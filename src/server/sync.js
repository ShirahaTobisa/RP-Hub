function createChunkKey(checksum, encoding = 'raw-bytes') {
    return `${CHUNK_PREFIX}/${String(checksum || '').toLowerCase()}.${encoding === 'gzip' ? 'gz' : 'bin'}`;
}

async function readR2JsonObject(bucket, key) {
    const object = await bucket.get(key);
    if (!object) return { object: null, value: null };
    try {
        return {
            object,
            value: JSON.parse(await object.text())
        };
    } catch (err) {
        throw new Error('R2 JSON 数据已损坏。');
    }
}

async function readR2Json(bucket, key) {
    return (await readR2JsonObject(bucket, key)).value;
}

function buildEmptyRemoteInfo(checksum, recordCount, totalBytes, metadata = {}) {
    return {
        version: 0,
        checksum,
        updatedAt: 0,
        recordCount,
        totalBytes,
        chunkCount: 0,
        chunkSize: 0,
        ...metadata
    };
}

function normalizeSnapshotFormat(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === STREAM_SNAPSHOT_FORMAT || value === LEGACY_SNAPSHOT_FORMAT) return value;
    return null;
}

function normalizeSnapshotMetadata(value) {
    if (!value || typeof value !== 'object') return null;
    const snapshotFormat = normalizeSnapshotFormat(value.snapshotFormat);
    const hasSchemaVersion = value.schemaVersion !== undefined
        && value.schemaVersion !== null
        && value.schemaVersion !== '';
    const schemaVersion = hasSchemaVersion ? Number(value.schemaVersion) : undefined;
    const hasChunkerProfile = Object.prototype.hasOwnProperty.call(value, 'chunkerProfile');
    if (snapshotFormat === null
        || (hasSchemaVersion && (!Number.isInteger(schemaVersion) || ![3, ...STREAM_SCHEMA_VERSIONS].includes(schemaVersion)))
        || (hasChunkerProfile && typeof value.chunkerProfile !== 'string')
        || Number(value.schemaVersion) === 5
        || value.snapshotFormat === 'rp-sync-jsonl-v2') return null;
    if (snapshotFormat === STREAM_SNAPSHOT_FORMAT
        && (!hasSchemaVersion || !STREAM_SCHEMA_VERSIONS.includes(schemaVersion))) return null;
    if (snapshotFormat === LEGACY_SNAPSHOT_FORMAT
        && hasSchemaVersion
        && schemaVersion !== 3) return null;
    if (snapshotFormat === undefined
        && hasSchemaVersion
        && schemaVersion !== 3) return null;

    const metadata = {};
    if (snapshotFormat !== undefined) metadata.snapshotFormat = snapshotFormat;
    if (hasSchemaVersion) metadata.schemaVersion = schemaVersion;
    if (hasChunkerProfile) metadata.chunkerProfile = value.chunkerProfile;
    return metadata;
}

function normalizeChunkManifest(manifest, totalBytes, encoding = 'raw-bytes') {
    if (!Array.isArray(manifest) || manifest.length === 0 || manifest.length > MAX_CHUNK_COUNT) return null;

    let byteOffset = 0;
    const normalized = manifest.map((item, index) => {
        const chunkIndex = Number(item?.index);
        const checksum = typeof item?.checksum === 'string' ? item.checksum : '';
        const length = Number(item?.length);
        const key = typeof item?.key === 'string' ? item.key : createChunkKey(checksum, encoding);

        if (!Number.isInteger(chunkIndex) || chunkIndex !== index) throw new Error(`分片顺序异常：第 ${index} 片。`);
        if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error(`分片校验码异常：第 ${index} 片。`);
        if (!Number.isInteger(length) || length <= 0 || length > MAX_PART_BYTES) throw new Error(`分片大小异常：第 ${index} 片。`);
        if (key !== createChunkKey(checksum, encoding)) throw new Error(`分片存储路径异常：第 ${index} 片。`);

        const nextItem = {
            index,
            checksum: checksum.toLowerCase(),
            length,
            byteOffset,
            byteLength: length,
            key,
            encoding
        };
        byteOffset += length;
        return nextItem;
    });

    if (byteOffset !== totalBytes) throw new Error('分片大小合计不一致。');
    return normalized;
}

