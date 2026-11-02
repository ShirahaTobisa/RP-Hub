import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';
import { patchRpHubCloudBackupJs, RP_HUB_CLOUD_BACKUP_PATH } from '../DB/app-patches.mjs';

// 从官方 RP-Hub 搬过来：官方「上传备份」得到的密钥，在测试版设置页「下载备份」里输入，角色卡和聊天合并进来。
// 对话框、比对和写入都是上游 cloud-backup.js 自己的；这里验证打过补丁后它读写的是我们的分键角色存储，
// 设置页只留「下载备份」，以及原作者的服务器只在用户输入密钥后才被连。
const cloudBackupFile = path.join(defaultUpstream, RP_HUB_CLOUD_BACKUP_PATH);
if (!fs.existsSync(cloudBackupFile)) {
    console.log(`SKIP upstream at ${defaultUpstream} has no cloud backup (2.0.4+)`);
    process.exit(0);
}
// 真文件要能打上补丁（核心测试只用缩写的片段）。
const patched = patchRpHubCloudBackupJs(fs.readFileSync(cloudBackupFile, 'utf8'), { version: 'fixture' });
assert.equal(patched.report.detected.characterLoad, 3);
assert.equal(patched.report.detected.characterSave, 1);

const apiBase = fs.readFileSync(path.join(defaultUpstream, 'index.html'), 'utf8')
    .match(/<meta name="rphub-update-api" content="([^"]+)"/)[1].replace(/\/+$/, '');
const KEY = 'ABCD-EFGH-JKMN-PQRS';
const encode = value => JSON.stringify(value ?? null);
const piece = value => ({ hash: createHash('sha256').update(encode(value)).digest('hex'), size: Buffer.byteLength(encode(value)) });
const chat = text => [{ role: 'user', content: text }];

// 本机：甲和备份完全相同，乙内容不同（还多一条本机才有的分支聊天），丙没有。
// 备份里的卡在页面启动、把本机的卡补齐默认字段之后再定，和官方站传上来的一样是完整的卡。
const cardA = { uuid: 'char-a', name: '甲', description: '一样的' };
const cardB = { uuid: 'char-b', name: '乙', description: '本机的旧版' };
let backup = null;
let pieces = null;
let blobs = null;
let manifest = null;
const buildBackup = (storedA, storedB) => {
    backup = {
        A: storedA, chatA: chat('备份里甲的聊天'),
        B: { ...storedB, description: '备份里的新版' }, chatB: chat('备份里乙的聊天'),
        C: { uuid: 'char-c', name: '丙', description: '新来的' }, chatC: chat('丙的聊天')
    };
    pieces = Object.fromEntries(Object.entries(backup).map(([name, value]) => [name, piece(value)]));
    blobs = new Map(Object.entries(backup).map(([name, value]) => [pieces[name].hash, value]));
    manifest = {
        createdAt: Date.now(),
        expiresAt: Date.now() + 86400000,
        characters: ['A', 'B', 'C'].map((name) => ({
            uuid: backup[name].uuid, name: backup[name].name, ...pieces[name],
            entries: [{ name: 'chat', id: backup[name].uuid, ...pieces[`chat${name}`] }]
        }))
    };
};

