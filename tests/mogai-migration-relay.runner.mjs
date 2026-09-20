import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { buildMigrationRelay } from '../scripts/build-migration-relay.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PROJECT_DIR = path.resolve(ROOT_DIR, '..');
const BASE_ZIP = path.join(PROJECT_DIR, 'release', 'RP-Hub-R2-rebuild-v4-img-20260901-020954.zip');
const MOGAI_ROOT = 'D:/tmp/mogai1';
const TAR_EXE = 'C:/Windows/System32/tar.exe';
const PASSWORD = 'rph';
const IMAGE_TOKEN = 'STD-mogai-relay-browser-token';
const CHARACTER = {
    uuid: 'face0000-0000-4000-8000-000000000001',
    name: 'Mogai Relay Role'
};
// Second catalog character that is never activated: its bucket may only be
// converted by the v3 full-catalog sweep, never by a lazy per-character load.
const IDLE_CHARACTER = {
    uuid: 'face0000-0000-4000-8000-000000000002',
    name: 'Mogai Relay Idle'
};
const OLD_PROMPT = 'silver hair, blue eyes, moonlit library';
const WRAPPED_PROMPT = 'crimson cape, snow field, distant tower';
const WRAPPED_REROLL_NONCE = 'nonce-mogai-wrap';
// The stored record keeps the original prompt with markdown-active
// characters; the rendered message text lost them, so the scan descriptor
// promptHash can never match again.  F5 must turn this floor into a manual
// "click to generate" frame with zero provider POSTs.
const MISMATCH_STORED_PROMPT = 'amber eyes, *gentle* smile, rain';
const MISMATCH_MESSAGE_PROMPT = 'amber eyes, gentle smile, rain';
const IDLE_PROMPT = 'verdant forest, morning fog, stone bridge';
const IMAGE_SIGNATURE_KEYS = [
    'provider', 'tag', 'model', 'artist', 'size', 'steps', 'scale', 'cfg',
    'sampler', 'negative', 'nocache', 'noise_schedule'
];
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
);

function parseArguments(argv) {
    const options = { evidenceDir: path.join(ROOT_DIR, 'evidence', 'mogai-migration-relay') };
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
        throw new Error(`Playwright is unavailable. NODE_PATH=${process.env.NODE_PATH || ''}`, { cause: error });
    }
}

function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe'
    ].filter(Boolean);
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) throw new Error(`Chrome executable not found: ${candidates.join(', ')}`);
    return found;
}

function wranglerBinary() {
    return path.resolve(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex').toLowerCase();
}

function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function poll(label, callback, timeoutMs = 90000, intervalMs = 150) {
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

async function stopProcessTree(processInfo) {
    const child = processInfo?.child ?? processInfo;
    if (!child) return null;
    const wasRunning = child.exitCode === null;

    // Wrangler launches a second Node process for wrangler-dist.  The outer
    // wrapper can report an exit code while that descendant is still alive;
    // returning early in that case leaves open stdio handles and makes a
    // serial run-all hang after the browser assertions already passed.  Always
    // target the exact test-owned PID so the whole process tree is reclaimed.
    if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true
        });
    } else if (child.exitCode === null) {
        child.kill('SIGTERM');
    }
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), wait(4000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
    // A forced Windows taskkill commonly surfaces as exit code 1 on the
    // wrapper even though cleanup succeeded.  Do not expose that harness
    // status as a failed relay assertion.
    return wasRunning ? 0 : child.exitCode;
}

