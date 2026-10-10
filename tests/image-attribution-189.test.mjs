import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const modulePath = path.join(root, 'DB', 'image-module.js');
const source = fs.readFileSync(modulePath, 'utf8');
const startup = source.indexOf('    state.ready = new Promise((resolve) => {');
assert.ok(startup > 0, 'unable to suppress module startup');
const instrumented = `${source.slice(0, startup)}
    globalThis.__rphAttribution189 = {
        canonMarkerText,
        markersMatchContent,
        readLiveAttributionSnapshot,
        resolveRuntimeAttribution,
        getMessageContext,
        isLiveGenerationWindow: () => Date.now() - state.lastBusyAt <= LIVE_WINDOW_MS,
        state
    };
})();`;

class FakeElement {
    constructor({ attrs = {}, text = '', one = {}, many = {}, closest = {} } = {}) {
        this.attrs = new Map(Object.entries(attrs).map(([key, value]) => [key, String(value)]));
        this.textContent = text;
        this.one = new Map(Object.entries(one));
        this.many = new Map(Object.entries(many));
        this.closestMap = new Map(Object.entries(closest));
        this.dataset = {};
        this.isConnected = true;
    }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    querySelector(selector) { return this.one.get(selector) || null; }
    querySelectorAll(selector) { return this.many.get(selector) || []; }
    closest(selector) { return this.closestMap.get(selector) || null; }
    matches(selector) { return selector === '[data-chat-index]' && this.attrs.has('data-chat-index'); }
}

const appRoot = new FakeElement();
const context = {
    console,
    Element: FakeElement,
    HTMLImageElement: class HTMLImageElement extends FakeElement {},
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    structuredClone,
    Date,
    document: {
        getElementById: (id) => id === 'app' ? appRoot : null,
        querySelectorAll: () => [],
        querySelector: () => null,
        addEventListener: () => {},
        readyState: 'loading'
    },
    window: { RPHubNavAdapter: { registerEntry() {} }, location: { origin: 'http://fixture.test' } }
};
context.globalThis = context;
vm.runInNewContext(instrumented, context, { filename: modulePath });
const api = context.__rphAttribution189;

assert.equal(api.canonMarkerText('  image###a\\_*b* ~c~ `d`###\n'), 'image###ab c d###');
assert.equal(api.canonMarkerText('image###keep#hash###'), 'image###keep#hash###');
assert.equal(api.markersMatchContent(
    'prefix image###second value### suffix',
    ['image###first value###', 'image###second *value*###']
), true, 'any matching marker must be sufficient');
assert.equal(api.markersMatchContent('image###only###', []), false);

for (let index = 0; index < 501; index += 1) api.canonMarkerText(`image###${index}###`);
assert.equal(api.canonMarkerText('image###0###'), 'image###0###');
assert.equal(api.state.lastBusyAt, 0);
api.state.lastBusyAt = Date.now();
assert.equal(api.isLiveGenerationWindow(), true);
api.state.lastBusyAt = Date.now() - 30_001;
assert.equal(api.isLiveGenerationWindow(), false);

const character = { uuid: 'card-a', name: 'Card A' };
const chat = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'image###runtime *marker*###' }
];
const messageRoot = new FakeElement({ text: 'image###runtime marker###', many: { img: [] } });
const row = new FakeElement({
    attrs: { 'data-chat-index': '1', 'data-role': 'assistant' },
    text: messageRoot.textContent,
    one: { '.message-content-wrapper, .markdown-body': messageRoot },
    many: {
        '.message-content-wrapper .markdown-body, .message-content-wrapper > .markdown-body': [messageRoot],
        '.markdown-body': [messageRoot]
    }
});
const catalog = { characters: [character] };

appRoot.__vue_app__ = { _instance: { proxy: { chatHistory: chat, currentCharacter: character } } };
assert.equal(api.resolveRuntimeAttribution(row, catalog)?.source, 'runtime-rescue');

