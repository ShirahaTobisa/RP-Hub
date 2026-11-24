import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));

// 1. 角色语音：残缺/重复配音表不落盘、不污染配音表（不加「对白」），强制重分析取消旧请求，同名子串人物不互相吞并
{
    const voice = read('DB/modules/character-voice.js');
    const analysis = voice.slice(voice.indexOf('            let store = { card:'), voice.indexOf('            // 念完一句停多久'));
    let cast = [{ name: '小明', id: 'v1' }];
    const saves = [];
    const toasts = [];
    const signals = [];
    let responder;
    const context = {
        AbortController, setTimeout, clearTimeout,
        characterId: () => 'card-1', character: () => ({ description: '' }),
        linesOf: () => [{ text: '“你好。”', quote: true }, { text: '“再见。”', quote: true }],
        keyOf: () => 'k1', get: () => '', readCast: () => cast, saveCast: (next) => { cast = next; },
        userName: () => '用户', renderWidget() {}, widgetVisible: () => true,
        parseJson: (text, open) => {
            const s = text.indexOf(open), e = text.lastIndexOf(open === '[' ? ']' : '}');
            if (s < 0 || e <= s) return null;
            try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
        },
        markRows() {}, NARRATOR: '旁白', DIALOGUE: '对白', ANALYSIS_KEEP: 10,
        analyzePrompt: () => 'fixture', LANGS: { ja: '日文' },
        isNarrator: (sp) => !sp || sp === '旁白',
        personOf: (sp, people) => people.find((p) => p.name === sp)
            || people.find((p) => p.name.length > 1 && sp.length > 1 && (sp.includes(p.name) || p.name.includes(sp))),
        document: { querySelectorAll: () => [] },
        ctx: {
            data: { get: async () => ({}), set: async (k, v) => saves.push({ k, v }) },
            ai: { complete: (req) => { signals.push(req.signal); return responder(req); } },
            ui: { toast: (msg) => toasts.push(msg) },
            log() {}
        }
    };
    vm.runInNewContext(analysis + '\nglobalThis.api = { analyze, abortAnalyses };', context);

    // 残缺结果（2 行只回 1 行）：不能落盘，不能把「对白」加成人物
    responder = async () => '[[1,"小明","happy",0.3]]';
    const partial = await context.api.analyze(0);
    assert.equal(saves.length, 0, 'truncated analysis must not be persisted');
    assert.ok(!cast.some((p) => p.name === '对白'), 'fallback speaker must not pollute cast');
    assert.ok(toasts.some((m) => m.includes('不完整')), JSON.stringify(toasts));
    assert.equal(partial.labels[0].speaker, '对白');

    // 重复行号：同样拒绝落盘
    responder = async () => '[[1,"小明","happy",0.3],[1,"小红","sad",0.3]]';
    await context.api.analyze(0);
    assert.equal(saves.length, 0, 'duplicate line indices must not be persisted');

    // 强制重分析：取消进行中的旧请求，新结果中的「小明妈妈」不被已有「小明」吞掉
    let releaseOld;
    let call = 0;
    responder = () => {
        call += 1;
        if (call === 1) return new Promise((resolve) => { releaseOld = resolve; });
        return Promise.resolve('[[1,"小明","happy",0.3],[2,"小明妈妈","gentle",0.5]]');
    };
    const first = context.api.analyze(0);
    await tick();
    const firstSignal = signals.at(-1);
    const forced = context.api.analyze(0, true);
    await tick();
    assert.equal(firstSignal.aborted, true, 'force re-analyze must abort previous in-flight request');
    const result = await forced;
    releaseOld('[[1,"旧人物","sad",0.1],[2,"旧人物","sad",0.1]]');
    await first;
    assert.deepEqual(Array.from(result.labels, (l) => l.speaker), ['小明', '小明妈妈']);
    assert.ok(cast.some((p) => p.name === '小明妈妈'), 'distinct character containing existing name must be added');
    assert.equal(saves.length, 1);
    console.log('PASS character-voice rejects truncated/duplicate tables, aborts stale force re-analysis, and preserves distinct names');
}

