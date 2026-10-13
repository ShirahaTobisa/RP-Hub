import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, chrome, root, instrument, initializeFixture } from './sync-195.helpers.mjs';

// 魔改版用户换成测试版（端到端）：魔改版自己的同步代码（cy-2-u/rp，CC BY-NC 4.0，固定提交）把数据传进本地 R2；
// 同一个网址、同一个存储桶换成测试版（npm run build 生成的 dist）以后：
// - 新设备点「下载」，魔改版的数据原样导进来；
// - 原来用魔改版的设备导入后，本机的 API 预设和魔改版不同步的设置都还在，魔改版留下的同名临时库不碍事，旧生图记录换成我们的写法；
// - 第一次上传前问一句（可取消），上传后云端换成测试版格式，别的设备照常拉取。
// 需要全局安装的 wrangler；第一次运行要联网下载魔改版代码（按固定提交下载并核对 SHA-256）。
const FORK_REPO = 'cy-2-u/rp';
const FORK_COMMIT = 'd98750264a401fd0d871e20c7d07071f4b1c60c0';
const FORK_FILES = {
    '_worker.js': 'd9d255f9d3fb489b1a96bc486fe43fae192b4507fb2a4bd641140c354975a80c',
    'DB/bootstrap.js': '08b99416cabe069d3cd832588103d96f735b34db6555f1559985d69d07c91652',
    'DB/dirty-tracker.js': 'd70bc2fba3a854d5ca8be0d3c60636c3a57fa578f44eac5f60b2edef74f05e03'
};
const PASSWORD = 'fork-migration-password';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const forkSite = path.join(root, 'evidence/fork-site', FORK_COMMIT.slice(0, 12));
const dist = process.env.RPH_PACKAGE_ROOT || path.join(root, 'dist');
const wrangler = path.join(process.env.APPDATA, 'npm/node_modules/wrangler/bin/wrangler.js');

for (const [file, hash] of Object.entries(FORK_FILES)) {
    const target = path.join(forkSite, file);
    const existing = await fs.readFile(target).catch(() => null);
    if (existing && sha256(existing) === hash) continue;
    const response = await fetch(`https://raw.githubusercontent.com/${FORK_REPO}/${FORK_COMMIT}/page/${file}`);
    assert.equal(response.status, 200, `下载魔改版 ${file} 失败`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(bytes), hash, `魔改版 ${file} 和固定提交的内容不一致`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
}

const harness = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-fork-migration-'));
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

const chat = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `第 ${i} 条消息🙂`.repeat(20) }));
const forkImage = {
    storyScopeId: 'main', messageId: 'm1', messageIndex: 1, contentHash: 'e1d2c3b', occurrenceIndex: 0,
    prompt: '1girl, smile', promptHash: '9f8e7d6',
    paramsSnapshot: { provider: '', model: 'nai-diffusion-4-5-full', artist: 'artist:x', size: '竖图', steps: '28', scale: '5', cfg: '0',
        sampler: 'k_euler_ancestral', negative: '', nocache: '0', noise_schedule: 'karras', rerollNonce: '', characterName: '角色A' },
    imageKey: `rp-images/characters/角色A/${'d'.repeat(64)}`, key: 'main:m1:0:9f8e7d6'
};
const presets = { custom: [{ name: '本机预设', key: 'sk-local-only' }], enabled: true };
const seed = {
    records: [
        ['rp_hub_chat_role-a', chat],
        ['rp_hub_character_index', { order: ['role-a'] }],
        ['rp_hub_character_role-a', { uuid: 'role-a', name: '角色A', description: '迁移测试' }],
        ['rp_hub_image_renders_role-a', [forkImage]],
        ['rp_hub_presets', presets],
        ['rp_hub_settings', { theme: 'dark', nested: { list: [1, 2, 3] } }]
    ],
    characters: [['c1', { id: 'c1', name: '生成器角色' }]],
    localStorage: [['rp_hub_theme_mode', 'dark'], ['rp_hub_magic_fixed_image', '1'], ['rphub_notes_v1', '本机便签'], ['not_app_key', 'keep']]
};
const synced = seed.records.filter(([key]) => key !== 'rp_hub_presets');

// 读出整个设备的数据，好和种下去的比。
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
    const local = Object.fromEntries(['rp_hub_theme_mode', 'rp_hub_magic_fixed_image', 'rphub_notes_v1', 'not_app_key'].map((key) => [key, localStorage.getItem(key)]));
    return { records: await read('RPHubDB', 'store'), characters: await read('AICharGen', 'characters'), local };
});
const sortEntries = (entries) => [...entries].sort(([a], [b]) => (a < b ? -1 : 1));
const pullManifest = (page) => page.evaluate(async () => (await fetch('/api/rp-sync', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rp-sync-password': localStorage.getItem('rp_hub_sync_password_v1') },
    body: JSON.stringify({ action: 'pull-manifest' })
})).json());

