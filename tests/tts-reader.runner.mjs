import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 朗读插件：读页面上显示的正文（对白、括号心理、星号动作、做成框的段落都读），跳过状态栏、折叠块、表格、代码和插图；
// 长句切成不超过 60 字的小段；念到的段落标底色；朗读中再点一下停止；设置面板的开关、声音、按卡关掉某类框和预览；
// 输入框上方按钮读最新回复；回复结束自动朗读。
const LONG = '她把书包放在桌上，打开窗户让风吹进来，又把昨天没写完的作业拿出来，一边嘟囔着一边在草稿纸上画着奇怪的小人，直到上课铃响起来才慌慌张张地收好东西。';
const GREETING = [
    '清晨的阳光洒进教室。',
    '“早上好，今天也要加油哦。”她笑着说。',
    '（她心里其实有点紧张。）',
    '*她轻轻推了推眼镜。*',
    '<div style="border:1px solid #ccc;padding:8px">（这段心理活动被做成了框，也要读。）</div>',
    '<details><summary>状态栏</summary>好感度：80/100</details>',
    '<div style="border:1px solid #ccc;padding:4px">好感度：80/100 | 体力：60</div>',
    '| 属性 | 数值 |\n| --- | --- |\n| 力量 | 10 |',
    '```js\nconsole.log("代码不读");\n```',
    'image###1girl, classroom###',
    LONG
].join('\n\n');

