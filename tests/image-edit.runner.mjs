import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { startHarness, initializeFixture, chromium, chrome, root, defaultUpstream } from './sync-195.helpers.mjs';

const evidence = path.join(root, 'evidence/image-edit-repair-20260920');
await fs.mkdir(evidence, { recursive: true });
const oldRuns = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/image-edit-legacy.json'), 'utf8'));
const harness = await startHarness({ assets: path.resolve(process.env.RPH_PACKAGE_ROOT || root), upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const contexts = [], report = { passed: [], pageErrors: [], imageRequests: [], snapshots: [] }, scripts = new Map();
report.moduleSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(process.env.RPH_PACKAGE_ROOT || root,'DB/image-module.js'))).digest('hex');
const imageFiles = new Set();
let remote, uploaded = new Map(), createRequest, generationSettings = null;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
const fixtureImage = { contentType:'image/svg+xml', body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" rx="8" fill="#dbeafe"/><path d="M0 140L85 65L155 120L225 40L300 110V180H0Z" fill="#60a5fa"/><text x="150" y="160" text-anchor="middle" font-size="16">隔离测试图</text></svg>' };
const uuid = 'image-edit-diagnostic-card', recordKey = `rp_hub_image_renders_${uuid}`;
const original = oldRuns.original, edited = oldRuns.edited;
const marker = 'image###blue sky, white clouds, landscape###';
const canonical = source => { const url = new URL(source, harness.url); url.searchParams.delete('_rph_retry'); return url.pathname + url.search; };
const posts = () => report.imageRequests.filter(r => r.method === 'POST').length;
function passed(name) { report.passed.push(name); console.log('PASS ' + name); }
const row = page => page.locator('[data-chat-index="0"][data-role="assistant"]');
const frame = page => row(page).locator('.rp-generated-image-frame');
async function read(page, key = recordKey) {
    return page.evaluate(async key => {
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open('RPHubDB'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        try { return await new Promise((resolve, reject) => { const r = db.transaction('store').objectStore('store').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
        finally { db.close(); }
    }, key);
}
async function app(page, name, arg) {
    return page.evaluate(async ({ name, arg }) => {
        const a = document.querySelector('#app').__vue_app__;
        const proxy = a._instance?.proxy || a._container._vnode.component.proxy;
        return typeof proxy[name] === 'function' ? await proxy[name](arg) : JSON.parse(JSON.stringify(proxy[name]));
    }, { name, arg });
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__ && globalThis.RPHubImageModule?.getState().persistenceFlushWrapped, null, { timeout: 45000 });
    await page.locator('#custom-splash-screen').waitFor({ state: 'detached' });
    await page.waitForFunction(() => {
        const screen = document.querySelector('.entry-transition');
        return !screen || Number(getComputedStyle(screen).opacity) === 0;
    });
    await page.evaluate(() => RPHubImageModule.scan());
    await frame(page).first().waitFor();
}
async function imageUrl(page, index = 0) {
    await page.waitForFunction(index => {
        const image = document.querySelectorAll('[data-chat-index="0"] .rp-generated-image-frame img')[index];
        return image?.complete && image.naturalWidth > 0;
    }, index);
    return canonical(await frame(page).nth(index).locator('img').getAttribute('src'));
}
async function edit(page, content) {
    await row(page).locator('button[title="编辑"]').click({ force: true });
    await row(page).getByPlaceholder('编辑消息...').fill(content);
    await row(page).getByRole('button', { name: '保存', exact: true }).click();
    await row(page).getByPlaceholder('编辑消息...').waitFor({ state: 'detached' });
    await page.evaluate(() => RPHubImageModule.scan());
    await frame(page).first().waitFor();
    await page.evaluate(() => RPH_R2_FLUSH_PERSISTENCE());
}
async function device(seed, mobile = false) {
    const context = await browser.newContext({ viewport: mobile ? {width:390,height:844} : {width:1280,height:900}, isMobile: mobile, hasTouch: mobile });
    contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', error => report.pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const isPublicScript = req => req.resourceType() === 'script' && ['cdn.tailwindcss.com','unpkg.com','cdn.jsdelivr.net'].includes(new URL(req.url()).hostname);
    page.on('response', response => {
        if (response.ok() && isPublicScript(response.request()) && !scripts.has(response.url())) {
            const result = response.body().then(body => ({ contentType:'text/javascript', body })).catch(() => null);
            for (let req = response.request(); req; req = req.redirectedFrom()) scripts.set(req.url(), result);
        }
    });
    await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === harness.url) {
            if (url.pathname === '/seed.html') return route.fulfill({ contentType:'text/html', body:'<!doctype html><title>Isolated seed</title>' });
            if (url.pathname === '/api/rp-image') {
                const key = canonical(url); report.imageRequests.push({ method:req.method(), key });
                if (req.method() === 'POST' || req.method() === 'PUT') imageFiles.add(key);
                if (req.method() === 'PUT') report.imageRequests.at(-1).contentType = req.headers()['content-type'];
                return imageFiles.has(key) ? route.fulfill(fixtureImage) : route.fulfill({ status:404, json:{error:'fixture original missing'} });
            }
            if (url.pathname === '/api/rp-image-thumb') return route.fulfill({json:{ok:true}});
            if (url.pathname === '/image/api/settings') return route.fulfill({json: generationSettings ? {ok:true, settings:generationSettings} : {}});
            if (url.pathname === '/api/rp-sync') {
                if (url.searchParams.get('action') === 'upload-part') {
                    const index = Number(url.searchParams.get('index')); uploaded.set(index, req.postDataBuffer());
                    return route.fulfill({json:{ok:true,index,partNumber:index+1,key:'fixture-'+index}});
                }
                const body = req.postDataJSON();
                if (body?.action === 'upload-create') {
                    createRequest = body; uploaded = new Map();
                    return route.fulfill({json:{ok:true,previousVersion:remote?.version||0,missingIndices:body.chunkManifest.map(c=>c.index)}});
                }
                if (body?.action === 'upload-complete') {
                    for (const c of createRequest.chunkManifest) assert.equal(crypto.createHash('sha256').update(uploaded.get(c.index)).digest('hex'), c.checksum);
                    remote = {...body,version:(remote?.version||0)+1}; report.snapshots.push({bytes:remote.totalBytes,chunks:remote.chunkCount});
                    return route.fulfill({json:{ok:true,version:remote.version}});
                }
                if (body?.action === 'pull-manifest') return route.fulfill({json:{ok:true,remote}});
                if (body?.action === 'pull-json-part') {
                    const bytes = Buffer.concat(Array.from({length:body.count},(_,i)=>uploaded.get(body.start+i)));
                    return route.fulfill({contentType:'application/octet-stream',body:bytes,headers:{'x-rp-sync-byte-length':String(bytes.length)}});
                }
                return route.fulfill({json:{ok:true,authenticated:true,authRequired:false}});
            }
            if (url.pathname === '/DB/bootstrap.js') {
                const response = await route.fetch();
                return route.fulfill({response,body:(await response.text()).replace('globalThis.api = {','globalThis.api = { performPushSync, performPullSync,')});
            }
            return route.continue();
        }
        if (isPublicScript(req)) { const cached = await scripts.get(url.href); return cached ? route.fulfill(cached) : route.continue(); }
        if (req.resourceType() === 'image') return route.fulfill({contentType:'image/png',body:png});
        if (req.resourceType() === 'stylesheet') return route.fulfill({contentType:'text/css',body:''});
        return route.fulfill({json:{}});
    });
    await page.goto(harness.url+'/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({seed,uuid}) => {
        localStorage.setItem('roleplay_hub_update_id','999999999');
        localStorage.setItem('rp_hub_sync_password_v1','isolated-image-edit');
        const character = {uuid,name:'测试角色',description:'隔离验收',first_mes:'准备完成',worldInfo:[],regexScripts:seed.regexScripts||[],uiTemplates:[]};
        const user = {uuid:'fixture-user',name:'隔离用户',person:'second'};
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index',{order:[uuid,'other-card']}],['rp_hub_character_'+uuid,character],
            ['rp_hub_character_other-card',{...character,uuid:'other-card'}],
            ['rp_hub_chat_'+uuid,[{id:'same-message-id',role:'assistant',name:character.name,content:seed.content}]],
            ['rp_hub_chat_other-card',[{id:'another-id',role:'assistant',name:character.name,content:seed.content}]],
            ['rp_hub_image_renders_'+uuid,seed.records],
            ['rp_hub_settings',{autoFetchModels:false,apiKey:'',imageGenKey:'STD-isolated',freezeImageGeneration:true,fontFamily:'modern',fontFamilyVersion:4}],
            ['rp_hub_global_worldinfo',[{comment:'自动生图',constant:true,enabled:true,content:'fixture',scope:'global'}]],
            ['rp_hub_worldinfo',[]],['rp_hub_global_regex',[]],['rp_hub_regex',[]],
            ['rp_hub_user',user],['rp_hub_user_profiles',[user]],['rp_hub_active_profile_id',user.uuid],['rp_hub_last_active_char',0]
        ]); db.close();
    },{seed,uuid});
    await page.goto(harness.url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.addLocatorHandler(page.getByRole('button',{name:/^(?:我)?知道了/}).first(), button=>button.click());
    await ready(page);
    return page;
}

