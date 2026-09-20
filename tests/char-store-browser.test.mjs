const resultNode = document.getElementById('result');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function finish(status, message) {
    resultNode.dataset.status = status;
    resultNode.textContent = `${status.toUpperCase()}: ${message}`;
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
}

function transactionDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
}

async function deleteDatabase() {
    const request = indexedDB.deleteDatabase('RPHubDB');
    await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error || new Error('deleteDatabase failed.'));
        request.onblocked = () => reject(new Error('deleteDatabase was blocked.'));
    });
}

async function openDatabase() {
    const request = indexedDB.open('RPHubDB', 1);
    request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('store')) {
            request.result.createObjectStore('store');
        }
    };
    return requestResult(request);
}

async function seedRecords(records) {
    const db = await openDatabase();
    try {
        const tx = db.transaction(['store'], 'readwrite');
        const done = transactionDone(tx);
        const store = tx.objectStore('store');
        for (const [key, value] of records) store.put(value, key);
        await done;
    } finally {
        db.close();
    }
}

async function readRecord(key) {
    const db = await openDatabase();
    try {
        return await requestResult(db.transaction(['store'], 'readonly').objectStore('store').get(key));
    } finally {
        db.close();
    }
}

async function readAllKeys() {
    const db = await openDatabase();
    try {
        return await requestResult(db.transaction(['store'], 'readonly').objectStore('store').getAllKeys());
    } finally {
        db.close();
    }
}