function startWrangler(distRoot, stateRoot, configRoot, bindings, port) {
    const wrangler = wranglerBinary();
    assert.ok(existsSync(wrangler), `wrangler missing: ${wrangler}`);
    const output = { value: '' };
    const args = [
        wrangler,
        'pages', 'dev', '.',
        '--port', String(port),
        '--compatibility-date', '2026-07-15',
        '--r2', 'RP_SYNC_R2',
        '--persist-to', stateRoot,
        '--log-level', 'error',
        '--show-interactive-dev-session=false'
    ];
    for (const [key, value] of Object.entries(bindings)) args.push('--binding', `${key}=${value}`);
    const child = spawn(process.execPath, args, {
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

async function waitForReady(origin, processInfo) {
    for (let attempt = 0; attempt < 240; attempt += 1) {
        if (processInfo.child.exitCode !== null) {
            throw new Error(`Wrangler exited early (${processInfo.child.exitCode}).\n${processInfo.output.value.slice(-12000)}`);
        }
        try {
            const response = await fetch(`${origin}/`);
            if (response.ok) return;
        } catch {
            // Listener is still starting.
        }
        await wait(150);
    }
    throw new Error(`Wrangler did not become ready.\n${processInfo.output.value.slice(-12000)}`);
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

/**
 * Extract the magic client's own hashText/buildRecordKey/buildDescriptor/
 * normalizeRecord verbatim from the sample.  Every pre-seeded record below is
 * produced by these functions, i.e. byte-for-byte what magic normalizeRecord
 * + saveNow persists — the fixture red line.
 */
function extractMogaiNormalizer(source) {
    const hashMatch = source.match(/const hashText = \(value\) => \{\n[\s\S]*?\n    \};/);
    const keyMatch = source.match(/const buildRecordKey = \(descriptor = \{\}\) => \[[\s\S]*?\n        \]\.join\(':'\);/);
    const descriptorMatch = source.match(/const buildDescriptor = \(prompt, occurrenceIndex, renderContext = \{\}\) => \{\n[\s\S]*?\n        \};/);
    const normalizeMatch = source.match(/const normalizeRecord = \(record = \{\}, ownerName = activeCharacterName\) => \{\n[\s\S]*?\n        \};/);
    assert.ok(hashMatch && keyMatch && descriptorMatch && normalizeMatch,
        'magic sample normalizer anchors drifted');
    const context = vm.createContext({});
    vm.runInContext(
        `${hashMatch[0]}\nlet activeCharacterName = '';\n${keyMatch[0]}\n${descriptorMatch[0]}\n${normalizeMatch[0]}\n`
            + 'this.api = { hashText, buildRecordKey, buildDescriptor, normalizeRecord };',
        context
    );
    return context.api;
}

/** Mirror of the relay module's buildImageRenderRecordKey (tree DB/image-module.js). */
function nativeRecordKey(record) {
    return [
        record.messageId || 'message',
        record.contentHash || 'content',
        record.occurrenceIndex ?? 0,
        record.promptHash || ''
    ].join(':');
}

function assertMagicPersistedShape(record, label, mogai) {
    assert.deepEqual(Object.keys(record).sort(),
        ['contentHash', 'key', 'messageId', 'messageIndex', 'occurrenceIndex', 'paramsSnapshot', 'prompt', 'promptHash'],
        `${label}: magic persisted record carries unexpected fields`);
    assert.equal(record.key, mogai.buildRecordKey(record),
        `${label}: stored key is not the real magic 3-segment buildRecordKey output`);
    assert.notEqual(record.key, nativeRecordKey(record),
        `${label}: fixture key accidentally matches the native 4-segment format`);
    for (const banned of ['imageSignature', 'status', 'skipped', 'createdAt', 'updatedAt', 'rerollCount', 'transient']) {
        assert.ok(!(banned in record), `${label}: fixture carries relay-only field ${banned}`);
    }
    for (const banned of ['prompt', 'tag', 'characterUuid', 'token', 'reroll_nonce', 'upstreamParams']) {
        assert.ok(!(banned in record.paramsSnapshot), `${label}: fixture snapshot carries ${banned}`);
    }
    if (record.messageId) {
        assert.equal(record.key.split(':').length, 3, `${label}: fixture key is not 3-segment`);
    } else {
        assert.ok(record.key.startsWith(`index:${record.messageIndex}:`),
            `${label}: id-less fixture key must use the index:<messageIndex> first segment`);
    }
}

function buildFixture() {
    const sampleFile = path.join(MOGAI_ROOT, 'assets', 'js', 'image-assets.js');
    assert.ok(existsSync(sampleFile), `magic sample missing: ${sampleFile}`);
    const mogai = extractMogaiNormalizer(readFileSync(sampleFile, 'utf8'));
    const baseSnapshot = (characterName, extra = {}) => ({
        provider: 'std',
        model: 'nai-diffusion-4-5-full',
        artist: 'artist:test',
        size: '竖图',
        steps: '40',
        scale: '6',
        cfg: '0',
        sampler: 'k_dpmpp_2m_sde',
        negative: 'bad anatomy',
        nocache: '0',
        rerollNonce: '',
        noise_schedule: 'karras',
        characterName,
        ...extra
    });
    // Messages carry no timestamp: real magic chat messages have none and the
    // fixture must not invent any.
    const messages = {
        user: { id: 'mogai-user-old', role: 'user', content: 'Show the old image.', isSelf: true },
        old: { id: 'mogai-a-old', role: 'assistant', name: CHARACTER.name, content: `image###${OLD_PROMPT}###`, isSelf: false },
        wrapped: { id: 'mogai-a-wrap', role: 'assistant', name: CHARACTER.name, content: `<image>image###${WRAPPED_PROMPT}###</image>`, isSelf: false },
        mismatch: { id: 'mogai-a-mismatch', role: 'assistant', name: CHARACTER.name, content: `image###${MISMATCH_MESSAGE_PROMPT}###`, isSelf: false }
    };
    for (const [label, message] of Object.entries(messages)) {
        assert.ok(!('timestamp' in message), `${label} message carries a self-invented timestamp`);
    }
    const persist = (message, index, prompt, paramsSnapshot) => {
        const descriptor = mogai.buildDescriptor(prompt, 0, { message, index });
        return mogai.normalizeRecord({ ...descriptor, paramsSnapshot }, paramsSnapshot.characterName);
    };
    const records = {
        old: persist(messages.old, 1, OLD_PROMPT, baseSnapshot(CHARACTER.name)),
        wrapped: persist(messages.wrapped, 2, WRAPPED_PROMPT, baseSnapshot(CHARACTER.name, {
            nocache: '1',
            rerollNonce: WRAPPED_REROLL_NONCE
        })),
        // The record keeps the pre-rewrite text; the seeded message above
        // carries the rewritten text, so the promptHash never matches again.
        mismatch: persist(
            { ...messages.mismatch, content: `image###${MISMATCH_STORED_PROMPT}###` },
            3,
            MISMATCH_STORED_PROMPT,
            baseSnapshot(CHARACTER.name)
        ),
        idle: persist(
            { id: 'mogai-b-old', role: 'assistant', name: IDLE_CHARACTER.name, content: `image###${IDLE_PROMPT}###`, isSelf: false },
            0,
            IDLE_PROMPT,
            baseSnapshot(IDLE_CHARACTER.name)
        )
    };
    for (const [label, record] of Object.entries(records)) assertMagicPersistedShape(record, label, mogai);
    assert.equal(records.mismatch.messageId, messages.mismatch.id);
    assert.notEqual(records.mismatch.promptHash, mogai.hashText(MISMATCH_MESSAGE_PROMPT),
        'mismatch fixture accidentally keeps a recoverable promptHash');

    const character = {
        uuid: CHARACTER.uuid,
        name: CHARACTER.name,
        description: 'Mogai relay migration fixture',
        first_mes: `Hello from ${CHARACTER.name}`,
        personality: 'Migration fixture',
        mes_example: '',
        avatar: null,
        createdAt: 1700100000000,
        worldInfo: [],
        regexScripts: [],
        uiTemplates: [],
        recentGenerationTimes: []
    };
    const idleCharacter = {
        ...character,
        uuid: IDLE_CHARACTER.uuid,
        name: IDLE_CHARACTER.name,
        first_mes: `Hello from ${IDLE_CHARACTER.name}`
    };
    const chat = [messages.user, messages.old, messages.wrapped, messages.mismatch];
    const settings = {
        apiUrl: 'https://migration.invalid/v1',
        apiKey: '',
        apiProviderId: 'custom',
        apiProviderKeys: { custom: '' },
        customApiUrl: 'https://migration.invalid/v1',
        autoFetchModels: false,
        fontFamily: 'modern',
        fontFamilyVersion: 4,
        stream: true,
        imageStyle: 'custom',
        customImageArtists: 'artist:relay-custom',
        imageSize: '横图',
        imageGenCount: 2,
        freezeImageGeneration: true,
        imageGenKey: IMAGE_TOKEN
    };
    return { records, character, idleCharacter, chat, settings };
}

async function seedFullBrowser(page, origin, fixture) {
    await page.goto(`${origin}/migration-seed.html`, { waitUntil: 'domcontentloaded' });
    return page.evaluate(async ({ character, idleCharacter, chat, settings, records, idleRecords, password }) => {
        localStorage.clear();
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_sync_password_v1', password);
        await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase('RPHubDB');
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('RPHubDB delete was blocked'));
        });
        const rows = [
            ['rp_hub_character_index', { order: [character.uuid, idleCharacter.uuid] }],
            [`rp_hub_character_${character.uuid}`, character],
            [`rp_hub_character_${idleCharacter.uuid}`, idleCharacter],
            [`rp_hub_chat_${character.uuid}`, chat],
            [`rp_hub_image_renders_${character.uuid}`, records],
            [`rp_hub_image_renders_${idleCharacter.uuid}`, idleRecords],
            ['rp_hub_settings', settings],
            ['rp_hub_global_regex', []],
            ['rp_hub_regex', []],
            ['rp_hub_global_worldinfo', [{ comment: '自动生图', enabled: true, scope: 'global' }]],
            ['rp_hub_worldinfo', []],
            ['rp_hub_user', { uuid: 'relay-user', name: 'Relay User', description: '', avatar: null, person: 'second' }],
            ['rp_hub_user_profiles', [{ uuid: 'relay-user', name: 'Relay User', description: '', avatar: null, person: 'second' }]],
            ['rp_hub_active_profile_id', 'relay-user'],
            ['rp_hub_last_active_char', character.uuid]
        ];
        await new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubDB', 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains('store')) request.result.createObjectStore('store');
            };
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const database = request.result;
                const tx = database.transaction('store', 'readwrite');
                for (const [key, value] of rows) tx.objectStore('store').put(value, key);
                tx.oncomplete = () => { database.close(); resolve(); };
                tx.onerror = () => { database.close(); reject(tx.error); };
            };
        });
        return { rows: rows.length };
    }, {
        character: fixture.character,
        idleCharacter: fixture.idleCharacter,
        chat: fixture.chat,
        settings: fixture.settings,
        records: [fixture.records.old, fixture.records.wrapped, fixture.records.mismatch],
        idleRecords: [fixture.records.idle],
        password: PASSWORD
    });
}

