import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream, root } from './sync-195.helpers.mjs';

// 柳贯一 20.3.2 工坊版：加载器第一次运行它时记下它有 beforeMount，刷新后官方页面挂载前就改成聊天模型五槽、
// 恢复输入混淆开关；开关关掉后 Gemini 请求不再混淆；插件包的流式保活不影响回复正文。
const source = await fs.readFile(path.join(root, 'DB/modules/liuguanyi-20.3.2.js'), 'utf8');
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

    assert.match(JSON.stringify(await send('第一句')), /read_user_input/);
    await page.evaluate(() => { vm().settings.inputObfuscation = false; });
    assert.doesNotMatch(JSON.stringify(await send('第二句')), /read_user_input/);
    console.log('PASS the obfuscation toggle controls Gemini requests and streamed replies arrive intact');

    // 第 4 槽的模型来自旧版保存的槽位配置，点它就切过去。
    await page.waitForFunction(() => !document.getElementById('custom-splash-screen'), null, { timeout: 15000 });
    await page.evaluate(() => { vm().showChatModelSelector = true; });
    await page.locator('.chat-model-slots > button').nth(3).click();
    assert.equal(await page.evaluate(() => vm().settings.model), 'fourth-model');
    console.log('PASS slot 4 keeps its saved model and selecting it switches the chat model');
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await harness.close();
}
