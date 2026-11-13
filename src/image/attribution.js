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

    function characterCatalogEntry({ uuid, name }) {
        return { uuid, name };
    }

    async function loadCharacterCatalogFromDb() {
        incrementPerformance('directoryDbGets');
        incrementPerformance('catalogReads');
        const [legacy, last] = await Promise.all([
            dbGet('rp_hub_characters'),
            dbGet('rp_hub_last_active_char')
        ]);
        if (Array.isArray(legacy)) {
            const characters = legacy.filter((item) => item && String(item.uuid || '')).map(characterCatalogEntry);
            const selectedIndex = typeof last === 'string' && last
                ? characters.findIndex((item) => String(item.uuid || '') === last)
                : Number(last);
            return {
                characters,
                selected: Number.isInteger(selectedIndex) && selectedIndex >= 0 ? characters[selectedIndex] || null : null,
                last
            };
        }

        // 角色成员和选中项以数据库为准；归属核对只取 UUID 和名字。
        // 优先复用页面中的角色，缺少时才逐张读库，避免复制整库头像。
        const indexValue = await dbGet('rp_hub_character_index');
        const order = Array.isArray(indexValue?.order)
            ? indexValue.order.map((value) => String(value || '')).filter(Boolean)
            : [];
        const liveCards = readLiveAppValue('characters');
        const liveEntries = new Map((Array.isArray(liveCards) ? liveCards : [])
            .filter((card) => card && String(card.uuid || ''))
            .map((card) => [String(card.uuid), card]));
        const characters = [];
        for (const uuid of order) {
            const card = liveEntries.get(uuid) || await dbGet(`rp_hub_character_${uuid}`);
            if (card && String(card.uuid || '')) characters.push(characterCatalogEntry(card));
        }
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

