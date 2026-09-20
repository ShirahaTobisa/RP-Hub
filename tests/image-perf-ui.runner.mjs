import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const BASELINE_ZIP = path.resolve(ROOT_DIR, '..', 'release', 'RP-Hub-R2-rebuild-v4-img-20260811-030437.zip');
const BASELINE_ZIP_SHA256 = '1285E5BB43D9EF81886D6426DB8F6620D844969B8E89D8A2E88B1939D0F50A8E';
const CATALOG_BASELINE_ZIP = path.resolve(ROOT_DIR, '..', 'release', 'RP-Hub-R2-rebuild-v4-img-20260811-164132.zip');
const CATALOG_BASELINE_ZIP_SHA256 = '0B92D24C7DD236394556BA0F1FA5BED013ACF181B71773F8C0D053FAF3052567';
const DEFAULT_EVIDENCE_DIR = path.resolve(ROOT_DIR, '..', 'release', 'image-perf-ui-evidence');
const CHARACTER_COUNT = 50;
const LARGE_CHARACTER_COUNT = 120;
const LARGE_CHARACTER_PADDING_BYTES = 56 * 1024;
const ROW_COUNT = 8;
const SCENARIO_DURATION_MS = 5_000;
const MANAGER_LONG_DURATION_MS = 25_500;
const IDLE_LONG_DURATION_MS = 35_500;

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

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function parseOptions(argv) {
    const options = { evidenceDir: DEFAULT_EVIDENCE_DIR, catalogBaselineOnly: false };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--evidence-dir') options.evidenceDir = path.resolve(argv[++index]);
        else if (argv[index] === '--catalog-baseline-only') options.catalogBaselineOnly = true;
        else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    return options;
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
    const server = (await import('node:http')).createServer();
    const port = await listen(server);
    await closeServer(server);
    return port;
}

async function stopProcessTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 4000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForReady(origin, child, output) {
    for (let attempt = 0; attempt < 160; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited early (${child.exitCode}).\n${output.value.slice(-6000)}`);
        try {
            const response = await fetch(`${origin}/`);
            if (response.ok) return;
        } catch (_) {
            // Wrangler is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Wrangler did not become ready.\n${output.value.slice(-6000)}`);
}

