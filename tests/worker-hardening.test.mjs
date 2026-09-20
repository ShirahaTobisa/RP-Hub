import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { RP_HUB_APP_PATCH_REVISION as PATCH_REVISION } from '../DB/app-patches.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const WORKER_FILE = path.join(ROOT_DIR, '_worker.js');
const API_URL = 'https://worker.test/api/rp-sync';
const MANIFEST_KEY = 'rp-sync/main/manifest.json';
const CHUNK_PREFIX = 'rp-sync/main/chunks/';
const HISTORY_PREFIX = 'rp-sync/main/manifest-history/';
const DAY_MS = 24 * 60 * 60 * 1000;
const UPSTREAM_REPO_DIR = path.resolve(ROOT_DIR, '..', 'RP-Hub');
const UPSTREAM_181_COMMIT = '8911f4bba41cfe3b1a092862697b99faf7716d7d';
const RAW_UPSTREAM_APP_JS = execFileSync(
    'git',
    ['-C', UPSTREAM_REPO_DIR, 'show', '1.7.5:assets/js/app.js'],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
);
const RAW_UPSTREAM_APP_181_JS = execFileSync(
    'git',
    ['-C', UPSTREAM_REPO_DIR, 'show', `${UPSTREAM_181_COMMIT}:assets/js/app.js`],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
);
const APP_UPDATE_PREFIX = 'rp-app-update';
const APP_UPDATE_MANIFEST_KEY = `${APP_UPDATE_PREFIX}/manifest.json`;
const APP_RELEASE_CACHE_KEY = `${APP_UPDATE_PREFIX}/release-cache.json`;
const UPSTREAM_FILES = [
    'LICENSE',
    'README.md',
    'assets/css/styles.css',
    'assets/js/app.js',
    'assets/js/card-utils.js',
    'assets/js/ui-select.js',
    'assets/js/utils.js',
    'character/index.html',
    'index.html'
];
const UPSTREAM_181_FILES = [
    'LICENSE',
    'README.md',
    'assets/css/styles.css',
    'assets/js/app.js',
    'assets/js/built-in-content.js',
    'assets/js/core-utils.js',
    'assets/js/data-services.js',
    'assets/js/runtime-services.js',
    'assets/js/ui-components.js',
    'character/index.html',
    'index.html',
    'novel/index.html'
];

function createUpdateFetch(options = {}) {
    const calls = [];
    const requestOptions = [];
    const contentsFiles = options.contentsFiles || UPSTREAM_FILES;
    let active = 0;
    let maxActive = 0;
    const fetchImpl = async (url, fetchOptions = {}) => {
        const value = String(url);
        calls.push(value);
        requestOptions.push(fetchOptions);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
            if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
            if (value.includes('api.github.com/repos/') && value.includes('/contents/')) {
                if (options.failContents) return new Response('contents unavailable', { status: 503 });
                return Response.json(contentsFiles.map((filePath) => ({
                    path: filePath,
                    type: 'file',
                    size: filePath === 'assets/js/app.js' ? RAW_UPSTREAM_APP_JS.length : 11
                })));
            }
            if (value.includes('/releases.atom')) {
                return new Response('release cache should have prevented an Atom request', { status: 500 });
            }
            if (options.redirectDownloads && !value.includes('rph-hop=1')) {
                return new Response(null, {
                    status: 302,
                    headers: { location: '?rph-hop=1' }
                });
            }
            if (options.failAllDownloads || (options.failDownloadPath && value.includes(options.failDownloadPath))) {
                return new Response('download unavailable', { status: 503 });
            }
            if (value.includes('/assets/js/app.js')) {
                return new Response(options.appJs ?? RAW_UPSTREAM_APP_JS, {
                    status: 200,
                    headers: { 'content-type': 'application/javascript' }
                });
            }
            return new Response(`upstream:${value}`, { status: 200 });
        } finally {
            active -= 1;
        }
    };
    return {
        calls,
        requestOptions,
        fetchImpl,
        get maxActive() {
            return maxActive;
        }
    };
}

function hex64(number) {
    return Number(number).toString(16).padStart(64, '0');
}

async function sha256Hex(bytes) {
    const digest = await webcrypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function buildV4ManifestChecksum({ recordCount, totalBytes, chunkManifest }) {
    return sha256Hex(new TextEncoder().encode(JSON.stringify([
        'rp-sync-jsonl-v1',
        4,
        Number(recordCount || 0),
        Number(totalBytes || 0),
        chunkManifest.map((chunk) => [String(chunk.checksum).toLowerCase(), Number(chunk.length)])
    ])));
}

function chunkKey(checksum) {
    return `${CHUNK_PREFIX}${checksum}.bin`;
}

function bytesOf(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    if (value === null) return new Uint8Array();
    throw new TypeError('FakeR2 only accepts buffered values in these tests.');
}

class FakeR2Object {
    constructor(record, withBody = true) {
        this.key = record.key;
        this.version = record.version;
        this.size = record.bytes.byteLength;
        this.etag = record.etag;
        this.httpEtag = `"${record.etag}"`;
        this.uploaded = new Date(record.uploaded);
        this.httpMetadata = record.httpMetadata;
        this.customMetadata = record.customMetadata;
        this.storageClass = 'Standard';
        this._bytes = withBody ? new Uint8Array(record.bytes) : null;
    }

    async text() {
        return new TextDecoder().decode(this._bytes);
    }

    async arrayBuffer() {
        return this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength);
    }

    get body() {
        return new Uint8Array(this._bytes);
    }
}

class FakeR2 {
    constructor() {
        this.records = new Map();
        this.sequence = 0;
        this.operationCount = 0;
        this.deleteBatches = [];
        this.putCalls = [];
        this.getBarriers = new Map();
    }

    resetOperationCount() {
        this.operationCount = 0;
        this.deleteBatches = [];
        this.putCalls = [];
    }

    seed(key, value, options = {}) {
        this.#store(key, bytesOf(value), options);
    }

    seedJson(key, value, options = {}) {
        this.seed(key, JSON.stringify(value), {
            httpMetadata: { contentType: 'application/json; charset=utf-8' },
            ...options
        });
    }

    setUploaded(key, uploaded) {
        const record = this.records.get(key);
        assert(record, `missing fake object: ${key}`);
        record.uploaded = new Date(uploaded).getTime();
    }

    has(key) {
        return this.records.has(key);
    }

    keys(prefix = '') {
        return [...this.records.keys()].filter((key) => key.startsWith(prefix)).sort();
    }

    json(key) {
        const record = this.records.get(key);
        assert(record, `missing fake JSON object: ${key}`);
        return JSON.parse(new TextDecoder().decode(record.bytes));
    }

    armGetBarrier(key, count) {
        let release;
        const promise = new Promise((resolve) => { release = resolve; });
        this.getBarriers.set(key, { count, arrived: 0, promise, release, done: false });
    }

    async get(key) {
        this.operationCount += 1;
        const record = this.records.get(key);
        const captured = record ? { ...record, bytes: new Uint8Array(record.bytes) } : null;
        const barrier = this.getBarriers.get(key);
        if (barrier && !barrier.done) {
            barrier.arrived += 1;
            if (barrier.arrived >= barrier.count) {
                barrier.done = true;
                barrier.release();
            }
            await barrier.promise;
        }
        return captured ? new FakeR2Object(captured, true) : null;
    }

    async put(key, value, options = {}) {
        this.operationCount += 1;
        const existing = this.records.get(key);
        const onlyIf = options.onlyIf;
        let conditionPassed = true;
        if (onlyIf instanceof Headers) {
            const ifMatch = onlyIf.get('if-match');
            const ifNoneMatch = onlyIf.get('if-none-match');
            if (ifMatch) conditionPassed = Boolean(existing && ifMatch === `"${existing.etag}"`);
            if (ifNoneMatch === '*') conditionPassed = !existing;
        } else if (onlyIf && typeof onlyIf === 'object') {
            if (onlyIf.etagMatches !== undefined) {
                conditionPassed = Boolean(existing && (onlyIf.etagMatches === '*' || onlyIf.etagMatches === existing.etag));
            }
            if (onlyIf.etagDoesNotMatch !== undefined) {
                conditionPassed = conditionPassed
                    && (onlyIf.etagDoesNotMatch === '*' ? !existing : !existing || onlyIf.etagDoesNotMatch !== existing.etag);
            }
        }
        this.putCalls.push({ key, onlyIf, conditionPassed });
        if (!conditionPassed) return null;
        return new FakeR2Object(this.#store(key, bytesOf(value), options), false);
    }

    async delete(keys) {
        this.operationCount += 1;
        const list = Array.isArray(keys) ? [...keys] : [keys];
        this.deleteBatches.push(list);
        for (const key of list) this.records.delete(key);
    }

    async list(options = {}) {
        this.operationCount += 1;
        const prefix = options.prefix || '';
        const all = [...this.records.values()]
            .filter((record) => record.key.startsWith(prefix))
            .sort((left, right) => left.key.localeCompare(right.key));
        const offset = options.cursor ? Number(options.cursor) : 0;
        const limit = Math.max(1, Math.min(Number(options.limit || 1000), 1000));
        const page = all.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
            objects: page.map((record) => new FakeR2Object(record, false)),
            truncated: nextOffset < all.length,
            cursor: nextOffset < all.length ? String(nextOffset) : undefined
        };
    }

    #store(key, bytes, options = {}) {
        this.sequence += 1;
        const record = {
            key,
            bytes,
            etag: `etag-${this.sequence}`,
            version: `version-${this.sequence}`,
            uploaded: options.uploaded ? new Date(options.uploaded).getTime() : Date.now(),
            httpMetadata: options.httpMetadata,
            customMetadata: options.customMetadata
        };
        this.records.set(key, record);
        return record;
    }
}

class FaultInjectingR2 extends FakeR2 {
    constructor() {
        super();
        this.putFault = null;
    }

    failNextPut(matcher, mode = 'throw-before') {
        this.putFault = { matcher, mode };
    }

    async put(key, value, options = {}) {
        const fault = this.putFault;
        if (!fault || !fault.matcher(key)) return super.put(key, value, options);
        this.putFault = null;
        if (fault.mode === 'return-null') return null;
        if (fault.mode === 'throw-after') {
            await super.put(key, value, options);
        }
        throw new Error(`injected put failure: ${key}`);
    }
}

