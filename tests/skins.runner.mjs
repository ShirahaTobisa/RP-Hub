import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 皮肤插件：换配色（明暗不变）、第一帧就生效、开屏图、横竖屏各用各的图、自带的里见茜、从皮肤工坊下载 / 更新 / 删除皮肤、
// 自定义主题色和自己的图、导出成皮肤包、别的插件登记皮肤。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
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
// 假的皮肤工坊：两套皮肤包，图都用 1 像素的 webp。
const WEBP = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const pack = (id, version, accent) => ({ schema: 1, id, version, name: `工坊${id}`, note: '测试', accent, neutral: '#8c80b8', colors: [accent, '#2fa7c9'],
    art: [WEBP, WEBP], wide: [WEBP + '#left', WEBP + '#right'], icons: WEBP });
const shop = { lily: pack('lily', '1.0.0', '#c06aa6'), mornye: pack('mornye', '1.0.0', '#2f9d5b') };
let tamper = false;
const packText = (id) => JSON.stringify(shop[id]);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
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
const shopButton = (id) => page.locator(`[data-rph-workshop-attach="skins"] [data-shop-skin="${id}"] button`);
const early = () => page.evaluate(() => localStorage.getItem('rph_mod_skins::early-style'));
const stored = (key) => page.evaluate((name) => localStorage.getItem('rph_mod_skins::' + name), key);

