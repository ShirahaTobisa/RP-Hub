// Diagnostic runner (NOT part of run-all): reproduce "presets stay old after 1.8.7 update".
// Flow: mock GitHub serving real 1.8.6 + 1.8.7 tag trees -> dist worker in wrangler pages dev
// -> browser boots on 1.8.6 (fresh data, enforce writes 1.8.6 presets) -> online update to 1.8.7
// -> reload -> assert stored/served/global preset content reaches 1.8.7 ("补充原则" marker).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PACKAGE_SCRIPT = path.join(ROOT_DIR, 'scripts', 'package.mjs');
const UPSTREAM_ROOT = path.resolve(ROOT_DIR, '..', 'RP-Hub');
const TAGS = ['1.8.6', '1.8.7'];
const MARKER_187 = '补充原则';
const PASSWORD = 'rph';
const SEED_FILE_NAME = 'preset-187-seed.html';

function readUpstreamTagFiles(tag) {
    const tree = spawnSync('git', ['-C', UPSTREAM_ROOT, 'ls-tree', '-r', '--name-only', tag], { encoding: 'utf8' });
    assert.equal(tree.status, 0, tree.stderr || tree.stdout);
    const names = tree.stdout.trim().split(/\r?\n/).filter(Boolean)
        .filter((name) => !['DB', '_worker.js', 'work.js', 'wrangler.toml', 'update-upstream.bat', '.git', '.github']
            .includes(name.split('/')[0]));
    const files = new Map();
    for (const name of names) {
        const result = spawnSync('git', ['-C', UPSTREAM_ROOT, 'show', `${tag}:${name}`]);
        assert.equal(result.status, 0, result.stderr?.toString() || name);
        files.set(name, Buffer.from(result.stdout));
    }
    return files;
}

function makeReleaseFeed(origin) {
    const entries = [...TAGS].reverse().map((tag) => [
        '<entry>',
        `<title>${tag}</title>`,
        '<updated>2026-08-22T00:16:32Z</updated>',
        `<link href="${origin}/releases/tag/${tag}"/>`,
        '</entry>'
    ].join(''));
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        ...entries,
        '</feed>'
    ].join('');
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

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

async function closeServer(server) {
    if (!server?.listening) return;
    server.close();
    await once(server, 'close');
}

async function availablePort() {
    const server = createServer();
    const port = await listen(server);
    await closeServer(server);
    return port;
}

async function startUpdateMock() {
    const filesByTag = new Map(TAGS.map((tag) => [tag, readUpstreamTagFiles(tag)]));
    const server = createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        if (url.pathname.endsWith('/releases.atom')) {
            const origin = `http://${request.headers.host}`;
            response.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' });
            response.end(makeReleaseFeed(origin));
            return;
        }
        const contentsMarker = '/contents/';
        const contentsIndex = url.pathname.indexOf(contentsMarker);
        if (contentsIndex >= 0) {
            const directory = decodeURIComponent(url.pathname.slice(contentsIndex + contentsMarker.length).replace(/\/$/, ''));
            const ref = url.searchParams.get('ref') || '';
            const selected = filesByTag.get(ref) || new Map();
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(directoryEntries(selected, directory)));
            return;
        }
        const rawMarker = '/raw/';
        const rawIndex = url.pathname.indexOf(rawMarker);
        if (rawIndex >= 0) {
            const rawPath = url.pathname.slice(rawIndex + rawMarker.length).split('/').map((part) => decodeURIComponent(part));
            const refIndex = rawPath.findIndex((part) => filesByTag.has(part));
            const tag = refIndex >= 0 ? rawPath[refIndex] : '';
            const fileName = refIndex >= 0 ? rawPath.slice(refIndex + 1).join('/') : '';
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
    const port = await listen(server);
    return { server, origin: `http://127.0.0.1:${port}`, filesByTag };
}

function loadPlaywright() {
    try {
        return createRequire(import.meta.url)('playwright');
    } catch (error) {
        throw new Error('Playwright is unavailable. Expose the bundled runtime through NODE_PATH.', { cause: error });
    }
}

function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    ].filter(Boolean);
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) throw new Error(`Chrome executable not found: ${candidates.join(', ')}`);
    return found;
}

async function stopProcessTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
        child.kill('SIGTERM');
    }
    await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 4000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function waitForReady(origin, child, output) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited early (${child.exitCode}).\n${output.value.slice(-8000)}`);
        try {
            const response = await fetchWithTimeout(`${origin}/`, {}, 1000);
            if (response.ok) return;
        } catch {
            // Wrangler is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Wrangler did not become ready.\n${output.value.slice(-8000)}`);
}

