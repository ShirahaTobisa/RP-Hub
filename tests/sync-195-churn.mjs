import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startHarness, initializeFixture, chromium, chrome, root } from './sync-195.helpers.mjs';
const harness = await startHarness();
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const report = {};
try {
    for (const baseline of [true, false]) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(harness.url + (baseline ? '/?baseline' : ''));
        await initializeFixture(page);
        report[baseline ? 'baseline' : 'candidate'] = await page.evaluate(async () => {
            const content = '中文🙂 escaped " \\ conversation '.repeat(32);
            const makeMessage = i => ({ role: i % 2 ? 'user' : 'assistant', content, timestamp: i, metadata: { branch: 'main', flags: [true, false], note: '\n' } });
            const messages = Array.from({ length: 32000 }, (_, i) => makeMessage(i));
            const db = await fixture.db();
            const scan = async value => {
                await fixture.write(db, [['rp_hub_chat_long', value]], true);
                return api.scanStreamSnapshot();
            };
            const original = await scan(messages);
            const old = new Set(original.chunkManifest.map(c => c.checksum + ':' + c.length));
            const result = { original, cases: {} };
            for (const action of ['edit', 'append', 'insert', 'delete']) {
                const next = messages.slice();
                if (action === 'edit') next[16000] = { ...next[16000], content: '编辑内容 ' + next[16000].content };
                if (action === 'append') next.push(makeMessage(32000));
                if (action === 'insert') next.splice(16000, 0, makeMessage(32001));
                if (action === 'delete') next.splice(16000, 1);
                const snapshot = await scan(next);
                const changed = snapshot.chunkManifest.filter(c => !old.has(c.checksum + ':' + c.length));
                result.cases[action] = { bytes: snapshot.totalBytes, chunks: snapshot.chunkManifest.length,
                    newChunks: changed.length, retransmitBytes: changed.reduce((sum, c) => sum + c.length, 0), checksum: snapshot.checksum };
            }
            db.close();
            return result;
        });
        await context.close();
    }
    assert.deepEqual(report.candidate, report.baseline);
    await fs.writeFile(path.join(root, 'evidence/sync-195/churn.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ original: { bytes: report.candidate.original.totalBytes, chunks: report.candidate.original.chunkManifest.length }, cases: report.candidate.cases }, null, 2));
} finally { await browser.close(); await harness.close(); }
