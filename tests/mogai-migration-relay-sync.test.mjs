import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildMigrationRelay } from '../scripts/build-migration-relay.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PROJECT_DIR = path.resolve(ROOT_DIR, '..');
const BASE_ZIP = path.join(PROJECT_DIR, 'release', 'RP-Hub-R2-rebuild-v4-img-20260901-020954.zip');
const API_URL = 'https://worker.test/api/rp-sync';
const MANIFEST_KEY = 'rp-sync/main/manifest.json';
const CHUNK_PREFIX = 'rp-sync/main/chunks';
const SNAPSHOT_FORMAT = 'rp-sync-jsonl-v1';
const SCHEMA_VERSION = 4;

function bytesOf(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    throw new TypeError('Unsupported fake R2 value');
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex').toLowerCase();
}

function chunkKey(checksum) {
    return `${CHUNK_PREFIX}/${String(checksum).toLowerCase()}.bin`;
}

class FakeR2Object {
    constructor(record) {
        this.key = record.key;
        this.etag = record.etag;
        this.httpEtag = `"${record.etag}"`;
        this.httpMetadata = record.httpMetadata;
        this.customMetadata = record.customMetadata;
        this.bytes = new Uint8Array(record.bytes);
        this.body = new Blob([this.bytes]).stream();
        this.size = this.bytes.byteLength;
        this.uploaded = new Date();
    }

    async text() { return new TextDecoder().decode(this.bytes); }
    async arrayBuffer() { return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength); }
}

class FakeR2 {
    constructor() {
        this.records = new Map();
        this.sequence = 0;
    }

    async get(key) {
        const record = this.records.get(key);
        return record ? new FakeR2Object(record) : null;
    }

    async put(key, value, options = {}) {
        const existing = this.records.get(key);
        let allowed = true;
        if (options.onlyIf?.etagMatches !== undefined) allowed = Boolean(existing && existing.etag === options.onlyIf.etagMatches);
        if (options.onlyIf?.etagDoesNotMatch !== undefined) {
            allowed = options.onlyIf.etagDoesNotMatch === '*'
                ? !existing
                : existing?.etag !== options.onlyIf.etagDoesNotMatch;
        }
        if (!allowed) return null;
        this.sequence += 1;
        const record = {
            key,
            bytes: bytesOf(value),
            etag: `etag-${this.sequence}`,
            httpMetadata: options.httpMetadata,
            customMetadata: options.customMetadata
        };
        this.records.set(key, record);
        return new FakeR2Object(record);
    }

    async delete(keys) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) this.records.delete(key);
    }

    async list(options = {}) {
        const prefix = String(options.prefix || '');
        const objects = [...this.records.values()]
            .filter((record) => record.key.startsWith(prefix))
            .sort((left, right) => left.key.localeCompare(right.key))
            .map((record) => ({
                key: record.key,
                etag: record.etag,
                httpEtag: `"${record.etag}"`,
                size: record.bytes.byteLength,
                uploaded: new Date(),
                httpMetadata: record.httpMetadata,
                customMetadata: record.customMetadata
            }));
        return { objects, truncated: false, cursor: undefined };
    }

    seedBytes(key, value, options = {}) {
        this.sequence += 1;
        this.records.set(key, {
            key,
            bytes: bytesOf(value),
            etag: `etag-${this.sequence}`,
            httpMetadata: options.httpMetadata || { contentType: 'application/octet-stream' },
            customMetadata: options.customMetadata
        });
    }

    seedJson(key, value) {
        this.seedBytes(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    }

    json(key) {
        const record = this.records.get(key);
        assert(record, `missing fake R2 object: ${key}`);
        return JSON.parse(new TextDecoder().decode(record.bytes));
    }

    snapshot() {
        return [...this.records.entries()].map(([key, value]) => [key, Buffer.from(value.bytes).toString('hex')]);
    }
}

class WaitUntilContext {
    constructor() { this.promises = []; }
    waitUntil(promise) { this.promises.push(Promise.resolve(promise)); }
    async drain() { await Promise.all(this.promises); }
}

async function loadWorker(workerFile) {
    assert(vm.SourceTextModule, 'Run this test with --experimental-vm-modules');
    const context = vm.createContext({
        AbortController,
        Blob,
        Headers,
        Request,
        Response,
        TextDecoder,
        TextEncoder,
        URL,
        console,
        crypto: webcrypto,
        fetch,
        setTimeout,
        clearTimeout,
        structuredClone
    });
    const source = fs.readFileSync(workerFile, 'utf8');
    const module = new vm.SourceTextModule(source, {
        context,
        identifier: pathToFileURL(workerFile).href
    });
    await module.link(() => { throw new Error('relay worker unexpectedly imported a module'); });
    await module.evaluate();
    return module.namespace.default;
}

