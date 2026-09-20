import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startHarness, initializeFixture, chromium, chrome, root } from './sync-195.helpers.mjs';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const harness = await startHarness();
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const browserCdp = await browser.newBrowserCDPSession();
const report = { browser: browser.version(), latencyMs: 80, memoryScope: 'sum of isolated benchmark Chromium renderer processes; 100ms Windows working-set/private-byte samples', phoneMemory: 'not measured', cases: {} };
const reportFile = path.join(root, 'evidence/sync-195/pull-performance.json');

async function load(baseline) {
    await page.goto(harness.url + `/?metrics${baseline ? '&baseline' : ''}`);
    await initializeFixture(page);
}

async function seed() {
    await load(false);
    const remote = await page.evaluate(async () => {
        const db = await fixture.db();
        const content = '中文🙂 baseline test '.repeat(75);
        await fixture.write(db, Array.from({ length: 32 }, (_, i) => [`rp_hub_chat_${String(i).padStart(3, '0')}`,
            Array.from({ length: 840 }, (_, j) => ({ role: 'assistant', content, index: j + i * 10000 }))]), true);
        localStorage.setItem('rp_hub_presets', JSON.stringify({ custom: ['preserve'], enabled: true }));
        db.close();
        window.remoteFixture = await fixture.snapshot();
        return remoteFixture.remote;
    });
    const chunks = [];
    for (let i = 0; i < remote.chunkCount; i++) {
        const encoded = await page.evaluate(index => {
            const bytes = remoteFixture.chunks[index].bytes;
            let text = '';
            for (let start = 0; start < bytes.length; start += 16384) text += String.fromCharCode(...bytes.subarray(start, start + 16384));
            return btoa(text);
        }, i);
        chunks.push(Buffer.from(encoded, 'base64'));
    }
    await page.evaluate(() => { delete window.remoteFixture; });
    harness.setSnapshot({ remote, chunks }, report.latencyMs);
    report.sample = { bytes: remote.totalBytes, records: remote.recordCount, chunks: remote.chunkCount, checksum: remote.checksum };
}

async function memorySample(operation) {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.filter(p => p.type === 'renderer').map(p => p.id);
    const samples = [];
    const script = `$pidsToSample = @(${ids.join(',')}); while ($true) { $ps = Get-Process -Id $pidsToSample -ErrorAction SilentlyContinue; $w = ($ps | Measure-Object WorkingSet64 -Sum).Sum; $p = ($ps | Measure-Object PrivateMemorySize64 -Sum).Sum; $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); Write-Output "$t,$w,$p"; Start-Sleep -Milliseconds 100 }`;
    const sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready, buffer = '';
    const started = new Promise(resolve => { ready = resolve; });
    sampler.stdout.on('data', data => {
        buffer += data;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            const values = buffer.slice(0, newline).trim().split(',').map(Number); buffer = buffer.slice(newline + 1);
            if (values.length === 3 && values.every(Number.isFinite)) samples.push(values);
            ready();
        }
    });
    await started;
    try {
        const result = await operation();
        const byStage = {};
        for (const [time, workingSet, privateBytes] of samples) {
            const stage = result.stages.filter(([at]) => at <= time).at(-1)?.[1] || 'other';
            const peak = byStage[stage] ||= { workingSet: 0, privateBytes: 0, samples: 0 };
            peak.workingSet = Math.max(peak.workingSet, workingSet); peak.privateBytes = Math.max(peak.privateBytes, privateBytes); peak.samples++;
        }
        delete result.stages;
        return { ...result, memory: { byStage, workingSet: Math.max(...samples.map(s => s[1])), privateBytes: Math.max(...samples.map(s => s[2])) } };
    } finally { sampler.kill(); }
}

