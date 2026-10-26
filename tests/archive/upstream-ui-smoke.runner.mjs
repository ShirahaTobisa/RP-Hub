import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..');
const deliveryWranglerDirectory = path.resolve(projectRoot, '.wrangler');
const chrome = process.env.CHROME_PATH
    || 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const CHARACTER_UUID = '5d6ab0c8-ec42-46a1-a7f7-9ef47d667e29';
const USER_UUID = '36f0b8c5-27fa-4652-af76-6dbdf6ef9d73';
const CHARACTER_NAME = 'UI Smoke Character';
const CHAT_MARKER = 'UI_SMOKE_CHAT_VISIBLE';
const USAGE_MODEL = 'ui-smoke-model';
const USAGE_DETAIL = 'UI_SMOKE_USAGE_RECORD';
const SETTINGS_API_URL = 'https://ui-smoke.invalid/v1';

if (!existsSync(chrome)) {
    throw new Error(`Chrome executable not found: ${chrome}`);
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function getFreePort() {
    return new Promise((resolvePort, rejectPort) => {
        const server = createServer();
        server.once('error', rejectPort);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close((error) => error ? rejectPort(error) : resolvePort(address.port));
        });
    });
}

async function removeTemporaryDirectory(directory) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            return;
        } catch {
            await wait(300);
        }
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

function captureProcessOutput(child, output) {
    const outputLimit = 2 * 1024 * 1024;
    const capture = (chunk) => {
        if (output.length >= outputLimit) return;
        output.push(chunk.toString().slice(0, outputLimit - output.join('').length));
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
}

async function stopProcess(child) {
    if (!child || child.exitCode !== null) return;
    child.kill();
    await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        wait(3000)
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForHttp(url, child, output, label) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`${label} exited before becoming ready.\n${output.join('')}`);
        }
        try {
            const response = await fetch(url);
            if (response.ok) return response;
        } catch {
            // The listener is still starting.
        }
        await wait(150);
    }
    throw new Error(`${label} did not become ready.\n${output.join('')}`);
}

function formatRemoteValue(value) {
    if (Object.prototype.hasOwnProperty.call(value || {}, 'value')) {
        if (typeof value.value === 'string') return value.value;
        try {
            return JSON.stringify(value.value);
        } catch {
            return String(value.value);
        }
    }
    return value?.description || value?.unserializableValue || value?.type || 'unknown';
}

function formatException(details) {
    const exception = details?.exception?.description || details?.exception?.value;
    const location = details?.url
        ? `${details.url}:${Number(details.lineNumber || 0) + 1}:${Number(details.columnNumber || 0) + 1}`
        : '';
    return [details?.text, exception, location].filter(Boolean).join(' | ');
}

class CdpSession {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        socket.addEventListener('message', (event) => this.handleMessage(event));
        socket.addEventListener('close', () => this.rejectPending(new Error('Chrome DevTools connection closed.')));
        socket.addEventListener('error', () => this.rejectPending(new Error('Chrome DevTools connection failed.')));
    }

    static async connect(url) {
        const socket = new WebSocket(url);
        await new Promise((resolveOpen, rejectOpen) => {
            socket.addEventListener('open', resolveOpen, { once: true });
            socket.addEventListener('error', rejectOpen, { once: true });
        });
        return new CdpSession(socket);
    }

    handleMessage(event) {
        let message;
        try {
            message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        } catch {
            return;
        }
        if (message.id) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            clearTimeout(pending.timeout);
            if (message.error) pending.reject(new Error(message.error.message || 'Chrome DevTools command failed.'));
            else pending.resolve(message.result || {});
            return;
        }
        const handlers = this.listeners.get(message.method) || [];
        handlers.forEach((handler) => handler(message.params || {}));
    }

    rejectPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }

    on(method, handler) {
        const handlers = this.listeners.get(method) || [];
        handlers.push(handler);
        this.listeners.set(method, handlers);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
            const timeout = setTimeout(() => {
                this.pending.delete(id);
                rejectCommand(new Error(`Chrome DevTools command timed out: ${method}`));
            }, 30_000);
            this.pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timeout });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    close() {
        this.socket.close();
    }
}

async function evaluate(session, expression, options = {}) {
    const result = await session.send('Runtime.evaluate', {
        expression,
        awaitPromise: options.awaitPromise !== false,
        returnByValue: true,
        userGesture: true
    });
    if (result.exceptionDetails) throw new Error(formatException(result.exceptionDetails));
    return result.result?.value;
}

