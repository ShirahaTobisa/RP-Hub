import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.env.RPH_MIRROR_DIR) throw new Error('Set RPH_MIRROR_DIR to the RP-Hub-Update-Mirror checkout.');
const mirrorRoot = path.resolve(process.env.RPH_MIRROR_DIR);
const { default: mirror } = await import(pathToFileURL(path.join(mirrorRoot, 'worker.mjs')));
const { FakeR2 } = await import(pathToFileURL(path.join(mirrorRoot, 'tests/r2.mjs')));

const built = path.resolve(process.argv[2] || fileURLToPath(new URL('../../', import.meta.url)));
const { default: worker } = await import(pathToFileURL(path.join(built, '_worker.js')));
// 支持元数据和分页，验证实际 R2 列表协议，不依赖旧测试替身的一页简化行为。
class Bucket extends FakeR2 {
    async list({ prefix = '', cursor = '', limit = 1000, include = [] } = {}) {
        const keys = [...this.records.keys()].filter(key => key.startsWith(prefix) && key > cursor).sort();
        const selected = keys.slice(0, limit);
        return { objects: selected.map(key => ({ key, ...(include.includes('customMetadata') ? { customMetadata: this.records.get(key).customMetadata } : {}) })),
            truncated: keys.length > limit, cursor: keys.length > limit ? selected.at(-1) : undefined };
    }
}
const receiver = { MIRROR_BUCKET: new Bucket(), ADMIN_TOKEN: 'admin-secret' };
const mirrorCalls = [], cfCalls = [];
globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === 'https://mirror.test') {
        mirrorCalls.push({ url: request.url, headers: Object.fromEntries(request.headers), body: await request.clone().json() });
        return mirror.fetch(request, receiver);
    }
    cfCalls.push(url.pathname);
    if (url.pathname.endsWith('/accounts')) return Response.json({ success: true, result: [{ id: 'account-one' }] });
    if (url.pathname.endsWith('/accounts/account-one/pages/projects')) return Response.json({ success: true, result: [{ name: 'site', subdomain: 'site.pages.dev', domains: ['site.test'] }] });
    throw new Error('Unexpected request ' + request.url);
};
const site = (extra = {}) => ({ RP_SYNC_R2: new Bucket(), RP_SYNC_PASSWORD: 'sync-secret', APP_UPDATE_MIRROR_BASE: 'https://mirror.test', ...extra });
const call = (env, body, password = 'sync-secret') => worker.fetch(new Request('https://site.test/api/rp-feedback', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rp-sync-password': password }, body: JSON.stringify(body)
}), env, { waitUntil() {} });
const admin = (route, options = {}) => mirror.fetch(new Request('https://mirror.test/api/feedback/' + route, {
    ...options, headers: { authorization: 'Bearer admin-secret' }
}), receiver);
const env = site({ CF_ACCOUNT_ID: 'account-one', CF_API_TOKEN: 'cf-secret' });
assert.equal((await call(env, { action: 'usage' }, '')).status, 401);
assert.equal(mirrorCalls.length, 0);
assert.equal((await call(env, { action: 'usage' })).status, 200);
assert.equal((await call(env, { action: 'usage' })).status, 200);
assert.equal(mirrorCalls.length, 1, 'the site sends at most once per UTC day');
assert.equal(cfCalls.length, 0, 'configured account needs no Cloudflare API call');
assert.equal(mirrorCalls[0].body.account, createHash('sha256').update('rph-usage-v1:account-one').digest('hex'));
for (const secret of ['account-one', 'cf-secret', 'sync-secret']) assert.ok(!JSON.stringify(mirrorCalls).includes(secret));
await call(site({ CF_ACCOUNT_ID: 'account-one' }), { action: 'usage' });
assert.equal((await (await admin('stats')).json()).total, 1, 'two sites in one account count once');
await call(site({ CF_API_TOKEN: 'cf-secret' }), { action: 'usage' });
assert.equal(cfCalls.length, 2, 'reuse existing account and project discovery');
assert.equal((await (await admin('stats')).json()).total, 1);
const previous = mirrorCalls.length;
assert.equal((await (await call(site(), { action: 'usage' })).json()).counted, false);
assert.equal((await (await call(site({ CF_ACCOUNT_ID: 'two', APP_UPDATE_MIRROR_BASE: 'off' }), { action: 'usage' })).json()).counted, false);
assert.equal(mirrorCalls.length, previous, 'missing identity and disabled mirror do not report');
await call(site({ CF_ACCOUNT_ID: 'account-two' }), { action: 'usage' });
let stats = await (await admin('stats')).json();
assert.deepEqual([stats.today, stats.week, stats.month, stats.total], [2, 2, 2, 2]);
const oldKey = receiver.MIRROR_BUCKET.keys('_feedback/usage/')[0];
receiver.MIRROR_BUCKET.records.get(oldKey).customMetadata.at = String(Date.now() - 31 * 86400000);
stats = await (await admin('stats')).json();
assert.deepEqual([stats.today, stats.week, stats.month, stats.total], [1, 1, 1, 2]);
console.log('PASS account hashing, multiple sites/devices, daily send, discovery, missing configuration and active windows');

const report = { schema: 1, release: '2026.11.10.2', upstream: '2.0.6', browser: 'fixture', issue: 'image', note: '切卡后图片不对',
    plugins: [{ id: 'run-log', version: '1', status: 'ok', source: 'do-not-store' }],
    events: [{ at: Date.now(), session: '12345678', kind: 'image-reroll-end', owner: 'C1', current: 'C2', password: 'do-not-store' }], apiKey: 'do-not-store' };
const response = await call(env, { action: 'report', report });
assert.equal(response.status, 200, await response.clone().text());
const { id } = await response.json();
const stored = await (await admin('reports/' + id)).json();
assert.equal(stored.events[0].owner, 'C1');
assert.equal(stored.events[0].current, 'C2');
assert.ok(!JSON.stringify(stored).includes('do-not-store'));
for (const route of ['stats', 'reports', 'reports/' + id]) {
    assert.equal((await mirror.fetch(new Request('https://mirror.test/api/feedback/' + route), receiver)).status, 403);
}
assert.equal((await mirror.fetch(new Request('https://mirror.test/_feedback/reports/' + id), receiver)).status, 404);
assert.equal((await call(env, { action: 'report', report: { ...report, note: 'x'.repeat(128 * 1024) } })).status, 413);
assert.equal((await call(env, { action: 'report', report: { schema: 3 } })).status, 400);
const listing = await (await admin('reports')).json();
assert.equal(listing.reports[0].id, id);
await admin('reports/' + id, { method: 'DELETE' });
assert.equal((await admin('reports/' + id)).status, 404);
console.log('PASS selected report fields, size limit, private retrieval/listing and deletion');

globalThis.fetch = async () => { throw new Error('network down'); };
const offline = site({ CF_ACCOUNT_ID: 'offline' });
assert.equal((await call(offline, { action: 'usage' })).status, 500);
assert.equal(offline.RP_SYNC_R2.keys('_feedback/usage').length, 0, 'failed delivery is not marked successful');
console.log('PASS unavailable receiver does not alter card/chat/sync data');