try {
    await page.addInitScript(() => { window.RPH_R2_MIRROR_BASE = 'https://mirror.test'; });
    await page.route('https://mirror.test/workshop/skins/**', (route) => {
        const name = new URL(route.request().url()).pathname.split('/').pop();
        if (name === 'index.json') {
            return route.fulfill({ json: { schema: 1, skins: Object.values(shop).map((skin) => ({
                id: skin.id, name: skin.name, note: skin.note, version: skin.version, accent: skin.accent, author: '测试作者',
                cover: { path: `/workshop/skins/${skin.id}.webp`, size: 34 },
                file: { path: `/workshop/skins/${skin.id}.json`, sha256: sha256(packText(skin.id)), size: packText(skin.id).length }
            })) } });
        }
        const [id, extension] = name.split('.');
        if (extension === 'webp') return route.fulfill({ contentType: 'image/webp', body: Buffer.from(WEBP.split(',')[1], 'base64') });
        return route.fulfill({ contentType: 'application/json', body: packText(id) + (tamper ? ' ' : '') });
    });
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

    // 设置页最下面有「皮肤」栏，自带的只有里见茜（探针插件登记了一套）；点它，整站颜色变了，明暗和官方一样（文字对比度不变），深色模式也有一套。
    await view('settings');
    await card('akane').waitFor();
    assert.deepEqual(await page.locator('[data-rph-workshop-attach="skins"] .rph-skin-card').evaluateAll((cards) => cards.map((item) => item.dataset.skin)), ['', 'akane', 'probe-skin', 'custom']);
    await card('akane').click();
    assert.equal(await card('akane').getAttribute('aria-pressed'), 'true');
    const light = [await variable('--primary-600'), await variable('--gray-50')];
    assert.notEqual(light[0], official.light[0]);
    assert.notEqual(light[1], official.light[1]);
    light.forEach((value, index) => sameBrightness(value, official.light[index], 'light'));
    await page.evaluate(() => { document.documentElement.dataset.appTheme = 'dark'; });
    const dark = [await variable('--primary-600'), await variable('--gray-50'), await variable('--primary-text-600')];
    dark.forEach((value, index) => { assert.notEqual(value, official.dark[index]); sameBrightness(value, official.dark[index], 'dark'); });
    await page.evaluate(() => { document.documentElement.dataset.appTheme = 'light'; });
    console.log('PASS the built-in skin recolors both themes and keeps the official brightness of every step');

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

    // 竖屏（手机）用竖图，横屏（电脑）用同一幅画的横版。
    const backdrop = () => page.evaluate(() => {
        const image = getComputedStyle(document.querySelector('.app-main'), '::before').backgroundImage.slice(0, 160);
        const root = document.documentElement.style;
        return image === root.getPropertyValue('--rph-skin-wide').slice(0, 160) ? 'wide' : image === root.getPropertyValue('--rph-skin-art').slice(0, 160) ? 'tall' : image;
    });
    assert.equal(await backdrop(), 'tall');
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await backdrop(), 'wide');
    // 横版里人物靠一边（中间是聊天栏），图按那一边对齐。
    assert.match(await page.evaluate(() => document.documentElement.style.getPropertyValue('--rph-skin-side')), /^(left|right)$/);
    assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('.app-main'), '::before').backgroundPosition), /^(0%|100%) 30%$/);
    await page.setViewportSize({ width: 390, height: 844 });
    console.log('PASS upright screens get the upright art and wide screens the wide version of the same picture, with the character at one side');

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
    // 别的插件自己画的入口（比如导航插件底栏的「设置」「更多」）：写上名字，画好后叫皮肤插件换一遍，马上就是彩绘的。
    assert.deepEqual(await page.evaluate(() => ['设置', '更多'].map((name) => {
        const node = Object.assign(document.createElement('button'), { innerHTML: '<span class="app-navigation-icon"><svg viewBox="0 0 24 24"></svg></span>' });
        node.dataset.rphIcon = name;
        document.body.appendChild(node);
        skinProbe.api.refreshIcons();
        return node.firstElementChild.style.getPropertyValue('--rph-skin-x') + ',' + node.firstElementChild.style.getPropertyValue('--rph-skin-y');
    })), ['5,0', '5,3']);
    await view('settings');
    await page.waitForFunction(() => document.querySelector('.settings-card__title svg[data-rph-skin-icon]'));
    for (const key of ['backdrop', 'chat', 'icons']) await option(key).click();
    const after = await early();
    assert.ok(parts.every((part) => !after.includes(part)), 'each switch removes its rules');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-rph-skin-icon]').length), 0);
    for (const key of ['backdrop', 'chat', 'icons']) await option(key).click();
    await page.waitForFunction(() => document.querySelector('.settings-card__title svg[data-rph-skin-icon]'));
    console.log('PASS the skin art sits behind the pages and the chat, painted icons (more as well) replace the line icons, and each can be switched off');

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
    await slide('fade', 60);   // 透明度 60% = 图的不透明度 40%
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

    // 皮肤工坊：列出能下载的皮肤；下载完就换上，图和颜色都来自皮肤包，刷新后从插件数据里读回来，不再联网下载。
    await view('settings');
    await shopButton('lily').waitFor();
    assert.equal(await shopButton('lily').textContent(), '下载');
    await shopButton('lily').click();
    await page.waitForFunction(() => document.querySelector('[data-rph-workshop-attach="skins"] .rph-skin-card[data-skin="lily"]')?.getAttribute('aria-pressed') === 'true');
    const lily = await variable('--primary-600');
    assert.notEqual(lily, official.light[0]);
    sameBrightness(lily, official.light[0], 'downloaded skin');
    assert.equal(await stored('downloaded'), '["lily"]');
    assert.equal(await shopButton('lily').textContent(), '删除');
    let packageRequests = 0;
    page.on('request', (request) => { if (/\/workshop\/skins\/[a-z-]+\.json$/.test(request.url())) packageRequests += 1; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--rph-skin-wide').endsWith('#left")')
        || document.documentElement.style.getPropertyValue('--rph-skin-wide').endsWith('#right")'), null, { timeout: 20000 });
    await ready();
    assert.equal(await variable('--primary-600'), lily);
    assert.equal(packageRequests, 0);
    console.log('PASS a skin from the skin workshop downloads, switches on, and comes back after a reload without downloading again');

    // 皮肤工坊里出了新版本：显示「更新」，更新后换上新配色；文件和目录里的指纹对不上就不收。
    shop.lily = pack('lily', '1.1.0', '#3f8fd6');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await view('settings');
    await shopButton('lily').filter({ hasText: '更新' }).waitFor();
    await shopButton('lily').click();
    await page.waitForFunction((previous) => getComputedStyle(document.documentElement).getPropertyValue('--primary-600').trim() !== previous, lily);
    assert.equal(await card('lily').getAttribute('aria-pressed'), 'true');
    tamper = true;
    await shopButton('mornye').click();
    await page.locator('.toast-item', { hasText: '校验失败' }).waitFor();
    assert.equal(await stored('downloaded'), '["lily"]');
    assert.equal(await card('mornye').count(), 0);
    tamper = false;
    console.log('PASS a newer version shows as an update and replaces the old one; a file that does not match the catalog is refused');

    // 删除下载过的皮肤：正在用的话回到默认；之后还能再下。
    await shopButton('lily').click();
    await page.waitForFunction(() => !document.querySelector('[data-rph-workshop-attach="skins"] .rph-skin-card[data-skin="lily"]'));
    assert.equal(await stored('active'), '');
    assert.equal(await stored('downloaded'), '[]');
    assert.equal(await variable('--primary-600'), official.light[0]);
    assert.equal(await shopButton('lily').textContent(), '下载');
    // 以前自带、现在挪进皮肤工坊的皮肤（正在用但本机没有）：打开页面时自动下回来，不用重新选。
    await page.evaluate(() => localStorage.setItem('rph_mod_skins::active', 'mornye'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await page.waitForFunction(() => localStorage.getItem('rph_mod_skins::downloaded') === '["mornye"]', null, { timeout: 20000 });
    await view('settings');
    await page.waitForFunction(() => document.querySelector('[data-rph-workshop-attach="skins"] .rph-skin-card[data-skin="mornye"]')?.getAttribute('aria-pressed') === 'true');
    console.log('PASS a downloaded skin can be deleted; a skin in use that is missing on this device is downloaded again by itself');

    // 自定义：换主题色，放自己的图（竖图给竖屏、横图给横屏）；导出成皮肤包；关掉开屏图后样式里不再有开屏层。
    await card('custom').click();
    await page.locator('[data-rph-workshop-attach="skins"] .rph-skin-dot').nth(1).click();
    const custom = await variable('--primary-600');
    assert.notEqual(custom, official.light[0]);
    sameBrightness(custom, official.light[0], 'custom');
    assert.ok(!(await early()).includes('.entry-transition'), 'no splash rules without a photo');
    const photo = (width, height) => page.evaluate(([w, h]) => {
        const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
        canvas.getContext('2d').fillRect(0, 0, w, h);
        return canvas.toDataURL('image/png').split(',')[1];
    }, [width, height]);
    await page.locator('[data-rph-workshop-attach="skins"] input[type="file"]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(await photo(60, 90), 'base64') });
    await page.locator('[data-rph-workshop-attach="skins"] .rph-skin-photo').waitFor();
    assert.ok((await early()).includes('.entry-transition'));
    await page.locator('[data-rph-workshop-attach="skins"] input[type="file"]').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: Buffer.from(await photo(90, 60), 'base64') });
    await page.waitForFunction(() => document.querySelectorAll('[data-rph-workshop-attach="skins"] .rph-skin-photo').length === 2);
    const [file] = await Promise.all([page.waitForEvent('download'), page.locator('[data-rph-workshop-attach="skins"] [data-export]').click()]);
    const exported = JSON.parse(await (await import('node:fs/promises')).readFile(await file.path(), 'utf8'));
    assert.deepEqual([exported.schema, exported.id, exported.art.length, exported.wide.length], [1, 'my-skin', 1, 1]);
    assert.match(exported.accent, /^#[0-9a-f]{6}$/);
    assert.match(exported.art[0], /^data:image\/jpeg;base64,[^#]+$/);
    assert.match(exported.wide[0], /^data:image\/jpeg;base64,[^#]+$/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.classList.contains('rph-skin-art'), null, { timeout: 20000 });
    assert.match(await page.evaluate(() => document.documentElement.style.getPropertyValue('--rph-skin-art')), /^url\("data:image\/jpeg[^#]*"\)$/);
    assert.match(await page.evaluate(() => document.documentElement.style.getPropertyValue('--rph-skin-wide')), /^url\("data:image\/jpeg[^#]*#wide"\)$/);
    await ready();
    await view('settings');
    await card('custom').waitFor();
    await option('splash').click();
    assert.ok(!(await early()).includes('.entry-transition'));
    console.log('PASS the custom skin takes a theme color and your own photos (upright for upright screens, wide for wide screens), exports as a skin package, and the splash can be turned off');

    // 预览：选中的图在用得到的设备上各有开屏、页面、聊天三张小图；点开放大，缩放、拖动后位置存下，页面上的图跟着变，刷新后还在，导出时记成人物在哪边；恢复默认后清掉。
    const bar = page.locator('[data-rph-workshop-attach="skins"]');
    const frames = (device) => bar.locator(`.rph-skin-preview .rph-skin-frame[data-device="${device}"]`).count();
    assert.deepEqual([await frames('phone'), await frames('desktop')], [3, 0], 'an upright photo is previewed on phones only while there is a wide one');
    await bar.locator('.rph-skin-photo > button:first-child').nth(1).click();
    assert.deepEqual([await frames('phone'), await frames('desktop')], [0, 3]);
    await bar.locator('.rph-skin-frame[data-device="desktop"][data-kind="chat"]').click();
    const viewer = page.locator('.rph-skin-viewer');
    await viewer.waitFor();
    await viewer.locator('input[type="range"]').evaluate((input) => {
        input.value = 200;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--rph-skin-wide-zoom') === '2');
    const box = await viewer.locator('.rph-skin-frame').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) await page.mouse.move(box.x + box.width * (0.5 + step * 0.1), box.y + box.height / 2);
    await page.mouse.up();
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--rph-skin-wide-pos') === '0% 30%');
    assert.equal(await viewer.locator('.rph-skin-frame-art').evaluate((art) => art.style.transform), 'scale(2)');
    await page.keyboard.press('Escape');
    const [shared] = await Promise.all([page.waitForEvent('download'), bar.locator('[data-export]').click()]);
    assert.match(JSON.parse(await (await import('node:fs/promises')).readFile(await shared.path(), 'utf8')).wide[0], /^data:image\/jpeg;base64,[^#]+#left$/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--rph-skin-wide-pos') === '0% 30%', null, { timeout: 20000 });
    assert.equal(await variable('--rph-skin-wide-zoom'), '2');
    await ready();
    await view('settings');
    await bar.locator('.rph-skin-photo > button:first-child').nth(1).click();
    await bar.locator('.rph-skin-frame[data-device="desktop"][data-kind="splash"]').click();
    await viewer.locator('button', { hasText: '恢复默认' }).click();
    await page.waitForFunction(() => !document.documentElement.style.getPropertyValue('--rph-skin-wide-pos') && !document.documentElement.style.getPropertyValue('--rph-skin-wide-zoom'));
    await page.keyboard.press('Escape');
    console.log('PASS your own photos have a preview for phones and computers; zooming and dragging in the large preview moves the picture on the page, stays after a reload and goes into the exported package, and resetting puts it back');
    assert.deepEqual(errors, []);
} finally {
    await context.close();
    await browser.close();
    await harness.close();
}