function startWrangler(distRoot, stateRoot, configRoot, port) {
    const wranglerBin = path.resolve(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    assert.ok(existsSync(wranglerBin), `wrangler missing: ${wranglerBin}`);
    const output = { value: '' };
    const child = spawn(process.execPath, [
        wranglerBin, 'pages', 'dev', '.', '--port', String(port), '--persist-to', stateRoot,
        '--compatibility-date', '2026-07-15',
        '--log-level', 'error', '--show-interactive-dev-session=false'
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

function makeFixtureHtml() {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>image perf fixture</title></head>
<body><main id="app"><div class="absolute"><span class="ml-2 font-medium">Character 0</span><button title="清空聊天">清空</button></div>
<button title="发送">发送</button><button id="native-auto" title="自动生图开关">native auto</button>
<aside class="app-sidebar" id="sidebar"><button id="settings" type="button"><svg viewBox="0 0 24 24"><path></path></svg><span>设置</span></button></aside>
<section id="chat"></section><section id="manager-grid"></section></main>
<script src="/nav-adapter.js"></script>
<script>
(async () => {
    const params = new URLSearchParams(location.search);
    const mode = params.get('mode') || 'perf';
    const requestedVariant = params.get('variant') || '';
    const variant = ['baseline', 'catalog-baseline'].includes(requestedVariant) ? requestedVariant : 'current';
    const largeCatalog = params.get('large') === '1';
    const characterCount = largeCatalog ? ${LARGE_CHARACTER_COUNT} : ${CHARACTER_COUNT};
    const characterPadding = largeCatalog ? 'x'.repeat(${LARGE_CHARACTER_PADDING_BYTES}) : '';
    const counts = { dbGets: 0, directoryCycles: 0, directoryKeyGets: 0, seedCycles: 0, seedKeyGets: 0, chatDbGets: 0, fullDocumentScans: 0, rowTextSerializations: 0, rowTextByRow: Object.create(null) };
    const workshopLifetime = { dbReads: 0, intervalCreates: 0, networkRequests: 0, observerCreates: 0 };
    const fromWorkshop = () => String(new Error().stack || '').includes('/module-loader.js');
    const originalGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function(key) {
        if (fromWorkshop()) workshopLifetime.dbReads += 1;
        const value = String(key || '');
        counts.dbGets += 1;
        if (value === 'rp_hub_character_index') { counts.directoryCycles += 1; counts.directoryKeyGets += 1; }
        else if (value.startsWith('rp_hub_character_')) counts.directoryKeyGets += 1;
        else if (value === 'rp_hub_global_regex') { counts.seedCycles += 1; counts.seedKeyGets += 1; }
        else if (/^rp_hub_(?:global_)?(?:regex|worldinfo)$/.test(value)) counts.seedKeyGets += 1;
        else if (value.startsWith('rp_hub_chat_')) counts.chatDbGets += 1;
        return originalGet.apply(this, arguments);
    };
    const originalOpenKeyCursor = IDBObjectStore.prototype.openKeyCursor;
    IDBObjectStore.prototype.openKeyCursor = function() {
        if (fromWorkshop()) workshopLifetime.dbReads += 1;
        return originalOpenKeyCursor.apply(this, arguments);
    };
    const originalOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function() {
        if (fromWorkshop()) workshopLifetime.dbReads += 1;
        return originalOpen.apply(this, arguments);
    };
    const OriginalMutationObserver = window.MutationObserver;
    function InstrumentedMutationObserver(callback) {
        if (fromWorkshop()) workshopLifetime.observerCreates += 1;
        return new OriginalMutationObserver(callback);
    }
    InstrumentedMutationObserver.prototype = OriginalMutationObserver.prototype;
    Object.setPrototypeOf(InstrumentedMutationObserver, OriginalMutationObserver);
    window.MutationObserver = InstrumentedMutationObserver;
    const originalSetInterval = window.setInterval;
    window.setInterval = function() {
        if (fromWorkshop()) workshopLifetime.intervalCreates += 1;
        return originalSetInterval.apply(this, arguments);
    };
    const originalAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function(node) {
        if (fromWorkshop() && node instanceof HTMLScriptElement && node.hasAttribute('data-rph-workshop-module-script')) workshopLifetime.networkRequests += 1;
        return originalAppendChild.apply(this, arguments);
    };
    const originalFetch = window.fetch;
    window.fetch = function() {
        if (fromWorkshop()) workshopLifetime.networkRequests += 1;
        return originalFetch.apply(this, arguments);
    };
    const originalDocumentQuery = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function(selector) {
        if (selector === '[data-chat-index][data-role]') counts.fullDocumentScans += 1;
        return originalDocumentQuery.apply(this, arguments);
    };
    const textDescriptor = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    if (textDescriptor?.get && textDescriptor?.set) {
        Object.defineProperty(Node.prototype, 'textContent', {
            configurable: true,
            get() {
                const element = this.nodeType === Node.ELEMENT_NODE ? this : this.parentElement;
                const row = element?.closest?.('[data-chat-index][data-role]');
                if (row && window.__perfHarness?.active) {
                    const id = row.getAttribute('data-test-row') || row.getAttribute('data-chat-index') || 'unknown';
                    counts.rowTextSerializations += 1;
                    counts.rowTextByRow[id] = (counts.rowTextByRow[id] || 0) + 1;
                }
                return textDescriptor.get.call(this);
            },
            set(value) { return textDescriptor.set.call(this, value); }
        });
    }
    window.open = (...args) => { window.__opened.push(args); return null; };
    window.__opened = [];
    globalThis.RPH_R2_FLUSH_PERSISTENCE = async () => true;
    const put = (store, key, value) => store.put(value, key);
    await new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('store');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('store', 'readwrite');
            const store = tx.objectStore('store');
            const order = [];
            for (let i = 0; i < characterCount; i += 1) {
                const uuid = 'perf-character-' + i;
                order.push(uuid);
                put(store, 'rp_hub_character_' + uuid, { uuid, name: 'Character ' + i, description: characterPadding, first_mes: '', personality: '', worldInfo: [], regexScripts: [] });
                put(store, 'rp_hub_chat_' + uuid, [{ id: 'u-' + i, role: 'user', content: 'hello' }, { id: 'a-' + i, role: 'assistant', content: 'plain message ' + i }]);
            }
            put(store, 'rp_hub_character_index', { order });
            put(store, 'rp_hub_last_active_char', order[0]);
            put(store, 'rp_hub_settings', { freezeImageGeneration: true, imageGenCount: 2 });
            put(store, 'rp_hub_global_regex', [{ name: 'RPHub 自动生图正则', regex: '/image###([\\s\\S]*?)###/g', replacement: 'rph-image-marker###$1###', placement: [2], markdownOnly: true, promptOnly: false, scope: 'global', enabled: true }]);
            put(store, 'rp_hub_regex', []);
            put(store, 'rp_hub_global_worldinfo', [{ comment: '自动生图', content: '<auto_image_gen>fixture</auto_image_gen>', enabled: true }]);
            put(store, 'rp_hub_worldinfo', []);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        };
    });
    const chat = document.querySelector('#chat');
    const makeRows = (kind) => {
        const rows = [];
        for (let i = 0; i < ${ROW_COUNT}; i += 1) {
            const content = kind === 'failure' && i === 0 ? 'image###unowned failure marker###' : 'settled message ' + i;
            const frame = kind === 'idle' ? '<span class="rp-generated-image-frame"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt=""></span>' : '';
            rows.push('<article data-chat-index="' + i + '" data-role="assistant" data-test-row="' + i + '"><div class="message-content-wrapper"><div class="markdown-body"><span class="stream-node">' + content + '</span>' + frame + '</div></div><span class="msg-name-tag">Character 0</span></article>');
        }
        chat.innerHTML = rows.join('');
    };
    makeRows('idle');
    if (mode === 'delayed') document.querySelector('#sidebar').remove();
    const native = document.querySelector('#native-auto');
    native.addEventListener('click', () => { window.__nativeToggleCount = (window.__nativeToggleCount || 0) + 1; });
    window.__nativeToggleCount = 0;
    const reset = () => {
        for (const key of Object.keys(counts)) {
            if (key === 'rowTextByRow') counts[key] = Object.create(null);
            else counts[key] = 0;
        }
        window.__perfHarness.active = true;
        globalThis.RPHubImageModule?.resetPerformanceCounters?.({ rowDetails: true });
    };
    window.__perfHarness = {
        active: true,
        setMode(kind) { makeRows(kind); },
        startStream(duration) {
            const node = document.querySelector('[data-test-row="0"] .stream-node').firstChild;
            let tick = 0;
            const timer = setInterval(() => { node.nodeValue = 'stream ' + (tick++); }, 33);
            setTimeout(() => clearInterval(timer), duration);
        },
        startChurn(duration) {
            const grid = document.querySelector('#manager-grid');
            if (!grid.children.length) for (let i = 0; i < characterCount; i += 1) { const node = document.createElement('div'); node.className = 'card-node'; grid.appendChild(node); }
            let tick = 0;
            const timer = setInterval(() => { for (const node of grid.children) node.classList.toggle('active', tick % 2 === 0); tick += 1; }, 100);
            setTimeout(() => clearInterval(timer), duration);
        },
        async repeatScans(count) { for (let i = 0; i < count; i += 1) await globalThis.RPHubImageModule?.scan?.(); },
        reset,
        snapshot() {
            return {
                external: structuredClone(counts),
                module: globalThis.RPHubImageModule?.getPerformanceCounters?.() || {},
                workshop: structuredClone(workshopLifetime),
                domToasts: document.querySelectorAll('[data-rph-image-toast]').length,
                nativeToggleCount: window.__nativeToggleCount,
                opened: window.__opened.slice()
            };
        }
    };
    const script = document.createElement('script');
    script.src = '/' + variant + '.js';
    if (variant === 'current') script.addEventListener('load', () => {
        const loader = document.createElement('script');
        loader.src = '/module-loader.js';
        document.head.appendChild(loader);
    });
    document.head.appendChild(script);
    if (mode === 'delayed') setTimeout(() => {
        const sidebar = document.createElement('aside');
        sidebar.className = 'app-sidebar';
        sidebar.innerHTML = '<button type="button"><svg viewBox="0 0 24 24"><path></path></svg><span>设置</span></button>';
        document.querySelector('#app').insertBefore(sidebar, document.querySelector('#chat'));
    }, 3000);
})();
</script></body></html>`;
}

async function seedAndWait(page, origin, variant, mode = 'perf', options = {}) {
    const large = options.largeCatalog ? '&large=1' : '';
    await page.goto(`${origin}/?variant=${variant}&mode=${mode}${large}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(
        globalThis.RPHubImageModule?.getState?.().persistenceFlushWrapped
    ), null, { timeout: 30000 });
    if (variant === 'current') {
        await page.waitForFunction(() => Boolean(globalThis.RPHubSDK), null, { timeout: 30000 });
    }
    await page.waitForTimeout(options.largeCatalog ? 1600 : 500);
}

