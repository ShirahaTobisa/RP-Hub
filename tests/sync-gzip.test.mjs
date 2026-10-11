import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import worker from '../_worker.js';

// 同步分块压缩（版本 6）：手机压缩后上传，服务器按压缩后的字节校验并单独存成 .gz，拉取时原样返回、在响应头里给出每块大小。
// 旧版测试版仍按版本 4 不压缩上传和拉取；压缩块和不压缩的块互不顶替；清理旧块时不误删压缩块。
const PASSWORD = 'fixture-sync-password';
const DAY = 86_400_000;

function fakeBucket() {
    const store = new Map();
    let etag = 0;
    const view = (item) => ({
        ...item, etag: item.etag, httpEtag: `"${item.etag}"`,
        async text() { return new TextDecoder().decode(item.bytes); },
        async arrayBuffer() { return item.bytes.slice().buffer; }
    });
    return {
        store,
        async get(key) { const item = store.get(key); return item ? view(item) : null; },
        async head(key) { const item = store.get(key); return item ? view(item) : null; },
        async put(key, value, options = {}) {
            const current = store.get(key);
            if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
            if (options.onlyIf?.etagDoesNotMatch === '*' && current) return null;
            const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer ? value.slice().buffer : value);
            const item = { key, bytes, size: bytes.byteLength, uploaded: new Date(), etag: `e${++etag}`, customMetadata: options.customMetadata || {} };
            store.set(key, item);
            return view(item);
        },
        async delete(keys) { for (const key of [].concat(keys)) store.delete(key); },
        async list({ prefix = '' } = {}) {
            return { objects: [...store.values()].filter((item) => item.key.startsWith(prefix)).map(({ bytes, ...item }) => item), truncated: false };
        }
    };
}

const bucket = fakeBucket();
const waits = [];
const env = { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: PASSWORD, APP_UPDATE_MIRROR_BASE: 'off', ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
const ctx = { waitUntil(promise) { waits.push(promise); } };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const api = async (body) => {
    const response = await worker.fetch(new Request('https://rph.example/api/rp-sync', {
        method: 'POST', headers: { 'x-rp-sync-password': PASSWORD, 'content-type': 'application/json' }, body: JSON.stringify(body)
    }), env, ctx);
    return response.headers.get('content-type')?.includes('json') ? { status: response.status, body: await response.json() } : response;
};
const uploadPart = async (index, raw, { gzip, storedChecksum } = {}) => {
    const body = gzip ? zlib.gzipSync(raw) : raw;
    const headers = { 'x-rp-sync-password': PASSWORD, 'x-rp-part-checksum': sha256(raw), 'x-rp-part-length': String(raw.length) };
    if (gzip) Object.assign(headers, { 'x-rp-part-encoding': 'gzip', 'x-rp-part-stored-length': String(body.length), 'x-rp-part-stored-checksum': storedChecksum || sha256(body) });
    const response = await worker.fetch(new Request(`https://rph.example/api/rp-sync?action=upload-part&index=${index}&partNumber=${index + 1}`, { method: 'POST', headers, body }), env, ctx);
    return { status: response.status, body: await response.json() };
};

function snapshot(schemaVersion, texts) {
    const raws = texts.map((text) => Buffer.from(text));
    const chunkManifest = raws.map((raw, index) => ({ index, checksum: sha256(raw), length: raw.length }));
    const totalBytes = raws.reduce((sum, raw) => sum + raw.length, 0);
    const recordCount = texts.length;
    const checksum = sha256(JSON.stringify(['rp-sync-jsonl-v1', schemaVersion, recordCount, totalBytes, chunkManifest.map((chunk) => [chunk.checksum, chunk.length])]));
    return { raws, meta: { snapshotFormat: 'rp-sync-jsonl-v1', schemaVersion, chunkerProfile: 'rph-jsonl-cdc-fnv1a-v1', checksum, recordCount, totalBytes, chunkSize: 2097152, chunkCount: raws.length, chunkManifest } };
}

async function push(snap, expectedVersion, gzip) {
    const created = await api({ action: 'upload-create', ...snap.meta });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    for (const index of created.body.missingIndices) assert.equal((await uploadPart(index, snap.raws[index], { gzip })).status, 200);
    const done = await api({ action: 'upload-complete', ...snap.meta, expectedVersion });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    await Promise.all(waits.splice(0));
    return created.body.missingIndices;
}

async function pull() {
    const { body } = await api({ action: 'pull-manifest' });
    const response = await api({ action: 'pull-json-part', version: body.remote.version, start: 0, count: body.remote.chunkCount });
    const bytes = Buffer.from(await response.arrayBuffer());
    const lengths = response.headers.get('x-rp-sync-part-lengths');
    const parts = [];
    let offset = 0;
    for (const [index, chunk] of body.remote.chunkManifest.entries()) {
        const size = lengths ? Number(lengths.split(',')[index]) : chunk.length;
        const stored = bytes.subarray(offset, offset + size);
        offset += size;
        parts.push(lengths ? zlib.gunzipSync(stored).toString() : stored.toString());
    }
    return { remote: body.remote, parts, storedBytes: bytes.length, gzip: Boolean(lengths) };
}

const line = (name, n) => JSON.stringify({ type: 'record', key: `rp_hub_chat_${name}`, value: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: `第 ${i} 句：她看着窗外的雨，轻声说今天也要好好吃饭。` })) }) + '\n';
const v6 = snapshot(6, [line('a', 400), line('b', 400), line('c', 400)]);

