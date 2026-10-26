import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome } from './sync-195.helpers.mjs';

const harness = await startHarness();
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const passed = [];
async function test(name, callback) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(harness.url);
        await initializeFixture(page);
        await callback(page, context);
        passed.push(name);
        console.log(`PASS ${name}`);
    } finally { await context.close(); }
}
try {
    await test('navigation rebuild, disposal, template cleanup and stable DOM', async (page) => {
        await page.evaluate(() => {
            window.clicks = 0;
            window.entry = RPHubNavAdapter.registerEntry({ id: 'lifecycle', label: '<入口>', iconPaths: ['M1 1'], onClick: () => clicks++ });
            document.querySelector('#app').outerHTML = '<div id="app"><aside class="app-sidebar"><button id="native" disabled aria-current="page" class="menu is-current" onclick="window.nativeClicked=true"><svg viewBox="0 0 24 24"><path d="M0 0"/></svg><span>设置</span></button></aside></div>';
        });
        await page.locator('[data-rph-nav-entry="lifecycle"]').waitFor();
        const entry = page.locator('[data-rph-nav-entry="lifecycle"]');
        assert.equal(await entry.getAttribute('id'), null);
        assert.equal(await entry.getAttribute('aria-current'), null);
        assert.equal(await entry.isDisabled(), false);
        assert.equal(await entry.textContent(), '<入口>');
        await entry.press('Enter');
        await entry.press('Space');
        assert.equal(await page.evaluate(() => clicks), 2);
        assert.equal(await page.evaluate(() => window.nativeClicked), undefined);
        await page.evaluate(() => {
            window.domWrites = 0;
            window.monitor = new MutationObserver(records => { domWrites += records.length; });
            monitor.observe(document.querySelector('#app'), { subtree: true, childList: true, attributes: true });
        });
        await page.waitForTimeout(100);
        assert.equal(await page.evaluate(() => domWrites), 0);
        await page.evaluate(() => {
            monitor.disconnect();
            window.replacement = RPHubNavAdapter.registerEntry({ id: 'lifecycle', label: '替换入口', onClick: () => clicks++ });
            entry.dispose();
        });
        assert.equal(await entry.count(), 1);
        assert.equal(await entry.textContent(), '替换入口');
        await page.evaluate(() => replacement.dispose());
        assert.equal(await page.locator('[data-rph-nav-entry="lifecycle"]').count(), 0);
    });

    await test('navigation close timeout cancels activation and allows later retry', async (page) => {
        const warnings = [];
        page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
        await page.evaluate(() => {
            window.closeActivations = 0;
            document.querySelector('#app').innerHTML = '<section id="app-navigation-panel" class="app-navigation-panel"><button class="app-navigation-close">关闭</button><div class="app-navigation-grid"><button><svg></svg><span>原生</span></button></div></section>';
            RPHubNavAdapter.registerEntry({ id: 'timeout', label: '等待关闭', waitForClose: true, onClick: () => closeActivations++ });
        });
        await page.locator('[data-rph-nav-entry="timeout"]').click();
        await page.waitForTimeout(2100);
        assert.equal(await page.evaluate(() => closeActivations), 0);
        assert(warnings.some(text => text.includes('导航未及时关闭')));
        await page.evaluate(() => document.querySelector('.app-navigation-close').addEventListener('click', () => document.querySelector('#app-navigation-panel').remove()));
        await page.locator('[data-rph-nav-entry="timeout"]').click();
        await page.waitForFunction(() => closeActivations === 1);
    });

    await test('JSONL records and serialization boundaries match baseline except workshop coverage header', async (page, context) => {
        const baselinePage = await context.newPage();
        await baselinePage.goto(harness.url + '/?baseline');
        await initializeFixture(baselinePage);
        const collect = async (target) => target.evaluate(async () => {
            const db = await fixture.db();
            const sparse = ['中文🙂\n"\\', , { date: new Date('2026-01-01'), numbers: [NaN, Infinity, -0] }];
            await fixture.write(db, [['array', sparse], ['date', new Date('2026-09-16')], ['value', { '<key>': '\u0000\ud800' }]], true);
            db.close();
            localStorage.setItem('rp_hub_presets', JSON.stringify({ custom: ['自定义'], enabled: true }));
            const snapshot = await fixture.snapshot();
            const result = { remote: snapshot.remote, text: new TextDecoder().decode(new Uint8Array(await new Blob(snapshot.chunks.map(c => c.bytes)).arrayBuffer())) };
            const record = { type: 'record', database: 'RPHubDB', store: 'store', key: 'edge' };
            result.edges = [];
            for (const value of [undefined, 1n, () => {}, { toJSON(key) { return key; } }, new Date('invalid')]) {
                try {
                    let text;
                    if (api.serializeStreamRecord) text = new TextDecoder().decode(api.serializeStreamRecord(record, 'edge', value));
                    else { api.checkStreamRecordSize('edge', value); text = api.serializeSnapshotLine({ ...record, value }); }
                    result.edges.push({ text });
                } catch (error) { result.edges.push({ error: error.message }); }
            }
            return result;
        });
        const current = await collect(page), previous = await collect(baselinePage);
        const [header, ...body] = current.text.split('\n');
        const [oldHeader, ...oldBody] = previous.text.split('\n');
        assert.deepEqual(JSON.parse(header), { ...JSON.parse(oldHeader), workshopVersion: 1 });
        assert.deepEqual(body, oldBody);
        assert.deepEqual(current.edges, previous.edges);
        assert.equal(current.remote.recordCount, previous.remote.recordCount);
    });

    await test('second scan rejects edits, additions and deletions', async (page) => {
        assert.equal(await page.evaluate(async () => {
            const db = await fixture.db();
            let rejected = 0;
            for (const entries of [[['a', 'changed']], [['a', 'base'], ['b', 'new']], []]) {
                await fixture.write(db, [['a', 'base']], true);
                const before = await api.scanStreamSnapshot();
                await fixture.write(db, entries, true);
                try { await api.uploadMissingStreamChunks(before, []); }
                catch (error) { if (error.message.includes('两次扫描')) rejected++; }
            }
            db.close();
            return rejected;
        }), 3);
    });

    await test('range continuity, byte budgets, oversize serialization and out-of-order completion', async (page) => {
        const result = await page.evaluate(async () => {
            api.CONFIG.downloadRangeBytes = 1600;
            api.CONFIG.downloadPendingBytes = 3200;
            const lengths = [900, 800, 3500, 600, 900, 700];
            const chunks = await Promise.all(lengths.map(async (length, index) => {
                const bytes = new Uint8Array(length).fill(index);
                return { index, length, bytes, checksum: await api.sha256Bytes(bytes) };
            }));
            const manifest = chunks.map(({ bytes, ...chunk }) => chunk);
            const ranges = api.buildDownloadRanges(manifest, new Set([api.chunkCacheKey(manifest[1])]));
            const active = new Map(), violations = [], completion = [];
            window.fetch = async (_, init) => {
                const request = JSON.parse(init.body);
                const chosen = chunks.slice(request.start, request.start + request.count);
                const length = chosen.reduce((sum, c) => sum + c.length, 0);
                active.set(request.start, length);
                const total = [...active.values()].reduce((a, b) => a + b, 0);
                if (active.size > 2 || (active.size > 1 && (total > 3200 || [...active.values()].some(n => n > 1600)))) violations.push('budget');
                await new Promise(resolve => setTimeout(resolve, request.start === 0 ? 60 : 15));
                const bytes = new Uint8Array(length);
                let offset = 0;
                for (const c of chosen) { bytes.set(c.bytes, offset); offset += c.length; }
                active.delete(request.start);
                completion.push(request.start);
                return new Response(bytes);
            };
            const db = await api.openDownloadStagingDb();
            await api.downloadSnapshotToStaging({ version: 1 }, manifest, db);
            let count = 0;
            for await (const bytes of api.iterateStagedSnapshotChunks(db, manifest)) count += bytes.length;
            await api.clearDownloadStagingStore(db);
            db.close();
            return { ranges, violations, completion, count };
        });
        assert.equal(result.ranges[0].count, 1);
        assert.equal(result.ranges[1].start, 2);
        assert.deepEqual(result.violations, []);
        assert.equal(result.count, 7400);
        assert.equal(result.completion[0], 1);
    });

    await test('failure waits for late downloads and write abort before cleanup', async (page) => {
        const result = await page.evaluate(async () => {
            api.CONFIG.jsonDownloadPartChunks = 1;
            api.CONFIG.retryDelayMs = 1;
            const chunks = await Promise.all([0, 1, 2, 3].map(async index => {
                const bytes = new Uint8Array(20).fill(index);
                return { index, bytes, length: 20, checksum: await api.sha256Bytes(bytes) };
            }));
            let active = 0, calls = 0, lateFinished = false;
            window.fetch = async (_, init) => {
                const body = JSON.parse(init.body); calls++; active++;
                await new Promise(resolve => setTimeout(resolve, body.start ? 80 : 5));
                active--;
                if (body.start === 0) return Response.json({ error: 'denied' }, { status: 401 });
                lateFinished = true;
                return new Response(chunks[body.start].bytes);
            };
            const db = await api.openDownloadStagingDb();
            let failed = false;
            try { await api.downloadSnapshotToStaging({ version: 1 }, chunks, db); } catch { failed = true; }
            const atFailure = { failed, active, calls, lateFinished };
            await api.clearDownloadStagingStore(db);
            const original = IDBObjectStore.prototype.put;
            let abortFinished = false;
            const transaction = db.transaction.bind(db);
            db.transaction = (...args) => {
                const tx = transaction(...args);
                tx.addEventListener('abort', () => { abortFinished = true; });
                return tx;
            };
            IDBObjectStore.prototype.put = function (...args) {
                throw new DOMException('quota', 'QuotaExceededError');
            };
            try { await api.writeDownloadStagingChunks(db, chunks); } catch (error) { atFailure.writeError = error.name; }
            IDBObjectStore.prototype.put = original;
            atFailure.abortFinished = abortFinished;
            db.close();
            return atFailure;
        });
        assert.deepEqual(result, { failed: true, active: 0, calls: 2, lateFinished: true, writeError: 'QuotaExceededError', abortFinished: true });
    });

    await test('download budget remains reserved until the write transaction completes', async (page) => {
        const result = await page.evaluate(async () => {
            api.CONFIG.jsonDownloadPartChunks = 1;
            api.CONFIG.downloadRangeBytes = 20;
            api.CONFIG.downloadPendingBytes = 40;
            const chunks = await Promise.all([0, 1, 2, 3, 4].map(async index => {
                const bytes = new Uint8Array(20).fill(index);
                return { index, bytes, length: 20, checksum: await api.sha256Bytes(bytes) };
            }));
            let reserved = 0, peak = 0;
            window.fetch = async (_, init) => {
                reserved += 20; peak = Math.max(peak, reserved);
                return new Response(chunks[JSON.parse(init.body).start].bytes);
            };
            const db = await api.openDownloadStagingDb();
            const transaction = db.transaction.bind(db);
            db.transaction = (...args) => {
                const tx = transaction(...args);
                tx.addEventListener('complete', () => { reserved -= tx.downloadBytes || 0; });
                return tx;
            };
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (...args) {
                this.transaction.downloadBytes = (this.transaction.downloadBytes || 0) + args[0].byteLength;
                const end = performance.now() + 30;
                const keepAlive = () => {
                    const request = this.get('keep-alive');
                    request.onsuccess = () => { if (performance.now() < end) keepAlive(); };
                };
                keepAlive();
                return put.apply(this, args);
            };
            try { await api.downloadSnapshotToStaging({ version: 1 }, chunks, db); }
            finally { IDBObjectStore.prototype.put = put; db.close(); }
            return { peak, reserved };
        });
        assert.deepEqual(result, { peak: 40, reserved: 0 });
    });

    await test('chunk prefetch stays one chunk ahead and drains a pending repair on consumer failure', async (page) => {
        const result = await page.evaluate(async () => {
            const chunks = await Promise.all([0, 1, 2, 3].map(async index => {
                const bytes = new Uint8Array(64).fill(index);
                return { index, bytes, length: bytes.length, checksum: await api.sha256Bytes(bytes) };
            }));
            const db = await api.openDownloadStagingDb('RPHubSyncChunkCache');
            await api.writeDownloadStagingChunks(db, chunks);
            const get = IDBObjectStore.prototype.get, reads = [];
            IDBObjectStore.prototype.get = function (key) {
                if (this.transaction.db === db) reads.push(key);
                return get.call(this, key);
            };
            let ahead, started = false, finished = false, failed = false;
            try {
                const stream = api.iterateStagedSnapshotChunks(db, chunks);
                const { value } = await stream.next();
                if (value[0] !== 0) throw new Error('Unexpected first chunk');
                await new Promise(resolve => setTimeout(resolve, 50));
                ahead = reads.length;
                await stream.return();
                await fixture.write(db, [[api.chunkCacheKey(chunks[1]), new Uint8Array([9])]]);
                const repairing = api.iterateStagedSnapshotChunks(db, chunks, true, { repair: async chunk => {
                    started = true;
                    await new Promise(resolve => setTimeout(resolve, 30));
                    await api.writeDownloadStagingChunks(db, [chunks[chunk.index]]);
                    finished = true;
                } });
                try {
                    for await (const bytes of repairing) {
                        await new Promise(resolve => setTimeout(resolve, 5));
                        throw new Error('Consumer stopped');
                    }
                } catch (error) { failed = error.message === 'Consumer stopped'; }
                return { ahead, started, finished, failed };
            } finally { IDBObjectStore.prototype.get = get; db.close(); }
        });
        assert.deepEqual(result, { ahead: 2, started: true, finished: true, failed: true });
    });

    await test('a repeatedly damaged cache is repaired once and never reaches business restore', async (page) => {
        const result = await page.evaluate(async () => {
            const db = await fixture.db(); await fixture.write(db, [['sample', 'cloud']], true);
            const snapshot = await fixture.snapshot();
            await fixture.write(db, [['sample', 'local']], true);
            const requests = fixture.mockServer(snapshot);
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (...args) {
                if (this.transaction.db.name === 'RPHubSyncChunkCache') args[0] = new Uint8Array([0]);
                return put.apply(this, args);
            };
            let restored = false, failed = false;
            try { await api.runSyncLocked(() => api.restoreStreamSnapshot(snapshot.remote, () => { restored = true; })); }
            catch { failed = true; }
            finally { IDBObjectStore.prototype.put = put; }
            const value = await new Promise(resolve => { const r = db.transaction('store').objectStore('store').get('sample'); r.onsuccess = () => resolve(r.result); });
            const cache = await api.openDownloadStagingDb('RPHubSyncChunkCache');
            const remaining = await new Promise(resolve => { const r = cache.transaction('chunks').objectStore('chunks').count(); r.onsuccess = () => resolve(r.result); });
            db.close(); cache.close();
            return { failed, restored, value, remaining, downloads: requests.filter(r => r.action === 'pull-json-part').length };
        });
        assert.deepEqual(result, { failed: true, restored: false, value: 'local', remaining: 0, downloads: 2 });
    });

    await test('cold, full, partial, corrupt and evicted cache restores identical values', async (page) => {
        const result = await page.evaluate(async () => {
            api.CONFIG.chunkSize = 256;
            const db = await fixture.db();
            await fixture.write(db, Array.from({ length: 8 }, (_, i) => [`rp_hub_chat_${i}`, [{ content: '中文🙂'.repeat(150) + i }]]), true);
            await fixture.write(db, [
                ['rp_hub_image_renders_role', { 'image-one': { ownerUuid: 'role', prompt: '图像' } }],
                ['rp_hub_presets', { custom: [{ name: '自定义预设', enabled: true, content: '中文🙂' }], enabled: false }],
                ['rp_hub_character_index', { order: ['role-b', 'role'] }],
                ['rp_hub_character_role', { uuid: 'role', name: '角色甲' }],
                ['rp_hub_character_role-b', { uuid: 'role-b', name: '角色乙' }]
            ]);
            localStorage.setItem('rp_hub_presets', JSON.stringify({ custom: ['preset'], enabled: true }));
            const snapshot = await fixture.snapshot();
            const requests = fixture.mockServer(snapshot);
            const counts = [];
            const pull = async () => {
                requests.length = 0;
                await api.runSyncLocked(() => api.restoreStreamSnapshot(snapshot.remote));
                counts.push(requests.filter(r => r.action === 'pull-json-part').flatMap(r => Array.from({ length: r.count }, (_, i) => r.start + i)));
            };
            await pull();
            await fixture.write(db, [['local-only', 'must be removed']]);
            localStorage.setItem('rp_hub_presets', 'locally changed');
            await pull();
            const restored = await fixture.snapshot();
            const cache = await api.openDownloadStagingDb('RPHubSyncChunkCache');
            const key = api.chunkCacheKey(snapshot.chunks[2]);
            const keep = api.retainedChunkKeys(snapshot.remote.chunkManifest); keep.delete(key);
            await api.pruneDownloadCache(cache, keep);
            await pull();
            await fixture.write(cache, [[key, new Uint8Array([0, 1])]]);
            await pull();
            api.CONFIG.downloadCacheBytes = 1800;
            await pull();
            const actualKeys = await new Promise(resolve => { const r = cache.transaction('chunks').objectStore('chunks').getAllKeys(); r.onsuccess = () => resolve(r.result); });
            const expectedKeys = [...api.retainedChunkKeys(snapshot.remote.chunkManifest, null, 1800)];
            await api.clearDownloadStagingStore(cache);
            await pull();
            cache.close(); db.close();
            return { counts, checksum: restored.remote.checksum, original: snapshot.remote.checksum, actualKeys, expectedKeys, total: snapshot.chunks.length };
        });
        assert.equal(result.checksum, result.original);
        assert.equal(result.counts[0].length, result.total);
        assert.deepEqual(result.counts[1], []);
        assert.deepEqual(result.counts[2], [2]);
        assert.deepEqual(result.counts[3], [2]);
        assert.deepEqual(result.actualKeys.sort(), result.expectedKeys.sort());
        assert.equal(result.counts[5].length, result.total);
    });

    await test('cache open failure, quota fallback and no-lock mode keep staging temporary', async (page) => {
        const result = await page.evaluate(async () => {
            const db = await fixture.db(); await fixture.write(db, [['sample', { value: 'ok' }]], true); db.close();
            const snapshot = await fixture.snapshot(); fixture.mockServer(snapshot);
            const realOpen = indexedDB.open.bind(indexedDB);
            let openFailures = 0, quotaFailures = 0, restores = 0;
            indexedDB.open = (name, ...args) => {
                if (name === 'RPHubSyncChunkCache') { openFailures++; throw new Error('unavailable'); }
                return realOpen(name, ...args);
            };
            await api.runSyncLocked(() => api.restoreStreamSnapshot(snapshot.remote, () => restores++));
            indexedDB.open = realOpen;
            const put = IDBObjectStore.prototype.put;
            IDBObjectStore.prototype.put = function (...args) {
                if (this.transaction.db.name === 'RPHubSyncChunkCache') { quotaFailures++; throw new DOMException('full', 'QuotaExceededError'); }
                return put.apply(this, args);
            };
            await api.runSyncLocked(() => api.restoreStreamSnapshot(snapshot.remote, () => restores++));
            IDBObjectStore.prototype.put = put;
            Object.defineProperty(navigator, 'locks', { value: undefined });
            await api.runSyncLocked(() => api.restoreStreamSnapshot(snapshot.remote, () => restores++));
            const staging = await api.openDownloadStagingDb();
            const keys = await new Promise(resolve => { const r = staging.transaction('chunks').objectStore('chunks').getAllKeys(); r.onsuccess = () => resolve(r.result); });
            staging.close();
            return { openFailures, quotaFailures, restores, keys };
        });
        assert.deepEqual(result, { openFailures: 1, quotaFailures: 1, restores: 3, keys: [] });
    });

    await test('authentication and changed manifest never restore from cache', async (page) => {
        const result = await page.evaluate(async () => {
            const db = await fixture.db(); await fixture.write(db, [['sample', 'cloud']], true);
            const snapshot = await fixture.snapshot(); fixture.mockServer(snapshot);
            await api.runSyncLocked(() => api.restoreStreamSnapshot(snapshot.remote));
            await fixture.write(db, [['sample', 'local']], true);
            window.fetch = async () => Response.json({ error: 'denied' }, { status: 401 });
            await api.pullFromServer();
            const authStatus = api.state.statusText;
            fixture.mockServer(snapshot);
            const fetch = window.fetch;
            window.fetch = async (...args) => JSON.parse(args[1].body).action === 'pull-manifest'
                ? Response.json({ ok: true, remote: { ...snapshot.remote, version: 2 } }) : fetch(...args);
            let restored = false, errorStatus;
            try { await api.runSyncLocked(() => api.restoreStreamSnapshot(snapshot.remote, () => { restored = true; })); }
            catch (error) { errorStatus = error.status; }
            const stored = await new Promise(resolve => { const r = db.transaction('store').objectStore('store').get('sample'); r.onsuccess = () => resolve(r.result); });
            db.close(); return { authStatus, restored, errorStatus, stored };
        });
        assert.equal(result.authStatus, 'denied');
        assert.equal(result.restored, false);
        assert.equal(result.errorStatus, 409);
        assert.equal(result.stored, 'local');
    });

    await test('native lock excludes a second tab, releases after failure/close and covers reload wait', async (page, context) => {
        const second = await context.newPage(); await second.goto(harness.url);
        await page.evaluate(() => { window.holding = api.runSyncLocked(() => new Promise(resolve => { window.release = resolve; })); });
        await second.evaluate(() => api.runSyncLocked(() => { window.unexpected = true; }));
        assert.equal(await second.evaluate(() => window.unexpected), undefined);
        assert.match(await second.evaluate(() => api.state.statusText), /另一页面/);
        await page.evaluate(async () => { release(); await holding; });
        await second.evaluate(() => api.runSyncLocked(() => Promise.reject(new Error('expected'))).catch(() => {}));
        await page.evaluate(() => api.runSyncLocked(() => { api.state.reloadPending = true; }));
        await second.evaluate(() => api.runSyncLocked(() => { window.unexpected = true; }));
        assert.equal(await second.evaluate(() => window.unexpected), undefined);
        await page.close();
        await second.evaluate(() => api.runSyncLocked(() => { window.afterClose = true; }));
        assert.equal(await second.evaluate(() => window.afterClose), true);
    });
    console.log(JSON.stringify({ ok: true, cases: passed.length, passed }));
} finally { await browser.close(); await harness.close(); }
