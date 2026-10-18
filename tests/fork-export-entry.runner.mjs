import assert from 'node:assert/strict';
import { startHarness, initializeFixture, chromium, chrome, defaultUpstream } from './sync-195.helpers.mjs';

// 「转成魔改版的数据」按钮：上游 2.0.3 及更早放在设置页的「空间管理」里；2.0.4 起上游删了那一段，
// 按钮要自己补在设置页最底下。离开设置页再回来，按钮只能有一个。
const harness = await startHarness({ upstream: defaultUpstream });
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const errors = [];
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(() => localStorage.setItem('roleplay_hub_update_id', '9999999990'));
    await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__, null, { timeout: 45000 });
    const setView = (view) => page.evaluate((value) => {
        const app = document.querySelector('#app').__vue_app__;
        (app._instance?.proxy || app._container._vnode.component.proxy).currentView = value;
    }, view);
    const inspect = () => page.evaluate(() => {
        const buttons = [...document.querySelectorAll('[data-action="fork-export"]')];
        const section = buttons[0]?.closest('.pt-6');
        return {
            count: buttons.length,
            headings: [...document.querySelectorAll('h4.settings-subheading')].map((node) => node.textContent.trim()),
            isLastSection: !!section && section.parentElement?.lastElementChild === section,
            sectionHeading: section?.querySelector('h4.settings-subheading')?.textContent.trim() || ''
        };
    });

    await setView('settings');
    await page.waitForSelector('[data-action="fork-export"]', { timeout: 15000 });
    const first = await inspect();
    assert.equal(first.count, 1, '设置页应有且只有一个「转成魔改版的数据」按钮');
    const upstreamHasStorageSection = first.headings.includes('空间管理');
    if (upstreamHasStorageSection) assert.equal(first.sectionHeading, '空间管理', '上游还有「空间管理」时按钮放在那一段里');
    else assert.equal(first.sectionHeading, '', '上游没有「空间管理」时按钮自成一段');
    assert.ok(first.isLastSection, '按钮所在的一段要在设置页最底下');

    await setView('chat');
    await page.waitForTimeout(500);
    await setView('settings');
    await page.waitForSelector('[data-action="fork-export"]', { timeout: 15000 });
    await page.waitForTimeout(1500);
    assert.equal((await inspect()).count, 1, '离开再回到设置页，按钮不能重复');
    assert.deepEqual(errors, []);
    console.log(`PASS the fork export button mounts once at the bottom of settings (${upstreamHasStorageSection ? 'inside the upstream storage section' : 'in its own section, upstream has none'})`);
} finally {
    await browser.close();
    await harness.close();
}
