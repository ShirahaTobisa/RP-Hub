import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, chrome, root, instrument, initializeFixture } from './sync-195.helpers.mjs';

// 快速上传（端到端，真实后端 + 浏览器）：第一次只能完整上传并记下分片布局；之后改几条记录（改、加、删，含一条跨好几个分片的大聊天和本机设置），
// 「快速上传」只重做改过的分片、只传这些分片，云端内容和完整扫描一模一样，别的设备拉下来和本机一样；
// 再逐个试边界：只改本机设置、超过单片硬上限的超大单条记录、散落各处的新增和删除（含别的库、数字键、整表清空）、连着几次快速上传；
// 没改动时直接说已是同一份；拉取过、改动太多或没有布局时自动改成完整上传。需要全局安装的 wrangler。
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
// 一条超过单片硬上限（8MB）的记录：一整行被切成几块
const giant = (size) => ({ uuid: 'giant', name: '大卡', avatar: 'x'.repeat(size) });
records.push(['rp_hub_character_giant', giant(9 * 1024 * 1024)]);

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
    return { records: await read('RPHubDB', 'store'), characters: await read('AICharGen', 'characters'), data: await read('RPHubWorkshop', 'data'), local };
});
const sortEntries = (entries) => [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const pullManifest = (page) => page.evaluate(async () => (await fetch('/api/rp-sync', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rp-sync-password': localStorage.getItem('rp_hub_sync_password_v1') },
    body: JSON.stringify({ action: 'pull-manifest' })
})).json());
// 页面里直接写库：和官方代码、插件写库走的是同一条路，记账挂在 IndexedDB 原型上，一样记得到。
const writeTo = (page, dbName, storeName, entries, removals = [], clear = false) => page.evaluate(async ([dbName, storeName, entries, removals, clear]) => {
    const db = await fixture.db(dbName, storeName);
    await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        if (clear) store.clear();
        for (const [key, value] of entries) store.put(value, key);
        for (const key of removals) store.delete(key);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
    });
    db.close();
}, [dbName, storeName, entries, removals, clear]);
const write = (page, entries, removals = []) => writeTo(page, 'RPHubDB', 'store', entries, removals);
const push = (page, mode) => page.evaluate((value) => api.pushToServer(value).then(() => api.state.statusText), mode);
const dirtyState = (page) => page.evaluate(() => api.readDirty());
const fastResult = (status) => {
    const [, rebuilt, total] = status.match(/^快速上传成功：重做了 (\d+) 个分片，共 (\d+) 个。$/) || [];
    assert.ok(rebuilt, status);
    return { rebuilt: Number(rebuilt), total: Number(total) };
};
// 云端现在的清单和本地完整扫描一遍的结果比：记录数、总字节数必须一样（分片切法偶尔可以不同）
const matchesFullScan = async (page) => {
    const remote = (await pullManifest(page)).remote;
    const fresh = await page.evaluate(() => api.scanStreamSnapshot('cdc'));
    assert.equal(fresh.recordCount, remote.recordCount, 'the cloud has exactly as many records as a full scan');
    assert.equal(fresh.totalBytes, remote.totalBytes, 'the cloud stream is byte-for-byte the size of a full scan');
    return fresh.checksum === remote.checksum ? 'identical to a full scan' : 'same bytes, cut differently';
};

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
        // 分片目标调小，十几 MB 的测试数据也能分成几十块，看得出只重做了一部分
        await page.evaluate(() => { api.CONFIG.chunkSize = 256 * 1024; });
        return page;
    };
    const pullInto = async (page) => {
        await Promise.all([page.waitForEvent('load', { timeout: 60_000 }), page.evaluate(() => api.pullFromServer())]);
        await initializeFixture(page);
    };

    // 0. 区域边界的算法：相邻区域合并；起点是上一块结束的地方之后（上一块最后那条记录整条都在上一块里就整条跳过），终点是下一块开始的地方。
    const pageA = await openDevice();
    const bounds = await pageA.evaluate(() => {
        const rec = (key) => ({ k: 'rec', d: 'RPHubDB', s: 'store', key });
        const chunks = [
            { from: { k: 'ls' }, fromLine: 0, to: rec('a') },
            { from: rec('c'), fromLine: 0, to: rec('c') },
            { from: rec('c'), fromLine: 5, to: rec('e') },
            { from: rec('g'), fromLine: 0, to: { k: 'end' } }
        ];
        return api.mergeRegions(chunks, [{ start: 1, end: 1 }, { start: 2, end: 2 }]).map((region) => [region.start, region.end, region.bounds]);
    });
    assert.deepEqual(bounds, [[1, 2, {
        start: { ref: { k: 'rec', d: 'RPHubDB', s: 'store', key: 'a' }, line: Infinity },
        stop: { ref: { k: 'rec', d: 'RPHubDB', s: 'store', key: 'g' }, line: 0 }
    }]]);
    console.log('PASS region edges come from the neighbouring chunks');

    // 1. 第一次上传：没有上次的布局，快速上传自动完整扫描；之后布局存在本机，改过的键清空。
    await write(pageA, records);
    await writeTo(pageA, 'AICharGen', 'characters', [[1, { id: 1, name: '生成器角色一' }], [2, { id: 2, name: '生成器角色二' }]]);
    await writeTo(pageA, 'RPHubWorkshop', 'data', [['demo::note', { text: '插件数据' }]]);
    await pageA.evaluate(() => { localStorage.setItem('rp_hub_theme_mode', 'dark'); localStorage.setItem('rphub_notes_v1', '便签'); });
    assert.ok((await dirtyState(pageA)).tokens.length >= records.length, 'every write is noted before the first upload');
    // 直接调生成器：起点正好是某个表的结尾（整条都在上一块里），这个表的记录一条都不能再生成；终点是某条记录的第 0 行，那条记录不生成
    const edgeUnits = await pageA.evaluate(async () => {
        const run = async (bounds) => {
            const refs = [];
            const stats = { recordCount: 0, totalBytes: 0 };
            for await (const chunk of api.iterateSnapshotChunks(stats, 'cdc', { ...bounds, recordCount: () => 0 })) refs.push(chunk.from, chunk.to);
            return { refs, records: stats.recordCount };
        };
        return {
            afterStore: await run({ start: { ref: { k: 'se', d: 'RPHubDB', s: 'store' }, line: Infinity } }),
            beforeSecond: await run({ start: { ref: { k: 'ls' }, line: Infinity }, stop: { ref: { k: 'rec', d: 'RPHubDB', s: 'store', key: 'rp_hub_character_1' }, line: 0 } })
        };
    });
    assert.ok(!edgeUnits.afterStore.refs.some((ref) => ref.d === 'RPHubDB' && ref.k !== 'de'), JSON.stringify(edgeUnits.afterStore.refs));
    assert.equal(edgeUnits.afterStore.records, 3, 'only the AICharGen and workshop records come after the store end');
    assert.deepEqual(edgeUnits.beforeSecond.refs.map((ref) => ref.key || ref.k), ['db', 'rp_hub_character_0'], JSON.stringify(edgeUnits.beforeSecond.refs));
    assert.equal(edgeUnits.beforeSecond.records, 1, 'between the local settings and the second character there is exactly one record');
    console.log('PASS the generator respects store-end starts and record stops');
    assert.equal(await push(pageA, 'fast'), '上传成功。');
    const fullParts = parts.count;
    const layout = await pageA.evaluate(() => api.loadSyncLayout());
    assert.ok(layout && layout.chunks.length >= 10, `the layout has ${layout?.chunks.length} chunks`);
    assert.equal(layout.chunks.reduce((sum, chunk) => sum + chunk.r, 0), (await pullManifest(pageA)).remote.recordCount, 'per-chunk record counts add up');
    assert.ok(layout.chunks.some((chunk) => chunk.fl > 0), 'some chunk starts inside a chat record');
    assert.equal(layout.chunks.filter((chunk) => chunk.sl).length, 1, 'the giant record is one line cut into pieces');
    assert.deepEqual(await dirtyState(pageA), { full: false, tokens: [] });
    console.log(`PASS the first upload scans everything and keeps the layout (${layout.chunks.length} chunks, ${fullParts} parts sent)`);

    // 2. 改一点：改一条小聊天、加一个角色、删一个角色、往大聊天末尾追加、改一个本机设置。快速上传只重做这些分片。
    const bigChat = records.find(([key]) => key === 'rp_hub_chat_role-big')[1];
    const index = records.find(([key]) => key === 'rp_hub_character_index')[1];
    await write(pageA, [
        ['rp_hub_chat_role-7', [...records.find(([key]) => key === 'rp_hub_chat_role-7')[1], message(300, 20)]],
        ['rp_hub_character_new', { uuid: 'role-new', name: '新角色', description: '后来加的' }],
        ['rp_hub_chat_role-new', [message(0, 5)]],
        ['rp_hub_chat_role-big', [...bigChat, message(1000, 60)]],
        ['rp_hub_character_index', { order: [...index.order.filter((id) => id !== 'role-3'), 'role-new'] }]
    ], ['rp_hub_character_3', 'rp_hub_chat_role-3']);
    await pageA.evaluate(() => localStorage.setItem('rp_hub_theme_mode', 'light'));
    assert.equal((await dirtyState(pageA)).tokens.length, 7);
    parts.count = 0;
    const edited = fastResult(await push(pageA, 'fast'));
    assert.ok(edited.rebuilt < edited.total, `only some chunks are rebuilt: ${edited.rebuilt}/${edited.total}`);
    assert.ok(parts.count > 0 && parts.count < fullParts, `fewer parts than the full upload: ${parts.count} < ${fullParts}`);
    assert.deepEqual(await dirtyState(pageA), { full: false, tokens: [] });
    console.log(`PASS a fast upload rebuilds ${edited.rebuilt} of ${edited.total} chunks and sends ${parts.count} parts, ${await matchesFullScan(pageA)}`);

    // 3. 别的设备拉下来，和本机一模一样。
    const pageB = await openDevice();
    await pullInto(pageB);
    const [a, b] = await Promise.all([dumpDevice(pageA), dumpDevice(pageB)]);
    assert.deepEqual(sortEntries(b.records), sortEntries(a.records));
    assert.deepEqual(sortEntries(b.characters), sortEntries(a.characters));
    assert.deepEqual(b.local, a.local);
    assert.ok(!a.records.some(([key]) => key === 'rp_hub_character_3') && a.records.some(([key]) => key === 'rp_hub_character_new'));
    console.log('PASS another device pulls the fast-uploaded data and matches');

    // 4. 只改本机设置：只重做头尾那两块。
    await pageA.evaluate(() => localStorage.setItem('rphub_notes_v1', '新便签'));
    const localOnly = fastResult(await push(pageA, 'fast'));
    assert.ok(localOnly.rebuilt <= 2, `only the first and last chunks: ${localOnly.rebuilt}`);
    console.log(`PASS a local-settings-only change rebuilds ${localOnly.rebuilt} chunks, ${await matchesFullScan(pageA)}`);

    // 5. 超大单条记录：改它旁边的键、改它本身，被切开的那几块都处理对。
    await write(pageA, [['rp_hub_character_giant2', { uuid: 'giant2', name: '大卡后面' }], ['rp_hub_character_gia', { uuid: 'gia', name: '大卡前面' }]]);
    const beside = fastResult(await push(pageA, 'fast'));
    assert.ok(beside.rebuilt < beside.total);
    console.log(`PASS keys beside the giant record: ${beside.rebuilt}/${beside.total} chunks, ${await matchesFullScan(pageA)}`);
    await write(pageA, [['rp_hub_character_giant', giant(9 * 1024 * 1024 + 7)]]);
    const grown = fastResult(await push(pageA, 'fast'));
    assert.ok(grown.rebuilt < grown.total);
    console.log(`PASS the giant record itself: ${grown.rebuilt}/${grown.total} chunks, ${await matchesFullScan(pageA)}`);

    // 6. 散落各处的改动：30 个随机新键、10 个删除、别的库的数字键、插件数据，然后整表清空后重填。
    const scattered = Array.from({ length: 30 }, (_, i) => [`rp_hub_chat_role-${String(Math.floor(i * 1.37) % 40).padStart(2, '0')}x${i}`, [message(i, 3)]]);
    const removed = Array.from({ length: 10 }, (_, i) => `rp_hub_chat_role-${i * 3 + 1}`);
    await write(pageA, scattered, removed);
    await writeTo(pageA, 'AICharGen', 'characters', [[2, { id: 2, name: '生成器角色二改' }], [3, { id: 3, name: '生成器角色三' }]], [1]);
    await writeTo(pageA, 'RPHubWorkshop', 'data', [['demo::note', { text: '插件数据改' }], ['demo::list', [1, 2, 3]]]);
    const spread = fastResult(await push(pageA, 'fast'));
    assert.ok(spread.rebuilt < spread.total);
    console.log(`PASS scattered edits across stores: ${spread.rebuilt}/${spread.total} chunks, ${await matchesFullScan(pageA)}`);
    await writeTo(pageA, 'AICharGen', 'characters', [[10, { id: 10, name: '重填' }]], [], true);
    const cleared = fastResult(await push(pageA, 'fast'));
    console.log(`PASS a cleared store: ${cleared.rebuilt}/${cleared.total} chunks, ${await matchesFullScan(pageA)}`);

    // 7. 连着快速上传：布局来自上一次快速上传，照样只重做改过的。
    for (const round of [1, 2]) {
        await write(pageA, [[`rp_hub_chat_role-${round}`, [message(round, 9)]], [`rp_hub_character_round${round}`, { uuid: `round${round}` }]]);
        const again = fastResult(await push(pageA, 'fast'));
        assert.ok(again.rebuilt < again.total);
        console.log(`PASS fast upload after a fast upload (round ${round}): ${again.rebuilt}/${again.total} chunks, ${await matchesFullScan(pageA)}`);
    }
    const pageC = await openDevice();
    await pullInto(pageC);
    const [a2, c] = await Promise.all([dumpDevice(pageA), dumpDevice(pageC)]);
    assert.deepEqual(sortEntries(c.records), sortEntries(a2.records));
    assert.deepEqual(sortEntries(c.characters), sortEntries(a2.characters));
    assert.deepEqual(sortEntries(c.data), sortEntries(a2.data));
    assert.deepEqual(c.local, a2.local);
    console.log('PASS a third device pulls everything after the chain of fast uploads and matches');

    // 7b. 上传途中又写了一条本来就改过的数据（AI 还在往聊天里写、插件在写）：这次上传完以后它还记着改过，下次快速上传把新内容传上去。
    await write(pageA, [['rp_hub_chat_role-9', [message(1, 7)]]]);
    let wroteDuringUpload = false;
    await pageA.route('**/api/rp-sync', async (route) => {
        if (!wroteDuringUpload && route.request().postDataJSON()?.action === 'upload-complete') {
            wroteDuringUpload = true;
            await write(pageA, [['rp_hub_chat_role-9', [message(2, 7)]], ['rp_hub_settings', { theme: 'during-upload' }]]);
        }
        return route.continue();
    });
    fastResult(await push(pageA, 'fast'));
    assert.ok(wroteDuringUpload);
    const afterRace = (await dirtyState(pageA)).tokens;
    assert.ok(afterRace.includes(JSON.stringify(['RPHubDB', 'store', 'rp_hub_chat_role-9'])), `a key rewritten during the upload stays marked: ${afterRace}`);
    assert.ok(afterRace.includes(JSON.stringify(['RPHubDB', 'store', 'rp_hub_settings'])), 'a key first written during the upload stays marked');
    await pageA.unroute('**/api/rp-sync');
    fastResult(await push(pageA, 'fast'));
    const pageD = await openDevice();
    await pullInto(pageD);
    const raced = Object.fromEntries((await dumpDevice(pageD)).records);
    assert.deepEqual(raced['rp_hub_chat_role-9'], [message(2, 7)], 'the content written during the earlier upload reaches the cloud on the next fast upload');
    assert.deepEqual(raced['rp_hub_settings'], { theme: 'during-upload' });
    // 完整上传途中写的也一样（拉取过的设备第一次上传就是完整的）
    assert.equal((await dirtyState(pageD)).full, true);
    let wroteDuringFull = false;
    await pageD.route('**/api/rp-sync', async (route) => {
        if (!wroteDuringFull && route.request().postDataJSON()?.action === 'upload-complete') {
            wroteDuringFull = true;
            await write(pageD, [['rp_hub_chat_role-9', [message(3, 7)]]]);
        }
        return route.continue();
    });
    assert.equal(await push(pageD, 'fast'), '上传成功。');
    assert.ok(wroteDuringFull);
    assert.ok((await dirtyState(pageD)).tokens.includes(JSON.stringify(['RPHubDB', 'store', 'rp_hub_chat_role-9'])), 'a write during a full upload stays marked too');
    await pageD.unroute('**/api/rp-sync');
    console.log('PASS writes made while an upload is running stay marked and go up with the next fast upload');
    // 云端现在是另一台设备传的；这台再传一次，云端回到这台的数据，好接着测下面的「没改动就不传」
    fastResult(await push(pageA, 'fast'));

    // 8. 没改动：快速上传直接说已是同一份；拉取过的设备下次上传完整扫描；改动太多、布局丢了也完整扫描。
    assert.equal(await push(pageA, 'fast'), '服务器已是同一份数据，无需重复上传。');
    assert.equal((await dirtyState(pageB)).full, true, 'a pull marks everything as changed');
    await write(pageB, [['rp_hub_settings', { theme: 'light' }]]);
    assert.equal(await push(pageB, 'fast'), '上传成功。');
    assert.deepEqual(await dirtyState(pageB), { full: false, tokens: [] });
    await write(pageA, [['rp_hub_settings', { theme: 'blue' }]]);
    await pageA.evaluate(() => localStorage.setItem('rp_hub_sync_dirty_v1:*', '1'));
    assert.equal(await push(pageA, 'fast'), '上传成功。');
    await write(pageA, [['rp_hub_settings', { theme: 'red' }]]);
    await pageA.evaluate(() => api.discardSyncLayout());
    assert.equal(await push(pageA, 'fast'), '上传成功。');
    assert.ok(await pageA.evaluate(() => api.loadSyncLayout()), 'a full upload records the layout again');
    await write(pageA, [['rp_hub_settings', { theme: 'green' }]]);
    assert.match(await push(pageA, 'fast'), /^快速上传成功/);
    console.log('PASS unchanged data is not re-uploaded; pulls, too many changes and a missing layout fall back to a full upload');

    // 9. 点了上传不用等：要传的分片进了本机暂存以后，同步面板能关，进度显示在悬浮条上；这时接着写数据不影响这次上传，写的东西下次快速上传传上去。
    await write(pageA, [['rp_hub_chat_role-5', [message(5, 40)]]]);
    let releaseParts;
    const partsHeld = new Promise((resolve) => { releaseParts = resolve; });
    await pageA.route('**/api/rp-sync?action=upload-part*', async (route) => { await partsHeld; return route.continue(); });
    const pushing = push(pageA, 'fast');
    await pageA.waitForFunction(() => api.state.background === true && !document.querySelector('.rp-sync-modal__close').disabled);
    await pageA.click('.rp-sync-modal__close');
    assert.equal(await pageA.locator('.rp-sync-modal.is-open').count(), 0, 'the sync panel closes while the upload runs');
    await pageA.locator('[data-rph-sync-float][data-kind="busy"]', { hasText: '上传中' }).waitFor();
    await write(pageA, [['rp_hub_chat_role-6', [message(6, 9)]]]);
    releaseParts();
    assert.match(await pushing, /^快速上传成功/, 'writing during the upload does not break it');
    await pageA.locator('[data-rph-sync-float][data-kind="done"]', { hasText: '上传成功' }).waitFor();
    assert.ok((await dirtyState(pageA)).tokens.includes(JSON.stringify(['RPHubDB', 'store', 'rp_hub_chat_role-6'])), 'what was written during the upload waits for the next one');
    assert.equal(await pageA.evaluate(() => localStorage.getItem('rp_hub_sync_pending_upload_v1')), null);
    await pageA.unroute('**/api/rp-sync?action=upload-part*');
    console.log('PASS the panel can be closed during the upload, a floating bar shows progress, and writes made meanwhile wait for the next upload');

    // 10. 传到一半断了：悬浮条显示失败和「重试」；重新打开页面提示「上次上传没传完」，点「继续上传」只补没传上去的分片。
    await write(pageA, Array.from({ length: 12 }, (_, i) => [`rp_hub_chat_role-${10 + i}`, Array.from({ length: 120 }, (__, m) => message(m + 7, 20))]));
    await pageA.evaluate(() => { api.CONFIG.retryCount = 0; });
    const uploadedBefore = new Set();
    let allowed = 3;
    let cutNetwork;
    const networkCut = new Promise((resolve) => { cutNetwork = resolve; });
    await pageA.route('**/api/rp-sync?action=upload-part*', async (route) => {
        if (allowed <= 0) {
            await networkCut; // 面板关了以后再断网
            return route.abort();
        }
        allowed -= 1;
        const response = await route.fetch();
        if (response.ok()) uploadedBefore.add(route.request().headers()['x-rp-part-checksum']); // 服务器回了成功才算传上去了
        return route.fulfill({ response });
    });
    const broken = push(pageA, 'fast');
    await pageA.waitForFunction(() => api.state.background === true);
    await pageA.click('.rp-sync-modal__close');
    cutNetwork();
    await broken;
    await pageA.locator('[data-rph-sync-float][data-kind="error"]', { hasText: '上传失败' }).waitFor();
    assert.ok(await pageA.evaluate(() => localStorage.getItem('rp_hub_sync_pending_upload_v1')), 'the unfinished upload is remembered');
    await pageA.unroute('**/api/rp-sync?action=upload-part*');
    const uploadedAfter = [];
    await pageA.route('**/api/rp-sync?action=upload-part*', (route) => {
        uploadedAfter.push(route.request().headers()['x-rp-part-checksum']);
        return route.continue();
    });
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await initializeFixture(pageA);
    await pageA.evaluate(() => { api.CONFIG.chunkSize = 256 * 1024; });
    await pageA.locator('[data-rph-sync-float][data-kind="resume"]', { hasText: '上次上传没传完' }).waitFor();
    await pageA.locator('[data-rph-sync-float] [data-act]', { hasText: '继续上传' }).click();
    await pageA.waitForFunction(() => !api.state.syncing && /^快速上传成功/.test(api.state.statusText), null, { timeout: 60_000 });
    assert.ok(uploadedBefore.size >= 3 && uploadedAfter.length > 0, `${uploadedBefore.size} parts went up before the break, ${uploadedAfter.length} after`);
    assert.ok(!uploadedAfter.some((checksum) => uploadedBefore.has(checksum)), 'parts that already went up are not sent again');
    assert.equal(await pageA.evaluate(() => localStorage.getItem('rp_hub_sync_pending_upload_v1')), null);
    const pageE = await openDevice();
    await pullInto(pageE);
    const [a3, e] = await Promise.all([dumpDevice(pageA), dumpDevice(pageE)]);
    assert.deepEqual(sortEntries(e.records), sortEntries(a3.records), 'after resuming, another device pulls exactly this device\'s data');
    console.log(`PASS a broken upload shows retry, and after reopening the page it resumes: ${uploadedBefore.size} parts before the break, ${uploadedAfter.length} after, none sent twice`);
    assert.deepEqual(pageErrors, []);
} finally {
    stopSite();
    await browser?.close();
    await fs.rm(harness, { recursive: true, force: true }).catch(() => {});
}