async function waitForApp(page) {
    await page.waitForFunction(() => Boolean(document.querySelector('#app')?.__vue_app__ && globalThis.RPHubImageModule?.getState), null, { timeout: 120000 });
}

async function findVisibleImage(page, prompt) {
    return page.evaluate((expected) => {
        const image = [...document.querySelectorAll('img')].find((candidate) => {
            try {
                const url = new URL(candidate.currentSrc || candidate.src, location.origin);
                return url.pathname === '/api/rp-image'
                    && url.searchParams.get('tag') === expected
                    && candidate.complete
                    && candidate.naturalWidth > 0;
            } catch {
                return false;
            }
        });
        if (!image) return null;
        const url = new URL(image.currentSrc || image.src, location.origin);
        return {
            src: url.toString(),
            rerollNonce: url.searchParams.get('reroll_nonce') || '',
            characterUuid: url.searchParams.get('character_id') || '',
            characterName: url.searchParams.get('character_name') || ''
        };
    }, prompt);
}

async function waitForImage(page, prompt) {
    return poll(`image ${prompt}`, () => findVisibleImage(page, prompt));
}

async function waitForRecord(page, uuid, prompt) {
    return poll(`record ${prompt}`, async () => {
        const records = await readBrowserRecord(page, `rp_hub_image_renders_${uuid}`);
        return Array.isArray(records) ? records.find((record) => record?.prompt === prompt) || null : null;
    });
}

