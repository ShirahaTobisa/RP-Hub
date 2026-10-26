import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PROJECT_DIR = path.resolve(ROOT_DIR, '..');
const PICS_PACKAGE = path.join(PROJECT_DIR, 'release', 'RP-Hub-R2-rebuild-pics-20260719-230502.zip');
const PICS_PACKAGE_SHA256 = '6EC06EA1A393CD5CE65AA8FDEA62CDD657C2966D0A489E3CE657E6A8F67E4FAF';
const PACKAGE_SCRIPT = path.join(ROOT_DIR, 'scripts', 'package.mjs');
const PASSWORD = 'rph';
const IMAGE_TOKEN = ['STD', 'active-character-migration-token'].join('-');
const IMAGE_WAIT_TIMEOUT_MS = Number(process.env.RPH_IMAGE_WAIT_TIMEOUT_MS) || 90_000;
const IMAGE_SIGNATURE_KEYS = [
    'provider', 'tag', 'model', 'artist', 'size', 'steps', 'scale', 'cfg',
    'sampler', 'negative', 'nocache', 'noise_schedule'
];

const DUPLICATE_A = {
    uuid: 'ac000000-0000-4000-8000-000000000001',
    name: 'Twin',
    oldPrompt: 'migration old twin alpha',
    newPrompt: 'migration new twin alpha'
};
const DUPLICATE_B = {
    uuid: 'ac000000-0000-4000-8000-000000000002',
    name: 'Twin',
    oldPrompt: 'migration old twin beta',
    newPrompt: 'migration new twin beta',
    immediatePrompt: 'migration immediate twin beta',
    skippedPrompt: 'migration skipped twin beta'
};
const RENAMED = {
    uuid: 'ac000000-0000-4000-8000-000000000003',
    initialName: 'Before Rename',
    name: 'After Rename',
    oldPrompt: 'migration old renamed role',
    newPrompt: 'migration new renamed role'
};
const CHARACTERS = [DUPLICATE_A, DUPLICATE_B, RENAMED];
const USER_UUID = 'ac000000-0000-4000-8000-000000000099';

function parseArguments(argv) {
    const options = { evidenceDir: '' };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--evidence-dir') options.evidenceDir = path.resolve(argv[++index]);
        else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    return options;
}

function loadPlaywright() {
    try {
        return createRequire(import.meta.url)('playwright');
    } catch (error) {
        throw new Error('Playwright is unavailable.', { cause: error });
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
    const server = createServer((request, response) => response.end('ok'));
    const port = await listen(server);
    await closeServer(server);
    return port;
}

async function wait(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(label, callback, timeoutMs = 60000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const value = await callback();
            if (value) return value;
            lastError = null;
        } catch (error) {
            lastError = error;
        }
        await wait(intervalMs);
    }
    throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

async function stopProcessTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true
        });
    } else {
        child.kill('SIGTERM');
    }
    await Promise.race([once(child, 'exit'), wait(4000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForReady(origin, child, output) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited early (${child.exitCode}).\n${output.value.slice(-8000)}`);
        try {
            const response = await fetch(`${origin}/`);
            if (response.ok) return;
        } catch {
            // The listener is still starting.
        }
        await wait(150);
    }
    throw new Error(`Wrangler did not become ready.\n${output.value.slice(-8000)}`);
}

function startWrangler(distRoot, stateRoot, configRoot, providerOrigin, port) {
    const wranglerBin = path.resolve(
        process.env.APPDATA || '',
        'npm',
        'node_modules',
        'wrangler',
        'bin',
        'wrangler.js'
    );
    assert.ok(existsSync(wranglerBin), `wrangler missing: ${wranglerBin}`);
    const output = { value: '' };
    const child = spawn(process.execPath, [
        wranglerBin,
        'pages',
        'dev',
        '.',
        '--port', String(port),
        '--r2', 'RP_SYNC_R2',
        '--persist-to', stateRoot,
        '--binding', `RP_SYNC_PASSWORD=${PASSWORD}`,
        '--binding', `IMAGE_PROVIDER_STD_URL=${providerOrigin}`,
        '--binding', `IMAGE_PROVIDER_STA1N_URL=${providerOrigin}`,
        '--log-level', 'error',
        '--show-interactive-dev-session=false'
    ], {
        cwd: distRoot,
        env: {
            ...process.env,
            NO_COLOR: '1',
            WRANGLER_SEND_METRICS: 'false',
            XDG_CONFIG_HOME: configRoot
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    child.stdout.on('data', (chunk) => { output.value += chunk; });
    child.stderr.on('data', (chunk) => { output.value += chunk; });
    return { child, output };
}

async function sha256File(file) {
    return createHash('sha256').update(await fs.readFile(file)).digest('hex').toUpperCase();
}

function makeCharacter(uuid, name) {
    return {
        uuid,
        name,
        description: `${name} migration fixture`,
        first_mes: `Hello from ${name}`,
        personality: 'Active-character migration fixture.',
        mes_example: '',
        avatar: null,
        createdAt: 1_700_100_000_000,
        worldInfo: [],
        regexScripts: [],
        uiTemplates: [],
        recentGenerationTimes: []
    };
}

function makeChat(character, prompt, suffix) {
    return [
        {
            id: `migration-user-${suffix}`,
            role: 'user',
            content: `Create an image for ${character.name || character.initialName}.`,
            isSelf: true,
            timestamp: 1_700_100_000_100
        },
        {
            id: `migration-assistant-${suffix}`,
            role: 'assistant',
            name: character.name || character.initialName,
            content: `image###${prompt}###`,
            isSelf: false,
            timestamp: 1_700_100_000_200
        }
    ];
}

