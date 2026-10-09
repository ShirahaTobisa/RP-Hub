import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../_worker.js';

// 测试版自更新：分发端清单 → 校验发布包 → 按 Cloudflare Pages 直传流程部署；以及回退和各种拒绝情形。
const MIRROR = 'https://mirror.test';
const PASSWORD = 'fixture-sync-password';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const bundleText = JSON.stringify({
    format: 'rph-release-bundle-v1',
    version: '2026.10.09.2',
    worker: "export default { fetch() { return new Response('new'); } };",
    assets: [
        { path: 'index.html', base64: Buffer.from('<h1>new</h1>').toString('base64') },
        { path: 'DB/module-loader.js', base64: Buffer.from('/* loader */').toString('base64') }
    ]
});
let mirrorManifest;
const resetMirror = () => {
    mirrorManifest = {
        schema: 1,
        versions: [
            { tag: '2026.10.09.2', name: '测试版 2026.10.09.2', notes: '新功能', publishedAt: 2,
                bundle: { path: '/test-releases/2026.10.09.2/bundle.json', sha256: sha256(bundleText) },
                zip: { path: '/test-releases/2026.10.09.2/RP-Hub-2026.10.09.2.zip' } },
            { tag: '2026.10.09', name: '测试版 2026.10.09', publishedAt: 1,
                bundle: { path: '/test-releases/2026.10.09/bundle.json', sha256: 'a'.repeat(64) } },
            { tag: 'not-a-date', bundle: { path: '/test-releases/x/bundle.json', sha256: 'b'.repeat(64) } }
        ]
    };
};

const calls = [];
let accounts = [];
const ok = (result) => Response.json({ success: true, result });
globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init });
    if (url.origin === MIRROR) {
        if (url.pathname === '/test-releases/manifest.json') return Response.json(mirrorManifest);
        if (url.pathname === '/test-releases/2026.10.09.2/bundle.json') return new Response(bundleText);
        return new Response('missing', { status: 404 });
    }
    assert.equal(url.origin, 'https://api.cloudflare.com');
    const path = url.pathname.replace('/client/v4', '');
    if (path === '/accounts') return ok(accounts);
    if (path === '/accounts/acc-1/pages/projects') {
        return ok(url.searchParams.get('page') === '1' ? [
            { name: 'other', subdomain: 'other.pages.dev', domains: ['other.pages.dev'] },
            { name: 'rph', subdomain: 'rph-8me.pages.dev', domains: ['rph-8me.pages.dev', 'rph.example'], production_branch: 'main', canonical_deployment: { id: 'dep-current' } }
        ] : []);
    }
    if (path === '/accounts/acc-1/pages/projects/rph/upload-token') return ok({ jwt: 'upload-jwt' });
    if (path === '/pages/assets/check-missing') {
        assert.equal(init.headers.authorization, 'Bearer upload-jwt');
        return ok(JSON.parse(init.body).hashes.slice(0, 1));
    }
    if (path === '/pages/assets/upload' || path === '/pages/assets/upsert-hashes') return ok(true);
    if (path === '/accounts/acc-1/pages/projects/rph/deployments' && init.method === 'POST') return ok({ id: 'dep-new', url: 'https://dep-new.rph-8me.pages.dev' });
    if (path === '/accounts/acc-1/pages/projects/rph/deployments') return ok([{ id: 'dep-newer' }, { id: 'dep-current' }, { id: 'dep-previous' }]);
    if (path === '/accounts/acc-1/pages/projects/rph/deployments/dep-previous/rollback') return ok({ id: 'dep-previous', url: 'https://dep-previous.rph-8me.pages.dev' });
    return Response.json({ success: false, errors: [{ message: `unexpected ${path}` }] }, { status: 404 });
};

const fakeBucket = { get: async () => null, put: async () => null, delete: async () => {}, list: async () => ({ objects: [] }) };
const baseEnv = { RP_SYNC_PASSWORD: PASSWORD, RP_SYNC_R2: fakeBucket, APP_UPDATE_MIRROR_BASE: MIRROR };
async function call(action, env, body = {}) {
    const response = await worker.fetch(new Request('https://rph.example/api/rp-sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rp-sync-password': PASSWORD },
        body: JSON.stringify({ action, ...body })
    }), env, { waitUntil() {} });
    return { status: response.status, body: await response.json() };
}
const cfCalls = () => calls.filter((item) => item.url.startsWith('https://api.cloudflare.com'));

