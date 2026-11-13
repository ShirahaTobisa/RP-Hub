import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { startHarness, initializeFixture, chromium, chrome, root, defaultUpstream } = await import(pathToFileURL(path.join(path.resolve(process.argv[2] || fileURLToPath(new URL('../../', import.meta.url))), 'tests/sync-195.helpers.mjs')));

const output = path.join(root, 'evidence/self-modules');
const withoutPlugins = process.argv.includes('--without-plugins');
const modules = withoutPlugins ? [] : (await fs.readdir(root + '/DB/modules')).filter(file => file.endsWith('.js'));
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const report = { modules, pageErrors: [], imageRequests: [], views: [] };
let releaseSettings, page;
try {
    page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.route('https://rphforum.zeabur.app/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>模拟广场</p>' }));
    await page.route('https://api.fish.audio/**', route => route.fulfill({ json: { items: [], total: 0 } }));
    const generated = new Set();
    await page.route('**/api/rp-image?**', route => {
        const req = route.request(), url = new URL(req.url());
        url.searchParams.delete('_rph_retry');
        report.imageRequests.push({ method: req.method(), card: url.searchParams.get('character_id') });
        if (req.method() !== 'GET') generated.add(url.href);
        return generated.has(url.href) ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>' }) : route.fulfill({ status: 404, json: { error: 'fixture missing' } });
    });
    await page.route('**/api/rp-image-thumb?**', route => route.fulfill({ json: { ok: true } }));
    let holdNext = false, didHold;
    await page.route('**/image/api/settings', async route => {
        if (holdNext) {
            holdNext = false;
            await new Promise(resolve => { releaseSettings = resolve; didHold(); });
        }
        await route.fulfill({ json: {} });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base, modules }) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify(modules.map(file => ({ url: base + '/DB/modules/' + file, enabled: true, beforeMount: file.startsWith('liuguanyi-') }))));
        const content = '相同的开场白。image###blue sky, landscape###';
        const card = uuid => ({ uuid, name: '同名角色', first_mes: content, description: '测试', worldInfo: [], regexScripts: [], uiTemplates: [] });
        const user = { uuid: 'fixture-user', name: '测试用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: ['card-A', 'card-B'] }], ['rp_hub_character_card-A', card('card-A')], ['rp_hub_character_card-B', card('card-B')],
            ...['card-A', 'card-B'].flatMap(uuid => [['rp_hub_chat_' + uuid, [{ role: 'assistant', name: '同名角色', content }]], ['rp_hub_image_renders_' + uuid, []]]),
            ['rp_hub_settings', { autoFetchModels: false, apiProviderId: 'custom', apiUrl: base + '/v1', apiKey: 'fixture', model: 'fixture', stream: false, imageGenKey: 'STD-fixture', freezeImageGeneration: true }],
            ['rp_hub_global_worldinfo', [{ comment: '自动生图', constant: true, enabled: true, content: 'fixture', scope: 'global' }]],
            ['rp_hub_worldinfo', []], ['rp_hub_global_regex', []], ['rp_hub_regex', []], ['rp_hub_presets', []],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
    }, { base: harness.url, modules });
    await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
    await page.addLocatorHandler(page.getByRole('button', { name: /^(?:我)?知道了/ }).first(), button => button.click());
    await page.waitForFunction(count => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]').filter(item => item.lastStatus === 'ok').length === count, modules.length, { timeout: 45000 });
    await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__);
    report.installations = await page.evaluate(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1')));
    console.log('PASS all ' + report.installations.length + ' modules initialize together');
    await page.evaluate(() => { const a = document.querySelector('#app').__vue_app__; window.testApp = (a._instance || a._container._vnode.component).proxy; });
    await page.locator('#custom-splash-screen').waitFor({ state: 'detached' });
    for (const view of ['settings', 'presets', 'square', 'chat']) {
        await page.evaluate(async view => { testApp.currentView = view; await Vue.nextTick(); }, view);
        if (view === 'settings' && modules.length) await page.locator('#rph-storage-manager').waitFor();
        if (view === 'presets' && modules.length) await page.locator('[data-preset-schemes-bar]').waitFor();
        if (view === 'square') await page.waitForFunction(() => !testApp.isSquareLoading);
        report.views.push(view);
    }
    await page.evaluate(() => RPHubImageModule.scan());
    const frame = page.locator('[data-chat-index="0"] .rp-generated-image-frame');
    await frame.waitFor();
    await page.waitForFunction(() => { const el = document.querySelector('.entry-transition'); return !el || Number(getComputedStyle(el).opacity) === 0; });
    const keyA = await frame.getAttribute('data-image-render-key');
    const held = new Promise(resolve => { didHold = resolve; });
    holdNext = true;
    await frame.locator('.rp-image-reroll-button').click();
    await held;
    await page.evaluate(async () => { await testApp.selectCharacter(1); await RPHubImageModule.scan(); });
    await page.waitForFunction(() => document.querySelector('[data-chat-index="0"] .rp-generated-image-frame')?.dataset.characterUuid === 'card-B');
    const keyB = await frame.getAttribute('data-image-render-key');
    assert.equal(keyA, keyB, 'fixture must have the same message identity in separate cards');
    releaseSettings();
    releaseSettings = null;
    const wrongOwner = await page.waitForFunction(() => document.querySelector('[data-chat-index="0"] .rp-generated-image-frame')?.dataset.characterUuid === 'card-A', null, { timeout: 5000 }).then(() => true, () => false);
    report.rerollSwitch = await page.evaluate(wrongOwner => ({ wrongOwner, currentCard: testApp.currentCharacter.uuid,
        frames: [...document.querySelectorAll('[data-chat-index="0"] .rp-generated-image-frame')].map(frame => ({ owner: frame.dataset.characterUuid, key: frame.dataset.imageRenderKey, image: frame.querySelector('img')?.src })) }), wrongOwner);
    await page.evaluate(() => RPHubImageModule.flushRecords());
    await initializeFixture(page);
    report.savedOwners = await page.evaluate(async () => {
        const db = await fixture.db(), owners = {};
        for (const id of ['card-A', 'card-B']) {
            const rows = await new Promise(resolve => { const request = db.transaction('store').objectStore('store').get('rp_hub_image_renders_' + id); request.onsuccess = () => resolve(request.result || []); });
            owners[id] = rows.map(record => record.paramsSnapshot?.characterUuid);
        }
        db.close();
        return owners;
    });
    assert.deepEqual(report.pageErrors, []);
    assert.equal(wrongOwner, false, '待完成的 A 卡重生成不能替换 B 卡图片框');
    assert.deepEqual(report.rerollSwitch.frames.map(frame => frame.owner), ['card-B']);
    assert.ok(report.savedOwners['card-A'].every(owner => owner === 'card-A'));
    assert.ok(report.savedOwners['card-B'].every(owner => owner === 'card-B'));
    await page.evaluate(async () => { await testApp.selectCharacter(0); await RPHubImageModule.scan(); });
    await page.waitForFunction(() => document.querySelector('[data-chat-index="0"] .rp-generated-image-frame')?.dataset.characterUuid === 'card-A');
    report.completed = true;
    console.log(JSON.stringify({ installed: report.installations.length, views: report.views, rerollSwitch: { currentCard: report.rerollSwitch.currentCard, owners: report.rerollSwitch.frames.map(frame => frame.owner), wrongOwner }, savedOwners: report.savedOwners, pageErrors: report.pageErrors }, null, 2));
} catch (error) {
    report.error = error.stack;
    report.visibleText = await page?.evaluate(() => document.body.innerText.slice(-5000)).catch(() => null);
    console.error(error);
    process.exitCode = 1;
} finally {
    releaseSettings?.();
    await fs.writeFile(output + (withoutPlugins ? '/image-reroll-without-plugins.json' : '/all-modules-browser.json'), JSON.stringify(report, null, 2));
    await browser.close();
    await harness.close();
}