function seedRecords() {
    const legacyRegex = {
        name: 'NAI画图正则',
        regex: '/image###([\\s\\S]*?)###/g',
        replacement: '<img src="https://std.loliyc.com/generate?tag=$1&token=&model=nai-diffusion-4-5-full" alt="generated image">',
        placement: [2],
        markdownOnly: true,
        promptOnly: false,
        scope: 'global',
        enabled: true
    };
    const world = {
        id: 'migration-auto-image',
        comment: '自动生图',
        keys: [],
        content: '<auto_image_gen>migration fixture</auto_image_gen>',
        constant: true,
        enabled: true,
        scope: 'global',
        position: 'at_depth',
        depth: 4,
        order: 100,
        useProbability: false,
        probability: 100
    };
    return [
        ['rp_hub_character_index', { order: CHARACTERS.map((character) => character.uuid) }],
        [`rp_hub_character_${DUPLICATE_A.uuid}`, makeCharacter(DUPLICATE_A.uuid, DUPLICATE_A.name)],
        [`rp_hub_character_${DUPLICATE_B.uuid}`, makeCharacter(DUPLICATE_B.uuid, DUPLICATE_B.name)],
        [`rp_hub_character_${RENAMED.uuid}`, makeCharacter(RENAMED.uuid, RENAMED.initialName)],
        [`rp_hub_chat_${DUPLICATE_A.uuid}`, makeChat(DUPLICATE_A, DUPLICATE_A.oldPrompt, 'duplicate-a')],
        [`rp_hub_chat_${DUPLICATE_B.uuid}`, makeChat(DUPLICATE_B, DUPLICATE_B.oldPrompt, 'duplicate-b')],
        [`rp_hub_chat_${RENAMED.uuid}`, makeChat({ initialName: RENAMED.initialName }, RENAMED.oldPrompt, 'renamed')],
        ['rp_hub_settings', {
            apiUrl: 'https://migration.invalid/v1',
            apiKey: '',
            apiProviderId: 'custom',
            apiProviderKeys: { custom: '' },
            customApiUrl: 'https://migration.invalid/v1',
            autoFetchModels: false,
            fontFamily: 'modern',
            fontFamilyVersion: 4,
            stream: true,
            imageSize: '竖图',
            imageGenCount: 2,
            freezeImageGeneration: true,
            imageGenKey: IMAGE_TOKEN
        }],
        ['rp_hub_global_regex', [legacyRegex]],
        ['rp_hub_global_worldinfo', [world]],
        ['rp_hub_user', {
            uuid: USER_UUID,
            name: 'Migration User',
            description: 'Isolated migration fixture',
            avatar: null,
            person: 'second'
        }],
        ['rp_hub_user_profiles', [{
            uuid: USER_UUID,
            name: 'Migration User',
            description: 'Isolated migration fixture',
            avatar: null,
            person: 'second'
        }]],
        ['rp_hub_active_profile_id', USER_UUID],
        ['rp_hub_last_active_char', 0]
    ];
}

async function seedBrowser(page, origin) {
    await page.goto(`${origin}/migration-seed.html`, { waitUntil: 'domcontentloaded' });
    const records = seedRecords();
    return page.evaluate(async ({ records, token, password }) => {
        localStorage.clear();
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_image_gen_key_v1', token);
        localStorage.setItem('rphImgKeyShadow', token);
        localStorage.setItem('rp_hub_sync_password_v1', password);
        await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase('RPHubDB');
            request.onsuccess = () => resolve();
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
                for (const [key, value] of records) transaction.objectStore('store').put(value, key);
            };
        });
        return { records: records.length };
    }, { records, token: IMAGE_TOKEN, password: PASSWORD });
}

async function readBrowserRecord(page, key) {
    return page.evaluate((recordKey) => new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const get = database.transaction('store', 'readonly').objectStore('store').get(recordKey);
            get.onsuccess = () => { database.close(); resolve(get.result); };
            get.onerror = () => { database.close(); reject(get.error); };
        };
    }), key);
}

async function writeBrowserRecord(page, key, value) {
    return page.evaluate(({ recordKey, recordValue }) => new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('store', 'readwrite');
            transaction.oncomplete = () => { database.close(); resolve(true); };
            transaction.onerror = () => { database.close(); reject(transaction.error); };
            transaction.objectStore('store').put(recordValue, recordKey);
        };
    }), { recordKey: key, recordValue: value });
}

async function gotoSeed(page, origin) {
    await page.goto(`${origin}/migration-seed.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
}

async function loadCharacter(page, origin, index, expectedName, phase, phaseName, moduleExpected) {
    await gotoSeed(page, origin);
    await writeBrowserRecord(page, 'rp_hub_last_active_char', index);
    phase.value = phaseName;
    await page.goto(`${origin}/?migration=${encodeURIComponent(phaseName)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 90000
    });
    await page.waitForFunction(({ name, moduleExpected }) => {
        const clear = document.querySelector('button[title="清空聊天"]');
        const header = clear?.closest('.absolute')?.querySelector('span.ml-2.font-medium');
        return Boolean(
            document.querySelector('#app')?.__vue_app__
            && typeof globalThis.RPH_R2_FLUSH_PERSISTENCE === 'function'
            && String(header?.textContent || '').trim() === name
            && (!moduleExpected || globalThis.RPHubImageModule?.getState)
        );
    }, { name: expectedName, moduleExpected }, { timeout: 60000 });
}

