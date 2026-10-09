import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { startHarness, initializeFixture, chromium, chrome, root, defaultUpstream } from './sync-195.helpers.mjs';

const evidence = path.join(root, 'evidence/workshop-cloud-20260917');
await fs.mkdir(evidence, { recursive: true });
const plugin = await fs.readFile(path.join(root, 'DB/modules/liuguanyi-19.5.4.js'), 'utf8');
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const report = { passed: [], pageErrors: [], blocked: [], snapshots: [] };
const contexts = [];
const externalScripts = new Map();
const isPublicScript = request => request.resourceType() === 'script'
    && ['cdn.tailwindcss.com', 'unpkg.com', 'cdn.jsdelivr.net'].includes(new URL(request.url()).hostname);
let remote = null, uploaded = new Map(), createRequest;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const audioBytes = Buffer.alloc(500124);
audioBytes.write('RIFF'); audioBytes.writeUInt32LE(audioBytes.length - 8, 4);
audioBytes.write('WAVEfmt ', 8); audioBytes.writeUInt32LE(16, 16);
audioBytes.writeUInt16LE(1, 20); audioBytes.writeUInt16LE(1, 22);
audioBytes.writeUInt32LE(8000, 24); audioBytes.writeUInt32LE(16000, 28);
audioBytes.writeUInt16LE(2, 32); audioBytes.writeUInt16LE(16, 34);
audioBytes.write('data', 36); audioBytes.writeUInt32LE(audioBytes.length - 44, 40);
function passed(name) { report.passed.push(name); console.log('PASS ' + name); }

async function device(mobile = false) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
    contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', e => report.pageErrors.push(e.message));
    page.on('dialog', d => d.accept());
    page.on('response', response => {
        if (response.ok() && isPublicScript(response.request()) && !externalScripts.has(response.url())) {
            const cached = response.body().then(body => ({ contentType: 'text/javascript', body })).catch(() => null);
            for (let request = response.request(); request; request = request.redirectedFrom()) externalScripts.set(request.url(), cached);
        }
    });
    await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === harness.url) {
            if (url.pathname === '/api/rp-sync') {
                const part = url.searchParams.get('action');
                if (part === 'upload-part') {
                    const index = Number(url.searchParams.get('index'));
                    uploaded.set(index, request.postDataBuffer());
                    return route.fulfill({ json: { ok: true, index, partNumber: index + 1, key: 'fixture-' + index } });
                }
                const body = request.postDataJSON();
                if (body?.action === 'upload-create') {
                    createRequest = body;
                    uploaded = new Map();
                    return route.fulfill({ json: { ok: true, previousVersion: remote?.version || 0, missingIndices: body.chunkManifest.map(c => c.index) } });
                }
                if (body?.action === 'upload-complete') {
                    for (const c of createRequest.chunkManifest) {
                        assert.equal(hash(uploaded.get(c.index)), c.checksum);
                        assert.equal(uploaded.get(c.index).length, c.length);
                    }
                    remote = { ...body, version: (remote?.version || 0) + 1 };
                    report.snapshots.push({ version: remote.version, bytes: remote.totalBytes, chunks: remote.chunkCount });
                    return route.fulfill({ json: { ok: true, version: remote.version } });
                }
                if (body?.action === 'pull-manifest') return route.fulfill({ json: { ok: true, remote } });
                if (body?.action === 'pull-json-part') {
                    const bytes = Buffer.concat(Array.from({ length: body.count }, (_, i) => uploaded.get(body.start + i)));
                    return route.fulfill({ contentType: 'application/octet-stream', body: bytes, headers: { 'x-rp-sync-byte-length': String(bytes.length) } });
                }
                return route.fulfill({ json: { ok: true, authenticated: true, authRequired: false } });
            }
            if (url.pathname === '/DB/bootstrap.js') {
                const response = await route.fetch();
                return route.fulfill({ response, body: (await response.text()).replace('globalThis.api = {', 'globalThis.api = { performPushSync, performPullSync, replaceLocalSnapshot,') });
            }
            return route.continue();
        }
        if (isPublicScript(request)) {
            const cached = await externalScripts.get(url.href);
            return cached ? route.fulfill(cached) : route.continue();
        }
        report.blocked.push(url.origin + url.pathname);
        if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: png });
        if (request.resourceType() === 'stylesheet') return route.fulfill({ contentType: 'text/css', body: '' });
        return route.fulfill({ json: {} });
    });
    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__ && !!globalThis.RPHubSDK);
    await page.addLocatorHandler(page.getByRole('button', { name: /^(?:我)?知道了/ }).first(), async button => button.click());
    await dismissWelcome(page);
    return page;
}

