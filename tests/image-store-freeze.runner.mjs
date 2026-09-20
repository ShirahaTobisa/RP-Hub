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
const EVIDENCE_DIR = path.join(ROOT_DIR, 'evidence', 'image-store-freeze');
const PASSWORD = 'rph';
const IMAGE_TOKEN = ['STA1N', 'image-store-freeze-token'].join('-');
const CHARACTER_UUID = 'fee10000-0000-4000-8000-000000000001';
const USER_UUID = 'fee10000-0000-4000-8000-000000000002';
const CHARACTER_NAME = '图片冻结验收角色';
const OLD_PROMPT = 'solo, frozen blue hair, moonlight, white dress';
const NEW_PROMPT = 'solo, current silver hair, morning light, black dress';
const SKIPPED_PROMPT = 'solo, skipped red hair, library, school uniform';
const NETWORK_GATE_PROMPT = 'solo, network gate green hair, observatory, winter coat';
const MODULE_REGEX_NAME = 'RPHub 自动生图正则';
const MODULE_WORLD_NAME = 'RPHub 自动生图';
const NATIVE_REGEX_NAME = 'NAI画图正则';
const NATIVE_WORLD_NAME = '自动生图';
const MIGRATION_MARKER = 'rp_hub_image_seed_retired_v1';
const PROVIDER_HOSTS = new Set(['nai.sta1n.cn', 'std.loliyc.com']);
const publicScripts = new Map();
const publicScriptHosts = new Set(['unpkg.com', 'cdn.jsdelivr.net', 'cdn.tailwindcss.com']);

function parseArguments(argv) {
    const options = { evidenceDir: EVIDENCE_DIR };
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
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 4000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
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
        for (let x = 0; x < width; x += 1) {
            const offset = row + 1 + x * 3;
            pixels[offset] = sequence % 2 ? 220 : 35;
            pixels[offset + 1] = Math.round((x / width) * 180);
            pixels[offset + 2] = sequence % 2 ? 55 : 220;
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

function startWrangler(distRoot, stateRoot, configRoot, providerOrigin, port) {
    const wranglerBin = path.resolve(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    assert.ok(existsSync(wranglerBin), `wrangler missing: ${wranglerBin}`);
    const output = { value: '' };
    const child = spawn(process.execPath, [
        wranglerBin,
        'pages', 'dev', '.',
        '--port', String(port),
        '--r2', 'RP_SYNC_R2',
        '--persist-to', stateRoot,
        '--binding', `RP_SYNC_PASSWORD=${PASSWORD}`,
        '--binding', `IMAGE_PROVIDER_STD_URL=${providerOrigin}`,
        '--binding', `IMAGE_PROVIDER_STA1N_URL=${providerOrigin}`,
        '--binding', 'APP_UPDATE_MIRROR_BASE=off',
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

function nativeRegex(enabled = false) {
    return {
        name: NATIVE_REGEX_NAME,
        regex: '/image###([\\s\\S]*?)###/g',
        replacement: `<div class="generated-image-card"><img src="https://nai.sta1n.cn/generate?tag=$1&token=${IMAGE_TOKEN}&model=nai-diffusion-4-5-full&artist=artist%3Anative-frozen&size=%E7%AB%96%E5%9B%BE&steps=40&scale=6&cfg=0&sampler=k_dpmpp_2m_sde&negative=bad%20anatomy&nocache=0&noise_schedule=karras" alt="generated image"></div>`,
        placement: [2],
        markdownOnly: true,
        promptOnly: false,
        scope: 'global',
        enabled
    };
}

function nativeWorld(enabled = false) {
    return {
        comment: NATIVE_WORLD_NAME,
        keys: [],
        content: '<auto_image_gen>native byte-preservation fixture\nline two</auto_image_gen>',
        constant: true,
        enabled,
        scope: 'global',
        position: 'at_depth',
        depth: 4,
        order: 100,
        useProbability: false,
        probability: 100
    };
}

function mainSeedRecords() {
    return [
        ['rp_hub_character_index', { order: [CHARACTER_UUID] }],
        [`rp_hub_character_${CHARACTER_UUID}`, {
            uuid: CHARACTER_UUID,
            name: CHARACTER_NAME,
            description: 'Image-store freeze browser fixture.',
            first_mes: '你好，这是图片冻结验收。',
            personality: 'Stable fixture.',
            mes_example: '',
            avatar: null,
            createdAt: 1_860_000_000_000,
            worldInfo: [],
            regexScripts: [],
            uiTemplates: [],
            recentGenerationTimes: []
        }],
        [`rp_hub_chat_${CHARACTER_UUID}`, [
            { id: 'freeze-user-0', role: 'user', content: '开始图片冻结验收。', isSelf: true, timestamp: 1_860_000_000_100 },
            { id: 'freeze-assistant-0', role: 'assistant', name: CHARACTER_NAME, content: '准备完成。', isSelf: false, timestamp: 1_860_000_000_200 }
        ]],
        ['rp_hub_settings', {
            apiUrl: 'https://freeze.invalid/v1',
            apiKey: '',
            apiProviderId: 'custom',
            apiProviderKeys: { custom: '' },
            customApiUrl: 'https://freeze.invalid/v1',
            autoFetchModels: false,
            fontFamily: 'modern',
            fontFamilyVersion: 4,
            stream: true,
            imageGenKey: IMAGE_TOKEN,
            imageStyle: 'default',
            imageSize: '竖图',
            imageGenCount: 1,
            freezeImageGeneration: true
        }],
        ['rp_hub_global_regex', [nativeRegex(false)]],
        ['rp_hub_regex', []],
        ['rp_hub_global_worldinfo', [nativeWorld(false)]],
        ['rp_hub_worldinfo', []],
        ['rp_hub_user', { uuid: USER_UUID, name: '冻结验收用户', description: '', avatar: null, person: 'second' }],
        ['rp_hub_user_profiles', [{ uuid: USER_UUID, name: '冻结验收用户', description: '', avatar: null, person: 'second' }]],
        ['rp_hub_active_profile_id', USER_UUID],
        ['rp_hub_last_active_char', 0]
    ];
}

const retiredModuleRegex = {
    name: MODULE_REGEX_NAME,
    regex: '/old-hook/g',
    replacement: 'image###$1###',
    placement: [2],
    markdownOnly: false,
    promptOnly: true,
    scope: 'global',
    enabled: false
};

const retiredModuleWorld = {
    comment: MODULE_WORLD_NAME,
    keys: ['retired'],
    content: '<auto_image_gen>retired replacement</auto_image_gen>',
    constant: true,
    enabled: true,
    scope: 'global',
    position: 'at_depth',
    depth: 4,
    order: 999
};

function migrationSeedRecords() {
    return [
        ['rp_hub_global_regex', [nativeRegex(false), structuredClone(retiredModuleRegex)]],
        ['rp_hub_regex', [structuredClone(retiredModuleRegex)]],
        ['rp_hub_global_worldinfo', [nativeWorld(false), structuredClone(retiredModuleWorld), { comment: '保留条目', content: 'keep-global', enabled: true }]],
        ['rp_hub_worldinfo', [{ comment: '角色条目', content: 'keep-local', enabled: false }, structuredClone(retiredModuleWorld)]],
        ['rp_hub_settings', { imageGenKey: '', freezeImageGeneration: true }]
    ];
}

function networkGateSeedRecords() {
    const records = mainSeedRecords();
    const chat = records.find(([key]) => key === `rp_hub_chat_${CHARACTER_UUID}`)[1];
    chat.push({
        id: 'freeze-network-gate-image',
        role: 'assistant',
        name: CHARACTER_NAME,
        content: `网络闸门\n\nimage###${NETWORK_GATE_PROMPT}###`,
        isSelf: false,
        timestamp: 1_860_000_000_300
    });
    records.find(([key]) => key === 'rp_hub_global_regex')[1].splice(0, 1, nativeRegex(true));
    records.find(([key]) => key === 'rp_hub_global_worldinfo')[1].splice(0, 1, nativeWorld(true));
    return records;
}

async function seedBrowser(page, origin, records, options = {}) {
    await page.goto(`${origin}/image-store-freeze-seed.html`, { waitUntil: 'domcontentloaded' });
    return page.evaluate(async ({ seedRecords, token, password, migrationDone }) => {
        localStorage.clear();
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_sync_password_v1', password);
        if (token) {
            localStorage.setItem('rp_hub_image_gen_key_v1', token);
            localStorage.setItem('rphImgKeyShadow', token);
            localStorage.setItem('rp_hub_image_gen_key_adopted_v1', token);
        }
        if (migrationDone) localStorage.setItem('rp_hub_image_seed_retired_v1', '1');
        await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase('RPHubDB');
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('RPHubDB delete was blocked'));
        });
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('store');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const database = request.result;
                const transaction = database.transaction('store', 'readwrite');
                for (const [key, value] of seedRecords) transaction.objectStore('store').put(value, key);
                transaction.oncomplete = () => { database.close(); resolve(); };
                transaction.onerror = () => reject(transaction.error);
            };
        });
        return { records: seedRecords.length };
    }, {
        seedRecords: records,
        token: options.token || '',
        password: PASSWORD,
        migrationDone: options.migrationDone === true
    });
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

async function setStoredImageStyle(page, imageStyle) {
    return page.evaluate((nextStyle) => new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('store', 'readwrite');
            const store = transaction.objectStore('store');
            const get = store.get('rp_hub_settings');
            get.onerror = () => reject(get.error);
            get.onsuccess = () => store.put({ ...(get.result || {}), imageStyle: nextStyle }, 'rp_hub_settings');
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.onerror = () => { database.close(); reject(transaction.error); };
        };
    }), imageStyle);
}

