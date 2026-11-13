    function isElementVisible(element) {
        if (!element || !(element instanceof Element)) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function detectConversationBusySignal() {
        // 页面的 isConversationBusy 与“中止生成”按钮同源；能读到就直接用，避免每次查 DOM 并触发样式计算。
        if (readLiveAppValue('isConversationBusy') === true) return { supported: true, busy: true, source: 'app-state' };
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
        // 生图设置存在站点上、所有设备共用；别的设备改过之后，这个页面在开始新一轮回复时重新读一次。
        if (signal.busy && !state.settingsReadForBusy) reloadGenerationSettings();
        state.settingsReadForBusy = signal.busy;
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
        // 先看页面当前状态（当前角色 + 这条消息在聊天里的位置），最快也最准；读不到时才翻页面标题和本地聊天记录兜底。
        let value = explicitUuid ? null : resolveRuntimeAttribution(row, catalog);
        if (value?.retry) return value;
        if (!value?.uuid) {
            value = await resolveCharacterAttribution(row, catalog, scanReads);
            let verdictCatalog = catalog;
            if (!value?.uuid || value.source !== 'active-character') {
                verdictCatalog = await readCharacterCatalog({ forVerdict: true });
                value = await resolveCharacterAttribution(row, verdictCatalog, new Map(), { forceForVerdict: true });
            }
            if (!explicitUuid) {
                const rescue = resolveRuntimeAttribution(row, verdictCatalog);
                if (rescue?.retry) return rescue;
                if (rescue?.uuid) value = rescue;
            }
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
                        reportAttributionFailure(`${detail} | ${describeRuntimeAttribution(row)}`);
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
        if (!state.fullScanPending && isConversationBusy()) delay = Math.max(delay, BUSY_SCAN_INTERVAL_MS);
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

