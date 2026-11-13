(function () {
    const SNAPSHOT_FORMAT = 'rp-sync-jsonl-v1';
    // 版本 6：分块 gzip 压缩后上传（快照内容和版本 4 相同，只是传输和存储时压缩）；
    // 浏览器不支持压缩时仍按版本 4 不压缩上传。拉取两种都认。
    const RAW_SCHEMA_VERSION = 4;
    const GZIP_SCHEMA_VERSION = 6;
    const SNAPSHOT_SCHEMA_VERSION = typeof CompressionStream === 'function' ? GZIP_SCHEMA_VERSION : RAW_SCHEMA_VERSION;
    const isStreamSchema = (value) => Number(value) === RAW_SCHEMA_VERSION || Number(value) === GZIP_SCHEMA_VERSION;
    const LEGACY_SNAPSHOT_FORMAT = 'rp-sync-json-v3';
    // 魔改版（cy-2-u/rp）的云端格式，只读：「下载」能导入，上传一律用我们的格式。
    const FORK_SNAPSHOT_FORMAT = 'rp-sync-paged-jsonl-v4';
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
            'sakura_gramophone_playlist_v6', 'sakura_gramophone_settings_v1', 'rphub_sakura_chat_extra_slots_v1'
        ],
        ignoredLocalStorageKeys: ['roleplay_hub_update_id'],
        chunkSize: 2 * 1024 * 1024,
        maxRecordBytes: 127 * 1024 * 1024, // Chrome/Edge/安卓浏览器单条 IndexedDB 记录的硬上限（133169152 字节），再大同步到那些设备就写不进去
        warnRecordBytes: 32 * 1024 * 1024,
        uploadPartConcurrency: 6,
        downloadPartConcurrency: 3,
        jsonDownloadPartChunks: 8,
        downloadTaskConcurrency: 2,
        downloadRangeBytes: 16 * 1024 * 1024,
        downloadPendingBytes: 32 * 1024 * 1024,
        downloadCacheBytes: 256 * 1024 * 1024,
        requestTimeoutMs: 60_000,
        transferTimeoutMs: 30_000, // 传分片：基础 30 秒，再按 50KB/s 加传输时间；慢网络给够，断网也不用干等太久
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

    // ---- 快速上传的记账：哪些键改过了 ----
    // 写库的地方太多（官方代码、插件、生图模块都写），所以挂在 IndexedDB 的原型上记，谁写都记得到。
    // 每个改过的键在本机 localStorage 里占一个 rp_hub_sync_dirty_v1: 开头的条目（这个前缀不进同步），值是写入时的批次记号。
    // 每次开始上传换一个批次记号（存在 localStorage，几个标签页共用）：之后的写入按新记号重新标记，
    // 上传成功后只清掉记号没变的，上传途中又写过的留到下次。
    // 改过的键太多（比如整站恢复）就记一个「全部」标记，快速上传不比完整扫描省，直接完整扫描。
    const DIRTY_PREFIX = 'rp_hub_sync_dirty_v1:';
    const DIRTY_FULL = `${DIRTY_PREFIX}*`;
    const DIRTY_EPOCH = 'rp_hub_sync_dirty_epoch_v1';
    const DIRTY_LIMIT = 3000;
    const LAYOUT_DB = 'RPHubSyncState'; // 上次上传的分片布局和这次要上传的分片暂存在这个单独的小库里（不进同步，写它也不记账）
    const PENDING_UPLOAD_KEY = 'rp_hub_sync_pending_upload_v1'; // 已经开始往服务器传、还没传完；页面关了下次打开提示接着传
    let newMarks = 0;

    function markDirty(dbName, storeName, key) {
        if (!CONFIG.knownDatabases.some((dbDef) => dbDef.name === dbName && dbDef.stores.includes(storeName))) return;
        const markKey = DIRTY_PREFIX + JSON.stringify([dbName, storeName, key === undefined ? null : key]);
        try {
            const epoch = localStorage.getItem(DIRTY_EPOCH) || '0';
            if (localStorage.getItem(DIRTY_FULL) === epoch) return; // 这一批已经记了「全部」
            const previous = localStorage.getItem(markKey);
            if (previous === epoch) return;
            if (previous === null && (newMarks += 1) > DIRTY_LIMIT) localStorage.setItem(DIRTY_FULL, epoch);
            else localStorage.setItem(markKey, epoch);
        } catch (_) {
            discardSyncLayout(); // 记不下来就作废上次的布局，下次上传完整扫描
        }
    }

    function markDirtyAll() {
        try { localStorage.setItem(DIRTY_FULL, localStorage.getItem(DIRTY_EPOCH) || '0'); } catch (_) { discardSyncLayout(); }
    }

    // 拉取是直接改本地库，别的标签页内存里还是旧数据：开始时让它们把写延后，完成或失败后让它们刷新，别拿旧数据盖回去。
    // 键以 rp_hub_sync_ 开头，不进快照。
    const RESTORE_BROADCAST_KEY = 'rp_hub_sync_restore_v1';
    const RESTORE_NOTICE_KEY = 'rp_hub_sync_restore_notice_v1';
    function announceRestore(phase) {
        try { localStorage.setItem(RESTORE_BROADCAST_KEY, `${phase}:${Date.now()}`); } catch (_) { /* storage blocked */ }
    }
    window.addEventListener('storage', (event) => {
        if (event.key !== RESTORE_BROADCAST_KEY || !event.newValue) return;
        if (event.newValue.startsWith('start:')) globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
        else location.reload();
    });
    function showRestoreNotice() {
        const notice = localStorage.getItem(RESTORE_NOTICE_KEY);
        if (!notice) return;
        try { localStorage.removeItem(RESTORE_NOTICE_KEY); } catch (_) { /* storage blocked */ }
        window.RPHubUI?.toast?.(notice, { kind: 'error', duration: 10000 });
    }

    function readDirtyMarks() {
        const marks = new Map();
        let fullMark = null;
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key || !key.startsWith(DIRTY_PREFIX)) continue;
            if (key === DIRTY_FULL) fullMark = localStorage.getItem(key);
            else marks.set(key.slice(DIRTY_PREFIX.length), localStorage.getItem(key));
        }
        return { full: fullMark !== null || marks.size > DIRTY_LIMIT, fullMark, marks };
    }

    function readDirty() {
        const { full, marks } = readDirtyMarks();
        return { full, tokens: [...marks.keys()] };
    }

    // 开始上传时：记下现在的标记，换一个批次记号
    function takeDirty() {
        const taken = readDirtyMarks();
        try { localStorage.setItem(DIRTY_EPOCH, crypto.randomUUID?.() || String(Date.now())); } catch (_) { /* storage blocked */ }
        newMarks = 0;
        return taken;
    }

    // 上传成功后：只清掉记号没变的（上传途中又写过的留着）。完整上传连「全部」标记一起清。
    function clearDirty(taken, uploadedFull) {
        try {
            for (const [token, value] of taken.marks) {
                if (localStorage.getItem(DIRTY_PREFIX + token) === value) localStorage.removeItem(DIRTY_PREFIX + token);
            }
            if (uploadedFull && taken.fullMark !== null && localStorage.getItem(DIRTY_FULL) === taken.fullMark) localStorage.removeItem(DIRTY_FULL);
        } catch (_) { /* storage blocked */ }
    }

    (function hookIndexedDbWrites() {
        if (typeof IDBObjectStore === 'undefined' || typeof IDBCursor === 'undefined' || IDBObjectStore.prototype.put.rphDirtyHooked) return;
        // 只认字符串和数字键，别的键当成整个表都改过
        const simpleKey = (key) => (typeof key === 'string' || typeof key === 'number' ? key : undefined);
        const keyOf = (store, value, key) => {
            if (key !== undefined) return simpleKey(key);
            const path = store.keyPath;
            if (typeof path === 'string' && value && typeof value === 'object') return simpleKey(path.split('.').reduce((node, part) => node?.[part], value));
            return undefined;
        };
        const storeOf = (source) => (typeof IDBIndex !== 'undefined' && source instanceof IDBIndex ? source.objectStore : source);
        const hook = (proto, name, describe) => {
            const native = proto[name];
            const wrapped = function (...args) {
                try {
                    const { store, key } = describe(this, args);
                    markDirty(store.transaction.db.name, store.name, key);
                } catch (_) { /* 记账出错不影响写入本身 */ }
                return native.apply(this, args);
            };
            wrapped.rphDirtyHooked = true;
            proto[name] = wrapped;
        };
        hook(IDBObjectStore.prototype, 'put', (store, [value, key]) => ({ store, key: keyOf(store, value, key) }));
        hook(IDBObjectStore.prototype, 'add', (store, [value, key]) => ({ store, key: keyOf(store, value, key) }));
        hook(IDBObjectStore.prototype, 'delete', (store, [key]) => ({ store, key: simpleKey(key) }));
        hook(IDBObjectStore.prototype, 'clear', (store) => ({ store, key: undefined }));
        hook(IDBCursor.prototype, 'update', (cursor) => ({ store: storeOf(cursor.source), key: simpleKey(cursor.primaryKey) }));
        hook(IDBCursor.prototype, 'delete', (cursor) => ({ store: storeOf(cursor.source), key: simpleKey(cursor.primaryKey) }));
    })();

    const state = {
        syncing: false,
        background: false, // 上传进入「只从本机暂存往上传」那一段：不挡页面，可以关掉同步面板
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
    let pushFullButton = null;
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

