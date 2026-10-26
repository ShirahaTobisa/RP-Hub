import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchRpHubAppJs, RP_HUB_APP_PATCH_REVISION } from '../DB/app-patches.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Reuse the existing Worker/R2 test implementation without executing its suite.
let support = await fs.readFile(path.join(root, 'tests/worker-hardening.test.mjs'), 'utf8');
support = support.slice(0, support.indexOf('const worker = await loadWorker();'))
    .replace("'../DB/app-patches.mjs'", JSON.stringify(pathToFileURL(path.join(root, 'DB/app-patches.mjs')).href))
    .replace('const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));', `const TEST_DIR = ${JSON.stringify(path.join(root, 'tests'))};`);
support += '\nexport { FakeR2, loadWorker, callApi, seedReleaseCache, WaitUntilContext };';
const { FakeR2, loadWorker, callApi, seedReleaseCache, WaitUntilContext } = await import('data:text/javascript;base64,' + Buffer.from(support).toString('base64'));
const versions = {
    '1.9.4': 'd312bd4b2798dad3f30307afdbd704aac1f80f1a',
    '1.9.5': 'cd7fb2b946f5985991b60597960852671013f36f'
};
const files = {};
for (const [version, sha] of Object.entries(versions)) {
    const directory = path.join(root, `evidence/sync-195/upstream/${version}/RP-Hub-${sha}`);
    files[version] = new Map();
    async function visit(relative = '') {
        for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
            const name = relative ? relative + '/' + entry.name : entry.name;
            if (entry.isDirectory()) await visit(name);
            else files[version].set(name, await fs.readFile(path.join(directory, name)));
        }
    }
    await visit();
}
const worker = await loadWorker({ fetchImpl: async input => {
    const url = new URL(input);
    const version = url.searchParams.get('ref') || [...Object.keys(versions)].find(v => url.pathname.includes('/' + v + '/'));
    if (url.hostname === 'api.github.com' && url.pathname.includes('/contents/')) {
        return Response.json([...files[version]].map(([name, bytes]) => ({ path: name, type: 'file', size: bytes.length })));
    }
    if (url.hostname === 'raw.githubusercontent.com') {
        const name = decodeURIComponent(url.pathname.split('/' + version + '/')[1]);
        if (files[version]?.has(name)) return new Response(files[version].get(name));
    }
    throw new Error('Unexpected offline update request: ' + input);
} });
const bucket = new FakeR2();
const syncData = { version: 9, checksum: 'unchanged-business-snapshot' };
bucket.seedJson('rp-sync/main/manifest.json', syncData);
const reports = [];
for (const version of ['1.9.4', '1.9.5']) {
    seedReleaseCache(bucket, version);
    const check = await callApi(worker, bucket, { action: 'app-update-check' });
    assert.equal(check.response.status, 200, check.payload.error);
    assert(check.payload.versions.some(v => v.tag === version));
    const result = await callApi(worker, bucket, { action: 'app-update-apply', target: version });
    assert.equal(result.response.status, 200, result.payload.error);
    const manifest = bucket.json('rp-app-update/manifest.json');
    assert.equal(manifest.current.upstreamTag, version);
    assert.equal(manifest.current.patchRevision, 'r2-character-split-e2b-v3');
    const app = await bucket.get(`rp-app-update/${manifest.current.slot}/assets/js/app.js`);
    const patched = patchRpHubAppJs(files[version].get('assets/js/app.js').toString(), { version });
    assert.equal(await app.text(), patched.code);
    assert.equal(RP_HUB_APP_PATCH_REVISION, 'r2-character-split-e2b-v3');
    reports.push({ version, patchReport: patched.report, files: manifest.current.files.length });
}
const rollback = await callApi(worker, bucket, { action: 'app-update-rollback' });
assert.equal(rollback.response.status, 200, rollback.payload.error);
assert.equal(bucket.json('rp-app-update/manifest.json').current.upstreamTag, '1.9.4');
const served = await worker.fetch(new Request('https://worker.test/assets/js/ui-components.js'), {
    RP_SYNC_R2: bucket, ASSETS: { fetch: async () => new Response('wrong fallback') }
}, new WaitUntilContext());
assert.equal(await served.text(), files['1.9.4'].get('assets/js/ui-components.js').toString());
assert.deepEqual(bucket.json('rp-sync/main/manifest.json'), syncData);
await fs.writeFile(path.join(root, 'evidence/sync-195/update-rollback.json'), JSON.stringify({ ok: true, reports, rollback: '1.9.4', revision: RP_HUB_APP_PATCH_REVISION }, null, 2));
console.log('1.9.4 → 1.9.5 → 1.9.4: check, apply, patches, overlay serving, rollback and sync isolation passed');
