// 全量测试：npm test、test:package、test:browser 三组，加上没放进这三组的检查；打包后再跑要用 dist 的三项。
// 一项失败不停，最后列出失败的项。浏览器用 CHROME_PATH 指定，两个 wrangler 端到端测试要全局装 wrangler。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const node = `"${process.execPath}"`;
const syntaxChecked = [
    '_worker.js', 'assets/js/app.js', 'DB/bootstrap.js', 'DB/char-store.js', 'DB/module-loader.js', 'DB/nav-adapter.js', 'DB/ui-kit.js',
    'examples/hello-module.js', 'examples/broken-module.js', 'examples/template-module.js'
];
const extraTests = [
    'app-patches-performance.test.mjs', 'app-update-mirror.test.mjs', 'bootstrap-behavior.runner.mjs', 'char-store-browser.runner.mjs',
    'image-r2-runtime.runner.mjs', 'image-store-freeze.runner.mjs', 'real-offline-backup.runner.mjs', 'strip-remote-ping.runner.mjs'
];
const distTests = ['dist-pages-smoke.mjs', 'fork-migration.runner.mjs', 'sync-fast-upload.runner.mjs'];
const steps = [
    ...syntaxChecked.map((file) => `${node} --check ${file}`),
    'npm test', 'npm run test:package', 'npm run test:browser',
    ...extraTests.map((file) => `${node} --experimental-vm-modules tests/${file}`),
    'npm run build',
    ...distTests.map((file) => `${node} tests/${file}`)
];

const failed = [];
for (const command of steps) {
    console.log(`\n[run] ${command}`);
    if (spawnSync(command, { cwd: root, shell: true, stdio: 'inherit' }).status !== 0) failed.push(command);
}
console.log(failed.length ? `\n${failed.length} 项失败：\n${failed.join('\n')}` : `\n全部 ${steps.length} 项通过。`);
process.exit(failed.length ? 1 : 0);