async function runLongCatalogScenario(browser, origin, variant, scenario) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
        await seedAndWait(page, origin, variant, 'perf', { largeCatalog: true });
        if (scenario === 'managerLong') {
            await page.evaluate((duration) => {
                document.querySelector('#chat').replaceChildren();
                window.__perfHarness.startChurn(duration);
            }, MANAGER_LONG_DURATION_MS);
            await page.waitForTimeout(200);
            await page.evaluate(() => window.__perfHarness.reset());
            await page.waitForTimeout(MANAGER_LONG_DURATION_MS);
        } else {
            await page.evaluate(() => window.__perfHarness.setMode('idle'));
            await page.waitForTimeout(200);
            await page.evaluate(() => window.__perfHarness.reset());
            await page.waitForTimeout(IDLE_LONG_DURATION_MS);
        }
        return await page.evaluate(() => window.__perfHarness.snapshot());
    } finally {
        await context.close();
    }
}

async function runScenario(browser, origin, variant, scenario) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
        await seedAndWait(page, origin, variant);
        if (scenario === 'stream') {
            await page.evaluate(() => window.__perfHarness.setMode('stream'));
            await page.waitForTimeout(200);
            await page.evaluate(() => window.__perfHarness.reset());
            await page.evaluate((duration) => window.__perfHarness.startStream(duration), SCENARIO_DURATION_MS);
            await page.waitForTimeout(SCENARIO_DURATION_MS + 350);
        } else if (scenario === 'manager') {
            await page.evaluate(() => window.__perfHarness.startChurn(5000));
            await page.evaluate(() => window.__perfHarness.reset());
            await page.waitForTimeout(SCENARIO_DURATION_MS + 350);
        } else if (scenario === 'failure') {
            await page.evaluate(() => window.__perfHarness.setMode('failure'));
            await page.waitForFunction(() => Boolean(document.querySelector('[data-test-row="0"]')?.dataset.rphImageAttributionFailure), null, { timeout: 30000 });
            await page.waitForTimeout(200);
            await page.evaluate(() => window.__perfHarness.reset());
            await page.evaluate(() => window.__perfHarness.repeatScans(5));
            await page.waitForTimeout(100);
        } else {
            await page.evaluate(() => window.__perfHarness.setMode('idle'));
            await page.waitForTimeout(200);
            await page.evaluate(() => window.__perfHarness.reset());
            await page.waitForTimeout(10_200);
        }
        return await page.evaluate(() => window.__perfHarness.snapshot());
    } finally {
        await context.close();
    }
}