async function callJson(worker, bucket, body, ctx = new WaitUntilContext()) {
    const response = await worker.fetch(new Request(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    }), { RP_SYNC_R2: bucket }, ctx);
    const payload = await response.json();
    return { response, payload, ctx };
}

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rph-mogai-relay-sync-'));
try {
    const relay = buildMigrationRelay({
        base: BASE_ZIP,
        dist: path.join(runtimeRoot, 'relay-dist'),
        releaseRoot: path.join(runtimeRoot, 'release'),
        timestamp: '20990101-020202'
    });
    const worker = await loadWorker(path.join(relay.dist, '_worker.js'));
    const bucket = new FakeR2();

    const legacyBytes = new Uint8Array([5, 4, 3]);
    const legacyChunkChecksum = sha256(legacyBytes);
    const legacyChunk = {
        index: 0,
        checksum: legacyChunkChecksum,
        length: legacyBytes.byteLength,
        byteOffset: 0,
        byteLength: legacyBytes.byteLength,
        key: chunkKey(legacyChunkChecksum),
        encoding: 'raw-bytes'
    };
    bucket.seedBytes(legacyChunk.key, legacyBytes);
    bucket.seedJson(MANIFEST_KEY, {
        version: 7,
        checksum: 'a'.repeat(64),
        updatedAt: 1700000000000,
        recordCount: 1,
        totalBytes: legacyBytes.byteLength,
        chunkSize: legacyBytes.byteLength,
        chunkCount: 1,
        chunkManifest: [legacyChunk],
        mode: 'r2-chunk-manifest-v1',
        snapshotFormat: 'rp-sync-jsonl-v2',
        schemaVersion: 5
    });
    const beforePull = bucket.snapshot();
    const failClosedPull = await callJson(worker, bucket, { action: 'pull-manifest' });
    assert.equal(failClosedPull.response.status, 200);
    assert.equal(failClosedPull.payload.remote, null, 'v5 manifest was exposed as a valid remote snapshot');
    assert.deepEqual(bucket.snapshot(), beforePull, 'fail-closed pull mutated the local remote state');

    const snapshotBytes = new TextEncoder().encode('relay-v4-snapshot');
    const chunkChecksum = sha256(snapshotBytes);
    const chunkManifest = [{
        index: 0,
        checksum: chunkChecksum,
        length: snapshotBytes.byteLength,
        key: chunkKey(chunkChecksum)
    }];
    const snapshotChecksum = sha256(JSON.stringify([
        SNAPSHOT_FORMAT,
        SCHEMA_VERSION,
        1,
        snapshotBytes.byteLength,
        [[chunkChecksum, snapshotBytes.byteLength]]
    ]));
    const metadata = {
        snapshotFormat: SNAPSHOT_FORMAT,
        schemaVersion: SCHEMA_VERSION,
        chunkerProfile: 'relay-test'
    };
    const create = await callJson(worker, bucket, {
        action: 'upload-create',
        checksum: snapshotChecksum,
        ...metadata,
        recordCount: 1,
        chunkSize: snapshotBytes.byteLength,
        chunkCount: 1,
        totalBytes: snapshotBytes.byteLength,
        chunkManifest
    });
    assert.equal(create.response.status, 200, create.payload.error);
    assert.equal(create.payload.previousVersion, 0,
        'invalid v5 manifest was incorrectly used as the upload version base');
    assert.deepEqual(create.payload.missingIndices, [0]);

    const uploadPart = await worker.fetch(new Request(`${API_URL}?action=upload-part&partNumber=1&index=0`, {
        method: 'POST',
        headers: {
            'x-rp-part-checksum': chunkChecksum,
            'x-rp-part-length': String(snapshotBytes.byteLength)
        },
        body: snapshotBytes
    }), { RP_SYNC_R2: bucket }, new WaitUntilContext());
    assert.equal(uploadPart.status, 200, await uploadPart.text());

    const complete = await callJson(worker, bucket, {
        action: 'upload-complete',
        checksum: snapshotChecksum,
        ...metadata,
        recordCount: 1,
        chunkSize: snapshotBytes.byteLength,
        chunkCount: 1,
        totalBytes: snapshotBytes.byteLength,
        chunkManifest,
        expectedVersion: create.payload.previousVersion
    });
    assert.equal(complete.response.status, 200, complete.payload.error);
    await complete.ctx.drain();

    const committed = bucket.json(MANIFEST_KEY);
    assert.equal(committed.version, 1);
    assert.equal(committed.snapshotFormat, SNAPSHOT_FORMAT);
    assert.equal(committed.schemaVersion, SCHEMA_VERSION);
    assert.equal(bucket.records.has(legacyChunk.key), true, 'legacy v5 chunk was eagerly deleted');

    const pullAfterPush = await callJson(worker, bucket, { action: 'pull-manifest' });
    assert.equal(pullAfterPush.response.status, 200);
    assert.equal(pullAfterPush.payload.remote.version, 1);
    assert.equal(pullAfterPush.payload.remote.schemaVersion, SCHEMA_VERSION);
    const pulled = await worker.fetch(new Request(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'pull-json-part', version: 1, start: 0, count: 1 })
    }), { RP_SYNC_R2: bucket }, new WaitUntilContext());
    assert.equal(pulled.status, 200, await pulled.clone().text());
    assert.deepEqual([...new Uint8Array(await pulled.arrayBuffer())], [...snapshotBytes]);

    console.log(JSON.stringify({
        ok: true,
        relayModuleSha256: relay.imageModule.afterSha256,
        v5Pull: { remote: null, localRemoteStateUnchanged: true },
        v4Push: {
            previousVersion: create.payload.previousVersion,
            committedVersion: committed.version,
            schemaVersion: committed.schemaVersion,
            legacyChunkRetained: bucket.records.has(legacyChunk.key)
        },
        v4Pull: { version: pullAfterPush.payload.remote.version, bytes: snapshotBytes.byteLength }
    }, null, 2));
    console.log('mogai-migration-relay-sync.test.mjs: v5 fail-closed pull, v4 push recount, and post-push pull passed');
} finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
}