resetMirror();
let result = await call('self-update-status', baseEnv);
assert.equal(result.status, 200);
assert.equal(result.body.current, 'dev');
assert.equal(result.body.latest, '2026.10.09.2');
assert.equal(result.body.updateAvailable, true);
assert.equal(result.body.selfDeploy, false);
assert.deepEqual(result.body.versions.map((version) => version.tag), ['2026.10.09.2', '2026.10.09']);
assert.equal(result.body.versions[0].zipUrl, `${MIRROR}/test-releases/2026.10.09.2/RP-Hub-2026.10.09.2.zip`);
console.log('PASS status lists valid mirror test releases and flags the update');

result = await call('self-update-apply', baseEnv);
assert.equal(result.status, 409);
assert.match(result.body.error, /CF_API_TOKEN/);
result = await call('self-update-apply', { ...baseEnv, CF_API_TOKEN: 'cf-token' });
assert.equal(result.status, 409);
assert.match(result.body.error, /帐户设置：读取|CF_ACCOUNT_ID/);
console.log('PASS apply refuses without a token, and explains how to provide the account');

calls.length = 0;
accounts = [{ id: 'acc-1' }];
result = await call('self-update-apply', { ...baseEnv, CF_API_TOKEN: 'cf-token' });
assert.equal(result.status, 200, JSON.stringify(result.body));
assert.deepEqual(result.body, { ok: true, version: '2026.10.09.2', deployment: { id: 'dep-new', url: 'https://dep-new.rph-8me.pages.dev', uploaded: 1 } });
const deploy = cfCalls().find((item) => item.url.endsWith('/pages/projects/rph/deployments') && item.init.method === 'POST');
assert.equal(deploy.init.headers.authorization, 'Bearer cf-token');
const form = deploy.init.body;
assert.equal(form.get('branch'), 'main');
assert.deepEqual(Object.keys(JSON.parse(form.get('manifest'))).sort(), ['/DB/module-loader.js', '/index.html']);
const workerBundleText = await form.get('_worker.bundle').text();
const boundary = workerBundleText.match(/^--(.+)\r\n/)[1];
const workerBundle = await new Response(workerBundleText, { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }).formData();
assert.deepEqual(JSON.parse(workerBundle.get('metadata')), { main_module: '_worker.js' });
assert.equal(await workerBundle.get('_worker.js').text(), "export default { fetch() { return new Response('new'); } };");
const uploads = JSON.parse(cfCalls().find((item) => item.url.endsWith('/pages/assets/upload')).init.body);
assert.equal(uploads.length, 1);
assert.equal(uploads[0].base64, true);
console.log('PASS apply finds the project by host, uploads only missing assets and deploys the bundled worker');

calls.length = 0;
mirrorManifest.versions[0].bundle.sha256 = 'c'.repeat(64);
result = await call('self-update-apply', { ...baseEnv, CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'acc-1' });
assert.equal(result.status, 502);
assert.match(result.body.error, /校验失败/);
assert.ok(!cfCalls().some((item) => item.url.includes('upload-token')), 'nothing may be uploaded after a failed checksum');
resetMirror();
result = await call('self-update-apply', { ...baseEnv, CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'acc-1' }, { target: '2099.01.01' });
assert.equal(result.status, 404);
console.log('PASS checksum mismatch and unknown versions are rejected before deploying');

result = await worker.fetch(new Request('https://rph.example/api/rp-sync', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'self-update-apply' })
}), { ...baseEnv, CF_API_TOKEN: 'cf-token' }, { waitUntil() {} });
assert.equal(result.status, 401);
console.log('PASS self-update actions require the sync password');

calls.length = 0;
result = await call('self-update-rollback', { ...baseEnv, CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: 'acc-1' });
assert.deepEqual(result.body, { ok: true, deployment: { id: 'dep-previous', url: 'https://dep-previous.rph-8me.pages.dev' } });
console.log('PASS rollback switches to the deployment before the current one');
