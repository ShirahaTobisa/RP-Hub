import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 多供应商模型插件：主供应商（RPH 自定义）+ 插件里添加的 B 供应商 + 内置 DeepSeek（密钥用 RPH 存的那份）。
// 拉模型时合并（同名模型归主供应商）、选择框标出供应商、请求按模型改发（地址和密钥）、别处改过地址的请求不动、
// 嵌入页面的请求也接管、关掉供应商有提示且不再往那边发、面板里新添的供应商可用、刷新后照样分发。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const MODELS = {
    'main.example': ['claude-main', 'shared-model'],
    'b.example': ['b-model', 'shared-model'],
    'api.deepseek.com': ['deepseek-chat'],
    'c.example': ['c-model']
};
const sent = [];

try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => { throw error; });
    await page.route(/^https:\/\/(main\.example|b\.example|c\.example|split\.example|api\.deepseek\.com)\//, (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const body = request.postDataJSON?.() || null;
        if (url.pathname.endsWith('/models')) return route.fulfill({ json: { object: 'list', data: (MODELS[url.host] || []).map((id) => ({ id, object: 'model' })) } });
        sent.push({ host: url.host, path: url.pathname, auth: request.headers().authorization, model: body?.model });
        if (url.pathname.endsWith('/embeddings')) return route.fulfill({ json: { data: [{ embedding: [0.1] }] } });
        return route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async (base) => {
        // 跳过 RPH 的更新公告（外壳会清掉 999999999 这个值，所以用另一个大编号）。
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url: base + '/DB/modules/multi-provider.js', enabled: true }]));
        localStorage.setItem('rph_mod_multi-provider::custom', JSON.stringify([{ id: 'b-prov', name: 'B 供应商', url: 'https://b.example/v1', key: 'b-key' }]));
        localStorage.setItem('rph_mod_multi-provider::enabled', JSON.stringify(['b-prov', 'deepseek']));
        const user = { uuid: 'u', name: '用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', 'u'],
            ['rp_hub_settings', { autoFetchModels: false, apiProviderId: 'custom', customApiUrl: 'https://main.example/v1', apiUrl: 'https://main.example/v1', apiKey: 'main-key',
                apiProviderKeys: { custom: 'main-key', deepseek: 'ds-key' }, qualityModel: 'claude-main', model: 'claude-main' }]]);
        db.close();
    }, harness.url);
    const load = async () => {
        await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
        await page.addLocatorHandler(page.getByRole('button', { name: /^(?:我)?知道了/ }).first(), (button) => button.click());
        // 刷新后上一次的“已加载”标记还在，所以等插件真正接管请求。
        await page.waitForFunction(() => window.fetch.__multiProvider === true, null, { timeout: 45000 });
    };
    const app = (name, ...args) => page.evaluate(async ({ name, args }) => {
        const a = document.querySelector('#app').__vue_app__;
        const proxy = a._instance?.proxy || a._container._vnode.component.proxy;
        return typeof proxy[name] === 'function' ? void await proxy[name](...args) : JSON.parse(JSON.stringify(proxy[name]));
    }, { name, args });
    const setApp = (path, value) => page.evaluate(({ path, value }) => {
        const a = document.querySelector('#app').__vue_app__;
        const keys = path.split('.');
        let target = a._instance?.proxy || a._container._vnode.component.proxy;
        for (const key of keys.slice(0, -1)) target = target[key];
        target[keys.at(-1)] = value;
    }, { path, value });
    // 用 RPH 自己的接口客户端发请求（和聊天、总结等一样的发法）。
    const ask = (model, path = 'chat/completions', base = 'https://main.example/v1') => page.evaluate(({ model, path, base }) => window.RPHubApiClient.requestJson({
        url: `${base}/${path}`, apiKey: 'main-key', body: path === 'embeddings' ? { model, input: 'hi' } : { model, messages: [{ role: 'user', content: 'hi' }] }
    }), { model, path, base }).then(() => sent.at(-1));

    await load();
    await app('fetchModels', true);
    await page.waitForFunction(() => {
        const a = document.querySelector('#app').__vue_app__;
        return (a._instance?.proxy || a._container._vnode.component.proxy).filteredModels.length >= 4;
    }, null, { timeout: 10000 });
    assert.deepEqual((await app('filteredModels')).map((model) => model.id).sort(), ['b-model', 'claude-main', 'deepseek-chat', 'shared-model']);
    console.log('PASS the model list shows every enabled provider, same-name models going to the main provider');

    await app('openModelSelector', 'qualityModel');
    const badge = (id) => page.locator(`button[aria-label="${id}"] [data-multi-provider]`);
    await badge('b-model').waitFor({ timeout: 5000 });
    assert.equal(await badge('b-model').textContent(), 'B 供应商');
    assert.equal(await badge('deepseek-chat').textContent(), 'DeepSeek');
    assert.equal(await badge('shared-model').textContent(), 'RPH 自定义');
    await setApp('showModelSelector', false);
    console.log('PASS the model picker labels each model with its provider');

    assert.deepEqual(await ask('b-model'), { host: 'b.example', path: '/v1/chat/completions', auth: 'Bearer b-key', model: 'b-model' });
    assert.deepEqual(await ask('deepseek-chat'), { host: 'api.deepseek.com', path: '/v1/chat/completions', auth: 'Bearer ds-key', model: 'deepseek-chat' });
    assert.deepEqual(await ask('claude-main'), { host: 'main.example', path: '/v1/chat/completions', auth: 'Bearer main-key', model: 'claude-main' });
    assert.deepEqual(await ask('shared-model'), { host: 'main.example', path: '/v1/chat/completions', auth: 'Bearer main-key', model: 'shared-model' });
    assert.deepEqual(await ask('b-model', 'embeddings'), { host: 'b.example', path: '/v1/embeddings', auth: 'Bearer b-key', model: 'b-model' });
    assert.deepEqual(await ask('b-model', 'chat/completions', 'https://split.example/v1'), { host: 'split.example', path: '/v1/chat/completions', auth: 'Bearer main-key', model: 'b-model' });
    console.log('PASS requests go to the provider of their model, with its address and key; requests already sent elsewhere are left alone');

    // 嵌入页面（角色卡生成页、小说页这类同源页面）：先给主页面发消息，之后它的请求也按模型改发。
    await page.evaluate((src) => new Promise((resolve) => {
        const frame = Object.assign(document.createElement('iframe'), { src });
        frame.id = 'probe-frame';
        frame.onload = resolve;
        document.body.appendChild(frame);
    }), harness.url + '/seed.html');
    // 和真实的嵌入页面一样，由它自己发消息（在主页面里替它发，发送方会被记成主页面）。
    await page.evaluate(() => document.getElementById('probe-frame').contentWindow.eval("parent.postMessage({ type: 'WORKSHOP_READY' }, '*')"));
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('probe-frame').contentWindow.fetch('https://main.example/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer main-key' }, body: JSON.stringify({ model: 'b-model', messages: [] })
    }));
    assert.deepEqual(sent.at(-1), { host: 'b.example', path: '/v1/chat/completions', auth: 'Bearer b-key', model: 'b-model' });
    console.log('PASS requests from embedded same-site pages are routed too');

    // 关掉 B：主力模型还在用 B 的模型，要提示；之后 B 的模型改发到主供应商。
    await setApp('settings.qualityModel', 'b-model');
    await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent)?.click());
    await page.locator('[data-rph-workshop-manager-entry]').waitFor({ state: 'attached' });
    await page.evaluate(() => document.querySelector('[data-rph-workshop-manager-entry]').click());
    await page.locator('[data-rph-workshop-launcher] button', { hasText: '多供应商模型' }).click();
    const row = (id) => page.locator(`[data-rph-workshop-panel] [data-provider="${id}"]`);
    await row('b-prov').locator('.settings-toggle').click();
    await page.locator('.toast-item', { hasText: '主力模型' }).waitFor({ timeout: 5000 });
    assert.deepEqual(await ask('b-model'), { host: 'main.example', path: '/v1/chat/completions', auth: 'Bearer main-key', model: 'b-model' });
    console.log('PASS turning a provider off warns about slots still using it and stops sending to it');

    // 在面板里添加 C 供应商：添加即启用，获取模型后可选、请求发到 C；刷新页面后照样分发。
    const field = (name) => page.locator(`[data-rph-workshop-panel] [data-new="${name}"]`);
    await field('name').fill('C 供应商');
    await field('url').fill('https://c.example/v1/');
    await field('key').fill('c-key');
    await page.locator('[data-rph-workshop-panel] [data-act="add"]').click();
    await page.locator('.toast-item', { hasText: '已添加并启用' }).waitFor({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await app('fetchModels', true);
    await page.waitForFunction(() => {
        const a = document.querySelector('#app').__vue_app__;
        return (a._instance?.proxy || a._container._vnode.component.proxy).filteredModels.some((model) => model.id === 'c-model');
    }, null, { timeout: 10000 });
    assert.equal((await app('filteredModels')).some((model) => model.id === 'b-model'), false, 'disabled provider models are no longer listed');
    assert.deepEqual(await ask('c-model'), { host: 'c.example', path: '/v1/chat/completions', auth: 'Bearer c-key', model: 'c-model' });
    await load();
    assert.deepEqual(await ask('c-model'), { host: 'c.example', path: '/v1/chat/completions', auth: 'Bearer c-key', model: 'c-model' });
    console.log('PASS a provider added in the panel is listed and used, and routing survives a reload');
} finally {
    await browser.close();
    await harness.close();
}
