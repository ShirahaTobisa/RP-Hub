(function () {
    const SNAPSHOT_FORMAT = 'rp-sync-jsonl-v1';
    const SNAPSHOT_SCHEMA_VERSION = 4;
    const LEGACY_SNAPSHOT_FORMAT = 'rp-sync-json-v3';
    const CHUNKER_PROFILE = 'rph-jsonl-cdc-fnv1a-v1';
    const DOWNLOAD_STAGING_DB = 'RPHubSyncStaging';
    const DOWNLOAD_CACHE_DB = 'RPHubSyncChunkCache';
    const DOWNLOAD_STAGING_STORE = 'chunks';
    const PAGE_SCOPE = ['/', '/index.html'];
    if (!PAGE_SCOPE.includes(location.pathname)) {
        return;
    }

    const CONFIG = {
        apiEndpoint: '/api/rp-sync',
        passwordStorageKey: 'rp_hub_sync_password_v1',
        upstreamNoticeKey: 'roleplay_hub_update_id',
        knownDatabases: [
            { name: 'RPHubDB', stores: ['store'] },
            { name: 'AICharGen', stores: ['characters'] },
            { name: 'RPHubWorkshop', stores: ['scripts', 'data'], workshop: true }
        ],
        localStoragePrefixes: ['rp_hub_', 'ai_chargen_', 'rph_mod_'],
        localStorageKeys: [
            'rphub_notes_v1', 'rphub_moments_v1', 'rphub_split_apis_v1', 'rphub_split_apis_v2',
            'rphub_user_temperature_pref', 'rphub_user_stream_pref', 'rphub_user_characterview_pref',
            'rphub_theme_color_v1', 'rphub_theme_custom_slots_v1', 'rphub_theme_custom_names_v1',
            'rphub_splash_custom_v1', 'rphub_splash_list_v1', 'rphub_presence_days_v1',
            'sakura_gramophone_playlist_v6', 'sakura_gramophone_settings_v1'
        ],
        ignoredLocalStorageKeys: ['roleplay_hub_update_id'],
        chunkSize: 2 * 1024 * 1024,
        maxSnapshotBytes: 1024 * 1024 * 1024,
        maxRecordBytes: 100 * 1024 * 1024,
        warnRecordBytes: 32 * 1024 * 1024,
        uploadPartConcurrency: 6,
        downloadPartConcurrency: 3,
        jsonDownloadPartChunks: 8,
        downloadTaskConcurrency: 2,
        downloadRangeBytes: 16 * 1024 * 1024,
        downloadPendingBytes: 32 * 1024 * 1024,
        downloadCacheBytes: 256 * 1024 * 1024,
        requestTimeoutMs: 60_000,
        uploadPartTimeoutMs: 120_000,
        commitTimeoutMs: 120_000,
        retryCount: 3,
        retryDelayMs: 600,
        readBatchSize: 4,
        restoreBatchSize: 16
    };

    const CDC_HARD_MAX_BYTES = 8 * 1024 * 1024;
    const LEGACY_FIXED_CHUNK_BYTES = 8 * 1024 * 1024;
    const FNV1A_OFFSET_BASIS = 0x811c9dc5;
    const FNV1A_PRIME = 0x01000193;
    const UINT32_RANGE = 0x100000000;

    const state = {
        syncing: false,
        syncLockHeld: false,
        reloadPending: false,
        progress: 0,
        statusText: '请选择同步方向。'
    };

    const deferredPersistenceWrites = [];
    let deferredPersistenceReleasePromise = null;

    function deferPersistenceWrite(operation) {
        if (typeof operation !== 'function') {
            return Promise.reject(new TypeError('延迟持久化操作必须是函数。'));
        }
        if (globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS !== true) {
            return Promise.resolve().then(operation);
        }
        return new Promise((resolve, reject) => {
            deferredPersistenceWrites.push({ operation, resolve, reject });
        });
    }

    {
        // 1.8.1+ 上游存储外置适配：RPHubStorage 赋值拦截门禁（等价于旧版 app.js 内注入的 pull-restore 写门禁）
        let rphubStorageValue;
        const setMethodArguments = new Map([
            ['setStoredValue', { valueIndex: 1, optionsIndex: 2 }],
            ['setScopedStoredValue', { valueIndex: 2, optionsIndex: 3 }]
        ]);
        const writeMethodNames = [
            'setStoredValue',
            'setScopedStoredValue',
            'deleteStoredValue',
            'deleteScopedStoredValue',
            'deleteStorageKeys'
        ];
        const wrapWriteMethod = (storage, methodName) => {
            const originalMethod = storage[methodName];
            if (typeof originalMethod !== 'function') return originalMethod;
            const setArguments = setMethodArguments.get(methodName);
            return function (...args) {
                if (globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS !== true) {
                    return Reflect.apply(originalMethod, storage, args);
                }
                const defer = globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE;
                if (typeof defer !== 'function') {
                    return Promise.reject(new Error('RP Sync 恢复写入队列不可用，已停止持久化。'));
                }
                const deferredArgs = args.slice();
                if (setArguments) {
                    const options = deferredArgs[setArguments.optionsIndex];
                    if (options?.clone !== false) {
                        deferredArgs[setArguments.valueIndex] = Reflect.apply(
                            storage.cloneForStorage,
                            storage,
                            [deferredArgs[setArguments.valueIndex]]
                        );
                    }
                    deferredArgs[setArguments.optionsIndex] = { ...options, clone: false };
                }
                return defer(() => Reflect.apply(originalMethod, storage, deferredArgs));
            };
        };

        Object.defineProperty(window, 'RPHubStorage', {
            configurable: true,
            enumerable: true,
            get() {
                return rphubStorageValue;
            },
            set(value) {
                const ownKeys = value !== null && typeof value === 'object'
                    ? Reflect.ownKeys(value)
                    : [];
                if (ownKeys.length === 0) {
                    rphubStorageValue = value;
                    return;
                }
                const wrapped = {};
                for (const key of ownKeys) {
                    Object.defineProperty(wrapped, key, {
                        configurable: true,
                        enumerable: Object.prototype.propertyIsEnumerable.call(value, key),
                        writable: true,
                        value: value[key]
                    });
                }
                for (const methodName of writeMethodNames) {
                    if (typeof value[methodName] !== 'function') continue;
                    Object.defineProperty(wrapped, methodName, {
                        configurable: true,
                        enumerable: Object.prototype.propertyIsEnumerable.call(value, methodName),
                        writable: true,
                        value: wrapWriteMethod(value, methodName)
                    });
                }
                rphubStorageValue = Object.freeze(wrapped);
            }
        });
    }

    async function releaseDeferredPersistenceWrites() {
        if (deferredPersistenceReleasePromise) return deferredPersistenceReleasePromise;
        deferredPersistenceReleasePromise = (async () => {
            const errors = [];
            while (deferredPersistenceWrites.length > 0) {
                const batch = deferredPersistenceWrites.splice(0);
                for (const entry of batch) {
                    try {
                        entry.resolve(await entry.operation());
                    } catch (error) {
                        entry.reject(error);
                        errors.push(error);
                    }
                }
                await Promise.resolve();
            }
            if (errors.length > 0) throw errors[0];
        })();
        try {
            return await deferredPersistenceReleasePromise;
        } finally {
            deferredPersistenceReleasePromise = null;
        }
    }

    globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE = deferPersistenceWrite;

    let syncEntry = null;
    let syncReturnFocus = null;
    let modalRoot = null;
    let modalTitle = null;
    let modalStatus = null;
    let modalProgressBar = null;
    let modalProgressValue = null;
    let pullButton = null;
    let pushButton = null;
    let appUpdateCheckButton = null;
    let appUpdateApplyButton = null;
    let appUpdateRollbackButton = null;
    let selfUpdateCheckButton = null;
    let selfUpdateApplyButton = null;
    let selfUpdateRollbackButton = null;
    let selfUpdateInfo = null;
    let selfUpdateStatus = null;
    let selfUpdateVersionButton = null;
    let selfUpdateVersionMenu = null;
    let selfUpdateSelected = null;
    let appUpdateVersionButton = null;
    let appUpdateVersionMenu = null;
    let appUpdateSelectedTarget = '';
    let closeButton = null;
    let confirmLayer = null;
    let confirmTitle = null;
    let confirmMessage = null;
    let confirmCancelButton = null;
    let confirmSubmitButton = null;
    let confirmResolve = null;
    let estimatedProgressTimer = null;
    let passwordModalRoot = null;
    let passwordInput = null;
    let passwordStatus = null;
    let passwordSubmitButton = null;
    let checkingPassword = false;

    function prepareReleaseNoticeGate() {
        if (localStorage.getItem(CONFIG.upstreamNoticeKey) === '999999999') {
            localStorage.removeItem(CONFIG.upstreamNoticeKey);
        }
    }

    prepareReleaseNoticeGate();

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function getStoredSyncPassword() {
        return localStorage.getItem(CONFIG.passwordStorageKey) || '';
    }

    function saveStoredSyncPassword(password) {
        localStorage.setItem(CONFIG.passwordStorageKey, password);
    }

    function clearStoredSyncPassword() {
        localStorage.removeItem(CONFIG.passwordStorageKey);
    }

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

    function readObjectStoreRecordBatch(db, storeName, afterKey, hasAfterKey) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeName], 'readonly');
            const store = tx.objectStore(storeName);
            const range = hasAfterKey ? IDBKeyRange.lowerBound(afterKey, true) : null;
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

    async function* iterateObjectStoreRecords(db, storeName) {
        let hasAfterKey = false;
        let afterKey;

        while (true) {
            const batch = await readObjectStoreRecordBatch(db, storeName, afterKey, hasAfterKey);
            for (const record of batch.records) yield record;
            if (batch.done) return;
            hasAfterKey = true;
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

    function writeObjectStoreRecordBatch(db, storeDef, records) {
        if (!Array.isArray(records) || records.length === 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([storeDef.name], 'readwrite');
            const store = tx.objectStore(storeDef.name);
            let firstError = null;

            const abortWith = (error, event) => {
                event?.preventDefault?.();
                firstError ||= error;
                try { tx.abort(); } catch {}
            };
            tx.oncomplete = () => resolve();
            tx.onerror = () => { firstError ||= tx.error || new Error('IndexedDB restore failed.'); };
            tx.onabort = () => reject(firstError || tx.error || new Error('IndexedDB restore failed.'));

            for (const record of records) {
                const request = storeDef.keyPath !== null && typeof storeDef.keyPath !== 'undefined'
                    ? store.put(record.value)
                    : store.put(record.value, record.key);
                request.onerror = (event) => {
                    const serialized = JSON.stringify(record.value);
                    const size = new TextEncoder().encode(serialized).byteLength;
                    abortWith(new Error(`恢复失败:记录 ${record.key}(约 ${(size / 1024 / 1024).toFixed(2)}MB)写入被浏览器拒绝(单条记录上限约127MB)。`), event);
                };
            }
        });
    }

    function clearObjectStore(db, storeName) {
        return new Promise((resolve, reject) => {
            if (!db.objectStoreNames.contains(storeName)) {
                resolve();
                return;
            }

            const tx = db.transaction([storeName], 'readwrite');
            const store = tx.objectStore(storeName);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed.'));
            store.clear();
        });
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

    async function sha256(text) {
        return sha256Bytes(new TextEncoder().encode(text));
    }

    async function sha256Bytes(bytes) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    function serializeSnapshotLine(value) {
        const json = JSON.stringify(value);
        if (typeof json !== 'string') throw new Error('本地数据包含无法序列化的内容。');
        return `${json}\n`;
    }

    const snapshotEncoder = new TextEncoder();

    function serializeStreamRecord(metadata, key, value) {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== 'string') throw new Error(`记录 ${String(key)} 无法序列化。`);
        const prefix = JSON.stringify(metadata).slice(0, -1) + ',"value":';
        // toJSON may depend on its key; retain the old semantics for it.
        if (value && typeof value.toJSON === 'function') {
            checkStreamRecordSize(key, snapshotEncoder.encode(serialized).byteLength);
            return snapshotEncoder.encode(serializeSnapshotLine({ ...metadata, value }));
        }
        const bytes = snapshotEncoder.encode(prefix + serialized + '}\n');
        checkStreamRecordSize(key, bytes.byteLength - snapshotEncoder.encode(prefix).byteLength - 2);
        return bytes;
    }

    function checkStreamRecordSize(key, size) {
        if (size > CONFIG.maxRecordBytes) {
            throw new Error(`上传已取消：记录 ${String(key)} 约 ${(size / 1024 / 1024).toFixed(2)}MB，超过单条上限100MiB。`);
        }
        if (size > CONFIG.warnRecordBytes) {
            console.warn(`[RP Sync] Large record ${String(key)}: ${(size / 1024 / 1024).toFixed(2)}MB`);
        }
    }

    async function* iterateSnapshotLines(stats) {
        yield serializeSnapshotLine({
            type: 'snapshot',
            format: SNAPSHOT_FORMAT,
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            workshopVersion: 1
        });

        for (const entry of readLocalStorageSnapshot()) {
            stats.recordCount += 1;
            yield serializeSnapshotLine({ type: 'localStorage', key: entry.key, value: entry.value });
        }
        yield serializeSnapshotLine({ type: 'localStorageEnd' });

        const dbNames = await listIndexedDbNames();
        for (const dbName of dbNames) {
            const knownDb = CONFIG.knownDatabases.find((dbDef) => dbDef.name === dbName);
            if (!knownDb) continue;

            let db = null;
            try {
                db = await openDbByName(dbName);
                const storeNames = knownDb.stores.filter((name) => db.objectStoreNames.contains(name));
                if (storeNames.length === 0) continue;
                const stores = readStoreDefinitions(db, storeNames);
                yield serializeSnapshotLine({ type: 'database', name: dbName, version: db.version, stores });

                for (const storeDef of stores) {
                    for await (const record of iterateObjectStoreRecords(db, storeDef.name)) {
                        stats.recordCount += 1;
                        if (Array.isArray(record.value)) {
                            yield serializeSnapshotLine({
                                type: 'recordArrayStart',
                                database: dbName,
                                store: storeDef.name,
                                key: record.key,
                                length: record.value.length
                            });
                            for (let index = 0; index < record.value.length; index += 1) {
                                const value = Object.prototype.hasOwnProperty.call(record.value, index)
                                    ? record.value[index]
                                    : null;
                                yield serializeStreamRecord({
                                    type: 'recordArrayItem',
                                    database: dbName,
                                    store: storeDef.name,
                                    index
                                }, `${String(record.key)}[${index}]`, value);
                            }
                            yield serializeSnapshotLine({
                                type: 'recordArrayEnd',
                                database: dbName,
                                store: storeDef.name
                            });
                        } else {
                            yield serializeStreamRecord({
                                type: 'record',
                                database: dbName,
                                store: storeDef.name,
                                key: record.key
                            }, record.key, record.value);
                        }
                    }
                    yield serializeSnapshotLine({ type: 'storeEnd', database: dbName, store: storeDef.name });
                }
                yield serializeSnapshotLine({ type: 'databaseEnd', name: dbName });
            } catch (error) {
                throw new Error(`读取本地数据库 ${dbName} 失败，已取消上传以避免云端数据缺失。`, { cause: error });
            } finally {
                if (db) db.close();
            }
        }

        yield serializeSnapshotLine({ type: 'snapshotEnd', recordCount: stats.recordCount });
    }

    function fnv1a32(bytes) {
        let hash = FNV1A_OFFSET_BASIS;
        for (const byte of bytes) {
            hash = Math.imul(hash ^ byte, FNV1A_PRIME) >>> 0;
        }
        return hash >>> 0;
    }

    class CdcChunkingError extends Error {
        constructor(message, options) {
            super(message, options);
            this.name = 'CdcChunkingError';
        }
    }

    class SnapshotChunkWriter {
        constructor(profile, targetBytes, hardMaxBytes, maxBytes) {
            this.profile = profile;
            this.targetBytes = targetBytes;
            this.hardMaxBytes = hardMaxBytes;
            this.maxBytes = maxBytes;
            this.encoder = new TextEncoder();
            this.bufferParts = [];
            this.bufferLength = 0;
            this.totalBytes = 0;
        }

        appendBuffer(bytes) {
            if (bytes.byteLength === 0) return;
            this.bufferParts.push(bytes);
            this.bufferLength += bytes.byteLength;
        }

        flushBuffer(completed) {
            if (this.bufferLength === 0) return;
            if (this.bufferLength > this.hardMaxBytes) {
                throw new CdcChunkingError('CDC 生成了越界块。');
            }
            const bytes = new Uint8Array(this.bufferLength);
            let offset = 0;
            for (const part of this.bufferParts) {
                bytes.set(part, offset);
                offset += part.byteLength;
            }
            this.bufferParts = [];
            this.bufferLength = 0;
            completed.push(bytes);
        }

        appendFixed(bytes, completed) {
            let offset = 0;
            while (offset < bytes.byteLength) {
                const available = this.hardMaxBytes - this.bufferLength;
                const length = Math.min(available, bytes.byteLength - offset);
                this.appendBuffer(bytes.subarray(offset, offset + length));
                offset += length;
                if (this.bufferLength === this.hardMaxBytes) this.flushBuffer(completed);
            }
        }

        appendCdc(bytes, completed) {
            if (bytes.byteLength >= this.hardMaxBytes) {
                this.flushBuffer(completed);
                for (let offset = 0; offset < bytes.byteLength; offset += this.hardMaxBytes) {
                    const end = Math.min(offset + this.hardMaxBytes, bytes.byteLength);
                    completed.push(bytes.slice(offset, end));
                }
                return;
            }

            if (this.bufferLength > 0 && this.bufferLength + bytes.byteLength > this.hardMaxBytes) {
                this.flushBuffer(completed);
            }
            this.appendBuffer(bytes);
            const threshold = bytes.byteLength >= this.targetBytes
                ? UINT32_RANGE
                : Math.floor((bytes.byteLength / this.targetBytes) * UINT32_RANGE);
            if (this.bufferLength >= this.hardMaxBytes || fnv1a32(bytes) < threshold) {
                this.flushBuffer(completed);
            }
        }

        appendLine(text) {
            const bytes = text instanceof Uint8Array ? text : this.encoder.encode(text);
            this.totalBytes += bytes.byteLength;
            if (this.totalBytes > this.maxBytes) {
                throw new Error(`本地数据太大：${this.totalBytes}/${this.maxBytes}。`);
            }
            const completed = [];
            if (this.profile === 'fixed') {
                this.appendFixed(bytes, completed);
            } else {
                this.appendCdc(bytes, completed);
            }
            return completed;
        }

        finish() {
            const completed = [];
            this.flushBuffer(completed);
            return completed;
        }
    }

    async function* iterateSnapshotChunks(stats, profile = 'cdc') {
        const hardMaxBytes = profile === 'fixed' ? LEGACY_FIXED_CHUNK_BYTES : CDC_HARD_MAX_BYTES;
        const writer = new SnapshotChunkWriter(profile, CONFIG.chunkSize, hardMaxBytes, CONFIG.maxSnapshotBytes);
        let index = 0;

        for await (const line of iterateSnapshotLines(stats)) {
            let completed;
            try {
                completed = writer.appendLine(line);
            } catch (error) {
                if (profile === 'cdc') {
                    if (error instanceof CdcChunkingError) throw error;
                    if (typeof error?.message === 'string' && error.message.startsWith('本地数据太大：')) {
                        throw error;
                    }
                    throw new CdcChunkingError('CDC 切块内部异常。', { cause: error });
                }
                throw error;
            }
            for (const bytes of completed) {
                if (bytes.byteLength <= 0 || bytes.byteLength > hardMaxBytes) {
                    throw new CdcChunkingError('CDC 生成了越界块。');
                }
                yield { index, bytes, checksum: await sha256Bytes(bytes), length: bytes.byteLength };
                index += 1;
                if (index > 10_000) throw new CdcChunkingError('CDC 块数量超过10000。');
                await wait(0);
            }
        }

        for (const bytes of writer.finish()) {
            yield { index, bytes, checksum: await sha256Bytes(bytes), length: bytes.byteLength };
            index += 1;
        }
        stats.totalBytes = writer.totalBytes;
        if (index === 0) throw new CdcChunkingError('本地快照没有生成有效分片。');
    }

    function buildStreamSnapshotChecksumSource(snapshot) {
        return JSON.stringify([
            SNAPSHOT_FORMAT,
            SNAPSHOT_SCHEMA_VERSION,
            Number(snapshot.recordCount || 0),
            Number(snapshot.totalBytes || 0),
            snapshot.chunkManifest.map((chunk) => [String(chunk.checksum).toLowerCase(), Number(chunk.length)])
        ]);
    }

    async function scanStreamSnapshot(profile = 'cdc') {
        const stats = { recordCount: 0, totalBytes: 0 };
        const chunkManifest = [];
        for await (const chunk of iterateSnapshotChunks(stats, profile)) {
            chunkManifest.push({ index: chunk.index, checksum: chunk.checksum, length: chunk.length });
            updateProgress(16, `正在扫描本地数据，已处理 ${chunkManifest.length} 个分片...`);
        }
        const totalBytes = chunkManifest.reduce((sum, chunk) => sum + chunk.length, 0);
        if (totalBytes !== stats.totalBytes || chunkManifest.length > 10_000) {
            throw new CdcChunkingError('CDC 块集合无法无损重组。');
        }
        const snapshot = {
            snapshotFormat: SNAPSHOT_FORMAT,
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            chunkerProfile: profile === 'cdc' ? CHUNKER_PROFILE : undefined,
            recordCount: stats.recordCount,
            totalBytes: stats.totalBytes,
            chunkManifest
        };
        snapshot.checksum = await sha256(buildStreamSnapshotChecksumSource(snapshot));
        return snapshot;
    }

    async function buildStreamSnapshotManifest() {
        try {
            return await scanStreamSnapshot('cdc');
        } catch (error) {
            if (!(error instanceof CdcChunkingError)) throw error;
            console.warn('[RP Sync] CDC 切块失败，回退旧定长切块。', error);
            return scanStreamSnapshot('fixed');
        }
    }

    function assertChunkMatchesManifest(chunk, expected) {
        if (!expected
            || chunk.index !== expected.index
            || chunk.length !== expected.length
            || chunk.checksum !== expected.checksum) {
            throw new Error('两次扫描结果不一致，本地数据可能仍在变化，已取消提交。');
        }
    }

    async function uploadMissingStreamChunks(snapshot, missingIndices) {
        const missing = new Set(missingIndices);
        const stats = { recordCount: 0, totalBytes: 0 };
        const profile = snapshot.chunkerProfile === CHUNKER_PROFILE ? 'cdc' : 'fixed';
        let pendingUploads = [];
        let completedUploads = 0;
        let scannedChunks = 0;

        const flushUploads = async () => {
            if (pendingUploads.length === 0) return;
            await Promise.all(pendingUploads);
            pendingUploads = [];
        };

        for await (const chunk of iterateSnapshotChunks(stats, profile)) {
            assertChunkMatchesManifest(chunk, snapshot.chunkManifest[chunk.index]);
            scannedChunks += 1;
            if (!missing.has(chunk.index)) continue;
            pendingUploads.push(postUploadPart(chunk).then(() => {
                completedUploads += 1;
                const percent = missing.size === 0 ? 100 : Math.round((completedUploads / missing.size) * 100);
                updateProgress(36 + Math.round(percent * 0.52), `正在上传服务器数据 ${percent}%...`);
            }));
            if (pendingUploads.length >= CONFIG.uploadPartConcurrency) await flushUploads();
        }
        await flushUploads();

        if (scannedChunks !== snapshot.chunkManifest.length
            || stats.recordCount !== snapshot.recordCount
            || stats.totalBytes !== snapshot.totalBytes) {
            throw new Error('两次扫描结果不一致，本地数据可能仍在变化，已取消提交。');
        }
    }

    async function downloadLegacyRemoteSnapshot(remote, allowVersionRetry = true) {
        if (!remote || !Number.isInteger(Number(remote.chunkCount)) || Number(remote.chunkCount) <= 0) {
            return null;
        }
        if (Number(remote.totalBytes || 0) > CONFIG.maxSnapshotBytes) {
            throw new Error(`服务器数据太大：${remote.totalBytes}/${CONFIG.maxSnapshotBytes}。`);
        }

        let payload;
        try {
            payload = await downloadLegacySnapshotJsonParts(remote);
        } catch (error) {
            if (allowVersionRetry && error.status === 409) {
                await wait(300);
                const retryResponse = await postSync({ action: 'pull-manifest' });
                const retryRemote = retryResponse.remote;
                if (retryRemote?.snapshotFormat && retryRemote.snapshotFormat !== LEGACY_SNAPSHOT_FORMAT) {
                    throw Object.assign(new Error('服务器同步版本已变化，请重新拉取。'), { status: 409 });
                }
                return downloadLegacyRemoteSnapshot(retryRemote, false);
            }
            throw error;
        }

        const json = payload;
        if (remote.checksum && await sha256(json) !== remote.checksum) {
            throw new Error('服务器数据整体校验失败。');
        }

        return {
            ...remote,
            json
        };
    }

    async function downloadLegacySnapshotJsonParts(remote) {
        const chunkCount = Number(remote.chunkCount || 0);
        if (!Number.isInteger(chunkCount) || chunkCount <= 0) {
            throw new Error('服务器数据格式不正确。');
        }

        const ranges = [];
        for (let start = 0; start < chunkCount; start += CONFIG.jsonDownloadPartChunks) {
            const count = Math.min(CONFIG.jsonDownloadPartChunks, chunkCount - start);
            ranges.push({ start, count });
        }

        const byteParts = new Array(ranges.length);
        let completed = 0;
        let cursor = 0;
        const workerCount = Math.min(CONFIG.downloadPartConcurrency, ranges.length);

        async function downloadNextRange() {
            while (cursor < ranges.length) {
                const rangeIndex = cursor;
                cursor += 1;
                const range = ranges[rangeIndex];
                const response = await postSyncBinary({
                    action: 'pull-json-part',
                    version: Number(remote.version),
                    start: range.start,
                    count: range.count
                });
                if (!response.bytes || !(response.bytes instanceof Uint8Array)) {
                    throw new Error('服务器分批数据格式不正确。');
                }
                const bytes = response.bytes;
                const expectedBytes = Number(response.byteLength || 0);
                if (expectedBytes > 0 && bytes.byteLength !== expectedBytes) {
                    throw new Error('服务器分批数据大小不正确。');
                }
                byteParts[rangeIndex] = bytes;
                completed += 1;
                updateProgress(
                    15 + Math.round((completed / ranges.length) * 35),
                    `正在下载服务器数据 ${Math.round((completed / ranges.length) * 100)}%...`
                );
                await wait(0);
            }
        }

        await Promise.all(Array.from({ length: workerCount }, () => downloadNextRange()));
        updateProgress(52, '服务器数据下载完成，正在校验...');
        const totalBytes = byteParts.reduce((sum, part) => sum + part.byteLength, 0);
        const merged = new Uint8Array(totalBytes);
        let offset = 0;
        for (const part of byteParts) {
            merged.set(part, offset);
            offset += part.byteLength;
        }
        return new TextDecoder().decode(merged);
    }

    function normalizeRemoteChunkManifest(remote) {
        const chunkCount = Number(remote?.chunkCount || 0);
        const manifest = Array.isArray(remote?.chunkManifest) ? remote.chunkManifest : [];
        if (!Number.isInteger(chunkCount) || chunkCount <= 0 || manifest.length !== chunkCount) {
            throw new Error('服务器分片清单不完整。');
        }

        let totalBytes = 0;
        const normalized = manifest.map((chunk, index) => {
            const checksum = String(chunk?.checksum || '').toLowerCase();
            const length = Number(chunk?.length || chunk?.byteLength || 0);
            if (Number(chunk?.index) !== index || !/^[a-f0-9]{64}$/.test(checksum)) {
                throw new Error(`服务器第 ${index + 1} 个分片信息不正确。`);
            }
            if (!Number.isInteger(length) || length <= 0 || length > CDC_HARD_MAX_BYTES) {
                throw new Error(`服务器第 ${index + 1} 个分片大小不正确。`);
            }
            totalBytes += length;
            return { index, checksum, length };
        });

        if (totalBytes !== Number(remote.totalBytes) || totalBytes > CONFIG.maxSnapshotBytes) {
            throw new Error('服务器分片总大小校验失败。');
        }
        return normalized;
    }

    async function validateStreamSnapshotManifest(remote) {
        if (remote?.snapshotFormat !== SNAPSHOT_FORMAT || Number(remote?.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) {
            throw new Error('服务器快照格式不受支持。');
        }
        const recordCount = Number(remote.recordCount || 0);
        if (!Number.isInteger(recordCount) || recordCount < 0) {
            throw new Error('服务器快照记录数量不正确。');
        }
        const chunkManifest = normalizeRemoteChunkManifest(remote);
        const snapshot = {
            recordCount,
            totalBytes: Number(remote.totalBytes || 0),
            chunkManifest
        };
        const expectedChecksum = await sha256(buildStreamSnapshotChecksumSource(snapshot));
        if (expectedChecksum !== String(remote.checksum || '').toLowerCase()) {
            throw new Error('服务器快照清单校验失败。');
        }
        return chunkManifest;
    }

    function openDownloadStagingDb(name = DOWNLOAD_STAGING_DB) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(name, 1);
            request.onerror = () => reject(request.error || new Error('同步临时数据库打开失败。'));
            request.onupgradeneeded = () => {
                const stagingDb = request.result;
                if (!stagingDb.objectStoreNames.contains(DOWNLOAD_STAGING_STORE)) {
                    stagingDb.createObjectStore(DOWNLOAD_STAGING_STORE);
                }
            };
            request.onsuccess = () => resolve(request.result);
        });
    }

    function clearDownloadStagingStore(stagingDb) {
        return new Promise((resolve, reject) => {
            const tx = stagingDb.transaction([DOWNLOAD_STAGING_STORE], 'readwrite');
            tx.objectStore(DOWNLOAD_STAGING_STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error || new Error('同步临时数据清理中止。'));
        });
    }

    function writeDownloadStagingChunks(stagingDb, chunks) {
        return new Promise((resolve, reject) => {
            const tx = stagingDb.transaction([DOWNLOAD_STAGING_STORE], 'readwrite');
            const store = tx.objectStore(DOWNLOAD_STAGING_STORE);
            let writeError;
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(writeError || tx.error || new Error('同步临时数据写入中止。'));
            try {
                for (const chunk of chunks) store.put(chunk.bytes,
                    stagingDb.name === DOWNLOAD_CACHE_DB ? chunkCacheKey(chunk) : chunk.index);
            } catch (error) { writeError = error; tx.abort(); }
        });
    }

    function readDownloadStagingChunk(stagingDb, index) {
        return new Promise((resolve, reject) => {
            const tx = stagingDb.transaction([DOWNLOAD_STAGING_STORE], 'readonly');
            const request = tx.objectStore(DOWNLOAD_STAGING_STORE).get(index);
            request.onsuccess = () => {
                const value = request.result;
                if (value instanceof Uint8Array) {
                    resolve(value);
                } else if (value instanceof ArrayBuffer) {
                    resolve(new Uint8Array(value));
                } else {
                    reject(Object.assign(new Error(`同步临时分片 ${index} 不存在。`), { chunkUnavailable: true }));
                }
            };
            request.onerror = () => reject(request.error || new Error('同步临时数据读取失败。'));
        });
    }

    async function downloadSnapshotRange(remote, chunkManifest, start, count, options = {}) {
        const selected = chunkManifest.slice(start, start + count);
        const expectedLength = selected.reduce((sum, chunk) => sum + chunk.length, 0);
        const response = await postSyncBinary({
            action: 'pull-json-part',
            version: Number(remote.version),
            start,
            count
        }, options);
        if (!(response.bytes instanceof Uint8Array)
            || response.bytes.byteLength !== expectedLength
            || (Number(response.byteLength || 0) > 0 && Number(response.byteLength) !== expectedLength)) {
            throw new Error(`服务器第 ${start + 1}-${start + count} 个分片大小校验失败。`);
        }

        const chunks = [];
        let offset = 0;
        for (const chunk of selected) {
            const bytes = response.bytes.slice(offset, offset + chunk.length);
            offset += chunk.length;
            if (await sha256Bytes(bytes) !== chunk.checksum) {
                throw new Error(`服务器第 ${chunk.index + 1} 个分片内容校验失败。`);
            }
            chunks.push({ ...chunk, bytes });
        }
        return chunks;
    }

    function chunkCacheKey(chunk) {
        return `${chunk.checksum}:${chunk.length}`;
    }

    function retainedChunkKeys(chunkManifest, verified, budget = Infinity) {
        const keep = new Set();
        for (const chunk of chunkManifest) {
            const key = chunkCacheKey(chunk);
            if (keep.has(key) || (verified && !verified.has(key)) || chunk.length > budget) continue;
            keep.add(key);
            budget -= chunk.length;
        }
        return keep;
    }

    function pruneDownloadCache(db, keep) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DOWNLOAD_STAGING_STORE, 'readwrite');
            const store = tx.objectStore(DOWNLOAD_STAGING_STORE);
            const present = new Set();
            const request = store.openKeyCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                if (keep.has(cursor.key)) present.add(cursor.key);
                else store.delete(cursor.key);
                cursor.continue();
            };
            tx.oncomplete = () => resolve(present);
            tx.onabort = () => reject(tx.error || new Error('同步缓存清理失败。'));
        });
    }

    function buildDownloadRanges(chunkManifest, present = new Set(), deduplicate = true) {
        const planned = new Set(present);
        const ranges = [];
        let range = null;
        for (const chunk of chunkManifest) {
            const key = chunkCacheKey(chunk);
            if (deduplicate && planned.has(key)) { range = null; continue; }
            if (deduplicate) planned.add(key);
            if (!range || range.count >= CONFIG.jsonDownloadPartChunks
                || range.bytes + chunk.length > CONFIG.downloadRangeBytes) {
                range = { start: chunk.index, count: 0, bytes: 0 };
                ranges.push(range);
            }
            range.count += 1;
            range.bytes += chunk.length;
        }
        return ranges;
    }

    async function downloadSnapshotToStaging(remote, chunkManifest, stagingDb, options = {}) {
        const cached = stagingDb.name === DOWNLOAD_CACHE_DB;
        if (!cached) await clearDownloadStagingStore(stagingDb);
        // The legacy staging store addresses by index, including duplicate contents.
        const ranges = buildDownloadRanges(chunkManifest, options.present, cached);
        const totalChunks = ranges.reduce((sum, range) => sum + range.count, 0);
        const active = new Set();
        const concurrency = options.concurrency || CONFIG.downloadTaskConcurrency;
        let next = 0;
        let pendingBytes = 0;
        let completedChunks = 0;
        let failure = null;
        while ((!failure && next < ranges.length) || active.size) {
            while (!failure && next < ranges.length && active.size < concurrency) {
                const range = ranges[next];
                const oversized = range.bytes > CONFIG.downloadRangeBytes;
                if (active.size && (oversized || pendingBytes > CONFIG.downloadRangeBytes
                    || pendingBytes + range.bytes > CONFIG.downloadPendingBytes)) break;
                next += 1;
                pendingBytes += range.bytes;
                const task = Promise.resolve().then(async () => {
                    const chunks = await downloadSnapshotRange(remote, chunkManifest, range.start, range.count,
                        { shouldStop: () => Boolean(failure) });
                    await writeDownloadStagingChunks(stagingDb, chunks);
                    for (const chunk of chunks) options.verified?.add(chunkCacheKey(chunk));
                    completedChunks += chunks.length;
                    const percent = Math.round(completedChunks / Math.max(1, totalChunks) * 100);
                    updateProgress(percent, `正在拉取服务器分片 ${percent}%...`);
                }).catch((error) => { failure ||= error; }).finally(() => {
                    pendingBytes -= range.bytes;
                    active.delete(task);
                });
                active.add(task);
                if (oversized) break;
            }
            if (active.size) await Promise.race(active);
        }
        if (failure) throw failure;
    }

    async function* iterateStagedSnapshotChunks(stagingDb, chunkManifest, verifyChecksum = true, options = {}) {
        const readChunk = async (chunk) => {
            const key = chunkCacheKey(chunk);
            const readAndCheck = async () => {
                const bytes = await readDownloadStagingChunk(stagingDb,
                    stagingDb.name === DOWNLOAD_CACHE_DB ? key : chunk.index);
                if (bytes.byteLength !== chunk.length
                    || (verifyChecksum && await sha256Bytes(bytes) !== chunk.checksum)) {
                    throw Object.assign(new Error(`同步临时分片 ${chunk.index + 1} 校验失败。`), { chunkUnavailable: true });
                }
                return bytes;
            };
            let bytes;
            try { bytes = await readAndCheck(); }
            catch (error) {
                options.verified?.delete(key);
                if (!verifyChecksum || !error.chunkUnavailable || !options.repair) throw error;
                await options.repair(chunk);
                try { bytes = await readAndCheck(); }
                catch (repairError) { options.verified?.delete(key); throw repairError; }
            }
            if (verifyChecksum) options.verified?.add(key);
            return bytes;
        };
        let pending = null;
        const preload = (chunk) => {
            const task = readChunk(chunk);
            task.catch(() => {}); // The consumer may fail before requesting the prefetched chunk.
            return task;
        };
        try {
            // Keep at most the current and next raw chunks (each capped at 8 MiB).
            if (chunkManifest.length) pending = preload(chunkManifest[0]);
            for (let index = 0; index < chunkManifest.length; index += 1) {
                const bytes = await pending;
                pending = index + 1 < chunkManifest.length ? preload(chunkManifest[index + 1]) : null;
                yield bytes;
            }
        } finally {
            // A repair/write must finish before the caller closes or prunes the cache.
            if (pending) await pending.catch(() => {});
        }
    }

    class SnapshotLineReader {
        constructor(onLine) {
            this.onLine = onLine;
            this.pendingParts = [];
        }

        async push(text) {
            let start = 0;
            while (true) {
                const newlineIndex = text.indexOf('\n', start);
                if (newlineIndex === -1) break;
                const segment = text.slice(start, newlineIndex);
                let line;
                if (this.pendingParts.length > 0) {
                    this.pendingParts.push(segment);
                    line = this.pendingParts.join('');
                    this.pendingParts = [];
                } else {
                    line = segment;
                }
                if (line.endsWith('\r')) line = line.slice(0, -1);
                if (line) {
                    const pending = this.onLine(line);
                    if (pending) await pending;
                }
                start = newlineIndex + 1;
            }
            if (start < text.length) this.pendingParts.push(text.slice(start));
        }

        async finish() {
            if (this.pendingParts.length === 0) return;
            let line = this.pendingParts.join('');
            this.pendingParts = [];
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line) await this.onLine(line);
        }
    }

    function normalizeLegacyCharacterForStream(character, index, seen, assignMissingUuid) {
        if (!character || typeof character !== 'object' || Array.isArray(character)) {
            throw new TypeError(`旧快照第 ${index + 1} 张角色卡格式无效，已取消恢复。`);
        }
        const rawUuid = character.uuid;
        let uuid = rawUuid;
        if (rawUuid === undefined || rawUuid === null || rawUuid === '') {
            if (!assignMissingUuid) return null;
            uuid = crypto.randomUUID();
            character.uuid = uuid;
        } else if (typeof rawUuid !== 'string') {
            throw new TypeError(`旧快照第 ${index + 1} 张角色卡 UUID 不是字符串，已取消恢复。`);
        }
        if (uuid === 'index') {
            throw new Error('旧快照角色卡 UUID index 与角色卡索引键冲突，已取消恢复。');
        }
        if (seen.has(uuid)) {
            throw new Error(`旧快照角色卡 UUID 重复：${uuid}。为避免合并存档，已取消恢复。`);
        }
        seen.add(uuid);
        return uuid;
    }

    function isLegacyCharacterArrayLine(databaseName, storeName, key) {
        return databaseName === 'RPHubDB'
            && storeName === 'store'
            && key === 'rp_hub_characters';
    }

    class StreamSnapshotRestorer {
        constructor(expectedRecordCount) {
            this.expectedRecordCount = Number(expectedRecordCount || 0);
            this.recordCount = 0;
            this.snapshotStarted = false;
            this.snapshotEnded = false;
            this.localStorageEnded = false;
            this.localStorageKeys = new Set();
            this.seenDatabases = new Set();
            this.currentDatabase = null;
        }

        consume(lineText) {
            let line;
            try {
                line = JSON.parse(lineText);
            } catch (_) {
                throw new Error('服务器快照记录格式不正确。');
            }

            switch (line?.type) {
                case 'snapshot':
                    this.startSnapshot(line);
                    break;
                case 'localStorage':
                    this.restoreLocalStorageEntry(line);
                    break;
                case 'localStorageEnd':
                    this.finishLocalStorage();
                    break;
                case 'database':
                    return this.startDatabase(line);
                case 'record':
                    return this.restoreRecord(line);
                case 'recordArrayStart':
                    this.startArrayRecord(line);
                    break;
                case 'recordArrayItem':
                    return this.restoreArrayRecordItem(line);
                case 'recordArrayEnd':
                    return this.finishArrayRecord(line);
                case 'storeEnd':
                    return this.finishStore(line);
                case 'databaseEnd':
                    return this.finishDatabase(line);
                case 'snapshotEnd':
                    return this.finishSnapshot(line);
                default:
                    throw new Error('服务器快照包含未知记录。');
            }
        }

        startSnapshot(line) {
            if (this.snapshotStarted
                || line.format !== SNAPSHOT_FORMAT
                || Number(line.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) {
                throw new Error('服务器快照头信息不正确。');
            }
            this.snapshotStarted = true;
            this.workshopVersion = line.workshopVersion;
        }

        restoreLocalStorageEntry(line) {
            if (!this.snapshotStarted || this.localStorageEnded || this.currentDatabase || typeof line.key !== 'string') {
                throw new Error('服务器本地设置记录顺序不正确。');
            }
            if (!isAppLocalStorageKey(line.key)) throw new Error('服务器包含无效的本地设置。');
            localStorage.setItem(line.key, String(line.value ?? ''));
            this.localStorageKeys.add(line.key);
            this.recordCount += 1;
        }

        finishLocalStorage() {
            if (!this.snapshotStarted || this.localStorageEnded || this.currentDatabase) {
                throw new Error('服务器本地设置结束标记不正确。');
            }
            for (const entry of readLocalStorageSnapshot()) {
                if (this.workshopVersion !== 1 && isWorkshopLocalStorageKey(entry.key)) continue;
                if (!this.localStorageKeys.has(entry.key)) localStorage.removeItem(entry.key);
            }
            this.localStorageEnded = true;
        }

        async startDatabase(line) {
            if (!this.localStorageEnded || this.currentDatabase || typeof line.name !== 'string') {
                throw new Error('服务器数据库记录顺序不正确。');
            }

            const knownDb = CONFIG.knownDatabases.find((dbDef) => dbDef.name === line.name);
            if (!knownDb) {
                this.currentDatabase = { name: line.name, ignored: true, arrayRecord: null };
                return;
            }

            const seenStoreNames = new Set();
            const stores = (Array.isArray(line.stores) ? line.stores : []).filter((storeDef) => {
                if (!storeDef || !knownDb.stores.includes(storeDef.name) || seenStoreNames.has(storeDef.name)) return false;
                seenStoreNames.add(storeDef.name);
                return true;
            }).map((storeDef) => ({
                name: storeDef.name,
                keyPath: storeDef.keyPath,
                autoIncrement: Boolean(storeDef.autoIncrement)
            }));

            const db = stores.length > 0 ? await openDbForRestore({ name: line.name, stores }) : null;
            this.currentDatabase = {
                name: line.name,
                db,
                knownDb,
                stores: new Map(stores.map((storeDef) => [storeDef.name, {
                    definition: storeDef,
                    incomingKeys: new Set(),
                    batch: [],
                    arrayRecord: null,
                    finished: false
                }]))
            };
            this.seenDatabases.add(line.name);
        }

        getStoreState(line) {
            const current = this.currentDatabase;
            if (!current || line.database !== current.name || typeof line.store !== 'string') {
                throw new Error('服务器数据库记录归属不正确。');
            }
            if (current.ignored) return null;
            const storeState = current.stores.get(line.store);
            if (!storeState || storeState.finished) throw new Error('服务器对象存储记录顺序不正确。');
            return storeState;
        }

        queueStoreRecord(storeState, record, countRecord = true) {
            storeState.incomingKeys.add(stableKeyToken(record.key));
            storeState.batch.push(record);
            if (countRecord) this.recordCount += 1;
            if (storeState.batch.length >= CONFIG.restoreBatchSize) return this.flushStore(storeState);
        }

        async restoreRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) {
                this.recordCount += 1;
                return;
            }
            if (storeState.arrayRecord) throw new Error('服务器数组记录尚未结束。');
            const record = {
                key: line.key,
                value: Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : undefined
            };
            const expanded = expandLegacyCharacterRecord(this.currentDatabase.name, line.store, record);
            if (expanded.length === 1 && expanded[0] === record) {
                await this.queueStoreRecord(storeState, record);
                return;
            }
            for (const item of expanded) await this.queueStoreRecord(storeState, item, false);
            this.recordCount += 1;
        }

        startArrayRecord(line) {
            const storeState = this.getStoreState(line);
            const length = Number(line.length);
            if (!Number.isInteger(length) || length < 0) {
                throw new Error('服务器数组记录头信息不正确。');
            }
            if (!storeState) {
                if (this.currentDatabase.arrayRecord) throw new Error('服务器数组记录头信息不正确。');
                this.currentDatabase.arrayRecord = { expectedLength: length, nextIndex: 0 };
                return;
            }
            if (storeState.arrayRecord) throw new Error('服务器数组记录头信息不正确。');
            const splitLegacyCharacters = isLegacyCharacterArrayLine(
                this.currentDatabase.name,
                line.store,
                line.key
            );
            storeState.arrayRecord = {
                key: line.key,
                value: splitLegacyCharacters ? null : [],
                expectedLength: length,
                nextIndex: 0,
                splitLegacyCharacters,
                order: splitLegacyCharacters ? [] : null,
                seen: splitLegacyCharacters ? new Set() : null
            };
        }

        restoreArrayRecordItem(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) {
                const arrayRecord = this.currentDatabase.arrayRecord;
                if (!arrayRecord || Number(line.index) !== arrayRecord.nextIndex) {
                    throw new Error('服务器数组记录顺序不正确。');
                }
                arrayRecord.nextIndex += 1;
                return;
            }
            const arrayRecord = storeState.arrayRecord;
            if (!arrayRecord || Number(line.index) !== arrayRecord.nextIndex) {
                throw new Error('服务器数组记录顺序不正确。');
            }
            const value = Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : null;
            let pending;
            if (arrayRecord.splitLegacyCharacters) {
                const uuid = normalizeLegacyCharacterForStream(
                    value,
                    arrayRecord.nextIndex,
                    arrayRecord.seen,
                    true
                );
                arrayRecord.order.push(uuid);
                pending = this.queueStoreRecord(storeState, {
                    key: `rp_hub_character_${uuid}`,
                    value
                }, false);
            } else {
                arrayRecord.value.push(value);
            }
            arrayRecord.nextIndex += 1;
            return pending;
        }

        async finishArrayRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) {
                const arrayRecord = this.currentDatabase.arrayRecord;
                if (!arrayRecord || arrayRecord.nextIndex !== arrayRecord.expectedLength) {
                    throw new Error('服务器数组记录数据不完整。');
                }
                this.currentDatabase.arrayRecord = null;
                this.recordCount += 1;
                return;
            }
            const arrayRecord = storeState.arrayRecord;
            if (!arrayRecord || arrayRecord.nextIndex !== arrayRecord.expectedLength) {
                throw new Error('服务器数组记录数据不完整。');
            }
            storeState.arrayRecord = null;
            if (arrayRecord.splitLegacyCharacters) {
                await this.queueStoreRecord(storeState, {
                    key: 'rp_hub_character_index',
                    value: { order: arrayRecord.order }
                }, false);
                this.recordCount += 1;
            } else {
                await this.queueStoreRecord(storeState, {
                    key: arrayRecord.key,
                    value: arrayRecord.value
                });
            }
            await this.flushStore(storeState);
        }

        async flushStore(storeState) {
            if (storeState.batch.length === 0) return;
            const batch = storeState.batch;
            storeState.batch = [];
            await writeObjectStoreRecordBatch(this.currentDatabase.db, storeState.definition, batch);
            await wait(0);
        }

        async finishStore(line) {
            const current = this.currentDatabase;
            if (!current || line.database !== current.name || typeof line.store !== 'string') {
                throw new Error('服务器对象存储结束标记不正确。');
            }
            if (current.ignored) {
                if (current.arrayRecord) throw new Error('服务器数组记录尚未结束。');
                return;
            }
            const storeState = current.stores.get(line.store);
            if (!storeState || storeState.finished) throw new Error('服务器对象存储结束顺序不正确。');
            if (storeState.arrayRecord) throw new Error('服务器数组记录尚未结束。');
            await this.flushStore(storeState);
            await deleteMissingObjectStoreRecords(current.db, line.store, storeState.incomingKeys);
            storeState.incomingKeys.clear();
            storeState.finished = true;
        }

        async finishDatabase(line) {
            const current = this.currentDatabase;
            if (!current || line.name !== current.name) throw new Error('服务器数据库结束标记不正确。');
            if (!current.ignored) {
                if ([...current.stores.values()].some((storeState) => !storeState.finished)) {
                    throw new Error('服务器对象存储数据不完整。');
                }
                if (current.db) current.db.close();
                const missingStores = current.knownDb.stores.filter((storeName) => !current.stores.has(storeName));
                if (missingStores.length > 0) await clearKnownIndexedDbStores(current.knownDb, missingStores);
            }
            this.currentDatabase = null;
        }

        async finishSnapshot(line) {
            if (!this.snapshotStarted || this.snapshotEnded || !this.localStorageEnded || this.currentDatabase) {
                throw new Error('服务器快照结束标记不正确。');
            }
            if (Number(line.recordCount) !== this.recordCount || this.recordCount !== this.expectedRecordCount) {
                throw new Error('服务器快照记录数量校验失败。');
            }
            for (const knownDb of CONFIG.knownDatabases) {
                if (knownDb.workshop && this.workshopVersion !== 1) continue;
                if (!this.seenDatabases.has(knownDb.name)) {
                    await clearKnownIndexedDbStores(knownDb, knownDb.stores);
                }
            }
            this.snapshotEnded = true;
        }

        finish() {
            if (!this.snapshotEnded) throw new Error('服务器快照数据不完整。');
        }

        abort() {
            if (this.currentDatabase?.db) this.currentDatabase.db.close();
            this.currentDatabase = null;
        }
    }

    class StreamSnapshotValidator {
        constructor(expectedRecordCount) {
            this.expectedRecordCount = Number(expectedRecordCount || 0);
            this.recordCount = 0;
            this.snapshotStarted = false;
            this.snapshotEnded = false;
            this.localStorageEnded = false;
            this.currentDatabase = null;
            this.currentStore = null;
            this.arrayRecord = null;
        }

        consume(lineText) {
            let line;
            try {
                line = JSON.parse(lineText);
            } catch (_) {
                throw new Error('服务器快照记录格式不正确。');
            }

            switch (line?.type) {
                case 'snapshot':
                    if (this.snapshotStarted
                        || line.format !== SNAPSHOT_FORMAT
                        || Number(line.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION
                        || (line.workshopVersion !== undefined && line.workshopVersion !== 1)) {
                        throw new Error('服务器快照头信息不正确。');
                    }
                    this.snapshotStarted = true;
                    break;
                case 'localStorage':
                    if (!this.snapshotStarted
                        || this.localStorageEnded
                        || this.currentDatabase
                        || typeof line.key !== 'string'
                        || !isAppLocalStorageKey(line.key)) {
                        throw new Error('服务器本地设置记录顺序不正确。');
                    }
                    this.recordCount += 1;
                    break;
                case 'localStorageEnd':
                    if (!this.snapshotStarted || this.localStorageEnded || this.currentDatabase) {
                        throw new Error('服务器本地设置结束标记不正确。');
                    }
                    this.localStorageEnded = true;
                    break;
                case 'database': {
                    if (!this.localStorageEnded
                        || this.currentDatabase
                        || typeof line.name !== 'string'
                        || !Array.isArray(line.stores)) {
                        throw new Error('服务器数据库记录顺序不正确。');
                    }
                    const storeNames = line.stores.map((store) => store?.name);
                    if (storeNames.some((name) => typeof name !== 'string')
                        || new Set(storeNames).size !== storeNames.length) {
                        throw new Error('服务器对象存储定义不正确。');
                    }
                    this.currentDatabase = {
                        name: line.name,
                        stores: new Set(storeNames),
                        finishedStores: new Set()
                    };
                    break;
                }
                case 'record':
                    this.validateStoreLine(line);
                    if (this.arrayRecord) throw new Error('服务器数组记录尚未结束。');
                    if (isLegacyCharacterArrayLine(this.currentDatabase.name, line.store, line.key)) {
                        if (!Array.isArray(line.value)) throw new Error('旧快照角色卡记录格式无效。');
                        const seen = new Set();
                        line.value.forEach((character, index) => {
                            normalizeLegacyCharacterForStream(character, index, seen, false);
                        });
                    }
                    this.recordCount += 1;
                    break;
                case 'recordArrayStart': {
                    this.validateStoreLine(line);
                    const length = Number(line.length);
                    if (this.arrayRecord || !Number.isInteger(length) || length < 0) {
                        throw new Error('服务器数组记录头信息不正确。');
                    }
                    this.arrayRecord = {
                        length,
                        nextIndex: 0,
                        splitLegacyCharacters: isLegacyCharacterArrayLine(
                            this.currentDatabase.name,
                            line.store,
                            line.key
                        ),
                        seen: new Set()
                    };
                    break;
                }
                case 'recordArrayItem':
                    this.validateStoreLine(line);
                    if (!this.arrayRecord || Number(line.index) !== this.arrayRecord.nextIndex) {
                        throw new Error('服务器数组记录顺序不正确。');
                    }
                    if (this.arrayRecord.splitLegacyCharacters) {
                        normalizeLegacyCharacterForStream(
                            Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : null,
                            this.arrayRecord.nextIndex,
                            this.arrayRecord.seen,
                            false
                        );
                    }
                    this.arrayRecord.nextIndex += 1;
                    break;
                case 'recordArrayEnd':
                    this.validateStoreLine(line);
                    if (!this.arrayRecord || this.arrayRecord.nextIndex !== this.arrayRecord.length) {
                        throw new Error('服务器数组记录数据不完整。');
                    }
                    this.arrayRecord = null;
                    this.recordCount += 1;
                    break;
                case 'storeEnd':
                    this.validateStoreLine(line);
                    if (this.arrayRecord) throw new Error('服务器数组记录尚未结束。');
                    this.currentDatabase.finishedStores.add(line.store);
                    this.currentStore = null;
                    break;
                case 'databaseEnd':
                    if (!this.currentDatabase
                        || line.name !== this.currentDatabase.name
                        || this.currentStore
                        || this.arrayRecord
                        || this.currentDatabase.finishedStores.size !== this.currentDatabase.stores.size) {
                        throw new Error('服务器数据库结束标记不正确。');
                    }
                    this.currentDatabase = null;
                    break;
                case 'snapshotEnd':
                    if (!this.snapshotStarted
                        || this.snapshotEnded
                        || !this.localStorageEnded
                        || this.currentDatabase
                        || Number(line.recordCount) !== this.recordCount
                        || this.recordCount !== this.expectedRecordCount) {
                        throw new Error('服务器快照记录数量校验失败。');
                    }
                    this.snapshotEnded = true;
                    break;
                default:
                    throw new Error('服务器快照包含未知记录。');
            }
        }

        validateStoreLine(line) {
            if (!this.currentDatabase
                || line.database !== this.currentDatabase.name
                || typeof line.store !== 'string'
                || !this.currentDatabase.stores.has(line.store)
                || this.currentDatabase.finishedStores.has(line.store)) {
                throw new Error('服务器数据库记录归属不正确。');
            }
            if (this.currentStore && this.currentStore !== line.store) {
                throw new Error('服务器对象存储记录顺序不正确。');
            }
            if (!this.currentStore) this.currentStore = line.store;
        }

        finish() {
            if (!this.snapshotEnded) throw new Error('服务器快照数据不完整。');
        }
    }

    async function parseStagedStreamSnapshot(stagingDb, chunkManifest, consumer, options = {}) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const lineReader = new SnapshotLineReader((line) => consumer.consume(line));
        let completed = 0;
        for await (const bytes of iterateStagedSnapshotChunks(
            stagingDb,
            chunkManifest,
            options.verifyChecksum !== false,
            options
        )) {
            await lineReader.push(decoder.decode(bytes, { stream: true }));
            completed += 1;
            if (typeof options.onProgress === 'function') {
                options.onProgress(completed, chunkManifest.length);
            }
        }
        await lineReader.push(decoder.decode());
        await lineReader.finish();
        consumer.finish();
    }

    async function restoreStreamSnapshot(remote, onRestoreStart) {
        const chunkManifest = await validateStreamSnapshotManifest(remote);
        let useCache = state.syncLockHeld;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let stagingDb;
            try { stagingDb = await openDownloadStagingDb(useCache ? DOWNLOAD_CACHE_DB : DOWNLOAD_STAGING_DB); }
            catch (error) {
                if (!useCache) throw error;
                console.warn('[RP Sync] 缓存库不可用，使用临时存储。', error);
                useCache = false;
                stagingDb = await openDownloadStagingDb();
            }
            const verified = new Set();
            let restoreStarted = false;
            let retryTemporary = false;
            try {
                const present = useCache
                    ? await pruneDownloadCache(stagingDb, retainedChunkKeys(chunkManifest)) : new Set();
                await downloadSnapshotToStaging(remote, chunkManifest, stagingDb, {
                    present, verified, concurrency: useCache ? CONFIG.downloadTaskConcurrency : 1
                });
                updateProgress(0, '服务器分片拉取完成，正在完整校验...');
                const repaired = new Set();
                const repair = useCache ? async (chunk) => {
                    const key = chunkCacheKey(chunk);
                    if (repaired.has(key)) throw new Error(`缓存分片 ${chunk.index + 1} 修复失败。`);
                    repaired.add(key);
                    verified.delete(key);
                    const keep = retainedChunkKeys(chunkManifest);
                    keep.delete(key);
                    await pruneDownloadCache(stagingDb, keep);
                    await downloadSnapshotToStaging(remote, chunkManifest, stagingDb, { present: keep, verified });
                } : null;
                await parseStagedStreamSnapshot(stagingDb, chunkManifest, new StreamSnapshotValidator(remote.recordCount), {
                    repair, verified,
                    onProgress: (completed, total) => {
                        const percent = Math.round((completed / total) * 100);
                        updateProgress(percent, `正在校验服务器分片 ${percent}%...`);
                    }
                });
                updateProgress(100, '本地分片校验完成，正在确认服务器版本...');
                const confirmation = await postSync({ action: 'pull-manifest' });
                if (!confirmation.remote
                    || Number(confirmation.remote.version) !== Number(remote.version)
                    || confirmation.remote.checksum !== remote.checksum) {
                    throw Object.assign(new Error('服务器同步版本已变化，请重新拉取。'), { status: 409 });
                }
                updateProgress(0, '服务器数据校验完成，正在恢复本地数据...');
                restoreStarted = true;
                if (typeof onRestoreStart === 'function') onRestoreStart();
                const restorer = new StreamSnapshotRestorer(remote.recordCount);
                try {
                    await parseStagedStreamSnapshot(stagingDb, chunkManifest, restorer, {
                        verifyChecksum: false,
                        onProgress: (completed, total) => {
                            const percent = Math.round((completed / total) * 100);
                            updateProgress(percent, `正在恢复本地数据 ${percent}%...`);
                        }
                    });
                } catch (error) { restorer.abort(); throw error; }
                return;
            } catch (error) {
                retryTemporary = useCache && !restoreStarted && error?.name === 'QuotaExceededError' && attempt === 0;
                if (!retryTemporary) throw error;
                // All scheduler tasks and aborted write transactions have settled here.
                await clearDownloadStagingStore(stagingDb);
                console.warn('[RP Sync] 缓存空间不足，重试一次临时存储。');
            } finally {
                try {
                    if (useCache) await pruneDownloadCache(stagingDb,
                        retainedChunkKeys(chunkManifest, verified, CONFIG.downloadCacheBytes));
                    else await clearDownloadStagingStore(stagingDb);
                } catch (error) { console.warn('[RP Sync] 同步暂存清理失败。', error); }
                stagingDb.close();
            }
            if (retryTemporary) useCache = false;
        }
    }

    function runSyncLocked(operation) {
        if (state.syncing || state.reloadPending) return Promise.resolve();
        if (!navigator.locks?.request) return operation();
        return new Promise((resolve, reject) => {
            navigator.locks.request('RPHubSync', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
                if (!lock) {
                    updateProgress(100, '另一页面正在同步，请稍后重试。');
                    return;
                }
                if (state.syncing || state.reloadPending) return;
                state.syncLockHeld = true;
                try {
                    const result = await operation();
                    if (state.reloadPending) {
                        resolve(result);
                        await new Promise((release) => window.addEventListener('pagehide', release, { once: true }));
                    }
                    return result;
                } finally { state.syncLockHeld = false; }
            }).then(resolve, reject);
        });
    }

    function buildSyncHeaders(options = {}) {
        const headers = {
            'content-type': 'application/json'
        };
        const password = typeof options.password === 'string' ? options.password : getStoredSyncPassword();
        if (password) {
            headers['x-rp-sync-password'] = password;
        }
        return headers;
    }

    function buildPartHeaders(chunk, options = {}) {
        const headers = {
            'content-type': 'application/octet-stream',
            'x-rp-part-checksum': chunk.checksum,
            'x-rp-part-length': String(chunk.length)
        };
        const password = typeof options.password === 'string' ? options.password : getStoredSyncPassword();
        if (password) {
            headers['x-rp-sync-password'] = password;
        }
        return headers;
    }

    function shouldRetrySyncError(error) {
        const status = Number(error?.status || 0);
        return !status || status === 408 || status === 429 || status >= 500;
    }

    async function postSync(payload, options = {}) {
        const retryCount = Number.isInteger(options.retryCount) ? options.retryCount : CONFIG.retryCount;
        const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : CONFIG.requestTimeoutMs;
        let lastError = null;

        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(CONFIG.apiEndpoint, {
                    method: 'POST',
                    headers: buildSyncHeaders(options),
                    body: JSON.stringify(payload),
                    credentials: 'same-origin',
                    signal: controller.signal
                });

                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.ok) {
                    if (response.status === 401 && !options.keepPasswordOnAuthError) {
                        clearStoredSyncPassword();
                    }
                    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { response: data, status: response.status });
                }
                return data;
            } catch (error) {
                const isAbort = error?.name === 'AbortError';
                const status = isAbort ? 0 : error?.status;
                const normalizedError = isAbort
                    ? new Error('同步请求超时，请检查网络后重试。')
                    : (error instanceof Error ? error : new Error(String(error)));
                lastError = Object.assign(normalizedError, { status });
                if (attempt >= retryCount || !shouldRetrySyncError(lastError)) {
                    throw lastError;
                }
                await wait(CONFIG.retryDelayMs * (attempt + 1));
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw lastError || new Error('同步请求失败。');
    }

    async function postSyncBinary(payload, options = {}) {
        const retryCount = Number.isInteger(options.retryCount) ? options.retryCount : CONFIG.retryCount;
        const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : CONFIG.requestTimeoutMs;
        let lastError = null;

        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            if (options.shouldStop?.()) throw new Error('其他下载任务已失败，停止重试。');
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(CONFIG.apiEndpoint, {
                    method: 'POST',
                    headers: buildSyncHeaders(options),
                    body: JSON.stringify(payload),
                    credentials: 'same-origin',
                    signal: controller.signal
                });

                if (!response.ok) {
                    const data = await response.json().catch(() => ({}));
                    if (response.status === 401 && !options.keepPasswordOnAuthError) {
                        clearStoredSyncPassword();
                    }
                    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { response: data, status: response.status });
                }

                const bytes = new Uint8Array(await response.arrayBuffer());
                return {
                    ok: true,
                    bytes,
                    byteLength: Number(response.headers.get('x-rp-sync-byte-length') || bytes.byteLength)
                };
            } catch (error) {
                const isAbort = error?.name === 'AbortError';
                const status = isAbort ? 0 : error?.status;
                const normalizedError = isAbort
                    ? new Error('同步请求超时，请检查网络后重试。')
                    : (error instanceof Error ? error : new Error(String(error)));
                lastError = Object.assign(normalizedError, { status });
                if (attempt >= retryCount || !shouldRetrySyncError(lastError)) {
                    throw lastError;
                }
                await wait(CONFIG.retryDelayMs * (attempt + 1));
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw lastError || new Error('同步请求失败。');
    }

    async function postUploadPart(chunk) {
        const retryCount = CONFIG.retryCount;
        let lastError = null;
        const params = new URLSearchParams({
            action: 'upload-part',
            index: String(chunk.index),
            partNumber: String(chunk.index + 1)
        });

        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.uploadPartTimeoutMs);
            try {
                const response = await fetch(`${CONFIG.apiEndpoint}?${params.toString()}`, {
                    method: 'POST',
                    headers: buildPartHeaders(chunk),
                    body: chunk.bytes,
                    credentials: 'same-origin',
                    signal: controller.signal
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || !data.ok) {
                    if (response.status === 401) clearStoredSyncPassword();
                    throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { response: data, status: response.status });
                }
                return {
                    partNumber: Number(data.partNumber),
                    index: chunk.index,
                    byteLength: chunk.length,
                    checksum: chunk.checksum,
                    key: data.key
                };
            } catch (error) {
                const isAbort = error?.name === 'AbortError';
                const status = isAbort ? 0 : error?.status;
                const normalizedError = isAbort
                    ? new Error('上传超时，请检查网络后重试。')
                    : (error instanceof Error ? error : new Error(String(error)));
                lastError = Object.assign(normalizedError, { status });
                if (attempt >= retryCount || !shouldRetrySyncError(lastError)) {
                    throw lastError;
                }
                await wait(CONFIG.retryDelayMs * (attempt + 1));
            } finally {
                clearTimeout(timeoutId);
            }
        }

        throw lastError || new Error('上传失败。');
    }

    function updateProgress(progress, text) {
        state.progress = Math.max(0, Math.min(100, progress));
        state.statusText = text || state.statusText;
        if (modalProgressBar) {
            modalProgressBar.style.width = `${state.progress}%`;
        }
        if (modalProgressValue) {
            modalProgressValue.textContent = `${Math.round(state.progress)}%`;
        }
        if (modalStatus) {
            modalStatus.textContent = state.statusText;
        }
    }

    function stopEstimatedProgress() {
        if (estimatedProgressTimer) {
            clearInterval(estimatedProgressTimer);
            estimatedProgressTimer = null;
        }
    }

    function startEstimatedProgress(options = {}) {
        stopEstimatedProgress();
        const startedAt = Date.now();
        const from = Number(options.from || state.progress || 8);
        const to = Number(options.to || 88);
        const durationMs = Number(options.durationMs || 150_000);
        const text = options.text || '正在连接 RP-Hub 上游';

        updateProgress(from, `${text}，已等待 0 秒...`);
        estimatedProgressTimer = setInterval(() => {
            const elapsedMs = Date.now() - startedAt;
            const elapsedSeconds = Math.floor(elapsedMs / 1000);
            const ratio = Math.min(1, elapsedMs / durationMs);
            const eased = 1 - Math.pow(1 - ratio, 2);
            const nextProgress = Math.min(to, Math.round(from + (to - from) * eased));
            updateProgress(nextProgress, `${text}，已等待 ${elapsedSeconds} 秒...`);
        }, 800);
    }

    function updateButtonState() {
        syncEntry?.update({ label: state.syncing ? '处理中' : '同步', busy: state.syncing });
    }

    function setActionButtonsDisabled(disabled) {
        if (pullButton) pullButton.disabled = disabled;
        if (pushButton) pushButton.disabled = disabled;
        if (appUpdateCheckButton) appUpdateCheckButton.disabled = disabled;
        if (appUpdateApplyButton) appUpdateApplyButton.disabled = disabled;
        if (appUpdateRollbackButton) appUpdateRollbackButton.disabled = disabled;
        for (const button of [selfUpdateCheckButton, selfUpdateApplyButton, selfUpdateRollbackButton, selfUpdateVersionButton]) {
            if (button) button.disabled = disabled;
        }
        if (appUpdateVersionButton) appUpdateVersionButton.disabled = disabled;
        if (closeButton) closeButton.disabled = disabled;
    }

    function getVueProxy() {
        const appRoot = document.getElementById('app');
        return appRoot?.__vue_app__?._instance?.proxy || null;
    }

    async function flushAppState() {
        if (typeof globalThis.RPH_R2_FLUSH_PERSISTENCE !== 'function') {
            throw new Error('当前程序缺少持久化同步桥，已取消同步或版本切换。');
        }
        await globalThis.RPH_R2_FLUSH_PERSISTENCE();
        await globalThis.RPHubSDK?.flush?.();
    }

    async function getAuthStatus(password = getStoredSyncPassword()) {
        return postSync({ action: 'auth-status' }, {
            password,
            keepPasswordOnAuthError: true
        });
    }

    function ensurePasswordModal() {
        if (passwordModalRoot) return;

        passwordModalRoot = document.createElement('div');
        passwordModalRoot.className = 'rp-sync-modal rp-sync-password-modal';
        passwordModalRoot.innerHTML = `
            <div class="rp-sync-modal__backdrop"></div>
            <form class="rp-sync-modal__panel rp-sync-password-panel">
                <div class="rp-sync-modal__header">
                    <div>
                        <div class="rp-sync-modal__eyebrow">Sync Password</div>
                        <h3 class="rp-sync-modal__title">同步密码</h3>
                    </div>
                    <button type="button" class="rp-sync-modal__close" aria-label="关闭">×</button>
                </div>
                <p class="rp-sync-modal__intro">当前站点已开启同步密码。输入一次后会保存在这个浏览器里，下次同步不需要再输入。</p>
                <label class="rp-sync-password-field">
                    <span>密码</span>
                    <input type="password" autocomplete="current-password" placeholder="请输入同步密码">
                </label>
                <p class="rp-sync-password-status">请输入同步密码。</p>
                <div class="rp-sync-modal__actions">
                    <button type="button" class="rp-sync-modal__button" data-action="cancel-password">取消</button>
                    <button type="submit" class="rp-sync-modal__button is-primary" data-action="submit-password">继续同步</button>
                </div>
            </form>
        `;

        document.body.appendChild(passwordModalRoot);
        passwordInput = passwordModalRoot.querySelector('input');
        passwordStatus = passwordModalRoot.querySelector('.rp-sync-password-status');
        passwordSubmitButton = passwordModalRoot.querySelector('[data-action="submit-password"]');

        const closePasswordModal = () => {
            if (checkingPassword) return;
            passwordModalRoot.classList.remove('is-open');
            returnSyncFocus();
        };

        passwordModalRoot.querySelector('.rp-sync-modal__close').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('[data-action="cancel-password"]').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('form').addEventListener('submit', (event) => {
            event.preventDefault();
            submitSyncPassword().catch(() => { });
        });
    }

    function openPasswordModal(message = '请输入同步密码。') {
        rememberSyncFocus();
        ensurePasswordModal();
        passwordStatus.textContent = message;
        passwordInput.value = '';
        passwordSubmitButton.disabled = false;
        passwordModalRoot.classList.add('is-open');
        setTimeout(() => passwordInput.focus(), 0);
    }

    function openSyncPanel() {
        state.statusText = '请选择同步方向。';
        state.progress = 0;
        openModal();
    }

    function settleInlineConfirm(value) {
        if (confirmLayer) confirmLayer.classList.remove('is-open');
        if (confirmResolve) {
            const resolve = confirmResolve;
            confirmResolve = null;
            resolve(Boolean(value));
        }
    }

    function openInlineConfirm(options = {}) {
        ensureModal();
        modalRoot.classList.add('is-open');
        if (appUpdateVersionMenu) appUpdateVersionMenu.classList.remove('is-open');
        if (confirmResolve) settleInlineConfirm(false);

        confirmTitle.textContent = options.title || '确认操作';
        confirmMessage.textContent = options.message || '继续执行这个操作吗？';
        confirmSubmitButton.textContent = options.confirmText || '继续';
        confirmSubmitButton.classList.toggle('is-danger', options.variant === 'danger');
        confirmLayer.classList.add('is-open');

        return new Promise((resolve) => {
            confirmResolve = resolve;
        });
    }

    function formatShortSha(value) {
        return typeof value === 'string' && value ? value.slice(0, 18) : '未知';
    }

    function formatCurrentAppVersion(result) {
        const current = result?.current || {};
        if (current.label) return current.label;
        if (current.version) return current.source === 'bundle' ? `内置 ${current.version}` : current.version;
        if (current.tag) return current.tag;
        if (current.source === 'bundle') return '内置版本';
        return formatShortSha(current.sha);
    }

    function setModalTitle() {
        if (!modalTitle) return;
        modalTitle.innerHTML = `
            <span class="rp-sync-modal__title-sub">R2 Sync</span>
            <span class="rp-sync-modal__title-main">云同步</span>
        `;
    }

    function getSelectedAppUpdateTarget() {
        return appUpdateSelectedTarget || '';
    }

    function formatAppUpdateVersionLabel(version, index = 0) {
        if (!version) return '最新版';
        const tag = version.tag || version.sha || '未知版本';
        const title = String(version.name || version.message || '').split('\n')[0].replace(tag, '').trim();
        const date = version.date ? new Date(version.date).toLocaleDateString('zh-CN') : '';
        const parts = [
            index === 0 ? `最新版：${tag}` : tag,
            date,
            title.slice(0, 36)
        ].filter(Boolean);
        return parts.join(' · ');
    }

    // 版本下拉：程序更新和测试版更新共用。默认选中第一项（最新版），选中时回调 onSelect(版本)。
    function renderVersionPicker(button, menu, versions, formatLabel, onSelect) {
        const list = Array.isArray(versions) ? versions : [];
        const choose = (version, index) => {
            button.textContent = version ? formatLabel(version, index) : '最新版';
            onSelect(version || null);
        };
        menu.innerHTML = '';
        choose(list[0], 0);
        list.forEach((version, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'rp-sync-version-option';
            item.textContent = formatLabel(version, index);
            item.addEventListener('click', () => {
                choose(version, index);
                menu.classList.remove('is-open');
            });
            menu.appendChild(item);
        });
    }

    function renderAppUpdateVersions(versions) {
        if (!appUpdateVersionButton || !appUpdateVersionMenu) return;
        renderVersionPicker(appUpdateVersionButton, appUpdateVersionMenu, versions, formatAppUpdateVersionLabel, (version) => {
            appUpdateSelectedTarget = version?.tag || version?.sha || '';
        });
    }

    async function checkAppUpdate() {
        if (state.syncing) return;

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);

        try {
            updateProgress(15, '正在检测 RP-Hub 上游版本...');
            const result = await postSync({ action: 'app-update-check' });
            renderAppUpdateVersions(result?.versions);
            const current = formatCurrentAppVersion(result);
            const latest = result?.latest?.tag || formatShortSha(result?.latest?.sha);
            const previous = result?.previous?.tag || result?.previous?.sha ? `，可回滚 ${result?.previous?.tag || formatShortSha(result.previous.sha)}` : '';
            const cacheText = result?.cache?.hit
                ? (result.cache.stale ? '，使用缓存列表' : '，命中缓存')
                : '';
            if (result?.updateAvailable) {
                updateProgress(100, `发现 Release ${latest}：当前为 ${current}，可以更新${previous}${cacheText}。`);
            } else {
                updateProgress(100, `当前已是最新 Release：${current}${previous}${cacheText}。`);
            }
        } catch (error) {
            updateProgress(100, error.message || '版本检测失败。');
        } finally {
            state.syncing = false;
            setActionButtonsDisabled(false);
            updateButtonState();
        }
    }

    async function applyAppUpdate() {
        if (state.syncing) return;

        const target = getSelectedAppUpdateTarget();
        const targetText = target || '最新版';
        const confirmed = await openInlineConfirm({
            title: '更新版本',
            message: `将从 RP-Hub 拉取 ${targetText} 并写入服务器覆盖层。只保留当前版和上一版，云同步数据不会被覆盖。`,
            confirmText: '开始更新'
        });
        if (!confirmed) return;

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);

        try {
            await flushAppState();
            startEstimatedProgress({
                from: 10,
                to: 88,
                durationMs: 165_000,
                text: '正在连接 RP-Hub 上游'
            });
            const result = await postSync({ action: 'app-update-apply', target }, {
                timeoutMs: 180_000,
                retryCount: 1
            });
            stopEstimatedProgress();
            const latest = result?.latest?.tag || formatShortSha(result?.latest?.sha);
            if (result?.alreadyUpToDate) {
                updateProgress(100, `程序已是最新版本：${latest}。`);
                setActionButtonsDisabled(false);
                return;
            }
            updateProgress(100, `程序更新完成：${latest}。页面即将刷新...`);
            setTimeout(() => {
                location.reload();
            }, 900);
        } catch (error) {
            stopEstimatedProgress();
            updateProgress(100, error.message || '程序更新失败。');
            setActionButtonsDisabled(false);
        } finally {
            stopEstimatedProgress();
            state.syncing = false;
            updateButtonState();
        }
    }

    async function rollbackAppUpdate() {
        if (state.syncing) return;

        const confirmed = await openInlineConfirm({
            title: '回滚上一版',
            message: '将切换到上一版程序覆盖层，云同步数据不会被覆盖。',
            confirmText: '确认回滚',
            variant: 'danger'
        });
        if (!confirmed) return;

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);

        try {
            await flushAppState();
            updateProgress(20, '正在回滚上一版程序...');
            const result = await postSync({ action: 'app-update-rollback' }, {
                timeoutMs: 120_000,
                retryCount: 1
            });
            updateProgress(100, `已回滚到 ${result?.rolledBackTo?.tag || formatShortSha(result?.rolledBackTo?.sha)}，页面即将刷新...`);
            setTimeout(() => {
                location.reload();
            }, 900);
        } catch (error) {
            updateProgress(100, error.message || '程序回滚失败。');
            setActionButtonsDisabled(false);
        } finally {
            state.syncing = false;
            updateButtonState();
        }
    }

    async function submitSyncPassword() {
        if (checkingPassword) return;

        const password = passwordInput.value;
        if (!password) {
            passwordStatus.textContent = '请输入同步密码。';
            passwordInput.focus();
            return;
        }

        checkingPassword = true;
        passwordSubmitButton.disabled = true;
        passwordStatus.textContent = '正在验证密码...';

        try {
            const auth = await getAuthStatus(password);
            if (auth.authRequired && !auth.authenticated) {
                clearStoredSyncPassword();
                passwordStatus.textContent = '密码不正确，请重新输入。';
                passwordInput.select();
                return;
            }

            if (auth.authRequired) {
                saveStoredSyncPassword(password);
            } else {
                clearStoredSyncPassword();
            }
            passwordModalRoot.classList.remove('is-open');
            openSyncPanel();
        } catch (error) {
            passwordStatus.textContent = error.message || '密码验证失败，请稍后再试。';
        } finally {
            checkingPassword = false;
            passwordSubmitButton.disabled = false;
        }
    }

    async function handleSyncButtonClick() {
        if (state.syncing || checkingPassword) return;

        syncEntry?.update({ busy: true });
        try {
            const auth = await getAuthStatus();
            if (!auth.authRequired || auth.authenticated) {
                openSyncPanel();
                return;
            }

            clearStoredSyncPassword();
            openPasswordModal('请输入同步密码后继续。');
        } catch (error) {
            if (error.status === 401) {
                clearStoredSyncPassword();
                openPasswordModal('请输入同步密码后继续。');
                return;
            }

            window.alert(error.message || '同步验证失败，请稍后再试。');
        } finally {
            updateButtonState();
        }
    }

    function ensureModal() {
        if (modalRoot) return;

        modalRoot = document.createElement('div');
        modalRoot.className = 'rp-sync-modal';
        modalRoot.innerHTML = `
            <div class="rp-sync-modal__backdrop"></div>
            <div class="rp-sync-modal__panel">
                <div class="rp-sync-modal__header">
                    <h3 class="rp-sync-modal__title">
                        <span class="rp-sync-modal__title-sub">R2 Sync</span>
                        <span class="rp-sync-modal__title-main">云同步</span>
                    </h3>
                    <button type="button" class="rp-sync-modal__close" aria-label="关闭">×</button>
                </div>
                <div class="rp-sync-main-actions">
                    <button type="button" class="rp-sync-action-button" data-action="pull">拉取</button>
                    <button type="button" class="rp-sync-action-button is-primary" data-action="push">上传</button>
                </div>
                <p class="rp-sync-modal__status">选择同步</p>
                <div class="rp-sync-progress">
                    <div class="rp-sync-progress__bar"></div>
                </div>
                <div class="rp-sync-progress__value">0%</div>
                <details class="rp-sync-update-details">
                    <summary>程序更新</summary>
                    <div class="rp-sync-update-body">
                        <p class="rp-sync-choice__desc">只显示正式发布版本。</p>
                        <div class="rp-sync-version-fields">
                            <label>
                                <span>目标版本</span>
                                <div class="rp-sync-version-picker">
                                    <button type="button" class="rp-sync-version-button" data-action="app-update-version-button">最新版</button>
                                    <div class="rp-sync-version-menu" data-action="app-update-version-menu"></div>
                                </div>
                            </label>
                        </div>
                        <div class="rp-sync-inline-actions">
                            <button type="button" class="rp-sync-modal__button" data-action="app-update-check">检测版本</button>
                            <button type="button" class="rp-sync-modal__button is-primary" data-action="app-update-apply">更新版本</button>
                            <button type="button" class="rp-sync-modal__button" data-action="app-update-rollback">回滚上一版</button>
                        </div>
                    </div>
                </details>
                <details class="rp-sync-update-details">
                    <summary>测试版更新</summary>
                    <div class="rp-sync-update-body">
                        <p class="rp-sync-choice__desc" data-role="self-update-info">从分发端获取测试版。站点设置 CF_API_TOKEN 后可一键更新。</p>
                        <div class="rp-sync-version-fields">
                            <label>
                                <span>目标版本</span>
                                <div class="rp-sync-version-picker">
                                    <button type="button" class="rp-sync-version-button" data-action="self-update-version-button">最新版</button>
                                    <div class="rp-sync-version-menu" data-action="self-update-version-menu"></div>
                                </div>
                            </label>
                        </div>
                        <div class="rp-sync-inline-actions">
                            <button type="button" class="rp-sync-modal__button" data-action="self-update-check">检测版本</button>
                            <button type="button" class="rp-sync-modal__button is-primary" data-action="self-update-apply">一键更新</button>
                            <button type="button" class="rp-sync-modal__button" data-action="self-update-rollback">回退上一次部署</button>
                        </div>
                    </div>
                </details>
                <div class="rp-sync-confirm" aria-hidden="true">
                    <div class="rp-sync-confirm__box" role="dialog" aria-modal="true">
                        <div class="rp-sync-confirm__title">确认操作</div>
                        <p class="rp-sync-confirm__message">继续执行这个操作吗？</p>
                        <div class="rp-sync-confirm__actions">
                            <button type="button" class="rp-sync-modal__button" data-action="confirm-cancel">取消</button>
                            <button type="button" class="rp-sync-modal__button is-primary" data-action="confirm-submit">继续</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modalRoot);
        modalTitle = modalRoot.querySelector('.rp-sync-modal__title');
        modalStatus = modalRoot.querySelector('.rp-sync-modal__status');
        modalProgressBar = modalRoot.querySelector('.rp-sync-progress__bar');
        modalProgressValue = modalRoot.querySelector('.rp-sync-progress__value');
        pullButton = modalRoot.querySelector('[data-action="pull"]');
        pushButton = modalRoot.querySelector('[data-action="push"]');
        appUpdateCheckButton = modalRoot.querySelector('[data-action="app-update-check"]');
        appUpdateApplyButton = modalRoot.querySelector('[data-action="app-update-apply"]');
        appUpdateRollbackButton = modalRoot.querySelector('[data-action="app-update-rollback"]');
        selfUpdateCheckButton = modalRoot.querySelector('[data-action="self-update-check"]');
        selfUpdateApplyButton = modalRoot.querySelector('[data-action="self-update-apply"]');
        selfUpdateRollbackButton = modalRoot.querySelector('[data-action="self-update-rollback"]');
        selfUpdateInfo = modalRoot.querySelector('[data-role="self-update-info"]');
        selfUpdateVersionButton = modalRoot.querySelector('[data-action="self-update-version-button"]');
        selfUpdateVersionMenu = modalRoot.querySelector('[data-action="self-update-version-menu"]');
        appUpdateVersionButton = modalRoot.querySelector('[data-action="app-update-version-button"]');
        appUpdateVersionMenu = modalRoot.querySelector('[data-action="app-update-version-menu"]');
        closeButton = modalRoot.querySelector('.rp-sync-modal__close');
        confirmLayer = modalRoot.querySelector('.rp-sync-confirm');
        confirmTitle = modalRoot.querySelector('.rp-sync-confirm__title');
        confirmMessage = modalRoot.querySelector('.rp-sync-confirm__message');
        confirmCancelButton = modalRoot.querySelector('[data-action="confirm-cancel"]');
        confirmSubmitButton = modalRoot.querySelector('[data-action="confirm-submit"]');

        modalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', () => {
            if (!state.syncing) closeModal();
        });
        pullButton.addEventListener('click', () => pullFromServer().catch(() => { }));
        pushButton.addEventListener('click', () => pushToServer().catch(() => { }));
        appUpdateCheckButton.addEventListener('click', () => checkAppUpdate().catch(() => { }));
        appUpdateApplyButton.addEventListener('click', () => applyAppUpdate().catch(() => { }));
        appUpdateRollbackButton.addEventListener('click', () => rollbackAppUpdate().catch(() => { }));
        selfUpdateCheckButton.addEventListener('click', () => checkSelfUpdate().catch(() => { }));
        selfUpdateApplyButton.addEventListener('click', () => applySelfUpdate().catch(() => { }));
        selfUpdateRollbackButton.addEventListener('click', () => rollbackSelfUpdate().catch(() => { }));
        confirmCancelButton.addEventListener('click', () => settleInlineConfirm(false));
        confirmSubmitButton.addEventListener('click', () => settleInlineConfirm(true));
        confirmLayer.addEventListener('click', (event) => {
            if (event.target === confirmLayer) settleInlineConfirm(false);
        });
        for (const [button, menu] of [[appUpdateVersionButton, appUpdateVersionMenu], [selfUpdateVersionButton, selfUpdateVersionMenu]]) {
            button.addEventListener('click', () => {
                if (!state.syncing) menu.classList.toggle('is-open');
            });
        }
        document.addEventListener('click', (event) => {
            if (!modalRoot?.contains(event.target)) return;
            const picker = event.target.closest('.rp-sync-version-picker');
            modalRoot.querySelectorAll('.rp-sync-version-menu.is-open').forEach((menu) => {
                if (menu.parentElement !== picker) menu.classList.remove('is-open');
            });
        });
        if (closeButton) closeButton.addEventListener('click', closeModal);
    }

    function rememberSyncFocus() {
        const active = document.activeElement;
        if (!modalRoot?.contains(active) && !passwordModalRoot?.contains(active)) syncReturnFocus = active;
    }

    // 测试版：外壳从分发端取发布包部署到本站；站点没设置 CF_API_TOKEN 时改为下载部署包。
    async function runSelfUpdateTask(task) {
        if (state.syncing) return;
        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);
        try {
            await task();
        } catch (error) {
            updateProgress(100, error.message || '测试版操作失败。');
        } finally {
            state.syncing = false;
            setActionButtonsDisabled(false);
            updateButtonState();
        }
    }

    function reloadAfterDeploy(text) {
        updateProgress(100, `${text}约半分钟后生效，页面将自动刷新。`);
        setTimeout(() => location.reload(), 40_000);
    }

    function checkSelfUpdate() {
        return runSelfUpdateTask(async () => {
            updateProgress(20, '正在检测测试版...');
            selfUpdateStatus = await postSync({ action: 'self-update-status' });
            selfUpdateApplyButton.textContent = selfUpdateStatus.selfDeploy ? '一键更新' : '下载部署包';
            const current = selfUpdateStatus.current;
            const formatLabel = (version, index) => [index === 0 ? `最新版：${version.tag}` : version.tag,
                version.publishedAt ? new Date(version.publishedAt).toLocaleDateString('zh-CN') : '',
                version.tag === current ? '当前' : ''].filter(Boolean).join(' · ');
            renderVersionPicker(selfUpdateVersionButton, selfUpdateVersionMenu, selfUpdateStatus.versions, formatLabel, (version) => {
                selfUpdateSelected = version;
                selfUpdateInfo.textContent = version ? `${version.tag}：${version.notes || '无更新说明'}` : '分发端暂无测试版。';
            });
            updateProgress(100, selfUpdateStatus.updateAvailable
                ? `发现测试版 ${selfUpdateStatus.latest}，当前为 ${selfUpdateStatus.current}。`
                : `当前已是最新测试版：${selfUpdateStatus.current}。`);
        });
    }

    async function applySelfUpdate() {
        if (!selfUpdateStatus) await checkSelfUpdate();
        const target = selfUpdateSelected;
        if (!target) return;
        if (!selfUpdateStatus.selfDeploy) {
            if (target.zipUrl) window.open(target.zipUrl, '_blank', 'noopener');
            updateProgress(100, `站点未设置 CF_API_TOKEN，请下载部署包后上传到 Cloudflare Pages：${target.zipUrl || '分发端暂无下载地址'}`);
            return;
        }
        const confirmed = await openInlineConfirm({
            title: '更新测试版',
            message: `将把本站部署为测试版 ${target.tag}。云同步数据不受影响，出问题可回退上一次部署。`,
            confirmText: '开始更新'
        });
        if (!confirmed) return;
        await runSelfUpdateTask(async () => {
            await flushAppState();
            updateProgress(30, `正在部署测试版 ${target.tag}...`);
            const result = await postSync({ action: 'self-update-apply', target: target.tag }, { timeoutMs: 180_000, retryCount: 0 });
            reloadAfterDeploy(`测试版 ${result.version} 已提交部署，`);
        });
    }

    async function rollbackSelfUpdate() {
        const confirmed = await openInlineConfirm({
            title: '回退上一次部署',
            message: '将把本站切回上一次 Cloudflare 部署，云同步数据不受影响。',
            confirmText: '确认回退',
            variant: 'danger'
        });
        if (!confirmed) return;
        await runSelfUpdateTask(async () => {
            updateProgress(30, '正在回退...');
            await postSync({ action: 'self-update-rollback' }, { timeoutMs: 120_000, retryCount: 0 });
            reloadAfterDeploy('已切回上一次部署，');
        });
    }

    function returnSyncFocus() {
        if (syncReturnFocus?.isConnected && syncReturnFocus.getClientRects().length) syncReturnFocus.focus();
        syncReturnFocus = null;
    }

    function openModal() {
        rememberSyncFocus();
        ensureModal();
        modalRoot.classList.add('is-open');
        setModalTitle();
        updateProgress(state.progress, state.statusText || '选择同步');
        setActionButtonsDisabled(state.syncing);
        if (!modalRoot.contains(document.activeElement)) closeButton?.focus();
    }

    function closeModal() {
        if (state.syncing || !modalRoot) return;
        settleInlineConfirm(false);
        modalRoot.classList.remove('is-open');
        returnSyncFocus();
    }

    function pullFromServer() { return runSyncLocked(performPullSync); }

    async function performPullSync() {
        if (state.syncing) return;

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);
        let restoreStarted = false;
        let restoreSucceeded = false;

        try {
            updateProgress(0, '正在读取服务器同步清单...');
            const manifestResponse = await postSync({ action: 'pull-manifest' });
            const remote = manifestResponse.remote;
            if (!remote) {
                updateProgress(100, '服务器当前没有可同步的数据。');
                setActionButtonsDisabled(false);
                return;
            }
            if (Number(remote.totalBytes || 0) > CONFIG.maxSnapshotBytes) {
                throw new Error(`服务器数据太大：${remote.totalBytes}/${CONFIG.maxSnapshotBytes}。`);
            }

            if (remote.snapshotFormat === 'rp-sync-jsonl-v2' || Number(remote.schemaVersion) === 5) {
                throw new Error('服务器快照格式不受支持。');
            }

            if (remote.snapshotFormat === SNAPSHOT_FORMAT
                && Number(remote.schemaVersion) === SNAPSHOT_SCHEMA_VERSION) {
                await restoreStreamSnapshot(remote, () => {
                    globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
                    restoreStarted = true;
                });
            } else if (!remote.snapshotFormat || remote.snapshotFormat === LEGACY_SNAPSHOT_FORMAT) {
                const response = await downloadLegacyRemoteSnapshot(remote);
                if (!response) throw new Error('服务器当前没有可同步的数据。');
                updateProgress(55, '旧版数据校验完成，正在写入本地浏览器数据...');
                const remoteSnapshot = JSON.parse(response.json);
                if (!remoteSnapshot
                    || (!Array.isArray(remoteSnapshot.indexedDB)
                        && !Array.isArray(remoteSnapshot.localStorage))) {
                    throw new Error('服务器数据格式不正确。');
                }
                globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
                restoreStarted = true;
                await replaceLocalSnapshot(remoteSnapshot);
            } else {
                throw new Error('服务器快照格式不受支持。');
            }

            restoreSucceeded = true;
            state.reloadPending = true;
            updateProgress(100, '服务器数据已写入本地，页面即将刷新...');
            setTimeout(() => {
                location.reload();
            }, 700);
        } catch (error) {
            let finalError = error;
            if (restoreStarted && !restoreSucceeded) {
                delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
                try {
                    await releaseDeferredPersistenceWrites();
                    if (typeof globalThis.RPHubCharStore?.waitForPendingMutations === 'function') {
                        await globalThis.RPHubCharStore.waitForPendingMutations();
                    }
                } catch (deferredError) {
                    finalError = new Error(
                        `${error?.message || '服务器同步失败。'} 恢复期间待保存数据写回失败：${deferredError?.message || deferredError}`,
                        { cause: deferredError }
                    );
                }
            }
            updateProgress(100, finalError.message || '服务器同步失败。');
            setActionButtonsDisabled(false);
        } finally {
            state.syncing = state.reloadPending;
            updateButtonState();
        }
    }

    function pushToServer() { return runSyncLocked(performPushSync); }

    async function performPushSync() {
        if (state.syncing) return;

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);

        try {
            updateProgress(8, '正在整理本地数据...');
            if (!globalThis.RPHubCharStore || typeof globalThis.RPHubCharStore.assertPushAllowed !== 'function') {
                throw new Error('角色卡存储自检不可用，已取消上传。');
            }
            await globalThis.RPHubCharStore.assertPushAllowed();
            await flushAppState();
            globalThis.RPH_R2_SNAPSHOT_IN_PROGRESS = true;

            updateProgress(16, '正在流式扫描本地浏览器数据...');
            const snapshot = await buildStreamSnapshotManifest();

            updateProgress(24, '正在检查服务器数据...');
            const remoteStatus = await postSync({ action: 'pull-manifest' });
            if (remoteStatus?.remote?.snapshotFormat === SNAPSHOT_FORMAT
                && Number(remoteStatus.remote.schemaVersion) === SNAPSHOT_SCHEMA_VERSION
                && remoteStatus.remote.checksum === snapshot.checksum) {
                updateProgress(100, '服务器已是同一份数据，无需重复上传。');
                setActionButtonsDisabled(false);
                return;
            }

            updateProgress(30, '正在准备流式上传...');
            let committed = false;
            for (let conflictAttempt = 0; conflictAttempt < 4; conflictAttempt += 1) {
                const uploadSession = await postSync({
                    action: 'upload-create',
                    checksum: snapshot.checksum,
                    snapshotFormat: snapshot.snapshotFormat,
                    schemaVersion: snapshot.schemaVersion,
                    chunkerProfile: snapshot.chunkerProfile,
                    recordCount: snapshot.recordCount,
                    chunkSize: CONFIG.chunkSize,
                    chunkCount: snapshot.chunkManifest.length,
                    totalBytes: snapshot.totalBytes,
                    chunkManifest: snapshot.chunkManifest
                });
                if (uploadSession.alreadyUpToDate) {
                    updateProgress(100, '服务器已是同一份数据，无需重复上传。');
                    setActionButtonsDisabled(false);
                    return;
                }
                const missingIndices = Array.isArray(uploadSession.missingIndices)
                    ? uploadSession.missingIndices
                    : snapshot.chunkManifest.map((chunk) => chunk.index);
                if (new Set(missingIndices).size !== missingIndices.length
                    || missingIndices.some((index) => !Number.isInteger(index)
                        || index < 0
                        || index >= snapshot.chunkManifest.length)) {
                    throw new Error('服务器返回的待上传分片清单无效。');
                }
                updateProgress(missingIndices.length > 0 ? 36 : 88,
                    missingIndices.length > 0 ? '正在进行第二遍扫描并上传缺少的分片...' : '服务器已有全部分片，正在核对本地数据...');
                await uploadMissingStreamChunks(snapshot, missingIndices);
                updateProgress(92, '正在完成服务器提交...');
                try {
                    const commitResponse = await postSync({
                        action: 'upload-complete',
                        checksum: snapshot.checksum,
                        snapshotFormat: snapshot.snapshotFormat,
                        schemaVersion: snapshot.schemaVersion,
                        chunkerProfile: snapshot.chunkerProfile,
                        recordCount: snapshot.recordCount,
                        chunkSize: CONFIG.chunkSize,
                        chunkCount: snapshot.chunkManifest.length,
                        totalBytes: snapshot.totalBytes,
                        chunkManifest: snapshot.chunkManifest,
                        expectedVersion: uploadSession.previousVersion
                    }, { retryCount: 1, timeoutMs: CONFIG.commitTimeoutMs });
                    const confirmation = await postSync({ action: 'pull-manifest' });
                    if (!confirmation.remote
                        || confirmation.remote.checksum !== snapshot.checksum
                        || Number(confirmation.remote.version) !== Number(commitResponse.version)
                        || confirmation.remote.snapshotFormat !== SNAPSHOT_FORMAT
                        || Number(confirmation.remote.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) {
                        throw new Error('服务器提交结果校验失败，请重新上传。');
                    }
                    committed = true;
                    break;
                } catch (error) {
                    if (Number(error?.status) !== 409 || conflictAttempt >= 3) throw error;
                    await wait(CONFIG.retryDelayMs);
                }
            }
            if (!committed) throw new Error('同步冲突重试失败，请稍后重试。');

            updateProgress(100, '上传成功。');
            setActionButtonsDisabled(false);
        } catch (error) {
            updateProgress(100, error?.message || '本地同步失败。');
            setActionButtonsDisabled(false);
        } finally {
            delete globalThis.RPH_R2_SNAPSHOT_IN_PROGRESS;
            state.syncing = false;
            updateButtonState();
        }
    }

    function mountSyncButton() {
        if (syncEntry) return;
        syncEntry = window.RPHubNavAdapter.registerEntry({
            id: 'sync', label: '同步', attributes: { 'data-rph-sync-entry': '' },
            iconPaths: ['M20 7h-9m9 0-3-3m3 3-3 3M4 17h9m-9 0 3 3m-3-3 3-3', 'M6 7a7 7 0 0112-2M18 17a7 7 0 01-12 2'],
            onClick: handleSyncButtonClick, waitForClose: true
        });
        updateButtonState();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ensureModal();
            mountSyncButton();
        }, { once: true });
    } else {
        ensureModal();
        mountSyncButton();
    }
})();
