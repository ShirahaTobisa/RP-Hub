import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const LIST_KEY = 'rp_hub_workshop_modules_v1';
const DEFAULT_EVIDENCE_DIR = path.resolve(root, '..', 'release', 'workshop-module-loader-evidence');

function parseOptions(argv) {
    const options = { evidenceDir: DEFAULT_EVIDENCE_DIR };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--evidence-dir') options.evidenceDir = path.resolve(argv[++index]);
        else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    return options;
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

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close((error) => error ? reject(error) : resolve(address.port));
        });
    });
}

async function waitForServer(baseUrl, child, output) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited early.\n${output.join('').slice(-6000)}`);
        try {
            const response = await fetch(baseUrl);
            if (response.ok) return;
        } catch (_) {
            // Wrangler is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Wrangler did not start in time.\n${output.join('').slice(-6000)}`);
}

async function stopProcessTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 4_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

function instrumentationAndSeed({ listKey, installations }) {
    if (Array.isArray(installations)) localStorage.setItem(listKey, JSON.stringify(installations));
    const metrics = globalThis.__workshopTestMetrics = {
        dbReads: 0,
        keyScans: 0,
        intervalCreates: 0,
        observerCreates: 0,
        thirdPartyScriptRequests: 0,
        toastMessages: []
    };
    const fromLoader = () => String(new Error().stack || '').includes('/DB/module-loader.js');

    const NativeObserver = globalThis.MutationObserver;
    function InstrumentedObserver(callback) {
        if (fromLoader()) metrics.observerCreates += 1;
        return new NativeObserver(callback);
    }
    InstrumentedObserver.prototype = NativeObserver.prototype;
    Object.setPrototypeOf(InstrumentedObserver, NativeObserver);
    globalThis.MutationObserver = InstrumentedObserver;

    const nativeSetInterval = globalThis.setInterval;
    globalThis.setInterval = function (...args) {
        if (fromLoader()) metrics.intervalCreates += 1;
        return Reflect.apply(nativeSetInterval, this, args);
    };

    const nativeOpen = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
        if (fromLoader() && args[0] === 'RPHubDB') metrics.dbReads += 1;
        return Reflect.apply(nativeOpen, this, args);
    };
    for (const method of ['get', 'openKeyCursor']) {
        const native = IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method] = function (...args) {
            if (fromLoader() && this.transaction.db.name === 'RPHubDB') {
                metrics.dbReads += 1;
                if (method === 'openKeyCursor') metrics.keyScans += 1;
            }
            return Reflect.apply(native, this, args);
        };
    }

    const nativeAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function (node) {
        if (fromLoader() && node instanceof HTMLScriptElement
            && node.hasAttribute('data-rph-workshop-module-script')) {
            metrics.thirdPartyScriptRequests += 1;
        }
        if (fromLoader() && node instanceof HTMLElement && node.hasAttribute('data-rph-workshop-toast')) {
            metrics.toastMessages.push(node.textContent || '');
        }
        return Reflect.apply(nativeAppendChild, this, [node]);
    };
}

function readInstallations(page) {
    return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]'), LIST_KEY);
}

async function waitForAppAndManager(page) {
    await page.waitForSelector('#app .app-sidebar', { timeout: 30_000 });
    await page.waitForSelector('[data-rph-workshop-manager-entry]', { timeout: 15_000 });
}

async function openManager(page) {
    await page.locator('[data-rph-workshop-manager-entry]').first().evaluate((element) => element.click());
    await page.waitForSelector('[data-rph-workshop-panel] [data-rph-workshop-module-list]');
}

async function closePanel(page) {
    const close = page.locator('[data-rph-workshop-panel-close]');
    if (await close.count()) await close.click();
}

function moduleSource(id, name, requiresApi, initBody = '') {
    return `(() => {
        'use strict';
        globalThis.RPHubSDK.register({
            id: ${JSON.stringify(id)},
            name: ${JSON.stringify(name)},
            version: '1.0.0',
            requiresApi: ${requiresApi},
            init(ctx) { ${initBody} }
        });
    })();`;
}

