import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { startHarness, initializeFixture, chromium, chrome, root } from './sync-195.helpers.mjs';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const reportFile = path.join(root, 'evidence/sync-195/performance.json');
const report = { environment: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0].model, memory: os.totalmem(), phone: 'not measured', network: 'isolated mock, 20 ms per request; 80 ms for pull' }, scans: {}, batches: {}, pulls: {}, edits: {} };
const harness = await startHarness();
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-precise-memory-info'] });
report.environment.browser = browser.version();
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const browserCdp = await browser.newBrowserCDPSession();

async function sampleMemory(operation) {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.filter(p => p.type === 'renderer').map(p => p.id);
    const readings = [];
    const command = `$idsToSample = @(${ids.join(',')}); while ($true) { $ps = Get-Process -Id $idsToSample -ErrorAction SilentlyContinue; $w = ($ps | Measure-Object WorkingSet64 -Sum).Sum; $p = ($ps | Measure-Object PrivateMemorySize64 -Sum).Sum; Write-Output "$w,$p"; Start-Sleep -Milliseconds 100 }`;
    const sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    let buffer = '';
    sampler.stdout.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            const values = buffer.slice(0, newline).trim().split(',').map(Number); buffer = buffer.slice(newline + 1);
            if (values.length === 2 && values.every(Number.isFinite)) readings.push(values);
            ready();
        }
    });
    await started;
    try {
        const value = await operation();
        return { ...value, rendererWorkingSetPeak: Math.max(...readings.map(r => r[0])), rendererPrivatePeak: Math.max(...readings.map(r => r[1])), memorySamples: readings.length };
    } finally { sampler.kill(); }
}

async function load(baseline, batch = 4) {
    await page.goto(harness.url + `/?metrics${baseline ? '&baseline' : ''}`);
    await initializeFixture(page);
    await page.evaluate(batch => { api.CONFIG.readBatchSize = batch; }, batch);
    await cdp.send('HeapProfiler.collectGarbage');
}

async function seed(kind) {
    await load(false);
    return page.evaluate(async kind => {
        const db = await fixture.db();
        const content = '中文🙂 escaped " \\ conversation '.repeat(32);
        const message = i => ({ role: i % 2 ? 'user' : 'assistant', content, timestamp: i, metadata: { branch: 'main', flags: [true, false], note: '\n' } });
        let entries;
        if (kind === 'small') entries = Array.from({ length: 2048 }, (_, i) => [`item-${String(i).padStart(5, '0')}`, { name: `条目${i}`, enabled: true, content: 'a'.repeat(128), detail: [i, i + 1] }]);
        else {
            const bytes = new TextEncoder().encode(JSON.stringify(message(1))).length;
            entries = kind === 'large' ? Array.from({ length: 64 }, (_, i) => [`rp_hub_chat_${String(i).padStart(3, '0')}`, Array.from({ length: Math.floor(2 * 1024 * 1024 / bytes) }, (_, j) => message(i * 10000 + j))])
                : [['rp_hub_chat_long', Array.from({ length: 32000 }, (_, i) => message(i))]];
        }
        await fixture.write(db, entries, true);
        db.close();
        localStorage.clear();
        localStorage.setItem('rp_hub_presets', JSON.stringify({ custom: ['对照预设'], enabled: true }));
        return { kind, records: entries.length, serializedBytes: new Blob(entries.map(([key, value]) => JSON.stringify(value))).size };
    }, kind);
}

async function push(baseline, batch = 4, noChange = false, memory = false) {
    await load(baseline, batch);
    const run = () => page.evaluate(async noChange => {
        window.RPHubCharStore = { assertPushAllowed: async () => {} };
        window.RPH_R2_FLUSH_PERSISTENCE = async () => {};
        let remote = noChange ? { ...await api.scanStreamSnapshot(), version: 1 } : null;
        let target;
        let uploadedBytes = 0;
        window.fetch = async (_, init) => {
            await new Promise(resolve => setTimeout(resolve, 20));
            if (typeof init.body !== 'string') { uploadedBytes += init.body.byteLength; return Response.json({ ok: true }); }
            const body = JSON.parse(init.body);
            if (body.action === 'pull-manifest') return Response.json({ ok: true, remote });
            if (body.action === 'upload-create') { target = body; return Response.json({ ok: true, previousVersion: 0, missingIndices: body.chunkManifest.map(c => c.index) }); }
            if (body.action === 'upload-complete') { remote = { ...target, version: 1 }; return Response.json({ ok: true, version: 1 }); }
            throw new Error(body.action);
        };
        window.__perf = {};
        const start = performance.now();
        await api.pushToServer();
        return { total: performance.now() - start, ...__perf, uploadedBytes, status: api.state.statusText };
    }, noChange);
    return memory ? sampleMemory(run) : run();
}

async function compare(operation) {
    await operation(true); await operation(false);
    const baseline = [], candidate = [];
    for (let pair = 0; pair < 10; pair++) {
        if (pair % 2) { candidate.push(await operation(false)); baseline.push(await operation(true)); }
        else { baseline.push(await operation(true)); candidate.push(await operation(false)); }
        if (pair === 4) {
            const jitter = values => (Math.max(...values) - Math.min(...values)) / median(values);
            if (jitter(baseline.map(x => x.total)) <= .05 && jitter(candidate.map(x => x.total)) <= .05) break;
        }
    }
    const summary = values => Object.fromEntries(Object.keys(values[0]).filter(k => typeof values[0][k] === 'number').map(k => [k, median(values.map(v => v[k]))]));
    return { baseline: summary(baseline), candidate: summary(candidate), pairs: baseline.length, raw: { baseline, candidate } };
}

try {
    for (const kind of ['small', 'large', 'long']) {
        const sample = await seed(kind);
        report.scans[kind] = { sample, firstPush: await compare(b => push(b)), unchanged: await compare(b => push(b, 4, true)) };
        console.log(JSON.stringify({ kind, firstPush: report.scans[kind].firstPush.candidate, baseline: report.scans[kind].firstPush.baseline }));
        await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    }
    for (const batch of [32, 16, 8]) {
        const measured = {};
        for (const kind of ['small', 'large', 'long']) {
            await seed(kind);
            measured[kind] = await compare(b => push(false, b ? 4 : batch, true, true));
        }
        report.batches[batch] = measured;
        console.log('batch', batch, JSON.stringify(Object.fromEntries(Object.entries(measured).map(([k, v]) => [k, { baseline: v.baseline, candidate: v.candidate }]))));
        await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
    }
} finally { await context.close(); await browser.close(); await harness.close(); }
