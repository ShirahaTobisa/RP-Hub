// Verifies the serve-time strip of upstream phone-home metas
// (rphub-presence-api / rphub-update-api) against real workerd via
// `wrangler pages dev`, since the HTMLRewriter selector semantics only
// exist there. The synthetic index.html stands in for an applied
// app-update slot page (upstream 1.8.4/1.8.5 styles carry these metas).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');

const SYNTHETIC_INDEX = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8">
    <meta name="rphub-presence-api" content="https://rphub-presence.zeabur.app">
    <meta name="rphub-update-api" content="https://rphub-presence.zeabur.app">
    <meta name="keep-me" content="untouched">
    <title>strip-remote-ping fixture</title>
</head>
<body><div id="app"></div></body>
</html>
`;

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitForServer(baseUrl, child, output) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`wrangler exited early:\n${output.join('')}`);
        }
        try {
            const response = await fetch(baseUrl, { signal: AbortSignal.timeout(2_000) });
            if (response.ok) return;
        } catch {
            // keep polling
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`wrangler did not become ready:\n${output.join('')}`);
}

async function main() {
    const harnessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-strip-ping-'));
    const siteDir = path.join(harnessDir, 'site');
    await fs.mkdir(siteDir, { recursive: true });
    await fs.mkdir(path.join(siteDir, 'DB'), { recursive: true });
    await fs.copyFile(path.join(ROOT_DIR, '_worker.js'), path.join(siteDir, '_worker.js'));
    await fs.copyFile(path.join(ROOT_DIR, 'DB', 'app-patches.mjs'), path.join(siteDir, 'DB', 'app-patches.mjs'));
    await fs.writeFile(path.join(siteDir, 'index.html'), SYNTHETIC_INDEX, 'utf8');
    await fs.writeFile(path.join(siteDir, 'other.html'), SYNTHETIC_INDEX, 'utf8');
    await fs.copyFile(path.join(ROOT_DIR, 'wrangler.toml'), path.join(harnessDir, 'wrangler.toml'));

    const port = await getFreePort();
    const output = [];
    const wranglerScript = process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
        : '';
    const command = wranglerScript && existsSync(wranglerScript) ? process.execPath : 'wrangler';
    const commandArgs = [
        'pages', 'dev', siteDir,
        '--port', String(port),
        '--persist-to', path.join(harnessDir, 'persist'),
        '--compatibility-date', '2026-06-06',
        '--log-level', 'error',
        '--show-interactive-dev-session=false'
    ];
    if (command === process.execPath) commandArgs.unshift(wranglerScript);
    const child = spawn(command, commandArgs, {
        cwd: harnessDir,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        await waitForServer(baseUrl, child, output);

        for (const pathname of ['/', '/index.html']) {
            const html = await (await fetch(baseUrl + pathname)).text();
            assert(!html.includes('rphub-presence-api'), `${pathname}: presence meta must be stripped`);
            assert(!html.includes('rphub-update-api'), `${pathname}: update meta must be stripped`);
            assert(html.includes('name="keep-me"'), `${pathname}: unrelated meta must survive`);
            assert(html.includes('/DB/bootstrap.js?v=r2-rebuild-1'), `${pathname}: overlay injection must still run`);
        }

        const other = await (await fetch(`${baseUrl}/other.html`)).text();
        assert(other.includes('rphub-presence-api'), 'non-inject path must be untouched');
        assert(other.includes('rphub-update-api'), 'non-inject path must be untouched');
        assert(!other.includes('/DB/bootstrap.js?v=r2-rebuild-1'), 'non-inject path must not gain injection');

        console.log('strip-remote-ping: PASS');
    } finally {
        child.kill('SIGTERM');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        await fs.rm(harnessDir, { recursive: true, force: true }).catch(() => {});
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
