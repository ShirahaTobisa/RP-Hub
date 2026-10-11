import { startHarness, initializeFixture, chromium, chrome, root, defaultUpstream } from './sync-195.helpers.mjs';

// 同步测速（基准，不是通过/失败测试）：两台“手机”（CPU 放慢 THROTTLE 倍、每个请求加 LATENCY 毫秒），
// A 首次上传 → 小改后再上传 → B 全量拉取 → A 再小改上传 → B 增量拉取。
// 每一步输出总耗时、进度条各阶段耗时、读库/序列化/算指纹/下载/校验/写回的累计耗时，以及请求数和传输量。
// 服务器是内存里的模拟：和真实服务器一样按指纹存块，已有的块不再上传；不含 Cloudflare 自身耗时和真实带宽。
// 用法：CHARS=40 MSGS=600 THROTTLE=4 LATENCY=80 UP_MBPS=10 DOWN_MBPS=30 node tests/sync-speed.runner.mjs
const CHARS = Number(process.env.CHARS || 40);
const MSGS = Number(process.env.MSGS || 600);
const THROTTLE = Number(process.env.THROTTLE || 4);
const LATENCY = Number(process.env.LATENCY || 80);
// 带宽（Mbps）：上传、下载各自共用一条线路，并发请求排队占用。
const UP_MBPS = Number(process.env.UP_MBPS || 10);
const DOWN_MBPS = Number(process.env.DOWN_MBPS || 30);
const link = { up: 0, down: 0 };
async function transfer(direction, bytes, mbps) {
    const start = Math.max(Date.now(), link[direction]);
    link[direction] = start + bytes * 8 / (mbps * 1000);
    await new Promise((resolve) => setTimeout(resolve, link[direction] - Date.now()));
}

const harness = await startHarness({ assets: root, upstream: defaultUpstream, metrics: true });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const chunks = new Map();
let manifest = null;
let pending = null;
let traffic = { requests: 0, up: 0, down: 0 };

async function syncApi(route) {
    const req = route.request();
    const url = new URL(req.url());
    traffic.requests += 1;
    await new Promise((resolve) => setTimeout(resolve, LATENCY));
    if (url.searchParams.get('action') === 'upload-part') {
        const body = req.postDataBuffer();
        traffic.up += body.length;
        await transfer('up', body.length, UP_MBPS);
        const checksum = req.headers()['x-rp-part-checksum'];
        chunks.set(checksum, body);
        const index = Number(url.searchParams.get('index'));
        return route.fulfill({ json: { ok: true, index, partNumber: index + 1, byteLength: body.length, checksum, key: checksum } });
    }
    const body = req.postDataJSON() || {};
    traffic.up += (req.postData() || '').length;
    if (body.action === 'pull-manifest') return route.fulfill({ json: { ok: true, remote: manifest } });
    if (body.action === 'upload-create') {
        if (manifest?.checksum === body.checksum) return route.fulfill({ json: { ok: true, alreadyUpToDate: true, remote: manifest } });
        pending = body;
        const missing = body.chunkManifest.filter((chunk) => !chunks.has(chunk.checksum)).map((chunk) => chunk.index);
        return route.fulfill({ json: { ok: true, missingIndices: missing, previousVersion: manifest?.version || 0 } });
    }
    if (body.action === 'upload-complete') {
        manifest = { ...pending, version: (manifest?.version || 0) + 1, chunkManifest: pending.chunkManifest.map((chunk) => ({ ...chunk, byteLength: chunk.length })) };
        delete manifest.action;
        return route.fulfill({ json: { ok: true, version: manifest.version, remote: manifest } });
    }
    if (body.action === 'pull-json-part') {
        const bytes = Buffer.concat(manifest.chunkManifest.slice(body.start, body.start + body.count).map((chunk) => chunks.get(chunk.checksum)));
        traffic.down += bytes.length;
        await transfer('down', bytes.length, DOWN_MBPS);
        return route.fulfill({ contentType: 'application/octet-stream', body: bytes, headers: { 'x-rp-sync-byte-length': String(bytes.length) } });
    }
    return route.fulfill({ json: { ok: true, authenticated: true, authRequired: false } });
}

async function device(seed) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.on('pageerror', (error) => console.log('PAGE ERROR', error.message));
    await page.route('**/*', async (route) => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === harness.url) {
            if (url.pathname === '/api/rp-sync') return syncApi(route);
            if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/image/api/')) return route.fulfill({ json: {} });
            return route.continue();
        }
        if (req.resourceType() === 'script') return route.continue();
        if (req.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: png });
        return route.fulfill({ contentType: 'text/css', body: '' });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ seed, chars, msgs }) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_sync_password_v1', 'bench');
        const user = { uuid: 'u', name: '用户', person: 'second' };
        const db = await fixture.db();
        const records = [['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', 'u'],
            ['rp_hub_settings', { autoFetchModels: false }], ['rp_hub_global_worldinfo', []], ['rp_hub_worldinfo', []], ['rp_hub_global_regex', []], ['rp_hub_regex', []]];
        if (seed) {
            const order = Array.from({ length: chars }, (_, i) => 'card-' + i);
            records.push(['rp_hub_character_index', { order }], ['rp_hub_last_active_char', 0]);
            const avatar = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(Math.floor(200 * 1024 / 11));
            const line = '她看着窗外的雨，轻声说道：“今天也要好好吃饭哦。”你点了点头，'.repeat(20);
            for (let c = 0; c < chars; c++) {
                records.push(['rp_hub_character_card-' + c, { uuid: 'card-' + c, name: '角色' + c, avatar, description: '设定'.repeat(1500), first_mes: '你好', worldInfo: [], regexScripts: [], uiTemplates: [] }]);
                records.push(['rp_hub_chat_card-' + c, Array.from({ length: msgs }, (_, m) => ({ id: `c${c}m${m}`, role: m % 2 ? 'user' : 'assistant', content: `${m} ${line}` }))]);
            }
        }
        for (let i = 0; i < records.length; i += 50) await fixture.write(db, records.slice(i, i + 50));
        db.close();
    }, { seed, chars: CHARS, msgs: MSGS });
    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.addLocatorHandler(page.getByRole('button', { name: /^(?:我)?知道了/ }).first(), (button) => button.click());
    await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__ && globalThis.api?.pushToServer, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    return { context, page, cdp };
}

