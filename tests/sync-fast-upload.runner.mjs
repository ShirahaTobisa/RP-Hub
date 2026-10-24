import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, chrome, root, instrument, initializeFixture } from './sync-195.helpers.mjs';

// 快速上传（端到端，真实后端 + 浏览器）：第一次只能完整上传并记下分片布局；之后改几条记录（改、加、删，含一条跨好几个分片的大聊天和本机设置），
// 「快速上传」只重做改过的分片、只传这些分片，云端内容和完整扫描一模一样，别的设备拉下来和本机一样；
// 没改动时直接说已是同一份；改动太多或没有布局时自动改成完整上传。需要全局安装的 wrangler。
const PASSWORD = 'fast-upload-password';
const dist = process.env.RPH_PACKAGE_ROOT || path.join(root, 'dist');
const wrangler = path.join(process.env.APPDATA, 'npm/node_modules/wrangler/bin/wrangler.js');
const harness = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-fast-upload-'));
const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let site = null;

async function startSite(directory) {
    const child = spawn(process.execPath, [wrangler, 'pages', 'dev', directory, '--port', String(port), '--r2', 'RP_SYNC_R2',
        '--binding', `RP_SYNC_PASSWORD=${PASSWORD}`, '--persist-to', path.join(harness, 'persist'), '--compatibility-date', '2026-06-06',
        '--log-level', 'error', '--show-interactive-dev-session=false'], { cwd: harness, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    child.stdout.on('data', (data) => output.push(data.toString()));
    child.stderr.on('data', (data) => output.push(data.toString()));
    for (let i = 0; i < 150 && child.exitCode === null; i += 1) {
        try { if ((await fetch(`${origin}/DB/bootstrap.js`)).ok) return child; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(output.join(''));
}

function stopSite() {
    if (site?.exitCode === null) spawnSync('taskkill', ['/pid', String(site.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    site = null;
}

const message = (i, size) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 条消息🙂`.repeat(size) });
const records = [['rp_hub_character_index', { order: Array.from({ length: 40 }, (_, i) => `role-${i}`) }], ['rp_hub_settings', { theme: 'dark' }]];
for (let i = 0; i < 40; i += 1) {
    records.push([`rp_hub_character_${i}`, { uuid: `role-${i}`, name: `角色${i}`, description: '快速上传测试'.repeat(30) }]);
    records.push([`rp_hub_chat_role-${i}`, Array.from({ length: 300 }, (_, m) => message(m, 20))]);
}
// 一条比较大的聊天：序列化后 1MB 多，跨好几个分片（分片目标在测试里调成了 256KB）
records.push(['rp_hub_chat_role-big', Array.from({ length: 1000 }, (_, m) => message(m, 60))]);

const dumpDevice = (page) => page.evaluate(async () => {
    const read = (name, store) => new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(store)) { db.close(); resolve([]); return; }
            const values = [];
            const cursor = db.transaction(store).objectStore(store).openCursor();
            cursor.onsuccess = () => {
                if (cursor.result) { values.push([cursor.result.key, cursor.result.value]); cursor.result.continue(); } else { db.close(); resolve(values); }
            };
        };
    });
    const local = Object.fromEntries(['rp_hub_theme_mode', 'rphub_notes_v1'].map((key) => [key, localStorage.getItem(key)]));
    return { records: await read('RPHubDB', 'store'), characters: await read('AICharGen', 'characters'), local };
});
const sortEntries = (entries) => [...entries].sort(([a], [b]) => (a < b ? -1 : 1));
const pullManifest = (page) => page.evaluate(async () => (await fetch('/api/rp-sync', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rp-sync-password': localStorage.getItem('rp_hub_sync_password_v1') },
    body: JSON.stringify({ action: 'pull-manifest' })
})).json());
// 页面里直接写库：和官方代码、插件写库走的是同一条路，记账挂在 IndexedDB 原型上，一样记得到。
const write = (page, entries, removals = []) => page.evaluate(([entries, removals]) => new Promise((resolve, reject) => {
    const request = indexedDB.open('RPHubDB');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('store', 'readwrite');
        for (const [key, value] of entries) tx.objectStore('store').put(value, key);
        for (const key of removals) tx.objectStore('store').delete(key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => reject(tx.error);
    };
}), [entries, removals]);
const push = (page, mode) => page.evaluate((value) => api.pushToServer(value).then(() => api.state.statusText), mode);
const dirtyState = (page) => page.evaluate(() => api.readDirty());

let browser;
try {
    site = await startSite(dist);
    const html = await (await fetch(origin)).text();
    const scripts = [...html.matchAll(/<script src="(\/DB\/[^"\s]+)"><\/script>/g)].map((match) => match[0]).join('');
    assert.ok(scripts.includes('/DB/bootstrap.js'));
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const pageErrors = [];
    const parts = { count: 0 };
    const openDevice = async () => {
        const context = await browser.newContext();
        // 页面里没有官方程序，自己补一个「保存完再同步」的桥（官方程序会提供）
        await context.addInitScript((password) => {
            localStorage.setItem('rp_hub_sync_password_v1', password);
            globalThis.RPH_R2_FLUSH_PERSISTENCE = () => RPHubCharStore.waitForPendingMutations();
        }, PASSWORD);
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.route(`${origin}/`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"><aside class="app-sidebar"><button><svg></svg><span>设置</span></button></aside></div>${scripts}</body></html>` }));
        await page.route('**/DB/bootstrap.js?*', async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, body: instrument(await response.text()) });
        });
        await page.route('**/api/rp-sync?action=upload-part*', (route) => { parts.count += 1; return route.continue(); });
        await page.goto(origin);
        await initializeFixture(page);
        // 分片目标调小，几 MB 的测试数据也能分成几十块，看得出只重做了一部分
        await page.evaluate(() => { api.CONFIG.chunkSize = 256 * 1024; });
        return page;
    };

    // 1. 第一次上传：没有上次的布局，快速上传自动完整扫描；之后布局存在本机，改过的键清空。
    const pageA = await openDevice();
    await write(pageA, records);
    await pageA.evaluate(() => { localStorage.setItem('rp_hub_theme_mode', 'dark'); localStorage.setItem('rphub_notes_v1', '便签'); });
    assert.ok((await dirtyState(pageA)).tokens.length >= records.length, 'every write is noted before the first upload');
    assert.equal(await push(pageA, 'fast'), '上传成功。');
    const fullParts = parts.count;
    const layout = await pageA.evaluate(() => api.loadSyncLayout());
    assert.ok(layout && layout.chunks.length >= 3, `the layout has ${layout?.chunks.length} chunks`);
    assert.equal(layout.chunks.reduce((sum, chunk) => sum + chunk.r, 0), (await pullManifest(pageA)).remote.recordCount, 'per-chunk record counts add up');
    assert.ok(layout.chunks.some((chunk) => chunk.fl > 0) && !layout.chunks.some((chunk) => chunk.sl), 'chunk edges fall inside chat records, no giant lines');
    assert.deepEqual(await dirtyState(pageA), { full: false, tokens: [] });
    console.log(`PASS the first upload scans everything and keeps the layout (${layout.chunks.length} chunks, ${fullParts} parts sent)`);

    // 2. 改一点：改一条小聊天、加一个角色、删一个角色、往大聊天末尾追加、改一个本机设置。快速上传只重做这些分片。
    const bigChat = records.find(([key]) => key === 'rp_hub_chat_role-big')[1];
    const index = records.find(([key]) => key === 'rp_hub_character_index')[1];
    const changes = [
        ['rp_hub_chat_role-7', [...records.find(([key]) => key === 'rp_hub_chat_role-7')[1], message(60, 20)]],
        ['rp_hub_character_new', { uuid: 'role-new', name: '新角色', description: '后来加的' }],
        ['rp_hub_chat_role-new', [message(0, 5)]],
        ['rp_hub_chat_role-big', [...bigChat, message(1000, 60)]],
        ['rp_hub_character_index', { order: [...index.order.filter((id) => id !== 'role-3'), 'role-new'] }]
    ];
    await write(pageA, changes, ['rp_hub_character_3', 'rp_hub_chat_role-3']);
    await pageA.evaluate(() => localStorage.setItem('rp_hub_theme_mode', 'light'));
    assert.equal((await dirtyState(pageA)).tokens.length, 7);
    parts.count = 0;
    const fast = await push(pageA, 'fast');
    const [, rebuilt, total] = fast.match(/^快速上传成功：重做了 (\d+) 个分片，共 (\d+) 个。$/) || [];
    assert.ok(rebuilt, fast);
    assert.ok(Number(rebuilt) < Number(total), `only some chunks are rebuilt: ${rebuilt}/${total}`);
    assert.ok(parts.count > 0 && parts.count < fullParts, `fewer parts than the full upload: ${parts.count} < ${fullParts}`);
    assert.deepEqual(await dirtyState(pageA), { full: false, tokens: [] });
    const remote = (await pullManifest(pageA)).remote;
    const fresh = await pageA.evaluate(() => api.scanStreamSnapshot('cdc'));
    assert.equal(fresh.recordCount, remote.recordCount, 'the cloud has exactly as many records as a full scan');
    assert.equal(fresh.totalBytes, remote.totalBytes, 'the cloud stream is byte-for-byte the size of a full scan');
    console.log(`PASS a fast upload rebuilds ${rebuilt} of ${total} chunks and sends ${parts.count} parts${fresh.checksum === remote.checksum ? ', identical to a full scan' : ' (same bytes, cut differently)'}`);

    // 3. 别的设备拉下来，和本机一模一样。
    const pageB = await openDevice();
    await Promise.all([pageB.waitForEvent('load', { timeout: 60_000 }), pageB.evaluate(() => api.pullFromServer())]);
    await initializeFixture(pageB);
    const [a, b] = await Promise.all([dumpDevice(pageA), dumpDevice(pageB)]);
    assert.deepEqual(sortEntries(b.records), sortEntries(a.records));
    assert.deepEqual(b.local, a.local);
    assert.ok(!a.records.some(([key]) => key === 'rp_hub_character_3') && a.records.some(([key]) => key === 'rp_hub_character_new'));
    console.log('PASS another device pulls the fast-uploaded data and matches');

    // 4. 没改动：快速上传直接说已是同一份；拉取过的设备下次上传完整扫描；改动太多也完整扫描。
    assert.equal(await push(pageA, 'fast'), '服务器已是同一份数据，无需重复上传。');
    assert.equal((await dirtyState(pageB)).full, true, 'a pull marks everything as changed');
    await write(pageB, [['rp_hub_settings', { theme: 'light' }]]);
    assert.equal(await push(pageB, 'fast'), '上传成功。');
    assert.deepEqual(await dirtyState(pageB), { full: false, tokens: [] });
    await write(pageA, [['rp_hub_settings', { theme: 'blue' }]]);
    await pageA.evaluate(() => localStorage.setItem('rp_hub_sync_dirty_v1:*', '1'));
    assert.equal(await push(pageA, 'fast'), '上传成功。');
    await write(pageA, [['rp_hub_settings', { theme: 'red' }]]);
    await pageA.evaluate(() => localStorage.removeItem('rp_hub_sync_layout_v1'));
    assert.equal(await push(pageA, 'fast'), '上传成功。');
    assert.ok(await pageA.evaluate(() => api.loadSyncLayout()), 'a full upload records the layout again');
    await write(pageA, [['rp_hub_settings', { theme: 'green' }]]);
    assert.match(await push(pageA, 'fast'), /^快速上传成功/);
    const pageC = await openDevice();
    await Promise.all([pageC.waitForEvent('load', { timeout: 60_000 }), pageC.evaluate(() => api.pullFromServer())]);
    await initializeFixture(pageC);
    assert.deepEqual(sortEntries((await dumpDevice(pageC)).records), sortEntries((await dumpDevice(pageA)).records));
    console.log('PASS unchanged data is not re-uploaded; pulls, too many changes and a missing layout fall back to a full upload');
    assert.deepEqual(pageErrors, []);
} finally {
    stopSite();
    await browser?.close();
    await fs.rm(harness, { recursive: true, force: true }).catch(() => {});
}
