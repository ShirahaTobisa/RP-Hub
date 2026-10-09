import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { patchRpHubAppJs } from '../DB/app-patches.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const { chromium } = createRequire(import.meta.url)('playwright');
export const chrome = process.env.CHROME_PATH || chromium.executablePath();
// 页面测试默认用固定的上游 1.9.5；RPH_UPSTREAM_DIR 可指向其他版本的上游源码目录（如 2.0.0）。
export const defaultUpstream = path.resolve(process.env.RPH_UPSTREAM_DIR || path.join(root, 'evidence/sync-195/upstream/1.9.5/RP-Hub-cd7fb2b946f5985991b60597960852671013f36f'));
export const baseline = process.env.RPH_BASELINE_DIR || path.join(root, 'evidence/sync-195/baseline');
const exposed = ['CONFIG', 'state', 'iterateSnapshotLines', 'iterateSnapshotChunks', 'SnapshotChunkWriter',
    'serializeSnapshotLine', 'serializeStreamRecord', 'checkStreamRecordSize', 'scanStreamSnapshot',
    'buildStreamSnapshotChecksumSource', 'sha256', 'sha256Bytes', 'readObjectStoreRecordBatch',
    'openDownloadStagingDb', 'clearDownloadStagingStore', 'writeDownloadStagingChunks', 'readDownloadStagingChunk',
    'downloadSnapshotToStaging', 'downloadSnapshotRange', 'iterateStagedSnapshotChunks', 'parseStagedStreamSnapshot',
    'restoreStreamSnapshot', 'StreamSnapshotValidator', 'StreamSnapshotRestorer', 'validateStreamSnapshotManifest',
    'buildDownloadRanges', 'chunkCacheKey', 'retainedChunkKeys', 'pruneDownloadCache', 'runSyncLocked',
    'pullFromServer', 'pushToServer', 'uploadMissingStreamChunks', 'updateButtonState'];

export function instrument(source, metrics = false) {
    const exports = exposed.filter((name) => new RegExp(`\\b(?:function\\*?|class|const)\\s+${name}\\b`).test(source));
    let timing = '';
    if (metrics) {
        timing = 'globalThis.__perf = {};\n';
        const sync = ['serializeSnapshotLine', source.includes('function serializeStreamRecord(') ? 'serializeStreamRecord' : 'checkStreamRecordSize'];
        for (const name of sync) timing += `{ const original = ${name}; ${name} = function (...args) { const start = performance.now(); try { return original.apply(this, args); } finally { __perf.processing = (__perf.processing || 0) + performance.now() - start; } }; }\n`;
        timing += '{ const original = SnapshotChunkWriter.prototype.appendLine; SnapshotChunkWriter.prototype.appendLine = function (...args) { const start = performance.now(); try { return original.apply(this, args); } finally { __perf.processing = (__perf.processing || 0) + performance.now() - start; } }; }\n';
        for (const [name, label] of [['readObjectStoreRecordBatch', 'read'], ['sha256Bytes', 'hash'], ['downloadSnapshotToStaging', 'download'], ['flushAppState', 'save']]) {
            timing += `{ const original = ${name}; ${name} = async function (...args) { const start = performance.now(); ${label === 'download' ? 'globalThis.__stage = "download";' : ''} try { return await original.apply(this, args); } finally { __perf.${label} = (__perf.${label} || 0) + performance.now() - start; } }; }\n`;
        }
        timing += '{ const original = parseStagedStreamSnapshot; parseStagedStreamSnapshot = async function (...args) { const stage = args[3]?.verifyChecksum === false ? "restore" : "validate"; const start = performance.now(); globalThis.__stage = stage; try { return await original.apply(this, args); } finally { __perf[stage] = (__perf[stage] || 0) + performance.now() - start; globalThis.__stage = "other"; } }; }\n';
    }
    return source.replace(/\}\)\(\);\s*$/, `${timing}globalThis.api = { ${exports.join(', ')} };\n})();`);
}

