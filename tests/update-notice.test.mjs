import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../_worker.js';

// 1.9.x 的公告弹窗倒计时 10 秒才能关闭；外壳返回 ui-components.js 时应去掉倒计时，其他文件原样返回。
const source = fs.readFileSync(new URL('../assets/js/ui-components.js', import.meta.url), 'utf8');
assert.match(source, /countdownEndsAt = Date\.now\(\) \+ 10_000;/, 'bundled base must still contain the upstream countdown');
const env = {
    RP_SYNC_R2: { get: async () => null, put: async () => null, delete: async () => {}, list: async () => ({ objects: [] }) },
    ASSETS: { fetch: async (request) => new Response(new URL(request.url).pathname === '/assets/js/ui-components.js' ? source : 'other countdownEndsAt = Date.now() + 10_000;', {
        headers: { 'content-type': 'application/javascript; charset=utf-8', etag: '"x"' }
    }) }
};
const served = await worker.fetch(new Request('https://rph.example/assets/js/ui-components.js'), env, { waitUntil() {} });
const text = await served.text();
assert.doesNotMatch(text, /Date\.now\(\) \+ 10_000/);
assert.match(text, /countdownEndsAt = Date\.now\(\);/);
assert.equal(text.length, source.length - ' + 10_000'.length);
assert.equal(served.headers.get('etag'), null);
const other = await worker.fetch(new Request('https://rph.example/assets/js/app.js'), env, { waitUntil() {} });
assert.match(await other.text(), /\+ 10_000/);
console.log('PASS update notice countdown removed only from ui-components.js');