async function waitForConvertedBucket(page, uuid, expectedCount, label) {
    return poll(`converted bucket ${label}`, async () => {
        const records = await readBrowserRecord(page, `rp_hub_image_renders_${uuid}`);
        if (!Array.isArray(records) || records.length !== expectedCount) return null;
        const everyNativeKey = records.every((record) => String(record?.key || '').split(':').length === 4);
        return everyNativeKey ? records : null;
    }, 90000, 250);
}

async function stableBucketBytes(page, uuid) {
    const first = JSON.stringify(await readBrowserRecord(page, `rp_hub_image_renders_${uuid}`));
    await wait(600);
    const second = JSON.stringify(await readBrowserRecord(page, `rp_hub_image_renders_${uuid}`));
    assert.equal(second, first, `bucket ${uuid} kept changing between reads`);
    return first;
}

async function dismissBlockingModals(page) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const overlay = page.locator('div.fixed.inset-0:visible').last();
        if (!await overlay.count()) return;
        const buttons = overlay.locator('button:visible');
        const count = await buttons.count();
        if (!count) {
            await page.keyboard.press('Escape').catch(() => {});
            await wait(250);
            continue;
        }
        let clicked = false;
        for (let index = count - 1; index >= 0; index -= 1) {
            const button = buttons.nth(index);
            const label = String(await button.innerText().catch(() => '')).trim();
            if (/知道了|暂不开启|以后再说|关闭|取消|跳过|稍后|我知道/.test(label)) {
                await button.click({ force: true }).catch(() => {});
                clicked = true;
                break;
            }
        }
        if (!clicked) await buttons.last().click({ force: true }).catch(() => {});
        await wait(350);
    }
}

function imageUrl(origin, paramsSnapshot, prompt, character) {
    const url = new URL('/api/rp-image', origin);
    for (const key of IMAGE_SIGNATURE_KEYS) {
        url.searchParams.set(key, key === 'tag' ? prompt : String(paramsSnapshot[key] || ''));
    }
    if (paramsSnapshot.rerollNonce) url.searchParams.set('reroll_nonce', paramsSnapshot.rerollNonce);
    url.searchParams.set('character_id', character.uuid);
    url.searchParams.set('character_name', character.name);
    return url;
}

function moduleProbeHtml() {
    return `<!doctype html><meta charset="utf-8"><script>
(async () => {
    const open = () => new Promise((resolve, reject) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('store')) request.result.createObjectStore('store'); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('RPHubDB'); request.onsuccess = resolve; request.onerror = reject; });
    const db = await open();
    await new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readwrite');
        tx.objectStore('store').put([{comment:'自动生图',enabled:true,scope:'global'}], 'rp_hub_global_worldinfo');
        tx.objectStore('store').put([], 'rp_hub_worldinfo');
        tx.objectStore('store').put([], 'rp_hub_global_regex');
        tx.objectStore('store').put([], 'rp_hub_regex');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
    const writes = [];
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
        writes.push(String(key ?? ''));
        return originalPut.apply(this, arguments);
    };
    const script = document.createElement('script');
    script.src = '/DB/image-module.js';
    document.body.appendChild(script);
    await new Promise(resolve => setTimeout(resolve, 1800));
    const result = { worldInfoWrites: writes.filter(key => key === 'rp_hub_global_worldinfo' || key === 'rp_hub_worldinfo') };
    globalThis.__probe = result;
})().catch(error => { globalThis.__probeError = String(error?.stack || error); });
</script>`;
}