// 2. 角色语音：play() 切句竞态（旧 play() 迟到 reject 不会误停新一句）与 Fish 原生/中转/自定义模型、状态栏过滤
{
    const voice = read('DB/modules/character-voice.js');
    const statusMatch = voice.match(/const looksLikeStatus = [\s\S]*?\.test\(text\);/);
    assert.ok(statusMatch);
    const looksLikeStatus = vm.runInNewContext(`(${statusMatch[0].replace(/^const looksLikeStatus = /, '').replace(/;$/, '')})`);
    assert.equal(looksLikeStatus('好感度：80/100 | 体力：60'), true);
    assert.equal(looksLikeStatus('HP: 20'), true);
    assert.equal(looksLikeStatus('2026年秋，东京'), false);
    assert.equal(looksLikeStatus('第3章 重逢'), false);
    assert.equal(looksLikeStatus('阿玲：快走'), false);
    assert.equal(looksLikeStatus('10分钟后'), false);

    // 抽取 play() 验证双 finish 竞态不会误杀下一句
    const playStart = voice.indexOf('            function play(blob, current) {');
    const playEnd = voice.indexOf('\n            // 正在说的那句', playStart);
    let rejectFirstPlay;
    let playCall = 0;
    const player = {
        src: '', onended: null, onerror: null, paused: false,
        pause() { this.paused = true; },
        removeAttribute(name) { if (name === 'src') this.src = ''; },
        load() {},
        play() {
            this.paused = false;
            playCall += 1;
            if (playCall === 1) return new Promise((_, reject) => { rejectFirstPlay = reject; });
            return Promise.resolve();
        }
    };
    const revoked = [];
    const playCtx = {
        player, tune() {}, DOMException,
        URL: { createObjectURL: () => `blob:${playCall}`, revokeObjectURL: (u) => revoked.push(u) }
    };
    vm.runInNewContext(voice.slice(playStart, playEnd) + '\nglobalThis.play = play;', playCtx);
    const current = { finish: null };
    const p1 = playCtx.play({}, current);
    current.finish(); // 模拟切句提前结束第一句
    await p1;
    const p2 = playCtx.play({}, current); // 开始播放第二句
    rejectFirstPlay(new DOMException('aborted', 'AbortError')); // 第一句迟到 reject
    await tick();
    assert.equal(player.paused, false, 'late rejection from first line must not pause second line');
    assert.ok(typeof player.onended === 'function', 'late rejection must not clear second line onended');
    assert.ok(typeof current.finish === 'function', 'late rejection must not clear second line finish');
    player.onended();
    await p2;
    assert.equal(revoked.length, 2);

    // 抽取 apiUrl + speechRequest 验证 Fish 原生、自定义模型、OpenAI tts-1 快照与语气方括号剥离
    const apiStart = voice.indexOf('            function apiUrl(address, mode) {');
    const apiEnd = voice.indexOf('\n            const cache = new Map();', apiStart);
    const reqCtx = {
        URL, FISH: 'https://api.fish.audio',
        get: () => '', fishUrl: () => 'https://api.fish.audio', fishModelName: () => 'custom-s1',
        template: () => ({ voices: ['alloy'] })
    };
    vm.runInNewContext(voice.slice(apiStart, apiEnd) + '\nglobalThis.api = { apiUrl, speechRequest };', reqCtx);
    const nativeReq = reqCtx.api.speechRequest({ text: '你好', voice: 'vid', tone: '[soft]' }, {
        provider: 'fish', fishProtocol: 'native', fishUrl: 'https://relay.test/fish', fishKey: 'k', fishModel: 'fish-audio/s2.1-pro', fishFormat: 'wav'
    });
    assert.equal(nativeReq.url, 'https://relay.test/fish/v1/tts');
    assert.equal(nativeReq.headers.model, 's2.1-pro');
    assert.deepEqual({ ...nativeReq.body }, { text: '[soft] 你好', reference_id: 'vid', format: 'wav' });

    const openaiTts1 = reqCtx.api.speechRequest({ text: 'Hello', voice: '', tone: '[calm]' }, {
        provider: 'openai', openaiUrl: 'https://api.openai.com', openaiKey: 'sk', openaiModel: 'openai/tts-1-1106',
        openaiVoice: '', openaiTone: 'instructions', openaiFormat: 'mp3', fallbackVoice: 'alloy'
    });
    assert.equal(openaiTts1.body.instructions, undefined, 'prefixed/versioned tts-1 must not send instructions');
    console.log('PASS character-voice play() race guard, status detection, Fish native/custom model, and tone bracket sanitization');
}

