import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHarness, initializeFixture, chromium, chrome, root, defaultUpstream } from './sync-195.helpers.mjs';

// 性能基准（不是通过/失败测试）：模拟 AI 逐字输出，比较“原版页面”和“加载覆盖层”的主线程开销。
// 输出：脚本耗时、任务耗时、长任务次数，以及每个 MutationObserver 回调的调用次数和耗时。
// 用法：node tests/perf-streaming.runner.mjs [--tokens 400] [--interval 25] [--runs 3]
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((item) => item.trim().split(/\s+/)));
const TOKENS = Number(args.tokens || 400);
const INTERVAL = Number(args.interval || 25);
const RUNS = Number(args.runs || 3);
// 对照组只保留角色分键存储（打过补丁的 app.js 依赖它），不加载同步、生图、插件加载器和导航适配。
const emptyAssets = fs.mkdtempSync(path.join(os.tmpdir(), 'rph-perf-no-overlay-'));
fs.mkdirSync(path.join(emptyAssets, 'DB'));
fs.copyFileSync(path.join(root, 'DB/char-store.js'), path.join(emptyAssets, 'DB/char-store.js'));

function instrumentObservers() {
    const stats = new Map();
    window.__observerStats = stats;
    const Native = window.MutationObserver;
    window.MutationObserver = class extends Native {
        constructor(callback) {
            const stack = new Error().stack || '';
            const source = (stack.match(/\/(DB\/[\w-]+\.js|assets\/js\/[\w-]+\.js)/g) || []).find((item) => item.includes('/DB/'))
                || (stack.match(/\/(assets\/js\/[\w-]+\.js)/) || [])[0] || 'other';
            const record = stats.get(source) || { calls: 0, time: 0, records: 0 };
            stats.set(source, record);
            super((records, observer) => {
                const start = performance.now();
                try { callback(records, observer); } finally {
                    record.calls += 1;
                    record.records += records.length;
                    record.time += performance.now() - start;
                }
            });
        }
    };
    window.__longTasks = [];
    try {
        new PerformanceObserver((list) => window.__longTasks.push(...list.getEntries().map((entry) => entry.duration)))
            .observe({ type: 'longtask', buffered: false });
    } catch (_) { /* longtask 不可用时只看 CDP 指标 */ }
}

async function seed(page, harness, plugins) {
    await page.goto(harness.url + '/seed.html');
    await initializeFixture(page);
    await page.evaluate(async ({ base, plugins }) => {
        localStorage.setItem('roleplay_hub_update_id', '999999999');
        localStorage.setItem('rp_hub_workshop_modules_v1', JSON.stringify(plugins.map((file) => ({ url: base + '/DB/modules/' + file, enabled: true }))));
        const uuid = 'perf-card';
        const character = { uuid, name: '测试角色', description: '性能基准', first_mes: '准备完成', worldInfo: [], regexScripts: [], uiTemplates: [] };
        const user = { uuid: 'perf-user', name: '测试用户', person: 'second' };
        const history = [];
        for (let index = 0; index < 20; index += 1) {
            history.push({ id: 'u' + index, role: 'user', name: user.name, content: '第 ' + index + ' 轮的输入，写一些普通的文字。' });
            history.push({ id: 'a' + index, role: 'assistant', name: character.name, content: ('这是第 ' + index + ' 轮的回复。').repeat(40) });
        }
        const db = await fixture.db();
        await fixture.write(db, [
            ['rp_hub_character_index', { order: [uuid] }], ['rp_hub_character_' + uuid, character], ['rp_hub_chat_' + uuid, history],
            ['rp_hub_settings', { autoFetchModels: false }], ['rp_hub_global_worldinfo', []], ['rp_hub_worldinfo', []],
            ['rp_hub_global_regex', []], ['rp_hub_regex', []],
            ['rp_hub_user', user], ['rp_hub_user_profiles', [user]], ['rp_hub_active_profile_id', user.uuid], ['rp_hub_last_active_char', 0]
        ]);
        db.close();
    }, { base: harness.url, plugins });
}

