import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 自定义生图插件（在真的页面里）：
// - 面板里添加、编辑、删除生图服务，下拉框用 RPH 自己的；NovelAI 不填模型；漏填有提示；
// - 加好的服务出现在「生图设置」→「生图接口」里，OpenAI、Gemini 的步数下面提示参数无效；删掉的标成「已删除」；
// - 选着它时，点生成后由插件在浏览器里出图，外壳用 PUT 上传保存，不再走直链；图能显示出来。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const marker = 'image###blue sky, white clouds, landscape###';
const settings = { generator: 'ci-test', params: { steps: 28, scale: 6, cfg: 0, sampler: 'k_euler', noise_schedule: 'karras', resolution: '', negative: '' } };
const providerRequests = [], imageRequests = [], stored = new Set(), pageErrors = [];

try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/image/api/settings', (route) => route.fulfill({ json: { ok: true, settings } }));
    await page.route('**/api/rp-image-thumb*', (route) => route.fulfill({ json: { ok: true } }));
    await page.route('**/api/rp-image?*', (route) => {
        // 外壳重新取图时带 _rph_retry 防缓存，存取都按去掉它的地址认。
        const request = route.request(), url = new URL(request.url());
        url.searchParams.delete('_rph_retry');
        const key = url.search;
        imageRequests.push({ method: request.method(), contentType: request.headers()['content-type'] || '' });
        if (request.method() === 'PUT' || request.method() === 'POST') stored.add(key);
        return stored.has(key) ? route.fulfill({ contentType: 'image/png', body: PNG }) : route.fulfill({ status: 404, json: { error: 'missing' } });
    });
    await page.route('https://img.example/**', (route) => {
        providerRequests.push({ url: route.request().url(), auth: route.request().headers().authorization, body: route.request().postDataJSON() });
        return route.fulfill({ json: { data: [{ b64_json: PNG.toString('base64') }] }, headers: { 'access-control-allow-origin': '*' } });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async (base) => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url: base + '/DB/modules/custom-image.js', enabled: true }]));
        localStorage.setItem('rph_mod_custom-image::services', JSON.stringify([
            { id: 'ci-test', name: 'GPT 生图', format: 'openai', base: 'https://img.example/v1', key: 'img-key', model: 'gpt-image-1', extra: '日系动漫风格' }
        ]));
        const uuid = 'custom-image-card';
        const character = { uuid, name: '测试角色', description: '自定义生图', first_mes: '准备完成', worldInfo: [], regexScripts: [], uiTemplates: [] };
        const user = { uuid: 'fixture-user', name: '用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: [uuid] }], ['rp_hub_character_' + uuid, character],
            ['rp_hub_chat_' + uuid, [{ id: 'reply-1', role: 'assistant', name: character.name, content: '准备完成' }]],
            ['rp_hub_settings', { autoFetchModels: false, apiKey: '', imageGenKey: 'STD-isolated', fontFamily: 'modern', fontFamilyVersion: 4 }],
            ['rp_hub_global_worldinfo', [{ comment: '自动生图', constant: true, enabled: true, content: 'fixture', scope: 'global' }]],
            ['rp_hub_worldinfo', []], ['rp_hub_global_regex', []], ['rp_hub_regex', []],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
    }, harness.url);
    await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
    await page.addLocatorHandler(page.getByRole('button', { name: /^(?:我)?知道了/ }).first(), (button) => button.click());
    await page.waitForFunction(() => globalThis.RPHubImageModule?.listImageProviders?.().some((item) => item.id === 'ci-test'), null, { timeout: 45000 });
    // 导航菜单 → 模块管理 → 「自定义生图」。
    const openPanel = async () => {
        await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent)?.click());
        await page.locator('[data-rph-workshop-manager-entry]').waitFor({ state: 'attached' });
        await page.evaluate(() => document.querySelector('[data-rph-workshop-manager-entry]').click());
        await page.locator('[data-rph-workshop-launcher] button', { hasText: '自定义生图' }).click();
    };
    const providers = () => page.evaluate(() => RPHubImageModule.listImageProviders().map(({ id, label, maxSteps }) => ({ id, label, maxSteps })));
    assert.deepEqual(await providers(), [{ id: 'ci-test', label: 'GPT 生图', maxSteps: 28 }]);
    console.log('PASS a saved service is registered as an image generator when the page opens');

    // 聊天里的生图标记：点生成后由插件请求服务，外壳把图用 PUT 存起来并显示。
    await page.evaluate(async (marker) => {
        await RPHubImageModule.reloadGenerationSettings();
        const a = document.querySelector('#app').__vue_app__;
        (a._instance?.proxy || a._container._vnode.component.proxy).chatHistory[0].content = marker;
        await Vue.nextTick();
        await RPHubImageModule.scan();
    }, marker);
    // 旧消息里新出现的图不自动生成（外壳的规矩），点图片右上角的按钮生成。
    await page.locator('.rp-generated-image-frame .rp-image-reroll-button').click();
    await page.waitForFunction(() => {
        const image = document.querySelector('.rp-generated-image-frame img');
        return image?.complete && image.naturalWidth > 0;
    }, null, { timeout: 20000 });
    assert.equal(providerRequests.length, 1);
    assert.equal(providerRequests[0].url, 'https://img.example/v1/images/generations');
    assert.equal(providerRequests[0].auth, 'Bearer img-key');
    assert.deepEqual(providerRequests[0].body, { model: 'gpt-image-1', prompt: 'blue sky, white clouds, landscape, 日系动漫风格', n: 1, size: '1024x1536' });
    assert.ok(imageRequests.some((item) => item.method === 'PUT' && item.contentType === 'image/png'), JSON.stringify(imageRequests));
    assert.ok(!imageRequests.some((item) => item.method === 'POST'), 'the direct link must not be called');
    console.log('PASS an image marker is generated by the service in the browser, uploaded with PUT and shown');

    // 打开面板：已有的服务列在上面；漏填有提示；选 NovelAI 时不显示模型和附加提示词。
    await openPanel();
    const panel = page.locator('[data-rph-workshop-panel]');
    const field = (name) => panel.locator(`[data-field="${name}"]`);
    await panel.locator('[data-service="ci-test"]', { hasText: 'OpenAI 图片接口 · gpt-image-1' }).waitFor();
    assert.equal(await panel.locator('select:visible').count(), 0, 'the native select is replaced by the RPH one');
    await panel.locator('[data-act="save"]').click();
    await page.locator('.toast-item', { hasText: '请填写名称、密钥和模型' }).waitFor({ timeout: 5000 });
    await panel.locator('button[aria-haspopup="listbox"]').click();
    await page.getByRole('option', { name: 'NovelAI 官方接口' }).click();
    assert.equal(await field('model').isVisible(), false);
    assert.equal(await field('extra').isVisible(), false);
    await field('name').fill('NAI 官方');
    await field('key').fill('pst-key');
    await panel.locator('[data-act="save"]').click();
    await page.locator('.toast-item', { hasText: '已添加「NAI 官方」' }).waitFor({ timeout: 5000 });
    const added = (await page.evaluate(() => JSON.parse(localStorage.getItem('rph_mod_custom-image::services')))).at(-1);
    assert.deepEqual({ ...added, id: '' }, { id: '', name: 'NAI 官方', format: 'novelai', base: '', key: 'pst-key', model: '', extra: '' });
    assert.match(added.id, /^ci-[a-z0-9]+$/);
    assert.deepEqual((await providers()).at(-1), { id: added.id, label: 'NAI 官方', maxSteps: 50 });
    console.log('PASS the panel adds a NovelAI service without a model, warns about missing fields and registers it');

    // 编辑：表单带出原来的值，改名后保存，下拉框里的名字跟着变。
    await panel.locator(`[data-service="${added.id}"] [data-act="edit"]`).click();
    await panel.locator('h3', { hasText: '编辑「NAI 官方」' }).waitFor();
    assert.equal(await field('key').inputValue(), 'pst-key');
    await field('name').fill('NovelAI');
    await panel.locator('[data-act="save"]').click();
    await page.locator('.toast-item', { hasText: '已保存「NovelAI」' }).waitFor({ timeout: 5000 });
    assert.equal((await providers()).at(-1).label, 'NovelAI');
    await page.screenshot({ path: 'evidence/custom-image-panel.png' });
    console.log('PASS editing keeps the saved values and renames the generator');

    // 生图设置页：两个服务都在下拉框里；选着 OpenAI 的服务时，步数下面提示参数无效。
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
        const a = document.querySelector('#app').__vue_app__;
        (a._instance?.proxy || a._container._vnode.component.proxy).currentView = 'settings';
    });
    const generator = page.locator('[data-rph-image-param]').first().locator('button[aria-haspopup="listbox"]');
    await generator.waitFor();
    assert.match(await generator.textContent(), /GPT 生图（插件，最高 28 步）/);
    await page.waitForFunction(() => /步数、采样器等参数对此服务无效/.test(document.querySelector('[data-rph-image-param] input[type="range"]')?.closest('[data-rph-image-param]')?.querySelector('p')?.textContent || ''), null, { timeout: 5000 });
    await generator.click();
    await page.getByRole('option', { name: /NovelAI（插件，最高 50 步）/ }).waitFor();
    await page.screenshot({ path: 'evidence/custom-image-settings.png' });
    await page.keyboard.press('Escape');
    console.log('PASS both services are in the generator list and OpenAI ones say the steps do not apply');

    // 删除：确认后从面板和存储里去掉；下拉框里刷新前标成「已删除」，选着它生图会提示重新选择。
    await page.evaluate(() => {
        const a = document.querySelector('#app').__vue_app__;
        (a._instance?.proxy || a._container._vnode.component.proxy).currentView = 'chat';
    });
    await openPanel();
    await panel.locator(`[data-service="${added.id}"] [data-act="delete"]`).click();
    await page.locator('[data-rph-ui-confirm]', { hasText: '「NovelAI」及其密钥将被删除。' }).waitFor();
    await page.locator('[data-rph-ui-confirm] [data-rph-ui-confirm-accept]').click();
    await panel.locator(`[data-service="${added.id}"]`).waitFor({ state: 'detached' });
    assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('rph_mod_custom-image::services')))).map((item) => item.id), ['ci-test']);
    assert.equal((await providers()).at(-1).label, 'NovelAI（已删除）');
    console.log('PASS deleting asks first, removes the service and marks it as deleted in the generator list');

    assert.deepEqual(pageErrors, []);
} finally {
    await browser.close();
    await harness.close();
}
