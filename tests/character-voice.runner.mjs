import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 角色语音插件：配音表（AI 按资料挑、自己搜）、AI 分析每句是谁说的和语气、只念人物的台词（旁白不念，用户扮演的默认不念）、
// 新人物自动加进配音表、边播边生成下一段、重听不再分析也不再生成、回复结束自动说、分析失败按引号当成角色卡本人、密钥错了有提示。
const LONG = '她把书包放在桌上，打开窗户让风吹进来，又把昨天没写完的作业拿出来，一边嘟囔着一边在草稿纸上画着奇怪的小人，直到上课铃响起来才慌慌张张地收好东西。';
const GREETING = [
    '清晨的阳光洒进教室。',
    '“早上好，今天也要加油哦。”她笑着说。',
    '（她心里其实有点紧张。）',
    '*她轻轻推了推眼镜。*',
    '<div style="border:1px solid #ccc;padding:4px">好感度：80/100 | 体力：60</div>',
    'image###1girl, classroom###',
    LONG
].join('\n\n');
const library = {
    'girl-gentle': { _id: 'girl-gentle', title: '温柔少女', tags: ['female', 'young', 'gentle', 'soft'], task_count: 100, samples: [{ audio: 'https://example.test/girl.mp3' }] },
    'girl-energetic': { _id: 'girl-energetic', title: '元气少女', tags: ['female', 'young', 'energetic'], task_count: 5000, samples: [] },
    'woman-calm': { _id: 'woman-calm', title: '成熟女声', tags: ['female', 'middle-aged', 'calm'], task_count: 99999, samples: [] },
    'uncle-deep': { _id: 'uncle-deep', title: '大叔', tags: ['male', 'middle-aged', 'deep'], task_count: 300, samples: [{ audio: 'https://example.test/uncle.mp3' }] }
};
// Fish 回一段 0.1 秒的静音 WAV：浏览器能正常加载，不会当成坏音频报错。
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
const cors = { 'access-control-allow-origin': '*' };
const reply = (content) => ({ json: { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] } });

