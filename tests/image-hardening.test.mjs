import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const WORKER_FILE = path.join(ROOT_DIR, '_worker.js');
const IMAGE_URL = 'https://worker.test/api/rp-image';
const THUMB_URL = 'https://worker.test/api/rp-image-thumb';
const SYNC_URL = 'https://worker.test/api/rp-sync';
const IMAGE_PREFIX = 'rp-images/characters/';
const THUMB_PREFIX = 'rp-images/thumbs/';
const TOMBSTONE_PREFIX = 'rp-images/_deleted/';
const SYNC_SENTINEL = 'rp-sync/main/chunks/sentinel.bin';
const PASSWORD = 'test-password';
const CARD_A = '11111111-1111-4111-8111-111111111111';
const CARD_B = '22222222-2222-4222-8222-222222222222';
const DELETE_CARD = '33333333-3333-4333-8333-333333333333';
const INVALID_THUMB_CARD = '88888888-8888-4888-8888-888888888888';
const HEAD_CARD = '44444444-4444-4444-8444-444444444444';
const JSON_CARD = '55555555-5555-4555-8555-555555555555';
const LARGE_CARD = '66666666-6666-4666-8666-666666666666';
const RATE_CARD = '77777777-7777-4777-8777-777777777777';
const SVG_CARD = '99999999-9999-4999-8999-999999999999';
const STREAM_LARGE_CARD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TIMEOUT_CARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LEGACY_CHARACTER_ID = 'legacy/card 幻世?100%#alpha';
const CLIENT_IMAGE_TOKEN = ['STD', 'client-test-token'].join('-');
const SERVER_IMAGE_TOKEN = ['STD', 'server-test-token'].join('-');
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

async function toBytes(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    if (value && typeof value.getReader === 'function') {
        return new Uint8Array(await new Response(value).arrayBuffer());
    }
    if (value === null || value === undefined) return new Uint8Array();
    throw new TypeError(`Unsupported FakeR2 value: ${Object.prototype.toString.call(value)}`);
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
        return new TextDecoder().decode(this._bytes || new Uint8Array());
    }

    async arrayBuffer() {
        const bytes = this._bytes || new Uint8Array();
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }

    get body() {
        return this._bytes ? new Uint8Array(this._bytes) : null;
    }
}

class FakeR2 {
    constructor() {
        this.records = new Map();
        this.sequence = 0;
        this.putCalls = [];
        this.getCalls = [];
        this.deleteCalls = [];
    }

    keys(prefix = '') {
        return [...this.records.keys()].filter((key) => key.startsWith(prefix)).sort();
    }

    has(key) {
        return this.records.has(key);
    }

    record(key) {
        return this.records.get(key) || null;
    }

    seed(key, value, options = {}) {
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
        return this.#store(key, bytes, options);
    }

    seedJson(key, value, options = {}) {
        return this.seed(key, JSON.stringify(value), {
            httpMetadata: { contentType: 'application/json; charset=utf-8' },
            ...options
        });
    }

    async get(key) {
        this.getCalls.push(key);
        const record = this.records.get(key);
        return record ? new FakeR2Object(record, true) : null;
    }

    async head(key) {
        const record = this.records.get(key);
        return record ? new FakeR2Object(record, false) : null;
    }

