import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../DB/image-module.js', import.meta.url), 'utf8');
const startup = source.indexOf('    state.ready = new Promise((resolve) => {');
assert(startup > 0);
class Element {
    constructor(attrs = {}) { this.attrs = attrs; this.dataset = {}; this.style = {}; this.textContent = ''; }
    getAttribute(key) { return this.attrs[key] ?? null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return this.frame; }
}
class Image extends Element {}
const app = new Element();
const sandbox = { console, URL, URLSearchParams, structuredClone, Date, Element, HTMLImageElement: Image,
    setTimeout: () => 1, clearTimeout() {},
    document: { getElementById: () => app, querySelectorAll: () => [], querySelector: () => null, readyState: 'loading' },
    window: { RPHubNavAdapter: { registerEntry() {} }, location: { origin: 'http://fixture.test' } } };
vm.runInNewContext(`${source.slice(0, startup)}globalThis.api = {
    state, buildDescriptor, buildImageRenderRecordKey, normalizeImageRenderRecord,
    findRecord, getFrozenRecord, getMessageContext, handleImageError
}; })();`, sandbox);
const api = sandbox.api;
const owner = { uuid: 'a', name: '同名角色' };
const prompt = 'blue sky, white clouds';
const body = text => `${text}\nimage###${prompt}###`;
const context = (rawContent = body('修改后'), extra = {}) => ({ messageId: 'm1', rawContent,
    branchId: 'main', legacyScope: true, attribution: owner, ...extra });
const descriptor = (raw = body('修改后'), index = 0, text = prompt, extra = {}) => api.buildDescriptor(text, index, context(raw, extra));
const record = (extra = {}, raw = body('原文')) => api.normalizeImageRenderRecord({
    ...descriptor(raw), paramsSnapshot: { tag: prompt, seed: '123', model: 'saved-model', characterUuid: 'a' },
    imageSignature: 'image-one', ...extra
}, 'a');
const legacy = (extra = {}, raw = body('原文')) => {
    const saved = record(extra, raw);
    delete saved.branchId; delete saved.promptLayout;
    saved.key = api.buildImageRenderRecordKey(saved);
    return saved;
};
let count = 0;
function check(name, records, expected, desc = descriptor()) {
    api.state.records = records;
    assert.equal(api.findRecord(desc), expected, name); count++;
}

