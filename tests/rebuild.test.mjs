import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '..');
const script = path.join(sourceRoot, 'scripts', 'rebuild.mjs');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rph-rebuild-test-'));
const outputRoot = path.join(temporaryRoot, 'generated');
const runtimeEntries = [
    '_worker.js', 'DB', 'wrangler.toml', 'work.js', 'index.html', 'LICENSE', 'assets', 'character'
];

function fileHash(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function treeManifest(root, entries) {
    const manifest = new Map();
    const visit = (absolute, relative) => {
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(absolute).sort()) {
                visit(path.join(absolute, name), path.join(relative, name));
            }
        } else {
            manifest.set(relative.replaceAll('\\', '/'), fileHash(absolute));
        }
    };
    for (const entry of entries) visit(path.join(root, entry), entry);
    return manifest;
}

try {
    const result = spawnSync(process.execPath, [script, '--output', outputRoot], {
        cwd: sourceRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.upstreamTag, '1.7.5');
    assert.equal(report.upstreamCommit, '060846be0d3677fac1d77c5f331f99a94e898bba');
    assert.equal(report.patchReport.replacements.persistenceBridge, 1);

    const expected = treeManifest(sourceRoot, runtimeEntries);
    // This historical recipe omits delivery overlays and copies the original
    // R2 stylesheet. The current release is checked by package.test.mjs.
    expected.delete('DB/image-module.js');
    expected.delete('DB/module-loader.js');
    expected.delete('DB/nav-adapter.js');
    expected.delete('DB/ui-kit.js');
    expected.set('DB/styles.css', 'a5ae1a2f99c1ca26bd3a3533551996b745a43a78adba87418cde0af9913bfbf9');
    const actual = treeManifest(outputRoot, runtimeEntries);
    assert.deepEqual(actual, expected);

    const allowedRootEntries = new Set([...runtimeEntries, 'README.md', 'PATCHES.md', 'scripts', 'tests']);
    const unexpectedRootEntries = fs.readdirSync(outputRoot).filter((name) => !allowedRootEntries.has(name));
    assert.deepEqual(unexpectedRootEntries, [], 'delivery root contains unexpected files');
    const forbiddenNames = new Set(['.wrangler', '.cache', 'node_modules']);
    const forbidden = [];
    const scanForbidden = (dir) => {
        for (const name of fs.readdirSync(dir)) {
            const absolute = path.join(dir, name);
            if (forbiddenNames.has(name)) forbidden.push(path.relative(outputRoot, absolute));
            if (fs.statSync(absolute).isDirectory()) scanForbidden(absolute);
        }
    };
    scanForbidden(outputRoot);
    assert.deepEqual(forbidden, [], 'generated delivery contains caches');

    const refused = spawnSync(process.execPath, [script, '--output', outputRoot], {
        cwd: sourceRoot,
        encoding: 'utf8'
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Refusing to overwrite an existing output directory/);
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('rebuild assertions passed');
