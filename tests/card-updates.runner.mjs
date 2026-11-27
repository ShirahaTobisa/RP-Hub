import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 万相广场的卡有新版本：打开角色卡管理时查一次，只查从广场下载的卡（头像 PNG 的 IHDR 后面紧跟 tEXt chara 块）；
// 广场上导入之后改过的卡，标题旁显示「N 张卡可更新」，列表里点「查看」在内嵌的万相广场打开那张卡。
// 不算更新的：本机已有改过之后再导入的同名卡、同名卡认不出是哪张、广场上的卡比本机导入还晚。一天之内不重复查；认出过的卡下次照旧认。
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
const png = (...chunks) => 'data:image/png;base64,' + Buffer.concat([SIGNATURE, chunk('IHDR', Buffer.alloc(13)), ...chunks, chunk('IEND', Buffer.alloc(0))]).toString('base64');
const forumAvatar = png(chunk('tEXt', Buffer.from('chara\0' + Buffer.from('{"name":"x"}').toString('base64'), 'latin1')));
const plainAvatar = png();
const day = (date) => Date.UTC(2026, 10, date);
const imported = day(1);
const cards = [
    ['xi', '夕', forumAvatar, imported], ['nian', '年', plainAvatar, imported], ['shu-old', '黍', forumAvatar, imported],
    ['shu-new', '黍', forumAvatar, day(22)], ['ling', '令', forumAvatar, imported], ['yue', '重岳', forumAvatar, imported]
].map(([uuid, name, avatar, createdAt]) => ({ uuid, name, avatar, createdAt, description: name + '的简介', creator_notes: '#R18',
    first_mes: '你好', worldInfo: [], regexScripts: [], uiTemplates: [] }));
let forum = {
    '夕': [{ id: 'a1', createdAt: Date.UTC(2026, 9, 1), updatedAt: day(20), same: true }],
    '黍': [{ id: 'c1', createdAt: Date.UTC(2026, 9, 1), updatedAt: day(20), same: false }],
    '令': [{ id: 'd1', createdAt: Date.UTC(2026, 9, 1), updatedAt: day(20), same: false }, { id: 'd2', createdAt: Date.UTC(2026, 9, 2), updatedAt: day(21), same: false }],
    '重岳': [{ id: 'e1', createdAt: day(5), updatedAt: day(20), same: false }]
};

const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
const asked = [];
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    // 测试不碰真的万相广场：内嵌广场的页面和本站代查都换成假的。
    await page.route('https://rphforum.zeabur.app/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>plaza</title>' }));
    await page.route('**/api/rp-sync', (route) => {
        const body = route.request().postDataJSON();
        if (body?.action !== 'forum-cards') return route.continue();
        asked.push(body.cards);
        return route.fulfill({ json: { ok: true, results: body.cards.map((card) => forum[card.name] || []) } });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async (cards) => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        const user = { uuid: 'fixture-user', name: '测试用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: cards.map((card) => card.uuid) }], ...cards.map((card) => ['rp_hub_character_' + card.uuid, card]),
            ['rp_hub_settings', { autoFetchModels: false, stream: false }],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
    }, cards);
    const load = async () => {
        await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForFunction(() => {
            const app = document.querySelector('#app')?.__vue_app__;
            return (app?._instance?.proxy || app?._container?._vnode?.component?.proxy)?.characters?.length === 6;
        }, null, { timeout: 45000 });
    };
    const app = (script, arg) => page.evaluate(({ script, arg }) => {
        const app = document.querySelector('#app').__vue_app__;
        return new Function('proxy', 'arg', script)(app._instance?.proxy || app._container._vnode.component.proxy, arg);
    }, { script, arg });
    const badge = page.locator('[data-rph-card-updates]:visible');

    await load();
    await app('proxy.currentView = arg', 'characters');
    await badge.waitFor({ timeout: 15000 });
    assert.equal(await badge.getAttribute('title'), '1 张卡可更新');
    assert.equal(await badge.textContent(), '1');
    assert.equal(await page.locator('[data-rph-card-updates]').count(), 2, 'one button in the phone actions and one in the computer actions');
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].map((card) => card.name), ['夕', '黍', '黍', '令', '重岳'], 'only cards downloaded from the plaza are looked up');
    assert.deepEqual(asked[0][0], { name: '夕', description: '夕的简介', creatorNotes: '#R18' });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('rp_hub_card_updates_v1')));
    assert.deepEqual(Object.keys(saved.cards).sort(), ['shu-new', 'shu-old', 'xi'], 'ambiguous names and plaza cards newer than the import are not linked');
    console.log('PASS only plaza downloads are checked; a card updated after its import is counted, the other cases are not');

    await badge.click();
    const rows = page.locator('.rph-ui-overlay .rph-ui-row');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.first().locator('.rph-ui-row-main > div').first().textContent(), '夕');
    assert.equal(await rows.first().locator('.rph-ui-muted').textContent(), '万相广场 11月20日更新');
    await rows.first().getByRole('button', { name: '查看' }).click();
    await page.waitForFunction(() => document.querySelector('iframe')?.getAttribute('src')?.startsWith('https://rphforum.zeabur.app/card/a1?t='), null, { timeout: 15000 });
    assert.equal(await app('return proxy.currentView'), 'square');
    await page.locator('.rph-ui-overlay').waitFor({ state: 'detached', timeout: 5000 }); // 列表随广场打开而关闭
    console.log('PASS the list opens the card inside the embedded plaza');

    await app('proxy.currentView = arg', 'characters');
    await badge.waitFor();
    await page.waitForTimeout(1000);
    assert.equal(asked.length, 1, 'the plaza is checked at most once a day');

    // 一天后再查：广场上「夕」多了一张同名卡、简介也改了，靠上次认出的编号照旧认出原来那张。
    forum = { ...forum, '夕': [{ id: 'z9', createdAt: Date.UTC(2026, 9, 3), updatedAt: day(26), same: false },
        { id: 'a1', createdAt: Date.UTC(2026, 9, 1), updatedAt: day(25), same: false }] };
    await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('rp_hub_card_updates_v1'));
        localStorage.setItem('rp_hub_card_updates_v1', JSON.stringify({ ...state, checkedAt: 0 }));
    });
    await load();
    await app('proxy.currentView = arg', 'characters');
    await badge.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_card_updates_v1')).checkedAt > 0, null, { timeout: 15000 });
    assert.equal(asked.length, 2);
    await badge.click();
    await rows.first().waitFor();
    assert.equal(await rows.first().locator('.rph-ui-muted').textContent(), '万相广场 11月25日更新');
    console.log('PASS a card linked once keeps its plaza card when a same-name card appears');
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await harness.close();
}