function normalizeManifest(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.mode && value.mode !== 'r2-chunk-manifest-v1') return null;
    const snapshotMetadata = normalizeSnapshotMetadata(value);
    if (!snapshotMetadata) return null;
    const version = Number(value.version || 0);
    const recordCount = value.recordCount;
    const chunkCount = Number(value.chunkCount);
    const totalBytes = Number(value.totalBytes);
    const chunkManifest = Array.isArray(value.chunkManifest) ? value.chunkManifest : [];
    if (!Number.isInteger(version) || version < 0) return null;
    if (!Number.isInteger(recordCount) || recordCount < 0) return null;
    if (!Number.isInteger(chunkCount) || chunkCount < 0 || chunkCount > MAX_CHUNK_COUNT) return null;
    if (!Number.isInteger(totalBytes) || totalBytes < 0) return null;
    if (typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(value.checksum)) return null;
    if (chunkCount === 0) {
        return {
            version,
            checksum: value.checksum.toLowerCase(),
            updatedAt: Number(value.updatedAt || 0),
            recordCount,
            totalBytes,
            chunkCount: 0,
            chunkSize: Number(value.chunkSize || 0),
            chunkManifest: [],
            mode: 'r2-chunk-manifest-v1',
            ...snapshotMetadata
        };
    }
    if (chunkManifest.length !== chunkCount) return null;
    let normalizedChunks;
    try {
        normalizedChunks = normalizeChunkManifest(chunkManifest, totalBytes, chunkEncodingForSchema(snapshotMetadata.schemaVersion));
    } catch (err) {
        return null;
    }
    if (!normalizedChunks || normalizedChunks.length !== chunkCount) return null;

    return {
        version,
        checksum: value.checksum.toLowerCase(),
        updatedAt: Number(value.updatedAt || 0),
        recordCount,
        totalBytes,
        chunkCount,
        chunkSize: Number(value.chunkSize || 0),
        chunkManifest: normalizedChunks,
        mode: 'r2-chunk-manifest-v1',
        ...snapshotMetadata
    };
}

function getChunkLength(chunk) {
    return Number(chunk?.byteLength || chunk?.length || 0);
}

function isSameChunk(left, right) {
    return Boolean(left && right)
        && String(left.checksum || '').toLowerCase() === String(right.checksum || '').toLowerCase()
        && getChunkLength(left) === getChunkLength(right)
        && (left.encoding || 'raw-bytes') === (right.encoding || 'raw-bytes');
}

function chunkSignature(chunk) {
    const checksum = String(chunk?.checksum || '').toLowerCase();
    const length = getChunkLength(chunk);
    return `${checksum}:${length}:${chunk?.encoding || 'raw-bytes'}`;
}

function buildChunkLookup(manifest) {
    const lookup = new Map();
    for (const chunk of Array.isArray(manifest?.chunkManifest) ? manifest.chunkManifest : []) {
        if (chunk?.checksum) {
            lookup.set(chunkSignature(chunk), chunk);
        }
    }
    return lookup;
}

async function getManifestState(bucket) {
    const state = await readR2JsonObject(bucket, MANIFEST_KEY);
    return {
        manifest: normalizeManifest(state.value),
        rawManifest: state.value,
        object: state.object,
        etag: typeof state.object?.etag === 'string' ? state.object.etag : '',
        httpEtag: typeof state.object?.httpEtag === 'string' ? state.object.httpEtag : ''
    };
}

async function getManifest(bucket) {
    return (await getManifestState(bucket)).manifest;
}

async function listR2Objects(bucket, prefix) {
    if (typeof bucket.list !== 'function') throw new Error('Missing R2 list support.');
    const objects = [];
    let cursor;
    do {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        for (const object of page.objects || []) {
            if (object?.key) objects.push(object);
        }
        if (page.truncated && !page.cursor) throw new Error('R2 list cursor missing.');
        cursor = page.truncated ? page.cursor : null;
    } while (cursor);
    return objects;
}

