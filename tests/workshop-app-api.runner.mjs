import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// API 3/4：ctx.app、ctx.requests.onChat、生成开始/结束事件、输入框按钮，以及随主线提供的 advice 插件，在真实页面上验证。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const chatBodies = [];
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const probeSource = `RPHubSDK.register({ id:'api3-probe', name:'Probe', version:'1', requiresApi:3, init(ctx) {
    const probe = globalThis.api3Probe = { events: [], lengths: [], handled: 0 };
    probe.userName = ctx.app.get('user')?.name;
    probe.historyIsArray = Array.isArray(ctx.app.get('chatHistory'));
    ctx.app.watch(() => ctx.app.get('chatHistory').length, length => probe.lengths.push(length));
    ctx.events.on('generation-start', () => probe.events.push('start'));
    ctx.events.on('generation-end', () => probe.events.push('end'));
    ctx.requests.onChat(body => { body.messages.push({ role: 'user', content: '坏插件的改动' }); throw new Error('fixture handler failure'); });
    ctx.requests.onChat(() => { probe.handled++; });
} });`;

try {
    await page.route('**/probe-api3.js', route => route.fulfill({ contentType: 'text/javascript', body: probeSource }));
    await page.route('**/v1/chat/completions', route => {
        chatBodies.push(route.request().postDataJSON());
        return route.fulfill({ json: { choices: [{ index: 0, message: { role: 'assistant', content: '回复正文' }, finish_reason: 'stop' }] } });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base }) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([
            { url: base + '/DB/modules/advice-inject.js', enabled: true },
            { url: base + '/probe-api3.js', enabled: true }
        ]));
        const uuid = 'api3-card';
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
    await page.waitForFunction(() => globalThis.api3Probe && document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
    await page.evaluate(() => {
        globalThis.vm = () => {
            const app = document.querySelector('#app').__vue_app__;
            return (app._instance || app._container._vnode.component).proxy;
        };
    });

    const probe = await page.evaluate(() => ({ userName: api3Probe.userName, historyIsArray: api3Probe.historyIsArray }));
    assert.deepEqual(probe, { userName: '隔离用户', historyIsArray: true });
    console.log('PASS ctx.app.get reads live page data');

    await page.evaluate(async () => {
        const proxy = vm();
        proxy.userInput = '我拔剑冲上去';
        await proxy.sendMessage();
    });
    await page.waitForFunction(() => api3Probe.events.includes('end'), null, { timeout: 30000 });

    assert.equal(chatBodies.length, 1);
    const messages = chatBodies[0].messages;
    const lastAssistant = messages.findLast(m => m.role === 'assistant');
    const lastUser = messages.findLast(m => m.role === 'user');
    assert.ok(lastAssistant.content.endsWith('准备完成\n\n<选项>\n我拔剑冲上去\n<选项/>'), lastAssistant.content);
    assert.ok(lastUser.content.includes('按照选项继续'));
    assert.ok(!messages.some(m => m.role === 'user' && m.content.includes('我拔剑冲上去')));
    assert.ok(!messages.some(m => String(m.content).includes('坏插件的改动')), 'failed handler changes must be discarded');
    console.log('PASS advice moved into previous AI reply; failing handler isolated');

    const after = await page.evaluate(() => {
        const history = vm().chatHistory;
        return { user: history.at(-2)?.content, reply: history.at(-1)?.content, events: api3Probe.events, lengths: api3Probe.lengths, handled: api3Probe.handled };
    });
    assert.equal(after.user, '我拔剑冲上去');
    assert.equal(after.reply, '回复正文');
    assert.deepEqual(after.events, ['start', 'end']);
    assert.ok(after.lengths.includes(2) && after.lengths.includes(3), JSON.stringify(after.lengths));
    assert.equal(after.handled, 1);
    console.log('PASS chat history keeps original input; generation events and ctx.app.watch fire');

    // 「选」按钮：改写结果写进上一条 AI 回复并随记录保存，输入框换成固定文字后发送，请求不再被二次改写。
    await page.evaluate(() => {
        vm().userInput = '我推开门';
        document.querySelector('[data-rph-workshop-composer-button="advice-inject"]').click();
    });
    await page.waitForFunction(() => api3Probe.events.filter(event => event === 'end').length === 2, null, { timeout: 30000 });
    const written = await page.evaluate(() => vm().chatHistory.slice(-3).map(message => message.content));
    assert.deepEqual(written, ['回复正文\n\n<选项>\n我推开门\n<选项/>', '按照选项继续', '回复正文']);
    const composerMessages = chatBodies[1].messages;
    assert.ok(composerMessages.findLast(m => m.role === 'assistant').content.endsWith('回复正文\n\n<选项>\n我推开门\n<选项/>'));
    assert.equal(composerMessages.findLast(m => m.role === 'user').content.includes('按照选项继续'), true);
    assert.equal(composerMessages.filter(m => String(m.content).includes('我推开门')).length, 1);
    console.log('PASS composer button writes the advice into history and sends the fixed text once');
    chatBodies.splice(0);

    await page.evaluate(base => fetch(base + '/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [
        { role: 'system', content: '你是角色扮演对话的逐轮记忆整理器。' }, { role: 'user', content: '我拔剑冲上去' }] }) }), harness.url);
    assert.equal(chatBodies.length, 1);
    assert.equal(chatBodies[0].messages.length, 2);
    assert.equal(await page.evaluate(() => api3Probe.handled), 2);
    console.log('PASS auxiliary requests are not passed to chat handlers');

    // 工坊：从分发端目录安装、刷新后运行、发布新版后原地更新；指纹不符的文件拒绝安装。
    const marketSource = (version) => `RPHubSDK.register({ id: 'market-demo', name: '工坊示例', version: '${version}', requiresApi: 4, init() { globalThis.marketDemoVersion = '${version}'; } });`;
    let marketVersion = '1.0.0';
    const sha = (text) => createHash('sha256').update(text).digest('hex');
    await page.route('https://update.rph.mornye.uk/workshop/**', (route) => {
        const pathname = new URL(route.request().url()).pathname;
        const headers = { 'access-control-allow-origin': '*' };
        if (pathname === '/workshop/index.json') {
            return route.fulfill({ headers, json: { schema: 1, plugins: [
                { id: 'market-demo', name: '工坊示例', version: marketVersion, author: '测试', description: '示例插件', requiresApi: 4,
                    file: { path: '/workshop/plugins/market-demo.js', sha256: sha(marketSource(marketVersion)) } },
                { id: 'market-bad', name: '坏指纹', version: '1.0.0', author: '测试', description: '指纹对不上', requiresApi: 4,
                    file: { path: '/workshop/plugins/market-bad.js', sha256: '0'.repeat(64) } },
                { id: 'market-future', name: '新接口', version: '1.0.0', author: '测试', description: '需要更高接口版本', requiresApi: 99,
                    file: { path: '/workshop/plugins/market-future.js', sha256: '0'.repeat(64) } }
            ] } });
        }
        if (pathname === '/workshop/plugins/market-demo.js') return route.fulfill({ headers, contentType: 'text/javascript', body: marketSource(marketVersion) });
        if (pathname === '/workshop/plugins/market-bad.js') return route.fulfill({ headers, contentType: 'text/javascript', body: 'tampered' });
        return route.fulfill({ status: 404, headers, body: '' });
    });
    page.on('dialog', (dialog) => dialog.accept());
    const marketAction = (id) => page.locator(`[data-rph-workshop-market-action="${id}"]`);
    const openManager = async () => {
        await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent)?.click());
        await page.locator('[data-rph-workshop-manager-entry]').waitFor({ state: 'attached' });
        await page.evaluate(() => document.querySelector('[data-rph-workshop-manager-entry]').click());
        await marketAction('market-demo').waitFor();
    };
    const installations = () => page.evaluate(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]'));

    await openManager();
    assert.equal(await marketAction('market-demo').textContent(), '安装');
    assert.equal(await marketAction('market-future').textContent(), '需要更新测试版');
    assert.equal(await marketAction('market-future').isDisabled(), true);
    await marketAction('market-bad').click();
    await page.waitForFunction(() => document.querySelector('[data-rph-workshop-toast]')?.textContent.includes('不一致'));
    assert.equal((await installations()).some((entry) => entry.url.endsWith('market-bad.js')), false);
    await marketAction('market-demo').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1')).some((entry) => entry.url.endsWith('/workshop/plugins/market-demo.js')));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.marketDemoVersion === '1.0.0', null, { timeout: 45000 });
    console.log('PASS workshop lists plugins, rejects a mismatched file, installs and runs a plugin after reload');

    marketVersion = '1.0.1';
    await openManager();
    assert.equal(await marketAction('market-demo').textContent(), '更新');
    await marketAction('market-demo').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1')).some((entry) => entry.id === 'market-demo' && entry.version === '1.0.1'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.marketDemoVersion === '1.0.1', null, { timeout: 45000 });
    const marketEntries = (await installations()).filter((entry) => entry.id === 'market-demo');
    assert.equal(marketEntries.length, 1);
    await openManager();
    assert.equal(await marketAction('market-demo').textContent(), '已安装');
    console.log('PASS workshop update replaces the installed file in place and keeps one installation');
    assert.deepEqual(errors, []);
} finally {
    await context.close();
    await browser.close();
    await harness.close();
}
