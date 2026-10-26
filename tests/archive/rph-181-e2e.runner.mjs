import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { patchRpHubAppJs } from '../DB/app-patches.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(testDirectory, '..');
const upstreamRepository = path.resolve(sourceRoot, '..', 'RP-Hub');
const UPSTREAM_181_COMMIT = '8911f4bba41cfe3b1a092862697b99faf7716d7d';
const chrome = process.env.CHROME_PATH
    || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const UPDATE_180_FILES = [
    'LICENSE',
    'README.md',
    'assets/css/styles.css',
    'assets/js/app.js',
    'assets/js/card-utils.js',
    'assets/js/ui-select.js',
    'assets/js/utils.js',
    'character/index.html',
    'index.html'
];
const UPDATE_181_FILES = [
    'LICENSE',
    'README.md',
    'assets/css/styles.css',
    'assets/js/app.js',
    'assets/js/built-in-content.js',
    'assets/js/core-utils.js',
    'assets/js/data-services.js',
    'assets/js/runtime-services.js',
    'assets/js/ui-components.js',
    'character/index.html',
    'index.html',
    'novel/index.html'
];
const IMAGE_RECORD_KEY = 'rp_hub_image_renders_card-a';
const BASELINE_SEED = {
    settings: { source: 'seed', nested: { version: 0 } },
    characterIndex: { order: ['card-a'] },
    character: { uuid: 'card-a', name: 'seed card' },
    chat: [{ role: 'assistant', content: 'seed chat' }],
    imageRecords: [{
        key: 'upgrade-image-card-a:content:0:prompt',
        messageId: 'upgrade-image-card-a',
        messageIndex: 0,
        contentHash: 'content',
        occurrenceIndex: 0,
        prompt: 'portrait, blue hair',
        promptHash: 'prompt',
        paramsSnapshot: {
            source: 'module',
            prompt: 'portrait, blue hair',
            tag: 'portrait, blue hair',
            provider: 'sta1n',
            seed: '180001',
            characterUuid: 'card-a',
            characterName: 'seed card'
        },
        imageSignature: 'upgrade-180-signature',
        status: 'rendered',
        createdAt: 1_800_000_000_000,
        updatedAt: 1_800_000_000_000,
        rerollCount: 1
    }]
};
const UPDATE_TAGS = ['1.8.0', '1.8.1'];

function readUpstreamTagFiles(tag) {
    const reference = tag === '1.8.1' ? UPSTREAM_181_COMMIT : tag;
    const names = execFileSync(
        'git',
        ['-C', upstreamRepository, 'ls-tree', '-r', '--name-only', reference],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    ).trim().split(/\r?\n/).filter(Boolean)
        .filter((name) => ![
            'DB', '_worker.js', 'work.js', 'wrangler.toml', 'update-upstream.bat', '.git', '.github'
        ].includes(name.split('/')[0]));
    return new Map(names.map((name) => [
        name,
        Buffer.from(execFileSync(
            'git',
            ['-C', upstreamRepository, 'show', `${reference}:${name}`],
            { maxBuffer: 8 * 1024 * 1024 }
        ))
    ]));
}

function directoryEntries(files, directory) {
    const prefix = directory ? `${directory}/` : '';
    const entries = new Map();
    for (const [name, bytes] of files) {
        if (!name.startsWith(prefix)) continue;
        const remainder = name.slice(prefix.length);
        if (!remainder) continue;
        const slash = remainder.indexOf('/');
        if (slash >= 0) {
            const child = remainder.slice(0, slash);
            entries.set(child, { type: 'dir', path: `${prefix}${child}` });
        } else {
            entries.set(remainder, { type: 'file', path: name, size: bytes.byteLength });
        }
    }
    return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function startUpdateMock() {
    const filesByTag = new Map(UPDATE_TAGS.map((tag) => [tag, readUpstreamTagFiles(tag)]));
    const requests = [];
    const server = createHttpServer((request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        requests.push({ method: request.method, pathname: url.pathname, query: url.search });
        if (url.pathname.endsWith('/releases.atom')) {
            const origin = `http://${request.headers.host}`;
            const entries = [...UPDATE_TAGS].reverse().map((tag, index) => [
                '<entry>',
                `<title>${tag}</title>`,
                `<updated>2026-08-${String(10 - index).padStart(2, '0')}T00:00:00Z</updated>`,
                `<link href="${origin}/releases/tag/${tag}"/>`,
                '</entry>'
            ].join('')).join('');
            response.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' });
            response.end(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries}</feed>`);
            return;
        }
        const contentsMarker = '/contents/';
        const contentsIndex = url.pathname.indexOf(contentsMarker);
        if (contentsIndex >= 0) {
            const directory = decodeURIComponent(url.pathname.slice(contentsIndex + contentsMarker.length).replace(/\/$/, ''));
            const selected = filesByTag.get(url.searchParams.get('ref')) || new Map();
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(directoryEntries(selected, directory)));
            return;
        }
        const rawMarker = '/raw/';
        const rawIndex = url.pathname.indexOf(rawMarker);
        if (rawIndex >= 0) {
            const rawPath = url.pathname.slice(rawIndex + rawMarker.length).split('/');
            const refIndex = rawPath.findIndex((part) => filesByTag.has(decodeURIComponent(part)));
            const tag = refIndex >= 0 ? decodeURIComponent(rawPath[refIndex]) : '';
            const fileName = refIndex >= 0
                ? rawPath.slice(refIndex + 1).map((part) => decodeURIComponent(part)).join('/')
                : '';
            const bytes = filesByTag.get(tag)?.get(fileName) || null;
            if (!bytes) {
                response.writeHead(404);
                response.end('missing fixture');
                return;
            }
            response.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-length': String(bytes.byteLength)
            });
            response.end(bytes);
            return;
        }
        response.writeHead(404);
        response.end('not found');
    });
    const port = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });
    return { server, origin: `http://127.0.0.1:${port}`, requests, filesByTag };
}

async function closeUpdateMock(updateMock) {
    if (!updateMock?.server?.listening) return;
    await new Promise((resolve) => updateMock.server.close(resolve));
}

function readUpstream(tag, file) {
    const reference = tag === '1.8.1' ? UPSTREAM_181_COMMIT : tag;
    return execFileSync(
        'git',
        ['-C', upstreamRepository, 'show', `${reference}:${file}`],
        { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    );
}

function extractStorageFixture(dataServicesSource) {
    const end = dataServicesSource.indexOf('// --- Memory utilities ---');
    assert(end >= 0, '1.8.1 data-services storage section is missing');
    return dataServicesSource.slice(0, end);
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = createNetServer();
        server.unref();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => resolve(address.port));
        });
    });
}