async function readLibrary(origin) {
    const response = await fetchWithTimeout(`${origin}/image/api/library`, {
        headers: { 'x-rp-sync-password': PASSWORD }
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
}

async function waitForApp(page) {
    try {
        await page.waitForFunction((uuid) => {
            const app = document.querySelector('#app')?.__vue_app__;
            const proxy = app?._instance?.proxy || app?._container?._vnode?.component?.proxy;
            return Boolean(proxy
                && globalThis.RPHubImageModule?.getState?.().persistenceFlushWrapped
                && typeof globalThis.RPH_R2_FLUSH_PERSISTENCE === 'function'
                && document.querySelector('button[title="自动生图开关"]'));
        }, CHARACTER_UUID, { timeout: 60000 });
    } catch (error) {
        const diagnostic = await page.evaluate(() => {
            const app = document.querySelector('#app');
            const vue = app?.__vue_app__;
            const proxy = vue?._instance?.proxy || vue?._container?._vnode?.component?.proxy;
            return {
                href: location.href,
                readyState: document.readyState,
                appPresent: Boolean(app),
                proxyPresent: Boolean(proxy),
                currentCharacterIndex: proxy?.currentCharacterIndex,
                characterUuids: Array.isArray(proxy?.characters) ? proxy.characters.map((entry) => entry?.uuid || '') : null,
                modulePresent: Boolean(globalThis.RPHubImageModule),
                moduleState: globalThis.RPHubImageModule?.getState?.() || null,
                bridgeType: typeof globalThis.RPH_R2_FLUSH_PERSISTENCE,
                bridgeWrapped: globalThis.RPH_R2_FLUSH_PERSISTENCE?.__rphImageFlushWrapper === true,
                autoButtonPresent: Boolean(document.querySelector('button[title="自动生图开关"]')),
                moduleScript: [...document.scripts].find((script) => script.src.includes('/DB/image-module.js'))?.src || '',
                bodyText: String(document.body?.innerText || '').slice(0, 1500)
            };
        }).catch((diagnosticError) => ({ diagnosticError: diagnosticError.message }));
        error.message = `${error.message} diagnostic=${JSON.stringify(diagnostic)}`;
        throw error;
    }
    await page.waitForFunction(() => {
        const app = document.querySelector('#app')?.__vue_app__;
        const proxy = app?._instance?.proxy || app?._container?._vnode?.component?.proxy;
        const scripts = proxy?.regexScripts;
        return Array.isArray(scripts) && scripts[0]?.name === 'RPHub 自动生图正则';
    }, null, { timeout: 30000 });
}

async function flushPage(page) {
    await page.evaluate(() => globalThis.RPH_R2_FLUSH_PERSISTENCE());
}

async function dismissStartupNotice(page) {
    const notice = page.locator('div.fixed.inset-0').filter({ hasText: '网站公告' }).first();
    if (!await notice.isVisible().catch(() => false)) return false;
    await notice.getByRole('button', { name: /知道了/ }).click({ timeout: 20000 });
    await notice.waitFor({ state: 'hidden', timeout: 10000 });
    return true;
}

async function nativeState(page) {
    return page.evaluate(() => {
        const app = document.querySelector('#app')?.__vue_app__;
        const proxy = app?._instance?.proxy || app?._container?._vnode?.component?.proxy;
        const regex = proxy?.regexScripts?.find((entry) => (entry?.name || entry?.scriptName) === 'NAI画图正则');
        const world = proxy?.worldInfo?.find((entry) => (entry?.comment || entry?.name) === '自动生图');
        return {
            autoEnabled: world?.enabled === true,
            regexEnabled: regex?.enabled === true,
            regexReplacement: String(regex?.replacement || ''),
            hookFirst: proxy?.regexScripts?.[0]?.name === 'RPHub 自动生图正则',
            module: globalThis.RPHubImageModule?.getState?.() || null
        };
    });
}

async function exerciseMaintenanceCycles(page, count = 3) {
    for (let index = 0; index < count; index += 1) {
        await page.evaluate(() => {
            const app = document.querySelector('#app')?.__vue_app__;
            const proxy = app?._instance?.proxy || app?._container?._vnode?.component?.proxy;
            const scripts = proxy?.regexScripts;
            if (Array.isArray(scripts)) {
                const hook = scripts.find((entry) => entry?.name === 'RPHub 自动生图正则');
                scripts.splice(0, scripts.length, ...scripts.filter((entry) => entry !== hook));
                if (hook) scripts.push(hook);
            }
            const node = document.createElement('span');
            node.textContent = 'maintenance-cycle';
            document.body.appendChild(node);
            node.remove();
            dispatchEvent(new StorageEvent('storage', { key: `freeze-cycle-${Date.now()}`, newValue: String(Math.random()) }));
        });
        await page.waitForFunction(() => (
            (document.querySelector('#app')?.__vue_app__?._instance?.proxy
                || document.querySelector('#app')?.__vue_app__?._container?._vnode?.component?.proxy)
                ?.regexScripts?.[0]?.name === 'RPHub 自动生图正则'
        ));
        await page.waitForTimeout(1300);
    }
}

async function setNativeAuto(page, enabled) {
    const current = await nativeState(page);
    if (current.autoEnabled !== enabled) await page.locator('button[title="自动生图开关"]').click();
    await page.waitForFunction((expected) => {
        const app = document.querySelector('#app')?.__vue_app__;
        const proxy = app?._instance?.proxy || app?._container?._vnode?.component?.proxy;
        const world = proxy?.worldInfo?.find((entry) => (entry?.comment || entry?.name) === '自动生图');
        return world?.enabled === expected && globalThis.RPHubImageModule?.getState?.().autoEnabled === expected;
    }, enabled, { timeout: 15000 });
    await flushPage(page);
}

async function appendImageMessage(page, id, prompt) {
    const index = await page.evaluate(({ messageId, imagePrompt, characterName }) => {
        const app = document.querySelector('#app')?.__vue_app__;
        const proxy = app?._instance?.proxy || app?._container?._vnode?.component?.proxy;
        proxy.chatHistory.push({
            id: messageId,
            role: 'assistant',
            name: characterName,
            content: `图片 ${messageId}\n\nimage###${imagePrompt}###`,
            isSelf: false,
            timestamp: Date.now(),
            skipReveal: true
        });
        return proxy.chatHistory.length - 1;
    }, { messageId: id, imagePrompt: prompt, characterName: CHARACTER_NAME });
    await flushPage(page);
    await page.evaluate(() => globalThis.RPHubImageModule.scan());
    return index;
}

async function readPromptRecord(page, prompt) {
    const records = await readBrowserRecord(page, `rp_hub_image_renders_${CHARACTER_UUID}`);
    return Array.isArray(records) ? records.find((record) => record?.prompt === prompt) || null : null;
}

async function waitForPromptRecord(page, prompt, predicate = () => true) {
    return poll(`record for ${prompt}`, async () => {
        const record = await readPromptRecord(page, prompt);
        return record && predicate(record) ? record : null;
    }, 60000, 200);
}

async function waitForPromptImage(page, prompt) {
    await page.waitForFunction((expected) => [...document.querySelectorAll('.rp-generated-image-frame img')].some((image) => {
        try {
            const url = new URL(image.currentSrc || image.src, location.origin);
            return url.searchParams.get('tag') === expected && image.complete && image.naturalWidth > 0;
        } catch {
            return false;
        }
    }), prompt, { timeout: 90000 });
    return page.evaluate((expected) => {
        const image = [...document.querySelectorAll('.rp-generated-image-frame img')].find((candidate) => {
            try { return new URL(candidate.currentSrc || candidate.src, location.origin).searchParams.get('tag') === expected; }
            catch { return false; }
        });
        const frame = image?.closest('.rp-generated-image-frame');
        return {
            src: image?.currentSrc || image?.src || '',
            key: frame?.getAttribute('data-image-render-key') || '',
            signature: frame?.getAttribute('data-image-signature') || '',
            characterUuid: frame?.getAttribute('data-character-uuid') || ''
        };
    }, prompt);
}

async function successfulImageResponse(responses, startIndex, prompt) {
    return poll(`successful image response for ${prompt}`, () => {
        const matches = responses.slice(startIndex).filter((entry) => entry.method === 'GET'
            && entry.status === 200 && entry.tag === prompt && entry.r2Key);
        return matches.at(-1) || null;
    }, 60000, 100);
}

async function assertPromptResponsesHit(responses, startIndex, prompts, label) {
    const expectedPrompts = Array.isArray(prompts) ? prompts : [prompts];
    const matches = await poll(`${label} image responses`, () => {
        const candidates = responses.slice(startIndex).filter((entry) => entry.method === 'GET'
            && entry.status === 200 && entry.r2Key && expectedPrompts.includes(entry.tag));
        return expectedPrompts.every((prompt) => candidates.some((entry) => entry.tag === prompt))
            ? candidates
            : null;
    }, 60000, 100);
    assert.equal(matches.every((entry) => entry.cache === 'HIT'), true,
        `${label} included a non-HIT response: ${JSON.stringify(matches)}`);
    return matches;
}

async function installBrowserInstrumentation(context, options = {}) {
    context.on('response', response => {
        if (!response.ok() || response.request().resourceType() !== 'script'
            || !publicScriptHosts.has(new URL(response.url()).hostname) || publicScripts.has(response.url())) return;
        const cached = response.body().then(body => ({ contentType: 'text/javascript', body })).catch(() => null);
        for (let request = response.request(); request; request = request.redirectedFrom()) publicScripts.set(request.url(), cached);
    });
    await context.route(url => publicScriptHosts.has(url.hostname), async route => {
        const cached = await publicScripts.get(route.request().url());
        return cached ? route.fulfill(cached) : route.continue();
    });
    const writes = [];
    await context.exposeBinding('__rphTrackIdbWrite', ({ frame }, entry) => {
        if (entry?.barrier) return true;
        writes.push({ ...entry, documentUrl: frame.url() });
        return true;
    });
    await context.addInitScript(({ migrationPath }) => {
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
            const stack = String(new Error().stack || '');
            const firstOwner = stack.match(/(?:https?:\/\/[^/]+)?\/(DB\/image-module\.js|assets\/js\/app\.js|DB\/bootstrap\.js)(?:\?[^:\s)]*)?/i)?.[1] || '';
            void globalThis.__rphTrackIdbWrite({
                key: String(args[1] || ''),
                owner: firstOwner,
                stack: stack.slice(0, 1200)
            });
            return originalPut.apply(this, args);
        };
        if (migrationPath && new URLSearchParams(location.search).get('pull') === '1') {
            globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
        }
    }, { migrationPath: options.migrationPath || '' });
    return { writes };
}

