import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PACKAGE_SCRIPT = path.join(ROOT_DIR, 'scripts', 'package.mjs');
const UPSTREAM_ROOT = path.resolve(ROOT_DIR, '..', 'RP-Hub');
const UPSTREAM_181_COMMIT = '8911f4bba41cfe3b1a092862697b99faf7716d7d';
const DEFAULT_TARGET_VERSION = '1.7.8';
const PASSWORD = 'rph';
const IMAGE_TOKEN = ['STD', 'overlay-browser-token'].join('-');
const CHARACTER_UUID = '8d5e4b53-ff25-4f74-9ee8-623579118d6e';
const USER_UUID = 'b83874fb-0b28-41b3-b05d-02e676ae8aa7';
const CHARACTER_NAME = '苏 糖·覆盖/验收';
const IMAGE_PROMPT = 'portrait, blue hair, window light, special / "? 中文';
const CHANGED_SETTINGS_TOKEN = ['STD', 'changed-settings-token'].join('-');
const PICS_MIGRATION_TOKEN = ['STD', 'pics-migration-token'].join('-');
const CLOSEOUT_A_UUID = 'aa000000-0000-4000-8000-000000000001';
const CLOSEOUT_B_UUID = 'bb000000-0000-4000-8000-000000000002';
const CLOSEOUT_A_NAME = '崩坏三';
const CLOSEOUT_B_NAME = '洛茜';
const CLOSEOUT_A_PROMPT = 'closeout role a, red hair, daylight';
const CLOSEOUT_B_PROMPT = 'closeout role b, silver hair, moonlight';
const CLOSEOUT_FAILURE_PROMPT = 'force-provider-500, closeout failure';
const PICS_REGEX_REPLACEMENT = `<img src="https://std.loliyc.com/generate?tag=$1&token=${PICS_MIGRATION_TOKEN}&model=nai-diffusion-4-5-full&artist=artist%3Apics&size=%E7%AB%96%E5%9B%BE&steps=40&scale=6&cfg=0&sampler=k_dpmpp_2m_sde&negative=bad%20anatomy&nocache=0&noise_schedule=karras&seed=778899" alt="generated image">`;
const PICS_REGEX_CLEARED_REPLACEMENT = '<img src="https://std.loliyc.com/generate?tag=$1&token=&model=nai-diffusion-4-5-full&artist=artist%3Apics&size=%E7%AB%96%E5%9B%BE&steps=40&scale=6&cfg=0&sampler=k_dpmpp_2m_sde&negative=bad%20anatomy&nocache=0&noise_schedule=karras&seed=778899" alt="generated image">';

const MODULE_REGEX_SEED = {
    name: 'RPHub 自动生图正则',
    regex: '/image###([\\s\\S]*?)###/g',
    replacement: 'image###$1###',
    placement: [2],
    markdownOnly: false,
    promptOnly: true,
    scope: 'global',
    enabled: true
};

const MODULE_WORLD_SEED = {
    comment: 'RPHub 自动生图',
    keys: [],
    content: '<auto_image_gen>overlay fixture</auto_image_gen>',
    constant: true,
    enabled: true,
    scope: 'global',
    position: 'at_depth',
    depth: 4,
    order: 100,
    useProbability: false,
    probability: 100
};

const PICS_REGEX_SEED = {
    name: 'NAI画图正则',
    regex: '/image###([\\s\\S]*?)###/g',
    replacement: PICS_REGEX_REPLACEMENT,
    placement: [2],
    markdownOnly: true,
    promptOnly: false,
    scope: 'global',
    enabled: true
};

const PICS_WORLD_SEED = {
    comment: '自动生图',
    keys: [],
    content: '<auto_image_gen>pics migration fixture</auto_image_gen>',
    constant: true,
    enabled: true,
    scope: 'global',
    position: 'at_depth',
    depth: 4,
    order: 100,
    useProbability: false,
    probability: 100
};

function readUpstreamTagFiles(version) {
    const reference = version === '1.8.1' ? UPSTREAM_181_COMMIT : version;
    const tree = spawnSync('git', ['-C', UPSTREAM_ROOT, 'ls-tree', '-r', '--name-only', reference], { encoding: 'utf8' });
    assert.equal(tree.status, 0, tree.stderr || tree.stdout);
    const names = tree.stdout.trim().split(/\r?\n/).filter(Boolean)
        .filter((name) => !['DB', '_worker.js', 'work.js', 'wrangler.toml', 'update-upstream.bat', '.git', '.github']
            .includes(name.split('/')[0]));
    const files = new Map();
    for (const name of names) {
        const result = spawnSync('git', ['-C', UPSTREAM_ROOT, 'show', `${reference}:${name}`]);
        assert.equal(result.status, 0, result.stderr?.toString() || name);
        files.set(name, Buffer.from(result.stdout));
    }
    return files;
}

function makeReleaseFeed(origin, version) {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        '<entry>',
        `<title>${version}</title>`,
        '<updated>2026-08-08T00:16:32Z</updated>',
        `<link href="${origin}/releases/tag/${version}"/>`,
        '</entry>',
        '</feed>'
    ].join('');
}

function directoryEntries(files, directory) {
    const prefix = directory ? `${directory}/` : '';
    const entries = new Map();
    for (const [name, bytes] of files) {
        if (!name.startsWith(prefix)) continue;
        const remainder = name.slice(prefix.length);
        if (!remainder) continue;
        const slash = remainder.indexOf('/');
        if (slash >= 0) {
            const child = remainder.slice(0, slash);
            entries.set(child, { type: 'dir', path: `${prefix}${child}` });
        } else {
            entries.set(remainder, { type: 'file', path: name, size: bytes.byteLength });
        }
    }
    return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function startUpdateMock(version) {
    const files = readUpstreamTagFiles(version);
    const requests = [];
    const server = createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        requests.push({ method: request.method, pathname: url.pathname, query: url.search });
        if (url.pathname.endsWith('/releases.atom')) {
            const origin = `http://${request.headers.host}`;
            response.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' });
            response.end(makeReleaseFeed(origin, version));
            return;
        }
        const contentsMarker = '/contents/';
        const contentsIndex = url.pathname.indexOf(contentsMarker);
        if (contentsIndex >= 0) {
            const directory = decodeURIComponent(url.pathname.slice(contentsIndex + contentsMarker.length).replace(/\/$/, ''));
            const selected = url.searchParams.get('ref') === version ? files : new Map();
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(directoryEntries(selected, directory)));
            return;
        }
        const rawMarker = '/raw/';
        const rawIndex = url.pathname.indexOf(rawMarker);
        if (rawIndex >= 0) {
            const rawPath = url.pathname.slice(rawIndex + rawMarker.length).split('/');
            const refIndex = rawPath.findIndex((part) => decodeURIComponent(part) === version);
            const fileName = refIndex >= 0
                ? rawPath.slice(refIndex + 1).map((part) => decodeURIComponent(part)).join('/')
                : '';
            const bytes = files.get(fileName) || null;
            if (!bytes) {
                response.writeHead(404);
                response.end('missing fixture');
                return;
            }
            response.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-length': String(bytes.byteLength)
            });
            response.end(bytes);
            return;
        }
        response.writeHead(404);
        response.end('not found');
    });
    const port = await listen(server);
    return { server, origin: `http://127.0.0.1:${port}`, requests, files };
}

function parseArguments(argv) {
    const options = { evidenceDir: '', targetVersion: DEFAULT_TARGET_VERSION };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--evidence-dir') options.evidenceDir = path.resolve(argv[++index]);
        else if (argv[index] === '--target-version') options.targetVersion = String(argv[++index] || '').trim();
        else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    if (!options.targetVersion) throw new Error('Target version is required.');
    return options;
}

function loadPlaywright() {
    try {
        return createRequire(import.meta.url)('playwright');
    } catch (error) {
        throw new Error('Playwright is unavailable. Install it locally or expose a bundled runtime through NODE_PATH.', { cause: error });
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
    const server = createServer();
    const port = await listen(server);
    await closeServer(server);
    return port;
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
    await Promise.race([
        once(child, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 4000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function waitForReady(origin, child, output) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited early (${child.exitCode}).\n${output.value.slice(-8000)}`);
        try {
            const response = await fetchWithTimeout(`${origin}/`, {}, 1000);
            if (response.ok) return;
        } catch {
            // Wrangler is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Wrangler did not become ready.\n${output.value.slice(-8000)}`);
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
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const name = Buffer.from(type, 'ascii');
    const payload = Buffer.from(data);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, payload])));
    return Buffer.concat([length, name, payload, checksum]);
}

function makeFixturePng(width = 640, height = 360) {
    const stride = width * 3 + 1;
    const pixels = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * stride;
        pixels[row] = 0;
        for (let x = 0; x < width; x += 1) {
            const offset = row + 1 + x * 3;
            pixels[offset] = Math.round(40 + (x / width) * 175);
            pixels[offset + 1] = Math.round(90 + (y / height) * 120);
            pixels[offset + 2] = x > width * 0.58 ? 72 : 175;
        }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(pixels)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

function startWrangler(distRoot, stateRoot, configRoot, mockOrigin, updateOrigin, port) {
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
        '--binding', `IMAGE_PROVIDER_STD_URL=${mockOrigin}`,
        '--binding', `IMAGE_PROVIDER_STA1N_URL=${mockOrigin}`,
        '--binding', `APP_UPDATE_DOWNLOAD_PROXIES=${updateOrigin}/`,
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

async function rpc(origin, action, extra = {}, timeoutMs = 180000) {
    const response = await fetchWithTimeout(`${origin}/api/rp-sync`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-rp-sync-password': PASSWORD
        },
        body: JSON.stringify({ action, ...extra })
    }, timeoutMs);
    const payload = await response.json().catch(async () => ({ error: await response.text().catch(() => '') }));
    assert.equal(response.status, 200, `${action}: ${JSON.stringify(payload)}`);
    assert.equal(payload.ok, true, `${action}: ${JSON.stringify(payload)}`);
    return payload;
}