async function waitForServer(origin, child, output) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
        if (child.exitCode !== null) {
            throw new Error(`Wrangler exited early (${child.exitCode}).\n${output.join('')}`);
        }
        try {
            const response = await fetch(`${origin}/tests/rph-181-e2e?phase=probe`);
            if (response.ok) {
                const html = await response.text();
                if (!html.includes('/DB/bootstrap.js?v=r2-rebuild-1')) {
                    const rootResponse = await fetch(`${origin}/`);
                    const rootHtml = await rootResponse.text();
                    throw new Error(`Wrangler served the E2E page without worker injection (content-type=${response.headers.get('content-type')}, rootInjected=${rootHtml.includes('/DB/bootstrap.js?v=r2-rebuild-1')}).\n${html.slice(0, 500)}\n${output.join('')}`);
                }
                return;
            }
        } catch (error) {
            if (error?.message?.startsWith('Wrangler served the E2E page')) throw error;
            // Wrangler is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Wrangler did not become ready.\n${output.join('')}`);
}

async function postJson(origin, body) {
    const response = await fetch(`${origin}/api/rp-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    const payload = await response.json();
    return { response, payload };
}

async function applyUpstreamVersion(origin, tag) {
    const result = await postJson(origin, { action: 'app-update-apply', target: tag });
    assert.equal(result.response.status, 200, `${tag} apply failed: ${result.payload.error || JSON.stringify(result.payload)}`);
    return result.payload;
}

async function seedLocalUpdateOverlay(origin) {
    const response = await fetch(`${origin}/tests/rph-181-e2e-seed-update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
    });
    const payload = await response.json();
    assert.equal(response.status, 200, `local update fixture seed failed: ${JSON.stringify(payload)}`);
}

