import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const CHUNK_SIZE = 8 * 1024 * 1024;
const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, '..');
const bootstrapPath = resolve(projectRoot, 'DB', 'bootstrap.js');
const converterPath = resolve(projectRoot, 'scripts', 'convert-offline-backup.mjs');
const inspectorPath = resolve(testDirectory, 'real-offline-backup.inspect.mjs');
const sourceBackup = process.env.RP_SYNC_REAL_BACKUP || 'D:\\tools\\codex\\.tmp\\rp-snapshot.json';
const chrome = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const sourceBackupInfo = existsSync(sourceBackup) ? await stat(sourceBackup).catch(() => null) : null;

if (!sourceBackupInfo || sourceBackupInfo.size === 0) {
    console.log('SKIP real offline backup unavailable');
    process.exit(0);
}

function replaceExactlyOnce(source, pattern, replacement) {
    const matches = source.match(pattern);
    if (!matches || matches.length !== 1) throw new Error('Bootstrap instrumentation failed.');
    return source.replace(pattern, replacement);
}

function instrumentBootstrap(source) {
    let result = replaceExactlyOnce(
        source,
        /const PAGE_SCOPE = \['\/', '\/index\.html'\];/g,
        "const PAGE_SCOPE = ['/', '/index.html', '/tests/real-offline-backup.html'];"
    );
    result = replaceExactlyOnce(
        result,
        /async function\* iterateSnapshotChunks\(stats, profile = 'cdc'\) \{/g,
        `async function* iterateSnapshotChunks(stats, profile = 'cdc') {
        globalThis.__realBackupIterateProfiles ||= [];
        globalThis.__realBackupIterateProfiles.push(profile);`
    );
    result = replaceExactlyOnce(
        result,
        /function openDownloadStagingDb\(\) \{/g,
        `function openDownloadStagingDb() {
        globalThis.__realBackupStagingOpenCalls =
            (globalThis.__realBackupStagingOpenCalls || 0) + 1;`
    );
    const closingIndex = result.lastIndexOf('})();');
    if (closingIndex < 0) throw new Error('Bootstrap instrumentation failed.');
    const exports = `
    globalThis.__RPHRealBackupTest = Object.freeze({
        CONFIG,
        state,
        pullFromServer,
        pushToServer,
        scanStreamSnapshot,
        buildStreamSnapshotChecksumSource
    });
`;
    result = `${result.slice(0, closingIndex)}${exports}${result.slice(closingIndex)}`;
    return result;
}

function runProcess(command, args, options = {}) {
    return new Promise((resolveRun, rejectRun) => {
        const { timeoutMs = 15 * 60 * 1000, ...spawnOptions } = options;
        const child = spawn(command, args, {
            cwd: projectRoot,
            windowsHide: true,
            ...spawnOptions
        });
        let stdout = '';
        let stderr = '';
        const outputLimit = 2 * 1024 * 1024;
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
            if (stdout.length < outputLimit) stdout += chunk.slice(0, outputLimit - stdout.length);
        });
        child.stderr?.on('data', (chunk) => {
            if (stderr.length < outputLimit) stderr += chunk.slice(0, outputLimit - stderr.length);
        });
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            rejectRun(new Error('Child process timed out.'));
        }, timeoutMs);
        child.on('error', (error) => {
            clearTimeout(timeout);
            rejectRun(error);
        });
        child.on('close', (code) => {
            clearTimeout(timeout);
            if (code !== 0) {
                rejectRun(new Error(
                    `Child process failed (${code}).\nSTDOUT:\n${stdout || '(empty)'}\nSTDERR:\n${stderr || '(empty)'}`
                ));
                return;
            }
            resolveRun({ stdout, stderr });
        });
    });
}

function readSmallJsonBody(request) {
    return new Promise((resolveBody, rejectBody) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            body += chunk;
            if (body.length > 64 * 1024) {
                request.destroy();
                rejectBody(new Error('Request body too large.'));
            }
        });
        request.on('end', () => {
            try {
                resolveBody(JSON.parse(body || '{}'));
            } catch {
                rejectBody(new Error('Invalid request body.'));
            }
        });
        request.on('error', rejectBody);
    });
}

function jsonResponse(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store'
    });
    response.end(body);
}

async function removeTemporaryDirectory(directory) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            return;
        } catch {
            await new Promise((resolveWait) => setTimeout(resolveWait, 300));
        }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'rph-real-backup-'));
const snapshotPath = resolve(temporaryDirectory, 'schema3.json');
const profileDirectory = resolve(temporaryDirectory, 'chrome-profile');
let server = null;
let releaseServerWaits = () => {};

