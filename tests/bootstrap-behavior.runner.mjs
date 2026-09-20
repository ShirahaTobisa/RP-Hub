import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { patchRpHubAppJs } from '../DB/app-patches.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');

const testDirectory = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(testDirectory, '..');
const bootstrapPath = resolve(siteRoot, 'DB', 'bootstrap.js');
const upstreamRepository = resolve(siteRoot, '..', 'RP-Hub');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const UPSTREAM_181_COMMIT = '8911f4bba41cfe3b1a092862697b99faf7716d7d';

function replaceExactlyOnce(source, pattern, replacement, label) {
    const matches = source.match(pattern);
    if (!matches || matches.length !== 1) {
        throw new Error(`Expected exactly one ${label} match, found ${matches?.length || 0}.`);
    }
    return source.replace(pattern, replacement);
}

function instrumentBootstrap(source) {
    let result = source;
    result = replaceExactlyOnce(result, /const PAGE_SCOPE = \['\/', '\/index\.html'\];/g,
        "const PAGE_SCOPE = ['/', '/index.html', '/tests/bootstrap-behavior.html'];",
        'test page scope');
    result = replaceExactlyOnce(result, /maxRecordBytes:\s*100 \* 1024 \* 1024/g,
        'maxRecordBytes: 256', 'maxRecordBytes threshold');
    result = replaceExactlyOnce(result, /warnRecordBytes:\s*32 \* 1024 \* 1024/g,
        'warnRecordBytes: 128', 'warnRecordBytes threshold');
    result = replaceExactlyOnce(result, /retryDelayMs:\s*600/g,
        'retryDelayMs: 1', 'retry delay');
    result = replaceExactlyOnce(result,
        /async function\* iterateSnapshotChunks\(stats, profile = 'cdc'\) \{/g,
        `async function* iterateSnapshotChunks(stats, profile = 'cdc') {
        globalThis.__bootstrapIterateSnapshotProfiles ||= [];
        globalThis.__bootstrapIterateSnapshotProfiles.push(profile);`,
        'iterateSnapshotChunks instrumentation');
    result = replaceExactlyOnce(result,
        /async function scanStreamSnapshot\(profile = 'cdc'\) \{/g,
        `async function scanStreamSnapshot(profile = 'cdc') {
        globalThis.__bootstrapScanProfiles ||= [];
        globalThis.__bootstrapScanProfiles.push(profile);
        if (profile === 'cdc' && globalThis.__RPH_FORCE_CDC_FAILURE === true) {
            throw new CdcChunkingError('forced test failure');
        }`,
        'scanStreamSnapshot instrumentation');
    result = replaceExactlyOnce(result,
        /function openDownloadStagingDb\(name = DOWNLOAD_STAGING_DB\) \{/g,
        `function openDownloadStagingDb(name = DOWNLOAD_STAGING_DB) {
        globalThis.__bootstrapStagingOpenCalls =
            (globalThis.__bootstrapStagingOpenCalls || 0) + 1;`,
        'staging open instrumentation');
    const closingIndex = result.lastIndexOf('})();');
    if (closingIndex < 0) throw new Error('bootstrap IIFE closing marker was not found.');
    const exportBlock = `
    globalThis.__RPHBootstrapTest = Object.freeze({
        CONFIG,
        state,
        expandLegacyCharacterRecord,
        syncObjectStoreRecords,
        replaceIndexedDbSnapshot,
        replaceLocalSnapshot,
        iterateSnapshotLines,
        iterateSnapshotChunks,
        SnapshotChunkWriter,
        SnapshotLineReader,
        buildStreamSnapshotChecksumSource,
        scanStreamSnapshot,
        buildStreamSnapshotManifest,
        validateStreamSnapshotManifest,
        openDownloadStagingDb,
        clearDownloadStagingStore,
        writeDownloadStagingChunks,
        readDownloadStagingChunk,
        downloadSnapshotRange,
        downloadSnapshotToStaging,
        iterateStagedSnapshotChunks,
        parseStagedStreamSnapshot,
        restoreStreamSnapshot,
        StreamSnapshotValidator,
        StreamSnapshotRestorer,
        downloadLegacyRemoteSnapshot,
        downloadLegacySnapshotJsonParts,
        sha256Bytes,
        fnv1a32,
        releaseDeferredPersistenceWrites,
        flushAppState,
        pullFromServer,
        pushToServer
    });
`;
    return `${result.slice(0, closingIndex)}${exportBlock}${result.slice(closingIndex)}`;
}

const instrumentedBootstrap = instrumentBootstrap(await readFile(bootstrapPath, 'utf8'));
const patchedUpstreamApp = patchRpHubAppJs(execFileSync(
    'git',
    [
        '-c', `safe.directory=${upstreamRepository.replaceAll('\\', '/')}`,
        '-C', upstreamRepository,
        'cat-file', 'blob', '1.7.5:assets/js/app.js'
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
), { version: '1.7.5-browser-race' }).code;
const upstreamDataServices = execFileSync(
    'git',
    [
        '-c', `safe.directory=${upstreamRepository.replaceAll('\\', '/')}`,
        '-C', upstreamRepository,
        'cat-file', 'blob', `${UPSTREAM_181_COMMIT}:assets/js/data-services.js`
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
);
const storageFixtureEnd = upstreamDataServices.indexOf('// --- Memory utilities ---');
if (storageFixtureEnd < 0) throw new Error('Unable to extract the 1.8.1 storage fixture.');
const externalizedStorageFixture = upstreamDataServices.slice(0, storageFixtureEnd);

function extractSection(source, startText, endText, label) {
    const start = source.indexOf(startText);
    const end = start < 0 ? -1 : source.indexOf(endText, start + startText.length);
    if (start < 0 || end < 0) throw new Error(`Unable to extract ${label} from patched app.js.`);
    return source.slice(start, end);
}

const appWriteGateFixture = `(() => {
        const cloneForStorage = (value) => structuredClone(value);
${extractSection(patchedUpstreamApp, '        const dbSetTo =', '        const dbSet = async', 'dbSetTo')}
${extractSection(patchedUpstreamApp, '        const dbDeleteFrom =', '        const dbDelete =', 'dbDeleteFrom')}
        globalThis.__RPH_TEST_DB_SET_TO = dbSetTo;
        globalThis.__RPH_TEST_DB_DELETE_FROM = dbDeleteFrom;
})();
`;
const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8'
};

const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        if (pathname === '/tests/bootstrap-behavior.wait') {
            setTimeout(() => response.writeHead(204).end(), 5000);
            return;
        }
        if (pathname === '/tests/bootstrap-behavior.instrumented.js') {
            response.writeHead(200, {
                'content-type': contentTypes['.js'],
                'cache-control': 'no-store'
            });
            response.end(instrumentedBootstrap);
            return;
        }
        if (pathname === '/tests/bootstrap-app-write-gates.js') {
            response.writeHead(200, {
                'content-type': contentTypes['.js'],
                'cache-control': 'no-store'
            });
            response.end(appWriteGateFixture);
            return;
        }
        if (pathname === '/tests/data-services-storage-1.8.1.js') {
            response.writeHead(200, {
                'content-type': contentTypes['.js'],
                'cache-control': 'no-store'
            });
            response.end(externalizedStorageFixture);
            return;
        }

        const relativePath = pathname === '/'
            ? 'tests/bootstrap-behavior.html'
            : pathname.replace(/^\/+/, '');
        const filePath = resolve(siteRoot, relativePath);
        if (filePath !== siteRoot && !filePath.startsWith(`${siteRoot}${sep}`)) {
            response.writeHead(403).end('Forbidden');
            return;
        }
        const body = await readFile(filePath);
        response.writeHead(200, {
            'content-type': contentTypes[extname(filePath)] || 'application/octet-stream',
            'cache-control': 'no-store'
        });
        response.end(body);
    } catch (_) {
        response.writeHead(404).end('Not found');
    }
});

async function runChrome(url) {
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => ['pass', 'fail'].includes(document.querySelector('#result')?.dataset.status), null, { timeout: 120000 });
        return await page.content();
    } finally { await browser.close(); }
}

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();

try {
    const html = await runChrome(
        `http://127.0.0.1:${address.port}/tests/bootstrap-behavior.html`
    );
    if (!/<pre id="result" data-status="pass">PASS:/.test(html)) {
        throw new Error(`Bootstrap browser behavior test failed:\n${html}`);
    }
    console.log('PASS bootstrap browser behavior');
} finally {
    await new Promise((resolveClose) => server.close(resolveClose));
}
