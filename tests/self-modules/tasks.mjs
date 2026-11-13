import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../../', import.meta.url)));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

// 实际重生成代码在保存前暂停，期间换成同键的 B 卡图片框。
for (const upstream of [false, true]) {
    const source = read('DB/image-module.js');
    const start = source.indexOf('    state.ready = new Promise((resolve) => {');
    let owner = 'A', replaced = null, release, entered;
    const held = new Promise(resolve => { entered = resolve; });
    const context = { console, URL, URLSearchParams, structuredClone, Date, crypto, performance, Element: class {},
        fetch: async () => Response.json({}),
        CSS: { escape: value => value }, setTimeout: () => 1, clearTimeout() {},
        localStorage: { getItem: () => 'STD-fixture', setItem() {} },
        document: { readyState: 'loading', getElementById: () => null, querySelectorAll: () => [],
            querySelector: selector => selector.includes('data-image-render-key')
                && (!selector.includes('data-character-uuid') || selector.includes('data-character-uuid="' + owner + '"'))
                ? { replaceWith: frame => { replaced = frame.owner; } } : null },
        window: { location: { origin: 'http://fixture.test' }, RPHubNavAdapter: { registerEntry() {} } } };
    vm.runInNewContext(source.slice(0, start) + `
        globalThis.api = { state, normalizeImageRenderRecord, rerollStoredImageRender };
        globalThis.setup = io => { loadSettings = async () => {}; reloadGenerationSettings = io.settings;
            saveRecords = io.save; createImageFrame = record => ({ owner: record.paramsSnapshot.characterUuid }); };
    })();`, context);
    const pause = () => new Promise(resolve => { release = () => resolve(true); entered(); });
    context.setup({ settings: upstream ? async () => {} : pause, save: upstream ? pause : async () => true });
    const record = id => context.api.normalizeImageRenderRecord({ key: 'same-key', prompt: 'sky, clouds',
        paramsSnapshot: { characterUuid: id, characterName: '同名', tag: 'sky, clouds',
            ...(upstream ? { source: 'upstream', upstreamParams: { tag: 'sky, clouds', model: 'nai-diffusion-4-5-full' } } : {}) } }, id);
    const a = [record('A')], b = [record('B')], before = JSON.stringify(b);
    context.api.state.character = { uuid: 'A' };
    context.api.state.records = a;
    context.api.state.recordBuckets.set('A', a);
    context.api.state.recordBuckets.set('B', b);
    const pending = context.api.rerollStoredImageRender('same-key', 'A');
    await held;
    owner = 'B';
    context.api.state.character = { uuid: 'B' };
    context.api.state.records = b;
    release();
    await pending;
    assert.equal(replaced, null, 'A 的重生成不能替换 B 的同键图片框');
    assert.equal(JSON.stringify(b), before);
    assert.equal(a[0].paramsSnapshot.characterUuid, 'A');
    assert.equal(a[0].rerollCount, 1);
    console.log('PASS reroll after switching cards: ' + (upstream ? 'upstream' : 'module'));
}

const voice = read('DB/modules/character-voice.js');
const analysis = voice.slice(voice.indexOf('            let store = { card:'), voice.indexOf('            // 念完一句停多久'));
{
    let card = 'A', delayStore = false, releaseStore;
    const requests = [], saves = [];
    const context = { characterId: () => card, linesOf: () => [{ text: '你好。', quote: true }], keyOf: () => 'same',
        get: () => '', readCast: () => [{ name: card }], userName: () => '用户', renderWidget() {}, widgetVisible: () => true,
        parseJson: JSON.parse, markRows() {}, NARRATOR: '旁白', DIALOGUE: '对话', ANALYSIS_KEEP: 10, ANALYZE_PROMPT: 'fixture',
        isNarrator: () => false, personOf: () => true, saveCast() {}, document: { querySelectorAll: () => [] },
        ctx: { data: { get: () => delayStore ? new Promise(resolve => { releaseStore = () => resolve({}); }) : Promise.resolve({}),
            set: async (key, value) => saves.push({ key, value }) },
            ai: { complete: request => new Promise(resolve => requests.push({ card, request, resolve })) }, ui: { toast() {} }, log() {} } };
    vm.runInNewContext(analysis + '\nglobalThis.analyze = analyze;', context);
    const a = context.analyze(0);
    await tick();
    const duplicate = context.analyze(0);
    await tick();
    card = 'B';
    const b = context.analyze(0);
    await tick();
    assert.equal(requests.length, 2);
    for (const request of requests) request.resolve(JSON.stringify([[1, request.card, '']]));
    const values = await Promise.all([a, duplicate, b]);
    assert.deepEqual(values.map(value => value.labels[0].speaker), ['A', 'A', 'B']);
    assert.ok(saves.every(save => save.key === 'analysis:B'));
    card = 'C'; delayStore = true;
    const changed = context.analyze(0);
    card = 'D'; releaseStore();
    assert.equal((await changed).lines.length, 0);
    assert.equal(requests.length, 2);
    console.log('PASS voice analysis separates cards and stops after a switch during storage read');
}

