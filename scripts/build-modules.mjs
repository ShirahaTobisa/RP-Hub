import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const checkOnly = process.argv.includes('--check');
const map = JSON.parse(await fs.readFile(new URL('./self-modules.json', import.meta.url), 'utf8'));
for (const [target, inputs] of Object.entries(map)) {
    let source = (await Promise.all(inputs.map(file => fs.readFile(path.join(root, file), 'utf8')))).join('');
    for (const match of [...source.matchAll(/\/\* @shared\/([\w-]+) \*\//g)]) {
        source = source.replace(match[0], await fs.readFile(path.join(root, 'src/shared', match[1] + '.js'), 'utf8'));
    }
    if (/\.[cm]?js$/.test(target)) {
        const check = spawnSync(process.execPath, ['--input-type=module', '--check'], {
            input: source, encoding: 'utf8', windowsHide: true
        });
        if (check.error) throw check.error;
        if (check.status !== 0) throw new Error(target + '\n' + check.stderr);
    }
    const destination = path.join(root, target);
    if (checkOnly) {
        if (await fs.readFile(destination, 'utf8') !== source) {
            throw new Error(target + ' 与源码不一致，请运行 npm run build:modules。');
        }
    } else {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, source);
    }
}
console.log((checkOnly ? 'Checked ' : 'Built ') + Object.keys(map).length + ' self modules.');