function startWrangler(distRoot, stateRoot, configRoot, updateOrigin, port) {
    const wranglerBin = path.resolve(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    assert.ok(existsSync(wranglerBin), `wrangler missing: ${wranglerBin}`);
    const output = { value: '' };
    const child = spawn(process.execPath, [
        wranglerBin,
        'pages',
        'dev',
        '.',
        '--port', String(port),
        '--r2', 'RP_SYNC_R2',
        '--persist-to', stateRoot,
        '--binding', `RP_SYNC_PASSWORD=${PASSWORD}`,
        '--binding', 'APP_UPDATE_MIRROR_BASE=off',
        '--binding', `APP_UPDATE_DOWNLOAD_PROXIES=${updateOrigin}/`,
        '--log-level', 'error',
        '--show-interactive-dev-session=false'
    ], {
        cwd: distRoot,
        env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: configRoot },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    child.stdout.on('data', (chunk) => { output.value += chunk; });
    child.stderr.on('data', (chunk) => { output.value += chunk; });
    return { child, output };
}

async function rpc(origin, action, extra = {}, timeoutMs = 180000) {
    const response = await fetchWithTimeout(`${origin}/api/rp-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rp-sync-password': PASSWORD },
        body: JSON.stringify({ action, ...extra })
    }, timeoutMs);
    const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => '') }));
    assert.equal(response.status, 200, `${action}: ${JSON.stringify(payload)}`);
    assert.equal(payload.ok, true, `${action}: ${JSON.stringify(payload)}`);
    return payload;
}

async function poll(label, callback, timeoutMs = 120000, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const value = await callback();
            if (value) return value;
            lastError = null;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function readBrowserRecord(page, key) {
    return page.evaluate((recordKey) => new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const get = database.transaction('store', 'readonly').objectStore('store').get(recordKey);
            get.onsuccess = () => { database.close(); resolve(get.result); };
            get.onerror = () => { database.close(); reject(get.error); };
        };
    }), key);
}

async function snapshotPresetState(page) {
    const stored = await readBrowserRecord(page, 'rp_hub_presets').catch((error) => ({ readError: String(error) }));
    const runtime = await page.evaluate(() => {
        const core = globalThis.BUILTIN_CORE_PRESETS || globalThis.RPHubBuiltinContent?.corePresets || null;
        let builtinProbe = null;
        if (Array.isArray(core) && core[0]) {
            builtinProbe = { name: core[0].name, has187Marker: String(core[0].content || '').includes('补充原则') };
        }
        return {
            builtinProbe,
            builtinGlobals: Object.keys(globalThis).filter((key) => /BUILTIN|RPHubBuiltin/i.test(key))
        };
    });
    let storedProbe = null;
    if (Array.isArray(stored)) {
        const breakLimit = stored.find((preset) => preset?.name === '破限');
        storedProbe = {
            count: stored.length,
            names: stored.map((preset) => preset?.name),
            breakLimitFound: Boolean(breakLimit),
            breakLimitHas187Marker: String(breakLimit?.content || '').includes('补充原则'),
            breakLimitLength: String(breakLimit?.content || '').length
        };
    }
    return { storedProbe, storedRaw: Array.isArray(stored) ? undefined : stored, runtime };
}

async function main() {
    const { chromium } = loadPlaywright();
    const chromePath = findChrome();
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-preset-187-'));
    const distRoot = path.join(runtimeRoot, 'dist');
    const releaseRoot = path.join(runtimeRoot, 'release');
    const stateRoot = path.join(runtimeRoot, 'state');
    const configRoot = path.join(runtimeRoot, 'xdg-config');
    const consoleLog = [];
    const pageErrors = [];
    const report = { ok: false, startedAt: new Date().toISOString() };
    let wrangler = null;
    let browser = null;
    let updateMock = null;
    let failure = null;

    try {
        await fs.mkdir(configRoot, { recursive: true });
        updateMock = await startUpdateMock();
        for (const tag of TAGS) {
            const builtin = updateMock.filesByTag.get(tag)?.get('assets/js/built-in-content.js');
            assert.ok(builtin, `${tag} fixture missing built-in-content.js`);
            const has187 = builtin.toString('utf8').includes(MARKER_187);
            assert.equal(has187, tag === '1.8.7', `${tag} fixture marker mismatch`);
        }

        const packaged = spawnSync(process.execPath, [
            PACKAGE_SCRIPT,
            '--dist', distRoot,
            '--release-dir', releaseRoot
        ], { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);

        const workerPath = path.join(distRoot, '_worker.js');
        const workerSource = await fs.readFile(workerPath, 'utf8');
        const harnessWorker = workerSource
            .replace('const APP_UPDATE_DOWNLOAD_TIMEOUT_MS = 20000;', 'const APP_UPDATE_DOWNLOAD_TIMEOUT_MS = 4000;')
            .replaceAll('https://github.com/', `${updateMock.origin}/`)
            .replaceAll('https://api.github.com/', `${updateMock.origin}/api/`)
            .replaceAll('https://raw.githubusercontent.com/', `${updateMock.origin}/raw/`);
        assert.notEqual(harnessWorker, workerSource, 'worker URL rewrite did not match');
        await fs.writeFile(workerPath, harnessWorker, 'utf8');
        await fs.writeFile(
            path.join(distRoot, SEED_FILE_NAME),
            '<!doctype html><html><head><meta charset="utf-8"><title>seed</title></head><body>seed</body></html>',
            'utf8'
        );

        const pagesPort = await availablePort();
        const origin = `http://127.0.0.1:${pagesPort}`;
        const wranglerRun = startWrangler(distRoot, stateRoot, configRoot, updateMock.origin, pagesPort);
        wrangler = wranglerRun.child;
        await waitForReady(origin, wrangler, wranglerRun.output);
        report.origin = origin;

        const versions = await rpc(origin, 'app-update-versions', { force: true });
        for (const tag of TAGS) {
            assert.ok(versions.versions?.some((entry) => entry.tag === tag), `${tag} was not listed`);
        }
        const applied186 = await rpc(origin, 'app-update-apply', { target: '1.8.6' }, 300000);
        assert.equal(applied186.latest?.tag, '1.8.6');

        browser = await chromium.launch({ executablePath: chromePath, headless: true });
        const context = await browser.newContext();
        const page = await context.newPage();
        page.on('console', (message) => consoleLog.push({ type: message.type(), text: message.text().slice(0, 600) }));
        page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error).slice(0, 2000)));

        await page.goto(`${origin}/${SEED_FILE_NAME}`, { waitUntil: 'domcontentloaded' });
        await page.evaluate(async ({ password }) => {
            localStorage.clear();
            localStorage.setItem('roleplay_hub_update_id', '999999998');
            localStorage.setItem('rp_hub_sync_password_v1', password);
            await new Promise((resolveDelete, rejectDelete) => {
                const request = indexedDB.deleteDatabase('RPHubDB');
                request.onsuccess = () => resolveDelete();
                request.onerror = () => rejectDelete(request.error);
                request.onblocked = () => rejectDelete(new Error('RPHubDB delete was blocked'));
            });
        }, { password: PASSWORD });

        // Phase A: boot on 1.8.6, wait for enforce+saveData to persist 1.8.6 presets.
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        const phaseA = await poll('1.8.6 presets persisted', async () => {
            const snapshot = await snapshotPresetState(page);
            return snapshot.storedProbe?.breakLimitFound ? snapshot : null;
        });
        report.phaseA = phaseA;
        assert.equal(phaseA.storedProbe.breakLimitHas187Marker, false, 'baseline unexpectedly already has 1.8.7 content');

        // Phase B: online update to 1.8.7, reload, expect refreshed preset content.
        const applied187 = await rpc(origin, 'app-update-apply', { target: '1.8.7' }, 300000);
        assert.equal(applied187.latest?.tag, '1.8.7');
        const servedBuiltin = await (await fetchWithTimeout(`${origin}/assets/js/built-in-content.js`, {}, 15000)).text();
        report.servedBuiltinHas187Marker = servedBuiltin.includes(MARKER_187);

        await page.reload({ waitUntil: 'domcontentloaded' });
        let phaseB = null;
        let phaseBTimeout = null;
        try {
            phaseB = await poll('1.8.7 presets refreshed', async () => {
                const snapshot = await snapshotPresetState(page);
                return snapshot.storedProbe?.breakLimitHas187Marker ? snapshot : null;
            }, 90000);
        } catch (error) {
            phaseBTimeout = String(error);
            phaseB = await snapshotPresetState(page);
        }
        report.phaseB = phaseB;
        report.phaseBTimeout = phaseBTimeout;
        report.ok = !phaseBTimeout
            && phaseB?.storedProbe?.breakLimitHas187Marker === true
            && report.servedBuiltinHas187Marker === true;
    } catch (error) {
        failure = error;
    } finally {
        report.consoleTail = consoleLog.slice(-40);
        report.pageErrors = pageErrors;
        if (browser) await browser.close().catch(() => { });
        if (wrangler) await stopProcessTree(wrangler);
        if (updateMock) await closeServer(updateMock.server);
        console.log(JSON.stringify(report, null, 1));
    }
    if (failure) throw failure;
    assert.equal(report.ok, true, 'preset content did not reach 1.8.7 state');
}

await main();
console.log('preset-187-diagnosis passed');