// 3. 朗读插件：状态栏不误杀正常短段、splitText 保留省略号与英文句号、insideQuote 保护对白斜体、超时触发 synth.cancel()
{
    const tts = read('DB/modules/tts-reader.js');
    const statusMatch = tts.match(/const looksLikeStatus = [\s\S]*?\.test\(text\);/);
    const looksLikeStatus = vm.runInNewContext(`(${statusMatch[0].replace(/^const looksLikeStatus = /, '').replace(/;$/, '')})`);
    assert.equal(looksLikeStatus('好感度：80/100 | 体力：60'), true);
    assert.equal(looksLikeStatus('2026年秋，东京'), false);

    const helpersStart = tts.indexOf('            function insideQuote(text) {');
    const helpersEnd = tts.indexOf('            function clean(text, opts) {', helpersStart);
    const splitStart = tts.indexOf('            function splitText(text) {');
    const splitEnd = tts.indexOf('\n            let session = null;', splitStart);
    const ttsCtx = { LIMIT: 60 };
    vm.runInNewContext(tts.slice(helpersStart, helpersEnd) + '\n' + tts.slice(splitStart, splitEnd) + '\nglobalThis.api = { insideQuote, splitText };', ttsCtx);
    assert.equal(ttsCtx.api.insideQuote('她说：“这是'), true);
    assert.equal(ttsCtx.api.insideQuote('她说：“这是”'), false);
    const parts = ttsCtx.api.splitText('……好吧。Hello world. Next sentence.');
    assert.equal(parts.join(''), '……好吧。Hello world. Next sentence.', 'leading ellipsis and English sentences must be preserved');
    assert.ok(parts[0].startsWith('……'), 'leading ellipsis must not be dropped');
    const longEn = ttsCtx.api.splitText('This is the first rather long English sentence right here. And this is the second English sentence after it.');
    assert.equal(longEn.length, 2, 'long English text should split at period boundaries');
    assert.equal(longEn[0], 'This is the first rather long English sentence right here.');
    assert.equal(longEn[1], 'And this is the second English sentence after it.');

    // 验证 speakPart 超时会调用 synth.cancel() 防止队列卡死，且只结算一次
    const speakStart = tts.indexOf('            function speakPart(text, voice, current) {');
    const speakEnd = tts.indexOf('\n            async function speak(', speakStart);
    let cancels = 0;
    let scheduled;
    const speakCtx = {
        SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
        get: () => '1',
        setTimeout: (fn) => { scheduled = fn; return 1; },
        clearTimeout() {},
        synth: { speak() {}, cancel() { cancels += 1; } }
    };
    vm.runInNewContext(tts.slice(speakStart, speakEnd) + '\nglobalThis.speakPart = speakPart;', speakCtx);
    const done = speakCtx.speakPart('卡住的一句', null, { stopped: false });
    scheduled();
    await done;
    assert.equal(cancels, 1, 'timed-out utterance must cancel speechSynthesis to unstick the queue');
    console.log('PASS tts-reader status detection, ellipsis/English splitting, quote-italic protection, and timeout cancel');
}
