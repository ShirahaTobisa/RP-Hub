import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 角色语音插件：配音表（AI 按资料挑、自己搜）；状态悬浮窗（点「分析」只分析、显示谁说了几句、正在说谁、能收起和拖动并记住位置）；
// 只念人物的台词（旁白不念，用户扮演的默认不念），带语气；边播边生成下一段；重听不再分析也不再生成；
// 自动分析模式只分析不出声；自动说时分析失败，引号里的话用默认声音；密钥错了有提示。分析用的模型从站点的模型列表里选，配音表不放卡名。
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
const LONG_TEXT = LONG;
const REPLIES = ['“你来了。”他抬起头。', '“快坐下。”她小声说。'];
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
        const audio = window.__audio = { plays: [], times: [], ended: [], pauses: 0, current: null };
        HTMLMediaElement.prototype.play = function play() {
            audio.plays.push(this.src);
            if (this.src.startsWith('blob:')) audio.times.push(performance.now());
            audio.current = this;
            return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function pause() { audio.pauses += 1; };
        audio.end = async () => {
            for (let idle = 0; idle < 60;) {
                const element = audio.current;
                if (element?.src.startsWith('blob:')) {
                    audio.current = null;
                    idle = 0;
                    audio.ended.push(performance.now());
                    element.dispatchEvent(new Event('ended'));
                } else {
                    idle += 1;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        };
    });
    await page.route('https://api.fish.audio/model?**', (route) => {
        const url = new URL(route.request().url());
        const title = url.searchParams.get('title') || '';
        if (title === '少年') {
            const page = Number(url.searchParams.get('page_number'));
            const items = Array.from({ length: page === 1 ? 20 : 5 }, (_, i) => ({ _id: `boy-${page}-${i}`, title: `少年${page}-${i}`, tags: ['male', 'young'], samples: [] }));
            return route.fulfill({ headers: cors, json: { total: 25, items } });
        }
        const ids = title === '少女' ? ['girl-energetic', 'girl-gentle'] : title === '大叔' ? ['uncle-deep'] : title ? [] : ['woman-calm', 'girl-energetic'];
        return route.fulfill({ headers: cors, json: { total: ids.length, items: ids.map((id) => library[id]) } });
    });
    await page.route('**/v1/models', (route) => route.fulfill({ json: { data: [{ id: 'fixture-model' }, { id: 'analysis-model' }, { id: 'text-embedding-3-small' }] } }));
    const aiRequests = [];
    let analysisFails = false;
    let replies = 0;
    await page.route('**/v1/chat/completions', (route) => {
        const body = route.request().postDataJSON();
        const system = String(body.messages?.[0]?.content || '');
        const user = String(body.messages?.at(-1)?.content || '');
        if (system.includes('配音选角')) {
            aiRequests.push({ kind: 'pick', body });
            return route.fulfill(reply('```json\n{"gender":"female","age":"young","tags":["gentle","soft"],"keywords":["少女"],"reason":"温柔的同桌"}\n```'));
        }
        if (system.includes('配音导演')) {
            aiRequests.push({ kind: 'analyze', body });
            if (analysisFails) return route.fulfill({ status: 500, json: { error: { message: 'analysis is down' } } });
            if (user.includes('你来了')) return route.fulfill(reply(JSON.stringify([[1, '班长', 'cold', 0.3], [2, '旁白', 'calm narration', 0]])));
            return route.fulfill(reply(JSON.stringify([[1, '旁白', 'calm narration', 0], [2, '同桌', 'cheerful', 0.2], [3, '旁白', 'calm narration', 0],
                [4, '同桌', 'nervous inner voice', 0.4], [5, '用户', 'shy', 0.2], [6, '班长', 'annoyed', 0]])));
        }
        return route.fulfill(reply(REPLIES[replies++]));
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
    // 设置是导航菜单里单独的「角色语音」页面（插件接口 8），不在「模块管理」里。
    const panel = page.locator('[data-rph-workshop-page="character-voice"]');
    const openSettings = async () => {
        await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent)?.click());
        await page.locator('#app-navigation-panel [data-rph-workshop-page-entry="character-voice"]').waitFor({ state: 'attached' });
        await page.evaluate(() => document.querySelector('[data-rph-workshop-page-entry="character-voice"]').click());
        await panel.locator('[data-k="fishKey"]').waitFor();
    };
    const backToChat = () => page.evaluate(() => {
        const app = document.querySelector('#app').__vue_app__;
        (app._instance || app._container._vnode.component).proxy.currentView = 'chat';
    });
    const widget = page.locator('[data-rph-voice-widget]');
    const widgetStatus = () => widget.locator('[data-status]').textContent();
    const statusIs = (text) => page.waitForFunction((value) => document.querySelector('[data-rph-voice-widget] [data-status]')?.textContent.startsWith(value), text, { timeout: 15000 });
    const cast = () => page.evaluate(() => JSON.parse(localStorage.getItem('rph_mod_character-voice::cast:voice-card') || '[]'));
    const analysisCount = () => aiRequests.filter((item) => item.kind === 'analyze').length;
    const blobPlays = () => page.evaluate(() => window.__audio.plays.filter((src) => src.startsWith('blob:')).length);
    const playingBlob = () => page.waitForFunction(() => window.__audio.current?.src.startsWith('blob:'));
    const idle = (index) => page.waitForFunction((i) => document.querySelector(`[data-chat-index="${i}"] [data-rph-voice]`)?.title === '角色语音', index);
    const send = (text) => page.evaluate(async (value) => {
        const app = document.querySelector('#app').__vue_app__;
        const vm = (app._instance || app._container._vnode.component).proxy;
        vm.userInput = value;
        await vm.sendMessage();
    }, text);

    // 1. 配音表：只列人物（没有旁白）；AI 按角色卡资料给「同桌」挑，排第一的自动选上；自己加「班长」，搜「大叔」选上
    await openSettings();
    assert.equal((await panel.locator('.settings-page-header h2').textContent()).trim(), '角色语音');
    assert.equal(await panel.locator('[data-card-name]').textContent(), '当前角色卡：同桌');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.chat-view-root')).display), 'none', 'the page takes the main area');
    await panel.locator('[data-k="fishKey"]').fill('test-key');
    assert.equal(await panel.locator('input[type="password"]').count(), 0, 'no password field, so the browser does not offer to save the key as the site password');
    assert.equal(await panel.locator('select:visible').count(), 0, 'every dropdown is the RPH dropdown, not the browser one');
    const dropdown = (key) => panel.locator(`[data-k="${key}"] + div button[aria-haspopup="listbox"]`);
    assert.equal((await dropdown('fishModel').textContent()).trim(), 'S2.1 Pro 免费版');
    assert.equal(await panel.locator('[data-k="fishModel"]').inputValue(), 'fish-audio/s2.1-pro-free', 'the free model is the default');
    assert.equal(await panel.locator('[data-k="analyzeMode"]').inputValue(), 'click', 'analysis waits for a click by default');
    await panel.locator('[data-models-note]', { hasText: '共 2 个模型' }).waitFor();
    assert.deepEqual(await panel.locator('[data-k="analysisModel"] option').evaluateAll((items) => items.map((item) => item.value)), ['', 'fixture-model', 'analysis-model'],
        'models come from the site AI, without embedding models');
    await dropdown('analysisModel').click();
    await page.getByRole('option', { name: 'analysis-model', exact: true }).click();
    assert.equal((await dropdown('analysisModel').textContent()).trim(), 'analysis-model');
    assert.equal(await page.evaluate(() => localStorage.getItem('rph_mod_character-voice::analysisModel')), 'analysis-model');
    assert.equal(await panel.locator('[data-cast] [data-person]').count(), 0, 'the card name is not put into the cast');
    assert.equal(await panel.locator('[data-cast]').textContent(), '还没有人物。');
    await panel.locator('[data-new-person]').fill('同桌');
    await panel.locator('[data-add-person]').click();
    await panel.locator('[data-person="同桌"]').getByRole('button', { name: 'AI 挑' }).click();
    await panel.locator('[data-pick="同桌"] [data-voice-id="girl-gentle"]').waitFor();
    assert.deepEqual(await panel.locator('[data-pick="同桌"] [data-voice-id]').evaluateAll((rows) => rows.map((row) => row.dataset.voiceId)),
        ['girl-gentle', 'girl-energetic', 'woman-calm']);
    const pick = aiRequests.find((item) => item.kind === 'pick').body;
    assert.ok(pick.messages[1].content.includes('人物：同桌') && pick.messages[1].content.includes('安静的同桌女生'), pick.messages[1].content);
    assert.equal(pick.model, 'analysis-model', 'the chosen model is used');
    await panel.locator('[data-new-person]').fill('班长');
    await panel.locator('[data-add-person]').click();
    await panel.locator('[data-person="班长"]').getByRole('button', { name: '搜索' }).click();
    await panel.locator('[data-pick="班长"] input').fill('少年');
    await panel.locator('[data-pick="班长"] input').press('Enter');
    await panel.locator('[data-pick="班长"]', { hasText: '一共 25 个声音' }).waitFor();
    assert.equal(await panel.locator('[data-pick="班长"] [data-voice-id]').count(), 20);
    await panel.locator('[data-pick="班长"]').getByRole('button', { name: '加载更多' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-pick="班长"] [data-voice-id]').length === 25);
    assert.equal(await panel.locator('[data-pick="班长"]').getByRole('button', { name: '加载更多' }).count(), 0);
    await panel.locator('[data-pick="班长"] input').fill('大叔');
    await panel.locator('[data-pick="班长"] input').press('Enter');
    await panel.locator('[data-pick="班长"] [data-voice-id="uncle-deep"]').getByRole('button', { name: '用这个' }).click();
    assert.deepEqual(await cast(), [
        { name: '同桌', id: 'girl-gentle', title: '温柔少女', sample: 'https://example.test/girl.mp3' },
        { name: '班长', id: 'uncle-deep', title: '大叔', sample: 'https://example.test/uncle.mp3' }
    ]);
    await backToChat();
    await panel.waitFor({ state: 'detached' });
    assert.equal(analysisCount(), 0, 'nothing is analysed until asked');
    assert.equal(await page.locator('[data-rph-workshop-composer-button="character-voice"]').count(), 0, 'no text button above the input box; the floating window does that job');
    console.log('PASS models are picked from the site list; the cast starts empty; AI picks a voice, and the library search pages through results');

    // 2. 悬浮窗：没分析时这么写；点「分析」只分析、不出声，显示谁说了几句（用户扮演的不算）
    await widget.waitFor();
    assert.equal(await widgetStatus(), '最新回复还没分析');
    await widget.locator('[data-analyze]').click();
    await statusIs('最新回复：');
    assert.equal(await widgetStatus(), '最新回复：同桌 2 句 · 班长 1 句');
    assert.equal(await widget.locator('[data-analyze]').textContent(), '重新分析');
    assert.equal(analysisCount(), 1);
    assert.equal(ttsRequests.length, 0, 'analysing alone makes no audio');
    assert.equal(aiRequests.find((item) => item.kind === 'analyze').body.model, 'analysis-model');
    const analysis = aiRequests.find((item) => item.kind === 'analyze').body.messages[1].content;
    assert.ok(analysis.includes('已知人物：同桌、班长；用户扮演：用户') && analysis.includes('2. “早上好，今天也要加油哦。”'), analysis);
    assert.ok(!analysis.includes('好感度') && !analysis.includes('1girl'), analysis);
    assert.deepEqual(await page.evaluate(() => [...CSS.highlights.get('rph-voice-line')].map((range) => range.toString())),
        ['“早上好，今天也要加油哦。”', '（她心里其实有点紧张。）', LONG_TEXT], 'the lines spoken by people are underlined');
    console.log('PASS the floating window analyses on click without speaking and shows who speaks how many lines');

    // 3. 播放：用存下的分析，只念人物的台词，带语气；边播边生成下一段；悬浮窗显示正在说谁
    await voiceButton(0).click();
    await playingBlob();
    for (let i = 0; i < 50 && ttsRequests.length < 2; i += 1) await page.waitForTimeout(20);
    assert.equal(ttsRequests.length, 2, 'the next line is requested while the first one plays');
    assert.deepEqual(ttsRequests[0], { model: 'fish-audio/s2.1-pro-free', input: '[cheerful] “早上好，今天也要加油哦。”', voice: 'girl-gentle', response_format: 'mp3', auth: 'Bearer test-key' });
    assert.deepEqual(await page.evaluate(() => [...CSS.highlights.get('rph-voice-now')].map((range) => range.toString())), ['“早上好，今天也要加油哦。”'],
        'only the line being spoken is highlighted');
    assert.equal(await widgetStatus(), '正在说：同桌');
    assert.equal(await widget.locator('[data-play]').textContent(), '停止');
    await page.evaluate(() => window.__audio.end());
    await idle(0);
    assert.equal(analysisCount(), 1, 'the saved analysis is used');
    assert.deepEqual(ttsRequests.map((item) => [item.voice, item.input]), [
        ['girl-gentle', '[cheerful] “早上好，今天也要加油哦。”'],
        ['girl-gentle', '[nervous inner voice] （她心里其实有点紧张。）'],
        ['uncle-deep', `[annoyed] ${LONG}`]
    ], 'only lines spoken by people are voiced, each with its speaker and tone');
    assert.equal(await blobPlays(), 3);
    const timing = await page.evaluate(() => ({ times: window.__audio.times.slice(-3), ended: window.__audio.ended.slice(-3) }));
    assert.ok(timing.times[1] - timing.ended[0] >= 180, `pause after the first line: ${timing.times[1] - timing.ended[0]}ms`);
    assert.ok(timing.times[2] - timing.ended[1] >= 380, `pause after the second line: ${timing.times[2] - timing.ended[1]}ms`);
    assert.equal(await widgetStatus(), '最新回复：同桌 2 句 · 班长 1 句');
    assert.deepEqual((await cast()).map((person) => person.name), ['同桌', '班长'], 'the user is not added to the cast');
    console.log('PASS playing uses the saved analysis, voices only people with their own voice and tone, pauses as the AI paced it, and shows who is speaking');

    // 3b. 点一句台词：小卡片写着谁说的、AI 分析的语气；「播放这句」只播这一句，「从这句开始」播到最后
    // 点在台词旁边的空白处（「（她心里其实有点紧张。）」独占一段，点这段右边没字的地方）不弹
    const blank = await page.evaluate(() => {
        const range = [...CSS.highlights.get('rph-voice-line')][1];
        const paragraph = range.startContainer.parentElement;
        paragraph.scrollIntoView({ block: 'center' });
        const rect = range.getClientRects()[0];
        return { x: paragraph.getBoundingClientRect().right - 10, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(blank.x, blank.y);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-rph-voice-pop]').count(), 0, 'clicking the blank space beside a line does not open the card');
    const clickLine = async (n) => {
        const point = await page.evaluate((i) => {
            const range = [...CSS.highlights.get('rph-voice-line')][i];
            range.startContainer.parentElement.scrollIntoView({ block: 'center' });
            const rect = range.getClientRects()[0];
            return { x: rect.left + 6, y: rect.top + rect.height / 2 };
        }, n);
        await page.mouse.click(point.x, point.y);
        await page.locator('[data-rph-voice-pop]').waitFor();
    };
    await clickLine(0);
    assert.equal(await page.locator('[data-rph-voice-pop] strong').textContent(), '同桌');
    assert.equal(await page.locator('[data-rph-voice-pop] .rph-voice-pop__tone').textContent(), 'AI 分析的语气：cheerful');
    let before = await blobPlays();
    await page.locator('[data-rph-voice-pop] [data-one]').click();
    await playingBlob();
    await page.evaluate(() => window.__audio.end());
    await idle(0);
    assert.equal(await blobPlays(), before + 1, 'only this line is played');
    await clickLine(1);
    before = await blobPlays();
    await page.locator('[data-rph-voice-pop] [data-from]').click();
    await playingBlob();
    await page.evaluate(() => window.__audio.end());
    await idle(0);
    assert.equal(await blobPlays(), before + 2, 'this line and the ones after it are played');
    assert.equal(ttsRequests.length, 3, 'the audio made before is reused');
    await page.mouse.click(5, 5);
    assert.equal(await page.locator('[data-rph-voice-pop]').count(), 0, 'clicking elsewhere closes the card');
    console.log('PASS a clicked line shows its speaker and AI tone, and can be played alone or from there on');

    // 4. 重听不再生成；打开「用户的台词也念」后才念用户的那句；悬浮窗的播放按钮能停
    await widget.locator('[data-play]').click();
    await playingBlob();
    await widget.locator('[data-play]').click();
    assert.equal(await widget.locator('[data-play]').textContent(), '播放');
    await page.evaluate(() => window.__audio.end());
    assert.equal(ttsRequests.length, 3, 'the audio is reused');
    await page.evaluate(() => localStorage.setItem('rph_mod_character-voice::userLines', '1'));
    await voiceButton(0).click();
    await playingBlob();
    await page.evaluate(() => window.__audio.end());
    await idle(0);
    assert.deepEqual(ttsRequests.slice(3).map((item) => [item.voice, item.input]), [['', '[shy] 她轻轻推了推眼镜。']]);
    console.log('PASS replays reuse the audio, the play button stops, and user lines are voiced only when turned on');

    // 5. 悬浮窗能收起成小圆点、再展开；拖动后位置记在这台设备上
    await widget.locator('[data-collapse]').click();
    assert.ok(await widget.evaluate((el) => el.classList.contains('is-folded')));
    await widget.locator('[data-expand]').click();
    assert.ok(!(await widget.evaluate((el) => el.classList.contains('is-folded'))));
    const head = await widget.locator('[data-drag]').boundingBox();
    await page.mouse.move(head.x + 20, head.y + 8);
    await page.mouse.down();
    await page.mouse.move(head.x - 180, head.y - 220, { steps: 6 });
    await page.mouse.up();
    const position = await page.evaluate(() => JSON.parse(localStorage.getItem('rph_voice_widget')));
    assert.ok(position.x < head.x - 100 && position.y < head.y - 100 && position.folded === false, JSON.stringify(position));
    await widget.locator('[data-settings]').click();
    await panel.locator('[data-k="fishKey"]').waitFor();
    await backToChat();
    await panel.waitFor({ state: 'detached' });
    console.log('PASS the floating window folds into a dot, opens again, remembers where it was dragged, and its gear opens the settings page');

    // 6. 自动分析：回复结束只分析、不出声；自动说：分析失败时提示，并把引号里的话当成角色卡本人说的
    await page.evaluate(() => localStorage.setItem('rph_mod_character-voice::analyzeMode', 'auto'));
    await send('你好');
    await statusIs('最新回复：班长 1 句');
    assert.equal(ttsRequests.length, 4, 'automatic analysis makes no audio');
    await page.evaluate(() => localStorage.setItem('rph_mod_character-voice::autoPlay', '1'));
    analysisFails = true;
    await send('坐哪');
    await page.locator('.toast-item', { hasText: '分析说话人失败' }).waitFor({ timeout: 15000 });
    await playingBlob();
    await page.evaluate(() => window.__audio.end());
    await idle(4);
    assert.deepEqual(ttsRequests.slice(4).map((item) => [item.voice, item.input]), [['', '“快坐下。”']], 'quotes use the Fish default voice when nobody is known');
    await statusIs('分析失败：');
    console.log('PASS automatic analysis stays silent; automatic speaking falls back to quotes in the default voice when analysis fails');

    // 7. 密钥错了：Fish 的 401 带上中文说明；悬浮窗刷新后还在拖过去的位置
    await page.evaluate(() => localStorage.setItem('rph_mod_character-voice::fishKey', 'bad-key'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await voiceButton(4).waitFor({ timeout: 45000 });
    await widget.waitFor();
    assert.deepEqual(await widget.evaluate((el) => [el.style.left, el.style.top]), [`${position.x}px`, `${position.y}px`]);
    await voiceButton(4).click();
    await page.locator('.toast-item', { hasText: 'Fish 报错（401，密钥不对）：Invalid Token' }).waitFor();
    await idle(4);
    console.log('PASS a wrong key shows the Fish error with a plain hint, and the floating window keeps its place after a reload');
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await harness.close();
}
