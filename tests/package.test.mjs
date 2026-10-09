import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWorkerAssetVersions, rewriteWorkerAssetVersions } from '../scripts/package.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '..');
const packageScript = path.join(sourceRoot, 'scripts', 'package.mjs');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rph-package-test-'));
const distRoot = path.join(temporaryRoot, 'dist');
const releaseRoot = path.join(temporaryRoot, 'release');
const extractedRoot = path.join(temporaryRoot, 'extracted');
const versionFixtureRoot = path.join(temporaryRoot, 'version-fixture');
const deployEntries = [
    '_worker.js',
    'index.html',
    'work.js',
    'wrangler.toml',
    'LICENSE',
    'assets',
    'character',
    'novel',
    'DB/nav-adapter.js',
    'DB/bootstrap.js',
    'DB/char-store.js',
    'DB/styles.css',
    'DB/image-module.js',
    'DB/module-loader.js',
    'DB/modules/advice-inject.js'
];
const versionedAssets = [
    ['DB/styles.css', '/DB/styles.css'],
    ['DB/nav-adapter.js', '/DB/nav-adapter.js'],
    ['DB/char-store.js', '/DB/char-store.js'],
    ['DB/bootstrap.js', '/DB/bootstrap.js'],
    ['DB/image-module.js', '/DB/image-module.js'],
    ['DB/module-loader.js', '/DB/module-loader.js']
];
const EXPECTED_DIST_WORKER_SHA256 = '478ebd52cd824ca2098b9153fecc4dc415869d7e1de58ee1b8dbcd1b2af4be18';

function runPackage() {
    const result = spawnSync(process.execPath, [
        packageScript,
        '--dist', distRoot,
        '--release-dir', releaseRoot
    ], {
        cwd: sourceRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(path.resolve(report.dist), distRoot);
    assert.ok(fs.existsSync(report.zip), 'package ZIP was not created');
    assert.match(path.basename(report.zip), /^RP-Hub-R2-rebuild-v4-img-\d{8}-\d{6}\.zip$/);
    return report;
}

function listFiles(root) {
    const files = [];
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll('\\', '/'));
        }
    };
    visit(root);
    return files.sort();
}

function expectedFiles() {
    const files = [];
    const visit = (absolute, relative) => {
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(absolute)) {
                visit(path.join(absolute, name), path.join(relative, name));
            }
        } else {
            files.push(relative.replaceAll('\\', '/'));
        }
    };
    for (const entry of deployEntries) visit(path.join(sourceRoot, entry), entry);
    return files.sort();
}

