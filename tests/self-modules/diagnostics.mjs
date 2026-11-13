import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
if (!process.env.RPH_MIRROR_DIR) throw new Error('Set RPH_MIRROR_DIR to the RP-Hub-Update-Mirror checkout.');
const mirrorRoot = path.resolve(process.env.RPH_MIRROR_DIR);
const { default: mirror } = await import(pathToFileURL(path.join(mirrorRoot, 'worker.mjs')));
const { FakeR2 } = await import(pathToFileURL(path.join(mirrorRoot, 'tests/r2.mjs')));

const built = path.resolve(process.argv[2] || fileURLToPath(new URL('../../', import.meta.url)));
const { default: worker } = await import(pathToFileURL(path.join(built, '_worker.js')));
const { chromium } = createRequire(import.meta.url)('playwright');
const bucket = new FakeR2();
bucket.list = async ({ prefix = '' }) => ({ objects: [...bucket.records].filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => ({ key, customMetadata: value.customMetadata })).sort((a, b) => a.key.localeCompare(b.key)), truncated: false });
const mirrorEnv = { MIRROR_BUCKET: bucket, ADMIN_TOKEN: 'fixture-admin' };
const siteEnv = { RP_SYNC_R2: new FakeR2(), RP_SYNC_PASSWORD: 'fixture-sync', CF_ACCOUNT_ID: 'fixture-account', APP_UPDATE_MIRROR_BASE: 'https://mirror.test' };
let offline = false;
const requests = [], errors = [];
globalThis.fetch = (input, init) => {
    assert.equal(new URL(input).origin, 'https://mirror.test', 'no real external service is contacted');
    if (offline) throw new Error('fixture receiver offline');
    return mirror.fetch(new Request(input, init), mirrorEnv);
};
const html = `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/assets/css/theme.css"><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/DB/styles.css">
    <script>window.RPH_R2_DIAGNOSTICS={release:'2026.11.10.2',upstream:'2.0.6',usage:true};</script>
    <script src="/DB/ui-kit.js"></script><script src="/DB/nav-adapter.js"></script></head>
    <body><div id="app"><aside class="app-sidebar"><button><svg></svg><span>设置</span></button></aside></div></body></html>`;
const server = http.createServer(async (request, response) => {
    try {
        if (request.url.startsWith('/DB/') || request.url.startsWith('/assets/css/')) {
            response.setHeader('content-type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript');
            response.end(await fs.readFile(path.join(built, request.url.slice(1))));
            return;
        }
        if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end(html); return; }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        const incoming = new Request('https://site.test' + request.url, { method: request.method, headers: request.headers,
            ...(bytes.length ? { body: bytes } : {}) });
        const isSite = request.url === '/api/rp-feedback';
        if (isSite) requests.push(JSON.parse(bytes));
        const result = await (isSite ? worker.fetch(incoming, siteEnv, {}) : mirror.fetch(incoming, mirrorEnv));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.body) Readable.fromWeb(result.body).pipe(response); else response.end();
    } catch (error) { response.writeHead(500); response.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || chromium.executablePath() });
