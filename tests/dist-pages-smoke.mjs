import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = process.env.RPH_PACKAGE_ROOT || path.join(root, 'dist');
const versionedAssets = [
    ['DB/styles.css', '/DB/styles.css'],
    ['DB/nav-adapter.js', '/DB/nav-adapter.js'],
    ['DB/char-store.js', '/DB/char-store.js'],
    ['DB/bootstrap.js', '/DB/bootstrap.js'],
    ['DB/image-module.js', '/DB/image-module.js'],
    ['DB/module-loader.js', '/DB/module-loader.js']
];

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
}

async function waitForServer(baseUrl, child, output) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited early.\n${output.join('')}`);
        try {
            const response = await fetch(baseUrl);
            if (response.ok) return;
        } catch {
            // The local listener is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Wrangler did not start in time.\n${output.join('')}`);
}

assert.ok(existsSync(path.join(dist, '_worker.js')), 'dist/_worker.js is missing; run scripts/package.mjs first');
assert.ok(existsSync(path.join(dist, 'DB', 'nav-adapter.js')), 'dist/DB/nav-adapter.js is missing');
assert.ok(existsSync(path.join(dist, 'DB', 'char-store.js')), 'dist/DB/char-store.js is missing');
assert.ok(existsSync(path.join(dist, 'DB', 'module-loader.js')), 'dist/DB/module-loader.js is missing');
assert.ok(!existsSync(path.join(dist, 'examples')), 'examples must not be packaged');
assert.ok(!existsSync(path.join(dist, 'WORKSHOP-MOD-GUIDE.md')), 'author guide must not be packaged');

const harness = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-r2-v4-dist-smoke-'));
const persist = path.join(harness, 'persist');
await fs.copyFile(path.join(dist, 'wrangler.toml'), path.join(harness, 'wrangler.toml'));
const port = await getFreePort();
const output = [];
const wranglerScript = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
    : '';
const command = wranglerScript && existsSync(wranglerScript) ? process.execPath : 'wrangler';
const args = [
    'pages', 'dev', dist,
    '--port', String(port),
    '--persist-to', persist,
    '--compatibility-date', '2026-06-06',
    '--log-level', 'error',
    '--show-interactive-dev-session=false'
];
if (command === process.execPath) args.unshift(wranglerScript);
const child = spawn(command, args, {
    cwd: harness,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (chunk) => output.push(chunk.toString()));
child.stderr.on('data', (chunk) => output.push(chunk.toString()));

const baseUrl = `http://127.0.0.1:${port}`;
try {
    await waitForServer(baseUrl, child, output);
    const rootResponse = await fetch(`${baseUrl}/`);
    const html = await rootResponse.text();
    assert.equal(rootResponse.status, 200);
    assert.match(rootResponse.headers.get('content-type') || '', /text\/html/i);
    assert.match(html, /<html/i);
    const assetResults = [];
    const versionedUrls = {};
    for (const [relativePath, publicPath] of versionedAssets) {
        const bytes = await fs.readFile(path.join(dist, relativePath));
        const version = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
        const versionedUrl = `${publicPath}?v=${version}`;
        assert.ok(html.includes(versionedUrl), `root HTML is missing ${versionedUrl}`);
        versionedUrls[publicPath] = versionedUrl;
        const response = await fetch(`${baseUrl}${versionedUrl}`);
        const body = await response.arrayBuffer();
        assert.equal(response.status, 200, `${versionedUrl} did not return 200`);
        assert.ok(body.byteLength > 0, `${versionedUrl} returned an empty body`);
        assetResults.push({ path: publicPath, version, status: response.status, bytes: body.byteLength });
    }
    assert.ok(html.indexOf(versionedUrls['/DB/nav-adapter.js']) < html.indexOf(versionedUrls['/DB/char-store.js']));
    assert.ok(html.indexOf(versionedUrls['/DB/char-store.js']) < html.indexOf(versionedUrls['/DB/bootstrap.js']));
    assert.ok(html.indexOf(versionedUrls['/DB/bootstrap.js']) < html.indexOf(versionedUrls['/DB/image-module.js']));
    assert.ok(html.indexOf(versionedUrls['/DB/image-module.js']) < html.indexOf(versionedUrls['/DB/module-loader.js']));

    const charStoreResponse = await fetch(`${baseUrl}${versionedUrls['/DB/char-store.js']}`);
    const charStore = await charStoreResponse.text();
    assert.equal(charStoreResponse.status, 200);
    assert.match(charStoreResponse.headers.get('content-type') || '', /javascript/i);
    assert.match(charStore, /RPHubCharStore/);
    assert.doesNotMatch(charStore, /<html/i);

    console.log(JSON.stringify({
        ok: true,
        rootStatus: rootResponse.status,
        rootBytes: Buffer.byteLength(html),
        charStoreStatus: charStoreResponse.status,
        charStoreBytes: Buffer.byteLength(charStore),
        charStoreContentType: charStoreResponse.headers.get('content-type'),
        versionedAssets: assetResults
    }));
} finally {
    child.kill();
    await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await fs.rm(harness, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