async function waitForEvaluation(session, expression, predicate, label, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let lastValue;
    let lastError;
    while (Date.now() < deadline) {
        try {
            lastValue = await evaluate(session, expression);
            if (predicate(lastValue)) return lastValue;
            lastError = null;
        } catch (error) {
            lastError = error;
        }
        await wait(150);
    }
    const detail = lastError ? lastError.message : JSON.stringify(lastValue);
    throw new Error(`${label} timed out. Last result: ${detail}`);
}

async function waitForDebugger(debugPort, chromeProcess, chromeOutput) {
    const versionUrl = `http://127.0.0.1:${debugPort}/json/version`;
    await waitForHttp(versionUrl, chromeProcess, chromeOutput, 'Chrome');
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page) throw new Error('Chrome did not expose a debuggable page target.');
    return page.webSocketDebuggerUrl;
}

async function navigate(session, url) {
    await session.send('Page.navigate', { url });
    const expectedUrls = [url];
    if (url.endsWith('.html')) expectedUrls.push(url.slice(0, -'.html'.length));
    await waitForEvaluation(
        session,
        `({ href: location.href, readyState: document.readyState })`,
        (value) => expectedUrls.includes(value?.href) && value.readyState === 'complete',
        `Navigation to ${url}`
    );
}

const seedRecords = [
    ['rp_hub_character_index', { order: [CHARACTER_UUID] }],
    [`rp_hub_character_${CHARACTER_UUID}`, {
        uuid: CHARACTER_UUID,
        name: CHARACTER_NAME,
        description: 'A split-record character used by the isolated upstream UI smoke test.',
        first_mes: 'Hello from the UI smoke fixture.',
        personality: 'Stable test fixture.',
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
            id: 'ui-smoke-user-message',
            role: 'user',
            content: 'UI_SMOKE_USER_MESSAGE',
            isSelf: true,
            timestamp: 1_700_000_000_100
        },
        {
            id: 'ui-smoke-assistant-message',
            role: 'assistant',
            content: CHAT_MARKER,
            isSelf: false,
            timestamp: 1_700_000_000_200
        }
    ]],
    ['rp_hub_settings', {
        apiUrl: SETTINGS_API_URL,
        apiKey: '',
        apiProviderId: 'custom',
        apiProviderKeys: { custom: '' },
        customApiUrl: SETTINGS_API_URL,
        imageGenKey: '',
        autoFetchModels: false,
        fontFamily: 'modern',
        fontFamilyVersion: 4,
        stream: true
    }],
    ['rp_hub_user', {
        uuid: USER_UUID,
        name: 'UI Smoke User',
        description: 'Isolated browser fixture',
        avatar: null,
        person: 'second'
    }],
    ['rp_hub_user_profiles', [{
        uuid: USER_UUID,
        name: 'UI Smoke User',
        description: 'Isolated browser fixture',
        avatar: null,
        person: 'second'
    }]],
    ['rp_hub_active_profile_id', USER_UUID],
    ['rp_hub_last_active_char', 0],
    ['rp_hub_token_usage_history', [{
        id: 'ui-smoke-usage-record',
        timestamp: 1_700_000_000_300,
        type: 'chat',
        model: USAGE_MODEL,
        detail: USAGE_DETAIL,
        characterName: CHARACTER_NAME,
        inputTokens: 3210,
        outputTokens: 456,
        totalTokens: 3666,
        cacheReadTokens: 78,
        cacheWriteTokens: 9,
        reasoningTokens: 12,
        reported: true
    }]]
];

const seedExpression = `
(async () => {
    localStorage.clear();
    localStorage.setItem('roleplay_hub_update_id', '999999999');
    await new Promise((resolveDelete, rejectDelete) => {
        const request = indexedDB.deleteDatabase('RPHubDB');
        request.onsuccess = () => resolveDelete();
        request.onerror = () => rejectDelete(request.error);
        request.onblocked = () => rejectDelete(new Error('RPHubDB delete was blocked.'));
    });
    const records = ${JSON.stringify(seedRecords)};
    await new Promise((resolveSeed, rejectSeed) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains('store')) database.createObjectStore('store');
        };
        request.onerror = () => rejectSeed(request.error);
        request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction('store', 'readwrite');
            transaction.oncomplete = () => {
                database.close();
                resolveSeed();
            };
            transaction.onerror = () => rejectSeed(transaction.error);
            transaction.onabort = () => rejectSeed(transaction.error || new Error('Seed transaction aborted.'));
            const store = transaction.objectStore('store');
            records.forEach(([key, value]) => store.put(value, key));
        };
    });
    return { records: records.length, updateId: localStorage.getItem('roleplay_hub_update_id') };
})()
`;

