import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 万相广场的卡有新版本：打开角色卡管理时查一次，只查从广场下载的卡（头像 PNG 的 IHDR 后面紧跟 tEXt chara 块）；
// 广场上导入之后改过的卡，右上角「检查更新」带数字，点开马上再查一次并列出来，点「更新」在内嵌的万相广场打开那张卡，在那里导入就原地换成新版：
// 角色卡编号不变（聊天记录还在），同名的状态栏模板沿用编号和数值、补上作者新加的变量；只拦这一次导入，再导入照旧新建一张。
// 不算更新的：本机已有改过之后再导入的同名卡、同名卡认不出是哪张、广场上的卡比本机导入还晚。一天之内不自动重复查；认出过的卡下次照旧认。
// 卡片上的「检查更新」只查那一张，认不出时列出同名卡让人选，选过的记住。
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
const pngBytes = (...chunks) => Buffer.concat([SIGNATURE, chunk('IHDR', Buffer.alloc(13)), ...chunks, chunk('IEND', Buffer.alloc(0))]);
const dataUrl = (bytes) => 'data:image/png;base64,' + bytes.toString('base64');
const cardChunk = (card) => chunk('tEXt', Buffer.from('chara\0' + Buffer.from(JSON.stringify(card)).toString('base64'), 'latin1'));
const forumAvatar = dataUrl(pngBytes(cardChunk({ name: 'x' })));
const plainAvatar = dataUrl(pngBytes());
// 广场上「夕」的新版：简介、开场白、世界书、正则都改了，状态栏模板同名但换了写法，还加了魔力和背包里的药。
const newVersion = pngBytes(cardChunk({ spec: 'chara_card_v2', data: {
    name: '夕', description: '夕的新简介', first_mes: '新的开场白', creator_notes: '#R18',
    character_book: { entries: [{ keys: ['画'], content: '新世界书', comment: '画室', enabled: true }] },
    extensions: { regex_scripts: [{ scriptName: '新正则', findRegex: '/旧/g', replaceString: '新' }],
        rp_hub_ui_templates: [{ name: '状态栏', htmlTemplate: '<div>体力 {{hp}} 魔力 {{mp}}</div>', initialVariableState: { hp: 100, mp: 50, 背包: { 药: 3 } } }] }
} }));
const oldState = { hp: 37, 背包: { 剑: 1 } };
const statusBar = { id: 'tpl-old', name: '状态栏', htmlTemplate: '<div>{{hp}}</div>', initialVariableState: { hp: 100, 背包: {} },
    variableState: oldState, changeLog: [], runtimeByCharacter: { xi: { variableState: oldState, changeLog: [] } } };
const day = (date) => Date.UTC(2026, 10, date);
const imported = day(1);
const cards = [
    ['xi', '夕', forumAvatar, imported], ['nian', '年', plainAvatar, imported], ['shu-old', '黍', forumAvatar, imported],
    ['shu-new', '黍', forumAvatar, day(22)], ['ling', '令', forumAvatar, imported], ['yue', '重岳', forumAvatar, imported]
].map(([uuid, name, avatar, createdAt]) => ({ uuid, name, avatar, createdAt, description: name + '的简介', creator_notes: '#R18',
    first_mes: '你好', worldInfo: [], regexScripts: [], uiTemplates: uuid === 'xi' ? [statusBar] : [] }));
