import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// Nai2API 插件：外壳的步数滑条按直链 28 步上限建，插件自己把上限放到 50，进出设置页都显示存好的 50 步。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const view = (page, value) => page.evaluate((value) => {
    const a = document.querySelector('#app').__vue_app__;
    (a._instance?.proxy || a._container._vnode.component.proxy).currentView = value;
}, value);

try {
    const page = await browser.newPage();
    await page.route('**/image/api/settings', (route) => route.fulfill({ json: { ok: true, settings: { generator: 'nai2api-web',
        params: { steps: 50, scale: 6, cfg: 0, sampler: 'k_euler', noise_schedule: 'karras', resolution: '', negative: '' } } } }));
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate((base) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify([{ url: base + '/DB/modules/nai2api-web.js', enabled: true }]));
    }, harness.url);
    await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]').some((entry) => entry.lastStatus === 'ok'), null, { timeout: 45000 });
    await page.evaluate(() => RPHubImageModule.reloadGenerationSettings());
    for (let round = 1; round <= 2; round++) {
        await view(page, 'settings');
        await page.locator('[data-rph-image-param] input[type="range"]').first().waitFor({ state: 'attached' });
        await page.waitForTimeout(500);
        const shown = await page.evaluate(() => {
            const input = document.querySelector('[data-rph-image-param] input[type="range"]');
            return [input.value, input.max, input.closest('[data-rph-image-param]').querySelector('span').textContent];
        });
        assert.deepEqual(shown, ['50', '50', '50 步'], `round ${round}`);
        await view(page, 'chat');
        await page.waitForTimeout(300);
    }
    console.log('PASS Nai2API plugin shows the saved 50 steps each time the settings page opens');
} finally {
    await browser.close();
    await harness.close();
}