class SupersedingManifestR2 extends FakeR2 {
    constructor() {
        super();
        this.manifestPutCount = 0;
        this.firstCommittedSlot = '';
        this.firstManifestCommitted = new Promise((resolve) => { this.resolveFirstManifestCommitted = resolve; });
        this.releaseFirstManifestPut = new Promise((resolve) => { this.resolveFirstManifestPut = resolve; });
    }

    async put(key, value, options = {}) {
        if (key !== APP_UPDATE_MANIFEST_KEY) return super.put(key, value, options);
        this.manifestPutCount += 1;
        if (this.manifestPutCount !== 1) return super.put(key, value, options);
        const stored = await super.put(key, value, options);
        this.firstCommittedSlot = JSON.parse(typeof value === 'string' ? value : new TextDecoder().decode(bytesOf(value))).current.slot;
        this.resolveFirstManifestCommitted();
        await this.releaseFirstManifestPut;
        throw new Error('injected ambiguous failure after first manifest commit');
    }

    releaseAmbiguousManifestPut() {
        this.resolveFirstManifestPut();
    }
}

class CleanupManifestReadBarrierR2 extends FakeR2 {
    constructor() {
        super();
        this.armAfterManifestPut = false;
        this.blockNextManifestGet = false;
        this.cleanupReadStarted = new Promise((resolve) => { this.resolveCleanupReadStarted = resolve; });
        this.cleanupReadRelease = new Promise((resolve) => { this.resolveCleanupReadRelease = resolve; });
    }

    armCleanupReadBarrier() {
        this.armAfterManifestPut = true;
    }

    async put(key, value, options = {}) {
        const stored = await super.put(key, value, options);
        if (key === APP_UPDATE_MANIFEST_KEY && this.armAfterManifestPut) {
            this.armAfterManifestPut = false;
            this.blockNextManifestGet = true;
        }
        return stored;
    }

    async get(key) {
        if (key === APP_UPDATE_MANIFEST_KEY && this.blockNextManifestGet) {
            this.blockNextManifestGet = false;
            this.resolveCleanupReadStarted();
            await this.cleanupReadRelease;
        }
        return super.get(key);
    }

    releaseCleanupRead() {
        this.resolveCleanupReadRelease();
    }
}

class WaitUntilContext {
    constructor() {
        this.promises = [];
    }

    waitUntil(promise) {
        this.promises.push(Promise.resolve(promise));
    }

    async drain() {
        await Promise.all(this.promises);
    }
}

async function loadWorker({ zeroGrace = false, fetchImpl = fetch } = {}) {
    assert(vm.SourceTextModule, 'Run with: node --experimental-vm-modules tests/worker-hardening.test.mjs');
    const context = vm.createContext({
        console,
        URL,
        Request,
        Response,
        Headers,
        TextEncoder,
        TextDecoder,
        AbortController,
        fetch: fetchImpl,
        setTimeout,
        clearTimeout,
        crypto: webcrypto,
        structuredClone
    });
    const cache = new Map();

    async function loadModule(filename) {
        const resolved = path.resolve(filename);
        if (cache.has(resolved)) return cache.get(resolved);
        let source = await fs.readFile(resolved, 'utf8');
        if (zeroGrace && resolved === WORKER_FILE) {
            source = source.replace(
                'const CHUNK_GC_GRACE_MS = 24 * 60 * 60 * 1000;',
                'const CHUNK_GC_GRACE_MS = 0;'
            );
        }
        const module = new vm.SourceTextModule(source, {
            context,
            identifier: pathToFileURL(resolved).href
        });
        cache.set(resolved, module);
        await module.link(async (specifier, referencingModule) => {
            const target = fileURLToPath(new URL(specifier, referencingModule.identifier));
            return loadModule(target);
        });
        await module.evaluate();
        return module;
    }

    return (await loadModule(WORKER_FILE)).namespace.default;
}

async function callApi(worker, bucket, body, ctx = new WaitUntilContext()) {
    return callApiWithEnv(worker, bucket, body, { APP_UPDATE_MIRROR_BASE: 'off' }, ctx);
}

async function callApiWithEnv(worker, bucket, body, extraEnv = {}, ctx = new WaitUntilContext()) {
    const response = await worker.fetch(new Request(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    }), { RP_SYNC_R2: bucket, ...extraEnv }, ctx);
    const payload = await response.json();
    return { response, payload, ctx };
}

function seedReleaseCache(bucket, tag, message = tag) {
    bucket.seedJson(APP_RELEASE_CACHE_KEY, {
        cachedAt: Date.now(),
        versions: [{
            tag,
            sha: tag,
            shortSha: tag,
            name: tag,
            date: '',
            message
        }]
    });
}

function seedAppVersion(bucket, slot, label, files = UPSTREAM_FILES) {
    for (const filePath of files) {
        bucket.seed(`${APP_UPDATE_PREFIX}/${slot}/${filePath}`, `${label}:${filePath}`, {
            httpMetadata: { contentType: filePath.endsWith('.js') ? 'application/javascript' : 'text/plain' }
        });
    }
    return {
        slot,
        patchRevision: PATCH_REVISION,
        upstreamTag: label,
        upstreamSha: label,
        upstreamDate: '',
        upstreamMessage: label,
        appliedAt: Date.now(),
        files: files.map((filePath) => ({ path: filePath }))
    };
}

function readStoredText(bucket, key) {
    const record = bucket.records.get(key);
    assert(record, `missing fake object: ${key}`);
    return new TextDecoder().decode(record.bytes);
}

function snapshotAppVersion(bucket, manifestKey = APP_UPDATE_MANIFEST_KEY) {
    const manifest = structuredClone(bucket.json(manifestKey));
    const objects = new Map();
    for (const key of bucket.keys(`${APP_UPDATE_PREFIX}/`)) {
        if (key === APP_RELEASE_CACHE_KEY) continue;
        objects.set(key, readStoredText(bucket, key));
    }
    return { manifest, objects };
}

function assertAppVersionSnapshot(bucket, snapshot) {
    assert.deepEqual(bucket.json(APP_UPDATE_MANIFEST_KEY), snapshot.manifest);
    for (const [key, value] of snapshot.objects) {
        assert.equal(readStoredText(bucket, key), value, `${key} changed during rejected update`);
    }
}

function seedStableAppState(bucket, options = {}) {
    const currentSlot = options.currentSlot || 'versions/current-1.7.5';
    const previousSlot = options.previousSlot || 'versions/previous-1.7.4';
    const current = seedAppVersion(bucket, currentSlot, '1.7.5');
    const previous = seedAppVersion(bucket, previousSlot, '1.7.4');
    const manifest = {
        upstreamRepo: 'STA1N156/RP-Hub',
        upstreamBranch: 'main',
        updatedAt: Date.now(),
        current,
        previous
    };
    bucket.seedJson(APP_UPDATE_MANIFEST_KEY, manifest);
    return manifest;
}

function makeChunk(seed, length = 1) {
    const checksum = hex64(seed);
    return {
        index: 0,
        checksum,
        length,
        byteOffset: 0,
        byteLength: length,
        key: chunkKey(checksum),
        encoding: 'raw-bytes'
    };
}

function makeManifest(version, seed, chunk = makeChunk(seed + 10000)) {
    return {
        version,
        checksum: hex64(seed),
        updatedAt: Date.now(),
        recordCount: 1,
        totalBytes: chunk.length,
        chunkSize: chunk.length,
        chunkCount: 1,
        chunkManifest: [chunk],
        mode: 'r2-chunk-manifest-v1'
    };
}

function uploadBody(seed, expectedVersion) {
    const chunk = makeChunk(seed + 10000);
    return {
        checksum: hex64(seed),
        recordCount: 1,
        chunkSize: 1,
        chunkCount: 1,
        totalBytes: 1,
        chunkManifest: [chunk],
        expectedVersion
    };
}

async function push(worker, bucket, seed) {
    const body = uploadBody(seed, 0);
    bucket.seed(body.chunkManifest[0].key, new Uint8Array([seed & 0xff]));
    const created = await callApi(worker, bucket, { action: 'upload-create', ...body });
    assert.equal(created.response.status, 200);
    body.expectedVersion = created.payload.previousVersion;
    const completed = await callApi(worker, bucket, { action: 'upload-complete', ...body });
    assert.equal(completed.response.status, 200, completed.payload.error);
    await completed.ctx.drain();
    return completed.payload;
}

async function testCas(worker) {
    const bucket = new FakeR2();
    const initial = makeManifest(1, 1);
    bucket.seed(initial.chunkManifest[0].key, new Uint8Array([1]));
    bucket.seedJson(MANIFEST_KEY, initial);

    const left = uploadBody(2, 1);
    const right = uploadBody(3, 1);
    bucket.seed(left.chunkManifest[0].key, new Uint8Array([2]));
    bucket.seed(right.chunkManifest[0].key, new Uint8Array([3]));
    const leftCreate = await callApi(worker, bucket, { action: 'upload-create', ...left });
    const rightCreate = await callApi(worker, bucket, { action: 'upload-create', ...right });
    assert.equal(leftCreate.payload.previousVersion, 1);
    assert.equal(rightCreate.payload.previousVersion, 1);

    bucket.armGetBarrier(MANIFEST_KEY, 2);
    const leftCtx = new WaitUntilContext();
    const rightCtx = new WaitUntilContext();
    const results = await Promise.all([
        callApi(worker, bucket, { action: 'upload-complete', ...left }, leftCtx),
        callApi(worker, bucket, { action: 'upload-complete', ...right }, rightCtx)
    ]);
    assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
    const conflict = results.find((result) => result.response.status === 409);
    assert.equal(conflict.payload.error, '同步冲突：云端数据已被其他设备更新，请重试。');
    await Promise.all([leftCtx.drain(), rightCtx.drain()]);
    assert.equal(bucket.json(MANIFEST_KEY).version, 2);

    const losingBody = results[0].response.status === 409 ? left : right;
    const retryCreate = await callApi(worker, bucket, { action: 'upload-create', ...losingBody });
    assert.equal(retryCreate.payload.previousVersion, 2);
    losingBody.expectedVersion = 2;
    const retry = await callApi(worker, bucket, { action: 'upload-complete', ...losingBody });
    assert.equal(retry.response.status, 200);
    await retry.ctx.drain();
    assert.equal(bucket.json(MANIFEST_KEY).version, 3);
}

