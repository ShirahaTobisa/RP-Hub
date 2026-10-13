import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchRpHubAppJs } from '../DB/app-patches.mjs';

const DEPLOY_ENTRIES = [
    '_worker.js',
    'index.html',
    'work.js',
    'wrangler.toml',
    'LICENSE',
    'assets',
    'character',
    'novel',
    'DB/ui-kit.js',
    'DB/nav-adapter.js',
    'DB/bootstrap.js',
    'DB/char-store.js',
    'DB/styles.css',
    'DB/image-module.js',
    'DB/module-loader.js'
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
    ['DB/ui-kit.js', '/DB/ui-kit.js'],
    ['DB/nav-adapter.js', '/DB/nav-adapter.js'],
    ['DB/char-store.js', '/DB/char-store.js'],
    ['DB/bootstrap.js', '/DB/bootstrap.js'],
    ['DB/image-module.js', '/DB/image-module.js'],
    ['DB/module-loader.js', '/DB/module-loader.js']
];

// RPH 本体（上游提供的部分）。发版时用 --upstream latest 换成分发端最新收录（补丁预检通过）的上游版本，
// 处理方式和站点「程序更新」相同：文件原样，只给 assets/js/app.js 打补丁。不带 --upstream 时用仓库里的底稿。
const UPSTREAM_ENTRIES = ['index.html', 'LICENSE', 'assets', 'character', 'novel'];
// 上游里不部署的：说明文档、在线人数服务端。出现别的新东西时停下来，确认要不要部署再改这里。
const UPSTREAM_SKIPPED = /^(?:README(?:\.[\w-]+)?\.md|presence-server|\.fixture\.json)$/;
const UPSTREAM_VERSION_LINE = /^const CURRENT_UPSTREAM_VERSION = '[^']*';$/m;
const UPSTREAM_SHA_LINE = /^const CURRENT_UPSTREAM_SHA = '[^']*';$/m;

