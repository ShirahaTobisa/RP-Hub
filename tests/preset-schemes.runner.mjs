import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 预设方案插件：把预设条目的开关存成方案、一键切换（同名条目按顺序对应）、RPH 自己保存切换后的开关、
// 之后新加的条目切换时不动、编辑方案不改现在的开关、导出导入、删除、刷新后方案还在。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });

try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => { throw error; });
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async (base) => {
        localStorage.setItem('roleplay_hub_update_id', '9999999990');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url: base + '/DB/modules/preset-schemes.js', enabled: true }]));
        const user = { uuid: 'u', name: '用户', person: 'second' };
        const db = await fixture.db();
        await fixture.write(db, [['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', 'u'],
            ['rp_hub_settings', { autoFetchModels: false }],
            ['rp_hub_presets', [
                { name: '文风A', content: 'A', enabled: true, role: 'system' },
                { name: '文风B', content: 'B', enabled: false, role: 'system' },
                { name: '重名', content: '第一个', enabled: true, role: 'user' },
                { name: '重名', content: '第二个', enabled: false, role: 'user' }
            ]]]);
        db.close();
    }, harness.url);
    const button = page.locator('[data-rph-workshop-composer-button="preset-schemes"]');
    const load = async () => {
        await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
        await page.addLocatorHandler(page.getByRole('button', { name: /^(?:我)?知道了/ }).first(), (item) => item.click());
        await button.waitFor({ timeout: 45000 });
    };
    // 页面里的预设开关：只看测试种的条目（RPH 还会自己加内置条目）。
    const switches = () => page.evaluate(() => {
        const a = document.querySelector('#app').__vue_app__;
        const proxy = a._instance?.proxy || a._container._vnode.component.proxy;
        return proxy.presets.filter((preset) => ['文风A', '文风B', '重名', '新条目'].includes(preset.name)).map((preset) => `${preset.content}:${preset.enabled !== false}`);
    });
    const setSwitch = (content, enabled) => page.evaluate(({ content, enabled }) => {
        const a = document.querySelector('#app').__vue_app__;
        const proxy = a._instance?.proxy || a._container._vnode.component.proxy;
        proxy.presets.find((preset) => preset.content === content).enabled = enabled;
    }, { content, enabled });
    // RPH 存进数据库的预设。页面里的 waitForFunction 不等异步判断，所以在这边轮询。
    const storedPresets = () => page.evaluate(async () => {
        const db = await new Promise((resolve) => { indexedDB.open('RPHubDB').onsuccess = (event) => resolve(event.target.result); });
        const value = await new Promise((resolve) => { db.transaction('store').objectStore('store').get('rp_hub_presets').onsuccess = (event) => resolve(event.target.result); });
        db.close();
        return value || [];
    });
    const waitStored = async (check, label) => {
        for (const deadline = Date.now() + 10000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 200))) {
            if (check(await storedPresets())) return;
        }
        throw new Error(`RPH 没在 10 秒内存好：${label}`);
    };
    const row = (name) => page.locator('[data-scheme]').filter({ has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) });
    const saveAs = async (name) => {
        await page.locator('[data-new]').fill(name);
        await page.getByRole('button', { name: '存成方案', exact: true }).click();
        await row(name).waitFor();
    };

    await load();
    await button.click();
    await saveAs('日常');
    await setSwitch('A', false);
    await setSwitch('B', true);
    await setSwitch('第二个', true);
    await saveAs('战斗');
    assert.match(await page.locator('.rph-ui-muted').filter({ hasText: '现在用的是' }).textContent(), /「战斗」/);
    assert.equal(await row('日常').locator('.rph-ui-muted').first().textContent(), '切换后：开 文风A；关 文风B、重名');
    await row('日常').getByRole('button', { name: '切换' }).click();
    assert.deepEqual(await switches(), ['A:true', 'B:false', '第一个:true', '第二个:false']);
    await row('日常').getByText('正在用').waitFor();
    console.log('PASS the current switches are saved as schemes and one click switches back, same-name entries in order');

    await waitStored((presets) => presets.find((preset) => preset.content === 'B')?.enabled === false
        && presets.find((preset) => preset.content === 'A')?.enabled === true && presets.find((preset) => preset.content === '第二个')?.enabled === false, '切换后的开关');
    console.log('PASS RPH saves the switched presets itself');

    await page.evaluate(() => {
        const a = document.querySelector('#app').__vue_app__;
        const proxy = a._instance?.proxy || a._container._vnode.component.proxy;
        proxy.presets.push({ name: '新条目', content: 'new', enabled: true, role: 'system' });
    });
    await row('战斗').getByRole('button', { name: '切换' }).click();
    assert.deepEqual(await switches(), ['A:false', 'B:true', '第一个:true', '第二个:true', 'new:true']);
    console.log('PASS entries added after a scheme was saved keep their switch');

    await row('战斗').getByRole('button', { name: '编辑' }).click();
    await page.locator('[data-filter]').fill('文风b');
    assert.equal(await page.locator('[data-entry]:visible').count(), 1);
    await page.locator('[data-filter]').fill('');
    await page.locator('[data-entry]').filter({ hasText: '文风B' }).locator('.settings-toggle').click();
    assert.match(await page.locator('[data-entry]').filter({ hasText: '新条目' }).textContent(), /新条目，还没记进方案/);
    await page.getByRole('button', { name: '保存方案' }).click();
    assert.deepEqual(await switches(), ['A:false', 'B:true', '第一个:true', '第二个:true', 'new:true'], 'editing a scheme does not touch the current switches');
    await row('战斗').getByRole('button', { name: '切换' }).click();
    assert.deepEqual(await switches(), ['A:false', 'B:false', '第一个:true', '第二个:true', 'new:false']);
    console.log('PASS a scheme is edited without touching the current switches, and the edit applies on switch');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出全部' }).click()]);
    const exported = JSON.parse(await (await download.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8')));
    assert.equal(exported.format, 'rph-preset-schemes-v1');
    assert.deepEqual(exported.schemes.map((scheme) => scheme.name), ['日常', '战斗']);
    assert.deepEqual(exported.presets.filter((entry) => ['文风A', '文风B', '重名', '新条目'].includes(entry.name)).map((entry) => `${entry.name}:${entry.content}`),
        ['文风A:A', '文风B:B', '重名:第一个', '重名:第二个', '新条目:new'], 'the file carries the entries the schemes use');
    await row('日常').getByRole('button', { name: '删除' }).click();
    await page.getByRole('button', { name: '删除', exact: true }).last().click();
    await row('日常').waitFor({ state: 'detached' });
    // 导入到缺条目的地方：缺的条目补到列表末尾（先关着、内容照文件），已有的同名条目不重复加。
    await page.evaluate(() => {
        const a = document.querySelector('#app').__vue_app__;
        const proxy = a._instance?.proxy || a._container._vnode.component.proxy;
        for (const name of ['文风B', '新条目']) proxy.presets.splice(proxy.presets.findIndex((preset) => preset.name === name), 1);
    });
    const imported = { ...exported, schemes: [...exported.schemes, { name: '分享来的', states: [['文风A', true], ['文风B', true]] }] };
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '导入' }).click()]);
    await chooser.setFiles({ name: 'schemes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
    await row('分享来的').waitFor();
    assert.equal(await page.locator('[data-scheme]').count(), 3, 'importing replaces same-name schemes instead of duplicating them');
    await page.getByText('新加了 2 个预设条目').first().waitFor();
    assert.deepEqual(await switches(), ['A:false', '第一个:true', '第二个:true', 'B:false', 'new:false']);
    // RPH 改完预设约 1 秒后才存，等它存好再刷新。
    await waitStored((presets) => presets.at(-1)?.name === '新条目' && presets.at(-2)?.name === '文风B' && presets.at(-2).content === 'B', '导入补上的条目');
    console.log('PASS schemes export with their entries, delete, and import back (same names replaced, missing entries added switched off)');

    await load();
    await button.click();
    await row('分享来的').getByRole('button', { name: '切换' }).click();
    assert.deepEqual(await switches(), ['A:true', '第一个:true', '第二个:true', 'B:true', 'new:false']);
    await saveAs('同上');
    assert.equal(await row('同上').locator('.rph-ui-muted').first().textContent(), '和现在的开关一样');
    console.log('PASS schemes survive a reload and switch after it');

    // RPH 自己的「预设管理」页：列表上方的方案下拉框显示当前方案、选中就切换；手动改开关后显示没存成方案；切走再回来只有一个。
    await page.keyboard.press('Escape');
    const setView = (view) => page.evaluate((view) => {
        const a = document.querySelector('#app').__vue_app__;
        (a._instance?.proxy || a._container._vnode.component.proxy).currentView = view;
    }, view);
    await setView('presets');
    const bar = page.locator('[data-preset-schemes-bar]');
    const trigger = bar.locator('button[aria-haspopup="listbox"]');
    await trigger.waitFor();
    assert.equal((await trigger.textContent()).trim(), '分享来的');
    assert.equal(await bar.evaluate((node) => node.nextElementSibling?.id), 'presets-list', 'the bar sits right above the native preset list');
    await trigger.click();
    await page.getByRole('option', { name: '日常' }).click();
    assert.deepEqual(await switches(), ['A:true', '第一个:true', '第二个:false', 'B:false', 'new:false']);
    await page.waitForFunction(() => document.querySelector('[data-preset-schemes-bar] button[aria-haspopup="listbox"]').textContent.trim() === '日常');
    await setSwitch('第二个', true);
    await page.waitForFunction(() => document.querySelector('[data-preset-schemes-bar] button[aria-haspopup="listbox"]').textContent.trim() === '现在的开关没存成方案');
    await setView('chat');
    await bar.waitFor({ state: 'detached' });
    await setView('presets');
    await trigger.waitFor();
    assert.equal(await bar.count(), 1);
    const [barDownload] = await Promise.all([page.waitForEvent('download'), bar.getByRole('button', { name: '导出全部方案' }).click()]);
    const barFile = JSON.parse(await (await barDownload.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8')));
    assert.deepEqual(barFile.schemes.map((scheme) => scheme.name), ['日常', '战斗', '分享来的', '同上']);
    const [barChooser] = await Promise.all([page.waitForEvent('filechooser'), bar.getByRole('button', { name: '导入方案' }).click()]);
    await barChooser.setFiles({ name: 'more.json', mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ format: 'rph-preset-schemes-v1', schemes: [{ name: '预设页导入的', states: [['文风A', false]] }] })) });
    await trigger.click();
    await page.getByRole('option', { name: '预设页导入的' }).waitFor();
    await page.keyboard.press('Escape');
    await bar.getByRole('button', { name: '管理方案' }).click();
    await row('日常').waitFor();
    console.log('PASS the native preset page gets a scheme dropdown that switches in one pick, follows manual toggles, and imports and exports');

    // 方案也管全局正则：存方案时一起记、切换时一起切；卡里的正则不管；没记正则的旧方案切换时不动正则；
    // 导出带上方案用到的正则，导入时补上缺的（全局、先关着），刷新后还在。
    const regexSwitches = () => page.evaluate(() => {
        const a = document.querySelector('#app').__vue_app__;
        return (a._instance?.proxy || a._container._vnode.component.proxy).regexScripts
            .filter((script) => ['正则A', '正则B', '卡里的'].includes(script.name)).map((script) => `${script.name}:${script.enabled !== false}`);
    });
    const editRegexes = (change) => page.evaluate((change) => {
        const a = document.querySelector('#app').__vue_app__;
        const scripts = (a._instance?.proxy || a._container._vnode.component.proxy).regexScripts;
        const base = { flags: 'g', replacement: '', placement: [2], markdownOnly: true, promptOnly: false, runOnEdit: false, minDepth: null, maxDepth: null };
        if (change === 'seed') {
            scripts.push({ ...base, name: '正则A', regex: 'a', scope: 'global', enabled: true }, { ...base, name: '正则B', regex: 'b', scope: 'global', enabled: false },
                { ...base, name: '卡里的', regex: 'c', scope: 'character', enabled: true });
        } else if (change === 'drop B') scripts.splice(scripts.findIndex((script) => script.name === '正则B'), 1);
        else for (const [name, enabled] of Object.entries(change)) scripts.find((script) => script.name === name).enabled = enabled;
    }, change);
    await editRegexes('seed');
    await saveAs('正则一');
    await editRegexes({ 正则A: false, 正则B: true, 卡里的: false });
    await saveAs('正则二');
    assert.equal(await row('正则一').locator('.rph-ui-muted').first().textContent(), '切换后：开正则 1 条；关正则 1 条');
    await row('正则一').getByRole('button', { name: '切换' }).click();
    assert.deepEqual(await regexSwitches(), ['正则A:true', '正则B:false', '卡里的:false'], 'switching sets the global regexes and leaves the card ones alone');
    await row('分享来的').getByRole('button', { name: '切换' }).click();
    assert.deepEqual(await regexSwitches(), ['正则A:true', '正则B:false', '卡里的:false'], 'a scheme without regex switches leaves the regexes alone');
    console.log('PASS schemes save and switch global regexes too, leaving card regexes and old schemes alone');

    await row('正则二').getByRole('button', { name: '编辑' }).click();
    assert.equal(await page.locator('[data-regex]').filter({ hasText: '卡里的' }).count(), 0, 'the editor lists only global regexes');
    await page.locator('[data-regex]').filter({ hasText: '正则A' }).locator('.settings-toggle').click();
    await page.getByRole('button', { name: '保存方案' }).click();
    assert.deepEqual(await regexSwitches(), ['正则A:true', '正则B:false', '卡里的:false'], 'editing a scheme does not touch the current regexes');
    await row('正则二').getByRole('button', { name: '切换' }).click();
    assert.deepEqual(await regexSwitches(), ['正则A:true', '正则B:true', '卡里的:false']);
    console.log('PASS the scheme editor lists the global regexes and the edit applies on switch');

    const [regexDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出全部', exact: true }).click()]);
    const regexFile = JSON.parse(await (await regexDownload.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8')));
    assert.deepEqual(regexFile.regex.map((script) => script.name).filter((name) => ['正则A', '正则B', '卡里的'].includes(name)), ['正则A', '正则B']);
    assert.ok(regexFile.regex.every((script) => !('enabled' in script) && !('scope' in script)), 'exported regexes carry no switch or scope');
    assert.equal(regexFile.schemes.find((scheme) => scheme.name === '分享来的').regexStates, undefined);
    await editRegexes('drop B');
    const [regexChooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '导入', exact: true }).click()]);
    await regexChooser.setFiles({ name: 'regex.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(regexFile)) });
    await page.getByText('新加了 1 条正则').first().waitFor();
    assert.deepEqual(await regexSwitches(), ['正则A:true', '卡里的:false', '正则B:false'], 'a missing regex comes back switched off');
    await row('正则二').getByRole('button', { name: '切换' }).click();
    assert.deepEqual(await regexSwitches(), ['正则A:true', '卡里的:false', '正则B:true']);
    const storedRegex = () => page.evaluate(async () => {
        const db = await new Promise((resolve) => { indexedDB.open('RPHubDB').onsuccess = (event) => resolve(event.target.result); });
        const value = await new Promise((resolve) => { db.transaction('store').objectStore('store').get('rp_hub_global_regex').onsuccess = (event) => resolve(event.target.result); });
        db.close();
        return (value || []).filter((script) => script.name === '正则B').map((script) => `${script.scope}:${script.enabled}`);
    });
    for (const deadline = Date.now() + 10000; String(await storedRegex()) !== 'global:true'; await new Promise((resolve) => setTimeout(resolve, 200))) {
        if (Date.now() > deadline) throw new Error('RPH 没在 10 秒内存好导入的正则');
    }
    await load();
    await button.click();
    assert.deepEqual((await regexSwitches()).filter((item) => !item.startsWith('卡里的')), ['正则A:true', '正则B:true']);
    await row('正则二').getByText('正在用').waitFor();
    console.log('PASS exported schemes carry their regexes; importing adds the missing ones as global and off, and they survive a reload');
} finally {
    await browser.close();
    await harness.close();
}
