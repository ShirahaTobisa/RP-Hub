import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream, root } from './sync-195.helpers.mjs';

// 空间管理插件：上游还有「空间管理」（2.0.3 及更早）时不加第二份；上游删了（2.0.4 起）就补在设置页最底下，
// 统计后只清掉已删角色的聊天、记忆、分支和旧正文分片，现有角色和库里存着但页面没加载的角色都不动。
const source = await fs.readFile(path.join(root, 'DB/modules/storage-manager.js'), 'utf8');
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const kept = ['character_live-card', 'chat_live-card', 'classic_memories_live-card', 'branches_live-card', 'chat_live-card__branch__b1',
    'character_ghost-card', 'chat_ghost-card'];
const orphans = ['chat_dead-card', 'classic_memories_dead-card', 'branches_dead-card', 'chat_dead-card__branch__b2', 'memories_old'];
const keys = () => page.evaluate(async () => {
    const db = window.RPHubStorage.getMainDb();
    const all = await new Promise((resolve) => { const request = db.transaction('store').objectStore('store').getAllKeys(); request.onsuccess = () => resolve(request.result); });
    return all.map(String);
});

try {
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ source, kept, orphans }) => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        const character = { uuid: 'live-card', name: '现有角色', description: '', first_mes: '你好', worldInfo: [], regexScripts: [], uiTemplates: [] };
        const user = { uuid: 'sm-user', name: '验收用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: ['live-card'] }],
            ['rp_hub_settings', { autoFetchModels: false }],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0],
            ...[...kept, ...orphans].map((key) => ['rp_hub_' + key, key.startsWith('character_') ? { ...character, uuid: key.slice(10) } : [{ id: 'm', role: 'assistant', content: 'x'.repeat(2000) }]])
        ]);
        db.close();
        const workshop = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubWorkshop', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('scripts'); request.result.createObjectStore('data'); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
            const tx = workshop.transaction('scripts', 'readwrite');
            tx.objectStore('scripts').put(source, 'rphub-file:storage-manager.js');
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error);
        });
        workshop.close();
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ id: 'storage-manager', url: 'rphub-file:storage-manager.js', enabled: true }]));
    }, { source, kept, orphans });

    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1'))[0].lastStatus === 'ok', null, { timeout: 45000 });
    const setView = (view) => page.evaluate((value) => {
        const app = document.querySelector('#app').__vue_app__;
        (app._instance?.proxy || app._container._vnode.component.proxy).currentView = value;
    }, view);
    const headings = () => page.evaluate(() => [...document.querySelectorAll('h4.settings-subheading')].map((node) => node.textContent.trim()));
    await setView('settings');
    await page.waitForSelector('h4.settings-subheading', { timeout: 15000 });
    await page.waitForTimeout(1000);

    assert.equal((await headings()).filter((text) => text === '空间管理').length, 1, '设置页有且只有一个「空间管理」');
    if (!await page.locator('#rph-storage-manager').count()) {
        console.log('PASS upstream still has its storage section, the plugin adds nothing');
    } else {
        const section = page.locator('#rph-storage-manager');
        await section.locator('[data-part="measure"]').click();
        await page.waitForFunction(() => document.querySelector('#rph-storage-manager [data-part="measure"]').textContent === '重新统计', null, { timeout: 15000 });
        const labels = await section.locator('[data-part="list"] .truncate').allTextContents();
        assert.deepEqual(labels.filter((label) => label !== '其他'), ['角色卡', '聊天记录', '记忆系统']);
        assert.equal(await section.locator('[data-part="clean"]').isEnabled(), true);
        console.log('PASS the plugin restores the storage section at the bottom of settings and measures usage by category');

        await section.locator('[data-part="clean"]').click();
        await page.locator('[data-rph-ui-confirm]', { hasText: `将清理 ${orphans.length} 项无用残留` }).waitFor({ timeout: 15000 });
        await page.locator('[data-rph-ui-confirm] [data-rph-ui-confirm-accept]').click();
        await page.locator('.toast-item', { hasText: `已清理 ${orphans.length} 项无用残留` }).waitFor({ timeout: 15000 });
        const left = await keys();
        for (const key of kept) assert.ok(left.includes('rp_hub_' + key), `${key} 不该被清理`);
        for (const key of orphans) assert.ok(!left.includes('rp_hub_' + key), `${key} 应该被清理`);
        await page.waitForFunction(() => document.querySelector('#rph-storage-manager [data-part="clean"]').disabled, null, { timeout: 15000 });
        console.log('PASS cleanup removes only deleted characters\' leftovers and keeps stored characters the page has not loaded');

        await setView('chat');
        await page.waitForTimeout(300);
        await setView('settings');
        await page.waitForSelector('#rph-storage-manager', { timeout: 15000 });
        await page.waitForTimeout(1000);
        assert.equal(await page.locator('#rph-storage-manager').count(), 1, '离开再回到设置页只有一份');
        console.log('PASS leaving and reopening settings keeps a single storage section');
    }
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await harness.close();
}
