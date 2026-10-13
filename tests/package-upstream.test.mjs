import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchRpHubAppJs } from '../DB/app-patches.mjs';

// 发版打包用分发端最新收录的上游（scripts/package.mjs --upstream）：
// RPH 本体是上游原样文件、只给 app.js 打补丁（和站点「程序更新」相同）；外壳记的内置版本跟着换；上游出现不认识的新目录时停下。
// 需要先运行 scripts/prepare-test-fixtures.mjs 下载最新上游。
const root = fileURLToPath(new URL('../', import.meta.url));
const upstreamDir = path.join(root, 'evidence/sync-195/upstream/latest');
const marker = JSON.parse(fs.readFileSync(path.join(upstreamDir, '.fixture.json'), 'utf8'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rph-package-upstream-'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const listFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
});
const pack = (upstream, dist) => spawnSync(process.execPath, ['scripts/package.mjs', '--dist', dist, '--release-dir', path.join(work, 'release'), '--upstream', upstream],
    { cwd: root, encoding: 'utf8' });

try {
    const dist = path.join(work, 'dist');
    const result = pack(upstreamDir, dist);
    assert.equal(result.status, 0, result.stderr);

    const entries = ['index.html', 'LICENSE', 'assets', 'character', 'novel'];
    const upstreamFiles = entries.flatMap((entry) => {
        const full = path.join(upstreamDir, entry);
        return fs.statSync(full).isDirectory() ? listFiles(full) : [full];
    }).map((file) => path.relative(upstreamDir, file).split(path.sep).join('/'));
    for (const file of upstreamFiles) {
        const source = fs.readFileSync(path.join(upstreamDir, file));
        const expected = file === 'assets/js/app.js' ? Buffer.from(patchRpHubAppJs(source.toString('utf8'), { version: marker.tag }).code) : source;
        assert.equal(sha256(fs.readFileSync(path.join(dist, file))), sha256(expected), file);
    }
    for (const skipped of ['README.md', 'README.en.md', 'presence-server']) assert.equal(fs.existsSync(path.join(dist, skipped)), false, skipped);
    for (const ours of ['DB/bootstrap.js', 'DB/image-module.js', 'DB/module-loader.js', 'work.js', 'wrangler.toml']) assert.ok(fs.existsSync(path.join(dist, ours)), ours);
    console.log(`PASS the package carries upstream ${marker.tag} as published, with only app.js patched, plus our shell`);

    // 装上这个包、没用过「程序更新」的站点：面板显示内置版本，分发端最新也是它时不提示更新。
    const workerSource = fs.readFileSync(path.join(dist, '_worker.js'), 'utf8');
    assert.match(workerSource, new RegExp(`^const CURRENT_UPSTREAM_VERSION = '${marker.tag.replace(/\./g, '\\.')}';$`, 'm'));
    assert.match(workerSource, new RegExp(`^const CURRENT_UPSTREAM_SHA = '${marker.commit}';$`, 'm'));
    const files = listFiles(upstreamDir).filter((file) => !file.endsWith('.fixture.json'))
        .map((file) => ({ path: path.relative(upstreamDir, file).split(path.sep).join('/'), sha256: sha256(fs.readFileSync(file)), size: fs.statSync(file).size }));
    const mirrorManifest = { schema: 1, upstreamRepo: 'STA1N156/RP-Hub', versions: [{ tag: marker.tag, commit: marker.commit, name: marker.tag, files }] };
    globalThis.fetch = async (input) => {
        if (String(input) === 'https://mirror.test/manifest.json') return new Response(JSON.stringify(mirrorManifest), { headers: { 'content-type': 'application/json' } });
        return new Response('not found', { status: 404 });
    };
    const { default: worker } = await import(pathToFileURL(path.join(dist, '_worker.js')).href);
    const env = {
        RP_SYNC_PASSWORD: 'pw',
        APP_UPDATE_MIRROR_BASE: 'https://mirror.test',
        RP_SYNC_R2: { get: async () => null, put: async () => null, list: async () => ({ objects: [], truncated: false }), delete: async () => {} },
        ASSETS: { fetch: async (request) => {
            const file = path.join(dist, decodeURIComponent(new URL(request.url).pathname));
            return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('', { status: 404 });
        } }
    };
    const response = await worker.fetch(new Request('https://rph.example/api/rp-sync', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-rp-sync-password': 'pw' }, body: JSON.stringify({ action: 'app-update-check' })
    }), env, { waitUntil() {} });
    const status = await response.json();
    assert.equal(status.current.label, `内置 ${marker.tag}`, JSON.stringify(status.current));
    assert.equal(status.current.source, 'bundle');
    assert.equal(status.updateAvailable, false);
    console.log(`PASS a site on this package shows built-in ${marker.tag} and is not asked to update to the same version`);

    // 上游出现不认识的新目录：停下来，不悄悄漏掉也不多带。
    const extra = path.join(work, 'upstream-extra');
    fs.cpSync(upstreamDir, extra, { recursive: true });
    fs.mkdirSync(path.join(extra, 'square'));
    fs.writeFileSync(path.join(extra, 'square', 'index.html'), '<!doctype html>');
    const refused = pack(extra, path.join(work, 'dist-extra'));
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /新增了 square/);
    console.log('PASS packaging stops when upstream adds an entry nobody has reviewed');
} finally {
    fs.rmSync(work, { recursive: true, force: true });
}