function fileHash(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readWorkerVersion(worker, publicPath) {
    const marker = `${publicPath}?v=`;
    const start = worker.indexOf(marker);
    assert.ok(start >= 0, `worker asset URL is missing: ${publicPath}`);
    return worker.slice(start + marker.length).match(/^[a-f0-9]+/)?.[0] || '';
}

function powershellLiteral(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

try {
    const sourceWorkerHash = fileHash(path.join(sourceRoot, '_worker.js'));
    const sourcePatcherHash = fileHash(path.join(sourceRoot, 'DB', 'app-patches.mjs'));
    const first = runPackage();
    const second = runPackage();

    const expected = expectedFiles();
    assert.deepEqual(listFiles(distRoot), expected, 'dist contains files outside the deployment whitelist');
    assert.equal(second.fileCount, expected.length);

    const bundledWorker = fs.readFileSync(path.join(distRoot, '_worker.js'), 'utf8');
    assert.equal(fileHash(path.join(distRoot, '_worker.js')), EXPECTED_DIST_WORKER_SHA256,
        'dist worker SHA-256 lock changed');
    assert.doesNotMatch(bundledWorker, /^\s*import(?:\s|\{|\*)/m);
    assert.doesNotMatch(bundledWorker, /\bimport\s*\(/);
    assert.equal((bundledWorker.match(/^\s*export\s+default\b/gm) || []).length, 1);
    assert.equal((bundledWorker.match(/^\s*export\s+/gm) || []).length, 1);
    assert.match(bundledWorker, /Inlined from DB\/app-patches\.mjs/);
    const expectedVersions = readWorkerAssetVersions(distRoot);
    assert.deepEqual(second.assetVersions, expectedVersions);
    for (const [, publicPath] of versionedAssets) {
        assert.equal(readWorkerVersion(bundledWorker, publicPath), expectedVersions[publicPath]);
        assert.equal(expectedVersions[publicPath].length, 12);
    }
    assert.ok(!fs.existsSync(path.join(distRoot, 'DB', 'app-patches.mjs')));

    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
        input: bundledWorker,
        encoding: 'utf8'
    });
    assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

    for (const relativePath of expected.filter((value) => value !== '_worker.js')) {
        assert.equal(
            fileHash(path.join(distRoot, relativePath)),
            fileHash(path.join(sourceRoot, relativePath)),
            `${relativePath} changed while packaging`
        );
    }
    assert.equal(fileHash(path.join(sourceRoot, '_worker.js')), sourceWorkerHash);
    assert.equal(fileHash(path.join(sourceRoot, 'DB', 'app-patches.mjs')), sourcePatcherHash);
    assert.equal(fileHash(path.join(distRoot, 'DB', 'image-module.js')), fileHash(path.join(sourceRoot, 'DB', 'image-module.js')));
    assert.equal(fileHash(path.join(distRoot, 'DB', 'module-loader.js')), fileHash(path.join(sourceRoot, 'DB', 'module-loader.js')));
    assert.ok(!fs.existsSync(path.join(distRoot, 'examples')), 'examples must not be packaged');
    assert.ok(!fs.existsSync(path.join(distRoot, 'WORKSHOP-MOD-GUIDE.md')), 'author guide must not be packaged');

    for (const [relativePath] of versionedAssets) {
        const target = path.join(versionFixtureRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(sourceRoot, relativePath), target);
    }
    const sourceWorker = fs.readFileSync(path.join(sourceRoot, '_worker.js'), 'utf8');
    for (const [relativePath, changedPublicPath] of versionedAssets) {
        const target = path.join(versionFixtureRoot, relativePath);
        const original = fs.readFileSync(target);
        const beforeProbe = rewriteWorkerAssetVersions(sourceWorker, versionFixtureRoot);
        fs.appendFileSync(target, '\n// package hash change probe\n', 'utf8');
        const afterProbe = rewriteWorkerAssetVersions(sourceWorker, versionFixtureRoot);
        assert.notEqual(
            readWorkerVersion(afterProbe, changedPublicPath),
            readWorkerVersion(beforeProbe, changedPublicPath),
            `${relativePath} content change did not change its worker URL parameter`
        );
        for (const [, publicPath] of versionedAssets.filter(([, publicPath]) => publicPath !== changedPublicPath)) {
            assert.equal(readWorkerVersion(afterProbe, publicPath), readWorkerVersion(beforeProbe, publicPath),
                `${publicPath} parameter changed when only ${relativePath} changed`);
        }
        fs.writeFileSync(target, original);
    }

    fs.mkdirSync(extractedRoot, { recursive: true });
    execFileSync('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${powershellLiteral(second.zip)} -DestinationPath ${powershellLiteral(extractedRoot)} -Force`
    ], { stdio: 'pipe', windowsHide: true });
    assert.deepEqual(listFiles(extractedRoot), expected, 'ZIP contents differ from dist');
    assert.deepEqual(listFiles(distRoot), listFiles(extractedRoot));
    assert.ok(!fs.existsSync(path.join(extractedRoot, 'examples')), 'examples must not be present in ZIP');
    assert.ok(!fs.existsSync(path.join(extractedRoot, 'WORKSHOP-MOD-GUIDE.md')), 'author guide must not be present in ZIP');
    assert.ok(first.zipBytes > 0 && second.zipBytes > 0);
} finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('package assertions passed');
