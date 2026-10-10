import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
    'image-edit.test.mjs',
    'image-active-character.test.mjs',
    'image-active-character-redlines.test.mjs',
    'image-attribution-189.test.mjs',
    'mainline-v4-invariants.test.mjs',
    'image-hardening.test.mjs',
    'image-key-persistence.test.mjs',
    'bootstrap-sync.test.mjs',
    'offline-backup-converter.test.mjs',
    'self-update.test.mjs',
    'image-storage.test.mjs',
    'update-notice.test.mjs',
    'static-cache.test.mjs'
];

for (const test of tests) {
    console.log('\n[run] ' + test);
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', 'tests/' + test], {
        cwd: root, stdio: 'inherit', windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\nAll ' + tests.length + ' core test scripts passed.');