const output = path.join(built, 'evidence/self-modules');
await fs.mkdir(output, { recursive: true });
try {
    const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: Date.now() });
    await page.addInitScript(() => {
        localStorage.setItem('rp_hub_sync_password_v1', 'fixture-sync');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ id: 'fixture-plugin', version: '1', enabled: true, lastStatus: 'ok', url: 'https://private.test/?token=private-token' }]));
    });
    const firstUsage = page.waitForResponse(response => response.url().endsWith('/api/rp-feedback'));
    await page.goto(base);
    await page.waitForFunction(() => window.RPHubDiagnostics && window.RPHubNavAdapter);
    await firstUsage;
    assert.equal(requests.filter(item => item.action === 'usage').length, 1);
    assert.equal(requests.filter(item => item.action === 'report').length, 0, 'logs are never sent automatically');
    await page.evaluate(() => {
        console.warn('private-chat-text', { apiKey: 'private-api-key', password: 'private-password' });
        const error = new TypeError('private-chat-text private-api-key');
        error.status = 503;
        error.stack = 'TypeError: private-chat-text\n at work (https://site.test/DB/image-module.js?token=private-token:12:3)';
        dispatchEvent(new ErrorEvent('error', { error }));
        const watches = [], data = { currentCharacter: { uuid: 'private-card-A' }, chatHistory: [{ content: 'private-chat-text' }], isGenerating: false };
        RPHubDiagnostics.attachApp({ get: key => data[key], watch: (get, callback, options) => { watches.push(callback); if (options?.immediate) callback(get()); } });
        watches[1](true);
        data.currentCharacter = { uuid: 'private-card-B' };
        watches[0](data.currentCharacter.uuid);
        watches[1](false);
        RPHubUI.openLogViewer();
    });
    const panel = page.locator('[data-rph-diagnostics]');
    await panel.waitFor();
    assert.equal(await panel.locator('[data-details]').getAttribute('open'), null, 'raw report starts collapsed');
    const preview = panel.locator('[data-preview]');
    const text = await preview.inputValue();
    for (const secret of ['private-chat-text', 'private-api-key', 'private-password', 'private-token', 'private-card-', 'fixture-sync', 'fixture-account']) assert.ok(!text.includes(secret), secret);
    const parsed = JSON.parse(text);
    assert.deepEqual(parsed.events.find(item => item.kind === 'page-error').frames, ['/DB/image-module.js:12:3']);
    assert.equal(parsed.events.find(item => item.kind === 'page-error').status, 503);
    const end = parsed.events.find(item => item.kind === 'generation-end');
    assert.equal(end.owner, 'C1'); assert.equal(end.current, 'C2');
    await panel.locator('[data-issue]').selectOption('image');
    await panel.locator('[data-note]').fill('角色切换后图片没有跟着切换');
    await panel.locator('label:has([data-usage])').click();
    assert.equal(await panel.locator('[data-usage]').isChecked(), false);
    await page.clock.fastForward(2 * 86400000);
    assert.equal(requests.filter(item => item.action === 'usage').length, 1, 'opt-out stops later daily sends');
    const download = page.waitForEvent('download');
    await panel.locator('[data-download]').click();
    const file = await download;
    await file.saveAs(path.join(output, 'fixture-feedback.json'));
    assert.equal(JSON.parse(await fs.readFile(path.join(output, 'fixture-feedback.json'), 'utf8')).issue, 'image');
    const sent = page.waitForResponse(response => response.url().endsWith('/api/rp-feedback') && response.request().postDataJSON().action === 'report');
    await panel.locator('[data-send]').click();
    const reply = await sent;
    assert.equal(reply.status(), 200, await reply.text());
    await page.clock.runFor(100);
    assert.equal(requests.filter(item => item.action === 'report').length, 1);
    const id = bucket.keys('_feedback/reports/')[0].split('/').pop();
    assert.equal(bucket.json('_feedback/reports/' + id).note, '角色切换后图片没有跟着切换');
    assert.ok((await panel.locator('[data-result]').textContent()).includes('已发送，编号 ' + id), 'the report id is shown for forwarding');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await panel.locator('[data-send]', { hasText: '复制编号' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), id, 'after sending, the main button copies the id');
    assert.equal(requests.filter(item => item.action === 'report').length, 1, 'copying does not send again');
    await page.clock.runFor(300);
    const originalLogger = await fs.readFile(path.join(built, 'DB/modules/run-log.js'), 'utf8');
    await page.evaluate(code => {
        window.RPHubSDK = { register(manifest) { manifest.init({ ui: { addSidebarEntry() { throw new Error('duplicate logger'); } } }); } };
        (0, eval)(code);
    }, originalLogger);
    await page.evaluate(() => {
        for (let i = 0; i < 500; i++) RPHubDiagnostics.failure('page-error', new TypeError('fixture'));
    });
    const bounded = await page.evaluate(() => RPHubDiagnostics.report());
    assert.ok(bounded.events.length <= 300);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 128 * 1024, 'a full error log remains sendable');
    await page.reload();
    assert.equal(await page.evaluate(() => RPHubDiagnostics.enabled), false);
    assert.equal(requests.filter(item => item.action === 'usage').length, 1);
    offline = true;
    await page.evaluate(() => RPHubUI.openLogViewer());
    const failed = page.waitForResponse(response => response.url().endsWith('/api/rp-feedback'));
    await panel.locator('[data-send]').click();
    assert.equal((await failed).status(), 500);
    await page.clock.runFor(100);
    assert.match(await panel.locator('[data-result]').textContent(), /发送失败.*offline/);
    assert.equal(await panel.locator('[data-send]').isEnabled(), true);
    assert.equal(await panel.locator('[data-download]').isEnabled(), true);
    offline = false;
    console.log('PASS browser preview, explicit send/download, secret exclusion, card-switch context, persisted opt-out, old logger and failure fallback');

    const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    admin.on('pageerror', error => errors.push(error.message));
    await admin.goto(base + '/admin#feedback');
    await admin.locator('#adminToken').fill('fixture-admin');
    await admin.getByRole('button', { name: '保存令牌' }).click();
    await admin.waitForFunction(() => document.querySelector('[data-feedback-count="total"]').textContent === '1');
    await admin.locator('[data-report]').click();
    await admin.locator('#feedbackDetail').waitFor();
    assert.match(await admin.locator('#feedbackPreview').textContent(), /角色切换后图片没有跟着切换/);
    assert.equal(await admin.locator('#feedbackNote').textContent(), '角色切换后图片没有跟着切换');
    assert.match(await admin.locator('#feedbackEvents').textContent(), /page-error {2}TypeError {2}HTTP 503\n {4}\/DB\/image-module\.js:12:3/);
    // 顶栏是 sticky，整页截图前回到顶部，免得顶栏画在页面中间。
    await admin.evaluate(() => scrollTo(0, 0));
    await admin.screenshot({ path: path.join(output, 'feedback-admin.png'), fullPage: true });
    await admin.setViewportSize({ width: 390, height: 844 });
    for (const colorScheme of ['light', 'dark']) {
        await admin.emulateMedia({ colorScheme });
        await admin.evaluate(() => scrollTo(0, 0));
        assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'admin feedback fits a phone in ' + colorScheme);
        await admin.screenshot({ path: path.join(output, 'feedback-admin-mobile' + (colorScheme === 'dark' ? '-dark' : '') + '.png'), fullPage: true });
    }
    await admin.locator('#feedbackClose').click();
    assert.equal(await admin.locator('#feedbackDetail').isHidden(), true);
    await admin.locator('#feedbackId').fill('not-an-id');
    await admin.locator('#feedbackFind button').click();
    assert.match(await admin.locator('#notice').textContent(), /编号格式不对/);
    await admin.locator('#feedbackId').fill(' ' + id.toUpperCase() + ' ');
    await admin.locator('#feedbackFind button').click();
    await admin.locator('#feedbackDetail').waitFor();
    assert.match(await admin.locator('#feedbackMeta').textContent(), new RegExp(id), 'a forwarded id finds the report');
    await admin.locator('#logout').click();
    assert.equal(await admin.locator('#feedbackPreview').textContent(), '');
    assert.equal(await admin.locator('[data-report]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS admin authentication, account summary, report lookup, logout clearing, no browser errors');
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