const old = legacy();
check('legacy image survives prose deletion', [old], old);
for (const prose of ['增加了很多普通文字', '', '完全替换普通文字']) check('prose only', [old], old, descriptor(body(prose)));
const empty = legacy({ status: 'skipped', imageSignature: 'manual' }, body('修改后'));
check('old manual blank cannot hide image', [empty, old], old);
const deliberate = legacy({ status: 'skipped', imageSignature: '' }, body('修改后'));
check('exact explicit skip wins', [old, deliberate], deliberate);
const skippedOld = legacy({ status: 'skipped', imageSignature: '' });
check('editing an explicit skip does not generate', [skippedOld], skippedOld);
const selected = record({ paramsSnapshot: { tag: prompt, seed: '456', rerollNonce: 'selected', characterUuid: 'a' } }, body('修改后'));
check('exact user selection wins', [old, selected], selected);
const otherImage = legacy({ paramsSnapshot: { tag: prompt, seed: '789', characterUuid: 'a' } }, body('另一段正文'));
check('different historical images are ambiguous', [old, otherImage, empty], empty);
check('ambiguity independent of order', [otherImage, old], undefined);
check('identical image parameters allow duplicate records', [old, legacy({}, body('另一段正文'))], old);
check('prompt must match actual text', [old], undefined, { ...descriptor(), prompt: 'hash collision' });
check('other message cannot lend image', [old], undefined, descriptor(undefined, 0, prompt, { messageId: 'm2' }));
check('legacy branch ownership unknown', [old], undefined, descriptor(undefined, 0, prompt, { branchId: 'fork', legacyScope: false }));
check('legacy main ownership unknown after forks', [old], undefined, descriptor(undefined, 0, prompt, { legacyScope: false }));
check('legacy exact match remains readable when branch is unknown', [old], old, descriptor(body('原文'), 0, prompt, { branchId: 'fork', legacyScope: false }));
check('explicit other branch excluded even if key matches', [record({ branchId: 'fork', key: descriptor().key })], undefined);
const scoped = record();
check('known main survives having branches', [scoped], scoped, descriptor(undefined, 0, prompt, { legacyScope: false }));
check('same text, different branches have distinct keys', [scoped], undefined, descriptor(body('原文'), 0, prompt, { branchId: 'fork', legacyScope: false }));
const noId = legacy({ messageId: '' });
check('no-ID legacy exact remains supported', [noId], noId, descriptor(body('原文'), 0, prompt, { messageId: '', branchId: '' }));
check('no-ID edit is not guessed', [noId], undefined, descriptor(undefined, 0, prompt, { messageId: '' }));
check('new inserted identical prompt changes layout', [old], undefined, descriptor(`${body('修改后')}\nimage###${prompt}###`));
const twoBody = `${body('原文')}\nimage###green trees###`;
const second = api.normalizeImageRenderRecord({ ...api.buildDescriptor('green trees', 1, context(twoBody)), paramsSnapshot: { tag: 'green trees', seed: '2' } }, 'a');
const first = legacy({}, twoBody);
delete second.branchId; delete second.promptLayout; second.key = api.buildImageRenderRecordKey(second);
check('legacy multiple image layout reconstructed', [first, second], first, descriptor(twoBody.replace('原文', '修改后')));
check('deletion of marker does not shift old images', [first, second], undefined);
check('marker reorder does not lend image', [first, second], undefined, descriptor(`image###green trees###\n${body('修改后')}`, 1));
const duplicates = `${body('原文')}\nimage###${prompt}###`;
const duplicateA = record({}, duplicates), duplicateB = record({ ...descriptor(duplicates, 1), paramsSnapshot: { tag: prompt, seed: '2' } }, duplicates);
check('repeated prompt keeps first slot', [duplicateA, duplicateB], duplicateA, descriptor(duplicates.replace('原文','修改后')));
check('repeated prompt keeps second slot', [duplicateA, duplicateB], duplicateB, descriptor(duplicates.replace('原文','修改后'), 1));
const upstream = legacy({ paramsSnapshot: { source: 'upstream', upstreamParams: { tag: 'white clouds, blue sky', model: 'old-model' }, upstreamSourceSignature: 'original' } });
check('upstream reroll retains original prompt and chosen parameters', [upstream], upstream);
api.state.records = [old, empty]; api.state.character = owner;
const paramsBefore = JSON.stringify(old.paramsSnapshot), keyBefore = old.key;
assert.equal(api.getFrozenRecord(prompt, 0, context()), old);
assert.equal(api.state.records.length, 2);
assert.equal(old.key, keyBefore); assert.equal(JSON.stringify(old.paramsSnapshot), paramsBefore);
assert.equal(old.branchId, 'main'); assert(api.state.recoveredRecords.has(old)); count++;
const reloaded = api.normalizeImageRenderRecord(JSON.parse(JSON.stringify(old)), 'a');
check('saved metadata survives sync/reload', [reloaded], reloaded, descriptor(undefined, 0, prompt, { legacyScope: false }));
api.state.records = [scoped];
const inherited = api.getFrozenRecord(prompt, 0, context(undefined, { branchId:'fork', legacyScope:false, parentBranchId:'main', branchCreatedAt:scoped.updatedAt+1 }));
assert.notEqual(inherited,scoped); assert.notEqual(inherited.key,scoped.key); assert.equal(inherited.branchId,'fork');
assert.deepEqual(inherited.paramsSnapshot,scoped.paramsSnapshot); assert.equal(inherited.readOnly,true); count++;
const inheritedReloaded = api.normalizeImageRenderRecord(JSON.parse(JSON.stringify(inherited)), 'a');
assert.equal(inheritedReloaded.readOnly,true); count++;
api.state.records = [scoped];
assert.equal(api.getFrozenRecord(prompt, 0, context(undefined, { branchId:'fork', legacyScope:false, parentBranchId:'main', branchCreatedAt:scoped.updatedAt-1 })),null); count++;
const row = new Element({ 'data-chat-index': '0', 'data-role': 'assistant' }); row.textContent = body('分支当前正文');
api.state.chat = [{ id: 'wrong-cached-id', role: 'assistant', content: body('缓存主线') }];
app.__vue_app__ = { _instance: { proxy: { currentCharacter: owner, chatHistory: [{ id: 'live-id', role: 'assistant', content: row.textContent }], currentStoryBranch: { id: 'fork' }, storyBranches: [{id:'main'}, {id:'fork'}] } } };
const current = api.getMessageContext(row, owner);
assert.equal(current.messageId, 'live-id'); assert.equal(current.branchId, 'fork'); assert.equal(current.legacyScope, false); count++;
const img = new Image(); img.src = 'http://fixture.test/api/rp-image?tag=test'; img.frame = new Element(); img.dataset.rphImageReadOnly = '1';
api.handleImageError({target: img}); assert.equal(img.dataset.rphImageGenerationState, 'missing');
assert.match(img.alt, /原图读取失败/); count++;
console.log(`image-edit.test.mjs: ${count} cases passed`);
