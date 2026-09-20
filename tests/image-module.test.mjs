import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const modulePath = path.join(ROOT_DIR, 'DB', 'image-module.js');
const source = fs.readFileSync(modulePath, 'utf8');
const worker = fs.readFileSync(path.join(ROOT_DIR, '_worker.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'js', 'app.js'), 'utf8');
const picsApp = fs.readFileSync(path.resolve(ROOT_DIR, '..', 'R2-rebuild-pics', 'assets', 'js', 'app.js'), 'utf8');
const upstreamRoot = path.resolve(ROOT_DIR, '..', 'RP-Hub');

const STRING_LITERAL = "((?:'(?:\\\\.|[^'\\\\])*')|(?:`(?:\\\\.|[^`\\\\])*`))";
function readLiteral(text, expression, label) {
    const match = text.match(new RegExp(expression.replace('<literal>', STRING_LITERAL)));
    assert.ok(match, `${label} literal is missing`);
    return vm.runInNewContext(`(${match[1]})`);
}

const syntax = spawnSync(process.execPath, ['--check', modulePath], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
assert.match(source, /\(\(\) => \{/);
assert.match(source, /MutationObserver/);
assert.ok(source.includes("regex: '/image###([\\\\s\\\\S]*?)###/g'"),
    'module render hook no longer recognizes image markers');
assert.match(source, /PROTECTED_TAGS/);
assert.ok(source.includes('<\\/?image'), 'legacy <image> tag stripping is missing');
assert.match(source, /rp_hub_image_renders_/);
assert.match(source, /rp_hub_character_index/);
assert.match(source, /rp_hub_character_\$\{uuid\}/);
assert.match(source, /normalizeImageRenderRecord/);
assert.match(source, /paramsSnapshot\.characterUuid \|\| ownerUuid/,
    'record normalization overwrites an existing attribution snapshot');
assert.match(source, /resolveCharacterAttribution/);
assert.match(source, /readMessageCharacterName/);
assert.match(source, /readChatHeaderCharacterName/);
assert.match(source, /readRowMembershipProbe/);
assert.match(source, /characterMatchesMembership/);
assert.match(source, /'active-character'/);
assert.match(source, /'content-membership'/);
assert.doesNotMatch(source, /source: '(?:message-name|chat-header|last-active-db)'/,
    'a name or last-active signal still assigns ownership without chat membership');
assert.match(source, /recordBuckets: new Map\(\)/);
assert.match(source, /chatBuckets: new Map\(\)/);
assert.match(source, /chatReadAtByUuid: new Map\(\)/);
assert.match(source, /const scanChatReads = new Map\(\)/);
assert.match(source, /await resolveCharacterAttribution\(row, catalog, scanReads\)/);
assert.match(source, /readCharacterCatalog\(\{ forVerdict: true \}\)/,
    'fail-closed attribution does not force-refresh the directory');
assert.match(source, /forceForVerdict: true/,
    'fail-closed attribution does not force-refresh candidate chats');
assert.match(source, /dirtyRecordOwners: new Set\(\)/);
assert.match(source, /IMAGE_RENDER_SIGNATURE_KEYS/);
assert.match(source, /const V5_UNSUPPORTED_STYLE_KEYS = new Set\(\['r18', 'lolita25d', 'anime'\]\)/,
    'v5 style blacklist drifted from upstream 1.8.6 v5UnsupportedImageStyles');
assert.match(source, /String\(settings\.imageModel \|\| ''\)/,
    'module generation no longer follows the upstream imageModel setting');
assert.match(source, /return model \|\| IMAGE_GEN_DEFAULT_MODEL/,
    'missing pre-1.8.6 fallback to the default image model');
assert.doesNotMatch(source, /model: 'nai-diffusion/,
    'module snapshot hardcodes the image model again');

{
    const configStart = source.indexOf('function getImageArtistConfig');
    const configEnd = source.indexOf('function buildImageParamsSnapshot', configStart);
    assert.ok(configStart > 0 && configEnd > configStart, 'image model helpers moved; update this probe');
    const probe = {
        state: { settings: {} },
        ARTIST_STYLES: {
            vertical: { name: '韩漫小清新风', artists: 'artist:vertical-probe' },
            r18: { name: '2.5D唯美风', artists: 'artist:r18-probe' }
        },
        DEFAULT_ARTISTS: 'artist:vertical-probe',
        IMAGE_GEN_DEFAULT_MODEL: 'nai-diffusion-4-5-full',
        IMAGE_GEN_V5_MODEL: 'nai-diffusion-5-full',
        V5_UNSUPPORTED_STYLE_KEYS: new Set(['r18', 'lolita25d', 'anime'])
    };
    vm.createContext(probe);
    vm.runInContext(
        `${source.slice(configStart, configEnd)}\nthis.__config = getImageArtistConfig;\nthis.__model = getModuleImageModel;`,
        probe
    );
    probe.state.settings = {};
    assert.equal(probe.__model(), 'nai-diffusion-4-5-full', 'missing imageModel must fall back to 4.5');
    probe.state.settings = { imageModel: 'nai-diffusion-5-full', imageStyle: 'r18' };
    assert.equal(probe.__model(), 'nai-diffusion-5-full', 'imageModel setting must be followed');
    assert.equal(probe.__config(probe.__model()).styleKey, 'vertical',
        'v5 with an unsupported style must migrate to vertical like upstream');
    assert.equal(probe.__config('nai-diffusion-4-5-full').styleKey, 'r18',
        '4.5 must keep the selected style untouched');
    probe.state.settings = { imageModel: 'nai-diffusion-5-full', imageStyle: 'galgame' };
    assert.equal(probe.__config(probe.__model()).styleKey, 'galgame',
        'v5 with a supported style must not be migrated');
}
assert.match(source, /upstreamSourceSignature/);
assert.doesNotMatch(source, /incomingSignature|attributedIncoming|const adopted = normalizeImageRenderRecord/,
    'existing records still adopt changed upstream generation parameters');
assert.match(source, /if \(existing\.status === 'skipped'\) return null;\s*return existing;/,
    'existing records are not returned as immutable snapshots');
assert.doesNotMatch(source, /clearLegacyImageKeySetting|scheduleStartupKeyCleanup|keyCleanupRetries/,
    'module still deletes or retries deletion of the native settings key');
assert.match(source, /IMAGE_GEN_KEY_ADOPTED_STORAGE_KEY/);
assert.match(source, /settingsKey !== adoptedKey/);
assert.match(source, /allowSettingsBackfill/);
assert.match(source, /function hasPendingImageScanWork/);
assert.match(source, /invalidateAttributionCaches\(reason\);\s*if \(hasPendingImageScanWork\(\)\) scheduleFullScan/);
assert.match(source, /invalidateSeedCache\(reason\);/);
assert.match(source, /x-rp-image-token/);
assert.match(source, /method: 'POST'/);
assert.match(source, /pendingRequests/);
assert.match(source, /IMAGE_THUMB_ENDPOINT/);
assert.match(source, /replacement: 'rph-image-marker###\$1###'/);
assert.match(source, /markers\.push\(`image###\$\{String\(match\[1\] \|\| ''\)\.trim\(\)\}###`\)/,
    'network-gate markers are not canonicalized for active-character attribution');
assert.match(source, /markdownOnly: true/);
assert.match(source, /promptOnly: false/);
assert.doesNotMatch(source, /function seedWorldInfo|<auto_image_gen>|核心一致性规范/,
    'retired module world-info replacement remains');
assert.doesNotMatch(source, /transient: true/,
    'freezeImageGeneration=false still bypasses record persistence');
assert.match(source, /RPH_R2_PULL_RESTORE_IN_PROGRESS === true/);
assert.match(source, /button\[title="中止生成"\]/);
assert.match(source, /\.typing-bubble/);
assert.match(source, /\.summary-timeline-card\.is-live/);
assert.match(source, /button\[title="发送"\]/);
assert.match(source, /conversation busy DOM signal unavailable; preserving non-blocking image behavior/);
assert.doesNotMatch(source, /periodic seed maintenance failed/,
    'seed fallback still starts periodic database maintenance');
assert.match(source, /RPHubImageModule/);
assert.match(source, /getPerformanceCounters/);
assert.match(source, /resetPerformanceCounters/);
assert.match(source, /reroll\.className = 'rp-image-reroll-button'/);
assert.match(source, /reroll\.dataset\.imageRenderKey = record\.key \|\| ''/);
assert.ok(source.includes('reroll.innerHTML = \'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">'),
    'module reroll button does not use the upstream 1.8.1 SVG');
assert.ok(source.includes('d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"'),
    'module reroll button SVG path drifted from upstream 1.8.1');
assert.doesNotMatch(source, /reroll\.textContent = '↻'/,
    'module reroll button still uses the hand-drawn text glyph');
assert.match(source, /async function rerollStoredImageRender\([^)]*\) \{\s*await loadSettings\(\);/,
    'explicit stored-image reroll does not refresh current settings first');
assert.match(source, /const \{ targetArtists, styleKey, styleName \} = getImageArtistConfig\(upstreamModel\);[\s\S]*upstreamParams\.artist = artist;[\s\S]*styleKey,[\s\S]*styleName,/,
    'upstream reroll does not apply the current artist snapshot');
assert.match(source, /if \(button\.disabled\) return;\s*button\.disabled = true;[\s\S]*\.finally\(\(\) => \{\s*button\.disabled = false;/,
    'module reroll button does not prevent reentry');
assert.match(source, /closest\?\.\('\.generated-image-reroll'\)/,
    'true native-card reroll compatibility branch was removed');
assert.match(source, /window\.RPHubNavAdapter\.registerEntry\(/);
assert.match(source, /id: 'images', label: '图片管理'/);
assert.doesNotMatch(source, /scheduleSidebarGuard|guardSidebarEntry|SIDEBAR_RETRY/);
assert.match(source, /state\.observer = new MutationObserver\(\(records\) => \{\s*ensurePersistenceFlushWrapped\(\);\s*maintainLiveRenderHook\(\);/,
    'DOM cycles do not restore the live render hook after upstream rebuilds');
assert.doesNotMatch(source, /attributes:\s*true|attributeFilter:/,
    'MutationObserver still subscribes to attribute churn');
assert.match(source, /collectMutationRows\(records\)/, 'MutationObserver does not locate dirty message rows');
assert.match(source, /rowWorkCache: new WeakMap\(\)/);
assert.match(source, /rowAttributionCache: new WeakMap\(\)/);
assert.match(source, /const CATALOG_CACHE_TTL_MS = 10_000/);
assert.match(source, /const SEED_CACHE_TTL_MS = 30_000/);
assert.doesNotMatch(source, /busyPoll|seedPoll|setInterval\([^)]*,\s*(?:700|2500)\s*\)/,
    'high-frequency catalog or seed polling remains');
assert.match(source,
    /IDBKeyRange\.bound\(IMAGE_RECORD_PREFIX, `\$\{IMAGE_RECORD_PREFIX\}\\uffff`\)/,
    'startup gate reads image record values instead of scanning keys only');
assert.match(source, /await startSeedSync\('initial seed sync failed', hasStoredImageRecords \? \{\} : \{ startupSettled \}\);/,
    'initial seed maintenance does not protect both cached images and first native adoption');
assert.match(source, /window\.open\('\/image', '_blank', 'noopener'\)/);
assert.doesNotMatch(source, /activateFloatingFallback|data-rph-image-toggle|data-rph-image-panel|data-rph-image-auto|togglePanel|installPanel/,
    'removed panel, floating fallback, or module auto-toggle remains');
assert.doesNotMatch(source, /sidebar-nav-button/,
    'image module hard-coded an upstream sidebar class instead of cloning the settings item');
assert.match(worker, /<script src="\/DB\/image-module\.js\?v=r2-img-1"><\/script>/);
assert.doesNotMatch(source, /setStoredValue\(/, 'module must use its own IndexedDB bridge');
assert.match(source, /ensurePersistenceFlushWrapped/);
assert.match(source, /__rphImageFlushWrapper/);
assert.match(source, /await flushRecordsWithoutBlockingSync\(\);[\s\S]*return await Reflect\.apply\(original, this, args\)/,
    'persistence wrapper does not flush first and transparently call the original bridge');
assert.match(source, /image record flush failed; sync will continue/);
assert.match(source, /if \(\(Number\(state\.recordRevisions\.get\(uuid\)\) \|\| 0\) !== revision\) return/,
    'stale queued record writes can overwrite a newer immediate flush');
assert.doesNotMatch(source, /nextEnabled = false|synchronizeLegacySeedEntries|legacySeedNeedsSync/,
    'native auto-image entries are still suppressed');
assert.match(source, /native\?\.enabled === true/,
    'auto-image state is not read from the native world-info entry');
assert.match(source, /safeLocalGet\(IMAGE_SEED_RETIREMENT_MIGRATION_KEY\) === '1'/,
    'one-time seed retirement migration guard is missing');
assert.match(source, /for \(const key of \['global_worldinfo', 'worldinfo'\]\)/,
    'migration does not clean both retired world-info locations');
assert.doesNotMatch(source, /dbPut\('rp_hub_(?:global_)?worldinfo'/,
    'normal maintenance writes world-info outside the migration loop');
assert.match(source, /无法确认图片所属角色，已拒绝生图/);
assert.match(source, /图片记录保存失败，可能影响同步/);
assert.match(source, /图片生成失败，请检查密钥或服务状态/);
assert.doesNotMatch(source, /dbPut\('rp_hub_characters'/,
    'image module must not bypass the v4 split-card store');
assert.doesNotMatch(app, /IMAGE_RENDER_ENDPOINT|rp_hub_image_renders_/,
    'upstream app.js gained an image anchor');

for (const tag of ['1.7.8', '1.8.0']) {
    const shown = spawnSync('git', ['-C', upstreamRoot, 'show', `${tag}:index.html`], { encoding: 'utf8' });
    assert.equal(shown.status, 0, shown.stderr || `unable to read upstream ${tag}`);
    assert.match(shown.stdout, /title="中止生成"/, `${tag} lost the observable stop-button signal`);
    assert.match(shown.stdout, /typing-bubble/, `${tag} lost the observable typing signal`);
    assert.match(shown.stdout, /summary-timeline-card/, `${tag} lost the observable live-timeline signal`);
    assert.match(shown.stdout, /title="发送"/, `${tag} lost the observable idle signal`);
}

const artistMappings = [
    ['default', picsApp, 'const\\s+defaultArtists\\s*=\\s*<literal>', source, 'const\\s+DEFAULT_ARTISTS\\s*=\\s*<literal>'],
    ['comicDoujin', picsApp, 'const\\s+comicDoujinArtists\\s*=\\s*<literal>', source, 'comicDoujin\\s*:\\s*\\{\\s*artists\\s*:\\s*<literal>'],
    ['r18', picsApp, 'const\\s+r18Artists\\s*=\\s*<literal>', source, 'r18\\s*:\\s*\\{\\s*artists\\s*:\\s*<literal>'],
    ['lolita25d', picsApp, 'const\\s+lolita25dArtists\\s*=\\s*<literal>', source, 'lolita25d\\s*:\\s*\\{\\s*artists\\s*:\\s*<literal>'],
    ['anime', picsApp, 'const\\s+animeArtists\\s*=\\s*<literal>', source, 'anime\\s*:\\s*\\{\\s*artists\\s*:\\s*<literal>'],
    ['galgame', picsApp, 'const\\s+galgameArtists\\s*=\\s*<literal>', source, 'galgame\\s*:\\s*\\{\\s*artists\\s*:\\s*<literal>']
];
for (const [label, expectedSource, expectedPattern, actualSource, actualPattern] of artistMappings) {
    assert.equal(
        readLiteral(actualSource, actualPattern, `overlay ${label}`),
        readLiteral(expectedSource, expectedPattern, `pics ${label}`),
        `${label} artist parameters changed from the pics generator`
    );
}

console.log('image-module.test.mjs: module contract and app black-box assertions passed');
