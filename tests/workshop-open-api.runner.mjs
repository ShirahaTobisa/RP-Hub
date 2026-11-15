import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// API 10：样式（含提前生效）、往页面挂内容、插件之间互相提供接口、包住官方函数（ctx.hooks），在真实页面上验证。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const chatBodies = [];
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const sources = {
    // 排在前面、先初始化：用到的接口由后面的插件提供。
    'probe-open-user.js': `RPHubSDK.register({ id:'open-user', name:'User', version:'1', requiresApi:10, init(ctx) {
        ctx.use('open-probe').then(api => { globalThis.openUser = api.hello(); });
    } });`,
    'probe-open.js': `RPHubSDK.register({ id:'open-probe', name:'Probe', version:'1', requiresApi:10, hooks:true,
        beforeMount({ ctx }) { globalThis.openProbeEarly = typeof ctx?.storage?.get === 'function' && !document.querySelector('#app').__vue_app__; },
        init(ctx) {
            const probe = globalThis.openProbe = { ctx, rendered: 0 };
            probe.early = ctx.ui.addStyle(':root{--open-probe-early:1}', { early: true });
            probe.style = ctx.ui.addStyle(':root{--open-probe:1}');
            probe.attachment = ctx.ui.attach({ anchor: '.settings-view .settings-page-header', render(node) { probe.rendered += 1; node.textContent = '探针挂件'; } });
            ctx.provide('open-probe', { hello: () => 'hi' });
        } });`,
    // 像柳贯一那样在挂载前把官方 setup 重新生成一遍：之后加载器照样能包住里面的函数。
    'probe-open-rebuild.js': `RPHubSDK.register({ id:'open-rebuild', name:'Rebuild', version:'1', requiresApi:10,
        beforeMount({ options }) { options.setup = (0, eval)('(function ' + String(options.setup) + ')'); }, init() { globalThis.openRebuild = true; } });`,
    // 模拟官方写法变了：setup 换成改写不了的样子。
    'probe-open-break.js': `RPHubSDK.register({ id:'open-break', name:'Break', version:'1', requiresApi:10,
        beforeMount({ options }) { const setup = options.setup; options.setup = (...args) => setup(...args); }, init() { globalThis.openBreak = true; } });`
};
const vm = `(() => { const app = document.querySelector('#app').__vue_app__; return (app._instance || app._container._vnode.component).proxy; })()`;
const ready = (name) => page.waitForFunction(`globalThis.${name} && document.querySelector('#app')?.__vue_app__`, null, { timeout: 45000 });
const setModules = (names) => page.evaluate(({ base, names }) => {
    const saved = JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]');
    localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify(names.map(name => saved.find(entry => entry.url.endsWith(name)) || { url: base + '/' + name, enabled: true })));
}, { base: harness.url, names });