async function testHistory(worker) {
    const bucket = new FakeR2();
    for (let version = 1; version <= 7; version += 1) await push(worker, bucket, 100 + version);
    const keys = bucket.keys(HISTORY_PREFIX);
    assert.equal(keys.length, 5);
    assert.deepEqual(keys.map((key) => Number(key.match(/v(\d+)\.json$/)[1])), [3, 4, 5, 6, 7]);
    assert.deepEqual(keys.map((key) => bucket.json(key).version), [3, 4, 5, 6, 7]);
}

async function testGc(worker) {
    const bucket = new FakeR2();
    for (let version = 1; version <= 7; version += 1) await push(worker, bucket, 200 + version);
    const oldTime = Date.now() - DAY_MS - 1000;
    for (let version = 3; version <= 7; version += 1) {
        bucket.setUploaded(makeChunk(200 + version + 10000).key, oldTime);
    }
    const staleKeys = [];
    for (let index = 0; index < 150; index += 1) {
        const key = `${CHUNK_PREFIX}stale-${String(index).padStart(3, '0')}.bin`;
        staleKeys.push(key);
        bucket.seed(key, new Uint8Array([index & 0xff]), { uploaded: oldTime });
    }
    const graceKey = `${CHUNK_PREFIX}within-grace.bin`;
    bucket.seed(graceKey, new Uint8Array([1]), { uploaded: Date.now() - DAY_MS + 60_000 });

    const body = uploadBody(208, 7);
    bucket.seed(body.chunkManifest[0].key, new Uint8Array([8]));
    bucket.resetOperationCount();
    const completed = await callApi(worker, bucket, { action: 'upload-complete', ...body });
    assert.equal(completed.response.status, 200);
    await completed.ctx.drain();
    assert(bucket.operationCount <= 50, `maintenance used ${bucket.operationCount} R2 calls`);
    assert(bucket.deleteBatches.every((batch) => batch.length <= 100));
    const staleRemainingAfterFirstPass = staleKeys.filter((key) => bucket.has(key)).length;
    assert(staleRemainingAfterFirstPass >= 50 && staleRemainingAfterFirstPass <= 51);
    assert(bucket.has(graceKey));
    for (let version = 4; version <= 7; version += 1) {
        assert(bucket.has(makeChunk(200 + version + 10000).key), `history chunk v${version} was deleted`);
    }
    assert(bucket.has(body.chunkManifest[0].key));

    await push(worker, bucket, 209);
    assert.equal(staleKeys.filter((key) => bucket.has(key)).length, 0);
    assert(bucket.has(graceKey));
    return { bucket, graceKey };
}

async function testZeroGrace(worker, bucket, graceKey) {
    await push(worker, bucket, 210);
    assert(!bucket.has(graceKey));
}

async function testV5Compatibility(worker, zeroGraceWorker) {
    const bucket = new FakeR2();
    const v5Chunk = `${CHUNK_PREFIX}legacy-v5.bin`;
    bucket.seed(v5Chunk, new Uint8Array([5]));
    bucket.seedJson(MANIFEST_KEY, {
        version: 15,
        schemaVersion: 5,
        snapshotFormat: 'rp-sync-jsonl-v2',
        checksum: hex64(500),
        chunkCount: 1,
        totalBytes: 1,
        chunkManifest: [{ key: v5Chunk }]
    });
    const status = await callApi(worker, bucket, { action: 'pull-manifest' });
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.remote, null);
    const pull = await callApi(worker, bucket, { action: 'pull-json-part', version: 15, start: 0, count: 1 });
    assert.equal(pull.response.status, 404);

    const body = uploadBody(501, 0);
    bucket.seed(body.chunkManifest[0].key, new Uint8Array([1]));
    bucket.resetOperationCount();
    const completed = await callApi(worker, bucket, { action: 'upload-complete', ...body });
    assert.equal(completed.response.status, 200, completed.payload.error);
    await completed.ctx.drain();
    assert.equal(bucket.json(MANIFEST_KEY).version, 1);
    const manifestPut = bucket.putCalls.find((call) => call.key === MANIFEST_KEY);
    assert.equal(manifestPut.onlyIf.etagMatches.startsWith('"'), false);
    assert.equal(manifestPut.conditionPassed, true);
    assert(bucket.has(v5Chunk), 'v5 chunk must remain inside the 24h grace period');

    await push(zeroGraceWorker, bucket, 502);
    assert(!bucket.has(v5Chunk), 'v5 chunk should be collected after grace is set to zero');
}

async function testLimitsAndPull(worker) {
    const bucket = new FakeR2();
    const chunks = [];
    for (let index = 0; index < 9; index += 1) {
        const checksum = hex64(6000 + index);
        const chunk = {
            index,
            checksum,
            length: 1,
            byteOffset: index,
            byteLength: 1,
            key: chunkKey(checksum),
            encoding: 'raw-bytes'
        };
        chunks.push(chunk);
        bucket.seed(chunk.key, new Uint8Array([index]));
    }
    bucket.seedJson(MANIFEST_KEY, {
        version: 1,
        checksum: hex64(600),
        updatedAt: Date.now(),
        recordCount: 1,
        totalBytes: 9,
        chunkSize: 1,
        chunkCount: 9,
        chunkManifest: chunks,
        mode: 'r2-chunk-manifest-v1'
    });
    const pullEight = await worker.fetch(new Request(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pull-json-part', version: 1, start: 0, count: 8 })
    }), { RP_SYNC_R2: bucket }, new WaitUntilContext());
    assert.equal(pullEight.status, 200);
    assert.equal((await pullEight.arrayBuffer()).byteLength, 8);
    const unsupportedPullPart = await callApi(worker, bucket, {
        action: 'pull-part',
        version: 1,
        start: 0,
        count: 1
    });
    assert.equal(unsupportedPullPart.response.status, 404);
    assert.equal(unsupportedPullPart.payload.error, 'Unsupported action.');
    const pullNine = await callApi(worker, bucket, { action: 'pull-json-part', version: 1, start: 0, count: 9 });
    assert.equal(pullNine.response.status, 400);

    const variableBucket = new FakeR2();
    const variableBytes = [
        new Uint8Array([0]),
        new Uint8Array([1, 2]),
        new Uint8Array([3, 4, 5])
    ];
    const variableManifest = [];
    for (let index = 0; index < variableBytes.length; index += 1) {
        const digest = await webcrypto.subtle.digest('SHA-256', variableBytes[index]);
        const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        variableManifest.push({ index, checksum, length: variableBytes[index].byteLength });
        variableBucket.seed(chunkKey(checksum), variableBytes[index]);
    }
    variableBucket.seedJson(MANIFEST_KEY, {
        version: 2,
        checksum: hex64(601),
        updatedAt: Date.now(),
        recordCount: 1,
        totalBytes: 6,
        chunkSize: 2 * 1024 * 1024,
        chunkCount: 3,
        chunkManifest: variableManifest,
        mode: 'r2-chunk-manifest-v1'
    });
    const variablePull = await worker.fetch(new Request(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pull-json-part', version: 2, start: 0, count: 3 })
    }), { RP_SYNC_R2: variableBucket }, new WaitUntilContext());
    assert.equal(variablePull.status, 200);
    assert.deepEqual([...new Uint8Array(await variablePull.arrayBuffer())], [0, 1, 2, 3, 4, 5]);

    const largeChunks = Array.from({ length: 9 }, (_, index) => ({
        index,
        checksum: hex64(7000 + index),
        length: 64 * 1024 * 1024
    }));
    const accepted = await callApi(worker, new FakeR2(), {
        action: 'upload-create',
        checksum: hex64(700),
        recordCount: 1,
        chunkSize: 64 * 1024 * 1024,
        chunkCount: largeChunks.length,
        totalBytes: 9 * 64 * 1024 * 1024,
        chunkManifest: largeChunks
    });
    assert.equal(accepted.response.status, 200, accepted.payload.error);

    const tooLarge = await callApi(worker, new FakeR2(), {
        action: 'upload-create',
        checksum: hex64(701),
        recordCount: 1,
        chunkSize: 64 * 1024 * 1024,
        chunkCount: 17,
        totalBytes: 17 * 64 * 1024 * 1024,
        chunkManifest: []
    });
    assert.equal(tooLarge.response.status, 400);

    const oversizedPart = await callApi(worker, new FakeR2(), {
        action: 'upload-create',
        checksum: hex64(702),
        recordCount: 1,
        chunkSize: 64 * 1024 * 1024 + 1,
        chunkCount: 1,
        totalBytes: 64 * 1024 * 1024 + 1,
        chunkManifest: [{ index: 0, checksum: hex64(8000), length: 64 * 1024 * 1024 + 1 }]
    });
    assert.equal(oversizedPart.response.status, 400);
}