async function measure(label, page, action, { reloads = false } = {}) {
    traffic = { requests: 0, up: 0, down: 0 };
    await page.evaluate(() => {
        globalThis.__perf = {};
        globalThis.__timeline = [];
        const record = () => {
            const text = document.querySelector('.rp-sync-modal__status')?.textContent || '';
            if (text && globalThis.__timeline.at(-1)?.text !== text) globalThis.__timeline.push({ at: performance.now(), text });
        };
        globalThis.__timelineObserver?.disconnect();
        globalThis.__timelineObserver = new MutationObserver(record);
        globalThis.__timelineObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
        globalThis.__timelineStart = performance.now();
    });
    const start = Date.now();
    let result;
    if (reloads) {
        // 拉取完成后页面会刷新：先取走计时，再等刷新。
        const navigation = page.waitForEvent('framenavigated', { timeout: 600000 });
        await page.evaluate(() => { api.pullFromServer(); });
        await page.waitForFunction(() => /即将刷新|失败|没有可同步/.test(document.querySelector('.rp-sync-modal__status')?.textContent || ''), null, { timeout: 600000, polling: 100 });
        result = await page.evaluate(() => ({ perf: globalThis.__perf, timeline: globalThis.__timeline.map((item) => ({ ms: Math.round(item.at - globalThis.__timelineStart), text: item.text })) }));
        await navigation;
    } else {
        await page.evaluate(action);
        result = await page.evaluate(() => ({ perf: globalThis.__perf, timeline: globalThis.__timeline.map((item) => ({ ms: Math.round(item.at - globalThis.__timelineStart), text: item.text })) }));
    }
    const total = Date.now() - start;
    const phases = result.timeline.map((item, i, all) => `${String((all[i + 1]?.ms ?? total) - item.ms).padStart(6)} ms  ${item.text.slice(0, 40)}`);
    const perf = Object.fromEntries(Object.entries(result.perf || {}).map(([key, value]) => [key, Math.round(value)]));
    console.log(`\n== ${label}：共 ${(total / 1000).toFixed(1)} 秒；请求 ${traffic.requests} 个，上传 ${(traffic.up / 1048576).toFixed(1)} MB，下载 ${(traffic.down / 1048576).toFixed(1)} MB`);
    console.log(phases.join('\n'));
    console.log('累计：', JSON.stringify(perf));
}

const editOneMessage = (page) => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('RPHubDB'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const read = () => new Promise((resolve) => { const r = db.transaction('store').objectStore('store').get('rp_hub_chat_card-3'); r.onsuccess = () => resolve(r.result); });
    const chat = await read();
    chat.push({ id: 'new-' + Date.now(), role: 'assistant', content: '新的一轮回复。'.repeat(50) });
    await new Promise((resolve) => { const t = db.transaction('store', 'readwrite'); t.objectStore('store').put(chat, 'rp_hub_chat_card-3'); t.oncomplete = resolve; });
    db.close();
});

try {
    console.log(`数据：${CHARS} 个角色（每个带约 200KB 头像）× 每个聊天 ${MSGS} 条；CPU 放慢 ${THROTTLE} 倍；每个请求 +${LATENCY} ms；上行 ${UP_MBPS} / 下行 ${DOWN_MBPS} Mbps`);
    const a = await device(true);
    await measure('A 首次上传', a.page, () => api.pushToServer());
    console.log('服务器快照大小：', (manifest.totalBytes / 1048576).toFixed(1), 'MB，分块', manifest.chunkManifest.length, '个');
    await editOneMessage(a.page);
    await measure('A 小改后上传', a.page, () => api.pushToServer());
    const b = await device(false);
    await measure('B 全量拉取（新设备）', b.page, null, { reloads: true });
    await b.page.waitForFunction(() => globalThis.api?.pullFromServer, null, { timeout: 300000 });
    await b.page.waitForTimeout(1500);
    await b.cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE }).catch(() => {});
    await editOneMessage(a.page);
    await measure('A 再小改后上传', a.page, () => api.pushToServer());
    const b2cdp = await b.context.newCDPSession(b.page);
    await b2cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    await measure('B 增量拉取', b.page, null, { reloads: true });
} finally {
    await browser.close();
    await harness.close();
}