async function fetchWithRetry(url, init = {}, attempts = 5) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
            const response = await fetch(url, { ...init, signal: controller.signal });
            if (response.ok) return response;
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        } finally {
            clearTimeout(timer);
        }
        await wait(250 * (attempt + 1));
    }
    throw lastError || new Error(`Fetch failed: ${url}`);
}

async function localUpdateFallback() {
    const updateRoot = existsSync('D:/tmp/rph-upstream-187/index.html')
        ? 'D:/tmp/rph-upstream-187'
        : MOGAI_ROOT;
    const localPaths = [];
    const visit = async (directory, relative = '') => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
            const child = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(child, childRelative);
            else if (entry.isFile()
                && !childRelative.startsWith('MODIFICATIONS_TO_KEEP')
                && childRelative !== '_worker.js'
                && !childRelative.startsWith('DB/')
                && !childRelative.startsWith('work.js')
                && !childRelative.startsWith('wrangler.toml')) localPaths.push(childRelative);
        }
    };
    await visit(updateRoot);
    const files = new Map();
    for (const filePath of localPaths) files.set(filePath, await fs.readFile(path.join(updateRoot, ...filePath.split('/'))));
    const cachedApp = 'D:/tmp/rph-upstream-187-app.js';
    if (updateRoot === MOGAI_ROOT && existsSync(cachedApp)) files.set('assets/js/app.js', await fs.readFile(cachedApp));
    return files;
}

async function fetchUpstream187Files() {
    // The local sample directory is already the 1.8.7-shaped tree.  When the
    // one cached pristine app.js is present, use it directly as the mock
    // GitHub snapshot; this keeps the e2e deterministic and offline-capable.
    if (existsSync('D:/tmp/rph-upstream-187-app.js')) return localUpdateFallback();
    let tree;
    try {
        const treeResponse = await fetchWithRetry('https://api.github.com/repos/STA1N156/RP-Hub/git/trees/1.8.7?recursive=1', {
            headers: { 'user-agent': 'rph-mogai-relay-test', accept: 'application/vnd.github+json' }
        });
        tree = await treeResponse.json();
    } catch (error) {
        const fallback = await localUpdateFallback();
        if (!fallback.has('assets/js/app.js') || fallback.get('assets/js/app.js').byteLength < 100000) throw error;
        return fallback;
    }
    const paths = tree.tree
        .filter((entry) => entry.type === 'blob')
        .map((entry) => String(entry.path))
        .filter((entry) => !entry.startsWith('DB/') && !entry.startsWith('_worker.js') && !entry.startsWith('work.js')
            && !entry.startsWith('wrangler.toml') && !entry.startsWith('.git') && !entry.startsWith('.github'));
    const files = new Map();
    const fallback = await localUpdateFallback();
    let cursor = 0;
    async function worker() {
        while (cursor < paths.length) {
            const filePath = paths[cursor++];
            try {
                const response = await fetchWithRetry(`https://raw.githubusercontent.com/STA1N156/RP-Hub/1.8.7/${filePath}`, {
                    headers: { 'user-agent': 'rph-mogai-relay-test' }
                });
                files.set(filePath, Buffer.from(await response.arrayBuffer()));
            } catch (error) {
                if (fallback.has(filePath)) files.set(filePath, fallback.get(filePath));
                else throw new Error(`Unable to obtain 1.8.7 file ${filePath}: ${error.message}`, { cause: error });
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(3, paths.length) }, () => worker()));
    if (!files.has('assets/js/app.js')) throw new Error('1.8.7 mock update has no app.js');
    return files;
}

function makeMockUpdateServer(upstreamFiles, providerCalls) {
    const commit = '1870000000000000000000000000000000000000';
    const descriptors = [...upstreamFiles.entries()].map(([filePath, bytes]) => ({
        path: filePath,
        sha256: sha256(bytes),
        size: bytes.byteLength
    })).sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
        schema: 1,
        upstreamRepo: 'STA1N156/RP-Hub',
        versions: [{
            tag: '1.8.7',
            commit,
            name: '1.8.7 mock GitHub mirror',
            date: '2026-08-23T00:00:00Z',
            files: descriptors
        }]
    };
    const requests = [];
    const server = createServer(async (request, response) => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        requests.push({ method: request.method, pathname: url.pathname });
        if (url.pathname === '/generate') {
            const params = url.searchParams;
            providerCalls.push({ tag: params.get('tag') || '', rerollNonce: params.get('reroll_nonce') || '' });
            response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(TINY_PNG.byteLength) });
            response.end(TINY_PNG);
            return;
        }
        if (url.pathname === '/manifest.json') {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify(manifest));
            return;
        }
        const prefix = `/snapshots/1.8.7/${commit}/`;
        if (url.pathname.startsWith(prefix)) {
            const filePath = decodeURIComponent(url.pathname.slice(prefix.length));
            const bytes = upstreamFiles.get(filePath);
            if (!bytes) {
                response.writeHead(404);
                response.end('not found');
                return;
            }
            response.writeHead(200, { 'content-type': filePath.endsWith('.js') ? 'application/javascript' : 'application/octet-stream' });
            response.end(bytes);
            return;
        }
        response.writeHead(404);
        response.end('not found');
    });
    return { server, manifest, requests };
}

