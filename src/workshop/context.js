    function openAppDatabase() {
        if (state.dbPromise) return state.dbPromise;
        state.dbPromise = new Promise((resolve, reject) => {
            if (!globalThis.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            const request = indexedDB.open(DB_NAME);
            let unexpectedUpgrade = false;
            request.onupgradeneeded = () => {
                unexpectedUpgrade = true;
                try { request.transaction.abort(); } catch (_) { /* no-op */ }
            };
            request.onsuccess = () => {
                const db = request.result;
                if (unexpectedUpgrade || !db.objectStoreNames.contains(DB_STORE)) {
                    db.close();
                    reject(new Error('RPHubDB/store unavailable'));
                    return;
                }
                db.onversionchange = () => { db.close(); state.dbPromise = null; };
                resolve(db);
            };
            request.onerror = () => reject(request.error || new Error('RPHubDB open failed'));
            request.onblocked = () => reject(new Error('RPHubDB open blocked'));
        }).catch((error) => {
            state.dbPromise = null;
            throw error;
        });
        return state.dbPromise;
    }

    /* @shared/database */

    async function appDbGet(key) {
        const db = await openAppDatabase();
        const request = await withStore(db, DB_STORE, 'readonly', store => store.get(String(key)));
        return request.result;
    }

    async function appDbKeys(prefix) {
        const db = await openAppDatabase();
        const keyPrefix = String(prefix || '');
        return withStore(db, DB_STORE, 'readonly', store => {
            const keys = [];
            const request = store.openKeyCursor(IDBKeyRange.bound(keyPrefix, keyPrefix + '\uffff'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                if (typeof cursor.key === 'string' && cursor.key.startsWith(keyPrefix)) keys.push(cursor.key);
                cursor.continue();
            };
            return keys;
        });
    }

    function storageByteLength(value) {
        if (globalThis.TextEncoder) return new TextEncoder().encode(value).byteLength;
        return new Blob([value]).size;
    }

    function persistSetting(key, operation) {
        if (!globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS) return operation();
        void trackPersistence('setting:' + key, () => globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE(operation))
            .catch(error => log('deferred module setting failed', error));
    }

    function buildContext(id) {
        const prefix = `rph_mod_${id}::`;
        return {
            log: (...args) => console.info(`[RPH-mod:${id}]`, ...args),
            version: { api: API_VERSION, loader: LOADER_VERSION },
            upstream: { updateInfo: globalThis.RPH_R2_UPDATE_INFO ?? null },
            storage: {
                get(key) {
                    try { return localStorage.getItem(prefix + String(key)); }
                    catch (_) { return null; }
                },
                set(key, value) {
                    const serialized = String(value);
                    if (storageByteLength(serialized) > STORAGE_VALUE_LIMIT) {
                        throw new RangeError('module storage value exceeds 64KB');
                    }
                    persistSetting(prefix + String(key), () => localStorage.setItem(prefix + String(key), serialized));
                },
                remove(key) {
                    try { persistSetting(prefix + String(key), () => localStorage.removeItem(prefix + String(key))); } catch (_) { /* no-op */ }
                }
            },
            appDb: {
                get: appDbGet,
                keys: appDbKeys
            },
            data: {
                get: key => workshopTransaction('data', 'readonly', store => store.get(id + '::' + String(key))),
                set(key, value) {
                    validateData(value);
                    const copy = structuredClone(value);
                    const fullKey = id + '::' + String(key);
                    return workshopWrite('data', fullKey, store => store.put(copy, fullKey));
                },
                remove(key) {
                    const fullKey = id + '::' + String(key);
                    return workshopWrite('data', fullKey, store => store.delete(fullKey));
                }
            },
            persistence: {
                track: (key, operation) => trackPersistence(id + ':' + String(key), operation)
            },
            ui: {
                toast: showToast,
                addSidebarEntry: (options) => addSidebarEntry(id, options),
                addComposerButton: (options) => addComposerButton(id, options),
                addPage: (options) => addPage(id, options),
                openPanel
            },
            events: {
                on: (name, callback) => subscribe(id, name, callback)
            },
            app: {
                get: appGet,
                set: appSet,
                watch: appWatch,
                saveChatHistory
            },
            requests: {
                onChat: callback => onChatRequest(id, callback)
            },
            // API 5：生图接口和生图参数，由生图模块（DB/image-module.js）实现。
            image: {
                registerProvider: (provider) => imageModule().registerImageProvider(provider),
                onParams: (handler) => imageModule().onImageParams(handler)
            },
            // API 7：用站点设置里的 AI 发一次请求，返回回复文字。
            ai: {
                complete: (options) => aiComplete(options)
            }
        };
    }

    // 默认用 RPH 设置里的「分析模型」（UI 模板分析那个），没设就用主模型；走 RPH 自己的请求函数，多接口分流照常生效。
    // 系统提示开头带上标记，加载器认得出这是附带请求，不交给 ctx.requests.onChat 改写。
    async function aiComplete({ messages, model, temperature = 0.3, signal } = {}) {
        const client = globalThis.RPHubApiClient;
        const endpoint = globalThis.RPHubApiUtils?.buildApiEndpoint;
        if (!client?.requestChatCompletion || !endpoint) throw new Error('这个版本的 RPH 不支持插件调用 AI');
        if (!Array.isArray(messages) || !messages.length) throw new TypeError('ctx.ai.complete 需要 messages');
        const settings = appGet('settings') || {};
        if (!String(settings.apiUrl || '').trim()) throw new Error('还没在 RPH 设置里填 AI 接口');
        const marked = typeof messages[0]?.content === 'string' && messages[0].role === 'system'
            ? [{ ...messages[0], content: AI_REQUEST_MARKER + messages[0].content }, ...messages.slice(1)]
            : [{ role: 'system', content: AI_REQUEST_MARKER }, ...messages];
        const result = await client.requestChatCompletion({
            url: endpoint(settings.apiUrl, 'chat/completions'),
            apiKey: settings.apiKey,
            model: String(model || settings.uiTemplateModel || settings.model || '').trim(),
            messages: marked, temperature, stream: false, signal
        });
        return String(result?.content || '');
    }

    function imageModule() {
        if (!globalThis.RPHubImageModule?.registerImageProvider) throw new Error('生图模块没有加载，无法使用 ctx.image');
        return globalThis.RPHubImageModule;
    }

