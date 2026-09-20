import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { patchRpHubAppJs } from '../DB/app-patches.mjs';

const UPSTREAM_TAG = '1.7.5';
const EXPECTED_UPSTREAM_COMMIT = '060846be0d3677fac1d77c5f331f99a94e898bba';
const BASELINE_FILES = ['_worker.js', 'DB', 'wrangler.toml', 'work.js'];
const UPSTREAM_FILES = ['index.html', 'assets', 'character', 'LICENSE'];
const CUSTOM_FILES = [
    '_worker.js',
    'DB/bootstrap.js',
    'DB/char-store.js',
    'DB/app-patches.mjs'
];
const PROJECT_FILES = ['README.md', 'PATCHES.md', 'scripts', 'tests'];
const IN_PLACE_ENTRIES = [
    '_worker.js',
    'DB',
    'wrangler.toml',
    'work.js',
    'index.html',
    'LICENSE',
    'assets',
    'character'
];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptDirectory, '..');
const projectRoot = path.resolve(sourceRoot, '..');
const baselineRoot = path.join(projectRoot, 'R2');
const upstreamRepository = path.join(projectRoot, 'RP-Hub');

function parseArguments(argv) {
    let output = sourceRoot;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--output') output = path.resolve(argv[++index]);
        else throw new Error(`Unknown argument: ${argument}`);
    }
    return { output };
}

function assertExists(target, label) {
    if (!fs.existsSync(target)) throw new Error(`${label} does not exist: ${target}`);
}

function copyEntry(fromRoot, toRoot, relativePath) {
    const source = path.join(fromRoot, relativePath);
    const target = path.join(toRoot, relativePath);
    assertExists(source, `Build input ${relativePath}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
}

function gitOutput(args) {
    return execFileSync('git', ['-C', upstreamRepository, ...args], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024
    }).trim();
}

function verifySources() {
    assertExists(baselineRoot, 'R2 baseline');
    assertExists(upstreamRepository, 'Upstream repository');
    const commit = gitOutput(['rev-parse', `${UPSTREAM_TAG}^{commit}`]);
    if (commit !== EXPECTED_UPSTREAM_COMMIT) {
        throw new Error(`Upstream tag ${UPSTREAM_TAG} resolved to unexpected commit ${commit}.`);
    }
    for (const relativePath of BASELINE_FILES) {
        assertExists(path.join(baselineRoot, relativePath), `Required baseline input ${relativePath}`);
    }
    for (const relativePath of [...CUSTOM_FILES, ...PROJECT_FILES]) {
        assertExists(path.join(sourceRoot, relativePath), `Required project input ${relativePath}`);
    }
}

function extractUpstream(stageRoot, workingDirectory) {
    const archivePath = path.join(workingDirectory, 'upstream.tar');
    execFileSync('git', [
        '-C', upstreamRepository,
        'archive',
        '--format=tar',
        `--output=${archivePath}`,
        UPSTREAM_TAG,
        ...UPSTREAM_FILES
    ], { stdio: 'pipe' });
    execFileSync('tar', ['-xf', archivePath, '-C', stageRoot], { stdio: 'pipe' });
}

function listFiles(root) {
    const files = [];
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile()) files.push(absolute);
        }
    };
    visit(root);
    return files;
}

function scanForSensitiveValues(root) {
    const findings = [];
    const textExtensions = new Set(['.bat', '.css', '.html', '.js', '.json', '.md', '.mjs', '.toml', '.txt']);
    const patterns = [
        { label: 'Cloudflare API token', expression: /cfat_[A-Za-z0-9_-]{20,}/ },
        { label: 'embedded sync password', expression: /RP_SYNC_PASSWORD\s*=\s*['"][^'"]+['"]/ }
    ];
    for (const file of listFiles(root)) {
        if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
        const text = fs.readFileSync(file, 'utf8');
        for (const pattern of patterns) {
            if (pattern.expression.test(text)) {
                findings.push(`${pattern.label}: ${path.relative(root, file)}`);
            }
        }
    }
    if (findings.length > 0) {
        throw new Error(`Sensitive-value scan failed:\n${findings.join('\n')}`);
    }
}

function buildStage(stageRoot, workingDirectory) {
    fs.mkdirSync(stageRoot, { recursive: true });
    for (const relativePath of BASELINE_FILES) copyEntry(baselineRoot, stageRoot, relativePath);
    extractUpstream(stageRoot, workingDirectory);
    for (const relativePath of CUSTOM_FILES) copyEntry(sourceRoot, stageRoot, relativePath);
    for (const relativePath of PROJECT_FILES) copyEntry(sourceRoot, stageRoot, relativePath);

    const appPath = path.join(stageRoot, 'assets', 'js', 'app.js');
    const source = fs.readFileSync(appPath, 'utf8');
    const patched = patchRpHubAppJs(source, { version: UPSTREAM_TAG });
    fs.writeFileSync(appPath, patched.code, 'utf8');
    scanForSensitiveValues(stageRoot);
    return patched.report;
}

function replaceInPlace(stageRoot) {
    for (const relativePath of IN_PLACE_ENTRIES) {
        const source = path.join(stageRoot, relativePath);
        const target = path.join(sourceRoot, relativePath);
        fs.rmSync(target, { recursive: true, force: true });
        fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
    }
}

function installStage(stageRoot, outputRoot) {
    if (path.resolve(outputRoot) === sourceRoot) {
        replaceInPlace(stageRoot);
        return sourceRoot;
    }
    if (fs.existsSync(outputRoot)) {
        throw new Error(`Refusing to overwrite an existing output directory: ${outputRoot}`);
    }
    fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
    fs.renameSync(stageRoot, outputRoot);
    return outputRoot;
}

function verifyInstalledOutput(outputRoot) {
    for (const relativePath of [...BASELINE_FILES, ...UPSTREAM_FILES, ...CUSTOM_FILES, ...PROJECT_FILES]) {
        assertExists(path.join(outputRoot, relativePath), `Generated output ${relativePath}`);
    }
    scanForSensitiveValues(outputRoot);
    const upstreamApp = execFileSync('git', [
        '-C', upstreamRepository,
        'show',
        `${UPSTREAM_TAG}:assets/js/app.js`
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const expectedApp = patchRpHubAppJs(upstreamApp, { version: UPSTREAM_TAG }).code;
    const actualApp = fs.readFileSync(path.join(outputRoot, 'assets', 'js', 'app.js'), 'utf8');
    if (actualApp !== expectedApp) throw new Error('Generated app.js differs from shared patcher output.');
}

const options = parseArguments(process.argv.slice(2));
verifySources();

const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rph-rebuild-'));
const stageRoot = path.join(workingDirectory, 'R2-rebuild');
let installedRoot = null;
try {
    const patchReport = buildStage(stageRoot, workingDirectory);
    installedRoot = installStage(stageRoot, options.output);
    verifyInstalledOutput(installedRoot);
    process.stdout.write(`${JSON.stringify({
        ok: true,
        output: installedRoot,
        baseline: baselineRoot,
        upstreamTag: UPSTREAM_TAG,
        upstreamCommit: EXPECTED_UPSTREAM_COMMIT,
        patchReport
    }, null, 2)}\n`);
} finally {
    if (fs.existsSync(workingDirectory)) fs.rmSync(workingDirectory, { recursive: true, force: true });
}
