    async function commitReroll(entry, paramsSnapshot) {
        const { uuid, records, index, record: previous } = entry;
        window.RPHubDiagnostics?.record('image-reroll-start', { owner: uuid, current: state.character?.uuid });
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
            window.RPHubDiagnostics?.record('image-save-error', { owner: uuid, current: state.character?.uuid });
            records[index] = previous;
            throw new Error('图片记录保存失败');
        }
        const frame = document.querySelector(`.rp-generated-image-frame[data-character-uuid="${CSS.escape(uuid)}"][data-image-render-key="${CSS.escape(previous.key)}"]`);
        if (frame) frame.replaceWith(createImageFrame(record));
        window.RPHubDiagnostics?.record('image-reroll-end', { owner: uuid, current: state.character?.uuid });
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
        const previous = entry.record;
        await reloadGenerationSettings();
        const paramsSnapshot = buildImageParamsSnapshot(previous.prompt || previous.paramsSnapshot?.prompt || '', {
            reroll: true,
            previousSeed: previous.paramsSnapshot?.seed,
            characterUuid: previous.paramsSnapshot?.characterUuid,
            characterName: previous.paramsSnapshot?.characterName
        });
        if (!paramsSnapshot) return;
        return commitReroll(entry, paramsSnapshot);
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
        const { uuid } = entry;
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
        return commitReroll(entry, paramsSnapshot);
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

