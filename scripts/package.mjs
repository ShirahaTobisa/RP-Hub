import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEPLOY_ENTRIES = [
    '_worker.js',
    'index.html',
    'work.js',
    'wrangler.toml',
    'LICENSE',
    'assets',
    'character',
    'DB/nav-adapter.js',
    'DB/bootstrap.js',
    'DB/char-store.js',
    'DB/styles.css',
    'DB/image-module.js',
    'DB/module-loader.js',
    'DB/modules'
];

const APP_PATCH_IMPORT = /^import\s*\{\s*patchRpHubAppJs\s*,\s*RpHubAppPatchError\s*,\s*RP_HUB_APP_PATCH_REVISION\s*\}\s*from\s*['"]\.\/DB\/app-patches\.mjs['"]\s*;\s*/;
const MODULE_EXPORT = /^export\s+(const|class|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gm;
const EXPECTED_MODULE_EXPORTS = [
    'const:RP_HUB_APP_PATH',
    'const:RP_HUB_APP_PATCH_REVISION',
    'const:APP_PATCH_MODES',
    'class:RpHubAppPatchError',
    'function:verifyRpHubAppJs',
    'function:patchRpHubAppJs'
];
const STATIC_IMPORT = /^\s*import\b/m;
const ANY_EXPORT = /^\s*export\s+/gm;
const DEFAULT_EXPORT = /^\s*export\s+default\b/gm;
const VERSIONED_WORKER_ASSETS = [
    ['DB/styles.css', '/DB/styles.css'],
    ['DB/nav-adapter.js', '/DB/nav-adapter.js'],
    ['DB/char-store.js', '/DB/char-store.js'],
    ['DB/bootstrap.js', '/DB/bootstrap.js'],
    ['DB/image-module.js', '/DB/image-module.js'],
    ['DB/module-loader.js', '/DB/module-loader.js']
];

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptDirectory, '..');
const projectRoot = path.resolve(sourceRoot, '..');

function parseArguments(argv) {
    const options = {
        distRoot: path.join(sourceRoot, 'dist'),
        releaseRoot: path.join(projectRoot, 'release')
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--dist') options.distRoot = path.resolve(argv[++index]);
        else if (argument === '--release-dir') options.releaseRoot = path.resolve(argv[++index]);
        else throw new Error(`Unknown argument: ${argument}`);
    }
    return options;
}

function assertExists(target, label) {
    if (!fs.existsSync(target)) throw new Error(`${label} does not exist: ${target}`);
}

function copyEntry(relativePath, stageRoot) {
    const source = path.join(sourceRoot, relativePath);
    const target = path.join(stageRoot, relativePath);
    assertExists(source, `Deployment input ${relativePath}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false });
}

function inlineAppPatcher(workerSource, patcherSource) {
    const importMatches = workerSource.match(new RegExp(APP_PATCH_IMPORT.source, 'gm')) || [];
    if (importMatches.length !== 1 || !APP_PATCH_IMPORT.test(workerSource)) {
        throw new Error('Expected exactly one app-patches.mjs import at the start of _worker.js.');
    }
    if (STATIC_IMPORT.test(patcherSource)) {
        throw new Error('DB/app-patches.mjs gained an import; package bundling must be adapted explicitly.');
    }

    const moduleExports = [...patcherSource.matchAll(MODULE_EXPORT)]
        .map((match) => `${match[1]}:${match[2]}`);
    if (JSON.stringify(moduleExports) !== JSON.stringify(EXPECTED_MODULE_EXPORTS)) {
        throw new Error(`Unexpected DB/app-patches.mjs exports: ${moduleExports.join(', ')}`);
    }
    const patcherBody = patcherSource.replace(MODULE_EXPORT, '$1 $2').trim();
    if (ANY_EXPORT.test(patcherBody)) {
        throw new Error('DB/app-patches.mjs contains an unsupported export form.');
    }

    const inlinedModule = [
        '// Inlined from DB/app-patches.mjs by scripts/package.mjs.',
        'const { patchRpHubAppJs, RpHubAppPatchError, RP_HUB_APP_PATCH_REVISION } = (() => {',
        patcherBody,
        'return { patchRpHubAppJs, RpHubAppPatchError, RP_HUB_APP_PATCH_REVISION };',
        '})();',
        ''
    ].join('\n');
    const bundled = workerSource.replace(APP_PATCH_IMPORT, () => inlinedModule);

    if (STATIC_IMPORT.test(bundled) || /\bimport\s*\(/.test(bundled)) {
        throw new Error('Bundled _worker.js still contains an import statement.');
    }
    const exports = bundled.match(ANY_EXPORT) || [];
    const defaultExports = bundled.match(DEFAULT_EXPORT) || [];
    if (exports.length !== 1 || defaultExports.length !== 1) {
        throw new Error('Bundled _worker.js must retain exactly one export default and no other exports.');
    }

    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
        input: bundled,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024
    });
    if (syntax.status !== 0) {
        throw new Error(`Bundled _worker.js failed syntax validation:\n${syntax.stderr || syntax.stdout}`);
    }
    return bundled;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function readWorkerAssetVersions(assetRoot) {
    return Object.fromEntries(VERSIONED_WORKER_ASSETS.map(([relativePath, publicPath]) => {
        const file = path.join(assetRoot, relativePath);
        assertExists(file, `Versioned worker asset ${relativePath}`);
        const version = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
        return [publicPath, version];
    }));
}

export function rewriteWorkerAssetVersions(workerSource, assetRoot) {
    const versions = readWorkerAssetVersions(assetRoot);
    let rewritten = workerSource;
    for (const [publicPath, version] of Object.entries(versions)) {
        const expression = new RegExp(`${escapeRegExp(publicPath)}\\?v=[^"'\\s<>]+`, 'g');
        const matches = rewritten.match(expression) || [];
        if (matches.length !== 1) {
            throw new Error(`Expected exactly one versioned worker asset URL for ${publicPath}; found ${matches.length}.`);
        }
        rewritten = rewritten.replace(expression, `${publicPath}?v=${version}`);
    }
    return rewritten;
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
    const textExtensions = new Set(['.css', '.html', '.js', '.toml']);
    const patterns = [
        { label: 'Cloudflare API token', expression: /cfat_[A-Za-z0-9_-]{20,}/ },
        { label: 'embedded sync password', expression: /RP_SYNC_PASSWORD\s*=\s*['"][^'"]+['"]/ }
    ];
    for (const file of listFiles(root)) {
        if (!textExtensions.has(path.extname(file).toLowerCase())) continue;
        const text = fs.readFileSync(file, 'utf8');
        for (const pattern of patterns) {
            if (pattern.expression.test(text)) findings.push(`${pattern.label}: ${path.relative(root, file)}`);
        }
    }
    if (findings.length > 0) {
        throw new Error(`Sensitive-value scan failed:\n${findings.join('\n')}`);
    }
}

function formatTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join('');
}

function powershellLiteral(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function createZip(distRoot, releaseRoot) {
    fs.mkdirSync(releaseRoot, { recursive: true });
    const timestamp = formatTimestamp();
    const zipPath = path.join(releaseRoot, `RP-Hub-R2-rebuild-v4-img-${timestamp}.zip`);
    const temporaryZip = path.join(releaseRoot, `.RP-Hub-R2-rebuild-v4-img-${timestamp}-${process.pid}.tmp.zip`);
    fs.rmSync(temporaryZip, { force: true });
    try {
        const command = [
            "$ErrorActionPreference = 'Stop'",
            `Compress-Archive -Path (Join-Path ${powershellLiteral(distRoot)} '*') -DestinationPath ${powershellLiteral(temporaryZip)} -CompressionLevel Optimal -Force`
        ].join('; ');
        execFileSync('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            command
        ], { stdio: 'pipe', windowsHide: true });
        if (!fs.existsSync(temporaryZip) || fs.statSync(temporaryZip).size === 0) {
            throw new Error('Compress-Archive did not produce a non-empty ZIP.');
        }
        fs.rmSync(zipPath, { force: true });
        fs.renameSync(temporaryZip, zipPath);
        return zipPath;
    } finally {
        fs.rmSync(temporaryZip, { force: true });
    }
}

function buildDist(distRoot) {
    const stageRoot = path.join(
        path.dirname(distRoot),
        `.rph-dist-stage-${process.pid}-${Date.now()}`
    );
    fs.rmSync(stageRoot, { recursive: true, force: true });
    try {
        fs.mkdirSync(stageRoot, { recursive: true });
        for (const relativePath of DEPLOY_ENTRIES) {
            if (relativePath !== '_worker.js') copyEntry(relativePath, stageRoot);
        }

        const workerSource = fs.readFileSync(path.join(sourceRoot, '_worker.js'), 'utf8');
        const patcherSource = fs.readFileSync(path.join(sourceRoot, 'DB', 'app-patches.mjs'), 'utf8');
        const bundledWorker = rewriteWorkerAssetVersions(
            inlineAppPatcher(workerSource, patcherSource),
            stageRoot
        );
        fs.writeFileSync(path.join(stageRoot, '_worker.js'), bundledWorker, 'utf8');
        scanForSensitiveValues(stageRoot);

        fs.rmSync(distRoot, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(distRoot), { recursive: true });
        fs.renameSync(stageRoot, distRoot);
        return {
            fileCount: listFiles(distRoot).length,
            assetVersions: readWorkerAssetVersions(distRoot)
        };
    } finally {
        fs.rmSync(stageRoot, { recursive: true, force: true });
    }
}

function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    const { fileCount, assetVersions } = buildDist(options.distRoot);
    const zipPath = createZip(options.distRoot, options.releaseRoot);

    process.stdout.write(`${JSON.stringify({
        ok: true,
        dist: options.distRoot,
        zip: zipPath,
        fileCount,
        assetVersions,
        zipBytes: fs.statSync(zipPath).size
    }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
