    function pullFromServer() { return runSyncLocked(performPullSync); }

    async function performPullSync() {
        if (state.syncing) return;
        window.RPHubDiagnostics?.record('sync-pull-start');

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);
        let restoreStarted = false;
        let restoreSucceeded = false;

        try {
            updateProgress(0, '正在检查云端数据…');
            const manifestResponse = await postSync({ action: 'pull-manifest' });
            const remote = manifestResponse.remote || manifestResponse.fork;
            if (!remote) {
                updateProgress(100, '云端暂无数据。');
                setActionButtonsDisabled(false);
                return;
            }

            if (remote.snapshotFormat === 'rp-sync-jsonl-v2' || Number(remote.schemaVersion) === 5) {
                throw new Error('云端数据格式不受支持。');
            }

            if ((remote.snapshotFormat === SNAPSHOT_FORMAT && isStreamSchema(remote.schemaVersion))
                || remote.snapshotFormat === FORK_SNAPSHOT_FORMAT) {
                await restoreStreamSnapshot(remote, () => {
                    globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
                    restoreStarted = true;
                    announceRestore('start');
                });
            } else if (!remote.snapshotFormat || remote.snapshotFormat === LEGACY_SNAPSHOT_FORMAT) {
                const response = await downloadLegacyRemoteSnapshot(remote);
                if (!response) throw new Error('云端暂无数据。');
                updateProgress(55, '正在写入本地数据…');
                const remoteSnapshot = JSON.parse(response.json);
                if (!remoteSnapshot
                    || (!Array.isArray(remoteSnapshot.indexedDB)
                        && !Array.isArray(remoteSnapshot.localStorage))) {
                    throw new Error(CLOUD_DATA_INVALID);
                }
                globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
                restoreStarted = true;
                announceRestore('start');
                await replaceLocalSnapshot(remoteSnapshot);
            } else {
                throw new Error('云端数据格式不受支持。');
            }

            restoreSucceeded = true;
            window.RPHubDiagnostics?.record('sync-pull-end');
            markDirtyAll(); // 本地数据整个换过了，下次上传完整扫描
            try { localStorage.removeItem(RESTORE_NOTICE_KEY); } catch (_) { /* storage blocked */ }
            announceRestore('done');
            state.reloadPending = true;
            updateProgress(100, '下载完成，页面即将刷新…');
            setTimeout(() => {
                location.reload();
            }, 700);
        } catch (error) {
            window.RPHubDiagnostics?.failure('sync-pull-error', error);
            if (restoreStarted && !restoreSucceeded) {
                // 本地库可能只换了一半。内存里的旧数据不能写回去（会把换好的部分盖掉，角色卡还会因为哈希缓存没变而漏写），
                // 写闸门保持关着，刷新让页面按现在的库重新加载，刷新后提示一次让用户重新拉取。
                announceRestore('failed');
                try {
                    localStorage.setItem(RESTORE_NOTICE_KEY, `上次下载未完成，本地数据可能不完整，请重新下载后再上传。原因：${error?.message || '未知错误。'}`);
                } catch (_) { /* storage blocked */ }
                state.reloadPending = true;
                updateProgress(100, '下载未完成，页面即将刷新…');
                setTimeout(() => {
                    location.reload();
                }, 700);
                return;
            }
            updateProgress(100, `下载失败：${error?.message || '请稍后重试。'}`);
            setActionButtonsDisabled(false);
        } finally {
            state.syncing = state.reloadPending;
            updateButtonState();
        }
    }

    // 扫描本地（或只重做改过的）、和云端比对、传缺的分片、提交；返回给用户看的结果。
    async function uploadLocalSnapshot(mode) {
        updateProgress(16, mode === 'fast' ? '正在检查改动…' : '正在扫描本地数据…');
        const plan = await buildSnapshotPlan(mode);
        const { snapshot } = plan;
        // 云端和本地一致了：记下这次的布局，改过的键清掉
        const finishPlan = async () => {
            await saveSyncLayout(plan);
            clearDirty(plan.consumed, !plan.fast);
        };

        updateProgress(24, '正在检查云端数据…');
        const remoteStatus = await postSync({ action: 'pull-manifest' });
        if (remoteStatus?.remote?.snapshotFormat === SNAPSHOT_FORMAT
            && Number(remoteStatus.remote.schemaVersion) === SNAPSHOT_SCHEMA_VERSION
            && remoteStatus.remote.checksum === snapshot.checksum) {
            await finishPlan();
            return '云端数据已是最新，无需上传。';
        }
        // 云端还是魔改版的数据：这台设备不一定是最新的，先问一句（魔改版的根清单会另存，不会丢）。
        if (remoteStatus?.fork && !await openInlineConfirm({
            title: '替换云端数据',
            message: `云端是魔改版 ${new Date(remoteStatus.fork.updatedAt).toLocaleString('zh-CN')} 同步的数据，上传后会被本机数据替换；本机数据不是最新时请先下载。`,
            confirmText: '上传'
        })) {
            return '已取消上传。';
        }

        updateProgress(30, '正在准备上传…');
        await syncStateStore('parts', 'readwrite', (store) => store.clear());
        const staged = new Set();
        for (let conflictAttempt = 0; conflictAttempt < 4; conflictAttempt += 1) {
            const uploadSession = await postSync({
                action: 'upload-create',
                checksum: snapshot.checksum,
                snapshotFormat: snapshot.snapshotFormat,
                schemaVersion: snapshot.schemaVersion,
                chunkerProfile: snapshot.chunkerProfile,
                recordCount: snapshot.recordCount,
                chunkSize: CONFIG.chunkSize,
                chunkCount: snapshot.chunkManifest.length,
                totalBytes: snapshot.totalBytes,
                chunkManifest: snapshot.chunkManifest
            });
            if (uploadSession.alreadyUpToDate) {
                await finishPlan();
                return '云端数据已是最新，无需上传。';
            }
            const missingIndices = Array.isArray(uploadSession.missingIndices)
                ? uploadSession.missingIndices
                : snapshot.chunkManifest.map((chunk) => chunk.index);
            if (new Set(missingIndices).size !== missingIndices.length
                || missingIndices.some((index) => !Number.isInteger(index)
                    || index < 0
                    || index >= snapshot.chunkManifest.length)) {
                throw new Error('服务器返回的数据格式不正确。');
            }
            const toStage = missingIndices.filter((index) => !staged.has(index));
            if (toStage.length) {
                updateProgress(36, '正在准备上传…');
                await stageMissingChunks(plan, toStage);
                toStage.forEach((index) => staged.add(index));
            }
            // 要传的都在本机暂存里了：之后不挡页面，可以关掉同步面板接着玩
            if (missingIndices.length) enterBackgroundUpload();
            await sendStagedParts(missingIndices);
            updateProgress(92, '正在完成上传…');
            try {
                const commitResponse = await postSync({
                    action: 'upload-complete',
                    checksum: snapshot.checksum,
                    snapshotFormat: snapshot.snapshotFormat,
                    schemaVersion: snapshot.schemaVersion,
                    chunkerProfile: snapshot.chunkerProfile,
                    recordCount: snapshot.recordCount,
                    chunkSize: CONFIG.chunkSize,
                    chunkCount: snapshot.chunkManifest.length,
                    totalBytes: snapshot.totalBytes,
                    chunkManifest: snapshot.chunkManifest,
                    expectedVersion: uploadSession.previousVersion
                }, { retryCount: 1, timeoutMs: CONFIG.commitTimeoutMs });
                const confirmation = await postSync({ action: 'pull-manifest' });
                if (!confirmation.remote
                    || confirmation.remote.checksum !== snapshot.checksum
                    || Number(confirmation.remote.version) !== Number(commitResponse.version)
                    || confirmation.remote.snapshotFormat !== SNAPSHOT_FORMAT
                    || Number(confirmation.remote.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) {
                    throw new Error('上传结果校验失败，请重新上传。');
                }
            } catch (error) {
                if (Number(error?.status) !== 409 || conflictAttempt >= 3) throw error;
                await wait(CONFIG.retryDelayMs);
                continue;
            }
            await syncStateStore('uploaded', 'readwrite', (store) => store.clear()).catch(() => {}); // 都提交了，不用再记
            await finishPlan();
            const rebuilt = plan.rebuilt.reduce((sum, region) => sum + region.end - region.start + 1, 0);
            return plan.fast ? `快速上传成功：更新了 ${rebuilt} 个数据块，共 ${snapshot.chunkManifest.length} 个。` : '上传成功。';
        }
        throw new Error('云端数据正被其他设备更新，请稍后重试。');
    }

    // mode：fast 只重做改过的数据（没有上次的记录时自动完整扫描），full 全部重新扫描。
    function pushToServer(mode = 'full') { return runSyncLocked(() => performPushSync(mode)); }

    async function performPushSync(mode = 'full') {
        if (state.syncing) return;
        window.RPHubDiagnostics?.record('sync-push-start');

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);
        let succeeded = false;

        try {
            updateProgress(8, '正在保存本地数据…');
            if (!globalThis.RPHubCharStore || typeof globalThis.RPHubCharStore.assertPushAllowed !== 'function') {
                throw new Error('页面未完整加载，请刷新后重试。');
            }
            await globalThis.RPHubCharStore.assertPushAllowed();
            await flushAppState();

            // 整理途中本地数据被改了（第二遍生成的分片和第一遍对不上）就重新来一次；已经在后台上传时不再自动重来
            let status;
            for (let attempt = 0; ; attempt += 1) {
                try {
                    status = await uploadLocalSnapshot(mode);
                    break;
                } catch (error) {
                    if (attempt >= 1 || state.background || error?.message !== LOCAL_DATA_CHANGED) throw error;
                    updateProgress(16, '本地数据有变动，正在重新扫描…');
                }
            }
            updateProgress(100, status);
            succeeded = true;
            window.RPHubDiagnostics?.record('sync-push-end');
            setActionButtonsDisabled(false);
        } catch (error) {
            window.RPHubDiagnostics?.failure('sync-push-error', error);
            updateProgress(100, `上传失败：${error?.message || '请稍后重试。'}`);
            setActionButtonsDisabled(false);
        } finally {
            syncStateStore('parts', 'readwrite', (store) => store.clear()).catch(() => {});
            leaveBackgroundUpload(succeeded);
            state.syncing = false;
            updateButtonState();
        }
    }

    // ---- 不挡页面的上传：分片都进了本机暂存以后，同步面板可以关掉，进度显示在屏幕上方的小悬浮条上 ----
    function warnBeforeUnload(event) {
        event.preventDefault();
        event.returnValue = '';
    }

    function enterBackgroundUpload() {
        if (state.background) return;
        state.background = true;
        try { localStorage.setItem(PENDING_UPLOAD_KEY, String(Date.now())); } catch (_) { /* storage blocked */ }
        window.addEventListener('beforeunload', warnBeforeUnload);
        if (closeButton) closeButton.disabled = false;
    }

    function clearPendingUpload() {
        try { localStorage.removeItem(PENDING_UPLOAD_KEY); } catch (_) { /* storage blocked */ }
    }

    function leaveBackgroundUpload(succeeded) {
        const wasBackground = state.background;
        state.background = false;
        window.removeEventListener('beforeunload', warnBeforeUnload);
        if (succeeded) clearPendingUpload();
        if (!wasBackground || modalRoot?.classList.contains('is-open')) return hideFloat();
        // 面板关着：结果显示在悬浮条上
        if (succeeded) showFloat({ text: '上传成功', progress: 100, kind: 'done', autoHide: 3000 });
        else showFloat({ text: state.statusText, kind: 'error', action: { label: '重试', onClick: () => pushToServer('fast') } });
    }

    let floatRoot = null;
    let floatTimer = null;
    function showFloat({ text, progress = null, kind = 'busy', action = null, autoHide = 0 }) {
        if (!floatRoot) {
            floatRoot = document.createElement('div');
            floatRoot.className = 'rp-sync-float';
            floatRoot.dataset.rphSyncFloat = '';
            floatRoot.innerHTML = '<button type="button" class="rp-sync-float__main" data-open></button>'
                + '<button type="button" class="rp-sync-float__action" data-act hidden></button>'
                + '<button type="button" class="rp-sync-float__close" data-close aria-label="关闭">×</button>'
                + '<span class="rp-sync-float__bar"></span>';
            floatRoot.querySelector('[data-open]').addEventListener('click', () => openModal());
            floatRoot.querySelector('[data-close]').addEventListener('click', () => {
                if (floatRoot.dataset.kind === 'resume') clearPendingUpload();
                hideFloat();
            });
            document.body.appendChild(floatRoot);
        }
        clearTimeout(floatTimer);
        floatRoot.hidden = false;
        floatRoot.dataset.kind = kind;
        floatRoot.querySelector('[data-open]').textContent = text;
        floatRoot.querySelector('.rp-sync-float__bar').style.width = progress === null ? '0' : `${progress}%`;
        const actionButton = floatRoot.querySelector('[data-act]');
        actionButton.hidden = !action;
        if (action) {
            actionButton.textContent = action.label;
            actionButton.onclick = () => {
                hideFloat();
                action.onClick();
            };
        }
        floatRoot.querySelector('[data-close]').hidden = kind === 'busy';
        if (autoHide) floatTimer = setTimeout(hideFloat, autoHide);
    }

    function hideFloat() {
        clearTimeout(floatTimer);
        if (floatRoot) floatRoot.hidden = true;
    }

    // 上次上传传到一半页面就关了：提示接着传（服务器已经有的分片不会再传）
    function offerResumeUpload() {
        let pending = null;
        try { pending = localStorage.getItem(PENDING_UPLOAD_KEY); } catch (_) { /* storage blocked */ }
        if (pending && !state.syncing) {
            showFloat({ text: '上次上传未完成', kind: 'resume', action: { label: '继续上传', onClick: () => pushToServer('fast') } });
        }
    }

    function mountSyncButton() {
        if (syncEntry) return;
        syncEntry = window.RPHubNavAdapter.registerEntry({
            id: 'sync', label: '同步', attributes: { 'data-rph-sync-entry': '' },
            iconPaths: ['M20 7h-9m9 0-3-3m3 3-3 3M4 17h9m-9 0 3 3m-3-3 3-3', 'M6 7a7 7 0 0112-2M18 17a7 7 0 01-12 2'],
            onClick: handleSyncButtonClick, waitForClose: true
        });
        updateButtonState();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ensureModal();
            mountSyncButton();
            offerResumeUpload();
            showRestoreNotice();
        }, { once: true });
    } else {
        ensureModal();
        mountSyncButton();
        offerResumeUpload();
        showRestoreNotice();
    }
    watchView('settings', decorateSettingsView);
    watchView('characters', decorateCharactersView);
})();
