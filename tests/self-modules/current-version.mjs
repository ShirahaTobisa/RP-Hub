import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const built = path.resolve(process.argv[2] || fileURLToPath(new URL('../../', import.meta.url)));
const release = '2026.11.10.2';
const current = file => execFileSync('git', ['show', release + ':' + file], { cwd: repository, maxBuffer: 4 * 1024 * 1024 });
const currentPatcher = await import('data:text/javascript;base64,' + current('DB/app-patches.mjs').toString('base64'));
const candidatePatcher = await import(pathToFileURL(path.join(built, 'DB/app-patches.mjs')));
const { startHarness, initializeFixture, chromium, chrome, defaultUpstream } = await import(pathToFileURL(path.join(built, 'tests/sync-195.helpers.mjs')));
const upstreamApp = await fs.readFile(path.join(defaultUpstream, 'assets/js/app.js'), 'utf8');
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const report = { release, upstream: JSON.parse(await fs.readFile(path.join(defaultUpstream, '.fixture.json'), 'utf8')).tag,
    pageErrors: [], imageWrites: [], phases: [] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const keys = ['rp_hub_character_index', ...['card-A', 'card-B'].flatMap(id => [
    'rp_hub_character_' + id, 'rp_hub_chat_' + id, 'rp_hub_image_renders_' + id
])];
await fs.mkdir(path.join(built, 'evidence/self-modules'), { recursive: true });
let phase = 'current';
const sourceCache = new Map();
let page, sentFeedback;
try {
    page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === harness.url) {
            if (url.pathname === '/assets/js/app.js') {
                const patcher = phase === 'current' ? currentPatcher : candidatePatcher;
                return route.fulfill({ contentType: 'text/javascript', body: patcher.patchRpHubAppJs(upstreamApp, { version: report.upstream }).code });
            }
            if (url.pathname.startsWith('/DB/')) {
                const file = url.pathname.slice(1), key = phase + ':' + file;
                if (!sourceCache.has(key)) sourceCache.set(key, phase === 'current' ? current(file) : await fs.readFile(path.join(built, file)));
                return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: sourceCache.get(key) });
            }
            if (url.pathname === '/api/rp-image') {
                if (request.method() !== 'GET') report.imageWrites.push(request.method());
                return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="#60a5fa"/></svg>' });
            }
            if (url.pathname === '/api/rp-image-thumb') return route.fulfill({ json: { ok: true } });
            // 本地模拟报告接收，只为看发送后的界面；不连接任何分发站。
            if (url.pathname === '/api/rp-feedback') {
                sentFeedback = request.postDataJSON();
                return route.fulfill({ json: { ok: true, id: '2wpj4xcha-f9dede2e' } });
            }
            if (url.pathname === '/image/api/settings') return route.fulfill({ json: {} });
            return route.continue();
        }
        if (request.resourceType() === 'script' && ['cdn.tailwindcss.com', 'unpkg.com', 'cdn.jsdelivr.net'].includes(url.hostname)) return route.continue();
        if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: png });
        if (request.resourceType() === 'stylesheet') return route.fulfill({ contentType: 'text/css', body: '' });
        return route.fulfill({ json: {} });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async () => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        const content = '兼容检查。image###blue sky, white clouds###';
        const user = { uuid: 'fixture-user', name: '测试用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: ['card-A', 'card-B'] }],
            ...['card-A', 'card-B'].flatMap(id => [
                ['rp_hub_character_' + id, { uuid: id, name: '同名角色', first_mes: content, description: '测试', avatar: '', worldInfo: [], regexScripts: [], uiTemplates: [] }],
                ['rp_hub_chat_' + id, [{ id: 'same-message', role: 'assistant', name: '同名角色', content }]],
                ['rp_hub_image_renders_' + id, []]
            ]),
            ['rp_hub_settings', { autoFetchModels: false, apiKey: '', imageGenKey: 'STD-fixture', freezeImageGeneration: true }],
            ['rp_hub_global_worldinfo', [{ comment: '自动生图', constant: true, enabled: true, content: 'fixture', scope: 'global' }]],
            ['rp_hub_worldinfo', []], ['rp_hub_global_regex', []], ['rp_hub_regex', []],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
    });
    const frame = page.locator('[data-chat-index="0"] .rp-generated-image-frame');
    const ready = async () => {
        await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
        await page.addLocatorHandler(page.getByRole('button', { name: /^(?:我)?知道了/ }).first(), button => button.click());
        await page.waitForFunction(() => RPHubImageModule?.getState().persistenceFlushWrapped && window.RPHubSDK);
        await page.locator('#custom-splash-screen').waitFor({ state: 'detached' });
        await page.waitForFunction(() => {
            const transition = document.querySelector('.entry-transition');
            return !transition || Number(getComputedStyle(transition).opacity) === 0;
        });
        await page.evaluate(async () => {
            const app = document.querySelector('#app').__vue_app__;
            window.testApp = (app._instance || app._container._vnode.component).proxy;
            await testApp.selectCharacter(0);
            await RPHubImageModule.scan();
        });
        await frame.waitFor();
    };
    const snapshot = () => page.evaluate(async keys => {
        await RPH_R2_FLUSH_PERSISTENCE();
        await RPHubImageModule.flushRecords();
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB');
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction('store');
                const requests = keys.map(key => tx.objectStore('store').get(key));
                tx.oncomplete = () => resolve(Object.fromEntries(keys.map((key, index) => [key, requests[index].result])));
                tx.onabort = () => reject(tx.error);
            });
        } finally { db.close(); }
    }, keys);
    const contracts = () => page.evaluate(() => Object.fromEntries(
        ['RPHubCharStore', 'RPHubImageModule', 'RPHubSDK', 'RPHubUI', 'RPHubNavAdapter']
            .map(name => [name, Object.keys(window[name]).sort()])));
    const image = () => frame.locator('img').getAttribute('src');

    await ready();
    // 旧聊天先按现行版的手动生图规则创建图片，再检查两个版本如何读取这份存档。
    if (!await frame.locator('img').count()) await frame.locator('.rp-image-reroll-button').click();
    await frame.locator('img').waitFor();
    const before = await snapshot(), api = await contracts(), originalImage = await image();
    report.phases.push('current saved');
    phase = 'candidate'; await ready();
    const candidateApi = await contracts();
    assert.ok(candidateApi.RPHubUI.includes('openLogViewer'), 'old run-log plugins must find the built-in viewer');
    candidateApi.RPHubUI = candidateApi.RPHubUI.filter(name => name !== 'openLogViewer');
    assert.deepEqual(candidateApi, api, 'all existing published browser API names must stay compatible');
    assert.deepEqual(await snapshot(), before, 'opening the candidate must not rewrite current cards/chats/images');
    assert.equal(await image(), originalImage);
    report.phases.push('candidate read current data unchanged');

    await page.setViewportSize({ width: 430, height: 932 });
    await page.evaluate(() => { window.feedbackPanel = RPHubUI.openLogViewer(); });
    const feedback = page.locator('[data-rph-diagnostics]');
    await feedback.waitFor();
    await feedback.locator('button[aria-haspopup="listbox"]').click();
    await page.getByRole('option', { name: '图片不对', exact: true }).click();
    assert.equal(JSON.parse(await feedback.locator('[data-preview]').inputValue()).issue, 'image', 'native RPH selector updates the report');
    assert.equal(await feedback.locator('[data-details]').getAttribute('open'), null);
    const theme = await page.evaluate(() => ({ data: document.documentElement.dataset.appTheme, classes: document.documentElement.className }));
    const setTheme = dark => page.evaluate(dark => { document.documentElement.dataset.appTheme = dark ? 'dark' : 'light'; document.documentElement.classList.toggle('dark', dark); }, dark);
    const shot = name => page.screenshot({ path: path.resolve(built, 'evidence/self-modules/feedback-current-' + name + '.png'), fullPage: true, animations: 'disabled' });
    for (const [name, width, height, dark] of [['mobile', 390, 844, false], ['mobile-dark', 390, 844, true], ['desktop', 1280, 900, false]]) {
        await page.setViewportSize({ width, height });
        await setTheme(dark);
        await shot(name);
        const bounds = await feedback.locator('[role="dialog"]').boundingBox();
        assert.ok(bounds.width <= width && bounds.height <= height, 'report fits ' + name);
    }
    // 手机上：下拉展开再选中收起、展开报告内容、发送后显示编号。
    await page.setViewportSize({ width: 390, height: 844 });
    await setTheme(false);
    await feedback.locator('button[aria-haspopup="listbox"]').click();
    await page.getByRole('listbox').waitFor();
    await shot('mobile-menu');
    await page.getByRole('option', { name: '同步异常', exact: true }).click();
    await page.getByRole('listbox').waitFor({ state: 'detached' });
    assert.equal(JSON.parse(await feedback.locator('[data-preview]').inputValue()).issue, 'sync');
    await feedback.locator('[data-details] > summary').click();
    assert.equal(await feedback.locator('[data-preview]').isVisible(), true);
    await shot('mobile-details');
    await feedback.locator('[data-details] > summary').click();
    await feedback.locator('[data-note]').fill('上传到一半提示失败');
    await feedback.locator('[data-send]').click();
    await feedback.locator('[data-result]', { hasText: '2wpj4xcha-f9dede2e' }).waitFor();
    assert.equal(await feedback.locator('[data-send]').textContent(), '复制编号');
    assert.deepEqual([sentFeedback.action, sentFeedback.report.issue, sentFeedback.report.note], ['report', 'sync', '上传到一半提示失败']);
    await setTheme(true);
    await shot('mobile-sent-dark');
    await setTheme(false);
    await shot('mobile-sent');
    await feedback.locator('button[aria-haspopup="listbox"]').click();
    await page.evaluate(() => feedbackPanel.close());
    await feedback.waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('listbox').count(), 0, 'closing feedback unmounts the native selector menu');
    await page.evaluate(theme => { document.documentElement.dataset.appTheme = theme.data; document.documentElement.className = theme.classes; }, theme);
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.evaluate(async () => {
        testApp.characters[0].name = '改名后';
        await RPHubCharStore.saveAll(testApp.characters);
        testApp.chatHistory[0].content += '\n新增普通文字。';
        await RPH_R2_SAVE_CHAT_HISTORY();
        await Vue.nextTick();
        await RPHubImageModule.scan();
    });
    assert.equal(await image(), originalImage, 'renaming/editing must keep the saved image');
    await frame.locator('.rp-image-reroll-button').click();
    await page.waitForFunction(previous => {
        const source = document.querySelector('[data-chat-index="0"] .rp-generated-image-frame img')?.getAttribute('src');
        return source && source !== previous;
    }, originalImage);
    const candidateData = await snapshot(), selectedImage = await image();
    report.phases.push('candidate saved edited character, message and rerolled image');

    phase = 'current'; await ready();
    assert.deepEqual(await snapshot(), candidateData, 'the published version must read and save candidate data unchanged');
    assert.equal(await image(), selectedImage, 'going back must keep the selected reroll');
    assert.deepEqual(await contracts(), api);
    assert.deepEqual(report.imageWrites, [], 'loading/upgrading/going back must not trigger generation');
    assert.deepEqual(report.pageErrors, []);
    report.phases.push('current read candidate data unchanged');
    report.ok = true;
    console.log('PASS current 2026.11.10.2 → candidate → current on official ' + report.upstream + ': APIs, characters, chats and selected images preserved');
} catch (error) {
    report.error = error.stack;
    report.visibleText = await page?.evaluate(() => document.body.innerText.slice(-2500)).catch(() => null);
    report.frames = await page?.locator('.rp-generated-image-frame').evaluateAll(frames => frames.map(frame => ({
        data: { ...frame.dataset }, image: frame.querySelector('img')?.getAttribute('src'), disabled: frame.querySelector('button')?.disabled
    }))).catch(() => null);
    throw error;
} finally {
    await fs.writeFile(path.resolve(built, 'evidence/self-modules/current-version.json'), JSON.stringify(report, null, 2));
    await browser.close();
    await harness.close();
}
