import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const modulePath = path.join(root, 'DB', 'image-module.js');
const uuid = 'image-attribution-189-card';
const character = { uuid, name: 'Attribution Card' };

function loadPlaywright() {
    return createRequire(import.meta.url)('playwright');
}

function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    ].filter(Boolean);
    const found = candidates.find(existsSync);
    if (!found) throw new Error(`Chrome executable not found: ${candidates.join(', ')}`);
    return found;
}

async function availablePort() {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    server.close();
    await once(server, 'close');
    return port;
}

async function stopProcessTree(child) {
    if (!child || child.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 4000))]);
}

function startWrangler(distRoot, stateRoot, configRoot, port) {
    const wrangler = path.resolve(process.env.APPDATA || '', 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
    const output = { value: '' };
    const child = spawn(process.execPath, [
        wrangler, 'pages', 'dev', '.', '--port', String(port), '--persist-to', stateRoot,
        '--compatibility-date', '2026-07-15', '--log-level', 'error', '--show-interactive-dev-session=false'
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

async function waitForReady(origin, child, output) {
    for (let attempt = 0; attempt < 180; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`Wrangler exited early.\n${output.value}`);
        try {
            if ((await fetch(origin)).ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Wrangler did not become ready.\n${output.value}`);
}

function fixtureHtml() {
    return `<!doctype html><html><head><meta charset="utf-8"><title>image attribution 189</title></head><body>
<main id="app"><div class="absolute"><span class="ml-2 font-medium">${character.name}</span><button title="清空聊天">清空</button></div>
<button id="send" title="发送">发送</button><aside class="app-sidebar"><button><span>设置</span></button></aside><section id="chat"></section></main>
<script>
const CHARACTER = ${JSON.stringify(character)};
const put = (store, key, value) => store.put(value, key);
const openDb = () => new Promise((resolve, reject) => { const request = indexedDB.open('RPHubDB', 1); request.onupgradeneeded = () => request.result.createObjectStore('store'); request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result); });
const dbPut = async (key, value) => { const db = await openDb(); await new Promise((resolve, reject) => { const tx = db.transaction('store', 'readwrite'); put(tx.objectStore('store'), key, value); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close(); };
const dbDelete = async (key) => { const db = await openDb(); await new Promise((resolve, reject) => { const tx = db.transaction('store', 'readwrite'); tx.objectStore('store').delete(key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close(); };
const dbGet = async (key) => { const db = await openDb(); const value = await new Promise((resolve, reject) => { const tx = db.transaction('store', 'readonly'); const request = tx.objectStore('store').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); db.close(); return value; };
const proxy = { regexScripts: [], worldInfo: [{ comment: '自动生图', enabled: true }], chatHistory: [], currentCharacter: CHARACTER };
document.getElementById('app').__vue_app__ = { _instance: { proxy } };
globalThis.RPH_R2_FLUSH_PERSISTENCE = async () => true;
globalThis.__providerPosts = 0;
const nativeFetch = fetch;
globalThis.fetch = async (input, init = {}) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href); if (url.pathname === '/api/rp-image' && init.method === 'POST') { globalThis.__providerPosts += 1; return new Response(null, { status: 200 }); } return nativeFetch(input, init); };
const render = (message, options = {}) => { if (options.grow) proxy.chatHistory.push(message); else proxy.chatHistory = options.chat || [message]; const row = document.createElement('article'); row.dataset.chatIndex = String(options.index || 0); row.dataset.role = 'assistant'; row.innerHTML = '<div class="message-content-wrapper">' + (options.reasoning ? '<div class="summary-timeline-card"><div class="markdown-body">' + options.reasoning + '</div></div>' : '') + '<div class="markdown-body">' + (options.dom || message.content) + '</div></div><span class="msg-name-tag">${character.name}</span>'; document.querySelector('#chat').replaceChildren(row); return row; };
globalThis.__fixture = { proxy, dbPut, dbDelete, dbGet, render, character: CHARACTER };
</script><script src="/DB/nav-adapter.js"></script><script src="/DB/image-module.js"></script></body></html>`;
}

async function reset(page) {
    await page.evaluate(async ({ uuid }) => {
        const f = globalThis.__fixture;
        f.proxy.currentCharacter = f.character;
        f.proxy.chatHistory = [];
        document.querySelector('#chat').replaceChildren();
        document.querySelector('#send').style.display = '';
        document.getElementById('app').__vue_app__ = { _instance: { proxy: f.proxy } };
        globalThis.__providerPosts = 0;
        await f.dbPut('rp_hub_character_index', { order: [uuid] });
        await f.dbPut('rp_hub_character_' + uuid, f.character);
        await f.dbPut('rp_hub_last_active_char', uuid);
        await f.dbPut('rp_hub_settings', { freezeImageGeneration: true });
        await f.dbPut('rp_hub_global_worldinfo', [{ comment: '自动生图', enabled: true }]);
        await f.dbPut('rp_hub_global_regex', []);
        await f.dbDelete('rp_hub_image_renders_' + uuid);
        await f.dbPut('rp_hub_chat_' + uuid, []);
    }, { uuid });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(globalThis.RPHubImageModule?.getState));
}

async function scan(page, fixture) {
    await page.evaluate(async (value) => {
        const f = globalThis.__fixture;
        const message = { id: value.id, role: 'assistant', content: value.content };
        f.render(message, value);
        await f.dbPut('rp_hub_chat_' + value.uuid, value.dbChat ?? [message]);
        await globalThis.RPHubImageModule.scan();
    }, { ...fixture, uuid });
    await page.waitForFunction(() => {
        const row = document.querySelector('[data-chat-index]');
        return row?.querySelector('.rp-generated-image-frame')
            || row?.dataset.rphImageAttributionRetry || row?.dataset.rphImageAttributionFailure;
    });
}

async function result(page) {
    return page.evaluate(() => {
        const row = document.querySelector('[data-chat-index]');
        return {
            frame: Boolean(row?.querySelector('.rp-generated-image-frame')),
            image: Boolean(row?.querySelector('.rp-generated-image-frame img')),
            reroll: Boolean(row?.querySelector('.rp-image-reroll-button')),
            failure: row?.dataset.rphImageAttributionFailure || '',
            retry: row?.dataset.rphImageAttributionRetry || '',
            toasts: document.querySelectorAll('[data-rph-image-toast]').length,
            source: globalThis.RPHubImageModule.getState().attributionSource,
            posts: globalThis.__providerPosts
        };
    });
}

const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rph-attribution-189-'));
const distRoot = path.join(runtimeRoot, 'dist');
const stateRoot = path.join(runtimeRoot, 'state');
const configRoot = path.join(runtimeRoot, 'config');
let wrangler;
let browser;
try {
    await fs.mkdir(path.join(distRoot, 'DB'), { recursive: true });
    await fs.mkdir(configRoot, { recursive: true });
    await fs.copyFile(modulePath, path.join(distRoot, 'DB', 'image-module.js'));
    await fs.copyFile(path.join(root, 'DB', 'nav-adapter.js'), path.join(distRoot, 'DB', 'nav-adapter.js'));
    await fs.writeFile(path.join(distRoot, 'index.html'), fixtureHtml(), 'utf8');
    await fs.writeFile(path.join(distRoot, '_worker.js'), 'export default { fetch(request, env) { return env.ASSETS.fetch(request); } };', 'utf8');
    const port = await availablePort();
    const run = startWrangler(distRoot, stateRoot, configRoot, port);
    wrangler = run.child;
    const origin = `http://127.0.0.1:${port}`;
    await waitForReady(origin, wrangler, run.output);
    const { chromium } = loadPlaywright();
    browser = await chromium.launch({ executablePath: findChrome(), headless: true });
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(globalThis.RPHubImageModule?.getState));

    await reset(page);
    await scan(page, { id: 'branch', content: 'image###branch clean###', dbChat: [], chat: [{ id: 'branch', role: 'assistant', content: 'image###branch clean###' }] });
    let value = await result(page);
    assert.equal(value.source, 'runtime-rescue');
    assert.equal(value.failure, '');
    assert.equal(value.frame, true);

    await reset(page);
    await scan(page, { id: 'reasoning', content: 'image###clean body###', reasoning: 'image###draft only###', dom: '<span>image###clean body###</span>' });
    value = await result(page);
    assert.equal(value.failure, '');
    assert.equal(value.frame, true);

    await reset(page);
    await scan(page, { id: 'markdown', content: 'image###2girls, *smile*, night_sky###', dom: 'image###2girls, smile, night_sky###' });
    value = await result(page);
    assert.equal(value.failure, '');
    assert.equal(value.frame, true);

    await reset(page);
    await scan(page, { id: 'forged', content: 'message has no marker', dom: 'image###forged###' });
    await page.waitForTimeout(2200);
    value = await result(page);
    assert.notEqual(value.failure, '');
    assert.ok(value.toasts > 0);
    await page.evaluate(async ({ uuid }) => {
        const f = globalThis.__fixture;
        const message = { id: 'forged', role: 'assistant', content: 'image###forged###' };
        f.proxy.chatHistory = [message];
        await f.dbPut('rp_hub_chat_' + uuid, [message]);
        const typing = document.createElement('div');
        typing.className = 'typing-bubble';
        document.getElementById('app').appendChild(typing);
        await globalThis.RPHubImageModule.scan();
        typing.remove();
    }, { uuid });
    await page.waitForFunction(() => Boolean(document.querySelector('.rp-generated-image-frame')));
    value = await result(page);
    assert.equal(value.failure, '', JSON.stringify(value));
    assert.equal(value.frame, true, JSON.stringify(value));

    await reset(page);
    await scan(page, { id: 'cold', content: 'image###cold old###' });
    value = await result(page);
    assert.equal(value.posts, 0);
    assert.equal(value.reroll, true);
    assert.equal(value.image, false);

    await reset(page);
    await scan(page, { id: 'old-dynamic', content: 'image###old dynamic###' });
    value = await result(page);
    assert.equal(value.posts, 0);
    assert.equal(value.reroll, true);
    assert.equal(value.image, false);

    await reset(page);
    await scan(page, { id: 'recent-dynamic', content: 'image###recent dynamic###' });
    value = await result(page);
    assert.equal(value.posts, 0);
    assert.equal(value.reroll, true);
    assert.equal(value.image, false);

    await reset(page);
    await page.evaluate(async ({ uuid }) => {
        const f = globalThis.__fixture;
        const message = { id: 'hit', role: 'assistant', content: 'image###existing hit###' };
        const probe = globalThis.RPHubImageModule.getFrozenImageRenderRecord('existing hit', 0, {
            messageId: message.id,
            messageIndex: 0,
            rawContent: message.content,
            attribution: f.character
        });
        probe.status = 'rendered';
        await f.dbPut('rp_hub_image_renders_' + uuid, [probe]);
    }, { uuid });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(globalThis.RPHubImageModule?.getState));
    await scan(page, { id: 'hit', content: 'image###existing hit###' });
    value = await result(page);
    assert.equal(value.posts, 0);
    assert.equal(value.image, true);

    await reset(page);
    await page.evaluate(() => {
        const typing = document.createElement('div');
        typing.className = 'typing-bubble';
        document.getElementById('app').appendChild(typing);
        return globalThis.RPHubImageModule.scan().then(() => typing.remove());
    });
    await scan(page, { id: 'new', content: 'image###new live###', grow: true });
    assert.equal(await page.evaluate(() => Object.hasOwn(globalThis.__fixture.proxy.chatHistory.at(-1), 'timestamp')), false);
    value = await result(page);
    assert.equal(value.image, true, JSON.stringify(value));
    await page.evaluate(() => {
        const image = document.querySelector('.rp-generated-image-frame img');
        image.dispatchEvent(new Event('error'));
    });
    await page.waitForTimeout(250);
    value = await result(page);
    assert.equal(value.posts, 1, JSON.stringify(value));

    await page.evaluate(() => { globalThis.__providerPosts = 0; });
    await scan(page, {
        id: 'switched-old',
        content: 'image###switched old###'
    });
    value = await result(page);
    assert.equal(value.posts, 0, JSON.stringify(value));
    assert.equal(value.reroll, true, JSON.stringify(value));
    assert.equal(value.image, false, JSON.stringify(value));

    await reset(page);
    await page.evaluate(() => { document.getElementById('app').__vue_app__ = null; });
    await scan(page, { id: 'rescue-off', content: 'image###branch unavailable###', dbChat: [], chat: [{ id: 'rescue-off', role: 'assistant', content: 'image###branch unavailable###' }] });
    await page.waitForTimeout(2200);
    value = await result(page);
    assert.notEqual(value.failure, '');

    await reset(page);
    await page.evaluate(() => { document.getElementById('app').__vue_app__ = null; });
    await scan(page, { id: 'main-no-vue', content: 'image###main *markdown*###', dom: 'image###main markdown###' });
    value = await result(page);
    assert.equal(value.failure, '');
    assert.equal(value.frame, true);

    await reset(page);
    await page.evaluate(() => { document.getElementById('app').__vue_app__ = null; });
    await scan(page, { id: 'reasoning-no-vue', content: 'image###clean no vue###', reasoning: 'image###draft no vue###', dom: '<span>image###clean no vue###</span>' });
    value = await result(page);
    assert.equal(value.failure, '');
    assert.equal(value.frame, true);

    await reset(page);
    const startedAt = Date.now();
    await page.evaluate(async ({ count, uuid }) => {
        const f = globalThis.__fixture;
        const messages = [];
        const rows = [];
        for (let index = 0; index < count; index += 1) {
            const content = index % 6 === 0 ? `image###fixture ${index}###` : `plain ${index}`;
            const message = { id: `row-${index}`, role: 'assistant', content };
            messages.push(message);
            const row = document.createElement('article');
            row.dataset.chatIndex = String(index);
            row.dataset.role = 'assistant';
            row.innerHTML = `<div class="message-content-wrapper"><div class="markdown-body">${content}</div></div><span class="msg-name-tag">${f.character.name}</span>`;
            rows.push(row);
        }
        f.proxy.chatHistory = messages;
        document.querySelector('#chat').replaceChildren(...rows);
        await f.dbPut('rp_hub_chat_' + uuid, messages);
        await globalThis.RPHubImageModule.scan();
    }, { count: 300, uuid });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs <= 3000, `300-row fixture took ${elapsedMs}ms`);
    const processedMarkers = await page.evaluate(() => [...document.querySelectorAll('[data-chat-index]')]
        .filter((row) => Number(row.dataset.chatIndex) % 6 === 0)
        .filter((row) => row.querySelector('.rp-generated-image-frame')
            || row.dataset.rphImageAttributionFailure
            || !/(?:image|rph-image-marker)###/i.test(row.textContent || '')).length);
    assert.equal(processedMarkers, 50, '300-row fixture left image markers unprocessed');

    console.log(JSON.stringify({ ok: true, scenarios: 7, rows: 300, elapsedMs }, null, 2));
} finally {
    await browser?.close().catch(() => {});
    await stopProcessTree(wrangler).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fs.rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