async function waitForImage(page, prompt) {
    const diagnostics = async (expected) => page.evaluate((value) => ({
        expected: value,
        module: globalThis.RPHubImageModule?.getState?.() || null,
        counters: globalThis.RPHubImageModule?.getPerformanceCounters?.() || null,
        rows: [...document.querySelectorAll('[data-chat-index][data-role]')].map((row) => ({
            index: row.getAttribute('data-chat-index'),
            role: row.getAttribute('data-role'),
            text: String(row.textContent || '').slice(0, 500),
            attributionFailure: row.dataset.rphImageAttributionFailure || ''
        })),
        frames: [...document.querySelectorAll('.rp-generated-image-frame')].map((frame) => ({
            uuid: frame.getAttribute('data-character-uuid') || '',
            src: frame.querySelector('img')?.currentSrc || frame.querySelector('img')?.src || '',
            complete: Boolean(frame.querySelector('img')?.complete),
            width: frame.querySelector('img')?.naturalWidth || 0,
            height: frame.querySelector('img')?.naturalHeight || 0
        })),
        toasts: [...document.querySelectorAll('[data-rph-image-toast]')].map((item) => item.textContent || '')
    }), expected).catch(() => null);
    try {
        await page.waitForFunction((expected) => [...document.querySelectorAll('.rp-generated-image-frame img')]
            .some((image) => {
                try { return new URL(image.currentSrc || image.src, location.origin).searchParams.get('tag') === expected; }
                catch { return false; }
            }), prompt, { timeout: Math.min(30_000, IMAGE_WAIT_TIMEOUT_MS) });
    } catch (error) {
        throw new Error(`${error.message}; diagnostics=${JSON.stringify(await diagnostics(prompt))}`);
    }
    await page.evaluate((expected) => {
        const image = [...document.querySelectorAll('.rp-generated-image-frame img')].find((candidate) => {
            try { return new URL(candidate.currentSrc || candidate.src, location.origin).searchParams.get('tag') === expected; }
            catch { return false; }
        });
        if (image && (!image.complete || image.naturalWidth <= 0)) image.dispatchEvent(new Event('error'));
    }, prompt);
    try {
        await page.waitForFunction((expected) => [...document.querySelectorAll('.rp-generated-image-frame img')]
            .some((image) => {
                if (!image.complete || image.naturalWidth <= 0) return false;
                try { return new URL(image.currentSrc || image.src, location.origin).searchParams.get('tag') === expected; }
                catch { return false; }
            }), prompt, { timeout: IMAGE_WAIT_TIMEOUT_MS });
    } catch (error) {
        throw new Error(`${error.message}; diagnostics=${JSON.stringify(await diagnostics(prompt))}`);
    }
    return page.evaluate((expected) => {
        const image = [...document.querySelectorAll('.rp-generated-image-frame img')].find((candidate) => {
            try { return new URL(candidate.currentSrc || candidate.src, location.origin).searchParams.get('tag') === expected; }
            catch { return false; }
        });
        const url = new URL(image.currentSrc || image.src, location.origin);
        return {
            src: url.toString(),
            characterUuid: url.searchParams.get('character_id'),
            characterName: url.searchParams.get('character_name')
        };
    }, prompt);
}

async function waitForRecord(page, uuid, predicate, label) {
    return poll(label, async () => {
        const records = await readBrowserRecord(page, `rp_hub_image_renders_${uuid}`);
        return Array.isArray(records) && predicate(records) ? records : null;
    }, 90000, 150);
}

async function flushPage(page) {
    await page.evaluate(() => globalThis.RPH_R2_FLUSH_PERSISTENCE());
}

async function pushSnapshot(page) {
    const syncButton = page.locator('[data-rph-sync-entry]');
    await syncButton.waitFor({ state: 'visible', timeout: 30000 });
    await page.evaluate(() => document.querySelector('[data-rph-sync-entry]')?.click());
    const modal = page.locator('.rp-sync-modal.is-open');
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(() => document.querySelector('.rp-sync-modal.is-open [data-action="push"]')?.click());
    await page.waitForFunction(() => {
        const status = document.querySelector('.rp-sync-modal.is-open .rp-sync-modal__status');
        const push = document.querySelector('.rp-sync-modal.is-open [data-action="push"]');
        return Boolean(status && /上传成功|同一份数据/.test(status.textContent || '') && push && !push.disabled);
    }, null, { timeout: 180000 });
    await page.evaluate(() => document.querySelector('.rp-sync-modal.is-open .rp-sync-modal__close')?.click());
    await modal.waitFor({ state: 'hidden', timeout: 10000 });
}

async function syncStatus(origin) {
    const response = await fetch(`${origin}/api/rp-sync`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-rp-sync-password': PASSWORD
        },
        body: JSON.stringify({ action: 'status' })
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true, JSON.stringify(payload));
    return payload;
}