// 测试版版本号：日期，同一天第二版起加序号，如 2026.10.09、2026.10.09.2。
export const RELEASE_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const RELEASE_VERSION_PLACEHOLDER = "const RPH_RELEASE_VERSION = 'dev';";

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
        else if (argument === '--version') options.version = argv[++index];
        else if (argument === '--upstream') options.upstream = argv[++index];
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (options.version !== undefined && !RELEASE_VERSION_PATTERN.test(options.version)) {
        throw new Error(`Release version must look like 2026.10.09 or 2026.10.09.2: ${options.version}`);
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

// latest：从分发端下载最新收录的上游（逐个核对 SHA-256）；也可以给一个已下载好的目录（带 .fixture.json）。
async function resolveUpstream(value) {
    if (!value) return null;
    if (value === 'latest') {
        const { prepareLatest, latestDirectory } = await import('./prepare-test-fixtures.mjs');
        const marker = await prepareLatest();
        return { root: latestDirectory, tag: marker.tag, commit: marker.commit };
    }
    const root = path.resolve(value);
    const marker = JSON.parse(fs.readFileSync(path.join(root, '.fixture.json'), 'utf8'));
    return { root, tag: marker.tag, commit: marker.commit };
}

function copyUpstream(upstream, stageRoot) {
    const unknown = fs.readdirSync(upstream.root).filter((name) => !UPSTREAM_ENTRIES.includes(name) && !UPSTREAM_SKIPPED.test(name));
    if (unknown.length) {
        throw new Error(`上游 ${upstream.tag} 新增了 ${unknown.join('、')}，先确认要不要部署，再改 scripts/package.mjs 的 UPSTREAM_ENTRIES。`);
    }
    for (const entry of UPSTREAM_ENTRIES) {
        const source = path.join(upstream.root, entry);
        assertExists(source, `上游 ${upstream.tag} 的 ${entry}`);
        fs.cpSync(source, path.join(stageRoot, entry), { recursive: true, force: true, errorOnExist: false });
    }
    const appPath = path.join(stageRoot, 'assets', 'js', 'app.js');
    fs.writeFileSync(appPath, patchRpHubAppJs(fs.readFileSync(appPath, 'utf8'), { version: upstream.tag }).code, 'utf8');
}

// 外壳里记的内置上游版本和提交号换成实际打进去的，「程序更新」面板据此判断是否已是最新。
function writeUpstreamVersion(workerSource, upstream) {
    if (!upstream) return workerSource;
    if (!UPSTREAM_VERSION_LINE.test(workerSource) || !UPSTREAM_SHA_LINE.test(workerSource)) {
        throw new Error('Expected CURRENT_UPSTREAM_VERSION and CURRENT_UPSTREAM_SHA constants in _worker.js.');
    }
    return workerSource
        .replace(UPSTREAM_VERSION_LINE, `const CURRENT_UPSTREAM_VERSION = '${upstream.tag}';`)
        .replace(UPSTREAM_SHA_LINE, `const CURRENT_UPSTREAM_SHA = '${upstream.commit}';`);
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

function writeReleaseVersion(workerSource, version) {
    if (workerSource.split(RELEASE_VERSION_PLACEHOLDER).length !== 2) {
        throw new Error('Expected exactly one RPH_RELEASE_VERSION placeholder in _worker.js.');
    }
    return version ? workerSource.replace(RELEASE_VERSION_PLACEHOLDER, `const RPH_RELEASE_VERSION = '${version}';`) : workerSource;
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
        { label: 'Cloudflare API token', expression: /cf[au]t_[A-Za-z0-9_-]{20,}/ },
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

function createZip(distRoot, releaseRoot, version) {
    fs.mkdirSync(releaseRoot, { recursive: true });
    const timestamp = formatTimestamp();
    const zipPath = path.join(releaseRoot, version ? `RP-Hub-${version}.zip` : `RP-Hub-R2-rebuild-v4-img-${timestamp}.zip`);
    const temporaryZip = path.join(releaseRoot, `.RP-Hub-R2-rebuild-v4-img-${timestamp}-${process.pid}.tmp.zip`);
    const entryListPath = `${temporaryZip}.json`;
    fs.rmSync(temporaryZip, { force: true });
    try {
        // Windows PowerShell 5.1 自带的压缩会写入反斜杠路径，Cloudflare 等工具解压后找不到子目录；
        // 包内文件名由这里按 ZIP 规范（正斜杠）算好，PowerShell 只负责逐个写入，避免短路径（如 RUNNER~1）算错前缀。
        fs.writeFileSync(entryListPath, JSON.stringify(listFiles(distRoot).map(file => ({
            source: file,
            name: path.relative(distRoot, file).split(path.sep).join('/')
        }))));
        const command = [
            "$ErrorActionPreference = 'Stop'",
            'Add-Type -AssemblyName System.IO.Compression.FileSystem',
            `$entries = Get-Content -LiteralPath ${powershellLiteral(entryListPath)} -Raw -Encoding UTF8 | ConvertFrom-Json`,
            `$zip = [IO.Compression.ZipFile]::Open(${powershellLiteral(temporaryZip)}, 'Create')`,
            "try { foreach ($entry in $entries) { [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $entry.source, $entry.name, 'Optimal') } } finally { $zip.Dispose() }"
        ].join('; ');
        execFileSync('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            command
        ], { stdio: 'pipe', windowsHide: true });
        if (!fs.existsSync(temporaryZip) || fs.statSync(temporaryZip).size === 0) {
            throw new Error('ZIP creation did not produce a non-empty file.');
        }
        fs.rmSync(zipPath, { force: true });
        fs.renameSync(temporaryZip, zipPath);
        return zipPath;
    } finally {
        fs.rmSync(temporaryZip, { force: true });
        fs.rmSync(entryListPath, { force: true });
    }
}

// 自部署发布包：外壳原文 + 其余文件的 base64，站点拿到后可直接按 Cloudflare Pages 上传格式部署。
function createReleaseBundle(distRoot, releaseRoot, version) {
    const assets = listFiles(distRoot)
        .map(file => path.relative(distRoot, file).split(path.sep).join('/'))
        .filter(relative => relative !== '_worker.js')
        .sort()
        .map(relative => ({ path: relative, base64: fs.readFileSync(path.join(distRoot, relative)).toString('base64') }));
    const bundlePath = path.join(releaseRoot, `rph-bundle-${version}.json`);
    fs.writeFileSync(bundlePath, JSON.stringify({
        format: 'rph-release-bundle-v1',
        version,
        worker: fs.readFileSync(path.join(distRoot, '_worker.js'), 'utf8'),
        assets
    }));
    return bundlePath;
}

function buildDist(distRoot, version, upstream = null) {
    const stageRoot = path.join(
        path.dirname(distRoot),
        `.rph-dist-stage-${process.pid}-${Date.now()}`
    );
    fs.rmSync(stageRoot, { recursive: true, force: true });
    try {
        fs.mkdirSync(stageRoot, { recursive: true });
        for (const relativePath of DEPLOY_ENTRIES) {
            if (relativePath === '_worker.js' || (upstream && UPSTREAM_ENTRIES.includes(relativePath))) continue;
            copyEntry(relativePath, stageRoot);
        }
        if (upstream) copyUpstream(upstream, stageRoot);

        const workerSource = writeUpstreamVersion(fs.readFileSync(path.join(sourceRoot, '_worker.js'), 'utf8'), upstream);
        const patcherSource = fs.readFileSync(path.join(sourceRoot, 'DB', 'app-patches.mjs'), 'utf8');
        const bundledWorker = rewriteWorkerAssetVersions(
            writeReleaseVersion(inlineAppPatcher(workerSource, patcherSource), version),
            stageRoot
        );
        fs.writeFileSync(path.join(stageRoot, '_worker.js'), bundledWorker, 'utf8');
        scanForSensitiveValues(stageRoot);

        fs.rmSync(distRoot, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(distRoot), { recursive: true });
        fs.renameSync(stageRoot, distRoot);
        return {
            fileCount: listFiles(distRoot).length,
            assetVersions: readWorkerAssetVersions(distRoot),
            upstream: upstream ? `${upstream.tag} ${upstream.commit}` : 'repository base'
        };
    } finally {
        fs.rmSync(stageRoot, { recursive: true, force: true });
    }
}

async function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    const { fileCount, assetVersions, upstream } = buildDist(options.distRoot, options.version, await resolveUpstream(options.upstream));
    const zipPath = createZip(options.distRoot, options.releaseRoot, options.version);
    const bundlePath = options.version ? createReleaseBundle(options.distRoot, options.releaseRoot, options.version) : null;

    process.stdout.write(`${JSON.stringify({
        ok: true,
        dist: options.distRoot,
        zip: zipPath,
        bundle: bundlePath,
        version: options.version || 'dev',
        upstream,
        fileCount,
        assetVersions,
        zipBytes: fs.statSync(zipPath).size
    }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
