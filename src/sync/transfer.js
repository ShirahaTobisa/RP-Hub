    async function downloadLegacyRemoteSnapshot(remote, allowVersionRetry = true) {
        if (!remote || !Number.isInteger(Number(remote.chunkCount)) || Number(remote.chunkCount) <= 0) {
            return null;
        }

        let payload;
        try {
            payload = await downloadLegacySnapshotJsonParts(remote);
        } catch (error) {
            if (allowVersionRetry && error.status === 409) {
                await wait(300);
                const retryResponse = await postSync({ action: 'pull-manifest' });
                const retryRemote = retryResponse.remote;
                if (retryRemote?.snapshotFormat && retryRemote.snapshotFormat !== LEGACY_SNAPSHOT_FORMAT) {
                    throw Object.assign(new Error('服务器同步版本已变化，请重新拉取。'), { status: 409 });
                }
                return downloadLegacyRemoteSnapshot(retryRemote, false);
            }
            throw error;
        }

        const json = payload;
        if (remote.checksum && await sha256(json) !== remote.checksum) {
            throw new Error('服务器数据整体校验失败。');
        }

        return {
            ...remote,
            json
        };
    }

    async function downloadLegacySnapshotJsonParts(remote) {
        const chunkCount = Number(remote.chunkCount || 0);
        if (!Number.isInteger(chunkCount) || chunkCount <= 0) {
            throw new Error('服务器数据格式不正确。');
        }

        const ranges = [];
        for (let start = 0; start < chunkCount; start += CONFIG.jsonDownloadPartChunks) {
            const count = Math.min(CONFIG.jsonDownloadPartChunks, chunkCount - start);
            ranges.push({ start, count });
        }

        const byteParts = new Array(ranges.length);
        let completed = 0;
        let cursor = 0;
        const workerCount = Math.min(CONFIG.downloadPartConcurrency, ranges.length);

        async function downloadNextRange() {
            while (cursor < ranges.length) {
                const rangeIndex = cursor;
                cursor += 1;
                const range = ranges[rangeIndex];
                const response = await postSyncBinary({
                    action: 'pull-json-part',
                    version: Number(remote.version),
                    start: range.start,
                    count: range.count
                }, { timeoutMs: transferTimeout(range.bytes) });
                if (!response.bytes || !(response.bytes instanceof Uint8Array)) {
                    throw new Error('服务器分批数据格式不正确。');
                }
                const bytes = response.bytes;
                const expectedBytes = Number(response.byteLength || 0);
                if (expectedBytes > 0 && bytes.byteLength !== expectedBytes) {
                    throw new Error('服务器分批数据大小不正确。');
                }
                byteParts[rangeIndex] = bytes;
                completed += 1;
                updateProgress(
                    15 + Math.round((completed / ranges.length) * 35),
                    `正在下载服务器数据 ${Math.round((completed / ranges.length) * 100)}%...`
                );
                await wait(0);
            }
        }

        await Promise.all(Array.from({ length: workerCount }, () => downloadNextRange()));
        updateProgress(52, '服务器数据下载完成，正在校验...');
        const totalBytes = byteParts.reduce((sum, part) => sum + part.byteLength, 0);
        const merged = new Uint8Array(totalBytes);
        let offset = 0;
        for (const part of byteParts) {
            merged.set(part, offset);
            offset += part.byteLength;
        }
        return new TextDecoder().decode(merged);
    }

    function normalizeRemoteChunkManifest(remote) {
        const chunkCount = Number(remote?.chunkCount || 0);
        const manifest = Array.isArray(remote?.chunkManifest) ? remote.chunkManifest : [];
        if (!Number.isInteger(chunkCount) || chunkCount <= 0 || manifest.length !== chunkCount) {
            throw new Error('服务器分片清单不完整。');
        }

        let totalBytes = 0;
        const normalized = manifest.map((chunk, index) => {
            const checksum = String(chunk?.checksum || '').toLowerCase();
            const length = Number(chunk?.length || chunk?.byteLength || 0);
            if (Number(chunk?.index) !== index || !/^[a-f0-9]{64}$/.test(checksum)) {
                throw new Error(`服务器第 ${index + 1} 个分片信息不正确。`);
            }
            if (!Number.isInteger(length) || length <= 0 || length > CDC_HARD_MAX_BYTES) {
                throw new Error(`服务器第 ${index + 1} 个分片大小不正确。`);
            }
            totalBytes += length;
            return { index, checksum, length };
        });

        if (totalBytes !== Number(remote.totalBytes)) {
            throw new Error('服务器分片总大小校验失败。');
        }
        return normalized;
    }

    async function validateStreamSnapshotManifest(remote) {
        if (remote?.snapshotFormat !== SNAPSHOT_FORMAT || !isStreamSchema(remote?.schemaVersion)) {
            throw new Error('服务器快照格式不受支持。');
        }
        if (Number(remote.schemaVersion) === GZIP_SCHEMA_VERSION && typeof DecompressionStream !== 'function') {
            throw new Error('这个浏览器版本太旧，读不了压缩的同步数据，请更新浏览器后再拉取。');
        }
        const recordCount = Number(remote.recordCount || 0);
        if (!Number.isInteger(recordCount) || recordCount < 0) {
            throw new Error('服务器快照记录数量不正确。');
        }
        const chunkManifest = normalizeRemoteChunkManifest(remote);
        const snapshot = {
            schemaVersion: Number(remote.schemaVersion),
            recordCount,
            totalBytes: Number(remote.totalBytes || 0),
            chunkManifest
        };
        const expectedChecksum = await sha256(buildStreamSnapshotChecksumSource(snapshot));
        if (expectedChecksum !== String(remote.checksum || '').toLowerCase()) {
            throw new Error('服务器快照清单校验失败。');
        }
        return chunkManifest;
    }

    function openDownloadStagingDb(name = DOWNLOAD_STAGING_DB) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(name, 1);
            request.onerror = () => reject(request.error || new Error('同步临时数据库打开失败。'));
            request.onupgradeneeded = () => {
                const stagingDb = request.result;
                if (!stagingDb.objectStoreNames.contains(DOWNLOAD_STAGING_STORE)) {
                    stagingDb.createObjectStore(DOWNLOAD_STAGING_STORE);
                }
            };
            request.onsuccess = () => resolve(request.result);
        }).catch(async (error) => {
            // 魔改版用同一个名字建过更高版本的临时库，里面只有它的临时数据：删掉重建。
            if (error?.name !== 'VersionError') throw error;
            await new Promise((resolve, reject) => {
                const request = indexedDB.deleteDatabase(name);
                request.onsuccess = resolve;
                request.onerror = () => reject(request.error);
            });
            return openDownloadStagingDb(name);
        });
    }

    function clearDownloadStagingStore(stagingDb) {
        return withStore(stagingDb, DOWNLOAD_STAGING_STORE, 'readwrite', store => { store.clear(); });
    }

    function writeDownloadStagingChunks(stagingDb, chunks) {
        return withStore(stagingDb, DOWNLOAD_STAGING_STORE, 'readwrite', store => {
            for (const chunk of chunks) store.put(chunk.bytes,
                stagingDb.name === DOWNLOAD_CACHE_DB ? chunkCacheKey(chunk) : chunk.index);
        });
    }

    function readDownloadStagingChunk(stagingDb, index) {
        return new Promise((resolve, reject) => {
            const tx = stagingDb.transaction([DOWNLOAD_STAGING_STORE], 'readonly');
            const request = tx.objectStore(DOWNLOAD_STAGING_STORE).get(index);
            request.onsuccess = () => {
                const value = request.result;
                if (value instanceof Uint8Array) {
                    resolve(value);
                } else if (value instanceof ArrayBuffer) {
                    resolve(new Uint8Array(value));
                } else {
                    reject(Object.assign(new Error(`同步临时分片 ${index} 不存在。`), { chunkUnavailable: true }));
                }
            };
            request.onerror = () => reject(request.error || new Error('同步临时数据读取失败。'));
        });
    }

    async function downloadSnapshotRange(remote, chunkManifest, start, count, options = {}) {
        const selected = chunkManifest.slice(start, start + count);
        const response = await postSyncBinary(remote.snapshotFormat === FORK_SNAPSHOT_FORMAT
            ? { action: 'fork-packs', checksums: selected.map((chunk) => chunk.checksum) }
            : { action: 'pull-json-part', version: Number(remote.version), start, count },
        { ...options, timeoutMs: transferTimeout(selected.reduce((sum, chunk) => sum + chunk.length, 0)) });
        const gzip = Number(remote.schemaVersion) === GZIP_SCHEMA_VERSION;
        const storedLengths = gzip ? String(response.partLengths || '').split(',').map(Number) : selected.map((chunk) => chunk.length);
        const expectedLength = storedLengths.reduce((sum, length) => sum + length, 0);
        if (!(response.bytes instanceof Uint8Array)
            || storedLengths.length !== selected.length
            || storedLengths.some((length) => !Number.isInteger(length) || length <= 0)
            || response.bytes.byteLength !== expectedLength
            || (Number(response.byteLength || 0) > 0 && Number(response.byteLength) !== expectedLength)) {
            throw new Error(`服务器第 ${start + 1}-${start + count} 个分片大小校验失败。`);
        }

        const chunks = [];
        let offset = 0;
        for (const [index, chunk] of selected.entries()) {
            const stored = response.bytes.slice(offset, offset + storedLengths[index]);
            offset += storedLengths[index];
            const bytes = gzip ? await gunzipBytes(stored).catch(() => null) : stored;
            if (!bytes || bytes.byteLength !== chunk.length || await sha256Bytes(bytes) !== chunk.checksum) {
                throw new Error(`服务器第 ${chunk.index + 1} 个分片内容校验失败。`);
            }
            chunks.push({ ...chunk, bytes });
        }
        return chunks;
    }

    function chunkCacheKey(chunk) {
        return `${chunk.checksum}:${chunk.length}`;
    }

    function retainedChunkKeys(chunkManifest, verified, budget = Infinity) {
        const keep = new Set();
        for (const chunk of chunkManifest) {
            const key = chunkCacheKey(chunk);
            if (keep.has(key) || (verified && !verified.has(key)) || chunk.length > budget) continue;
            keep.add(key);
            budget -= chunk.length;
        }
        return keep;
    }

    function pruneDownloadCache(db, keep) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(DOWNLOAD_STAGING_STORE, 'readwrite');
            const store = tx.objectStore(DOWNLOAD_STAGING_STORE);
            const present = new Set();
            const request = store.openKeyCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                if (keep.has(cursor.key)) present.add(cursor.key);
                else store.delete(cursor.key);
                cursor.continue();
            };
            tx.oncomplete = () => resolve(present);
            tx.onabort = () => reject(tx.error || new Error('同步缓存清理失败。'));
        });
    }

    function buildDownloadRanges(chunkManifest, present = new Set(), deduplicate = true) {
        const planned = new Set(present);
        const ranges = [];
        let range = null;
        for (const chunk of chunkManifest) {
            const key = chunkCacheKey(chunk);
            if (deduplicate && planned.has(key)) { range = null; continue; }
            if (deduplicate) planned.add(key);
            if (!range || range.count >= CONFIG.jsonDownloadPartChunks
                || range.bytes + chunk.length > CONFIG.downloadRangeBytes) {
                range = { start: chunk.index, count: 0, bytes: 0 };
                ranges.push(range);
            }
            range.count += 1;
            range.bytes += chunk.length;
        }
        return ranges;
    }

    async function downloadSnapshotToStaging(remote, chunkManifest, stagingDb, options = {}) {
        const cached = stagingDb.name === DOWNLOAD_CACHE_DB;
        if (!cached) await clearDownloadStagingStore(stagingDb);
        // The legacy staging store addresses by index, including duplicate contents.
        const ranges = buildDownloadRanges(chunkManifest, options.present, cached);
        const totalChunks = ranges.reduce((sum, range) => sum + range.count, 0);
        const active = new Set();
        const concurrency = options.concurrency || CONFIG.downloadTaskConcurrency;
        let next = 0;
        let pendingBytes = 0;
        let completedChunks = 0;
        let failure = null;
        while ((!failure && next < ranges.length) || active.size) {
            while (!failure && next < ranges.length && active.size < concurrency) {
                const range = ranges[next];
                const oversized = range.bytes > CONFIG.downloadRangeBytes;
                if (active.size && (oversized || pendingBytes > CONFIG.downloadRangeBytes
                    || pendingBytes + range.bytes > CONFIG.downloadPendingBytes)) break;
                next += 1;
                pendingBytes += range.bytes;
                const task = Promise.resolve().then(async () => {
                    const chunks = await downloadSnapshotRange(remote, chunkManifest, range.start, range.count,
                        { shouldStop: () => Boolean(failure) });
                    await writeDownloadStagingChunks(stagingDb, chunks);
                    for (const chunk of chunks) options.verified?.add(chunkCacheKey(chunk));
                    completedChunks += chunks.length;
                    const percent = Math.round(completedChunks / Math.max(1, totalChunks) * 100);
                    updateProgress(percent, `正在拉取服务器分片 ${percent}%...`);
                }).catch((error) => { failure ||= error; }).finally(() => {
                    pendingBytes -= range.bytes;
                    active.delete(task);
                });
                active.add(task);
                if (oversized) break;
            }
            if (active.size) await Promise.race(active);
        }
        if (failure) throw failure;
    }

    async function* iterateStagedSnapshotChunks(stagingDb, chunkManifest, verifyChecksum = true, options = {}) {
        const readChunk = async (chunk) => {
            const key = chunkCacheKey(chunk);
            const readAndCheck = async () => {
                const bytes = await readDownloadStagingChunk(stagingDb,
                    stagingDb.name === DOWNLOAD_CACHE_DB ? key : chunk.index);
                if (bytes.byteLength !== chunk.length
                    || (verifyChecksum && await sha256Bytes(bytes) !== chunk.checksum)) {
                    throw Object.assign(new Error(`同步临时分片 ${chunk.index + 1} 校验失败。`), { chunkUnavailable: true });
                }
                return bytes;
            };
            let bytes;
            try { bytes = await readAndCheck(); }
            catch (error) {
                options.verified?.delete(key);
                if (!verifyChecksum || !error.chunkUnavailable || !options.repair) throw error;
                await options.repair(chunk);
                try { bytes = await readAndCheck(); }
                catch (repairError) { options.verified?.delete(key); throw repairError; }
            }
            if (verifyChecksum) options.verified?.add(key);
            return bytes;
        };
        let pending = null;
        const preload = (chunk) => {
            const task = readChunk(chunk);
            task.catch(() => {}); // The consumer may fail before requesting the prefetched chunk.
            return task;
        };
        try {
            // Keep at most the current and next raw chunks (each capped at 8 MiB).
            if (chunkManifest.length) pending = preload(chunkManifest[0]);
            for (let index = 0; index < chunkManifest.length; index += 1) {
                const bytes = await pending;
                pending = index + 1 < chunkManifest.length ? preload(chunkManifest[index + 1]) : null;
                yield bytes;
            }
        } finally {
            // A repair/write must finish before the caller closes or prunes the cache.
            if (pending) await pending.catch(() => {});
        }
    }

    class SnapshotLineReader {
        constructor(onLine) {
            this.onLine = onLine;
            this.pendingParts = [];
        }

        async push(text) {
            let start = 0;
            while (true) {
                const newlineIndex = text.indexOf('\n', start);
                if (newlineIndex === -1) break;
                const segment = text.slice(start, newlineIndex);
                let line;
                if (this.pendingParts.length > 0) {
                    this.pendingParts.push(segment);
                    line = this.pendingParts.join('');
                    this.pendingParts = [];
                } else {
                    line = segment;
                }
                if (line.endsWith('\r')) line = line.slice(0, -1);
                if (line) {
                    const pending = this.onLine(line);
                    if (pending) await pending;
                }
                start = newlineIndex + 1;
            }
            if (start < text.length) this.pendingParts.push(text.slice(start));
        }

        async finish() {
            if (this.pendingParts.length === 0) return;
            let line = this.pendingParts.join('');
            this.pendingParts = [];
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line) await this.onLine(line);
        }
    }

    function normalizeLegacyCharacterForStream(character, index, seen, assignMissingUuid) {
        if (!character || typeof character !== 'object' || Array.isArray(character)) {
            throw new TypeError(`旧快照第 ${index + 1} 张角色卡格式无效，已取消恢复。`);
        }
        const rawUuid = character.uuid;
        let uuid = rawUuid;
        if (rawUuid === undefined || rawUuid === null || rawUuid === '') {
            if (!assignMissingUuid) return null;
            uuid = crypto.randomUUID();
            character.uuid = uuid;
        } else if (typeof rawUuid !== 'string') {
            throw new TypeError(`旧快照第 ${index + 1} 张角色卡 UUID 不是字符串，已取消恢复。`);
        }
        if (uuid === 'index') {
            throw new Error('旧快照角色卡 UUID index 与角色卡索引键冲突，已取消恢复。');
        }
        if (seen.has(uuid)) {
            throw new Error(`旧快照角色卡 UUID 重复：${uuid}。为避免合并存档，已取消恢复。`);
        }
        seen.add(uuid);
        return uuid;
    }

    function isLegacyCharacterArrayLine(databaseName, storeName, key) {
        return databaseName === 'RPHubDB'
            && storeName === 'store'
            && key === 'rp_hub_characters';
    }

    class StreamSnapshotRestorer {
        constructor(expectedRecordCount) {
            this.expectedRecordCount = Number(expectedRecordCount || 0);
            this.recordCount = 0;
            this.snapshotStarted = false;
            this.snapshotEnded = false;
            this.localStorageEnded = false;
            this.localStorageKeys = new Set();
            this.seenDatabases = new Set();
            this.currentDatabase = null;
        }

        consume(lineText) {
            let line;
            try {
                line = JSON.parse(lineText);
            } catch (_) {
                throw new Error('服务器快照记录格式不正确。');
            }

            switch (line?.type) {
                case 'snapshot':
                    this.startSnapshot(line);
                    break;
                case 'localStorage':
                    this.restoreLocalStorageEntry(line);
                    break;
                case 'localStorageEnd':
                    this.finishLocalStorage();
                    break;
                case 'database':
                    return this.startDatabase(line);
                case 'record':
                    return this.restoreRecord(line);
                case 'recordArrayStart':
                    this.startArrayRecord(line);
                    break;
                case 'recordArrayItem':
                    return this.restoreArrayRecordItem(line);
                case 'recordArrayEnd':
                    return this.finishArrayRecord(line);
                case 'storeEnd':
                    return this.finishStore(line);
                case 'databaseEnd':
                    return this.finishDatabase(line);
                case 'snapshotEnd':
                    return this.finishSnapshot(line);
                default:
                    throw new Error('服务器快照包含未知记录。');
            }
        }

        startSnapshot(line) {
            if (this.snapshotStarted
                || line.format !== SNAPSHOT_FORMAT
                || !isStreamSchema(line.schemaVersion)) {
                throw new Error('服务器快照头信息不正确。');
            }
            this.snapshotStarted = true;
            this.workshopVersion = line.workshopVersion;
        }

        restoreLocalStorageEntry(line) {
            if (!this.snapshotStarted || this.localStorageEnded || this.currentDatabase || typeof line.key !== 'string') {
                throw new Error('服务器本地设置记录顺序不正确。');
            }
            if (!isAppLocalStorageKey(line.key)) throw new Error('服务器包含无效的本地设置。');
            localStorage.setItem(line.key, String(line.value ?? ''));
            this.localStorageKeys.add(line.key);
            this.recordCount += 1;
        }

        finishLocalStorage() {
            if (!this.snapshotStarted || this.localStorageEnded || this.currentDatabase) {
                throw new Error('服务器本地设置结束标记不正确。');
            }
            for (const entry of readLocalStorageSnapshot()) {
                if (this.workshopVersion !== 1 && isWorkshopLocalStorageKey(entry.key)) continue;
                if (!this.localStorageKeys.has(entry.key)) localStorage.removeItem(entry.key);
            }
            this.localStorageEnded = true;
        }

        async startDatabase(line) {
            if (!this.localStorageEnded || this.currentDatabase || typeof line.name !== 'string') {
                throw new Error('服务器数据库记录顺序不正确。');
            }

            const knownDb = CONFIG.knownDatabases.find((dbDef) => dbDef.name === line.name);
            if (!knownDb) {
                this.currentDatabase = { name: line.name, ignored: true, arrayRecord: null };
                return;
            }

            const seenStoreNames = new Set();
            const stores = (Array.isArray(line.stores) ? line.stores : []).filter((storeDef) => {
                if (!storeDef || !knownDb.stores.includes(storeDef.name) || seenStoreNames.has(storeDef.name)) return false;
                seenStoreNames.add(storeDef.name);
                return true;
            }).map((storeDef) => ({
                name: storeDef.name,
                keyPath: storeDef.keyPath,
                autoIncrement: Boolean(storeDef.autoIncrement)
            }));

            const db = stores.length > 0 ? await openDbForRestore({ name: line.name, stores }) : null;
            this.currentDatabase = {
                name: line.name,
                db,
                knownDb,
                stores: new Map(stores.map((storeDef) => [storeDef.name, {
                    definition: storeDef,
                    incomingKeys: new Set(),
                    batch: [],
                    arrayRecord: null,
                    finished: false
                }]))
            };
            this.seenDatabases.add(line.name);
        }

        getStoreState(line) {
            const current = this.currentDatabase;
            if (!current || line.database !== current.name || typeof line.store !== 'string') {
                throw new Error('服务器数据库记录归属不正确。');
            }
            if (current.ignored) return null;
            const storeState = current.stores.get(line.store);
            if (!storeState || storeState.finished) throw new Error('服务器对象存储记录顺序不正确。');
            return storeState;
        }

        queueStoreRecord(storeState, record, countRecord = true) {
            storeState.incomingKeys.add(stableKeyToken(record.key));
            storeState.batch.push(record);
            if (countRecord) this.recordCount += 1;
            if (storeState.batch.length >= CONFIG.restoreBatchSize) return this.flushStore(storeState);
        }

        async restoreRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) {
                this.recordCount += 1;
                return;
            }
            if (storeState.arrayRecord) throw new Error('服务器数组记录尚未结束。');
            const record = {
                key: line.key,
                value: Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : undefined
            };
            const expanded = expandLegacyCharacterRecord(this.currentDatabase.name, line.store, record);
            if (expanded.length === 1 && expanded[0] === record) {
                await this.queueStoreRecord(storeState, record);
                return;
            }
            for (const item of expanded) await this.queueStoreRecord(storeState, item, false);
            this.recordCount += 1;
        }

        startArrayRecord(line) {
            const storeState = this.getStoreState(line);
            const length = Number(line.length);
            if (!Number.isInteger(length) || length < 0) {
                throw new Error('服务器数组记录头信息不正确。');
            }
            if (!storeState) {
                if (this.currentDatabase.arrayRecord) throw new Error('服务器数组记录头信息不正确。');
                this.currentDatabase.arrayRecord = { expectedLength: length, nextIndex: 0 };
                return;
            }
            if (storeState.arrayRecord) throw new Error('服务器数组记录头信息不正确。');
            const splitLegacyCharacters = isLegacyCharacterArrayLine(
                this.currentDatabase.name,
                line.store,
                line.key
            );
            storeState.arrayRecord = {
                key: line.key,
                value: splitLegacyCharacters ? null : [],
                expectedLength: length,
                nextIndex: 0,
                splitLegacyCharacters,
                order: splitLegacyCharacters ? [] : null,
                seen: splitLegacyCharacters ? new Set() : null
            };
        }

        restoreArrayRecordItem(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) {
                const arrayRecord = this.currentDatabase.arrayRecord;
                if (!arrayRecord || Number(line.index) !== arrayRecord.nextIndex) {
                    throw new Error('服务器数组记录顺序不正确。');
                }
                arrayRecord.nextIndex += 1;
                return;
            }
            const arrayRecord = storeState.arrayRecord;
            if (!arrayRecord || Number(line.index) !== arrayRecord.nextIndex) {
                throw new Error('服务器数组记录顺序不正确。');
            }
            const value = Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : null;
            let pending;
            if (arrayRecord.splitLegacyCharacters) {
                const uuid = normalizeLegacyCharacterForStream(
                    value,
                    arrayRecord.nextIndex,
                    arrayRecord.seen,
                    true
                );
                arrayRecord.order.push(uuid);
                pending = this.queueStoreRecord(storeState, {
                    key: `rp_hub_character_${uuid}`,
                    value
                }, false);
            } else {
                arrayRecord.value.push(value);
            }
            arrayRecord.nextIndex += 1;
            return pending;
        }

        async finishArrayRecord(line) {
            const storeState = this.getStoreState(line);
            if (!storeState) {
                const arrayRecord = this.currentDatabase.arrayRecord;
                if (!arrayRecord || arrayRecord.nextIndex !== arrayRecord.expectedLength) {
                    throw new Error('服务器数组记录数据不完整。');
                }
                this.currentDatabase.arrayRecord = null;
                this.recordCount += 1;
                return;
            }
            const arrayRecord = storeState.arrayRecord;
            if (!arrayRecord || arrayRecord.nextIndex !== arrayRecord.expectedLength) {
                throw new Error('服务器数组记录数据不完整。');
            }
            storeState.arrayRecord = null;
            if (arrayRecord.splitLegacyCharacters) {
                await this.queueStoreRecord(storeState, {
                    key: 'rp_hub_character_index',
                    value: { order: arrayRecord.order }
                }, false);
                this.recordCount += 1;
            } else {
                await this.queueStoreRecord(storeState, {
                    key: arrayRecord.key,
                    value: arrayRecord.value
                });
            }
            await this.flushStore(storeState);
        }

        async flushStore(storeState) {
            if (storeState.batch.length === 0) return;
            const batch = storeState.batch;
            storeState.batch = [];
            await writeObjectStoreRecordBatch(this.currentDatabase.db, storeState.definition, batch);
            await wait(0);
        }

        async finishStore(line) {
            const current = this.currentDatabase;
            if (!current || line.database !== current.name || typeof line.store !== 'string') {
                throw new Error('服务器对象存储结束标记不正确。');
            }
            if (current.ignored) {
                if (current.arrayRecord) throw new Error('服务器数组记录尚未结束。');
                return;
            }
            const storeState = current.stores.get(line.store);
            if (!storeState || storeState.finished) throw new Error('服务器对象存储结束顺序不正确。');
            if (storeState.arrayRecord) throw new Error('服务器数组记录尚未结束。');
            await this.flushStore(storeState);
            await deleteMissingObjectStoreRecords(current.db, line.store, storeState.incomingKeys);
            storeState.incomingKeys.clear();
            storeState.finished = true;
        }

        async finishDatabase(line) {
            const current = this.currentDatabase;
            if (!current || line.name !== current.name) throw new Error('服务器数据库结束标记不正确。');
            if (!current.ignored) {
                if ([...current.stores.values()].some((storeState) => !storeState.finished)) {
                    throw new Error('服务器对象存储数据不完整。');
                }
                if (current.db) current.db.close();
                const missingStores = current.knownDb.stores.filter((storeName) => !current.stores.has(storeName));
                if (missingStores.length > 0) await clearKnownIndexedDbStores(current.knownDb, missingStores);
            }
            this.currentDatabase = null;
        }

        async finishSnapshot(line) {
            if (!this.snapshotStarted || this.snapshotEnded || !this.localStorageEnded || this.currentDatabase) {
                throw new Error('服务器快照结束标记不正确。');
            }
            if (Number(line.recordCount) !== this.recordCount || this.recordCount !== this.expectedRecordCount) {
                throw new Error('服务器快照记录数量校验失败。');
            }
            for (const knownDb of CONFIG.knownDatabases) {
                if (knownDb.workshop && this.workshopVersion !== 1) continue;
                if (!this.seenDatabases.has(knownDb.name)) {
                    await clearKnownIndexedDbStores(knownDb, knownDb.stores);
                }
            }
            this.snapshotEnded = true;
        }

        finish() {
            if (!this.snapshotEnded) throw new Error('服务器快照数据不完整。');
        }

        abort() {
            if (this.currentDatabase?.db) this.currentDatabase.db.close();
            this.currentDatabase = null;
        }
    }

    class StreamSnapshotValidator {
        constructor(expectedRecordCount) {
            this.expectedRecordCount = Number(expectedRecordCount || 0);
            this.recordCount = 0;
            this.snapshotStarted = false;
            this.snapshotEnded = false;
            this.localStorageEnded = false;
            this.currentDatabase = null;
            this.currentStore = null;
            this.arrayRecord = null;
        }

        consume(lineText) {
            let line;
            try {
                line = JSON.parse(lineText);
            } catch (_) {
                throw new Error('服务器快照记录格式不正确。');
            }

            switch (line?.type) {
                case 'snapshot':
                    if (this.snapshotStarted
                        || line.format !== SNAPSHOT_FORMAT
                        || !isStreamSchema(line.schemaVersion)
                        || (line.workshopVersion !== undefined && line.workshopVersion !== 1)) {
                        throw new Error('服务器快照头信息不正确。');
                    }
                    this.snapshotStarted = true;
                    break;
                case 'localStorage':
                    if (!this.snapshotStarted
                        || this.localStorageEnded
                        || this.currentDatabase
                        || typeof line.key !== 'string'
                        || !isAppLocalStorageKey(line.key)) {
                        throw new Error('服务器本地设置记录顺序不正确。');
                    }
                    this.recordCount += 1;
                    break;
                case 'localStorageEnd':
                    if (!this.snapshotStarted || this.localStorageEnded || this.currentDatabase) {
                        throw new Error('服务器本地设置结束标记不正确。');
                    }
                    this.localStorageEnded = true;
                    break;
                case 'database': {
                    if (!this.localStorageEnded
                        || this.currentDatabase
                        || typeof line.name !== 'string'
                        || !Array.isArray(line.stores)) {
                        throw new Error('服务器数据库记录顺序不正确。');
                    }
                    const storeNames = line.stores.map((store) => store?.name);
                    if (storeNames.some((name) => typeof name !== 'string')
                        || new Set(storeNames).size !== storeNames.length) {
                        throw new Error('服务器对象存储定义不正确。');
                    }
                    this.currentDatabase = {
                        name: line.name,
                        stores: new Set(storeNames),
                        finishedStores: new Set()
                    };
                    break;
                }
                case 'record':
                    this.validateStoreLine(line);
                    if (this.arrayRecord) throw new Error('服务器数组记录尚未结束。');
                    if (isLegacyCharacterArrayLine(this.currentDatabase.name, line.store, line.key)) {
                        if (!Array.isArray(line.value)) throw new Error('旧快照角色卡记录格式无效。');
                        const seen = new Set();
                        line.value.forEach((character, index) => {
                            normalizeLegacyCharacterForStream(character, index, seen, false);
                        });
                    }
                    this.recordCount += 1;
                    break;
                case 'recordArrayStart': {
                    this.validateStoreLine(line);
                    const length = Number(line.length);
                    if (this.arrayRecord || !Number.isInteger(length) || length < 0) {
                        throw new Error('服务器数组记录头信息不正确。');
                    }
                    this.arrayRecord = {
                        length,
                        nextIndex: 0,
                        splitLegacyCharacters: isLegacyCharacterArrayLine(
                            this.currentDatabase.name,
                            line.store,
                            line.key
                        ),
                        seen: new Set()
                    };
                    break;
                }
                case 'recordArrayItem':
                    this.validateStoreLine(line);
                    if (!this.arrayRecord || Number(line.index) !== this.arrayRecord.nextIndex) {
                        throw new Error('服务器数组记录顺序不正确。');
                    }
                    if (this.arrayRecord.splitLegacyCharacters) {
                        normalizeLegacyCharacterForStream(
                            Object.prototype.hasOwnProperty.call(line, 'value') ? line.value : null,
                            this.arrayRecord.nextIndex,
                            this.arrayRecord.seen,
                            false
                        );
                    }
                    this.arrayRecord.nextIndex += 1;
                    break;
                case 'recordArrayEnd':
                    this.validateStoreLine(line);
                    if (!this.arrayRecord || this.arrayRecord.nextIndex !== this.arrayRecord.length) {
                        throw new Error('服务器数组记录数据不完整。');
                    }
                    this.arrayRecord = null;
                    this.recordCount += 1;
                    break;
                case 'storeEnd':
                    this.validateStoreLine(line);
                    if (this.arrayRecord) throw new Error('服务器数组记录尚未结束。');
                    this.currentDatabase.finishedStores.add(line.store);
                    this.currentStore = null;
                    break;
                case 'databaseEnd':
                    if (!this.currentDatabase
                        || line.name !== this.currentDatabase.name
                        || this.currentStore
                        || this.arrayRecord
                        || this.currentDatabase.finishedStores.size !== this.currentDatabase.stores.size) {
                        throw new Error('服务器数据库结束标记不正确。');
                    }
                    this.currentDatabase = null;
                    break;
                case 'snapshotEnd':
                    if (!this.snapshotStarted
                        || this.snapshotEnded
                        || !this.localStorageEnded
                        || this.currentDatabase
                        || Number(line.recordCount) !== this.recordCount
                        || this.recordCount !== this.expectedRecordCount) {
                        throw new Error('服务器快照记录数量校验失败。');
                    }
                    this.snapshotEnded = true;
                    break;
                default:
                    throw new Error('服务器快照包含未知记录。');
            }
        }

        validateStoreLine(line) {
            if (!this.currentDatabase
                || line.database !== this.currentDatabase.name
                || typeof line.store !== 'string'
                || !this.currentDatabase.stores.has(line.store)
                || this.currentDatabase.finishedStores.has(line.store)) {
                throw new Error('服务器数据库记录归属不正确。');
            }
            if (this.currentStore && this.currentStore !== line.store) {
                throw new Error('服务器对象存储记录顺序不正确。');
            }
            if (!this.currentStore) this.currentStore = line.store;
        }

        finish() {
            if (!this.snapshotEnded) throw new Error('服务器快照数据不完整。');
        }
    }

    async function parseStagedStreamSnapshot(stagingDb, chunkManifest, consumer, options = {}) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const lineReader = new SnapshotLineReader((line) => consumer.consume(line));
        let completed = 0;
        for await (const bytes of iterateStagedSnapshotChunks(
            stagingDb,
            chunkManifest,
            options.verifyChecksum !== false,
            options
        )) {
            await lineReader.push(decoder.decode(bytes, { stream: true }));
            completed += 1;
            if (typeof options.onProgress === 'function') {
                options.onProgress(completed, chunkManifest.length);
            }
        }
        await lineReader.push(decoder.decode());
        await lineReader.finish();
        await consumer.finish();
    }

    // 魔改版的清单：根清单 → 分页（每页最多 32 个数据包，校验码逐页串起来）→ 按内容 SHA-256 存放的数据包。
