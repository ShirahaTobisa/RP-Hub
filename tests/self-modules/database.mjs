import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../../', import.meta.url)));
const { startHarness, initializeFixture, chromium, chrome } = await import(pathToFileURL(path.join(root, 'tests/sync-195.helpers.mjs')));
const harness = await startHarness();
const browser = await chromium.launch({ executablePath: chrome, headless: true });
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/instrumented.js*', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('globalThis.api = {', 'globalThis.api = { writeObjectStoreRecordBatch,') });
    });
    await page.goto(harness.url);
    await initializeFixture(page);
    const result = await page.evaluate(async () => {
        const db = await fixture.db();
        await fixture.write(db, [['original', 'keep']]);
        let rejected = false;
        try {
            await api.writeObjectStoreRecordBatch(db, { name: 'store', keyPath: null }, [
                { key: 'new', value: 'must roll back' }, { key: null, value: 'invalid key' }
            ]);
        } catch { rejected = true; }
        const values = await new Promise((resolve, reject) => {
            const store = db.transaction('store').objectStore('store');
            const a = store.get('original'), b = store.get('new');
            b.onsuccess = () => resolve({ original: a.result, added: b.result });
            b.onerror = () => reject(b.error);
        });
        db.close();
        const staging = await api.openDownloadStagingDb();
        await api.writeDownloadStagingChunks(staging, [{ index: 1, bytes: new Uint8Array([9]) }]);
        let stagingRejected = false;
        try {
            await api.writeDownloadStagingChunks(staging, [{ index: 1, bytes: new Uint8Array([0]) }, { index: null, bytes: new Uint8Array([1]) }]);
        } catch { stagingRejected = true; }
        const retained = [...await api.readDownloadStagingChunk(staging, 1)];
        staging.close();
        return { rejected, values, stagingRejected, retained };
    });
    assert.deepEqual(result, { rejected: true, values: { original: 'keep', added: undefined }, stagingRejected: true, retained: [9] });
    assert.deepEqual(errors, []);
    console.log('PASS a synchronous bad key rolls back all earlier writes in restore and staging transactions');
} finally {
    await browser.close();
    await harness.close();
}
