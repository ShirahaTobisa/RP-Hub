import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDirectory, '..');
const modulePath = path.join(root, 'DB', 'image-module.js');
const source = fs.readFileSync(modulePath, 'utf8');

const dbGetStart = source.indexOf('    async function dbGet(key) {');
const dbGetEnd = source.indexOf('\n\n    function dbPut', dbGetStart);
const dbPutStart = source.indexOf('    function dbPut(key, value) {');
const dbPutEnd = source.indexOf('\n\n    function dbPutImmediately', dbPutStart);
const startup = source.indexOf('    state.ready = new Promise((resolve) => {');
assert.ok(dbGetStart >= 0 && dbGetEnd > dbGetStart && dbPutStart > dbGetEnd && dbPutEnd > dbPutStart && startup > dbPutEnd);

let instrumented = [
    source.slice(0, dbGetStart),
    "    async function dbGet(key) { return globalThis.__rphKeyDbGet(key); }",
    source.slice(dbGetEnd, dbPutStart),
    "    function dbPut(key, value) { return globalThis.__rphKeyDbPut(key, value); }",
    source.slice(dbPutEnd, startup),
    `    globalThis.__rphImageKeyTest = { state, reconcileImageKeyStorage, loadSettings, getImageToken, ensurePersistenceFlushWrapped };\n})();`
].join('');

const values = new Map();
const writes = [];
const storageValues = new Map();
const localStorage = {
    getItem(key) { return storageValues.has(key) ? storageValues.get(key) : null; },
    setItem(key, value) { storageValues.set(String(key), String(value)); },
    removeItem(key) { storageValues.delete(String(key)); },
    clear() { storageValues.clear(); }
};
const context = {
    console,
    URL,
    URLSearchParams,
    structuredClone,
    localStorage,
    Element: class Element {},
    HTMLImageElement: class HTMLImageElement {},
    document: { visibilityState: 'visible' },
    window: { RPHubNavAdapter: { registerEntry() {} }, location: { origin: 'https://fixture.invalid' } },
    setTimeout() { return 1; },
    clearTimeout() {},
    __rphKeyDbGet(key) { return structuredClone(values.get(String(key))); },
    __rphKeyDbPut(key, value) {
        const storedKey = String(key);
        const cloned = structuredClone(value);
        values.set(storedKey, cloned);
        writes.push({ key: storedKey, value: cloned });
        return Promise.resolve();
    }
};
context.globalThis = context;
vm.runInNewContext(instrumented, context, { filename: modulePath });
const internals = context.__rphImageKeyTest;
const PRIMARY = 'rp_hub_image_gen_key_v1';
const SHADOW = 'rphImgKeyShadow';
const ADOPTED = 'rp_hub_image_gen_key_adopted_v1';
const OLD_KEY = 'STD-old-key';
const NEW_KEY = 'STD-new-key';

function reset({ settings = {}, primary = '', shadow = '', adopted = '' } = {}) {
    values.clear();
    writes.length = 0;
    storageValues.clear();
    if (primary) storageValues.set(PRIMARY, primary);
    if (shadow) storageValues.set(SHADOW, shadow);
    if (adopted) storageValues.set(ADOPTED, adopted);
    values.set('rp_hub_settings', structuredClone(settings));
    internals.state.settings = structuredClone(settings);
    internals.state.keySettingsBackfillAttempted = false;
    internals.state.keyRecoveryNotice = '';
    internals.state.persistenceFlushOriginal = null;
    internals.state.persistenceFlushWrapper = null;
    internals.state.scanTimer = null;
    internals.state.seedSyncTimer = null;
}

reset({ settings: { imageGenKey: OLD_KEY } });
await internals.reconcileImageKeyStorage();
assert.equal(localStorage.getItem(PRIMARY), OLD_KEY, 'settings key was not adopted');
assert.equal(localStorage.getItem(SHADOW), OLD_KEY, 'settings key shadow was not updated');
assert.equal(localStorage.getItem(ADOPTED), OLD_KEY, 'adopted marker was not recorded');
assert.equal(values.get('rp_hub_settings').imageGenKey, OLD_KEY, 'settings field was changed during adoption');
assert.equal(writes.length, 0, 'settings adoption unexpectedly wrote the settings record');