async function dismissWelcome(page) {
    await page.locator('#custom-splash-screen').waitFor({ state: 'detached', timeout: 15000 });
    const name = page.getByPlaceholder('角色对您的称呼');
    if (await name.isVisible()) {
        await name.fill('隔离同步用户');
        await page.getByRole('button', { name: /开始/ }).click();
        await name.waitFor({ state: 'hidden' });
    }
}

async function openManager(page) {
    await dismissWelcome(page);
    await page.locator('.app-nav-trigger:visible').first().click();
    await page.locator('[data-rph-workshop-manager-entry]').click();
    await page.locator('[data-rph-workshop-panel]').waitFor();
}

async function moduleReady(page) {
    await page.waitForFunction(() => globalThis.__rphLiuguanyiInitialized && JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]').some(e => e.id === 'liuguanyi' && ['ok','init-error'].includes(e.lastStatus)), null, { timeout: 30000 });
    await page.evaluate(() => RPHubSDK.flush());
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1')).find(e => e.id === 'liuguanyi').lastStatus), 'ok');
    await dismissWelcome(page);
}

async function push(page) {
    await page.evaluate(async () => { await api.performPushSync(); });
    assert.equal(await page.evaluate(() => api.state.statusText), '上传成功。');
}

async function pull(page) {
    await page.evaluate(async () => { await api.performPullSync(); });
    assert.equal(await page.evaluate(() => api.state.reloadPending), true);
    await page.waitForEvent('domcontentloaded', { timeout: 45000 });
    await moduleReady(page);
}

async function records(page) {
    return page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => { const req = indexedDB.open('RPHubWorkshop'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        try {
            const read = storeName => new Promise((resolve, reject) => {
                const store = db.transaction(storeName).objectStore(storeName);
                const keys = store.getAllKeys(), values = store.getAll();
                store.transaction.oncomplete = () => resolve(Object.fromEntries(keys.result.map((key, i) => [key, values.result[i]])));
                store.transaction.onabort = () => reject(store.transaction.error);
            });
            return { scripts: await read('scripts'), data: await read('data'),
                list: JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1')), notes: localStorage.getItem('rphub_notes_v1'),
                settings: localStorage.getItem('rphub_split_apis_v2'), theme: localStorage.getItem('rphub_theme_color_v1'), playlist: localStorage.getItem('sakura_gramophone_playlist_v6') };
        } finally { db.close(); }
    });
}