async function testManifestFormatMetadataAndChecksum(worker) {
    const bucket = new FakeR2();
    const bytes = new TextEncoder().encode('jsonl-v4-fixture');
    const chunkChecksum = await sha256Hex(bytes);
    const chunk = { index: 0, checksum: chunkChecksum, length: bytes.byteLength };
    const snapshotChecksum = await buildV4ManifestChecksum({
        recordCount: 7,
        totalBytes: bytes.byteLength,
        chunkManifest: [chunk]
    });
    bucket.seed(chunkKey(chunkChecksum), bytes);

    const body = {
        action: 'upload-create',
        checksum: snapshotChecksum,
        snapshotFormat: 'rp-sync-jsonl-v1',
        schemaVersion: 4,
        chunkerProfile: 'rph-jsonl-cdc-fnv1a-v1',
        recordCount: 7,
        chunkSize: 2 * 1024 * 1024,
        chunkCount: 1,
        totalBytes: bytes.byteLength,
        chunkManifest: [chunk]
    };
    const create = await callApi(worker, bucket, body);
    assert.equal(create.response.status, 200, create.payload.error);
    assert.equal(create.payload.snapshotFormat, 'rp-sync-jsonl-v1');
    assert.equal(create.payload.schemaVersion, 4);
    assert.equal(create.payload.chunkerProfile, 'rph-jsonl-cdc-fnv1a-v1');

    const complete = await callApi(worker, bucket, {
        ...body,
        action: 'upload-complete',
        expectedVersion: create.payload.previousVersion
    });
    assert.equal(complete.response.status, 200, complete.payload.error);
    assert.equal(complete.payload.snapshotFormat, 'rp-sync-jsonl-v1');
    assert.equal(complete.payload.schemaVersion, 4);
    assert.equal(complete.payload.chunkerProfile, 'rph-jsonl-cdc-fnv1a-v1');
    await complete.ctx.drain();

    const pulled = await callApi(worker, bucket, { action: 'pull-manifest' });
    assert.equal(pulled.response.status, 200);
    assert.equal(pulled.payload.remote.snapshotFormat, 'rp-sync-jsonl-v1');
    assert.equal(pulled.payload.remote.schemaVersion, 4);
    assert.equal(pulled.payload.remote.chunkerProfile, 'rph-jsonl-cdc-fnv1a-v1');
    assert.deepEqual(pulled.payload.remote.chunkManifest, [{
        index: 0,
        checksum: chunkChecksum,
        length: bytes.byteLength
    }]);
    const status = await callApi(worker, bucket, { action: 'status' });
    assert.equal(status.payload.remote.snapshotFormat, 'rp-sync-jsonl-v1');
    assert.equal(status.payload.remote.schemaVersion, 4);
    assert.equal(status.payload.remote.chunkerProfile, 'rph-jsonl-cdc-fnv1a-v1');
    assert.equal(status.payload.remote.chunkManifest, undefined, 'status should remain compact');

    const invalidChecksum = await callApi(worker, new FakeR2(), {
        ...body,
        checksum: hex64(123456)
    });
    assert.equal(invalidChecksum.response.status, 400);
    assert.match(invalidChecksum.payload.error, /清单校验/);

    const alternateProfile = await callApi(worker, new FakeR2(), {
        ...body,
        chunkerProfile: 'alternate-profile'
    });
    assert.equal(alternateProfile.response.status, 200, alternateProfile.payload.error);
    assert.equal(alternateProfile.payload.chunkerProfile, 'alternate-profile');

    const invalidProfile = await callApi(worker, new FakeR2(), {
        ...body,
        chunkerProfile: 4
    });
    assert.equal(invalidProfile.response.status, 400);
    assert.match(invalidProfile.payload.error, /快照格式/);

    const baseVersionOnly = await callApi(worker, new FakeR2(), {
        ...body,
        action: 'upload-complete',
        baseVersion: 0
    });
    assert.equal(baseVersionOnly.response.status, 409);
    assert.match(baseVersionOnly.payload.error, /会话版本/);

    const ABSENT = Symbol('absent');
    const storedManifestWithMetadata = (snapshotFormat, schemaVersion, recordCount = 1) => {
        const manifest = makeManifest(1, 991);
        manifest.recordCount = recordCount;
        if (snapshotFormat !== ABSENT) manifest.snapshotFormat = snapshotFormat;
        if (schemaVersion !== ABSENT) manifest.schemaVersion = schemaVersion;
        return manifest;
    };
    const pullStoredManifest = async (manifest) => {
        const manifestBucket = new FakeR2();
        manifestBucket.seedJson(MANIFEST_KEY, manifest);
        return callApi(worker, manifestBucket, { action: 'pull-manifest' });
    };

    const rejectedMetadataPairs = [
        [ABSENT, 4],
        ['rp-sync-jsonl-v1', ABSENT],
        ['rp-sync-jsonl-v1', 3],
        ['rp-sync-json-v3', 4],
        ['rp-sync-jsonl-v2', 5],
        ['rp-sync-jsonl-v2', 4],
        ['rp-sync-jsonl-v1', 5]
    ];
    for (const [snapshotFormat, schemaVersion] of rejectedMetadataPairs) {
        const stored = await pullStoredManifest(storedManifestWithMetadata(snapshotFormat, schemaVersion));
        assert.equal(stored.payload.remote, null);

        const metadata = {
            snapshotFormat: snapshotFormat === ABSENT ? undefined : snapshotFormat,
            schemaVersion: schemaVersion === ABSENT ? undefined : schemaVersion
        };
        const createRejected = await callApi(worker, new FakeR2(), {
            ...body,
            ...metadata,
            action: 'upload-create'
        });
        assert.equal(createRejected.response.status, 400);
        assert.match(createRejected.payload.error, /快照格式/);

        const completeRejected = await callApi(worker, new FakeR2(), {
            ...body,
            ...metadata,
            action: 'upload-complete',
            expectedVersion: 0
        });
        assert.equal(completeRejected.response.status, 400);
        assert.match(completeRejected.payload.error, /快照格式/);
    }

    const acceptedLegacyMetadataPairs = [
        ['rp-sync-json-v3', 3],
        ['rp-sync-json-v3', ABSENT],
        [ABSENT, 3],
        [ABSENT, ABSENT]
    ];
    for (const [snapshotFormat, schemaVersion] of acceptedLegacyMetadataPairs) {
        const stored = await pullStoredManifest(storedManifestWithMetadata(snapshotFormat, schemaVersion));
        assert.notEqual(stored.payload.remote, null);
        assert.equal(stored.payload.remote.snapshotFormat, snapshotFormat === ABSENT ? undefined : snapshotFormat);
        assert.equal(stored.payload.remote.schemaVersion, schemaVersion === ABSENT ? undefined : schemaVersion);

        const acceptedMetadata = {
            snapshotFormat: snapshotFormat === ABSENT ? undefined : snapshotFormat,
            schemaVersion: schemaVersion === ABSENT ? undefined : schemaVersion
        };
        const createAccepted = await callApi(worker, new FakeR2(), {
            ...body,
            ...acceptedMetadata,
            action: 'upload-create'
        });
        assert.equal(createAccepted.response.status, 200, createAccepted.payload.error);
    }

    for (const invalidRecordCount of [-1, 1.5, '7', null, undefined]) {
        const storedManifest = makeManifest(1, 992);
        storedManifest.recordCount = invalidRecordCount;
        const stored = await pullStoredManifest(storedManifest);
        assert.equal(stored.payload.remote, null);

        const createRejected = await callApi(worker, new FakeR2(), {
            ...body,
            action: 'upload-create',
            recordCount: invalidRecordCount
        });
        assert.equal(createRejected.response.status, 400);
        assert.match(createRejected.payload.error, /记录数量/);

        const completeRejected = await callApi(worker, new FakeR2(), {
            ...body,
            action: 'upload-complete',
            recordCount: invalidRecordCount,
            expectedVersion: 0
        });
        assert.equal(completeRejected.response.status, 400);
        assert.match(completeRejected.payload.error, /记录数量/);
    }

    const legacyBucket = new FakeR2();
    const legacyManifest = makeManifest(1, 990);
    legacyManifest.snapshotFormat = 'rp-sync-json-v3';
    legacyManifest.schemaVersion = 3;
    legacyManifest.chunkerProfile = '';
    legacyBucket.seed(legacyManifest.chunkManifest[0].key, new Uint8Array([1]));
    legacyBucket.seedJson(MANIFEST_KEY, legacyManifest);
    const legacyStatus = await callApi(worker, legacyBucket, { action: 'pull-manifest' });
    assert.equal(legacyStatus.payload.remote.snapshotFormat, 'rp-sync-json-v3');
    assert.equal(legacyStatus.payload.remote.schemaVersion, 3);
    assert.equal(legacyStatus.payload.remote.chunkerProfile, '');
}