// 从两个已生成插件中抽取同一调度函数，并执行各自真实的接入代码。
for (const file of ['tts-reader.js', 'character-voice.js']) {
    const source = read('DB/modules/' + file);
    const helperStart = source.indexOf('    function onReplyReady(');
    const helperEnd = source.indexOf('\n    }', helperStart) + 6;
    const wiringStart = source.indexOf('            onReplyReady(ctx, {');
    const wiringEnd = source.indexOf('            });', wiringStart) + '            });'.length;
    assert.ok(helperStart > 0 && wiringStart > 0);
    let card = 'A', enabled = true;
    let history = [{ id: 'reply', content: '你好' }];
    const events = {}, timers = new Map(), actions = [], watches = [];
    let timerId = 0;
    const play = index => actions.push({ card, index });
    const context = { get: key => enabled && ['autoRead', 'autoPlay'].includes(key) ? '1' : '',
        renderWidget() {}, lastReplyIndex: () => history.length - 1, startReading: play, speak: play, analyze: play,
        setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
        ctx: { events: { on: (name, fn) => { events[name] = fn; } }, log: error => { throw error; },
            app: { get: key => key === 'chatHistory' ? history : key === 'currentCharacter' ? { uuid: card } : false,
                watch: (_getter, fn) => watches.push(fn) } } };
    vm.runInNewContext(source.slice(helperStart, helperEnd) + '\n' + source.slice(wiringStart, wiringEnd), context);
    const flush = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); };
    events['generation-end'](); card = 'B'; flush(); assert.equal(actions.length, 0);
    card = 'A'; events['generation-end'](); history[0].content += '。'; flush(); assert.equal(actions.length, 0);
    events['generation-end'](); events['generation-start'](); flush(); assert.equal(actions.length, 0);
    events['generation-end'](); enabled = false; flush(); assert.equal(actions.length, 0);
    enabled = true; events['generation-end'](); flush(); assert.equal(actions.length, 1);
    events['generation-end'](); flush(); assert.equal(actions.length, 1);
    history = [{ id: 'reply', content: '你好' }]; card = 'B';
    events['generation-end']();
    history = history.map(message => ({ ...message }));
    flush(); assert.equal(actions.length, 2, 'recreating the same message must not suppress playback');
    assert.equal(actions[1].card, 'B');
    history = [{ content: '没有编号的旧消息' }];
    events['generation-end'](); history = history.map(message => ({ ...message }));
    flush(); assert.equal(actions.length, 3, 'legacy replies without IDs still use their original slot');
    history = [{ id: 'old-id', content: 'same text' }];
    events['generation-end'](); history[0] = { id: 'new-id', content: 'same text' };
    flush(); assert.equal(actions.length, 3, 'a different message must cancel the pending playback');
    console.log('PASS delayed reply stays with its character/message: ' + file);
}

{
    let provider, manifest, base = 'https://old.test';
    const calls = [];
    vm.runInNewContext(read('DB/modules/nai2api-web.js'), {
        RPHubSDK: { register: value => { manifest = value; } },
        setTimeout: fn => { base = 'https://new.test'; fn(); },
        fetch: async url => {
            calls.push(url);
            assert.ok(url.startsWith('https://old.test/'));
            return url.endsWith('/content') ? new Response(new Uint8Array([1]))
                : Response.json({ id: 'job', status: url.endsWith('/api/web/jobs') ? 'queued' : 'done' });
        }
    });
    manifest.init({ image: { registerProvider: value => { provider = value; } }, storage: { get: () => base }, app: { watch() {} }, ui: { addSidebarEntry() {} } });
    assert.equal((await provider.generate({ params: {}, token: 'fixture' })).size, 1);
    assert.equal(calls.length, 3);
    console.log('PASS service remains fixed from job submission through image download');
}
