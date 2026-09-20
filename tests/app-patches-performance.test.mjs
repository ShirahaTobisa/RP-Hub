import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { patchRpHubAppJs } from '../DB/app-patches.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, '..', '..');
const upstreamRepository = resolve(projectDirectory, 'RP-Hub');
const wranglerConfigSource = resolve(testDirectory, 'app-patches-performance.wrangler.toml');
const workerSource = resolve(testDirectory, 'app-patches-performance.worker.mjs');
const patcherSource = resolve(testDirectory, '..', 'DB', 'app-patches.mjs');
const deliveryWranglerDirectory = resolve(testDirectory, '..', '.wrangler');

function readUpstreamApp() {
    const result = spawnSync(
        'git',
        ['-C', upstreamRepository, 'cat-file', 'blob', '1.7.5:assets/js/app.js'],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

function percentile(values, fraction) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function summarize(values) {
    return {
        median: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        max: percentile(values, 1)
    };
}

async function availablePort() {
    const server = createServer();
    server.unref();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    server.close();
    await once(server, 'close');
    return port;
}

async function waitForReady(origin, child, output) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited early (${child.exitCode}).\n${output.value}`);
        try {
            const response = await fetch(`${origin}/noop`);
            if (response.ok) return;
        } catch {
            // Wrangler is still starting.
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error(`Wrangler did not become ready.\n${output.value}`);
}

async function timedFetch(url) {
    const startedAt = performance.now();
    const response = await fetch(url);
    const body = await response.text();
    return { status: response.status, wallMs: performance.now() - startedAt, body };
}

async function main() {
    const source = readUpstreamApp();

    for (let index = 0; index < 20; index += 1) patchRpHubAppJs(source, { version: '1.7.5' });
    const nodeSamples = [];
    for (let index = 0; index < 100; index += 1) {
        const startedAt = performance.now();
        patchRpHubAppJs(source, { version: '1.7.5' });
        nodeSamples.push(performance.now() - startedAt);
    }

    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const wranglerBin = resolve(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const wranglerRoot = resolve(wranglerBin, '..', '..');
    const workerdBin = resolve(wranglerRoot, 'node_modules', 'workerd', 'bin', 'workerd');
    const wranglerVersion = spawnSync(process.execPath, [wranglerBin, '--version'], { encoding: 'utf8' }).stdout.trim();
    const workerdVersion = spawnSync(process.execPath, [workerdBin, '--version'], { encoding: 'utf8' }).stdout.trim();
    const runtimePath = await mkdtemp(join(tmpdir(), 'rph-app-patches-workerd-'));
    const runtimeTests = join(runtimePath, 'tests');
    const runtimeDb = join(runtimePath, 'DB');
    const runtimeConfig = join(runtimeTests, 'app-patches-performance.wrangler.toml');
    await Promise.all([mkdir(runtimeTests), mkdir(runtimeDb)]);
    await Promise.all([
        copyFile(wranglerConfigSource, runtimeConfig),
        copyFile(workerSource, join(runtimeTests, 'app-patches-performance.worker.mjs')),
        copyFile(patcherSource, join(runtimeDb, 'app-patches.mjs'))
    ]);
    const output = { value: '' };
    const child = spawn(process.execPath, [
        wranglerBin,
        '--cwd', runtimePath,
        'dev',
        '--config', runtimeConfig,
        '--local',
        '--port', String(port),
        '--persist-to', join(runtimePath, 'state')
    ], {
        cwd: runtimePath,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => { output.value += chunk; });
    child.stderr.on('data', (chunk) => { output.value += chunk; });

    try {
        await waitForReady(origin, child, output);
        const loaded = await fetch(`${origin}/load`, { method: 'POST', body: source });
        assert.equal(loaded.status, 200, await loaded.text());

        for (let index = 0; index < 10; index += 1) {
            const warmup = await fetch(`${origin}/patch`);
            assert.equal(warmup.status, 200, await warmup.text());
        }

        const noopSamples = [];
        const patchSamples = [];
        for (let index = 0; index < 80; index += 1) {
            noopSamples.push((await timedFetch(`${origin}/noop`)).wallMs);
            const result = await timedFetch(`${origin}/patch`);
            assert.equal(result.status, 200, result.body);
            const parsed = JSON.parse(result.body);
            assert.deepEqual(parsed.replacements, { characterSave: 6, characterLoad: 1, persistenceBridge: 1 });
            patchSamples.push(result.wallMs);
        }

        const workerBatchPerPatchSamples = [];
        const clientBatchPerPatchSamples = [];
        for (let index = 0; index < 12; index += 1) {
            const batch = await timedFetch(`${origin}/patch?iterations=20`);
            assert.equal(batch.status, 200, batch.body);
            const batchBody = JSON.parse(batch.body);
            workerBatchPerPatchSamples.push(batchBody.elapsedMs / batchBody.iterations);
            clientBatchPerPatchSamples.push(batch.wallMs / batchBody.iterations);
        }
        assert.ok(
            percentile(workerBatchPerPatchSamples, 0.95) < 8,
            `workerd patch p95 exceeded the 8 ms safety target: ${JSON.stringify(workerBatchPerPatchSamples)}`
        );

        const burn = await timedFetch(`${origin}/burn?ms=100`);
        const localCpuLimitEnforced = burn.status >= 500;
        const result = {
            sourceBytes: Buffer.byteLength(source),
            nodeWallMs: summarize(nodeSamples),
            workerdNoopWallMs: summarize(noopSamples),
            workerdPatchWallMs: summarize(patchSamples),
            workerdPatchMinusNoopMedianMs: percentile(patchSamples, 0.5) - percentile(noopSamples, 0.5),
            workerdBatchPerPatchMs: {
                iterationsPerRequest: 20,
                samples: workerBatchPerPatchSamples.length,
                workerElapsed: summarize(workerBatchPerPatchSamples),
                clientWall: summarize(clientBatchPerPatchSamples)
            },
            configuredCpuLimitMs: 10,
            localCpuLimitEnforced,
            cpuLimitProbe: { status: burn.status, wallMs: burn.wallMs },
            wranglerVersion,
            workerdVersion
        };
        console.log(JSON.stringify(result, null, 2));
    } finally {
        child.kill();
        await Promise.race([once(child, 'exit'), new Promise((resolvePromise) => setTimeout(resolvePromise, 3000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
        await rm(runtimePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        assert.equal(existsSync(deliveryWranglerDirectory), false, 'performance runner polluted the delivery root with .wrangler');
    }
}

await main();