async function deleteR2Objects(bucket, keys) {
    const uniqueKeys = [...new Set(keys)].filter(Boolean);
    for (let offset = 0; offset < uniqueKeys.length; offset += 1000) {
        await bucket.delete(uniqueKeys.slice(offset, offset + 1000));
    }
}

function manifestHistoryKey(version) {
    return `${MANIFEST_HISTORY_PREFIX}/v${String(version).padStart(20, '0')}.json`;
}

async function writeManifestHistory(bucket, manifest) {
    await bucket.put(manifestHistoryKey(manifest.version), JSON.stringify(manifest), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { dataset: DATASET_ID, version: String(manifest.version) }
    });
}

async function readRecentManifestHistory(bucket) {
    const historyObjects = await listR2Objects(bucket, `${MANIFEST_HISTORY_PREFIX}/`);
    historyObjects.sort((left, right) => right.key.localeCompare(left.key));
    const retainedObjects = historyObjects.slice(0, MANIFEST_HISTORY_KEEP);
    const staleHistoryKeys = historyObjects.slice(MANIFEST_HISTORY_KEEP).map((object) => object.key);
    if (staleHistoryKeys.length > 0) await deleteR2Objects(bucket, staleHistoryKeys);

    const manifests = await Promise.all(retainedObjects.map(async (object) => {
        const manifest = normalizeManifest(await readR2Json(bucket, object.key));
        if (!manifest) throw new Error(`历史 manifest 无效：${object.key}`);
        return manifest;
    }));
    manifests.sort((left, right) => right.version - left.version);
    return manifests;
}

function hasContiguousRecentHistory(currentManifest, historyManifests) {
    const requiredCount = Math.min(MANIFEST_HISTORY_KEEP, currentManifest.version);
    if (historyManifests.length < requiredCount) return false;
    for (let index = 0; index < requiredCount; index += 1) {
        if (historyManifests[index]?.version !== currentManifest.version - index) return false;
    }
    return true;
}

function collectReferencedChunkKeys(currentManifest, historyManifests) {
    const referencedKeys = new Set();
    for (const manifest of [currentManifest, ...historyManifests]) {
        for (const chunk of manifest?.chunkManifest || []) {
            if (chunk?.key) referencedKeys.add(chunk.key);
        }
    }
    return referencedKeys;
}

async function cleanupUnusedChunks(bucket, currentManifest, historyManifests) {
    const referencedKeys = collectReferencedChunkKeys(currentManifest, historyManifests);
    const storedObjects = await listR2Objects(bucket, `${CHUNK_PREFIX}/`);
    const cutoff = Date.now() - CHUNK_GC_GRACE_MS;
    const staleKeys = storedObjects
        .filter((object) => {
            const uploadedAt = object?.uploaded instanceof Date
                ? object.uploaded.getTime()
                : new Date(object?.uploaded || 0).getTime();
            return object?.key
                && !referencedKeys.has(object.key)
                && Number.isFinite(uploadedAt)
                && uploadedAt < cutoff;
        })
        .sort((left, right) => {
            const uploadedDifference = new Date(left.uploaded).getTime() - new Date(right.uploaded).getTime();
            return uploadedDifference || left.key.localeCompare(right.key);
        })
        .slice(0, CHUNK_GC_MAX_DELETE)
        .map((object) => object.key);
    if (staleKeys.length > 0) await deleteR2Objects(bucket, staleKeys);
}

async function maintainCommittedManifest(bucket, manifest) {
    await writeManifestHistory(bucket, manifest);
    const historyManifests = await readRecentManifestHistory(bucket);
    if (!hasContiguousRecentHistory(manifest, historyManifests)) {
        console.warn('[RP Sync] Manifest history is not contiguous yet; chunk GC deferred.');
        return;
    }
    await cleanupUnusedChunks(bucket, manifest, historyManifests);
}

function scheduleManifestMaintenance(ctx, bucket, manifest) {
    const maintenance = maintainCommittedManifest(bucket, manifest).catch((err) => {
        console.warn('[RP Sync] Failed to maintain manifest history or chunks:', err);
    });
    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(maintenance);
    }
}