function wait(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function releaseDeferredWrites(queue) {
    while (queue.length > 0) {
        const entry = queue.shift();
        try {
            entry.resolve(await entry.operation());
        } catch (error) {
            entry.reject(error);
        }
        await Promise.resolve();
    }
}

async function testPullRestoreMutationDeferral() {
    await deleteDatabase();
    await seedRecords([['rp_hub_characters', [{ uuid: 'deferred-seed', name: 'legacy seed' }]]]);
    const deferredWrites = [];
    globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE = (operation) => new Promise((resolve, reject) => {
        deferredWrites.push({ operation, resolve, reject });
    });
    globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;

    const migratePromise = window.RPHubCharStore.migrate();
    await wait(0);
    assert(deferredWrites.length === 1, 'migrate did not defer while pull restore was active');
    assert(Array.isArray(await readRecord('rp_hub_characters')), 'deferred migrate changed the legacy record');

    delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
    await releaseDeferredWrites(deferredWrites);
    const migrated = await migratePromise;
    assert(migrated[0].uuid === 'deferred-seed', 'released migrate returned an incompatible result');

    globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
    const savePromise = window.RPHubCharStore.saveAll([{ uuid: 'deferred-latest', name: 'latest local card' }]);
    await wait(0);
    assert(deferredWrites.length === 1, 'saveAll did not defer while pull restore was active');
    assert((await readRecord('rp_hub_character_index')).order[0] === 'deferred-seed',
        'deferred saveAll changed the character index');

    delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
    await releaseDeferredWrites(deferredWrites);
    const summary = await savePromise;
    assert(summary.writtenKeys.includes('rp_hub_character_deferred-latest'),
        'released saveAll returned an incompatible summary');
    assert((await readRecord('rp_hub_character_index')).order[0] === 'deferred-latest',
        'released saveAll did not persist the latest local card');

    delete globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE;
}

async function testMigrationRollbackAfterQueuedPut() {
    await deleteDatabase();
    const legacyCards = [
        { uuid: 'rollback-a', name: 'queued before failure' },
        { uuid: 'rollback-b', name: 'forced failure' }
    ];
    await seedRecords([['rp_hub_characters', legacyCards]]);

    const nativePut = IDBObjectStore.prototype.put;
    let firstCharacterPutQueued = false;
    let failureInjectedAfterFirstPut = false;
    IDBObjectStore.prototype.put = function patchedPut(value, key) {
        if (key === 'rp_hub_character_rollback-a') {
            firstCharacterPutQueued = true;
            return nativePut.apply(this, arguments);
        }
        if (key === 'rp_hub_character_rollback-b') {
            failureInjectedAfterFirstPut = firstCharacterPutQueued;
            return nativePut.call(this, value);
        }
        return nativePut.apply(this, arguments);
    };

    let migrationError = null;
    try {
        await window.RPHubCharStore.migrate();
    } catch (error) {
        migrationError = error;
    } finally {
        IDBObjectStore.prototype.put = nativePut;
    }

    assert(firstCharacterPutQueued, 'migration fault ran before any character put was queued');
    assert(failureInjectedAfterFirstPut, 'migration fault was not injected after the first queued put');
    assert(migrationError, 'migration unexpectedly committed after the injected put failure');
    assert(
        JSON.stringify(await readRecord('rp_hub_characters')) === JSON.stringify(legacyCards),
        'aborted migration changed or deleted the legacy record'
    );
    assert(await readRecord('rp_hub_character_rollback-a') === undefined,
        'first queued character put survived the transaction abort');
    assert(await readRecord('rp_hub_character_rollback-b') === undefined,
        'failed character record unexpectedly exists');
    assert(await readRecord('rp_hub_character_index') === undefined,
        'aborted migration committed the character index');
}

async function testScaledLargeRecordGuard() {
    await deleteDatabase();
    window.__charStoreConsoleErrors.length = 0;
    const card = {
        uuid: 'large-card',
        name: 'scaled 100MiB guard fixture',
        payload: 'x'.repeat(2 * 1024 * 1024)
    };

    const summary = await window.RPHubCharStore.saveAll([card]);
    const key = 'rp_hub_character_large-card';
    const warning = window.__charStoreConsoleErrors.find((message) => message.includes(key));
    assert(warning, 'large-record console.error omitted the record key');
    assert(/约 2\.00MiB/.test(warning), 'large-record console.error omitted the serialized size');
    assert(/仍将尝试写入/.test(warning), 'large-record console.error omitted the continued-write behavior');
    assert(summary.writtenKeys.includes(key), 'large record did not reach the put path after logging');
    assert((await readRecord(key))?.payload?.length === card.payload.length,
        'large record was not persisted after logging');
}

async function runStorageTests() {
    await deleteDatabase();
    const legacyCards = [
        { uuid: 'char-a', name: 'A', avatar: 'data:a' },
        { name: 'B', avatar: 'data:b' },
        { uuid: 'char-c', name: 'C', avatar: 'data:c' }
    ];
    const chatKey = 'rp_hub_chat_char-a';
    const memoryKey = 'rp_hub_memories_char-a';
    await seedRecords([
        ['rp_hub_characters', legacyCards],
        [chatKey, [{ role: 'user', content: 'hello' }]],
        [memoryKey, [{ summary: 'memory' }]]
    ]);

    const migrated = await window.RPHubCharStore.loadAll();
    assert(migrated.length === 3, 'migration did not return all cards');
    assert(migrated[0].uuid === 'char-a' && migrated[2].uuid === 'char-c', 'migration changed card order');
    assert(typeof migrated[1].uuid === 'string' && migrated[1].uuid.length > 0, 'missing UUID was not generated');
    assert(await readRecord('rp_hub_characters') === undefined, 'legacy record still exists');

    const index = await readRecord('rp_hub_character_index');
    assert(index.order.join(',') === migrated.map((card) => card.uuid).join(','), 'index order is incorrect');
    for (const card of migrated) {
        assert((await readRecord(`rp_hub_character_${card.uuid}`)).name === card.name, `missing split record ${card.uuid}`);
    }

    const loadedAgain = await window.RPHubCharStore.loadAll();
    assert(loadedAgain.length === 3, 'second load repeated or lost migration data');

    loadedAgain[1].name = 'B changed';
    const changedSummary = await window.RPHubCharStore.saveAll(loadedAgain);
    assert(changedSummary.writtenKeys.length === 1, 'incremental save rewrote more than one card');
    assert(changedSummary.writtenKeys[0] === `rp_hub_character_${loadedAgain[1].uuid}`, 'wrong card was rewritten');
    assert(changedSummary.indexWritten === false, 'unchanged order rewrote index');

    const removed = loadedAgain.pop();
    const deleteSummary = await window.RPHubCharStore.saveAll(loadedAgain);
    assert(deleteSummary.deletedKeys.length === 1, 'deleted card record was not removed exactly once');
    assert(deleteSummary.deletedKeys[0] === `rp_hub_character_${removed.uuid}`, 'wrong card record was deleted');
    assert(await readRecord(`rp_hub_character_${removed.uuid}`) === undefined, 'deleted card record remains');
    assert(Array.isArray(await readRecord(chatKey)), 'chat record was deleted with a card');
    assert(Array.isArray(await readRecord(memoryKey)), 'memory record was deleted with a card');

    const keys = await readAllKeys();
    assert(keys.includes('rp_hub_character_index'), 'character index disappeared');
    assert(!keys.includes('rp_hub_characters'), 'legacy monolithic key reappeared');

    await deleteDatabase();
    await seedRecords([
        ['rp_hub_characters', [
            { uuid: 'duplicate', name: 'one' },
            { uuid: 'duplicate', name: 'two' }
        ]]
    ]);
    let duplicateRejected = false;
    try {
        await window.RPHubCharStore.migrate();
    } catch (_) {
        duplicateRejected = true;
    }
    assert(duplicateRejected, 'duplicate UUID migration was not rejected');
    assert(Array.isArray(await readRecord('rp_hub_characters')), 'failed migration deleted the legacy record');
    assert(await readRecord('rp_hub_character_index') === undefined, 'failed migration committed an index');

    let followupSaveRejected = false;
    try {
        await window.RPHubCharStore.saveAll([]);
    } catch (_) {
        followupSaveRejected = true;
    }
    assert(followupSaveRejected, 'saveAll created an empty index after failed migration');
    assert(Array.isArray(await readRecord('rp_hub_characters')), 'follow-up save deleted failed migration data');
    assert(await readRecord('rp_hub_character_index') === undefined, 'follow-up save created an index over legacy data');

    await deleteDatabase();
    await seedRecords([['rp_hub_characters', [{ uuid: 'index', name: 'reserved' }]]]);
    let reservedRejected = false;
    try {
        await window.RPHubCharStore.migrate();
    } catch (_) {
        reservedRejected = true;
    }
    assert(reservedRejected, 'reserved UUID index was not rejected');
    assert(Array.isArray(await readRecord('rp_hub_characters')), 'reserved UUID failure deleted legacy data');
    assert(await readRecord('rp_hub_character_index') === undefined, 'reserved UUID overwrote the index key');

    await testMigrationRollbackAfterQueuedPut();
    await testPullRestoreMutationDeferral();
}

async function run() {
    const mode = new URLSearchParams(location.search).get('mode') || 'main';
    if (mode === 'unpatched') {
        let rejected = false;
        try {
            await window.RPHubCharStore.assertPushAllowed();
        } catch (error) {
            rejected = /上传已被阻止/.test(error.message);
        }
        assert(rejected, 'unpatched app.js did not block push');
        assert(window.__charStoreAlerts.length === 1, 'unpatched app.js did not show one visible warning');
        finish('pass', 'runtime self-check blocked push');
        return;
    }

    if (mode === 'fetch-failure') {
        await window.RPHubCharStore.assertPushAllowed();
        const audit = window.RPHubCharStore.getPatchAuditStatus();
        assert(audit.status === 'skipped', 'app.js fetch failure did not produce a skipped audit');
        assert(audit.reason === '', 'skipped audit exposed a blocking reason');
        assert(window.__charStoreAlerts.length === 0, 'app.js fetch failure showed an alert');
        assert(window.__charStoreConsoleErrors.length === 0, 'app.js fetch failure logged an error');
        finish('pass', 'runtime self-check fetch failure stayed silent and allowed push');
        return;
    }

    await window.RPHubCharStore.assertPushAllowed();
    assert(window.RPHubCharStore.getPatchAuditStatus().status === 'ok', 'patched app.js audit did not pass');
    if (mode === 'large-record') {
        await testScaledLargeRecordGuard();
        finish('pass', 'scaled 100MiB guard logged key/size and still persisted the card');
        return;
    }
    await runStorageTests();
    finish('pass', 'migration, incremental save, deletion isolation, queued-put rollback, and pull deferral');
}

try {
    await run();
} catch (error) {
    console.error(error);
    finish('fail', error?.stack || error?.message || String(error));
}
