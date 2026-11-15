import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 皮肤插件：换配色（明暗不变）、第一帧就生效、开屏图、自定义主题色和开屏图、别的插件登记皮肤。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const probeSource = `RPHubSDK.register({ id:'skin-probe', name:'Skin probe', version:'1', requiresApi:10, init(ctx) {
    const probe = globalThis.skinProbe = { applied: 0, removed: 0 };
    ctx.use('skins').then((skins) => {
        probe.api = skins;
        skins.register({ id: 'probe-skin', name: '探针皮肤', accent: '#c0392b', css: ':root{--probe-skin:1}', apply() { probe.applied += 1; }, remove() { probe.removed += 1; } });
    });
} });`;
const variable = (name) => page.evaluate((key) => getComputedStyle(document.documentElement).getPropertyValue(key).trim(), name);
const luminance = (value) => {
    const [r, g, b] = value.split(/[ ,]+/).map(Number).map((channel) => { const v = channel / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const sameBrightness = (a, b, label) => assert.ok(Math.abs(luminance(a) - luminance(b)) < 0.012, `${label}: ${a} vs ${b}`);
const ready = () => page.waitForFunction(() => globalThis.skinProbe?.api && document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
const view = (name) => page.evaluate((target) => {
    const app = document.querySelector('#app').__vue_app__;
    (app._instance || app._container._vnode.component).proxy.currentView = target;
}, name);
const card = (id) => page.locator(`[data-rph-workshop-attach="skins"] .rph-skin-card[data-skin="${id}"]`);
const early = () => page.evaluate(() => localStorage.getItem('rph_mod_skins::early-style'));

try {
    await page.route('**/probe-skin.js', route => route.fulfill({ contentType: 'text/javascript', body: probeSource }));
    await page.route('**/v1/**', route => route.fulfill({ json: { data: [] } }));
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base }) => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([
            { url: base + '/DB/modules/skins.js', enabled: true }, { url: base + '/probe-skin.js', enabled: true }
        ]));
        const uuid = 'skin-card';
        const character = { uuid, name: '测试角色', description: '隔离验收', first_mes: '准备完成', worldInfo: [], regexScripts: [], uiTemplates: [] };
        const user = { uuid: 'fixture-user', name: '隔离用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: [uuid] }], ['rp_hub_character_' + uuid, character],
            ['rp_hub_chat_' + uuid, [{ id: 'greeting', role: 'assistant', name: character.name, content: character.first_mes }]],
            ['rp_hub_settings', { autoFetchModels: false, apiUrl: base + '/v1', apiKey: 'fixture-key', model: 'fixture-model', stream: false }],
            ['rp_hub_global_worldinfo', []], ['rp_hub_worldinfo', []], ['rp_hub_global_regex', []], ['rp_hub_regex', []],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
    }, { base: harness.url });

    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await ready();
    const official = { light: [await variable('--primary-600'), await variable('--gray-50')] };
    await page.evaluate(() => { document.documentElement.dataset.appTheme = 'dark'; });
    official.dark = [await variable('--primary-600'), await variable('--gray-50'), await variable('--primary-text-600')];
    await page.evaluate(() => { document.documentElement.dataset.appTheme = 'light'; });

    // 设置页最下面有「皮肤」栏；点一套，整站颜色变了，明暗和官方一样（文字对比度不变），深色模式也有一套。
    await view('settings');
    await card('aphrissa').waitFor();
    assert.equal(await page.locator('[data-rph-workshop-attach="skins"] .rph-skin-card').count(), 6);
    await card('aphrissa').click();
    assert.equal(await card('aphrissa').getAttribute('aria-pressed'), 'true');
    const light = [await variable('--primary-600'), await variable('--gray-50')];
    assert.notEqual(light[0], official.light[0]);
    assert.notEqual(light[1], official.light[1]);
    light.forEach((value, index) => sameBrightness(value, official.light[index], 'light'));
    await page.evaluate(() => { document.documentElement.dataset.appTheme = 'dark'; });
    const dark = [await variable('--primary-600'), await variable('--gray-50'), await variable('--primary-text-600')];
    dark.forEach((value, index) => { assert.notEqual(value, official.dark[index]); sameBrightness(value, official.dark[index], 'dark'); });
    await page.evaluate(() => { document.documentElement.dataset.appTheme = 'light'; });
    console.log('PASS choosing a skin recolors both themes and keeps the official brightness of every step');

    // 小说、角色卡生成是内嵌页面，配色也要送进去。
    await view('novel');
    await page.waitForFunction(() => document.querySelector('iframe[src*="novel/index.html"]')?.contentDocument?.getElementById('rph-skin')?.textContent.includes('--primary-600'), null, { timeout: 20000 });
    console.log('PASS the embedded novel page gets the same colors');

    // 再打开：插件还没加载，配色已经在；开屏层换成皮肤的图，插件就绪后收起。
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await variable('--primary-600'), light[0]);
    assert.equal(await page.evaluate(() => !!globalThis.skinProbe), false);
    await page.waitForFunction(() => document.documentElement.classList.contains('rph-skin-art'), null, { timeout: 20000 });
    assert.match(await page.evaluate(() => document.documentElement.style.getPropertyValue('--rph-skin-art')), /^url\("data:image\/webp/);
    await page.waitForFunction(() => document.querySelector('.entry-transition.rph-skin-out'), null, { timeout: 20000 });
    await ready();
    console.log('PASS the colors are there on the first frame and the splash shows the skin art until the plugin is ready');

    // 页面背景、聊天页背景、彩绘图标：样式里各有一段；导航入口、设置页分区的图标标上了图集里的位置。逐项关掉后对应的那段没了。
    const option = (key) => page.locator('[data-rph-workshop-attach="skins"] label.rph-ui-check', { has: page.locator(`input[data-option="${key}"]`) });
    const parts = ['.app-main::before', '.char-bg-blur', '[data-rph-skin-icon]'];
    const before = await early();
    assert.ok(parts.every((part) => before.includes(part)), 'backdrop, chat and icon rules are in the saved style');
    await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent)?.click());
    await page.waitForFunction(() => document.querySelectorAll('.app-navigation-icon[data-rph-skin-icon]').length >= 13);
    assert.deepEqual(await page.evaluate(() => {
        const icon = [...document.querySelectorAll('.app-navigation-item')].find((item) => item.textContent.trim() === '设置').querySelector('.app-navigation-icon');
        return [icon.style.getPropertyValue('--rph-skin-x'), icon.style.getPropertyValue('--rph-skin-y'), getComputedStyle(icon).backgroundImage.startsWith('url("data:image/webp')];
    }), ['5', '0', true]);
    await page.keyboard.press('Escape');
    await view('settings');
    await page.waitForFunction(() => document.querySelector('.settings-card__title svg[data-rph-skin-icon]'));
    for (const key of ['backdrop', 'chat', 'icons']) await option(key).click();
    const after = await early();
    assert.ok(parts.every((part) => !after.includes(part)), 'each switch removes its rules');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-rph-skin-icon]').length), 0);
    for (const key of ['backdrop', 'chat', 'icons']) await option(key).click();
    await page.waitForFunction(() => document.querySelector('.settings-card__title svg[data-rph-skin-icon]'));
    console.log('PASS the skin art sits behind the pages and the chat, painted icons replace the line icons, and each can be switched off');

    // 调节当前这套皮肤：换主题色、把底色调成纯灰、把背景图调深；恢复原样后回到它自己的配色。
    const skinBar = page.locator('[data-rph-workshop-attach="skins"]');
    const slide = (key, value) => skinBar.locator(`input[data-tune="${key}"]`).evaluate((input, next) => {
        input.value = next;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await skinBar.locator('.rph-skin-dot').nth(1).click();
    const tuned = await variable('--primary-600');
    assert.notEqual(tuned, light[0]);
    sameBrightness(tuned, official.light[0], 'tuned accent');
    await slide('tint', 0);
    const gray = (await variable('--gray-100')).split(' ').map(Number);
    assert.ok(Math.max(...gray) - Math.min(...gray) <= 1, `tint 0 gives a neutral gray: ${gray}`);
    await slide('fade', 40);
    assert.ok((await early()).includes(":root{--rph-skin-fade:0.4}"));
    await skinBar.locator('[data-reset]').click();
    assert.equal(await variable('--primary-600'), light[0]);
    assert.ok(!(await early()).includes(':root{--rph-skin-fade:'));
    assert.equal(await skinBar.locator('[data-reset]').count(), 0);
    console.log('PASS each skin can be tuned (theme color, tint, backdrop strength) and put back as it was');

    // 别的插件登记的皮肤：选中时调 apply、带上它的样式，换走时调 remove；回到默认后什么都不留。
    await page.evaluate(() => skinProbe.api.use('probe-skin'));
    assert.deepEqual(await page.evaluate(() => [skinProbe.applied, skinProbe.removed, skinProbe.api.current]), [1, 0, 'probe-skin']);
    assert.equal(await variable('--probe-skin'), '1');
    await page.evaluate(() => skinProbe.api.use(''));
    assert.deepEqual(await page.evaluate(() => [skinProbe.applied, skinProbe.removed]), [1, 1]);
    assert.equal(await variable('--primary-600'), official.light[0]);
    assert.equal(await early(), null);
    console.log('PASS a skin registered by another plugin is applied and removed; the default leaves nothing behind');

    // 自定义：换主题色，放自己的开屏图；关掉开屏图后样式里不再有开屏层。
    await view('settings');
    await card('custom').click();
    await page.locator('[data-rph-workshop-attach="skins"] .rph-skin-dot').nth(1).click();
    const custom = await variable('--primary-600');
    assert.notEqual(custom, official.light[0]);
    sameBrightness(custom, official.light[0], 'custom');
    assert.ok(!(await early()).includes('.entry-transition'), 'no splash rules without a photo');
    const png = await page.evaluate(async () => {
        const canvas = Object.assign(document.createElement('canvas'), { width: 60, height: 90 });
        canvas.getContext('2d').fillRect(0, 0, 60, 90);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.locator('[data-rph-workshop-attach="skins"] input[type="file"]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.locator('[data-rph-workshop-attach="skins"] .rph-skin-photo').waitFor();
    assert.ok((await early()).includes('.entry-transition'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.classList.contains('rph-skin-art'), null, { timeout: 20000 });
    assert.match(await page.evaluate(() => document.documentElement.style.getPropertyValue('--rph-skin-art')), /^url\("data:image\/jpeg/);
    await ready();
    await view('settings');
    await card('custom').waitFor();
    await option('splash').click();
    assert.ok(!(await early()).includes('.entry-transition'));
    console.log('PASS the custom skin takes a theme color and your own splash photos; the splash can be turned off');
    assert.deepEqual(errors, []);
} finally {
    await context.close();
    await browser.close();
    await harness.close();
}