async function switchLocalUpdateOverlay(origin, tag) {
    const response = await fetch(`${origin}/tests/rph-181-e2e-switch-update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, `local update fixture switch to ${tag} failed: ${JSON.stringify(payload)}`);
}

function buildRemoteSnapshot() {
    const records = [
        ['rp_hub_settings', { source: 'remote', nested: { version: 1 } }],
        ['rp_hub_character_index', BASELINE_SEED.characterIndex],
        ['rp_hub_character_card-a', BASELINE_SEED.character],
        ['rp_hub_chat_card-a', BASELINE_SEED.chat],
        [IMAGE_RECORD_KEY, BASELINE_SEED.imageRecords]
    ];
    const recordCount = records.length + 1;
    const lines = [
        JSON.stringify({ type: 'snapshot', format: 'rp-sync-jsonl-v1', schemaVersion: 4 }),
        JSON.stringify({ type: 'localStorage', key: 'rp_hub_e2e_profile', value: 'remote-profile' }),
        JSON.stringify({ type: 'localStorageEnd' }),
        JSON.stringify({
            type: 'database',
            name: 'RPHubDB',
            stores: [{ name: 'store', keyPath: null, autoIncrement: false }]
        }),
        ...records.map(([key, value]) => JSON.stringify({
            type: 'record',
            database: 'RPHubDB',
            store: 'store',
            key,
            value
        })),
        JSON.stringify({ type: 'storeEnd', database: 'RPHubDB', store: 'store' }),
        JSON.stringify({ type: 'databaseEnd', name: 'RPHubDB' }),
        JSON.stringify({ type: 'snapshotEnd', recordCount })
    ];
    return { bytes: Buffer.from(`${lines.join('\n')}\n`, 'utf8'), recordCount };
}

async function uploadRemoteSnapshot(origin) {
    const { bytes, recordCount } = buildRemoteSnapshot();
    const chunkChecksum = sha256(bytes);
    const chunkManifest = [{
        index: 0,
        checksum: chunkChecksum,
        length: bytes.byteLength,
        byteOffset: 0,
        byteLength: bytes.byteLength,
        key: `rp-sync/main/chunks/${chunkChecksum}.bin`,
        encoding: 'raw-bytes'
    }];
    const snapshotChecksum = sha256(Buffer.from(JSON.stringify([
        'rp-sync-jsonl-v1',
        4,
        recordCount,
        bytes.byteLength,
        [[chunkChecksum, bytes.byteLength]]
    ]), 'utf8'));
    const body = {
        action: 'upload-create',
        snapshotFormat: 'rp-sync-jsonl-v1',
        schemaVersion: 4,
        chunkerProfile: 'rph-jsonl-cdc-fnv1a-v1',
        checksum: snapshotChecksum,
        recordCount,
        chunkSize: bytes.byteLength,
        chunkCount: 1,
        totalBytes: bytes.byteLength,
        chunkManifest,
        expectedVersion: 0
    };
    const current = await postJson(origin, { action: 'status' });
    body.expectedVersion = Number(current.payload.remote?.version || 0);
    const created = await postJson(origin, body);
    assert.equal(created.response.status, 200, `snapshot upload-create failed: ${JSON.stringify(created.payload)}`);
    body.expectedVersion = created.payload.previousVersion;
    const part = await fetch(`${origin}/api/rp-sync?action=upload-part&partNumber=1&index=0`, {
        method: 'POST',
        headers: {
            'x-rp-part-checksum': chunkChecksum,
            'x-rp-part-length': String(bytes.byteLength)
        },
        body: bytes
    });
    assert.equal(part.status, 200, `snapshot upload-part failed: ${await part.text()}`);
    const completed = await postJson(origin, { ...body, action: 'upload-complete' });
    assert.equal(completed.response.status, 200, `snapshot upload-complete failed: ${JSON.stringify(completed.payload)}`);
    return completed.payload;
}

async function readRemoteSnapshot(origin) {
    const manifest = await postJson(origin, { action: 'pull-manifest' });
    assert.equal(manifest.response.status, 200, `remote manifest failed: ${JSON.stringify(manifest.payload)}`);
    const remote = manifest.payload.remote;
    assert.equal(remote?.snapshotFormat, 'rp-sync-jsonl-v1');
    assert.equal(Number(remote?.schemaVersion), 4);
    const response = await fetch(`${origin}/api/rp-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            action: 'pull-json-part',
            version: remote.version,
            start: 0,
            count: Number(remote.chunkCount || 1)
        })
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `remote snapshot download failed: ${bytes.toString('utf8')}`);
    const lines = bytes.toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const records = {};
    let currentArray = null;
    for (const entry of lines) {
        const inTargetStore = entry.database === 'RPHubDB' && entry.store === 'store';
        if (entry.type === 'record' && inTargetStore) {
            records[entry.key] = entry.value;
        } else if (entry.type === 'recordArrayStart') {
            currentArray = {
                target: inTargetStore,
                key: entry.key,
                value: new Array(Math.max(0, Number(entry.length) || 0))
            };
        } else if (entry.type === 'recordArrayItem' && currentArray) {
            currentArray.value[Number(entry.index)] = entry.value;
        } else if (entry.type === 'recordArrayEnd' && currentArray) {
            if (currentArray.target) records[currentArray.key] = currentArray.value;
            currentArray = null;
        }
    }
    assert.equal(currentArray, null, 'remote snapshot ended inside an array record');
    return { remote, bytes, records };
}

async function runChromePhase(origin, profileDirectory, phase) {
    const child = spawn(chrome, [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-default-apps',
        '--no-first-run',
        `--user-data-dir=${profileDirectory}`,
        '--dump-dom',
        `${origin}/tests/rph-181-e2e?phase=${encodeURIComponent(phase)}&nonce=${Date.now()}`
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (...args) => resolve(args));
    });
    if (code !== 0) throw new Error(`Chrome phase ${phase} exited ${code}: ${stderr}`);
    if (!/<pre id="result" data-status="pass">PASS:/.test(stdout)) {
        throw new Error(`E2E phase ${phase} failed:\n${stdout}\n${stderr}`);
    }
    const result = stdout.match(/<pre id="result" data-status="pass">([^<]*)<\/pre>/)?.[1] || '';
    console.log(`PASS e2e ${phase}: ${result}`);
    return result;
}