const probeSource = `(() => {
    'use strict';
    const flags = globalThis.__rphProbeFlags = {
        registered: false,
        initDone: false,
        readySeen: 0,
        visibilitySeen: 0,
        chatMutations: 0,
        dirtyRowsAreElements: false,
        flushSeen: 0,
        storageLimitThrew: false,
        dbGetOk: false,
        dbKeysOk: false,
        ctxKeys: [],
        versionOk: false,
        updateInfoExact: false
    };
    flags.registered = globalThis.RPHubSDK.register({
        id: 'sdk-probe',
        name: 'SDK Probe',
        version: '1.0.0',
        requiresApi: 1,
        async init(ctx) {
            flags.ctxKeys = Object.keys(ctx).sort();
            flags.versionOk = ctx.version.api === 2 && ctx.version.loader === 'r2-workshop-2';
            flags.updateInfoExact = ctx.upstream.updateInfo === (globalThis.RPH_R2_UPDATE_INFO ?? null);
            ctx.events.on('ready', () => { flags.readySeen += 1; });
            ctx.events.on('visibility', () => { flags.visibilitySeen += 1; });
            ctx.events.on('chat-mutation', ({ dirtyRows }) => {
                flags.chatMutations += 1;
                flags.dirtyRowsAreElements = dirtyRows.length > 0 && dirtyRows.every((row) => row instanceof Element);
            });
            ctx.events.on('persistence-flush', () => { flags.flushSeen += 1; });
            try { ctx.storage.set('oversized', 'x'.repeat(64 * 1024 + 1)); }
            catch (_) { flags.storageLimitThrew = true; }
            const settings = await ctx.appDb.get('rp_hub_settings');
            flags.dbGetOk = settings === undefined || (settings && typeof settings === 'object');
            const keys = await ctx.appDb.keys('rp_hub_');
            flags.dbKeysOk = Array.isArray(keys) && keys.length > 0 && keys.every((key) => typeof key === 'string' && key.startsWith('rp_hub_'));
            flags.initDone = true;
        }
    }) === true;
})();`;