const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    // 播放换成假的：记下播了什么，由测试控制播完。
    await page.addInitScript(() => {
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
    });
    await page.route('https://api.fish.audio/model?**', (route) => {
        const title = new URL(route.request().url()).searchParams.get('title') || '';
        const ids = title === '少女' ? ['girl-energetic', 'girl-gentle'] : title === '大叔' ? ['uncle-deep'] : title ? [] : ['woman-calm', 'girl-energetic'];
        return route.fulfill({ headers: cors, json: { total: ids.length, items: ids.map((id) => library[id]) } });
    });
    const aiRequests = [];
    let analysisFails = false;
    await page.route('**/v1/chat/completions', (route) => {
        const body = route.request().postDataJSON();
        const system = String(body.messages?.[0]?.content || '');
        if (system.includes('配音选角')) {
            aiRequests.push({ kind: 'pick', body });
            return route.fulfill(reply('```json\n{"gender":"female","age":"young","tags":["gentle","soft"],"keywords":["少女"],"reason":"温柔的同桌"}\n```'));
        }
        if (system.includes('配音导演')) {
            aiRequests.push({ kind: 'analyze', body });
            if (analysisFails) return route.fulfill({ status: 500, json: { error: { message: 'analysis is down' } } });
            return route.fulfill(reply(JSON.stringify([[1, '旁白', 'calm narration'], [2, '同桌', 'cheerful'], [3, '旁白', 'calm narration'],
                [4, '同桌', 'nervous inner voice'], [5, '用户', 'shy'], [6, '班长', 'annoyed']])));
        }
        return route.fulfill(reply('“你来了。”他抬起头。'));
    });
    const ttsRequests = [];
    await page.route('https://api.fish.audio/compat/v1/audio/speech', (route) => {
        const request = route.request();
        ttsRequests.push({ ...request.postDataJSON(), auth: request.headers().authorization });
        if (request.headers().authorization === 'Bearer bad-key') return route.fulfill({ status: 401, headers: cors, json: { error: { code: 401, message: 'Invalid Token' } } });
        return route.fulfill({ headers: cors, contentType: 'audio/wav', body: wav });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base, greeting }) => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url: base + '/DB/modules/character-voice.js', enabled: true }]));
        const uuid = 'voice-card';
        const character = { uuid, name: '同桌', description: '安静的同桌女生', first_mes: '你好', worldInfo: [
            { keys: ['班长'], comment: '班长', content: '班长是个严厉的中年男老师' }
        ], regexScripts: [], uiTemplates: [] };
        const user = { uuid: 'voice-user', name: '用户', person: 'second' };
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
    const voiceButton = (index) => page.locator(`[data-chat-index="${index}"] [data-rph-voice]`);
    await voiceButton(0).waitFor({ timeout: 45000 });
    const panel = page.locator('[data-rph-workshop-panel]');
    const openSettings = async () => {
        await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent)?.click());
        await page.locator('[data-rph-workshop-manager-entry]').waitFor({ state: 'attached' });
        await page.evaluate(() => document.querySelector('[data-rph-workshop-manager-entry]').click());
        await page.locator('[data-rph-workshop-launcher] button', { hasText: '角色语音设置' }).click();
        await panel.locator('[data-k="fishKey"]').waitFor();
    };
    const cast = () => page.evaluate(() => JSON.parse(localStorage.getItem('rph_mod_character-voice::cast:voice-card') || '[]'));
    const blobPlays = () => page.evaluate(() => window.__audio.plays.filter((src) => src.startsWith('blob:')).length);
    const playingBlob = () => page.waitForFunction(() => window.__audio.current?.src.startsWith('blob:'));
    const idle = (index) => page.waitForFunction((i) => document.querySelector(`[data-chat-index="${i}"] [data-rph-voice]`)?.title === '角色语音', index);

    // 1. 配音表：只列人物（没有旁白）；AI 按角色卡资料给「同桌」挑，排第一的自动选上；自己加「班长」，搜「大叔」选上
    await openSettings();
    await panel.locator('[data-k="fishKey"]').fill('test-key');
    assert.equal(await panel.locator('[data-k="fishModel"]').inputValue(), 'fish-audio/s2.1-pro-free', 'the free model is the default');
    assert.deepEqual(await panel.locator('[data-cast] [data-person]').evaluateAll((rows) => rows.map((row) => row.dataset.person)), ['同桌']);
    await panel.locator('[data-person="同桌"]').getByRole('button', { name: 'AI 挑' }).click();
    await panel.locator('[data-pick="同桌"] [data-voice-id="girl-gentle"]').waitFor();
    assert.deepEqual(await panel.locator('[data-pick="同桌"] [data-voice-id]').evaluateAll((rows) => rows.map((row) => row.dataset.voiceId)),
        ['girl-gentle', 'girl-energetic', 'woman-calm']);
    const pick = aiRequests.find((item) => item.kind === 'pick').body;
    assert.ok(pick.messages[1].content.includes('人物：同桌') && pick.messages[1].content.includes('安静的同桌女生'), pick.messages[1].content);
    await panel.locator('[data-new-person]').fill('班长');
    await panel.locator('[data-add-person]').click();
    await panel.locator('[data-person="班长"]').getByRole('button', { name: '搜索' }).click();
    await panel.locator('[data-pick="班长"] input').fill('大叔');
    await panel.locator('[data-pick="班长"] input').press('Enter');
    await panel.locator('[data-pick="班长"] [data-voice-id="uncle-deep"]').getByRole('button', { name: '用这个' }).click();
    assert.deepEqual(await cast(), [
        { name: '同桌', id: 'girl-gentle', title: '温柔少女', sample: 'https://example.test/girl.mp3' },
        { name: '班长', id: 'uncle-deep', title: '大叔', sample: 'https://example.test/uncle.mp3' }
    ]);
    await page.keyboard.press('Escape');
    console.log('PASS the cast lists people only; AI picks a voice from the card and the library, and a voice can be searched and chosen');

    // 2. 只念人物的台词：旁白、状态栏、插图不念，用户扮演的默认不念；带语气；边播边生成下一段
    await voiceButton(0).click();
    await playingBlob();
    for (let i = 0; i < 50 && ttsRequests.length < 2; i += 1) await page.waitForTimeout(20);
    assert.equal(ttsRequests.length, 2, 'the next line is requested while the first one plays');
    assert.deepEqual(ttsRequests[0], { model: 'fish-audio/s2.1-pro-free', input: '[cheerful] “早上好，今天也要加油哦。”', voice: 'girl-gentle', response_format: 'mp3', auth: 'Bearer test-key' });
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.rph-voice-speaking')].map((el) => el.textContent.trim())), ['“早上好，今天也要加油哦。”她笑着说。']);
    await page.evaluate(() => window.__audio.end());
    await idle(0);
    const analysis = aiRequests.filter((item) => item.kind === 'analyze');
    assert.equal(analysis.length, 1);
    assert.ok(analysis[0].body.messages[1].content.includes('已知人物：同桌、班长；用户扮演：用户'), analysis[0].body.messages[1].content);
    assert.ok(!analysis[0].body.messages[1].content.includes('好感度') && !analysis[0].body.messages[1].content.includes('1girl'));
    assert.deepEqual(ttsRequests.map((item) => [item.voice, item.input]), [
        ['girl-gentle', '[cheerful] “早上好，今天也要加油哦。”'],
        ['girl-gentle', '[nervous inner voice] （她心里其实有点紧张。）'],
        ['uncle-deep', `[annoyed] ${LONG}`]
    ], 'only lines spoken by people are voiced, each with its speaker and tone');
    assert.equal(await blobPlays(), 3);
    assert.deepEqual((await cast()).map((person) => person.name), ['同桌', '班长'], 'the user is not added to the cast');
    console.log('PASS only lines spoken by people are voiced with their own voice and tone; narration and the user are skipped');

    // 3. 重听：不再分析，也不再向 Fish 要语音；打开「用户的台词也念」后才念用户的那句
    await voiceButton(0).click();
    await playingBlob();
    await page.evaluate(() => window.__audio.end());
    await idle(0);
    assert.equal(aiRequests.filter((item) => item.kind === 'analyze').length, 1, 'the analysis is reused');
    assert.equal(ttsRequests.length, 3, 'the audio is reused');
    await page.evaluate(() => localStorage.setItem('rph_mod_character-voice::userLines', '1'));
    await voiceButton(0).click();
    await playingBlob();
    await page.evaluate(() => window.__audio.end());
    await idle(0);
    assert.deepEqual(ttsRequests.slice(3).map((item) => [item.voice, item.input]), [['', '[shy] 她轻轻推了推眼镜。']]);
    console.log('PASS replays reuse the analysis and the audio; the user lines are voiced only when turned on');

    // 4. 回复结束自动说；分析失败时提示，并把引号里的话当成角色卡本人说的
    await page.evaluate(() => localStorage.setItem('rph_mod_character-voice::autoPlay', '1'));
    analysisFails = true;
    await page.evaluate(async () => {
        const app = document.querySelector('#app').__vue_app__;
        const vm = (app._instance || app._container._vnode.component).proxy;
        vm.userInput = '你好';
        await vm.sendMessage();
    });
    await page.locator('.toast-item', { hasText: '分析说话人失败' }).waitFor({ timeout: 15000 });
    await playingBlob();
    await page.evaluate(() => window.__audio.end());
    await idle(2);
    assert.deepEqual(ttsRequests.slice(4).map((item) => [item.voice, item.input]), [['girl-gentle', '“你来了。”']]);
    console.log('PASS new replies are voiced when they finish; a failed analysis falls back to quotes as the card character');

    // 5. 密钥错了：Fish 的 401 带上中文说明
    await page.evaluate(() => localStorage.setItem('rph_mod_character-voice::fishKey', 'bad-key'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await voiceButton(2).waitFor({ timeout: 45000 });
    await voiceButton(2).click();
    await page.locator('.toast-item', { hasText: 'Fish 报错（401，密钥不对）：Invalid Token' }).waitFor();
    await idle(2);
    console.log('PASS a wrong key shows the Fish error with a plain hint');
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await harness.close();
}