function buildRemoteInfo(manifest, includeChunkManifest = false) {
    const remote = {
        version: manifest.version,
        checksum: manifest.checksum,
        updatedAt: manifest.updatedAt,
        recordCount: manifest.recordCount,
        totalBytes: manifest.totalBytes,
        chunkCount: manifest.chunkCount,
        chunkSize: manifest.chunkSize,
        ...(manifest.snapshotFormat === undefined ? {} : { snapshotFormat: manifest.snapshotFormat }),
        ...(manifest.schemaVersion === undefined ? {} : { schemaVersion: manifest.schemaVersion }),
        ...(manifest.chunkerProfile === undefined ? {} : { chunkerProfile: manifest.chunkerProfile })
    };
    if (includeChunkManifest) {
        remote.chunkManifest = (manifest.chunkManifest || []).map((chunk) => ({
            index: chunk.index,
            checksum: chunk.checksum,
            length: getChunkLength(chunk)
        }));
    }
    return remote;
}

// 只认出格式和取分页要用的字段，完整校验由页面按根清单的校验码做。
function readForkRoot(value) {
    if (value?.format !== FORK_ROOT_FORMAT || !/^[a-f0-9]{64}$/.test(value.checksum) || !Number.isInteger(value.pageCount)) return null;
    const { version, checksum, updatedAt, totalBytes, packCount, entryCount, pageCount, pageRoot, bloomChecksum, snapshotFormat, schemaVersion } = value;
    return { version, checksum, updatedAt, totalBytes, packCount, entryCount, pageCount, pageRoot, bloomChecksum, snapshotFormat, schemaVersion };
}

async function handleStatus(bucket, includeChunkManifest = false) {
    const { manifest, rawManifest } = await getManifestState(bucket);
    const fork = manifest ? null : readForkRoot(rawManifest);
    return json({ ok: true, remote: manifest ? buildRemoteInfo(manifest, includeChunkManifest) : null, ...(fork ? { fork } : {}) });
}

async function handleForkPage(bucket, body) {
    const index = Number(body.index);
    if (!/^[a-f0-9]{64}$/.test(body.checksum) || !Number.isInteger(index) || index < 0 || index > 9999) return error('魔改版清单参数无效。');
    const object = await bucket.get(`${R2_PREFIX}/manifests/${body.checksum}/${String(index).padStart(4, '0')}.json`);
    let page = null;
    try { page = object ? JSON.parse(await object.text()) : null; } catch (_) { /* 当作不存在 */ }
    if (!Array.isArray(page?.packs)) return error('魔改版清单分页不存在。', 404);
    return json({ ok: true, packs: page.packs });
}