async function testAppUpdateKeepsBootstrapOrthogonal() {
    const contentsFiles = [
        ...UPSTREAM_FILES,
        'DB/bootstrap.js',
        'DB/char-store.js',
        '_worker.js',
        'wrangler.toml'
    ];
    const fetchState = createUpdateFetch({
        contentsFiles,
        appJs: `${RAW_UPSTREAM_APP_JS}\n// synthetic-1.7.6-marker`
    });
    const updateWorker = await loadWorker({ fetchImpl: fetchState.fetchImpl });
    const bucket = new FakeR2();
    seedReleaseCache(bucket, '1.7.6');
    seedStableAppState(bucket);
    const syncBytes = new TextEncoder().encode(`${[
        { type: 'snapshot', format: 'rp-sync-jsonl-v1', schemaVersion: 4 },
        { type: 'localStorage', key: 'rp_hub_before_update', value: '1.7.5' },
        { type: 'localStorageEnd' },
        { type: 'snapshotEnd', recordCount: 1 }
    ].map((line) => JSON.stringify(line)).join('\n')}\n`);
    const syncChunkChecksum = await sha256Hex(syncBytes);
    const syncChunkManifest = [{ index: 0, checksum: syncChunkChecksum, length: syncBytes.byteLength }];
    const syncManifest = {
        version: 1,
        checksum: await buildV4ManifestChecksum({
            recordCount: 1,
            totalBytes: syncBytes.byteLength,
            chunkManifest: syncChunkManifest
        }),
        snapshotFormat: 'rp-sync-jsonl-v1',
        schemaVersion: 4,
        chunkerProfile: 'rph-jsonl-cdc-fnv1a-v1',
        updatedAt: Date.now(),
        recordCount: 1,
        totalBytes: syncBytes.byteLength,
        chunkSize: 2 * 1024 * 1024,
        chunkCount: 1,
        chunkManifest: syncChunkManifest,
        mode: 'r2-chunk-manifest-v1'
    };
    bucket.seed(chunkKey(syncChunkChecksum), syncBytes);
    bucket.seedJson(MANIFEST_KEY, syncManifest);
    const beforeUpdateManifest = await callApi(updateWorker, bucket, { action: 'pull-manifest' });
    assert.equal(beforeUpdateManifest.response.status, 200);
    assert.equal(beforeUpdateManifest.payload.remote.checksum, syncManifest.checksum);
    assert.equal(beforeUpdateManifest.payload.remote.snapshotFormat, syncManifest.snapshotFormat);
    assert.equal(beforeUpdateManifest.payload.remote.schemaVersion, syncManifest.schemaVersion);
    assert.equal(beforeUpdateManifest.payload.remote.chunkerProfile, syncManifest.chunkerProfile);
    assert.deepEqual(beforeUpdateManifest.payload.remote.chunkManifest, syncChunkManifest);
    const beforeUpdatePull = await updateWorker.fetch(new Request(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pull-json-part', version: 1, start: 0, count: 1 })
    }), { RP_SYNC_R2: bucket }, new WaitUntilContext());
    assert.equal(beforeUpdatePull.status, 200);
    const beforeUpdateBytes = new Uint8Array(await beforeUpdatePull.arrayBuffer());
    assert.deepEqual([...beforeUpdateBytes], [...syncBytes]);
    const beforeSyncKeys = bucket.keys('rp-sync/');
    const applied = await callApi(updateWorker, bucket, { action: 'app-update-apply', target: '1.7.6' });
    assert.equal(applied.response.status, 200, applied.payload.error);
    await applied.ctx.drain();
    const updateManifest = bucket.json(APP_UPDATE_MANIFEST_KEY);
    const updateFiles = updateManifest.current.files || [];
    assert(!updateFiles.some((file) => ['DB/bootstrap.js', 'DB/char-store.js', '_worker.js', 'wrangler.toml'].includes(file.path)));
    assert(!fetchState.calls.some((url) => /DB\/bootstrap\.js|DB\/char-store\.js|_worker\.js|wrangler\.toml/.test(url)));

    const bootstrapSource = await fs.readFile(path.join(ROOT_DIR, 'DB', 'bootstrap.js'), 'utf8');
    const servedBootstrap = await updateWorker.fetch(new Request('https://worker.test/DB/bootstrap.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: { fetch: async () => new Response(bootstrapSource) }
    }, new WaitUntilContext());
    assert.equal(await servedBootstrap.text(), bootstrapSource);
    const servedApp = await updateWorker.fetch(new Request('https://worker.test/assets/js/app.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: { fetch: async () => new Response('bundled-fallback') }
    }, new WaitUntilContext());
    assert.match(await servedApp.text(), /synthetic-1\.7\.6-marker/);
    assert.equal(bucket.keys('rp-sync/').join('|'), beforeSyncKeys.join('|'));

    const afterUpdateManifest = await callApi(updateWorker, bucket, { action: 'pull-manifest' });
    assert.equal(afterUpdateManifest.response.status, 200);
    assert.deepEqual(afterUpdateManifest.payload.remote, beforeUpdateManifest.payload.remote);
    const afterUpdatePull = await updateWorker.fetch(new Request(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            action: 'pull-json-part',
            version: afterUpdateManifest.payload.remote.version,
            start: 0,
            count: 1
        })
    }), { RP_SYNC_R2: bucket }, new WaitUntilContext());
    assert.equal(afterUpdatePull.status, 200);
    assert.deepEqual([...new Uint8Array(await afterUpdatePull.arrayBuffer())], [...beforeUpdateBytes]);

    const snapshotRecordCount = 1;
    const snapshotBytes = new TextEncoder().encode(`${[
        { type: 'snapshot', format: 'rp-sync-jsonl-v1', schemaVersion: 4 },
        { type: 'localStorage', key: 'rp_hub_cdc_update_test', value: '1.7.6' },
        { type: 'localStorageEnd' },
        { type: 'snapshotEnd', recordCount: snapshotRecordCount }
    ].map((line) => JSON.stringify(line)).join('\n')}\n`);
    const offsets = [
        0,
        Math.floor(snapshotBytes.byteLength / 3),
        Math.floor((snapshotBytes.byteLength * 2) / 3),
        snapshotBytes.byteLength
    ];
    const cdcChunks = [];
    for (let index = 0; index < offsets.length - 1; index += 1) {
        const bytes = snapshotBytes.subarray(offsets[index], offsets[index + 1]);
        cdcChunks.push({
            index,
            bytes,
            checksum: await sha256Hex(bytes),
            length: bytes.byteLength
        });
    }
    const chunkManifest = cdcChunks.map(({ index, checksum, length }) => ({ index, checksum, length }));
    const snapshotChecksum = await buildV4ManifestChecksum({
        recordCount: snapshotRecordCount,
        totalBytes: snapshotBytes.byteLength,
        chunkManifest
    });
    const snapshotMetadata = {
        snapshotFormat: 'rp-sync-jsonl-v1',
        schemaVersion: 4,
        chunkerProfile: 'rph-jsonl-cdc-fnv1a-v1'
    };
    const create = await callApi(updateWorker, bucket, {
        action: 'upload-create',
        checksum: snapshotChecksum,
        ...snapshotMetadata,
        recordCount: snapshotRecordCount,
        chunkSize: 2 * 1024 * 1024,
        chunkCount: cdcChunks.length,
        totalBytes: snapshotBytes.byteLength,
        chunkManifest
    });
    assert.equal(create.response.status, 200, create.payload.error);
    assert.deepEqual(create.payload.missingIndices, [0, 1, 2]);
    assert.equal(create.payload.snapshotFormat, snapshotMetadata.snapshotFormat);
    assert.equal(create.payload.schemaVersion, snapshotMetadata.schemaVersion);
    assert.equal(create.payload.chunkerProfile, snapshotMetadata.chunkerProfile);
    for (const chunk of cdcChunks) {
        const uploaded = await updateWorker.fetch(new Request(
            `${API_URL}?action=upload-part&index=${chunk.index}&partNumber=${chunk.index + 1}`,
            {
                method: 'POST',
                headers: {
                    'x-rp-part-checksum': chunk.checksum,
                    'x-rp-part-length': String(chunk.length)
                },
                body: chunk.bytes
            }
        ), { RP_SYNC_R2: bucket }, new WaitUntilContext());
        assert.equal(uploaded.status, 200, await uploaded.text());
    }
    const complete = await callApi(updateWorker, bucket, {
        action: 'upload-complete',
        checksum: snapshotChecksum,
        ...snapshotMetadata,
        recordCount: snapshotRecordCount,
        chunkSize: 2 * 1024 * 1024,
        chunkCount: cdcChunks.length,
        totalBytes: snapshotBytes.byteLength,
        chunkManifest,
        expectedVersion: create.payload.previousVersion
    });
    assert.equal(complete.response.status, 200, complete.payload.error);
    assert.equal(complete.payload.snapshotFormat, snapshotMetadata.snapshotFormat);
    assert.equal(complete.payload.schemaVersion, snapshotMetadata.schemaVersion);
    assert.equal(complete.payload.chunkerProfile, snapshotMetadata.chunkerProfile);
    await complete.ctx.drain();
    const pullManifest = await callApi(updateWorker, bucket, { action: 'pull-manifest' });
    assert.equal(pullManifest.response.status, 200);
    assert.equal(pullManifest.payload.remote.checksum, snapshotChecksum);
    assert.equal(pullManifest.payload.remote.snapshotFormat, snapshotMetadata.snapshotFormat);
    assert.equal(pullManifest.payload.remote.schemaVersion, snapshotMetadata.schemaVersion);
    assert.equal(pullManifest.payload.remote.chunkerProfile, snapshotMetadata.chunkerProfile);
    assert.equal(pullManifest.payload.remote.recordCount, snapshotRecordCount);
    assert.deepEqual(pullManifest.payload.remote.chunkManifest, chunkManifest);
    const pulled = await updateWorker.fetch(new Request(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            action: 'pull-json-part',
            version: pullManifest.payload.remote.version,
            start: 0,
            count: cdcChunks.length
        })
    }), { RP_SYNC_R2: bucket }, new WaitUntilContext());
    assert.equal(pulled.status, 200);
    const pulledBytes = new Uint8Array(await pulled.arrayBuffer());
    assert.deepEqual([...pulledBytes], [...snapshotBytes]);
    assert.equal(pullManifest.payload.remote.totalBytes, pulledBytes.byteLength);
    assert.equal(
        await buildV4ManifestChecksum({
            recordCount: pullManifest.payload.remote.recordCount,
            totalBytes: pullManifest.payload.remote.totalBytes,
            chunkManifest: pullManifest.payload.remote.chunkManifest
        }),
        snapshotChecksum
    );
}

async function testStaticInvariants() {
    const source = await fs.readFile(WORKER_FILE, 'utf8');
    assert.match(source, /import\s*\{[\s\S]*patchRpHubAppJs[\s\S]*RpHubAppPatchError[\s\S]*RP_HUB_APP_PATCH_REVISION[\s\S]*\}\s*from '\.\/DB\/app-patches\.mjs';/);
    assert(source.indexOf('/DB/char-store.js?v=r2-rebuild-1') < source.indexOf('/DB/bootstrap.js?v=r2-rebuild-1'));
    assert(source.includes("const CURRENT_UPSTREAM_VERSION = '1.7.5';"));
    assert(source.includes('const MAX_PULL_CHUNKS = 8;'));
    assert(source.includes('const MAX_PART_BYTES = 64 * 1024 * 1024;'));
    assert(source.includes('const MAX_APP_UPDATE_FILES = 32;'));
    assert(source.includes('const MAX_APP_UPDATE_EXTERNAL_REQUESTS = 50;'));
    assert(source.includes('const MAX_APP_UPDATE_REDIRECTS = 5;'));
    assert(source.includes('const APP_UPDATE_FILE_CONCURRENCY = 4;'));
    assert(source.includes("const STREAM_SNAPSHOT_FORMAT = 'rp-sync-jsonl-v1';"));
    assert(source.includes('const STREAM_SNAPSHOT_SCHEMA_VERSION = 4;'));
    assert(source.includes("const LEGACY_SNAPSHOT_FORMAT = 'rp-sync-json-v3';"));
    assert(!source.includes('FALLBACK_UPSTREAM_FILES'));
    assert(!source.includes('fallback-list'));
    assert(!source.includes('copyStoredFiles'));
    assert(!source.includes('const startUpdateCountdown'));
    assert.equal((source.match(/patchRpHubAppJs\(/g) || []).length, 1);
    assert(source.includes("redirect: 'manual'"));
    assert(!source.includes('scheduleUnusedChunkCleanup'));
    assert(!source.includes("body.action === 'pull-part'"));
    assert(!source.includes('baseVersion'));
    assert.equal(
        source.includes('IMAGE_API_PATH'),
        source.includes('/DB/image-module.js?v=r2-img-1'),
        'image API routes must only exist when the image overlay is injected'
    );
}

async function testAppUpdatePatchRejection(worker) {
    const bucket = new FakeR2();
    seedReleaseCache(bucket, '9.9.9', 'storage API renamed');
    const oldApp = '/* patched current app */';
    bucket.seed(`${APP_UPDATE_PREFIX}/current/assets/js/app.js`, oldApp);
    bucket.seedJson(APP_UPDATE_MANIFEST_KEY, {
        current: {
            upstreamTag: '1.7.5',
            upstreamSha: '1.7.5',
            files: [{ path: 'assets/js/app.js' }]
        },
        previous: null
    });

    const result = await callApi(worker, bucket, { action: 'app-update-apply', target: '9.9.9' });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.code, 'RP_HUB_APP_PATCH_REJECTED');
    assert.match(result.payload.error, /上游 9\.9\.9 改动了角色卡存储接口/);
    assert.equal(bucket.json(APP_UPDATE_MANIFEST_KEY).current.upstreamTag, '1.7.5');
    assert.equal(readStoredText(bucket, `${APP_UPDATE_PREFIX}/current/assets/js/app.js`), oldApp);
    assert.equal(bucket.keys(`${APP_UPDATE_PREFIX}/versions/`).length, 0);
}

