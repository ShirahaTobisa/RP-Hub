import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { patchRpHubAppJs } from '../DB/app-patches.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PROJECT_DIR = path.resolve(ROOT_DIR, '..');
const UPSTREAM_ROOT = path.join(PROJECT_DIR, 'RP-Hub');
const PACKAGE_SCRIPT = path.join(ROOT_DIR, 'scripts', 'package.mjs');
const UPSTREAM_181_COMMIT = '8911f4bba41cfe3b1a092862697b99faf7716d7d';
const EXPECTED_PATCHED_SHA256 = '948C6560DE09E4CAD27BE091B812E241F56F30E53D0618561057E23E3C9750FE';
const CHARACTER_UUID = '18118118-1181-4181-8181-181181181181';
const CHARACTER_NAME = 'Retag Browser Character';
const USER_UUID = '28128128-1281-4281-8281-281281281281';
const CHROME_PATH = process.env.CHROME_PATH
    || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const DEFAULT_EVIDENCE_DIR = path.join(PROJECT_DIR, 'release', 'rph-181-retag-evidence');

function parseArguments(argv) {
    const options = { evidenceDir: DEFAULT_EVIDENCE_DIR };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--evidence-dir') options.evidenceDir = path.resolve(argv[++index]);
        else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    return options;
}