const readStore = (page, keys) => page.evaluate(async (keys) => {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const read = (key) => new Promise((resolve, reject) => {
        const request = db.transaction('store').objectStore('store').get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const out = {};
    for (const key of keys) out[key] = await read(key);
    db.close();
    return out;
}, keys);

const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
const served = [];
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    // 假装是原作者的备份服务：清单和数据块按上游服务器的接口返回。
    await page.route((url) => url.href.startsWith(`${apiBase}/v1/backup/`), async (route) => {
        const { pathname } = new URL(route.request().url());
        served.push(pathname);
        const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json; charset=utf-8' };
        const match = pathname.match(/^\/v1\/backup\/([0-9A-Z]{16})(?:\/blobs\/([0-9a-f]{64}))?$/);
        if (!manifest || !match || match[1] !== KEY.replace(/-/g, '')) return route.fulfill({ status: 404, headers, body: JSON.stringify({ error: '密钥无效或已过期' }) });
        if (!match[2]) return route.fulfill({ status: 200, headers, body: JSON.stringify(manifest) });
        if (!blobs.has(match[2])) return route.fulfill({ status: 404, headers, body: JSON.stringify({ error: '备份里没有这项内容' }) });
        return route.fulfill({ status: 200, headers, body: encode(blobs.get(match[2])) });
    });

    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ cardA, cardB }) => {
        const user = { uuid: 'u', name: '用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            // 填好用户资料，上游的首次设置弹窗才不会盖住设置页。
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', 'u'], ['rp_hub_settings', { autoFetchModels: false }],
            ['rp_hub_character_index', { order: ['char-a', 'char-b'] }],
            ['rp_hub_character_char-a', cardA],
            ['rp_hub_character_char-b', cardB],
            ['rp_hub_chat_char-a', [{ role: 'user', content: '本机甲的聊天' }]],
            ['rp_hub_chat_char-b', [{ role: 'user', content: '本机乙的聊天' }]],
            ['rp_hub_chat_char-b__branch__x1', [{ role: 'user', content: '本机乙的分支' }]]
        ]);
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
    }, { cardA, cardB });

    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
    // 本机有角色卡时上游初始化完会自己切回聊天页，所以一直把视图按在设置页，直到那一段出现。
    await page.waitForFunction(() => {
        const app = document.querySelector('#app').__vue_app__;
        const proxy = app._instance?.proxy || app._container._vnode.component.proxy;
        if (proxy.currentView !== 'settings') proxy.currentView = 'settings';
        return !!document.querySelector('[data-rph-cloud-restore]');
    }, null, { timeout: 30000, polling: 500 });
    const ui = await page.evaluate(() => {
        const grid = document.querySelector('[data-rph-cloud-restore]');
        const visible = (text) => [...grid.querySelectorAll('button')].filter((button) => button.textContent.includes(text)).map((button) => button.offsetParent !== null);
        return { oneColumn: grid.classList.contains('grid-cols-1') && !grid.classList.contains('grid-cols-2'), upload: visible('上传备份'), download: visible('下载备份'), hint: grid.nextElementSibling?.textContent || '' };
    });
    assert.deepEqual(ui.upload, [false], '「上传备份」要藏起来');
    assert.deepEqual(ui.download, [true], '「下载备份」要能看到');
    assert.ok(ui.oneColumn && ui.hint.includes('官方 RP-Hub'), '按钮占满一行，下面有怎么搬的提示');
    assert.deepEqual(served, [], '没输入密钥之前不能连原作者的服务器');

    const stored = await readStore(page, ['rp_hub_character_char-a', 'rp_hub_character_char-b', 'rp_hub_characters']);
    assert.equal(stored['rp_hub_characters'], undefined, '启动后角色卡仍在分键存储里');
    buildBackup(stored['rp_hub_character_char-a'], stored['rp_hub_character_char-b']);

    await page.getByRole('button', { name: '下载备份' }).click();
    await page.locator('input[placeholder="XXXX-XXXX-XXXX-XXXX"]').fill(KEY);
    await page.evaluate(() => { window.__beforeRestore = true; });
    await page.getByRole('button', { name: '开始下载' }).click();
    // 恢复完成后上游自己刷新页面。
    await page.waitForFunction(() => !window.__beforeRestore && document.querySelector('#app')?.__vue_app__, null, { timeout: 60000 });

    const after = await readStore(page, ['rp_hub_character_index', 'rp_hub_character_char-a', 'rp_hub_character_char-b', 'rp_hub_character_char-c',
        'rp_hub_chat_char-a', 'rp_hub_chat_char-b', 'rp_hub_chat_char-b__branch__x1', 'rp_hub_chat_char-c', 'rp_hub_characters']);
    const dirty = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('rp_hub_sync_dirty_v1:')));
    assert.deepEqual(after['rp_hub_character_index'].order, ['char-a', 'char-b', 'char-c'], '新角色卡接在后面，顺序不变');
    assert.equal(after['rp_hub_character_char-a'].description, '一样的');
    assert.equal(after['rp_hub_character_char-b'].description, '备份里的新版', '内容不同的角色卡以备份为准');
    assert.equal(after['rp_hub_character_char-c'].description, '新来的');
    assert.equal(after['rp_hub_chat_char-a'][0].content, '本机甲的聊天', '相同的角色卡连聊天一起保留本机的');
    assert.equal(after['rp_hub_chat_char-b'][0].content, '备份里乙的聊天');
    assert.equal(after['rp_hub_chat_char-b__branch__x1'], undefined, '被替换的角色卡不保留本机才有的分支');
    assert.equal(after['rp_hub_chat_char-c'][0].content, '丙的聊天');
    assert.equal(after['rp_hub_characters'], undefined, '不能写回旧的整表 characters 键');
    assert.ok(dirty.some((key) => key.includes('rp_hub_character_char-c')), '恢复进来的记录要记成改过，快速上传才会带上');
    assert.ok(served.some((pathname) => pathname.endsWith(`/blobs/${pieces.C.hash}`)), '新角色卡从备份下载');
    assert.ok(!served.some((pathname) => pathname.endsWith(`/blobs/${pieces.chatA.hash}`)), '相同的角色卡连聊天都不下载');
    assert.deepEqual(errors, []);
    console.log('PASS an official RP-Hub cloud backup restores into the split character store: 1 added, 1 replaced, 1 skipped');
} finally {
    await browser.close();
    await harness.close();
}
