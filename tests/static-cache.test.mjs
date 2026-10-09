import assert from 'node:assert/strict';
import worker from '../_worker.js';
import { RP_HUB_APP_PATCH_REVISION } from '../DB/app-patches.mjs';

// Node 没有 Cloudflare 的 HTMLRewriter；这里只检查响应头，用不做改写的替身。
globalThis.HTMLRewriter ??= class { on() { return this; } transform(response) { return response; } };

// 静态文件缓存：R2 里在线更新的上游文件带 ETag 并支持 304；首页不缓存；带内容哈希的覆盖层长期缓存。
const files = new Map([['assets/js/app.js', 'console.log("app")'], ['index.html', '<html><head></head><body></body></html>']]);
const manifest = { current: { slot: 'a', upstreamTag: '2.0.0', patchRevision: RP_HUB_APP_PATCH_REVISION, appliedAt: 1 } };
const bucket = {
    async get(key) {
        if (key === 'rp-app-update/manifest.json') return { async json() { return manifest; }, async text() { return JSON.stringify(manifest); } };
        const path = key.replace(/^rp-app-update\/a\//, '');
        if (!files.has(path)) return null;
        return { body: new Blob([files.get(path)]).stream(), httpEtag: '"etag-' + path + '"', httpMetadata: {} };
    },
    put: async () => null, delete: async () => {}, list: async () => ({ objects: [] })
};
const assets = { fetch: async (request) => new Response('/* overlay */', { headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=0, must-revalidate' } }) };
const env = { RP_SYNC_R2: bucket, ASSETS: assets };
const get = (path, headers = {}) => worker.fetch(new Request('https://rph.example' + path, { headers }), env, { waitUntil() {} });

let response = await get('/assets/js/app.js');
const key = response.headers.get('etag');
assert.equal(response.status, 200);
assert.equal(key, '"etag-assets/js/app.js"');
assert.equal(response.headers.get('cache-control'), 'no-cache');
assert.equal(await response.text(), 'console.log("app")');
response = await get('/assets/js/app.js', { 'if-none-match': key });
assert.equal(response.status, 304);
assert.equal(await response.text(), '');
response = await get('/');
assert.equal(response.headers.get('etag'), null, 'the injected home page must not be revalidated from R2');
assert.equal(response.headers.get('cache-control'), 'no-store');
console.log('PASS updated upstream files revalidate with ETag/304; the home page stays uncached');
response = await get('/DB/bootstrap.js?v=0123456789ab');
assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
response = await get('/DB/bootstrap.js?v=r2-rebuild-1');
assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
response = await get('/DB/modules/advice-inject.js');
assert.equal(response.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
console.log('PASS content-hashed overlay files are cached long-term; other files keep the default');
