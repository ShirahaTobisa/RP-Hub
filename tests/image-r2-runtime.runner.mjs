import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PACKAGE_SCRIPT = path.join(ROOT_DIR, 'scripts', 'package.mjs');
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const CARD_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const IMAGE_TOKEN = ['STD', 'runtime-test-token'].join('-');

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}

async function closeServer(server) {
    if (!server.listening) return;
    server.close();
    await once(server, 'close');
}

async function availablePort() {
    const server = createServer();
    const port = await listen(server);
    await closeServer(server);
    return port;
}

async function stopProcessTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true
        });
    } else {
        child.kill();
    }
    await Promise.race([
        once(child, 'exit'),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 3000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 2000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function waitForReady(origin, child, output) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
        if (child.exitCode !== null) {
            throw new Error(`Wrangler exited early (${child.exitCode}).\n${output.value}`);
        }
        try {
            const response = await fetchWithTimeout(`${origin}/`, {}, 500);
            if (response.ok) return;
        } catch {
            // Wrangler is still starting.
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error(`Wrangler did not become ready.\n${output.value}`);
}

function requestUrl(origin) {
    const url = new URL('/api/rp-image', origin);
    url.searchParams.set('character_id', CARD_ID);
    url.searchParams.set('character_name', 'Runtime R2 Card');
    url.searchParams.set('tag', 'runtime R2 unknown length test');
    url.searchParams.set('provider', 'std');
    url.searchParams.set('model', 'nai-diffusion-4-5-full');
    url.searchParams.set('size', 'vertical');
    return url;
}

async function main() {
    const runtimeRoot = await fs.mkdtemp(path.join(ROOT_DIR, '.rph-image-r2-runtime-'));
    const distRoot = path.join(runtimeRoot, 'dist');
    const releaseRoot = path.join(runtimeRoot, 'release');
    const stateRoot = path.join(runtimeRoot, 'state');
    const configRoot = path.join(runtimeRoot, 'xdg-config');
    const logRoot = path.join(runtimeRoot, 'wrangler-logs');
    const mockCalls = [];
    let wrangler = null;

    const mockServer = createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        mockCalls.push(url);
        if (url.pathname !== '/generate') {
            response.writeHead(404);
            response.end('not found');
            return;
        }
        response.writeHead(200, {
            'content-type': 'image/png',
            'transfer-encoding': 'chunked'
        });
        response.write(PNG_BYTES.subarray(0, 8));
        setTimeout(() => response.end(PNG_BYTES.subarray(8)), 10);
    });

    try {
        await Promise.all([
            fs.mkdir(configRoot, { recursive: true }),
            fs.mkdir(logRoot, { recursive: true })
        ]);
        const packageResult = spawnSync(process.execPath, [
            PACKAGE_SCRIPT,
            '--dist', distRoot,
            '--release-dir', releaseRoot
        ], {
            cwd: ROOT_DIR,
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024
        });
        assert.equal(packageResult.status, 0, packageResult.stderr || packageResult.stdout);

        const mockPort = await listen(mockServer);
        const mockOrigin = `http://127.0.0.1:${mockPort}`;
        const workerPath = path.join(distRoot, '_worker.js');
        const workerSource = await fs.readFile(workerPath, 'utf8');
        const patchedWorker = workerSource
            .replaceAll('https://std.loliyc.com', mockOrigin)
            .replaceAll('https://nai.sta1n.cn', mockOrigin);
        assert.notEqual(patchedWorker, workerSource, 'image provider URL replacement did not match');
        await fs.writeFile(workerPath, patchedWorker, 'utf8');

        const pagesPort = await availablePort();
        const origin = `http://127.0.0.1:${pagesPort}`;
        const wranglerBin = path.resolve(
            process.env.APPDATA || '',
            'npm',
            'node_modules',
            'wrangler',
            'bin',
            'wrangler.js'
        );
        const output = { value: '' };
        wrangler = spawn(process.execPath, [
            wranglerBin,
            'pages',
            'dev',
            '.',
            '--port', String(pagesPort),
            '--r2', 'RP_SYNC_R2',
            '--persist-to', stateRoot,
            '--log-level', 'error',
            '--show-interactive-dev-session=false'
        ], {
            cwd: distRoot,
            env: {
                ...process.env,
                NO_COLOR: '1',
                WRANGLER_SEND_METRICS: 'false',
                HOME: runtimeRoot,
                USERPROFILE: runtimeRoot,
                XDG_CONFIG_HOME: configRoot,
                WRANGLER_LOG_PATH: logRoot
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        wrangler.stdout.on('data', (chunk) => { output.value += chunk; });
        wrangler.stderr.on('data', (chunk) => { output.value += chunk; });
        await waitForReady(origin, wrangler, output);

        const url = requestUrl(origin);
        const generated = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'x-rp-image-token': IMAGE_TOKEN }
        }, 15000);
        const generatedBytes = new Uint8Array(await generated.arrayBuffer());
        assert.equal(generated.status, 200, new TextDecoder().decode(generatedBytes));
        assert.equal(generated.headers.get('x-rp-image-cache'), 'MISS');
        assert.deepEqual(generatedBytes, PNG_BYTES);
        assert.equal(mockCalls.length, 1);
        assert.equal(mockCalls[0].searchParams.get('token'), IMAGE_TOKEN);

        const cached = await fetchWithTimeout(url, {}, 5000);
        assert.equal(cached.status, 200, await cached.clone().text());
        assert.equal(cached.headers.get('x-rp-image-cache'), 'HIT');
        assert.deepEqual(new Uint8Array(await cached.arrayBuffer()), PNG_BYTES);
        assert.equal(mockCalls.length, 1, 'cache hit called the provider again');
    } finally {
        await stopProcessTree(wrangler);
        await closeServer(mockServer);
        await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
}

await main();
console.log('PASS image generation unknown-length body -> real local R2 -> cache hit');
