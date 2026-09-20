const MAX_RECORD_BYTES = 100 * 1024 * 1024;
const CHARACTER_PREFIX = 'rp_hub_character_';
const CHARACTER_INDEX_KEY = 'rp_hub_character_index';
const LEGACY_CHARACTER_KEY = 'rp_hub_characters';
const CHAT_PREFIX = 'rp_hub_chat_';
const MEMORY_PREFIX = 'rp_hub_memories_';
const encoder = new TextEncoder();

function requireCondition(condition) {
    if (!condition) throw new Error('Real backup verification failed.');
}

function isAppLocalStorageKey(key) {
    return typeof key === 'string'
        && key !== 'rp_hub_sync_password_v1'
        && !key.startsWith('rp_hub_sync_')
        && key !== 'roleplay_hub_update_id'
        && (key.startsWith('rp_hub_') || key.startsWith('ai_chargen_'));
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('IndexedDB request failed.'));
    });
}

function deleteDatabase(name) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error('IndexedDB cleanup failed.'));
        request.onblocked = () => reject(new Error('IndexedDB cleanup blocked.'));
    });
}

function openExistingDatabase(name, storeName) {
    return new Promise((resolve, reject) => {
        let upgraded = false;
        const request = indexedDB.open(name);
        request.onupgradeneeded = () => {
            upgraded = true;
            request.transaction.abort();
        };
        request.onerror = () => reject(new Error('IndexedDB open failed.'));
        request.onsuccess = () => {
            if (upgraded || !request.result.objectStoreNames.contains(storeName)) {
                request.result.close();
                reject(new Error('IndexedDB store missing.'));
                return;
            }
            resolve(request.result);
        };
    });
}

function seedStaleRphRecord() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('store')) {
                request.result.createObjectStore('store');
            }
        };
        request.onerror = () => reject(new Error('IndexedDB seed open failed.'));
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(['store'], 'readwrite');
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(new Error('IndexedDB seed failed.'));
            };
            tx.objectStore('store').put({ testOnly: true }, '__rph_real_backup_stale__');
        };
    });
}

async function getAllKeys(db, storeName) {
    const tx = db.transaction([storeName], 'readonly');
    return requestResult(tx.objectStore(storeName).getAllKeys());
}

async function getValue(db, storeName, key) {
    const tx = db.transaction([storeName], 'readonly');
    return requestResult(tx.objectStore(storeName).get(key));
}

function transactionDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
}