async function main() {
    const options = parseOptions(process.argv.slice(2));
    await fs.mkdir(options.evidenceDir, { recursive: true });
    const helloBytes = await fs.readFile(path.join(root, 'examples', 'hello-module.js'));
    const brokenBytes = await fs.readFile(path.join(root, 'examples', 'broken-module.js'));
    const templateBytes = await fs.readFile(path.join(root, 'examples', 'template-module.js'));
    const fixtureRequests = Object.create(null);
    const fixtureSources = new Map([
        ['/hello-module.js', helloBytes],
        ['/broken-module.js', brokenBytes],
        ['/template-module.js', templateBytes],
        ['/bad-id.js', Buffer.from(moduleSource('Bad Id', 'Bad Id', 1))],
        ['/missing-field.js', Buffer.from("globalThis.RPHubSDK.register({ id: 'missing-demo', name: 'Missing Demo', requiresApi: 1 });")],
        ['/api-mismatch.js', Buffer.from(moduleSource('future-demo', 'Future Demo', 99))],
        ['/probe-module.js', Buffer.from(probeSource)]
    ]);
    let loaderAssetUrl = '';
    const fixtureServer = http.createServer((request, response) => {
        response.setHeader('access-control-allow-origin', '*');
        const pathname = new URL(request.url, 'http://fixture.test').pathname;
        fixtureRequests[pathname] = (fixtureRequests[pathname] || 0) + 1;
        if (pathname === '/flush-order.html') {
            response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            response.end(`<!doctype html><html><head><meta charset="utf-8"><title>flush coexistence</title>
<script>
window.RPH_R2_UPDATE_INFO = null;
window.__baseFlushCalls = 0;
const baseFlush = async () => { window.__baseFlushCalls += 1; return 'base-result'; };
Object.defineProperty(baseFlush, '__rphImageFlushWrapper', { value: true });
Object.defineProperty(baseFlush, '__rphImageProbe', { value: 'preserve', writable: true, enumerable: true, configurable: true });
window.__baseFlush = baseFlush;
window.__baseDescriptors = Object.fromEntries(['__rphImageFlushWrapper', '__rphImageProbe'].map((name) => [name, Object.getOwnPropertyDescriptor(baseFlush, name)]));
window.RPH_R2_FLUSH_PERSISTENCE = baseFlush;
</script>
<script src="${new URL('/DB/nav-adapter.js', loaderAssetUrl).href}"></script>
<script src="${loaderAssetUrl}"></script></head><body>
<main id="app"><aside class="app-sidebar"><button type="button"><svg viewBox="0 0 24 24"><path></path></svg><span>设置</span></button></aside></main>
</body></html>`);
            return;
        }
        const source = fixtureSources.get(pathname);
        if (!source) {
            response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            response.end('not found');
            return;
        }
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        response.end(source);
    });
    const fixturePort = await getFreePort();
    await new Promise((resolve) => fixtureServer.listen(fixturePort, '127.0.0.1', resolve));
    const fixtureOrigin = `http://127.0.0.1:${fixturePort}`;
    const urls = {
        hello: `${fixtureOrigin}/hello-module.js`,
        broken: `${fixtureOrigin}/broken-module.js`,
        template: `${fixtureOrigin}/template-module.js`,
        missing: `${fixtureOrigin}/missing-module.js`,
        badId: `${fixtureOrigin}/bad-id.js`,
        missingField: `${fixtureOrigin}/missing-field.js`,
        mismatch: `${fixtureOrigin}/api-mismatch.js`,
        probe: `${fixtureOrigin}/probe-module.js`
    };

    const harness = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-workshop-e2e-'));
    const persist = path.join(harness, 'persist');
    await fs.copyFile(path.join(root, 'wrangler.toml'), path.join(harness, 'wrangler.toml'));
    const port = await getFreePort();
    const output = [];
    const wranglerScript = process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
        : '';
    const command = wranglerScript && existsSync(wranglerScript) ? process.execPath : 'wrangler';
    const args = [
        'pages', 'dev', root,
        '--port', String(port),
        '--persist-to', persist,
        '--compatibility-date', '2026-06-06',
        '--log-level', 'error',
        '--show-interactive-dev-session=false'
    ];
    if (command === process.execPath) args.unshift(wranglerScript);
    const child = spawn(command, args, {
        cwd: harness,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' }
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    const baseUrl = `http://127.0.0.1:${port}`;
    loaderAssetUrl = `${baseUrl}/DB/module-loader.js?v=r2-workshop-1`;
    const report = {
        ok: false,
        baseUrl,
        fixtureOrigin,
        emptyAndLifecycle: null,
        flushCoexistence: null,
        failureIsolation: null,
        templateE2E: null,
        safeMode: null,
        fixtureRequests,
        evidence: {
            installPanel: path.join(options.evidenceDir, 'workshop-install-panel.png'),
            failurePanel: path.join(options.evidenceDir, 'workshop-failure-panel.png'),
            safeModePanel: path.join(options.evidenceDir, 'workshop-safe-mode-panel.png'),
            report: path.join(options.evidenceDir, 'workshop-module-loader-e2e.json')
        }
    };
    let browser = null;
    let failure = null;
    try {
        await waitForServer(baseUrl, child, output);
        const html = await (await fetch(`${baseUrl}/`)).text();
        assert.equal((html.match(/\/DB\/module-loader\.js\?v=r2-workshop-1/g) || []).length, 1);
        browser = await chromium.launch({
            executablePath: findChrome(),
            headless: true,
            args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server']
        });

        const lifecycleContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await lifecycleContext.addInitScript(instrumentationAndSeed, { listKey: LIST_KEY, installations: null });
        const page = await lifecycleContext.newPage();
        const lifecyclePageErrors = [];
        page.on('pageerror', (error) => lifecyclePageErrors.push(String(error)));
        await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
        await waitForAppAndManager(page);
        await page.waitForTimeout(1_500);
        const empty = await page.evaluate(() => ({
            sdkKeys: Object.keys(globalThis.RPHubSDK).sort(),
            sdkFrozen: Object.isFrozen(globalThis.RPHubSDK),
            apiVersion: globalThis.RPHubSDK.apiVersion,
            metrics: structuredClone(globalThis.__workshopTestMetrics),
            workshopFlushHooked: globalThis.__rphWorkshopFlushHooked === true
        }));
        assert.deepEqual(empty.sdkKeys, ['apiVersion', 'flush', 'register']);
        assert.equal(empty.sdkFrozen, true);
        assert.equal(empty.apiVersion, 2);
        assert.deepEqual({
            dbReads: empty.metrics.dbReads,
            intervalCreates: empty.metrics.intervalCreates,
            observerCreates: empty.metrics.observerCreates,
            thirdPartyScriptRequests: empty.metrics.thirdPartyScriptRequests
        }, { dbReads: 0, intervalCreates: 0, observerCreates: 0, thirdPartyScriptRequests: 0 });
        assert.equal(empty.workshopFlushHooked, false);
        assert.equal(Object.values(fixtureRequests).reduce((sum, value) => sum + value, 0), 0);

        await openManager(page);
        const input = page.locator('[data-rph-workshop-url-input]');
        await input.fill('http://example.com/insecure.js');
        await page.locator('[data-rph-workshop-install]').click();
        await page.waitForFunction(() => globalThis.__workshopTestMetrics.toastMessages.includes('模块 URL 必须使用 HTTPS'));
        assert.deepEqual(await readInstallations(page), []);
        await input.evaluate((element) => { element.value = `https://example.com/${'x'.repeat(490)}.js`; });
        await page.locator('[data-rph-workshop-install]').click();
        await page.waitForFunction(() => globalThis.__workshopTestMetrics.toastMessages.includes('模块 URL 不能超过 500 个字符'));
        assert.deepEqual(await readInstallations(page), []);

        await input.fill(urls.hello);
        let riskWarning = '';
        page.once('dialog', async (dialog) => {
            riskWarning = dialog.message();
            await dialog.accept();
        });
        await page.locator('[data-rph-workshop-install]').click();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) || '[]').length === 1, LIST_KEY);
        assert.match(riskWarning, /第三方代码拥有页面全部权限/);
        assert.match(riskWarning, /云同步密码与生图密钥/);
        const installed = await readInstallations(page);
        assert.deepEqual(Object.keys(installed[0]).sort(), ['addedAt', 'enabled', 'id', 'lastStatus', 'name', 'url', 'version']);
        assert.deepEqual({ id: installed[0].id, url: installed[0].url, enabled: installed[0].enabled, lastStatus: installed[0].lastStatus }, {
            id: '', url: urls.hello, enabled: true, lastStatus: ''
        });
        assert.equal(fixtureRequests['/hello-module.js'] || 0, 1, 'install must save the module source');
        assert.equal(await page.evaluate(() => !!globalThis.__rphHelloFlags), false, 'install must not execute until refresh');
        await page.screenshot({ path: report.evidence.installPanel });
        await input.fill(urls.hello);
        await page.locator('[data-rph-workshop-install]').click();
        await page.waitForFunction(() => globalThis.__workshopTestMetrics.toastMessages.includes('该模块 URL 已安装'));
        assert.equal((await readInstallations(page)).length, 1);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppAndManager(page);
        await page.waitForFunction(() => {
            const flags = globalThis.__rphHelloFlags;
            return Boolean(flags?.registered && flags.initDone && flags.storageOk);
        }, null, { timeout: 20_000 });
        await page.waitForSelector('[data-rph-workshop-module-id="hello-demo"]');
        const helloInstalled = await readInstallations(page);
        assert.equal(helloInstalled[0].id, 'hello-demo');
        assert.equal(helloInstalled[0].lastStatus, 'ok');
        const enabledMetrics = await page.evaluate(() => structuredClone(globalThis.__workshopTestMetrics));
        assert.deepEqual({
            dbReads: enabledMetrics.dbReads,
            intervalCreates: enabledMetrics.intervalCreates,
            observerCreates: enabledMetrics.observerCreates,
            thirdPartyScriptRequests: enabledMetrics.thirdPartyScriptRequests
        }, { dbReads: 0, intervalCreates: 0, observerCreates: 1, thirdPartyScriptRequests: 1 });
        await page.locator('[data-rph-workshop-module-id="hello-demo"]').evaluate((element) => element.click());
        await page.waitForSelector('[data-rph-workshop-panel]');
        assert.equal(await page.locator('[data-rph-workshop-panel-body]').textContent(), 'Hello from the workshop module.');
        assert.equal(await page.evaluate(() => globalThis.__rphHelloFlags.sidebarClicks), 1);
        await closePanel(page);
        await page.waitForFunction(() => globalThis.__rphWorkshopFlushHooked === true
            && globalThis.RPH_R2_FLUSH_PERSISTENCE?.__rphImageFlushWrapper === true);
        await page.evaluate(() => { globalThis.__workshopFlushReference = globalThis.RPH_R2_FLUSH_PERSISTENCE; });
        await page.waitForTimeout(2_000);
        const helloFlush = await page.evaluate(async () => {
            const stable = globalThis.RPH_R2_FLUSH_PERSISTENCE === globalThis.__workshopFlushReference;
            const result = await globalThis.RPH_R2_FLUSH_PERSISTENCE();
            return {
                stable,
                result,
                flushSeen: globalThis.__rphHelloFlags.flushSeen,
                imageWrapped: globalThis.RPHubImageModule.getState().persistenceFlushWrapped
            };
        });
        assert.equal(helloFlush.stable, true);
        assert.ok(helloFlush.flushSeen >= 1);
        assert.equal(helloFlush.imageWrapped, true);

        await openManager(page);
        const helloToggle = page.locator(`[data-rph-workshop-enabled="${urls.hello}"]`);
        await helloToggle.uncheck();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key))[0].enabled === false, LIST_KEY);
        const requestsBeforeDisabledRefresh = fixtureRequests['/hello-module.js'] || 0;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppAndManager(page);
        await page.waitForTimeout(1_500);
        const disabled = await page.evaluate(() => ({
            helloLoaded: Boolean(globalThis.__rphHelloFlags),
            metrics: structuredClone(globalThis.__workshopTestMetrics),
            workshopFlushHooked: globalThis.__rphWorkshopFlushHooked === true,
            imageFlushHooked: globalThis.RPH_R2_FLUSH_PERSISTENCE?.__rphImageFlushWrapper === true,
            helloStorage: localStorage.getItem('rph_mod_hello-demo::greet')
        }));
        assert.equal(disabled.helloLoaded, false);
        assert.deepEqual({
            dbReads: disabled.metrics.dbReads,
            intervalCreates: disabled.metrics.intervalCreates,
            observerCreates: disabled.metrics.observerCreates,
            thirdPartyScriptRequests: disabled.metrics.thirdPartyScriptRequests
        }, { dbReads: 0, intervalCreates: 0, observerCreates: 0, thirdPartyScriptRequests: 0 });
        assert.equal(disabled.workshopFlushHooked, false);
        assert.equal(disabled.imageFlushHooked, true);
        assert.equal(fixtureRequests['/hello-module.js'] || 0, requestsBeforeDisabledRefresh);
        assert.equal(await page.locator('[data-rph-workshop-module-id="hello-demo"]').count(), 0);
        assert.equal(disabled.helloStorage, 'hi');
        await openManager(page);
        await page.locator(`[data-rph-workshop-uninstall="${urls.hello}"]`).click();
        const uninstalled = await page.evaluate((key) => ({
            list: JSON.parse(localStorage.getItem(key) || '[]'),
            storage: localStorage.getItem('rph_mod_hello-demo::greet')
        }), LIST_KEY);
        assert.deepEqual(uninstalled, { list: [], storage: null });
        assert.deepEqual(lifecyclePageErrors, []);
        report.emptyAndLifecycle = { empty, installed, helloInstalled, enabledMetrics, helloFlush, disabled, uninstalled };
        await lifecycleContext.close();

        const templateContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await templateContext.addInitScript(instrumentationAndSeed, {
            listKey: LIST_KEY,
            installations: [{ id: '', url: urls.template, enabled: true, addedAt: 1, lastStatus: '' }]
        });
        const templatePage = await templateContext.newPage();
        const templatePageErrors = [];
        templatePage.on('pageerror', (error) => templatePageErrors.push(String(error)));
        await templatePage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
        await waitForAppAndManager(templatePage);
        await templatePage.waitForSelector('[data-rph-workshop-module-id="template-mod"]', { timeout: 20_000 });
        await templatePage.waitForTimeout(1_500);
        const templateIdle = await templatePage.evaluate(() => ({
            metrics: structuredClone(globalThis.__workshopTestMetrics),
            count: localStorage.getItem('rph_mod_template-mod::template-count')
        }));
        assert.equal(templateIdle.metrics.dbReads, 0, 'template module read the app DB before its panel opened');
        assert.equal(templateIdle.metrics.keyScans, 0, 'template module scanned keys before its panel opened');
        assert.equal(templateIdle.count, '1');
        await templatePage.locator('[data-rph-workshop-module-id="template-mod"]').evaluate((element) => element.click());
        await templatePage.waitForSelector('[data-rph-workshop-panel]');
        assert.match(await templatePage.locator('[data-rph-workshop-panel-body]').textContent(), /这是模板面板/);
        await templatePage.getByRole('button', { name: '发个 toast' }).click();
        await templatePage.waitForSelector('[data-rph-workshop-toast]', { timeout: 5_000 });
        await templatePage.getByRole('button', { name: '读一次库' }).click();
        await templatePage.waitForFunction(() => globalThis.__workshopTestMetrics.keyScans === 1, null, { timeout: 10_000 });
        const templateAfterRead = await templatePage.evaluate(() => structuredClone(globalThis.__workshopTestMetrics));
        assert.equal(templateAfterRead.keyScans, 1);
        await closePanel(templatePage);
        await openManager(templatePage);
        await templatePage.locator(`[data-rph-workshop-uninstall="${urls.template}"]`).click();
        const templateUninstalled = await templatePage.evaluate(() => ({
            list: JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]'),
            storage: localStorage.getItem('rph_mod_template-mod::template-count')
        }));
        assert.deepEqual(templateUninstalled, { list: [], storage: null });
        assert.deepEqual(templatePageErrors, []);
        report.templateE2E = { templateIdle, templateAfterRead, templateUninstalled, pageErrors: templatePageErrors };
        await templateContext.close();

        const coexistenceContext = await browser.newContext({ viewport: { width: 900, height: 700 } });
        await coexistenceContext.addInitScript(instrumentationAndSeed, {
            listKey: LIST_KEY,
            installations: [{ id: '', url: urls.hello, enabled: true, addedAt: 1, lastStatus: '' }]
        });
        const coexistencePage = await coexistenceContext.newPage();
        const coexistencePageErrors = [];
        coexistencePage.on('pageerror', (error) => coexistencePageErrors.push(String(error)));
        await coexistencePage.goto(`${fixtureOrigin}/flush-order.html`, { waitUntil: 'domcontentloaded' });
        await coexistencePage.waitForFunction(() => globalThis.__rphWorkshopFlushHooked === true
            && globalThis.__rphHelloFlags?.initDone === true, null, { timeout: 15_000 });
        const descriptors = await coexistencePage.evaluate(() => Object.fromEntries(
            ['__rphImageFlushWrapper', '__rphImageProbe'].map((name) => [
                name,
                Object.getOwnPropertyDescriptor(globalThis.RPH_R2_FLUSH_PERSISTENCE, name)
            ])
        ));
        const baseDescriptors = await coexistencePage.evaluate(() => structuredClone(globalThis.__baseDescriptors));
        assert.deepEqual(descriptors, baseDescriptors, 'loader did not preserve all image __rph property descriptors');
        await coexistencePage.evaluate(() => { globalThis.__imageFirstFlushReference = globalThis.RPH_R2_FLUSH_PERSISTENCE; });
        await coexistencePage.waitForTimeout(2_000);
        const imageFirst = await coexistencePage.evaluate(async () => ({
            stable: globalThis.RPH_R2_FLUSH_PERSISTENCE === globalThis.__imageFirstFlushReference,
            result: await globalThis.RPH_R2_FLUSH_PERSISTENCE(),
            baseCalls: globalThis.__baseFlushCalls,
            helloFlushSeen: globalThis.__rphHelloFlags.flushSeen,
            imageMarker: globalThis.RPH_R2_FLUSH_PERSISTENCE.__rphImageFlushWrapper === true,
            workshopMarker: globalThis.RPH_R2_FLUSH_PERSISTENCE.__rphWorkshopFlushWrapper === true
        }));
        assert.deepEqual(imageFirst, {
            stable: true,
            result: 'base-result',
            baseCalls: 1,
            helloFlushSeen: 1,
            imageMarker: true,
            workshopMarker: true
        });
        assert.deepEqual(coexistencePageErrors, []);
        report.flushCoexistence = { order: 'image-first', descriptors, imageFirst, pageErrors: coexistencePageErrors };
        await coexistenceContext.close();

        const failureUrls = [urls.hello, urls.broken, urls.missing, urls.badId, urls.missingField, urls.mismatch, urls.probe];
        const failureEntries = failureUrls.map((url, index) => ({
            id: '', url, enabled: true, addedAt: index + 1, lastStatus: ''
        }));
        const failureContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await failureContext.addInitScript(instrumentationAndSeed, { listKey: LIST_KEY, installations: failureEntries });
        const failurePage = await failureContext.newPage();
        const failurePageErrors = [];
        failurePage.on('pageerror', (error) => failurePageErrors.push(String(error)));
        await failurePage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
        await waitForAppAndManager(failurePage);
        await failurePage.waitForFunction((key) => {
            const entries = JSON.parse(localStorage.getItem(key) || '[]');
            const statuses = Object.fromEntries(entries.map((entry) => [new URL(entry.url).pathname, entry.lastStatus]));
            return statuses['/hello-module.js'] === 'ok'
                && statuses['/broken-module.js'] === 'init-error'
                && statuses['/missing-module.js'] === 'load-error'
                && statuses['/bad-id.js'] === 'load-error'
                && statuses['/missing-field.js'] === 'load-error'
                && statuses['/api-mismatch.js'] === 'api-mismatch'
                && statuses['/probe-module.js'] === 'ok';
        }, LIST_KEY, { timeout: 25_000 });
        await failurePage.waitForFunction(() => globalThis.__rphProbeFlags?.initDone === true, null, { timeout: 20_000 });
        const probe = await failurePage.evaluate(() => structuredClone(globalThis.__rphProbeFlags));
        assert.equal(probe.registered, true);
        assert.equal(probe.storageLimitThrew, true);
        assert.equal(probe.dbGetOk, true);
        assert.equal(probe.dbKeysOk, true);
        assert.equal(probe.versionOk, true);
        assert.equal(probe.updateInfoExact, true);
        assert.deepEqual(probe.ctxKeys, ['appDb', 'data', 'events', 'log', 'persistence', 'storage', 'ui', 'upstream', 'version']);
        await failurePage.evaluate(() => {
            const row = document.createElement('article');
            row.setAttribute('data-chat-index', 'workshop-probe');
            row.textContent = 'mutation probe';
            document.querySelector('#app').appendChild(row);
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await failurePage.waitForFunction(() => globalThis.__rphProbeFlags.chatMutations > 0
            && globalThis.__rphProbeFlags.visibilitySeen > 0
            && globalThis.__rphProbeFlags.readySeen > 0, null, { timeout: 5_000 });
        await failurePage.waitForFunction(() => globalThis.__rphWorkshopFlushHooked === true
            && globalThis.RPH_R2_FLUSH_PERSISTENCE?.__rphImageFlushWrapper === true);
        await failurePage.evaluate(() => { globalThis.__workshopFailureFlushReference = globalThis.RPH_R2_FLUSH_PERSISTENCE; });
        await failurePage.waitForTimeout(2_000);
        const failureFlush = await failurePage.evaluate(async () => {
            const stable = globalThis.RPH_R2_FLUSH_PERSISTENCE === globalThis.__workshopFailureFlushReference;
            await globalThis.RPH_R2_FLUSH_PERSISTENCE();
            return {
                stable,
                helloFlushSeen: globalThis.__rphHelloFlags.flushSeen,
                probeFlushSeen: globalThis.__rphProbeFlags.flushSeen,
                imageWrapped: globalThis.RPHubImageModule.getState().persistenceFlushWrapped
            };
        });
        assert.equal(failureFlush.stable, true);
        assert.ok(failureFlush.helloFlushSeen >= 1);
        assert.ok(failureFlush.probeFlushSeen >= 1);
        assert.equal(failureFlush.imageWrapped, true);
        const failureChecks = await failurePage.evaluate((key) => ({
            appBooted: Boolean(document.querySelector('#app .app-sidebar')),
            helloWorks: Boolean(globalThis.__rphHelloFlags?.initDone && globalThis.__rphHelloFlags.storageOk),
            probe: structuredClone(globalThis.__rphProbeFlags),
            entries: JSON.parse(localStorage.getItem(key) || '[]'),
            sdkKeys: Object.keys(globalThis.RPHubSDK).sort(),
            sdkFrozen: Object.isFrozen(globalThis.RPHubSDK),
            metrics: structuredClone(globalThis.__workshopTestMetrics)
        }), LIST_KEY);
        assert.equal(failureChecks.appBooted, true);
        assert.equal(failureChecks.helloWorks, true);
        assert.equal(failureChecks.probe.dirtyRowsAreElements, true);
        assert.deepEqual(failureChecks.sdkKeys, ['apiVersion', 'flush', 'register']);
        assert.equal(failureChecks.sdkFrozen, true);
        assert.equal(failureChecks.metrics.observerCreates, 1);
        assert.equal(failureChecks.metrics.intervalCreates, 0);
        assert.equal(failureChecks.metrics.thirdPartyScriptRequests, failureEntries.length - 1, 'missing source must not be executed');
        assert.equal(failureChecks.metrics.toastMessages.filter((message) => message.includes('需要 API 99')).length, 1);
        assert.equal(await failurePage.locator('[data-rph-workshop-module-id="hello-demo"]').count(), 1);
        assert.deepEqual(failurePageErrors, []);
        await openManager(failurePage);
        const panelStatuses = await failurePage.evaluate(() => Object.fromEntries(
            [...document.querySelectorAll('[data-rph-workshop-module-row]')].map((row) => [
                new URL(row.dataset.rphWorkshopModuleRow).pathname,
                row.querySelector('[data-rph-workshop-status]')?.textContent || ''
            ])
        ));
        assert.deepEqual(panelStatuses, {
            '/hello-module.js': '正常',
            '/broken-module.js': '初始化失败',
            '/missing-module.js': '加载失败',
            '/bad-id.js': '加载失败',
            '/missing-field.js': '加载失败',
            '/api-mismatch.js': 'API 不符',
            '/probe-module.js': '正常'
        });
        await failurePage.screenshot({ path: report.evidence.failurePanel });
        report.failureIsolation = { failureChecks, failureFlush, panelStatuses, pageErrors: failurePageErrors };
        await failurePage.close();

        const fixtureRequestsBeforeSafeMode = structuredClone(fixtureRequests);
        const safePage = await failureContext.newPage();
        const safePageErrors = [];
        safePage.on('pageerror', (error) => safePageErrors.push(String(error)));
        await safePage.goto(`${baseUrl}/?rph_safe_mode=1`, { waitUntil: 'domcontentloaded' });
        await waitForAppAndManager(safePage);
        await safePage.waitForFunction(() => globalThis.__workshopTestMetrics.toastMessages.includes('安全模式:已跳过 7 个模块'));
        await safePage.waitForTimeout(1_500);
        const safeChecks = await safePage.evaluate(() => ({
            sdkPresent: Boolean(globalThis.RPHubSDK),
            helloLoaded: Boolean(globalThis.__rphHelloFlags),
            probeLoaded: Boolean(globalThis.__rphProbeFlags),
            metrics: structuredClone(globalThis.__workshopTestMetrics),
            workshopFlushHooked: globalThis.__rphWorkshopFlushHooked === true
        }));
        assert.equal(safeChecks.sdkPresent, true);
        assert.equal(safeChecks.helloLoaded, false);
        assert.equal(safeChecks.probeLoaded, false);
        assert.deepEqual({
            dbReads: safeChecks.metrics.dbReads,
            intervalCreates: safeChecks.metrics.intervalCreates,
            observerCreates: safeChecks.metrics.observerCreates,
            thirdPartyScriptRequests: safeChecks.metrics.thirdPartyScriptRequests
        }, { dbReads: 0, intervalCreates: 0, observerCreates: 0, thirdPartyScriptRequests: 0 });
        assert.equal(safeChecks.workshopFlushHooked, false);
        assert.deepEqual(structuredClone(fixtureRequests), fixtureRequestsBeforeSafeMode);
        await openManager(safePage);
        await safePage.locator('[data-rph-workshop-disable-all]').click();
        await safePage.waitForFunction((key) => JSON.parse(localStorage.getItem(key) || '[]').every((entry) => entry.enabled === false), LIST_KEY);
        const safeList = await readInstallations(safePage);
        assert.equal(safeList.length, 7);
        assert.ok(safeList.every((entry) => entry.enabled === false));
        await safePage.screenshot({ path: report.evidence.safeModePanel });
        assert.deepEqual(safePageErrors, []);
        report.safeMode = { safeChecks, safeList, pageErrors: safePageErrors };
        await failureContext.close();
        report.ok = true;
    } catch (error) {
        failure = error;
        report.error = { name: error.name || 'Error', message: error.message || String(error), stack: error.stack || '' };
    } finally {
        await browser?.close().catch(() => { });
        await stopProcessTree(child).catch(() => { });
        if (fixtureServer.listening) {
            fixtureServer.close();
            await once(fixtureServer, 'close').catch(() => { });
        }
        await fs.writeFile(report.evidence.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        await fs.rm(harness, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => { });
    }
    console.log(JSON.stringify(report, null, 2));
    if (failure) throw failure;
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