let forum = {
    '夕': [{ id: 'a1', createdAt: Date.UTC(2026, 9, 1), updatedAt: day(20), same: true }],
    '黍': [{ id: 'c1', createdAt: Date.UTC(2026, 9, 1), updatedAt: day(20), same: false }],
    '令': [{ id: 'd1', createdAt: Date.UTC(2026, 9, 1), updatedAt: day(20), same: false }, { id: 'd2', createdAt: Date.UTC(2026, 9, 2), updatedAt: day(21), same: false }],
    '重岳': [{ id: 'e1', createdAt: day(5), updatedAt: day(20), same: false }]
};
let failing = false;

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
        return route.fulfill({ json: { ok: true, results: body.cards.map((card) => (failing ? null : forum[card.name] || [])) } });
    });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async (cards) => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        const user = { uuid: 'fixture-user', name: '测试用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: cards.map((card) => card.uuid) }], ...cards.map((card) => ['rp_hub_character_' + card.uuid, card]),
            ['rp_hub_chat_xi', [{ id: 'm1', role: 'assistant', name: '夕', content: '你好' }, { id: 'm2', role: 'user', content: '继续画' }]],
            ['rp_hub_settings', { autoFetchModels: false, stream: false }],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
    }, cards);
    const app = (script, arg) => page.evaluate(({ script, arg }) => {
        const app = document.querySelector('#app').__vue_app__;
        return new Function('proxy', 'arg', script)(app._instance?.proxy || app._container._vnode.component.proxy, arg);
    }, { script, arg });
    const load = async (count) => {
        await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForFunction((count) => {
            const app = document.querySelector('#app')?.__vue_app__;
            return (app?._instance?.proxy || app?._container?._vnode?.component?.proxy)?.characters?.length === count;
        }, count, { timeout: 45000 });
    };
    const updates = (count) => page.locator(`[data-rph-card-updates][title="${count} 张卡可更新"]:visible`);
    const checkButton = page.locator('[data-rph-card-updates][title="检查更新"]:visible');
    const rows = page.locator('.rph-ui-overlay .rph-ui-row');
    const note = page.locator('.rph-ui-overlay .rph-ui-body > .rph-ui-muted');
    const closeList = async () => {
        await page.locator('.rph-ui-overlay .modal-close-button').click();
        await page.locator('.rph-ui-overlay').waitFor({ state: 'detached', timeout: 5000 });
    };

    await load(6);
    await app('proxy.currentView = arg', 'characters');
    await updates(1).waitFor({ timeout: 15000 });
    assert.equal(await updates(1).textContent(), '1');
    assert.equal(await page.locator('[data-rph-card-updates]').count(), 2, 'one button in the phone actions and one in the computer actions');
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].map((card) => card.name), ['夕', '黍', '黍', '令', '重岳'], 'only cards downloaded from the plaza are looked up');
    assert.deepEqual(asked[0][0], { name: '夕', description: '夕的简介', creatorNotes: '#R18' });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('rp_hub_card_updates_v1')));
    assert.deepEqual(Object.keys(saved.cards).sort(), ['shu-new', 'shu-old', 'xi'], 'ambiguous names and plaza cards newer than the import are not linked');
    console.log('PASS only plaza downloads are checked; a card updated after its import is counted, the other cases are not');

    await updates(1).click();
    await rows.first().waitFor();
    assert.equal(asked.length, 2, 'opening the list checks the plaza again');
    assert.equal(await rows.count(), 1);
    assert.equal(await rows.first().locator('.rph-ui-row-main > div').first().textContent(), '夕');
    assert.equal(await rows.first().locator('.rph-ui-muted').textContent(), '万相广场 11月20日更新');
    await rows.first().getByRole('button', { name: '更新' }).click();
    await page.waitForFunction(() => document.querySelector('iframe')?.getAttribute('src')?.startsWith('https://rphforum.zeabur.app/card/a1?t='), null, { timeout: 15000 });
    assert.equal(await app('return proxy.currentView'), 'square');
    await page.locator('.rph-ui-overlay').waitFor({ state: 'detached', timeout: 5000 }); // 列表随广场打开而关闭
    console.log('PASS the list checks again, and the update button opens the card inside the embedded plaza');

    // 在广场里点「导入」：广场把卡片 PNG 发给 RPH，等它回导入结果。
    const plazaImport = async (requestId) => {
        const frame = page.frames().find((item) => item.url().startsWith('https://rphforum.zeabur.app/card/a1'));
        return frame.evaluate(({ requestId, bytes }) => new Promise((resolve) => {
            window.addEventListener('message', (event) => { if (event.data?.requestId === requestId) resolve(event.data); });
            const buffer = new Uint8Array(bytes).buffer;
            window.parent.postMessage({ type: 'RPH_FORUM_IMPORT_CARD', requestId, buffer }, '*', [buffer]);
        }), { requestId, bytes: [...newVersion] });
    };
    assert.deepEqual(await plazaImport('update-1'), { type: 'RPHUB_IMPORT_RESULT', requestId: 'update-1', name: '夕' });
    const updated = await app(`const char = proxy.characters.find((item) => item.uuid === 'xi');
        return { count: proxy.characters.length, current: proxy.currentCharacter?.uuid, chat: proxy.chatHistory?.length,
            description: char.description, first: char.first_mes, avatar: char.avatar === arg,
            world: char.worldInfo.map((entry) => entry.content), regex: char.regexScripts.map((script) => script.name || script.scriptName),
            templates: char.uiTemplates.map((t) => ({ id: t.id, html: t.htmlTemplate, state: t.variableState, saved: t.runtimeByCharacter?.xi?.variableState })) };`,
    dataUrl(newVersion));
    // 被更新的是正在聊的那张卡：还是当前卡，聊天还在页面上；状态栏数值接着用，作者新加的魔力、药用作者给的初始值。
    const newState = { hp: 37, mp: 50, 背包: { 剑: 1, 药: 3 } };
    assert.deepEqual(updated, { count: 6, current: 'xi', chat: 2, description: '夕的新简介', first: '新的开场白', avatar: true, world: ['新世界书'], regex: ['新正则'],
        templates: [{ id: 'tpl-old', html: '<div>体力 {{hp}} 魔力 {{mp}}</div>', state: newState, saved: newState }] });
    await initializeFixture(page);
    const stored = await page.evaluate(async () => {
        const db = await fixture.db();
        const read = (key) => new Promise((resolve) => { const request = db.transaction('store').objectStore('store').get(key); request.onsuccess = () => resolve(request.result); });
        const result = { description: (await read('rp_hub_character_xi'))?.description, chat: (await read('rp_hub_chat_xi'))?.map((message) => message.content) };
        db.close();
        return result;
    });
    assert.deepEqual(stored, { description: '夕的新简介', chat: ['你好', '继续画'] }, 'the update is saved at once and the chat stays with the card');
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('rp_hub_card_updates_v1')).cards.xi.syncedAt > 0));
    console.log('PASS importing from the update replaces the card in place: same card, new content, the status bar keeps its values and gains the new ones');

    assert.equal((await plazaImport('import-2')).name, '夕');
    await page.waitForFunction(() => {
        const app = document.querySelector('#app').__vue_app__;
        return (app._instance?.proxy || app._container._vnode.component.proxy).characters.length === 7;
    }, null, { timeout: 15000 });
    await app('proxy.currentView = arg', 'characters');
    await checkButton.waitFor({ timeout: 15000 });
    await page.waitForTimeout(1000);
    assert.equal(asked.length, 2, 'besides opening the list, the plaza is checked at most once a day');
    assert.equal(await checkButton.textContent(), '', 'nothing left to update; the button stays for checking by hand');
    console.log('PASS only that one import is taken over; importing again adds a new card as before');

    // 点「检查更新」马上查：广场不可用时说查不成，好了以后说都是最新版。
    failing = true;
    await checkButton.click();
    await note.filter({ hasText: '检查失败' }).waitFor({ timeout: 15000 });
    assert.equal(await note.textContent(), '检查失败：万相广场暂时不可用');
    assert.equal(await rows.count(), 0);
    await closeList();
    failing = false;
    await checkButton.click();
    await note.filter({ hasText: '已是最新版本' }).waitFor({ timeout: 15000 });
    assert.equal(asked.length, 6, 'each check by hand asks at once: six plaza downloads in two batches');
    await closeList();
    console.log('PASS checking by hand asks the plaza at once and says when it cannot be reached');

    // 一天后再查：广场上「夕」多了一张同名卡、简介也改了，作者又改了一次；靠认出过的编号照旧认出原来那张，两张本机的「夕」都要更新。
    const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
    forum = { ...forum, '夕': [{ id: 'z9', createdAt: Date.UTC(2026, 9, 3), updatedAt: later + 1000, same: false },
        { id: 'a1', createdAt: Date.UTC(2026, 9, 1), updatedAt: later, same: false }] };
    await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('rp_hub_card_updates_v1'));
        localStorage.setItem('rp_hub_card_updates_v1', JSON.stringify({ ...state, checkedAt: 0 }));
    });
    const before = asked.length;
    await load(7);
    await app('proxy.currentView = arg', 'characters');
    await updates(2).waitFor({ timeout: 15000 });
    assert.equal(asked.length - before, 2, 'six plaza downloads, asked in two batches');
    await updates(2).click();
    await rows.nth(1).waitFor();
    assert.deepEqual(await rows.locator('.rph-ui-row-main > div:first-child').allTextContents(), ['夕', '夕']);
    assert.match(await rows.first().locator('.rph-ui-muted').textContent(), /^万相广场 \d+月\d+日更新$/);
    console.log('PASS a card linked once keeps its plaza card when a same-name card appears, and shows the next update after an in-place update');
    await closeList();

    // 卡片上的「检查更新」只查这一张：翻牌时正对着的卡有，网格里每张广场下载的卡都有，自己导入的卡没有。
    await page.locator('.character-deck__item.is-focused [data-rph-card-check]').waitFor({ timeout: 15000 });
    await app('proxy.characterGridView = true');
    // 翻牌那组卡片只是藏起来了还在页面上，只找网格里看得见的。
    const card = (name, index = 0) => page.locator('.char-grid-item:visible').filter({ has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) }).nth(index);
    const checkCard = (name, index) => card(name, index).locator('[data-rph-card-check]');
    await checkCard('令').waitFor({ timeout: 15000 });
    assert.equal(await page.locator('.char-grid-item:visible [data-rph-card-check]').count(), 6, 'every plaza download has one');
    assert.equal(await checkCard('年').count(), 0);
    // 「令」在广场上有两张同名卡、认不出：列出来（新上传的在前）让人选，选过的记住，有新版本就能更新。
    const asking = asked.length;
    await checkCard('令').click();
    await note.filter({ hasText: '请选择' }).waitFor({ timeout: 15000 });
    assert.deepEqual(asked.slice(asking).map((batch) => batch.map((item) => item.name)), [['令']], 'only that card is looked up');
    assert.equal(await note.textContent(), '请选择万相广场上对应的卡');
    assert.equal(await rows.count(), 2);
    await rows.first().getByRole('button', { name: '选择' }).click();
    await note.filter({ hasText: '有新版本' }).waitFor();
    assert.equal(await note.textContent(), '「令」有新版本');
    assert.equal(await rows.first().getByRole('button', { name: '更新' }).count(), 1);
    assert.equal(await rows.nth(1).getByRole('button', { name: '选择' }).count(), 1);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rp_hub_card_updates_v1')).cards.ling.id), 'd2');
    await closeList();
    await updates(3).waitFor({ timeout: 5000 });
    console.log('PASS checking one card asks only for it and lets you pick its plaza card when the name is ambiguous');

    // 认得出又没有新版本的只说一句；同一张卡导入了两份（头像一模一样）也分得清点的是哪张。
    await checkCard('黍', 1).click();
    await note.filter({ hasText: '已是最新版本' }).waitFor({ timeout: 15000 });
    assert.equal(await note.textContent(), '「黍」已是最新版本');
    assert.equal(await rows.count(), 0);
    await closeList();
    const copy = await app('return proxy.characters[6].uuid');
    const copyIndex = (await app('return proxy.displayedCharacters.filter((char) => char.name === arg).map((char) => char.uuid)', '夕')).indexOf(copy);
    const xiSynced = await page.evaluate(() => JSON.parse(localStorage.getItem('rp_hub_card_updates_v1')).cards.xi.syncedAt);
    await checkCard('夕', copyIndex).click();
    await note.filter({ hasText: '有新版本' }).waitFor({ timeout: 15000 });
    assert.equal(await rows.count(), 2, 'the other same-name plaza card is offered too');
    await rows.nth(1).getByRole('button', { name: '更新' }).click();
    await page.waitForFunction(() => document.querySelector('iframe')?.getAttribute('src')?.startsWith('https://rphforum.zeabur.app/card/a1?t='), null, { timeout: 15000 });
    assert.equal((await plazaImport('update-copy')).name, '夕');
    const synced = await page.evaluate(() => JSON.parse(localStorage.getItem('rp_hub_card_updates_v1')).cards);
    assert.ok(synced[copy].syncedAt > 0 && synced.xi.syncedAt === xiSynced, 'the copy that was clicked is the one updated');
    assert.equal(await app('return proxy.characters.length'), 7);
    console.log('PASS a card that is up to date says so, and two copies of the same card are told apart');

    // 作者把新版重新上传成了一张新卡（比本机导入晚）：自动检查不认，单张检查里选上它就能更新。
    await app('proxy.currentView = arg', 'characters'); // 回到角色卡管理时官方会切回翻牌，再换成网格
    await app('proxy.characterGridView = true');
    await checkCard('重岳').click();
    await note.filter({ hasText: '请选择' }).waitFor({ timeout: 15000 });
    await rows.first().getByRole('button', { name: '选择' }).click();
    await rows.first().getByRole('button', { name: '更新' }).click();
    await page.waitForFunction(() => document.querySelector('iframe')?.getAttribute('src')?.startsWith('https://rphforum.zeabur.app/card/e1?t='), null, { timeout: 15000 });
    console.log('PASS a re-uploaded plaza card can be picked by hand and updated');
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await harness.close();
}