async function prepareRuntime(runtimeRoot, updateOrigin = '') {
    await fs.mkdir(path.join(runtimeRoot, 'fixtures'), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, 'wrangler.toml'), path.join(runtimeRoot, 'wrangler.toml'));
    await fs.copyFile(path.join(sourceRoot, '_worker.js'), path.join(runtimeRoot, '_worker.js'));
    await fs.cp(path.join(sourceRoot, 'DB'), path.join(runtimeRoot, 'DB'), { recursive: true });
    await fs.cp(path.join(sourceRoot, 'assets'), path.join(runtimeRoot, 'assets'), { recursive: true });

    let worker = (await fs.readFile(path.join(runtimeRoot, '_worker.js'), 'utf8')).replaceAll('\r\n', '\n');
    if (updateOrigin) {
        worker = worker
            .replaceAll('https://github.com/', `${updateOrigin}/`)
            .replaceAll('https://api.github.com/', `${updateOrigin}/api/`)
            .replaceAll('https://raw.githubusercontent.com/', `${updateOrigin}/raw/`);
    }
    const originalInjectCheck = "return pathname === '/' || pathname === '/index.html';";
    assert(worker.includes(originalInjectCheck), 'test worker injection marker missing');
    worker = worker.replace(
        originalInjectCheck,
        "return pathname === '/' || pathname === '/index.html' || pathname === '/tests/rph-181-e2e.html' || pathname === '/tests/rph-181-e2e';"
    );
    const workerFetchMarker = '        const url = new URL(request.url);\n        if (url.pathname === IMAGE_API_PATH)';
    assert(worker.includes(workerFetchMarker), 'test worker fetch marker missing');
    const overlayConfigSource = JSON.stringify({
        '1.8.0': { slot: 'e2e-1.8.0', files: UPDATE_180_FILES },
        '1.8.1': { slot: 'e2e-1.8.1', files: UPDATE_181_FILES }
    });
    const localOverlayRoutes = [
        '        const url = new URL(request.url);',
        "        if (url.pathname === '/tests/rph-181-e2e.wait.svg') {",
        "            return new Promise((resolve) => setTimeout(() => resolve(new Response('<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"/>', { headers: { 'content-type': 'image/svg+xml' } })), 10000));",
        '        }',
        "        if (url.pathname === '/tests/rph-181-e2e-seed-update' && request.method === 'POST') {",
        '            const bucket = getBucket(env);',
        `            const configs = ${overlayConfigSource};`,
        '            for (const [tag, config] of Object.entries(configs)) {',
        '                for (const filePath of config.files) {',
        "                    const fileResponse = await env.ASSETS.fetch(new Request(new URL('/fixtures/updates/' + tag + '/' + filePath, request.url)));",
        "                    if (!fileResponse.ok) return error('Missing local update fixture: ' + tag + '/' + filePath, 500);",
        '                    await bucket.put(APP_UPDATE_PREFIX + \'/\' + config.slot + \'/\' + filePath, await fileResponse.arrayBuffer(), {',
        '                        httpMetadata: { contentType: getContentType(filePath) }',
        '                    });',
        '                }',
        '            }',
        '            const current = configs[\'1.8.0\'];',
        '            const currentFiles = current.files.map((filePath) => ({ path: filePath }));',
        '            await bucket.put(APP_UPDATE_MANIFEST_KEY, JSON.stringify({',
        "                upstreamRepo: 'STA1N156/RP-Hub',",
        "                upstreamBranch: 'main',",
        '                updatedAt: Date.now(),',
        '                current: { slot: current.slot, patchRevision: \'r2-character-split-e2b-v3\', upstreamTag: \'1.8.0\', upstreamSha: \'1.8.0\', files: currentFiles, appliedAt: Date.now() },',
        '                previous: null',
        '            }), { httpMetadata: { contentType: \'application/json; charset=utf-8\' } });',
        "            return json({ ok: true, seeded: ['1.8.0', '1.8.1'] });",
        '        }',
        "        if (url.pathname === '/tests/rph-181-e2e-switch-update' && request.method === 'POST') {",
        '            const body = await request.json().catch(() => ({}));',
        `            const configs = ${overlayConfigSource};`,
        '            const target = configs[String(body.tag || \"\")];',
        "            if (!target) return error('Unknown local update fixture.', 400);",
        '            const bucket = getBucket(env);',
        '            const manifest = await getAppliedAppUpdateManifest(bucket);',
        '            if (!manifest?.current) return error(\'Local update fixture is not seeded.\', 409);',
        '            const previous = manifest.current;',
        '            const files = target.files.map((filePath) => ({ path: filePath }));',
        '            manifest.current = { slot: target.slot, patchRevision: \'r2-character-split-e2b-v3\', upstreamTag: String(body.tag), upstreamSha: String(body.tag), files, appliedAt: Date.now() };',
        '            manifest.previous = previous;',
        '            await bucket.put(APP_UPDATE_MANIFEST_KEY, JSON.stringify(manifest), { httpMetadata: { contentType: \'application/json; charset=utf-8\' } });',
        '            return json({ ok: true, current: manifest.current.upstreamTag, previous: manifest.previous.upstreamTag });',
        '        }',
        '        if (url.pathname === IMAGE_API_PATH)'
    ].join('\n');
    worker = worker.replace(
        workerFetchMarker,
        localOverlayRoutes
    );
    await fs.writeFile(path.join(runtimeRoot, '_worker.js'), worker, 'utf8');

    let bootstrap = (await fs.readFile(path.join(sourceRoot, 'DB', 'bootstrap.js'), 'utf8')).replaceAll('\r\n', '\n');
    const originalScope = "const PAGE_SCOPE = ['/', '/index.html'];";
    assert(bootstrap.includes(originalScope), 'test bootstrap scope marker missing');
    bootstrap = bootstrap.replace(
        originalScope,
        "const PAGE_SCOPE = ['/', '/index.html', '/tests/rph-181-e2e.html', '/tests/rph-181-e2e'];"
    );
    const reloadSnippet = [
        'setTimeout(() => {',
        '                location.reload();',
        '            }, 700);'
    ].join('\n');
    assert(bootstrap.includes(reloadSnippet), 'test bootstrap reload marker missing');
    bootstrap = bootstrap.replace(reloadSnippet, 'globalThis.__RPH_E2E_RELOAD_SCHEDULED = true;');
    const pullErrorMarker = "            updateProgress(100, finalError.message || '服务器同步失败。');";
    assert(bootstrap.includes(pullErrorMarker), 'test bootstrap pull error marker missing');
    bootstrap = bootstrap.replace(
        pullErrorMarker,
        "            globalThis.__RPH_E2E_LAST_PULL_ERROR = finalError?.message || '';\n            updateProgress(100, finalError.message || '服务器同步失败。');"
    );
    const closingIndex = bootstrap.lastIndexOf('})();');
    assert(closingIndex >= 0, 'test bootstrap closing marker missing');
    bootstrap = `${bootstrap.slice(0, closingIndex)}
    globalThis.__RPH_E2E = Object.freeze({
        pullFromServer,
        pushToServer,
        releaseDeferredPersistenceWrites
    });
${bootstrap.slice(closingIndex)}`;
    await fs.writeFile(path.join(runtimeRoot, 'DB', 'bootstrap.js'), bootstrap, 'utf8');

    await fs.writeFile(
        path.join(runtimeRoot, 'fixtures', 'data-services-1.8.1.js'),
        extractStorageFixture(readUpstream('1.8.1', 'assets/js/data-services.js')),
        'utf8'
    );
    for (const [tag, files] of [['1.8.0', UPDATE_180_FILES], ['1.8.1', UPDATE_181_FILES]]) {
        for (const filePath of files) {
            const target = path.join(runtimeRoot, 'fixtures', 'updates', tag, filePath);
            await fs.mkdir(path.dirname(target), { recursive: true });
            const upstreamSource = readUpstream(tag, filePath);
            const fixtureSource = filePath === 'assets/js/app.js'
                ? patchRpHubAppJs(upstreamSource, { version: tag }).code
                : upstreamSource;
            await fs.writeFile(target, fixtureSource, 'utf8');
        }
    }

    const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>RPH 1.8.1 E2E</title>