try {
    await mkdir(profileDirectory);
    const converted = await runProcess(process.execPath, [
        converterPath,
        '--input', sourceBackup,
        '--output', snapshotPath
    ], { timeoutMs: 15 * 60 * 1000 });
    let conversionReport;
    try {
        conversionReport = JSON.parse(converted.stdout);
    } catch {
        throw new Error('Backup conversion report was invalid.');
    }
    if (!/^[a-f0-9]{64}$/.test(conversionReport.outputSha256 || '')) {
        throw new Error('Backup conversion checksum was invalid.');
    }

    const inspected = await runProcess(process.execPath, [
        '--max-old-space-size=4096',
        inspectorPath,
        '--source', sourceBackup,
        '--snapshot', snapshotPath
    ], { timeoutMs: 15 * 60 * 1000 });
    let expected;
    try {
        expected = JSON.parse(inspected.stdout);
    } catch {
        throw new Error('Backup inspection report was invalid.');
    }

    const snapshotInfo = await stat(snapshotPath);
    if (snapshotInfo.size !== Number(conversionReport.outputBytes)) {
        throw new Error('Converted snapshot size did not match its report.');
    }
    const chunkCount = Math.ceil(snapshotInfo.size / CHUNK_SIZE);
    const instrumentedBootstrap = instrumentBootstrap(await readFile(bootstrapPath, 'utf8'));
    const html = await readFile(resolve(testDirectory, 'real-offline-backup.html'));
    const browserTest = await readFile(resolve(testDirectory, 'real-offline-backup.test.mjs'));
    const expectedBody = Buffer.from(JSON.stringify(expected));
    const waitingResponses = new Set();
    let testCompleted = false;

    function releaseWaitingResponses() {
        testCompleted = true;
        for (const response of waitingResponses) response.writeHead(204).end();
        waitingResponses.clear();
    }
    releaseServerWaits = releaseWaitingResponses;

    server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            if (request.method === 'GET' && url.pathname === '/tests/real-offline-backup.html') {
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                response.end(html);
                return;
            }
            if (request.method === 'GET' && url.pathname === '/tests/real-offline-backup.bootstrap.js') {
                response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
                response.end(instrumentedBootstrap);
                return;
            }
            if (request.method === 'GET' && url.pathname === '/tests/real-offline-backup.test.mjs') {
                response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
                response.end(browserTest);
                return;
            }
            if (request.method === 'GET' && url.pathname === '/tests/real-offline-backup.expected.json') {
                response.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'content-length': expectedBody.byteLength,
                    'cache-control': 'no-store'
                });
                response.end(expectedBody);
                return;
            }
            if (request.method === 'GET' && url.pathname === '/tests/real-offline-backup.snapshot.json') {
                const snapshotInfo = await stat(snapshotPath);
                response.writeHead(200, {
                    'content-type': 'application/json; charset=utf-8',
                    'content-length': snapshotInfo.size,
                    'cache-control': 'no-store'
                });
                createReadStream(snapshotPath).pipe(response);
                return;
            }
            if (request.method === 'GET' && url.pathname === '/tests/real-offline-backup.wait') {
                if (testCompleted) {
                    response.writeHead(204).end();
                } else {
                    waitingResponses.add(response);
                    request.on('close', () => waitingResponses.delete(response));
                }
                return;
            }
            if (request.method === 'POST' && url.pathname === '/tests/real-offline-backup.complete') {
                response.writeHead(204).end();
                setTimeout(releaseWaitingResponses, 50);
                return;
            }
            if (request.method === 'POST' && url.pathname === '/api/rp-sync') {
                const payload = await readSmallJsonBody(request);
                if (payload.action === 'pull-manifest') {
                    jsonResponse(response, 200, {
                        ok: true,
                        remote: {
                            version: 1,
                            chunkCount,
                            totalBytes: snapshotInfo.size,
                            checksum: conversionReport.outputSha256
                        }
                    });
                    return;
                }
                if (payload.action === 'pull-json-part') {
                    const start = Number(payload.start);
                    const count = Number(payload.count);
                    const version = Number(payload.version);
                    if (version !== 1 || !Number.isInteger(start) || start < 0
                        || !Number.isInteger(count) || count <= 0
                        || start >= chunkCount || start + count > chunkCount) {
                        jsonResponse(response, 400, { ok: false, error: 'Invalid range.' });
                        return;
                    }
                    const byteStart = start * CHUNK_SIZE;
                    const byteEndExclusive = Math.min((start + count) * CHUNK_SIZE, snapshotInfo.size);
                    const byteLength = byteEndExclusive - byteStart;
                    response.writeHead(200, {
                        'content-type': 'application/octet-stream',
                        'content-length': byteLength,
                        'x-rp-sync-byte-length': String(byteLength),
                        'cache-control': 'no-store'
                    });
                    createReadStream(snapshotPath, { start: byteStart, end: byteEndExclusive - 1 })
                        .on('error', () => response.destroy())
                        .pipe(response);
                    return;
                }
                jsonResponse(response, 400, { ok: false, error: 'Unsupported action.' });
                return;
            }
            response.writeHead(404).end('Not found');
        } catch {
            if (!response.headersSent) jsonResponse(response, 500, { ok: false, error: 'Test server error.' });
            else response.destroy();
        }
    });

    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    const browserRun = await runProcess(chrome, [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--js-flags=--max-old-space-size=4096',
        `--user-data-dir=${profileDirectory}`,
        '--virtual-time-budget=900000',
        '--dump-dom',
        `http://127.0.0.1:${address.port}/tests/real-offline-backup.html`
    ], { timeoutMs: 15 * 60 * 1000 });
    const match = browserRun.stdout.match(/<pre id="result" data-status="pass">([^<]+)<\/pre>/);
    if (!match) {
        throw new Error(
            `Real backup browser verification failed.\nDOM:\n${browserRun.stdout || '(empty)'}\nSTDERR:\n${browserRun.stderr || '(empty)'}`
        );
    }
    console.log(match[1]);
} finally {
    if (server) {
        releaseServerWaits();
        await new Promise((resolveClose) => server.close(resolveClose));
    }
    await removeTemporaryDirectory(temporaryDirectory);
}