async function snapshotTrackedWrites(page, writes) {
    await page.evaluate(() => globalThis.__rphTrackIdbWrite({ barrier: true }));
    return writes.slice();
}

async function runMigrationScenario(browser, origin) {
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const { writes } = await installBrowserInstrumentation(context, { migrationPath: '/image-store-freeze-migration.html' });
    const page = await context.newPage();
    try {
        const seed = migrationSeedRecords();
        const nativeRegexBefore = JSON.stringify(seed.find(([key]) => key === 'rp_hub_global_regex')[1][0]);
        const nativeWorldBefore = JSON.stringify(seed.find(([key]) => key === 'rp_hub_global_worldinfo')[1][0]);
        await seedBrowser(page, origin, seed);

        const pullWriteStart = (await snapshotTrackedWrites(page, writes)).length;
        await page.goto(`${origin}/image-store-freeze-migration.html?pull=1`, { waitUntil: 'domcontentloaded' });
        assert.equal(await page.evaluate(() => globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS), true,
            'pull-restore fixture did not establish the migration guard');
        await page.waitForFunction(() => Boolean(globalThis.RPHubImageModule?.getState));
        await page.waitForTimeout(1800);
        const pullWrites = (await snapshotTrackedWrites(page, writes)).slice(pullWriteStart);
        assert.equal(localStorageValue(await page.evaluate((marker) => localStorage.getItem(marker), MIGRATION_MARKER)), '');
        assert.deepEqual(await readBrowserRecord(page, 'rp_hub_global_worldinfo'), seed.find(([key]) => key === 'rp_hub_global_worldinfo')[1]);
        assert.equal(pullWrites.filter((entry) => entry.owner === 'DB/image-module.js').length, 0,
            'pull-restore guard allowed module persistence');

        const firstWriteStart = (await snapshotTrackedWrites(page, writes)).length;
        await page.goto(`${origin}/image-store-freeze-migration.html?pull=0`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((marker) => localStorage.getItem(marker) === '1', MIGRATION_MARKER, { timeout: 15000 });
        const firstWrites = (await snapshotTrackedWrites(page, writes)).slice(firstWriteStart);
        const globalRegex = await readBrowserRecord(page, 'rp_hub_global_regex');
        const localRegex = await readBrowserRecord(page, 'rp_hub_regex');
        const globalWorld = await readBrowserRecord(page, 'rp_hub_global_worldinfo');
        const localWorld = await readBrowserRecord(page, 'rp_hub_worldinfo');
        assert.equal(globalRegex[0]?.name, MODULE_REGEX_NAME);
        assert.equal(globalRegex[0]?.replacement, 'rph-image-marker###$1###');
        assert.equal(globalRegex.find((entry) => entry?.name === NATIVE_REGEX_NAME)?.enabled, false);
        assert.equal(JSON.stringify(globalRegex.find((entry) => entry?.name === NATIVE_REGEX_NAME)), nativeRegexBefore);
        assert.equal(localRegex.some((entry) => entry?.name === MODULE_REGEX_NAME), false);
        assert.equal(globalWorld.some((entry) => entry?.comment === MODULE_WORLD_NAME), false);
        assert.equal(localWorld.some((entry) => entry?.comment === MODULE_WORLD_NAME), false);
        assert.equal(JSON.stringify(globalWorld.find((entry) => entry?.comment === NATIVE_WORLD_NAME)), nativeWorldBefore);
        const firstModuleWorldWrites = firstWrites.filter((entry) => entry.owner === 'DB/image-module.js'
            && /^rp_hub_(?:global_)?worldinfo$/.test(entry.key));
        assert.deepEqual(firstModuleWorldWrites.map((entry) => entry.key).sort(), ['rp_hub_global_worldinfo', 'rp_hub_worldinfo']);

        const secondWriteStart = (await snapshotTrackedWrites(page, writes)).length;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => Boolean(globalThis.RPHubImageModule?.getState));
        await page.waitForTimeout(1800);
        const secondWrites = (await snapshotTrackedWrites(page, writes)).slice(secondWriteStart);
        const secondModuleWorldWrites = secondWrites.filter((entry) => entry.owner === 'DB/image-module.js'
            && /^rp_hub_(?:global_)?worldinfo$/.test(entry.key));
        assert.deepEqual(secondModuleWorldWrites, [], 'retirement migration wrote world-info twice');
        assert.equal(JSON.stringify((await readBrowserRecord(page, 'rp_hub_global_worldinfo'))
            .find((entry) => entry?.comment === NATIVE_WORLD_NAME)), nativeWorldBefore);

        return {
            pullRestore: { moduleWrites: 0, markerWritten: false },
            firstRun: {
                worldWrites: firstModuleWorldWrites.map((entry) => entry.key).sort(),
                retiredGlobalRemoved: true,
                retiredLocalRemoved: true,
                nativeRegexBytePreserved: true,
                nativeWorldBytePreserved: true,
                nativeRemainedDisabled: true,
                hookNormalizedFirst: true
            },
            secondRun: { worldWrites: 0, idempotent: true }
        };
    } finally {
        await context.close();
    }
}

