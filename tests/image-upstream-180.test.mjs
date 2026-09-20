import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PROJECT_DIR = path.resolve(ROOT_DIR, '..');
const UPSTREAM_REPOSITORY = path.join(PROJECT_DIR, 'RP-Hub');
const MODULE_FILE = path.join(ROOT_DIR, 'DB', 'image-module.js');
const WORKER_FILE = path.join(ROOT_DIR, '_worker.js');
const UPSTREAM_TAG = '1.8.0';
const UPSTREAM_COMMIT = '1ede9a99fbf4db8c0069515a87a45d915616faf8';
const UPSTREAM_APP_BLOB = '52f81c6877793f10fe931af0f99652deed18c0a6';
const UPSTREAM_181_TAG = '1.8.1';
const UPSTREAM_181_COMMIT = '8911f4bba41cfe3b1a092862697b99faf7716d7d';
const UPSTREAM_181_APP_BLOB = '0ca6835e9f5027bea4008951d86dea4a58a294b4';
const CHARACTER_UUID = '18018018-0180-4180-8180-180180180180';
const CHARACTER_NAME = 'Upstream 1.8.0 Card';
const IMAGE_TOKEN = ['STA1N', 'upstream-180-test-token'].join('-');
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 8, 0]);

function git(...args) {
    return execFileSync('git', ['-C', UPSTREAM_REPOSITORY, ...args], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024
    }).trimEnd();
}

function upstreamAppSource(tag = UPSTREAM_TAG) {
    return git('cat-file', 'blob', `${tag}:assets/js/app.js`);
}

async function loadImageModuleApi() {
    const source = await fs.readFile(MODULE_FILE, 'utf8');
    const context = vm.createContext({
        URL,
        URLSearchParams,
        clearInterval,
        clearTimeout,
        console,
        crypto: webcrypto,
        document: {
            readyState: 'loading',
            addEventListener() { }
        },
        localStorage: {
            getItem() { return null; },
            removeItem() { },
            setItem() { }
        },
        performance: { now: () => 0 },
        setInterval,
        setTimeout,
        structuredClone,
        window: { RPHubNavAdapter: { registerEntry() {} }, location: { origin: 'https://worker.test' } }
    });
    vm.runInContext(source, context, { filename: MODULE_FILE });
    assert.ok(context.RPHubImageModule, 'image module public API was not installed');
    return context.RPHubImageModule;
}

async function toBytes(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    if (value && typeof value.getReader === 'function') {
        return new Uint8Array(await new Response(value).arrayBuffer());
    }
    return new Uint8Array(await new Response(value || '').arrayBuffer());
}

class FakeR2Object {
    constructor(record) {
        this.key = record.key;
        this.size = record.bytes.byteLength;
        this.body = new Uint8Array(record.bytes);
        this.httpMetadata = record.httpMetadata || {};
        this.customMetadata = record.customMetadata || {};
        this.uploaded = new Date(record.uploaded);
    }

    async text() {
        return new TextDecoder().decode(this.body);
    }
}

class FakeR2 {
    constructor() {
        this.records = new Map();
    }

    async get(key) {
        const record = this.records.get(String(key));
        return record ? new FakeR2Object(record) : null;
    }

    async put(key, value, options = {}) {
        const record = {
            key: String(key),
            bytes: await toBytes(value),
            httpMetadata: options.httpMetadata,
            customMetadata: options.customMetadata,
            uploaded: Date.now()
        };
        this.records.set(record.key, record);
        return new FakeR2Object(record);
    }

    async delete(keys) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) this.records.delete(String(key));
    }

    async list(options = {}) {
        const prefix = String(options.prefix || '');
        return {
            objects: [...this.records.values()]
                .filter((record) => record.key.startsWith(prefix))
                .map((record) => new FakeR2Object(record)),
            truncated: false
        };
    }
}

async function loadWorker(fetchImpl) {
    assert.ok(vm.SourceTextModule, 'Run this test with --experimental-vm-modules');
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

    async function visit(filename) {
        const resolved = path.resolve(filename);
        if (modules.has(resolved)) return modules.get(resolved);
        const source = await fs.readFile(resolved, 'utf8');
        const module = new vm.SourceTextModule(source, {
            context,
            identifier: pathToFileURL(resolved).href
        });
        modules.set(resolved, module);
        await module.link(async (specifier, referencingModule) => {
            const target = fileURLToPath(new URL(specifier, referencingModule.identifier));
            return visit(target);
        });
        await module.evaluate();
        return module;
    }

    return (await visit(WORKER_FILE)).namespace.default;
}

function nativeParams(tag, overrides = {}) {
    return {
        tag,
        model: 'nai-diffusion-4-5-full',
        artist: 'artist:upstream-180',
        size: '竖图',
        steps: '40',
        scale: '6',
        cfg: '0',
        sampler: 'k_dpmpp_2m_sde',
        negative: 'bad anatomy, watermark',
        nocache: '0',
        noise_schedule: 'karras',
        seed: '180001',
        nonce: 'native-nonce-a',
        ...overrides
    };
}

