import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_ZIP_SHA256 = '70E67D42FC40EF17B6DDEF80E46DF8ED1254A0BBE1725A9CCA090A735CAF5B29';
export const BASE_IMAGE_MODULE_SHA256 = 'DA7D22F73FA4ADB40350212C9DB9B2B32F1895E3EC5DA1EE88DE2285C159BAD3';

export const EXPECTED_ARCHIVE_FILES = [
    '_worker.js',
    'assets/css/styles.css',
    'assets/js/app.js',
    'assets/js/card-utils.js',
    'assets/js/ui-select.js',
    'assets/js/utils.js',
    'character/index.html',
    'DB/bootstrap.js',
    'DB/char-store.js',
    'DB/image-module.js',
    'DB/styles.css',
    'index.html',
    'LICENSE',
    'work.js',
    'wrangler.toml'
].sort();

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(scriptDirectory, '..');
const projectRoot = path.resolve(sourceRoot, '..');

function sha256Bytes(value) {
    return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function sha256File(file) {
    return sha256Bytes(fs.readFileSync(file));
}

function countOccurrences(source, anchor) {
    let count = 0;
    let offset = 0;
    while (true) {
        const index = String(source).indexOf(anchor, offset);
        if (index < 0) return count;
        count += 1;
        offset = index + Math.max(1, anchor.length);
    }
}

function replaceExactly(source, anchor, replacement, label) {
    const count = countOccurrences(source, anchor);
    if (count !== 1) {
        throw new Error(`Relay patch anchor ${label} expected exactly once; found ${count}. Refusing to build.`);
    }
    return String(source).replace(anchor, replacement);
}

/**
 * Inject the v3 relay behavior into the baseline module only.  The condition
 * mirrors the magic client's normalizeRecord shape: prompt remains on the
 * record, while prompt/tag/upstreamParams are absent from the snapshot.
 * On top of the v2 tag backfill, conditional signature rebuild and the
 * loadRecords persistence bridge, v3 adds two more injections:
 *   - key recompute: records hitting the backfill guard discard their stored
 *     (magic 3-segment) key and are re-keyed with buildImageRenderRecordKey
 *     from the four components carried on the record itself;
 *   - full catalog sweep: after module initialization every character bucket
 *     is loaded once (serially) so the persistence bridge converts all
 *     buckets, not just the active character's.
 * No world-info logic is introduced here.
 */
export function patchImageModule(source) {
    const promptAnchor = "        const prompt = String(record.prompt || paramsSnapshot.prompt || paramsSnapshot.tag || '');\n        const createdAt = Number(record.createdAt) || Date.now();";
    const promptReplacement = "        const prompt = String(record.prompt || paramsSnapshot.prompt || paramsSnapshot.tag || '');\n        let imageSignature = String(record.imageSignature || '');\n        const mogaiShapedRecord = !paramsSnapshot.tag && !paramsSnapshot.prompt && !paramsSnapshot.upstreamParams\n            && paramsSnapshot.source !== 'upstream' && prompt;\n        if (mogaiShapedRecord) {\n            paramsSnapshot.tag = prompt.slice(0, 2000);\n            if (!imageSignature) imageSignature = buildImageRenderSignature(paramsSnapshot);\n        }\n        const createdAt = Number(record.createdAt) || Date.now();";
    let patched = replaceExactly(source, promptAnchor, promptReplacement, 'mogai tag backfill');

    patched = replaceExactly(
        patched,
        "            imageSignature: String(record.imageSignature || ''),",
        '            imageSignature,',
        'conditional image signature backfill'
    );

    // Magic-shaped records persist under the magic 3-segment key
    // (messageId:occurrenceIndex:promptHash) while findRecord requires the
    // native 4-segment key.  Discard the stored key and recompute it from the
    // four components the record itself carries; both sides use the identical
    // FNV-1a hashText so the recomputed key matches the scan descriptor.
    // Records that miss the guard keep their stored key untouched.
    patched = replaceExactly(
        patched,
        '        normalized.key = normalized.key || buildImageRenderRecordKey(normalized);',
        '        normalized.key = mogaiShapedRecord\n            ? buildImageRenderRecordKey(normalized)\n            : normalized.key || buildImageRenderRecordKey(normalized);',
        'magic record key recompute'
    );

    // The baseline loader normalizes into memory but does not persist the
    // changed bucket.  Add only the existing debounce path so conversion is
    // durable and naturally idempotent on the next load.
    const loadAnchor = `    async function loadRecords(uuid, ownerName = '') {
        if (!uuid) return [];
        const value = await dbGet(\`${'${IMAGE_RECORD_PREFIX}'}${'${uuid}'}\`);
        return Array.isArray(value)
            ? value.map((record) => {
                const normalized = normalizeImageRenderRecord(record, uuid);
                if (normalized.paramsSnapshot.characterName === '未命名角色' && ownerName) {
                    normalized.paramsSnapshot.characterName = String(ownerName);
                }
                return normalized;
            }).filter((record) => record.prompt)
            : [];
    }`;
    const loadReplacement = `    async function loadRecords(uuid, ownerName = '') {
        if (!uuid) return [];
        const value = await dbGet(\`${'${IMAGE_RECORD_PREFIX}'}${'${uuid}'}\`);
        const records = Array.isArray(value)
            ? value.map((record) => {
                const normalized = normalizeImageRenderRecord(record, uuid);
                if (normalized.paramsSnapshot.characterName === '未命名角色' && ownerName) {
                    normalized.paramsSnapshot.characterName = String(ownerName);
                }
                return normalized;
            }).filter((record) => record.prompt)
            : [];
        if (Array.isArray(value) && JSON.stringify(value) !== JSON.stringify(records)) {
            setRecordBucket(uuid, records);
            scheduleSave({ uuid });
        }
        return records;
    }`;
    patched = replaceExactly(patched, loadAnchor, loadReplacement, 'normalized record persistence');

    // The conversion above is per-character and lazy: buckets belonging to
    // characters the user never opens would stay magic-shaped forever.  Sweep
    // the character catalog once after initialization, loading each bucket
    // serially (never concurrently) so the persistence bridge rewrites every
    // bucket.  Second runs see no diff and write nothing.
    const sweepAnchor = '    async function initialize() {';
    const sweepReplacement = `    async function convertAllImageRecordBuckets() {
        let catalog;
        try {
            catalog = await loadCharacterCatalogFromDb();
        } catch (error) {
            log('image record bucket sweep catalog read failed', error);
            return;
        }
        for (const character of catalog.characters) {
            const uuid = String(character?.uuid || '');
            if (!uuid) continue;
            try {
                await loadRecords(uuid, String(character?.name || ''));
            } catch (error) {
                log('image record bucket sweep failed for character', uuid, error);
            }
        }
    }

    async function initialize() {`;
    patched = replaceExactly(patched, sweepAnchor, sweepReplacement, 'full bucket sweep definition');

    patched = replaceExactly(
        patched,
        '        scheduleFullScan(0);\n    }\n\n    state.ready = new Promise((resolve) => {',
        '        scheduleFullScan(0);\n        convertAllImageRecordBuckets().catch((error) => log(\'image record bucket sweep failed\', error));\n    }\n\n    state.ready = new Promise((resolve) => {',
        'full bucket sweep invocation'
    );

    if (patched === source) throw new Error('Relay image-module patch unexpectedly made no changes.');
    if (/IMAGE_AUTO_ENTRY_MIGRATION_KEY|migrateNativeAutoImageEntry|buildNativeAutoImagePrompt/.test(patched)) {
        throw new Error('Refusing to build a relay containing retired world-info seeding logic.');
    }
    return patched;
}

export function rewriteImageModuleVersion(workerSource, moduleBytes) {
    const version = createHash('sha256').update(moduleBytes).digest('hex').slice(0, 12);
    const expression = /\/DB\/image-module\.js\?v=[^"'\s<>]+/g;
    const matches = String(workerSource).match(expression) || [];
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one versioned image-module URL in _worker.js; found ${matches.length}.`);
    }
    const rewritten = String(workerSource).replace(expression, `/DB/image-module.js?v=${version}`);
    const beforeLines = String(workerSource).split('\n');
    const afterLines = rewritten.split('\n');
    const changedLines = beforeLines
        .map((line, index) => line === afterLines[index] ? null : index + 1)
        .filter(Boolean);
    if (changedLines.length !== 1) {
        throw new Error(`Image module version rewrite changed ${changedLines.length} worker lines; expected 1.`);
    }
    return {
        source: rewritten,
        version,
        line: changedLines[0],
        before: matches[0],
        after: `/DB/image-module.js?v=${version}`
    };
}

function parseArguments(argv) {
    const options = {
        base: '',
        dist: '',
        releaseRoot: path.join(projectRoot, 'release'),
        timestamp: ''
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--base') options.base = path.resolve(argv[++index]);
        else if (argument === '--dist') options.dist = path.resolve(argv[++index]);
        else if (argument === '--release-dir') options.releaseRoot = path.resolve(argv[++index]);
        else if (argument === '--timestamp') options.timestamp = String(argv[++index] || '');
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!options.base) throw new Error('Required argument missing: --base <baseline.zip>');
    if (options.timestamp && !/^\d{8}-\d{6}$/.test(options.timestamp)) {
        throw new Error(`Invalid --timestamp value: ${options.timestamp}`);
    }
    return options;
}

function formatTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function nodePath(value) {
    return String(value).replaceAll('\\', '/');
}

function systemTar() {
    const root = process.env.SystemRoot || 'C:\\Windows';
    const candidate = path.join(root, 'System32', 'tar.exe');
    return fs.existsSync(candidate) ? candidate : 'tar';
}

function listZipFiles(zipPath) {
    const output = execFileSync(systemTar(), ['-tf', nodePath(zipPath)], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
    });
    return output.split(/\r?\n/)
        .map((entry) => entry.replaceAll('\\', '/').replace(/^\.\//, ''))
        .filter((entry) => entry && !entry.endsWith('/'));
}

export function assertArchiveManifest(zipPath) {
    const entries = listZipFiles(zipPath);
    for (const entry of entries) {
        if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry) || entry.split('/').includes('..')) {
            throw new Error(`Unsafe archive entry: ${entry}`);
        }
    }
    const sorted = [...entries].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(EXPECTED_ARCHIVE_FILES)) {
        throw new Error(`Baseline archive manifest mismatch. Expected ${EXPECTED_ARCHIVE_FILES.length} exact files; got ${sorted.length}: ${sorted.join(', ')}`);
    }
    return sorted;
}

function hashTree(root, relativeFiles = EXPECTED_ARCHIVE_FILES) {
    return Object.fromEntries(relativeFiles.map((relativePath) => {
        const file = path.join(root, ...relativePath.split('/'));
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            throw new Error(`Expected extracted archive file is missing: ${relativePath}`);
        }
        return [relativePath, sha256File(file)];
    }));
}

function assertSyntax(file) {
    const checked = spawnSync(process.execPath, ['--check', nodePath(file)], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
    });
    if (checked.status !== 0) {
        throw new Error(`${path.basename(file)} failed syntax validation:\n${checked.stderr || checked.stdout}`);
    }
}

function powershellLiteral(value) {
    return `'${String(value).replaceAll("'", "''")}'`;
}

function createZip(stageRoot, zipPath) {
    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    if (fs.existsSync(zipPath)) throw new Error(`Refusing to overwrite an existing relay package: ${zipPath}`);
    const temporaryZip = path.join(
        path.dirname(zipPath),
        `.${path.basename(zipPath)}.${process.pid}.${Date.now()}.tmp.zip`
    );
    try {
        const command = [
            "$ErrorActionPreference = 'Stop'",
            `Compress-Archive -Path (Join-Path ${powershellLiteral(stageRoot)} '*') -DestinationPath ${powershellLiteral(temporaryZip)} -CompressionLevel Optimal -Force`
        ].join('; ');
        execFileSync('powershell.exe', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            command
        ], { stdio: 'pipe', windowsHide: true });
        if (!fs.existsSync(temporaryZip) || fs.statSync(temporaryZip).size === 0) {
            throw new Error('Compress-Archive did not produce a non-empty relay ZIP.');
        }
        fs.renameSync(temporaryZip, zipPath);
    } finally {
        fs.rmSync(temporaryZip, { force: true });
    }
}

function copyDist(stageRoot, distRoot) {
    if (!distRoot) return '';
    if (fs.existsSync(distRoot)) throw new Error(`Refusing to overwrite an existing --dist path: ${distRoot}`);
    fs.mkdirSync(path.dirname(distRoot), { recursive: true });
    fs.cpSync(stageRoot, distRoot, { recursive: true, errorOnExist: true, force: false });
    return distRoot;
}

export function buildMigrationRelay(options) {
    const base = path.resolve(options.base);
    if (!fs.existsSync(base) || !fs.statSync(base).isFile()) {
        throw new Error(`Baseline ZIP does not exist: ${base}`);
    }
    const baseSha256 = sha256File(base);
    if (baseSha256 !== BASE_ZIP_SHA256) {
        throw new Error(`Baseline ZIP SHA-256 mismatch. Expected ${BASE_ZIP_SHA256}; got ${baseSha256}. Refusing to build.`);
    }
    const archiveFiles = assertArchiveManifest(base);
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rph-mogai-relay-build-'));
    const stageRoot = path.join(runtimeRoot, 'stage');
    fs.mkdirSync(stageRoot);
    try {
        execFileSync(systemTar(), ['-xf', nodePath(base), '-C', nodePath(stageRoot)], {
            stdio: 'pipe',
            windowsHide: true
        });
        const beforeHashes = hashTree(stageRoot, archiveFiles);
        if (beforeHashes['DB/image-module.js'] !== BASE_IMAGE_MODULE_SHA256) {
            throw new Error(`Baseline image module SHA-256 mismatch. Expected ${BASE_IMAGE_MODULE_SHA256}; got ${beforeHashes['DB/image-module.js']}. Refusing to build.`);
        }

        const modulePath = path.join(stageRoot, 'DB', 'image-module.js');
        const workerPath = path.join(stageRoot, '_worker.js');
        const moduleSource = fs.readFileSync(modulePath, 'utf8');
        const patchedModule = patchImageModule(moduleSource);
        fs.writeFileSync(modulePath, patchedModule, 'utf8');
        assertSyntax(modulePath);

        const workerSource = fs.readFileSync(workerPath, 'utf8');
        const workerRewrite = rewriteImageModuleVersion(workerSource, Buffer.from(patchedModule));
        fs.writeFileSync(workerPath, workerRewrite.source, 'utf8');
        assertSyntax(workerPath);

        const afterHashes = hashTree(stageRoot, archiveFiles);
        const changedFiles = archiveFiles.filter((relativePath) => beforeHashes[relativePath] !== afterHashes[relativePath]);
        const expectedChanges = ['DB/image-module.js', '_worker.js'];
        if (JSON.stringify(changedFiles.sort()) !== JSON.stringify(expectedChanges.sort())) {
            throw new Error(`Relay build changed unexpected archive files: ${changedFiles.join(', ')}`);
        }

        const timestamp = options.timestamp || formatTimestamp();
        const releaseRoot = path.resolve(options.releaseRoot || path.join(projectRoot, 'release'));
        const zipPath = path.join(releaseRoot, `RP-Hub-R2-rebuild-v4-img-migrate-mogai-${timestamp}.zip`);
        createZip(stageRoot, zipPath);
        const outputManifest = assertArchiveManifest(zipPath);
        copyDist(stageRoot, options.dist ? path.resolve(options.dist) : '');

        return {
            ok: true,
            base,
            baseSha256,
            baseFileCount: archiveFiles.length,
            zip: zipPath,
            zipSha256: sha256File(zipPath),
            zipBytes: fs.statSync(zipPath).size,
            fileCount: outputManifest.length,
            dist: options.dist ? path.resolve(options.dist) : '',
            imageModule: {
                beforeSha256: beforeHashes['DB/image-module.js'],
                afterSha256: afterHashes['DB/image-module.js'],
                version: workerRewrite.version
            },
            workerVersionReference: {
                line: workerRewrite.line,
                before: workerRewrite.before,
                after: workerRewrite.after
            },
            changedFiles: changedFiles.sort(),
            unchangedFiles: archiveFiles.filter((relativePath) => !changedFiles.includes(relativePath)).sort(),
            beforeHashes,
            afterHashes
        };
    } finally {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
}

function main(argv = process.argv.slice(2)) {
    const options = parseArguments(argv);
    const result = buildMigrationRelay(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
