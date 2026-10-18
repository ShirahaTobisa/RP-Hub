import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, root, defaultUpstream } from './sync-195.helpers.mjs';

// 魔改版（cy-2-u/rp）迁来的生图记录要在正文里显示原图。魔改版只按分支、消息、第几张认图：
// 回复流式输出到一半就生图，每张图记的内容指纹都是当时的半截内容；提示词从生图地址读回，& 后被截、+ 变空格。
// 记录按魔改版 page/magic-extension.js 的算法造（原作者 2.0.3 的标记正则 + tag=$1 地址）；测试版自己的记录照旧。
const uuid = 'fork-image-card', name = '迁移角色';
const forkHash = (value) => { let hash = 2166136261; const text = String(value || ''); for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16); };
const ourHash = (value) => forkHash(value).padStart(8, '0');
const forkPrompt = (raw) => (new URL(`https://x/generate?tag=${raw}&token=t`).searchParams.get('tag') || '').trim();
const upstreamMarkers = (text) => [...text.matchAll(/image###((?:(?!image###|###)[^\r\n])*?)(?:###|(?=\r?\n)|$)/gi)].map((match) => match[1]);
const params = { provider: '', model: 'nai-diffusion-4-5-full', artist: 'artist:x', size: '竖图', steps: '28', scale: '5', cfg: '0', sampler: 'k_euler_ancestral', negative: '', nocache: '0', noise_schedule: 'karras', rerollNonce: '' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');

// at：魔改版生成每张图那一刻的正文（算内容指纹用）。placeholders：修复前测试版没认出来，已替这些位置存了「未生成」占位。
const scenes = [
    { name: '一张图，回复写到一半就生成', final: '她站在窗前。\n\nimage###1girl, smile###\n\n雨停了。', at: ['她站在窗前。\n\nimage###1girl, smile###'], expect: ['image'] },
    { name: '两张图，流式中先后生成', final: '开头。\n\nimage###1girl, smile###\n\n中间。\n\nimage###2girls, park###\n\n结尾。', at: ['开头。\n\nimage###1girl, smile###', '开头。\n\nimage###1girl, smile###\n\n中间。\n\nimage###2girls, park###'], expect: ['image', 'image'] },
    { name: '提示词里有 &', final: '文字。\n\nimage###cat & dog###', at: ['文字。\n\nimage###cat & dog###'], expect: ['image'] },
    { name: '修复前已留下未生成占位', final: '开头。\n\nimage###sky###\n\n中间。\n\nimage###sea###', at: ['开头。\n\nimage###sky###', '开头。\n\nimage###sky###\n\n中间。\n\nimage###sea###'], placeholders: true, expect: ['image', 'image'] },
    { name: '测试版自己的图', final: '文字。\n\nimage###native one###', native: 'rendered', expect: ['image'] },
    { name: '测试版自己的未生成占位', final: '文字。\n\nimage###native two###', native: 'placeholder', expect: ['manual'] }
];
const chat = [{ id: 'u0', role: 'user', name: '用户', content: '开始' }];
const records = [];
const ourRecord = (id, index, content, occurrenceIndex, prompt, extra) => ({
    key: [id, ourHash(content), occurrenceIndex, ourHash(prompt)].join(':'), messageId: id, messageIndex: index, contentHash: ourHash(content), occurrenceIndex,
    prompt, promptHash: ourHash(prompt), branchId: 'main', paramsSnapshot: { ...params, prompt, tag: prompt, characterUuid: uuid, characterName: name }, createdAt: 1, updatedAt: 1, ...extra
});
for (const scene of scenes) {
    const index = chat.length, id = 'm' + index;
    chat.push({ id, role: 'assistant', name, content: scene.final });
    scene.index = index;
    if (scene.native) {
        const prompt = scene.final.match(/image###(.*?)###/)[1];
        const record = ourRecord(id, index, scene.final, 0, prompt, { imageSignature: 'native-' + index, status: scene.native === 'rendered' ? 'rendered' : 'skipped' });
        if (scene.native === 'rendered') record.paramsSnapshot.imageKey = `rp-images/characters/${name}/${'a'.repeat(63)}${index}`;
        records.push(record);
        continue;
    }
    upstreamMarkers(scene.final).forEach((raw, occurrenceIndex) => {
        const prompt = forkPrompt(raw);
        const record = { storyScopeId: 'main', messageId: id, messageIndex: index, contentHash: forkHash(scene.at[occurrenceIndex]), occurrenceIndex, prompt, promptHash: forkHash(prompt),
            paramsSnapshot: { ...params, characterName: name }, imageKey: `rp-images/characters/${name}/${String(index).padStart(2, '0')}${String(occurrenceIndex).repeat(62)}` };
        record.key = ['main', id, occurrenceIndex, record.promptHash].join(':');
        records.push(record);
        if (scene.placeholders) records.push(ourRecord(id, index, scene.final, occurrenceIndex, raw, { imageSignature: 'placeholder-' + occurrenceIndex, status: 'skipped' }));
    });
}

const harness = await startHarness({ assets: root, upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const generation = [], pageErrors = [];
try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 1400 } })).newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/*', async (route) => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === harness.url) {
            if (url.pathname === '/seed.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' });
            if (url.pathname === '/api/rp-image') {
                if (request.method() !== 'GET' && request.method() !== 'HEAD') { generation.push(request.method()); return route.fulfill({ status: 404, json: { error: 'no generation in this test' } }); }
                return url.searchParams.get('image_key') ? route.fulfill({ contentType: 'image/png', body: png }) : route.fulfill({ status: 404, json: { error: 'missing' } });
            }
            if (url.pathname === '/image/api/settings') return route.fulfill({ json: {} });
            if (url.pathname === '/api/rp-sync') return route.fulfill({ json: { ok: true, authenticated: true, authRequired: false } });
            return route.continue();
        }
        if (request.resourceType() === 'script') return route.continue();
        if (request.resourceType() === 'image') return route.fulfill({ contentType: 'image/png', body: png });
        if (request.resourceType() === 'stylesheet') return route.fulfill({ contentType: 'text/css', body: '' });
        return route.fulfill({ json: {} });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ uuid, name, chat, records }) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        const character = { uuid, name, description: '迁移', first_mes: '你好', worldInfo: [], regexScripts: [], uiTemplates: [] };
        const user = { uuid: 'fixture-user', name: '用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: [uuid] }], ['rp_hub_character_' + uuid, character], ['rp_hub_chat_' + uuid, chat], ['rp_hub_image_renders_' + uuid, records],
            ['rp_hub_settings', { autoFetchModels: false, apiKey: '', imageGenKey: '', freezeImageGeneration: true, fontFamily: 'modern', fontFamilyVersion: 4 }],
            ['rp_hub_global_worldinfo', [{ comment: '自动生图', constant: true, enabled: true, content: 'fixture', scope: 'global' }]],
            ['rp_hub_worldinfo', []], ['rp_hub_global_regex', []], ['rp_hub_regex', []],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
    }, { uuid, name, chat, records });

    async function frames() {
        await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__ && globalThis.RPHubImageModule?.getState().persistenceFlushWrapped, null, { timeout: 45000 });
        await page.locator('#custom-splash-screen').waitFor({ state: 'detached' });
        await page.evaluate(() => RPHubImageModule.scan());
        const result = [];
        for (const scene of scenes) {
            const row = page.locator(`[data-chat-index="${scene.index}"]`);
            await row.scrollIntoViewIfNeeded();
            await page.waitForFunction((index) => [...document.querySelectorAll(`[data-chat-index="${index}"] .rp-generated-image-frame img`)].every((img) => img.complete), scene.index);
            result.push(await row.evaluate((element) => [...element.querySelectorAll('.rp-generated-image-frame')].map((frame) => {
                const img = frame.querySelector('img');
                if (!img) return 'manual';
                return img.naturalWidth > 0 && new URL(img.src).searchParams.get('image_key') ? 'image' : 'broken';
            })));
        }
        return result;
    }
    for (const pass of ['first open', 'after reload']) {
        if (pass === 'first open') await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        else await page.reload({ waitUntil: 'domcontentloaded' });
        await page.addLocatorHandler(page.getByRole('button', { name: /^(?:我)?知道了/ }).first(), (button) => button.click()).catch(() => {});
        const seen = await frames();
        scenes.forEach((scene, i) => assert.deepEqual(seen[i], scene.expect, `${pass}: ${scene.name}`));
        console.log(`PASS ${pass}: fork images show in multi-image, mid-stream and "&" replies and over old placeholders; our own records unchanged`);
    }
    const kept = await page.evaluate(() => RPHubImageModule.normalizeImageRenderRecord(RPHubImageModule.normalizeImageRenderRecord({ storyScopeId: 'main', messageId: 'x', contentHash: 'abc', prompt: 'p' })).fork);
    assert.equal(kept, true, 'the fork mark must survive being saved and read back in our format');
    assert.deepEqual(generation, [], 'showing migrated images must not generate anything');
    assert.deepEqual(pageErrors, []);
    console.log('PASS fork mark survives re-normalizing; no generation requests');
} finally {
    await browser.close(); await harness.close();
}
