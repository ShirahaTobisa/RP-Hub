import assert from 'node:assert/strict';
import worker from '../_worker.js';

// 测试版生图设置（存在 R2）、R2 存储统计与清理、网页任务生图（Nai2API POST /api/web/jobs）。
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
assert.deepEqual(result.body.settings, { mode: 'direct', steps: 28, storageLimitGb: 9 });
result = await call('/image/api/settings', { method: 'PUT', body: JSON.stringify({ mode: 'web', steps: 99, storageLimitGb: 0.001 }) });
assert.deepEqual(result.body.settings, { mode: 'web', steps: 50, storageLimitGb: 9 }, 'a limit that rounds to 0 would plan deleting every image');
result = await call('/image/api/settings', { method: 'PUT', body: JSON.stringify({ steps: 35 }) });
assert.deepEqual(result.body.settings, { mode: 'web', steps: 35, storageLimitGb: 9 });
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

// 网页任务：提交 → 查询到完成 → 取图 → 存进 R2；步数取设置里的值。
const upstream = [];
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    upstream.push({ path: url.pathname, method: init.method || 'GET', auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null });
    assert.equal(url.origin, 'https://nai.sta1n.cn');
    if (url.pathname === '/api/web/jobs') return Response.json({ id: 'job_1', status: 'queued' }, { status: 202 });
    if (url.pathname === '/api/jobs/job_1') return Response.json({ id: 'job_1', status: 'done', imageUrl: '/api/images/i/content' });
    if (url.pathname === '/api/jobs/job_1/content') return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Response('missing', { status: 404 });
};
globalThis.setTimeout = (fn) => { fn(); return 0; };
try {
    const query = new URLSearchParams({ tag: '1girl', character_name: '丙', model: 'nai-diffusion-4-5-full', size: '竖图', steps: '40', scale: '6', cfg: '0', sampler: 'k_dpmpp_2m_sde', noise_schedule: 'karras', nocache: '0', provider: 'sta1n', token: 'STA1N-fixture' });
    const response = await worker.fetch(new Request(`https://rph.example/api/rp-image?${query}`, { method: 'POST' }), env, { waitUntil() {} });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('x-rp-image-cache'), 'MISS');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
} finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realTimeout;
}
assert.deepEqual(upstream.map((item) => item.path), ['/api/web/jobs', '/api/jobs/job_1', '/api/jobs/job_1/content']);
assert.equal(upstream[0].method, 'POST');
assert.equal(upstream[0].auth, 'Bearer STA1N-fixture');
assert.equal(upstream[0].body.steps, 35);
assert.equal(upstream[0].body.tag, '1girl');
assert.ok([...bucket.store.keys()].some((key) => key.startsWith('rp-images/characters/丙/')));
console.log('PASS web-job mode submits, polls and stores the image using the configured steps');