function imageRequestUrl(params) {
    const url = new URL('https://worker.test/api/rp-image');
    url.searchParams.set('provider', 'sta1n');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('character_id', CHARACTER_UUID);
    url.searchParams.set('character_name', CHARACTER_NAME);
    return url;
}

function addRepeatedNativeParams(url) {
    url.searchParams.append('native_control', 'alpha');
    url.searchParams.append('native_control', 'beta');
    return url;
}

function imageKey(response) {
    return decodeURIComponent(response.headers.get('x-rp-image-key') || '');
}

async function requestImage(worker, env, url, method = 'POST') {
    const headers = method === 'POST' ? { 'x-rp-image-token': IMAGE_TOKEN } : {};
    const response = await worker.fetch(new Request(url, { method, headers }), env, { waitUntil() { } });
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(response.status, 200, new TextDecoder().decode(bytes));
    return { response, bytes, key: imageKey(response) };
}

test('authoritative 1.8.0 reroll only reorders tag and does not mutate seed/nonce/time', () => {
    assert.equal(git('rev-parse', UPSTREAM_TAG), UPSTREAM_COMMIT);
    assert.equal(git('rev-parse', `${UPSTREAM_TAG}:assets/js/app.js`), UPSTREAM_APP_BLOB);

    const source = upstreamAppSource();
    const start = source.indexOf('const handleGeneratedImageReroll = (event, messageIndex) => {');
    const end = source.indexOf('const updateImageGenRegexState =', start);
    assert.ok(start >= 0 && end > start, '1.8.0 reroll implementation was not found');
    const reroll = source.slice(start, end);

    assert.match(reroll, /imageMatch\[1\]\.split\(','\)/);
    assert.match(reroll, /Math\.floor\(Math\.random\(\) \* \(tags\.length - 1\)\)/);
    assert.ok(reroll.includes('[tags[swapIndex], tags[swapIndex + 1]] = [tags[swapIndex + 1], tags[swapIndex]];'));
    assert.ok(reroll.includes('const tagUrlPattern = /([?&]tag=)[\\s\\S]*?(&token=)/;'));
    assert.ok(reroll.includes('(_, start, end) => `${start}${tags.join(\', \')}${end}`'));
    assert.ok(reroll.includes('preloadedImage.src = nextImageUrl;'));
    assert.ok(reroll.includes('scheduleChatHistorySave();'));
    assert.doesNotMatch(reroll, /\b(?:seed|nonce|timestamp)\b|Date\.now\(/i);

    const templateStart = source.indexOf('const enforceSpecialRules = () => {');
    const templateEnd = source.indexOf('// 查找当前是否已存在新命名的正则', templateStart);
    const template = source.slice(templateStart, templateEnd);
    assert.match(template, /\/generate\?tag=\$1&token=/);
    assert.match(template, /&nocache=0&noise_schedule=karras/);
    assert.doesNotMatch(template, /[?&](?:seed|nonce|timestamp)=/i);
});

test('1.8.1 native image source differs from 1.8.0 only at the accepted template bytes', () => {
    assert.equal(git('rev-parse', UPSTREAM_181_TAG), UPSTREAM_181_COMMIT);
    assert.equal(git('rev-parse', `${UPSTREAM_181_TAG}:assets/js/app.js`), UPSTREAM_181_APP_BLOB);

    const source180 = upstreamAppSource(UPSTREAM_TAG);
    const source181 = upstreamAppSource(UPSTREAM_181_COMMIT);
    const rerollStart = 'const handleGeneratedImageReroll = (event, messageIndex) => {';
    const rerollEnd = 'const updateImageGenRegexState =';
    const extractReroll = (source, tag) => {
        const start = source.indexOf(rerollStart);
        const end = source.indexOf(rerollEnd, start);
        assert.ok(start >= 0 && end > start, `${tag} reroll implementation was not found`);
        return source.slice(start, end);
    };
    assert.equal(
        extractReroll(source181, UPSTREAM_181_COMMIT),
        extractReroll(source180, UPSTREAM_TAG),
        'handleGeneratedImageReroll changed between 1.8.0 and 1.8.1'
    );

    const extractTemplateLine = (source, tag) => {
        const matches = source.split('\n').filter((line) => (
            line.includes('replacement:') && line.includes('nai-diffusion-4-5-full')
        ));
        assert.equal(matches.length, 1, `${tag} native replacement line count changed`);
        return matches[0].replace(/\r$/, '');
    };
    const template180 = extractTemplateLine(source180, UPSTREAM_TAG);
    const template181 = extractTemplateLine(source181, UPSTREAM_181_COMMIT);
    const allowedChanges = [
        ['<div style="width: 100%; height: auto;', '<div style="width: auto; height: auto;', 1],
        ['display: flex; justify-content:', 'display: inline-flex; justify-content:', 1],
        ['{missing fingers}},{{missing legs}}', '{missing fingers},{{missing legs}}', 1],
        ['style="max-width: 100%; height: auto; width: 100%; display: block;',
            'style="max-width: 100%; height: auto; width: auto; display: block;', 1]
    ];
    let normalized181 = template181;
    for (const [actual181, expected180, expectedCount] of allowedChanges) {
        assert.equal(
            normalized181.split(actual181).length - 1,
            expectedCount,
            `accepted 1.8.1 template delta missing or duplicated: ${actual181}`
        );
        normalized181 = normalized181.replaceAll(actual181, expected180);
    }
    assert.equal(normalized181, template180, '1.8.1 native replacement gained an unapproved delta');
});

test('adopted native snapshot forwards every generation parameter except token', async () => {
    const api = await loadImageModuleApi();
    const upstreamParams = nativeParams('solo, blue hair, moonlight');
    upstreamParams.token = 'must-not-leak';
    upstreamParams.native_control = ['alpha', 'beta'];
    const built = new URL(api.buildImageRenderUrl({
        source: 'upstream',
        prompt: upstreamParams.tag,
        tag: upstreamParams.tag,
        provider: 'sta1n',
        upstreamParams,
        characterUuid: CHARACTER_UUID,
        characterName: CHARACTER_NAME
    }), 'https://worker.test');

    assert.equal(built.pathname, '/api/rp-image');
    assert.equal(built.searchParams.get('provider'), 'sta1n');
    for (const [key, value] of Object.entries(nativeParams(upstreamParams.tag))) {
        assert.equal(built.searchParams.get(key), value, `${key} was not forwarded from upstreamParams`);
    }
    assert.equal(built.searchParams.has('token'), false, 'native token leaked into the cache URL');
    assert.deepEqual(built.searchParams.getAll('native_control'), ['alpha', 'beta']);
    assert.equal(built.searchParams.get('character_id'), CHARACTER_UUID);
    assert.equal(built.searchParams.get('character_name'), CHARACTER_NAME);
});

test('native tag reroll, seed, and nonce each change the R2 signature exactly once', async () => {
    const providerCalls = [];
    const worker = await loadWorker(async (input) => {
        const url = new URL(String(input));
        providerCalls.push(url);
        return new Response(PNG_BYTES, {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(PNG_BYTES.byteLength) }
        });
    });
    const bucket = new FakeR2();
    const env = {
        RP_SYNC_R2: bucket,
        IMAGE_PROVIDER_STA1N_URL: 'https://mock-provider.test'
    };

    const initialUrl = addRepeatedNativeParams(imageRequestUrl(nativeParams('solo, blue hair, moonlight, white dress')));
    assert.equal(initialUrl.searchParams.has('token'), false);
    const initial = await requestImage(worker, env, initialUrl);
    assert.equal(initial.response.headers.get('x-rp-image-cache'), 'MISS');
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].searchParams.get('seed'), '180001');
    assert.equal(providerCalls[0].searchParams.get('nonce'), 'native-nonce-a');
    assert.deepEqual(providerCalls[0].searchParams.getAll('native_control'), ['alpha', 'beta']);
    assert.equal(providerCalls[0].searchParams.get('token'), IMAGE_TOKEN);

    const initialHit = await requestImage(worker, env, initialUrl, 'GET');
    assert.equal(initialHit.response.headers.get('x-rp-image-cache'), 'HIT');
    assert.equal(initialHit.key, initial.key);
    assert.equal(providerCalls.length, 1, 'unchanged native URL called the provider again');

    const rerolledUrl = addRepeatedNativeParams(imageRequestUrl(nativeParams('blue hair, solo, moonlight, white dress')));
    const rerolled = await requestImage(worker, env, rerolledUrl);
    assert.equal(rerolled.response.headers.get('x-rp-image-cache'), 'MISS');
    assert.notEqual(rerolled.key, initial.key, '1.8.0 adjacent tag swap reused the original key');
    assert.equal(providerCalls.length, 2, 'native tag reroll did not call the provider exactly once');

    const rerolledHit = await requestImage(worker, env, rerolledUrl, 'GET');
    assert.equal(rerolledHit.response.headers.get('x-rp-image-cache'), 'HIT');
    assert.equal(rerolledHit.key, rerolled.key);
    assert.equal(providerCalls.length, 2, 'rerolled native image refresh called the provider');

    const changedSeedUrl = addRepeatedNativeParams(imageRequestUrl(nativeParams(
        'blue hair, solo, moonlight, white dress',
        { seed: '180002' }
    )));
    const changedSeed = await requestImage(worker, env, changedSeedUrl);
    assert.equal(changedSeed.response.headers.get('x-rp-image-cache'), 'MISS');
    assert.notEqual(changedSeed.key, rerolled.key, 'changed upstream seed was absent from the signature');
    assert.equal(providerCalls.length, 3);

    const changedNonceUrl = addRepeatedNativeParams(imageRequestUrl(nativeParams(
        'blue hair, solo, moonlight, white dress',
        { seed: '180002', nonce: 'native-nonce-b' }
    )));
    const changedNonce = await requestImage(worker, env, changedNonceUrl);
    assert.equal(changedNonce.response.headers.get('x-rp-image-cache'), 'MISS');
    assert.notEqual(changedNonce.key, changedSeed.key, 'changed upstream nonce was absent from the signature');
    assert.equal(providerCalls.length, 4);
});
