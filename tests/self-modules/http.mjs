import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || fileURLToPath(new URL('../../', import.meta.url)));
const source = fs.readFileSync(path.join(root, 'DB/bootstrap.js'), 'utf8');
const start = source.indexOf('    function buildSyncHeaders('), end = source.indexOf('    function updateProgress(', start);
let cleared = 0;
const replies = [], requests = [], delays = [];
const context = { Error, Uint8Array, AbortController, URLSearchParams, setTimeout, clearTimeout,
    CONFIG: { apiEndpoint: '/fixture-sync', retryCount: 2, requestTimeoutMs: 100, retryDelayMs: 1, transferTimeoutMs: 100 },
    getStoredSyncPassword: () => 'fixture-password', clearStoredSyncPassword: () => { cleared++; },
    wait: async ms => { delays.push(ms); },
    fetch: async (url, init) => { requests.push({ url, init }); return replies.shift()(init); } };
vm.runInNewContext(source.slice(start, end) + '\nglobalThis.api = { postSync, postSyncBinary, postUploadPart };', context);

replies.push(() => Response.json({ error: 'try again' }, { status: 503 }), () => Response.json({ ok: true }));
await context.api.postSync({ action: 'status' });
assert.equal(requests.length, 2);
assert.deepEqual(delays, [1]);
assert.equal(requests[0].init.body, requests[1].init.body);
assert.equal(requests[0].init.headers['x-rp-sync-password'], 'fixture-password');
for (const status of [401, 409]) {
    const count = requests.length;
    replies.push(() => Response.json({ error: 'blocked' }, { status }));
    await assert.rejects(context.api.postSync({ action: 'status' }), error => error.status === status);
    assert.equal(requests.length, count + 1, 'auth/conflict errors must not be retried');
}
assert.equal(cleared, 1);
replies.push(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'x-rp-sync-byte-length': '3', 'x-rp-sync-part-lengths': '1,2' } }));
const bytes = await context.api.postSyncBinary({ action: 'pull-json-part' });
assert.deepEqual([...bytes.bytes], [1, 2, 3]);
assert.equal(bytes.partLengths, '1,2');
assert.equal(bytes.byteLength, 3);
const count = requests.length;
await assert.rejects(context.api.postSyncBinary({}, { shouldStop: () => true }), /停止重试/);
assert.equal(requests.length, count);
replies.push(init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')))));
await assert.rejects(context.api.postSync({}, { timeoutMs: 5, retryCount: 0 }), /超时/);
replies.push(() => Response.json({ ok: true, partNumber: 3, key: 'chunk' }));
const uploaded = await context.api.postUploadPart({ index: 2, length: 20, checksum: 'raw', body: new Uint8Array([1]), encoding: 'gzip', storedLength: 1, storedChecksum: 'zip' });
assert.equal(uploaded.index, 2);
assert.equal(uploaded.byteLength, 20);
assert.equal(requests.at(-1).init.headers['x-rp-part-stored-checksum'], 'zip');
assert.match(requests.at(-1).url, /action=upload-part&index=2&partNumber=3/);
console.log('PASS sync retry, auth/conflict errors, cancellation, timeout, binary headers, and compressed upload');

const { default: worker } = await import(pathToFileURL(path.join(root, '_worker.js')));
const env = { RP_SYNC_PASSWORD: 'fixture-password', RP_SYNC_R2: { get() {}, put() {}, delete() {}, list() {} } };
for (const action of ['toString', 'constructor', 'unsupported']) {
    const response = await worker.fetch(new Request('https://fixture.test/api/rp-sync', {
        method: 'POST', headers: { 'x-rp-sync-password': 'fixture-password' }, body: JSON.stringify({ action })
    }), env, {});
    assert.equal(response.status, 404);
}
const denied = await worker.fetch(new Request('https://fixture.test/api/rp-sync', {
    method: 'POST', body: JSON.stringify({ action: 'upload-create' })
}), env, {});
assert.equal(denied.status, 401);
console.log('PASS server action dispatch rejects unknown names and requires authentication');