async function readLibrary(origin) {
    const response = await fetchWithTimeout(`${origin}/image/api/library`, {
        headers: { 'x-rp-sync-password': PASSWORD }
    }, 30000);
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
}

const seedRecords = [
    ['rp_hub_character_index', { order: [CHARACTER_UUID] }],
    [`rp_hub_character_${CHARACTER_UUID}`, {
        uuid: CHARACTER_UUID,
        name: CHARACTER_NAME,
        description: 'Image overlay browser acceptance fixture.',
        first_mes: 'Hello from the image overlay fixture.',
        personality: 'Stable browser fixture.',
        mes_example: '',
        avatar: null,
        createdAt: 1_700_000_000_000,
        worldInfo: [],
        regexScripts: [],
        uiTemplates: [],
        recentGenerationTimes: []
    }],
    [`rp_hub_chat_${CHARACTER_UUID}`, [
        {
            id: 'image-overlay-user-message',
            role: 'user',
            content: '请生成验收图片。',
            isSelf: true,
            timestamp: 1_700_000_000_100
        },
        {
            id: 'image-overlay-assistant-message',
            role: 'assistant',
            content: `图片覆盖层验收\n\nimage###${IMAGE_PROMPT}###`,
            isSelf: false,
            timestamp: 1_700_000_000_200
        }
    ]],
    ['rp_hub_settings', {
        apiUrl: 'https://image-overlay.invalid/v1',
        apiKey: '',
        apiProviderId: 'custom',
        apiProviderKeys: { custom: '' },
        customApiUrl: 'https://image-overlay.invalid/v1',
        autoFetchModels: false,
        fontFamily: 'modern',
        fontFamilyVersion: 4,
        stream: true,
        imageSize: '竖图',
        imageGenCount: 2,
        freezeImageGeneration: true
    }],
    ['rp_hub_global_regex', [MODULE_REGEX_SEED]],
    ['rp_hub_global_worldinfo', [MODULE_WORLD_SEED]],
    ['rp_hub_user', {
        uuid: USER_UUID,
        name: 'Image Overlay User',
        description: 'Isolated browser fixture',
        avatar: null,
        person: 'second'
    }],
    ['rp_hub_user_profiles', [{
        uuid: USER_UUID,
        name: 'Image Overlay User',
        description: 'Isolated browser fixture',
        avatar: null,
        person: 'second'
    }]],
    ['rp_hub_active_profile_id', USER_UUID],
    ['rp_hub_last_active_char', 0]
];

async function seedBrowser(page, origin, options = {}) {
    const token = options.token === undefined ? IMAGE_TOKEN : String(options.token || '');
    const records = structuredClone(seedRecords);
    if (options.seedMode === 'pics') {
        records.find(([key]) => key === 'rp_hub_global_regex')[1] = [structuredClone(PICS_REGEX_SEED)];
        records.find(([key]) => key === 'rp_hub_global_worldinfo')[1] = [structuredClone(PICS_WORLD_SEED)];
    }
    if (options.settingsImageGenKey !== undefined) {
        records.find(([key]) => key === 'rp_hub_settings')[1].imageGenKey = String(options.settingsImageGenKey || '');
    }
    if (options.withoutImage) {
        const chat = records.find(([key]) => key === `rp_hub_chat_${CHARACTER_UUID}`)[1];
        chat[1].content = '图片模块迁移验收。';
    }
    await page.goto(`${origin}/image-overlay-seed.html`, { waitUntil: 'domcontentloaded' });
    return page.evaluate(async ({ records, token, password }) => {
        localStorage.clear();
        localStorage.setItem('roleplay_hub_update_id', '999999998');
        if (token) {
            localStorage.setItem('rp_hub_image_gen_key_v1', token);
            localStorage.setItem('rphImgKeyShadow', token);
        }
        localStorage.setItem('rp_hub_sync_password_v1', password);
        await new Promise((resolveDelete, rejectDelete) => {
            const request = indexedDB.deleteDatabase('RPHubDB');
            request.onsuccess = () => resolveDelete();
            request.onerror = () => rejectDelete(request.error);
            request.onblocked = () => rejectDelete(new Error('RPHubDB delete was blocked'));
        });
        await new Promise((resolveSeed, rejectSeed) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains('store')) request.result.createObjectStore('store');
            };
            request.onerror = () => rejectSeed(request.error);
            request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction('store', 'readwrite');
                transaction.oncomplete = () => { database.close(); resolveSeed(); };
                transaction.onerror = () => rejectSeed(transaction.error);
                for (const [key, value] of records) transaction.objectStore('store').put(value, key);
            };
        });
        return { records: records.length };
    }, { records, token, password: PASSWORD });
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

async function deleteBrowserRecord(page, key) {
    return page.evaluate((recordKey) => new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('store', 'readwrite');
            transaction.oncomplete = () => { database.close(); resolve(true); };
            transaction.onerror = () => { database.close(); reject(transaction.error); };
            transaction.objectStore('store').delete(recordKey);
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

async function seedCloseoutBrowser(page, origin) {
    await seedBrowser(page, origin, { withoutImage: true });
    const makeCharacter = (uuid, name) => ({
        uuid,
        name,
        description: `${name} closeout fixture`,
        first_mes: `Hello from ${name}`,
        personality: 'Closeout attribution fixture.',
        mes_example: '',
        avatar: null,
        createdAt: 1_700_000_001_000,
        worldInfo: [],
        regexScripts: [],
        uiTemplates: [],
        recentGenerationTimes: []
    });
    const makeChat = (name, prompt, suffix) => ([
        { id: `closeout-user-${suffix}`, role: 'user', content: `请为 ${name} 生图。`, isSelf: true },
        { id: `closeout-assistant-${suffix}`, role: 'assistant', name, content: `image###${prompt}###`, isSelf: false }
    ]);
    await writeBrowserRecord(page, 'rp_hub_character_index', { order: [CLOSEOUT_A_UUID, CLOSEOUT_B_UUID] });
    await writeBrowserRecord(page, `rp_hub_character_${CLOSEOUT_A_UUID}`, makeCharacter(CLOSEOUT_A_UUID, CLOSEOUT_A_NAME));
    await writeBrowserRecord(page, `rp_hub_character_${CLOSEOUT_B_UUID}`, makeCharacter(CLOSEOUT_B_UUID, CLOSEOUT_B_NAME));
    await writeBrowserRecord(page, `rp_hub_chat_${CLOSEOUT_A_UUID}`, makeChat(CLOSEOUT_A_NAME, CLOSEOUT_A_PROMPT, 'a'));
    await writeBrowserRecord(page, `rp_hub_chat_${CLOSEOUT_B_UUID}`, makeChat(CLOSEOUT_B_NAME, CLOSEOUT_B_PROMPT, 'b'));
    await writeBrowserRecord(page, 'rp_hub_last_active_char', CLOSEOUT_A_UUID);
    await writeBrowserRecord(page, 'rp_hub_global_regex', [structuredClone(MODULE_REGEX_SEED), structuredClone(PICS_REGEX_SEED)]);
    await writeBrowserRecord(page, 'rp_hub_global_worldinfo', [structuredClone(MODULE_WORLD_SEED)]);
}

async function waitForSyncPanel(page) {
    const syncButton = page.locator('[data-rph-sync-entry]');
    await syncButton.waitFor({ state: 'visible', timeout: 30000 });
    await syncButton.click();
    const modal = page.locator('.rp-sync-modal.is-open');
    await modal.waitFor({ state: 'visible', timeout: 10000 });
    return modal;
}

async function pushSnapshot(page) {
    const modal = await waitForSyncPanel(page);
    await modal.locator('[data-action="push"]').click();
    await page.waitForFunction(() => {
        const status = document.querySelector('.rp-sync-modal.is-open .rp-sync-modal__status');
        const push = document.querySelector('.rp-sync-modal.is-open [data-action="push"]');
        return Boolean(status && /上传成功|同一份数据/.test(status.textContent || '') && push && !push.disabled);
    }, null, { timeout: 180000 });
    await modal.locator('.rp-sync-modal__close').click();
    await modal.waitFor({ state: 'hidden', timeout: 10000 });
}

async function pullSnapshot(page) {
    const modal = await waitForSyncPanel(page);
    const navigation = page.waitForEvent('framenavigated', {
        predicate: (frame) => frame === page.mainFrame(),
        timeout: 180000
    });
    await modal.locator('[data-action="pull"]').click();
    await navigation;
    await page.waitForLoadState('domcontentloaded');
}

async function waitForRenderedImage(page) {
    await page.waitForFunction((uuid) => (
        globalThis.RPHubImageModule?.getState?.().characterUuid === uuid
    ), CHARACTER_UUID, { timeout: 60000 });
    const frame = page.locator('[data-chat-index="1"] .rp-generated-image-frame').first();
    await frame.waitFor({ state: 'visible', timeout: 60000 });
    const image = frame.locator('img');
    await image.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
        const target = document.querySelector('[data-chat-index="1"] .rp-generated-image-frame img');
        return Boolean(target?.complete && target.naturalWidth > 0 && target.naturalHeight > 0);
    }, null, { timeout: 90000 });
    return page.evaluate(() => {
        const row = document.querySelector('[data-chat-index="1"]');
        const image = row?.querySelector('.rp-generated-image-frame img');
        const moduleState = globalThis.RPHubImageModule?.getState?.() || null;
        return {
            title: document.title,
            href: location.href,
            markerRemoved: !String(row?.textContent || '').includes('image###'),
            imageWidth: image?.naturalWidth || 0,
            imageHeight: image?.naturalHeight || 0,
            imageSrc: image?.currentSrc || image?.src || '',
            moduleState
        };
    });
}

async function waitForEntryTransition(page) {
    const transition = page.locator('.entry-transition');
    await transition.waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
    await transition.waitFor({ state: 'hidden', timeout: 10000 });
}