async function handleForkPacks(bucket, body) {
    const checksums = Array.isArray(body.checksums) ? body.checksums : [];
    if (!checksums.length || checksums.length > MAX_PULL_CHUNKS || checksums.some((checksum) => !/^[a-f0-9]{64}$/.test(checksum))) {
        return error('魔改版数据包参数无效。');
    }
    const parts = await Promise.all(checksums.map(async (checksum) => {
        const object = await bucket.get(`${R2_PREFIX}/packs/${checksum}.bin`);
        return object ? object.arrayBuffer() : null;
    }));
    if (parts.some((bytes) => !bytes)) return error('魔改版数据包不存在。', 404);
    return new Response(new Blob(parts), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
}

// ---- 换成魔改版：页面把测试版的云端数据转成魔改版 schema 13 的数据包和清单，这里核对后落盘，再把程序换过去 ----
const FORK_PACK_MAX_BYTES = 1024 * 1024;
const FORK_BLOOM_BYTES = 32 * 1024;
const FORK_PAGE_PACKS = 32;
const FORK_EXPORT_MAX_PAGES = 1000;
const TEST_ROOT_BACKUP_KEY = `${R2_PREFIX}/test-root-backup.json`;

async function handleForkExportPack(request, bucket, url) {
    const checksum = url.searchParams.get('checksum') || '';
    if (!/^[a-f0-9]{64}$/.test(checksum)) return error('魔改版数据包校验码无效。');
    const bytes = await readLimitedBody(request.body, FORK_PACK_MAX_BYTES, '魔改版数据包');
    if (await sha256Bytes(bytes) !== checksum) return error('魔改版数据包校验失败。', 409);
    // 魔改版下载时核对包里的条数（就是换行数），条数记在对象的元数据里。
    let entryCount = 0;
    for (let index = bytes.indexOf(10); index !== -1; index = bytes.indexOf(10, index + 1)) entryCount += 1;
    await bucket.put(`${R2_PREFIX}/packs/${checksum}.bin`, bytes, {
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: { entryCount: String(entryCount) }
    });
    return json({ ok: true });
}

// 分页哈希链、布隆过滤器和根清单校验码都重算一遍，对得上才换上根清单；测试版的清单另存一份。
async function handleForkExportCommit(bucket, body) {
    const state = await getManifestState(bucket);
    if (!state.manifest || state.manifest.checksum !== body.expectedChecksum) return error('云端数据刚刚变了，请重新转换。', 409);
    const pages = Array.isArray(body.pages) ? body.pages : [];
    if (pages.length > FORK_EXPORT_MAX_PAGES) return error('数据太多，一次转不过去。');
    const packs = pages.flatMap((page) => (Array.isArray(page?.packs) ? page.packs : []));
    if (packs.some((pack) => !/^[a-f0-9]{64}$/.test(pack?.checksum) || !(pack.length > 0 && pack.length <= FORK_PACK_MAX_BYTES)
        || !Number.isInteger(pack.length) || !Number.isInteger(pack.entryCount) || !Number.isInteger(pack.part)
        || typeof pack.bucketKey !== 'string' || typeof pack.group !== 'string')) return error('魔改版数据包清单异常。');
    let pageRoot = '0'.repeat(64);
    for (const [index, page] of pages.entries()) {
        if (!page.packs?.length || page.packs.length > FORK_PAGE_PACKS || page.previousPageHash !== pageRoot) return error('魔改版清单分页不连续。');
        pageRoot = await sha256Text(JSON.stringify(['rp-sync-manifest-page-v1', index, pageRoot,
            page.packs.map((pack) => [pack.bucketKey, pack.group, pack.part, pack.checksum, pack.length, pack.entryCount])]));
        if (page.pageHash !== pageRoot) return error('魔改版清单分页校验失败。');
    }
    let bloom;
    try { bloom = Uint8Array.from(atob(String(body.bloom || '')), (char) => char.charCodeAt(0)); } catch (_) { bloom = new Uint8Array(); }
    if (bloom.byteLength !== FORK_BLOOM_BYTES) return error('魔改版布隆过滤器大小异常。');
    const bloomChecksum = await sha256Bytes(bloom);
    const totalBytes = packs.reduce((sum, pack) => sum + pack.length, 0);
    const entryCount = packs.reduce((sum, pack) => sum + pack.entryCount, 0);
    const checksum = await sha256Text(JSON.stringify(['rp-sync-paged-jsonl-v4', 13, totalBytes, packs.length, entryCount, pages.length, pageRoot, bloomChecksum]));
    if (checksum !== body.checksum) return error('魔改版根清单校验失败。');

    const putJson = (key, value, options = {}) => bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json; charset=utf-8' }, ...options });
    await Promise.all(pages.map((page, index) => putJson(`${R2_PREFIX}/manifests/${checksum}/${String(index).padStart(4, '0')}.json`, {
        format: 'rp-sync-manifest-page-v1', checksum, pageIndex: index, previousPageHash: page.previousPageHash, pageHash: page.pageHash, packs: page.packs
    })));
    await bucket.put(`${R2_PREFIX}/blooms/${bloomChecksum}.bin`, bloom, { httpMetadata: { contentType: 'application/octet-stream' } });
    // 魔改版第一次见到这个桶时，会把当时的根清单记成“旧数据”跳过；先替它写好迁移标记，它就直接读这份根清单。
    await putJson(`${R2_PREFIX}/migration-v13.done`, { format: 'rp-sync-migration-v13', legacyEtag: null, createdAt: Date.now() },
        { onlyIf: { etagDoesNotMatch: '*' } });
    await putJson(TEST_ROOT_BACKUP_KEY, state.rawManifest);
    const previousFork = (await readR2JsonObject(bucket, FORK_ROOT_BACKUP_KEY)).value;
    const version = (Number(previousFork?.version) || 0) + 1;
    const written = await putJson(MANIFEST_KEY, {
        format: FORK_ROOT_FORMAT, version, checksum, updatedAt: Date.now(), totalBytes, packCount: packs.length, entryCount,
        pageCount: pages.length, pageRoot, bloomChecksum, snapshotFormat: 'rp-sync-paged-jsonl-v4', schemaVersion: 13
    }, { onlyIf: { etagMatches: state.etag || state.httpEtag.replace(/^"|"$/g, '') } });
    if (!written) return error('云端数据刚刚变了，请重新转换。', 409);
    return json({ ok: true, version });
}

async function handlePullJsonPart(bucket, body) {
    const manifest = await getManifest(bucket);
    if (!manifest) return error('服务器当前没有可同步的数据。', 404);

    const version = Number(body.version);
    const start = Number(body.start);
    const count = Number(body.count);
    if (!Number.isInteger(version) || version !== manifest.version) return error('服务器版本已变化，请重试。', 409);
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count <= 0 || count > MAX_PULL_CHUNKS) {
        return error('下载分段范围无效。');
    }
    if (start >= manifest.chunkCount || start + count > manifest.chunkCount) return error('下载分段范围无效。');

    const selectedChunks = manifest.chunkManifest.slice(start, start + count);
    const byteLength = selectedChunks.reduce((sum, item) => sum + Number(item.byteLength || item.length || 0), 0);
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
        return error('R2 分段字节信息异常。', 409);
    }

    const parts = await Promise.all(selectedChunks.map(async (chunk) => {
        const object = await bucket.get(chunk.key);
        return object ? new Uint8Array(await object.arrayBuffer()) : null;
    }));
    if (parts.some((bytes) => !bytes)) return error('R2 快照分片不存在。', 404);
    const gzip = selectedChunks.some((chunk) => chunk.encoding === 'gzip');
    if (!gzip && parts.some((bytes, index) => bytes.byteLength !== getChunkLength(selectedChunks[index]))) {
        return error('R2 快照分片大小校验失败。', 409);
    }
    const storedLength = parts.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    const merged = new Uint8Array(storedLength);
    let offset = 0;
    for (const bytes of parts) {
        merged.set(bytes, offset);
        offset += bytes.byteLength;
    }

    return new Response(merged, {
        status: 200,
        headers: {
            'content-type': 'application/octet-stream',
            'cache-control': 'no-store',
            'x-rp-sync-start': String(start),
            'x-rp-sync-count': String(count),
            'x-rp-sync-byte-length': String(storedLength),
            ...(gzip ? { 'x-rp-sync-part-lengths': parts.map((bytes) => bytes.byteLength).join(',') } : {})
        }
    });
}

