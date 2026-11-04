import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream, root } from './sync-195.helpers.mjs';

// 柳贯一 20.5.7 工坊版：加载器第一次运行它时记下它有 beforeMount，刷新后官方页面挂载前就改成聊天模型五槽、
// 恢复输入混淆开关；开关关掉后 Gemini 请求不再混淆；插件包的流式保活不影响回复正文。
// 响应增强：init 里重编译官方 API 客户端去掉固定超时，主聊天改成每次从 window 取客户端；开关关掉后请求原样直发。
const source = await fs.readFile(path.join(root, 'DB/modules/liuguanyi-20.5.7.js'), 'utf8');
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
const bodies = [];
page.on('pageerror', (error) => errors.push(error.message));
const open = async () => {
    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => globalThis.__rphLiuguanyiInitialized && document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
    await page.evaluate(() => {
        globalThis.vm = () => {
            const app = document.querySelector('#app').__vue_app__;
            return (app._instance || app._container._vnode.component).proxy;
        };
    });
};
const send = async (text) => {
    const length = await page.evaluate((text) => { const length = vm().chatHistory.length; vm().userInput = text; vm().sendMessage(); return length; }, text);
    await page.waitForFunction((length) => !vm().isGenerating && vm().chatHistory.length === length + 2 && vm().chatHistory.at(-1).content.includes('流式回复'), length, { timeout: 30000 });
    return bodies.at(-1);
};

