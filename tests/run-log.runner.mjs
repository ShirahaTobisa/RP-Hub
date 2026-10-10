import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 运行日志插件：装上后警告存在本机，刷新后还在，从「模块管理 → 插件功能 → 运行日志」能看到；不装就不记录。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];

try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate((base) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url: base + '/DB/modules/run-log.js', enabled: true }]));
    }, harness.url);
    await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
    const pluginReady = () => page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]').some((entry) => entry.lastStatus === 'ok'), null, { timeout: 45000 });
    await pluginReady();
    await page.evaluate(() => console.warn('log probe', { index: 7 }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await pluginReady();
    await page.evaluate(() => [...document.querySelectorAll('.app-nav-trigger')].find((trigger) => trigger.offsetParent)?.click());
    await page.locator('[data-rph-workshop-manager-entry]').waitFor({ state: 'attached' });
    await page.evaluate(() => document.querySelector('[data-rph-workshop-manager-entry]').click());
    await page.locator('[data-rph-workshop-launcher] button', { hasText: '运行日志' }).click();
    await page.waitForFunction(() => document.querySelector('[data-rph-workshop-panel] [data-log]')?.value.includes('[warn] log probe {"index":7}'));
    assert.equal(await page.evaluate(() => localStorage.getItem('rphub_debug_log_v1').includes('log probe')), true);
    console.log('PASS run log plugin keeps warnings across reloads and shows them in its panel');
    assert.deepEqual(errors, []);
} finally {
    await browser.close();
    await harness.close();
}