async function handleUploadCreate(bucket, body) {
    const checksum = typeof body.checksum === 'string' ? body.checksum.toLowerCase() : '';
    const recordCount = body.recordCount;
    const chunkSize = Number.isFinite(Number(body.chunkSize)) ? Number(body.chunkSize) : 0;
    const chunkCount = Number.isFinite(Number(body.chunkCount)) ? Number(body.chunkCount) : 0;
    const totalBytes = Number.isFinite(Number(body.totalBytes)) ? Number(body.totalBytes) : 0;
    const snapshotMetadata = normalizeSnapshotMetadata(body);

    if (!/^[a-f0-9]{64}$/i.test(checksum)) return error('本地数据校验码无效。');
    if (!snapshotMetadata) return error('本地快照格式无效。');
    if (!Number.isInteger(recordCount) || recordCount < 0) return error('本地数据记录数量异常。');
    if (chunkCount === 0 && totalBytes === 0) {
        return json({ ok: true, alreadyUpToDate: true, remote: buildEmptyRemoteInfo(checksum, recordCount, totalBytes, snapshotMetadata) });
    }
    if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) return error(`本地数据数量异常：${chunkCount}/${MAX_CHUNK_COUNT}。`);
    if (!Number.isInteger(totalBytes) || totalBytes <= 0) return error('本地数据大小异常。');

    let chunkManifest;
    try {
        chunkManifest = normalizeChunkManifest(body.chunkManifest, totalBytes, chunkEncodingForSchema(snapshotMetadata.schemaVersion));
    } catch (err) {
        return error(err instanceof Error ? err.message : '分片清单无效。');
    }
    if (!chunkManifest || chunkManifest.length !== chunkCount) return error('分片清单数量不一致。');
    if (snapshotMetadata.snapshotFormat === STREAM_SNAPSHOT_FORMAT
        && await sha256Text(JSON.stringify([
            STREAM_SNAPSHOT_FORMAT,
            snapshotMetadata.schemaVersion,
            Number(recordCount || 0),
            Number(totalBytes || 0),
            chunkManifest.map((chunk) => [String(chunk.checksum).toLowerCase(), getChunkLength(chunk)])
        ])) !== checksum) {
        return error('本地快照清单校验失败。');
    }

    const current = await getManifest(bucket);
    if (current?.checksum === checksum) {
        return json({ ok: true, alreadyUpToDate: true, remote: buildRemoteInfo(current, true) });
    }

    const currentChunkLookup = buildChunkLookup(current);
    const missingIndices = [];
    const reusableIndices = [];
    const plannedUploadSignatures = new Set();
    for (const item of chunkManifest) {
        const signature = chunkSignature(item);
        if (isSameChunk(item, currentChunkLookup.get(signature)) || plannedUploadSignatures.has(signature)) {
            reusableIndices.push(item.index);
        } else {
            missingIndices.push(item.index);
            plannedUploadSignatures.add(signature);
        }
    }

    return json({
        ok: true,
        alreadyUpToDate: false,
        chunkSize,
        chunkCount,
        totalBytes,
        recordCount,
        ...snapshotMetadata,
        missingIndices,
        reusableIndices,
        previousVersion: current?.version || 0
    });
}

