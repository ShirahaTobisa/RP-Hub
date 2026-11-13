    function seedRegex() {
        return {
            name: IMAGE_REGEX_NAME,
            regex: '/image###([\\s\\S]*?)###/g',
            replacement: 'rph-image-marker###$1###',
            placement: [2],
            markdownOnly: true,
            promptOnly: false,
            scope: 'global',
            enabled: true
        };
    }

    function isModuleRegex(item) { return String(item?.name || item?.scriptName || '') === IMAGE_REGEX_NAME; }
    function isModuleWorldInfo(item) { return String(item?.comment || item?.name || '') === IMAGE_WORLD_INFO_NAME; }
    const SEED_DB_KEYS = ['global_regex', 'regex', 'global_worldinfo', 'worldinfo'];

    async function readSeedSnapshot(options = {}) {
        const now = Date.now();
        if (!options.force && state.seedCache && now - state.seedReadAt < SEED_CACHE_TTL_MS) {
            return state.seedCache;
        }
        incrementPerformance('seedSnapshotReads');
        incrementPerformance('seedDbGets');
        const values = {};
        const entries = await Promise.all(SEED_DB_KEYS.map(async (key) => [
            key,
            await dbGet(`rp_hub_${key}`)
        ]));
        for (const [key, value] of entries) values[key] = value;
        state.seedCache = { values, epoch: state.seedCacheEpoch };
        state.seedReadAt = Date.now();
        return state.seedCache;
    }

    function seedValues(snapshot) {
        return snapshot?.values && typeof snapshot.values === 'object' ? snapshot.values : {};
    }

    function updateRenderHookArray(value, installModule) {
        const source = Array.isArray(value) ? value : [];
        const filtered = source.filter((item) => !isModuleRegex(item));
        if (installModule) filtered.unshift(seedRegex());
        return filtered;
    }

    function renderHookNeedsMaintenance(value, installModule) {
        const source = Array.isArray(value) ? value : [];
        return JSON.stringify(updateRenderHookArray(source, installModule)) !== JSON.stringify(source);
    }

    function getLiveAppProxy() {
        const app = document.getElementById('app')?.__vue_app__;
        return app?._instance?.proxy || app?._container?._vnode?.component?.proxy || null;
    }

    function unwrapLiveValue(value) {
        return value && typeof value === 'object' && 'value' in value
            ? value.value
            : value;
    }

    function readLiveAppValue(key) {
        const app = document.getElementById('app')?.__vue_app__;
        const proxy = app?._instance?.proxy || app?._container?._vnode?.component?.proxy || null;
        if (proxy && key in proxy) return proxy[key];
        const setupStates = [
            app?._instance?.setupState,
            app?._container?._vnode?.component?.setupState
        ];
        for (const setupState of setupStates) {
            if (setupState && key in setupState) return unwrapLiveValue(setupState[key]);
        }
        return undefined;
    }

    function readLiveAttributionSnapshot() {
        const chatHistory = readLiveAppValue('chatHistory');
        const currentCharacter = readLiveAppValue('currentCharacter');
        if (!Array.isArray(chatHistory) || !currentCharacter || typeof currentCharacter !== 'object') return null;
        return {
            chatHistory,
            currentCharacter,
            uuid: String(currentCharacter.uuid || '')
        };
    }

    // 判断失败时写进日志：页面当前角色、这条消息的位置和发言方各是什么，一眼看出是哪一项没对上。
    function describeRuntimeAttribution(row) {
        const live = readLiveAttributionSnapshot();
        const index = readMessageIndex(row);
        const message = live && index !== null ? live.chatHistory[index] : null;
        return [
            `页面状态=${live ? '有' : '读不到'}`,
            `角色编号=${live?.uuid || '空'}`,
            `角色名=${live?.currentCharacter?.name || '空'}`,
            `消息数=${live?.chatHistory.length ?? '?'}`,
            `消息位置=${index ?? '空'}`,
            `行发言方=${row?.getAttribute?.('data-role') || '空'}`,
            `记录发言方=${message ? message.role : '无此消息'}`,
            `角色列表=${state.catalogCache?.characters?.length ?? '未读'}`,
            `在列表里=${Boolean(live?.uuid && state.catalogCache?.characters?.some((item) => String(item?.uuid || '') === live.uuid))}`
        ].join(' ');
    }

    function resolveRuntimeAttribution(row, catalog) {
        const live = readLiveAttributionSnapshot();
        if (!live) return null;
        const index = readMessageIndex(row);
        if (index === null) return null;
        const message = live.chatHistory[index];
        const role = String(row?.getAttribute?.('data-role') || '');
        // 消息行就在当前聊天里：位置和角色对得上即归当前角色。不再比对生图标记文字，
        // 正则美化后的显示文字常与原文对不上，会把整段聊天都判成“无法确认”。
        if (!message || String(message.role || '') !== role) return null;
        const catalogCharacter = catalog?.characters?.find((item) => (
            live.uuid && String(item?.uuid || '') === live.uuid
        ));
        if (!catalogCharacter) return null;
        const current = readLiveAttributionSnapshot();
        if (!current || current.chatHistory !== live.chatHistory || current.uuid !== live.uuid) {
            state.rowAttributionCache.delete(row);
            deferAttributionRetry(row, 0);
            return { retry: true };
        }
        return {
            ...createCharacterAttribution(live.currentCharacter, 'runtime-rescue'),
            runtimeChat: live.chatHistory
        };
    }

    function maintainLiveRenderHook() {
        const proxy = getLiveAppProxy();
        const scripts = proxy?.regexScripts;
        if (!Array.isArray(scripts)) return false;
        const next = updateRenderHookArray(scripts, true);
        if (JSON.stringify(next) === JSON.stringify(scripts)) return false;
        scripts.splice(0, scripts.length, ...next);
        return true;
    }

    function refreshAutoEnabledFromLiveData() {
        const proxy = getLiveAppProxy();
        const entries = proxy?.worldInfo;
        if (!Array.isArray(entries)) return false;
        const native = entries.find((entry) => String(entry?.comment || entry?.name || '') === NATIVE_WORLD_INFO_NAME);
        const enabled = native?.enabled === true;
        if (enabled === state.autoEnabled) return true;
        state.autoEnabled = enabled;
        scheduleFullScan(0);
        return true;
    }

    async function maintainRenderHook(providedSnapshot = null) {
        if (globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true) return false;
        const snapshot = providedSnapshot || await readSeedSnapshot({ force: true });
        const values = seedValues(snapshot);
        const writes = [];
        // This display hook is a network gate, not the user's auto-image
        // switch. It consumes image markers before the native NAI rule can
        // create a provider <img>, so it must stay normalized and first.
        const globalRegex = updateRenderHookArray(values.global_regex, true);
        if (JSON.stringify(globalRegex) !== JSON.stringify(Array.isArray(values.global_regex) ? values.global_regex : [])) {
            writes.push(dbPut('rp_hub_global_regex', globalRegex));
        }
        const localRegex = updateRenderHookArray(values.regex, false);
        if (JSON.stringify(localRegex) !== JSON.stringify(Array.isArray(values.regex) ? values.regex : [])) {
            writes.push(dbPut('rp_hub_regex', localRegex));
        }
        await Promise.all(writes);
        return writes.length > 0;
    }

    async function migrateRetiredSeedData(providedSnapshot = null) {
        if (globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true) return false;
        if (safeLocalGet(IMAGE_SEED_RETIREMENT_MIGRATION_KEY) === '1') return false;
        const snapshot = providedSnapshot || await readSeedSnapshot();
        const values = seedValues(snapshot);
        const writes = [];
        for (const key of ['global_worldinfo', 'worldinfo']) {
            const source = Array.isArray(values[key]) ? values[key] : [];
            const next = source.filter((item) => !isModuleWorldInfo(item));
            if (JSON.stringify(next) !== JSON.stringify(source)) {
                writes.push(dbPut(`rp_hub_${key}`, next));
            }
        }
        await Promise.all(writes);
        safeLocalSet(RETIRED_IMAGE_AUTO_STORAGE_KEY, '');
        safeLocalSet(IMAGE_SEED_RETIREMENT_MIGRATION_KEY, '1');
        return writes.length > 0;
    }

    async function inferAutoEnabled(providedSnapshot = null) {
        const snapshot = providedSnapshot || await readSeedSnapshot();
        const values = seedValues(snapshot);
        const globalWorld = values.global_worldinfo;
        const world = values.worldinfo;
        const worldEntries = [...(Array.isArray(globalWorld) ? globalWorld : []), ...(Array.isArray(world) ? world : [])];
        const native = worldEntries.find((entry) => String(entry?.comment || entry?.name || '') === NATIVE_WORLD_INFO_NAME);
        return native?.enabled === true;
    }

    async function syncAutoEnabledFromSeedData(options = {}) {
        if (globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true) return state.autoEnabled;
        let snapshot = await readSeedSnapshot();
        const values = seedValues(snapshot);
        if (renderHookNeedsMaintenance(values.global_regex, true)
            || renderHookNeedsMaintenance(values.regex, false)) {
            await maintainRenderHook(snapshot);
        }
        if (options.startupSettled) await options.startupSettled;
        snapshot = await readSeedSnapshot({ force: true });
        await migrateRetiredSeedData(snapshot);
        snapshot = await readSeedSnapshot({ force: true });
        const settledValues = seedValues(snapshot);
        if (renderHookNeedsMaintenance(settledValues.global_regex, true)
            || renderHookNeedsMaintenance(settledValues.regex, false)) {
            await maintainRenderHook(snapshot);
        }
        snapshot = await readSeedSnapshot({ force: true });
        const enabled = await inferAutoEnabled(snapshot);
        if (enabled !== state.autoEnabled) {
            state.autoEnabled = enabled;
            scheduleFullScan(0);
        }
        return enabled;
    }

    async function flushRecordsWithoutBlockingSync() {
        try {
            const saved = await flushRecords();
            if (!saved) reportRecordFlushFailure();
            return saved;
        } catch (error) {
            reportRecordFlushFailure(error);
            return false;
        }
    }

    function ensurePersistenceFlushWrapped() {
        const current = globalThis.RPH_R2_FLUSH_PERSISTENCE;
        if (typeof current !== 'function') return false;
        if (current === state.persistenceFlushWrapper || current.__rphImageFlushWrapper === true) return true;
        const original = current;
        const wrapped = async function (...args) {
            await flushRecordsWithoutBlockingSync();
            try {
                return await Reflect.apply(original, this, args);
            } finally {
                invalidateAllDataCaches('persistence flush');
                await reconcileImageKeyStorage({ reloadSettings: true })
                    .catch((error) => log('image key reconciliation failed', error));
                scheduleFullScan(0);
                scheduleSeedSync(0);
            }
        };
        Object.defineProperty(wrapped, '__rphImageFlushWrapper', { value: true });
        Object.defineProperty(wrapped, '__rphImageFlushOriginal', { value: original });
        state.persistenceFlushOriginal = original;
        state.persistenceFlushWrapper = wrapped;
        globalThis.RPH_R2_FLUSH_PERSISTENCE = wrapped;
        return true;
    }

    async function loadSettings() {
        const settings = await dbGet('rp_hub_settings');
        state.settings = settings && typeof settings === 'object' ? settings : {};
    }

    window.RPHubNavAdapter.registerEntry({
        id: 'images', label: '图片管理', attributes: { 'data-rph-image-sidebar-entry': '' },
        iconPaths: ['M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z', 'M3 16l5-5 4 4 2-2 7 7M8.5 9h.01'],
        onClick: () => window.open('/image', '_blank', 'noopener'), waitForClose: false
    });

