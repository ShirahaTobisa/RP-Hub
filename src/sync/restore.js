    async function restoreStreamSnapshot(remote, onRestoreStart) {
        const fork = remote.snapshotFormat === FORK_SNAPSHOT_FORMAT;
        const chunkManifest = fork ? await readForkPackList(remote) : await validateStreamSnapshotManifest(remote);
        const presets = fork ? await readLocalPresets() : undefined;
        const lines = (consumer) => (fork ? new ForkSnapshotLines(consumer, presets) : consumer);
        let useCache = state.syncLockHeld;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            let stagingDb;
            try { stagingDb = await openDownloadStagingDb(useCache ? DOWNLOAD_CACHE_DB : DOWNLOAD_STAGING_DB); }
            catch (error) {
                if (!useCache) throw error;
                console.warn('[RP Sync] 缓存库不可用，使用临时存储。', error);
                useCache = false;
                stagingDb = await openDownloadStagingDb();
            }
            const verified = new Set();
            let restoreStarted = false;
            let retryTemporary = false;
            try {
                const present = useCache
                    ? await pruneDownloadCache(stagingDb, retainedChunkKeys(chunkManifest)) : new Set();
                await downloadSnapshotToStaging(remote, chunkManifest, stagingDb, {
                    present, verified, concurrency: useCache ? CONFIG.downloadTaskConcurrency : 1
                });
                updateProgress(0, '服务器分片拉取完成，正在完整校验...');
                const repaired = new Set();
                const repair = useCache ? async (chunk) => {
                    const key = chunkCacheKey(chunk);
                    if (repaired.has(key)) throw new Error(`缓存分片 ${chunk.index + 1} 修复失败。`);
                    repaired.add(key);
                    verified.delete(key);
                    const keep = retainedChunkKeys(chunkManifest);
                    keep.delete(key);
                    await pruneDownloadCache(stagingDb, keep);
                    await downloadSnapshotToStaging(remote, chunkManifest, stagingDb, { present: keep, verified });
                } : null;
                await parseStagedStreamSnapshot(stagingDb, chunkManifest, lines(new StreamSnapshotValidator(remote.recordCount)), {
                    repair, verified,
                    onProgress: (completed, total) => {
                        const percent = Math.round((completed / total) * 100);
                        updateProgress(percent, `正在校验服务器分片 ${percent}%...`);
                    }
                });
                updateProgress(100, '本地分片校验完成，正在确认服务器版本...');
                const confirmation = await postSync({ action: 'pull-manifest' });
                const current = fork ? confirmation.fork : confirmation.remote;
                if (!current
                    || Number(current.version) !== Number(remote.version)
                    || current.checksum !== remote.checksum) {
                    throw Object.assign(new Error('服务器同步版本已变化，请重新拉取。'), { status: 409 });
                }
                updateProgress(0, '服务器数据校验完成，正在恢复本地数据...');
                restoreStarted = true;
                if (typeof onRestoreStart === 'function') onRestoreStart();
                const restorer = new StreamSnapshotRestorer(remote.recordCount);
                try {
                    await parseStagedStreamSnapshot(stagingDb, chunkManifest, lines(restorer), {
                        verifyChecksum: false,
                        onProgress: (completed, total) => {
                            const percent = Math.round((completed / total) * 100);
                            updateProgress(percent, `正在恢复本地数据 ${percent}%...`);
                        }
                    });
                } catch (error) { restorer.abort(); throw error; }
                return;
            } catch (error) {
                retryTemporary = useCache && !restoreStarted && error?.name === 'QuotaExceededError' && attempt === 0;
                if (!retryTemporary) throw error;
                // All scheduler tasks and aborted write transactions have settled here.
                await clearDownloadStagingStore(stagingDb);
                console.warn('[RP Sync] 缓存空间不足，重试一次临时存储。');
            } finally {
                try {
                    if (useCache) await pruneDownloadCache(stagingDb,
                        retainedChunkKeys(chunkManifest, verified, CONFIG.downloadCacheBytes));
                    else await clearDownloadStagingStore(stagingDb);
                } catch (error) { console.warn('[RP Sync] 同步暂存清理失败。', error); }
                stagingDb.close();
            }
            if (retryTemporary) useCache = false;
        }
    }

    function runSyncLocked(operation) {
        if (state.syncing || state.reloadPending) return Promise.resolve();
        if (!navigator.locks?.request) return operation();
        return new Promise((resolve, reject) => {
            navigator.locks.request('RPHubSync', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
                if (!lock) {
                    updateProgress(100, '另一页面正在同步，请稍后重试。');
                    return;
                }
                if (state.syncing || state.reloadPending) return;
                state.syncLockHeld = true;
                try {
                    const result = await operation();
                    if (state.reloadPending) {
                        resolve(result);
                        await new Promise((release) => window.addEventListener('pagehide', release, { once: true }));
                    }
                    return result;
                } finally { state.syncLockHeld = false; }
            }).then(resolve, reject);
        });
    }