async function handleUploadPart(request, bucket, url) {
    const partNumber = Number(url.searchParams.get('partNumber'));
    const index = Number(url.searchParams.get('index'));
    const expectedChecksum = (request.headers.get('x-rp-part-checksum') || '').toLowerCase();
    const expectedLength = Number(request.headers.get('x-rp-part-length') || 0);

    if (!Number.isInteger(partNumber) || partNumber <= 0 || partNumber > MAX_CHUNK_COUNT) return error('上传数据序号异常。');
    if (!Number.isInteger(index) || index < 0 || index + 1 !== partNumber) return error('上传数据索引异常。');
    if (!/^[a-f0-9]{64}$/i.test(expectedChecksum)) return error('上传数据校验码无效。');
    if (!Number.isInteger(expectedLength) || expectedLength <= 0 || expectedLength > MAX_PART_BYTES) return error('上传数据大小异常。');

    const encoding = request.headers.get('x-rp-part-encoding') === 'gzip' ? 'gzip' : 'raw-bytes';
    const storedChecksum = encoding === 'gzip' ? (request.headers.get('x-rp-part-stored-checksum') || '').toLowerCase() : expectedChecksum;
    const storedLength = encoding === 'gzip' ? Number(request.headers.get('x-rp-part-stored-length') || 0) : expectedLength;
    if (!/^[a-f0-9]{64}$/i.test(storedChecksum)) return error('上传数据校验码无效。');
    if (!Number.isInteger(storedLength) || storedLength <= 0 || storedLength > MAX_PART_BYTES) return error('上传数据大小异常。');

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== storedLength) return error('上传数据大小与声明不一致。', 409);
    if (await sha256Bytes(bytes) !== storedChecksum) return error('上传数据校验失败。', 409);

    const key = createChunkKey(expectedChecksum, encoding);
    try {
        await bucket.put(key, bytes, {
            httpMetadata: { contentType: 'application/octet-stream' },
            customMetadata: { dataset: DATASET_ID, checksum: expectedChecksum }
        });
    } catch (err) {
        return error(err instanceof Error ? err.message : '上传数据失败。', 409);
    }
    return json({
        ok: true,
        partNumber,
        index,
        byteLength: bytes.byteLength,
        checksum: expectedChecksum,
        key
    });
}