try {
    await page.route('**/v1/chat/completions', (route) => {
        bodies.push(route.request().postDataJSON());
        const chunk = (text) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
        return route.fulfill({ contentType: 'text/event-stream', body: chunk('流式') + chunk('回复') + 'data: [DONE]\n\n' });
    });
    // 开屏图在外部图床，连不上时开屏不会结束；测试不碰外网，直接让它失败（插件按加载失败照常倒计时）。
    await page.route('https://img.scdn.io/**', (route) => route.abort());
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base, source }) => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        const uuid = 'liu-card';
        const character = { uuid, name: '柳测试角色', description: '工坊版验收', first_mes: '准备完成', worldInfo: [], regexScripts: [], uiTemplates: [] };
        const user = { uuid: 'liu-user', name: '验收用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: [uuid] }], ['rp_hub_character_' + uuid, character],
            ['rp_hub_chat_' + uuid, [{ id: 'greeting', role: 'assistant', name: character.name, content: character.first_mes }]],
            ['rp_hub_settings', { autoFetchModels: false, apiUrl: base + '/v1', apiKey: 'fixture-key', model: 'gemini-fixture', stream: true }],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
        const workshop = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubWorkshop', 1);
            request.onupgradeneeded = () => { request.result.createObjectStore('scripts'); request.result.createObjectStore('data'); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
            const tx = workshop.transaction('scripts', 'readwrite');
            tx.objectStore('scripts').put(source, 'rphub-file:liuguanyi.js');
            tx.oncomplete = resolve;
            tx.onabort = () => reject(tx.error);
        });
        workshop.close();
        localStorage.setItem('rphub_sakura_chat_extra_slots_v1', JSON.stringify({ models: ['fourth-model', 'fifth-model'] }));
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ id: 'liuguanyi', url: 'rphub-file:liuguanyi.js', enabled: true }]));
    }, { base: harness.url, source });

    await open();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1'))[0].lastStatus === 'ok', null, { timeout: 30000 });
    await page.locator('.toast-item', { hasText: '要再刷新一次才能完整生效' }).waitFor({ timeout: 5000 });
    const first = await page.evaluate(() => ({ status: window.__sakuraNativeFiveStatus ?? null, entry: JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1'))[0] }));
    assert.equal(first.status, null, 'the first load has not seen beforeMount yet');
    assert.equal(first.entry.beforeMount, true);

    await open();
    const mounted = await page.evaluate(() => ({ status: window.__sakuraNativeFiveStatus, slots: vm().chatModelSlots.map((slot) => slot.mode), obfuscation: vm().settings.inputObfuscation }));
    assert.deepEqual(mounted, { status: 'mounted', slots: ['quality', 'balanced', 'fast', 'fourth', 'fifth'], obfuscation: true });
    await page.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem('rphub_split_apis_v2') || '{}').main?.customUrls || {}).length === 5, null, { timeout: 15000 });
    console.log('PASS after one refresh the page mounts with five chat model slots, the obfuscation toggle and five main API slots');

    await page.waitForFunction(() => window.__sakuraResponseTimeoutPolicyInstalled === true, null, { timeout: 15000 });
    const enhance = await page.evaluate(() => ({
        setting: vm().settings.sakuraStreamEnhanceEnabled,
        lateBound: String(document.querySelector('#app').__vue_app__._component.setup).includes('window.RPHubApiClient.requestChatCompletion('),
        noDeadline: window.__sakuraTransformResponseTimeout(`const withApiResponse = async (options, read) => {
            timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120000);
            if (!response.ok) {
            }
            return await read(response, touch);`).includes('if (!sakuraNoDeadline) timer = setTimeout')
    }));
    assert.deepEqual(enhance, { setting: true, lateBound: true, noDeadline: true });
    console.log('PASS the response enhancement rebuilds the API client without the fixed timeout and the chat uses it');

    assert.match(JSON.stringify(await send('第一句')), /read_user_input/);
    assert.equal(await page.evaluate(() => window.__sakuraStreamEnhanceDebug.lastRoute), 'enhanced');
    await page.evaluate(() => { vm().settings.inputObfuscation = false; });
    assert.doesNotMatch(JSON.stringify(await send('第二句')), /read_user_input/);
    console.log('PASS the obfuscation toggle controls Gemini requests and streamed replies arrive intact');

    await page.evaluate(() => { vm().setSakuraStreamEnhanceEnabled(false); });
    await send('第三句');
    assert.equal(await page.evaluate(() => window.__sakuraStreamEnhanceDebug.lastRoute), 'native-bypass');
    await page.evaluate(() => { vm().setSakuraStreamEnhanceEnabled(true); });
    await send('第四句');
    assert.equal(await page.evaluate(() => window.__sakuraStreamEnhanceDebug.lastRoute), 'enhanced');
    console.log('PASS switching the response enhancement off sends the main chat request untouched and on restores it');

    // 第 4 槽的模型来自旧版保存的槽位配置，点它就切过去。
    await page.waitForFunction(() => !document.getElementById('custom-splash-screen'), null, { timeout: 15000 });
    await page.evaluate(() => { vm().showChatModelSelector = true; });
    await page.locator('.chat-model-slots > button').nth(3).click();
    assert.equal(await page.evaluate(() => vm().settings.model), 'fourth-model');
    console.log('PASS slot 4 keeps its saved model and selecting it switches the chat model');

    // 2.0.4 起官方没有「空间管理」，测试版又不显示「备份与转移」，「樱花个性化」要接在设置页最后。
    await page.evaluate(() => { vm().currentView = 'settings'; });
    await page.locator('#sakura-personal-section').waitFor({ timeout: 15000 });
    console.log('PASS the settings page shows the sakura personalization section');

    // 浏览器自带的弹窗不该再出现（出现就记成错误）：主题改名、删除记忆都走插件自己的框，提示走气泡。
    page.on('dialog', (dialog) => { errors.push('browser dialog: ' + dialog.message()); dialog.dismiss(); });
    await page.locator('.sakura-personal-card[data-entry="theme"]').click();
    const theme = page.locator('#sakura-theme-mask');
    await theme.waitFor();
    await theme.locator('button').filter({ hasText: '#' }).first().click();
    await theme.getByLabel('主题 HEX 色值').fill('#58a6f5');
    await theme.getByLabel('主题 HEX 色值').press('Enter');
    // 输入框失焦时面板会重画一次，先失焦再点，不然这一下会点在被换掉的按钮上。
    await theme.getByLabel('主题 HEX 色值').blur();
    await theme.getByTitle('重命名该主题').first().click();
    const naming = page.locator('#sakura-moment-naming');
    assert.equal(await naming.locator('.sn-title').innerText(), '给这个主题起个名字');
    await naming.locator('.sn-input').fill('海蓝');
    await naming.locator('.sn-btn-ok').click();
    await naming.waitFor({ state: 'detached' });
    await theme.getByText('海蓝').first().waitFor();
    await page.evaluate(() => document.getElementById('sakura-theme-mask').remove());
    console.log('PASS renaming a theme uses the plugin dialog instead of the browser prompt');

    await page.evaluate(() => window.RPHubStorage.setScopedStoredValue('classic_memories', vm().currentCharacter.uuid, [{ id: 'mem-1', classicMemory: true, turn: 1, summary: '第一轮的总结' }]));
    await open();
    await page.waitForFunction(() => !document.getElementById('custom-splash-screen'), null, { timeout: 15000 });
    await page.evaluate(() => { vm().memorySettings.enabled = true; vm().currentView = 'memory'; });
    const deleteMemory = page.locator('.sakura-mem-del').first();
    await deleteMemory.waitFor({ timeout: 15000 });
    const storedMemories = () => page.evaluate(async () => (await window.RPHubStorage.getScopedStoredValue('classic_memories', vm().currentCharacter.uuid)).length);
    await deleteMemory.click();
    const memoryConfirm = page.locator('#sakura-moment-confirm');
    assert.equal(await memoryConfirm.locator('.sn-title').innerText(), '删除总结记忆');
    await memoryConfirm.locator('.sn-btn-cancel').click();
    assert.equal(await storedMemories(), 1, 'cancel keeps the memory');
    await deleteMemory.click();
    await memoryConfirm.locator('.sn-btn-danger').click();
    await page.locator('#sakura-moment-toast').filter({ hasText: '已删除第 1 轮' }).waitFor({ timeout: 5000 });
    assert.equal(await storedMemories(), 0);
    console.log('PASS deleting a memory uses the plugin dialog and toast instead of browser popups');
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await harness.close();
}