function localStorageValue(value) {
    return value == null ? '' : String(value);
}

async function runMainScenario(browser, origin, providerCalls) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const { writes } = await installBrowserInstrumentation(context);
    const providerDomainRequests = [];
    let phase = 'seed';
    for (const host of PROVIDER_HOSTS) {
        await context.route(`https://${host}/**`, async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            const resourceType = request.resourceType();
            const kind = url.pathname === '/generate' || resourceType === 'image'
                ? 'direct-image'
                : (url.pathname === '/api/api/getUser' ? 'quota' : 'status');
            providerDomainRequests.push({ phase, host, method: request.method(), resourceType, kind, url: request.url() });
            if (kind === 'quota') {
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', type: 'sta1n', data: { value: '321' } }) });
            } else if (kind === 'status') {
                await route.fulfill({ status: 204 });
            } else {
                await route.fulfill({ status: 200, contentType: 'image/png', body: makeFixturePng(99) });
            }
        });
    }
    const page = await context.newPage();
    const responses = [];
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push({ phase, message: error.message || String(error) }));
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push({ phase, text: message.text() });
    });
    page.on('response', async (response) => {
        const url = new URL(response.url());
        if (url.origin !== origin || url.pathname !== '/api/rp-image') return;
        const headers = await response.allHeaders();
        responses.push({
            phase,
            method: response.request().method(),
            status: response.status(),
            tag: url.searchParams.get('tag') || '',
            artist: url.searchParams.get('artist') || '',
            seed: url.searchParams.get('seed') || '',
            cache: headers['x-rp-image-cache'] || '',
            r2Key: headers['x-rp-image-key'] || ''
        });
    });

    try {
        await seedBrowser(page, origin, mainSeedRecords(), { token: IMAGE_TOKEN, migrationDone: true });
        const scenarioWriteStart = (await snapshotTrackedWrites(page, writes)).length;
        phase = 'startup-off';
        await page.goto(`${origin}/?image-store-freeze=main`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForApp(page);
        await dismissStartupNotice(page);
        const startupState = await nativeState(page);
        assert.equal(startupState.autoEnabled, false);
        assert.equal(startupState.module.autoEnabled, false);
        assert.equal(startupState.regexEnabled, false);
        assert.equal(startupState.hookFirst, true);
        assert.match(startupState.regexReplacement, new RegExp(`token=${IMAGE_TOKEN}`));

        phase = 'switch-on-persist';
        await setNativeAuto(page, true);
        await exerciseMaintenanceCycles(page, 3);
        await flushPage(page);
        let state = await nativeState(page);
        assert.equal(state.autoEnabled, true);
        assert.equal(state.regexEnabled, true);
        assert.match(state.regexReplacement, new RegExp(`token=${IMAGE_TOKEN}`));
        const providerBeforeOnRefresh = providerCalls.length;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForApp(page);
        state = await nativeState(page);
        assert.equal(state.autoEnabled, true);
        assert.equal(state.module.autoEnabled, true);
        assert.equal(state.regexEnabled, true);
        assert.match(state.regexReplacement, new RegExp(`token=${IMAGE_TOKEN}`));
        assert.equal(providerCalls.length, providerBeforeOnRefresh);

        phase = 'switch-off-persist';
        await setNativeAuto(page, false);
        await exerciseMaintenanceCycles(page, 3);
        await flushPage(page);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForApp(page);
        state = await nativeState(page);
        assert.equal(state.autoEnabled, false);
        assert.equal(state.module.autoEnabled, false);
        assert.match(state.regexReplacement, new RegExp(`token=${IMAGE_TOKEN}`));

        phase = 'switch-on-for-generation';
        await setNativeAuto(page, true);
        await exerciseMaintenanceCycles(page, 2);
        await flushPage(page);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForApp(page);
        assert.equal((await nativeState(page)).autoEnabled, true);

        phase = 'old-create';
        const oldProviderStart = providerCalls.length;
        const oldResponseStart = responses.length;
        await appendImageMessage(page, 'freeze-old-image', OLD_PROMPT);
        await poll('old image provider call', () => providerCalls.length === oldProviderStart + 1, 90000);
        const oldImage = await waitForPromptImage(page, OLD_PROMPT);
        await page.evaluate(() => globalThis.RPHubImageModule.flushRecords());
        const oldRecord = await waitForPromptRecord(page, OLD_PROMPT, (record) => record.status === 'rendered');
        const oldResponse = await successfulImageResponse(responses, oldResponseStart, OLD_PROMPT);
        assert.equal(providerCalls.length, oldProviderStart + 1);
        assert.equal(oldImage.characterUuid, CHARACTER_UUID);
        assert.ok(oldRecord.paramsSnapshot.artist);
        assert.equal(providerCalls[oldProviderStart]?.artist, oldRecord.paramsSnapshot.artist);
        assert.equal(oldResponse.cache, 'HIT');
        const oldPostGenerationResponseStart = responses.length;

        phase = 'old-style-drift';
        const providerBeforeStyle = providerCalls.length;
        const styleResponseStart = responses.length;
        await page.evaluate(() => {
            const app = document.querySelector('#app').__vue_app__;
            const proxy = app._instance?.proxy || app._container?._vnode?.component?.proxy;
            proxy.settings.imageStyle = 'anime';
        });
        await flushPage(page);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForApp(page);
        const oldAfterStyle = await waitForPromptImage(page, OLD_PROMPT);
        const oldStyleResponses = await assertPromptResponsesHit(responses, styleResponseStart, OLD_PROMPT, 'style refresh');
        const oldRecordAfterStyle = await waitForPromptRecord(page, OLD_PROMPT);
        assert.equal(providerCalls.length, providerBeforeStyle, 'style drift regenerated an old image');
        assert.equal(oldRecordAfterStyle.imageSignature, oldRecord.imageSignature);
        assert.equal(oldRecordAfterStyle.paramsSnapshot.artist, oldRecord.paramsSnapshot.artist);
        assert.equal(new URL(oldAfterStyle.src).searchParams.get('artist'), oldRecord.paramsSnapshot.artist);
        assert.equal(oldStyleResponses.every((entry) => entry.artist === oldRecord.paramsSnapshot.artist), true);

        phase = 'old-switch-cycle';
        const providerBeforeSwitchCycle = providerCalls.length;
        const switchResponseStart = responses.length;
        await setNativeAuto(page, false);
        await exerciseMaintenanceCycles(page, 2);
        await setNativeAuto(page, true);
        await exerciseMaintenanceCycles(page, 2);
        await flushPage(page);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForApp(page);
        const oldAfterSwitch = await waitForPromptImage(page, OLD_PROMPT);
        const oldSwitchResponses = await assertPromptResponsesHit(responses, switchResponseStart, OLD_PROMPT, 'off/on refresh');
        assert.equal(providerCalls.length, providerBeforeSwitchCycle, 'off/on cycle regenerated an old image');
        assert.equal(new URL(oldAfterSwitch.src).searchParams.get('artist'), oldRecord.paramsSnapshot.artist);
        assert.equal(oldSwitchResponses.every((entry) => entry.artist === oldRecord.paramsSnapshot.artist), true);

        phase = 'new-create';
        const newProviderStart = providerCalls.length;
        const newResponseStart = responses.length;
        await appendImageMessage(page, 'freeze-new-image', NEW_PROMPT);
        await poll('new image provider call', () => providerCalls.length === newProviderStart + 1, 90000);
        await waitForPromptImage(page, NEW_PROMPT);
        await page.evaluate(() => globalThis.RPHubImageModule.flushRecords());
        const newRecord = await waitForPromptRecord(page, NEW_PROMPT, (record) => record.status === 'rendered');
        const newResponse = await successfulImageResponse(responses, newResponseStart, NEW_PROMPT);
        assert.equal(providerCalls.length, newProviderStart + 1, 'new image did not call provider exactly once');
        assert.notEqual(newRecord.paramsSnapshot.artist, oldRecord.paramsSnapshot.artist);
        assert.equal(providerCalls[newProviderStart]?.artist, newRecord.paramsSnapshot.artist);
        assert.equal(newResponse.cache, 'HIT');

        phase = 'skipped-create';
        await setNativeAuto(page, false);
        const skippedProviderStart = providerCalls.length;
        await appendImageMessage(page, 'freeze-skipped-image', SKIPPED_PROMPT);
        await page.waitForTimeout(1000);
        await page.evaluate(() => globalThis.RPHubImageModule.flushRecords());
        const skippedRecord = await waitForPromptRecord(page, SKIPPED_PROMPT, (record) => record.status === 'skipped');
        assert.equal(providerCalls.length, skippedProviderStart);
        assert.equal(skippedRecord.status, 'skipped');
        assert.equal(await page.locator('.rp-generated-image-frame img').evaluateAll((images, prompt) => images.filter((image) => {
            try { return new URL(image.currentSrc || image.src, location.origin).searchParams.get('tag') === prompt; }
            catch { return false; }
        }).length, SKIPPED_PROMPT), 0);

        phase = 'skipped-reenable';
        const reenableResponseStart = responses.length;
        await setNativeAuto(page, true);
        await flushPage(page);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForApp(page);
        await waitForPromptImage(page, OLD_PROMPT);
        await waitForPromptImage(page, NEW_PROMPT);
        await assertPromptResponsesHit(responses, reenableResponseStart, [OLD_PROMPT, NEW_PROMPT], 'skipped re-enable refresh');
        await page.evaluate(() => globalThis.RPHubImageModule.scan());
        await page.waitForTimeout(800);
        assert.equal(providerCalls.length, skippedProviderStart, 're-enable revived a skipped record');
        assert.equal((await waitForPromptRecord(page, SKIPPED_PROMPT)).status, 'skipped');

        phase = 'explicit-reroll';
        const rerollProviderStart = providerCalls.length;
        const rerollResponseStart = responses.length;
        const beforeReroll = await waitForPromptRecord(page, NEW_PROMPT);
        await setStoredImageStyle(page, 'galgame');
        const liveStyleBeforeReroll = await page.evaluate(() => {
            const app = document.querySelector('#app').__vue_app__;
            const proxy = app._instance?.proxy || app._container?._vnode?.component?.proxy;
            return proxy.settings.imageStyle;
        });
        assert.equal(liveStyleBeforeReroll, 'anime', 'fixture unexpectedly refreshed settings before explicit reroll');
        const rerollButton = await page.evaluate((prompt) => {
            const image = [...document.querySelectorAll('.rp-generated-image-frame img')].find((candidate) => {
                try { return new URL(candidate.currentSrc || candidate.src, location.origin).searchParams.get('tag') === prompt; }
                catch { return false; }
            });
            const frame = image?.closest('.rp-generated-image-frame');
            const button = frame?.querySelector('.rp-image-reroll-button');
            const result = {
                className: button?.className || '',
                renderKey: button?.getAttribute('data-image-render-key') || '',
                frameRenderKey: frame?.getAttribute('data-image-render-key') || '',
                svgCount: button?.querySelectorAll('svg').length || 0,
                path: button?.querySelector('path')?.getAttribute('d') || '',
                text: String(button?.textContent || '').trim()
            };
            button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            result.disabledAfterClick = button?.disabled === true;
            return result;
        }, NEW_PROMPT);
        assert.equal(rerollButton.className, 'rp-image-reroll-button');
        assert.equal(rerollButton.renderKey, rerollButton.frameRenderKey);
        assert.equal(rerollButton.renderKey, beforeReroll.key);
        assert.equal(rerollButton.svgCount, 1);
        assert.equal(rerollButton.path, 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15');
        assert.equal(rerollButton.text, '');
        assert.equal(rerollButton.disabledAfterClick, true, 'module reroll button did not enter its reentry guard');
        await poll('reroll provider call', () => providerCalls.length === rerollProviderStart + 1, 90000);
        await waitForPromptImage(page, NEW_PROMPT);
        const rerolled = await waitForPromptRecord(page, NEW_PROMPT, (record) => record.rerollCount === 1);
        const rerollResponse = await successfulImageResponse(responses, rerollResponseStart, NEW_PROMPT);
        assert.equal(providerCalls.length, rerollProviderStart + 1, 'reroll did not call provider exactly once');
        assert.equal(rerolled.key, beforeReroll.key);
        assert.notEqual(rerolled.imageSignature, beforeReroll.imageSignature);
        assert.notEqual(rerolled.paramsSnapshot.seed, beforeReroll.paramsSnapshot.seed);
        assert.equal(rerolled.paramsSnapshot.styleKey, 'galgame');
        assert.notEqual(rerolled.paramsSnapshot.artist, beforeReroll.paramsSnapshot.artist);
        assert.equal(providerCalls[rerollProviderStart]?.artist, rerolled.paramsSnapshot.artist);
        assert.notEqual(rerollResponse.r2Key, newResponse.r2Key);

        phase = 'post-reroll-freeze';
        const providerAfterReroll = providerCalls.length;
        const postRerollResponseStart = responses.length;
        await page.evaluate(() => {
            const app = document.querySelector('#app').__vue_app__;
            const proxy = app._instance?.proxy || app._container?._vnode?.component?.proxy;
            proxy.settings.imageStyle = 'galgame';
        });
        await setNativeAuto(page, false);
        await setNativeAuto(page, true);
        await exerciseMaintenanceCycles(page, 2);
        await flushPage(page);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForApp(page);
        await waitForPromptImage(page, OLD_PROMPT);
        await waitForPromptImage(page, NEW_PROMPT);
        await assertPromptResponsesHit(responses, postRerollResponseStart, [OLD_PROMPT, NEW_PROMPT], 'post-reroll refresh');
        assert.equal(providerCalls.length, providerAfterReroll, 'non-reroll paths regenerated after reroll');
        const rerolledAfterRefresh = await waitForPromptRecord(page, NEW_PROMPT);
        assert.equal(rerolledAfterRefresh.imageSignature, rerolled.imageSignature);
        assert.equal(rerolledAfterRefresh.paramsSnapshot.artist, rerolled.paramsSnapshot.artist);

        const finalNative = await nativeState(page);
        assert.equal(finalNative.autoEnabled, true);
        assert.equal(finalNative.regexEnabled, true);
        assert.equal(finalNative.hookFirst, true);
        assert.match(finalNative.regexReplacement, new RegExp(`token=${IMAGE_TOKEN}`));
        const directRequests = providerDomainRequests.filter((entry) => entry.kind === 'direct-image');
        assert.ok(providerDomainRequests.length > 0, 'provider-domain network observer saw no control traffic');
        assert.equal(directRequests.length, 0, `browser contacted provider domains: ${JSON.stringify(directRequests)}`);
        const oldPostGenerationResponses = responses.slice(oldPostGenerationResponseStart).filter((entry) => (
            entry.method === 'GET' && entry.status === 200 && entry.r2Key && entry.tag === OLD_PROMPT
        ));
        assert.ok(oldPostGenerationResponses.length >= 4, 'old image did not traverse every refresh phase');
        assert.equal(oldPostGenerationResponses.every((entry) => entry.cache === 'HIT'), true,
            `old image produced a non-HIT after generation: ${JSON.stringify(oldPostGenerationResponses)}`);
        const scenarioWrites = (await snapshotTrackedWrites(page, writes)).slice(scenarioWriteStart);
        const moduleWorldWrites = scenarioWrites.filter((entry) => entry.owner === 'DB/image-module.js'
            && /^rp_hub_(?:global_)?worldinfo$/.test(entry.key));
        assert.deepEqual(moduleWorldWrites, [], 'module wrote world-info outside migration');
        const moduleRegexWrites = scenarioWrites.filter((entry) => entry.owner === 'DB/image-module.js'
            && /^rp_hub_(?:global_)?regex$/.test(entry.key));
        assert.equal(moduleRegexWrites.every((entry) => /^rp_hub_(?:global_)?regex$/.test(entry.key)), true);
        const library = await readLibrary(origin);

        const relevantConsoleErrors = consoleErrors.filter((entry) => (
            !/Failed to load resource: the server responded with a status of 404/i.test(entry.text)
        ));
        assert.deepEqual(pageErrors, [], 'browser emitted uncaught exceptions');
        assert.deepEqual(relevantConsoleErrors, [], 'browser emitted relevant console errors');

        return {
            switchPersistence: {
                enabledAcrossCyclesAndRefresh: true,
                disabledAcrossCyclesAndRefresh: true,
                moduleWorldInfoWrites: 0,
                nativeRegexEnabled: finalNative.regexEnabled,
                nativeTokenIntact: finalNative.regexReplacement.includes(`token=${IMAGE_TOKEN}`),
                hookFirst: finalNative.hookFirst
            },
            providerTable: {
                oldCreate: 1,
                oldStyleRefresh: 0,
                oldOffOn: 0,
                newCreate: 1,
                skippedCreate: 0,
                skippedReenable: 0,
                reroll: 1,
                postRerollNonReroll: 0,
                total: providerCalls.length
            },
            records: {
                old: { key: oldRecord.key, signature: oldRecord.imageSignature, artist: oldRecord.paramsSnapshot.artist, r2Key: oldResponse.r2Key },
                oldAfterDrift: { signature: oldRecordAfterStyle.imageSignature, artist: oldRecordAfterStyle.paramsSnapshot.artist },
                current: { key: newRecord.key, signature: newRecord.imageSignature, artist: newRecord.paramsSnapshot.artist, r2Key: newResponse.r2Key },
                skipped: { key: skippedRecord.key, status: skippedRecord.status },
                rerolled: { key: rerolled.key, signature: rerolled.imageSignature, rerollCount: rerolled.rerollCount, artist: rerolled.paramsSnapshot.artist, styleKey: rerolled.paramsSnapshot.styleKey, r2Key: rerollResponse.r2Key }
            },
            rerollButton,
            r2: { totalCount: library.totalCount, hitCount: responses.filter((entry) => entry.cache === 'HIT').length },
            network: {
                directBrowserRequests: directRequests,
                naiSta1nRequests: directRequests.filter((entry) => entry.host === 'nai.sta1n.cn').length,
                stdLoliycRequests: directRequests.filter((entry) => entry.host === 'std.loliyc.com').length,
                observedControlRequests: providerDomainRequests.filter((entry) => entry.kind !== 'direct-image'),
                imageResponses: responses
            },
            persistence: { moduleRegexWrites: moduleRegexWrites.length, moduleWorldWrites: 0 },
            console: { pageErrors, relevantConsoleErrors }
        };
    } finally {
        await context.close();
    }
}

async function runNetworkGateScenario(browser, origin, providerCalls) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
    const providerDomainRequests = [];
    for (const host of PROVIDER_HOSTS) {
        await context.route(`https://${host}/**`, async (route) => {
            const request = route.request();
            providerDomainRequests.push({ host, method: request.method(), resourceType: request.resourceType(), url: request.url() });
            await route.fulfill({ status: 200, contentType: 'image/png', body: makeFixturePng(101) });
        });
    }
    const page = await context.newPage();
    const responses = [];
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message || String(error)));
    page.on('response', async (response) => {
        const url = new URL(response.url());
        if (url.origin !== origin || url.pathname !== '/api/rp-image') return;
        const headers = await response.allHeaders();
        responses.push({
            method: response.request().method(),
            status: response.status(),
            tag: url.searchParams.get('tag') || '',
            cache: headers['x-rp-image-cache'] || '',
            r2Key: headers['x-rp-image-key'] || ''
        });
    });
    try {
        await seedBrowser(page, origin, networkGateSeedRecords(), { token: IMAGE_TOKEN, migrationDone: true });
        const providerStart = providerCalls.length;
        await page.goto(`${origin}/image-store-freeze-network-gate.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await waitForApp(page);
        const state = await nativeState(page);
        assert.equal(state.autoEnabled, true);
        assert.equal(state.regexEnabled, true);
        assert.equal(state.hookFirst, true);
        assert.match(state.regexReplacement, new RegExp(`token=${IMAGE_TOKEN}`));

        const firstResponseStart = responses.length;
        const firstRender = await page.evaluate(() => globalThis.__rphRenderNetworkGate());
        assert.match(firstRender.renderedText, /^rph-image-marker###/);
        assert.equal(firstRender.hookFirst, true);
        await poll('network-gate new image provider call', () => providerCalls.length === providerStart + 1, 90000);
        await waitForPromptImage(page, NETWORK_GATE_PROMPT);
        const firstResponse = await successfulImageResponse(responses, firstResponseStart, NETWORK_GATE_PROMPT);
        assert.equal(firstResponse.cache, 'HIT');

        const providerBeforeOldRender = providerCalls.length;
        const oldResponseStart = responses.length;
        const oldRender = await page.evaluate(() => globalThis.__rphRenderNetworkGate());
        assert.match(oldRender.renderedText, /^rph-image-marker###/);
        await waitForPromptImage(page, NETWORK_GATE_PROMPT);
        const oldResponse = await successfulImageResponse(responses, oldResponseStart, NETWORK_GATE_PROMPT);
        assert.equal(oldResponse.cache, 'HIT');
        assert.equal(providerCalls.length, providerBeforeOldRender, 'network-gate old render regenerated');
        assert.deepEqual(providerDomainRequests, [],
            `render hook allowed provider-domain browser traffic: ${JSON.stringify(providerDomainRequests)}`);
        assert.deepEqual(pageErrors, []);
        return {
            nativeRegexEnabled: true,
            nativeTokenIntact: true,
            hookFirst: true,
            newRenderProviderCalls: 1,
            oldRenderProviderCalls: 0,
            naiSta1nRequests: 0,
            stdLoliycRequests: 0,
            allProviderDomainRequests: providerDomainRequests,
            newRenderCache: firstResponse.cache,
            oldRenderCache: oldResponse.cache
        };
    } finally {
        await context.close();
    }
}

function networkGateHtml(moduleVersion) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>network gate</title></head><body>
<main id="app">
<button title="发送">发送</button><button title="自动生图开关">自动生图</button>
<aside class="app-sidebar"><button><span>设置</span></button></aside>
<article data-chat-index="2" data-role="assistant"><div class="message-content-wrapper"><div class="markdown-body"></div></div><span class="msg-name-tag">${CHARACTER_NAME}</span></article>
</main>
<script>
const root = document.getElementById('app');
const proxy = {
    regexScripts: [${JSON.stringify(nativeRegex(true))}],
    worldInfo: [${JSON.stringify(nativeWorld(true))}],
    chatHistory: [
        { id: 'network-gate-user-0', role: 'user', content: '网络闸门准备。' },
        { id: 'network-gate-assistant-1', role: 'assistant', content: '等待新楼层。' }
    ]
};
root.__vue_app__ = { _container: { _vnode: { component: { proxy } } } };
globalThis.RPH_R2_FLUSH_PERSISTENCE = async () => true;
globalThis.__rphRenderNetworkGate = async () => {
    let renderedText = ${JSON.stringify(`image###${NETWORK_GATE_PROMPT}###`)};
    if (!proxy.chatHistory[2]) {
        proxy.chatHistory.push({
            id: 'freeze-network-gate-image',
            role: 'assistant',
            name: ${JSON.stringify(CHARACTER_NAME)},
            content: renderedText,
            isSelf: false
        });
    }
    for (const entry of proxy.regexScripts) {
        if (entry?.enabled !== true) continue;
        const literal = String(entry.regex || '').match(/^\\/([\\s\\S]*)\\/([a-z]*)$/i);
        const expression = literal
            ? new RegExp(literal[1], literal[2])
            : new RegExp(String(entry.regex || ''), String(entry.flags || 'g'));
        renderedText = renderedText.replace(expression, String(entry.replacement || ''));
    }
    document.querySelector('.markdown-body').textContent = renderedText;
    await globalThis.RPHubImageModule.scan();
    return { renderedText, hookFirst: proxy.regexScripts[0]?.name === ${JSON.stringify(MODULE_REGEX_NAME)} };
};
</script>
<script src="/DB/nav-adapter.js"></script><script src="/DB/image-module.js?v=${moduleVersion}"></script>
</body></html>`;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const { chromium } = loadPlaywright();
    const chromePath = findChrome();
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-image-store-freeze-'));
    const distRoot = path.join(runtimeRoot, 'dist');
    const releaseRoot = path.join(runtimeRoot, 'release');
    const stateRoot = path.join(runtimeRoot, 'state');
    const configRoot = path.join(runtimeRoot, 'config');
    const providerCalls = [];
    const report = {
        ok: false,
        targetVersion: '1.8.1',
        browser: { engine: 'Chrome', executable: chromePath, controller: 'Playwright' },
        startedAt: new Date().toISOString()
    };
    let providerServer = null;
    let wrangler = null;
    let browser = null;
    let failure = null;

    try {
        await Promise.all([fs.mkdir(options.evidenceDir, { recursive: true }), fs.mkdir(configRoot, { recursive: true })]);
        const packaged = spawnSync(process.execPath, [
            PACKAGE_SCRIPT,
            '--dist', distRoot,
            '--release-dir', releaseRoot
        ], { cwd: ROOT_DIR, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        assert.equal(packaged.status, 0, packaged.stderr || packaged.stdout);
        const packageReport = JSON.parse(packaged.stdout);
        const moduleVersion = packageReport.assetVersions['/DB/image-module.js'];
        await Promise.all([
            fs.writeFile(path.join(distRoot, 'image-store-freeze-seed.html'), '<!doctype html><meta charset="utf-8"><title>seed</title>', 'utf8'),
            fs.writeFile(path.join(distRoot, 'image-store-freeze-migration.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>migration</title></head><body>
<main id="app"><button title="发送">发送</button><aside class="app-sidebar"><button><span>设置</span></button></aside></main>
<script>
const root = document.getElementById('app');
root.__vue_app__ = { _instance: { proxy: { regexScripts: [], worldInfo: [] } } };
globalThis.RPH_R2_FLUSH_PERSISTENCE = async () => true;
</script>
<script src="/DB/nav-adapter.js"></script><script src="/DB/image-module.js?v=${moduleVersion}"></script>
</body></html>`, 'utf8'),
            fs.writeFile(path.join(distRoot, 'image-store-freeze-network-gate.html'), networkGateHtml(moduleVersion), 'utf8')
        ]);

        providerServer = createServer((request, response) => {
            const url = new URL(request.url || '/', 'http://127.0.0.1');
            if (url.pathname !== '/generate') {
                response.writeHead(404);
                response.end('not found');
                return;
            }
            providerCalls.push({
                provider: url.searchParams.get('provider') || '',
                tag: url.searchParams.get('tag') || '',
                artist: url.searchParams.get('artist') || '',
                seed: url.searchParams.get('seed') || '',
                tokenPresent: Boolean(url.searchParams.get('token'))
            });
            const png = makeFixturePng(providerCalls.length);
            response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.byteLength) });
            response.end(png);
        });
        const providerPort = await listen(providerServer);
        const providerOrigin = `http://127.0.0.1:${providerPort}`;
        const port = await availablePort();
        const origin = `http://127.0.0.1:${port}`;
        const run = startWrangler(distRoot, stateRoot, configRoot, providerOrigin, port);
        wrangler = run.child;
        await waitForReady(origin, wrangler, run.output);
        report.origin = origin;
        report.package = { fileCount: packageReport.fileCount, assetVersions: packageReport.assetVersions };

        browser = await chromium.launch({
            executablePath: chromePath,
            headless: true,
            args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server']
        });
        report.migration = await runMigrationScenario(browser, origin);
        report.main = await runMainScenario(browser, origin, providerCalls);
        report.networkGate = await runNetworkGateScenario(browser, origin, providerCalls);
        assert.equal(providerCalls.every((entry) => entry.tokenPresent), true, 'worker omitted provider token forwarding');
        report.providerCalls = providerCalls;
        report.ok = true;
    } catch (error) {
        failure = error;
        report.error = { name: error.name || 'Error', message: error.message || String(error), stack: error.stack || '' };
    } finally {
        report.finishedAt = new Date().toISOString();
        await browser?.close().catch(() => {});
        await stopProcessTree(wrangler).catch(() => {});
        await closeServer(providerServer).catch(() => {});
        await fs.mkdir(options.evidenceDir, { recursive: true }).catch(() => {});
        await fs.writeFile(path.join(options.evidenceDir, 'image-store-freeze-e2e.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
        await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (failure) throw failure;
}

await main();