export async function startHarness({ upstream, assets = process.env.RPH_PACKAGE_ROOT || root, instrumented = true } = {}) {
    let snapshot, latency = 0;
    const requests = [];
    const server = http.createServer(async (request, response) => {
        try {
            const url = new URL(request.url, 'http://localhost');
            if (url.pathname === '/api/rp-sync' && snapshot) {
                const buffers = [];
                for await (const data of request) buffers.push(data);
                const body = JSON.parse(Buffer.concat(buffers).toString());
                requests.push(body);
                if (latency) await new Promise(resolve => setTimeout(resolve, latency));
                if (body.action === 'pull-manifest') {
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({ ok: true, remote: snapshot.remote }));
                } else if (body.action === 'pull-json-part') {
                    const bytes = Buffer.concat(snapshot.chunks.slice(body.start, body.start + body.count));
                    response.setHeader('content-type', 'application/octet-stream');
                    response.setHeader('x-rp-sync-byte-length', bytes.length);
                    response.end(bytes);
                } else { response.statusCode = 400; response.end('{}'); }
                return;
            }
            if (url.pathname === '/' || url.pathname === '/index.html') {
                response.setHeader('content-type', 'text/html; charset=utf-8');
                if (upstream) {
                    const html = await fs.readFile(path.join(upstream, 'index.html'), 'utf8');
                    const scripts = ['nav-adapter', 'char-store', 'bootstrap', 'image-module', 'module-loader']
                        .map(name => `<script src="/DB/${name}.js"></script>`).join('');
                    response.end(html.replace('</head>', `<link rel="stylesheet" href="/DB/styles.css">${scripts}</head>`));
                    return;
                }
                response.end(`<!doctype html><html><body><div id="app"><aside class="app-sidebar"><button class="menu"><svg viewBox="0 0 24 24"><path d="M0 0"></path></svg><span>设置</span></button></aside></div><script src="/DB/nav-adapter.js"></script><script src="/instrumented.js${url.search}"></script></body></html>`);
                return;
            }
            if (url.pathname === '/instrumented.js') {
                response.setHeader('content-type', 'text/javascript; charset=utf-8');
                const directory = url.searchParams.has('baseline') ? baseline : assets;
                response.end(instrument(await fs.readFile(path.join(directory, 'DB/bootstrap.js'), 'utf8'), url.searchParams.has('metrics')));
                return;
            }
            const directory = upstream && !url.pathname.startsWith('/DB/') ? upstream : assets;
            const file = path.resolve(directory, '.' + decodeURIComponent(url.pathname));
            if (!file.startsWith(directory + path.sep)) throw new Error('invalid path');
            response.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript; charset=utf-8');
            let content = await fs.readFile(file);
            if (upstream && url.pathname === '/assets/js/app.js') content = patchRpHubAppJs(content.toString()).code;
            if (instrumented && url.pathname === '/DB/bootstrap.js') content = instrument(content.toString());
            response.end(content);
        } catch { response.statusCode = 404; response.end('not found'); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}`, requests,
        setSnapshot(value, delay = 0) { snapshot = value; latency = delay; requests.length = 0; },
        close: () => new Promise((resolve) => server.close(resolve)) };
}

export async function initializeFixture(page) {
    await page.evaluate(() => {
        window.fixture = {
            async db(name = 'RPHubDB', store = 'store') {
                return new Promise((resolve, reject) => {
                    const request = indexedDB.open(name, 1);
                    request.onupgradeneeded = () => request.result.createObjectStore(store);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
            },
            async write(db, entries, clear = false) {
                return new Promise((resolve, reject) => {
                    const tx = db.transaction(db.objectStoreNames[0], 'readwrite');
                    const store = tx.objectStore(db.objectStoreNames[0]);
                    if (clear) store.clear();
                    for (const [key, value] of entries) store.put(value, key);
                    tx.oncomplete = resolve;
                    tx.onabort = () => reject(tx.error);
                });
            },
            async snapshot() {
                const stats = { recordCount: 0, totalBytes: 0 };
                const chunks = [];
                for await (const chunk of api.iterateSnapshotChunks(stats)) chunks.push(chunk);
                const remote = { version: 1, snapshotFormat: 'rp-sync-jsonl-v1', schemaVersion: 4,
                    chunkerProfile: 'rph-jsonl-cdc-fnv1a-v1', recordCount: stats.recordCount,
                    totalBytes: stats.totalBytes, chunkCount: chunks.length,
                    chunkManifest: chunks.map(({ index, checksum, length }) => ({ index, checksum, length })) };
                remote.checksum = await api.sha256(api.buildStreamSnapshotChecksumSource(remote));
                return { remote, chunks };
            },
            mockServer(snapshot, options = {}) {
                const requests = [];
                window.fetch = async (_, init) => {
                    const body = JSON.parse(init.body);
                    requests.push(body);
                    if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
                    if (body.action === 'pull-manifest') return Response.json({ ok: true, remote: snapshot.remote });
                    if (body.action !== 'pull-json-part') return Response.json({ ok: true });
                    const selected = snapshot.chunks.slice(body.start, body.start + body.count);
                    const bytes = new Uint8Array(selected.reduce((sum, chunk) => sum + chunk.length, 0));
                    let offset = 0;
                    for (const chunk of selected) { bytes.set(chunk.bytes, offset); offset += chunk.length; }
                    return new Response(bytes);
                };
                return requests;
            }
        };
    });
}
