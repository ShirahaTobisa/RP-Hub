import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { startHarness, initializeFixture, chromium, chrome, root, baseline } from './sync-195.helpers.mjs';

const evidence = path.join(root, 'evidence/pull-20260917');
const memoryOnly = process.argv.includes('--memory');
const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const hash = file => fs.readFile(file).then(bytes => crypto.createHash('sha256').update(bytes).digest('hex'));
const harness = await startHarness();
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const report = { browser: browser.version(), latencyMs: 80, rounds: memoryOnly ? 2 : 10, realPhone: false,
    baseline: await hash(path.join(baseline, 'DB/bootstrap.js')), candidate: await hash(path.join(root, 'DB/bootstrap.js')), cases: {} };
const cdp = await context.newCDPSession(page);
const browserCdp = await browser.newBrowserCDPSession();
async function sampleMemory(operation) {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const pids = processInfo.filter(value => value.type === 'renderer').map(value => value.id);
    const script = `$samplePids = @(${pids.join(',')}); while ($true) { $processes = Get-Process -Id $samplePids -ErrorAction SilentlyContinue; $working = ($processes | Measure-Object WorkingSet64 -Sum).Sum; $private = ($processes | Measure-Object PrivateMemorySize64 -Sum).Sum; $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); Write-Output "$stamp,$working,$private"; Start-Sleep -Milliseconds 50 }`;
    const sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '', ready;
    const samples = [], started = new Promise(resolve => { ready = resolve; });
    sampler.stdout.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
            const values = buffer.slice(0, end).trim().split(',').map(Number);
            buffer = buffer.slice(end + 1);
            if (values.length === 3 && values.every(Number.isFinite)) { samples.push(values); ready(); }
        }
    });
    await started;
    try {
        const result = await operation(), stages = {};
        for (const [stamp, working, privateBytes] of samples) {
            const stage = result.stages.filter(([at]) => at <= stamp).at(-1)?.[1] || 'other';
            const peak = stages[stage] ||= { working: 0, privateBytes: 0, samples: 0 };
            peak.working = Math.max(peak.working, working);
            peak.privateBytes = Math.max(peak.privateBytes, privateBytes);
            peak.samples++;
        }
        return { ...result, memory: stages };
    } finally { sampler.kill(); }
}
async function load(previous) {
    await page.goto(harness.url + '/?metrics' + (previous ? '&baseline' : ''));
    await initializeFixture(page);
}
async function run(previous, cold) {
    await load(previous);
    if (cold) await page.evaluate(async () => {
        const cache = await api.openDownloadStagingDb('RPHubSyncChunkCache');
        await api.clearDownloadStagingStore(cache); cache.close();
    });
    await cdp.send('HeapProfiler.collectGarbage');
    harness.requests.length = 0;
    const operation = () => page.evaluate(async () => {
        globalThis.__perf = {};
        const stages = [[Date.now(), 'other']];
        let stage = 'other';
        Object.defineProperty(globalThis, '__stage', { configurable: true, get: () => stage,
            set(value) { stage = value; stages.push([Date.now(), value]); } });
        const start = performance.now();
        const { remote } = await (await fetch('/api/rp-sync', { method: 'POST', body: JSON.stringify({ action: 'pull-manifest' }) })).json();
        await api.runSyncLocked(() => api.restoreStreamSnapshot(remote));
        return { total: performance.now() - start, ...__perf, stages, checksum: remote.checksum };
    });
    const result = memoryOnly ? await sampleMemory(operation) : await operation();
    await page.evaluate(async checksum => {
        if ((await api.scanStreamSnapshot()).checksum !== checksum) throw new Error('Restored data changed');
    }, result.checksum);
    delete result.stages;
    delete result.checksum;
    result.requests = harness.requests.filter(request => request.action === 'pull-json-part').length;
    return result;
}
try {
    await load(false);
    const remote = await page.evaluate(async () => {
        const db = await fixture.db();
        const content = '中文🙂 baseline test '.repeat(75);
        await fixture.write(db, Array.from({ length: 32 }, (_, i) => [`rp_hub_chat_${String(i).padStart(3, '0')}`,
            Array.from({ length: 840 }, (_, j) => ({ role: 'assistant', content, index: j + i * 10000 }))]), true);
        await fixture.write(db, [['rp_hub_presets', { custom: ['自定义预设'], enabled: true }]]);
        localStorage.setItem('rphub_notes_v1', '便签');
        db.close();
        globalThis.remoteFixture = await fixture.snapshot();
        return remoteFixture.remote;
    });
    const chunks = [];
    for (let i = 0; i < remote.chunkCount; i++) chunks.push(Buffer.from(await page.evaluate(index => {
        const bytes = remoteFixture.chunks[index].bytes;
        let binary = '';
        for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
        return btoa(binary);
    }, i), 'base64'));
    harness.setSnapshot({ remote, chunks }, report.latencyMs);
    report.sample = { bytes: remote.totalBytes, records: remote.recordCount, messages: 26880, chunks: remote.chunkCount, checksum: remote.checksum };
    report.memoryScope = 'isolated Chromium renderer processes; 50 ms Windows working set/private byte samples; not JS heap only';
    if (!memoryOnly) { await run(true, true); await run(false, true); }
    for (const mode of ['cold', 'cached']) {
        const samples = { baseline: [], candidate: [] };
        for (let i = 0; i < report.rounds; i++) {
            for (const previous of i % 2 ? [false, true] : [true, false]) {
                samples[previous ? 'baseline' : 'candidate'].push(await run(previous, mode === 'cold'));
            }
        }
        const summarize = values => Object.fromEntries(['total', 'download', 'validate', 'restore', 'hash', 'requests']
            .map(key => [key, median(values.map(value => value[key] || 0))]));
        report.cases[mode] = { baseline: summarize(samples.baseline), candidate: summarize(samples.candidate), raw: samples };
        assert(report.cases[mode].candidate.requests === report.cases[mode].baseline.requests);
        console.log(JSON.stringify({ mode, baseline: report.cases[mode].baseline, candidate: report.cases[mode].candidate }));
    }
} finally {
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, memoryOnly ? 'memory.json' : 'performance.json'), JSON.stringify(report, null, 2));
    await context.close(); await browser.close(); await harness.close();
}
