    function hasPendingImageScanWork() {
        return state.scanning || state.dirtyRows.size > 0
            || state.fullScanPending || state.scanQueuedWhileBusy;
    }

    async function runCatalogFallback(reason = 'catalog fallback') {
        if (document.visibilityState === 'hidden') return;
        invalidateAttributionCaches(reason);
        if (hasPendingImageScanWork()) scheduleFullScan(0);
    }

    async function runSeedFallback(reason = 'seed fallback') {
        if (document.visibilityState === 'hidden') return;
        invalidateSeedCache(reason);
    }

    function finishSeedSync() {
        state.seedSyncPromise = null;
        if (state.seedSyncPending && document.visibilityState !== 'hidden') {
            state.seedSyncPending = false;
            scheduleSeedSync(0);
        }
    }

    function startSeedSync(errorLabel, options = {}) {
        if (state.seedSyncPromise) {
            state.seedSyncPending = true;
            return state.seedSyncPromise;
        }
        state.seedSyncPending = false;
        state.seedSyncPromise = syncAutoEnabledFromSeedData(options)
            .catch((error) => log(errorLabel, error))
            .finally(finishSeedSync);
        return state.seedSyncPromise;
    }

    function scheduleSeedSync(delay = 0) {
        if (document.visibilityState === 'hidden') return;
        state.seedSyncPending = true;
        if (state.seedSyncTimer) return;
        state.seedSyncTimer = setTimeout(() => {
            state.seedSyncTimer = null;
            if (document.visibilityState === 'hidden') {
                state.seedSyncPending = false;
                return;
            }
            if (state.seedSyncPromise) {
                state.seedSyncPending = true;
                return;
            }
            state.seedSyncPending = false;
            startSeedSync('event-driven seed maintenance failed');
        }, Math.max(0, Number(delay) || 0));
    }

    function installEventHandlers() {
        document.addEventListener('load', handleImageLoad, true);
        document.addEventListener('error', handleImageError, true);
        document.addEventListener('click', handleImageClick, true);
        document.addEventListener('click', (event) => {
            if (!event.target?.closest?.('button[title="自动生图开关"]')) return;
            maintainLiveRenderHook();
            setTimeout(refreshAutoEnabledFromLiveData, 0);
            setTimeout(() => {
                invalidateSeedCache('native auto-image toggle');
                scheduleSeedSync(0);
            }, 1200);
        }, true);
        document.addEventListener('change', (event) => {
            if (!event.target?.matches?.('input[type="checkbox"]')) return;
            maintainLiveRenderHook();
            setTimeout(refreshAutoEnabledFromLiveData, 0);
            setTimeout(() => {
                invalidateSeedCache('native auto-image toggle');
                scheduleSeedSync(0);
            }, 1200);
        }, true);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                flushRecordsWithoutBlockingSync();
                return;
            }
            reloadGenerationSettings();
            if (!state.catalogCache || Date.now() - state.catalogReadAt >= CATALOG_CACHE_TTL_MS) runCatalogFallback('visibility resume');
            if (!state.seedCache || Date.now() - state.seedReadAt >= SEED_CACHE_TTL_MS) runSeedFallback('visibility resume');

        });
        window.addEventListener('beforeunload', () => {
            flushRecordsWithoutBlockingSync();
        });
        window.addEventListener('storage', (event) => {
            invalidateAllDataCaches('storage event');
            if (event.key === IMAGE_GEN_KEY_STORAGE_KEY && String(event.newValue || '').trim()) {
                safeLocalSet(IMAGE_GEN_KEY_SHADOW_STORAGE_KEY, String(event.newValue || '').trim());
            }
            state.keyRecoveryNotice = '';
            scheduleFullScan(0);
            scheduleSeedSync(0);
        });
        for (const row of document.querySelectorAll('[data-chat-index]')) state.knownRows.add(row);
        const liveChat = readLiveAppValue('chatHistory');
        if (Array.isArray(liveChat)) state.liveChatBaselines.set(liveChat, liveChat.length);
        state.renderedChat = liveChat;
        state.observer = new MutationObserver((records) => {
            ensurePersistenceFlushWrapped();
            // 回复期间不会有人改正则脚本，跳过逐次比对整份列表。
            if (!isConversationBusy()) maintainLiveRenderHook();
            const currentChat = readLiveAppValue('chatHistory');
            if (Array.isArray(currentChat) && state.renderedChat !== currentChat) {
                state.renderedChat = currentChat;
                // Vue may reuse identical message HTML across characters/branches.
                // Restore markers so that those frames are checked in the new chat.
                for (const frame of document.querySelectorAll('.rp-generated-image-frame')) {
                    const record = getRecordBucket(frame.dataset.characterUuid)
                        .find((item) => item.key === frame.dataset.imageRenderKey);
                    if (record) frame.replaceWith(document.createTextNode(`image###${record.prompt}###`));
                }
                invalidateAttributionCaches('live chat changed');
                scheduleFullScan(0);
            }
            if (Array.isArray(currentChat) && !state.liveChatBaselines.has(currentChat)) {
                state.liveChatBaselines.set(currentChat, currentChat.length);
            }
            const dirtyRows = collectMutationRows(records);
            if (dirtyRows.size) scheduleScan();

        });
        state.observer.observe(document.body, {
            subtree: true,
            childList: true,
            characterData: true
        });
        state.catalogFallback = setInterval(() => {
            if (document.visibilityState === 'hidden') return;
            runCatalogFallback().catch(() => { });
        }, CATALOG_CACHE_TTL_MS);
        state.seedFallback = setInterval(() => {
            if (document.visibilityState === 'hidden') return;
            runSeedFallback().catch(() => { });
        }, SEED_CACHE_TTL_MS);
    }

    async function initialize() {
        const startupSettled = new Promise((resolve) => setTimeout(resolve, APP_STARTUP_SETTLE_MS));
        await loadSettings();
        await reconcileImageKeyStorage({ allowSettingsBackfill: true });
        const hasStoredImageRecords = await hasStoredImageRecordBucket()
            .catch((error) => { log('initial image record key scan failed', error); return false; });
        await startSeedSync('initial seed sync failed', hasStoredImageRecords ? {} : { startupSettled });
        await startupSettled;
        if (state.keyRecoveryNotice) showImageToast(state.keyRecoveryNotice, { kind: 'info' });

        installEventHandlers();
        maintainLiveRenderHook();
        ensurePersistenceFlushWrapped();
        [0, 50, 250, 1000].forEach((delay) => setTimeout(ensurePersistenceFlushWrapped, delay));
        setTimeout(() => {
            invalidateSeedCache('startup settle');
            scheduleSeedSync(0);
        }, 1000);
        scheduleFullScan(0);
    }

    state.ready = new Promise((resolve) => {
        const start = () => initialize().then(resolve).catch((error) => { log('module initialization failed', error); resolve(); });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    });

    globalThis.RPHubImageModule = {
        version: MODULE_VERSION,
        scan: () => state.ready.then(() => {
            if (state.dirtyRows.size) invalidateAttributionCaches('explicit dirty scan');
            return scanDocument({ full: true });
        }),
        getState: () => ({
            autoEnabled: state.autoEnabled,
            characterUuid: state.character?.uuid || '',
            recordCount: state.records.length,
            entryMode: document.querySelector('[data-rph-image-sidebar-entry]')?.closest('.app-sidebar') ? 'sidebar'
                : document.querySelector('[data-rph-image-sidebar-entry]') ? 'navigation' : 'pending',
            attributionSource: state.lastAttributionSource,
            busySignalSupported: state.busySignalSupported,
            busySignalSource: state.busySignalSource,
            persistenceFlushWrapped: Boolean(globalThis.RPH_R2_FLUSH_PERSISTENCE?.__rphImageFlushWrapper)
        }),
        buildImageRenderUrl,
        buildImageRenderSignature,
        deriveImageSeed,
        normalizeImageRenderRecord,
        getFrozenImageRenderRecord: (prompt, occurrenceIndex, context = {}) => getFrozenRecord(prompt, occurrenceIndex, context),
        flushRecords: () => flushRecordsWithoutBlockingSync(),
        registerImageProvider,
        onImageParams,
        listImageProviders: () => [...generation.providers.values()].map(({ id, label, maxSteps, costHint }) => ({ id, label, maxSteps, costHint })),
        getGenerationSettings: () => structuredClone(generation.settings),
        reloadGenerationSettings,
        applyGenerationSettings,
        defaultNegativePrompt: IMAGE_GEN_NEGATIVE_PROMPT,
        estimateImagePoints,
        getPerformanceCounters: () => readPerformanceCounters(),
        resetPerformanceCounters: (options = {}) => resetPerformanceCounters(options),
        setPerformanceRowDetailsEnabled: (enabled) => {
            state.performanceRowDetailsEnabled = Boolean(enabled);
            state.performanceRowDetails.clear();
        }
    };
})();

/* 生图参数：直接并进 RPH 设置页「生图设置」的格子里（接口、采样器、步数、引导值、负面提示词）。
 * 设置值存在站点的 R2（/image/api/settings），不写进 RPH 自己的设置数据，聊天页面保存设置时不会被覆盖。
 * 另外每天最多检查一次存储用量，超出清理上限时弹窗询问。 */
(() => {
    'use strict';
    const PASSWORD_KEY = 'rp_hub_sync_password_v1';
    const CHECK_KEY = 'rph_image_storage_checked_at';
    const DAY_MS = 86_400_000;
    const FIELD_ATTR = 'data-rph-image-param';
    const SAMPLERS = ['k_euler', 'k_euler_ancestral', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_sde'];
    const NOISE_SCHEDULES = ['karras', 'native', 'exponential', 'polyexponential'];
    const BADGE_CLASS = 'text-xs font-mono font-bold text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1 whitespace-nowrap';
    const RANGE_CLASS = 'compact-range w-full h-1.5 bg-primary-100 rounded-lg appearance-none cursor-pointer accent-primary-500';

