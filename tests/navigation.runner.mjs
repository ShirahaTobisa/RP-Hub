import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 导航插件：导航面板里的入口自己挑、底部栏；官方换了写法时各自退回原样。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const probeSource = `RPHubSDK.register({ id:'nav-probe', name:'Nav probe', version:'1', requiresApi:10, init(ctx) {
    ctx.ui.addPage({ label: '探针页', render(body) { body.textContent = '探针页内容'; } });
    // 像外壳的「同步」那样的入口：点了直接做事，忙的时候会改文字、点不动。
    globalThis.probeEntry = RPHubNavAdapter.registerEntry({ id: 'probe-entry', label: '探针入口', onClick() { globalThis.probeClicks = (globalThis.probeClicks || 0) + 1; } });
} });`;
// 模拟官方改版：把导航组件文件里的某个名字换掉。
let rewrite = (source) => source;
const state = () => page.evaluate(() => {
    const app = document.querySelector('#app').__vue_app__;
    const bar = document.querySelector('.rph-nav-bar');
    const box = (node) => node.getBoundingClientRect();
    return {
        view: (app._instance || app._container._vnode.component).proxy.currentView,
        shown: [...document.querySelectorAll('#app-navigation-panel .app-navigation-item')].filter((item) => item.offsetParent).map((item) => item.textContent.trim()),
        sections: [...document.querySelectorAll('#app-navigation-panel .app-navigation-section')].filter((section) => section.offsetParent).map((section) => section.querySelector('h3').textContent.trim()),
        panelBottom: Math.round(document.querySelector('#app-navigation-panel')?.getBoundingClientRect().bottom || 0),
        tools: !!document.querySelector('#app-navigation-panel .rph-nav-tools'),
        bar: bar?.offsetParent ? [...bar.children].map((tab) => tab.textContent + (tab.classList.contains('is-current') ? '*' : '')) : null,
        fills: bar?.offsetParent ? Math.round(box(document.querySelector('.app-main')).height + box(bar).height) : 0,
        // 聊天页的输入框底边到底栏顶边还差多少（不小于 0 就是没被盖住）
        inputGap: bar?.offsetParent && document.querySelector('.input-area-mobile')?.offsetParent
            ? Math.round(box(bar).top - box(document.querySelector('.input-area-mobile')).bottom) : null,
        quiet: document.documentElement.classList.contains('rph-nav-quiet')
    };
});
const load = async () => {
    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__ && document.querySelector('.rph-nav-bar'), null, { timeout: 45000 });
};
const openPanel = async () => {
    await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent).click());
    // 外壳和插件的入口晚一帧才加进面板。
    await page.waitForFunction(() => document.querySelector('#app-navigation-panel [data-rph-workshop-page-entry]'));
};
const closePanel = async () => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.app-navigation-layer'));
};
const item = (text) => page.locator('#app-navigation-panel .app-navigation-item', { hasText: new RegExp(`^\\s*${text}\\s*$`) });
const tool = (text) => page.locator('.rph-nav-tools button', { hasText: text });
const tab = (text) => page.locator('.rph-nav-bar .rph-nav-tab', { hasText: text });
const view = (name) => page.evaluate((target) => {
    const app = document.querySelector('#app').__vue_app__;
    (app._instance || app._container._vnode.component).proxy.currentView = target;
}, name);
const waitView = (name) => page.waitForFunction((target) => {
    const app = document.querySelector('#app').__vue_app__;
    return (app._instance || app._container._vnode.component).proxy.currentView === target;
}, name);
const all = ['聊天', '角色卡管理', '记忆系统', 'UI模板', '用量统计', '设置', '角色卡生成', '小说生成', '万相广场', '预设', '世界书', '正则', '工具'];