async function measure(label, assets, plugins = []) {
    const harness = await startHarness({ upstream: defaultUpstream, ...(assets ? { assets } : {}) });
    const browser = await chromium.launch({ executablePath: chrome, headless: true });
    const results = [];
    try {
        for (let run = 0; run < RUNS; run += 1) {
            const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
            const page = await context.newPage();
            await seed(page, harness, plugins);
            await context.addInitScript(instrumentObservers);
            const loadStart = Date.now();
            await page.goto(harness.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForFunction(() => document.querySelectorAll('[data-chat-index]').length > 10, null, { timeout: 60000, polling: 50 });
            const loadMs = Date.now() - loadStart;
            await page.waitForTimeout(3000);
            const cdp = await context.newCDPSession(page);
            await cdp.send('Performance.enable');
            const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((item) => [item.name, item.value]));
            await page.evaluate(() => { for (const record of window.__observerStats.values()) Object.assign(record, { calls: 0, time: 0, records: 0 }); window.__longTasks.length = 0; });
            const scans = () => page.evaluate(() => window.RPHubImageModule?.getPerformanceCounters?.()?.scanRuns ?? null);
            const scansBefore = await scans();
            await cdp.send('Profiler.enable');
            await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
            await cdp.send('Profiler.start');
            const before = await metric();
            // 和真实流式输出一样：页面处于“生成中”（出现中止按钮），每隔 INTERVAL 毫秒往最后一条 AI 回复追加一小段文字，由 Vue 重新渲染。
            await page.evaluate(({ tokens, interval }) => new Promise((resolve) => {
                const app = document.querySelector('#app').__vue_app__;
                const vm = (app._instance || app._container._vnode.component).proxy;
                vm.isGenerating = true;
                vm.chatHistory.push({ id: 'stream', role: 'assistant', name: '测试角色', content: '' });
                const message = vm.chatHistory[vm.chatHistory.length - 1];
                let count = 0;
                const timer = setInterval(() => {
                    message.content += (count % 30 === 29 ? '\n\n' : '') + '字' + (count % 10);
                    if (++count >= tokens) { clearInterval(timer); vm.isGenerating = false; setTimeout(resolve, 1500); }
                }, interval);
            }), { tokens: TOKENS, interval: INTERVAL });
            const after = await metric();
            const { profile } = await cdp.send('Profiler.stop');
            // 按脚本文件汇总采样到的自身耗时（不含子调用），看开销落在哪个文件。
            const byScript = {};
            const durations = new Map();
            profile.samples.forEach((id, index) => durations.set(id, (durations.get(id) || 0) + (profile.timeDeltas[index] || 0)));
            for (const node of profile.nodes) {
                const url = node.callFrame.url ? new URL(node.callFrame.url).pathname.replace(/^.*\/(?=[^/]+$)/, '') : '(' + (node.callFrame.functionName || 'native') + ')';
                byScript[url] = (byScript[url] || 0) + (durations.get(node.id) || 0) / 1000;
            }
            const scansAfter = await scans();
            const observers = await page.evaluate(() => Object.fromEntries([...window.__observerStats.entries()]
                .filter(([, record]) => record.calls).map(([source, record]) => [source, { calls: record.calls, records: record.records, ms: Math.round(record.time) }])));
            const longTasks = await page.evaluate(() => window.__longTasks);
            results.push({
                loadMs,
                scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
                taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
                layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
                longTasks: longTasks.length,
                longTaskMs: Math.round(longTasks.reduce((sum, value) => sum + value, 0)),
                imageScans: scansAfter === null ? null : scansAfter - scansBefore,
                byScript: Object.fromEntries(Object.entries(byScript).filter(([, ms]) => ms >= 2).sort((a, b) => b[1] - a[1]).map(([url, ms]) => [url, Math.round(ms)])),
                observers
            });
            await context.close();
        }
    } finally {
        await browser.close();
        await harness.close();
    }
    const median = (key) => results.map((item) => item[key]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
    const summary = { label, runs: RUNS, loadMs: median('loadMs'), scriptMs: median('scriptMs'), taskMs: median('taskMs'), layoutMs: median('layoutMs'), longTasks: median('longTasks'), longTaskMs: median('longTaskMs'), imageScans: median('imageScans'), observers: results[Math.floor(results.length / 2)].observers, byScript: results[Math.floor(results.length / 2)].byScript };
    console.log(JSON.stringify(summary));
    return summary;
}

console.log(`streaming ${TOKENS} tokens every ${INTERVAL}ms, ${RUNS} runs each (median)`);
const baseline = await measure('upstream + char-store only', emptyAssets);
const overlay = await measure('with overlays', null);
const withPlugin = await measure('with overlays + advice plugin', null, ['advice-inject.js']);
console.log(JSON.stringify({ overlayScriptMs: overlay.scriptMs - baseline.scriptMs, overlayTaskMs: overlay.taskMs - baseline.taskMs,
    pluginScriptMs: withPlugin.scriptMs - overlay.scriptMs }));
fs.rmSync(emptyAssets, { recursive: true, force: true });