// 新版压缩上传 → 拉取解压后和原内容一致，存储比原来小。
assert.deepEqual(await push(v6, 0, true), [0, 1, 2]);
let pulled = await pull();
assert.equal(pulled.remote.schemaVersion, 6);
assert.equal(pulled.gzip, true);
assert.deepEqual(pulled.parts, v6.raws.map(String));
assert.ok(pulled.storedBytes < v6.meta.totalBytes / 3, `stored ${pulled.storedBytes} of ${v6.meta.totalBytes}`);
const gzKeys = [...bucket.store.keys()].filter((key) => key.endsWith('.gz'));
assert.equal(gzKeys.length, 3);
console.log('PASS compressed chunks are stored as .gz and pull back to the exact original content');

// 压缩数据的校验码对不上：拒绝。
const bad = await uploadPart(0, v6.raws[0], { gzip: true, storedChecksum: '0'.repeat(64) });
assert.equal(bad.status, 409);
console.log('PASS a compressed part with a wrong checksum is rejected');

// 第二次上传只传有变化的块。
const v6b = snapshot(6, [line('a', 400), line('b', 401), line('c', 400)]);
assert.deepEqual(await push(v6b, 1, true), [1]);
assert.deepEqual((await pull()).parts, v6b.raws.map(String));
console.log('PASS a later compressed push uploads only the changed chunk');

// 旧版（版本 4）不压缩上传：压缩块不能顶替，整份重传；拉取原样返回、不带分块大小。
const v4 = snapshot(4, [line('a', 400), line('b', 401), line('c', 400)]);
assert.deepEqual(await push(v4, 2, false), [0, 1, 2]);
pulled = await pull();
assert.equal(pulled.remote.schemaVersion, 4);
assert.equal(pulled.gzip, false);
assert.deepEqual(pulled.parts, v4.raws.map(String));
assert.equal([...bucket.store.keys()].filter((key) => key.endsWith('.bin')).length, 3);
console.log('PASS older test builds still push and pull uncompressed snapshots, kept apart from compressed chunks');

// 清理旧块：最近几份清单（含压缩的）引用到的块都留着，没人引用的旧块才删。
for (const item of bucket.store.values()) item.uploaded = new Date(Date.now() - 2 * DAY);
await bucket.put('rp-sync/main/chunks/' + 'f'.repeat(64) + '.gz', new Uint8Array([1]));
bucket.store.get('rp-sync/main/chunks/' + 'f'.repeat(64) + '.gz').uploaded = new Date(Date.now() - 2 * DAY);
const v6c = snapshot(6, [line('a', 400), line('b', 402), line('c', 400)]);
await push(v6c, 3, true);
const referenced = new Set();
for (const [key, item] of bucket.store) {
    if (key.includes('manifest')) for (const chunk of JSON.parse(new TextDecoder().decode(item.bytes)).chunkManifest || []) referenced.add(chunk.key);
}
for (const key of referenced) assert.ok(bucket.store.has(key), `referenced chunk was deleted: ${key}`);
assert.ok([...referenced].some((key) => key.endsWith('.gz')));
assert.equal(bucket.store.has('rp-sync/main/chunks/' + 'f'.repeat(64) + '.gz'), false, 'unreferenced old chunk should be cleaned up');
console.log('PASS chunk cleanup keeps every chunk referenced by recent compressed or uncompressed manifests');
