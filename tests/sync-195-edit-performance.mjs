import fs from 'node:fs/promises';
import path from 'node:path';
import { startHarness, initializeFixture, chromium, chrome, root } from './sync-195.helpers.mjs';
const harness = await startHarness();
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const report = {};
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function run(baseline, action) {
    await page.goto(harness.url + '/?metrics' + (baseline ? '&baseline' : ''));
    await initializeFixture(page);
    return page.evaluate(async action => {
        const content = '中文🙂 escaped " \\ conversation '.repeat(32);
        const message = i => ({ role: i % 2 ? 'user' : 'assistant', content, timestamp: i, metadata: { branch: 'main', flags: [true, false], note: '\n' } });
        const messages = Array.from({ length: 32000 }, (_, i) => message(i));
        const db = await fixture.db();
        await fixture.write(db, [['rp_hub_chat_long', messages]], true);
        let remote = { ...await api.scanStreamSnapshot(), version: 1 };
        const old = new Set(remote.chunkManifest.map(c => c.checksum + ':' + c.length));
        if (action === 'edit') messages[16000] = { ...messages[16000], content: '编辑内容 ' + messages[16000].content };
        if (action === 'append') messages.push(message(32000));
        if (action === 'insert') messages.splice(16000, 0, message(32001));
        if (action === 'delete') messages.splice(16000, 1);
        await fixture.write(db, [['rp_hub_chat_long', messages]], true); db.close();
        window.RPHubCharStore = { assertPushAllowed: async () => {} };
        window.RPH_R2_FLUSH_PERSISTENCE = async () => {};
        let target, uploadedBytes = 0;
        window.fetch = async (_, init) => {
            await new Promise(resolve => setTimeout(resolve, 20));
            if (typeof init.body !== 'string') { uploadedBytes += init.body.byteLength; return Response.json({ ok: true }); }
            const body = JSON.parse(init.body);
            if (body.action === 'pull-manifest') return Response.json({ ok: true, remote });
            if (body.action === 'upload-create') {
                target = body;
                return Response.json({ ok: true, previousVersion: 1,
                    missingIndices: body.chunkManifest.filter(c => !old.has(c.checksum + ':' + c.length)).map(c => c.index) });
            }
            if (body.action === 'upload-complete') { remote = { ...target, version: 2 }; return Response.json({ ok: true, version: 2 }); }
        };
        window.__perf = {};
        const start = performance.now(); await api.pushToServer();
        if (api.state.statusText !== '上传成功。') throw new Error(api.state.statusText);
        return { total: performance.now() - start, ...__perf, uploadedBytes };
    }, action);
}
try {
    for (const action of ['edit', 'append', 'insert', 'delete']) {
        await run(true, action); await run(false, action);
        const baseline = [], candidate = [];
        for (let i = 0; i < 10; i++) {
            if (i % 2) { candidate.push(await run(false, action)); baseline.push(await run(true, action)); }
            else { baseline.push(await run(true, action)); candidate.push(await run(false, action)); }
            if (i === 4) {
                const jitter = a => (Math.max(...a) - Math.min(...a)) / median(a);
                if (jitter(baseline.map(r => r.total)) <= .05 && jitter(candidate.map(r => r.total)) <= .05) break;
            }
        }
        const summarize = values => Object.fromEntries(Object.keys(values[0]).map(k => [k, median(values.map(v => v[k]))]));
        report[action] = { baseline: summarize(baseline), candidate: summarize(candidate), pairs: baseline.length, raw: { baseline, candidate } };
        await fs.writeFile(path.join(root, 'evidence/sync-195/edit-performance.json'), JSON.stringify(report, null, 2));
        console.log(action, JSON.stringify({ baseline: report[action].baseline, candidate: report[action].candidate }));
    }
} finally { await context.close(); await browser.close(); await harness.close(); }