async function inspectSidebarEntry(page) {
    return page.evaluate(() => {
        const sidebar = document.querySelector('#app .app-sidebar');
        const candidates = sidebar ? [...sidebar.querySelectorAll('button, a, [role="button"]')] : [];
        const settingsItem = candidates.find((element) => (
            !element.hasAttribute('data-rph-image-sidebar-entry')
            && String(element.textContent || '').trim() === '设置'
        )) || null;
        const entries = sidebar ? [...sidebar.querySelectorAll('[data-rph-image-sidebar-entry]')] : [];
        const entry = entries[0] || null;
        const fallback = document.querySelector('[data-rph-image-toggle]');
        const isVisible = (element) => {
            if (!(element instanceof Element)) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
                && rect.width > 0 && rect.height > 0;
        };
        return {
            entryCount: entries.length,
            entryText: String(entry?.textContent || '').trim(),
            entryTitle: entry?.getAttribute('title') || '',
            entryAfterSettings: Boolean(entry && settingsItem && settingsItem.nextElementSibling === entry),
            tagMatches: Boolean(entry && settingsItem && entry.tagName === settingsItem.tagName),
            classMatches: Boolean(entry && settingsItem
                && (entry.getAttribute('class') || '') === (settingsItem.getAttribute('class') || '')),
            iconClassMatches: Boolean(entry?.querySelector('svg') && settingsItem?.querySelector('svg')
                && (entry.querySelector('svg').getAttribute('class') || '')
                    === (settingsItem.querySelector('svg').getAttribute('class') || '')),
            entryVisible: isVisible(entry),
            fallbackVisible: isVisible(fallback),
            moduleState: globalThis.RPHubImageModule?.getState?.() || null
        };
    });
}

async function waitForSidebarEntry(page) {
    await page.waitForFunction(() => {
        const sidebar = document.querySelector('#app .app-sidebar');
        const entry = sidebar?.querySelector('[data-rph-image-sidebar-entry]');
        return Boolean(entry && globalThis.RPHubImageModule?.getState?.().entryMode === 'sidebar');
    }, null, { timeout: 30000 });
    const result = await inspectSidebarEntry(page);
    assert.equal(result.entryCount, 1, 'sidebar image entry count changed');
    assert.equal(result.entryText, '图片管理');
    assert.equal(result.entryTitle, '图片管理');
    assert.equal(result.entryAfterSettings, true, 'image entry is not immediately after settings');
    assert.equal(result.tagMatches, true, 'image entry did not clone the settings element type');
    assert.equal(result.classMatches, true, 'image entry classes diverged from settings');
    assert.equal(result.iconClassMatches, true, 'image entry icon classes diverged from settings');
    assert.equal(result.entryVisible, true, 'sidebar image entry is not visible');
    assert.equal(result.fallbackVisible, false, 'floating fallback appeared while sidebar entry was healthy');
    assert.equal(result.moduleState.entryMode, 'sidebar');
    return result;
}