<script>globalThis.RPH_R2_FLUSH_PERSISTENCE=async function rphE2eFlush(){return true;};</script>
</head>
<body>
<pre id="result" data-status="running">RUNNING</pre>
<script>window.__rphE2eBodyRan = true;</script>
<script>
window.Vue = {};
window.addEventListener('error', function (event) {
    var node = document.getElementById('result');
    if (node && node.dataset.status === 'running') {
        node.dataset.status = 'fail';
        node.textContent = 'FAIL: ' + (event.error && event.error.stack || event.message || 'error');
    }
});
window.addEventListener('unhandledrejection', function (event) {
    var node = document.getElementById('result');
    if (node && node.dataset.status === 'running') {
        node.dataset.status = 'fail';
        node.textContent = 'FAIL: ' + (event.reason && event.reason.stack || event.reason || 'rejection');
    }
});
</script>
<script>
var phase = new URLSearchParams(location.search).get('phase') || '';
if (phase === 'upgrade' || phase === 'defer' || phase === 'daily' || phase === 'daily-refresh') {
    document.write('<script src="/fixtures/data-services-1.8.1.js"><\\/script>');
}
</script>
<script src="/fixtures/rph-181-e2e-client.js" onload="window.__rphE2eScriptLoaded = true" onerror="window.__rphE2eScriptError = true"></script>
<script>
setTimeout(function () {
    var node = document.getElementById('result');
    if (node && node.dataset.status === 'running' && !window.__rphE2eClientLoaded) {
        node.dataset.status = 'fail';
        node.textContent = 'FAIL: E2E client did not execute; body=' + !!window.__rphE2eBodyRan + '; scriptLoaded=' + !!window.__rphE2eScriptLoaded + '; scriptError=' + !!window.__rphE2eScriptError;
    }
}, 1000);
</script>
<script>
setTimeout(function () {
    var node = document.getElementById('result');
    if (node && node.dataset.status === 'running') {
        node.dataset.status = 'fail';
        node.textContent = 'FAIL: E2E phase timed out';
    }
}, 30000);
</script>
<img src="/tests/rph-181-e2e.wait.svg" alt="" hidden>
</body></html>
`;
    await fs.mkdir(path.join(runtimeRoot, 'tests'), { recursive: true });

    const client = String.raw`(async () => {
globalThis.__rphE2eClientLoaded = true;
const resultNode = document.getElementById('result');
const phase = new URLSearchParams(location.search).get('phase') || '';
const baseline = ${JSON.stringify(BASELINE_SEED)};
const imageRecordKey = ${JSON.stringify(IMAGE_RECORD_KEY)};

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
    if (actual !== expected) throw new Error(message + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

function deepEqual(actual, expected, message) {
    const left = JSON.stringify(actual);
    const right = JSON.stringify(expected);
    if (left !== right) throw new Error(message + ': expected ' + right + ', got ' + left);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    });
}

async function openDb() {
    const request = indexedDB.open('RPHubDB', 1);
    request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('store')) request.result.createObjectStore('store');
    };
    return requestResult(request);
}