async function testStaleAppOverlayFallsBackToBundle(worker) {
    const bucket = new FakeR2();
    bucket.seed('rp-app-update/current/assets/js/app.js', 'stale-unpatched-overlay');
    bucket.seedJson('rp-app-update/manifest.json', {
        current: {
            upstreamTag: '1.7.5',
            upstreamSha: '1.7.5',
            files: [{ path: 'assets/js/app.js' }]
        },
        previous: null
    });
    const response = await worker.fetch(new Request('https://worker.test/assets/js/app.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: {
            fetch: async () => new Response('bundled-patched-app', {
                headers: { 'content-type': 'application/javascript; charset=utf-8' }
            })
        }
    }, new WaitUntilContext());
    assert.equal(await response.text(), 'bundled-patched-app');
}

async function testSameTagAppUpdateIsRepatched(worker) {
    const bucket = new FakeR2();
    seedReleaseCache(bucket, '1.7.5', 'same tag, stale patch revision');
    bucket.seed('rp-app-update/current/assets/js/app.js', 'stale-unpatched-overlay');
    bucket.seedJson('rp-app-update/manifest.json', {
        current: {
            upstreamTag: '1.7.5',
            upstreamSha: '1.7.5',
            files: [{ path: 'assets/js/app.js' }]
        },
        previous: null
    });

    const applied = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.5' });
    assert.equal(applied.response.status, 200, applied.payload.error);
    assert.equal(applied.payload.alreadyUpToDate, false);
    const manifest = bucket.json(APP_UPDATE_MANIFEST_KEY);
    assert.equal(manifest.current.patchRevision, PATCH_REVISION);
    assert.equal(manifest.current.upstreamTag, '1.7.5');
    assert.equal(manifest.previous, null);
    assert.match(manifest.current.slot, /^versions\/1\.7\.5-/);
    const patchedApp = readStoredText(bucket, `${APP_UPDATE_PREFIX}/${manifest.current.slot}/assets/js/app.js`);
    assert.match(patchedApp, /RPH_R2_FLUSH_PERSISTENCE/);
    assert.doesNotMatch(patchedApp, /setStoredValue\(\s*'characters'/);

    const repeated = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.5' });
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.payload.alreadyUpToDate, true);

    const served = await worker.fetch(new Request('https://worker.test/assets/js/app.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: { fetch: async () => new Response('bundled-fallback') }
    }, new WaitUntilContext());
    assert.match(await served.text(), /RPH_R2_FLUSH_PERSISTENCE/);
}