async function exerciseSidebarReinsert(page) {
    const before = await waitForSidebarEntry(page);
    await page.locator('[data-rph-image-sidebar-entry]').evaluate((entry) => entry.remove());
    await page.waitForFunction(() => (
        document.querySelectorAll('#app .app-sidebar [data-rph-image-sidebar-entry]').length === 1
        && globalThis.RPHubImageModule?.getState?.().entryMode === 'sidebar'
    ), null, { timeout: 10000 });
    const after = await waitForSidebarEntry(page);
    assert.equal(await page.locator('[data-rph-image-sidebar-entry]').count(), 1, 'entry was not rebuilt exactly once');
    return { before, after, reinserted: true };
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const targetVersion = options.targetVersion;
    const { chromium } = loadPlaywright();
    const chromePath = findChrome();
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-image-overlay-e2e-'));
    const evidenceDir = options.evidenceDir || path.join(runtimeRoot, 'evidence');
    const distRoot = path.join(runtimeRoot, 'dist');
    const releaseRoot = path.join(runtimeRoot, 'release');
    const stateRoot = path.join(runtimeRoot, 'state');
    const configRoot = path.join(runtimeRoot, 'xdg-config');
    const png = makeFixturePng();
    const providerCalls = [];
    const report = {
        ok: false,
        targetVersion,
        browser: { engine: 'Chrome', executable: chromePath, controller: 'Playwright' },
        startedAt: new Date().toISOString()
    };
    let wrangler = null;
    let browser = null;
    let mockServer = null;
    let updateMock = null;
    let failure = null;

    try {
        await Promise.all([
            fs.mkdir(evidenceDir, { recursive: true }),
            fs.mkdir(configRoot, { recursive: true })
        ]);
        updateMock = await startUpdateMock(targetVersion);
        const packaged = spawnSync(process.execPath, [
            PACKAGE_SCRIPT,
            '--dist', distRoot,
            '--release-dir', releaseRoot
        ], { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
        const packageReport = JSON.parse(packaged.stdout);
        const bootstrapAssetUrl = `/DB/bootstrap.js?v=${packageReport.assetVersions['/DB/bootstrap.js']}`;
        const imageModuleAssetUrl = `/DB/image-module.js?v=${packageReport.assetVersions['/DB/image-module.js']}`;
        const workerPath = path.join(distRoot, '_worker.js');
        const workerSource = await fs.readFile(workerPath, 'utf8');
        const harnessWorker = workerSource
            .replace(
                'const APP_UPDATE_DOWNLOAD_TIMEOUT_MS = 20000;',
                'const APP_UPDATE_DOWNLOAD_TIMEOUT_MS = 2000;'
            )
            .replaceAll('https://github.com/', `${updateMock.origin}/`)
            .replaceAll('https://api.github.com/', `${updateMock.origin}/api/`)
            .replaceAll('https://raw.githubusercontent.com/', `${updateMock.origin}/raw/`);
        assert.notEqual(harnessWorker, workerSource, 'temporary app-update timeout override did not match');
        await fs.writeFile(workerPath, harnessWorker, 'utf8');
        report.harness = {
            browserPlugin: 'not available',
            appUpdateDownloadTimeoutMs: 2000,
            updateFixture: targetVersion === '1.8.1'
                ? `local git commit ${UPSTREAM_181_COMMIT} as 1.8.1`
                : `local git tag ${targetVersion}`,
            updateOrigin: updateMock.origin,
            upstreamFileCount: updateMock.files.size
        };
        await fs.writeFile(
            path.join(distRoot, 'image-overlay-seed.html'),
            '<!doctype html><html><head><meta charset="utf-8"><title>Image overlay seed</title></head><body>seed</body></html>',
            'utf8'
        );
        await fs.writeFile(
            path.join(distRoot, 'image-closeout-fixture.html'),
            `<!doctype html><html><head><meta charset="utf-8"><title>Image closeout fixture</title>
<style>body{font-family:sans-serif}.absolute{position:relative}.markdown-body{min-height:40px}.rp-generated-image-frame img{max-width:320px}</style></head><body>
<div id="app">
  <div class="absolute top-0 left-0 right-0"><div><span class="ml-2 font-medium">${CLOSEOUT_A_NAME}</span><button type="button" title="清空聊天">clear</button></div></div>
  <button id="busy-signal" type="button" title="发送">send</button>
  <div id="closeout-message" data-chat-index="1" data-role="assistant">
    <div class="msg-name-tag">${CLOSEOUT_A_NAME}</div>
    <div class="message-content-wrapper"><div class="markdown-body">image###${CLOSEOUT_A_PROMPT}###</div></div>
  </div>
</div>
<script>globalThis.__closeoutOriginalBridgeCalls=0;globalThis.RPH_R2_FLUSH_PERSISTENCE=async function closeoutOriginalBridge(){globalThis.__closeoutOriginalBridgeCalls+=1;return 'original-result';};</script>
<script src="/DB/nav-adapter.js"></script><script src="/DB/image-module.js?v=closeout"></script>
</body></html>`,
            'utf8'
        );

        mockServer = createServer((request, response) => {
            const url = new URL(request.url || '/', 'http://127.0.0.1');
            providerCalls.push({
                pathname: url.pathname,
                token: url.searchParams.get('token') || '',
                tag: url.searchParams.get('tag') || ''
            });
            if (url.pathname !== '/generate') {
                response.writeHead(404);
                response.end('not found');
                return;
            }
            if ((url.searchParams.get('tag') || '').includes('force-provider-500')) {
                response.writeHead(500, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ error: 'injected provider failure' }));
                return;
            }
            response.writeHead(200, {
                'content-type': 'image/png',
                'content-length': String(png.byteLength)
            });
            response.end(png);
        });
        const mockPort = await listen(mockServer);
        const mockOrigin = `http://127.0.0.1:${mockPort}`;
        report.harness.provider = mockOrigin;
        const pagesPort = await availablePort();
        const origin = `http://127.0.0.1:${pagesPort}`;
        const wranglerRun = startWrangler(distRoot, stateRoot, configRoot, mockOrigin, updateMock.origin, pagesPort);
        wrangler = wranglerRun.child;
        await waitForReady(origin, wrangler, wranglerRun.output);
        report.origin = origin;

        browser = await chromium.launch({
            executablePath: chromePath,
            headless: true,
            args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server']
        });
        report.keyPersistence = {};

        const migrationContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const migrationPage = await migrationContext.newPage();
        const migrationSeed = await seedBrowser(migrationPage, origin, {
            token: '',
            seedMode: 'pics',
            settingsImageGenKey: IMAGE_TOKEN,
            withoutImage: true
        });
        assert.equal(migrationSeed.records, seedRecords.length);
        await migrationPage.goto(`${origin}/?image-overlay=migration`, {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });
        await migrationPage.waitForFunction((token) => (
            globalThis.RPHubImageModule?.getState?.().autoEnabled === true
            && localStorage.getItem('rp_hub_image_gen_key_v1') === token
            && localStorage.getItem('rphImgKeyShadow') === token
        ), IMAGE_TOKEN, { timeout: 60000 });
        const migratedSettings = await readBrowserRecord(migrationPage, 'rp_hub_settings');
        const migratedRegex = await readBrowserRecord(migrationPage, 'rp_hub_global_regex');
        const migratedWorld = await readBrowserRecord(migrationPage, 'rp_hub_global_worldinfo');
        const picsRegex = migratedRegex.find((entry) => entry?.name === 'NAI画图正则');
        const picsWorld = migratedWorld.find((entry) => entry?.comment === '自动生图');
        assert.equal(migratedSettings.imageGenKey, IMAGE_TOKEN, 'settings.imageGenKey was removed after module adoption');
        assert.equal(picsRegex?.replacement, PICS_REGEX_CLEARED_REPLACEMENT,
            'pics regex migration changed parameters other than clearing token');
        assert.equal(picsRegex?.enabled, false, 'legacy pics direct-image regex remained active');
        assert.equal(picsWorld?.enabled, false, 'legacy pics world-info remained active');
        assert.ok(migratedRegex.some((entry) => entry?.name === 'RPHub 自动生图正则'));
        assert.ok(migratedWorld.some((entry) => entry?.comment === 'RPHub 自动生图'));
        report.seedMigration = {
            autoEnabled: true,
            moduleRegexInstalled: true,
            moduleWorldInstalled: true,
            legacyRegexPreservedDisabled: true,
            legacyWorldPreservedDisabled: true,
            legacyTokenCleared: true
        };
        report.keyPersistence.settingsMigration = {
            primary: await migrationPage.evaluate(() => localStorage.getItem('rp_hub_image_gen_key_v1')),
            shadow: await migrationPage.evaluate(() => localStorage.getItem('rphImgKeyShadow')),
            settingsFieldPreserved: migratedSettings.imageGenKey
        };

        await migrationPage.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await migrationPage.waitForFunction((token) => (
            globalThis.RPHubImageModule?.getState?.().persistenceFlushWrapped === true
            && localStorage.getItem('rp_hub_image_gen_key_v1') === token
            && localStorage.getItem('rphImgKeyShadow') === token
        ), IMAGE_TOKEN, { timeout: 60000 });
        const refreshedSettings = await readBrowserRecord(migrationPage, 'rp_hub_settings');
        assert.equal(refreshedSettings.imageGenKey, IMAGE_TOKEN, 'native image key disappeared after refresh');

        await writeBrowserRecord(migrationPage, 'rp_hub_settings', {
            ...refreshedSettings,
            imageGenKey: CHANGED_SETTINGS_TOKEN
        });
        await migrationPage.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await migrationPage.waitForFunction((token) => (
            localStorage.getItem('rp_hub_image_gen_key_v1') === token
            && localStorage.getItem('rphImgKeyShadow') === token
        ), CHANGED_SETTINGS_TOKEN, { timeout: 60000 });
        const changedSettings = await readBrowserRecord(migrationPage, 'rp_hub_settings');
        assert.equal(changedSettings.imageGenKey, CHANGED_SETTINGS_TOKEN, 'changed native image key was not preserved');

        await migrationPage.goto(`${origin}/image`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await migrationPage.locator('#app:not(.hidden)').waitFor({ state: 'visible', timeout: 30000 });
        await migrationPage.locator('#clearImageKey').click();
        await migrationPage.waitForFunction(() => (
            !localStorage.getItem('rp_hub_image_gen_key_v1')
            && !localStorage.getItem('rphImgKeyShadow')
        ), null, { timeout: 10000 });
        await migrationPage.goto(`${origin}/?image-overlay=key-clear-no-revival`, {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });
        await migrationPage.waitForFunction(() => (
            globalThis.RPHubImageModule?.getState?.().persistenceFlushWrapped === true
        ), null, { timeout: 30000 });
        await migrationPage.waitForTimeout(500);
        assert.equal(await migrationPage.evaluate(() => localStorage.getItem('rp_hub_image_gen_key_v1')), null,
            'cleared primary image key was revived from unchanged settings');
        assert.equal(await migrationPage.evaluate(() => localStorage.getItem('rphImgKeyShadow')), null,
            'cleared shadow image key was revived from unchanged settings');
        assert.equal((await readBrowserRecord(migrationPage, 'rp_hub_settings')).imageGenKey, CHANGED_SETTINGS_TOKEN,
            'management-page clear removed the native settings field');
        report.keyPersistence.nativeSettings = {
            inputRefreshPreserved: true,
            changedKeyAdopted: true,
            clearDidNotRevive: true,
            settingsAfterClear: CHANGED_SETTINGS_TOKEN
        };

        await migrationPage.goto(`${origin}/image-overlay-seed.html?manual-seed-delete=1`, {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });
        const persistedRegexBeforeDelete = await readBrowserRecord(migrationPage, 'rp_hub_global_regex');
        const persistedWorldBeforeDelete = await readBrowserRecord(migrationPage, 'rp_hub_global_worldinfo');
        const regexAfterManualDelete = persistedRegexBeforeDelete
            .filter((entry) => entry?.name !== 'RPHub 自动生图正则')
            .map((entry) => entry?.name === 'NAI画图正则'
                ? { ...entry, enabled: false, replacement: PICS_REGEX_CLEARED_REPLACEMENT }
                : entry);
        const worldAfterManualDelete = persistedWorldBeforeDelete
            .filter((entry) => entry?.comment !== 'RPHub 自动生图')
            .map((entry) => entry?.comment === '自动生图' ? { ...entry, enabled: false } : entry);
        await writeBrowserRecord(migrationPage, 'rp_hub_global_regex', regexAfterManualDelete);
        await writeBrowserRecord(migrationPage, 'rp_hub_global_worldinfo', worldAfterManualDelete);
        const persistedRegexAfterDelete = await readBrowserRecord(migrationPage, 'rp_hub_global_regex');
        const persistedWorldAfterDelete = await readBrowserRecord(migrationPage, 'rp_hub_global_worldinfo');
        assert.equal(persistedRegexAfterDelete.find((entry) => entry?.name === 'NAI画图正则')?.enabled, false,
            'manual deletion fixture left the legacy pics regex enabled');
        assert.equal(persistedRegexAfterDelete.find((entry) => entry?.name === 'NAI画图正则')?.replacement,
            PICS_REGEX_CLEARED_REPLACEMENT, 'manual deletion fixture restored the legacy pics token');
        assert.equal(persistedWorldAfterDelete.find((entry) => entry?.comment === '自动生图')?.enabled, false,
            'manual deletion fixture left the legacy pics world-info enabled');
        await migrationPage.goto(`${origin}/?image-overlay=manual-seed-delete`, {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });
        const [deletedSeedRegex, deletedSeedWorld] = await poll('manual seed deletion persistence', async () => {
            const values = await Promise.all([
                readBrowserRecord(migrationPage, 'rp_hub_global_regex'),
                readBrowserRecord(migrationPage, 'rp_hub_global_worldinfo')
            ]);
            const absent = !values[0].some((entry) => entry?.name === 'RPHub 自动生图正则')
                && !values[1].some((entry) => entry?.comment === 'RPHub 自动生图');
            return absent ? values : null;
        }, 15000, 250);
        assert.equal(deletedSeedRegex.some((entry) => entry?.name === 'RPHub 自动生图正则'), false,
            'manual module-regex deletion was recreated after refresh');
        assert.equal(deletedSeedWorld.some((entry) => entry?.comment === 'RPHub 自动生图'), false,
            'manual module-world deletion was recreated after refresh');
        await migrationPage.waitForFunction(() => Boolean(
            globalThis.RPHubImageModule?.getState?.().persistenceFlushWrapped
        ), null, { timeout: 30000 });
        const removedModuleUiCount = await migrationPage.locator('[data-rph-image-auto], [data-rph-image-panel], [data-rph-image-toggle]').count();
        const localRegexAfterDelete = await readBrowserRecord(migrationPage, 'rp_hub_regex') || [];
        const localWorldAfterDelete = await readBrowserRecord(migrationPage, 'rp_hub_worldinfo') || [];
        const localModuleInstalled = localRegexAfterDelete.some((entry) => entry?.name === 'RPHub 自动生图正则')
            && localWorldAfterDelete.some((entry) => entry?.comment === 'RPHub 自动生图');
        await poll('startup-settled seed module state', async () => migrationPage.evaluate((expected) => (
            globalThis.RPHubImageModule?.getState?.().autoEnabled === expected
        ), localModuleInstalled), 5000, 100);
        const manualSeedModuleState = await migrationPage.evaluate(() => globalThis.RPHubImageModule.getState());
        report.seedMigration.manualDeleteStorage = {
            globalRegex: deletedSeedRegex,
            globalWorld: deletedSeedWorld,
            localRegex: localRegexAfterDelete,
            localWorld: localWorldAfterDelete,
            legacyPreference: await migrationPage.evaluate(() => localStorage.getItem('rp_hub_image_auto_enabled_v1')),
            moduleState: manualSeedModuleState
        };
        assert.equal(manualSeedModuleState.autoEnabled, localModuleInstalled,
            `module state did not follow the four-collection seed model: ${JSON.stringify(manualSeedModuleState)}`);
        assert.equal(removedModuleUiCount, 0,
            'removed module UI returned after manual seed deletion');
        report.seedMigration.manualDeleteRefresh = {
            autoEnabled: manualSeedModuleState.autoEnabled,
            localModuleInstalled,
            removedModuleUiCount,
            moduleRegexInstalled: false,
            moduleWorldInstalled: false
        };
        await migrationContext.close();

        const remoteSeedContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const remoteSeedPage = await remoteSeedContext.newPage();
        const remoteSeed = await seedBrowser(remoteSeedPage, origin, { token: '' });
        assert.equal(remoteSeed.records, seedRecords.length);
        await remoteSeedPage.goto(`${origin}/?image-overlay=remote-without-key`, {
            waitUntil: 'domcontentloaded',
            timeout: 90000
        });
        await remoteSeedPage.waitForFunction(() => Boolean(
            globalThis.RPHubImageModule?.getState?.().characterUuid
            && document.querySelector('[data-rph-sync-entry]')
        ), null, { timeout: 60000 });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await pushSnapshot(remoteSeedPage);
        report.keyPersistence.remoteSnapshotWithoutKey = true;
        await remoteSeedContext.close();

        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const uncaught = [];
        const consoleErrors = [];
        const requests = [];
        const responses = [];
        let phase = 'seed';
        const attachPage = (target) => {
            target.on('pageerror', (error) => uncaught.push({ phase, message: error.message || String(error) }));
            target.on('console', (message) => {
                if (message.type() === 'error') consoleErrors.push({ phase, text: message.text() });
            });
            target.on('request', (request) => {
                const url = new URL(request.url());
                if (url.origin !== origin || url.pathname !== '/api/rp-image') return;
                requests.push({ phase, method: request.method(), url: url.toString(), headers: request.headers() });
            });
            target.on('response', async (response) => {
                const url = new URL(response.url());
                if (url.origin !== origin || !['/api/rp-image', '/api/rp-image-thumb'].includes(url.pathname)) return;
                responses.push({
                    phase,
                    method: response.request().method(),
                    pathname: url.pathname,
                    status: response.status(),
                    headers: await response.allHeaders()
                });
            });
        };
        context.on('page', attachPage);
        const page = await context.newPage();
        report.seed = await seedBrowser(page, origin);
        assert.equal(report.seed.records, seedRecords.length);

        phase = 'pre-generate';
        await page.goto(`${origin}/?image-overlay=pre`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        report.preGenerate = await waitForRenderedImage(page);
        assert.equal(report.preGenerate.markerRemoved, true);
        assert.equal(report.preGenerate.moduleState.characterUuid, CHARACTER_UUID);
        const settingsAfterBackfill = await poll('historical image key settings backfill', async () => {
            const value = await readBrowserRecord(page, 'rp_hub_settings');
            return value?.imageGenKey === IMAGE_TOKEN ? value : null;
        }, 15000, 250);
        assert.equal(settingsAfterBackfill.imageGenKey, IMAGE_TOKEN,
            'historical local image key was not restored to native settings');
        assert.equal(await page.evaluate(() => localStorage.getItem('rp_hub_image_gen_key_v1')), IMAGE_TOKEN,
            'historical primary image key changed during settings backfill');
        assert.equal(await page.evaluate(() => localStorage.getItem('rphImgKeyShadow')), IMAGE_TOKEN,
            'the synchronized primary key did not refresh its shadow');
        report.keyPersistence.oldUserBackfill = {
            primary: IMAGE_TOKEN,
            shadow: IMAGE_TOKEN,
            settingsField: settingsAfterBackfill.imageGenKey,
            refreshesToConverge: 1
        };
        await poll('image POST request', () => requests.some((entry) => entry.phase === 'pre-generate' && entry.method === 'POST'));
        await poll('provider call', () => providerCalls.length === 1);
        const generationRequest = requests.find((entry) => entry.phase === 'pre-generate' && entry.method === 'POST');
        assert.equal(generationRequest.headers['x-rp-image-token'], IMAGE_TOKEN);
        assert.equal(new URL(generationRequest.url).searchParams.has('token'), false, 'image token leaked into the browser URL');
        assert.equal(providerCalls[0].token, IMAGE_TOKEN);
        assert.equal(providerCalls[0].tag, IMAGE_PROMPT);

        const library = await poll('R2 image and thumbnail', async () => {
            const value = await readLibrary(origin);
            const image = value.characters?.flatMap((character) => character.images || [])[0];
            return Number(value.totalCount) === 1 && image?.hasThumb ? value : null;
        }, 90000, 250);
        report.r2 = {
            totalCount: library.totalCount,
            totalBytes: library.totalBytes,
            characterName: library.characters[0]?.name || '',
            imageKey: library.characters[0]?.images?.[0]?.key || '',
            hasThumb: Boolean(library.characters[0]?.images?.[0]?.hasThumb)
        };
        assert.match(report.r2.imageKey, /^rp-images\/characters\//);

        const records = await poll('image render record', async () => {
            const value = await readBrowserRecord(page, `rp_hub_image_renders_${CHARACTER_UUID}`);
            return Array.isArray(value) && value.length === 1 ? value : null;
        });
        assert.equal(records[0].paramsSnapshot.characterUuid, CHARACTER_UUID);
        assert.equal(Object.hasOwn(records[0].paramsSnapshot, 'token'), false);
        const [regexSeed, worldSeed] = await poll('overlay seed maintenance', async () => {
            const values = await Promise.all([
                readBrowserRecord(page, 'rp_hub_global_regex'),
                readBrowserRecord(page, 'rp_hub_global_worldinfo')
            ]);
            const hasRegex = values[0]?.some((entry) => entry?.name === 'RPHub 自动生图正则');
            const hasWorldInfo = values[1]?.some((entry) => entry?.comment === 'RPHub 自动生图');
            return hasRegex && hasWorldInfo ? values : null;
        }, 15000, 250);
        const overlayRegex = regexSeed?.find((entry) => entry?.name === 'RPHub 自动生图正则');
        const overlayWorldInfo = worldSeed?.find((entry) => entry?.comment === 'RPHub 自动生图');
        const upstreamRegex = regexSeed?.find((entry) => entry?.name === 'NAI画图正则');
        assert.equal(overlayRegex?.promptOnly, true);
        assert.match(overlayRegex?.replacement || '', /^image###\$1###$/);
        assert.match(overlayWorldInfo?.content || '', /<auto_image_gen>/);
        if (upstreamRegex) {
            assert.equal(upstreamRegex.enabled, false, 'upstream direct-image regex became active');
        }
        assert.equal(JSON.stringify(records).includes(IMAGE_TOKEN), false, 'image token entered module render records');
        assert.equal(JSON.stringify([overlayRegex, overlayWorldInfo]).includes(IMAGE_TOKEN), false,
            'image token entered module-owned seed data');

        phase = 'record-loss-reload';
        const renderRecordKey = `rp_hub_image_renders_${CHARACTER_UUID}`;
        const providerBeforeRecordLoss = providerCalls.length;
        const postsBeforeRecordLoss = requests.filter((entry) => entry.method === 'POST').length;
        const initialImageUrl = new URL(report.preGenerate.imageSrc);
        initialImageUrl.searchParams.delete('_rph_retry');
        await deleteBrowserRecord(page, renderRecordKey);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        const recordLossReload = await waitForRenderedImage(page);
        const rebuiltImageUrl = new URL(recordLossReload.imageSrc);
        rebuiltImageUrl.searchParams.delete('_rph_retry');
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(rebuiltImageUrl.toString(), initialImageUrl.toString(), 'record loss changed the deterministic render URL');
        assert.equal(providerCalls.length, providerBeforeRecordLoss, 'record loss reload called the provider');
        assert.equal(requests.filter((entry) => entry.method === 'POST').length, postsBeforeRecordLoss,
            'record loss reload generated again');
        assert.ok(responses.some((entry) => entry.phase === 'record-loss-reload'
            && entry.pathname === '/api/rp-image'
            && entry.method === 'GET'
            && entry.headers['x-rp-image-cache'] === 'HIT'), 'record loss reload did not return HIT');
        const rebuiltRecords = await poll('rebuilt image render record', async () => {
            const value = await readBrowserRecord(page, renderRecordKey);
            return Array.isArray(value) && value.length === 1 ? value : null;
        });
        assert.equal(rebuiltRecords[0].paramsSnapshot.seed, records[0].paramsSnapshot.seed,
            'record loss changed the deterministic seed');
        const recordLossLibrary = await readLibrary(origin);
        assert.equal(recordLossLibrary.characters?.[0]?.images?.[0]?.key, report.r2.imageKey,
            'record loss changed the R2 key');
        report.recordLoss = {
            imageKey: report.r2.imageKey,
            seed: rebuiltRecords[0].paramsSnapshot.seed,
            cache: 'HIT',
            providerCallsBefore: providerBeforeRecordLoss,
            providerCallsAfter: providerCalls.length
        };

        phase = 'module-reroll';
        const providerBeforeModuleReroll = providerCalls.length;
        const postsBeforeModuleReroll = requests.filter((entry) => entry.method === 'POST').length;
        await page.locator('[data-chat-index="1"] .rp-image-reroll-button').dispatchEvent('click');
        await poll('module reroll provider call', () => providerCalls.length === providerBeforeModuleReroll + 1, 90000);
        await page.waitForFunction((oldSeed) => {
            const image = document.querySelector('[data-chat-index="1"] .rp-generated-image-frame img');
            if (!image?.complete || image.naturalWidth <= 0) return false;
            try {
                return new URL(image.currentSrc || image.src, location.origin).searchParams.get('seed') !== oldSeed;
            } catch (_) {
                return false;
            }
        }, rebuiltRecords[0].paramsSnapshot.seed, { timeout: 90000 });
        const moduleRerollRender = await waitForRenderedImage(page);
        const moduleRerollUrl = new URL(moduleRerollRender.imageSrc);
        moduleRerollUrl.searchParams.delete('_rph_retry');
        assert.notEqual(moduleRerollUrl.toString(), rebuiltImageUrl.toString(), 'module reroll reused the deterministic URL');
        assert.equal(providerCalls.length, providerBeforeModuleReroll + 1, 'module reroll did not call provider exactly once');
        assert.equal(requests.filter((entry) => entry.method === 'POST').length, postsBeforeModuleReroll + 1,
            'module reroll did not issue exactly one generation POST');
        const moduleRerollRecords = await poll('module reroll record', async () => {
            const value = await readBrowserRecord(page, renderRecordKey);
            return Array.isArray(value) && value[0]?.rerollCount === 1 ? value : null;
        });
        assert.notEqual(moduleRerollRecords[0].paramsSnapshot.seed, rebuiltRecords[0].paramsSnapshot.seed,
            'module reroll did not persist a new seed');
        const moduleRerollLibrary = await poll('second R2 image after module reroll', async () => {
            const value = await readLibrary(origin);
            return Number(value.totalCount) === 2 ? value : null;
        }, 90000, 250);
        const moduleRerollKeys = moduleRerollLibrary.characters
            ?.flatMap((character) => character.images || [])
            .map((image) => image.key) || [];
        const moduleRerollImageKey = moduleRerollKeys.find((key) => key !== report.r2.imageKey) || '';
        assert.match(moduleRerollImageKey, /^rp-images\/characters\//, 'module reroll did not create a distinct R2 key');

        phase = 'module-reroll-refresh';
        const providerBeforeModuleRerollRefresh = providerCalls.length;
        const postsBeforeModuleRerollRefresh = requests.filter((entry) => entry.method === 'POST').length;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        const moduleRerollRefresh = await waitForRenderedImage(page);
        const moduleRerollRefreshUrl = new URL(moduleRerollRefresh.imageSrc);
        moduleRerollRefreshUrl.searchParams.delete('_rph_retry');
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(moduleRerollRefreshUrl.toString(), moduleRerollUrl.toString(), 'refresh lost the module reroll seed');
        assert.equal(providerCalls.length, providerBeforeModuleRerollRefresh, 'module reroll refresh called the provider');
        assert.equal(requests.filter((entry) => entry.method === 'POST').length, postsBeforeModuleRerollRefresh,
            'module reroll refresh generated again');
        assert.ok(responses.some((entry) => entry.phase === 'module-reroll-refresh'
            && entry.pathname === '/api/rp-image'
            && entry.method === 'GET'
            && entry.headers['x-rp-image-cache'] === 'HIT'), 'module reroll refresh did not return HIT');
        report.moduleReroll = {
            imageKey: moduleRerollImageKey,
            seedBefore: rebuiltRecords[0].paramsSnapshot.seed,
            seedAfter: moduleRerollRecords[0].paramsSnapshot.seed,
            rerollCount: moduleRerollRecords[0].rerollCount,
            providerCallsBefore: providerBeforeModuleReroll,
            providerCallsAfter: providerCalls.length,
            refreshCache: 'HIT'
        };

        phase = 'key-shadow-pull';
        const providerBeforeKeyPull = providerCalls.length;
        await pullSnapshot(page);
        await waitForRenderedImage(page);
        await page.waitForFunction((token) => (
            localStorage.getItem('rp_hub_image_gen_key_v1') === token
            && localStorage.getItem('rphImgKeyShadow') === token
        ), IMAGE_TOKEN, { timeout: 30000 });
        assert.equal(providerCalls.length, providerBeforeKeyPull, 'shadow-key pull recovery called the provider');
        report.keyPersistence.pullWithoutPush = {
            primary: await page.evaluate(() => localStorage.getItem('rp_hub_image_gen_key_v1')),
            shadow: await page.evaluate(() => localStorage.getItem('rphImgKeyShadow')),
            providerCallsBefore: providerBeforeKeyPull,
            providerCallsAfter: providerCalls.length,
            generationAvailable: true
        };

        phase = 'pre-cache-reload';
        const providerBeforeReload = providerCalls.length;
        const postsBeforeReload = requests.filter((entry) => entry.method === 'POST').length;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        report.preCacheReload = await waitForRenderedImage(page);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(providerCalls.length, providerBeforeReload, 'cache reload called the provider');
        assert.equal(requests.filter((entry) => entry.method === 'POST').length, postsBeforeReload, 'cache reload generated again');
        assert.ok(responses.some((entry) => entry.phase === 'pre-cache-reload'
            && entry.pathname === '/api/rp-image'
            && entry.method === 'GET'
            && entry.headers['x-rp-image-cache'] === 'HIT'), 'cache reload did not return HIT');
        await waitForEntryTransition(page);
        report.sidebar = {
            preUpdate: await exerciseSidebarReinsert(page)
        };
        const preScreenshot = path.join(evidenceDir, 'image-overlay-pre-update.png');
        await page.screenshot({ path: preScreenshot, fullPage: false });

        phase = `apply-${targetVersion}`;
        const versions = await rpc(origin, 'app-update-versions', { force: true });
        assert.ok(versions.versions?.some((entry) => entry.tag === targetVersion), `${targetVersion} was not listed`);
        const applied = await rpc(origin, 'app-update-apply', { target: targetVersion }, 300000);
        assert.equal(applied.latest?.tag, targetVersion);
        const checked = await rpc(origin, 'app-update-check');
        assert.equal(checked.current?.tag, targetVersion);
        assert.equal(checked.current?.source, 'r2');
        report.update = {
            listed: true,
            updateFixture: targetVersion === '1.8.1'
                ? `local git commit ${UPSTREAM_181_COMMIT} as 1.8.1`
                : `local git tag ${targetVersion}`,
            appliedTag: applied.latest?.tag || '',
            currentTag: checked.current?.tag || '',
            currentSource: checked.current?.source || '',
            updateAvailable: checked.updateAvailable
        };

        const updatedRoot = await (await fetchWithTimeout(`${origin}/?image-overlay=post-html`, {}, 30000)).text();
        const bootstrapIndex = updatedRoot.indexOf(bootstrapAssetUrl);
        const imageModuleIndex = updatedRoot.indexOf(imageModuleAssetUrl);
        assert.ok(bootstrapIndex >= 0 && imageModuleIndex > bootstrapIndex, 'updated HTML lost image-module injection order');
        assert.ok(updatedRoot.includes(`"tag":"${targetVersion}"`), 'updated HTML lost the target version marker');
        const moduleResponse = await fetchWithTimeout(`${origin}/DB/image-module.js?v=e2e`, {}, 30000);
        assert.equal(moduleResponse.status, 200);
        assert.match(await moduleResponse.text(), /const MODULE_VERSION = 'r2-img-1'/);

        phase = 'post-update';
        const providerBeforeUpdateReload = providerCalls.length;
        const postsBeforeUpdateReload = requests.filter((entry) => entry.method === 'POST').length;
        await page.goto(`${origin}/?image-overlay=post`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        report.postUpdate = await waitForRenderedImage(page);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(report.postUpdate.moduleState.characterUuid, CHARACTER_UUID);
        assert.equal(providerCalls.length, providerBeforeUpdateReload, `${targetVersion} reload called the provider`);
        assert.equal(requests.filter((entry) => entry.method === 'POST').length, postsBeforeUpdateReload,
            `${targetVersion} reload regenerated the image`);
        assert.ok(responses.some((entry) => entry.phase === 'post-update'
            && entry.pathname === '/api/rp-image'
            && entry.method === 'GET'
            && entry.headers['x-rp-image-cache'] === 'HIT'), `${targetVersion} image request did not return HIT`);

        await waitForEntryTransition(page);
        report.sidebar.postUpdate = await waitForSidebarEntry(page);
        const sidebarEntry = page.locator('[data-rph-image-sidebar-entry]');
        assert.equal(await page.locator('[data-rph-image-toggle], [data-rph-image-panel], [data-rph-image-auto]').count(), 0,
            'removed floating panel UI is present after update');
        const popupPromise = page.waitForEvent('popup');
        await sidebarEntry.click();
        const imageManagerPage = await popupPromise;
        await imageManagerPage.waitForURL((url) => url.pathname === '/image', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        assert.equal(new URL(imageManagerPage.url()).pathname, '/image', 'sidebar entry did not directly open /image');
        await imageManagerPage.close();
        const postScreenshot = path.join(evidenceDir, `image-overlay-post-${targetVersion}.png`);
        await page.screenshot({ path: postScreenshot, fullPage: false });

        phase = 'b2-immediate-record-flush';
        const b2BeforeRerollRecords = await readBrowserRecord(page, renderRecordKey);
        const providerBeforeB2Reroll = providerCalls.length;
        await page.locator('[data-chat-index="1"] .rp-image-reroll-button').dispatchEvent('click');
        await poll('B2 latest image provider call', () => providerCalls.length === providerBeforeB2Reroll + 1, 90000);
        const b2LatestRecords = await poll('B2 latest image record', () => readBrowserRecord(page, renderRecordKey)
            .then((value) => Array.isArray(value)
                && value[0]?.paramsSnapshot?.seed !== b2BeforeRerollRecords?.[0]?.paramsSnapshot?.seed
                ? value
                : null));
        await page.waitForFunction((expectedSeed) => {
            const image = document.querySelector('[data-chat-index="1"] .rp-generated-image-frame img');
            if (!image?.complete || image.naturalWidth <= 0) return false;
            try { return new URL(image.currentSrc || image.src, location.origin).searchParams.get('seed') === expectedSeed; }
            catch (_) { return false; }
        }, b2LatestRecords[0].paramsSnapshot.seed, { timeout: 90000 });
        await deleteBrowserRecord(page, renderRecordKey);
        const b2Flush = await page.evaluate(async ({ recordKey, expectedSeed }) => {
            const image = document.querySelector('[data-chat-index="1"] .rp-generated-image-frame img');
            if (!image) throw new Error('B2 image is missing');
            if (globalThis.RPH_R2_FLUSH_PERSISTENCE?.__rphImageFlushWrapper !== true) {
                throw new Error('B2 persistence bridge is not wrapped');
            }
            const readRecord = () => new Promise((resolve, reject) => {
                const open = indexedDB.open('RPHubDB', 1);
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const database = open.result;
                    const get = database.transaction('store', 'readonly').objectStore('store').get(recordKey);
                    get.onsuccess = () => { database.close(); resolve(get.result); };
                    get.onerror = () => { database.close(); reject(get.error); };
                };
            });
            image.dispatchEvent(new Event('load'));
            const startedAt = performance.now();
            const bridge = globalThis.RPH_R2_FLUSH_PERSISTENCE();
            let records = null;
            let writeElapsedMs = null;
            while (performance.now() - startedAt < 250) {
                records = await readRecord();
                if (Array.isArray(records) && records[0]?.paramsSnapshot?.seed === expectedSeed) {
                    writeElapsedMs = performance.now() - startedAt;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            await bridge;
            return {
                wrapped: globalThis.RPH_R2_FLUSH_PERSISTENCE?.__rphImageFlushWrapper === true,
                writeElapsedMs,
                recordCount: Array.isArray(records) ? records.length : 0,
                seed: records?.[0]?.paramsSnapshot?.seed || '',
                rerollCount: records?.[0]?.rerollCount ?? null
            };
        }, { recordKey: renderRecordKey, expectedSeed: b2LatestRecords[0].paramsSnapshot.seed });
        assert.equal(b2Flush.wrapped, true);
        assert.ok(Number.isFinite(b2Flush.writeElapsedMs) && b2Flush.writeElapsedMs < 250,
            `B2 record was not flushed before the 300 ms debounce: ${JSON.stringify(b2Flush)}`);
        assert.equal(b2Flush.seed, b2LatestRecords[0].paramsSnapshot.seed);
        assert.equal(b2Flush.rerollCount, b2LatestRecords[0].rerollCount);

        phase = 'multi-device-key-push';
        await pushSnapshot(page);
        const providerBeforeDevicePull = providerCalls.length;
        const deviceContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const devicePage = await deviceContext.newPage();
        await seedBrowser(devicePage, origin, { token: '' });
        await devicePage.goto(`${origin}/?image-overlay=device-b`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await pullSnapshot(devicePage);
        await devicePage.waitForFunction((token) => (
            localStorage.getItem('rp_hub_image_gen_key_v1') === token
            && localStorage.getItem('rphImgKeyShadow') === token
        ), IMAGE_TOKEN, { timeout: 30000 });
        const deviceRender = await waitForRenderedImage(devicePage);
        const deviceRecords = await readBrowserRecord(devicePage, renderRecordKey);
        assert.equal(deviceRecords?.[0]?.paramsSnapshot?.seed, b2LatestRecords[0].paramsSnapshot.seed,
            'device B did not pull the latest image record flushed immediately before push');
        assert.equal(deviceRecords?.[0]?.rerollCount, b2LatestRecords[0].rerollCount,
            'device B pulled a stale pre-reroll image record');
        assert.equal(deviceRender.moduleState.characterUuid, CHARACTER_UUID);
        assert.equal(providerCalls.length, providerBeforeDevicePull, 'device B pull regenerated the cached image');
        report.b2ImmediatePush = {
            debounceMs: 300,
            writeElapsedMs: b2Flush.writeElapsedMs,
            pushedSeed: b2Flush.seed,
            pulledSeed: deviceRecords?.[0]?.paramsSnapshot?.seed || '',
            pulledRerollCount: deviceRecords?.[0]?.rerollCount ?? null,
            cache: 'HIT',
            providerCallsBefore: providerBeforeDevicePull,
            providerCallsAfter: providerCalls.length
        };
        report.keyPersistence.multiDevice = {
            primary: await devicePage.evaluate(() => localStorage.getItem('rp_hub_image_gen_key_v1')),
            shadow: await devicePage.evaluate(() => localStorage.getItem('rphImgKeyShadow')),
            providerCallsBefore: providerBeforeDevicePull,
            providerCallsAfter: providerCalls.length,
            generationAvailable: true
        };
        await deviceContext.close();

        await page.setViewportSize({ width: 390, height: 844 });
        const mobileMenuButton = page.locator('button.md\\:hidden').first();
        await mobileMenuButton.waitFor({ state: 'visible', timeout: 10000 });
        await mobileMenuButton.click();
        await sidebarEntry.waitFor({ state: 'visible', timeout: 10000 });
        report.sidebar.mobile = await inspectSidebarEntry(page);
        assert.equal(report.sidebar.mobile.entryVisible, true, 'mobile drawer image entry is not visible');
        assert.equal(report.sidebar.mobile.fallbackVisible, false, 'floating fallback appeared in mobile drawer mode');
        const mobileSidebarScreenshot = path.join(evidenceDir, `image-overlay-sidebar-post-${targetVersion}-mobile.png`);
        await page.screenshot({ path: mobileSidebarScreenshot, fullPage: false });

        const mobilePopupPromise = page.waitForEvent('popup');
        await sidebarEntry.click();
        const mobileImageManagerPage = await mobilePopupPromise;
        await mobileImageManagerPage.waitForURL((url) => url.pathname === '/image', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        assert.equal(new URL(mobileImageManagerPage.url()).pathname, '/image');
        await mobileImageManagerPage.close();
        report.sidebar.mobile.directPath = '/image';
        await page.locator('[data-chat-index="1"] .rp-generated-image-frame').scrollIntoViewIfNeeded();
        const mobileScreenshot = path.join(evidenceDir, `image-overlay-post-${targetVersion}-mobile.png`);
        await page.screenshot({ path: mobileScreenshot, fullPage: false });

        await page.locator('#app .app-sidebar').evaluate((sidebar) => sidebar.remove());
        await page.waitForTimeout(1200);
        report.sidebar.noFloatingFallback = await inspectSidebarEntry(page);
        assert.equal(report.sidebar.noFloatingFallback.entryCount, 0);
        assert.equal(report.sidebar.noFloatingFallback.fallbackVisible, false, 'removed floating fallback appeared');
        assert.equal(await page.locator('#rph-image-module-root, [data-rph-image-panel], [data-rph-image-toggle]').count(), 0);
        const fallbackScreenshot = path.join(evidenceDir, 'image-overlay-sidebar-no-fallback.png');
        await page.screenshot({ path: fallbackScreenshot, fullPage: false });

        phase = 'image-admin';
        const admin = await context.newPage();
        await admin.setViewportSize({ width: 1280, height: 900 });
        await admin.goto(`${origin}/image`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await admin.locator('#app:not(.hidden)').waitFor({ state: 'visible', timeout: 30000 });
        await admin.locator('.photo').first().waitFor({ state: 'visible', timeout: 30000 });
        assert.match(await admin.title(), /角色图片管理/);
        assert.equal((await admin.locator('#imageKeyMasked').textContent())?.trim(), 'STD-••••••oken');
        assert.equal(await admin.locator('#imageKey, #saveImageKey, #toggleImageKey').count(), 0);
        assert.equal(await admin.locator('#clearImageKey').count(), 1);
        const adminScreenshot = path.join(evidenceDir, `image-overlay-admin-post-${targetVersion}.png`);
        await admin.screenshot({ path: adminScreenshot, fullPage: false });

        phase = 'closeout-attribution-freeze-toast';
        const closeoutContext = await browser.newContext({ viewport: { width: 1100, height: 760 } });
        const closeoutPage = await closeoutContext.newPage();
        await seedCloseoutBrowser(closeoutPage, origin);
        const closeoutProviderStart = providerCalls.length;
        await closeoutPage.goto(`${origin}/image-closeout-fixture.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await closeoutPage.waitForFunction(() => (
            globalThis.RPHubImageModule?.getState?.().persistenceFlushWrapped === true
        ), null, { timeout: 30000 });
        await closeoutPage.waitForFunction((prompt) => {
            const images = [...document.querySelectorAll('.rp-generated-image-frame img')];
            return images.some((image) => {
                try {
                    return new URL(image.currentSrc || image.src, location.origin).searchParams.get('tag') === prompt
                        && image.complete && image.naturalWidth > 0;
                } catch (_) { return false; }
            });
        }, CLOSEOUT_A_PROMPT, { timeout: 90000 });
        const closeoutARecords = await poll('closeout A record', () => readBrowserRecord(
            closeoutPage,
            `rp_hub_image_renders_${CLOSEOUT_A_UUID}`
        ).then((value) => Array.isArray(value) && value[0]?.paramsSnapshot?.characterUuid === CLOSEOUT_A_UUID ? value : null));
        const disabledLegacyRegex = await poll('disabled legacy NAI regex', () => readBrowserRecord(
            closeoutPage,
            'rp_hub_global_regex'
        ).then((value) => {
            const legacy = Array.isArray(value) ? value.find((item) => (item?.name || item?.scriptName) === 'NAI画图正则') : null;
            return legacy && legacy.enabled === false ? legacy : null;
        }));

        const providerBeforeBusyB = providerCalls.length;
        await closeoutPage.evaluate(({ name, prompt }) => {
            document.querySelector('.absolute span.ml-2.font-medium').textContent = name;
            document.querySelector('#closeout-message .msg-name-tag').textContent = name;
            document.querySelector('#closeout-message .markdown-body').textContent = `image###${prompt}###`;
            document.querySelector('#busy-signal').setAttribute('title', '中止生成');
        }, { name: CLOSEOUT_B_NAME, prompt: CLOSEOUT_B_PROMPT });
        await closeoutPage.evaluate(() => globalThis.RPHubImageModule.scan());
        await new Promise((resolve) => setTimeout(resolve, 150));
        const frozenState = await closeoutPage.evaluate(() => ({
            marker: document.querySelector('#closeout-message .markdown-body')?.textContent || '',
            frameCount: document.querySelectorAll('#closeout-message .rp-generated-image-frame').length,
            module: globalThis.RPHubImageModule?.getState?.() || null
        }));
        assert.match(frozenState.marker, /image###/);
        assert.equal(frozenState.frameCount, 0, 'busy conversation rendered a partial image marker');
        assert.equal(frozenState.module.busySignalSupported, true);
        assert.equal(frozenState.module.busySignalSource, 'stop-button');
        assert.equal(providerCalls.length, providerBeforeBusyB, 'busy conversation called the image provider');

        await closeoutPage.evaluate(() => {
            document.querySelector('#busy-signal').setAttribute('title', '发送');
            return globalThis.RPHubImageModule.scan();
        });
        await closeoutPage.waitForFunction((prompt) => {
            const image = document.querySelector('#closeout-message .rp-generated-image-frame img');
            if (!image?.complete || image.naturalWidth <= 0) return false;
            try { return new URL(image.currentSrc || image.src, location.origin).searchParams.get('tag') === prompt; }
            catch (_) { return false; }
        }, CLOSEOUT_B_PROMPT, { timeout: 90000 });
        const closeoutBRecords = await poll('closeout B record', () => readBrowserRecord(
            closeoutPage,
            `rp_hub_image_renders_${CLOSEOUT_B_UUID}`
        ).then((value) => Array.isArray(value) && value[0]?.paramsSnapshot?.characterUuid === CLOSEOUT_B_UUID ? value : null));
        assert.equal(closeoutBRecords[0].paramsSnapshot.characterName, CLOSEOUT_B_NAME);
        const closeoutLibrary = await poll('closeout A/B R2 groups', async () => {
            const value = await readLibrary(origin);
            const names = new Set((value.characters || []).map((character) => character.name));
            return names.has(CLOSEOUT_A_NAME) && names.has(CLOSEOUT_B_NAME) ? value : null;
        }, 90000, 100);

        const bSeedBefore = closeoutBRecords[0].paramsSnapshot.seed;
        const providerBeforeSnapshotReroll = providerCalls.length;
        await closeoutPage.evaluate((name) => {
            document.querySelector('.absolute span.ml-2.font-medium').textContent = name;
            document.querySelector('#closeout-message .msg-name-tag').textContent = name;
            document.querySelector('#closeout-message .rp-image-reroll-button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }, CLOSEOUT_A_NAME);
        await poll('snapshot-owned B reroll provider call', () => providerCalls.length === providerBeforeSnapshotReroll + 1, 90000);
        const rerolledBRecords = await poll('snapshot-owned B reroll record', () => readBrowserRecord(
            closeoutPage,
            `rp_hub_image_renders_${CLOSEOUT_B_UUID}`
        ).then((value) => Array.isArray(value) && value[0]?.rerollCount === 1 ? value : null));
        assert.equal(rerolledBRecords[0].paramsSnapshot.characterUuid, CLOSEOUT_B_UUID,
            'reroll re-inferred the visible A character instead of using the B snapshot uuid');
        assert.equal(rerolledBRecords[0].paramsSnapshot.characterName, CLOSEOUT_B_NAME);
        assert.notEqual(rerolledBRecords[0].paramsSnapshot.seed, bSeedBefore);
        const providerAfterSnapshotReroll = providerCalls.length;
        const rerolledLibrary = await poll('snapshot-owned B reroll R2 group', async () => {
            const value = await readLibrary(origin);
            const group = (value.characters || []).find((character) => character.name === CLOSEOUT_B_NAME);
            return (group?.images?.length || 0) >= 2 ? value : null;
        }, 90000, 100);

        const providerBeforeInjectedFailure = providerCalls.length;
        await writeBrowserRecord(closeoutPage, `rp_hub_chat_${CLOSEOUT_B_UUID}`, [
            { id: 'closeout-user-b', role: 'user', content: `请为 ${CLOSEOUT_B_NAME} 生图。`, isSelf: true },
            {
                id: 'closeout-assistant-b',
                role: 'assistant',
                name: CLOSEOUT_B_NAME,
                content: `image###${CLOSEOUT_FAILURE_PROMPT}###`,
                isSelf: false
            }
        ]);
        await closeoutPage.evaluate(({ name, prompt }) => {
            document.querySelector('.absolute span.ml-2.font-medium').textContent = name;
            document.querySelector('#closeout-message .msg-name-tag').textContent = name;
            document.querySelector('#closeout-message .markdown-body').textContent = `image###${prompt}###`;
            return globalThis.RPHubImageModule.scan();
        }, { name: CLOSEOUT_B_NAME, prompt: CLOSEOUT_FAILURE_PROMPT });
        await closeoutPage.waitForFunction(() => [...document.querySelectorAll('[data-rph-image-toast]')]
            .some((toast) => /图片生成失败/.test(toast.textContent || '')), null, { timeout: 30000 });
        await poll('injected provider failure call', () => providerCalls.length === providerBeforeInjectedFailure + 1, 30000);

        await writeBrowserRecord(closeoutPage, 'rp_hub_last_active_char', 'missing-closeout-character');
        const providerBeforeAttributionFailure = providerCalls.length;
        await closeoutPage.evaluate(() => {
            document.querySelector('.absolute span.ml-2.font-medium').textContent = '未知角色';
            document.querySelector('#closeout-message .msg-name-tag').textContent = '未知角色';
            document.querySelector('#closeout-message .markdown-body').textContent = 'image###must-not-generate###';
            return globalThis.RPHubImageModule.scan();
        });
        await closeoutPage.waitForFunction(() => [...document.querySelectorAll('[data-rph-image-toast]')]
            .some((toast) => /无法确认图片所属角色/.test(toast.textContent || '')), null, { timeout: 10000 });
        assert.equal(providerCalls.length, providerBeforeAttributionFailure,
            'fail-closed attribution path still called the provider');
        assert.match(await closeoutPage.locator('#closeout-message .markdown-body').textContent(), /must-not-generate/);

        const flushFailure = await closeoutPage.evaluate(async ({ uuid, name }) => {
            globalThis.RPHubImageModule.getFrozenImageRenderRecord('flush failure probe', 9, {
                messageId: 'flush-failure-probe',
                rawContent: 'flush failure probe',
                attribution: { uuid, name, source: 'test-snapshot' }
            });
            const originalTransaction = IDBDatabase.prototype.transaction;
            IDBDatabase.prototype.transaction = function (...args) {
                if (args[1] === 'readwrite') throw new Error('injected IndexedDB write failure');
                return originalTransaction.apply(this, args);
            };
            try {
                const result = await globalThis.RPH_R2_FLUSH_PERSISTENCE();
                return { result, originalCalls: globalThis.__closeoutOriginalBridgeCalls };
            } finally {
                IDBDatabase.prototype.transaction = originalTransaction;
            }
        }, { uuid: CLOSEOUT_B_UUID, name: CLOSEOUT_B_NAME });
        assert.equal(flushFailure.result, 'original-result', 'flush failure changed the original bridge result');
        assert.equal(flushFailure.originalCalls, 1, 'flush wrapper blocked or duplicated the original bridge');
        await closeoutPage.waitForFunction(() => [...document.querySelectorAll('[data-rph-image-toast]')]
            .some((toast) => /图片记录保存失败/.test(toast.textContent || '')), null, { timeout: 10000 });

        const closeoutScreenshot = path.join(evidenceDir, 'image-closeout-attribution.png');
        await closeoutPage.screenshot({ path: closeoutScreenshot, fullPage: false });
        report.closeout = {
            attribution: {
                roleA: { uuid: closeoutARecords[0].paramsSnapshot.characterUuid, name: CLOSEOUT_A_NAME },
                roleB: { uuid: closeoutBRecords[0].paramsSnapshot.characterUuid, name: CLOSEOUT_B_NAME },
                r2Groups: (closeoutLibrary.characters || [])
                    .filter((character) => [CLOSEOUT_A_NAME, CLOSEOUT_B_NAME].includes(character.name))
                    .map((character) => ({ name: character.name, images: character.images?.length || 0 }))
            },
            snapshotReroll: {
                uuid: rerolledBRecords[0].paramsSnapshot.characterUuid,
                seedBefore: bSeedBefore,
                seedAfter: rerolledBRecords[0].paramsSnapshot.seed,
                providerCallsBefore: providerBeforeSnapshotReroll,
                providerCallsAfter: providerAfterSnapshotReroll,
                r2GroupCount: (rerolledLibrary.characters || []).find((character) => character.name === CLOSEOUT_B_NAME)?.images?.length || 0
            },
            freeze: {
                supported: frozenState.module.busySignalSupported,
                source: frozenState.module.busySignalSource,
                providerCallsBefore: providerBeforeBusyB,
                providerCallsWhileBusy: providerBeforeBusyB,
                processedAfterIdle: true
            },
            legacyRegex: { retained: true, enabled: disabledLegacyRegex.enabled },
            toasts: { providerFailure: true, attributionFailure: true, flushFailure: true },
            flushFailurePassthrough: flushFailure,
            providerCalls: providerCalls.length - closeoutProviderStart,
            screenshot: closeoutScreenshot
        };
        await closeoutContext.close();

        const relevantConsoleErrors = consoleErrors.filter((entry) => !/Failed to load resource: the server responded with a status of 404/i.test(entry.text));
        assert.deepEqual(uncaught, [], 'browser emitted uncaught exceptions');
        assert.deepEqual(relevantConsoleErrors, [], 'browser emitted relevant console errors');
        report.network = {
            providerCalls: providerCalls.length,
            browserImagePosts: requests.filter((entry) => entry.method === 'POST').length,
            tokenHeaderObserved: generationRequest.headers['x-rp-image-token'] === IMAGE_TOKEN,
            cacheHitResponses: responses.filter((entry) => entry.headers['x-rp-image-cache'] === 'HIT').length,
            thumbnailUploads: responses.filter((entry) => entry.pathname === '/api/rp-image-thumb' && entry.status === 200).length
        };
        report.console = { uncaught, errors: consoleErrors, relevantErrors: relevantConsoleErrors };
        report.screenshots = [
            preScreenshot,
            postScreenshot,
            mobileSidebarScreenshot,
            mobileScreenshot,
            fallbackScreenshot,
            adminScreenshot,
            closeoutScreenshot
        ];
        report.ok = true;
    } catch (error) {
        failure = error;
        report.error = { name: error.name || 'Error', message: error.message || String(error), stack: error.stack || '' };
    } finally {
        report.finishedAt = new Date().toISOString();
        await browser?.close().catch(() => {});
        await stopProcessTree(wrangler).catch(() => {});
        await closeServer(mockServer).catch(() => {});
        await closeServer(updateMock?.server).catch(() => {});
        await fs.mkdir(evidenceDir, { recursive: true }).catch(() => {});
        await fs.writeFile(path.join(evidenceDir, 'image-overlay-e2e.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
        await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (failure) throw failure;
}

await main();
