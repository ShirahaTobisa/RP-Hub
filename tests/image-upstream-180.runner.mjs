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
const targetVersionIndex = process.argv.indexOf('--target-version');
const TARGET_VERSION = targetVersionIndex >= 0
    ? String(process.argv[targetVersionIndex + 1] || '').trim()
    : '1.8.0';
if (!['1.8.0', '1.8.1'].includes(TARGET_VERSION)) {
    throw new Error(`Unsupported upstream image E2E target: ${TARGET_VERSION}`);
}
const TARGET_SLUG = TARGET_VERSION.replaceAll('.', '');
const PASSWORD = 'rph';
const IMAGE_TOKEN = ['STA1N', `upstream-${TARGET_SLUG}-browser-token`].join('-');
const CHARACTER_UUID = '18018018-0180-4180-8180-180180180180';
const USER_UUID = '28028028-0280-4280-8280-280280280280';
const CHARACTER_NAME = `Upstream ${TARGET_VERSION} Browser Card`;
const INITIAL_PROMPT = 'solo, blue hair, moonlight, white dress';
const SEED_FILE_NAME = `image-upstream-${TARGET_SLUG}-seed.html`;
const EVIDENCE_STEM = `image-upstream-${TARGET_SLUG}`;
const NATIVE_ADOPTION_TIMEOUT_MS = Number(process.env.RPH_NATIVE_ADOPTION_TIMEOUT_MS) || 120000;

