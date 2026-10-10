import assert from 'node:assert/strict';
import worker from '../_worker.js';

// 测试版生图设置（存在 R2）、R2 存储统计与清理、生图插件上传图片。
const PASSWORD = 'fixture-sync-password';
const GB = 1024 ** 3;

function fakeBucket() {
    const store = new Map();
    return {
        store,
        async get(key) {
            const item = store.get(key);
            if (!item) return null;
            return { ...item, body: new Blob([item.bytes]).stream(), async text() { return new TextDecoder().decode(item.bytes); } };
        },
        async put(key, value, options = {}) {
            const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
            store.set(key, { key, bytes, size: options.size ?? bytes.byteLength, uploaded: options.uploaded || new Date(), httpMetadata: options.httpMetadata || {}, customMetadata: options.customMetadata || {} });
        },
        async delete(keys) { for (const key of [].concat(keys)) store.delete(key); },
        async list({ prefix = '' } = {}) {
            return { objects: [...store.values()].filter((item) => item.key.startsWith(prefix)).map(({ bytes, ...item }) => item), truncated: false };
        }
    };
}

const bucket = fakeBucket();
const env = { RP_SYNC_R2: bucket, RP_SYNC_PASSWORD: PASSWORD, ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
const call = async (path, init = {}) => {
    const response = await worker.fetch(new Request(`https://rph.example${path}`, {
        ...init, headers: { 'x-rp-sync-password': PASSWORD, 'content-type': 'application/json', ...(init.headers || {}) }
    }), env, { waitUntil() {} });
    return { status: response.status, body: await response.json() };
};

let result = await call('/image/api/settings');
assert.deepEqual(result.body.settings, { storageLimitGb: 9, generator: 'direct', params: { steps: 28, scale: 6, cfg: 0, sampler: 'k_dpmpp_2m_sde', noise_schedule: 'karras', negative: '' } });
result = await call('/image/api/settings', { method: 'PUT', body: JSON.stringify({ storageLimitGb: 0.001, generator: 'nai2api-web', params: { steps: 99, scale: 7.25, sampler: 'bogus' } }) });
assert.equal(result.body.settings.storageLimitGb, 9, 'a limit that rounds to 0 would plan deleting every image');
assert.equal(result.body.settings.generator, 'nai2api-web');
assert.deepEqual(result.body.settings.params, { steps: 50, scale: 7.3, cfg: 0, sampler: 'k_dpmpp_2m_sde', noise_schedule: 'karras', negative: '' });
result = await call('/image/api/settings', { method: 'PUT', body: JSON.stringify({ params: { steps: 35 } }) });
assert.equal(result.body.settings.params.steps, 35);
assert.equal(result.body.settings.params.scale, 7.3, 'saving one parameter keeps the others');
assert.equal((await worker.fetch(new Request('https://rph.example/image/api/settings'), env, { waitUntil() {} })).status, 401);
console.log('PASS image settings are stored in R2, clamped, merged and require the sync password');

// 存储：3 张图 + 缩略图 + 同步数据；上限 1 GB 时从最旧的图开始删，直到回到上限以下。
const day = 86_400_000;
const imageKey = (name, n) => `rp-images/characters/${name}/${String(n).repeat(64).slice(0, 64)}`;
await bucket.put(imageKey('甲', 1), new Uint8Array(1), { size: 0.6 * GB, uploaded: new Date(Date.now() - 3 * day) });
await bucket.put(`rp-images/thumbs/甲/${'1'.repeat(64)}.webp`, new Uint8Array(1), { size: 1024 });
await bucket.put(imageKey('乙', 2), new Uint8Array(1), { size: 0.5 * GB, uploaded: new Date(Date.now() - 2 * day) });
await bucket.put(imageKey('甲', 3), new Uint8Array(1), { size: 0.3 * GB, uploaded: new Date(Date.now() - day) });
await bucket.put('rp-sync/default/chunks/a.bin', new Uint8Array(1), { size: 0.2 * GB });
await call('/image/api/settings', { method: 'PUT', body: JSON.stringify({ storageLimitGb: 1 }) });
result = await call('/image/api/storage');
assert.equal(result.body.over, true);
assert.equal(result.body.categories.find((item) => item.id === 'images').count, 3);
assert.equal(result.body.categories.find((item) => item.id === 'sync').bytes, 0.2 * GB);
assert.deepEqual(result.body.cleanup.keys, [imageKey('甲', 1), imageKey('乙', 2)], 'oldest first, only until under the limit');
assert.equal(result.body.cleanup.enough, true);
result = await call('/image/api/storage/cleanup', { method: 'POST', body: '{}' });
assert.deepEqual([result.body.deletedCount, result.body.remaining], [2, 0]);
assert.ok(!bucket.store.has(imageKey('甲', 1)) && !bucket.store.has(`rp-images/thumbs/甲/${'1'.repeat(64)}.webp`));
assert.ok(bucket.store.has(imageKey('甲', 3)));
assert.ok([...bucket.store.keys()].some((key) => key.startsWith('rp-images/_deleted/')), 'cleanup leaves a tombstone so the chat shows “deleted” instead of regenerating');
assert.equal((await call('/image/api/storage')).body.over, false);
console.log('PASS storage report groups usage, plans oldest-first cleanup and deletes with tombstones');

// 生图插件：浏览器里生成好图片后 PUT 上传，外壳按参数算出存放位置；需要同步密码，只收图片。
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const query = new URLSearchParams({ tag: '1girl', character_name: '丙', model: 'nai-diffusion-4-5-full', size: '竖图', steps: '35', scale: '6', cfg: '0', sampler: 'k_dpmpp_2m_sde', noise_schedule: 'karras', nocache: '0', provider: 'sta1n' });
const upload = (headers, body = png) => worker.fetch(new Request(`https://rph.example/api/rp-image?${query}`, { method: 'PUT', headers, body }), env, { waitUntil() {} });
assert.equal((await upload({ 'content-type': 'image/png' })).status, 401);
assert.equal((await upload({ 'content-type': 'text/html', 'x-rp-sync-password': PASSWORD }, '<script>')).status, 415);
const uploaded = await upload({ 'content-type': 'image/png', 'x-rp-sync-password': PASSWORD });
assert.equal(uploaded.status, 200, await uploaded.clone().text());
const storedKey = decodeURIComponent(uploaded.headers.get('x-rp-image-key'));
assert.ok(storedKey.startsWith('rp-images/characters/丙/'));
const read = await worker.fetch(new Request(`https://rph.example/api/rp-image?${query}`), env, { waitUntil() {} });
assert.equal(read.headers.get('x-rp-image-cache'), 'HIT', 'the uploaded image is found at the same place a direct-link image would be');
assert.deepEqual(new Uint8Array(await read.arrayBuffer()), png);
console.log('PASS plugin uploads are stored where the same params would be cached, and need the sync password');
