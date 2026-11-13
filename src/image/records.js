    function normalizeImageRenderRecord(record = {}, ownerUuid = '') {
        // 魔改版（cy-2-u/rp）的记录：分支记在 storyScopeId，key 是它自己的拼法、哈希不补零，
        // 参数里不带提示词，图片在 R2 的位置记在 imageKey。换成我们的写法，原图照常显示。
        const fork = record.storyScopeId !== undefined;
        const forkHash = (value) => (fork && value ? String(value).padStart(8, '0') : String(value || ''));
        const paramsSnapshot = record.paramsSnapshot && typeof record.paramsSnapshot === 'object'
            ? { ...record.paramsSnapshot }
            : {};
        if (fork && record.imageKey) paramsSnapshot.imageKey = String(record.imageKey);
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
        if (fork) paramsSnapshot.tag ||= prompt;
        const createdAt = Number(record.createdAt) || Date.now();
        const normalized = {
            key: fork ? '' : String(record.key || ''),
            messageId: String(record.messageId || ''),
            messageIndex: Number.isFinite(Number(record.messageIndex)) ? Number(record.messageIndex) : null,
            contentHash: forkHash(record.contentHash),
            occurrenceIndex: Math.max(0, Number(record.occurrenceIndex) || 0),
            prompt,
            promptHash: forkHash(record.promptHash) || hashText(prompt),
            ...(record.branchId || fork ? { branchId: String(record.branchId || record.storyScopeId) } : {}),
            ...(record.promptLayout ? { promptLayout: String(record.promptLayout) } : {}),
            ...(record.readOnly === true ? { readOnly: true } : {}),
            ...(fork || record.fork === true ? { fork: true } : {}),
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
            if (paramsSnapshot.imageKey) params.set('image_key', String(paramsSnapshot.imageKey));
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

    // 画风、模型、比例以页面上正在用的设置为准，改完下一张图就生效；页面还没挂载时才用启动时读的副本。
    function liveSettings() {
        const live = readLiveAppValue('settings');
        return live && typeof live === 'object' ? live : (state.settings || {});
    }

    function getImageArtistConfig(model = '') {
        const settings = liveSettings();
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
        const settings = liveSettings();
        // Pre-1.8.6 slots have no imageModel setting; fall back to the model
        // this module has always used.
        const model = String(settings.imageModel || '').trim();
        return model || IMAGE_GEN_DEFAULT_MODEL;
    }

    // 测试版生图设置（站点 R2 里的 /image/api/settings）：生图参数和所选生图接口。读不到时用原来的固定值。
    const generation = {
        settings: { generator: 'direct', params: { steps: 28, scale: 6, cfg: 0, sampler: 'k_dpmpp_2m_sde', noise_schedule: 'karras', resolution: '', negative: '' } },
        providers: new Map(),
        paramHandlers: new Set()
    };

    // 设置以最后一次改动为准：先发出、晚回来的读取不会盖掉之后改过的值。
    let settingsRevision = 0;

    function applyGenerationSettings(settings) {
        settingsRevision += 1;
        if (settings && typeof settings === 'object') generation.settings = structuredClone(settings);
        return generation.settings;
    }

    async function reloadGenerationSettings() {
        const revision = ++settingsRevision;
        try {
            const headers = { 'x-rp-sync-password': safeLocalGet('rp_hub_sync_password_v1') || '' };
            const response = await fetch('/image/api/settings', { headers, credentials: 'same-origin' });
            const body = await response.json().catch(() => null);
            if (revision === settingsRevision && response.ok && body?.settings) generation.settings = body.settings;
        } catch (error) {
            log('image settings unavailable; using defaults', error);
        }
        return generation.settings;
    }

    // 插件注册的生图接口：generate({ params, token, signal }) 返回图片 Blob，外壳负责上传存进 R2。
    function registerImageProvider(provider) {
        const id = String(provider?.id || '').trim();
        if (!/^[a-z0-9-]{3,32}$/.test(id) || id === 'direct') throw new TypeError('image provider id must be 3-32 lowercase letters, digits or dashes');
        if (typeof provider.generate !== 'function') throw new TypeError('image provider generate must be a function');
        generation.providers.set(id, {
            id,
            label: String(provider.label || id).slice(0, 40),
            maxSteps: Math.min(50, Math.max(1, Math.round(Number(provider.maxSteps) || 28))),
            costHint: typeof provider.costHint === 'function' ? provider.costHint : null,
            generate: provider.generate
        });
        window.dispatchEvent(new CustomEvent('rph-image-providers-change'));
    }

    // 每张图的点数：公式来自 Nai2API README（2026-10-05 对照 NovelAI 官网核对），直链和网页任务共用。
    const IMAGE_PIXELS = {
        竖图: [832, 1216], 横图: [1216, 832], 方图: [1024, 1024],
        '2K竖图': [1088, 1600], '2K横图': [1600, 1088], '2K方图': [1344, 1344],
        '4K竖图': [1344, 1984], '4K横图': [1984, 1344], '4K方图': [1728, 1728]
    };
    function estimateImagePoints(model, size, steps) {
        const [width, height] = IMAGE_PIXELS[size] || IMAGE_PIXELS.竖图;
        const pixels = width * height;
        const v5 = String(model || '').includes('diffusion-5');
        if (steps <= 28 && pixels <= 1024 * 1024) return v5 ? 6 : 1;
        const base = Math.ceil(0.000002951823174884865 * pixels + 0.0000005753298233447344 * pixels * steps);
        return v5 ? Math.max(2, Math.ceil(base * 1.5)) : Math.max(2, base);
    }

    // 生图前改参数：只影响之后的新图，已生成的图锁住生成时的参数。
    function onImageParams(handler) {
        if (typeof handler !== 'function') throw new TypeError('image params handler must be a function');
        generation.paramHandlers.add(handler);
        return () => generation.paramHandlers.delete(handler);
    }
    reloadGenerationSettings();

    function applyParamHandlers(snapshot) {
        for (const handler of generation.paramHandlers) {
            try {
                const draft = structuredClone(snapshot);
                const result = handler(draft);
                const next = result && typeof result === 'object' ? result : draft;
                for (const key of ['tag', 'artist', 'negative', 'size', 'steps', 'scale', 'cfg', 'sampler', 'noise_schedule']) {
                    if (next[key] !== undefined) snapshot[key] = String(next[key]);
                }
            } catch (error) {
                log('image params handler failed', error);
            }
        }
        return snapshot;
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
        const settings = liveSettings();
        const params = generation.settings.params || {};
        return applyParamHandlers({
            prompt: safePrompt,
            tag: safePrompt.slice(0, 2000),
            source: 'module',
            provider: getProviderName(),
            model,
            artist: String(targetArtists || '').slice(0, 2500),
            styleKey,
            styleName,
            size: `${params.resolution || ''}${settings.imageSize || '竖图'}`,
            steps: String(params.steps ?? 28),
            scale: String(params.scale ?? 6),
            cfg: String(params.cfg ?? 0),
            sampler: String(params.sampler || 'k_dpmpp_2m_sde'),
            negative: String(params.negative || IMAGE_GEN_NEGATIVE_PROMPT),
            nocache: options.reroll ? '1' : '0',
            rerollNonce,
            noise_schedule: String(params.noise_schedule || 'karras'),
            seed,
            characterUuid,
            characterName: String(options.characterName || '未命名角色')
        });
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
        if (exact && exact.status !== 'skipped') return exact;
        // 魔改版迁来的图：魔改版只按分支、消息、第几张认图（流式输出到一半就生图，内容指纹是半截的；提示词从地址读回，& 后被截、+ 变空格），
        // 对不上时照它的规则找，也盖过因为没认出它而留下的「未生成」占位和自动生图关着时记下的跳过。
        const forkSlot = records.find((record) => record.fork && record.status !== 'skipped'
            && record.occurrenceIndex === descriptor.occurrenceIndex
            && (descriptor.messageId ? record.messageId === descriptor.messageId
                : record.messageIndex === descriptor.messageIndex && record.contentHash === descriptor.contentHash));
        if (forkSlot) return forkSlot;
        if (exact && !exact.imageSignature) return exact;
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