async function test181DynamicUpdateAndRollback(worker, fetchState) {
    const bucket = new FakeR2();
    seedReleaseCache(bucket, '1.8.1');
    const current = seedAppVersion(bucket, 'versions/current-1.8.0', '1.8.0', UPSTREAM_FILES);
    const previous = seedAppVersion(bucket, 'versions/previous-1.7.9', '1.7.9', UPSTREAM_FILES);
    bucket.seedJson(APP_UPDATE_MANIFEST_KEY, {
        upstreamRepo: 'STA1N156/RP-Hub',
        upstreamBranch: 'main',
        updatedAt: Date.now(),
        current,
        previous
    });
    const syncSentinel = {
        version: 181,
        checksum: 'sync-data-must-not-change',
        records: ['characters', 'chat', 'settings', 'image-records']
    };
    bucket.seedJson(MANIFEST_KEY, syncSentinel);

    const applied = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.8.1' });
    assert.equal(applied.response.status, 200, applied.payload.error);
    const manifest = bucket.json(APP_UPDATE_MANIFEST_KEY);
    assert.equal(manifest.current.upstreamTag, '1.8.1');
    assert.equal(manifest.current.patchRevision, PATCH_REVISION);
    assert.equal(manifest.previous.slot, current.slot);
    assert.deepEqual(
        manifest.current.files.map((file) => file.path),
        [...UPSTREAM_181_FILES].sort((left, right) => left.localeCompare(right))
    );
    for (const filePath of [
        'assets/js/built-in-content.js',
        'assets/js/core-utils.js',
        'assets/js/data-services.js',
        'assets/js/runtime-services.js',
        'assets/js/ui-components.js'
    ]) {
        assert(bucket.has(`${APP_UPDATE_PREFIX}/${manifest.current.slot}/${filePath}`),
            `1.8.1 dynamic file was not stored: ${filePath}`);
        assert(fetchState.calls.some((url) => url.includes(`/${filePath}`)),
            `1.8.1 dynamic file was not downloaded: ${filePath}`);
    }
    for (const filePath of ['assets/js/card-utils.js', 'assets/js/ui-select.js', 'assets/js/utils.js']) {
        assert.equal(bucket.has(`${APP_UPDATE_PREFIX}/${manifest.current.slot}/${filePath}`), false,
            `1.8.0-only file leaked into the 1.8.1 slot: ${filePath}`);
    }
    const patchedApp = readStoredText(
        bucket,
        `${APP_UPDATE_PREFIX}/${manifest.current.slot}/assets/js/app.js`
    );
    assert.match(patchedApp, /RPH_R2_FLUSH_PERSISTENCE/);
    assert.match(patchedApp, /\} = window\.RPHubStorage;/);
    assert.doesNotMatch(patchedApp, /setStoredValue\(\s*'characters'/);
    assert.doesNotMatch(patchedApp, /return deferWrite\(\(\) => dbSetTo/);
    assert.deepEqual(bucket.json(MANIFEST_KEY), syncSentinel,
        '1.8.0 to 1.8.1 update changed sync or image-record data');

    const servedDataServices = await worker.fetch(
        new Request('https://worker.test/assets/js/data-services.js'),
        {
            RP_SYNC_R2: bucket,
            ASSETS: { fetch: async () => new Response('bundled-fallback') }
        },
        new WaitUntilContext()
    );
    assert.match(await servedDataServices.text(), /upstream:/,
        '1.8.1 data-services.js was not served from the active overlay');

    const rolledBack = await callApi(worker, bucket, { action: 'app-update-rollback' });
    assert.equal(rolledBack.response.status, 200, rolledBack.payload.error);
    const rollbackManifest = bucket.json(APP_UPDATE_MANIFEST_KEY);
    assert.equal(rollbackManifest.current.slot, current.slot);
    assert.equal(rollbackManifest.current.upstreamTag, '1.8.0');
    assert.equal(rollbackManifest.previous.upstreamTag, '1.8.1');
    assert.deepEqual(bucket.json(MANIFEST_KEY), syncSentinel,
        '1.8.1 to 1.8.0 rollback changed sync or image-record data');
    const servedOldApp = await worker.fetch(
        new Request('https://worker.test/assets/js/app.js'),
        {
            RP_SYNC_R2: bucket,
            ASSETS: { fetch: async () => new Response('bundled-fallback') }
        },
        new WaitUntilContext()
    );
    assert.equal(await servedOldApp.text(), '1.8.0:assets/js/app.js');
}

async function testRollbackRejectsStalePatchRevision(worker) {
    const bucket = new FakeR2();
    bucket.seed('rp-app-update/current/assets/js/app.js', 'safe-current');
    bucket.seed('rp-app-update/previous/assets/js/app.js', 'unsafe-previous');
    bucket.seedJson('rp-app-update/manifest.json', {
        current: {
            patchRevision: PATCH_REVISION,
            upstreamTag: '1.7.5',
            upstreamSha: '1.7.5',
            files: [{ path: 'assets/js/app.js' }]
        },
        previous: {
            upstreamTag: '1.7.4',
            upstreamSha: '1.7.4',
            files: [{ path: 'assets/js/app.js' }]
        }
    });

    const rollback = await callApi(worker, bucket, { action: 'app-update-rollback' });
    assert.equal(rollback.response.status, 409);
    assert.equal(rollback.payload.code, 'RP_HUB_APP_ROLLBACK_PATCH_MISMATCH');
    assert.equal(new TextDecoder().decode(bucket.records.get('rp-app-update/current/assets/js/app.js').bytes), 'safe-current');
    assert.equal(bucket.json('rp-app-update/manifest.json').current.upstreamTag, '1.7.5');
}

async function testContentsFailureRejectsUpdate(worker, fetchState) {
    const bucket = new FakeR2();
    seedReleaseCache(bucket, '1.7.6');
    seedStableAppState(bucket);
    const before = snapshotAppVersion(bucket);
    const beforeKeys = bucket.keys(`${APP_UPDATE_PREFIX}/`);

    const result = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.6' });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.code, 'RP_HUB_APP_FILE_LIST_FAILED');
    assert.match(result.payload.error, /完整文件列表失败/);
    assertAppVersionSnapshot(bucket, before);
    assert.deepEqual(bucket.keys(`${APP_UPDATE_PREFIX}/`), beforeKeys);
    assert.equal(fetchState.calls.filter((url) => !url.includes('/contents/')).length, 0);

    const served = await worker.fetch(new Request('https://worker.test/assets/js/app.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: { fetch: async () => new Response('bundled-fallback') }
    }, new WaitUntilContext());
    assert.equal(await served.text(), '1.7.5:assets/js/app.js');
}

async function testDownloadFailureKeepsCurrent(worker) {
    const bucket = new FakeR2();
    seedReleaseCache(bucket, '1.7.6');
    seedStableAppState(bucket);
    const before = snapshotAppVersion(bucket);
    const beforeKeys = bucket.keys(`${APP_UPDATE_PREFIX}/`);

    const result = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.6' });
    assert.equal(result.response.status, 500);
    assertAppVersionSnapshot(bucket, before);
    assert.deepEqual(bucket.keys(`${APP_UPDATE_PREFIX}/`), beforeKeys);
}

async function testSlotWriteFailureKeepsCurrent(worker) {
    const bucket = new FaultInjectingR2();
    seedReleaseCache(bucket, '1.7.6');
    seedStableAppState(bucket);
    const before = snapshotAppVersion(bucket);
    const beforeKeys = bucket.keys(`${APP_UPDATE_PREFIX}/`);
    bucket.failNextPut((key) => key.includes('/versions/') && key.endsWith('/assets/css/styles.css'));

    const result = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.6' });
    assert.equal(result.response.status, 500);
    assertAppVersionSnapshot(bucket, before);
    assert.deepEqual(bucket.keys(`${APP_UPDATE_PREFIX}/`), beforeKeys);
}

async function testManifestFailureKeepsCurrent(worker, failureMode, expectedStatus) {
    const bucket = new FaultInjectingR2();
    seedReleaseCache(bucket, '1.7.6');
    seedStableAppState(bucket);
    const before = snapshotAppVersion(bucket);
    const beforeKeys = bucket.keys(`${APP_UPDATE_PREFIX}/`);
    bucket.failNextPut((key) => key === APP_UPDATE_MANIFEST_KEY, failureMode);

    const result = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.6' });
    assert.equal(result.response.status, expectedStatus);
    if (failureMode === 'return-null') assert.equal(result.payload.code, 'RP_HUB_APP_UPDATE_CONFLICT');
    assertAppVersionSnapshot(bucket, before);
    assert.deepEqual(bucket.keys(`${APP_UPDATE_PREFIX}/`), beforeKeys);
}

async function testManifestThrowAfterCommitIsRecovered(worker) {
    const bucket = new FaultInjectingR2();
    seedReleaseCache(bucket, '1.7.6');
    seedStableAppState(bucket);
    bucket.failNextPut((key) => key === APP_UPDATE_MANIFEST_KEY, 'throw-after');
    const result = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.6' });
    assert.equal(result.response.status, 200, result.payload.error);
    const manifest = bucket.json(APP_UPDATE_MANIFEST_KEY);
    assert.match(manifest.current.slot, /^versions\/1\.7\.6-/);
    assert(bucket.keys(`${APP_UPDATE_PREFIX}/${manifest.current.slot}/`).length > 0);
    await result.ctx.drain();
}

async function testAtomicApplyAndRollback(worker) {
    const bucket = new FakeR2();
    seedReleaseCache(bucket, '1.7.6');
    const oldManifest = seedStableAppState(bucket);
    const oldCurrentSlot = oldManifest.current.slot;
    const oldPreviousSlot = oldManifest.previous.slot;

    const applied = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.6' });
    assert.equal(applied.response.status, 200, applied.payload.error);
    const committed = bucket.json(APP_UPDATE_MANIFEST_KEY);
    const newSlot = committed.current.slot;
    assert.match(newSlot, /^versions\/1\.7\.6-/);
    assert.notEqual(newSlot, oldCurrentSlot);
    assert.equal(committed.previous.slot, oldCurrentSlot);
    assert.equal(readStoredText(bucket, `${APP_UPDATE_PREFIX}/${oldCurrentSlot}/assets/js/app.js`), '1.7.5:assets/js/app.js');
    assert.match(readStoredText(bucket, `${APP_UPDATE_PREFIX}/${newSlot}/assets/js/app.js`), /RPH_R2_FLUSH_PERSISTENCE/);
    const manifestPut = bucket.putCalls.find((call) => call.key === APP_UPDATE_MANIFEST_KEY);
    assert.equal(manifestPut.onlyIf.etagMatches.startsWith('"'), false);
    await applied.ctx.drain();
    assert.equal(bucket.keys(`${APP_UPDATE_PREFIX}/${oldPreviousSlot}/`).length, 0);
    assert(bucket.keys(`${APP_UPDATE_PREFIX}/${oldCurrentSlot}/`).length > 0);
    assert(bucket.keys(`${APP_UPDATE_PREFIX}/${newSlot}/`).length > 0);

    const servedNew = await worker.fetch(new Request('https://worker.test/assets/js/app.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: { fetch: async () => new Response('bundled-fallback') }
    }, new WaitUntilContext());
    assert.match(await servedNew.text(), /RPH_R2_FLUSH_PERSISTENCE/);

    bucket.resetOperationCount();
    const rolledBack = await callApi(worker, bucket, { action: 'app-update-rollback' });
    assert.equal(rolledBack.response.status, 200, rolledBack.payload.error);
    const rollbackManifest = bucket.json(APP_UPDATE_MANIFEST_KEY);
    assert.equal(rollbackManifest.current.slot, oldCurrentSlot);
    assert.equal(rollbackManifest.previous.slot, newSlot);
    assert.deepEqual(bucket.putCalls.map((call) => call.key), [APP_UPDATE_MANIFEST_KEY]);
    assert.equal(bucket.deleteBatches.length, 0);
    const servedOld = await worker.fetch(new Request('https://worker.test/assets/js/app.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: { fetch: async () => new Response('bundled-fallback') }
    }, new WaitUntilContext());
    assert.equal(await servedOld.text(), '1.7.5:assets/js/app.js');

    const restored = await callApi(worker, bucket, { action: 'app-update-rollback' });
    assert.equal(restored.response.status, 200, restored.payload.error);
    assert.equal(bucket.json(APP_UPDATE_MANIFEST_KEY).current.slot, newSlot);
}

async function testLegacyFixedSlotRollback(worker) {
    const bucket = new FakeR2();
    const current = seedAppVersion(bucket, 'current', 'legacy-current');
    const previous = seedAppVersion(bucket, 'previous', 'legacy-previous');
    delete current.slot;
    delete previous.slot;
    bucket.seedJson(APP_UPDATE_MANIFEST_KEY, { current, previous });

    const servedCurrent = await worker.fetch(new Request('https://worker.test/assets/js/app.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: { fetch: async () => new Response('bundled-fallback') }
    }, new WaitUntilContext());
    assert.equal(await servedCurrent.text(), 'legacy-current:assets/js/app.js');
    bucket.resetOperationCount();
    const rollback = await callApi(worker, bucket, { action: 'app-update-rollback' });
    assert.equal(rollback.response.status, 200, rollback.payload.error);
    const manifest = bucket.json(APP_UPDATE_MANIFEST_KEY);
    assert.equal(manifest.current.slot, 'previous');
    assert.equal(manifest.previous.slot, 'current');
    assert.deepEqual(bucket.putCalls.map((call) => call.key), [APP_UPDATE_MANIFEST_KEY]);
    assert.equal(bucket.deleteBatches.length, 0);
    const servedPrevious = await worker.fetch(new Request('https://worker.test/assets/js/app.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: { fetch: async () => new Response('bundled-fallback') }
    }, new WaitUntilContext());
    assert.equal(await servedPrevious.text(), 'legacy-previous:assets/js/app.js');
}

async function testRollbackManifestFailureKeepsPointers(worker) {
    const bucket = new FaultInjectingR2();
    seedStableAppState(bucket);
    const before = snapshotAppVersion(bucket);
    const beforeKeys = bucket.keys(`${APP_UPDATE_PREFIX}/`);
    bucket.failNextPut((key) => key === APP_UPDATE_MANIFEST_KEY);
    const rollback = await callApi(worker, bucket, { action: 'app-update-rollback' });
    assert.equal(rollback.response.status, 500);
    assertAppVersionSnapshot(bucket, before);
    assert.deepEqual(bucket.keys(`${APP_UPDATE_PREFIX}/`), beforeKeys);
}

async function testAmbiguousCommitSupersededKeepsPreviousSlot(worker) {
    const bucket = new SupersedingManifestR2();
    bucket.seedJson(APP_RELEASE_CACHE_KEY, {
        cachedAt: Date.now(),
        versions: ['1.7.7', '1.7.6'].map((tag) => ({
            tag,
            sha: tag,
            shortSha: tag,
            name: tag,
            date: '',
            message: tag
        }))
    });
    seedStableAppState(bucket);
    const firstCtx = new WaitUntilContext();
    const firstApplyPromise = callApi(
        worker,
        bucket,
        { action: 'app-update-apply', target: '1.7.6' },
        firstCtx
    );
    await bucket.firstManifestCommitted;
    const slotA = bucket.firstCommittedSlot;
    assert.match(slotA, /^versions\/1\.7\.6-/);

    const secondApply = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.7' });
    assert.equal(secondApply.response.status, 200, secondApply.payload.error);
    const supersedingManifest = bucket.json(APP_UPDATE_MANIFEST_KEY);
    assert.match(supersedingManifest.current.slot, /^versions\/1\.7\.7-/);
    assert.equal(supersedingManifest.previous.slot, slotA);

    bucket.releaseAmbiguousManifestPut();
    const firstApply = await firstApplyPromise;
    assert.equal(firstApply.response.status, 200, firstApply.payload.error);
    await Promise.all([firstCtx.drain(), secondApply.ctx.drain()]);
    assert(bucket.keys(`${APP_UPDATE_PREFIX}/${slotA}/`).length > 0, 'adopted slotA was deleted by A cleanup');

    const rollback = await callApi(worker, bucket, { action: 'app-update-rollback' });
    assert.equal(rollback.response.status, 200, rollback.payload.error);
    assert.equal(bucket.json(APP_UPDATE_MANIFEST_KEY).current.slot, slotA);
    const served = await worker.fetch(new Request('https://worker.test/assets/js/app.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: { fetch: async () => new Response('bundled-fallback') }
    }, new WaitUntilContext());
    assert.match(await served.text(), /RPH_R2_FLUSH_PERSISTENCE/);
}

async function testDelayedCleanupRereadsLatestPointers(worker) {
    const bucket = new CleanupManifestReadBarrierR2();
    seedReleaseCache(bucket, '1.7.6');
    const oldManifest = seedStableAppState(bucket);
    const rescuedSlot = oldManifest.previous.slot;
    bucket.armCleanupReadBarrier();

    const applied = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.6' });
    assert.equal(applied.response.status, 200, applied.payload.error);
    await bucket.cleanupReadStarted;

    const latestObject = await bucket.get(APP_UPDATE_MANIFEST_KEY);
    const latestManifest = JSON.parse(await latestObject.text());
    const switchedManifest = {
        upstreamRepo: 'STA1N156/RP-Hub',
        upstreamBranch: 'main',
        updatedAt: Date.now(),
        current: oldManifest.previous,
        previous: latestManifest.current
    };
    const switched = await bucket.put(APP_UPDATE_MANIFEST_KEY, JSON.stringify(switchedManifest), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        onlyIf: { etagMatches: latestObject.etag }
    });
    assert(switched, 'concurrent rollback-style pointer switch failed');

    bucket.releaseCleanupRead();
    await applied.ctx.drain();
    assert(bucket.keys(`${APP_UPDATE_PREFIX}/${rescuedSlot}/`).length > 0, 'latest current slot was deleted by stale cleanup');
    assert.equal(bucket.json(APP_UPDATE_MANIFEST_KEY).current.slot, rescuedSlot);
    const served = await worker.fetch(new Request('https://worker.test/assets/js/app.js'), {
        RP_SYNC_R2: bucket,
        ASSETS: { fetch: async () => new Response('bundled-fallback') }
    }, new WaitUntilContext());
    assert.equal(await served.text(), '1.7.4:assets/js/app.js');
}