try {
    for (const [name, body] of Object.entries(sources)) await page.route('**/' + name, route => route.fulfill({ contentType: 'text/javascript', body }));
    await page.route('**/v1/chat/completions', route => {
        chatBodies.push(route.request().postDataJSON());
        return route.fulfill({ json: { choices: [{ index: 0, message: { role: 'assistant', content: '回复正文' }, finish_reason: 'stop' }] } });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base }) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        const uuid = 'open-card';
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
    await setModules(['probe-open-user.js', 'probe-open.js']);

    // 第一次打开：插件刚登记 hooks，这次还没改写官方函数，页面照常。
    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await ready('openProbe');
    assert.equal(await page.evaluate(() => openProbe.ctx.hooks.has('sendMessage')), false);
    assert.equal(await page.evaluate(() => openUser), 'hi');
    console.log('PASS ctx.provide / ctx.use connect two plugins whatever the order; hooks wait for the next load');

    await page.reload({ waitUntil: 'domcontentloaded' });
    const first = await page.evaluate(() => ({
        css: document.querySelector('style[data-rph-workshop-style="open-probe"]')?.textContent, loaded: !!globalThis.openProbe
    }));
    assert.deepEqual(first, { css: ':root{--open-probe-early:1}', loaded: false });
    await ready('openProbe');
    assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-rph-workshop-style="open-probe"]').length), 2);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--open-probe')), '1');
    await page.evaluate(() => { openProbe.early.set(':root{--open-probe-early:2}'); openProbe.style.remove(); });
    assert.deepEqual(await page.evaluate(() => [localStorage.getItem('rph_mod_open-probe::early-style'),
        document.querySelectorAll('style[data-rph-workshop-style="open-probe"]').length]), [':root{--open-probe-early:2}', 1]);
    await page.evaluate(() => openProbe.early.remove());
    assert.equal(await page.evaluate(() => localStorage.getItem('rph_mod_open-probe::early-style')), null);
    console.log('PASS ctx.ui.addStyle: the early style is on the page before the plugin loads, can be changed and removed');

    assert.equal(await page.evaluate(() => openProbeEarly), true);
    const names = await page.evaluate(() => openProbe.ctx.hooks.names());
    assert.ok(names.length > 100 && ['sendMessage', 'generateResponse', 'showToast'].every(name => names.includes(name)), String(names.length));
    console.log(`PASS beforeMount gets ctx; ${names.length} official functions can be wrapped`);

    // sendMessage 在官方内部调用 generateResponse：包住后者，页面发消息时也经过插件；坏掉的包装不影响官方流程和别的包装。
    await page.evaluate(() => {
        openProbe.calls = [];
        openProbe.ctx.hooks.wrap('generateResponse', (next, ...args) => { openProbe.calls.push('good'); return next(...args); });
        openProbe.ctx.hooks.wrap('generateResponse', () => { openProbe.calls.push('bad'); throw new Error('fixture hook failure'); });
        openProbe.ctx.hooks.wrap('generateResponse', async (next, ...args) => { const result = await next(...args); openProbe.calls.push('after'); throw new Error('fixture late failure'); });
    });
    await page.evaluate(`(async () => { const proxy = ${vm}; proxy.userInput = '我拔剑冲上去'; await proxy.sendMessage(); })()`);
    await page.waitForFunction(`${vm}.chatHistory.length === 3 && !${vm}.isGenerating`, null, { timeout: 30000 });
    assert.equal(chatBodies.length, 1);
    assert.deepEqual(await page.evaluate(() => openProbe.calls), ['bad', 'good', 'after']);
    assert.equal(await page.evaluate(`${vm}.chatHistory.at(-1).content`), '回复正文');
    console.log('PASS a wrapped official function is reached from inside the official code; failing wrappers are skipped');

    // 不调用 next 就是拦下；改参数、直接调用官方函数。
    const toasts = `${vm}.toasts.map(toast => toast.message)`;
    const off = await page.evaluateHandle(() => openProbe.ctx.hooks.wrap('showToast', () => {}));
    await page.evaluate(() => openProbe.ctx.hooks.call('showToast', '被拦下的提示'));
    assert.ok(!(await page.evaluate(toasts)).includes('被拦下的提示'));
    await off.evaluate(remove => remove());
    await page.evaluate(() => {
        openProbe.ctx.hooks.wrap('showToast', (next, message, ...rest) => next('插件改过：' + message, ...rest));
        openProbe.ctx.hooks.call('showToast', '直接调用');
    });
    assert.ok((await page.evaluate(toasts)).includes('插件改过：直接调用'));
    assert.equal(await page.evaluate(() => { try { openProbe.ctx.hooks.call('noSuchOfficialFunction'); return 'called'; } catch (error) { return 'threw'; } }), 'threw');
    console.log('PASS wrappers can block or change a call, and ctx.hooks.call reaches an official function by name');

    // 挂到设置页标题下面：进设置页才出现，离开再回来由加载器补回，render 只调用一次。
    const attached = () => page.evaluate(() => {
        const node = document.querySelector('[data-rph-workshop-attach="open-probe"]');
        return node ? [node.textContent, node.previousElementSibling?.classList.contains('settings-page-header')] : null;
    });
    assert.equal(await attached(), null);
    for (const view of ['settings', 'chat', 'settings']) {
        await page.evaluate(`${vm}.currentView = '${view}'`);
        await page.waitForFunction(present => !!document.querySelector('[data-rph-workshop-attach="open-probe"]') === present, view === 'settings');
    }
    assert.deepEqual(await attached(), ['探针挂件', true]);
    assert.equal(await page.evaluate(() => openProbe.rendered), 1);
    await page.evaluate(() => openProbe.attachment.remove());
    await page.evaluate(`${vm}.currentView = 'chat'`);
    await page.evaluate(`${vm}.currentView = 'settings'`);
    await page.waitForTimeout(300);
    assert.equal(await attached(), null);
    console.log('PASS ctx.ui.attach puts content next to an anchor and restores it after the page redraws');

    await setModules(['probe-open-rebuild.js', 'probe-open.js']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready('openRebuild');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready('openProbe');
    assert.equal(await page.evaluate(() => openProbe.ctx.hooks.names().length), names.length);
    console.log('PASS hooks still install after another plugin rebuilt the official setup before mount');

    // 官方写法变了、改写不了：页面照常，别的接口照常，只是 ctx.hooks 用不了。
    await setModules(['probe-open-break.js', 'probe-open.js']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready('openBreak');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready('openProbe');
    assert.deepEqual(await page.evaluate(() => [openProbe.ctx.hooks.has('sendMessage'), openProbe.ctx.hooks.names().length]), [false, 0]);
    assert.equal(await page.evaluate(`${vm}.chatHistory.length`), 3);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--open-probe')), '1');
    console.log('PASS when the official setup cannot be rewritten the page and other interfaces keep working');
    assert.deepEqual(errors, []);
} finally {
    await context.close();
    await browser.close();
    await harness.close();
}