try {
    const a = await device();
    await initializeFixture(a);
    await a.evaluate(async encodedAudio => {
        localStorage.setItem('rphub_notes_v1', 'legacy note');
        localStorage.setItem('rphub_theme_color_v1', '#248572');
        localStorage.setItem('rphub_split_apis_v2', JSON.stringify({ memory: { active: 'custom', customUrls: { custom: 'https://fixture.invalid' }, keys: { custom: 'fixture-key' } } }));
        const db = await fixture.db('SakuraMomentsDB', 'moments');
        await fixture.write(db, [['list', Array.from({ length: 25 }, (_, i) => ({ id: String(i), title: 'Long moment ' + i,
            aiText: (i === 0 ? 'image###do not generate### <img src="https://generation.invalid/should-not-load">\n' : '') + 'Long text '.repeat(2000),
            images: [{src:'https://generation.invalid/should-not-load'}] }))]]);
        db.close();
        const tracks = await fixture.db('sakura_gramophone_db', 'tracks');
        const bytes = Uint8Array.from(atob(encodedAudio), c => c.charCodeAt(0));
        await fixture.write(tracks, [['audio1', { id: 'audio1', blob: new Blob([bytes], { type: 'audio/wav' }) }]]);
        tracks.close();
        localStorage.setItem('sakura_gramophone_playlist_v6', JSON.stringify([{ id: 'audio1', type: 'local', title: 'fixture audio' }]));
    }, audioBytes.toString('base64'));
    await openManager(a);
    const chooser = a.waitForEvent('filechooser');
    await a.locator('[data-rph-workshop-import]').click();
    await (await chooser).setFiles({ name: 'liuguanyi.js', mimeType: 'text/javascript', buffer: Buffer.from(plugin) });
    await a.locator('[data-rph-ui-confirm] [data-rph-ui-confirm-accept]').click();
    await a.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]').length === 1);
    await a.reload({ waitUntil: 'domcontentloaded' });
    await moduleReady(a);
    passed('JS file import and initialization');
    const initial = await records(a);
    assert.equal(Object.values(initial.scripts)[0], plugin);
    assert.equal(initial.data['liuguanyi::moments'].length, 25);
    assert.equal(initial.data['liuguanyi::moments'][24].aiText.length, 20000);
    assert(!('images' in initial.data['liuguanyi::moments'][0]));
    const audio = initial.data['liuguanyi::track:audio1'];
    assert.equal(audio[0].mime, 'audio/wav');
    assert.equal(hash(Buffer.concat(audio.slice(1).map(v => Buffer.from(v, 'base64')))), hash(audioBytes));
    passed('legacy full moments and binary audio migration');
    assert.equal(await a.getByTitle('自动生图开关', { exact: true }).count(), 1);
    assert.equal(await a.getByTitle('名场面回忆', { exact: true }).count(), 0);
    assert(!/imageLock|generated-image|sakura-bk-import|sakura-bk-export/.test(plugin));
    passed('image button preserved and image hooks removed');

    await openManager(a);
    await a.screenshot({ path: path.join(evidence, 'desktop-manager.png') });
    const updatedPlugin = plugin.replace("version: '19.5.4-rph.1'", "version: '19.5.4-rph.2'");
    const updateChooser = a.waitForEvent('filechooser');
    await a.locator('[data-rph-workshop-replace]').click();
    await (await updateChooser).setFiles({ name: 'liuguanyi-update.js', mimeType: 'text/javascript', buffer: Buffer.from(updatedPlugin) });
    await a.getByText('插件文件已更新，原数据保留，刷新后生效', { exact: true }).waitFor();
    await a.reload({ waitUntil: 'domcontentloaded' });
    await moduleReady(a);
    const updated = await records(a);
    assert.equal(Object.values(updated.scripts)[0], updatedPlugin);
    assert.equal(updated.list.length, 1);
    assert.equal(updated.list[0].url, initial.list[0].url);
    assert.equal(updated.list[0].version, '19.5.4-rph.2');
    assert.deepEqual(updated.data, initial.data);
    assert.equal(updated.notes, initial.notes);
    passed('file update preserves installation identity, notes and full private data');

    await a.addInitScript(() => {
        const get = IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get = function (key) {
            if (this.transaction.db.name === 'RPHubWorkshop' && key === 'liuguanyi::moments'
                && localStorage.getItem('fixtureFailMomentsRead')) throw new Error('fixture moments read failure');
            return get.call(this, key);
        };
    });
    await a.evaluate(() => localStorage.setItem('fixtureFailMomentsRead', '1'));
    await a.reload({ waitUntil: 'domcontentloaded' });
    await a.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1'))[0].lastStatus === 'init-error');
    await assert.rejects(a.evaluate(() => RPHubSDK.flush()), /fixture moments read failure/);
    assert.deepEqual((await records(a)).data, initial.data);
    await a.evaluate(() => localStorage.removeItem('fixtureFailMomentsRead'));
    await a.reload({ waitUntil: 'domcontentloaded' });
    await moduleReady(a);
    passed('failed full-text read preserves complete data and blocks upload');

    await a.locator('.app-nav-trigger:visible').first().click();
    await a.locator('[data-rph-workshop-manager-entry]').click();
    await a.locator('[data-rph-workshop-module-id="liuguanyi"]').filter({ hasText: '便签' }).click();
    await a.getByRole('textbox', { name: '便签内容' }).fill('Cloud note\n中文 and punctuation <>&');
    await a.locator('[data-rph-workshop-panel-close]').click();
    await push(a);
    passed('real push flow includes module source and private data');
    const uploadedText = Buffer.concat([...uploaded].sort((x,y)=>x[0]-y[0]).map(([,b])=>b)).toString('utf8');
    assert.match(uploadedText, /workshopVersion/);
    assert(!uploadedText.includes('rphub_image_lock_cache_v2'));
    const b = await device(true);
    await b.evaluate(() => { localStorage.setItem('rp_hub_sync_password_v1', 'device-b-password'); });
    await pull(b);
    const restored = await records(b);
    assert.deepEqual(restored.scripts, (await records(a)).scripts);
    assert.deepEqual(restored.data, (await records(a)).data);
    assert.equal(restored.notes, 'Cloud note\n中文 and punctuation <>&');
    assert.equal(restored.theme, initial.theme);
    assert.equal(restored.settings, initial.settings);
    assert.equal(restored.playlist, initial.playlist);
    assert.equal(await b.evaluate(() => localStorage.getItem('rp_hub_sync_password_v1')), 'device-b-password');
    passed('fresh mobile context pulls source, state, notes, long text, settings and audio');
    await b.evaluate(() => {
        globalThis.Audio = new Proxy(Audio, { construct(target, args) {
            return globalThis.fixtureAudio = Reflect.construct(target, args);
        } });
    });
    await b.locator('#sakura-gramophone-trigger').click();
    await b.locator('.sgp-play-btn').click();
    await b.waitForFunction(() => globalThis.fixtureAudio?.currentTime > 0);
    const playback = await b.evaluate(async () => {
        fixtureAudio.pause();
        const bytes = await (await fetch(fixtureAudio.src)).arrayBuffer();
        return { duration: fixtureAudio.duration, digest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('') };
    });
    assert.equal(playback.digest, hash(audioBytes));
    assert(Math.abs(playback.duration - (audioBytes.length - 44) / 16000) < 0.01);
    await b.locator('.sgp-close').click();
    passed('restored local audio reconstructs exact bytes and plays');

    await b.locator('.app-nav-trigger:visible').first().click();
    await b.locator('[data-rph-workshop-manager-entry]').click();
    await b.locator('[data-rph-workshop-module-id="liuguanyi"]').filter({ hasText: '文字名场面' }).click();
    await b.locator('.sm-card').filter({ hasText: 'Long moment 0' }).click();
    assert.equal(await b.locator('.sm-content img').count(), 0);
    assert.match(await b.locator('.sm-content').innerText(), /\[图片\].*<img src=/);
    assert(!report.blocked.some(url => url.includes('generation.invalid')));
    await b.locator('#sakura-moments-mask [data-act="close"]').click();
    passed('text collection renders complete text without image requests');
    await openManager(b);
    const layout = await b.locator('[data-rph-workshop-module-row]').evaluate(row => {
        const bounds = row.getBoundingClientRect();
        return { width: row.clientWidth, scrollWidth: row.scrollWidth,
            overflow: [...row.querySelectorAll('button, label')].filter(node => {
                const box = node.getBoundingClientRect();
                return box.left < bounds.left || box.right > bounds.right;
            }).map(node => node.textContent.trim()) };
    });
    assert(layout.scrollWidth <= layout.width + 1 && !layout.overflow.length, JSON.stringify(layout));
    await b.screenshot({ path: path.join(evidence, 'mobile-manager.png') });
    await b.locator('label:has([data-rph-workshop-enabled]) .settings-toggle').click();
    await b.locator('[data-rph-workshop-panel-close]').click();
    await push(b);
    await a.evaluate(async () => { await api.performPullSync(); });
    await a.waitForEvent('domcontentloaded');
    await a.waitForFunction(() => !!RPHubSDK);
    assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1'))[0].enabled), false);
    assert.equal(await a.evaluate(() => !!globalThis.__rphLiuguanyiInitialized), false);
    passed('disabled state restores without executing module');

    // Legacy snapshots have no workshop coverage flag. They must preserve data
    // which the old writer could never have included.
    await initializeFixture(a);
    const oldState = await records(a);
    await a.evaluate(async () => {
        const lines = [
            {type:'snapshot',format:'rp-sync-jsonl-v1',schemaVersion:4},
            {type:'localStorageEnd'}, {type:'snapshotEnd',recordCount:0}
        ];
        const restorer = new api.StreamSnapshotRestorer(0);
        for (const line of lines) await restorer.consume(JSON.stringify(line));
        restorer.finish();
        await api.replaceLocalSnapshot({ indexedDB: [], localStorage: [] });
    });
    const afterOld = await records(a);
    assert.deepEqual(afterOld, oldState);
    passed('old stream and legacy JSON snapshots preserve module files and private data');
    await a.evaluate(async () => {
        const restorer = new api.StreamSnapshotRestorer(0);
        for (const line of [{type:'snapshot',format:'rp-sync-jsonl-v1',schemaVersion:4,workshopVersion:1}, {type:'localStorageEnd'}, {type:'snapshotEnd',recordCount:0}]) await restorer.consume(JSON.stringify(line));
        restorer.finish();
    });
    const cleared = await records(a);
    assert.deepEqual(cleared.data, {});
    assert.deepEqual(cleared.scripts, {});
    assert.equal(cleared.notes, null);
    assert.equal(cleared.list, null);
    passed('new empty snapshot propagates plugin deletion');
    assert.deepEqual(report.pageErrors, []);
} catch (error) {
    report.failure = error.stack;
    console.error(error);
    process.exitCode = 1;
} finally {
    report.blocked = [...new Set(report.blocked)];
    await fs.writeFile(path.join(evidence, 'cloud-test-results.json'), JSON.stringify(report, null, 2));
    for (const c of contexts) await c.close();
    await browser.close();
    await harness.close();
}
