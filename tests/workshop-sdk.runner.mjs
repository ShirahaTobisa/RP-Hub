import assert from 'node:assert/strict';
import { startHarness, chromium, chrome } from './sync-195.helpers.mjs';

const harness = await startHarness();
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
let sourceRequests = 0;
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
    await page.route('**/probe.js', route => {
        sourceRequests++;
        return route.fulfill({ contentType: 'text/javascript', body: `RPHubSDK.register({ id:'storage-probe', name:'Probe', version:'1', requiresApi:1, init(ctx) { globalThis.probe = ctx; } });` });
    });
    await page.route('**/instrumented.js*', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('globalThis.api = {', 'globalThis.api = { releaseDeferredPersistenceWrites,') });
    });
    await page.goto(harness.url);
    await page.evaluate(url => localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url, enabled:true }])), harness.url + '/probe.js');
    await page.addScriptTag({ url: harness.url + '/DB/module-loader.js' });
    await page.waitForFunction(() => !!globalThis.probe);
    assert.equal(sourceRequests, 1);
    const result = await page.evaluate(async () => {
        const value = { nested: { a: 1 } };
        const save = probe.data.set('copy', value);
        value.nested.a = 2;
        await save;
        const copy = await probe.data.get('copy');
        let invalidRejected = 0;
        for (const unsupported of [new Blob(['x']), new Date(), { bad: undefined }, { bad: Infinity }]) {
            try { await probe.data.set('invalid', unsupported); } catch { invalidRejected++; }
        }
        let oversizeRejected = false;
        try { probe.storage.set('too-big', 'x'.repeat(65537)); } catch { oversizeRejected = true; }
        const writing = probe.persistence.track('background', async () => {
            await new Promise(resolve => setTimeout(resolve, 40));
            await probe.data.set('async', 'saved');
        });
        await RPHubSDK.flush();
        const asyncValue = await probe.data.get('async');
        await writing;
        const fail = probe.persistence.track('failed', () => { throw new Error('fixture save failure'); });
        await fail.catch(() => {});
        let flushFailed = false;
        try { await RPHubSDK.flush(); } catch { flushFailed = true; }
        await probe.persistence.track('failed', () => probe.data.set('fixed', true));
        await RPHubSDK.flush();
        probe.storage.set('setting', 'before');
        await probe.data.set('guarded', 'before');
        globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
        probe.storage.set('setting', 'after');
        const pending = probe.data.set('guarded', 'after');
        await new Promise(resolve => setTimeout(resolve, 40));
        const during = { data: await probe.data.get('guarded'), setting: probe.storage.get('setting') };
        delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
        await api.releaseDeferredPersistenceWrites();
        await pending;
        await RPHubSDK.flush();
        const after = { data: await probe.data.get('guarded'), setting: probe.storage.get('setting') };
        const lines = [];
        for await (const line of api.iterateSnapshotLines({recordCount:0,totalBytes:0})) lines.push(JSON.parse(typeof line === 'string' ? line : new TextDecoder().decode(line)));
        return { copy, invalidRejected, oversizeRejected, asyncValue, flushFailed, during, after,
            settingSynced: lines.some(line => line.key === 'rph_mod_storage-probe::setting') };
    });
    assert.deepEqual(result, { copy:{nested:{a:1}}, invalidRejected:4, oversizeRejected:true, asyncValue:'saved', flushFailed:true,
        during:{data:'before',setting:'before'}, after:{data:'after',setting:'after'}, settingSynced:true });
    console.log('PASS SDK v1 compatibility, JSON data validation, snapshot copy, awaited saves, failure recovery, restore write gate');
    await page.reload();
    await page.addScriptTag({ url: harness.url + '/DB/module-loader.js' });
    await page.waitForFunction(() => !!globalThis.probe);
    assert.equal(sourceRequests, 1, 'cached source must start without fetching its original URL');
    await page.goto(harness.url + '/?rph_safe_mode=1');
    await page.addScriptTag({ url: harness.url + '/DB/module-loader.js' });
    assert.equal(await page.evaluate(() => typeof globalThis.probe), 'undefined');
    assert.equal(sourceRequests, 1);
    console.log('PASS saved source loading and safe mode');
    assert.deepEqual(errors, []);
} finally {
    await context.close();
    await browser.close();
    await harness.close();
}