async function run(baseline, mode = 'cold', memory = false) {
    await load(baseline);
    await page.evaluate(async ({ baseline, mode }) => {
        if (!baseline) {
            const cache = await api.openDownloadStagingDb('RPHubSyncChunkCache');
            await api.clearDownloadStagingStore(cache); cache.close();
        }
        if (mode !== 'cold') {
            const { remote } = await (await fetch('/api/rp-sync', { method: 'POST', body: JSON.stringify({ action: 'pull-manifest' }) })).json();
            await api.runSyncLocked(() => api.restoreStreamSnapshot(remote));
            if (mode === 'partial') {
                const cache = await api.openDownloadStagingDb('RPHubSyncChunkCache');
                const keep = api.retainedChunkKeys(remote.chunkManifest);
                keep.delete(api.chunkCacheKey(remote.chunkManifest[1]));
                keep.delete(api.chunkCacheKey(remote.chunkManifest[remote.chunkManifest.length - 2]));
                await api.pruneDownloadCache(cache, keep); cache.close();
            }
        }
    }, { baseline, mode });
    await cdp.send('HeapProfiler.collectGarbage');
    harness.requests.length = 0;
    const operation = () => page.evaluate(async baseline => {
        window.__perf = {};
        const stages = [[Date.now(), 'other']];
        let stage = 'other';
        Object.defineProperty(window, '__stage', { configurable: true, get: () => stage, set(value) { stage = value; stages.push([Date.now(), value]); } });
        const start = performance.now();
        const { remote } = await (await fetch('/api/rp-sync', { method: 'POST', body: JSON.stringify({ action: 'pull-manifest' }) })).json();
        if (baseline) await api.restoreStreamSnapshot(remote);
        else await api.runSyncLocked(() => api.restoreStreamSnapshot(remote));
        stages.push([Date.now(), 'other']);
        const result = { total: performance.now() - start, ...__perf, stages };
        window.expectedPullChecksum = remote.checksum;
        return result;
    }, baseline);
    const result = memory ? await memorySample(operation) : await operation();
    await page.evaluate(async () => {
        const restored = await api.scanStreamSnapshot();
        if (restored.checksum !== expectedPullChecksum) throw new Error('restored key/value digest changed');
    });
    result.downloadedBytes = harness.requests.filter(r => r.action === 'pull-json-part').reduce((sum, r) => sum + report.manifest.slice(r.start, r.start + r.count).reduce((s, c) => s + c.length, 0), 0);
    return result;
}

try {
    await seed();
    report.manifest = await page.evaluate(() => api.scanStreamSnapshot().then(s => s.chunkManifest));
    await run(true); await run(false);
    const baseline = [], candidate = [];
    for (let i = 0; i < 10; i++) {
        if (i % 2) { candidate.push(await run(false)); baseline.push(await run(true)); }
        else { baseline.push(await run(true)); candidate.push(await run(false)); }
        if (i === 4) {
            const jitter = a => (Math.max(...a) - Math.min(...a)) / median(a);
            if (jitter(baseline.map(r => r.total)) <= .05 && jitter(candidate.map(r => r.total)) <= .05) break;
        }
    }
    const summarize = values => Object.fromEntries(Object.keys(values[0]).filter(k => typeof values[0][k] === 'number').map(k => [k, median(values.map(v => v[k]))]));
    report.cases.cold = { baseline: summarize(baseline), candidate: summarize(candidate), raw: { baseline, candidate } };
    for (const mode of ['full', 'partial']) {
        const runs = [];
        for (let i = 0; i < 5; i++) runs.push(await run(false, mode));
        report.cases[mode] = { median: summarize(runs), raw: runs };
    }
    report.memory = { baseline: await run(true, 'cold', true), candidate: await run(false, 'cold', true), full: await run(false, 'full', true) };
    delete report.manifest;
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ sample: report.sample, cold: { baseline: report.cases.cold.baseline, candidate: report.cases.cold.candidate }, full: report.cases.full.median, partial: report.cases.partial.median, memory: report.memory }, null, 2));
} finally { await context.close(); await browser.close(); await harness.close(); }