    async put(key, value, options = {}) {
        if (value && typeof value.getReader === 'function') {
            throw new TypeError(
                'Provided readable stream must have a known length '
                + '(request/response body or readable half of FixedLengthStream)'
            );
        }
        const bytes = await toBytes(value);
        const existing = this.records.get(key);
        let conditionPassed = true;
        if (options.onlyIf instanceof Headers) {
            const ifMatch = options.onlyIf.get('if-match');
            const ifNoneMatch = options.onlyIf.get('if-none-match');
            if (ifMatch) conditionPassed = Boolean(existing && ifMatch === `"${existing.etag}"`);
            if (ifNoneMatch === '*') conditionPassed = !existing;
        } else if (options.onlyIf && typeof options.onlyIf === 'object') {
            if (options.onlyIf.etagMatches !== undefined) {
                conditionPassed = Boolean(existing && options.onlyIf.etagMatches === existing.etag);
            }
            if (options.onlyIf.etagDoesNotMatch !== undefined) {
                conditionPassed = conditionPassed && (options.onlyIf.etagDoesNotMatch === '*' ? !existing : true);
            }
        }
        this.putCalls.push({ key, conditionPassed, options });
        if (!conditionPassed) return null;
        return new FakeR2Object(this.#store(key, bytes, options), false);
    }

    async delete(keys) {
        const values = Array.isArray(keys) ? keys : [keys];
        this.deleteCalls.push([...values]);
        for (const key of values) this.records.delete(key);
    }

    async list(options = {}) {
        const prefix = String(options.prefix || '');
        const all = [...this.records.values()]
            .filter((record) => record.key.startsWith(prefix))
            .sort((left, right) => left.key.localeCompare(right.key));
        const offset = options.cursor ? Number(options.cursor) : 0;
        const limit = Math.max(1, Math.min(Number(options.limit || 1000), 1000));
        const page = all.slice(offset, offset + limit);
        const next = offset + page.length;
        return {
            objects: page.map((record) => new FakeR2Object(record, false)),
            truncated: next < all.length,
            cursor: next < all.length ? String(next) : undefined
        };
    }

    #store(key, bytes, options) {
        this.sequence += 1;
        const record = {
            key,
            bytes: new Uint8Array(bytes),
            etag: `etag-${this.sequence}`,
            version: `version-${this.sequence}`,
            uploaded: Date.now(),
            httpMetadata: options.httpMetadata,
            customMetadata: options.customMetadata
        };
        this.records.set(key, record);
        return record;
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

async function loadWorker(fetchImpl, options = {}) {
    assert(vm.SourceTextModule, 'Run with --experimental-vm-modules.');
    const context = vm.createContext({
        AbortController,
        ArrayBuffer,
        Blob,
        FormData,
        Headers,
        ReadableStream,
        Request,
        Response,
        TextDecoder,
        TextEncoder,
        TransformStream,
        URL,
        URLSearchParams,
        clearTimeout,
        console,
        crypto: webcrypto,
        fetch: fetchImpl,
        setTimeout,
        structuredClone
    });
    const modules = new Map();

    async function loadModule(filename) {
        const resolved = path.resolve(filename);
        if (modules.has(resolved)) return modules.get(resolved);
        let source = await fs.readFile(resolved, 'utf8');
        if (resolved === path.resolve(WORKER_FILE) && options.imageFetchTimeoutMs !== undefined) {
            const replacement = `const IMAGE_FETCH_TIMEOUT_MS = ${Number(options.imageFetchTimeoutMs)};`;
            const patched = source.replace(/const IMAGE_FETCH_TIMEOUT_MS = \d+;/, replacement);
            assert.notEqual(patched, source, 'test timeout override did not match IMAGE_FETCH_TIMEOUT_MS');
            source = patched;
        }
        const module = new vm.SourceTextModule(source, {
            context,
            identifier: pathToFileURL(resolved).href
        });
        modules.set(resolved, module);
        await module.link(async (specifier, referencingModule) => {
            const target = fileURLToPath(new URL(specifier, referencingModule.identifier));
            return loadModule(target);
        });
        await module.evaluate();
        return module;
    }

    return (await loadModule(WORKER_FILE)).namespace.default;
}

function imageRequestUrl({ id = CARD_A, idKey = 'character_id', name = 'Same Name', tag = 'portrait' } = {}) {
    const url = new URL(IMAGE_URL);
    if (id !== null) url.searchParams.set(idKey, id);
    url.searchParams.set('character_name', name);
    url.searchParams.set('tag', tag);
    url.searchParams.set('provider', 'std');
    url.searchParams.set('model', 'nai-diffusion-4-5-full');
    url.searchParams.set('size', 'vertical');
    return url;
}

function imageGenerationRequest(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.token !== null) headers.set('x-rp-image-token', options.token || CLIENT_IMAGE_TOKEN);
    if (options.password) headers.set('x-rp-sync-password', options.password);
    return new Request(url, { method: 'POST', headers });
}

function createUpstream(options = {}) {
    const calls = [];
    const fetchImpl = async (input) => {
        const url = new URL(String(input));
        calls.push(url);
        if (options.status && options.status !== 200) {
            return new Response(options.body || 'upstream error', { status: options.status });
        }
        const headers = new Headers({
            'content-type': options.contentType || 'image/png'
        });
        if (options.contentLength !== undefined) headers.set('content-length', String(options.contentLength));
        const bytes = options.bytes || PNG_BYTES;
        return new Response(bytes, { status: 200, headers });
    };
    return { calls, fetchImpl };
}

function makeEnv(bucket, options = {}) {
    const env = {
        RP_SYNC_R2: bucket,
        ASSETS: {
            fetch: async (request) => new Response(
                options.assetBody || `bundled:${new URL(request.url).pathname}`,
                { headers: { 'content-type': options.assetContentType || 'application/javascript' } }
            )
        }
    };
    if (options.imageToken !== null) env.IMAGE_GEN_TOKEN = options.imageToken || SERVER_IMAGE_TOKEN;
    if (options.password) env.RP_SYNC_PASSWORD = options.password;
    return env;
}

function decodeImageKey(response) {
    const value = response.headers.get('x-rp-image-key') || '';
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

async function jsonRequest(worker, env, url, body, headers = {}) {
    const response = await worker.fetch(new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
    }), env, new WaitUntilContext());
    const payload = await response.json().catch(() => null);
    return { response, payload };
}

