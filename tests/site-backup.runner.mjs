import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 全站备份插件：A 站点导出（ZIP / JSON），导入到另一个网址的 B 站点；数据完整搬过去，B 站点自己的同步密码和同步设置保留。
const siteA = await startHarness({ upstream: defaultUpstream });
const siteB = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];

async function openSite(harness, seed) {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base, seed }) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url: base + '/DB/modules/site-backup.js', enabled: true }]));
        for (const [key, value] of Object.entries(seed.local)) localStorage.setItem(key, value);
        const db = await fixture.db();
        // 二进制值在页面里生成：Playwright 传参不能直接带 ArrayBuffer。
        await fixture.write(db, seed.records.map(([key, value]) => [key, value === '__BIN__' ? new Uint8Array([1, 2, 3, 250]).buffer : value]));
        db.close();
    }, { base: harness.url, seed });
    await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.RPHubSDK && document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
    return { context, page };
}

async function openBackupPanel(page) {
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]').some((entry) => entry.lastStatus === 'ok'), null, { timeout: 30000 });
    await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent)?.click());
    await page.locator('[data-rph-workshop-manager-entry]').waitFor({ state: 'attached' });
    await page.evaluate(() => document.querySelector('[data-rph-workshop-manager-entry]').click());
    await page.locator('[data-rph-workshop-launcher] button', { hasText: '全站备份' }).click();
    await page.locator('[data-rph-workshop-panel] [data-act="zip"]').waitFor();
}

const readState = (page) => page.evaluate(async () => {
    const db = await fixture.db();
    const read = (key) => new Promise((resolve) => { const request = db.transaction('store').objectStore('store').get(key); request.onsuccess = () => resolve(request.result); });
    const result = { character: await read('rp_hub_character_card-a'), audio: await read('rp_hub_binary_probe'), note: localStorage.getItem('rphub_notes_v1'),
        password: localStorage.getItem('rp_hub_sync_password_v1'), syncState: localStorage.getItem('rp_hub_sync_state_probe') };
    db.close();
    result.audio = result.audio ? Array.from(new Uint8Array(result.audio)) : null;
    return result;
});

try {
    const a = await openSite(siteA, {
        local: { rp_hub_sync_password_v1: 'password-A', rp_hub_sync_state_probe: 'state-A', rphub_notes_v1: '来自 A 站点的便签' },
        records: [['rp_hub_character_card-a', { uuid: 'card-a', name: 'A 站角色' }], ['rp_hub_binary_probe', '__BIN__']]
    });
    await openBackupPanel(a.page);
    const files = {};
    for (const kind of ['zip', 'json']) {
        const download = a.page.waitForEvent('download');
        await a.page.locator(`[data-rph-workshop-panel] [data-act="${kind}"]`).click();
        files[kind] = await (await download).path();
        await a.page.locator('[data-rph-workshop-panel] [data-status]', { hasText: '已导出' }).waitFor();
    }
    console.log('PASS site A exports a ZIP and a JSON backup');

    for (const kind of ['zip', 'json']) {
        const b = await openSite(siteB, {
            local: { rp_hub_sync_password_v1: 'password-B', rp_hub_sync_state_probe: 'state-B', rphub_notes_v1: 'B 站点原来的便签' },
            records: [['rp_hub_character_card-b', { uuid: 'card-b', name: 'B 站角色' }]]
        });
        await openBackupPanel(b.page);
        const chooser = b.page.waitForEvent('filechooser');
        await b.page.locator('[data-rph-workshop-panel] [data-act="import"]').click();
        await (await chooser).setFiles(files[kind]);
        await b.page.locator('[data-rph-ui-confirm] [data-rph-ui-confirm-accept]').click();
        await b.page.waitForEvent('load', { timeout: 30000 });
        await b.page.waitForFunction(() => document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
        await initializeFixture(b.page);
        const state = await readState(b.page);
        assert.deepEqual(state.character, { uuid: 'card-a', name: 'A 站角色' }, kind);
        assert.deepEqual(state.audio, [1, 2, 3, 250], `${kind}: binary values survive the round trip`);
        assert.equal(state.note, '来自 A 站点的便签', kind);
        assert.equal(state.password, 'password-B', `${kind}: the target site keeps its own sync password`);
        assert.equal(state.syncState, 'state-B', `${kind}: the target site keeps its own sync state`);
        await b.context.close();
        console.log(`PASS ${kind.toUpperCase()} backup imports into another site, keeping that site's sync password and state`);
    }
    await a.context.close();
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await siteA.close();
    await siteB.close();
}