async function testExternalRequestBudget(worker, fetchState) {
    const bucket = new FakeR2();
    seedReleaseCache(bucket, '2.0.0');
    seedStableAppState(bucket);
    const before = snapshotAppVersion(bucket);
    const result = await callApi(worker, bucket, { action: 'app-update-apply', target: '2.0.0' });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.code, 'RP_HUB_APP_UPDATE_REQUEST_LIMIT');
    assert.equal(fetchState.calls.length, 50);
    assert(fetchState.calls.some((url) => url.includes('rph-hop=1')), 'relative redirect location was not followed');
    assert(fetchState.requestOptions.every((options) => options.redirect === 'manual'));
    assert(fetchState.maxActive <= 4, `update fetch concurrency reached ${fetchState.maxActive}`);
    assert(fetchState.maxActive > 1);
    assertAppVersionSnapshot(bucket, before);
}

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
}

async function waitForServer(baseUrl, child, output) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited early.\n${output.join('')}`);
        try {
            const response = await fetch(baseUrl);
            if (response.ok) return;
        } catch {
            // The local listener is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Wrangler did not start in time.\n${output.join('')}`);
}

async function wranglerPost(baseUrl, body) {
    const response = await fetch(`${baseUrl}/api/rp-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { response, payload: await response.json() };
}

async function realChunk(seed) {
    const bytes = new Uint8Array([seed & 0xff]);
    const digest = await webcrypto.subtle.digest('SHA-256', bytes);
    const checksum = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return { bytes, checksum };
}

async function wranglerUploadPart(baseUrl, chunk) {
    const response = await fetch(`${baseUrl}/api/rp-sync?action=upload-part&partNumber=1&index=0`, {
        method: 'POST',
        headers: {
            'x-rp-part-checksum': chunk.checksum,
            'x-rp-part-length': String(chunk.bytes.byteLength)
        },
        body: chunk.bytes
    });
    const payload = await response.json();
    assert.equal(response.status, 200, payload.error);
}

function realUploadBody(seed, chunk, expectedVersion) {
    return {
        checksum: hex64(9000 + seed),
        recordCount: 1,
        chunkSize: 1,
        chunkCount: 1,
        totalBytes: 1,
        chunkManifest: [{ index: 0, checksum: chunk.checksum, length: 1 }],
        expectedVersion
    };
}

async function testRealWrangler() {
    const harnessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-r2-worker-test-'));
    const persistDir = path.join(harnessDir, 'persist');
    await fs.copyFile(path.join(ROOT_DIR, 'wrangler.toml'), path.join(harnessDir, 'wrangler.toml'));
    const port = await getFreePort();
    const output = [];
    const wranglerScript = process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
        : '';
    const command = wranglerScript && existsSync(wranglerScript) ? process.execPath : 'wrangler';
    const commandArgs = [
        'pages', 'dev', ROOT_DIR,
        '--port', String(port),
        '--persist-to', persistDir,
        '--compatibility-date', '2026-06-06',
        '--log-level', 'error',
        '--show-interactive-dev-session=false'
    ];
    if (command === process.execPath) commandArgs.unshift(wranglerScript);
    const child = spawn(command, commandArgs, {
        cwd: harnessDir,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
        await waitForServer(baseUrl, child, output);
        const html = await (await fetch(baseUrl)).text();
        assert(html.indexOf('/DB/char-store.js?v=r2-rebuild-1') < html.indexOf('/DB/bootstrap.js?v=r2-rebuild-1'));

        const firstChunk = await realChunk(1);
        const firstBody = realUploadBody(1, firstChunk, 0);
        const firstCreate = await wranglerPost(baseUrl, { action: 'upload-create', ...firstBody });
        assert.equal(firstCreate.payload.previousVersion, 0);
        await wranglerUploadPart(baseUrl, firstChunk);
        const firstComplete = await wranglerPost(baseUrl, { action: 'upload-complete', ...firstBody });
        assert.equal(firstComplete.response.status, 200, firstComplete.payload.error);
        assert.equal(firstComplete.payload.version, 1);

        const leftChunk = await realChunk(2);
        const rightChunk = await realChunk(3);
        const leftBody = realUploadBody(2, leftChunk, 1);
        const rightBody = realUploadBody(3, rightChunk, 1);
        const [leftCreate, rightCreate] = await Promise.all([
            wranglerPost(baseUrl, { action: 'upload-create', ...leftBody }),
            wranglerPost(baseUrl, { action: 'upload-create', ...rightBody })
        ]);
        assert.equal(leftCreate.payload.previousVersion, 1);
        assert.equal(rightCreate.payload.previousVersion, 1);
        await Promise.all([wranglerUploadPart(baseUrl, leftChunk), wranglerUploadPart(baseUrl, rightChunk)]);
        const concurrent = await Promise.all([
            wranglerPost(baseUrl, { action: 'upload-complete', ...leftBody }),
            wranglerPost(baseUrl, { action: 'upload-complete', ...rightBody })
        ]);
        assert.deepEqual(concurrent.map((result) => result.response.status).sort(), [200, 409]);
        const loserBody = concurrent[0].response.status === 409 ? leftBody : rightBody;
        const retryCreate = await wranglerPost(baseUrl, { action: 'upload-create', ...loserBody });
        assert.equal(retryCreate.payload.previousVersion, 2);
        loserBody.expectedVersion = 2;
        const retryComplete = await wranglerPost(baseUrl, { action: 'upload-complete', ...loserBody });
        assert.equal(retryComplete.response.status, 200, retryComplete.payload.error);
        assert.equal(retryComplete.payload.version, 3);

        const status = await wranglerPost(baseUrl, { action: 'status' });
        assert.equal(status.payload.remote.version, 3);
    } finally {
        child.kill();
        await Promise.race([
            new Promise((resolve) => child.once('exit', resolve)),
            new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
        await fs.rm(harnessDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

const worker = await loadWorker();
const zeroGraceWorker = await loadWorker({ zeroGrace: true });
const rejectedPatchFetch = createUpdateFetch({ appJs: 'const renamedCharacterStorageApi = true;' });
const updateWorker = await loadWorker({
    fetchImpl: rejectedPatchFetch.fetchImpl
});
const successfulUpdateFetch = createUpdateFetch();
const sameTagUpdateWorker = await loadWorker({
    fetchImpl: successfulUpdateFetch.fetchImpl
});
const update181Fetch = createUpdateFetch({
    contentsFiles: UPSTREAM_181_FILES,
    appJs: RAW_UPSTREAM_APP_181_JS
});
const update181Worker = await loadWorker({ fetchImpl: update181Fetch.fetchImpl });
const contentsFailureFetch = createUpdateFetch({ failContents: true });
const contentsFailureWorker = await loadWorker({ fetchImpl: contentsFailureFetch.fetchImpl });
const downloadFailureFetch = createUpdateFetch({ failDownloadPath: '/assets/js/card-utils.js' });
const downloadFailureWorker = await loadWorker({ fetchImpl: downloadFailureFetch.fetchImpl });
const budgetFiles = [
    ...UPSTREAM_FILES,
    ...Array.from({ length: 23 }, (_, index) => `extras/file-${String(index).padStart(2, '0')}.txt`)
];
const budgetFetch = createUpdateFetch({
    contentsFiles: budgetFiles,
    failAllDownloads: true,
    redirectDownloads: true,
    delayMs: 1
});
const budgetWorker = await loadWorker({ fetchImpl: budgetFetch.fetchImpl });
await testStaticInvariants();
await testStaleAppOverlayFallsBackToBundle(worker);
await testAppUpdatePatchRejection(updateWorker);
await testSameTagAppUpdateIsRepatched(sameTagUpdateWorker);
await test181DynamicUpdateAndRollback(update181Worker, update181Fetch);
await testRollbackRejectsStalePatchRevision(worker);
await testContentsFailureRejectsUpdate(contentsFailureWorker, contentsFailureFetch);
await testDownloadFailureKeepsCurrent(downloadFailureWorker);
await testSlotWriteFailureKeepsCurrent(sameTagUpdateWorker);
await testManifestFailureKeepsCurrent(sameTagUpdateWorker, 'throw-before', 500);
await testManifestFailureKeepsCurrent(sameTagUpdateWorker, 'return-null', 409);
await testManifestThrowAfterCommitIsRecovered(sameTagUpdateWorker);
await testAtomicApplyAndRollback(sameTagUpdateWorker);
await testLegacyFixedSlotRollback(worker);
await testRollbackManifestFailureKeepsPointers(worker);
await testAmbiguousCommitSupersededKeepsPreviousSlot(sameTagUpdateWorker);
await testDelayedCleanupRereadsLatestPointers(sameTagUpdateWorker);
await testExternalRequestBudget(budgetWorker, budgetFetch);
await testAppUpdateKeepsBootstrapOrthogonal();
await testCas(worker);
await testHistory(worker);
const gcState = await testGc(worker);
await testZeroGrace(zeroGraceWorker, gcState.bucket, gcState.graceKey);
await testV5Compatibility(worker, zeroGraceWorker);
await testLimitsAndPull(worker);
await testManifestFormatMetadataAndChecksum(worker);
if (process.argv.includes('--wrangler')) await testRealWrangler();
console.log('worker-hardening.test.mjs: all assertions passed');