async function runUiScenario(browser, origin) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
        await seedAndWait(page, origin, 'current', 'delayed');
        await page.waitForFunction(() => Boolean(
            document.querySelector('[data-rph-image-sidebar-entry]')
            && globalThis.RPHubImageModule?.getState?.().entryMode === 'sidebar'
        ), null, { timeout: 12000 });
        const entry = page.locator('[data-rph-image-sidebar-entry]');
        assert.equal(await entry.textContent(), '图片管理');
        assert.equal(await page.locator('#rph-image-module-root, [data-rph-image-panel], [data-rph-image-toggle], [data-rph-image-auto]').count(), 0);
        await entry.click();
        const opened = await page.evaluate(() => window.__opened);
        assert.deepEqual(opened[0], ['/image', '_blank', 'noopener']);
        await page.locator('#native-auto').click();
        await page.locator('#native-auto').click();
        assert.equal(await page.evaluate(() => window.__nativeToggleCount), 2);
        assert.equal(await page.evaluate(() => globalThis.RPHubImageModule.getState().entryMode), 'sidebar');
        return { delayedSidebarSeconds: 3, directOpen: opened[0], removedUiCount: 0, nativeToggleCount: 2 };
    } finally {
        await context.close();
    }
}

async function main() {
    const options = parseOptions(process.argv.slice(2));
    const zipBytes = await fs.readFile(BASELINE_ZIP);
    assert.equal(sha256(zipBytes), BASELINE_ZIP_SHA256, '030437 baseline ZIP SHA-256 changed');
    const catalogBaselineZipBytes = await fs.readFile(CATALOG_BASELINE_ZIP);
    assert.equal(sha256(catalogBaselineZipBytes), CATALOG_BASELINE_ZIP_SHA256, '164132 baseline ZIP SHA-256 changed');
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-image-perf-ui-'));
    const extractRoot = path.join(runtimeRoot, 'baseline');
    const catalogExtractRoot = path.join(runtimeRoot, 'catalog-baseline');
    const distRoot = path.join(runtimeRoot, 'dist');
    const stateRoot = path.join(runtimeRoot, 'state');
    const configRoot = path.join(runtimeRoot, 'config');
    await Promise.all([fs.mkdir(extractRoot, { recursive: true }), fs.mkdir(catalogExtractRoot, { recursive: true }), fs.mkdir(distRoot, { recursive: true }), fs.mkdir(stateRoot, { recursive: true }), fs.mkdir(configRoot, { recursive: true })]);
    const extracted = spawnSync('tar', ['-xf', BASELINE_ZIP, '-C', extractRoot], { encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
    const catalogExtracted = spawnSync('tar', ['-xf', CATALOG_BASELINE_ZIP, '-C', catalogExtractRoot], { encoding: 'utf8' });
    assert.equal(catalogExtracted.status, 0, catalogExtracted.stderr || catalogExtracted.stdout);
    await Promise.all([
        fs.writeFile(path.join(distRoot, 'index.html'), makeFixtureHtml(), 'utf8'),
        fs.copyFile(path.join(extractRoot, 'DB', 'image-module.js'), path.join(distRoot, 'baseline.js')),
        fs.copyFile(path.join(catalogExtractRoot, 'DB', 'image-module.js'), path.join(distRoot, 'catalog-baseline.js')),
        fs.copyFile(path.join(ROOT_DIR, 'DB', 'image-module.js'), path.join(distRoot, 'current.js')),
        fs.copyFile(path.join(ROOT_DIR, 'DB', 'nav-adapter.js'), path.join(distRoot, 'nav-adapter.js')),
        fs.copyFile(path.join(ROOT_DIR, 'DB', 'module-loader.js'), path.join(distRoot, 'module-loader.js'))
    ]);
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const wrangler = startWrangler(distRoot, stateRoot, configRoot, port);
    const report = {
        baselineZip: { path: BASELINE_ZIP, sha256: sha256(zipBytes) },
        catalogBaselineZip: { path: CATALOG_BASELINE_ZIP, sha256: sha256(catalogBaselineZipBytes) },
        origin,
        scenarios: { baseline: {}, current: {} },
        catalogFallback: { baseline: {}, current: {} },
        catalogFixture: {
            characters: LARGE_CHARACTER_COUNT,
            characterPaddingBytes: LARGE_CHARACTER_PADDING_BYTES,
            managerDurationMs: MANAGER_LONG_DURATION_MS,
            idleDurationMs: IDLE_LONG_DURATION_MS
        },
        ui: null,
        assertions: { idle: true, stream: true, manager: true, failure: true, delayedSidebar: true }
    };
    let browser;
    let failure = null;
    try {
        await waitForReady(origin, wrangler.child, wrangler.output);
        const { chromium } = loadPlaywright();
        browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server'] });
        const catalogVariants = options.catalogBaselineOnly ? ['catalog-baseline'] : ['catalog-baseline', 'current'];
        for (const variant of catalogVariants) {
            const reportVariant = variant === 'catalog-baseline' ? 'baseline' : 'current';
            for (const scenario of ['managerLong', 'idleLong']) {
                report.catalogFallback[reportVariant][scenario] = await runLongCatalogScenario(browser, origin, variant, scenario);
            }
        }
        const baselineManagerLong = report.catalogFallback.baseline.managerLong;
        const baselineIdleLong = report.catalogFallback.baseline.idleLong;
        assert.ok(baselineManagerLong.external.directoryCycles >= 2,
            `164132 manager baseline missed catalog fallback cycles: ${JSON.stringify(baselineManagerLong)}`);
        assert.ok(baselineIdleLong.external.directoryCycles >= 3,
            `164132 idle baseline missed catalog fallback cycles: ${JSON.stringify(baselineIdleLong)}`);
        assert.ok(baselineIdleLong.external.seedCycles >= 1,
            `164132 idle baseline missed seed fallback cycles: ${JSON.stringify(baselineIdleLong)}`);
        assert.equal(baselineManagerLong.external.rowTextSerializations, 0,
            '164132 manager baseline serialized a chat row after the manager view was isolated');
        if (options.catalogBaselineOnly) {
            report.ok = true;
        } else {
            for (const variant of ['baseline', 'current']) {
                for (const scenario of ['idle', 'stream', 'manager', 'failure']) {
                    report.scenarios[variant][scenario] = await runScenario(browser, origin, variant, scenario);
                }
            }
            report.ui = await runUiScenario(browser, origin);
            const currentManagerLong = report.catalogFallback.current.managerLong;
            const currentIdleLong = report.catalogFallback.current.idleLong;
            assert.ok(MANAGER_LONG_DURATION_MS >= 25_000 && IDLE_LONG_DURATION_MS >= 25_000,
                'synthetic steady-state windows must remain at least 25 seconds');
            for (const [label, scenario] of [['manager', currentManagerLong], ['idle', currentIdleLong]]) {
                assert.equal(scenario.external.directoryCycles, 0, `current ${label} fallback actively read the catalog`);
                assert.equal(scenario.external.directoryKeyGets, 0, `current ${label} fallback read a directory key`);
                assert.equal(scenario.external.seedCycles, 0, `current ${label} fallback actively read seed data`);
                assert.equal(scenario.external.seedKeyGets, 0, `current ${label} fallback read a seed key`);
                assert.equal(scenario.external.dbGets, 0, `current ${label} fallback performed an IndexedDB read`);
                assert.equal(scenario.external.fullDocumentScans, 0, `current ${label} fallback performed a full scan`);
                assert.equal(scenario.external.rowTextSerializations, 0, `current ${label} fallback serialized a chat row`);
                assert.deepEqual(scenario.workshop, { dbReads: 0, intervalCreates: 0, networkRequests: 0, observerCreates: 0 },
                    `empty workshop loader did background work during current ${label}`);
                for (const counter of ['dbGets', 'directoryDbGets', 'directoryKeyDbGets', 'seedDbGets',
                    'seedKeyDbGets', 'chatDbGets', 'catalogReads', 'seedSnapshotReads', 'scanRuns',
                    'fullDocumentScans', 'dirtyRowScans', 'rowWorkChecks', 'rowTextSerializations',
                    'attributionRecomputations', 'attributionAttempts', 'attributionFailureToasts']) {
                    assert.equal(scenario.module[counter], 0, `current ${label} module counter ${counter} was not idle`);
                }
            }
        const currentIdle = report.scenarios.current.idle;
        assert.ok(currentIdle.external.directoryCycles <= 1, `current idle directory cycles exceeded one: ${JSON.stringify(currentIdle)}`);
        assert.ok(currentIdle.external.seedCycles <= 4, `current idle startup seed cycles exceeded four: ${JSON.stringify(currentIdle)}`);
        assert.equal(currentIdle.external.seedKeyGets, currentIdle.external.seedCycles * 4,
            `current idle seed reads were not complete four-key snapshots: ${JSON.stringify(currentIdle)}`);
        assert.equal(currentIdle.module.seedSnapshotReads, currentIdle.external.seedCycles,
            `current idle seed snapshot counter diverged from observed reads: ${JSON.stringify(currentIdle)}`);
        assert.ok(currentIdle.external.fullDocumentScans <= 1, `current idle full scans exceeded one: ${JSON.stringify(currentIdle)}`);
        assert.equal(currentIdle.external.rowTextSerializations, 0, 'current idle serialized a settled row');
        const currentStream = report.scenarios.current.stream;
        assert.equal(currentStream.external.fullDocumentScans, 0, 'current stream performed a full-document scan');
        assert.equal(Object.keys(currentStream.external.rowTextByRow).filter((id) => id !== '0').length, 0,
            'current stream serialized a non-dirty row');
        assert.ok((currentStream.external.rowTextByRow['0'] || 0) > 0, 'current stream did not scan the dirty row');
        assert.ok(currentStream.module.dirtyRowScans > 0 && currentStream.module.dirtyRowScans <= 180,
            `current stream scan count is unbounded: ${JSON.stringify(currentStream.module)}`);
        const currentManager = report.scenarios.current.manager;
        assert.equal(currentManager.external.directoryCycles, 0, 'current card churn reread the directory');
        assert.equal(currentManager.external.fullDocumentScans, 0, 'current card churn triggered a document scan');
        assert.equal(currentManager.external.rowTextSerializations, 0, 'current card churn serialized chat rows');
        const currentFailure = report.scenarios.current.failure;
        assert.equal(currentFailure.external.chatDbGets, 0, 'current repeated failure reread a chat');
        assert.equal(currentFailure.module.attributionRecomputations, 0, 'current repeated failure recomputed attribution');
        assert.equal(currentFailure.module.attributionFailureToasts, 0, 'current repeated failure emitted a second toast');
        assert.ok(report.scenarios.baseline.idle.external.directoryCycles > currentIdle.external.directoryCycles, 'baseline idle did not show catalog polling');
        assert.ok(report.scenarios.baseline.stream.external.fullDocumentScans > currentStream.external.fullDocumentScans, 'baseline stream did not show full scans');
        assert.ok(report.scenarios.baseline.manager.external.fullDocumentScans > currentManager.external.fullDocumentScans, 'baseline card churn did not show attribute storm scans');
        assert.ok(report.scenarios.baseline.failure.external.chatDbGets > currentFailure.external.chatDbGets, 'baseline failure did not repeat chat reads');
            report.ok = true;
        }
    } catch (error) {
        failure = error;
        report.ok = false;
        report.error = { name: error.name || 'Error', message: error.message || String(error), stack: error.stack || '' };
    } finally {
        await browser?.close().catch(() => {});
        await stopProcessTree(wrangler.child).catch(() => {});
        await fs.mkdir(options.evidenceDir, { recursive: true });
        const evidenceName = options.catalogBaselineOnly
            ? 'image-key-catalog-164132-baseline.json'
            : 'image-perf-ui-e2e.json';
        await fs.writeFile(path.join(options.evidenceDir, evidenceName), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
    console.log(JSON.stringify(report, null, 2));
    if (failure) throw failure;
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
