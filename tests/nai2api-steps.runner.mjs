import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 生图设置格子 + Nai2API 插件：
// - 外壳的步数滑条按直链 28 步上限建，插件自己把上限放到 50，进出设置页都显示存好的 50 步；
// - 下拉框用 RPH 原生 custom-select，展开的是原生样式的列表；
// - 切回直链后马上离开设置页再回来、或者读取比保存晚回来，都不会变回网页任务；
// - 设置存在站点上、所有设备共用：页面记着的旧值会及时刷新；只保存改动的那一项；保存失败要提示并恢复成站点上的值。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const view = (page, value) => page.evaluate((value) => {
    const a = document.querySelector('#app').__vue_app__;
    (a._instance?.proxy || a._container._vnode.component.proxy).currentView = value;
}, value);
let server = { generator: 'nai2api-web', params: { steps: 50, scale: 6, cfg: 0, sampler: 'k_euler', noise_schedule: 'karras', resolution: '', negative: '' } };
let getDelay = 0;
let failNextPut = false;
const puts = [];

try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => { throw error; });
    await page.route('**/image/api/settings', async (route) => {
        if (route.request().method() === 'PUT') {
            const body = route.request().postDataJSON();
            puts.push(body);
            if (failNextPut) { failNextPut = false; return route.fulfill({ status: 401, json: { ok: false, error: '同步密码错误' } }); }
            server = { ...server, ...body, params: { ...server.params, ...(body.params || {}) } };
            return route.fulfill({ json: { ok: true, settings: server } });
        }
        const snapshot = structuredClone(server);
        if (getDelay) await new Promise((resolve) => setTimeout(resolve, getDelay));
        return route.fulfill({ json: { ok: true, settings: snapshot } });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async (base) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        const user = { uuid: 'fixture-user', name: '用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid]]);
        db.close();
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url: base + '/DB/modules/nai2api-web.js', enabled: true }]));
    }, harness.url);
    await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
    await page.addLocatorHandler(page.getByRole('button', { name: /^(?:我)?知道了/ }).first(), (button) => button.click());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]').some((entry) => entry.lastStatus === 'ok'), null, { timeout: 45000 });
    await page.evaluate(() => RPHubImageModule.reloadGenerationSettings());
    const fields = page.locator('[data-rph-image-param]');
    const openSettings = async () => {
        await view(page, 'settings');
        await fields.first().waitFor({ state: 'attached' });
        await page.waitForTimeout(300);
    };
    for (let round = 1; round <= 2; round++) {
        await openSettings();
        const shown = await page.evaluate(() => {
            const input = document.querySelector('[data-rph-image-param] input[type="range"]');
            return [input.value, input.max, input.closest('[data-rph-image-param]').querySelector('span').textContent];
        });
        assert.deepEqual(shown, ['50', '50', '50 步'], `round ${round}`);
        await view(page, 'chat');
        await page.waitForTimeout(300);
    }
    console.log('PASS Nai2API plugin shows the saved 50 steps each time the settings page opens');

    // 改「生图比例」「生图模型」（RPH 原生设置）后，步数下面的点数要跟着变：50 步竖图 33 点、方图 34 点，V5 方图 51 点。
    await openSettings();
    const hint = () => page.evaluate(() => document.querySelector('[data-rph-image-param] input[type="range"]').closest('[data-rph-image-param]').querySelector('p').textContent);
    const setApp = (key, value) => page.evaluate(({ key, value }) => {
        const a = document.querySelector('#app').__vue_app__;
        (a._instance?.proxy || a._container._vnode.component.proxy).settings[key] = value;
    }, { key, value });
    await setApp('imageModel', 'nai-diffusion-4-5-full');
    await setApp('imageSize', '竖图');
    await page.waitForFunction(() => /约 33 点/.test(document.querySelector('[data-rph-image-param] input[type="range"]').closest('[data-rph-image-param]').querySelector('p').textContent), null, { timeout: 3000 }).catch(() => {});
    assert.match(await hint(), /约 33 点/);
    await setApp('imageSize', '方图');
    await page.waitForTimeout(300);
    assert.match(await hint(), /约 34 点/);
    await setApp('imageModel', 'nai-diffusion-5-full');
    await page.waitForTimeout(300);
    assert.match(await hint(), /约 51 点/);
    await setApp('imageModel', 'nai-diffusion-4-5-full');
    await setApp('imageSize', '竖图');
    await view(page, 'chat');
    console.log('PASS the points hint follows the native image size and model settings');

    await openSettings();
    const generatorButton = fields.nth(0).locator('button[aria-haspopup="listbox"]');
    const samplerButton = fields.nth(2).locator('button[aria-haspopup="listbox"]');
    assert.equal(await page.locator('[data-rph-image-param] select:visible').count(), 0, 'native <select> must not be visible');
    await samplerButton.click();
    await page.getByRole('option', { name: 'k_dpmpp_2m_sde' }).waitFor();
    assert.equal(await page.getByRole('option', { name: 'k_euler_ancestral' }).count(), 1);
    await page.keyboard.press('Escape');
    console.log('PASS sampler and other dropdowns use the native RPH select with its styled option list');

    // 切回直链，400 毫秒内离开设置页再回来。
    await generatorButton.click();
    await page.getByRole('option', { name: /^直链/ }).click();
    await view(page, 'chat');
    await page.waitForTimeout(100);
    await openSettings();
    assert.match(await fields.nth(0).locator('button[aria-haspopup="listbox"]').textContent(), /直链/);
    await page.waitForTimeout(800);
    assert.equal(server.generator, 'direct');
    console.log('PASS switching back to the direct link sticks when leaving the settings page right away');

    // 进设置页时的读取比之后的保存晚回来：不能把刚存的值盖回去。
    await view(page, 'chat');
    getDelay = 1500;
    await view(page, 'settings');
    await fields.first().waitFor({ state: 'attached' });
    await fields.nth(0).locator('button[aria-haspopup="listbox"]').click();
    await page.getByRole('option', { name: /网页任务/ }).click();
    await page.waitForTimeout(600);
    await fields.nth(0).locator('button[aria-haspopup="listbox"]').click();
    await page.getByRole('option', { name: /^直链/ }).click();
    await page.waitForTimeout(2500);
    getDelay = 0;
    assert.equal(await page.evaluate(() => RPHubImageModule.getGenerationSettings().generator), 'direct');
    await view(page, 'chat');
    await page.waitForTimeout(300);
    await openSettings();
    assert.match(await fields.nth(0).locator('button[aria-haspopup="listbox"]').textContent(), /直链/);
    assert.equal(server.generator, 'direct');
    console.log('PASS a slow settings read cannot overwrite a newer choice');

    const app = (script) => page.evaluate(script);
    const pageSteps = () => app(() => RPHubImageModule.getGenerationSettings().params.steps);
    const shownSteps = () => app(() => document.querySelector('[data-rph-image-param] input[type="range"]').value);
    const remember = (settings) => page.evaluate((settings) => {
        const current = RPHubImageModule.getGenerationSettings();
        RPHubImageModule.applyGenerationSettings({ ...current, ...settings, params: { ...current.params, ...settings.params } });
    }, settings);

    // 别的设备改了设置（4K 50 步 → 标准 28 步），这个页面还记着旧值：进设置页先读站点上的最新值；只改采样器时只存采样器。
    await view(page, 'chat');
    server = { ...server, generator: 'nai2api-web', params: { ...server.params, steps: 28, resolution: '' } };
    await remember({ generator: 'nai2api-web', params: { steps: 50, resolution: '4K' } });
    await openSettings();
    assert.equal(await shownSteps(), '28');
    assert.match(await fields.nth(1).locator('button[aria-haspopup="listbox"]').textContent(), /标准/);
    puts.length = 0;
    await fields.nth(2).locator('button[aria-haspopup="listbox"]').click();
    await page.getByRole('option', { name: 'k_dpmpp_2m', exact: true }).click();
    await page.waitForTimeout(900);
    assert.deepEqual(puts, [{ params: { sampler: 'k_dpmpp_2m' } }]);
    assert.equal(server.params.steps, 28);
    assert.equal(server.params.resolution, '');
    console.log('PASS a page holding old settings shows the latest ones and saves only the field that was changed');

    // 别的设备改了步数：切回这个页面时、开始新一轮回复时（新图要等回复结束才定参数）都会读到新值。
    await view(page, 'chat');
    server.params.steps = 33;
    await app(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => RPHubImageModule.getGenerationSettings().params.steps === 33, null, { timeout: 5000 });
    server.params.steps = 34;
    await app(async () => {
        const a = document.querySelector('#app').__vue_app__;
        (a._instance?.proxy || a._container._vnode.component.proxy).isGenerating = true;
        await Vue.nextTick();
        await RPHubImageModule.scan();
    });
    await page.waitForFunction(() => RPHubImageModule.getGenerationSettings().params.steps === 34, null, { timeout: 5000 });
    await app(() => { const a = document.querySelector('#app').__vue_app__; (a._instance?.proxy || a._container._vnode.component.proxy).isGenerating = false; });
    assert.equal(await pageSteps(), 34);
    console.log('PASS settings changed on another device reach an open page when it comes back and when a new reply starts');

    // 保存失败：弹出提示，设置页恢复成站点上的值，页面记着的也是站点上的值。
    await openSettings();
    failNextPut = true;
    await app(() => {
        const input = document.querySelector('[data-rph-image-param] input[type="range"]');
        input.value = '20';
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('change'));
    });
    await page.locator('.toast-item', { hasText: '生图设置没有保存成功' }).waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('[data-rph-image-param] input[type="range"]')?.value === '34', null, { timeout: 5000 });
    assert.equal(await pageSteps(), 34);
    assert.equal(server.params.steps, 34);
    await view(page, 'chat');
    console.log('PASS a failed save is reported and the settings page goes back to what the site has');

    // 生图接口的插件比设置页晚加载：先按 28 显示，接口和它声明的上限到了以后显示存的 50（存的值不被改掉）。
    server = { ...server, generator: 'late-gen', params: { ...server.params, steps: 50 } };
    await app(() => RPHubImageModule.reloadGenerationSettings());
    await openSettings();
    assert.equal(await shownSteps(), '28');
    assert.match(await hint(), /插件没有加载/);
    await app(() => RPHubImageModule.registerImageProvider({ id: 'late-gen', label: '晚到的接口', maxSteps: 50, async generate() { return new Blob(); } }));
    await page.waitForFunction(() => document.querySelector('[data-rph-image-param] input[type="range"]').value === '50', null, { timeout: 5000 });
    assert.equal(server.params.steps, 50);
    console.log('PASS a plugin generator that loads after the settings page shows the saved steps once its range is known');
} finally {
    await browser.close();
    await harness.close();
}