api.state.startedAt = Date.now() - 1000;
api.state.liveChatBaselines.set(chat, chat.length);
chat.push({ role: 'assistant', content: 'image###new growth###' });
const growthRow = new FakeElement({ attrs: { 'data-chat-index': '2', 'data-role': 'assistant' } });
api.state.lastBusyAt = 0;
const growthContext = api.getMessageContext(growthRow, character);
assert.equal(growthContext.live, true, 'same-array chat growth must mark the row live');
assert.equal(Object.hasOwn(chat[2], 'timestamp'), false, 'upstream chat messages must not be given synthetic timestamps');
assert.ok(api.state.lastBusyAt >= api.state.startedAt, 'same-array chat growth must open the live window');
const replacement = [...chat];
appRoot.__vue_app__._instance.proxy.chatHistory = replacement;
api.state.lastBusyAt = 0;
const replacementContext = api.getMessageContext(growthRow, character);
assert.equal(replacementContext.live, false, 'replacement chat array must not mark the row live');
assert.equal(api.state.lastBusyAt, 0, 'replacement chat array must not open the live window');
appRoot.__vue_app__._instance.proxy.chatHistory = chat;

appRoot.__vue_app__ = {
    _instance: {
        setupState: {
            chatHistory: { value: chat },
            currentCharacter: { value: character }
        }
    }
};
assert.equal(api.resolveRuntimeAttribution(row, catalog)?.uuid, character.uuid);

const prototypeRef = (value) => Object.create({ get value() { return value; } });
appRoot.__vue_app__ = {
    _instance: {
        setupState: {
            chatHistory: prototypeRef(chat),
            currentCharacter: prototypeRef(character)
        }
    }
};
assert.equal(api.resolveRuntimeAttribution(row, catalog)?.uuid, character.uuid);

appRoot.__vue_app__ = {
    _container: {
        _vnode: {
            component: {
                setupState: {
                    chatHistory: { value: chat },
                    currentCharacter: { value: character }
                }
            }
        }
    }
};
assert.equal(api.resolveRuntimeAttribution(row, catalog)?.uuid, character.uuid);

// 显示文字经过 Markdown 和美化正则后可能和原文对不上，只要位置和角色一致就归当前角色。
appRoot.__vue_app__ = { _instance: { proxy: { chatHistory: [chat[0], { ...chat[1], content: 'no marker' }], currentCharacter: character } } };
assert.equal(api.resolveRuntimeAttribution(row, catalog)?.uuid, character.uuid);

const rejects = [
    () => { appRoot.__vue_app__ = null; },
    () => { appRoot.__vue_app__ = { _instance: { proxy: { chatHistory: [], currentCharacter: character } } }; },
    () => { appRoot.__vue_app__ = { _instance: { proxy: { chatHistory: [chat[0], { ...chat[1], role: 'user' }], currentCharacter: character } } }; },
    () => { appRoot.__vue_app__ = { _instance: { proxy: { chatHistory: chat, currentCharacter: character } } }; }
];
for (const [index, setup] of rejects.entries()) {
    setup();
    const verdict = index === rejects.length - 1
        ? api.resolveRuntimeAttribution(row, { characters: [] })
        : api.resolveRuntimeAttribution(row, catalog);
    assert.equal(verdict, null, `runtime rescue condition ${index + 1} failed open`);
}

const switchingCharacter = { ...character };
Object.defineProperty(switchingCharacter, 'uuid', {
    get() {
        appRoot.__vue_app__._instance.proxy.chatHistory = [...chat];
        return character.uuid;
    }
});
appRoot.__vue_app__ = { _instance: { proxy: { chatHistory: chat, currentCharacter: switchingCharacter } } };
assert.equal(api.resolveRuntimeAttribution(row, catalog)?.retry, true, 'changed chat reference must invalidate rescue');

console.log('image-attribution-189.test.mjs: unit assertions passed');