async function postSync(origin, body) {
    const response = await fetch(`${origin}/api/rp-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rp-sync-password': PASSWORD },
        body: JSON.stringify(body)
    });
    const payload = await response.json();
    return { response, payload };
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    assert.ok(existsSync(TAR_EXE), `tar missing: ${TAR_EXE}`);
    assert.ok(existsSync(MOGAI_ROOT), `magic sample missing: ${MOGAI_ROOT}`);
    const { chromium } = loadPlaywright();
    const fixture = buildFixture();
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-mogai-relay-browser-'));
    const relayDist = path.join(runtimeRoot, 'relay-dist');
    const baselineDist = path.join(runtimeRoot, 'baseline-dist');
    const releaseRoot = path.join(runtimeRoot, 'release');
    const stateRoot = path.join(runtimeRoot, 'state');
    const configRoot = path.join(runtimeRoot, 'config');
    await fs.mkdir(baselineDist, { recursive: true });
    const providerCalls = [];
    const pageErrors = [];
    let providerServer;
    let relayProcess;
    let baselineProcess;
    let browser;
    let context;
    const report = {
        ok: false,
        startedAt: new Date().toISOString(),
        browser: { engine: 'system Chrome', executable: findChrome() },
        phases: {}
    };
    try {
        const relay = buildMigrationRelay({ base: BASE_ZIP, dist: relayDist, releaseRoot, timestamp: '20990101-030303' });
        report.relay = relay;
        const extracted = spawnSync(TAR_EXE, ['-xf', BASE_ZIP, '-C', baselineDist], { encoding: 'utf8', windowsHide: true });
        assert.equal(extracted.status, 0, extracted.stderr || extracted.stdout);
        const upstreamFiles = await fetchUpstream187Files();
        const mock = makeMockUpdateServer(upstreamFiles, providerCalls);
        providerServer = mock.server;
        const mockPort = await listen(providerServer);
        const mockOrigin = `http://127.0.0.1:${mockPort}`;
        report.mockUpdate = { origin: mockOrigin, version: mock.manifest.versions[0].tag, fileCount: upstreamFiles.size };

        const seedHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Migration seed</title></head><body>seed</body></html>';
        await Promise.all([
            fs.writeFile(path.join(relayDist, 'migration-seed.html'), seedHtml, 'utf8'),
            fs.writeFile(path.join(baselineDist, 'migration-seed.html'), seedHtml, 'utf8'),
            fs.writeFile(path.join(relayDist, 'module-probe.html'), moduleProbeHtml(), 'utf8')
        ]);

        const pagesPort = await availablePort();
        const origin = `http://127.0.0.1:${pagesPort}`;
        report.origin = origin;
        const bindings = {
            RP_SYNC_PASSWORD: PASSWORD,
            IMAGE_PROVIDER_STD_URL: mockOrigin,
            IMAGE_PROVIDER_STA1N_URL: mockOrigin,
            APP_UPDATE_MIRROR_BASE: mockOrigin
        };
        relayProcess = startWrangler(relayDist, stateRoot, configRoot, bindings, pagesPort);
        await waitForReady(origin, relayProcess);

        browser = await chromium.launch({
            executablePath: findChrome(),
            headless: true,
            args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server']
        });
        context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
        const imageResponses = [];
        page.on('response', (response) => {
            try {
                const url = new URL(response.url());
                if (url.pathname !== '/api/rp-image') return;
                imageResponses.push({
                    status: response.status(),
                    cache: response.headers()['x-rp-image-cache'] || '',
                    tag: url.searchParams.get('tag') || '',
                    characterUuid: url.searchParams.get('character_id') || ''
                });
            } catch {
                // Ignore unrelated responses.
            }
        });

        // A module-only probe verifies the canonical two world-info buckets are
        // read but never written by the relay conversion startup.
        const probePage = await context.newPage();
        await probePage.goto(`${origin}/module-probe.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await probePage.waitForFunction(() => globalThis.__probe || globalThis.__probeError, null, { timeout: 30000 });
        const probe = await probePage.evaluate(() => ({ result: globalThis.__probe || null, error: globalThis.__probeError || '' }));
        assert.equal(probe.error, '', probe.error);
        assert.deepEqual(probe.result.worldInfoWrites, []);
        report.phases.worldInfoRedline = { worldInfoWrites: probe.result.worldInfoWrites };
        await probePage.close();

        const seeded = await seedFullBrowser(page, origin, fixture);
        assert.equal(seeded.rows, 15);
        for (const record of [fixture.records.old, fixture.records.wrapped]) {
            const preloadResponse = await fetch(imageUrl(origin, record.paramsSnapshot, record.prompt, CHARACTER), {
                method: 'POST',
                headers: { 'x-rp-image-token': IMAGE_TOKEN, 'x-rp-sync-password': PASSWORD }
            });
            assert.equal(preloadResponse.status, 200, await preloadResponse.text());
            assert.equal(preloadResponse.headers.get('x-rp-image-cache'), 'MISS');
            await preloadResponse.body?.cancel().catch(() => {});
        }
        assert.equal(providerCalls.length, 2, 'R2 preload did not make exactly two provider calls');
        const providerBeforeLoad = providerCalls.length;

        await page.goto(`${origin}/?relay=first-load`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await waitForApp(page);
        const oldImage = await waitForImage(page, OLD_PROMPT);
        const oldHit = await poll('old image R2 HIT', () => imageResponses.find((entry) => entry.tag === OLD_PROMPT && entry.cache === 'HIT'));
        const wrappedImage = await waitForImage(page, WRAPPED_PROMPT);
        assert.equal(wrappedImage.rerollNonce, WRAPPED_REROLL_NONCE, 'wrapped record lost its rerollNonce');
        const wrappedHit = await poll('wrapped image R2 HIT', () => imageResponses.find((entry) => entry.tag === WRAPPED_PROMPT && entry.cache === 'HIT'));
        // The promptHash-mismatched floor must degrade to the F5 manual frame
        // and must never call the provider.
        await poll('mismatch floor manual frame', async () => page.evaluate(() => (
            [...document.querySelectorAll('.rp-generated-image-frame')]
                .some((frame) => String(frame.textContent || '').includes('未生成，点击按钮生成'))
        )), 90000, 250);
        await wait(700);
        assert.equal(providerCalls.length, providerBeforeLoad, 'old image generated instead of using R2');
        assert.ok(!imageResponses.some((entry) => entry.tag === MISMATCH_MESSAGE_PROMPT
            || entry.tag === MISMATCH_STORED_PROMPT), 'mismatch floor produced an image request');
        const wrappedResidue = await page.evaluate(() => {
            const text = [...document.querySelectorAll('#app *')]
                .map((element) => String(element.childNodes.length === 1 && element.firstChild?.nodeType === 3
                    ? element.textContent : ''))
                .join('\n');
            return {
                wrapperTagsVisible: /<\/image>|<image>/i.test(text),
                rawMarkersVisible: /image###/.test(text)
            };
        });
        const migratedRecord = await waitForRecord(page, CHARACTER.uuid, OLD_PROMPT);
        assert.equal(migratedRecord.paramsSnapshot.tag, OLD_PROMPT);
        assert.equal(migratedRecord.paramsSnapshot.characterUuid, CHARACTER.uuid);
        assert.equal(migratedRecord.key, nativeRecordKey(migratedRecord), 'active bucket record kept its magic 3-segment key');
        assert.ok(migratedRecord.imageSignature);
        // §2⑤: the never-activated character's bucket must have been swept and
        // persisted with native 4-segment keys without anyone opening it.
        const idleBucket = await waitForConvertedBucket(page, IDLE_CHARACTER.uuid, 1, 'idle character');
        assert.equal(idleBucket[0].key, nativeRecordKey(idleBucket[0]), 'idle bucket record kept its magic 3-segment key');
        assert.equal(idleBucket[0].paramsSnapshot.tag, IDLE_PROMPT);
        assert.equal(idleBucket[0].paramsSnapshot.characterUuid, IDLE_CHARACTER.uuid);
        // The active bucket ends with the three converted magic records plus
        // the F5 manual-frame record created for the unrecoverable floor.
        const activeBucket = await waitForConvertedBucket(page, CHARACTER.uuid, 4, 'active character');
        assert.ok(activeBucket.every((record) => record.paramsSnapshot?.tag), 'converted bucket has a record without tag');
        await page.waitForFunction(() => [...document.querySelectorAll('#app *')]
            .some((element) => String(element.textContent || '').trim() === '图片管理'), null, { timeout: 30000 });
        await dismissBlockingModals(page);
        const rerollButton = page.locator('.rp-image-reroll-button').first();
        await rerollButton.waitFor({ state: 'visible', timeout: 30000 });
        const providerBeforeReroll = providerCalls.length;
        await rerollButton.evaluate((button) => button.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
        })));
        const rerolledRecord = await poll('reroll record', async () => {
            const value = await readBrowserRecord(page, `rp_hub_image_renders_${CHARACTER.uuid}`);
            const record = Array.isArray(value) ? value.find((item) => item?.prompt === OLD_PROMPT) : null;
            return record?.paramsSnapshot?.rerollNonce ? record : null;
        }, 90000, 200);
        assert.ok(rerolledRecord.paramsSnapshot.rerollNonce);
        await poll('reroll provider call', () => providerCalls.length === providerBeforeReroll + 1, 30000, 150);
        assert.equal(providerCalls.length, providerBeforeReroll + 1, 'reroll did not call the provider once');
        report.phases.relay = {
            oldImage,
            oldHit,
            wrappedImage,
            wrappedHit,
            mismatchManualFrame: true,
            wrappedResidue,
            providerCallsBeforeLoad: providerBeforeLoad,
            providerCallsAfterLoad: providerCalls.length - 2,
            migratedRecord,
            idleBucket,
            rerolledRecord,
            imageManagementVisible: true,
            rerollAvailable: true
        };

        const versions = await postSync(origin, { action: 'app-update-versions', force: true });
        assert.equal(versions.response.status, 200, versions.payload.error);
        assert.equal(versions.payload.versions[0].tag, '1.8.7');
        const update = await postSync(origin, { action: 'app-update-apply', target: '1.8.7' });
        assert.equal(update.response.status, 200, update.payload.error);
        assert.equal(update.payload.latest.tag, '1.8.7');
        const updateCheck = await postSync(origin, { action: 'app-update-check' });
        assert.equal(updateCheck.response.status, 200, updateCheck.payload.error);
        assert.equal(updateCheck.payload.current.tag, '1.8.7');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
        await waitForApp(page);
        await dismissBlockingModals(page);
        const postUpdateImage = await waitForImage(page, OLD_PROMPT);
        const providerAfterUpdate = providerCalls.length;
        assert.equal(providerAfterUpdate, providerBeforeReroll + 1, 'online update caused an image regeneration');
        await page.locator('.rp-image-reroll-button').first().waitFor({ state: 'visible', timeout: 30000 });
        report.phases.onlineUpdate = {
            target: '1.8.7',
            fileCount: update.payload.fileCount,
            fileListSource: update.payload.fileListSource,
            image: postUpdateImage,
            providerDelta: providerAfterUpdate - (providerBeforeReroll + 1),
            rerollStillAvailable: true
        };

        // Snapshot the fully settled converted data only after the reroll and
        // the online update, so the formal-package byte compare covers the
        // exact records the relay leaves behind.
        const convertedBytes = await stableBucketBytes(page, CHARACTER.uuid);
        const convertedIdleBytes = await stableBucketBytes(page, IDLE_CHARACTER.uuid);

        const relayExit = await stopProcessTree(relayProcess);
        relayProcess = null;
        report.relayExitCode = relayExit;
        const baselineBindings = { ...bindings, APP_UPDATE_MIRROR_BASE: 'off' };
        baselineProcess = startWrangler(baselineDist, stateRoot, configRoot, baselineBindings, pagesPort);
        await waitForReady(origin, baselineProcess);
        await page.goto(`${origin}/?formal=020954`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await waitForApp(page);
        await dismissBlockingModals(page);
        const baselineOldImage = await waitForImage(page, OLD_PROMPT);
        const baselineRecords = await stableBucketBytes(page, CHARACTER.uuid);
        assert.equal(baselineRecords, convertedBytes, 'formal package changed converted record bytes');
        const baselineIdleRecords = await stableBucketBytes(page, IDLE_CHARACTER.uuid);
        assert.equal(baselineIdleRecords, convertedIdleBytes, 'formal package changed the swept idle bucket bytes');
        assert.equal(providerCalls.length, providerAfterUpdate, 'formal package regenerated an existing image');
        report.phases.formalReturn = {
            recordBytesUnchanged: true,
            idleRecordBytesUnchanged: true,
            recordCount: JSON.parse(baselineRecords).length,
            image: baselineOldImage,
            providerDelta: providerCalls.length - providerAfterUpdate,
            behaviorNormal: true
        };

        assert.deepEqual(pageErrors, [], `browser page errors:\n${pageErrors.join('\n')}`);
        report.providerCalls = providerCalls;
        report.imageResponses = imageResponses;
        report.pageErrors = pageErrors;
        report.ok = true;
        report.finishedAt = new Date().toISOString();
        await fs.mkdir(options.evidenceDir, { recursive: true });
        await fs.writeFile(path.join(options.evidenceDir, 'mogai-migration-relay-e2e.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        console.log(JSON.stringify(report, null, 2));
        console.log('mogai-migration-relay.runner.mjs: 3-segment key recompute, R2 HIT, zero regeneration, idle-bucket sweep, mismatch manual frame, wrapped message, 1.8.7 update, and formal-package return passed');
    } catch (error) {
        report.failure = { message: error?.message || String(error), stack: error?.stack || '' };
        report.providerCalls = providerCalls;
        report.pageErrors = pageErrors;
        report.wranglerOutput = [relayProcess, baselineProcess]
            .filter(Boolean)
            .map((item) => item.output.value.slice(-12000))
            .join('\n---\n');
        report.finishedAt = new Date().toISOString();
        await fs.mkdir(options.evidenceDir, { recursive: true }).catch(() => {});
        await fs.writeFile(path.join(options.evidenceDir, 'mogai-migration-relay-e2e.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => {});
        throw error;
    } finally {
        await stopProcessTree(relayProcess).catch(() => {});
        await stopProcessTree(baselineProcess).catch(() => {});
        await browser?.close().catch(() => {});
        await closeServer(providerServer).catch(() => {});
        await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
}

await main();