const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    // 浏览器的语音换成假的：记下每次要念的句子，念完由测试控制。
    await page.addInitScript(() => {
        const voices = [
            { name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN', localService: true },
            { name: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', lang: 'zh-CN', localService: false },
            { name: 'Google US English', lang: 'en-US', localService: false }
        ];
        const tts = window.__tts = { spoken: [], cancels: 0, current: null };
        window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
        Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
            getVoices: () => voices,
            speak(utterance) { tts.spoken.push({ text: utterance.text, voice: utterance.voice?.name ?? null, rate: utterance.rate }); tts.current = utterance; },
            cancel() { tts.cancels += 1; const utterance = tts.current; tts.current = null; utterance?.onerror?.(); },
            addEventListener() {}, removeEventListener() {}
        } });
        // 在线语音的播放也换成假的：记下播了什么，由测试控制播完。
        const audio = window.__audio = { plays: [], pauses: 0, current: null };
        HTMLMediaElement.prototype.play = function play() {
            audio.plays.push(this.src);
            audio.current = this;
            return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function pause() { audio.pauses += 1; };
        audio.end = async () => {
            for (let idle = 0; idle < 15;) {
                const element = audio.current;
                if (element?.src.startsWith('blob:')) {
                    audio.current = null;
                    idle = 0;
                    element.dispatchEvent(new Event('ended'));
                } else {
                    idle += 1;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        };
        tts.finish = async () => {
            for (let i = 0; i < 500 && tts.current; i += 1) {
                const utterance = tts.current;
                tts.current = null;
                utterance.onend?.();
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        };
    });
    await page.route('**/v1/chat/completions', (route) => route.fulfill({ json: { choices: [{ index: 0, message: { role: 'assistant', content: '这是新的回复。' }, finish_reason: 'stop' }] } }));
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base, greeting }) => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url: base + '/DB/modules/tts-reader.js', enabled: true }]));
        const uuid = 'tts-card';
        const character = { uuid, name: '同桌', description: '朗读验收', first_mes: '你好', worldInfo: [], regexScripts: [], uiTemplates: [] };
        const user = { uuid: 'tts-user', name: '用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: [uuid] }], ['rp_hub_character_' + uuid, character],
            ['rp_hub_chat_' + uuid, [{ id: 'greeting', role: 'assistant', name: character.name, content: greeting }]],
            ['rp_hub_settings', { autoFetchModels: false, apiUrl: base + '/v1', apiKey: 'fixture-key', model: 'fixture-model', stream: false }],
            ['rp_hub_global_worldinfo', []], ['rp_hub_worldinfo', []], ['rp_hub_global_regex', []], ['rp_hub_regex', []],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
    }, { base: harness.url, greeting: GREETING });
    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const readButton = page.locator('[data-chat-index="0"] [data-rph-tts]');
    await readButton.waitFor({ timeout: 45000 });

    const spoken = () => page.evaluate(() => window.__tts.spoken);
    const reset = () => page.evaluate(() => { window.__tts.spoken = []; });
    const finish = () => page.evaluate(() => window.__tts.finish());
    const readAll = async (start) => {
        await reset();
        await start();
        await page.waitForFunction(() => window.__tts.current);
        await finish();
        return (await spoken()).map((item) => item.text);
    };

    // 1. 读什么、跳过什么、怎么切段、用哪个声音
    await reset();
    await readButton.click();
    await page.waitForFunction(() => window.__tts.current);
    assert.equal(await readButton.getAttribute('title'), '停止朗读');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.rph-tts-reading')].map((el) => el.textContent.trim())), ['清晨的阳光洒进教室。'],
        'the paragraph being read is highlighted');
    await finish();
    assert.equal(await page.locator('.rph-tts-reading').count(), 0);
    await page.waitForFunction(() => document.querySelector('[data-chat-index="0"] [data-rph-tts]').title === '朗读');
    const first = await spoken();
    const text = first.map((item) => item.text).join('\n');
    for (const expected of ['清晨的阳光洒进教室。', '“早上好，今天也要加油哦。”她笑着说。', '（她心里其实有点紧张。）', '她轻轻推了推眼镜。', '（这段心理活动被做成了框，也要读。）']) {
        assert.ok(text.includes(expected), `should read ${expected}: ${text}`);
    }
    for (const skipped of ['好感度', '体力', '力量', '代码不读', '状态栏', '1girl', 'classroom', '未生成']) {
        assert.ok(!text.includes(skipped), `should skip ${skipped}: ${text}`);
    }
    assert.ok(first.every((item) => item.text.length <= 60), JSON.stringify(first.map((item) => item.text.length)));
    assert.equal(first.map((item) => item.text).join(''), text.replace(/\n/g, ''), 'nothing is lost when long sentences are split');
    assert.ok(text.replace(/\n/g, '').includes(LONG), 'the long sentence is read in full across several parts');
    assert.ok(first.every((item) => item.voice === 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)'), 'a natural Chinese voice is picked by default');
    console.log('PASS reads the shown text, skips status bars, folded blocks, tables, code and pictures, and splits long sentences');

    // 2. 朗读中再点一下停止
    await reset();
    await readButton.click();
    await page.waitForFunction(() => window.__tts.current);
    const cancels = await page.evaluate(() => window.__tts.cancels);
    await readButton.click();
    assert.equal(await page.evaluate(() => window.__tts.current), null);
    assert.ok(await page.evaluate(() => window.__tts.cancels) > cancels);
    await finish();
    assert.equal((await spoken()).length, 1, 'nothing more is read after stopping');
    assert.equal(await readButton.getAttribute('title'), '朗读');
    console.log('PASS clicking again while reading stops it');

    // 3. 设置面板：只列中文声音、换声音只存在本机、按卡关掉某类框、开关立即生效、预览会读什么
    const openSettings = async () => {
        await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent)?.click());
        await page.locator('[data-rph-workshop-manager-entry]').waitFor({ state: 'attached' });
        await page.evaluate(() => document.querySelector('[data-rph-workshop-manager-entry]').click());
        await page.locator('[data-rph-workshop-launcher] button', { hasText: '朗读设置' }).click();
        await page.locator('[data-rph-workshop-panel] [data-k="engine"]').waitFor();
    };
    const panel = page.locator('[data-rph-workshop-panel]');
    await openSettings();
    assert.deepEqual(await panel.locator('[data-voice] option').evaluateAll((items) => items.map((item) => item.value)),
        ['Microsoft Huihui - Chinese (Simplified, PRC)', 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)']);
    assert.equal(await panel.locator('[data-voice]').inputValue(), 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)');
    await panel.locator('[data-voice]').selectOption('Microsoft Huihui - Chinese (Simplified, PRC)');
    assert.equal(await page.evaluate(() => localStorage.getItem('rph_tts_voice')), 'Microsoft Huihui - Chinese (Simplified, PRC)');
    await panel.locator('[data-preview]').click();
    const previewText = await panel.locator('[data-preview-text]').textContent();
    assert.ok(previewText.includes('清晨的阳光洒进教室。') && !previewText.includes('好感度'), previewText);
    const boxTexts = await panel.locator('[data-boxes] label').allTextContents();
    assert.ok(boxTexts.some((item) => item.includes('这段心理活动')), JSON.stringify(boxTexts));
    assert.ok(!boxTexts.some((item) => item.includes('好感度')), 'status bars are skipped anyway and not listed');
    await panel.locator('[data-boxes] label', { hasText: '这段心理活动' }).click();
    const skippedBoxes = () => page.evaluate(() => JSON.parse(localStorage.getItem('rph_mod_tts-reader::skip:tts-card') || '[]'));
    assert.deepEqual((await skippedBoxes()).map((box) => box.sample), ['（这段心理活动被做成了框，也要读。）']);
    await page.keyboard.press('Escape');
    let said = (await readAll(() => readButton.click())).join('\n');
    assert.ok(said.includes('清晨的阳光洒进教室。') && !said.includes('这段心理活动'), said);
    await openSettings();
    await panel.locator('[data-boxes] label', { hasText: '这段心理活动' }).click();
    assert.deepEqual(await skippedBoxes(), [], 'a box turned off can be turned back on');
    await panel.locator('label', { has: page.locator('[data-k="onlyQuotes"]') }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('rph_mod_tts-reader::onlyQuotes')), '1');
    await page.keyboard.press('Escape');
    said = await readAll(() => readButton.click());
    assert.deepEqual(said, ['“早上好，今天也要加油哦。”']);
    assert.equal((await spoken())[0].voice, 'Microsoft Huihui - Chinese (Simplified, PRC)');
    await openSettings();
    await panel.locator('label', { has: page.locator('[data-k="onlyQuotes"]') }).click();
    await panel.locator('label', { has: page.locator('[data-k="skipParens"]') }).click();
    await panel.locator('label', { has: page.locator('[data-k="skipActions"]') }).click();
    await page.keyboard.press('Escape');
    said = (await readAll(() => readButton.click())).join('\n');
    assert.ok(said.includes('清晨的阳光洒进教室。') && said.includes('早上好'), said);
    assert.ok(!said.includes('紧张') && !said.includes('心理活动') && !said.includes('眼镜'), said);
    console.log('PASS the settings panel lists Chinese voices, keeps the voice on this device, turns box kinds off per card and its switches apply at once');

    // 4. 输入框上方的按钮读最新回复；回复结束后自动朗读，新回复开始时停掉正在读的
    await openSettings();
    for (const key of ['skipParens', 'skipActions', 'autoRead']) await panel.locator('label', { has: page.locator(`[data-k="${key}"]`) }).click();
    await page.keyboard.press('Escape');
    said = await readAll(() => page.locator('[data-rph-workshop-composer-button="tts-reader"]').click());
    assert.equal(said[0], '清晨的阳光洒进教室。');
    await reset();
    await readButton.click();
    await page.waitForFunction(() => window.__tts.current);
    const before = await page.evaluate(() => window.__tts.cancels);
    await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__;
        const vm = (app._instance || app._container._vnode.component).proxy;
        vm.userInput = '你好';
        await vm.sendMessage();
    });
    await page.waitForFunction(() => window.__tts.spoken.some((item) => item.text === '这是新的回复。'), null, { timeout: 15000 });
    assert.ok(await page.evaluate(() => window.__tts.cancels) > before, 'the reading in progress stops when a new reply starts');
    await finish();
    assert.equal((await spoken()).filter((item) => item.text === '这是新的回复。').length, 1);
    console.log('PASS the composer button reads the latest reply and new replies are read once they finish');

    // 5. 在线语音接口（按 Fish Audio 填）：请求格式、对白和旁白分开用声音、边播边生成下一段、重听不再请求、停止、报错提示
    const ttsRequests = [];
    // 接口回一段 0.1 秒的静音 WAV：浏览器能正常加载，不会当成坏音频报错。
    const wav = Buffer.alloc(44 + 1600);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + 1600, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(1600, 40);
    await page.route('**/compat/v1/audio/speech', (route) => {
        const request = route.request();
        const body = request.postDataJSON();
        ttsRequests.push({ ...body, auth: request.headers().authorization });
        const headers = { 'access-control-allow-origin': '*' };
        if (body.voice === 'bad-voice') return route.fulfill({ status: 401, headers, json: { message: 'invalid api key' } });
        return route.fulfill({ headers, contentType: 'audio/wav', body: wav });
    });
    await openSettings();
    await panel.locator('[data-k="engine"]').selectOption('online');
    assert.equal(await panel.locator('[data-voice]').isVisible(), false, 'browser voices are hidden for the online engine');
    await panel.locator('[data-preset]').selectOption('fish');
    assert.equal(await panel.locator('[data-k="apiUrl"]').inputValue(), 'https://api.fish.audio/compat/v1');
    assert.equal(await panel.locator('[data-k="model"]').inputValue(), 'fish-audio/s2.1-pro');
    await panel.locator('[data-k="apiKey"]').fill('test-key');
    await panel.locator('[data-k="voice"]').fill('narrator-id');
    await panel.locator('[data-card-voice]').fill('card-id');
    await panel.locator('label', { has: page.locator('[data-k="splitVoices"]') }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('rph_mod_tts-reader::voice:tts-card')), 'card-id');
    await page.keyboard.press('Escape');

    const blobPlays = () => page.evaluate(() => window.__audio.plays.filter((src) => src.startsWith('blob:')).length);
    const playingBlob = () => page.waitForFunction(() => window.__audio.current?.src.startsWith('blob:'));
    const idle = () => page.waitForFunction(() => document.querySelector('[data-chat-index="0"] [data-rph-tts]').title === '朗读');
    await readButton.click();
    await playingBlob();
    for (let i = 0; i < 50 && ttsRequests.length < 2; i += 1) await page.waitForTimeout(20);
    assert.equal(ttsRequests.length, 2, 'the next part is requested while the first one plays');
    assert.deepEqual(ttsRequests[0], { model: 'fish-audio/s2.1-pro', input: '清晨的阳光洒进教室。', voice: 'narrator-id', response_format: 'mp3', speed: 1, auth: 'Bearer test-key' });
    assert.equal(await page.locator('.rph-tts-reading').count(), 1);
    await page.evaluate(() => window.__audio.end());
    await idle();
    const voiceOf = Object.fromEntries(ttsRequests.map((item) => [item.input, item.voice]));
    assert.equal(voiceOf['“早上好，今天也要加油哦。”'], 'card-id', 'dialogue uses the card voice');
    assert.equal(voiceOf['她笑着说。'], 'narrator-id', 'narration uses the default voice');
    assert.ok(!ttsRequests.some((item) => /好感度|代码不读|1girl/.test(item.input)), JSON.stringify(ttsRequests.map((item) => item.input)));
    assert.ok(ttsRequests.every((item) => item.input.length <= 200));
    const played = await blobPlays();
    assert.equal(played, ttsRequests.length, 'every part is played once');

    const requested = ttsRequests.length;
    await readButton.click();
    await playingBlob();
    await page.evaluate(() => window.__audio.end());
    await idle();
    assert.equal(ttsRequests.length, requested, 'reading the same reply again uses the audio already made');
    assert.equal(await blobPlays(), played * 2);

    await readButton.click();
    await playingBlob();
    const pauses = await page.evaluate(() => window.__audio.pauses);
    const playsBeforeStop = await blobPlays();
    await readButton.click();
    assert.ok(await page.evaluate(() => window.__audio.pauses) > pauses);
    await page.evaluate(() => window.__audio.end());
    assert.equal(await blobPlays(), playsBeforeStop, 'nothing more plays after stopping');
    assert.equal(await readButton.getAttribute('title'), '朗读');

    await openSettings();
    await panel.locator('[data-card-voice]').fill('bad-voice');
    await page.keyboard.press('Escape');
    await readButton.click();
    await playingBlob();
    await page.evaluate(() => window.__audio.end());
    await page.locator('.toast-item', { hasText: '语音接口报错（401，密钥不对）：invalid api key' }).waitFor();
    await idle();
    console.log('PASS the online engine sends OpenAI-style requests, splits dialogue and narration voices, prefetches, reuses audio, stops and shows API errors');
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await harness.close();
}