async function handleUploadComplete(bucket, body, ctx) {
    const checksum = typeof body.checksum === 'string' ? body.checksum.toLowerCase() : '';
    const recordCount = body.recordCount;
    const chunkSize = Number.isFinite(Number(body.chunkSize)) ? Number(body.chunkSize) : 0;
    const chunkCount = Number.isFinite(Number(body.chunkCount)) ? Number(body.chunkCount) : 0;
    const totalBytes = Number.isFinite(Number(body.totalBytes)) ? Number(body.totalBytes) : 0;
    const expectedVersion = Number(body.expectedVersion);
    const snapshotMetadata = normalizeSnapshotMetadata(body);

    if (!/^[a-f0-9]{64}$/i.test(checksum)) return error('本地数据校验码无效。');
    if (!snapshotMetadata) return error('本地快照格式无效。');
    if (!Number.isInteger(recordCount) || recordCount < 0) return error('本地数据记录数量异常。');
    if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) return error('上传数据数量异常。');
    if (!Number.isInteger(totalBytes) || totalBytes <= 0) return error('本地数据大小异常。');
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return error('上传会话版本无效，请重新开始上传。', 409);

    let chunkManifest;
    try {
        chunkManifest = normalizeChunkManifest(body.chunkManifest, totalBytes, chunkEncodingForSchema(snapshotMetadata.schemaVersion));
    } catch (err) {
        return error(err instanceof Error ? err.message : '上传数据清单无效。');
    }
    if (!chunkManifest || chunkManifest.length !== chunkCount) return error('上传数据清单数量不一致。');
    if (snapshotMetadata.snapshotFormat === STREAM_SNAPSHOT_FORMAT
        && await sha256Text(JSON.stringify([
            STREAM_SNAPSHOT_FORMAT,
            snapshotMetadata.schemaVersion,
            Number(recordCount || 0),
            Number(totalBytes || 0),
            chunkManifest.map((chunk) => [String(chunk.checksum).toLowerCase(), getChunkLength(chunk)])
        ])) !== checksum) {
        return error('本地快照清单校验失败。');
    }

    const manifestState = await getManifestState(bucket);
    const previous = manifestState.manifest;
    if (previous?.checksum === checksum) {
        return json({
            ok: true,
            version: previous.version,
            checksum: previous.checksum,
            updatedAt: previous.updatedAt,
            reusedChunkCount: 0,
            alreadyCommitted: true,
            ...Object.fromEntries(Object.entries({
                snapshotFormat: previous.snapshotFormat,
                schemaVersion: previous.schemaVersion,
                chunkerProfile: previous.chunkerProfile
            }).filter(([, value]) => value !== undefined))
        });
    }

    const actualVersion = Number(previous?.version || 0);
    if (actualVersion !== expectedVersion) {
        return error('同步冲突：云端数据已被其他设备更新，请重试。', 409);
    }

    const committedManifest = {
        version: actualVersion + 1,
        checksum,
        updatedAt: Date.now(),
        recordCount,
        totalBytes,
        chunkSize,
        chunkCount,
        chunkManifest,
        mode: 'r2-chunk-manifest-v1',
        ...snapshotMetadata
    };

    let onlyIf;
    if (manifestState.object) {
        const etag = manifestState.etag || manifestState.httpEtag.replace(/^"|"$/g, '');
        if (!etag) throw new Error('R2 manifest 缺少 ETag，无法安全提交。');
        onlyIf = { etagMatches: etag };
    } else {
        onlyIf = { etagDoesNotMatch: '*' };
    }

    if (!previous && readForkRoot(manifestState.rawManifest)) {
        await bucket.put(FORK_ROOT_BACKUP_KEY, JSON.stringify(manifestState.rawManifest), {
            httpMetadata: { contentType: 'application/json; charset=utf-8' }
        });
    }

    const committedObject = await bucket.put(MANIFEST_KEY, JSON.stringify(committedManifest), {
        onlyIf,
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
    if (!committedObject) {
        return error('同步冲突：云端数据已被其他设备更新，请重试。', 409);
    }

    scheduleManifestMaintenance(ctx, bucket, committedManifest);

    return json({
        ok: true,
        version: committedManifest.version,
        checksum: committedManifest.checksum,
        updatedAt: committedManifest.updatedAt,
        reusedChunkCount: 0,
        ...snapshotMetadata
    });
}