internals.state.settings = { imageGenKey: NEW_KEY };
await internals.reconcileImageKeyStorage();
assert.equal(localStorage.getItem(PRIMARY), NEW_KEY, 'changed settings key was not adopted');
assert.equal(localStorage.getItem(SHADOW), NEW_KEY, 'changed settings key did not refresh shadow');
assert.equal(localStorage.getItem(ADOPTED), NEW_KEY, 'changed settings key did not refresh marker');

reset({ settings: { imageGenKey: NEW_KEY }, adopted: NEW_KEY });
await internals.reconcileImageKeyStorage({ allowSettingsBackfill: true });
assert.equal(localStorage.getItem(PRIMARY), null, 'management clear primary key was revived');
assert.equal(localStorage.getItem(SHADOW), null, 'management clear shadow key was revived');
assert.equal(writes.length, 0, 'management clear triggered an unexpected settings write');

reset({ settings: { imageGenKey: '' }, primary: OLD_KEY, shadow: OLD_KEY, adopted: OLD_KEY });
await internals.reconcileImageKeyStorage({ allowSettingsBackfill: true });
assert.equal(localStorage.getItem(PRIMARY), OLD_KEY, 'empty settings cleared the module key');
assert.equal(localStorage.getItem(SHADOW), OLD_KEY, 'empty settings cleared the shadow key');
assert.equal(values.get('rp_hub_settings').imageGenKey, OLD_KEY, 'empty old-user settings were not backfilled');
assert.equal(writes.length, 1, 'empty old-user settings backfill did not converge in one write');
await internals.reconcileImageKeyStorage({ allowSettingsBackfill: true });
assert.equal(writes.length, 1, 'empty old-user settings backfill repeated within one session');

reset({ settings: { other: true }, shadow: OLD_KEY });
await internals.reconcileImageKeyStorage({ allowSettingsBackfill: true });
assert.equal(localStorage.getItem(PRIMARY), OLD_KEY, 'shadow recovery did not restore primary key');
assert.equal(localStorage.getItem(SHADOW), OLD_KEY, 'shadow recovery changed the shadow key');
assert.equal(values.get('rp_hub_settings').imageGenKey, OLD_KEY, 'old-user settings backfill did not persist imageGenKey');
assert.equal(localStorage.getItem(ADOPTED), OLD_KEY, 'old-user backfill did not update adopted marker');
assert.equal(writes.length, 1, 'old-user backfill wrote more than once on first session');

values.set('rp_hub_settings', { other: true });
await internals.loadSettings();
await internals.reconcileImageKeyStorage({ allowSettingsBackfill: true });
assert.equal(writes.length, 1, 'old-user backfill repeated within one session');

reset({ settings: { imageGenKey: OLD_KEY }, primary: OLD_KEY, shadow: OLD_KEY, adopted: OLD_KEY });
values.set('rp_hub_settings', { imageGenKey: NEW_KEY });
await internals.reconcileImageKeyStorage({ reloadSettings: true });
assert.equal(localStorage.getItem(PRIMARY), NEW_KEY, 'flush-time settings change was not adopted');
assert.equal(localStorage.getItem(SHADOW), NEW_KEY, 'flush-time settings change did not refresh shadow');
assert.equal(localStorage.getItem(ADOPTED), NEW_KEY, 'flush-time settings change did not refresh marker');
assert.equal(writes.length, 0, 'flush-time key adoption rewrote settings unexpectedly');

reset({ settings: { imageGenKey: OLD_KEY }, primary: OLD_KEY, shadow: OLD_KEY, adopted: OLD_KEY });
context.RPH_R2_FLUSH_PERSISTENCE = async () => 'original-result';
assert.equal(internals.ensurePersistenceFlushWrapped(), true, 'persistence flush was not wrapped');
values.set('rp_hub_settings', { imageGenKey: NEW_KEY });
assert.equal(await context.RPH_R2_FLUSH_PERSISTENCE(), 'original-result', 'flush wrapper changed the original result');
assert.equal(localStorage.getItem(PRIMARY), NEW_KEY, 'flush wrapper did not adopt the changed settings key');
assert.equal(localStorage.getItem(SHADOW), NEW_KEY, 'flush wrapper did not refresh shadow');
assert.equal(localStorage.getItem(ADOPTED), NEW_KEY, 'flush wrapper did not refresh adopted marker');

console.log('image-key-persistence.test.mjs: adoption, backfill, empty-value, clear, and flush semantics passed');