function readUpstreamTagFiles(version) {
    const reference = version === '1.8.1' ? UPSTREAM_181_COMMIT : version;
    const tree = spawnSync('git', [
        '-C', UPSTREAM_ROOT,
        'ls-tree', '-r', '--name-only', reference
    ], { encoding: 'utf8' });
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

function makeReleaseFeed(origin) {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        '<entry>',
        `<title>${TARGET_VERSION}</title>`,
        '<updated>2026-08-08T00:16:32Z</updated>',
        `<link href="${origin}/releases/tag/${TARGET_VERSION}"/>`,
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

async function startUpdateMock() {
    const files = readUpstreamTagFiles(TARGET_VERSION);
    const requests = [];
    const server = createServer((request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        requests.push({ method: request.method, pathname: url.pathname, query: url.search });
        if (url.pathname.endsWith('/releases.atom')) {
            const origin = `http://${request.headers.host}`;
            response.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' });
            response.end(makeReleaseFeed(origin));
            return;
        }
        const contentsMarker = '/contents/';
        const contentsIndex = url.pathname.indexOf(contentsMarker);
        if (contentsIndex >= 0) {
            const directory = decodeURIComponent(url.pathname.slice(contentsIndex + contentsMarker.length).replace(/\/$/, ''));
            const selected = url.searchParams.get('ref') === TARGET_VERSION ? files : new Map();
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(directoryEntries(selected, directory)));
            return;
        }
        const rawMarker = '/raw/';
        const rawIndex = url.pathname.indexOf(rawMarker);
        if (rawIndex >= 0) {
            const rawPath = url.pathname.slice(rawIndex + rawMarker.length).split('/');
            const refIndex = rawPath.findIndex((part) => decodeURIComponent(part) === TARGET_VERSION);
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
    const options = { evidenceDir: '' };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--evidence-dir') options.evidenceDir = path.resolve(argv[++index]);
        else if (argv[index] === '--target-version') index += 1;
        else throw new Error(`Unknown argument: ${argv[index]}`);
    }
    return options;
}

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

function makeFixturePng(sequence) {
    const width = 16;
    const height = 16;
    const stride = width * 3 + 1;
    const pixels = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * stride;
        pixels[row] = 0;
        for (let x = 0; x < width; x += 1) {
            const offset = row + 1 + x * 3;
            pixels[offset] = sequence % 2 ? 220 : 40;
            pixels[offset + 1] = Math.round((x / width) * 180);
            pixels[offset + 2] = sequence % 2 ? 60 : 220;
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
        '--binding', 'APP_UPDATE_MIRROR_BASE=off',
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

const NATIVE_REGEX_REPLACEMENT = `<div class="generated-image-card" style="position:relative;display:inline-flex;max-width:100%"><img src="https://nai.sta1n.cn/generate?tag=$1&token=&model=nai-diffusion-4-5-full&artist=artist%3Aupstream-${TARGET_SLUG}&size=%E7%AB%96%E5%9B%BE&steps=40&scale=6&cfg=0&sampler=k_dpmpp_2m_sde&negative=bad%20anatomy%2C%20watermark&nocache=0&noise_schedule=karras" alt="generated image"><div class="generated-image-reroll-loading" aria-hidden="true"></div><button type="button" class="generated-image-reroll" title="reroll" aria-label="reroll">&#8635;</button></div>`;

function hashFixtureText(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

const INITIAL_MESSAGE_CONTENT = `Native image fixture\n\nimage###${INITIAL_PROMPT}###`;
const INITIAL_UPSTREAM_PARAMS = {
    tag: INITIAL_PROMPT,
    model: 'nai-diffusion-4-5-full',
    artist: `artist:upstream-${TARGET_SLUG}`,
    size: '竖图',
    steps: '40',
    scale: '6',
    cfg: '0',
    sampler: 'k_dpmpp_2m_sde',
    negative: TARGET_VERSION === '1.8.1'
        ? 'bad anatomy, {missing fingers}}, {{missing legs}}, watermark'
        : 'bad anatomy, watermark',
    nocache: '0',
    noise_schedule: 'karras'
};
const initialSignatureParams = { ...INITIAL_UPSTREAM_PARAMS, provider: 'sta1n' };
const INITIAL_UPSTREAM_SIGNATURE = hashFixtureText(JSON.stringify(Object.fromEntries(
    Object.entries(initialSignatureParams).sort(([left], [right]) => left.localeCompare(right))
)));
const INITIAL_RECORD_KEY = [
    'upstream-180-assistant-message',
    hashFixtureText(INITIAL_MESSAGE_CONTENT),
    0,
    hashFixtureText(INITIAL_PROMPT)
].join(':');
const INITIAL_UPSTREAM_RECORD = {
    key: INITIAL_RECORD_KEY,
    messageId: 'upstream-180-assistant-message',
    messageIndex: 1,
    contentHash: hashFixtureText(INITIAL_MESSAGE_CONTENT),
    occurrenceIndex: 0,
    prompt: INITIAL_PROMPT,
    promptHash: hashFixtureText(INITIAL_PROMPT),
    paramsSnapshot: {
        ...INITIAL_UPSTREAM_PARAMS,
        prompt: INITIAL_PROMPT,
        source: 'upstream',
        upstreamHost: 'nai.sta1n.cn',
        upstreamParams: INITIAL_UPSTREAM_PARAMS,
        provider: 'sta1n',
        characterUuid: CHARACTER_UUID,
        characterName: CHARACTER_NAME
    },
    imageSignature: INITIAL_UPSTREAM_SIGNATURE,
    status: 'rendered',
    createdAt: 1_800_000_000_200,
    updatedAt: 1_800_000_000_200,
    rerollCount: 0
};

const seedRecords = [
    ['rp_hub_character_index', { order: [CHARACTER_UUID] }],
    [`rp_hub_character_${CHARACTER_UUID}`, {
        uuid: CHARACTER_UUID,
        name: CHARACTER_NAME,
        description: `Upstream ${TARGET_VERSION} native image adoption fixture.`,
        first_mes: 'Hello from the upstream image fixture.',
        personality: 'Stable browser fixture.',
        mes_example: '',
        avatar: null,
        createdAt: 1_800_000_000_000,
        worldInfo: [],
        regexScripts: [],
        uiTemplates: [],
        recentGenerationTimes: []
    }],
    [`rp_hub_chat_${CHARACTER_UUID}`, [
        {
            id: 'upstream-180-user-message',
            role: 'user',
            content: 'Render the native image fixture.',
            isSelf: true,
            timestamp: 1_800_000_000_100
        },
        {
            id: 'upstream-180-assistant-message',
            role: 'assistant',
            content: INITIAL_MESSAGE_CONTENT,
            isSelf: false,
            timestamp: 1_800_000_000_200
        }
    ]],
    ['rp_hub_settings', {
        apiUrl: 'https://upstream-180.invalid/v1',
        apiKey: '',
        apiProviderId: 'custom',
        apiProviderKeys: { custom: '' },
        customApiUrl: 'https://upstream-180.invalid/v1',
        autoFetchModels: false,
        fontFamily: 'modern',
        fontFamilyVersion: 4,
        stream: true,
        imageGenKey: '',
        imageStyle: 'default',
        imageSize: '竖图',
        imageGenCount: 1,
        freezeImageGeneration: true
    }],
    ['rp_hub_global_regex', [{
        name: 'NAI画图正则',
        regex: '/image###([\\s\\S]*?)###/g',
        replacement: NATIVE_REGEX_REPLACEMENT,
        placement: [2],
        markdownOnly: true,
        promptOnly: false,
        scope: 'global',
        enabled: true
    }]],
    ['rp_hub_global_worldinfo', [{
        comment: '自动生图',
        keys: [],
        content: '<auto_image_gen>native fixture</auto_image_gen>',
        constant: true,
        enabled: true,
        scope: 'global',
        position: 'at_depth',
        depth: 4,
        order: 100,
        useProbability: false,
        probability: 100
    }]],
    ['rp_hub_user', {
        uuid: USER_UUID,
        name: 'Upstream Image User',
        description: 'Isolated browser fixture',
        avatar: null,
        person: 'second'
    }],
    ['rp_hub_user_profiles', [{
        uuid: USER_UUID,
        name: 'Upstream Image User',
        description: 'Isolated browser fixture',
        avatar: null,
        person: 'second'
    }]],
    ['rp_hub_active_profile_id', USER_UUID],
    ['rp_hub_last_active_char', 0],
    [`rp_hub_image_renders_${CHARACTER_UUID}`, [INITIAL_UPSTREAM_RECORD]]
];

async function seedBrowser(page, origin) {
    await page.goto(`${origin}/${SEED_FILE_NAME}`, { waitUntil: 'domcontentloaded' });
    return page.evaluate(async ({ records, token, password }) => {
        localStorage.clear();
        localStorage.setItem('roleplay_hub_update_id', '999999998');
        localStorage.setItem('rp_hub_image_gen_key_v1', token);
        localStorage.setItem('rphImgKeyShadow', token);
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
    }, { records: seedRecords, token: IMAGE_TOKEN, password: PASSWORD });
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

async function waitForStoredUpstreamFrame(page) {
    try {
        await page.waitForFunction((uuid) => {
            const frame = document.querySelector('[data-chat-index="1"] .rp-generated-image-frame');
            const image = frame?.querySelector('img');
            const button = frame?.querySelector('.rp-image-reroll-button');
            return globalThis.RPHubImageModule?.getState?.().characterUuid === uuid
                && image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0
                && button && !button.disabled;
        }, CHARACTER_UUID, { timeout: NATIVE_ADOPTION_TIMEOUT_MS });
    } catch (error) {
        const diagnostic = await page.evaluate(() => {
            const row = document.querySelector('[data-chat-index="1"]');
            return {
                moduleState: globalThis.RPHubImageModule?.getState?.() || null,
                counters: globalThis.RPHubImageModule?.getPerformanceCounters?.() || null,
                rowHtml: row?.outerHTML?.slice(0, 8000) || '',
                rowAttributes: row ? Object.fromEntries([...row.attributes].map((item) => [item.name, item.value])) : null,
                imageSources: [...document.querySelectorAll('[data-chat-index="1"] img')]
                    .map((image) => image.currentSrc || image.src || '')
            };
        });
        error.message = `${error.message} diagnostic=${JSON.stringify(diagnostic)}`;
        throw error;
    }
    return inspectImage(page);
}

async function waitForModuleImage(page) {
    await page.waitForFunction((uuid) => {
        const image = document.querySelector('[data-chat-index="1"] .rp-generated-image-frame img');
        return globalThis.RPHubImageModule?.getState?.().characterUuid === uuid
            && image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    }, CHARACTER_UUID, { timeout: 120000 });
    return inspectImage(page);
}

async function waitForEntryTransition(page) {
    const transition = page.locator('.entry-transition');
    await transition.waitFor({ state: 'attached', timeout: 10000 }).catch(() => { });
    await transition.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => { });
}

async function inspectImage(page) {
    return page.evaluate(() => {
        const row = document.querySelector('[data-chat-index="1"]');
        const card = row?.querySelector('.generated-image-card');
        const frame = row?.querySelector('.rp-generated-image-frame');
        const image = frame?.querySelector('img');
        let tag = '';
        try { tag = new URL(image?.currentSrc || image?.src || '', location.origin).searchParams.get('tag') || ''; } catch { }
        return {
            imageSrc: image?.currentSrc || image?.src || '',
            imageWidth: image?.naturalWidth || 0,
            imageHeight: image?.naturalHeight || 0,
            tag,
            nativeCard: Boolean(card),
            nativeButtonCount: card?.querySelectorAll('.generated-image-reroll').length || 0,
            moduleButtonCount: frame?.querySelectorAll('.rp-image-reroll-button').length || 0,
            markerVisible: String(row?.textContent || '').includes('image###'),
            moduleState: globalThis.RPHubImageModule?.getState?.() || null
        };
    });
}

async function readUpstreamRecord(page) {
    return poll('upstream image render record', async () => {
        const records = await readBrowserRecord(page, `rp_hub_image_renders_${CHARACTER_UUID}`);
        if (!Array.isArray(records)) return null;
        return records.find((record) => record?.paramsSnapshot?.source === 'upstream') || null;
    }, 30000, 200);
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const { chromium } = loadPlaywright();
    const chromePath = findChrome();
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), `rph-image-upstream-${TARGET_SLUG}-`));
    const evidenceDir = options.evidenceDir || path.join(runtimeRoot, 'evidence');
    const distRoot = path.join(runtimeRoot, 'dist');
    const releaseRoot = path.join(runtimeRoot, 'release');
    const stateRoot = path.join(runtimeRoot, 'state');
    const configRoot = path.join(runtimeRoot, 'xdg-config');
    const providerCalls = [];
    const directBrowserRequests = [];
    const report = {
        ok: false,
        targetVersion: TARGET_VERSION,
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
        updateMock = await startUpdateMock();
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
            updateFixture: TARGET_VERSION === '1.8.1'
                ? `local git commit ${UPSTREAM_181_COMMIT} as 1.8.1`
                : `local git tag ${TARGET_VERSION}`,
            updateOrigin: updateMock.origin,
            upstreamFileCount: updateMock.files.size
        };
        await fs.writeFile(
            path.join(distRoot, SEED_FILE_NAME),
            '<!doctype html><html><head><meta charset="utf-8"><title>seed</title></head><body>seed</body></html>',
            'utf8'
        );

        mockServer = createServer((request, response) => {
            const url = new URL(request.url || '/', 'http://127.0.0.1');
            if (url.pathname !== '/generate') {
                response.writeHead(404);
                response.end('not found');
                return;
            }
            providerCalls.push({
                tag: url.searchParams.get('tag') || '',
                artist: url.searchParams.get('artist') || '',
                model: url.searchParams.get('model') || '',
                size: url.searchParams.get('size') || '',
                seed: url.searchParams.get('seed') || '',
                nonce: url.searchParams.get('nonce') || '',
                tokenPresent: Boolean(url.searchParams.get('token'))
            });
            const png = makeFixturePng(providerCalls.length);
            response.writeHead(200, {
                'content-type': 'image/png',
                'content-length': String(png.byteLength)
            });
            response.end(png);
        });
        const mockPort = await listen(mockServer);
        const mockOrigin = `http://127.0.0.1:${mockPort}`;
        const pagesPort = await availablePort();
        const origin = `http://127.0.0.1:${pagesPort}`;
        const wranglerRun = startWrangler(distRoot, stateRoot, configRoot, mockOrigin, updateMock.origin, pagesPort);
        wrangler = wranglerRun.child;
        await waitForReady(origin, wrangler, wranglerRun.output);
        report.origin = origin;

        const versions = await rpc(origin, 'app-update-versions', { force: true });
        assert.ok(versions.versions?.some((entry) => entry.tag === TARGET_VERSION), `${TARGET_VERSION} was not listed`);
        const applied = await rpc(origin, 'app-update-apply', { target: TARGET_VERSION }, 300000);
        assert.equal(applied.latest?.tag, TARGET_VERSION);
        const checked = await rpc(origin, 'app-update-check');
        assert.equal(checked.current?.tag, TARGET_VERSION);
        assert.equal(checked.current?.source, 'r2');
        report.update = {
            listed: true,
            appliedTag: applied.latest?.tag || '',
            currentTag: checked.current?.tag || '',
            currentSource: checked.current?.source || '',
            fixtureRequests: updateMock.requests.length
        };

        const updatedRoot = await (await fetchWithTimeout(`${origin}/`, {}, 30000)).text();
        assert.ok(
            updatedRoot.includes(`"tag":"${TARGET_VERSION}"`),
            `updated root did not expose ${TARGET_VERSION}`
        );
        assert.ok(updatedRoot.indexOf(imageModuleAssetUrl) > updatedRoot.indexOf(bootstrapAssetUrl));
        const updatedApp = await (await fetchWithTimeout(`${origin}/assets/js/app.js`, {}, 30000)).text();
        assert.match(updatedApp, /const handleGeneratedImageReroll = \(event, messageIndex\) =>/);
        assert.match(updatedApp, /const tagUrlPattern = \/\(\[\?&\]tag=\)\[\\s\\S\]\*\?\(&token=\)\//);
        if (TARGET_VERSION === '1.8.1') {
            assert.match(updatedApp, /\{missing fingers\}\},\{\{missing legs\}\}/);
            assert.match(updatedApp, /width: 100%; height: auto;[\s\S]*display: flex;/);
        }

        browser = await chromium.launch({
            executablePath: chromePath,
            headless: true,
            args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server']
        });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.route('https://nai.sta1n.cn/**', async (route) => {
            const url = new URL(route.request().url());
            const kind = url.pathname === '/api/api/getUser' ? 'quota' : 'image';
            directBrowserRequests.push({ kind, pathname: url.pathname, tag: url.searchParams.get('tag') || '' });
            if (kind === 'quota') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ status: 'ok', type: 'sta1n', data: { value: '321' } })
                });
                return;
            }
            const png = makeFixturePng(99);
            await route.fulfill({ status: 200, contentType: 'image/png', body: png });
        });
        const page = await context.newPage();
        const uncaught = [];
        const consoleErrors = [];
        const imageResponses = [];
        let phase = 'seed';
        page.on('pageerror', (error) => uncaught.push({ phase, message: error.message || String(error) }));
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push({ phase, text: message.text() });
        });
        page.on('response', async (response) => {
            const url = new URL(response.url());
            if (url.origin !== origin || url.pathname !== '/api/rp-image') return;
            imageResponses.push({
                phase,
                method: response.request().method(),
                status: response.status(),
                tag: url.searchParams.get('tag') || '',
                headers: await response.allHeaders()
            });
        });

        report.seed = await seedBrowser(page, origin);
        assert.equal(report.seed.records, seedRecords.length);
        phase = 'adopt';
        await page.goto(`${origin}/?upstream-${TARGET_SLUG}=adopt`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        report.adopt = await waitForStoredUpstreamFrame(page);
        assert.equal(report.adopt.nativeCard, false, `${TARGET_VERSION} stored upstream record unexpectedly restored a native card`);
        assert.equal(report.adopt.nativeButtonCount, 0, 'stored upstream frame retained a competing native reroll button');
        assert.equal(report.adopt.moduleButtonCount, 1, 'stored upstream frame did not expose the module SVG reroll button');
        assert.equal(report.adopt.tag, INITIAL_PROMPT);
        await poll('initial provider call', () => providerCalls.length === 1, 90000);

        const initialRecord = await readUpstreamRecord(page);
        assert.equal(initialRecord.paramsSnapshot.source, 'upstream');
        assert.equal(initialRecord.paramsSnapshot.upstreamParams.tag, INITIAL_PROMPT);
        assert.equal(initialRecord.paramsSnapshot.upstreamParams.model, 'nai-diffusion-4-5-full');
        assert.equal(initialRecord.paramsSnapshot.upstreamParams.nocache, '0');
        if (TARGET_VERSION === '1.8.1') {
            assert.ok(
                initialRecord.paramsSnapshot.upstreamParams.negative.includes('{missing fingers}}'),
                '1.8.1 adopted URL lost the accepted extra negative brace'
            );
        }
        assert.equal(Object.hasOwn(initialRecord.paramsSnapshot.upstreamParams, 'token'), false);
        assert.equal(JSON.stringify(initialRecord).includes(IMAGE_TOKEN), false, 'secret token entered the image record');
        report.initialRecord = {
            key: initialRecord.key,
            signature: initialRecord.imageSignature,
            tag: initialRecord.paramsSnapshot.upstreamParams.tag,
            params: initialRecord.paramsSnapshot.upstreamParams
        };

        phase = 'second-load-hit';
        const providerBeforeSecondLoad = providerCalls.length;
        report.secondLoad = await page.evaluate(async (src) => {
            const response = await fetch(src, { cache: 'no-store' });
            await response.arrayBuffer();
            return {
                status: response.status,
                cache: response.headers.get('x-rp-image-cache') || '',
                key: response.headers.get('x-rp-image-key') || ''
            };
        }, report.adopt.imageSrc);
        assert.equal(report.secondLoad.status, 200);
        assert.equal(report.secondLoad.cache, 'HIT');
        assert.equal(providerCalls.length, providerBeforeSecondLoad, 'second native load called the provider');

        phase = 'style-change-before-native-reroll';
        await page.evaluate(async () => {
            const app = document.querySelector('#app').__vue_app__;
            const proxy = app._instance?.proxy || app._container?._vnode?.component?.proxy;
            proxy.settings.imageStyle = 'anime';
            await globalThis.RPH_R2_FLUSH_PERSISTENCE();
        });
        assert.equal((await readBrowserRecord(page, 'rp_hub_settings')).imageStyle, 'anime');

        phase = 'native-reroll';
        const providerBeforeReroll = providerCalls.length;
        await page.locator('[data-chat-index="1"] .rp-generated-image-frame .rp-image-reroll-button').dispatchEvent('click');
        await poll('stored upstream reroll provider call', () => providerCalls.length === providerBeforeReroll + 1, 90000);
        await page.waitForFunction((oldTag) => {
            const image = document.querySelector('[data-chat-index="1"] .rp-generated-image-frame img');
            if (!image?.complete || image.naturalWidth <= 0) return false;
            try { return new URL(image.currentSrc || image.src, location.origin).searchParams.get('tag') !== oldTag; }
            catch { return false; }
        }, INITIAL_PROMPT, { timeout: 90000 });
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.equal(providerCalls.length, providerBeforeReroll + 1, 'stored upstream reroll called provider more than once');
        report.reroll = await inspectImage(page);
        assert.notEqual(report.reroll.tag, INITIAL_PROMPT, 'native reroll did not change the tag order');
        assert.equal(report.reroll.nativeButtonCount, 0);
        assert.equal(report.reroll.moduleButtonCount, 1);

        const rerolledRecord = await readUpstreamRecord(page);
        assert.equal(rerolledRecord.rerollCount, 1);
        assert.equal(rerolledRecord.paramsSnapshot.source, 'upstream');
        assert.equal(rerolledRecord.paramsSnapshot.upstreamParams.tag, report.reroll.tag);
        assert.equal(rerolledRecord.paramsSnapshot.styleKey, 'anime');
        assert.equal(rerolledRecord.paramsSnapshot.styleName, '本子里番风');
        assert.equal(rerolledRecord.paramsSnapshot.upstreamParams.artist, rerolledRecord.paramsSnapshot.artist);
        assert.notEqual(rerolledRecord.paramsSnapshot.artist, initialRecord.paramsSnapshot.artist);
        assert.equal(providerCalls[providerBeforeReroll]?.artist, rerolledRecord.paramsSnapshot.artist);
        for (const [name, value] of Object.entries(initialRecord.paramsSnapshot.upstreamParams)) {
            if (name === 'tag' || name === 'artist') continue;
            assert.deepEqual(rerolledRecord.paramsSnapshot.upstreamParams[name], value,
                `native reroll changed preserved upstream parameter ${name}`);
        }
        assert.notEqual(rerolledRecord.imageSignature, initialRecord.imageSignature);
        assert.equal(rerolledRecord.key, initialRecord.key, 'reroll should update the same persisted render record');
        report.rerollRecord = {
            key: rerolledRecord.key,
            signature: rerolledRecord.imageSignature,
            tag: rerolledRecord.paramsSnapshot.upstreamParams.tag,
            artist: rerolledRecord.paramsSnapshot.artist,
            styleKey: rerolledRecord.paramsSnapshot.styleKey,
            source: rerolledRecord.paramsSnapshot.source,
            preservedParams: Object.fromEntries(Object.entries(rerolledRecord.paramsSnapshot.upstreamParams)
                .filter(([name]) => name !== 'tag' && name !== 'artist')),
            rerollCount: rerolledRecord.rerollCount
        };

        const library = await poll('two R2 images after native reroll', async () => {
            const value = await readLibrary(origin);
            return Number(value.totalCount) === 2 ? value : null;
        }, 90000, 250);
        report.r2 = {
            totalCount: library.totalCount,
            keys: library.characters?.flatMap((character) => character.images || []).map((image) => image.key).sort() || []
        };
        assert.equal(new Set(report.r2.keys).size, 2, 'native reroll did not create a distinct R2 key');

        const screenshot = path.join(evidenceDir, `${EVIDENCE_STEM}-reroll.png`);
        await waitForEntryTransition(page);
        await page.locator('[data-chat-index="1"] .rp-generated-image-frame').scrollIntoViewIfNeeded();
        await page.screenshot({ path: screenshot, fullPage: false });
        phase = 'reroll-refresh-hit';
        const providerBeforeRefresh = providerCalls.length;
        await page.reload({ waitUntil: 'commit', timeout: 90000 });
        report.refresh = await waitForModuleImage(page);
        assert.equal(report.refresh.tag, report.reroll.tag, 'refresh lost the rerolled upstream parameters');
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.equal(providerCalls.length, providerBeforeRefresh, 'refresh regenerated the rerolled native image');
        assert.ok(imageResponses.some((entry) => entry.phase === 'reroll-refresh-hit'
            && entry.method === 'GET'
            && entry.tag === report.reroll.tag
            && entry.headers['x-rp-image-cache'] === 'HIT'), 'rerolled refresh did not return R2 HIT');

        const relevantConsoleErrors = consoleErrors.filter((entry) => (
            !/Failed to load resource: the server responded with a status of 404/i.test(entry.text)
        ));
        assert.deepEqual(uncaught, [], 'browser emitted uncaught exceptions');
        assert.deepEqual(relevantConsoleErrors, [], 'browser emitted relevant console errors');
        report.network = {
            providerCalls,
            providerCallCount: providerCalls.length,
            directBrowserRequestCount: directBrowserRequests.length,
            quotaRequestCount: directBrowserRequests.filter((entry) => entry.kind === 'quota').length,
            cacheHits: imageResponses.filter((entry) => entry.headers['x-rp-image-cache'] === 'HIT').length
        };
        assert.equal(report.network.providerCallCount, 2);
        assert.ok(report.network.quotaRequestCount > 0, 'preserved native settings key did not fetch quota');
        assert.equal(report.network.providerCalls.every((call) => call.tokenPresent), true, 'worker omitted token header forwarding');
        report.console = { uncaught, errors: consoleErrors, relevantErrors: relevantConsoleErrors };
        report.screenshot = screenshot;
        report.ok = true;
    } catch (error) {
        failure = error;
        report.error = { name: error.name || 'Error', message: error.message || String(error), stack: error.stack || '' };
    } finally {
        report.finishedAt = new Date().toISOString();
        await browser?.close().catch(() => { });
        await stopProcessTree(wrangler).catch(() => { });
        await closeServer(mockServer).catch(() => { });
        await closeServer(updateMock?.server).catch(() => { });
        await fs.mkdir(evidenceDir, { recursive: true }).catch(() => { });
        await fs.writeFile(path.join(evidenceDir, `${EVIDENCE_STEM}-e2e.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => { });
        await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => { });
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (failure) throw failure;
}

await main();
