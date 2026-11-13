import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 全站备份插件：A 站点导出（ZIP / JSON），导入到另一个网址的 B 站点；数据完整搬过去，B 站点自己的同步密码和同步设置保留。
const siteA = await startHarness({ upstream: defaultUpstream });
const siteB = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];

async function openSite(harness, seed) {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base, seed }) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url: base + '/DB/modules/site-backup.js', enabled: true }]));
        for (const [key, value] of Object.entries(seed.local)) localStorage.setItem(key, value);
        const db = await fixture.db();
        // 二进制值在页面里生成：Playwright 传参不能直接带 ArrayBuffer。
        await fixture.write(db, seed.records.map(([key, value]) => [key, value === '__BIN__' ? new Uint8Array([1, 2, 3, 250]).buffer : value]));
        db.close();
    }, { base: harness.url, seed });
    await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.RPHubSDK && document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
    return { context, page };
}

async function openBackupPanel(page) {
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]').some((entry) => entry.lastStatus === 'ok'), null, { timeout: 30000 });
    await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent)?.click());
    await page.locator('[data-rph-workshop-manager-entry]').waitFor({ state: 'attached' });
    await page.evaluate(() => document.querySelector('[data-rph-workshop-manager-entry]').click());
    await page.locator('[data-rph-workshop-launcher] button', { hasText: '全站备份' }).click();
    await page.locator('[data-rph-workshop-panel] [data-act="zip"]').waitFor();
}

const readState = (page) => page.evaluate(async () => {
    const db = await fixture.db();
    const read = (key) => new Promise((resolve) => { const request = db.transaction('store').objectStore('store').get(key); request.onsuccess = () => resolve(request.result); });
    const result = { character: await read('rp_hub_character_card-a'), audio: await read('rp_hub_binary_probe'), note: localStorage.getItem('rphub_notes_v1'),
        password: localStorage.getItem('rp_hub_sync_password_v1'), syncState: localStorage.getItem('rp_hub_sync_state_probe') };
    db.close();
    result.audio = result.audio ? Array.from(new Uint8Array(result.audio)) : null;
    return result;
});