function loadPlaywright() {
    const require = createRequire(import.meta.url);
    const candidates = ['playwright'];
    for (const root of String(process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) {
        candidates.push(path.join(root, 'playwright'));
    }
    for (const candidate of candidates) {
        try { return require(candidate); } catch (_) { /* try the next runtime */ }
    }
    throw new Error('Playwright is unavailable. Set NODE_PATH to the test runtime dependencies.');
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function upstreamFileNames() {
    return execFileSync('git', [
        '-C', UPSTREAM_ROOT,
        'ls-tree', '-r', '--name-only', UPSTREAM_181_COMMIT
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
        .trim().split(/\r?\n/).filter(Boolean)
        .filter((name) => ![
            'DB', '_worker.js', 'work.js', 'wrangler.toml', 'update-upstream.bat', '.git', '.github'
        ].includes(name.split('/')[0]));
}

function readUpstreamFile(filePath) {
    return Buffer.from(execFileSync('git', [
        '-C', UPSTREAM_ROOT,
        'show', `${UPSTREAM_181_COMMIT}:${filePath}`
    ], { maxBuffer: 8 * 1024 * 1024 }));
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

async function waitForServer(origin, child, output) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited early.\n${output.join('')}`);
        try {
            const response = await fetch(origin);
            if (response.ok) return;
        } catch (_) { /* listener is still starting */ }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Wrangler did not become ready.\n${output.join('')}`);
}

async function stopProcess(child) {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

function seedHtml() {
    const records = [
        ['rp_hub_character_index', { order: [CHARACTER_UUID] }],
        [`rp_hub_character_${CHARACTER_UUID}`, {
            uuid: CHARACTER_UUID,
            name: CHARACTER_NAME,
            description: 'Retagged 1.8.1 browser smoke fixture.',
            first_mes: 'Hello from the retag smoke fixture.',
            personality: 'Stable test fixture.',
            mes_example: '',
            avatar: null,
            createdAt: 1_700_000_000_000,
            worldInfo: [],
            regexScripts: [],
            uiTemplates: [],
            recentGenerationTimes: []
        }],
        [`rp_hub_chat_${CHARACTER_UUID}`, [{
            id: 'retag-smoke-assistant',
            role: 'assistant',
            content: 'RETAG_181_CHAT_VISIBLE',
            isSelf: false,
            timestamp: 1_700_000_000_100
        }]],
        ['rp_hub_settings', {
            apiKey: '',
            imageGenKey: '',
            autoFetchModels: false,
            fontFamily: 'modern',
            fontFamilyVersion: 4,
            stream: true
        }],
        ['rp_hub_user', {
            uuid: USER_UUID,
            name: 'Retag Browser User',
            description: 'Retagged 1.8.1 browser smoke fixture.',
            avatar: null,
            person: 'second'
        }],
        ['rp_hub_user_profiles', [{
            uuid: USER_UUID,
            name: 'Retag Browser User',
            description: 'Retagged 1.8.1 browser smoke fixture.',
            avatar: null,
            person: 'second'
        }]],
        ['rp_hub_active_profile_id', USER_UUID],
        ['rp_hub_last_active_char', 0]
    ];
    return `<!doctype html><html><head><meta charset="utf-8"><title>Retag seed</title></head><body>
<pre id="result" data-status="running">RUNNING</pre>
<script>
(async () => {
    const records = ${JSON.stringify(records)};
    localStorage.clear();
    localStorage.setItem('roleplay_hub_update_id', '999999999');
    await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase('RPHubDB');
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('RPHubDB delete was blocked'));
    });
    await new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('store')) request.result.createObjectStore('store');
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('store', 'readwrite');
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error('seed aborted'));
            const store = transaction.objectStore('store');
            records.forEach(([key, value]) => store.put(value, key));
        };
    });
    const result = document.getElementById('result');
    result.dataset.status = 'pass';
    result.textContent = 'PASS';
})().catch((error) => {
    const result = document.getElementById('result');
    result.dataset.status = 'fail';
    result.textContent = 'FAIL: ' + (error && error.stack || error);
});
</script></body></html>`;
}

async function prepareDist(runtimeRoot) {
    const distRoot = path.join(runtimeRoot, 'dist');
    const releaseRoot = path.join(runtimeRoot, 'release');
    const packaged = spawnSync(process.execPath, [
        PACKAGE_SCRIPT,
        '--dist', distRoot,
        '--release-dir', releaseRoot
    ], { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);

    for (const filePath of upstreamFileNames()) {
        const target = path.join(distRoot, filePath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, readUpstreamFile(filePath));
    }

    const rawApp = (await fs.readFile(path.join(distRoot, 'assets', 'js', 'app.js'), 'utf8'));
    const patched = patchRpHubAppJs(rawApp, { version: '1.8.1' });
    const patchedBytes = Buffer.from(patched.code, 'utf8');
    assert.deepEqual(patched.report.replacements, {
        characterSave: 1,
        characterLoad: 1,
        persistenceBridge: 1
    });
    assert.equal(sha256(patchedBytes), EXPECTED_PATCHED_SHA256);
    assert.match(patched.code, /await window\.RPHubCharStore\.saveAll\(unwrapForStorage\(characters\.value\)\)/);
    assert.doesNotMatch(patched.code, /setStoredValue\(\s*'characters'/);
    await fs.writeFile(path.join(distRoot, 'assets', 'js', 'app.js'), patched.code, 'utf8');

    const fixturePath = path.join(distRoot, 'tests', 'rph-181-retag-seed.html');
    await fs.mkdir(path.dirname(fixturePath), { recursive: true });
    await fs.writeFile(fixturePath, seedHtml(), 'utf8');
    return { distRoot, packageReport: JSON.parse(packaged.stdout), patchReport: patched.report };
}

async function readBrowserRecord(page, key) {
    return page.evaluate(async (recordKey) => {
        const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            return await new Promise((resolve, reject) => {
                const request = database.transaction('store', 'readonly').objectStore('store').get(recordKey);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        } finally {
            database.close();
        }
    }, key);
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    assert(existsSync(CHROME_PATH), `Chrome executable not found: ${CHROME_PATH}`);
    const { chromium } = loadPlaywright();
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-181-retag-browser-'));
    const persistRoot = path.join(runtimeRoot, 'persist');
    const configRoot = path.join(runtimeRoot, 'xdg-config');
    const port = await getFreePort();
    const origin = `http://127.0.0.1:${port}`;
    const output = [];
    let child = null;
    let browser = null;
    const report = {
        ok: false,
        upstreamCommit: UPSTREAM_181_COMMIT,
        patchedAppSha256: EXPECTED_PATCHED_SHA256,
        startedAt: new Date().toISOString()
    };

    try {
        await fs.mkdir(configRoot, { recursive: true });
        const prepared = await prepareDist(runtimeRoot);
        report.assetVersions = prepared.packageReport.assetVersions;
        report.patchReplacements = prepared.patchReport.replacements;

        const wranglerScript = process.platform === 'win32'
            ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
            : '';
        const command = wranglerScript && existsSync(wranglerScript) ? process.execPath : 'wrangler';
        const args = [
            'pages', 'dev', prepared.distRoot,
            '--port', String(port),
            '--persist-to', persistRoot,
            '--compatibility-date', '2026-06-06',
            '--log-level', 'error',
            '--show-interactive-dev-session=false'
        ];
        if (command === process.execPath) args.unshift(wranglerScript);
        child = spawn(command, args, {
            cwd: runtimeRoot,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, XDG_CONFIG_HOME: configRoot, NO_COLOR: '1' }
        });
        child.stdout.on('data', (chunk) => output.push(chunk.toString()));
        child.stderr.on('data', (chunk) => output.push(chunk.toString()));
        await waitForServer(origin, child, output);

        browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.addInitScript(() => {
            let charStore;
            globalThis.__RPH_181_SAVE_ALL_CALLS = 0;
            globalThis.__RPH_181_LAST_SAVE_ALL = null;
            Object.defineProperty(globalThis, 'RPHubCharStore', {
                configurable: true,
                get() { return charStore; },
                set(value) {
                    const originalSaveAll = value.saveAll;
                    charStore = Object.freeze({
                        ...value,
                        async saveAll(cards) {
                            globalThis.__RPH_181_SAVE_ALL_CALLS += 1;
                            globalThis.__RPH_181_LAST_SAVE_ALL = structuredClone(cards);
                            return originalSaveAll(cards);
                        }
                    });
                }
            });
        });
        const page = await context.newPage();
        const pageErrors = [];
        const consoleErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });

        await page.goto(`${origin}/tests/rph-181-retag-seed.html`, { waitUntil: 'load' });
        await page.locator('#result[data-status="pass"]').waitFor({ timeout: 15_000 });
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((name) => (
            Boolean(document.querySelector('#app')?.__vue_app__)
            && typeof globalThis.RPHubCharStore?.saveAll === 'function'
            && typeof globalThis.RPHubImageModule?.getState === 'function'
            && document.body.innerText.includes(name)
        ), CHARACTER_NAME, { timeout: 60_000 });

        const blockingModals = await page.locator('div.fixed.inset-0').evaluateAll((elements) => elements
            .filter((element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
                    && style.display !== 'none' && style.pointerEvents !== 'none';
            })
            .map((element) => ({
                text: element.innerText,
                buttons: [...element.querySelectorAll('button')].map((button) => button.innerText.trim()).filter(Boolean)
            })));
        report.browserNotices = blockingModals;
        const updateNotice = page.locator('div.fixed.inset-0').filter({ hasText: '网站公告' }).first();
        if (await updateNotice.isVisible().catch(() => false)) {
            await updateNotice.getByRole('button', { name: /知道了/ }).click({ timeout: 20_000 });
            await updateNotice.waitFor({ state: 'hidden', timeout: 10_000 });
        }
        await page.locator('button[title="角色卡管理"]').click();
        const favorite = page.locator('button[aria-label="收藏角色"]:visible').first();
        await favorite.waitFor({ timeout: 15_000 });
        const beforeSaveCalls = await page.evaluate(() => globalThis.__RPH_181_SAVE_ALL_CALLS);
        await favorite.click();
        await page.waitForFunction((before) => globalThis.__RPH_181_SAVE_ALL_CALLS > before, beforeSaveCalls, { timeout: 15_000 });
        await page.waitForFunction((uuid) => (
            Array.isArray(globalThis.__RPH_181_LAST_SAVE_ALL)
            && globalThis.__RPH_181_LAST_SAVE_ALL.some((card) => card?.uuid === uuid && Number(card.favoriteAt) > 0)
        ), CHARACTER_UUID, { timeout: 15_000 });

        let storedCharacter;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            storedCharacter = await readBrowserRecord(page, `rp_hub_character_${CHARACTER_UUID}`);
            if (Number(storedCharacter?.favoriteAt) > 0) break;
            await page.waitForTimeout(50);
        }
        assert.ok(Number(storedCharacter?.favoriteAt) > 0, 'favorite action did not persist through RPHubCharStore');
        assert.equal(await readBrowserRecord(page, 'rp_hub_characters'), undefined, 'legacy character blob was recreated');
        const runtime = await page.evaluate(() => ({
            saveAllCalls: globalThis.__RPH_181_SAVE_ALL_CALLS,
            savedCharacterCount: globalThis.__RPH_181_LAST_SAVE_ALL?.length || 0,
            imageModuleReady: typeof globalThis.RPHubImageModule?.getState === 'function',
            imageModuleVersion: globalThis.RPHubImageModule?.version || '',
            persistenceBridgeReady: typeof globalThis.RPH_R2_FLUSH_PERSISTENCE === 'function',
            vueMounted: Boolean(document.querySelector('#app')?.__vue_app__)
        }));
        assert.ok(runtime.saveAllCalls > beforeSaveCalls);
        assert.equal(runtime.imageModuleReady, true);
        assert.equal(runtime.persistenceBridgeReady, true);
        assert.equal(runtime.vueMounted, true);

        const relevantConsoleErrors = consoleErrors.filter((message) => (
            !/Failed to load resource: the server responded with a status of 404/i.test(message)
        ));
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(relevantConsoleErrors, []);

        await fs.mkdir(options.evidenceDir, { recursive: true });
        const screenshotPath = path.join(options.evidenceDir, 'rph-181-retag-browser.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        report.runtime = runtime;
        report.console = {
            errors: consoleErrors,
            relevantErrors: relevantConsoleErrors,
            pageErrors
        };
        report.character = {
            uuid: storedCharacter.uuid,
            name: storedCharacter.name,
            favoritePersisted: Number(storedCharacter.favoriteAt) > 0,
            legacyBlobPresent: false
        };
        report.screenshot = screenshotPath;
        report.ok = true;
        report.finishedAt = new Date().toISOString();
        await fs.writeFile(
            path.join(options.evidenceDir, 'rph-181-retag-browser.json'),
            `${JSON.stringify(report, null, 2)}\n`,
            'utf8'
        );
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await browser?.close().catch(() => { });
        await stopProcess(child);
        await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

await main();
