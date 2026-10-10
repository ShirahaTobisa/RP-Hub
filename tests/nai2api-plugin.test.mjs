import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Nai2API 网页任务插件：提交 → 串行查询到完成 → 取图；失败报原因；点数提示与 Nai2API 价格表一致。
const source = fs.readFileSync(new URL('../DB/modules/nai2api-web.js', import.meta.url), 'utf8');
let manifest = null;
vm.runInNewContext(source, { RPHubSDK: { register(value) { manifest = value; } }, setTimeout: (fn) => { fn(); return 0; }, fetch: (...args) => globalThis.fetch(...args) });
assert.equal(manifest.id, 'nai2api-web');
assert.equal(manifest.requiresApi, 5);

let provider = null;
const settings = { imageModel: 'nai-diffusion-4-5-full', imageSize: '竖图' };
const storage = new Map();
manifest.init({
    image: { registerProvider(value) { provider = value; } },
    app: { get: (name) => (name === 'settings' ? settings : undefined) },
    storage: { get: (key) => storage.get(key) ?? null, set: (key, value) => storage.set(key, value), remove: (key) => storage.delete(key) },
    ui: { addSidebarEntry() {}, openPanel() {}, toast() {} }
});
assert.equal(provider.id, 'nai2api-web');
assert.equal(provider.maxSteps, 50);
assert.match(provider.costHint({ steps: 28 }), /每张图 1 点/);
assert.match(provider.costHint({ steps: 35 }), /约 24 点（28 步只要 1 点）/);
settings.imageModel = 'nai-diffusion-5-full';
assert.match(provider.costHint({ steps: 50 }), /约 50 点（28 步只要 8 点）/);
console.log('PASS cost hint matches the Nai2API price table (V4.5 28/35 steps = 1/24, V5 50 steps = 50)');

const calls = [];
let polls = 0;
let failNext = false;
globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : null });
    const path = new URL(url).pathname;
    if (path === '/api/web/jobs') return Response.json({ id: 'job_9', status: 'queued' }, { status: 202 });
    if (path === '/api/jobs/job_9') {
        polls += 1;
        if (failNext) return Response.json({ id: 'job_9', status: 'failed', error: '余额不足' });
        return Response.json({ id: 'job_9', status: polls < 3 ? 'running' : 'done' });
    }
    if (path === '/api/jobs/job_9/content') return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    return new Response('missing', { status: 404 });
};
const params = { tag: '1girl', model: 'nai-diffusion-4-5-full', size: '竖图', steps: '35', scale: '6', cfg: '0', sampler: 'k_euler', negative: 'bad', nocache: '0', noise_schedule: 'karras', seed: '42', character_name: '甲', provider: 'sta1n' };
const blob = await provider.generate({ params, token: 'STA1N-fixture' });
assert.equal(blob.type, 'image/png');
assert.equal(calls[0].url, 'https://nai.sta1n.cn/api/web/jobs');
assert.equal(calls[0].method, 'POST');
assert.equal(calls[0].auth, 'Bearer STA1N-fixture');
assert.deepEqual(calls[0].body, { tag: '1girl', model: 'nai-diffusion-4-5-full', size: '竖图', steps: '35', scale: '6', cfg: '0', sampler: 'k_euler', negative: 'bad', nocache: '0', noise_schedule: 'karras', seed: '42' });
assert.equal(polls, 3);
assert.ok(calls.at(-1).url.endsWith('/api/jobs/job_9/content'));
console.log('PASS submits the generation params, polls until done and returns the image');

storage.set('base', 'https://my-nai.example/');
calls.length = 0; polls = 0; failNext = true;
await assert.rejects(provider.generate({ params, token: 'STA1N-fixture' }), /余额不足/);
assert.equal(calls[0].url, 'https://my-nai.example/api/web/jobs');
await assert.rejects(provider.generate({ params, token: '' }), /缺少生图密钥/);
console.log('PASS custom service address, failed jobs and missing keys surface clear errors');
