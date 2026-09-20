import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const modulePath = path.join(ROOT_DIR, 'DB', 'image-module.js');
const source = fs.readFileSync(modulePath, 'utf8');

const dbGetStart = source.indexOf('    async function dbGet(key) {');
const dbGetEnd = source.indexOf('\n\n    function dbPut', dbGetStart);
assert.ok(dbGetStart >= 0 && dbGetEnd > dbGetStart, 'unable to instrument dbGet');
let instrumented = [
    source.slice(0, dbGetStart),
    "    async function dbGet(key) { return globalThis.__rphTestDbGet(key); }",
    source.slice(dbGetEnd)
].join('');

const startup = instrumented.indexOf('    state.ready = new Promise((resolve) => {');
assert.ok(startup >= 0, 'unable to suppress module startup');
instrumented = `${instrumented.slice(0, startup)}
    globalThis.__rphActiveCharacterTest = {
        state,
        readCharacterCatalog,
        readRowMembershipProbe,
        resolveCharacterAttribution
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
    }

    getAttribute(name) {
        return this.attrs.has(name) ? this.attrs.get(name) : null;
    }

    querySelector(selector) {
        return this.one.get(selector) || null;
    }

    querySelectorAll(selector) {
        return this.many.get(selector) || [];
    }

    closest(selector) {
        return this.closestMap.get(selector) || null;
    }
}

const dbValues = new Map();
const dbReads = new Map();
const documentFixture = { headerName: '' };
const context = {
    console,
    Element: FakeElement,
    HTMLImageElement: class HTMLImageElement extends FakeElement {},
    URL,
    URLSearchParams,
    window: { RPHubNavAdapter: { registerEntry() {} }, location: { origin: 'http://fixture.test' } },
    document: {
        querySelector(selector) {
            if (selector !== 'button[title="清空聊天"]' || !documentFixture.headerName) return null;
            const name = new FakeElement({ text: documentFixture.headerName });
            const header = new FakeElement({ one: { 'span.ml-2.font-medium': name } });
            return new FakeElement({ closest: { '.absolute': header } });
        }
    },
    __rphTestDbGet(key) {
        dbReads.set(key, (dbReads.get(key) || 0) + 1);
        return structuredClone(dbValues.get(key));
    }
};
context.globalThis = context;
vm.runInNewContext(instrumented, context, { filename: modulePath });
const internals = context.__rphActiveCharacterTest;

const A = { uuid: '00000000-0000-4000-8000-00000000000a', name: 'Alpha' };
const B = { uuid: '00000000-0000-4000-8000-00000000000b', name: 'Beta' };
const C = { uuid: '00000000-0000-4000-8000-00000000000c', name: 'Header' };
const D = { uuid: '00000000-0000-4000-8000-00000000000d', name: 'Same' };
const E = { uuid: '00000000-0000-4000-8000-00000000000e', name: 'Same' };
const F = { uuid: '00000000-0000-4000-8000-00000000000f', name: 'Outside' };
const characters = [A, B, C, D, E, F];

function resetFixture() {
    dbValues.clear();
    dbReads.clear();
    documentFixture.headerName = '';
    internals.state.chatBuckets.clear();
    internals.state.chatReadAtByUuid.clear();
    internals.state.chatReadEpochByUuid.clear();
    internals.state.chatVerdictEpochByUuid.clear();
    internals.state.lastChatReadAt = 0;
    internals.state.cacheEpoch += 1;
    internals.state.catalogCache = null;
    internals.state.catalogReadAt = 0;
    internals.state.catalogVerdictEpoch = -1;
}

function seedCatalog(shape, selected = null) {
    if (shape === 'legacy') {
        dbValues.set('rp_hub_characters', characters);
        dbValues.set('rp_hub_last_active_char', selected
            ? characters.findIndex((character) => character.uuid === selected.uuid)
            : 'missing-character');
        return;
    }
    dbValues.set('rp_hub_characters', undefined);
    dbValues.set('rp_hub_character_index', { order: characters.map((character) => character.uuid) });
    for (const character of characters) dbValues.set(`rp_hub_character_${character.uuid}`, character);
    dbValues.set('rp_hub_last_active_char', selected?.uuid || 'missing-character');
}

function seedChat(character, messages) {
    dbValues.set(`rp_hub_chat_${character.uuid}`, messages);
}

function makeRow({ index = 1, role = 'assistant', name = '', content = '', explicitUuid = '' } = {}) {
    const root = new FakeElement({ text: content, many: { img: [] } });
    const nameTag = new FakeElement({ text: name });
    const attrs = { 'data-chat-index': index, 'data-role': role };
    if (explicitUuid) attrs['data-character-uuid'] = explicitUuid;
    return new FakeElement({
        attrs,
        text: `${name}${content}`,
        one: {
            '.msg-name-tag': nameTag,
            '.message-content-wrapper, .markdown-body': root
        },
        many: {
            '.message-content-wrapper .markdown-body, .message-content-wrapper > .markdown-body': [root],
            '.markdown-body': [root]
        }
    });
}

function message(content, role = 'assistant') {
    return { id: `message-${content}`, role, content };
}

function chatReads(character) {
    return dbReads.get(`rp_hub_chat_${character.uuid}`) || 0;
}

async function readCatalog(shape, selected) {
    seedCatalog(shape, selected);
    return internals.readCharacterCatalog({ force: true });
}

for (const shape of ['legacy', 'v4']) {
    resetFixture();
    let catalog = await readCatalog(shape, null);
    let result = await internals.resolveCharacterAttribution(
        makeRow({ explicitUuid: A.uuid, content: 'explicit path' }),
        catalog,
        new Map()
    );
    assert.deepEqual(
        { uuid: result.uuid, name: result.name, source: result.source },
        { uuid: A.uuid, name: A.name, source: 'message-uuid' },
        `${shape}: explicit uuid did not win`
    );
    assert.equal(chatReads(A), 0, `${shape}: explicit uuid unexpectedly read chat`);

    result = await internals.resolveCharacterAttribution(
        makeRow({ explicitUuid: 'missing-uuid', content: 'explicit failure' }),
        catalog,
        new Map()
    );
    assert.match(result.error, /message uuid not found/, `${shape}: invalid explicit uuid did not fail closed`);

    resetFixture();
    catalog = await readCatalog(shape, B);
    documentFixture.headerName = A.name;
    seedChat(A, [message('user', 'user'), message('exact row content')]);
    seedChat(B, [message('user', 'user'), message('wrong owner content')]);
    result = await internals.resolveCharacterAttribution(
        makeRow({ name: B.name, content: 'exact row content' }),
        catalog,
        new Map()
    );
    assert.equal(result.uuid, A.uuid, `${shape}: message label overrode the active header`);
    assert.equal(result.source, 'active-character');
    assert.equal(result.name, A.name, `${shape}: attribution name did not come from the card directory`);

    resetFixture();
    catalog = await readCatalog(shape, A);
    documentFixture.headerName = A.name;
    const fallbackMarker = 'image###full-array marker###';
    seedChat(A, [message('user', 'user'), message('index miss'), message(`prefix ${fallbackMarker} suffix`)]);
    result = await internals.resolveCharacterAttribution(
        makeRow({ name: A.name, content: fallbackMarker }),
        catalog,
        new Map()
    );
    assert.equal(result.uuid, A.uuid, `${shape}: full-array marker fallback did not match`);
    assert.equal(result.source, 'active-character');

    resetFixture();
    catalog = await readCatalog(shape, C);
    documentFixture.headerName = C.name;
    const betaMarker = 'image###beta-only###';
    seedChat(C, [message('user', 'user'), message('header does not own marker')]);
    seedChat(B, [message('user', 'user'), message(betaMarker)]);
    result = await internals.resolveCharacterAttribution(
        makeRow({ name: B.name, content: betaMarker }),
        catalog,
        new Map()
    );
    assert.equal(result.uuid, B.uuid, `${shape}: restricted content fallback chose the wrong character`);
    assert.equal(result.source, 'content-membership');
    assert.equal(chatReads(C), 1, `${shape}: active candidate was read more than once`);
    assert.equal(chatReads(B), 1, `${shape}: fallback candidate was read more than once`);

    resetFixture();
    catalog = await readCatalog(shape, A);
    documentFixture.headerName = A.name;
    seedChat(A, [message('user', 'user'), message('not the row')]);
    seedChat(B, [message('user', 'user'), message('also not the row')]);
    result = await internals.resolveCharacterAttribution(
        makeRow({ name: B.name, content: 'image###no owner###' }),
        catalog,
        new Map()
    );
    assert.match(result.error, /did not match a restricted candidate/, `${shape}: zero-match path guessed an owner`);

    resetFixture();
    catalog = await readCatalog(shape, C);
    documentFixture.headerName = C.name;
    const sharedMarker = 'image###duplicate owner marker###';
    seedChat(C, [message('user', 'user'), message('not shared')]);
    seedChat(D, [message('user', 'user'), message(sharedMarker)]);
    seedChat(E, [message('user', 'user'), message(sharedMarker)]);
    seedChat(F, [message('user', 'user'), message(sharedMarker)]);
    result = await internals.resolveCharacterAttribution(
        makeRow({ name: D.name, content: sharedMarker }),
        catalog,
        new Map()
    );
    assert.match(result.error, /content membership is ambiguous/, `${shape}: multi-match path guessed an owner`);
    assert.equal(chatReads(F), 0, `${shape}: fallback scanned a character outside the restricted candidate set`);

    resetFixture();
    catalog = await readCatalog(shape, B);
    const selectedMarker = 'image###selected owner###';
    seedChat(B, [message('user', 'user'), message(selectedMarker)]);
    result = await internals.resolveCharacterAttribution(
        makeRow({ name: 'display alias', content: selectedMarker }),
        catalog,
        new Map()
    );
    assert.equal(result.uuid, B.uuid, `${shape}: valid last-active character was not used`);
    assert.equal(result.source, 'active-character');

    resetFixture();
    catalog = await readCatalog(shape, null);
    seedChat(B, [message('user', 'user'), message('image###label only###')]);
    result = await internals.resolveCharacterAttribution(
        makeRow({ name: B.name, content: 'image###label only###' }),
        catalog,
        new Map()
    );
    assert.match(result.error, /active character signals are unavailable/, `${shape}: name label became an independent owner signal`);
    assert.equal(chatReads(B), 0, `${shape}: label-only failure still read a chat`);

    resetFixture();
    catalog = await readCatalog(shape, A);
    documentFixture.headerName = A.name;
    const immediateMarker = 'image###immediate switch###';
    internals.state.chatBuckets.set(A.uuid, [message('user', 'user'), message('stale cached chat')]);
    internals.state.chatReadAtByUuid.set(A.uuid, Date.now());
    seedChat(A, [message('user', 'user'), message(immediateMarker)]);
    result = await internals.resolveCharacterAttribution(
        makeRow({ name: A.name, content: immediateMarker }),
        catalog,
        new Map()
    );
    assert.equal(result.uuid, A.uuid, `${shape}: stale 2s cache blocked immediate membership refresh`);
    assert.equal(chatReads(A), 1, `${shape}: stale-cache retry exceeded one DB read in a scan`);

    resetFixture();
    catalog = await readCatalog(shape, D);
    documentFixture.headerName = D.name;
    const duplicateActiveMarker = 'image###duplicate selected side###';
    seedChat(D, [message('user', 'user'), message(duplicateActiveMarker)]);
    seedChat(E, [message('user', 'user'), message('other duplicate side')]);
    result = await internals.resolveCharacterAttribution(
        makeRow({ name: D.name, content: duplicateActiveMarker }),
        catalog,
        new Map()
    );
    assert.equal(result.uuid, D.uuid, `${shape}: last-active did not disambiguate a duplicate header name`);
    assert.equal(result.source, 'active-character');
}

console.log('image-active-character.test.mjs: legacy/v4 attribution branches passed');
