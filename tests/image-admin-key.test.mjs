import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const WORKER_FILE = path.join(ROOT_DIR, '_worker.js');
const PRIMARY_KEY = 'rp_hub_image_gen_key_v1';
const SHADOW_KEY = 'rphImgKeyShadow';

const workerSource = await fs.readFile(WORKER_FILE, 'utf8');
const htmlMarker = 'return new Response(`<!doctype html>';
const htmlStart = workerSource.indexOf(htmlMarker);
assert.notEqual(htmlStart, -1, 'image admin HTML start marker is missing');
const htmlBodyStart = htmlStart + 'return new Response(`'.length;
const htmlEnd = workerSource.indexOf('`, { headers:', htmlBodyStart);
assert.notEqual(htmlEnd, -1, 'image admin HTML end marker is missing');
const adminHtml = workerSource.slice(htmlBodyStart, htmlEnd);
const scriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>/);
assert(scriptMatch, 'image admin script is missing');
const adminScript = scriptMatch[1];

assert.match(adminHtml, /id="imageKeyMasked"/);
assert.match(adminHtml, /<button id="clearImageKey"[^>]+type="button">清除<\/button>/);
assert.doesNotMatch(adminHtml, /id="imageKey"|id="saveImageKey"|id="toggleImageKey"/);
assert.doesNotMatch(adminScript, /saveImageKey|toggleImageKey/);
assert.match(adminHtml, /@media\(max-width:720px\)/);
assert.match(adminHtml, /\.key-mask\{/);
assert.match(adminHtml, /\.key-settings>\.btn\{align-self:flex-start\}/);
assert.match(adminScript, new RegExp(`imageKeyStorageKey='${PRIMARY_KEY}'`));
assert.match(adminScript, new RegExp(`imageKeyShadowStorageKey='${SHADOW_KEY}'`));

function makeClassList(initial = []) {
    const values = new Set(initial);
    return {
        add(...names) {
            for (const name of names) values.add(name);
        },
        remove(...names) {
            for (const name of names) values.delete(name);
        },
        toggle(name, force) {
            const enabled = force === undefined ? !values.has(name) : Boolean(force);
            if (enabled) values.add(name);
            else values.delete(name);
            return enabled;
        },
        contains(name) {
            return values.has(name);
        }
    };
}

function makeElement(id) {
    const attributes = new Map();
    return {
        id,
        value: '',
        type: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        style: {},
        dataset: {},
        classList: makeClassList(id === 'auth' || id === 'app' ? ['hidden'] : []),
        closest() {
            return null;
        },
        focus() {},
        removeAttribute(name) {
            attributes.delete(name);
            delete this[name];
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        }
    };
}

class FakeStorage {
    constructor(entries = []) {
        this.values = new Map(entries);
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(String(key), String(value));
    }

    removeItem(key) {
        this.values.delete(key);
    }
}

async function runAdminScript(initialStorage) {
    const ids = [
        'password', 'auth', 'app', 'authMsg', 'library', 'stats', 'notice', 'filter',
        'refresh', 'deleteMode', 'cancelDelete', 'deleteSelected', 'viewer', 'viewerImage',
        'imageKeyMasked', 'imageKeyStatus', 'clearImageKey',
        'login', 'closeViewer'
    ];
    const elements = new Map(ids.map((id) => [id, makeElement(id)]));
    const localStorage = new FakeStorage(initialStorage);
    const requests = [];
    const storageListeners = [];
    const document = {
        body: { classList: makeClassList() },
        getElementById(id) {
            return elements.get(id) || null;
        }
    };
    const window = {
        addEventListener(type, listener) {
            if (type === 'storage') storageListeners.push(listener);
        }
    };
    const fetch = async (input) => {
        const target = String(input);
        requests.push(target);
        if (target === '/image/api/auth-status') {
            return new Response(JSON.stringify({ ok: true, authenticated: true }), {
                headers: { 'content-type': 'application/json' }
            });
        }
        if (target === '/image/api/library') {
            return new Response(JSON.stringify({
                ok: true,
                totalCount: 0,
                totalHuman: '0 B',
                characters: []
            }), { headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`Unexpected image admin request: ${target}`);
    };
    const context = vm.createContext({
        Boolean,
        JSON,
        Object,
        Response,
        Set,
        String,
        confirm: () => true,
        document,
        encodeURIComponent,
        fetch,
        localStorage,
        window
    });

    vm.runInContext(adminScript, context, { filename: 'image-admin-inline.js' });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return { elements, localStorage, requests, storageListeners };
}

const recovered = await runAdminScript([[SHADOW_KEY, 'STD-shadow-token']]);
assert.equal(recovered.localStorage.getItem(PRIMARY_KEY), 'STD-shadow-token');
assert.equal(recovered.elements.get('imageKeyMasked').textContent, 'STD-••••••oken');
assert.match(recovered.elements.get('imageKeyStatus').textContent, /已从本机恢复/);
assert.equal(recovered.storageListeners.length, 1);

const requestCountBeforeClear = recovered.requests.length;
recovered.elements.get('clearImageKey').onclick();
assert.equal(recovered.localStorage.getItem(PRIMARY_KEY), null);
assert.equal(recovered.localStorage.getItem(SHADOW_KEY), null);
assert.equal(recovered.elements.get('imageKeyMasked').textContent, '未设置');
assert.equal(recovered.requests.length, requestCountBeforeClear, 'clearing the key must not call a server API');

const cloudWins = await runAdminScript([
    [PRIMARY_KEY, 'STD-cloud-token'],
    [SHADOW_KEY, 'STD-stale-shadow']
]);
assert.equal(cloudWins.elements.get('imageKeyMasked').textContent, 'STD-••••••oken');
assert.equal(cloudWins.localStorage.getItem(PRIMARY_KEY), 'STD-cloud-token');
assert.equal(cloudWins.localStorage.getItem(SHADOW_KEY), 'STD-cloud-token');
assert.equal(cloudWins.elements.get('imageKeyStatus').textContent, '已设置');

console.log('image-admin-key.test.mjs: all assertions passed');
