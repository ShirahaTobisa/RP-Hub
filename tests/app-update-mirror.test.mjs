import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const WORKER_FILE = path.join(ROOT_DIR, '_worker.js');
const UPSTREAM_REPO_DIR = path.resolve(ROOT_DIR, '..', 'RP-Hub');
const API_URL = 'https://worker.test/api/rp-sync';
const APP_UPDATE_PREFIX = 'rp-app-update';
const APP_UPDATE_MANIFEST_KEY = `${APP_UPDATE_PREFIX}/manifest.json`;
const APP_RELEASE_CACHE_KEY = `${APP_UPDATE_PREFIX}/release-cache.json`;
const DEFAULT_MIRROR_BASE = 'https://update.rph.mornye.uk';
const UPSTREAM_181_COMMIT = '8911f4bba41cfe3b1a092862697b99faf7716d7d';
const PRESERVED_ROOTS = new Set([
    'DB', '_worker.js', 'work.js', 'wrangler.toml', 'update-upstream.bat', '.git', '.github'
]);

function bytesOf(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    throw new TypeError('Unsupported fake R2 value.');
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
    }

    async text() {
        return new TextDecoder().decode(this.bytes);
    }

    async arrayBuffer() {
        return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
    }
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
        const onlyIf = options.onlyIf;
        if (onlyIf?.etagMatches !== undefined && existing?.etag !== onlyIf.etagMatches) return null;
        if (onlyIf?.etagDoesNotMatch === '*' && existing) return null;
        if (
            onlyIf?.etagDoesNotMatch !== undefined
            && onlyIf.etagDoesNotMatch !== '*'
            && existing?.etag === onlyIf.etagDoesNotMatch
        ) return null;
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
        for (const key of Array.isArray(keys) ? keys : [keys]) this.records.delete(key);
    }

    async list(options = {}) {
        const prefix = String(options.prefix || '');
        return {
            objects: [...this.records.keys()]
                .filter((key) => key.startsWith(prefix))
                .map((key) => ({ key })),
            truncated: false
        };
    }

    json(key) {
        const record = this.records.get(key);
        assert(record, `missing fake R2 JSON object: ${key}`);
        return JSON.parse(new TextDecoder().decode(record.bytes));
    }

    text(key) {
        const record = this.records.get(key);
        assert(record, `missing fake R2 object: ${key}`);
        return new TextDecoder().decode(record.bytes);
    }

    keys(prefix = '') {
        return [...this.records.keys()].filter((key) => key.startsWith(prefix)).sort();
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

async function sha256(bytes) {
    const digest = await webcrypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function gitCommit(reference) {
    return execFileSync(
        'git',
        ['-C', UPSTREAM_REPO_DIR, 'rev-parse', `${reference}^{commit}`],
        { encoding: 'utf8' }
    ).trim().toLowerCase();
}

function gitFileNames(commit) {
    return execFileSync(
        'git',
        ['-C', UPSTREAM_REPO_DIR, 'ls-tree', '-r', '--name-only', commit],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    ).trim().split(/\r?\n/).filter(Boolean)
        .filter((filePath) => !PRESERVED_ROOTS.has(filePath.split('/')[0]));
}

function gitBlob(commit, filePath) {
    return execFileSync(
        'git',
        ['-C', UPSTREAM_REPO_DIR, 'cat-file', 'blob', `${commit}:${filePath}`],
        { encoding: null, maxBuffer: 8 * 1024 * 1024 }
    );
}

async function buildMirrorVersion(reference, tag) {
    const commit = gitCommit(reference);
    const files = [];
    const blobs = new Map();
    for (const filePath of gitFileNames(commit)) {
        const bytes = gitBlob(commit, filePath);
        blobs.set(filePath, bytes);
        files.push({ path: filePath, sha256: await sha256(bytes), size: bytes.byteLength });
    }
    return {
        entry: {
            tag,
            commit,
            name: `RP-Hub ${tag}`,
            date: '2026-08-12T00:00:00Z',
            publishedAt: 1786464000000,
            precheckPatchRevision: 'r2-character-split-e2b-v3',
            files
        },
        blobs
    };
}

async function startMirror(versions, options = {}) {
    const manifest = {
        schema: 1,
        updatedAt: 1786464000000,
        upstreamRepo: 'STA1N156/RP-Hub',
        versions: versions.map((version) => structuredClone(version.entry)),
        pending: []
    };
    if (typeof options.transformManifest === 'function') options.transformManifest(manifest);
    const requests = [];
    const server = createServer((request, response) => {
        const url = new URL(request.url, 'http://127.0.0.1');
        requests.push(url.pathname);
        if (url.pathname === '/manifest.json') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(manifest));
            return;
        }
        for (const version of versions) {
            const prefix = `/snapshots/${version.entry.tag}/${version.entry.commit}/`;
            if (!url.pathname.startsWith(prefix)) continue;
            const filePath = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
            const bytes = version.blobs.get(filePath);
            if (!bytes) {
                response.writeHead(404);
                response.end('missing fixture file');
                return;
            }
            const body = options.corruptPath === filePath ? Buffer.from('corrupt mirror bytes') : bytes;
            response.writeHead(200, { 'content-type': 'application/octet-stream' });
            response.end(body);
            return;
        }
        response.writeHead(404);
        response.end('not found');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    };
}

async function loadWorker(fetchImpl = fetch) {
    assert(vm.SourceTextModule, 'Run with --experimental-vm-modules.');
    const context = vm.createContext({
        console,
        URL,
        Request,
        Response,
        Headers,
        Blob,
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
        const source = await fs.readFile(resolved, 'utf8');
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

async function callApi(worker, bucket, body, extraEnv = {}) {
    const ctx = new WaitUntilContext();
    const response = await worker.fetch(new Request(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    }), { RP_SYNC_R2: bucket, ...extraEnv }, ctx);
    const payload = await response.json();
    await ctx.drain();
    return { response, payload };
}

async function testMirrorUpdateAndRollback(version180, version181) {
    const mirror = await startMirror([version181, version180]);
    const calls = [];
    const worker = await loadWorker(async (input, options) => {
        calls.push(String(input));
        return fetch(input, options);
    });
    const bucket = new FakeR2();
    const env = { APP_UPDATE_MIRROR_BASE: mirror.baseUrl };
    try {
        const listed = await callApi(worker, bucket, { action: 'app-update-versions', force: true }, env);
        assert.equal(listed.response.status, 200, listed.payload.error);
        assert.equal(listed.payload.versions[0].sha, version181.entry.commit);
        assert.equal(listed.payload.cache.hit, false);
        const listedAgain = await callApi(worker, bucket, { action: 'app-update-versions' }, env);
        assert.equal(listedAgain.response.status, 200, listedAgain.payload.error);
        assert.equal(listedAgain.payload.cache.hit, false);
        assert.equal(mirror.requests.filter((item) => item === '/manifest.json').length, 2);

        const first = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.8.0' }, env);
        assert.equal(first.response.status, 200, first.payload.error);
        assert.equal(first.payload.fileListSource, 'mirror-manifest');
        assert.equal(bucket.json(APP_UPDATE_MANIFEST_KEY).current.upstreamSha, version180.entry.commit);

        const second = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.8.1' }, env);
        assert.equal(second.response.status, 200, second.payload.error);
        const applied = bucket.json(APP_UPDATE_MANIFEST_KEY);
        assert.equal(applied.current.upstreamSha, version181.entry.commit);
        assert.equal(applied.previous.upstreamSha, version180.entry.commit);
        assert.match(
            bucket.text(`${APP_UPDATE_PREFIX}/${applied.current.slot}/assets/js/app.js`),
            /RPH_R2_FLUSH_PERSISTENCE/
        );

        const checked = await callApi(worker, bucket, { action: 'app-update-check' }, env);
        assert.equal(checked.response.status, 200, checked.payload.error);
        assert.equal(checked.payload.current.sha, version181.entry.commit);
        assert.equal(checked.payload.updateAvailable, false);

        const rollback = await callApi(worker, bucket, { action: 'app-update-rollback' }, env);
        assert.equal(rollback.response.status, 200, rollback.payload.error);
        assert.equal(bucket.json(APP_UPDATE_MANIFEST_KEY).current.upstreamSha, version180.entry.commit);
        assert(mirror.requests.includes('/manifest.json'));
        assert(mirror.requests.some((item) => item.includes(`/snapshots/1.8.1/${version181.entry.commit}/`)));
        assert(calls.every((item) => item.startsWith(mirror.baseUrl)), `non-mirror request observed: ${calls.join(', ')}`);
    } finally {
        await mirror.close();
    }
}

async function testChecksumMismatchFailsClosed(version181) {
    const mirror = await startMirror([version181], { corruptPath: 'assets/css/styles.css' });
    const worker = await loadWorker();
    const bucket = new FakeR2();
    try {
        const result = await callApi(
            worker,
            bucket,
            { action: 'app-update-apply', target: '1.8.1' },
            { APP_UPDATE_MIRROR_BASE: mirror.baseUrl }
        );
        assert.equal(result.response.status, 500);
        assert.match(result.payload.error, /SHA-256 不匹配/);
        assert.equal(bucket.records.has(APP_UPDATE_MANIFEST_KEY), false);
        assert.equal(bucket.keys(`${APP_UPDATE_PREFIX}/versions/`).length, 0);
    } finally {
        await mirror.close();
    }
}

async function testMissingRequiredFileFailsClosed(version181) {
    const mirror = await startMirror([version181], {
        transformManifest(manifest) {
            manifest.versions[0].files = manifest.versions[0].files.filter((file) => file.path !== 'index.html');
        }
    });
    const worker = await loadWorker();
    const bucket = new FakeR2();
    try {
        const result = await callApi(
            worker,
            bucket,
            { action: 'app-update-apply', target: '1.8.1' },
            { APP_UPDATE_MIRROR_BASE: mirror.baseUrl }
        );
        assert.equal(result.response.status, 409);
        assert.equal(result.payload.code, 'RP_HUB_APP_FILE_LIST_FAILED');
        assert.match(result.payload.error, /缺少必要文件：index\.html/);
        assert.deepEqual(mirror.requests, ['/manifest.json']);
    } finally {
        await mirror.close();
    }
}

async function testUnreachableMirrorFailsClosed() {
    const mirror = await startMirror([]);
    const unreachableBase = mirror.baseUrl;
    await mirror.close();
    const calls = [];
    const worker = await loadWorker(async (input, options) => {
        calls.push(String(input));
        return fetch(input, options);
    });
    const result = await callApi(
        worker,
        new FakeR2(),
        { action: 'app-update-versions', force: true },
        { APP_UPDATE_MIRROR_BASE: unreachableBase }
    );
    assert.equal(result.response.status, 500);
    assert.match(result.payload.error, /在线更新镜像不可达/);
    assert.match(result.payload.error, new RegExp(unreachableBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(calls, [`${unreachableBase}/manifest.json`]);
}

function createLegacyGitHubFetch() {
    const calls = [];
    const commit = gitCommit('1.7.5');
    const files = new Map([
        ['index.html', gitBlob(commit, 'index.html')],
        ['assets/css/styles.css', gitBlob(commit, 'assets/css/styles.css')],
        ['assets/js/app.js', gitBlob(commit, 'assets/js/app.js')]
    ]);
    const fetchImpl = async (input) => {
        const url = new URL(String(input));
        calls.push(url.toString());
        if (url.hostname === 'github.com' && url.pathname.endsWith('/releases.atom')) {
            return new Response(`<feed><entry><title>RP-Hub 1.7.5</title><updated>2026-01-01T00:00:00Z</updated><link href="https://github.com/STA1N156/RP-Hub/releases/tag/1.7.5" /></entry></feed>`);
        }
        if (url.hostname === 'api.github.com' && url.pathname.includes('/contents/')) {
            const suffix = url.pathname.split('/contents/')[1] || '';
            const entries = suffix === ''
                ? [{ path: 'index.html', type: 'file', size: files.get('index.html').byteLength }, { path: 'assets', type: 'dir' }]
                : suffix === 'assets'
                    ? [{ path: 'assets/css', type: 'dir' }, { path: 'assets/js', type: 'dir' }]
                    : suffix === 'assets/css'
                        ? [{ path: 'assets/css/styles.css', type: 'file', size: files.get('assets/css/styles.css').byteLength }]
                        : suffix === 'assets/js'
                            ? [{ path: 'assets/js/app.js', type: 'file', size: files.get('assets/js/app.js').byteLength }]
                            : [];
            return Response.json(entries);
        }
        if (url.hostname === 'raw.githubusercontent.com') {
            const prefix = '/STA1N156/RP-Hub/1.7.5/';
            const filePath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
            const bytes = files.get(filePath);
            return bytes ? new Response(bytes) : new Response('not found', { status: 404 });
        }
        throw new Error(`legacy fixture received unexpected request: ${url}`);
    };
    return { calls, fetchImpl };
}

async function testEnvOffUsesLegacyPath() {
    const fixture = createLegacyGitHubFetch();
    const worker = await loadWorker(fixture.fetchImpl);
    const bucket = new FakeR2();
    const env = { APP_UPDATE_MIRROR_BASE: 'off' };
    const listed = await callApi(worker, bucket, { action: 'app-update-versions', force: true }, env);
    assert.equal(listed.response.status, 200, listed.payload.error);
    const applied = await callApi(worker, bucket, { action: 'app-update-apply', target: '1.7.5' }, env);
    assert.equal(applied.response.status, 200, applied.payload.error);
    assert.equal(applied.payload.fileListSource, 'github-contents');
    assert.equal(bucket.json(APP_UPDATE_MANIFEST_KEY).current.upstreamSha, '1.7.5');
    assert(bucket.records.has(APP_RELEASE_CACHE_KEY));
    assert(fixture.calls.some((url) => url.includes('/releases.atom')));
    assert(fixture.calls.some((url) => url.includes('api.github.com/')));
    assert(fixture.calls.some((url) => url.includes('raw.githubusercontent.com/')));
    assert(fixture.calls.every((url) => !url.startsWith(DEFAULT_MIRROR_BASE)));
}

const [version180, version181] = await Promise.all([
    buildMirrorVersion('1.8.0', '1.8.0'),
    buildMirrorVersion(UPSTREAM_181_COMMIT, '1.8.1')
]);

await testMirrorUpdateAndRollback(version180, version181);
await testChecksumMismatchFailsClosed(version181);
await testMissingRequiredFileFailsClosed(version181);
await testUnreachableMirrorFailsClosed();
await testEnvOffUsesLegacyPath();

console.log('app-update-mirror.test.mjs: mirror cycle, fail-closed cases, and env=off legacy path passed');