try {
    // Use records actually produced by the unmodified 0901 and production modules.
    for (const old of oldRuns.cases) {
        const expected = canonical(old.before.imageUrl); imageFiles.add(expected);
        const beforePosts = posts();
        const page = await device({content:edited,records:old.after.records}, old.host === 'package-0901');
        assert.equal(await imageUrl(page), expected);
        await page.evaluate(()=>RPHubImageModule.flushRecords());
        const records = await read(page);
        assert.equal(records.length, old.after.records.length);
        for (const prior of old.after.records) assert.deepEqual(records.find(r=>r.key===prior.key)?.paramsSnapshot,prior.paramsSnapshot);
        assert.equal(posts(),beforePosts);
        passed(old.host+' old blank restored without new generation or deleting records');
        if (old.host === 'package-0901') {
            await edit(page, original); assert.equal(await imageUrl(page),expected);
            await edit(page, edited); assert.equal(await imageUrl(page),expected);
            await page.reload({waitUntil:'domcontentloaded'}); await ready(page); assert.equal(await imageUrl(page),expected);
            await page.screenshot({path:path.join(evidence,'mobile-legacy-restored.png')});
            passed('mobile viewport: native edit/save/reload preserves 0901 image');
            continue;
        }
        for (const text of [`增加一段文字。\n${marker}`, `\n${marker}`, `替换为新的普通文字。\n${marker}`]) {
            await edit(page,text); assert.equal(await imageUrl(page),expected);
        }
        assert.equal(posts(),beforePosts);
        passed('desktop native add/delete/replace prose retains exact image URL and parameters');
        await frame(page).locator('.rp-image-reroll-button').click();
        await page.waitForFunction(before=>document.querySelector('[data-chat-index="0"] .rp-generated-image-frame img')?.src !== before, harness.url+expected);
        const rerolled = await imageUrl(page); assert.notEqual(rerolled,expected); assert.equal(posts(),beforePosts+1);
        await edit(page,edited); assert.equal(await imageUrl(page),rerolled);
        await page.reload({waitUntil:'domcontentloaded'}); await ready(page); assert.equal(await imageUrl(page),rerolled);
        passed('explicit reroll survives edit/save/reload');
        await app(page,'selectCharacter',1); await ready(page);
        assert.equal(await frame(page).locator('img').count(),0);
        await app(page,'selectCharacter',0); await ready(page); assert.equal(await imageUrl(page),rerolled);
        passed('same-name character switch does not borrow images');
        await page.evaluate(()=>api.performPushSync());
        assert.equal(await page.evaluate(()=>api.state.statusText),'上传成功。');
        await page.locator('.rp-sync-modal__close').click();
        const sourceRecords = await read(page);
        const b = await device({content:'待拉取\n'+marker,records:[]},true);
        const navigation = b.waitForEvent('domcontentloaded',{timeout:45000});
        await b.evaluate(()=>api.performPullSync()); await navigation; await ready(b);
        assert.deepEqual(await read(b),sourceRecords); assert.equal(await imageUrl(b),rerolled);
        await edit(b,'手机编辑文字\n'+marker); assert.equal(await imageUrl(b),rerolled);
        passed('real snapshot push/pull to fresh mobile context preserves records and selected image');
        await page.screenshot({path:path.join(evidence,'desktop-restored.png')});
        const postLimit = posts(); imageFiles.delete(rerolled);
        await page.reload({waitUntil:'domcontentloaded'}); await ready(page);
        await page.waitForFunction(()=>document.querySelector('.rp-generated-image-frame img')?.dataset.rphImageGenerationState==='missing');
        await page.waitForTimeout(700); assert.equal(posts(),postLimit);
        assert.match(await frame(page).locator('img').getAttribute('alt'),/原图读取失败/);
        await page.screenshot({path:path.join(evidence,'missing-original.png')});
        await frame(page).locator('.rp-image-reroll-button').click();
        const regenerated = await imageUrl(page); assert.notEqual(regenerated,rerolled); assert.equal(posts(),postLimit+1);
        passed('missing recovered original does not auto-generate; explicit reroll works');
        await edit(page,`多图回复\n${marker}\nimage###green trees###\n${marker}`);
        assert.equal(await frame(page).count(),3);
        assert.equal(await frame(page).locator('img').count(),0);
        for (let index=0;index<3;index++) { await frame(page).nth(index).locator('.rp-image-reroll-button').click(); await imageUrl(page,index); }
        const urls = await Promise.all([0,1,2].map(i=>imageUrl(page,i)));
        assert.notEqual(urls[0],urls[2]);
        await edit(page,`改普通文字\n${marker}\nimage###green trees###\n${marker}`);
        assert.deepEqual(await Promise.all([0,1,2].map(i=>imageUrl(page,i))),urls);
        await edit(page,`删一个标记\n${marker}\nimage###green trees###`);
        assert.equal(await frame(page).locator('img').count(),0);
        passed('multiple/repeated prompts retain slots; inserted/deleted marker layouts are not guessed');
        await edit(page,`改普通文字\n${marker}\nimage###green trees###\n${marker}`);
        assert.deepEqual(await Promise.all([0,1,2].map(i=>imageUrl(page,i))),urls);
        await row(page).getByRole('button',{name:'从这里创建分支'}).click({force:true});
        await page.waitForFunction(()=>{
            const a=document.querySelector('#app').__vue_app__; return (a._instance?.proxy||a._container._vnode.component.proxy).currentStoryBranch?.id!=='main';
        });
        await ready(page);
        const branch = await app(page,'currentStoryBranch');
        assert.deepEqual(await Promise.all([0,1,2].map(i=>imageUrl(page,i))),urls);
        const branchPosts = posts();
        const branchSignature = await frame(page).first().getAttribute('data-image-signature');
        await frame(page).first().locator('.rp-image-reroll-button').click();
        await page.waitForFunction(signature => document.querySelector('.rp-generated-image-frame')?.dataset.imageSignature !== signature, branchSignature);
        const branchUrl = await imageUrl(page);
        assert.notEqual(branchUrl,urls[0]); assert.equal(posts(),branchPosts+1);
        await edit(page,`分支编辑\n${marker}\nimage###green trees###\n${marker}`); assert.equal(await imageUrl(page),branchUrl);
        await app(page,'switchStoryBranch','main'); await ready(page); assert.deepEqual(await Promise.all([0,1,2].map(i=>imageUrl(page,i))),urls);
        await app(page,'switchStoryBranch',branch.id); await ready(page); assert.equal(await imageUrl(page),branchUrl);
        await page.reload({waitUntil:'domcontentloaded'}); await ready(page); assert.equal(await imageUrl(page),branchUrl);
        passed('native branch inherits known images, then edit/switch/reload keeps independent reroll choices');
        await edit(page,'换提示词\nimage###a different prompt###');
        assert.equal(await frame(page).locator('img').count(),0);
        passed('changed prompt has a generation entry and does not reuse old image');
    }
    // 美化正则只改显示文字，让页面上的生图标记和原文对不上：仍要认出是当前角色，不报错、不发生图请求。
    {
        const old = oldRuns.cases.find(item => item.host !== 'package-0901');
        const expected = canonical(old.before.imageUrl);
        const beforePosts = posts();
        const page = await device({ content: edited, records: old.after.records,
            regexScripts: [{ name: '美化', regex: '/white clouds/g', replacement: '白云', placement: [2], markdownOnly: true, promptOnly: false, enabled: true }] });
        await page.waitForTimeout(1500);
        await frame(page).first().waitFor();
        assert.equal(await frame(page).first().getAttribute('data-character-uuid'), uuid);
        assert.equal(posts(), beforePosts);
        assert.equal(await page.locator('.toast-item', { hasText: '无法确认图片所属角色' }).count(), 0);
        passed('display-only regex that rewrites the image prompt still attributes the row without errors or generation');
    }
    // 选了插件提供的生图接口：插件在浏览器里生成图片，外壳用 PUT 上传到同一个存放位置，不再走直链 POST。
    {
        const old = oldRuns.cases.find(item => item.host !== 'package-0901');
        generationSettings = { generator: 'test-gen', params: { steps: 50, scale: 6, cfg: 0, sampler: 'k_euler', noise_schedule: 'karras', negative: '' } };
        const page = await device({ content: edited, records: old.after.records });
        await page.evaluate(async () => {
            globalThis.providerCalls = [];
            RPHubImageModule.registerImageProvider({ id: 'test-gen', label: '测试接口', maxSteps: 50, async generate({ params, token }) {
                providerCalls.push({ tag: params.tag, token: Boolean(token) });
                return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
            } });
            await RPHubImageModule.reloadGenerationSettings();
        });
        const before = report.imageRequests.length;
        await frame(page).locator('.rp-image-reroll-button').click();
        await page.waitForFunction(() => providerCalls.length === 1);
        await page.waitForFunction(n => document.querySelectorAll('[data-chat-index="0"] .rp-generated-image-frame img')[0]?.src.includes('_rph_retry'), null);
        const sent = report.imageRequests.slice(before);
        assert.ok(sent.some(r => r.method === 'PUT' && r.contentType === 'image/png'), JSON.stringify(sent));
        assert.ok(!sent.some(r => r.method === 'POST'), 'plugin generation must not also call the direct link');
        assert.equal(await page.evaluate(() => providerCalls[0].tag), 'blue sky, white clouds, landscape');
        passed('plugin image provider generates in the browser and uploads with PUT instead of the direct link');
        // 设置页里读回插件接口的 50 步，不能被直链的 28 步上限压回去。
        await page.evaluate(() => { const a = document.querySelector('#app').__vue_app__; (a._instance?.proxy || a._container._vnode.component.proxy).currentView = 'settings'; });
        const stepsInput = page.locator('[data-rph-image-param] input[type="range"]').first();
        await stepsInput.waitFor({ state: 'attached' });
        assert.equal(await stepsInput.inputValue(), '50');
        generationSettings = null;
        passed('settings page shows the saved 50 steps of a plugin generator instead of clamping to 28');
    }
    assert.deepEqual(report.pageErrors,[]);
    report.ok = true;
} catch(error) {
    report.ok=false; report.error=error.stack;
    for (const [index,context] of contexts.entries()) {
        const page=context.pages()[0];
        await page?.screenshot({path:path.join(evidence,`failure-${index}.png`)}).catch(()=>{});
        report[`debug${index}`]=await page?.evaluate(()=>{
            const a=document.querySelector('#app')?.__vue_app__, p=a?._instance?.proxy||a?._container?._vnode?.component?.proxy;
            return {text:document.body.innerText.slice(-5000),state:globalThis.RPHubImageModule?.getState(),character:p?.currentCharacter?.uuid,
                characters:p?.characters?.map(c=>c.uuid),chat:p?.chatHistory?.map(m=>({id:m.id,content:m.content})),
                frames:[...document.querySelectorAll('.rp-generated-image-frame')].map(n=>({...n.dataset}))};
        }).catch(()=>null);
    }
    throw error;
} finally {
    await fs.writeFile(path.join(evidence,'results.json'),JSON.stringify(report,null,2));
    await browser.close(); await harness.close();
}
