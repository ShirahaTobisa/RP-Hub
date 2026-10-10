import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, chrome, root, instrument, initializeFixture } from './sync-195.helpers.mjs';
const dist = process.env.RPH_PACKAGE_ROOT || path.join(root, 'dist');
const harness = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-package-195-'));
const listener = createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const wrangler = path.join(process.env.APPDATA, 'npm/node_modules/wrangler/bin/wrangler.js');
const child = spawn(process.execPath, [wrangler, 'pages', 'dev', dist, '--port', String(port), '--r2', 'RP_SYNC_R2', '--persist-to', path.join(harness, 'persist'), '--compatibility-date', '2026-06-06', '--log-level', 'error', '--show-interactive-dev-session=false'], { cwd: harness, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const output = [];
child.stdout.on('data', data => output.push(data.toString()));
child.stderr.on('data', data => output.push(data.toString()));
const origin = `http://127.0.0.1:${port}`;
let browser;
try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
        try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
        if (child.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert(ready, output.join(''));
    const html = await (await fetch(origin)).text();
    const scripts = [...html.matchAll(/<script src="(\/DB\/[^"\s]+)"><\/script>/g)].map(match => match[0]).join('');
    assert(scripts.includes('/DB/nav-adapter.js'));
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    const requests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => {
        if (!request.url().endsWith('/api/rp-sync')) return;
        try { requests.push(JSON.parse(request.postData())); } catch {}
    });
    await page.route(origin + '/', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"><aside class="app-sidebar"><button><svg></svg><span>设置</span></button></aside></div>${scripts}</body></html>` }));
    await page.route('**/DB/bootstrap.js?*', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: instrument(await response.text()) });
    });
    await page.goto(origin);
    await initializeFixture(page);
    assert.deepEqual(pageErrors, [], await page.locator('script').evaluateAll(nodes => nodes.map(node => node.src).join('\n')));
    const pushed = await page.evaluate(async moduleSource => {
        await RPHubImageModule.scan();
        await RPHubCharStore.saveAll([{ uuid: 'pkg-role', name: '包内验收角色' }]);
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_presets', { custom: [{ name: '自定义', enabled: true }], enabled: false }],
            ['rp_hub_chat_pkg-role::branch', Array.from({ length: 4000 }, (_, i) => ({ role: 'assistant', content: '中文🙂包内推拉'.repeat(60) + i }))],
            ['rp_hub_image_renders_pkg-role', { image: { ownerUuid: 'pkg-role', prompt: 'image test' } }]
        ]);
        db.close();
        const workshop = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubWorkshop', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('scripts'); request.result.createObjectStore('data'); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const moduleUrl = 'rphub-file:package-fixture/liuguanyi.js';
        await new Promise((resolve, reject) => {
            const tx = workshop.transaction(['scripts', 'data'], 'readwrite');
            tx.objectStore('scripts').put(moduleSource, moduleUrl);
            tx.objectStore('data').put([{ title: '完整收藏', aiText: '完整正文'.repeat(5000) }], 'liuguanyi::moments');
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error);
        });
        workshop.close();
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ id: 'liuguanyi', url: moduleUrl, enabled: false }]));
        localStorage.setItem('rphub_notes_v1', '包内便签');
        RPH_R2_FLUSH_PERSISTENCE = () => RPHubCharStore.waitForPendingMutations();
        await api.pushToServer();
        return { status: api.state.statusText, audit: RPHubCharStore.getPatchAuditStatus(), snapshot: await api.scanStreamSnapshot() };
    }, await fs.readFile(path.join(dist, 'DB/modules/liuguanyi-20.0.3.js'), 'utf8'));
    assert.equal(pushed.status, '上传成功。');
    assert.equal(pushed.audit.status, 'ok');
    const firstPull = await page.evaluate(async () => {
        const db = await fixture.db(); await fixture.write(db, [['local-only', 'remove']], true); db.close();
        const workshop = await fixture.db('RPHubWorkshop', 'scripts');
        for (const name of ['scripts', 'data']) await new Promise((resolve, reject) => {
            const tx = workshop.transaction(name, 'readwrite');
            tx.objectStore(name).clear(); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
        });
        workshop.close();
        localStorage.removeItem('rphub_notes_v1');
        localStorage.removeItem('rp_hub_workshop_modules_v1');
        const { remote } = await (await fetch('/api/rp-sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pull-manifest' }) })).json();
        await api.runSyncLocked(() => api.restoreStreamSnapshot(remote));
        return api.scanStreamSnapshot();
    });
    assert.equal(firstPull.checksum, pushed.snapshot.checksum);
    requests.length = 0;
    const secondPull = await page.evaluate(async () => {
        const db = await fixture.db(); await fixture.write(db, [['local-only', 'remove again']]); db.close();
        const { remote } = await (await fetch('/api/rp-sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pull-manifest' }) })).json();
        await api.runSyncLocked(() => api.restoreStreamSnapshot(remote));
        return api.scanStreamSnapshot();
    });
    assert.equal(secondPull.checksum, pushed.snapshot.checksum);
    assert.equal(requests.filter(request => request.action === 'pull-json-part').length, 0);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ ok: true, dist, bytes: pushed.snapshot.totalBytes, chunks: pushed.snapshot.chunkManifest.length, checksum: pushed.snapshot.checksum, secondPullPartRequests: 0, pageErrors }));
} finally {
    await browser?.close();
    if (child.exitCode === null) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    // The mkdtemp path is confined to this test's own directory.
    if (path.dirname(harness) === os.tmpdir() && path.basename(harness).startsWith('rph-package-195-')) await fs.rm(harness, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
