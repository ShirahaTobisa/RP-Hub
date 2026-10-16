import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 魔改版（cy-2-u/rp）给本地数据库 RPHubDB 加过自己的表，版本升到了 2；RPH 和生图模块固定按版本 1 打开。
// 同一个网址从魔改版换成测试版后，这台浏览器上的数据必须照常读出来，不能报“加载保存的数据失败”。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const consoleErrors = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async () => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        const uuid = 'fork-card';
        const character = { uuid, name: '魔改版角色', description: '迁移验收', first_mes: '你好', worldInfo: [], regexScripts: [], uiTemplates: [] };
        const user = { uuid: 'fork-user', name: '迁移用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: [uuid] }], ['rp_hub_character_' + uuid, character],
            ['rp_hub_chat_' + uuid, [{ id: 'm1', role: 'assistant', name: character.name, content: '迁移前的聊天记录' }]],
            ['rp_hub_settings', { autoFetchModels: false }], ['rp_hub_user', user], ['rp_hub_user_profiles', [user]],
            ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
        // 照魔改版 dirty-tracker 的做法：升到版本 2，加它的日志表。
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 2);
            request.onupgradeneeded = () => request.result.createObjectStore('__rp_sync_journal_v2', { autoIncrement: true });
            request.onsuccess = () => { request.result.close(); resolve(); };
            request.onerror = () => reject(request.error);
        });
    });
    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
    await page.waitForTimeout(3000);
    const state = await page.evaluate(() => {
        const app = document.querySelector('#app').__vue_app__;
        const vm = (app._instance || app._container._vnode.component).proxy;
        return {
            characters: vm.characters.map((item) => item.name),
            toasts: [...document.querySelectorAll('.toast-item')].map((item) => item.textContent.trim())
        };
    });
    assert.ok(!state.toasts.some((text) => text.includes('加载保存的数据失败')), JSON.stringify(state.toasts));
    assert.ok(!consoleErrors.some((text) => /VersionError|less than the existing version/.test(text)), consoleErrors.join(' | '));
    assert.deepEqual(state.characters, ['魔改版角色']);
    const version = await page.evaluate(() => new Promise((resolve) => {
        const request = indexedDB.open('RPHubDB');
        request.onsuccess = () => { const value = request.result.version; request.result.close(); resolve(value); };
    }));
    assert.equal(version, 2, 'the existing database is used as is, not downgraded or deleted');
    const imageDb = await page.evaluate(async () => (await RPHubImageModule.flushRecords().then(() => 'ok', (error) => String(error?.message || error))));
    assert.equal(imageDb, 'ok', 'the image module can open the same database too');
    console.log('PASS a browser whose RPHubDB was upgraded by the fork still loads its data on the test build');

    // 正常使用不受影响：全新的浏览器照样建出版本 1 的库，新建角色、保存、刷新后还在。
    const fresh = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    fresh.on('pageerror', (error) => errors.push(error.message));
    await fresh.addInitScript(() => localStorage.setItem('roleplay_hub_update_id', '9999999990'));
    const vmCall = (script) => fresh.evaluate(script);
    await fresh.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await fresh.waitForFunction(() => document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
    await fresh.waitForTimeout(2000);
    await vmCall(() => {
        const app = document.querySelector('#app').__vue_app__;
        const vm = (app._instance || app._container._vnode.component).proxy;
        vm.createNewCharacter();
        vm.editingCharacter.data.name = '新用户角色';
        vm.saveCharacter();
    });
    const readIndex = () => vmCall(() => new Promise((resolve) => {
        const request = indexedDB.open('RPHubDB');
        request.onsuccess = () => {
            const db = request.result;
            const get = db.transaction('store').objectStore('store').get('rp_hub_character_index');
            get.onsuccess = () => { const value = { version: db.version, stores: [...db.objectStoreNames], order: get.result?.order?.length || 0 }; db.close(); resolve(value); };
        };
    }));
    let stored = await readIndex();
    for (let attempt = 0; attempt < 20 && !stored.order; attempt += 1) {
        await fresh.waitForTimeout(250);
        stored = await readIndex();
    }
    assert.deepEqual(stored, { version: 1, stores: ['store'], order: 1 }, 'a new browser still gets a version 1 database with the RPH store');
    await fresh.reload({ waitUntil: 'domcontentloaded' });
    await fresh.waitForFunction(() => document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
    await fresh.waitForTimeout(2000);
    const names = await vmCall(() => {
        const app = document.querySelector('#app').__vue_app__;
        return (app._instance || app._container._vnode.component).proxy.characters.map((item) => item.name);
    });
    assert.deepEqual(names, ['新用户角色']);
    console.log('PASS a new browser creates a version 1 database, saves a character and keeps it after reload');
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await harness.close();
}
