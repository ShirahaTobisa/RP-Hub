/* RP-Hub image overlay. This file is deliberately independent from app.js. */
(() => {
    'use strict';

    const MODULE_VERSION = 'r2-img-1';
    const IMAGE_RENDER_ENDPOINT = '/api/rp-image';
    const IMAGE_THUMB_ENDPOINT = '/api/rp-image-thumb';
    const IMAGE_TOKEN_HEADER = 'x-rp-image-token';
    const IMAGE_RENDER_SIGNATURE_KEYS = [
        'provider', 'tag', 'model', 'artist', 'size', 'steps', 'scale', 'cfg',
        'sampler', 'negative', 'nocache', 'noise_schedule'
    ];
    const IMAGE_OPTIONAL_SIGNATURE_KEYS = ['seed'];
    const IMAGE_GEN_DEFAULT_MODEL = 'nai-diffusion-4-5-full';
    const IMAGE_GEN_V5_MODEL = 'nai-diffusion-5-full';
    const V5_UNSUPPORTED_STYLE_KEYS = new Set(['r18', 'lolita25d', 'anime']);
    const IMAGE_GEN_KEY_STORAGE_KEY = 'rp_hub_image_gen_key_v1';
    const IMAGE_GEN_KEY_SHADOW_STORAGE_KEY = 'rphImgKeyShadow';
    const IMAGE_GEN_KEY_ADOPTED_STORAGE_KEY = 'rp_hub_image_gen_key_adopted_v1';
    const RETIRED_IMAGE_AUTO_STORAGE_KEY = 'rp_hub_image_auto_enabled_v1';
    const IMAGE_SEED_RETIREMENT_MIGRATION_KEY = 'rp_hub_image_seed_retired_v1';
    const IMAGE_RECORD_PREFIX = 'rp_hub_image_renders_';
    const IMAGE_RECORD_SAVE_DEBOUNCE_MS = 300;
    const DB_NAME = 'RPHubDB';
    const DB_STORE = 'store';
    const IMAGE_REGEX_NAME = 'RPHub 自动生图正则';
    const IMAGE_WORLD_INFO_NAME = 'RPHub 自动生图';
    const NATIVE_WORLD_INFO_NAME = '自动生图';
    const CATALOG_CACHE_TTL_MS = 10_000;
    const SEED_CACHE_TTL_MS = 30_000;
    const CHAT_CACHE_TTL_MS = 2_000;
    const ATTRIBUTION_RETRY_MS = 2_000;
    const LIVE_WINDOW_MS = 30_000;
    const APP_STARTUP_SETTLE_MS = 1_000;
    const CANON_MARKER_CACHE_LIMIT = 500;
    const PROTECTION_PATTERN = /(<!DOCTYPE html>[\s\S]*?<\/html>|<html\b[^>]*>[\s\S]*?<\/html>|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<(?:cot|think)>[\s\S]*?(?:<\/(?:cot|think)>|<(?:cot|think)>|$)|```[\s\S]*?```|`[^`]+`)/gi;
    const PROTECTED_TEXT_PATTERN = /^(<!DOCTYPE html>[\s\S]*?<\/html>|<html\b[^>]*>[\s\S]*?<\/html>|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<(?:cot|think)>[\s\S]*?(?:<\/(?:cot|think)>|<(?:cot|think)>|$)|```[\s\S]*?```|`[^`]+`)$/i;
    const PROTECTED_TAGS = new Set(['SCRIPT', 'STYLE', 'PRE', 'CODE', 'IFRAME', 'COT', 'THINK']);
    const IMAGE_GEN_NEGATIVE_PROMPT = '{{{{bad anatomy}}}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,ink eyes,ink hair,jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers},{missing legs},{{{more than 2 nipples}}},mutated hands,{{{mutation}}},normal quality,owres,{{poorly drawn face}},{{poorly drawn hands}},reen eyes,signature,text,{{too many fingers}},{{{ugly}}},username,uta,watermark,worst quality,{{{more than 2 legs}}},awkward hand sign,weird hand gesture,contorted hand,unnatural finger pose,deformed hand gesture,{shaka},{hang loose},{{rock on}},{shaka sign}';
    const DEFAULT_ARTISTS = 'masterpiece, best quality,[[[artist:dishwasher1910]]], {{yd_(orange_maru)}}, [artist:ciloranko], [artist:sho_(sho_lwlw)], [ningen mame], soft lighting,year 2024';
    const ARTIST_STYLES = {
        comicDoujin: {
            artists: 'masterpiece, best quality, very aesthetic, modern Japanese anime, official anime art, anime key visual, anime screencap, soft cel shading, soft anime coloring, smooth color transitions, natural skin tones, restrained color palette, slightly desaturated, muted colors, soft ambient lighting, gentle contrast, subtle gradients, subtle bloom, detailed anime background',
            name: '动漫同人风'
        },
        r18: {
            artists: `0.9::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, textless version, The image is highly intricate finished drawn. Only the character's face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::. 1.63::photorealistic::, 1.63::photo(medium)::,
20::best quality, absurdres, very aesthetic, detailed, masterpiece::,, very aesthetic, masterpiece, no text,`,
            name: '2.5D唯美风'
        },
        lolita25d: {
            artists: `20::best quality, absurdres, very aesthetic, detailed, masterpiece::, 20::highly finished::, 10::ultra detailed::, 5::masterpiece::, 5::best quality::,
2.4::kidmo::, 1.2::omone hokoma agm::, 1.1::dino, wanke, liduke::, 0.8::rurudo, mignon, artist:pottsness, artist:toosaka asagi::, 0.7::misaka_12003-gou::, 0.6::artist:chocoan, artist:ciloranko, artist:rhasta, artist:sho_sho_lwlw::, dino_(dinoartforame), agoto, akakura, 0.9::rurudo(Only body shape), mignon(Only body shape) ::
year 2025, textless version, {{petite,loli}}, Petite figure, no text, The image is highly intricate finished drawn. Only the character's face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has graphic texture, realistic skin surface, and lifelike flesh with little obliques::, smooth line, glossy skin, realistic, 4k,
1.63::photorealistic::, 1.63::photo(medium)::, 3::simple background::, 2::depth of field::,
1.5::vivid color, lively color::, desaturated, muted tones, cinematic desaturation, pale aesthetic, silver-toned,
-2::green::, -1.5::vibrant, colorful, saturated::`,
            name: '2.5D唯美风（萝）'
        },
        anime: {
            artists: '1.4::asanagi::,{{{{{artist:asanagi}}}}},1.2::xiaoluo_xl::,1.3::Artist: misaka_12003-gou::,1.2::Artist:shexyo::,0.7::Artist:b.sa_(bbbs)::,1::Artist:qiandaiyiyu::,1.05::artist:natedecock::,1.05::artist:kunaboto::,0.75::artist:kandata_nijou::,1.05::artist:zer0.zer0 ::,1.05::artist:jasony::,0.75::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, {textless version, The image is highly intricate finished drawn,write realistically,true to life}, 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::, 1.63::photorealistic::,3::age slider::,1.63::photo(medium)::, 2::best quality, absurdres, very aesthetic, detailed, masterpiece::,-4::Muscle definition, abs::',
            name: '本子里番风'
        },
        galgame: {
            artists: 'artist:ningen_mame,, noyu_(noyu23386566),, toosaka asagi,, location,\\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,:,, very aesthetic, masterpiece, no text,',
            name: 'GalGame风'
        },
        custom: {
            artists: '',
            name: '自定义'
        }
    };

    const state = {
        db: null,
        character: null,
        chat: [],
        renderedChat: null,
        records: [],
        recoveredRecords: new WeakSet(),
        autoEnabled: false,
        ready: null,
        scanning: false,
        scanTimer: null,
        saveTimers: new Map(),
        recordBuckets: new Map(),
        chatBuckets: new Map(),
        chatReadAtByUuid: new Map(),
        dirtyRecordOwners: new Set(),
        recordRevisions: new Map(),
        writeQueue: Promise.resolve(),
        lastChatReadAt: 0,
        uploadedThumbs: new Set(),
        pendingRequests: new Map(),
        observer: null,
        catalogFallback: null,
        seedFallback: null,
        seedSyncTimer: null,
        seedSyncPromise: null,
        seedSyncPending: false,
        keySettingsBackfillAttempted: false,
        keyRecoveryNotice: '',
        toastHost: null,
        busySignalSupported: false,
        busySignalSource: 'unavailable',
        busySignalWarningShown: false,
        startedAt: Date.now(),
        lastBusyAt: 0,
        lastAttributionSource: '',
        persistenceFlushOriginal: null,
        persistenceFlushWrapper: null,
        cacheEpoch: 0,
        seedCacheEpoch: 0,
        catalogCache: null,
        catalogReadAt: 0,
        catalogVerdictEpoch: -1,
        chatReadEpochByUuid: new Map(),
        chatVerdictEpochByUuid: new Map(),
        seedCache: null,
        seedReadAt: 0,
        dirtyRows: new Set(),
        rowRevisions: new WeakMap(),
        rowWorkCache: new WeakMap(),
        rowAttributionCache: new WeakMap(),
        knownRows: new WeakSet(),
        liveMutationRows: new WeakSet(),
        liveChatBaselines: new WeakMap(),
        scanQueuedWhileBusy: false,
        fullScanPending: false,
        performanceRowDetailsEnabled: false,
        performanceRowIds: new WeakMap(),
        performanceNextRowId: 1,
        performanceRowDetails: new Map(),
        performance: {
            dbGets: 0,
            directoryDbGets: 0,
            directoryKeyDbGets: 0,
            seedDbGets: 0,
            seedKeyDbGets: 0,
            chatDbGets: 0,
            catalogReads: 0,
            seedSnapshotReads: 0,
            scanRuns: 0,
            fullDocumentScans: 0,
            dirtyRowScans: 0,
            rowWorkChecks: 0,
            rowTextSerializations: 0,
            attributionRecomputations: 0,
            attributionAttempts: 0,
            attributionFailureToasts: 0,
            cacheInvalidations: 0,
            seedCacheInvalidations: 0
        }
    };

    const log = (...args) => {
        try { console.warn('[RP-Hub image overlay]', ...args); } catch (_) { /* no-op */ }
    };

    function incrementPerformance(name, amount = 1) {
        if (Object.prototype.hasOwnProperty.call(state.performance, name)) {
            state.performance[name] += amount;
        }
    }

    function getPerformanceRowId(row) {
        let id = state.performanceRowIds.get(row);
        if (!id) {
            const hint = String(row?.getAttribute?.('data-chat-index') || '').trim();
            id = hint ? `chat-${hint}-${state.performanceNextRowId}` : `row-${state.performanceNextRowId}`;
            state.performanceNextRowId += 1;
            state.performanceRowIds.set(row, id);
        }
        return id;
    }

    function incrementRowPerformance(row, name, amount = 1) {
        incrementPerformance(name, amount);
        if (!state.performanceRowDetailsEnabled || !row) return;
        const id = getPerformanceRowId(row);
        const details = state.performanceRowDetails.get(id) || {
            chatIndex: String(row?.getAttribute?.('data-chat-index') || ''),
            rowWorkChecks: 0,
            rowTextSerializations: 0,
            attributionRecomputations: 0,
            dirtyRowScans: 0
        };
        if (Object.prototype.hasOwnProperty.call(details, name)) details[name] += amount;
        state.performanceRowDetails.set(id, details);
    }

    function resetPerformanceCounters(options = {}) {
        for (const key of Object.keys(state.performance)) state.performance[key] = 0;
        state.performanceRowDetails.clear();
        state.performanceRowDetailsEnabled = Boolean(options.rowDetails);
    }

    function readPerformanceCounters() {
        return {
            ...state.performance,
            rowDetailsEnabled: state.performanceRowDetailsEnabled,
            rowDetails: state.performanceRowDetailsEnabled
                ? Object.fromEntries(state.performanceRowDetails)
                : {}
        };
    }

    function showImageToast(message, options = {}) {
        if (!document?.body) return;
        let host = state.toastHost;
        if (!host?.isConnected) {
            host = document.createElement('div');
            host.id = 'rph-image-toast-host';
            host.setAttribute('aria-live', 'assertive');
            host.setAttribute('aria-atomic', 'false');
            host.style.cssText = 'position:fixed;left:50%;top:16px;z-index:2147483646;display:flex;flex-direction:column;align-items:center;gap:8px;width:min(420px,calc(100vw - 24px));pointer-events:none;font:13px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';
            document.body.appendChild(host);
            state.toastHost = host;
        }
        const text = String(message || '').trim();
        const duplicate = [...host.children].find((item) => item.textContent === text);
        if (duplicate) duplicate.remove();
        const toast = document.createElement('div');
        const kind = options.kind === 'info' ? 'info' : 'error';
        toast.dataset.rphImageToast = kind;
        toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        toast.textContent = text;
        toast.style.cssText = kind === 'info'
            ? 'max-width:100%;padding:9px 12px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#334155;box-shadow:0 8px 22px rgba(15,23,42,.16);overflow-wrap:anywhere;'
            : 'max-width:100%;padding:9px 12px;border:1px solid #fecaca;border-radius:7px;background:#fff;color:#991b1b;box-shadow:0 8px 22px rgba(15,23,42,.16);overflow-wrap:anywhere;';
        host.appendChild(toast);
        setTimeout(() => {
            toast.remove();
            if (host.childElementCount === 0) {
                host.remove();
                if (state.toastHost === host) state.toastHost = null;
            }
        }, 4200);
    }

    function reportAttributionFailure(detail = '') {
        log('image attribution failed; generation refused', detail);
        incrementPerformance('attributionFailureToasts');
        showImageToast('无法确认图片所属角色，已拒绝生图');
    }

    function reportRecordFlushFailure(error = null) {
        log('image record flush failed; sync will continue', error);
        showImageToast('图片记录保存失败，可能影响同步');
    }

    function reportImageGenerationFailure(error = null) {
        log('image generation failed', error);
        showImageToast('图片生成失败，请检查密钥或服务状态');
    }

    function hashText(value) {
        const text = String(value ?? '');
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function hashToImageSeed(value) {
        return String(Number.parseInt(hashText(value), 16) >>> 0);
    }

    function deriveImageSeed(prompt, occurrenceIndex, characterUuid) {
        return hashToImageSeed(`${String(prompt || '')}${Math.max(0, Number(occurrenceIndex) || 0)}${String(characterUuid || '')}`);
    }

    function createRerollSeed(previousSeed = '') {
        const previous = String(previousSeed || '');
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const entropy = globalThis.crypto?.randomUUID?.()
                || `${Date.now()}-${String(globalThis.performance?.now?.() || '')}-${attempt}`;
            const seed = hashToImageSeed(entropy);
            if (seed !== previous) return seed;
        }
        return String(((Number(previous) || 0) + 1) >>> 0);
    }

    function safeLocalGet(key) {
        try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
    }

    function safeLocalSet(key, value) {
        try {
            if (value === '' || value === null || value === undefined) localStorage.removeItem(key);
            else localStorage.setItem(key, String(value));
        } catch (error) { log('localStorage write failed', error); }
    }

    function normalizeGenerationParams(value) {
        const normalized = {};
        if (!value || typeof value !== 'object') return normalized;
        for (const [rawKey, rawValue] of Object.entries(value)) {
            const key = String(rawKey || '').trim();
            if (!key || key.toLowerCase() === 'token') continue;
            if (Array.isArray(rawValue)) normalized[key] = rawValue.map((item) => String(item ?? ''));
            else normalized[key] = String(rawValue ?? '');
        }
        return normalized;
    }

    function readGenerationParams(url) {
        const params = {};
        for (const [rawKey, rawValue] of url.searchParams.entries()) {
            const key = String(rawKey || '').trim();
            if (!key || key.toLowerCase() === 'token') continue;
            const value = String(rawValue ?? '');
            if (!Object.prototype.hasOwnProperty.call(params, key)) params[key] = value;
            else if (Array.isArray(params[key])) params[key].push(value);
            else params[key] = [params[key], value];
        }
        return params;
    }

    function appendGenerationParam(params, key, value) {
        if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item ?? '')));
        else params.set(key, String(value ?? ''));
    }

    function canonicalGenerationParams(value) {
        const source = normalizeGenerationParams(value);
        const canonical = {};
        Object.keys(source).sort().forEach((key) => { canonical[key] = source[key]; });
        return canonical;
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            if (!globalThis.indexedDB) return reject(new Error('IndexedDB unavailable'));
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('RPHubDB open failed'));
        });
    }

    async function getDb() {
        if (state.db && state.db.objectStoreNames.contains(DB_STORE)) return state.db;
        state.db = await openDatabase();
        return state.db;
    }

    function dbGetFrom(db, key) {
        return new Promise((resolve, reject) => {
            if (!db) return resolve(undefined);
            let request;
            try { request = db.transaction([DB_STORE], 'readonly').objectStore(DB_STORE).get(key); }
            catch (error) { reject(error); return; }
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
        });
    }

    async function dbGet(key) {
        const dbKey = String(key || '');
        incrementPerformance('dbGets');
        if (dbKey === 'rp_hub_characters' || dbKey === 'rp_hub_last_active_char'
            || dbKey === 'rp_hub_character_index' || /^rp_hub_character_[^_]/.test(dbKey)) {
            incrementPerformance('directoryKeyDbGets');
        } else if (/^rp_hub_(?:global_)?(?:regex|worldinfo)$/.test(dbKey)) {
            incrementPerformance('seedKeyDbGets');
        } else if (dbKey.startsWith('rp_hub_chat_')) {
            incrementPerformance('chatDbGets');
        }
        try { return await dbGetFrom(await getDb(), key); }
        catch (error) {
            try { state.db?.close(); } catch (_) { /* no-op */ }
            state.db = null;
            return dbGetFrom(await getDb(), key);
        }
    }

    async function hasStoredImageRecordBucket() {
        const db = await getDb();
        return new Promise((resolve, reject) => {
            let request;
            try {
                const store = db.transaction([DB_STORE], 'readonly').objectStore(DB_STORE);
                const range = IDBKeyRange.bound(IMAGE_RECORD_PREFIX, `${IMAGE_RECORD_PREFIX}\uffff`);
                request = store.openKeyCursor(range);
            } catch (error) {
                reject(error);
                return;
            }
            request.onsuccess = () => resolve(Boolean(request.result));
            request.onerror = () => reject(request.error || new Error('IndexedDB image record key scan failed'));
        });
    }

    function dbPut(key, value) {
        return new Promise(async (resolve, reject) => {
            let db;
            try { db = await getDb(); } catch (error) { reject(error); return; }
            let request;
            try { request = db.transaction([DB_STORE], 'readwrite').objectStore(DB_STORE).put(value, key); }
            catch (error) { reject(error); return; }
            request.onsuccess = () => {
                invalidateCachesForDbKey(key);
                resolve();
            };
            request.onerror = () => reject(request.error || new Error('IndexedDB write failed'));
        });
    }

    function dbPutImmediately(db, key, value) {
        return new Promise((resolve, reject) => {
            let transaction;
            try {
                transaction = db.transaction([DB_STORE], 'readwrite');
                transaction.objectStore(DB_STORE).put(value, key);
            } catch (error) {
                reject(error);
                return;
            }
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error || new Error('IndexedDB write failed'));
            transaction.onabort = () => reject(transaction.error || new Error('IndexedDB write aborted'));
        });
    }

    function cloneValue(value) {
        try { return structuredClone(value); } catch (_) { return JSON.parse(JSON.stringify(value)); }
    }

    function normalizeImageRenderRecord(record = {}, ownerUuid = '') {
        const paramsSnapshot = record.paramsSnapshot && typeof record.paramsSnapshot === 'object'
            ? { ...record.paramsSnapshot }
            : {};
        delete paramsSnapshot.token;
        if (paramsSnapshot.upstreamParams) {
            paramsSnapshot.upstreamParams = normalizeGenerationParams(paramsSnapshot.upstreamParams);
        }
        if (!paramsSnapshot.rerollNonce && paramsSnapshot.reroll_nonce) paramsSnapshot.rerollNonce = paramsSnapshot.reroll_nonce;
        delete paramsSnapshot.reroll_nonce;
        // The snapshot is authoritative after first generation. ownerUuid only
        // backfills records written before attribution snapshots existed.
        paramsSnapshot.characterUuid = String(paramsSnapshot.characterUuid || ownerUuid || '');
        paramsSnapshot.characterName = String(paramsSnapshot.characterName || '未命名角色');
        const prompt = String(record.prompt || paramsSnapshot.prompt || paramsSnapshot.tag || '');
        const createdAt = Number(record.createdAt) || Date.now();
        const normalized = {
            key: String(record.key || ''),
            messageId: String(record.messageId || ''),
            messageIndex: Number.isFinite(Number(record.messageIndex)) ? Number(record.messageIndex) : null,
            contentHash: String(record.contentHash || ''),
            occurrenceIndex: Math.max(0, Number(record.occurrenceIndex) || 0),
            prompt,
            promptHash: String(record.promptHash || hashText(prompt)),
            ...(record.branchId ? { branchId: String(record.branchId) } : {}),
            ...(record.promptLayout ? { promptLayout: String(record.promptLayout) } : {}),
            ...(record.readOnly === true ? { readOnly: true } : {}),
            paramsSnapshot,
            imageSignature: String(record.imageSignature || ''),
            status: record.status === 'skipped' || record.skipped === true ? 'skipped' : 'rendered',
            createdAt,
            updatedAt: Number(record.updatedAt) || createdAt,
            rerollCount: Math.max(0, Number(record.rerollCount) || 0)
        };
        normalized.key = normalized.key || buildImageRenderRecordKey(normalized);
        return normalized;
    }

    function buildImageRenderRecordKey(descriptor = {}) {
        const key = [
            descriptor.messageId || 'message',
            descriptor.contentHash || 'content',
            descriptor.occurrenceIndex ?? 0,
            descriptor.promptHash || hashText(descriptor.prompt || '')
        ].join(':');
        return descriptor.branchId && descriptor.branchId !== 'main' ? `${key}:branch:${descriptor.branchId}` : key;
    }

    function buildUpstreamImageRenderSignature(paramsSnapshot = {}) {
        const generationParams = normalizeGenerationParams(paramsSnapshot.upstreamParams);
        if (!Object.prototype.hasOwnProperty.call(generationParams, 'provider')) {
            generationParams.provider = String(paramsSnapshot.provider || '');
        }
        return hashText(JSON.stringify(canonicalGenerationParams(generationParams)));
    }

    function buildImageRenderSignature(paramsSnapshot = {}) {
        if (paramsSnapshot.source === 'upstream' && paramsSnapshot.upstreamParams) {
            return buildUpstreamImageRenderSignature(paramsSnapshot);
        }
        const signature = {};
        IMAGE_RENDER_SIGNATURE_KEYS.forEach((key) => { signature[key] = String(paramsSnapshot[key] || ''); });
        IMAGE_OPTIONAL_SIGNATURE_KEYS.forEach((key) => {
            if (paramsSnapshot[key] !== undefined && paramsSnapshot[key] !== '') signature[key] = String(paramsSnapshot[key]);
        });
        if (paramsSnapshot.rerollNonce) signature.rerollNonce = String(paramsSnapshot.rerollNonce);
        return hashText(JSON.stringify(signature));
    }

    function getUpstreamSourceSignature(record = {}) {
        const snapshot = record.paramsSnapshot || {};
        if (snapshot.upstreamSourceSignature) return String(snapshot.upstreamSourceSignature);
        if (snapshot.source !== 'upstream' || !snapshot.upstreamParams) return '';
        const currentSignature = buildUpstreamImageRenderSignature(snapshot);
        const originalPrompt = String(record.prompt || '').trim();
        const currentTag = Array.isArray(snapshot.upstreamParams.tag)
            ? String(snapshot.upstreamParams.tag[0] || '').trim()
            : String(snapshot.upstreamParams.tag || '').trim();
        if (!originalPrompt || originalPrompt === currentTag) return currentSignature;
        const originalParams = normalizeGenerationParams(snapshot.upstreamParams);
        originalParams.tag = originalPrompt;
        return buildUpstreamImageRenderSignature({ ...snapshot, upstreamParams: originalParams });
    }

    function buildImageRenderUrl(paramsSnapshot = {}) {
        const params = new URLSearchParams();
        if (paramsSnapshot.source === 'upstream' && paramsSnapshot.upstreamParams) {
            const generationParams = normalizeGenerationParams(paramsSnapshot.upstreamParams);
            Object.entries(generationParams).forEach(([key, value]) => appendGenerationParam(params, key, value));
            if (!params.has('provider')) params.set('provider', String(paramsSnapshot.provider || ''));
        } else {
            IMAGE_RENDER_SIGNATURE_KEYS.forEach((key) => params.set(key, String(paramsSnapshot[key] || '')));
            IMAGE_OPTIONAL_SIGNATURE_KEYS.forEach((key) => {
                if (paramsSnapshot[key] !== undefined && paramsSnapshot[key] !== '') params.set(key, String(paramsSnapshot[key]));
            });
            if (paramsSnapshot.rerollNonce) params.set('reroll_nonce', String(paramsSnapshot.rerollNonce));
        }
        params.delete('token');
        params.set('character_id', String(paramsSnapshot.characterUuid || ''));
        params.set('character_name', String(paramsSnapshot.characterName || '未命名角色'));
        return `${IMAGE_RENDER_ENDPOINT}?${params.toString()}`;
    }

    function getImageToken() { return String(safeLocalGet(IMAGE_GEN_KEY_STORAGE_KEY) || '').trim(); }

    async function reconcileImageKeyStorage(options = {}) {
        if (options.reloadSettings) await loadSettings();
        let main = getImageToken();
        const shadow = String(safeLocalGet(IMAGE_GEN_KEY_SHADOW_STORAGE_KEY) || '').trim();
        const hasSettingsKey = Object.prototype.hasOwnProperty.call(state.settings || {}, 'imageGenKey');
        const settingsKey = String(state.settings?.imageGenKey || '').trim();
        const adoptedKey = String(safeLocalGet(IMAGE_GEN_KEY_ADOPTED_STORAGE_KEY) || '').trim();
        let source = '';
        if (settingsKey && settingsKey !== adoptedKey) {
            safeLocalSet(IMAGE_GEN_KEY_STORAGE_KEY, settingsKey);
            safeLocalSet(IMAGE_GEN_KEY_SHADOW_STORAGE_KEY, settingsKey);
            safeLocalSet(IMAGE_GEN_KEY_ADOPTED_STORAGE_KEY, settingsKey);
            main = getImageToken();
            if (main) {
                state.keyRecoveryNotice = '已采纳原生设置中的图片密钥；下次推送会带上该密钥。';
                source = 'settings';
            }
        } else if (main) {
            if (shadow !== main) safeLocalSet(IMAGE_GEN_KEY_SHADOW_STORAGE_KEY, main);
            source = 'main';
        } else if (shadow) {
            safeLocalSet(IMAGE_GEN_KEY_STORAGE_KEY, shadow);
            if (getImageToken()) {
                state.keyRecoveryNotice = '已从本机保护副本恢复密钥；下次推送会带上该密钥。';
                source = 'shadow';
            }
        }

        main = getImageToken();
        if (options.allowSettingsBackfill && (!hasSettingsKey || !settingsKey)
            && main && !state.keySettingsBackfillAttempted) {
            state.keySettingsBackfillAttempted = true;
            const restoredSettings = { ...(state.settings || {}), imageGenKey: main };
            await dbPut('rp_hub_settings', restoredSettings);
            state.settings = restoredSettings;
            safeLocalSet(IMAGE_GEN_KEY_ADOPTED_STORAGE_KEY, main);
            source = source || 'settings-backfill';
        }
        return source;
    }

    function getTokenProviderName(token) {
        const normalized = String(token || '').trim().toUpperCase();
        if (normalized.startsWith('STA1N')) return 'sta1n';
        if (normalized.startsWith('STD')) return 'std';
        return '';
    }

    function getProviderName() {
        const token = getImageToken();
        return token ? (getTokenProviderName(token) || 'std') : '';
    }

    function getImageArtistConfig(model = '') {
        const settings = state.settings || {};
        let styleKey = settings.imageStyle || 'vertical';
        // Mirrors upstream 1.8.6: v5 rejects these styles and migrates to
        // vertical; keep the set in sync with app.js v5UnsupportedImageStyles.
        if (String(model) === IMAGE_GEN_V5_MODEL && V5_UNSUPPORTED_STYLE_KEYS.has(styleKey)) styleKey = 'vertical';
        const style = ARTIST_STYLES[styleKey];
        return {
            styleKey,
            styleName: style?.name || '韩漫小清新风',
            targetArtists: style?.artists || (styleKey === 'custom' ? String(settings.customImageArtists || '') : DEFAULT_ARTISTS)
        };
    }

    function getModuleImageModel() {
        const settings = state.settings || {};
        // Pre-1.8.6 slots have no imageModel setting; fall back to the model
        // this module has always used.
        const model = String(settings.imageModel || '').trim();
        return model || IMAGE_GEN_DEFAULT_MODEL;
    }

    function buildImageParamsSnapshot(prompt, options = {}) {
        const characterUuid = String(options.characterUuid || '');
        if (!characterUuid) return null;
        const model = getModuleImageModel();
        const { targetArtists, styleKey, styleName } = getImageArtistConfig(model);
        const safePrompt = String(prompt || '').trim();
        const rerollNonce = options.reroll
            ? (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${hashText(String(performance.now?.() || ''))}`)
            : '';
        const seed = options.reroll
            ? createRerollSeed(options.previousSeed)
            : deriveImageSeed(safePrompt, options.occurrenceIndex, characterUuid);
        const settings = state.settings || {};
        return {
            prompt: safePrompt,
            tag: safePrompt.slice(0, 2000),
            source: 'module',
            provider: getProviderName(),
            model,
            artist: String(targetArtists || '').slice(0, 2500),
            styleKey,
            styleName,
            size: settings.imageSize || '竖图',
            steps: '40',
            scale: '6',
            cfg: '0',
            sampler: 'k_dpmpp_2m_sde',
            negative: IMAGE_GEN_NEGATIVE_PROMPT,
            nocache: options.reroll ? '1' : '0',
            rerollNonce,
            noise_schedule: 'karras',
            seed,
            characterUuid,
            characterName: String(options.characterName || '未命名角色')
        };
    }

    function buildDescriptor(prompt, occurrenceIndex, context) {
        const safePrompt = String(prompt || '').trim();
        const rawContent = String(context.rawContent || safePrompt);
        const prompts = rawContent.split(PROTECTION_PATTERN)
            .filter((part) => !PROTECTED_TEXT_PATTERN.test(part))
            .flatMap((part) => [...part.matchAll(/(?:image|rph-image-marker)###([\s\S]*?)###/gi)]
                .map((match) => match[1].trim()));
        const descriptor = {
            messageId: String(context.messageId || ''),
            messageIndex: Number.isFinite(Number(context.messageIndex)) ? Number(context.messageIndex) : null,
            contentHash: hashText(rawContent || safePrompt),
            occurrenceIndex: Math.max(0, Number(occurrenceIndex) || 0),
            prompt: safePrompt,
            promptHash: hashText(safePrompt),
            branchId: String(context.branchId || ''),
            legacyScope: context.legacyScope === true,
            promptLayout: prompts[occurrenceIndex] === safePrompt ? JSON.stringify(prompts) : ''
        };
        descriptor.key = buildImageRenderRecordKey(descriptor);
        return descriptor;
    }

    function findRecord(descriptor) {
        const records = state.records.filter((record) => record.branchId
            ? record.branchId === descriptor.branchId
            : !descriptor.branchId || descriptor.legacyScope);
        const legacyKey = buildImageRenderRecordKey({ ...descriptor, branchId: '' });
        const exact = records.find((record) => record.key === descriptor.key && record.prompt === descriptor.prompt)
            || records.find((record) => record.key === legacyKey && record.prompt === descriptor.prompt)
            || state.records.find((record) => !record.branchId && record.key === legacyKey && record.prompt === descriptor.prompt)
            || state.records.find((record) => !record.messageId && !descriptor.messageId
                && !record.branchId && !descriptor.branchId
                && record.contentHash === descriptor.contentHash
                && record.occurrenceIndex === descriptor.occurrenceIndex
                && record.prompt === descriptor.prompt);
        if (exact && (exact.status !== 'skipped' || !exact.imageSignature)) return exact;
        if (!descriptor.messageId || !descriptor.branchId || !descriptor.promptLayout) return exact;

        const family = records.filter((record) => record.messageId === descriptor.messageId);
        const candidates = family.filter((record) => {
            if (record.occurrenceIndex !== descriptor.occurrenceIndex || record.prompt !== descriptor.prompt) return false;
            if (record.promptLayout) return record.promptLayout === descriptor.promptLayout;
            // Old records have no layout. Reconstruct only a complete, unambiguous
            // sequence of recorded slots; insertions/deletions must not shift images.
            const slots = [];
            for (const sibling of family.filter((item) => item.contentHash === record.contentHash)) {
                const index = sibling.occurrenceIndex;
                if (slots[index] !== undefined && slots[index] !== sibling.prompt) return false;
                slots[index] = sibling.prompt;
            }
            return JSON.stringify(slots) === descriptor.promptLayout;
        });
        const skipped = candidates.find((record) => record.status === 'skipped' && !record.imageSignature);
        if (skipped) return skipped;
        const rendered = candidates.filter((record) => record.status !== 'skipped');
        return rendered.length && new Set(rendered.map((record) => buildImageRenderUrl(record.paramsSnapshot))).size === 1
            ? rendered[0] : exact;
    }

    function getRecordBucket(uuid) {
        const ownerUuid = String(uuid || '');
        if (!ownerUuid) return [];
        if (state.recordBuckets.has(ownerUuid)) return state.recordBuckets.get(ownerUuid);
        if (String(state.character?.uuid || '') === ownerUuid) return state.records;
        return [];
    }

    function setRecordBucket(uuid, records) {
        const ownerUuid = String(uuid || '');
        if (!ownerUuid) return [];
        const bucket = Array.isArray(records) ? records : [];
        state.recordBuckets.set(ownerUuid, bucket);
        if (String(state.character?.uuid || '') === ownerUuid) state.records = bucket;
        return bucket;
    }

    function markRecordBucketDirty(uuid) {
        const ownerUuid = String(uuid || '');
        if (!ownerUuid) return 0;
        const revision = (Number(state.recordRevisions.get(ownerUuid)) || 0) + 1;
        state.recordRevisions.set(ownerUuid, revision);
        state.dirtyRecordOwners.add(ownerUuid);
        return revision;
    }

    function scheduleSave(options = {}) {
        const normalized = typeof options === 'number' ? { delay: options } : options;
        const uuid = String(normalized.uuid || state.character?.uuid || '');
        if (!uuid || globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true) return;
        markRecordBucketDirty(uuid);
        const existing = state.saveTimers.get(uuid);
        if (existing) clearTimeout(existing);
        const delay = Math.min(1000, Math.max(0, Number(normalized.delay ?? IMAGE_RECORD_SAVE_DEBOUNCE_MS) || 0));
        const timer = setTimeout(() => {
            state.saveTimers.delete(uuid);
            saveRecords({ uuid, silent: true }).catch((error) => log('record save failed', error));
        }, delay);
        state.saveTimers.set(uuid, timer);
    }

    async function flushRecordOwner(uuid, options = {}) {
        const ownerUuid = String(uuid || '');
        if (!ownerUuid || globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true) return false;
        const timer = state.saveTimers.get(ownerUuid);
        if (timer) clearTimeout(timer);
        state.saveTimers.delete(ownerUuid);
        const records = Array.isArray(options.records) ? options.records : getRecordBucket(ownerUuid);
        const revision = Number(state.recordRevisions.get(ownerUuid)) || 0;
        const payload = records.map((record) => normalizeImageRenderRecord(record, ownerUuid));
        const db = state.db;
        let saved = false;
        if (db && db.objectStoreNames.contains(DB_STORE)) {
            try {
                // Create the transaction in the caller's lifecycle/sync stack.
                const write = dbPutImmediately(db, `${IMAGE_RECORD_PREFIX}${ownerUuid}`, cloneValue(payload));
                state.writeQueue = Promise.allSettled([state.writeQueue, write]).then(() => undefined);
                await write;
                saved = true;
            } catch (error) {
                log('immediate record flush failed', error);
            }
        }
        if (!saved) saved = await saveRecords({ uuid: ownerUuid, records, silent: true });
        if (saved && (Number(state.recordRevisions.get(ownerUuid)) || 0) === revision) {
            state.dirtyRecordOwners.delete(ownerUuid);
        }
        return saved;
    }

    async function flushRecords(options = {}) {
        if (globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true) return false;
        const requestedUuid = String(options.uuid || '');
        const owners = requestedUuid
            ? [requestedUuid]
            : [...state.dirtyRecordOwners];
        if (!owners.length && options.forceCurrent && state.character?.uuid) owners.push(String(state.character.uuid));
        if (!owners.length) return true;
        const results = await Promise.all(owners.map((uuid) => flushRecordOwner(uuid, {
            ...options,
            records: requestedUuid === uuid ? options.records : undefined
        })));
        return results.every(Boolean);
    }

    async function saveRecords(options = {}) {
        const uuid = String(options.uuid || state.character?.uuid || '');
        if (!uuid || globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true) return false;
        const records = Array.isArray(options.records) ? options.records : getRecordBucket(uuid);
        const revision = Number(state.recordRevisions.get(uuid)) || 0;
        const payload = records.map((record) => normalizeImageRenderRecord(record, uuid));
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const write = state.writeQueue.then(() => {
                // A lifecycle/sync flush may already have committed a newer
                // revision while this queued save was waiting.
                if ((Number(state.recordRevisions.get(uuid)) || 0) !== revision) return;
                return dbPut(`${IMAGE_RECORD_PREFIX}${uuid}`, cloneValue(payload));
            });
            state.writeQueue = write.catch(() => { });
            try {
                await write;
                if ((Number(state.recordRevisions.get(uuid)) || 0) === revision) state.dirtyRecordOwners.delete(uuid);
                return true;
            } catch (error) {
                lastError = error;
                if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (2 ** attempt)));
            }
        }
        log('record save failed after retries', lastError);
        if (!options.silent) reportRecordFlushFailure(lastError);
        return false;
    }

    async function loadRecords(uuid, ownerName = '') {
        if (!uuid) return [];
        const value = await dbGet(`${IMAGE_RECORD_PREFIX}${uuid}`);
        return Array.isArray(value)
            ? value.map((record) => {
                const normalized = normalizeImageRenderRecord(record, uuid);
                if (normalized.paramsSnapshot.characterName === '未命名角色' && ownerName) {
                    normalized.paramsSnapshot.characterName = String(ownerName);
                }
                return normalized;
            }).filter((record) => record.prompt)
            : [];
    }

    function normalizeAttributionName(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function invalidateAttributionCaches(reason = '') {
        state.cacheEpoch += 1;
        state.catalogCache = null;
        state.catalogReadAt = 0;
        state.catalogVerdictEpoch = -1;
        state.chatBuckets.clear();
        state.chatReadAtByUuid.clear();
        state.chatReadEpochByUuid.clear();
        state.chatVerdictEpochByUuid.clear();
        state.lastChatReadAt = 0;
        state.chat = [];
        incrementPerformance('cacheInvalidations');
    }

    function invalidateSeedCache(reason = '') {
        state.seedCacheEpoch += 1;
        state.seedCache = null;
        state.seedReadAt = 0;
        incrementPerformance('seedCacheInvalidations');
    }

    function invalidateAllDataCaches(reason = '') {
        invalidateAttributionCaches(reason);
        invalidateSeedCache(reason);
    }

    function invalidateCachesForDbKey(key) {
        const dbKey = String(key || '');
        if (dbKey === 'rp_hub_characters' || dbKey === 'rp_hub_last_active_char'
            || dbKey === 'rp_hub_character_index' || dbKey.startsWith('rp_hub_character_')
            || dbKey.startsWith('rp_hub_chat_')) {
            invalidateAttributionCaches(`module write: ${dbKey}`);
        }
        if (/^rp_hub_(?:global_)?(?:regex|worldinfo)$/.test(dbKey)) {
            invalidateSeedCache(`module write: ${dbKey}`);
        }
    }

    async function loadCharacterCatalogFromDb() {
        incrementPerformance('directoryDbGets');
        incrementPerformance('catalogReads');
        const [legacy, last] = await Promise.all([
            dbGet('rp_hub_characters'),
            dbGet('rp_hub_last_active_char')
        ]);
        if (Array.isArray(legacy)) {
            const characters = legacy.filter((item) => item && String(item.uuid || ''));
            const selectedIndex = typeof last === 'string' && last
                ? characters.findIndex((item) => String(item.uuid || '') === last)
                : Number(last);
            return {
                characters,
                selected: Number.isInteger(selectedIndex) && selectedIndex >= 0 ? characters[selectedIndex] || null : null,
                last
            };
        }

        // v4 cards are split by UUID. Read the live index and cards for each
        // attribution attempt; character ownership is never a startup cache.
        const indexValue = await dbGet('rp_hub_character_index');
        const order = Array.isArray(indexValue?.order)
            ? indexValue.order.map((value) => String(value || '')).filter(Boolean)
            : [];
        const characters = (await Promise.all(order.map((uuid) => dbGet(`rp_hub_character_${uuid}`))))
            .filter((item) => item && String(item.uuid || ''));
        const selectedUuid = typeof last === 'string' && order.includes(last)
            ? last
            : order[Number.isInteger(Number(last)) ? Number(last) : -1];
        return {
            characters,
            selected: characters.find((item) => String(item.uuid || '') === selectedUuid) || null,
            last
        };
    }

    async function readCharacterCatalog(options = {}) {
        const now = Date.now();
        const forVerdict = options.forVerdict === true;
        if (forVerdict && state.catalogVerdictEpoch === state.cacheEpoch && state.catalogCache) {
            return state.catalogCache;
        }
        if (!options.force && !forVerdict && state.catalogCache
            && now - state.catalogReadAt < CATALOG_CACHE_TTL_MS) {
            return state.catalogCache;
        }
        const catalog = await loadCharacterCatalogFromDb();
        state.catalogCache = catalog;
        state.catalogReadAt = Date.now();
        if (forVerdict) state.catalogVerdictEpoch = state.cacheEpoch;
        return catalog;
    }

    function findCharactersByName(catalog, name) {
        const expected = normalizeAttributionName(name);
        if (!expected) return [];
        return catalog.characters.filter((character) => (
            normalizeAttributionName(character?.name) === expected
        ));
    }

    function readMessageCharacterName(row) {
        if (!(row instanceof Element) || row.getAttribute('data-role') !== 'assistant') return '';
        return normalizeAttributionName(row.querySelector('.msg-name-tag')?.textContent || '');
    }

    function readChatHeaderCharacterName() {
        const clearButton = document.querySelector('button[title="清空聊天"]');
        const header = clearButton?.closest('.absolute') || null;
        return normalizeAttributionName(header?.querySelector('span.ml-2.font-medium')?.textContent || '');
    }

    function readMessageIndex(row) {
        const value = String(row?.getAttribute?.('data-chat-index') || '');
        if (!value) return null;
        const index = Number(value);
        return Number.isInteger(index) && index >= 0 ? index : null;
    }

    function readRowMembershipProbe(row) {
        const roots = findMessageRoots(row);
        const candidates = roots.length ? roots : [row];
        incrementRowPerformance(row, 'rowTextSerializations');
        const content = candidates.map((root) => String(root?.textContent || '')).join('\n');
        const markers = [];
        for (const root of candidates) {
            const text = String(root?.textContent || '');
            const matcher = /(?:image|rph-image-marker)###([\s\S]*?)###/gi;
            let match;
            while ((match = matcher.exec(text))) {
                markers.push(`image###${String(match[1] || '').trim()}###`);
            }
            for (const image of [...(root?.querySelectorAll?.('img') || [])]) {
                const prompt = getLegacyImagePrompt(image);
                if (prompt) markers.push(`image###${prompt}###`);
            }
        }
        return {
            index: readMessageIndex(row),
            role: String(row?.getAttribute?.('data-role') || ''),
            content,
            contentHash: content ? hashText(content) : '',
            markers: [...new Set(markers)]
        };
    }

    const canonMarkerCache = new Map();
    function canonMarkerText(value) {
        const source = String(value || '');
        if (canonMarkerCache.has(source)) {
            const cached = canonMarkerCache.get(source);
            canonMarkerCache.delete(source);
            canonMarkerCache.set(source, cached);
            return cached;
        }
        const canonical = source.replace(/[\\*_~`]/g, '').replace(/\s+/g, ' ').trim();
        canonMarkerCache.set(source, canonical);
        if (canonMarkerCache.size > CANON_MARKER_CACHE_LIMIT) {
            canonMarkerCache.delete(canonMarkerCache.keys().next().value);
        }
        return canonical;
    }

    function markersMatchContent(content, markers) {
        if (!Array.isArray(markers) || markers.length === 0) return false;
        const canonContent = canonMarkerText(content);
        return markers.some((marker) => canonContent.includes(canonMarkerText(marker)));
    }

    function messageMatchesMembershipProbe(message, probe) {
        if (!message || typeof message !== 'object') return false;
        const messageRole = String(message.role || '');
        if (probe.role && messageRole && probe.role !== messageRole) return false;
        const content = String(message.content || '');
        if (probe.contentHash && hashText(content) === probe.contentHash) return true;
        return markersMatchContent(content, probe.markers);
    }

    function chatContainsMembership(chat, probe) {
        if (!Array.isArray(chat)) return false;
        if (probe.index !== null && messageMatchesMembershipProbe(chat[probe.index], probe)) return true;
        for (let index = 0; index < chat.length; index += 1) {
            if (index === probe.index) continue;
            if (messageMatchesMembershipProbe(chat[index], probe)) return true;
        }
        return false;
    }

    function getFreshChatCache(uuid) {
        const readAt = Number(state.chatReadAtByUuid.get(uuid)) || 0;
        if (!state.chatBuckets.has(uuid) || Date.now() - readAt >= CHAT_CACHE_TTL_MS) return null;
        return state.chatBuckets.get(uuid);
    }

    async function readCharacterChat(uuid, scanReads = null, options = {}) {
        const targetUuid = String(uuid || '');
        if (!targetUuid) return { chat: [], source: 'empty' };
        if (options.forceForVerdict && state.chatVerdictEpochByUuid.get(targetUuid) === state.cacheEpoch) {
            return { chat: state.chatBuckets.get(targetUuid) || [], source: 'verdict-cache' };
        }
        if (!options.forceForVerdict && !options.force) {
            const cached = getFreshChatCache(targetUuid);
            if (cached) return { chat: cached, source: 'cache' };
        }
        if (!options.forceForVerdict && scanReads?.has(targetUuid)) {
            return { chat: await scanReads.get(targetUuid), source: 'scan' };
        }
        const read = (async () => {
            const value = await dbGet(`rp_hub_chat_${targetUuid}`);
            const chat = Array.isArray(value) ? value : [];
            const now = Date.now();
            state.chatBuckets.set(targetUuid, chat);
            state.chatReadAtByUuid.set(targetUuid, now);
            if (options.forceForVerdict) state.chatVerdictEpochByUuid.set(targetUuid, state.cacheEpoch);
            state.chatReadEpochByUuid.set(targetUuid, state.cacheEpoch);
            state.lastChatReadAt = now;
            return chat;
        })();
        if (scanReads && !options.forceForVerdict) scanReads.set(targetUuid, read);
        return { chat: await read, source: 'database' };
    }

    async function characterMatchesMembership(character, probe, scanReads, options = {}) {
        const uuid = String(character?.uuid || '');
        if (!uuid) return false;
        if (options.forceForVerdict) {
            const result = await readCharacterChat(uuid, scanReads, { forceForVerdict: true });
            return chatContainsMembership(result.chat, probe);
        }
        let result = await readCharacterChat(uuid, scanReads);
        if (chatContainsMembership(result.chat, probe)) return true;
        if (result.source === 'cache') {
            result = await readCharacterChat(uuid, scanReads, { force: true });
            return chatContainsMembership(result.chat, probe);
        }
        return false;
    }

    function uniqueCharacterCandidates(characters) {
        const byUuid = new Map();
        for (const character of characters) {
            const uuid = String(character?.uuid || '');
            if (uuid && !byUuid.has(uuid)) byUuid.set(uuid, character);
        }
        return [...byUuid.values()];
    }

    function createCharacterAttribution(character, source) {
        return {
            uuid: String(character.uuid),
            name: String(character.name || '未命名角色'),
            source
        };
    }

    async function resolveCharacterAttribution(row, catalog, scanReads = new Map(), options = {}) {
        incrementPerformance('attributionAttempts');
        const explicitUuid = String(
            row?.getAttribute?.('data-character-uuid')
            || row?.getAttribute?.('data-rph-character-uuid')
            || ''
        );
        if (explicitUuid) {
            const explicit = catalog.characters.find((item) => String(item?.uuid || '') === explicitUuid);
            if (explicit) return createCharacterAttribution(explicit, 'message-uuid');
            return { error: `message uuid not found: ${explicitUuid}` };
        }

        const headerName = readChatHeaderCharacterName();
        const headerMatches = findCharactersByName(catalog, headerName);
        const selected = catalog.selected?.uuid ? catalog.selected : null;
        const activeCharacter = headerMatches.length === 1 ? headerMatches[0] : selected;
        if (!activeCharacter) {
            return { error: 'active character signals are unavailable' };
        }

        const probe = readRowMembershipProbe(row);
        const readErrors = [];
        const matches = async (character) => {
            try {
                return await characterMatchesMembership(character, probe, scanReads, options);
            } catch (error) {
                readErrors.push(`${String(character?.uuid || 'unknown')}: ${error?.message || error}`);
                return false;
            }
        };
        if (await matches(activeCharacter)) {
            return createCharacterAttribution(activeCharacter, 'active-character');
        }

        const messageMatches = findCharactersByName(catalog, readMessageCharacterName(row));
        const candidates = uniqueCharacterCandidates([
            ...headerMatches,
            selected,
            ...messageMatches
        ]);
        const membershipMatches = [];
        for (const character of candidates) {
            if (await matches(character)) membershipMatches.push(character);
        }
        if (membershipMatches.length === 1) {
            return createCharacterAttribution(membershipMatches[0], 'content-membership');
        }
        if (membershipMatches.length > 1) {
            return {
                error: `content membership is ambiguous: ${membershipMatches.map((item) => item.uuid).join(', ')}`
            };
        }
        const readDetail = readErrors.length ? `; chat reads failed: ${readErrors.join(' | ')}` : '';
        return { error: `content membership did not match a restricted candidate${readDetail}` };
    }

    async function activateCharacterContext(character, options = {}) {
        const uuid = String(character?.uuid || '');
        if (!uuid) {
            state.character = null;
            state.records = [];
            state.chat = [];
            return false;
        }
        const normalized = { uuid, name: String(character.name || '未命名角色') };
        state.character = normalized;
        if (character.source) state.lastAttributionSource = String(character.source);
        let records = state.recordBuckets.get(uuid);
        if (!records || options.reloadRecords) {
            records = await loadRecords(uuid, normalized.name);
            state.recordBuckets.set(uuid, records);
        }
        state.records = records;
        if (Array.isArray(options.chat)) state.chat = options.chat;
        else {
            const chatResult = await readCharacterChat(uuid, options.scanReads || null, { force: Boolean(options.forceChat) });
            state.chat = chatResult.chat;
        }
        return true;
    }

    async function refreshCharacterContext(force = false) {
        const options = typeof force === 'object' ? force : {
            forceCatalog: Boolean(force),
            reloadRecords: Boolean(force),
            forceChat: Boolean(force)
        };
        const catalog = await readCharacterCatalog({ force: Boolean(options.forceCatalog) });
        if (!catalog.selected) {
            if (options.forceCatalog) await activateCharacterContext(null);
            return;
        }
        if (String(state.character?.uuid || '') === String(catalog.selected.uuid || '')
            && !options.reloadRecords && !options.forceChat) {
            state.character = {
                uuid: String(catalog.selected.uuid || ''),
                name: String(catalog.selected.name || '未命名角色')
            };
            return;
        }
        await activateCharacterContext(catalog.selected, {
            reloadRecords: Boolean(options.reloadRecords),
            forceChat: Boolean(options.forceChat)
        });
    }

    function isElementVisible(element) {
        if (!element || !(element instanceof Element)) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function detectConversationBusySignal() {
        if ([...document.querySelectorAll('button[title="中止生成"]')].some(isElementVisible)) {
            return { supported: true, busy: true, source: 'stop-button' };
        }
        if ([...document.querySelectorAll('.typing-bubble')].some(isElementVisible)) {
            return { supported: true, busy: true, source: 'typing-bubble' };
        }
        if ([...document.querySelectorAll('.summary-timeline-card.is-live')].some(isElementVisible)) {
            return { supported: true, busy: true, source: 'live-timeline' };
        }
        if ([...document.querySelectorAll('button[title="发送"]')].some(isElementVisible)) {
            return { supported: true, busy: false, source: 'send-button' };
        }
        if (!state.busySignalWarningShown && document.readyState === 'complete' && document.querySelector('#app')) {
            state.busySignalWarningShown = true;
            log('conversation busy DOM signal unavailable; preserving non-blocking image behavior');
        }
        return { supported: false, busy: false, source: 'unavailable' };
    }

    function isConversationBusy() {
        const signal = detectConversationBusySignal();
        state.busySignalSupported = signal.supported;
        state.busySignalSource = signal.source;
        if (signal.busy) {
            state.lastBusyAt = Date.now();
            const liveChat = readLiveAppValue('chatHistory');
            if (Array.isArray(liveChat) && !state.liveChatBaselines.has(liveChat)) {
                state.liveChatBaselines.set(liveChat, liveChat.length);
            }
        }
        return signal.busy;
    }

    function isProtectedElement(element) {
        if (!(element instanceof Element)) return true;
        if (PROTECTED_TAGS.has(element.tagName)) return true;
        if (element.closest('.native-thinking-wrapper, .cot-ui, .rp-generated-image-frame, iframe')) return true;
        return false;
    }

    function isFrozenForBusy() {
        const configured = state.settings?.freezeImageGeneration;
        return configured !== false && isConversationBusy();
    }

    function getMessageContext(row, attribution) {
        const indexValue = row.getAttribute('data-chat-index');
        const messageIndex = Number.isFinite(Number(indexValue)) ? Number(indexValue) : null;
        const liveSnapshot = readLiveAttributionSnapshot();
        const liveMessage = liveSnapshot?.chatHistory[messageIndex];
        const verifiedLive = liveSnapshot?.uuid === attribution?.uuid && liveMessage
            && messageMatchesMembershipProbe(liveMessage, readRowMembershipProbe(row));
        const message = verifiedLive ? liveMessage : messageIndex !== null ? state.chat[messageIndex] : null;
        const branches = verifiedLive ? readLiveAppValue('storyBranches') : null;
        const branch = verifiedLive ? readLiveAppValue('currentStoryBranch') : null;
        const branchId = verifiedLive ? String(branch?.id || (branches === undefined ? 'main' : '')) : '';
        const liveMutation = state.liveMutationRows.has(row);
        state.liveMutationRows.delete(row);
        const liveChat = readLiveAppValue('chatHistory');
        let liveGrowth = false;
        if (Array.isArray(liveChat)) {
            const baseline = state.liveChatBaselines.get(liveChat);
            if (baseline === undefined) state.liveChatBaselines.set(liveChat, liveChat.length);
            else if (messageIndex !== null && messageIndex >= baseline && messageIndex < liveChat.length) {
                liveGrowth = true;
            }
        }
        const live = liveGrowth || !Array.isArray(liveChat)
            && liveMutation && Date.now() - state.lastBusyAt <= LIVE_WINDOW_MS;
        if (liveGrowth) state.lastBusyAt = Date.now();
        const root = row.querySelector('.message-content-wrapper, .markdown-body') || row;
        return {
            messageId: String(message?.id || row.getAttribute('data-message-id') || ''),
            messageIndex,
            rawContent: String(message?.content || root.textContent || ''),
            branchId,
            parentBranchId: String(branch?.parentId || ''),
            branchCreatedAt: Number(branch?.createdAt) || 0,
            legacyScope: branchId === 'main' && (branches === undefined
                || Array.isArray(branches) && branches.length === 1 && branches[0].id === 'main'),
            attribution,
            live
        };
    }

    const DEFER_IMAGE = Symbol('defer-image');

    function getFrozenRecord(prompt, occurrenceIndex, context, options = {}) {
        const attribution = context?.attribution;
        const ownerUuid = String(attribution?.uuid || '');
        const ownerName = String(attribution?.name || '');
        if (!ownerUuid) {
            reportAttributionFailure('getFrozenRecord received no live attribution');
            return null;
        }
        const descriptor = buildDescriptor(prompt, occurrenceIndex, context);
        const existing = findRecord(descriptor);
        const incomingParams = options.paramsSnapshot ? {
            ...options.paramsSnapshot,
            characterUuid: ownerUuid,
            characterName: ownerName || '未命名角色'
        } : null;
        if (existing) {
            if (existing.status !== 'skipped' && existing.contentHash !== descriptor.contentHash) state.recoveredRecords.add(existing);
            if (descriptor.legacyScope && !existing.branchId) {
                existing.branchId = descriptor.branchId;
                if (descriptor.promptLayout) existing.promptLayout = descriptor.promptLayout;
                scheduleSave({ uuid: ownerUuid });
            }
            if (existing.status === 'skipped') return null;
            return existing;
        }
        if (context.parentBranchId && descriptor.branchId) {
            const parentDescriptor = { ...descriptor, branchId: context.parentBranchId, legacyScope: false };
            parentDescriptor.key = buildImageRenderRecordKey(parentDescriptor);
            const parent = findRecord(parentDescriptor);
            if (parent?.status === 'rendered' && parent.branchId === context.parentBranchId
                && parent.updatedAt <= context.branchCreatedAt) {
                const inherited = normalizeImageRenderRecord({ ...parent, ...descriptor, readOnly: true,
                    createdAt: Date.now(), updatedAt: Date.now() }, ownerUuid);
                state.records.push(inherited);
                scheduleSave({ uuid: ownerUuid });
                return inherited;
            }
        }
        if (isFrozenForBusy()) return DEFER_IMAGE;
        if (!state.autoEnabled) {
            const skipped = normalizeImageRenderRecord({
                ...descriptor,
                status: 'skipped',
                skipped: true,
                paramsSnapshot: {
                    prompt: descriptor.prompt,
                    tag: descriptor.prompt,
                    characterUuid: ownerUuid,
                    characterName: ownerName || '未命名角色'
                },
                imageSignature: '',
                createdAt: Date.now(),
                updatedAt: Date.now()
            }, ownerUuid);
            state.records.push(skipped);
            scheduleSave({ uuid: ownerUuid });
            return null;
        }
        const paramsSnapshot = incomingParams || buildImageParamsSnapshot(descriptor.prompt, {
            occurrenceIndex: descriptor.occurrenceIndex,
            characterUuid: ownerUuid,
            characterName: ownerName
        });
        if (!paramsSnapshot) {
            reportAttributionFailure('image params snapshot could not bind a character uuid');
            return null;
        }
        const manual = context?.live !== true || Date.now() - state.lastBusyAt > LIVE_WINDOW_MS;
        const record = normalizeImageRenderRecord({
            ...descriptor,
            paramsSnapshot,
            imageSignature: buildImageRenderSignature(paramsSnapshot),
            ...(manual ? { status: 'skipped' } : {}),
            createdAt: Date.now(),
            updatedAt: Date.now()
        }, ownerUuid);
        state.records.push(record);
        scheduleSave({ uuid: ownerUuid });
        return record;
    }

    function createImageFrame(record) {
        const manual = record.status === 'skipped' && Boolean(record.imageSignature);
        const frame = document.createElement('span');
        frame.className = 'rp-generated-image-frame';
        frame.dataset.rphImageFrame = '1';
        frame.dataset.imageRenderKey = record.key || '';
        frame.dataset.imageOccurrence = String(record.occurrenceIndex ?? 0);
        frame.dataset.imageSignature = record.imageSignature || '';
        frame.dataset.characterUuid = String(record.paramsSnapshot?.characterUuid || '');
        frame.style.cssText = 'width:auto;height:auto;max-width:100%;box-sizing:border-box;padding:2px;border:1px solid rgba(148,163,184,.35);background:rgba(255,255,255,.55);position:relative;border-radius:8px;overflow:hidden;display:inline-flex;justify-content:center;align-items:center;box-shadow:0 4px 14px rgba(15,23,42,.08);vertical-align:middle;';
        if (manual) {
            const label = document.createElement('span');
            label.textContent = '未生成，点击按钮生成';
            label.style.cssText = 'min-width:180px;min-height:96px;display:flex;align-items:center;justify-content:center;padding:16px 44px 16px 16px;color:#475569;text-align:center;';
            frame.appendChild(label);
        } else {
            const image = document.createElement('img');
            image.src = buildImageRenderUrl(record.paramsSnapshot);
            image.alt = '生成图片';
            image.loading = 'lazy';
            image.decoding = 'async';
            image.referrerPolicy = 'no-referrer';
            image.dataset.rphImageGenerationState = '';
            if (record.readOnly || state.recoveredRecords.has(record)) image.dataset.rphImageReadOnly = '1';
            image.style.cssText = 'max-width:100%;height:auto;width:auto;display:block;object-fit:contain;border-radius:6px;transition:transform .3s ease;';
            frame.appendChild(image);
        }
        if (record.status !== 'skipped' || manual) {
            const reroll = document.createElement('button');
            reroll.type = 'button';
            reroll.className = 'rp-image-reroll-button';
            reroll.dataset.imageRenderKey = record.key || '';
            reroll.title = '重新生成图片';
            reroll.setAttribute('aria-label', '重新生成图片');
            reroll.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>';
            reroll.style.cssText = 'position:absolute;right:6px;top:6px;width:28px;height:28px;border-radius:50%;border:1px solid rgba(148,163,184,.45);background:rgba(255,255,255,.88);color:#334155;display:inline-flex;align-items:center;justify-content:center;margin:0;padding:0;cursor:pointer;box-shadow:0 4px 12px rgba(15,23,42,.12);';
            reroll.querySelector('svg').style.cssText = 'width:18px;height:18px;display:block;';
            frame.appendChild(reroll);
        }
        return frame;
    }

    function appendTextOrFrame(fragment, text, record) {
        if (text) fragment.appendChild(document.createTextNode(text));
        if (record && record !== DEFER_IMAGE) fragment.appendChild(createImageFrame(record));
    }

    function findManualRecord(prompt, occurrenceIndex, context) {
        const record = findRecord(buildDescriptor(prompt, occurrenceIndex, context));
        return record?.status === 'skipped' && record.imageSignature ? record : null;
    }

    function replaceTextNode(node, context) {
        const original = String(node.nodeValue || '');
        if (!original || !/(?:image|rph-image-marker)###/i.test(original) && !/<\/?image\b/i.test(original)) return;
        const source = original.replace(/<\/?image\b[^>]*>/gi, '');
        const parts = source.split(PROTECTION_PATTERN);
        const fragment = document.createDocumentFragment();
        let changed = source !== original;
        for (const part of parts) {
            if (!part) continue;
            if (PROTECTED_TEXT_PATTERN.test(part)) {
                fragment.appendChild(document.createTextNode(part));
                continue;
            }
            const matcher = /(?:image|rph-image-marker)###([\s\S]*?)###/gi;
            let cursor = 0;
            let match;
            while ((match = matcher.exec(part))) {
                changed = true;
                appendTextOrFrame(fragment, part.slice(cursor, match.index), null);
                const prompt = String(match[1] || '').trim();
                const occurrence = context.occurrence;
                context.occurrence += 1;
                let record = prompt ? getFrozenRecord(prompt, occurrence, context.message) : null;
                if (!record && prompt) record = findManualRecord(prompt, occurrence, context.message);
                if (record === DEFER_IMAGE) {
                    appendTextOrFrame(fragment, match[0], null);
                    context.deferred = true;
                } else if (record) {
                    appendTextOrFrame(fragment, '', record);
                }
                cursor = matcher.lastIndex;
            }
            appendTextOrFrame(fragment, part.slice(cursor), null);
        }
        if (changed && node.parentNode) node.parentNode.replaceChild(fragment, node);
    }

    function getLegacyImageSource(image, attribution = null) {
        if (!(image instanceof HTMLImageElement)) return '';
        let url;
        try { url = new URL(image.currentSrc || image.src || '', window.location.origin); } catch (_) { return ''; }
        if (url.pathname !== '/generate' || !url.searchParams.get('tag')) return '';
        if (!['nai.sta1n.cn', 'std.loliyc.com'].includes(url.hostname)) return '';
        const upstreamParams = readGenerationParams(url);
        const prompt = String(url.searchParams.get('tag') || '').trim();
        const provider = url.hostname === 'nai.sta1n.cn' ? 'sta1n' : 'std';
        const paramsSnapshot = {
            ...Object.fromEntries(Object.entries(upstreamParams).filter(([, value]) => !Array.isArray(value))),
            prompt,
            tag: prompt,
            source: 'upstream',
            upstreamHost: url.hostname,
            upstreamParams,
            provider,
            characterUuid: String(attribution?.uuid || ''),
            characterName: String(attribution?.name || '未命名角色')
        };
        return { prompt, paramsSnapshot };
    }

    function getLegacyImagePrompt(image) {
        return getLegacyImageSource(image)?.prompt || '';
    }

    function replaceLegacyImage(image, context, parent) {
        const source = getLegacyImageSource(image, context.message.attribution);
        if (!source?.prompt) return false;
        const host = parent && parent !== context.root ? parent : image;
        let record = getFrozenRecord(source.prompt, context.occurrence, context.message, {
            paramsSnapshot: source.paramsSnapshot
        });
        if (!record) record = findManualRecord(source.prompt, context.occurrence, context.message);
        context.occurrence += 1;
        if (record === DEFER_IMAGE) {
            const marker = document.createTextNode(`image###${source.prompt}###`);
            host.replaceWith(marker);
            context.deferred = true;
        } else if (record) {
            host.replaceWith(createImageFrame(record));
        } else {
            host.remove();
        }
        return true;
    }

    function walkNode(node, context) {
        if (!node || !node.isConnected) return;
        if (node.nodeType === Node.TEXT_NODE) {
            replaceTextNode(node, context);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const element = /** @type {Element} */ (node);
        if (element.classList.contains('rp-generated-image-frame')) {
            context.occurrence += 1;
            return;
        }
        if (isProtectedElement(element)) return;
        if (element.tagName === 'IMAGE') {
            while (element.firstChild) element.parentNode?.insertBefore(element.firstChild, element);
            element.remove();
            return;
        }
        if (element.tagName === 'IMG' && getLegacyImagePrompt(element)) {
            const parent = element.parentElement && element.parentElement.children.length === 1
                ? element.parentElement
                : element;
            if (replaceLegacyImage(element, context, parent)) return;
        }
        for (const child of [...element.childNodes]) walkNode(child, context);
    }

    function findMessageRoots(row) {
        const roots = [...row.querySelectorAll('.message-content-wrapper .markdown-body, .message-content-wrapper > .markdown-body')]
            .filter((root) => !root.closest('.native-thinking-wrapper, .cot-ui, .summary-timeline-card'));
        return roots.length ? roots : [...row.querySelectorAll('.markdown-body')];
    }

    function rowHasImageWork(row) {
        incrementRowPerformance(row, 'rowWorkChecks');
        incrementRowPerformance(row, 'rowTextSerializations');
        const text = String(row?.textContent || '');
        if (/(?:image|rph-image-marker)###|<\/?image\b/i.test(text)) return true;
        if (row?.querySelector?.('image')) return true;
        return [...(row?.querySelectorAll?.('img') || [])].some((image) => Boolean(getLegacyImagePrompt(image)));
    }

    function getRowRevision(row) {
        return Number(state.rowRevisions.get(row)) || 0;
    }

    function markRowDirty(row) {
        if (!(row instanceof Element) || !row.matches?.('[data-chat-index]')) return false;
        state.rowRevisions.set(row, getRowRevision(row) + 1);
        state.dirtyRows.add(row);
        return true;
    }

    function deferAttributionRetry(row, delay = ATTRIBUTION_RETRY_MS, options = {}) {
        setTimeout(() => {
            if (!row?.isConnected) return;
            if (options.refresh && !isConversationBusy()) {
                invalidateAttributionCaches('attribution retry');
            }
            state.dirtyRows.add(row);
            scheduleScan(0);
        }, delay);
    }

    function collectMutationRows(records) {
        const rows = new Set();
        const liveRows = new Set();
        const addClosest = (node) => {
            const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
            const row = element?.closest?.('[data-chat-index]');
            if (!row) return;
            rows.add(row);
            if (state.knownRows.has(row)) liveRows.add(row);
        };
        const addContained = (node) => {
            if (node?.nodeType !== Node.ELEMENT_NODE) return;
            if (node.matches?.('[data-chat-index]')) rows.add(node);
            for (const row of node.querySelectorAll?.('[data-chat-index]') || []) rows.add(row);
        };
        for (const record of records || []) {
            addClosest(record.target);
            if (record.type !== 'childList') continue;
            for (const node of record.addedNodes || []) {
                addClosest(node);
                addContained(node);
            }
        }
        for (const row of rows) {
            state.knownRows.add(row);
            if (liveRows.has(row)) state.liveMutationRows.add(row);
            markRowDirty(row);
        }
        return rows;
    }

    function rowHasImageWorkCached(row) {
        const revision = getRowRevision(row);
        const cached = state.rowWorkCache.get(row);
        if (cached && cached.revision === revision) return cached.value;
        const value = rowHasImageWork(row);
        state.rowWorkCache.set(row, { revision, value });
        return value;
    }

    async function resolveRowAttribution(row, catalog, scanReads) {
        const revision = getRowRevision(row);
        const cached = state.rowAttributionCache.get(row);
        if (cached && cached.revision === revision && cached.epoch === state.cacheEpoch) return cached.value;
        incrementRowPerformance(row, 'attributionRecomputations');
        const explicitUuid = String(
            row?.getAttribute?.('data-character-uuid')
            || row?.getAttribute?.('data-rph-character-uuid')
            || ''
        );
        let value = await resolveCharacterAttribution(row, catalog, scanReads);
        let verdictCatalog = catalog;
        if (!value?.uuid || value.source !== 'active-character') {
            verdictCatalog = await readCharacterCatalog({ forVerdict: true });
            value = await resolveCharacterAttribution(row, verdictCatalog, new Map(), { forceForVerdict: true });
        }
        if (!explicitUuid) {
            const rescue = resolveRuntimeAttribution(row, verdictCatalog);
            if (rescue?.retry) return rescue;
            if (rescue?.uuid && rescue.uuid !== value?.uuid) value = rescue;
        }
        state.rowAttributionCache.set(row, {
            revision: getRowRevision(row),
            epoch: state.cacheEpoch,
            value
        });
        return value;
    }

    async function scanDocument(options = {}) {
        const full = options.full === true || state.fullScanPending;
        if (state.scanning) {
            if (full) state.fullScanPending = true;
            state.scanQueuedWhileBusy = true;
            return;
        }
        if (!document.body) return;
        state.scanning = true;
        incrementPerformance('scanRuns');
        try {
            let candidateRows;
            if (full) {
                incrementPerformance('fullDocumentScans');
                state.fullScanPending = false;
                candidateRows = [...document.querySelectorAll('[data-chat-index][data-role]')];
                for (const row of candidateRows) state.dirtyRows.delete(row);
            } else {
                candidateRows = [...state.dirtyRows].filter((row) => row?.isConnected);
                state.dirtyRows.clear();
                for (const row of candidateRows) incrementRowPerformance(row, 'dirtyRowScans');
            }
            const rows = candidateRows.filter(rowHasImageWorkCached);
            if (!rows.length) {
                if (!isConversationBusy()) processDeferredImages();
                return;
            }
            let catalog = await readCharacterCatalog();
            const scanChatReads = new Map();
            for (const row of rows) {
                const attribution = await resolveRowAttribution(row, catalog, scanChatReads);
                catalog = state.catalogCache || catalog;
                if (attribution?.retry) continue;
                if (!attribution?.uuid) {
                    const detail = String(attribution?.error || 'unknown attribution failure');
                    if (isConversationBusy()) {
                        state.rowAttributionCache.delete(row);
                        delete row.dataset.rphImageAttributionRetry;
                        delete row.dataset.rphImageAttributionFailure;
                        deferAttributionRetry(row, ATTRIBUTION_RETRY_MS, { refresh: true });
                        continue;
                    }
                    if (row.dataset.rphImageAttributionFailure) continue;
                    if (row.dataset.rphImageAttributionRetry !== '1') {
                        state.rowAttributionCache.delete(row);
                        row.dataset.rphImageAttributionRetry = '1';
                        deferAttributionRetry(row, ATTRIBUTION_RETRY_MS, { refresh: true });
                        continue;
                    }
                    delete row.dataset.rphImageAttributionRetry;
                    if (row.dataset.rphImageAttributionFailure !== detail) {
                        row.dataset.rphImageAttributionFailure = detail;
                        reportAttributionFailure(detail);
                    }
                    continue;
                }
                delete row.dataset.rphImageAttributionRetry;
                delete row.dataset.rphImageAttributionFailure;
                await activateCharacterContext(attribution, {
                    scanReads: scanChatReads,
                    chat: attribution.runtimeChat
                });
                const context = getMessageContext(row, attribution);
                const walkContext = { occurrence: 0, deferred: false, message: context, root: row };
                for (const root of findMessageRoots(row)) {
                    if (!root || isProtectedElement(root)) continue;
                    walkContext.root = root;
                    walkNode(root, walkContext);
                }
            }
            if (!isConversationBusy()) processDeferredImages();
        } catch (error) {
            log('DOM scan failed', error);
        } finally {
            state.scanning = false;
            if (state.scanQueuedWhileBusy || state.fullScanPending || state.dirtyRows.size) {
                state.scanQueuedWhileBusy = false;
                scheduleScan(0, { full: state.fullScanPending });
            }
        }
    }

    function scheduleScan(delay = 30, options = {}) {
        if (options.full) state.fullScanPending = true;
        if (state.scanTimer) return;
        state.scanTimer = setTimeout(() => {
            state.scanTimer = null;
            scanDocument({ full: state.fullScanPending }).catch((error) => log('scheduled scan failed', error));
        }, delay);
    }

    function scheduleFullScan(delay = 0) {
        scheduleScan(delay, { full: true });
    }

    function processDeferredImages() {
        if (isFrozenForBusy()) return;
        for (const image of [...document.querySelectorAll('.rp-generated-image-frame img[data-rph-image-generation-state="deferred"]')]) {
            image.dispatchEvent(new Event('error'));
        }
    }

    function canonicalImageRenderUrl(source) {
        const url = new URL(source, window.location.origin);
        url.searchParams.delete('_rph_retry');
        return url;
    }

    function requestImageGeneration(source) {
        const url = canonicalImageRenderUrl(source);
        const requestKey = url.toString();
        if (state.pendingRequests.has(requestKey)) return state.pendingRequests.get(requestKey);
        const request = (async () => {
            const headers = {};
            const token = getImageToken();
            const provider = String(url.searchParams.get('provider') || '').toLowerCase();
            const tokenProvider = getTokenProviderName(token);
            if (token && (!provider || !tokenProvider || provider === tokenProvider)) headers[IMAGE_TOKEN_HEADER] = token;
            const syncPassword = safeLocalGet('rp_hub_sync_password_v1');
            if (syncPassword) headers['x-rp-sync-password'] = syncPassword;
            const response = await fetch(url, { method: 'POST', headers });
            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw new Error(payload?.error || `图片生成失败：HTTP ${response.status}`);
            }
            if (response.body) await response.body.cancel().catch(() => { });
            return true;
        })();
        state.pendingRequests.set(requestKey, request);
        request.then(() => state.pendingRequests.delete(requestKey), () => state.pendingRequests.delete(requestKey));
        return request;
    }

    function handleImageError(event) {
        const image = event.target;
        if (!(image instanceof HTMLImageElement)) return;
        const frame = image.closest('.rp-generated-image-frame');
        if (!frame) return;
        let url;
        try { url = canonicalImageRenderUrl(image.currentSrc || image.src || ''); } catch (_) { return; }
        if (url.origin !== window.location.origin || url.pathname !== IMAGE_RENDER_ENDPOINT) return;
        const currentState = image.dataset.rphImageGenerationState || '';
        if (image.dataset.rphImageReadOnly === '1') {
            image.dataset.rphImageGenerationState = 'missing';
            image.alt = '原图读取失败，可点击重新生成';
            frame.style.minHeight = '96px';
            return;
        }
        if (currentState === 'pending' || currentState === 'retrying') return;
        if (isFrozenForBusy()) {
            image.dataset.rphImageGenerationState = 'deferred';
            return;
        }
        image.dataset.rphImageGenerationState = 'pending';
        requestImageGeneration(url).then(() => {
            const retryUrl = canonicalImageRenderUrl(url);
            retryUrl.searchParams.set('_rph_retry', String(Date.now()));
            image.dataset.rphImageGenerationState = 'retrying';
            image.src = retryUrl.toString();
        }).catch((error) => {
            image.dataset.rphImageGenerationState = 'failed';
            image.alt = '生图失败，请检查密钥或服务状态';
            reportImageGenerationFailure(error);
        });
    }

    function buildImageThumbnailBlob(image) {
        return new Promise((resolve, reject) => {
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            if (!width || !height) return reject(new Error('Image is not ready'));
            const ratio = Math.min(1, 360 / Math.max(width, height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(width * ratio));
            canvas.height = Math.max(1, Math.round(height * ratio));
            const context = canvas.getContext('2d');
            if (!context) return reject(new Error('Canvas unavailable'));
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Failed to build thumbnail')), 'image/webp', 0.8);
        });
    }

    async function uploadImageThumbnail(image) {
        let signature = '';
        try {
            const source = image?.currentSrc || image?.src || '';
            const url = new URL(source, window.location.origin);
            if (url.origin !== window.location.origin || url.pathname !== IMAGE_RENDER_ENDPOINT) return;
            url.searchParams.delete('_rph_retry');
            signature = url.search;
            if (!signature || state.uploadedThumbs.has(signature)) return;
            state.uploadedThumbs.add(signature);
            const blob = await buildImageThumbnailBlob(image);
            const response = await fetch(IMAGE_THUMB_ENDPOINT + signature, {
                method: 'PUT',
                headers: {
                    'Content-Type': blob.type || 'image/webp',
                    'x-rp-sync-password': safeLocalGet('rp_hub_sync_password_v1')
                },
                body: blob
            });
            if (!response.ok) throw new Error(`Thumbnail upload failed: ${response.status}`);
        } catch (error) {
            if (signature) state.uploadedThumbs.delete(signature);
            log('thumbnail upload failed', error);
        }
    }

    function handleImageLoad(event) {
        const image = event.target;
        if (!(image instanceof HTMLImageElement)) return;
        const frame = image.closest('.rp-generated-image-frame');
        if (!frame) return;
        delete image.dataset.rphImageGenerationState;
        if (frame.getAttribute('data-image-render-key')) {
            scheduleSave({ uuid: frame.getAttribute('data-character-uuid') || '' });
        }
        uploadImageThumbnail(image).catch((error) => log('thumbnail task failed', error));
    }

    async function getRecordBucketEntry(key, ownerUuid = '') {
        const hintedUuid = String(ownerUuid || '');
        const candidateUuids = hintedUuid
            ? [hintedUuid]
            : [String(state.character?.uuid || ''), ...state.recordBuckets.keys()].filter(Boolean);
        for (const uuid of [...new Set(candidateUuids)]) {
            let records = state.recordBuckets.get(uuid);
            if (!records) {
                records = await loadRecords(uuid);
                state.recordBuckets.set(uuid, records);
            }
            const index = records.findIndex((record) => record.key === key);
            if (index >= 0) return { uuid, records, index, record: records[index] };
        }
        return null;
    }

    async function rerollImageRender(key, ownerUuid = '') {
        const entry = await getRecordBucketEntry(key, ownerUuid);
        if (!entry) return;
        const { uuid, records, index } = entry;
        const previous = entry.record;
        const paramsSnapshot = buildImageParamsSnapshot(previous.prompt || previous.paramsSnapshot?.prompt || '', {
            reroll: true,
            previousSeed: previous.paramsSnapshot?.seed,
            characterUuid: previous.paramsSnapshot?.characterUuid,
            characterName: previous.paramsSnapshot?.characterName
        });
        if (!paramsSnapshot) return;
        const record = normalizeImageRenderRecord({
            ...previous,
            paramsSnapshot,
            imageSignature: buildImageRenderSignature(paramsSnapshot),
            updatedAt: Date.now(),
            rerollCount: (Number(previous.rerollCount) || 0) + 1,
            readOnly: false,
            status: 'rendered'
        }, uuid);
        records[index] = record;
        markRecordBucketDirty(uuid);
        if (!await saveRecords({ uuid, records, silent: true })) {
            records[index] = previous;
            throw new Error('图片记录保存失败');
        }
        const frame = document.querySelector(`.rp-generated-image-frame[data-image-render-key="${CSS.escape(key)}"]`);
        if (frame) frame.replaceWith(createImageFrame(record));
    }

    function rerollUpstreamTag(value) {
        const tags = String(value || '').split(',').map((tag) => tag.trim()).filter(Boolean);
        if (tags.length < 2) return '';
        const candidates = [];
        for (let index = 0; index < tags.length - 1; index += 1) {
            if (tags[index] !== tags[index + 1]) candidates.push(index);
        }
        if (!candidates.length) return '';
        const swapIndex = candidates[Math.floor(Math.random() * candidates.length)];
        [tags[swapIndex], tags[swapIndex + 1]] = [tags[swapIndex + 1], tags[swapIndex]];
        return tags.join(', ');
    }

    async function rerollUpstreamImageRender(key, ownerUuid = '') {
        const entry = await getRecordBucketEntry(key, ownerUuid);
        if (!entry) return;
        const { uuid, records, index } = entry;
        const previous = entry.record;
        if (previous.paramsSnapshot?.source !== 'upstream') return rerollImageRender(key, uuid);
        const upstreamParams = normalizeGenerationParams(previous.paramsSnapshot.upstreamParams);
        const currentTag = Array.isArray(upstreamParams.tag) ? upstreamParams.tag[0] : upstreamParams.tag;
        const nextTag = rerollUpstreamTag(currentTag);
        if (!nextTag) throw new Error('提示词太短，无法重新生成');
        const upstreamModel = Array.isArray(upstreamParams.model)
            ? String(upstreamParams.model[0] || '')
            : String(upstreamParams.model || '');
        const { targetArtists, styleKey, styleName } = getImageArtistConfig(upstreamModel);
        const artist = String(targetArtists || '').slice(0, 2500);
        upstreamParams.tag = nextTag;
        upstreamParams.artist = artist;
        const paramsSnapshot = {
            ...previous.paramsSnapshot,
            tag: nextTag,
            artist,
            styleKey,
            styleName,
            upstreamParams,
            upstreamSourceSignature: getUpstreamSourceSignature(previous)
        };
        const record = normalizeImageRenderRecord({
            ...previous,
            paramsSnapshot,
            imageSignature: buildImageRenderSignature(paramsSnapshot),
            updatedAt: Date.now(),
            rerollCount: (Number(previous.rerollCount) || 0) + 1,
            readOnly: false,
            status: 'rendered'
        }, uuid);
        records[index] = record;
        markRecordBucketDirty(uuid);
        if (!await saveRecords({ uuid, records, silent: true })) {
            records[index] = previous;
            throw new Error('图片记录保存失败');
        }
        const frame = document.querySelector(`.rp-generated-image-frame[data-image-render-key="${CSS.escape(key)}"]`);
        if (frame) frame.replaceWith(createImageFrame(record));
    }

    async function rerollStoredImageRender(key, ownerUuid = '') {
        await loadSettings();
        const entry = await getRecordBucketEntry(key, ownerUuid);
        if (!entry) return;
        if (entry.record.paramsSnapshot?.source === 'upstream') {
            return rerollUpstreamImageRender(key, entry.uuid);
        }
        return rerollImageRender(key, entry.uuid);
    }

    function handleImageClick(event) {
        const nativeButton = event.target?.closest?.('.generated-image-reroll');
        if (nativeButton) {
            const frame = nativeButton.closest('.generated-image-card')?.querySelector('.rp-generated-image-frame');
            const key = frame?.getAttribute('data-image-render-key') || '';
            const ownerUuid = frame?.getAttribute('data-character-uuid') || '';
            if (!key) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            const card = nativeButton.closest('.generated-image-card');
            if (card?.classList.contains('is-rerolling')) return;
            card?.classList.add('is-rerolling');
            nativeButton.disabled = true;
            rerollUpstreamImageRender(key, ownerUuid).catch((error) => {
                if (/记录保存失败/.test(String(error?.message || ''))) reportRecordFlushFailure(error);
                else reportImageGenerationFailure(error);
            }).finally(() => {
                card?.classList.remove('is-rerolling');
                nativeButton.disabled = false;
            });
            return;
        }
        const button = event.target?.closest?.('.rp-image-reroll-button');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (button.disabled) return;
        button.disabled = true;
        const frame = button.closest('.rp-generated-image-frame');
        rerollStoredImageRender(
            button.getAttribute('data-image-render-key') || '',
            frame?.getAttribute('data-character-uuid') || ''
        ).catch((error) => {
            if (/记录保存失败/.test(String(error?.message || ''))) reportRecordFlushFailure(error);
            else reportImageGenerationFailure(error);
        }).finally(() => {
            button.disabled = false;
        });
    }

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

    function resolveRuntimeAttribution(row, catalog) {
        const live = readLiveAttributionSnapshot();
        if (!live) return null;
        const index = readMessageIndex(row);
        if (index === null) return null;
        const message = live.chatHistory[index];
        const role = String(row?.getAttribute?.('data-role') || '');
        if (!message || String(message.role || '') !== role) return null;
        const probe = readRowMembershipProbe(row);
        if (!markersMatchContent(message.content, probe.markers)) return null;
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
            maintainLiveRenderHook();
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
        getPerformanceCounters: () => readPerformanceCounters(),
        resetPerformanceCounters: (options = {}) => resetPerformanceCounters(options),
        setPerformanceRowDetailsEnabled: (enabled) => {
            state.performanceRowDetailsEnabled = Boolean(enabled);
            state.performanceRowDetails.clear();
        }
    };
})();