const appReadyExpression = `
(() => {
    const root = document.querySelector('#app');
    return {
        vueMounted: Boolean(root && root.__vue_app__),
        charStoreReady: typeof globalThis.RPHubCharStore?.loadAll === 'function',
        persistenceBridgeReady: typeof globalThis.RPH_R2_FLUSH_PERSISTENCE === 'function',
        syncButtonReady: Boolean(document.querySelector('[data-rph-sync-entry]')),
        characterVisible: document.body.innerText.includes(${JSON.stringify(CHARACTER_NAME)}),
        chatVisible: document.body.innerText.includes(${JSON.stringify(CHAT_MARKER)})
    };
})()
`;

const visibleCharacterCardExpression = `
(() => {
    const cards = Array.from(document.querySelectorAll('.char-grid-item'));
    const card = cards.find((element) => element.offsetParent !== null);
    return {
        visible: Boolean(card),
        text: card?.innerText || ''
    };
})()
`;

const visibleSettingsExpression = `
(() => ({
    heading: Array.from(document.querySelectorAll('h2')).some((element) => (
        element.offsetParent !== null && element.textContent.trim() === '设置'
    )),
    userSettings: Array.from(document.querySelectorAll('*')).some((element) => (
        element.offsetParent !== null && element.textContent.trim() === '用户设置'
    )),
    apiUrlLoaded: document.querySelector('input[placeholder="https://your-api.example/v1"]')?.value
        === ${JSON.stringify(SETTINGS_API_URL)}
}))()
`;

const visibleUsageExpression = `
(() => {
    const articles = Array.from(document.querySelectorAll('article')).filter((element) => element.offsetParent !== null);
    const text = articles.map((element) => element.innerText).join('\\n');
    return {
        heading: Array.from(document.querySelectorAll('h2')).some((element) => (
            element.offsetParent !== null && element.textContent.includes('Token 统计')
        )),
        model: text.includes(${JSON.stringify(USAGE_MODEL)}),
        detail: text.includes(${JSON.stringify(USAGE_DETAIL)}),
        character: text.includes(${JSON.stringify(CHARACTER_NAME)}),
        count: document.body.innerText.includes('共 1 条')
    };
})()
`;

const readSplitRecordsExpression = `
(async () => {
    const database = await new Promise((resolveOpen, rejectOpen) => {
        const request = indexedDB.open('RPHubDB', 1);
        request.onsuccess = () => resolveOpen(request.result);
        request.onerror = () => rejectOpen(request.error);
    });
    const transaction = database.transaction('store', 'readonly');
    const store = transaction.objectStore('store');
    const get = (key) => new Promise((resolveGet, rejectGet) => {
        const request = store.get(key);
        request.onsuccess = () => resolveGet(request.result);
        request.onerror = () => rejectGet(request.error);
    });
    const [index, character, legacy] = await Promise.all([
        get('rp_hub_character_index'),
        get(${JSON.stringify(`rp_hub_character_${CHARACTER_UUID}`)}),
        get('rp_hub_characters')
    ]);
    database.close();
    return { index, characterName: character?.name, legacyPresent: legacy !== undefined };
})()
`;

const temporaryDirectory = await mkdtemp(path.resolve(tmpdir(), 'rph-upstream-ui-smoke-'));
const wranglerPersistDirectory = path.resolve(temporaryDirectory, 'wrangler');
const chromeProfileDirectory = path.resolve(temporaryDirectory, 'chrome-profile');
const wranglerPort = await getFreePort();
const chromeDebugPort = await getFreePort();
const wranglerOutput = [];
const chromeOutput = [];
let wranglerProcess;
let chromeProcess;
let session;

