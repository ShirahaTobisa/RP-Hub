import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startHarness, chromium, chrome, root } from './sync-195.helpers.mjs';

const upstreamRoot = path.join(root, 'evidence/sync-195/upstream');
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const reports = [];
try {
    for (const [version, sha] of [['1.9.4', 'd312bd4b2798dad3f30307afdbd704aac1f80f1a'], ['1.9.5', 'cd7fb2b946f5985991b60597960852671013f36f']]) {
        const harness = await startHarness({ upstream: path.join(upstreamRoot, version, `RP-Hub-${sha}`), assets: process.env.RPH_PACKAGE_ROOT || root });
        try {
            for (const mobile of [false, true]) {
                const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
                const page = await context.newPage();
                await page.addInitScript(() => {
                    window.navFocusLog = [];
                    document.addEventListener('focusin', event => {
                        navFocusLog.push(event.target.outerHTML.slice(0, 200));
                        if (navFocusLog.length > 12) navFocusLog.shift();
                    });
                });
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.route('**/api/rp-sync', route => route.fulfill({ json: {
                    ok: true, authRequired: true, authenticated: route.request().headers()['x-rp-sync-password'] === 'nav-test-password'
                } }));
                await page.goto(harness.url, { waitUntil: 'networkidle', timeout: 90000 });
                await page.addLocatorHandler(page.getByRole('button', { name: /^(?:我)?知道了/ }).first(),
                    async button => { await button.click({ timeout: 20000 }); });
                const name = page.getByPlaceholder('角色对您的称呼');
                if (await name.isVisible()) {
                    await name.fill('隔离验收用户');
                    await page.getByRole('button', { name: /开始/ }).click();
                    await name.waitFor({ state: 'hidden' });
                }
                if (version === '1.9.5') {
                    const open = async () => {
                        await page.locator('.app-nav-trigger:visible').first().click();
                        await page.locator('[data-rph-sync-entry]').waitFor();
                    };
                    await open();
                    await page.locator('[data-rph-sync-entry]').waitFor();
                    assert.equal(await page.locator('[data-rph-nav-entry]').count(), 3);
                    await page.locator('.app-navigation-close').click();
                    await page.locator('#app-navigation-panel').waitFor({ state: 'detached' });
                    for (let i = 0; i < 20; i++) {
                        await open();
                        assert.equal(await page.locator('[data-rph-nav-entry]').count(), 3);
                        await page.locator('.app-navigation-close').click();
                        await page.locator('#app-navigation-panel').waitFor({ state: 'detached' });
                    }
                    await open();
                    await page.locator('[data-rph-sync-entry]').press('Enter');
                    await page.locator('.rp-sync-password-modal.is-open input').waitFor();
                    assert.equal(await page.locator('#app-navigation-panel').count(), 0);
                    assert.equal(await page.evaluate(() => document.activeElement?.type), 'password');
                    await page.locator('.rp-sync-password-modal [data-action="cancel-password"]').click();
                    assert.equal(await page.evaluate(() => document.activeElement?.matches('.app-nav-trigger')), true,
                        JSON.stringify(await page.evaluate(() => ({ active: document.activeElement.outerHTML.slice(0, 300), log: navFocusLog }))));
                    await open();
                    await page.locator('[data-rph-sync-entry]').click();
                    await page.locator('.rp-sync-password-modal.is-open input').fill('nav-test-password');
                    await page.locator('[data-action="submit-password"]').click();
                    const syncPanel = page.locator('.rp-sync-modal.is-open:not(.rp-sync-password-modal)');
                    await syncPanel.waitFor();
                    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.rp-sync-modal.is-open'))), true);
                    await syncPanel.locator('.rp-sync-modal__close').click();
                    await open();
                    await page.locator('[data-rph-workshop-manager-entry]').press('Space');
                    await page.locator('[data-rph-workshop-panel]').waitFor();
                    assert.equal(await page.locator('#app-navigation-panel').count(), 0);
                    await page.locator('[data-rph-workshop-panel-close]').click();
                    await open();
                    const popup = page.waitForEvent('popup');
                    await page.locator('[data-rph-image-sidebar-entry]').click();
                    await (await popup).close();
                    await page.locator('#app-navigation-panel').waitFor({ state: 'detached' });
                    await open();
                    await page.evaluate(() => {
                        window.activationCount = 0;
                        window.dynamicEntry = RPHubNavAdapter.registerEntry({ id: 'dynamic-test', label: '动态入口', iconPaths: [], onClick() {
                            window.activationCount++;
                            const input = document.createElement('input'); input.id = 'dynamic-focus'; document.body.appendChild(input); input.focus();
                        } });
                    });
                    await page.locator('[data-rph-nav-entry="dynamic-test"]').click();
                    await page.locator('#app-navigation-panel').waitFor({ state: 'detached' });
                    assert.equal(await page.evaluate(() => document.activeElement?.id), 'dynamic-focus');
                    assert.equal(await page.evaluate(() => window.activationCount), 1);
                    await page.evaluate(() => { dynamicEntry.dispose(); document.querySelector('#dynamic-focus').remove(); });
                    await open();
                    await page.evaluate(() => { api.state.syncing = true; api.updateButtonState(); });
                    await page.locator('.app-navigation-close').click();
                    await page.locator('#app-navigation-panel').waitFor({ state: 'detached' });
                    await open();
                    assert.equal(await page.locator('[data-rph-sync-entry]').textContent(), '处理中');
                    assert.equal(await page.locator('[data-rph-sync-entry]').isDisabled(), true);
                    await page.evaluate(() => { api.state.syncing = false; api.updateButtonState(); });
                } else {
                    await page.locator('[data-rph-sync-entry]').waitFor({ state: 'attached' });
                    assert.equal(await page.locator('[data-rph-nav-entry]').count(), 3);
                    if (!mobile) {
                        await page.getByTitle('收起侧边栏', { exact: true }).click();
                        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-rph-sync-entry] [data-rph-nav-label]')).display === 'none');
                        assert.equal(await page.locator('[data-rph-sync-entry]').isVisible(), true);
                        await page.getByTitle('展开侧边栏', { exact: true }).click();
                        await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-rph-sync-entry] [data-rph-nav-label]')).display !== 'none');
                    } else {
                        await page.locator('button:has(use[href="#icon-menu"]):visible').first().click();
                    }
                    await page.locator('[data-rph-sync-entry]').click();
                    await page.locator('.rp-sync-password-modal.is-open input').waitFor();
                    assert.equal(await page.evaluate(() => document.activeElement?.type), 'password');
                    await page.locator('.rp-sync-password-modal [data-action="cancel-password"]').click();
                }
                const screenshot = path.join(root, `evidence/sync-195/nav-${version}-${mobile ? 'mobile-emulation' : 'desktop'}.png`);
                if (version === '1.9.5') await page.waitForFunction(() => {
                    const layer = document.querySelector('.app-navigation-layer');
                    return !layer.classList.contains('app-navigation-enter-active')
                        && Number(getComputedStyle(layer.querySelector('.app-navigation-panel')).opacity) > .99;
                });
                await page.screenshot({ path: screenshot });
                reports.push({ version, mobileEmulation: mobile, errors, screenshot });
                console.log(JSON.stringify(reports.at(-1)));
                assert.deepEqual(errors, []);
                await context.close();
            }
        } finally { await harness.close(); }
    }
    await fs.writeFile(path.join(root, 'evidence/sync-195/navigation.json'), JSON.stringify(reports, null, 2));
} finally { await browser.close(); }