let browser;
try {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const remember = (password) => localStorage.setItem('rp_hub_sync_password_v1', password);
    const deviceA = await browser.newContext();
    await deviceA.addInitScript(remember, PASSWORD);
    const pageErrors = [];

    // 1. 魔改版：种数据（经过它的变更日志），用它自己的上传传进 R2。
    site = await startSite(forkSite);
    const forkPage = await deviceA.newPage();
    forkPage.on('pageerror', (error) => pageErrors.push(`fork: ${error.message}`));
    await forkPage.route(`${origin}/`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"></div>'
        + '<script>window.RPHubExternal = { version: 1, flush: async () => {} };</script><script src="/DB/dirty-tracker.js"></script><script src="/DB/bootstrap.js"></script></body></html>' }));
    await forkPage.route('**/DB/bootstrap.js', async (route) => {
        const response = await route.fetch();
        const marker = 'const pushToServer = () => runSyncOperation(() => pushToServerUnlocked());';
        const source = await response.text();
        assert.ok(source.includes(marker));
        await route.fulfill({ response, body: source.replace(marker, `${marker}\n    window.__forkPush = pushToServer;`) });
    });
    await forkPage.goto(origin);
    const forkPush = await forkPage.evaluate(async (data) => {
        const open = (name, store) => new Promise((resolve, reject) => {
            const request = indexedDB.open(name);
            request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        const write = (db, store, entries) => new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite');
            for (const [key, value] of entries) tx.objectStore(store).put(value, key);
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error);
        });
        const hub = await open('RPHubDB', 'store');
        await write(hub, 'store', data.records);
        hub.close();
        const chargen = await open('AICharGen', 'characters');
        await write(chargen, 'characters', data.characters);
        chargen.close();
        for (const [key, value] of data.localStorage) localStorage.setItem(key, value);
        const result = await window.__forkPush();
        return { result, staging: (await indexedDB.databases()).find((item) => item.name === 'RPHubSyncStaging')?.version ?? null };
    }, seed);
    assert.ok(!forkPush.result?.error, JSON.stringify(forkPush));
    // 魔改版做过一次恢复的设备上才会有它的同名临时库；这里直接按它的版本建一个，模拟那种设备。
    await forkPage.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubSyncStaging', 3);
        request.onupgradeneeded = () => request.result.createObjectStore('packs');
        request.onsuccess = () => { request.result.close(); resolve(); };
        request.onerror = () => reject(request.error);
    }));
    await forkPage.close();
    stopSite();
    console.log('PASS the fork uploaded its data with its own sync code');

    // 2. 同一个网址、同一个存储桶换成测试版。
    site = await startSite(dist);
    const html = await (await fetch(origin)).text();
    const scripts = [...html.matchAll(/<script src="(\/DB\/[^"\s]+)"><\/script>/g)].map((match) => match[0]).join('');
    assert.ok(scripts.includes('/DB/bootstrap.js'));
    const openOurs = async (context) => {
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(`ours: ${error.message}`));
        await page.route(`${origin}/`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app"><aside class="app-sidebar"><button><svg></svg><span>设置</span></button></aside></div>${scripts}</body></html>` }));
        await page.route('**/DB/bootstrap.js?*', async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, body: instrument(await response.text()) });
        });
        await page.goto(origin);
        await initializeFixture(page);
        return page;
    };

    const status = await pullManifest(await openOurs(deviceA).then((page) => { deviceA.page = page; return page; }));
    const pageA = deviceA.page;
    assert.equal(status.remote, null);
    assert.equal(status.fork.snapshotFormat, 'rp-sync-paged-jsonl-v4');
    console.log('PASS the test build sees the fork data in the same bucket');

    // 3. 新设备：「下载」把魔改版的数据原样导进来。
    const deviceB = await browser.newContext();
    await deviceB.addInitScript(remember, PASSWORD);
    const pageB = await openOurs(deviceB);
    await pageB.evaluate(async () => {
        const { fork } = await (await fetch('/api/rp-sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rp-sync-password': localStorage.getItem('rp_hub_sync_password_v1') }, body: JSON.stringify({ action: 'pull-manifest' }) })).json();
        await api.runSyncLocked(() => api.restoreStreamSnapshot(fork));
    });
    const imported = await dumpDevice(pageB);
    assert.deepEqual(sortEntries(imported.records), sortEntries(synced));
    assert.deepEqual(imported.characters, seed.characters);
    assert.deepEqual(imported.local, { rp_hub_theme_mode: 'dark', rp_hub_magic_fixed_image: '1', rphub_notes_v1: null, not_app_key: null });
    console.log('PASS a new device imports the fork data as it was');

    // 4. 原来用魔改版的设备：同名临时库不碍事；「下载」（真实按钮流程，导完刷新）后本机预设和不同步的设置都在。
    const stagingVersion = await pageA.evaluate(async () => {
        const db = await api.openDownloadStagingDb();
        db.close();
        return (await indexedDB.databases()).find((item) => item.name === 'RPHubSyncStaging').version;
    });
    assert.equal(stagingVersion, 1);
    await Promise.all([pageA.waitForEvent('load', { timeout: 60_000 }), pageA.evaluate(() => api.pullFromServer())]);
    await initializeFixture(pageA);
    const migrated = await dumpDevice(pageA);
    // 刷新后生图模块照常写回它自己的生图正则，不算导入的数据。
    assert.deepEqual(sortEntries(migrated.records.filter(([key]) => key !== 'rp_hub_global_regex')), sortEntries(seed.records));
    assert.deepEqual(migrated.local, { rp_hub_theme_mode: 'dark', rp_hub_magic_fixed_image: '1', rphub_notes_v1: '本机便签', not_app_key: 'keep' });
    console.log('PASS the fork device imports through the pull button and keeps its presets and local-only settings');

    // 5. 旧生图记录换成我们的写法：key、补零的哈希、分支、提示词，显示时带上原图在 R2 的位置。
    const image = await pageA.evaluate((record) => {
        const normalized = RPHubImageModule.normalizeImageRenderRecord(record, 'role-a');
        return { normalized, url: RPHubImageModule.buildImageRenderUrl(normalized.paramsSnapshot) };
    }, forkImage);
    assert.equal(image.normalized.key, 'm1:0e1d2c3b:0:09f8e7d6');
    assert.equal(image.normalized.branchId, 'main');
    assert.equal(image.normalized.paramsSnapshot.tag, '1girl, smile');
    assert.equal(image.normalized.paramsSnapshot.characterUuid, 'role-a');
    assert.equal(new URL(image.url, origin).searchParams.get('image_key'), forkImage.imageKey);
    console.log('PASS fork image records turn into ours and point at the stored image');

    // 6. 第一次上传前问一句：取消就不动云端；确认后云端换成测试版格式，别的设备照常拉取。
    // 测试页没有 RPH 本体，上传前的保存接口和别的同步测试一样用角色卡存储代替。
    await pageA.evaluate(() => { globalThis.RPH_R2_FLUSH_PERSISTENCE = () => RPHubCharStore.waitForPendingMutations(); });
    const upload = async (button) => {
        const pushing = pageA.evaluate(() => api.pushToServer().then(() => api.state.statusText));
        const asked = pageA.getByRole('button', { name: button });
        const ended = await Promise.race([pushing.then((text) => `没有询问就结束了：${text}`), asked.waitFor().then(() => '')]);
        assert.equal(ended, '');
        await asked.click();
        return pushing;
    };
    assert.equal(await upload('取消'), '已取消上传。');
    assert.ok((await pullManifest(pageA)).fork);
    assert.equal(await upload('仍然上传'), '上传成功。');
    const after = await pullManifest(pageA);
    assert.equal(after.fork, undefined);
    assert.equal(after.remote.snapshotFormat, 'rp-sync-jsonl-v1');
    await pageB.evaluate(async () => {
        const { remote } = await (await fetch('/api/rp-sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rp-sync-password': localStorage.getItem('rp_hub_sync_password_v1') }, body: JSON.stringify({ action: 'pull-manifest' }) })).json();
        await api.runSyncLocked(() => api.restoreStreamSnapshot(remote));
    });
    assert.deepEqual(sortEntries((await dumpDevice(pageB)).records), sortEntries((await dumpDevice(pageA)).records));
    console.log('PASS the first upload asks first, then other devices pull the test build format');
    assert.deepEqual(pageErrors, []);
} finally {
    await browser?.close();
    stopSite();
    // The mkdtemp path is confined to this test's own directory.
    if (path.dirname(harness) === os.tmpdir() && path.basename(harness).startsWith('rph-fork-migration-')) await fs.rm(harness, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