async function readLibrary(origin) {
    const response = await fetch(`${origin}/image/api/library`, {
        headers: { 'x-rp-sync-password': PASSWORD }
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
}

function findRecord(records, prompt) {
    return (records || []).find((record) => record?.prompt === prompt) || null;
}

function buildRecordUrl(origin, record) {
    const params = record?.paramsSnapshot || {};
    const url = new URL('/api/rp-image', origin);
    for (const key of IMAGE_SIGNATURE_KEYS) url.searchParams.set(key, String(params[key] || ''));
    if (params.seed) url.searchParams.set('seed', String(params.seed));
    if (params.rerollNonce) url.searchParams.set('reroll_nonce', String(params.rerollNonce));
    url.searchParams.set('character_id', String(params.characterUuid || ''));
    url.searchParams.set('character_name', String(params.characterName || '未命名角色'));
    return url;
}

function summarizeRecord(record) {
    return {
        key: record?.key || '',
        prompt: record?.prompt || '',
        status: record?.status || '',
        rerollCount: Number(record?.rerollCount || 0),
        characterUuid: record?.paramsSnapshot?.characterUuid || '',
        characterName: record?.paramsSnapshot?.characterName || '',
        seed: record?.paramsSnapshot?.seed || ''
    };
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const { chromium } = loadPlaywright();
    const chromePath = findChrome();
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-pics-img-migration-'));
    const picsDist = path.join(runtimeRoot, 'pics-dist');
    const imgDist = path.join(runtimeRoot, 'img-dist');
    const tempRelease = path.join(runtimeRoot, 'release');
    const stateRoot = path.join(runtimeRoot, 'wrangler-state');
    const configRoot = path.join(runtimeRoot, 'xdg-config');
    const evidenceDir = options.evidenceDir || path.join(runtimeRoot, 'evidence');
    const reportPath = path.join(evidenceDir, 'image-pics-migration-e2e.json');
    const screenshotPath = path.join(evidenceDir, 'image-pics-migration-admin.png');
    const phase = { value: 'setup' };
    const providerCalls = [];
    const imageResponses = [];
    const pageErrors = [];
    const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=', 'base64');
    const report = {
        ok: false,
        startedAt: new Date().toISOString(),
        browser: { engine: 'Chrome', executable: chromePath, controller: 'Playwright' },
        baseline: { package: PICS_PACKAGE, expectedSha256: PICS_PACKAGE_SHA256 },
        sameBucket: { binding: 'RP_SYNC_R2', persistRoot: stateRoot },
        provider: { origin: '', calls: [] }
    };
    let providerServer = null;
    let browser = null;
    let context = null;
    let page = null;
    let wrangler = null;
    let wranglerOutput = null;
    let failure = null;

    const switchDist = async (distRoot, origin, label) => {
        if (page) await page.goto('about:blank').catch(() => {});
        await stopProcessTree(wrangler);
        wrangler = null;
        await wait(250);
        const run = startWrangler(distRoot, stateRoot, configRoot, report.provider.origin, Number(new URL(origin).port));
        wrangler = run.child;
        wranglerOutput = run.output;
        await waitForReady(origin, wrangler, wranglerOutput);
        report.sameBucket[label] = { distRoot, port: Number(new URL(origin).port) };
    };

    try {
        await Promise.all([
            fs.mkdir(picsDist, { recursive: true }),
            fs.mkdir(configRoot, { recursive: true }),
            fs.mkdir(evidenceDir, { recursive: true })
        ]);
        const actualPicsSha = await sha256File(PICS_PACKAGE);
        assert.equal(actualPicsSha, PICS_PACKAGE_SHA256, 'frozen pics migration package changed');
        report.baseline.actualSha256 = actualPicsSha;
        const extracted = spawnSync('tar', ['-xf', PICS_PACKAGE, '-C', picsDist], {
            encoding: 'utf8',
            windowsHide: true
        });
        assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
        const packaged = spawnSync(process.execPath, [
            PACKAGE_SCRIPT,
            '--dist', imgDist,
            '--release-dir', tempRelease
        ], { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
        report.imgPackage = JSON.parse(packaged.stdout);
        const fixtureHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Migration seed</title></head><body>seed</body></html>';
        await Promise.all([
            fs.writeFile(path.join(picsDist, 'migration-seed.html'), fixtureHtml, 'utf8'),
            fs.writeFile(path.join(imgDist, 'migration-seed.html'), fixtureHtml, 'utf8')
        ]);

        providerServer = createServer((request, response) => {
            const url = new URL(request.url || '/', 'http://127.0.0.1');
            if (url.pathname !== '/generate') {
                response.writeHead(404);
                response.end('not found');
                return;
            }
            providerCalls.push({
                phase: phase.value,
                provider: url.searchParams.get('provider') || '',
                tag: url.searchParams.get('tag') || '',
                model: url.searchParams.get('model') || ''
            });
            response.writeHead(200, {
                'content-type': 'image/png',
                'content-length': String(tinyPng.byteLength)
            });
            response.end(tinyPng);
        });
        const providerPort = await listen(providerServer);
        report.provider = { origin: `http://127.0.0.1:${providerPort}` };
        const picsWorkerPath = path.join(picsDist, '_worker.js');
        const picsWorkerSource = await fs.readFile(picsWorkerPath, 'utf8');
        const picsHarnessWorker = picsWorkerSource.replaceAll('https://std.loliyc.com', report.provider.origin);
        assert.notEqual(picsHarnessWorker, picsWorkerSource, 'frozen pics provider URL override did not match');
        await fs.writeFile(picsWorkerPath, picsHarnessWorker, 'utf8');
        report.harness = {
            picsProviderOverride: {
                from: 'https://std.loliyc.com',
                to: report.provider.origin,
                scope: 'temporary extracted dist only'
            }
        };
        const pagesPort = await availablePort();
        const origin = `http://127.0.0.1:${pagesPort}`;
        report.origin = origin;

        browser = await chromium.launch({
            executablePath: chromePath,
            headless: true,
            args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server']
        });
        context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
        page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
        page.on('response', (response) => {
            try {
                const url = new URL(response.url());
                if (url.pathname !== '/api/rp-image') return;
                const headers = response.headers();
                imageResponses.push({
                    phase: phase.value,
                    method: response.request().method(),
                    status: response.status(),
                    cache: headers['x-rp-image-cache'] || '',
                    tag: url.searchParams.get('tag') || '',
                    characterUuid: url.searchParams.get('character_id') || '',
                    characterName: url.searchParams.get('character_name') || ''
                });
            } catch {
                // Ignore unrelated response parsing failures.
            }
        });

        await switchDist(picsDist, origin, 'stageA');
        const seeded = await seedBrowser(page, origin);
        assert.ok(seeded.records >= 10);
        const providerStageAStart = providerCalls.length;

        let expectedProvider = providerCalls.length + 1;
        await loadCharacter(page, origin, 0, DUPLICATE_A.name, phase, 'A-duplicate-a', false);
        const duplicateAInitialImage = await waitForImage(page, DUPLICATE_A.oldPrompt);
        await poll('stage A duplicate A provider call', () => providerCalls.length === expectedProvider);
        const duplicateAInitialRecords = await waitForRecord(
            page,
            DUPLICATE_A.uuid,
            (records) => Boolean(findRecord(records, DUPLICATE_A.oldPrompt)),
            'stage A duplicate A record'
        );
        const duplicateAInitial = findRecord(duplicateAInitialRecords, DUPLICATE_A.oldPrompt);
        assert.equal(duplicateAInitial.paramsSnapshot.characterUuid, DUPLICATE_A.uuid);
        assert.equal(duplicateAInitial.paramsSnapshot.characterName, DUPLICATE_A.name);

        expectedProvider += 1;
        const rerollClicked = await page.evaluate((prompt) => {
            const image = [...document.querySelectorAll('.rp-generated-image-frame img')].find((candidate) => {
                try { return new URL(candidate.currentSrc || candidate.src, location.origin).searchParams.get('tag') === prompt; }
                catch { return false; }
            });
            const button = image?.closest('.rp-generated-image-frame')?.querySelector('.rp-image-reroll-button');
            button?.click();
            return Boolean(button);
        }, DUPLICATE_A.oldPrompt);
        assert.equal(rerollClicked, true, 'stage A reroll button missing');
        await poll('stage A reroll provider call', () => providerCalls.length === expectedProvider);
        const duplicateARerolledRecords = await waitForRecord(
            page,
            DUPLICATE_A.uuid,
            (records) => findRecord(records, DUPLICATE_A.oldPrompt)?.rerollCount === 1,
            'stage A reroll record'
        );
        const duplicateARerolled = findRecord(duplicateARerolledRecords, DUPLICATE_A.oldPrompt);
        assert.notEqual(duplicateARerolled.imageSignature, duplicateAInitial.imageSignature);

        expectedProvider += 1;
        await loadCharacter(page, origin, 1, DUPLICATE_B.name, phase, 'A-duplicate-b', false);
        await waitForImage(page, DUPLICATE_B.oldPrompt);
        await poll('stage A duplicate B provider call', () => providerCalls.length === expectedProvider);
        await waitForRecord(
            page,
            DUPLICATE_B.uuid,
            (records) => Boolean(findRecord(records, DUPLICATE_B.oldPrompt)),
            'stage A duplicate B record'
        );

        await gotoSeed(page, origin);
        const duplicateBChat = await readBrowserRecord(page, `rp_hub_chat_${DUPLICATE_B.uuid}`);
        duplicateBChat.push({
            id: 'migration-assistant-skipped-b',
            role: 'assistant',
            name: DUPLICATE_B.name,
            content: `image###${DUPLICATE_B.skippedPrompt}###`,
            isSelf: false,
            timestamp: 1_700_100_000_300
        });
        const worldDisabled = await readBrowserRecord(page, 'rp_hub_global_worldinfo');
        worldDisabled.forEach((entry) => { if (entry?.comment === '自动生图') entry.enabled = false; });
        await writeBrowserRecord(page, `rp_hub_chat_${DUPLICATE_B.uuid}`, duplicateBChat);
        await writeBrowserRecord(page, 'rp_hub_global_worldinfo', worldDisabled);
        const providerBeforeSkipped = providerCalls.length;
        await loadCharacter(page, origin, 1, DUPLICATE_B.name, phase, 'A-skipped', false);
        const duplicateBSkippedRecords = await waitForRecord(
            page,
            DUPLICATE_B.uuid,
            (records) => findRecord(records, DUPLICATE_B.skippedPrompt)?.status === 'skipped',
            'stage A skipped record'
        );
        assert.equal(providerCalls.length, providerBeforeSkipped, 'skipped record called provider');
        assert.equal(findRecord(duplicateBSkippedRecords, DUPLICATE_B.skippedPrompt)?.status, 'skipped');

        await gotoSeed(page, origin);
        const worldEnabled = await readBrowserRecord(page, 'rp_hub_global_worldinfo');
        worldEnabled.forEach((entry) => { if (entry?.comment === '自动生图') entry.enabled = true; });
        await writeBrowserRecord(page, 'rp_hub_global_worldinfo', worldEnabled);
        await loadCharacter(page, origin, 1, DUPLICATE_B.name, phase, 'A-skipped-reenabled', false);
        await waitForImage(page, DUPLICATE_B.oldPrompt);
        assert.equal(providerCalls.length, providerBeforeSkipped, 'reloading a skipped record regenerated it');

        expectedProvider += 1;
        await loadCharacter(page, origin, 2, RENAMED.initialName, phase, 'A-rename-before', false);
        await waitForImage(page, RENAMED.oldPrompt);
        await poll('stage A pre-rename provider call', () => providerCalls.length === expectedProvider);
        const preRenameRecords = await waitForRecord(
            page,
            RENAMED.uuid,
            (records) => Boolean(findRecord(records, RENAMED.oldPrompt)),
            'stage A pre-rename record'
        );
        assert.equal(findRecord(preRenameRecords, RENAMED.oldPrompt).paramsSnapshot.characterName, RENAMED.initialName);

        await gotoSeed(page, origin);
        const renamedCard = await readBrowserRecord(page, `rp_hub_character_${RENAMED.uuid}`);
        renamedCard.name = RENAMED.name;
        await writeBrowserRecord(page, `rp_hub_character_${RENAMED.uuid}`, renamedCard);
        expectedProvider += 1;
        await loadCharacter(page, origin, 2, RENAMED.name, phase, 'A-rename-after', false);
        const renamedImage = await waitForImage(page, RENAMED.oldPrompt);
        await poll('stage A post-rename provider call', () => providerCalls.length === expectedProvider);
        assert.equal(renamedImage.characterName, RENAMED.name);
        await flushPage(page);
        const renamedRecords = await waitForRecord(
            page,
            RENAMED.uuid,
            (records) => findRecord(records, RENAMED.oldPrompt)?.paramsSnapshot?.characterName === RENAMED.name,
            'stage A post-rename snapshot'
        );

        await pushSnapshot(page);
        const stageAStatus = await syncStatus(origin);
        const stageARecords = {
            duplicateA: structuredClone(findRecord(duplicateARerolledRecords, DUPLICATE_A.oldPrompt)),
            duplicateB: structuredClone(findRecord(
                await readBrowserRecord(page, `rp_hub_image_renders_${DUPLICATE_B.uuid}`),
                DUPLICATE_B.oldPrompt
            )),
            renamed: structuredClone(findRecord(renamedRecords, RENAMED.oldPrompt)),
            skipped: structuredClone(findRecord(
                await readBrowserRecord(page, `rp_hub_image_renders_${DUPLICATE_B.uuid}`),
                DUPLICATE_B.skippedPrompt
            ))
        };
        const providerStageAEnd = providerCalls.length;
        assert.equal(providerStageAEnd - providerStageAStart, 5, 'stage A provider count changed unexpectedly');
        report.stageA = {
            assertions: {
                generatedCharacters: 3,
                duplicatePair: true,
                reroll: stageARecords.duplicateA.rerollCount === 1,
                skipped: stageARecords.skipped.status === 'skipped',
                renamedAfterGeneration: stageARecords.renamed.paramsSnapshot.characterName === RENAMED.name,
                pushed: Boolean(stageAStatus.remote?.version)
            },
            provider: { start: providerStageAStart, end: providerStageAEnd, delta: providerStageAEnd - providerStageAStart },
            records: Object.fromEntries(Object.entries(stageARecords).map(([key, value]) => [key, summarizeRecord(value)])),
            initialImage: duplicateAInitialImage,
            syncStatus: stageAStatus
        };
        console.log(`PASS migration phase A: provider=${providerStageAEnd}, rendered=3, reroll=1, skipped=1, renamed=1, pushed=1`);

        await switchDist(imgDist, origin, 'stageB');
        const providerStageBOldStart = providerCalls.length;
        const oldCases = [
            { character: DUPLICATE_A, index: 0, name: DUPLICATE_A.name, prompt: DUPLICATE_A.oldPrompt },
            { character: DUPLICATE_B, index: 1, name: DUPLICATE_B.name, prompt: DUPLICATE_B.oldPrompt },
            { character: RENAMED, index: 2, name: RENAMED.name, prompt: RENAMED.oldPrompt }
        ];
        const oldHits = [];
        for (const item of oldCases) {
            const phaseName = `B-old-${item.index}`;
            const before = providerCalls.length;
            await loadCharacter(page, origin, item.index, item.name, phase, phaseName, true);
            const image = await waitForImage(page, item.prompt);
            await wait(250);
            assert.equal(providerCalls.length, before, `${phaseName} called provider`);
            const response = await poll(`${phaseName} HIT response`, () => imageResponses.find((entry) => (
                entry.phase === phaseName && entry.tag === item.prompt && entry.cache === 'HIT'
            )));
            const records = await readBrowserRecord(page, `rp_hub_image_renders_${item.character.uuid}`);
            assert.ok(findRecord(records, item.prompt), `${phaseName} record missing from its UUID bucket`);
            const state = await page.evaluate(() => globalThis.RPHubImageModule.getState());
            assert.equal(state.characterUuid, item.character.uuid, `${phaseName} module activated the wrong bucket`);
            oldHits.push({ characterUuid: item.character.uuid, prompt: item.prompt, image, response });
        }
        const providerStageBOldEnd = providerCalls.length;
        assert.equal(providerStageBOldEnd, providerStageBOldStart, 'stage B old images increased provider count');
        await page.evaluate(() => globalThis.RPHubImageModule.setAutoEnabled(true));
        await page.waitForFunction(() => globalThis.RPHubImageModule?.getState?.().autoEnabled === true, null, { timeout: 30000 });

        const newCases = [
            { character: DUPLICATE_A, index: 0, name: DUPLICATE_A.name, prompt: DUPLICATE_A.newPrompt },
            { character: DUPLICATE_B, index: 1, name: DUPLICATE_B.name, prompt: DUPLICATE_B.newPrompt },
            { character: RENAMED, index: 2, name: RENAMED.name, prompt: RENAMED.newPrompt }
        ];
        const newRecords = [];
        const providerStageBNewStart = providerCalls.length;
        for (const item of newCases) {
            await gotoSeed(page, origin);
            const chat = await readBrowserRecord(page, `rp_hub_chat_${item.character.uuid}`);
            chat.push({
                id: `migration-new-${item.index}`,
                role: 'assistant',
                name: item.name,
                content: `image###${item.prompt}###`,
                isSelf: false,
                timestamp: 1_700_100_001_000 + item.index
            });
            await writeBrowserRecord(page, `rp_hub_chat_${item.character.uuid}`, chat);
            const before = providerCalls.length;
            const phaseName = `B-new-${item.index}`;
            await loadCharacter(page, origin, item.index, item.name, phase, phaseName, true);
            const image = await waitForImage(page, item.prompt);
            await poll(`${phaseName} provider call`, () => providerCalls.length === before + 1);
            await wait(250);
            assert.equal(providerCalls.length, before + 1, `${phaseName} called provider more than once`);
            const records = await waitForRecord(
                page,
                item.character.uuid,
                (values) => Boolean(findRecord(values, item.prompt)),
                `${phaseName} record`
            );
            const record = findRecord(records, item.prompt);
            assert.equal(record.paramsSnapshot.characterUuid, item.character.uuid, `${phaseName} uuid crossed buckets`);
            assert.equal(record.paramsSnapshot.characterName, item.name, `${phaseName} did not use directory card name`);
            assert.equal(image.characterUuid, item.character.uuid, `${phaseName} URL used wrong uuid`);
            assert.equal(image.characterName, item.name, `${phaseName} URL used wrong name`);
            newRecords.push(summarizeRecord(record));
        }

        await loadCharacter(page, origin, 0, DUPLICATE_A.name, phase, 'B-immediate-source-a', true);
        await waitForImage(page, DUPLICATE_A.newPrompt);
        const providerBeforeImmediate = providerCalls.length;
        phase.value = 'B-immediate-switch-b';
        const immediateIndex = await page.evaluate(async ({ uuid, name, prompt }) => {
            const database = await new Promise((resolve, reject) => {
                const request = indexedDB.open('RPHubDB', 1);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            const transaction = database.transaction('store', 'readwrite');
            const store = transaction.objectStore('store');
            const chat = await new Promise((resolve, reject) => {
                const request = store.get(`rp_hub_chat_${uuid}`);
                request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
                request.onerror = () => reject(request.error);
            });
            const index = chat.length;
            chat.push({
                id: 'migration-immediate-b',
                role: 'assistant',
                name,
                content: `image###${prompt}###`,
                isSelf: false,
                timestamp: Date.now()
            });
            store.put(chat, `rp_hub_chat_${uuid}`);
            store.put(1, 'rp_hub_last_active_char');
            await new Promise((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
            database.close();
            const clear = document.querySelector('button[title="清空聊天"]');
            const header = clear?.closest('.absolute')?.querySelector('span.ml-2.font-medium');
            if (header) header.textContent = name;
            const rows = [...document.querySelectorAll('[data-chat-index][data-role="assistant"]')];
            const row = rows.at(-1);
            if (!row) throw new Error('assistant row missing for immediate switch');
            row.setAttribute('data-chat-index', String(index));
            const nameTag = row.querySelector('.msg-name-tag');
            if (nameTag) nameTag.textContent = name;
            const root = row.querySelector('.markdown-body');
            if (!root) throw new Error('markdown root missing for immediate switch');
            root.textContent = `image###${prompt}###`;
            await globalThis.RPHubImageModule.scan();
            return index;
        }, { uuid: DUPLICATE_B.uuid, name: DUPLICATE_B.name, prompt: DUPLICATE_B.immediatePrompt });
        assert.ok(Number.isInteger(immediateIndex));
        await waitForImage(page, DUPLICATE_B.immediatePrompt);
        await poll('immediate switch provider call', () => providerCalls.length === providerBeforeImmediate + 1);
        const immediateRecords = await waitForRecord(
            page,
            DUPLICATE_B.uuid,
            (records) => Boolean(findRecord(records, DUPLICATE_B.immediatePrompt)),
            'immediate switch record'
        );
        const immediateRecord = findRecord(immediateRecords, DUPLICATE_B.immediatePrompt);
        assert.equal(immediateRecord.paramsSnapshot.characterUuid, DUPLICATE_B.uuid);
        assert.equal(immediateRecord.paramsSnapshot.characterName, DUPLICATE_B.name);
        const immediateState = await page.evaluate(() => globalThis.RPHubImageModule.getState());
        assert.equal(immediateState.characterUuid, DUPLICATE_B.uuid);
        assert.equal(immediateState.attributionSource, 'active-character');

        const buckets = {
            duplicateA: await readBrowserRecord(page, `rp_hub_image_renders_${DUPLICATE_A.uuid}`),
            duplicateB: await readBrowserRecord(page, `rp_hub_image_renders_${DUPLICATE_B.uuid}`),
            renamed: await readBrowserRecord(page, `rp_hub_image_renders_${RENAMED.uuid}`)
        };
        assert.equal(Boolean(findRecord(buckets.duplicateA, DUPLICATE_B.newPrompt)), false, 'duplicate B record leaked into duplicate A bucket');
        assert.equal(Boolean(findRecord(buckets.duplicateB, DUPLICATE_A.newPrompt)), false, 'duplicate A record leaked into duplicate B bucket');
        assert.equal(Boolean(findRecord(buckets.renamed, DUPLICATE_A.newPrompt)), false, 'duplicate record leaked into renamed bucket');

        const library = await readLibrary(origin);
        const libraryNames = new Set((library.characters || []).map((character) => character.name));
        assert.ok(libraryNames.has(DUPLICATE_A.name), 'management library omitted duplicate-name images');
        assert.ok(libraryNames.has(RENAMED.name), 'management library omitted renamed character images');
        const adminPage = await context.newPage();
        await adminPage.goto(`${origin}/image`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        const passwordInput = adminPage.locator('#password');
        if (await passwordInput.isVisible().catch(() => false)) {
            await passwordInput.fill(PASSWORD);
            await adminPage.locator('#login').click();
        }
        await adminPage.waitForFunction(({ duplicateName, renamedName }) => {
            const titles = [...document.querySelectorAll('.album-title')].map((item) => item.textContent || '');
            return titles.includes(duplicateName) && titles.includes(renamedName);
        }, { duplicateName: DUPLICATE_A.name, renamedName: RENAMED.name }, { timeout: 30000 });
        await adminPage.screenshot({ path: screenshotPath, fullPage: false });
        await adminPage.close();

        const providerStageBNewEnd = providerCalls.length;
        assert.equal(providerStageBNewEnd - providerStageBNewStart, 4, 'stage B new-image provider count changed unexpectedly');
        report.stageB = {
            oldImages: {
                providerStart: providerStageBOldStart,
                providerEnd: providerStageBOldEnd,
                providerDelta: providerStageBOldEnd - providerStageBOldStart,
                hits: oldHits,
                autoEnabledBeforeNewGeneration: false
            },
            newImages: {
                autoEnabled: true,
                providerStart: providerStageBNewStart,
                providerEnd: providerStageBNewEnd,
                providerDelta: providerStageBNewEnd - providerStageBNewStart,
                records: newRecords,
                immediate: summarizeRecord(immediateRecord)
            },
            buckets: Object.fromEntries(Object.entries(buckets).map(([key, values]) => [key, values.map(summarizeRecord)])),
            library: {
                totalCount: library.totalCount,
                characters: (library.characters || []).map((character) => ({ name: character.name, count: character.count }))
            },
            managementScreenshot: screenshotPath
        };
        console.log(`PASS migration phase B: oldHits=3, oldProviderDelta=0, newProviderDelta=4, duplicateBuckets=isolated, immediateSwitch=${DUPLICATE_B.uuid}`);

        await switchDist(picsDist, origin, 'stageC');
        await gotoSeed(page, origin);
        const providerStageCDirectStart = providerCalls.length;
        const rollbackHits = [];
        for (const [label, record] of Object.entries({
            duplicateA: stageARecords.duplicateA,
            duplicateB: stageARecords.duplicateB,
            renamed: stageARecords.renamed
        })) {
            phase.value = `C-direct-${label}`;
            const response = await fetch(buildRecordUrl(origin, record));
            assert.equal(response.status, 200, `${label} rollback image unavailable`);
            assert.equal(response.headers.get('x-rp-image-cache'), 'HIT', `${label} rollback image was not a HIT`);
            await response.body?.cancel().catch(() => {});
            rollbackHits.push({
                label,
                prompt: record.prompt,
                cache: response.headers.get('x-rp-image-cache'),
                key: decodeURIComponent(response.headers.get('x-rp-image-key') || '')
            });
        }
        const providerStageCDirectEnd = providerCalls.length;
        assert.equal(providerStageCDirectEnd, providerStageCDirectStart, 'stage C old-image verification called provider');

        const rollbackBuckets = {
            duplicateA: await readBrowserRecord(page, `rp_hub_image_renders_${DUPLICATE_A.uuid}`),
            duplicateB: await readBrowserRecord(page, `rp_hub_image_renders_${DUPLICATE_B.uuid}`),
            renamed: await readBrowserRecord(page, `rp_hub_image_renders_${RENAMED.uuid}`)
        };
        for (const [label, oldRecord] of Object.entries({
            duplicateA: stageARecords.duplicateA,
            duplicateB: stageARecords.duplicateB,
            renamed: stageARecords.renamed
        })) {
            const current = rollbackBuckets[label];
            assert.ok(current.some((record) => record.key === oldRecord.key), `${label} stage A record was damaged`);
        }
        assert.ok(rollbackBuckets.duplicateB.some((record) => record.key === stageARecords.skipped.key), 'stage A skipped record was damaged');

        const providerBeforeRollbackPage = providerCalls.length;
        await loadCharacter(page, origin, 2, RENAMED.name, phase, 'C-page-smoke', false);
        await waitForImage(page, RENAMED.oldPrompt);
        await wait(500);
        const rollbackPageState = await page.evaluate((name) => ({
            vueMounted: Boolean(document.querySelector('#app')?.__vue_app__),
            header: String(document.querySelector('button[title="清空聊天"]')?.closest('.absolute')
                ?.querySelector('span.ml-2.font-medium')?.textContent || '').trim(),
            oldImageVisible: [...document.querySelectorAll('.rp-generated-image-frame img')].some((image) => {
                try { return new URL(image.currentSrc || image.src, location.origin).searchParams.get('tag') === name; }
                catch { return false; }
            })
        }), RENAMED.oldPrompt);
        assert.deepEqual(rollbackPageState, {
            vueMounted: true,
            header: RENAMED.name,
            oldImageVisible: true
        });
        const rollbackStatus = await syncStatus(origin);
        report.stageC = {
            oldImages: {
                providerStart: providerStageCDirectStart,
                providerEnd: providerStageCDirectEnd,
                providerDelta: providerStageCDirectEnd - providerStageCDirectStart,
                hits: rollbackHits
            },
            page: {
                ...rollbackPageState,
                providerStart: providerBeforeRollbackPage,
                providerEnd: providerCalls.length,
                providerDelta: providerCalls.length - providerBeforeRollbackPage
            },
            stageARecordsIntact: true,
            syncStatus: rollbackStatus
        };
        console.log(`PASS migration phase C: oldHits=3, oldProviderDelta=0, pageUsable=1, rollbackProviderDelta=${providerCalls.length - providerBeforeRollbackPage}`);

        assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join('\n')}`);
        report.provider.calls = providerCalls;
        report.provider.table = {
            stageA: { start: providerStageAStart, end: providerStageAEnd, delta: providerStageAEnd - providerStageAStart },
            stageBOld: { start: providerStageBOldStart, end: providerStageBOldEnd, delta: providerStageBOldEnd - providerStageBOldStart },
            stageBNew: { start: providerStageBNewStart, end: providerStageBNewEnd, delta: providerStageBNewEnd - providerStageBNewStart },
            stageCOld: { start: providerStageCDirectStart, end: providerStageCDirectEnd, delta: providerStageCDirectEnd - providerStageCDirectStart }
        };
        report.imageResponses = imageResponses;
        report.pageErrors = pageErrors;
        report.ok = true;
        report.finishedAt = new Date().toISOString();
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log(`PASS image-pics-migration.runner.mjs: ${reportPath}`);
    } catch (error) {
        failure = error;
        report.ok = false;
        report.failure = {
            phase: phase.value,
            message: error?.message || String(error),
            stack: error?.stack || ''
        };
        report.provider.calls = providerCalls;
        report.imageResponses = imageResponses;
        report.pageErrors = pageErrors;
        report.wranglerOutput = wranglerOutput?.value?.slice(-12000) || '';
        report.finishedAt = new Date().toISOString();
        await fs.mkdir(evidenceDir, { recursive: true }).catch(() => {});
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
    } finally {
        await stopProcessTree(wrangler).catch(() => {});
        await browser?.close().catch(() => {});
        await closeServer(providerServer).catch(() => {});
        await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
    if (failure) throw failure;
}

await main();
