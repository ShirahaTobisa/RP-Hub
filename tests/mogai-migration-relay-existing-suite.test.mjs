import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMigrationRelay } from '../scripts/build-migration-relay.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PROJECT_DIR = path.resolve(ROOT_DIR, '..');
const BASE_ZIP = path.join(PROJECT_DIR, 'release', 'RP-Hub-R2-rebuild-v4-img-20260901-020954.zip');
// This historical relay keeps its original sidebar code and original contract.
const ORIGINAL_SUITE = path.join(ROOT_DIR, 'evidence', 'sync-195', 'baseline', 'tests', 'image-module.test.mjs');

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rph-mogai-relay-existing-suite-'));
try {
    const relay = buildMigrationRelay({
        base: BASE_ZIP,
        dist: path.join(runtimeRoot, 'relay-dist'),
        releaseRoot: path.join(runtimeRoot, 'release'),
        timestamp: '20990101-020202'
    });
    const relayModule = path.join(relay.dist, 'DB', 'image-module.js');
    let suiteSource = fs.readFileSync(ORIGINAL_SUITE, 'utf8');
    const testDirAnchor = "const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));";
    const moduleAnchor = "const modulePath = path.join(ROOT_DIR, 'DB', 'image-module.js');";
    assert.equal(suiteSource.split(testDirAnchor).length - 1, 1, 'existing suite TEST_DIR anchor drifted');
    assert.equal(suiteSource.split(moduleAnchor).length - 1, 1, 'existing suite module path anchor drifted');
    suiteSource = suiteSource
        .replace(testDirAnchor, `const TEST_DIR = ${JSON.stringify(TEST_DIR)};`)
        .replace(moduleAnchor, `const modulePath = ${JSON.stringify(relayModule)};`);

    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
        cwd: ROOT_DIR,
        input: suiteSource,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.status, 0, 'existing image-module suite failed against the relay module');
    console.log(JSON.stringify({
        ok: true,
        suite: path.basename(ORIGINAL_SUITE),
        relayModuleSha256: relay.imageModule.afterSha256,
        relayVersion: relay.imageModule.version
    }, null, 2));
    console.log('mogai-migration-relay-existing-suite.test.mjs: existing image-module suite passed against relay module');
} finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
}