try {
    await copyFile(path.resolve(projectRoot, 'wrangler.toml'), path.resolve(temporaryDirectory, 'wrangler.toml'));
    const wranglerScript = process.platform === 'win32'
        ? path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
        : '';
    const wranglerCommand = wranglerScript && existsSync(wranglerScript) ? process.execPath : 'wrangler';
    const wranglerArguments = [
        'pages', 'dev', projectRoot,
        '--port', String(wranglerPort),
        '--persist-to', wranglerPersistDirectory,
        '--compatibility-date', '2026-06-06',
        '--log-level', 'error',
        '--show-interactive-dev-session=false'
    ];
    if (wranglerCommand === process.execPath) wranglerArguments.unshift(wranglerScript);
    wranglerProcess = spawn(wranglerCommand, wranglerArguments, {
        cwd: temporaryDirectory,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    captureProcessOutput(wranglerProcess, wranglerOutput);

    const baseUrl = `http://127.0.0.1:${wranglerPort}`;
    const rootResponse = await waitForHttp(baseUrl, wranglerProcess, wranglerOutput, 'Wrangler');
    const rootHtml = await rootResponse.text();
    const charStoreIndex = rootHtml.indexOf('/DB/char-store.js?v=r2-rebuild-1');
    const bootstrapIndex = rootHtml.indexOf('/DB/bootstrap.js?v=r2-rebuild-1');
    const appIndex = rootHtml.indexOf('assets/js/app.js');
    assert(charStoreIndex >= 0, 'Worker did not inject char-store.js.');
    assert(bootstrapIndex > charStoreIndex, 'Worker injection order must be char-store.js then bootstrap.js.');
    assert(appIndex > bootstrapIndex, 'Worker injections must execute before the upstream app.js loader.');
    const appSource = await (await fetch(`${baseUrl}/assets/js/app.js`)).text();
    assert.match(appSource, /### RP-Hub 1\.7\.5/);

    chromeProcess = spawn(chrome, [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--window-size=1440,1000',
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${chromeDebugPort}`,
        `--user-data-dir=${chromeProfileDirectory}`,
        'about:blank'
    ], {
        cwd: projectRoot,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    captureProcessOutput(chromeProcess, chromeOutput);

    session = await CdpSession.connect(await waitForDebugger(chromeDebugPort, chromeProcess, chromeOutput));
    await Promise.all([
        session.send('Page.enable'),
        session.send('Runtime.enable'),
        session.send('Log.enable')
    ]);

    let collectRuntimeFailures = false;
    const runtimeFailures = [];
    const dialogs = [];
    session.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
        if (collectRuntimeFailures) runtimeFailures.push(`exception: ${formatException(exceptionDetails)}`);
    });
    session.on('Runtime.consoleAPICalled', ({ type, args }) => {
        if (!collectRuntimeFailures || !['error', 'assert'].includes(type)) return;
        runtimeFailures.push(`console.${type}: ${(args || []).map(formatRemoteValue).join(' ')}`);
    });
    session.on('Log.entryAdded', ({ entry }) => {
        if (!collectRuntimeFailures || entry?.level !== 'error') return;
        if (['network', 'security'].includes(entry.source)) return;
        runtimeFailures.push(`log.${entry.source}: ${entry.text}`);
    });
    session.on('Page.javascriptDialogOpening', ({ message }) => {
        if (collectRuntimeFailures) dialogs.push(message || 'Unexpected JavaScript dialog');
        session.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => { });
    });

    const fixtureUrl = `${baseUrl}/tests/upstream-ui-smoke.fixture.html`;
    await navigate(session, fixtureUrl);
    const seeded = await evaluate(session, seedExpression);
    assert.equal(seeded.records, seedRecords.length);
    assert.equal(seeded.updateId, '999999999');

    collectRuntimeFailures = true;
    await session.send('Page.navigate', { url: `${baseUrl}/` });
    const ready = await waitForEvaluation(
        session,
        appReadyExpression,
        (value) => Object.values(value || {}).every(Boolean),
        'Upstream 1.7.5 application startup',
        60_000
    );
    assert.deepEqual(ready, {
        vueMounted: true,
        charStoreReady: true,
        persistenceBridgeReady: true,
        syncButtonReady: true,
        characterVisible: true,
        chatVisible: true
    });

    const liveScripts = await evaluate(session, `Array.from(document.scripts).map((script) => {
        try { return new URL(script.src, location.href).pathname; } catch { return ''; }
    })`);
    const liveCharStoreIndex = liveScripts.indexOf('/DB/char-store.js');
    const liveBootstrapIndex = liveScripts.indexOf('/DB/bootstrap.js');
    const liveAppIndex = liveScripts.indexOf('/assets/js/app.js');
    assert(liveCharStoreIndex >= 0, 'Live page did not execute char-store.js.');
    assert(liveBootstrapIndex > liveCharStoreIndex, 'Live page executed bootstrap.js before char-store.js.');
    assert(liveAppIndex > liveBootstrapIndex, 'Live page executed app.js before the R2 injections.');

    const syncButton = await evaluate(session, `(() => {
        const button = document.querySelector('[data-rph-sync-entry]');
        return { exists: Boolean(button), visible: Boolean(button?.offsetParent), text: button?.innerText.trim() || '' };
    })()`);
    assert.deepEqual(syncButton, { exists: true, visible: true, text: '同步' });

    assert.equal(await evaluate(session, `(() => {
        const button = document.querySelector('button[title="角色卡管理"]');
        button?.click();
        return Boolean(button);
    })()`), true);
    const characterCard = await waitForEvaluation(
        session,
        visibleCharacterCardExpression,
        (value) => value?.visible && value.text.includes(CHARACTER_NAME),
        'Character management view'
    );
    assert.match(characterCard.text, new RegExp(CHARACTER_NAME));
    assert.equal(await evaluate(session, `(() => {
        const cards = Array.from(document.querySelectorAll('.char-grid-item'));
        const card = cards.find((element) => element.offsetParent !== null);
        card?.click();
        return Boolean(card);
    })()`), true);
    await waitForEvaluation(
        session,
        `({
            chatVisible: document.body.innerText.includes(${JSON.stringify(CHAT_MARKER)}),
            characterVisible: document.body.innerText.includes(${JSON.stringify(CHARACTER_NAME)}),
            chatNavActive: document.querySelector('button[title="聊天"]')?.className.includes('bg-primary-50') || false
        })`,
        (value) => value?.chatVisible && value.characterVisible && value.chatNavActive,
        'Opening the pre-seeded character chat'
    );

    assert.equal(await evaluate(session, `(() => {
        const button = document.querySelector('button[title="设置"]');
        button?.click();
        return Boolean(button);
    })()`), true);
    const settingsView = await waitForEvaluation(
        session,
        visibleSettingsExpression,
        (value) => value?.heading && value.userSettings && value.apiUrlLoaded,
        'Settings view'
    );
    assert.deepEqual(settingsView, { heading: true, userSettings: true, apiUrlLoaded: true });

    assert.equal(await evaluate(session, `(() => {
        const button = document.querySelector('button[title="统计"]');
        button?.click();
        return Boolean(button);
    })()`), true);
    const usageView = await waitForEvaluation(
        session,
        visibleUsageExpression,
        (value) => Object.values(value || {}).every(Boolean),
        'Token usage view'
    );
    assert.deepEqual(usageView, {
        heading: true,
        model: true,
        detail: true,
        character: true,
        count: true
    });

    const splitRecords = await evaluate(session, readSplitRecordsExpression);
    assert.deepEqual(splitRecords.index?.order, [CHARACTER_UUID]);
    assert.equal(splitRecords.characterName, CHARACTER_NAME);
    assert.equal(splitRecords.legacyPresent, false);

    await wait(500);
    const uniqueRuntimeFailures = [...new Set(runtimeFailures.filter(Boolean))];
    assert.deepEqual(dialogs, [], `Unexpected dialogs: ${dialogs.join(' | ')}`);
    assert.deepEqual(uniqueRuntimeFailures, [], `Fatal browser errors:\n${uniqueRuntimeFailures.join('\n')}`);

    console.log('PASS upstream 1.7.5 UI smoke: startup, split character/chat, settings, token usage, sync button');
} catch (error) {
    const diagnostics = [
        error?.stack || String(error),
        wranglerOutput.length ? `\nWrangler output:\n${wranglerOutput.join('')}` : '',
        chromeOutput.length ? `\nChrome output:\n${chromeOutput.join('')}` : ''
    ].join('');
    throw new Error(diagnostics);
} finally {
    session?.close();
    await stopProcess(chromeProcess);
    await stopProcess(wranglerProcess);
    await removeTemporaryDirectory(temporaryDirectory);
    assert.equal(existsSync(deliveryWranglerDirectory), false, 'UI smoke runner polluted the delivery root with .wrangler');
}