try {
    const a = await openSite(siteA, {
        local: { rp_hub_sync_password_v1: 'password-A', rp_hub_sync_state_probe: 'state-A', rphub_notes_v1: '来自 A 站点的便签' },
        records: [['rp_hub_character_card-a', { uuid: 'card-a', name: 'A 站角色' }], ['rp_hub_binary_probe', '__BIN__']]
    });
    await openBackupPanel(a.page);
    const files = {};
    for (const kind of ['zip', 'json']) {
        const download = a.page.waitForEvent('download');
        await a.page.locator(`[data-rph-workshop-panel] [data-act="${kind}"]`).click();
        files[kind] = await (await download).path();
        await a.page.locator('[data-rph-workshop-panel] [data-status]', { hasText: '已导出' }).waitFor();
    }
    console.log('PASS site A exports a ZIP and a JSON backup');

    for (const kind of ['zip', 'json']) {
        const b = await openSite(siteB, {
            local: { rp_hub_sync_password_v1: 'password-B', rp_hub_sync_state_probe: 'state-B', rphub_notes_v1: 'B 站点原来的便签' },
            records: [['rp_hub_character_card-b', { uuid: 'card-b', name: 'B 站角色' }]]
        });
        await openBackupPanel(b.page);
        const chooser = b.page.waitForEvent('filechooser');
        await b.page.locator('[data-rph-workshop-panel] [data-act="import"]').click();
        await (await chooser).setFiles(files[kind]);
        await b.page.locator('[data-rph-ui-confirm] [data-rph-ui-confirm-accept]').click();
        await b.page.waitForEvent('load', { timeout: 30000 });
        await b.page.waitForFunction(() => document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
        await initializeFixture(b.page);
        const state = await readState(b.page);
        assert.deepEqual(state.character, { uuid: 'card-a', name: 'A 站角色' }, kind);
        assert.deepEqual(state.audio, [1, 2, 3, 250], `${kind}: binary values survive the round trip`);
        assert.equal(state.note, '来自 A 站点的便签', kind);
        assert.equal(state.password, 'password-B', `${kind}: the target site keeps its own sync password`);
        assert.equal(state.syncState, 'state-B', `${kind}: the target site keeps its own sync state`);
        await b.context.close();
        console.log(`PASS ${kind.toUpperCase()} backup imports into another site, keeping that site's sync password and state`);
    }

    // 柳贯一 20.3.2 导出的 1.2 版备份：日期、Blob、定型数组带类型标记，多一个结束标记文件，导入后类型照原样还原。
    const liuZip = await a.page.evaluate(async () => {
        const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
        const createdAt = '2026-10-17T00:00:00.000Z';
        const record = { k: 'rp_hub_liu12_probe', v: { at: { __rphub_type__: 'Date', value: createdAt },
            blob: { __rphub_bin__: b64([7, 8, 9]), __rphub_type__: 'Blob', __rphub_mime__: 'audio/mpeg' }, view: { __rphub_bin__: b64([1, 2]), __rphub_type__: 'Uint8Array' } } };
        const manifest = { format: 'rphub-backup-zip', version: '1.2', plugin: '柳贯一插件', pluginVersion: '20.3.2', createdAt, totalRecords: 1, volumes: 1, volumeMode: 'concatenated-zip-stream',
            databases: [{ name: 'RPHubDB', stores: [{ store: 'store', keyPath: null, autoInc: false, indexes: [], records: 1, chunks: ['RPHubDB/store/chunk-0000.jsonl'] }] }],
            webStorage: { localStorage: 1, sessionStorage: 0 } };
        const zip = new JSZip();
        zip.file('RPHubDB/store/chunk-0000.jsonl', JSON.stringify(record) + '\n');
        zip.file('storage/localStorage.json', JSON.stringify({ rphub_notes_v1: '柳贯一 20.3.2 的便签' }));
        zip.file('storage/sessionStorage.json', '{}');
        zip.file('manifest.json', JSON.stringify(manifest));
        zip.file('backup.complete.json', JSON.stringify({ format: manifest.format, createdAt, totalRecords: 1 }));
        return Array.from(await zip.generateAsync({ type: 'uint8array' }));
    });
    const b = await openSite(siteB, { local: {}, records: [] });
    await openBackupPanel(b.page);
    const chooser = b.page.waitForEvent('filechooser');
    await b.page.locator('[data-rph-workshop-panel] [data-act="import"]').click();
    await (await chooser).setFiles({ name: 'RPHub全站备份_柳贯一.zip', mimeType: 'application/zip', buffer: Buffer.from(liuZip) });
    await b.page.locator('[data-rph-ui-confirm] [data-rph-ui-confirm-accept]').click();
    await b.page.waitForEvent('load', { timeout: 30000 });
    await initializeFixture(b.page);
    const probe = await b.page.evaluate(async () => {
        const db = await fixture.db();
        const value = await new Promise((resolve) => { const request = db.transaction('store').objectStore('store').get('rp_hub_liu12_probe'); request.onsuccess = () => resolve(request.result); });
        db.close();
        return { at: value.at instanceof Date && value.at.toISOString(), blob: value.blob instanceof Blob && [value.blob.type, ...new Uint8Array(await value.blob.arrayBuffer())],
            view: value.view instanceof Uint8Array && [...value.view], note: localStorage.getItem('rphub_notes_v1') };
    });
    assert.deepEqual(probe, { at: '2026-10-17T00:00:00.000Z', blob: ['audio/mpeg', 7, 8, 9], view: [1, 2], note: '柳贯一 20.3.2 的便签' });
    await b.context.close();
    console.log('PASS a version 1.2 backup from the Liuguanyi plugin 20.3.2 restores dates, blobs and typed arrays');

    const bad = await openSite(siteB, { local: { rphub_notes_v1: '保留原便签' }, records: [['rp_hub_character_card-a', { uuid: 'card-a', name: '保留原角色' }]] });
    await openBackupPanel(bad.page);
    await initializeFixture(bad.page);
    const beforeFailure = await readState(bad.page);
    const zipFailure = async (kind) => Buffer.from(await a.page.evaluate(async (kind) => {
        const zip = new JSZip();
        const manifest = { format: 'rphub-backup-zip', totalRecords: 1, databases: [{ name: 'RPHubDB', stores: [
            { store: 'store', records: 1, chunks: ['records.jsonl'] }
        ] }], webStorage: { localStorage: kind === 'missing-storage' ? 1 : 0 } };
        zip.file('manifest.json', JSON.stringify(manifest));
        if (kind !== 'missing-chunk') zip.file('records.jsonl', kind === 'wrong-count' ? '' : JSON.stringify({ k: 'replacement', v: 'new' }));
        return [...await zip.generateAsync({ type: 'uint8array' })];
    }, kind));
    const invalidJson = (databases) => Buffer.from(JSON.stringify({ __rphub_backup__: 1, version: 8, databases }));
    const failures = [
        ['missing.zip', await zipFailure('missing-chunk'), '备份缺少文件：records.jsonl'],
        ['truncated.zip', await zipFailure('wrong-count'), '备份记录数不符'],
        ['storage.zip', await zipFailure('missing-storage'), '备份缺少文件：storage/localStorage.json'],
        ['binary.json', invalidJson({ RPHubDB: { store: [{ k: 'replacement', v: 'new' }] }, Broken: { store: [{ k: 'bad', v: { __rphub_bin__: '%' } }] } }), 'atob'],
        ['key.json', invalidJson({ RPHubDB: { store: [{ k: 'replacement', v: 'new' }, { v: 'missing key' }] } }), 'key']
    ];
    for (const [name, buffer, message] of failures) {
        const chooser = bad.page.waitForEvent('filechooser');
        await bad.page.locator('[data-act="import"]').click();
        await (await chooser).setFiles({ name, mimeType: name.endsWith('.zip') ? 'application/zip' : 'application/json', buffer });
        await bad.page.locator('[data-rph-ui-confirm] [data-rph-ui-confirm-accept]').click();
        await bad.page.locator('[data-status]', { hasText: message }).waitFor();
        assert.deepEqual(await readState(bad.page), beforeFailure, `${name}: rejected import changed local data`);
        assert.equal(await bad.page.evaluate(() => !!window.RPH_R2_PULL_RESTORE_IN_PROGRESS), false);
    }
    console.log('PASS missing ZIP files/counts, invalid binary data and write errors preserve existing records');

    let downloads = 0;
    bad.page.on('download', () => downloads++);
    await bad.page.evaluate(() => {
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args) {
            if (args[1] === 'readonly' && new Error().stack.includes('readStore')) throw new Error('simulated backup read failure');
            return transaction.apply(this, args);
        };
    });
    await bad.page.locator('[data-act="json"]').click();
    await bad.page.locator('[data-status]', { hasText: 'simulated backup read failure' }).waitFor();
    assert.equal(downloads, 0, 'a read failure still produced a backup download');
    assert.deepEqual(await readState(bad.page), beforeFailure);
    await bad.context.close();
    console.log('PASS a database read failure stops export instead of creating an empty backup');
    await a.context.close();
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await siteA.close();
    await siteB.close();
}
