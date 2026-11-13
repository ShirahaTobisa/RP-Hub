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
    // AI 回复期间消息每出一个字就变一次，生图又处于冻结状态；普通扫描放宽到这个间隔，回复结束后照常扫描。
    const BUSY_SCAN_INTERVAL_MS = 500;
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
        // 正式页面有 DB/ui-kit.js，用页面原生提示条；单独加载生图模块时（旧测试）用下面的备用提示条。
        if (window.RPHubUI) {
            window.RPHubUI.toast(message, { kind: options.kind === 'info' ? 'info' : 'error', duration: 4200 });
            return;
        }
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

    function describeGenerationError(error) {
        const text = String(error?.message || '').replace(/^图片生成失败[：:]\s*/, '').trim();
        return Array.from(text).slice(0, 80).join('');
    }

    // 一轮回复里几张图一起失败只弹一条，带上 Worker/插件给的原因。
    // 重绘后旧 img 还没丢时，新旧两个 img 共用一次请求、拿到同一个 Error，只算一张。
    const generationFailures = { reasons: new Set(), errors: new Set(), count: 0, timer: 0 };
    function reportImageGenerationFailure(error = null) {
        log('image generation failed', error);
        if (error instanceof Object) {
            if (generationFailures.errors.has(error)) return;
            generationFailures.errors.add(error);
        }
        const reason = describeGenerationError(error);
        if (reason) generationFailures.reasons.add(reason);
        generationFailures.count += 1;
        clearTimeout(generationFailures.timer);
        generationFailures.timer = setTimeout(() => {
            const { count } = generationFailures;
            const [first, ...others] = generationFailures.reasons;
            generationFailures.reasons.clear();
            generationFailures.errors.clear();
            generationFailures.count = 0;
            if (!first) return showImageToast('图片生成失败，请检查密钥或服务状态');
            showImageToast(`图片生成失败${count > 1 ? `（${count} 张）` : ''}：${first}${others.length ? `；另有 ${others.length} 种原因` : ''}`);
        }, 800);
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