async function readRecord(key) {
    const db = await openDb();
    try {
        return await requestResult(db.transaction(['store'], 'readonly').objectStore('store').get(key));
    } finally {
        db.close();
    }
}

async function writeSeed() {
    const db = await openDb();
    try {
        const tx = db.transaction(['store'], 'readwrite');
        const done = transactionDone(tx);
        const store = tx.objectStore('store');
        store.put(baseline.settings, 'rp_hub_settings');
        store.put(baseline.characterIndex, 'rp_hub_character_index');
        store.put(baseline.character, 'rp_hub_character_card-a');
        store.put(baseline.chat, 'rp_hub_chat_card-a');
        store.put(baseline.imageRecords, imageRecordKey);
        await done;
    } finally {
        db.close();
    }
    localStorage.setItem('rp_hub_e2e_profile', 'seed-profile');
}

async function assertBaselineStorage(storage, label) {
    deepEqual(await storage.getStoredValue('settings'), baseline.settings, label + ' lost settings');
    deepEqual(await storage.getStoredValue('character_index'), baseline.characterIndex, label + ' lost character index');
    deepEqual(await storage.getStoredValue('character_card-a'), baseline.character, label + ' lost character');
    deepEqual(await storage.getScopedStoredValue('chat', 'card-a'), baseline.chat, label + ' lost chat');
    deepEqual(await storage.getStoredValue('image_renders_card-a'), baseline.imageRecords, label + ' lost image records');
}

function finish(message) {
    resultNode.dataset.status = 'pass';
    resultNode.textContent = 'PASS: ' + message;
}