try {
    await page.route('**/nav-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: probeSource }));
    await page.route('**/v1/**', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/assets/js/ui-components.js*', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: rewrite(await response.text()) });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base }) => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([
            { url: base + '/DB/modules/navigation.js', enabled: true }, { url: base + '/nav-probe.js', enabled: true }
        ]));
        const uuid = 'nav-card';
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

    // 面板标题栏多了「编辑」。编辑中点入口是挑选不是打开；挑掉的入口平时不显示，整个分区都挑掉时分区标题也收起；刷新后还在。
    await load();
    // 刚装上、还没打开过面板：底栏已经有默认的几个入口，每个都画了图标。
    let now = await state();
    assert.deepEqual(now.bar, ['聊天*', '角色卡管理', '预设', '设置', '更多']);
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.rph-nav-bar .rph-nav-tab svg')].every((svg) => svg.children.length)));
    await openPanel();
    now = await state();
    assert.ok(now.tools);
    assert.deepEqual(now.shown.slice(0, 13), all);
    assert.ok(now.shown.includes('探针页') && now.shown.includes('模块管理'));
    assert.ok(now.panelBottom <= 844 - 12, `the panel stays on screen after the late entries arrive: ${now.panelBottom}`);
    await tool('编辑').click();
    for (const name of ['角色卡生成', '小说生成', '万相广场', '用量统计', '模块管理']) await item(name).click();
    now = await state();
    assert.equal(now.view, 'chat');
    assert.equal(now.shown.length, 13 + (await page.locator('#app-navigation-panel [data-rph-nav-entry]').count()));
    await tool('完成').click();
    now = await state();
    assert.deepEqual(now.shown.slice(0, 9), ['聊天', '角色卡管理', '记忆系统', 'UI模板', '设置', '预设', '世界书', '正则', '工具']);
    assert.ok(!now.shown.includes('模块管理') && now.shown.includes('探针页'));
    assert.deepEqual(now.sections, ['常用', '高级']);
    await closePanel();
    await load();
    await openPanel();
    now = await state();
    assert.deepEqual(now.sections, ['常用', '高级']);
    assert.ok(!now.shown.includes('用量统计') && !now.shown.includes('模块管理'));
    console.log('PASS entries picked in the panel are hidden (official, shell and plugin ones alike), an emptied section goes with them, and it survives a reload');

    // 底栏：每个页面都有（聊天页也在，页面往上让、输入框在它上面），当前页亮着，点一下换页。
    assert.deepEqual(now.bar, ['聊天*', '角色卡管理', '预设', '设置', '更多']);
    await item('角色卡管理').click();
    await waitView('characters');
    now = await state();
    assert.deepEqual(now.bar, ['聊天', '角色卡管理*', '预设', '设置', '更多']);
    assert.equal(now.fills, 844);
    await tab('设置').click();
    now = await state();
    assert.equal(now.view, 'settings');
    assert.deepEqual(now.bar, ['聊天', '角色卡管理', '预设', '设置*', '更多']);
    await tab('更多').click();
    await page.waitForFunction(() => document.querySelector('#app-navigation-panel'));
    await closePanel();
    await tab('聊天').click();
    await page.waitForFunction(() => document.querySelector('.input-area-mobile')?.offsetParent);
    now = await state();
    assert.deepEqual(now.bar, ['聊天*', '角色卡管理', '预设', '设置', '更多']);
    assert.equal(now.fills, 844);
    assert.ok(now.inputGap >= 0, `the chat input sits above the bar: ${now.inputGap}`);
    // 键盘弹出、聊天全屏时底栏收起，聊天页回到官方的整屏高度；之后回来。
    const flag = (name, value) => page.evaluate(([key, next]) => {
        const app = document.querySelector('#app').__vue_app__;
        (app._instance || app._container._vnode.component).proxy[key] = next;
    }, [name, value]);
    for (const name of ['isMobileKeyboardOpen', 'isChatFullscreen']) {
        await flag(name, true);
        await page.waitForFunction(() => !document.querySelector('.rph-nav-bar').offsetParent
            && Math.round(document.querySelector('.chat-view-root').getBoundingClientRect().height) === 844);
        await flag(name, false);
        await page.waitForFunction(() => document.querySelector('.rph-nav-bar').offsetParent);
    }
    console.log('PASS the bottom bar starts with the usual pages and is on every page: the chat makes room for it, the current page is marked, a tap switches pages, the keyboard and fullscreen hide it');

    // 自己挑底栏放哪些：拿掉两个，放上插件的页面和外壳那样的入口；最多 4 个。这两种由插件替用户在面板里点开，面板全程不露面。
    const settled = () => page.waitForFunction(() => !document.documentElement.classList.contains('rph-nav-quiet') && !document.querySelector('.app-navigation-layer'));
    await openPanel();
    await tool('编辑').click();
    await tool('底部栏').click();
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#app-navigation-panel [data-rph-nav-pin]')].map((node) => node.textContent.trim() + node.dataset.rphNavPin)),
        ['聊天1', '角色卡管理2', '设置4', '预设3']);
    for (const name of ['预设', '设置', '探针页', '探针入口', '世界书']) await item(name).click();
    await page.locator('.toast-item', { hasText: '底部栏最多放 4 个' }).waitFor();
    await tool('完成').click();
    await closePanel();
    await view('settings');
    await page.waitForFunction(() => document.querySelector('.rph-nav-bar')?.offsetParent);
    assert.deepEqual((await state()).bar, ['聊天', '角色卡管理', '探针页', '探针入口', '更多']);
    await tab('探针页').click();
    await waitView('rph-page-nav-probe');
    await settled();
    assert.deepEqual((await state()).bar, ['聊天', '角色卡管理', '探针页*', '探针入口', '更多']);
    assert.equal(await page.locator('[data-rph-workshop-page="nav-probe"]').count(), 1);
    await tab('探针入口').click();
    await settled();
    assert.equal(await page.evaluate(() => probeClicks), 1);
    console.log('PASS the bar takes the entries you pick, up to four; plugin and shell entries on it open without the panel showing');

    // 外壳的入口文字会变、会正忙（「同步」同步时显示「处理中」）：按编号认它，正忙时点了不动它、也不把它从底栏丢掉，忙完照常。
    await page.evaluate(() => probeEntry.update({ label: '处理中', busy: true }));
    await tab('探针入口').click();
    await settled();
    assert.equal(await page.evaluate(() => probeClicks), 1);
    assert.deepEqual((await state()).bar, ['聊天', '角色卡管理', '探针页*', '探针入口', '更多']);
    await openPanel();
    assert.equal(await page.evaluate(() => document.querySelector('#app-navigation-panel [data-rph-nav-entry="probe-entry"]').dataset.rphNavPin), '4');
    await closePanel();
    await page.evaluate(() => probeEntry.update({ label: '探针入口', busy: false }));
    await tab('探针入口').click();
    await settled();
    assert.equal(await page.evaluate(() => probeClicks), 2);
    console.log('PASS an entry that changes its text or is busy is still recognized, left alone while busy, and kept on the bar');

    // 底栏上的入口后来没了（插件卸了、官方改名）：点它时提示一句、从底栏拿掉，并把面板亮出来让用户自己选。
    await page.evaluate(() => {
        const pins = JSON.parse(localStorage.getItem('rph_mod_navigation::bar'));
        localStorage.setItem('rph_mod_navigation::bar', JSON.stringify([...pins.slice(0, 3),
            { key: '没有的入口', label: '没有的入口', icon: [['path', [['d', 'M4 4h16'], ['onclick', 'x']]], ['script', []]] }]));
    });
    await load();
    await view('settings');
    await tab('没有的入口').waitFor();
    assert.equal(await page.evaluate(() => document.querySelector('.rph-nav-bar .rph-nav-tab:nth-child(4) svg').innerHTML), '<path d="M4 4h16"></path>');
    await tab('没有的入口').click();
    await page.locator('.toast-item', { hasText: '已不存在' }).waitFor();
    now = await state();
    assert.deepEqual(now.bar, ['聊天', '角色卡管理', '探针页', '更多']);
    assert.ok(now.shown.length && !now.quiet);
    await closePanel();
    console.log('PASS an entry that no longer exists is dropped from the bar and the panel is shown instead; saved icons only keep plain shapes');

    // 官方换了聊天页的写法、没给底栏让出位置：底栏在聊天页收起（不能盖住输入框），别的页面照常。
    await page.addStyleTag({ content: '#app .app-main .chat-view-root{flex-shrink:0!important}' });
    await view('chat');
    await page.waitForFunction(() => !document.querySelector('.rph-nav-bar').offsetParent);
    await view('settings');
    await page.waitForFunction(() => document.querySelector('.rph-nav-bar').offsetParent);
    console.log('PASS a page that leaves no room for the bar does not get it');

    // 官方换了写法、读不到页面清单：底栏的入口照样能用，改成替用户在面板里点。
    rewrite = (source) => source.replace(/\bsections\b/g, 'groups');
    await load();
    await view('settings');
    await tab('角色卡管理').waitFor();
    await tab('角色卡管理').click();
    await waitView('characters');
    await page.waitForFunction(() => !document.documentElement.classList.contains('rph-nav-quiet') && !document.querySelector('.app-navigation-layer'));
    console.log('PASS when the official page list cannot be read, bar entries still work by clicking in the panel');

    // 官方换了面板的写法、找不到放「编辑」的地方：什么都不藏，面板和官方一样。
    rewrite = (source) => source.replaceAll('app-navigation-close', 'app-navigation-shut');
    await load();
    await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent).click());
    await page.waitForFunction(() => document.querySelectorAll('#app-navigation-panel .app-navigation-item').length >= 13);
    now = await state();
    assert.equal(now.tools, false);
    assert.deepEqual(now.shown.slice(0, 13), all);
    assert.deepEqual(now.sections, ['常用', '在线', '高级']);
    console.log('PASS when the panel cannot be edited, nothing is hidden');

    // 电脑宽度没有底栏。
    rewrite = (source) => source;
    await page.setViewportSize({ width: 1280, height: 800 });
    await load();
    await view('settings');
    await page.waitForFunction(() => document.querySelector('.settings-view'));
    assert.equal((await state()).bar, null);
    console.log('PASS there is no bottom bar at desktop width');
    assert.deepEqual(errors, []);
} finally {
    await context.close();
    await browser.close();
    await harness.close();
}
