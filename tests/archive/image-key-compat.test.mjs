import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PICS_WORKER = path.resolve(ROOT_DIR, '..', 'R2-rebuild-pics', '_worker.js');
const IMAGE_WORKER = path.join(ROOT_DIR, '_worker.js');
const TOKEN = 'STD-key-compat-test';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]);

class FakeObject {
    constructor(key, bytes, metadata = {}) {
        this.key = key;
        this.size = bytes.byteLength;
        this.body = new Uint8Array(bytes);
        this.httpMetadata = metadata.httpMetadata || {};
        this.customMetadata = metadata.customMetadata || {};
        this.uploaded = new Date();
    }

    async text() { return new TextDecoder().decode(this.body); }
}

class FakeR2 {
    constructor() { this.objects = new Map(); }

    async get(key) {
        const value = this.objects.get(String(key));
        return value ? new FakeObject(value.key, value.body, value) : null;
    }

    async put(key, value, options = {}) {
        let bytes;
        if (value instanceof Uint8Array) bytes = new Uint8Array(value);
        else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
        else bytes = new Uint8Array(await new Response(value).arrayBuffer());
        this.objects.set(String(key), { key: String(key), body: bytes, ...options });
        return this.get(key);
    }

    async delete(keys) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) this.objects.delete(String(key));
    }

    async list(options = {}) {
        const prefix = String(options.prefix || '');
        return {
            objects: [...this.objects.values()]
                .filter((value) => value.key.startsWith(prefix))
                .map((value) => new FakeObject(value.key, value.body, value)),
            truncated: false
        };
    }
}

async function loadWorker(filename) {
    const context = vm.createContext({
        AbortController, ArrayBuffer, Blob, FormData, Headers, ReadableStream,
        Request, Response, TextDecoder, TextEncoder, TransformStream, URL,
        URLSearchParams, clearTimeout, console, crypto: webcrypto, fetch: async () => new Response(PNG, {
            status: 200,
            headers: { 'content-type': 'image/png', 'content-length': String(PNG.byteLength) }
        }), setTimeout, structuredClone
    });
    const modules = new Map();
    async function visit(file) {
        const resolved = path.resolve(file);
        if (modules.has(resolved)) return modules.get(resolved);
        const source = await fs.readFile(resolved, 'utf8');
        const module = new vm.SourceTextModule(source, { context, identifier: pathToFileURL(resolved).href });
        modules.set(resolved, module);
        await module.link(async (specifier, referencingModule) => visit(fileURLToPath(new URL(specifier, referencingModule.identifier))));
        await module.evaluate();
        return module;
    }
    return (await visit(filename)).namespace.default;
}

function imageUrl(sample) {
    const url = new URL('https://worker.test/api/rp-image');
    url.searchParams.set('character_id', sample.uuid);
    url.searchParams.set('character_name', sample.name);
    url.searchParams.set('tag', sample.tag);
    url.searchParams.set('provider', sample.provider || 'std');
    url.searchParams.set('model', 'nai-diffusion-4-5-full');
    url.searchParams.set('size', '竖图');
    url.searchParams.set('artist', sample.artist || 'artist:测试 / "?');
    url.searchParams.set('negative', sample.negative || 'bad / 特殊?');
    return url;
}

async function render(worker, sample) {
    const bucket = new FakeR2();
    const env = { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: 'rph', IMAGE_PROVIDER_STD_URL: 'https://std.loliyc.com' };
    const response = await worker.fetch(new Request(imageUrl(sample), {
        method: 'POST',
        headers: { 'x-rp-image-token': TOKEN, 'x-rp-sync-password': 'rph' }
    }), env, { waitUntil() { } });
    assert.equal(response.status, 200, await response.text());
    return {
        key: decodeURIComponent(response.headers.get('x-rp-image-key') || ''),
        storageKeys: [...bucket.objects.keys()].sort()
    };
}

const pics = await loadWorker(PICS_WORKER);
const rebuilt = await loadWorker(IMAGE_WORKER);
const samples = [
    { uuid: '11111111-1111-4111-8111-111111111111', name: '苏 糖·同步', tag: '中文提示词，夜景 / 角色', provider: 'std' },
    { uuid: '22222222-2222-4222-8222-222222222222', name: 'A/"?特殊#%&{}$!`@+= 角色', tag: 'special / "? # % &', provider: 'std' },
    { uuid: '33333333-3333-4333-8333-333333333333', name: 'ＮＦＫＣ　角色／测试', tag: 'NFKC 中文', provider: 'std' }
];

for (const sample of samples) {
    const expected = await render(pics, sample);
    const actual = await render(rebuilt, sample);
    assert.equal(actual.key, expected.key, `R2 image key changed for ${sample.name}`);
    assert.deepEqual(actual.storageKeys, expected.storageKeys, `R2 namespace changed for ${sample.name}`);
    assert.match(actual.key, /^rp-images\/characters\//);
    assert.match(actual.key, /[a-f0-9]{64}$/);
}

console.log(`image-key-compat.test.mjs: ${samples.length} pics/new-worker key pairs matched byte-for-byte`);