async function applyRecordChanges(db, storeName, changes) {
    const tx = db.transaction([storeName], 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(storeName);
    for (const change of changes) {
        if (change.type === 'delete') store.delete(change.key);
        else store.put(change.value, change.key);
    }
    await done;
}

async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function compareDescriptor(left, right) {
    for (let index = 0; index < 3; index += 1) {
        if (left[index] < right[index]) return -1;
        if (left[index] > right[index]) return 1;
    }
    return 0;
}

function cdcSignature(chunk) {
    return `${chunk.checksum}:${chunk.length}`;
}

function assertCdcDelta(before, after, label) {
    const beforeSet = new Set(before.map(cdcSignature));
    const afterSet = new Set(after.map(cdcSignature));
    const newOnly = after.filter((chunk) => !beforeSet.has(cdcSignature(chunk)));
    const oldOnly = before.filter((chunk) => !afterSet.has(cdcSignature(chunk)));
    requireCondition(newOnly.length >= 1 && newOnly.length <= 3);
    requireCondition(oldOnly.length <= 3);
    return { label, newChunks: newOnly.length, retiredChunks: oldOnly.length };
}

async function runRealCdcChecks(api) {
    const db = await openExistingDatabase('RPHubDB', 'store');
    try {
        const keys = await getAllKeys(db, 'store');
        const chatKey = keys.find((key) => typeof key === 'string' && key.startsWith(CHAT_PREFIX));
        requireCondition(typeof chatKey === 'string');
        const originalChat = await getValue(db, 'store', chatKey);
        const originalIndex = await getValue(db, 'store', CHARACTER_INDEX_KEY);
        requireCondition(originalIndex && Array.isArray(originalIndex.order));

        globalThis.__realBackupIterateProfiles = [];
        const base = await api.scanStreamSnapshot('cdc');
        requireCondition(base.totalBytes >= 64 * 1024 * 1024);
        requireCondition(base.chunkManifest.length > 1);
        requireCondition(base.chunkManifest.every((chunk) =>
            chunk.length > 0 && chunk.length <= 8 * 1024 * 1024));
        const checksumSource = JSON.stringify([
            'rp-sync-jsonl-v1',
            4,
            Number(base.recordCount),
            Number(base.totalBytes),
            base.chunkManifest.map((chunk) => [String(chunk.checksum).toLowerCase(), Number(chunk.length)])
        ]);
        requireCondition(await sha256(checksumSource) === base.checksum);

        const changedChat = Array.isArray(originalChat)
            ? [...originalChat, { role: 'user', content: 'cdc-single-chat-edit' }]
            : { ...originalChat, cdcEdit: true };
        await applyRecordChanges(db, 'store', [{ key: chatKey, value: changedChat }]);
        const changedDelta = assertCdcDelta(
            base.chunkManifest,
            (await api.scanStreamSnapshot('cdc')).chunkManifest,
            'chat'
        );
        await applyRecordChanges(db, 'store', [{ key: chatKey, value: originalChat }]);

        const newUuid = 'cdc-new-character-20260717';
        await applyRecordChanges(db, 'store', [
            {
                key: `rp_hub_character_${newUuid}`,
                value: { uuid: newUuid, name: 'CDC 新角色', description: 'incremental test' }
            },
            {
                key: CHARACTER_INDEX_KEY,
                value: { ...originalIndex, order: [...originalIndex.order, newUuid] }
            }
        ]);
        const addedDelta = assertCdcDelta(
            base.chunkManifest,
            (await api.scanStreamSnapshot('cdc')).chunkManifest,
            'character-add'
        );
        await applyRecordChanges(db, 'store', [
            { type: 'delete', key: `rp_hub_character_${newUuid}` },
            { key: CHARACTER_INDEX_KEY, value: originalIndex }
        ]);

        await applyRecordChanges(db, 'store', [{ type: 'delete', key: chatKey }]);
        const deletedDelta = assertCdcDelta(
            base.chunkManifest,
            (await api.scanStreamSnapshot('cdc')).chunkManifest,
            'record-delete'
        );
        await applyRecordChanges(db, 'store', [{ key: chatKey, value: originalChat }]);

        const restored = await api.scanStreamSnapshot('cdc');
        requireCondition(JSON.stringify(restored.chunkManifest.map(cdcSignature))
            === JSON.stringify(base.chunkManifest.map(cdcSignature)));
        requireCondition(globalThis.__realBackupIterateProfiles.length === 5);
        requireCondition(globalThis.__realBackupIterateProfiles.every((profile) => profile === 'cdc'));

        return {
            baseChunks: base.chunkManifest.length,
            totalBytes: base.totalBytes,
            changedDelta,
            addedDelta,
            deletedDelta
        };
    } finally {
        db.close();
    }
}

async function verifyRestoredData(expected) {
    const descriptors = [];
    const characterUuids = new Set();
    const characterNames = new Map();
    let characterIndex = null;
    let legacyCharacters = 0;
    let characters = 0;
    let chats = 0;
    let memories = 0;
    let aiCharGenRecords = 0;
    let maxRecordBytes = 0;

    for (const definition of [
        { database: 'RPHubDB', store: 'store' },
        { database: 'AICharGen', store: 'characters' }
    ]) {
        const db = await openExistingDatabase(definition.database, definition.store);
        try {
            const keys = await getAllKeys(db, definition.store);
            for (const key of keys) {
                const value = await getValue(db, definition.store, key);
                const keyToken = JSON.stringify(key);
                const valueJson = JSON.stringify(value);
                requireCondition(typeof keyToken === 'string' && typeof valueJson === 'string');
                const recordBytes = encoder.encode(valueJson).byteLength;
                maxRecordBytes = Math.max(maxRecordBytes, recordBytes);
                descriptors.push([
                    definition.database,
                    definition.store,
                    keyToken,
                    await sha256(valueJson)
                ]);

                if (definition.database === 'AICharGen') {
                    aiCharGenRecords += 1;
                    continue;
                }
                if (key === LEGACY_CHARACTER_KEY) legacyCharacters += 1;
                if (key === CHARACTER_INDEX_KEY) {
                    requireCondition(characterIndex === null);
                    characterIndex = value;
                    continue;
                }
                if (typeof key === 'string' && key.startsWith(CHARACTER_PREFIX)) {
                    requireCondition(value && typeof value === 'object' && !Array.isArray(value));
                    requireCondition(typeof value.uuid === 'string' && key === `${CHARACTER_PREFIX}${value.uuid}`);
                    requireCondition(!characterUuids.has(value.uuid));
                    characterUuids.add(value.uuid);
                    characters += 1;
                    if (typeof value.name === 'string') {
                        const group = characterNames.get(value.name) || [];
                        group.push(value.uuid);
                        characterNames.set(value.name, group);
                    }
                    continue;
                }
                if (typeof key === 'string' && key.startsWith(CHAT_PREFIX)) chats += 1;
                if (typeof key === 'string' && key.startsWith(MEMORY_PREFIX)) memories += 1;
            }
        } finally {
            db.close();
        }
    }

    requireCondition(legacyCharacters === 0);
    requireCondition(characterIndex && Array.isArray(characterIndex.order));
    const indexSet = new Set(characterIndex.order);
    requireCondition(characterIndex.order.length === expected.indexEntries);
    requireCondition(indexSet.size === expected.indexEntries);
    requireCondition(characterUuids.size === expected.characters);
    requireCondition([...characterUuids].every((uuid) => indexSet.has(uuid)));

    let duplicateNameGroups = 0;
    for (const uuids of characterNames.values()) {
        if (uuids.length <= 1) continue;
        duplicateNameGroups += 1;
        requireCondition(new Set(uuids).size === uuids.length);
    }

    descriptors.sort(compareDescriptor);
    const knownRecordDigest = await sha256(JSON.stringify(descriptors));
    const localStorageEntries = [];
    for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (isAppLocalStorageKey(key)) {
            localStorageEntries.push({ key, value: localStorage.getItem(key) });
        }
    }
    localStorageEntries.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const localStorageDigest = await sha256(JSON.stringify(localStorageEntries));

    requireCondition(characters === 45 && characters === expected.characters);
    requireCondition(chats === 45 && chats === expected.chats);
    requireCondition(memories === 62 && memories === expected.memories);
    requireCondition(aiCharGenRecords === expected.aiCharGenRecords && aiCharGenRecords > 0);
    requireCondition(descriptors.length === expected.knownRecords);
    requireCondition(localStorageEntries.length === expected.localStorageRecords);
    requireCondition(maxRecordBytes === expected.maxRecordBytes && maxRecordBytes < MAX_RECORD_BYTES);
    requireCondition(duplicateNameGroups === expected.duplicateNameGroups);
    requireCondition(knownRecordDigest === expected.knownRecordDigest);
    requireCondition(localStorageDigest === expected.localStorageDigest);

    return {
        characters,
        indexEntries: characterIndex.order.length,
        chats,
        memories,
        aiCharGenRecords,
        duplicateNameGroups,
        localStorageRecords: localStorageEntries.length
    };
}