try {
    if (phase === 'seed') {
        await writeSeed();
        finish('1.8.0 upgrade baseline seeded: character/chat/settings/image-records');
    } else if (phase === 'push-baseline') {
        equal(globalThis.RPH_R2_UPDATE_INFO?.tag, '1.8.0', 'baseline push did not run under 1.8.0');
        deepEqual(await readRecord('rp_hub_settings'), baseline.settings, 'push baseline lost settings before upload');
        deepEqual(await readRecord(imageRecordKey), baseline.imageRecords, 'push baseline lost image records before upload');
        assert(typeof globalThis.RPHubImageModule?.flushRecords === 'function', 'image module flush API unavailable before push');
        await globalThis.RPHubImageModule.flushRecords();
        await globalThis.__RPH_E2E.pushToServer();
        finish('1.8.0 baseline pushed: character/chat/settings/image-records');
    } else if (phase === 'upgrade') {
        const storage = globalThis.RPHubStorage;
        assert(storage && Object.isFrozen(storage), '1.8.1 RPHubStorage wrapper unavailable');
        await storage.initDB();
        equal(globalThis.RPH_R2_UPDATE_INFO?.tag, '1.8.1', 'upgrade refresh did not load 1.8.1');
        await assertBaselineStorage(storage, '1.8.1 upgrade refresh');
        assert(typeof globalThis.RPHubImageModule?.getState === 'function', 'image module unavailable after 1.8.1 upgrade');
        finish('1.8.1 refresh preserves character/chat/settings/image-records');
    } else if (phase === 'defer') {
        const storage = globalThis.RPHubStorage;
        assert(storage && Object.isFrozen(storage), '1.8.1 RPHubStorage wrapper unavailable');
        await storage.initDB();
        await assertBaselineStorage(storage, 'pre-restore 1.8.1');
        let localWriteDuringRestore = 0;
        const nativePut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value) {
            if (globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true && value && value.source === 'deferred-local') localWriteDuringRestore += 1;
            return nativePut.apply(this, arguments);
        };
        try {
            const pullPromise = globalThis.__RPH_E2E.pullFromServer();
            for (let attempt = 0; attempt < 200 && globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS !== true; attempt += 1) await sleep(10);
            assert(globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true, 'pull did not enter restore window: ' + (globalThis.__RPH_E2E_LAST_PULL_ERROR || 'no error'));
            const { setStoredValue } = storage;
            const deferredValue = { source: 'deferred-local', nested: { version: 1 } };
            let settled = false;
            const pending = setStoredValue('settings', deferredValue).then(() => { settled = true; });
            deferredValue.nested.version = 999;
            await pullPromise;
            equal(settled, false, 'restore-period write settled before release');
            equal(localWriteDuringRestore, 0, 'restore-period write reached IndexedDB directly');
            deepEqual(await storage.getStoredValue('settings'), { source: 'remote', nested: { version: 1 } }, 'remote restore did not land');
            delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
            await globalThis.__RPH_E2E.releaseDeferredPersistenceWrites();
            await pending;
            deepEqual(await storage.getStoredValue('settings'), { source: 'deferred-local', nested: { version: 1 } }, 'deferred write did not land after restore');
            deepEqual(await storage.getStoredValue('character_index'), baseline.characterIndex, 'restore lost character index');
            deepEqual(await storage.getStoredValue('character_card-a'), baseline.character, 'restore lost character');
            deepEqual(await storage.getScopedStoredValue('chat', 'card-a'), baseline.chat, 'restore lost chat');
            deepEqual(await storage.getStoredValue('image_renders_card-a'), baseline.imageRecords, 'restore lost image records');
            finish('1.8.1 restore write deferred/replayed; character/chat/image-records intact');
        } finally {
            IDBObjectStore.prototype.put = nativePut;
            delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
        }
    } else if (phase === 'daily') {
        const storage = globalThis.RPHubStorage;
        assert(storage, 'daily 1.8.1 storage export unavailable');
        await storage.initDB();
        const daily = { source: 'daily', saved: true };
        await storage.setStoredValue('settings', daily);
        await storage.setScopedStoredValue('chat', 'card-a', [{ role: 'user', content: 'daily chat' }]);
        deepEqual(await storage.getStoredValue('settings'), daily, 'daily settings write failed');
        deepEqual(await storage.getStoredValue('character_card-a'), baseline.character, 'daily flow lost character');
        deepEqual(await storage.getStoredValue('image_renders_card-a'), baseline.imageRecords, 'daily flow lost image records');
        finish('daily 1.8.1 writes preserve character and image records');
    } else if (phase === 'daily-refresh') {
        const storage = globalThis.RPHubStorage;
        assert(storage, 'daily refresh storage export unavailable');
        await storage.initDB();
        deepEqual(await storage.getStoredValue('settings'), { source: 'daily', saved: true }, 'refresh lost daily settings');
        deepEqual(await storage.getScopedStoredValue('chat', 'card-a'), [{ role: 'user', content: 'daily chat' }], 'refresh lost daily chat');
        deepEqual(await storage.getStoredValue('character_card-a'), baseline.character, 'refresh lost character');
        deepEqual(await storage.getStoredValue('image_renders_card-a'), baseline.imageRecords, 'refresh lost image records');
        finish('daily character/chat/settings/image-records survive refresh');
    } else if (phase === 'rollback') {
        assert(globalThis.RPHubStorage === undefined, '1.8.0 rollback unexpectedly received externalized storage export');
        deepEqual(await readRecord('rp_hub_settings'), { source: 'daily', saved: true }, 'rollback lost settings');
        deepEqual(await readRecord('rp_hub_chat_card-a'), [{ role: 'user', content: 'daily chat' }], 'rollback lost chat');
        deepEqual(await readRecord('rp_hub_character_card-a'), baseline.character, 'rollback lost character');
        deepEqual(await readRecord(imageRecordKey), baseline.imageRecords, 'rollback lost image records');
        assert(typeof globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE === 'function', 'rollback page bootstrap is unavailable');
        assert(typeof globalThis.RPHubImageModule?.getState === 'function', 'rollback image module is unavailable');
        finish('rollback to 1.8.0 keeps all data and image module available');
    } else if (phase === 'probe') {
        finish('probe');
    } else {
        throw new Error('unknown E2E phase: ' + phase);
    }
} catch (error) {
    resultNode.dataset.status = 'fail';
    resultNode.textContent = 'FAIL: ' + (error && error.stack || error && error.message || String(error));
}
})();
`;
    const inlinePage = page.replace(
        '<script src="/fixtures/rph-181-e2e-client.js" onload="window.__rphE2eScriptLoaded = true" onerror="window.__rphE2eScriptError = true"></script>',
        () => `<script>${client}</script>`
    );
    await fs.writeFile(path.join(runtimeRoot, 'tests', 'rph-181-e2e.html'), inlinePage, 'utf8');
    await fs.writeFile(path.join(runtimeRoot, 'fixtures', 'rph-181-e2e-client.js'), client, 'utf8');
}

async function main() {
    assert(existsSync(chrome), `Chrome executable not found: ${chrome}`);
    const reusedRuntimeRoot = process.env.RPH_E2E_REUSE_ROOT
        ? path.resolve(process.env.RPH_E2E_REUSE_ROOT)
        : null;
    const runtimeRoot = reusedRuntimeRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'rph-181-e2e-'));
    const persistRoot = path.join(runtimeRoot, 'persist');
    const profileRoot = path.join(runtimeRoot, 'chrome-profile');
    const port = await getFreePort();
    const origin = `http://127.0.0.1:${port}`;
    const liveUpdates = process.env.RPH_E2E_LIVE_UPDATES === '1';
    const directSlotFixture = process.env.RPH_E2E_DIRECT_SLOT === '1';
    const updateMock = liveUpdates || directSlotFixture ? null : await startUpdateMock();
    try {
        await prepareRuntime(runtimeRoot, updateMock?.origin || '');
    } catch (error) {
        await closeUpdateMock(updateMock).catch(() => { });
        if (!reusedRuntimeRoot) {
            await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
        throw error;
    }
    const output = [];
    const wranglerScript = process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
        : '';
    const command = wranglerScript && existsSync(wranglerScript) ? process.execPath : 'wrangler';
    const args = [
        'pages', 'dev', runtimeRoot,
        '--port', String(port),
        '--persist-to', persistRoot,
        '--compatibility-date', '2026-06-06',
        '--binding', 'APP_UPDATE_MIRROR_BASE=off',
        '--log-level', process.env.RPH_E2E_LOG_LEVEL || 'error',
        '--show-interactive-dev-session=false'
    ];
    if (command === process.execPath) args.unshift(wranglerScript);
    const child = spawn(command, args, {
        cwd: runtimeRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' }
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    try {
        await waitForServer(origin, child, output);
        if (directSlotFixture) await seedLocalUpdateOverlay(origin);
        else await applyUpstreamVersion(origin, '1.8.0');
        await runChromePhase(origin, profileRoot, 'seed');
        await runChromePhase(origin, profileRoot, 'push-baseline');
        const pushedSnapshot = await readRemoteSnapshot(origin);
        assert.deepEqual(pushedSnapshot.records.rp_hub_settings, BASELINE_SEED.settings);
        assert.deepEqual(pushedSnapshot.records.rp_hub_character_index, BASELINE_SEED.characterIndex);
        assert.deepEqual(pushedSnapshot.records['rp_hub_character_card-a'], BASELINE_SEED.character);
        assert.deepEqual(pushedSnapshot.records['rp_hub_chat_card-a'], BASELINE_SEED.chat);
        assert.deepEqual(pushedSnapshot.records[IMAGE_RECORD_KEY], BASELINE_SEED.imageRecords);
        console.log(`PASS remote 1.8.0 push: version=${pushedSnapshot.remote.version}, records=${Object.keys(pushedSnapshot.records).length}, bytes=${pushedSnapshot.bytes.length}, sha256=${sha256(pushedSnapshot.bytes)}`);

        if (directSlotFixture) await switchLocalUpdateOverlay(origin, '1.8.1');
        else await applyUpstreamVersion(origin, '1.8.1');
        await runChromePhase(origin, profileRoot, 'upgrade');

        await uploadRemoteSnapshot(origin);
        const restoreSnapshot = await readRemoteSnapshot(origin);
        assert.deepEqual(restoreSnapshot.records[IMAGE_RECORD_KEY], BASELINE_SEED.imageRecords);
        console.log(`remote restore snapshot: version=${restoreSnapshot.remote.version}, records=${Object.keys(restoreSnapshot.records).length}, bytes=${restoreSnapshot.bytes.length}, sha256=${sha256(restoreSnapshot.bytes)}`);
        await runChromePhase(origin, profileRoot, 'defer');
        await runChromePhase(origin, profileRoot, 'daily');
        await runChromePhase(origin, profileRoot, 'daily-refresh');
        if (directSlotFixture) await switchLocalUpdateOverlay(origin, '1.8.0');
        else {
            const rollback = await postJson(origin, { action: 'app-update-rollback' });
            assert.equal(rollback.response.status, 200, `1.8.1 rollback failed: ${JSON.stringify(rollback.payload)}`);
        }
        await runChromePhase(origin, profileRoot, 'rollback');
        const updateMode = liveUpdates
            ? 'live GitHub app-update apply'
            : directSlotFixture
                ? 'direct local update slot fixture'
                : `local Git commit ${UPSTREAM_181_COMMIT.slice(0, 7)} as 1.8.1 app-update apply mock, requests=${updateMock.requests.length}`;
        console.log(`E2E assertions passed (${updateMode}): 1.8.0 push, 1.8.1 upgrade/no-loss, defer/replay, daily/refresh, rollback/safety`);
    } finally {
        child.kill();
        await Promise.race([
            new Promise((resolve) => child.once('exit', resolve)),
            new Promise((resolve) => setTimeout(resolve, 5000))
        ]);
        if (child.exitCode === null) child.kill('SIGKILL');
        await closeUpdateMock(updateMock).catch(() => { });
        if (reusedRuntimeRoot || process.env.RPH_KEEP_E2E === '1') {
            console.error(`kept E2E runtime: ${runtimeRoot}`);
        } else {
            await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    }
}

await main();