async function testNameKeyCompatibilityAndAliases() {
    const bucket = new FakeR2();
    const upstream = createUpstream();
    const worker = await loadWorker(upstream.fetchImpl);
    const env = makeEnv(bucket, { password: PASSWORD });

    const firstUrl = imageRequestUrl();
    assert.equal(firstUrl.searchParams.has('token'), false, 'client image token leaked into the URL');
    const firstResponse = await worker.fetch(imageGenerationRequest(firstUrl), env, new WaitUntilContext());
    assert.equal(firstResponse.status, 200, await firstResponse.text());
    assert.equal(firstResponse.headers.get('x-rp-image-cache'), 'MISS');
    assert.match(firstResponse.headers.get('cache-control') || '', /no-store/i);
    assert.equal(upstream.calls[0]?.searchParams.get('token'), CLIENT_IMAGE_TOKEN,
        'x-rp-image-token was not forwarded to the provider');
    const firstKey = decodeImageKey(firstResponse);
    assert.match(firstKey, /^rp-images\/characters\/Same-Name\/[a-f0-9]{64}$/);
    assert(bucket.has(firstKey));
    assert.equal(bucket.record(firstKey)?.customMetadata?.characterId, undefined,
        'name-key images must not persist a UUID namespace identifier');

    const cachedResponse = await worker.fetch(new Request(firstUrl), env, new WaitUntilContext());
    assert.equal(cachedResponse.status, 200);
    assert.equal(cachedResponse.headers.get('x-rp-image-cache'), 'HIT');
    assert.match(cachedResponse.headers.get('cache-control') || '', /no-store/i);
    assert.equal(upstream.calls.length, 1, 'cache hit called the image provider again');

    const legacyProviderUrl = new URL(firstUrl);
    legacyProviderUrl.searchParams.set('provider', 'STD API');
    const legacyProviderHit = await worker.fetch(
        new Request(legacyProviderUrl),
        makeEnv(bucket, { password: PASSWORD, imageToken: null }),
        new WaitUntilContext()
    );
    assert.equal(legacyProviderHit.status, 200, await legacyProviderHit.text());
    assert.equal(legacyProviderHit.headers.get('x-rp-image-cache'), 'HIT',
        'legacy provider labels must resolve the existing name-key image');
    assert.equal(decodeImageKey(legacyProviderHit), firstKey);
    assert.equal(upstream.calls.length, 1, 'legacy provider lookup regenerated an image');

    const sta1nUrl = imageRequestUrl({ id: CARD_B, name: 'Sta1n Legacy Card', tag: 'sta1n portrait' });
    sta1nUrl.searchParams.set('provider', 'sta1n');
    const sta1nToken = ['STA1N', 'legacy-test-token'].join('-');
    const sta1nResponse = await worker.fetch(imageGenerationRequest(sta1nUrl, { token: sta1nToken }), env, new WaitUntilContext());
    assert.equal(sta1nResponse.status, 200, await sta1nResponse.text());
    const sta1nKey = decodeImageKey(sta1nResponse);
    const sta1nLegacyLabelUrl = new URL(sta1nUrl);
    sta1nLegacyLabelUrl.searchParams.set('provider', 'STA1N API');
    const sta1nLegacyHit = await worker.fetch(
        new Request(sta1nLegacyLabelUrl),
        makeEnv(bucket, { password: PASSWORD, imageToken: null }),
        new WaitUntilContext()
    );
    assert.equal(sta1nLegacyHit.status, 200, await sta1nLegacyHit.text());
    assert.equal(sta1nLegacyHit.headers.get('x-rp-image-cache'), 'HIT');
    assert.equal(decodeImageKey(sta1nLegacyHit), sta1nKey);

    const aliasUrl = imageRequestUrl({ id: CARD_B, idKey: 'character_uuid' });
    const upstreamCallsBeforeAlias = upstream.calls.length;
    const aliasResponse = await worker.fetch(imageGenerationRequest(aliasUrl), env, new WaitUntilContext());
    assert.equal(aliasResponse.status, 200, await aliasResponse.text());
    const aliasKey = decodeImageKey(aliasResponse);
    assert.equal(aliasKey, firstKey, 'character_id must be ignored for name-key lookup');
    assert.equal(upstream.calls.length, upstreamCallsBeforeAlias, 'name-key alias unexpectedly regenerated an image');

    const renamedResponse = await worker.fetch(imageGenerationRequest(imageRequestUrl({
        id: CARD_A,
        name: 'Renamed Card',
        tag: 'second portrait'
    })), env, new WaitUntilContext());
    assert.equal(renamedResponse.status, 200, await renamedResponse.text());
    assert.match(decodeImageKey(renamedResponse), /^rp-images\/characters\/Renamed-Card\//);

    const legacyIdUrl = imageRequestUrl({ id: LEGACY_CHARACTER_ID, name: 'Legacy ID Card', tag: 'legacy portrait' });
    const legacyIdResponse = await worker.fetch(imageGenerationRequest(legacyIdUrl), env, new WaitUntilContext());
    assert.equal(legacyIdResponse.status, 200, await legacyIdResponse.text());
    const legacyIdKey = decodeImageKey(legacyIdResponse);
    assert.match(legacyIdKey, /^rp-images\/characters\/Legacy-ID-Card\/[a-f0-9]{64}$/);
    assert(bucket.has(legacyIdKey), 'name-key image was not stored');
    const legacyReadUrl = new URL('https://worker.test/image/api/image');
    legacyReadUrl.searchParams.set('key', legacyIdKey);
    const legacyRead = await worker.fetch(new Request(legacyReadUrl, {
        headers: { 'x-rp-sync-password': PASSWORD }
    }), env, new WaitUntilContext());
    assert.equal(legacyRead.status, 200, await legacyRead.text());

    const missingIdResponse = await worker.fetch(imageGenerationRequest(imageRequestUrl({ id: null, name: 'Name Only Card' })), env, new WaitUntilContext());
    assert.equal(missingIdResponse.status, 200, await missingIdResponse.text());
    assert.match(decodeImageKey(missingIdResponse), /^rp-images\/characters\/Name-Only-Card\//);

    const invalidIdResponse = await worker.fetch(imageGenerationRequest(imageRequestUrl({
        id: `bad${String.fromCharCode(1)}id`,
        name: 'Control ID Card'
    })), env, new WaitUntilContext());
    assert.equal(invalidIdResponse.status, 200, await invalidIdResponse.text());

    const library = await worker.fetch(new Request('https://worker.test/image/api/library', {
        headers: { 'x-rp-sync-password': PASSWORD }
    }), env, new WaitUntilContext());
    assert.equal(library.status, 200, await library.clone().text());
    const libraryPayload = await library.json();
    const groups = Array.isArray(libraryPayload.characters) ? libraryPayload.characters : [];
    assert.deepEqual(groups.map((group) => group.name).sort(), [
        'Control ID Card',
        'Legacy ID Card',
        'Name Only Card',
        'Renamed Card',
        'Same Name',
        'Sta1n Legacy Card'
    ].sort());
    assert(groups.every((group) => !('characterId' in group) && !('legacy' in group)),
        'name-key library must not expose UUID/legacy dual-track fields');
}

async function testThumbnailAuthDeleteAndTombstonePrecedence() {
    const bucket = new FakeR2();
    bucket.seed(SYNC_SENTINEL, new Uint8Array([7]));
    const upstream = createUpstream();
    const worker = await loadWorker(upstream.fetchImpl);
    const env = makeEnv(bucket, { password: PASSWORD });
    const renderUrl = imageRequestUrl({ id: DELETE_CARD, name: 'Delete Card' });

    const rendered = await worker.fetch(imageGenerationRequest(renderUrl), env, new WaitUntilContext());
    assert.equal(rendered.status, 200, await rendered.text());
    const imageKey = decodeImageKey(rendered);

    const unauthenticatedThumb = await worker.fetch(new Request(new URL(renderUrl.toString().replace(IMAGE_URL, THUMB_URL)), {
        method: 'PUT',
        headers: { 'content-type': 'image/webp' },
        body: WEBP_BYTES
    }), env, new WaitUntilContext());
    assert([401, 403].includes(unauthenticatedThumb.status), 'thumbnail write accepted no admin password');

    const authenticatedThumb = await worker.fetch(new Request(new URL(renderUrl.toString().replace(IMAGE_URL, THUMB_URL)), {
        method: 'PUT',
        headers: {
            'content-type': 'image/webp',
            'x-rp-sync-password': PASSWORD
        },
        body: WEBP_BYTES
    }), env, new WaitUntilContext());
    assert.equal(authenticatedThumb.status, 200, await authenticatedThumb.text());
    const thumbKeys = bucket.keys(`${THUMB_PREFIX}Delete-Card/`);
    assert.equal(thumbKeys.length, 1);

    const adminImageUrl = new URL('https://worker.test/image/api/image');
    adminImageUrl.searchParams.set('key', imageKey);
    const adminImage = await worker.fetch(new Request(adminImageUrl, {
        headers: { 'x-rp-sync-password': PASSWORD }
    }), env, new WaitUntilContext());
    assert.equal(adminImage.status, 200, await adminImage.text());
    assert.match(adminImage.headers.get('cache-control') || '', /no-store/i);
    const adminThumbUrl = new URL('https://worker.test/image/api/thumb');
    adminThumbUrl.searchParams.set('key', imageKey);
    const adminThumb = await worker.fetch(new Request(adminThumbUrl, {
        headers: { 'x-rp-sync-password': PASSWORD }
    }), env, new WaitUntilContext());
    assert.equal(adminThumb.status, 200, await adminThumb.text());
    assert.match(adminThumb.headers.get('cache-control') || '', /no-store/i);

    const invalidThumbRenderUrl = imageRequestUrl({
        id: INVALID_THUMB_CARD,
        name: 'Invalid Thumb Card',
        tag: 'invalid thumbnail source'
    });
    const invalidThumbSource = await worker.fetch(imageGenerationRequest(invalidThumbRenderUrl), env, new WaitUntilContext());
    assert.equal(invalidThumbSource.status, 200, await invalidThumbSource.text());
    const invalidThumb = await worker.fetch(new Request(new URL(invalidThumbRenderUrl.toString().replace(IMAGE_URL, THUMB_URL)), {
        method: 'PUT',
        headers: {
            'content-type': 'image/png',
            'x-rp-sync-password': PASSWORD
        },
        body: PNG_BYTES
    }), env, new WaitUntilContext());
    assert([400, 415].includes(invalidThumb.status));

    const authStatus = await worker.fetch(new Request('https://worker.test/image/api/auth-status', {
        headers: { 'x-rp-sync-password': PASSWORD }
    }), env, new WaitUntilContext());
    assert.equal(authStatus.status, 200);
    const setCookie = authStatus.headers.get('set-cookie') || '';
    assert.match(setCookie, /rp_image_admin_auth=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);

    const deletion = await jsonRequest(
        worker,
        env,
        'https://worker.test/image/api/delete',
        { keys: [imageKey] },
        { 'x-rp-sync-password': PASSWORD }
    );
    assert.equal(deletion.response.status, 200, JSON.stringify(deletion.payload));
    assert.equal(deletion.payload.deletedCount, 1);
    assert.equal(bucket.has(imageKey), false);
    assert.equal(bucket.has(thumbKeys[0]), false);
    assert.equal(bucket.keys(`${TOMBSTONE_PREFIX}Delete-Card/`).length, 1);
    assert(bucket.has(SYNC_SENTINEL), 'image deletion touched the sync namespace');

    bucket.seed(imageKey, PNG_BYTES, {
        httpMetadata: { contentType: 'image/png' },
        customMetadata: { characterName: 'Delete Card' }
    });
    const providerCallsBefore = upstream.calls.length;
    const deletedRender = await worker.fetch(new Request(renderUrl), env, new WaitUntilContext());
    assert.equal(deletedRender.status, 200);
    assert.equal(deletedRender.headers.get('x-rp-image-cache'), 'DELETED');
    assert.match(deletedRender.headers.get('content-type') || '', /image\/svg\+xml/);
    assert.equal(upstream.calls.length, providerCallsBefore, 'tombstoned image called the provider again');
}

async function testImageTokenAuthAndProviderMismatch() {
    {
        const bucket = new FakeR2();
        const upstream = createUpstream();
        const worker = await loadWorker(upstream.fetchImpl);
        const response = await worker.fetch(
            imageGenerationRequest(imageRequestUrl({ tag: 'server token without password' }), { token: null }),
            makeEnv(bucket),
            new WaitUntilContext()
        );
        assert.equal(response.status, 503, 'server image token worked without RP_SYNC_PASSWORD configuration');
        assert.equal(upstream.calls.length, 0);
        assert.equal(bucket.keys('rp-images/').length, 0);
    }
    {
        const bucket = new FakeR2();
        const upstream = createUpstream();
        const worker = await loadWorker(upstream.fetchImpl);
        const env = makeEnv(bucket, { password: PASSWORD });
        const unauthenticated = await worker.fetch(
            imageGenerationRequest(imageRequestUrl({ tag: 'server token missing password header' }), { token: null }),
            env,
            new WaitUntilContext()
        );
        assert.equal(unauthenticated.status, 401, 'server image token worked without the sync password header');
        assert.equal(upstream.calls.length, 0);

        const authenticated = await worker.fetch(
            imageGenerationRequest(imageRequestUrl({ tag: 'server token authenticated' }), {
                token: null,
                password: PASSWORD
            }),
            env,
            new WaitUntilContext()
        );
        assert.equal(authenticated.status, 200, await authenticated.text());
        assert.equal(upstream.calls.length, 1);
        assert.equal(upstream.calls[0].searchParams.get('token'), SERVER_IMAGE_TOKEN);
    }
    {
        const bucket = new FakeR2();
        const upstream = createUpstream();
        const worker = await loadWorker(upstream.fetchImpl);
        const mismatchUrl = imageRequestUrl({ tag: 'provider mismatch' });
        mismatchUrl.searchParams.set('provider', 'sta1n');
        const response = await worker.fetch(
            imageGenerationRequest(mismatchUrl),
            makeEnv(bucket, { imageToken: null }),
            new WaitUntilContext()
        );
        assert.equal(response.status, 409, 'provider/token mismatch was not rejected');
        assert.equal(upstream.calls.length, 0, 'provider/token mismatch reached the upstream provider');
        assert.equal(bucket.keys('rp-images/').length, 0);
    }
}

async function testCharacterNameDeletionTargetsNameKeys() {
    const bucket = new FakeR2();
    const upstream = createUpstream();
    const worker = await loadWorker(upstream.fetchImpl);
    const env = makeEnv(bucket, { password: PASSWORD });
    const currentUrl = imageRequestUrl({ id: CARD_A, name: 'Colliding Name', tag: 'current uuid image' });
    const currentResponse = await worker.fetch(imageGenerationRequest(currentUrl), env, new WaitUntilContext());
    assert.equal(currentResponse.status, 200, await currentResponse.text());
    const currentKey = decodeImageKey(currentResponse);

    const legacyChecksum = 'c'.repeat(64);
    const legacyKey = `rp-images/characters/Colliding-Name/${legacyChecksum}`;
    bucket.seed(legacyKey, PNG_BYTES, {
        httpMetadata: { contentType: 'image/png' },
        customMetadata: { characterName: 'Colliding Name' }
    });

    const deletion = await jsonRequest(
        worker,
        env,
        'https://worker.test/image/api/delete',
        { characterNames: ['Colliding Name'] },
        { 'x-rp-sync-password': PASSWORD }
    );
    assert.equal(deletion.response.status, 200, JSON.stringify(deletion.payload));
    assert.equal(deletion.payload.deletedCount, 2, 'characterNames should delete all images in the name album');
    assert.equal(bucket.has(currentKey), false, 'name-based deletion left the current image');
    assert.equal(bucket.has(legacyKey), false, 'name-based deletion left the second name-key image');
}

async function testProviderFailuresAndHeadMiss() {
    {
        const bucket = new FakeR2();
        const upstream = createUpstream();
        const worker = await loadWorker(upstream.fetchImpl);
        const missUrl = imageRequestUrl({ id: HEAD_CARD });
        const response = await worker.fetch(new Request(missUrl, { method: 'HEAD' }), makeEnv(bucket), new WaitUntilContext());
        assert.equal(response.status, 404);
        const getResponse = await worker.fetch(new Request(missUrl), makeEnv(bucket), new WaitUntilContext());
        assert.equal(getResponse.status, 404);
        assert.equal(getResponse.headers.get('x-rp-image-generate-method'), 'POST');
        assert.equal(upstream.calls.length, 0, 'HEAD cache miss generated an image');
        assert.equal(bucket.keys('rp-images/').length, 0);
    }
    {
        const bucket = new FakeR2();
        const upstream = createUpstream({ contentType: 'application/json' });
        const worker = await loadWorker(upstream.fetchImpl);
        const response = await worker.fetch(imageGenerationRequest(imageRequestUrl({ id: JSON_CARD })), makeEnv(bucket), new WaitUntilContext());
        assert.equal(response.status, 502);
        assert.equal(bucket.keys('rp-images/').length, 0);
    }
    {
        const bucket = new FakeR2();
        const upstream = createUpstream({ contentLength: 64 * 1024 * 1024 + 1 });
        const worker = await loadWorker(upstream.fetchImpl);
        const response = await worker.fetch(imageGenerationRequest(imageRequestUrl({ id: LARGE_CARD })), makeEnv(bucket), new WaitUntilContext());
        assert.equal(response.status, 413);
        assert.equal(bucket.keys('rp-images/').length, 0);
    }
    {
        const bucket = new FakeR2();
        const upstream = createUpstream({ status: 429 });
        const worker = await loadWorker(upstream.fetchImpl);
        const response = await worker.fetch(imageGenerationRequest(imageRequestUrl({ id: RATE_CARD })), makeEnv(bucket), new WaitUntilContext());
        assert.equal(response.status, 429);
        assert.equal(bucket.keys('rp-images/').length, 0);
    }
    {
        const bucket = new FakeR2();
        const upstream = createUpstream({ contentType: 'image/svg+xml' });
        const worker = await loadWorker(upstream.fetchImpl);
        const response = await worker.fetch(imageGenerationRequest(imageRequestUrl({ id: SVG_CARD })), makeEnv(bucket), new WaitUntilContext());
        assert.equal(response.status, 502, 'SVG upstream payload must not be cached as an image');
        assert.equal(bucket.keys('rp-images/').length, 0);
    }
    {
        const bucket = new FakeR2();
        const megabyte = new Uint8Array(1024 * 1024);
        const fetchImpl = async () => new Response(new ReadableStream({
            start(controller) {
                for (let index = 0; index < 65; index += 1) controller.enqueue(megabyte);
                controller.close();
            }
        }), { status: 200, headers: { 'content-type': 'image/png' } });
        const worker = await loadWorker(fetchImpl);
        const response = await worker.fetch(imageGenerationRequest(imageRequestUrl({ id: STREAM_LARGE_CARD })), makeEnv(bucket), new WaitUntilContext());
        assert.equal(response.status, 413, 'unknown-length oversized streams must be capped');
        assert.equal(bucket.keys('rp-images/').length, 0);
    }
    {
        const bucket = new FakeR2();
        const fetchImpl = async () => new Response(new ReadableStream({
            pull() {
                return new Promise(() => { });
            }
        }), { status: 200, headers: { 'content-type': 'image/png' } });
        const worker = await loadWorker(fetchImpl, { imageFetchTimeoutMs: 30 });
        const startedAt = Date.now();
        const response = await worker.fetch(imageGenerationRequest(imageRequestUrl({ id: TIMEOUT_CARD })), makeEnv(bucket), new WaitUntilContext());
        assert.equal(response.status, 504, 'a hanging image body must be reported as timeout');
        assert(Date.now() - startedAt < 2000, 'shortened body timeout did not terminate the request promptly');
        assert.equal(bucket.keys('rp-images/').length, 0);
    }
}

async function testRouteIsolationAndUpdateOverlayRemainsMainlineBehavior() {
    const bucket = new FakeR2();
    bucket.seedJson('rp-app-update/manifest.json', {
        current: {
            upstreamTag: '9.9.9',
            upstreamSha: 'stale',
            patchRevision: 'r2-character-split-e2b-v3',
            slot: 'current',
            files: [{ path: 'assets/js/app.js', key: 'ignored' }]
        },
        previous: null
    });
    bucket.seed('rp-app-update/current/assets/js/app.js', 'stale-online-overlay', {
        httpMetadata: { contentType: 'application/javascript' }
    });
    const upstream = createUpstream();
    const worker = await loadWorker(upstream.fetchImpl);
    const env = makeEnv(bucket, { assetBody: 'bundled-image-app' });

    const appResponse = await worker.fetch(new Request('https://worker.test/assets/js/app.js'), env, new WaitUntilContext());
    assert.equal(appResponse.status, 200);
    assert.equal(await appResponse.text(), 'stale-online-overlay', 'v4 online-update overlay behavior changed');

    const syncStatus = await jsonRequest(worker, env, SYNC_URL, { action: 'status' });
    assert.equal(syncStatus.response.status, 200, JSON.stringify(syncStatus.payload));
    assert.equal(syncStatus.payload.ok, true);

    const adminPage = await worker.fetch(new Request('https://worker.test/image'), env, new WaitUntilContext());
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.headers.get('content-type') || '', /text\/html/);
    assert.match(await adminPage.text(), /(?:character|image|\u56fe\u7247)/i);

    const exactRoute = await worker.fetch(new Request(imageRequestUrl({ id: null })), env, new WaitUntilContext());
    assert.equal(exactRoute.status, 404);
    assert.notEqual(await exactRoute.text(), 'bundled-image-app');
}

await testNameKeyCompatibilityAndAliases();
await testThumbnailAuthDeleteAndTombstonePrecedence();
await testImageTokenAuthAndProviderMismatch();
await testCharacterNameDeletionTargetsNameKeys();
await testProviderFailuresAndHeadMiss();
await testRouteIsolationAndUpdateOverlayRemainsMainlineBehavior();

console.log('image-hardening.test.mjs: all assertions passed');
