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
    const row = (name) => page.locator('[data-scheme]').filter({ has: page.locator('b', { hasText: new RegExp(`^${name}$`) }) });
    const saveAs = async (name) => {
        await page.locator('[data-new]').fill(name);
        await page.getByRole('button', { name: '存成方案' }).click();
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

    await page.waitForFunction(async () => {
        const db = await new Promise((resolve) => { indexedDB.open('RPHubDB').onsuccess = (event) => resolve(event.target.result); });
        const presets = await new Promise((resolve) => { db.transaction('store').objectStore('store').get('rp_hub_presets').onsuccess = (event) => resolve(event.target.result); });
        db.close();
        return presets?.find((preset) => preset.content === 'B')?.enabled === false && presets?.find((preset) => preset.content === 'A')?.enabled === true;
    }, null, { timeout: 10000 });
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
    await row('日常').getByRole('button', { name: '删除' }).click();
    await page.getByRole('button', { name: '删除', exact: true }).last().click();
    await row('日常').waitFor({ state: 'detached' });
    const imported = { ...exported, schemes: [...exported.schemes, { name: '分享来的', states: [['文风A', true], ['文风B', true]] }] };
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '导入' }).click()]);
    await chooser.setFiles({ name: 'schemes.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
    await row('分享来的').waitFor();
    assert.equal(await page.locator('[data-scheme]').count(), 3, 'importing replaces same-name schemes instead of duplicating them');
    console.log('PASS schemes export to a file, delete, and import back (same names replaced)');

    await load();
    await button.click();
    await row('分享来的').getByRole('button', { name: '切换' }).click();
    assert.deepEqual(await switches(), ['A:true', 'B:true', '第一个:true', '第二个:true', 'new:false']);
    await saveAs('同上');
    assert.equal(await row('同上').locator('.rph-ui-muted').first().textContent(), '和现在的开关一样');
    console.log('PASS schemes survive a reload and switch after it');
} finally {
    await browser.close();
    await harness.close();
}
