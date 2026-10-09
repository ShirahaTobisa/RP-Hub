import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDirectory, '..');

const commands = [
    [process.execPath, ['--check', path.join(projectRoot, 'DB', 'nav-adapter.js')]],
    [process.execPath, [path.join(testDirectory, 'sync-195.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'nav-195.runner.mjs')]],
    [process.execPath, ['--experimental-vm-modules', path.join(testDirectory, 'update-195.test.mjs')]],
    [process.execPath, ['--check', path.join(projectRoot, '_worker.js')]],
    [process.execPath, ['--check', path.join(projectRoot, 'DB', 'bootstrap.js')]],
    [process.execPath, ['--check', path.join(projectRoot, 'DB', 'char-store.js')]],
    [process.execPath, ['--check', path.join(projectRoot, 'DB', 'module-loader.js')]],
    [process.execPath, ['--check', path.join(projectRoot, 'DB', 'ui-kit.js')]],
    [process.execPath, ['--check', path.join(projectRoot, 'examples', 'hello-module.js')]],
    [process.execPath, ['--check', path.join(projectRoot, 'examples', 'broken-module.js')]],
    [process.execPath, ['--check', path.join(projectRoot, 'examples', 'template-module.js')]],
    [process.execPath, ['--check', path.join(projectRoot, 'assets', 'js', 'app.js')]],
    [process.execPath, [path.join(testDirectory, 'mainline-v4-invariants.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'app-patches.test.mjs')]],
    [process.execPath, ['--experimental-vm-modules', path.join(testDirectory, 'app-update-mirror.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'app-patches-performance.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'bootstrap-sync.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'bootstrap-behavior.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'image-module.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'image-edit.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'image-edit.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'mogai-migration-relay.test.mjs')]],
    [process.execPath, ['--experimental-vm-modules', path.join(testDirectory, 'mogai-migration-relay-sync.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'mogai-migration-relay-existing-suite.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'mogai-migration-relay-canonical.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'mogai-migration-relay.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'image-active-character.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'image-active-character-redlines.test.mjs')]],
    [process.execPath, ['--experimental-vm-modules', path.join(testDirectory, 'image-key-compat.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'image-key-persistence.test.mjs')]],
    [process.execPath, ['--experimental-vm-modules', path.join(testDirectory, 'image-hardening.test.mjs')]],
    [process.execPath, ['--experimental-vm-modules', path.join(testDirectory, 'image-upstream-180.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'image-store-freeze.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'image-admin-key.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'workshop-module-loader.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'workshop-sdk.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'workshop-cloud.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'image-perf-ui.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'image-r2-runtime.runner.mjs')]],
    [process.execPath, ['--experimental-vm-modules', path.join(testDirectory, 'worker-hardening.test.mjs'), '--wrangler']],
    [process.execPath, [path.join(testDirectory, 'strip-remote-ping.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'rph-181-e2e.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'rph-181-retag-browser.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'offline-backup-converter.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'upstream-ui-smoke.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'rebuild.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'package.test.mjs')]],
    [process.execPath, [path.join(testDirectory, 'dist-pages-smoke.mjs')]],
    [process.execPath, [path.join(testDirectory, 'package-195-sync.runner.mjs')]],
    [process.execPath, [path.join(testDirectory, 'char-store-browser.runner.mjs')]]
];

for (const [command, args] of commands) {
    const label = [path.basename(command), ...args.map((value) => path.basename(value))].join(' ');
    process.stdout.write(`\n[run] ${label}\n`);
    const result = spawnSync(command, args, {
        cwd: projectRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.stdout.write(`[exit] ${result.status ?? -1}\n`);
    if (result.status !== 0) process.exit(result.status || 1);
}

console.log('[skip] real-offline-backup.runner.mjs (designed environment skip)');
console.log('\nAll automated tests passed.');
