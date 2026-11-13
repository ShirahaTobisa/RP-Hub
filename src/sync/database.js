    function openDbByName(dbName, version) {
        return new Promise((resolve, reject) => {
            const request = typeof version === 'number'
                ? indexedDB.open(dbName, version)
                : indexedDB.open(dbName);
            request.onerror = () => reject(request.error || new Error('IndexedDB open failed.'));
            request.onsuccess = () => resolve(request.result);
        });
    }

    function createObjectStoreFromSnapshot(db, storeDef) {
        if (db.objectStoreNames.contains(storeDef.name)) return;

        const options = {};
        if (storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined') {
            options.keyPath = storeDef.keyPath;
        }
        if (storeDef.autoIncrement) {
            options.autoIncrement = true;
        }

        db.createObjectStore(storeDef.name, options);
    }

    function openDbForRestore(dbDef) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(dbDef.name);

            request.onerror = () => reject(request.error || new Error('IndexedDB restore open failed.'));
            request.onupgradeneeded = () => {
                const db = request.result;
                for (const storeDef of dbDef.stores || []) {
                    createObjectStoreFromSnapshot(db, storeDef);
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                const missingStores = (dbDef.stores || [])
                    .filter((storeDef) => !db.objectStoreNames.contains(storeDef.name));

                if (missingStores.length === 0) {
                    resolve(db);
                    return;
                }

                const nextVersion = db.version + 1;
                db.close();

                const upgradeRequest = indexedDB.open(dbDef.name, nextVersion);
                upgradeRequest.onerror = () => reject(upgradeRequest.error || new Error('IndexedDB restore upgrade failed.'));
                upgradeRequest.onupgradeneeded = () => {
                    const upgradedDb = upgradeRequest.result;
                    for (const storeDef of dbDef.stores || []) {
                        createObjectStoreFromSnapshot(upgradedDb, storeDef);
                    }
                };
                upgradeRequest.onsuccess = () => resolve(upgradeRequest.result);
            };
        });
    }

    function isAppLocalStorageKey(key) {
        return key !== CONFIG.passwordStorageKey
            && !key.startsWith('rp_hub_sync_')
            && !CONFIG.ignoredLocalStorageKeys.includes(key)
            && (CONFIG.localStorageKeys.includes(key)
                || CONFIG.localStoragePrefixes.some((prefix) => key.startsWith(prefix)));
    }

    function readLocalStorageSnapshot() {
        const entries = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key === null || !isAppLocalStorageKey(key)) continue;
            entries.push({
                key,
                value: localStorage.getItem(key)
            });
        }
        entries.sort((a, b) => a.key.localeCompare(b.key));
        return entries;
    }

    function isWorkshopLocalStorageKey(key) {
        return key === 'rp_hub_workshop_modules_v1' || key.startsWith('rph_mod_')
            || CONFIG.localStorageKeys.includes(key);
    }

    function restoreLocalStorageSnapshot(entries) {
        clearAppLocalStorage();
        for (const entry of Array.isArray(entries) ? entries : []) {
            if (typeof entry?.key === 'string' && isAppLocalStorageKey(entry.key)) {
                localStorage.setItem(entry.key, String(entry.value ?? ''));
            }
        }
    }

    function clearAppLocalStorage() {
        const keysToRemove = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key !== null && isAppLocalStorageKey(key) && !isWorkshopLocalStorageKey(key)) {
                keysToRemove.push(key);
            }
        }
        for (const key of keysToRemove) {
            localStorage.removeItem(key);
        }
    }

    async function listIndexedDbNames() {
        const knownNames = CONFIG.knownDatabases.map((dbDef) => dbDef.name);

        if (typeof indexedDB.databases === 'function') {
            try {
                const databases = await indexedDB.databases();
                const existingNames = new Set((databases || [])
                    .map((dbInfo) => dbInfo?.name)
                    .filter((name) => typeof name === 'string' && name));
                return knownNames.filter((name) => existingNames.has(name));
            } catch (error) {
                // Some browsers expose indexedDB.databases but may reject it.
            }
        }

        return knownNames;
    }

    // afterKey 到 upper 之间的记录，按键的顺序；afterOpen / upperOpen 为 true 时不含那一端
    function readObjectStoreRecordBatch(db, storeName, afterKey, hasAfterKey, afterOpen, upper, upperOpen) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            const range = hasAfterKey
                ? (upper === undefined ? IDBKeyRange.lowerBound(afterKey, afterOpen) : IDBKeyRange.bound(afterKey, upper, afterOpen, upperOpen))
                : (upper === undefined ? null : IDBKeyRange.upperBound(upper, upperOpen));
            const records = [];
            const request = store.openCursor(range);

            request.onerror = () => reject(request.error || new Error('IndexedDB cursor read failed.'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve({ records, done: true, lastKey: afterKey });
                    return;
                }

                records.push({ key: cursor.key, value: cursor.value });
                if (records.length >= (db.name === 'RPHubWorkshop' ? 1 : CONFIG.readBatchSize)) {
                    resolve({ records, done: false, lastKey: cursor.key });
                    return;
                }
                cursor.continue();
            };
        });
    }

    // lower 到 upper 之间的记录；lowerOpen / upperOpen 为 true 时不含那一端
    async function* iterateObjectStoreRecords(db, storeName, lower, upper, upperOpen = true, lowerOpen = false) {
        let hasAfterKey = lower !== undefined;
        let afterKey = lower;
        let afterOpen = lowerOpen;

        while (true) {
            if (hasAfterKey && upper !== undefined) {
                const order = indexedDB.cmp(afterKey, upper);
                if (order > 0 || (order === 0 && (afterOpen || upperOpen))) return;
            }
            const batch = await readObjectStoreRecordBatch(db, storeName, afterKey, hasAfterKey, afterOpen, upper, upperOpen);
            for (const record of batch.records) yield record;
            if (batch.done) return;
            hasAfterKey = true;
            afterOpen = true;
            afterKey = batch.lastKey;
            await wait(0);
        }
    }

    function readStoreDefinitions(db, storeNames) {
        return storeNames.map((storeName) => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            return {
                name: storeName,
                keyPath: store.keyPath,
                autoIncrement: Boolean(store.autoIncrement)
            };
        });
    }

    function stableKeyToken(key) {
        return JSON.stringify(key);
    }

    function readObjectStoreKeys(db, storeName) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readonly');
            const keys = [];
            const request = tx.objectStore(storeName).openKeyCursor();

            request.onerror = () => reject(request.error || new Error('IndexedDB key read failed.'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve(keys);
                    return;
                }
                keys.push(cursor.key);
                cursor.continue();
            };
        });
    }

    async function deleteObjectStoreKeys(db, storeName, keys) {
        for (let start = 0; start < keys.length; start += CONFIG.restoreBatchSize) {
            const batch = keys.slice(start, start + CONFIG.restoreBatchSize);
            await new Promise((resolve, reject) => {
                const tx = db.transaction([storeName], 'readwrite');
                const store = tx.objectStore(storeName);
                let firstError = null;
                const abortWith = (error, event) => {
                    event?.preventDefault?.();
                    firstError ||= error;
                    try { tx.abort(); } catch {}
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => { firstError ||= tx.error || new Error('IndexedDB cleanup failed.'); };
                tx.onabort = () => reject(firstError || tx.error || new Error('IndexedDB cleanup failed.'));
                for (const key of batch) {
                    const request = store.delete(key);
                    request.onerror = (event) => abortWith(
                        new Error(`清理本地多余记录 ${String(key)} 失败。`, { cause: request.error }),
                        event
                    );
                }
            });
            await wait(0);
        }
    }

    async function deleteMissingObjectStoreRecords(db, storeName, incomingKeyTokens) {
        const existingKeys = await readObjectStoreKeys(db, storeName);
        const keysToDelete = existingKeys.filter((key) => !incomingKeyTokens.has(stableKeyToken(key)));
        await deleteObjectStoreKeys(db, storeName, keysToDelete);
    }

    /* @shared/database */

    function writeObjectStoreRecordBatch(db, storeDef, records) {
        if (!Array.isArray(records) || !records.length) return Promise.resolve();
        return withStore(db, storeDef.name, 'readwrite', (store, abort) => {
            for (const record of records) {
                const request = storeDef.keyPath != null ? store.put(record.value) : store.put(record.value, record.key);
                request.onerror = event => {
                    event.preventDefault();
                    abort(new Error('恢复记录 ' + record.key + ' 失败。', { cause: request.error }));
                };
            }
        });
    }

    function clearObjectStore(db, storeName) {
        if (!db.objectStoreNames.contains(storeName)) return Promise.resolve();
        return withStore(db, storeName, 'readwrite', store => { store.clear(); });
    }

    async function clearKnownIndexedDbStores(dbDef, storeNames) {
        const dbNames = await listIndexedDbNames();
        if (!dbNames.includes(dbDef.name)) return;

        const db = await openDbByName(dbDef.name);
        try {
            for (const storeName of storeNames) {
                await clearObjectStore(db, storeName);
            }
        } finally {
            db.close();
        }
    }

    function expandLegacyCharacterRecord(dbName, storeName, record) {
        if (dbName !== 'RPHubDB' || storeName !== 'store' || record?.key !== 'rp_hub_characters' || !Array.isArray(record.value)) {
            return [record];
        }
        const records = [];
        const order = [];
        const seen = new Set();
        for (const [index, character] of record.value.entries()) {
            if (!character || typeof character !== 'object' || Array.isArray(character)) {
                throw new TypeError(`旧快照第 ${index + 1} 张角色卡格式无效，已取消恢复。`);
            }
            const rawUuid = character.uuid;
            let uuid;
            if (rawUuid === undefined || rawUuid === null || rawUuid === '') {
                uuid = crypto.randomUUID();
                character.uuid = uuid;
            } else if (typeof rawUuid !== 'string') {
                throw new TypeError(`旧快照第 ${index + 1} 张角色卡 UUID 不是字符串，已取消恢复。`);
            } else {
                uuid = rawUuid;
            }
            if (uuid === 'index') {
                throw new Error('旧快照角色卡 UUID index 与角色卡索引键冲突，已取消恢复。');
            }
            if (seen.has(uuid)) {
                throw new Error(`旧快照角色卡 UUID 重复：${uuid}。为避免合并存档，已取消恢复。`);
            }
            seen.add(uuid);
            order.push(uuid);
            records.push({ key: `rp_hub_character_${uuid}`, value: character });
        }
        records.push({ key: 'rp_hub_character_index', value: { order } });
        return records;
    }

    async function syncObjectStoreRecords(db, storeDef) {
        const records = (Array.isArray(storeDef.records) ? storeDef.records : [])
            .flatMap((record) => expandLegacyCharacterRecord(storeDef.databaseName, storeDef.name, record));
        const incomingKeys = new Set(records.map((record) => stableKeyToken(record.key)));
        await new Promise((resolve, reject) => {
            const tx = db.transaction([storeDef.name], 'readwrite');
            const store = tx.objectStore(storeDef.name);
            let firstError = null;

            const abortWith = (error, event) => {
                event?.preventDefault?.();
                firstError ||= error;
                try { tx.abort(); } catch {}
            };
            const trackPut = (request, record) => {
                request.onerror = (event) => {
                    const serialized = JSON.stringify(record.value);
                    const size = new TextEncoder().encode(serialized).byteLength;
                    abortWith(new Error(`恢复失败:记录 ${record.key}(约 ${(size / 1024 / 1024).toFixed(2)}MB)写入被浏览器拒绝(单条记录上限约127MB)。`), event);
                };
            };

            tx.oncomplete = () => resolve();
            tx.onerror = () => {
                firstError ||= tx.error || new Error('IndexedDB restore failed.');
            };
            tx.onabort = () => reject(firstError || tx.error || new Error('IndexedDB restore failed.'));

            for (const record of records) {
                const request = storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined'
                    ? store.put(record.value)
                    : store.put(record.value, record.key);
                trackPut(request, record);
            }

            const cursorRequest = store.openCursor();
            cursorRequest.onerror = (event) => abortWith(
                cursorRequest.error || new Error('IndexedDB cleanup scan failed.'),
                event
            );
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor) return;
                if (!incomingKeys.has(stableKeyToken(cursor.key))) {
                    const key = cursor.key;
                    const deleteRequest = cursor.delete();
                    deleteRequest.onerror = (event) => abortWith(
                        new Error(`清理本地多余记录 ${String(key)} 失败。`, { cause: deleteRequest.error }),
                        event
                    );
                }
                cursor.continue();
            };
        });
    }

    async function replaceIndexedDbSnapshot(databases) {
        const incomingDbMap = new Map((Array.isArray(databases) ? databases : [])
            .filter((dbDef) => dbDef && typeof dbDef.name === 'string')
            .map((dbDef) => [dbDef.name, dbDef]));

        for (const dbDef of Array.isArray(databases) ? databases : []) {
            if (!dbDef || typeof dbDef.name !== 'string') continue;
            const knownDb = CONFIG.knownDatabases.find((item) => item.name === dbDef.name);
            if (!knownDb) continue;

            const stores = (Array.isArray(dbDef.stores) ? dbDef.stores : [])
                .filter((storeDef) => knownDb.stores.includes(storeDef?.name));
            if (stores.length === 0) continue;

            const db = await openDbForRestore(dbDef);
            try {
                for (const storeDef of stores) {
                    if (!db.objectStoreNames.contains(storeDef.name)) continue;
                    await syncObjectStoreRecords(db, { ...storeDef, databaseName: dbDef.name });
                }
            } finally {
                db.close();
            }
        }

        for (const knownDb of CONFIG.knownDatabases) {
            const incomingDb = incomingDbMap.get(knownDb.name);
            if (!incomingDb) {
                if (knownDb.workshop) continue;
                await clearKnownIndexedDbStores(knownDb, knownDb.stores);
                continue;
            }

            const incomingStoreNames = new Set((Array.isArray(incomingDb.stores) ? incomingDb.stores : [])
                .map((storeDef) => storeDef?.name)
                .filter((storeName) => knownDb.stores.includes(storeName)));
            const missingStores = knownDb.stores.filter((storeName) => !incomingStoreNames.has(storeName));
            if (missingStores.length > 0) {
                await clearKnownIndexedDbStores(knownDb, missingStores);
            }
        }
    }

    async function replaceLocalSnapshot(snapshot) {
        if (snapshot && Array.isArray(snapshot.indexedDB)) {
            await replaceIndexedDbSnapshot(snapshot.indexedDB);
        }

        if (snapshot && Array.isArray(snapshot.localStorage)) {
            restoreLocalStorageSnapshot(snapshot.localStorage);
        }
    }