async function run() {
    const api = globalThis.__RPHRealBackupTest;
    requireCondition(api && typeof api.pullFromServer === 'function');
    const expectedResponse = await fetch('/tests/real-offline-backup.expected.json', { cache: 'no-store' });
    requireCondition(expectedResponse.ok);
    const expected = await expectedResponse.json();
    requireCondition(expected.schemaVersion === 3);
    requireCondition(typeof api.scanStreamSnapshot === 'function');

    await deleteDatabase('RPHubDB');
    await deleteDatabase('AICharGen');
    await seedStaleRphRecord();
    localStorage.clear();
    localStorage.setItem('rp_hub_real_backup_stale', 'remove-on-pull');

    const nativeSetTimeout = globalThis.setTimeout;
    let blockedReloads = 0;
    globalThis.setTimeout = (callback, delay, ...args) => {
        if (Number(delay) === 700) {
            blockedReloads += 1;
            return 0;
        }
        return nativeSetTimeout(callback, delay, ...args);
    };
    try {
        await api.pullFromServer();
    } finally {
        globalThis.setTimeout = nativeSetTimeout;
    }

    requireCondition(blockedReloads === 1);
    requireCondition(/页面即将刷新/.test(api.state.statusText));
    requireCondition(localStorage.getItem('rp_hub_real_backup_stale') === null);
    const counts = await verifyRestoredData(expected);
    const cdcReport = await runRealCdcChecks(api);
    await globalThis.__finishRealBackupTest('pass', [
        'PASS',
        `characters=${counts.characters}`,
        `index=${counts.indexEntries}`,
        `chats=${counts.chats}`,
        `memories=${counts.memories}`,
        `aiCharGenRecords=${counts.aiCharGenRecords}`,
        `duplicateNameGroups=${counts.duplicateNameGroups}`,
        `localStorageRecords=${counts.localStorageRecords}`,
        'maxUnder100MiB=1',
        'completeDigest=1',
        `streamBytes=${cdcReport.totalBytes}`,
        `cdcBaseChunks=${cdcReport.baseChunks}`,
        `cdcChatNew=${cdcReport.changedDelta.newChunks}`,
        `cdcChatRetired=${cdcReport.changedDelta.retiredChunks}`,
        `cdcAddNew=${cdcReport.addedDelta.newChunks}`,
        `cdcAddRetired=${cdcReport.addedDelta.retiredChunks}`,
        `cdcDeleteNew=${cdcReport.deletedDelta.newChunks}`,
        `cdcDeleteRetired=${cdcReport.deletedDelta.retiredChunks}`
    ].join(' '));
}

try {
    await run();
} catch (error) {
    await globalThis.__finishRealBackupTest(
        'fail',
        `FAIL: ${error?.stack || error?.message || String(error)}`
    );
}
