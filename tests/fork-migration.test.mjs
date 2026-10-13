import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker from '../_worker.js';

// 魔改版（cy-2-u/rp）换成测试版后，同一个存储桶里还是魔改版的云端数据：
// 拉取清单时报出来；按页取清单、按校验码取数据包；第一次上传前把它的根清单另存一份。
// 迁移来的图按记录里存的 R2 位置显示，只读：不进缓存键，生成时不用它。
const PASSWORD = 'fixture-sync-password';
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const store = new Map();
let etag = 0;
const view = (item) => ({
    ...item, httpEtag: `"${item.etag}"`, body: item.bytes,
    async text() { return new TextDecoder().decode(item.bytes); },
    async arrayBuffer() { return item.bytes.slice().buffer; }
});
const bucket = {
    async get(key) { const item = store.get(key); return item ? view(item) : null; },
    async head(key) { const item = store.get(key); return item ? view(item) : null; },
    async put(key, value, options = {}) {
        const current = store.get(key);
        if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
        if (options.onlyIf?.etagDoesNotMatch === '*' && current) return null;
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(ArrayBuffer.isView(value) ? value : new Uint8Array(value));
        const item = { key, bytes, size: bytes.byteLength, uploaded: new Date(), etag: `e${++etag}`, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata || {} };
        store.set(key, item);
        return view(item);
    },
    async delete(keys) { for (const key of [].concat(keys)) store.delete(key); },
    async list({ prefix = '' } = {}) {
        return { objects: [...store.values()].filter((item) => item.key.startsWith(prefix)).map(({ bytes, ...item }) => item), truncated: false };
    }
};
const waits = [];
const env = { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: PASSWORD, APP_UPDATE_MIRROR_BASE: 'off', ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
const ctx = { waitUntil(promise) { waits.push(promise); } };
const call = (url, init = {}) => worker.fetch(new Request(url, init), env, ctx);
const api = async (body) => {
    const response = await call('https://rph.example/api/rp-sync', {
        method: 'POST', headers: { 'x-rp-sync-password': PASSWORD, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return response.headers.get('content-type')?.includes('json') ? { status: response.status, body: await response.json() } : response;
};

const pack = Buffer.from('{"type":"localStorage","key":"rp_hub_theme","value":"dark"}\n');
const packSum = sha256(pack);
const root = {
    format: 'rp-sync-manifest-root-v1', version: 7, checksum: 'a'.repeat(64), updatedAt: 1760000000000,
    totalBytes: pack.length, packCount: 1, entryCount: 1, pageCount: 1, pageRoot: 'b'.repeat(64), bloomChecksum: 'c'.repeat(64),
    snapshotFormat: 'rp-sync-paged-jsonl-v4', schemaVersion: 13
};
await bucket.put('rp-sync/main/manifest.json', JSON.stringify(root));
await bucket.put(`rp-sync/main/manifests/${root.checksum}/0000.json`, JSON.stringify({
    format: 'rp-sync-manifest-page-v1', checksum: root.checksum, pageIndex: 0,
    packs: [{ bucketKey: 'localStorage|s001', group: 'localStorage', part: 0, checksum: packSum, length: pack.length, entryCount: 1 }]
}));
await bucket.put(`rp-sync/main/packs/${packSum}.bin`, pack);

const status = await api({ action: 'pull-manifest' });
assert.equal(status.body.remote, null);
const { format, ...forkInfo } = root;
assert.deepEqual(status.body.fork, forkInfo);
console.log('PASS pull-manifest reports the fork snapshot next to an empty remote');

const page = await api({ action: 'fork-page', checksum: root.checksum, index: 0 });
assert.equal(page.body.packs[0].checksum, packSum);
assert.equal((await api({ action: 'fork-page', checksum: root.checksum, index: 1 })).status, 404);
assert.equal((await api({ action: 'fork-page', checksum: '../manifest', index: 0 })).status, 400);
const packs = await api({ action: 'fork-packs', checksums: [packSum, packSum] });
assert.equal(Buffer.from(await packs.arrayBuffer()).toString(), pack.toString().repeat(2));
assert.equal((await api({ action: 'fork-packs', checksums: ['f'.repeat(64)] })).status, 404);
assert.equal((await api({ action: 'fork-packs', checksums: ['../manifest.json'] })).status, 400);
assert.equal((await worker.fetch(new Request('https://rph.example/api/rp-sync', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'fork-packs', checksums: [packSum] })
}), env, ctx)).status, 401);
console.log('PASS manifest pages and packs are served by checksum, behind the sync password');

const raw = Buffer.from('{"type":"snapshot"}\n');
const chunkManifest = [{ index: 0, checksum: sha256(raw), length: raw.length }];
const meta = {
    snapshotFormat: 'rp-sync-jsonl-v1', schemaVersion: 4, chunkerProfile: 'rph-jsonl-cdc-fnv1a-v1', recordCount: 1, totalBytes: raw.length,
    chunkSize: 2097152, chunkCount: 1, chunkManifest,
    checksum: sha256(JSON.stringify(['rp-sync-jsonl-v1', 4, 1, raw.length, chunkManifest.map((chunk) => [chunk.checksum, chunk.length])]))
};
const created = await api({ action: 'upload-create', ...meta });
assert.equal(created.status, 200, JSON.stringify(created.body));
const part = await call('https://rph.example/api/rp-sync?action=upload-part&index=0&partNumber=1', {
    method: 'POST', headers: { 'x-rp-sync-password': PASSWORD, 'x-rp-part-checksum': chunkManifest[0].checksum, 'x-rp-part-length': String(raw.length) }, body: raw
});
assert.equal(part.status, 200);
const done = await api({ action: 'upload-complete', ...meta, expectedVersion: created.body.previousVersion });
assert.equal(done.status, 200, JSON.stringify(done.body));
await Promise.all(waits.splice(0));
assert.deepEqual(JSON.parse(await (await bucket.get('rp-sync/main/fork-root-backup.json')).text()), root);
const after = await api({ action: 'pull-manifest' });
assert.equal(after.body.remote.checksum, meta.checksum);
assert.equal(after.body.fork, undefined);
assert.ok(store.has(`rp-sync/main/packs/${packSum}.bin`), 'fork packs stay in the bucket');
console.log('PASS the first upload keeps a copy of the fork root, then the cloud is ours');

const image = Buffer.from('fake png bytes');
const imageKey = `rp-images/characters/角色A/${'d'.repeat(64)}`;
await bucket.put(imageKey, image, { httpMetadata: { contentType: 'image/png' } });
const imageUrl = (extra = '') => `https://rph.example/api/rp-image?tag=${encodeURIComponent('1girl, smile')}&model=nai-diffusion-4-5-full&character_name=${encodeURIComponent('角色A')}${extra}`;
const shown = await call(imageUrl(`&image_key=${encodeURIComponent(imageKey)}`));
assert.equal(shown.status, 200);
assert.equal(shown.headers.get('x-rp-image-cache'), 'HIT');
assert.equal(Buffer.from(await shown.arrayBuffer()).toString(), image.toString());
const plain = await call(imageUrl());
const missing = await call(imageUrl(`&image_key=${encodeURIComponent(`rp-images/characters/角色A/${'e'.repeat(64)}`)}`));
assert.equal(plain.status, 404);
assert.equal(missing.status, 404);
assert.equal(missing.headers.get('x-rp-image-key'), plain.headers.get('x-rp-image-key'), 'image_key is not part of the cache key');
assert.equal((await call(imageUrl(`&image_key=${encodeURIComponent('rp-sync/main/manifest.json')}`))).status, 404);
const generate = await call(imageUrl(`&image_key=${encodeURIComponent(imageKey)}`), { method: 'POST' });
assert.notEqual(generate.status, 200, 'generation never answers with the migrated image');
console.log('PASS migrated images show by their stored location, read-only and outside the cache key');

// 反过来换成魔改版：页面转好的数据包按校验码落盘（条数记进元数据，魔改版下载时要核对）；
// 提交时分页哈希链、布隆过滤器、根清单校验码都重算，对得上才换上根清单，测试版的清单另存一份。
const forkPack = Buffer.from('{"key":"rp_hub_theme","type":"localStorage","value":"dark"}\n{"key":"rp_hub_x","type":"localStorage","value":"1"}\n');
const forkPackSum = sha256(forkPack);
const sendPack = (bytes, checksum = sha256(bytes), password = PASSWORD) => call(`https://rph.example/api/rp-sync?action=fork-export-pack&checksum=${checksum}`, {
    method: 'POST', headers: { 'x-rp-sync-password': password, 'content-type': 'application/octet-stream' }, body: bytes
});
assert.equal((await sendPack(forkPack, 'f'.repeat(64))).status, 409);
assert.equal((await sendPack(forkPack, '../manifest')).status, 400);
assert.equal((await sendPack(forkPack, undefined, 'wrong')).status, 401);
assert.equal((await sendPack(forkPack)).status, 200);
assert.equal(store.get(`rp-sync/main/packs/${forkPackSum}.bin`).customMetadata.entryCount, '2');

const descriptor = { bucketKey: 'localStorage|s001', group: 'localStorage', part: 0, checksum: forkPackSum, length: forkPack.length, entryCount: 2 };
const pageHash = sha256(JSON.stringify(['rp-sync-manifest-page-v1', 0, '0'.repeat(64), [[descriptor.bucketKey, descriptor.group, 0, forkPackSum, forkPack.length, 2]]]));
const bloom = Buffer.alloc(32 * 1024);
for (const offset of [0, 8, 16, 24]) {
    const bit = parseInt(forkPackSum.slice(offset, offset + 8), 16) % (32 * 1024 * 8);
    bloom[bit >>> 3] |= 1 << (bit & 7);
}
const exportRoot = sha256(JSON.stringify(['rp-sync-paged-jsonl-v4', 13, forkPack.length, 1, 2, 1, pageHash, sha256(bloom)]));
const commit = (patch = {}) => api({
    action: 'fork-export-commit', expectedChecksum: meta.checksum, checksum: exportRoot,
    pages: [{ previousPageHash: '0'.repeat(64), pageHash, packs: [descriptor] }], bloom: bloom.toString('base64'), ...patch
});
const ours = JSON.parse(await (await bucket.get('rp-sync/main/manifest.json')).text());
assert.equal((await commit({ expectedChecksum: 'e'.repeat(64) })).status, 409);
assert.equal((await commit({ pages: [{ previousPageHash: '0'.repeat(64), pageHash: 'a'.repeat(64), packs: [descriptor] }] })).status, 400);
assert.equal((await commit({ checksum: 'b'.repeat(64) })).status, 400);
assert.equal((await commit({ bloom: 'AAAA' })).status, 400);
assert.equal(JSON.parse(await (await bucket.get('rp-sync/main/manifest.json')).text()).checksum, meta.checksum, 'refused commits leave the cloud as it was');
const committed = await commit();
assert.equal(committed.status, 200, JSON.stringify(committed.body));
const switched = JSON.parse(await (await bucket.get('rp-sync/main/manifest.json')).text());
assert.equal(switched.format, 'rp-sync-manifest-root-v1');
assert.equal(switched.checksum, exportRoot);
assert.equal(switched.version, 8, 'the converted root follows the fork root it once replaced');
assert.deepEqual(JSON.parse(await (await bucket.get('rp-sync/main/test-root-backup.json')).text()), ours);
assert.deepEqual(JSON.parse(await (await bucket.get(`rp-sync/main/manifests/${exportRoot}/0000.json`)).text()),
    { format: 'rp-sync-manifest-page-v1', checksum: exportRoot, pageIndex: 0, previousPageHash: '0'.repeat(64), pageHash, packs: [descriptor] });
assert.ok(store.has(`rp-sync/main/blooms/${sha256(bloom)}.bin`));
assert.equal(JSON.parse(await (await bucket.get('rp-sync/main/migration-v13.done')).text()).legacyEtag, null, 'the fork reads this root instead of skipping it as old data');
assert.equal((await api({ action: 'pull-manifest' })).body.fork.checksum, exportRoot);
console.log('PASS converted fork data is checked before the root is switched, and the test build manifest is kept');
