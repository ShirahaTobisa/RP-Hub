import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
    BASE_IMAGE_MODULE_SHA256,
    BASE_ZIP_SHA256,
    buildMigrationRelay,
    patchImageModule,
    rewriteImageModuleVersion
} from '../scripts/build-migration-relay.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');
const PROJECT_DIR = path.resolve(ROOT_DIR, '..');
const BASE_ZIP = path.join(PROJECT_DIR, 'release', 'RP-Hub-R2-rebuild-v4-img-20260901-020954.zip');
// Primary sample: mogai1 (1.8.8 base).  The 1.8.7 sample only cross-checks
// that the persisted record shape is identical across both magic bases.
const MOGAI_ROOT = 'D:/tmp/mogai1';
const MOGAI_ROOT_187 = 'D:/tmp/rph-mogai-new';
const IMAGE_SIGNATURE_KEYS = [
    'provider', 'tag', 'model', 'artist', 'size', 'steps', 'scale', 'cfg',
    'sampler', 'negative', 'nocache', 'noise_schedule'
];

function sha256(value) {
    return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function jsonBytes(value) {
    return JSON.stringify(value);
}

function loadImageModuleSource(source, filename = 'image-module.js') {
    const context = vm.createContext({
        URL,
        URLSearchParams,
        clearInterval,
        clearTimeout,
        console,
        crypto: webcrypto,
        document: {
            readyState: 'loading',
            addEventListener() { }
        },
        localStorage: {
            getItem() { return null; },
            removeItem() { },
            setItem() { }
        },
        performance: { now: () => 0 },
        setInterval,
        setTimeout,
        structuredClone,
        window: { location: { origin: 'https://relay.test' } }
    });
    vm.runInContext(source, context, { filename });
    assert.ok(context.RPHubImageModule, 'relay image module did not install its public API');
    return { api: context.RPHubImageModule, source };
}

function loadImageModule(moduleFile) {
    return loadImageModuleSource(fs.readFileSync(moduleFile, 'utf8'), moduleFile);
}

/**
 * Extract the magic client's own hashText/buildRecordKey/buildDescriptor/
 * normalizeRecord verbatim from the sample and run them in a vm.  Fixtures
 * built through these functions are byte-for-byte what the magic client's
 * normalizeRecord + saveNow would have persisted — the fixture red line.
 */
function extractMogaiNormalizer(source, label) {
    const hashMatch = source.match(/const hashText = \(value\) => \{\n[\s\S]*?\n    \};/);
    const keyMatch = source.match(/const buildRecordKey = \(descriptor = \{\}\) => \[[\s\S]*?\n        \]\.join\(':'\);/);
    const descriptorMatch = source.match(/const buildDescriptor = \(prompt, occurrenceIndex, renderContext = \{\}\) => \{\n[\s\S]*?\n        \};/);
    const normalizeMatch = source.match(/const normalizeRecord = \(record = \{\}, ownerName = activeCharacterName\) => \{\n[\s\S]*?\n        \};/);
    assert.ok(hashMatch, `${label}: hashText anchor drifted`);
    assert.ok(keyMatch, `${label}: buildRecordKey anchor drifted`);
    assert.ok(descriptorMatch, `${label}: buildDescriptor anchor drifted`);
    assert.ok(normalizeMatch, `${label}: normalizeRecord anchor drifted`);
    const context = vm.createContext({});
    vm.runInContext(
        `${hashMatch[0]}\nlet activeCharacterName = '';\n${keyMatch[0]}\n${descriptorMatch[0]}\n${normalizeMatch[0]}\n`
            + 'this.api = { hashText, buildRecordKey, buildDescriptor, normalizeRecord };',
        context
    );
    return context.api;
}

/** Mirror of the relay module's buildImageRenderRecordKey (tree DB/image-module.js). */
function nativeRecordKey(record) {
    return [
        record.messageId || 'message',
        record.contentHash || 'content',
        record.occurrenceIndex ?? 0,
        record.promptHash || ''
    ].join(':');
}

/**
 * Fixture red line, asserted on every pre-seeded record: the record must be
 * exactly what magic normalizeRecord + saveNow persists — a real 3-segment
 * storage key, no relay-only fields, no prompt/tag/characterUuid upstream
 * leftovers in the snapshot.
 */
function assertMagicPersistedShape(record, label, mogai) {
    assert.deepEqual(Object.keys(record).sort(),
        ['contentHash', 'key', 'messageId', 'messageIndex', 'occurrenceIndex', 'paramsSnapshot', 'prompt', 'promptHash'],
        `${label}: magic persisted record carries unexpected fields`);
    assert.equal(record.key, mogai.buildRecordKey(record),
        `${label}: stored key is not the real magic buildRecordKey output`);
    assert.notEqual(record.key, nativeRecordKey(record),
        `${label}: fixture key accidentally matches the native 4-segment format`);
    for (const banned of ['imageSignature', 'status', 'skipped', 'createdAt', 'updatedAt', 'rerollCount', 'transient']) {
        assert.ok(!(banned in record), `${label}: fixture carries relay-only field ${banned}`);
    }
    for (const banned of ['prompt', 'tag', 'characterUuid', 'token', 'reroll_nonce', 'upstreamParams']) {
        assert.ok(!(banned in record.paramsSnapshot), `${label}: fixture snapshot carries ${banned}`);
    }
    if (record.messageId) {
        assert.equal(record.key.split(':').length, 3, `${label}: fixture key is not 3-segment`);
    } else {
        assert.ok(record.key.startsWith(`index:${record.messageIndex}:`),
            `${label}: id-less fixture key must use the index:<messageIndex> first segment`);
    }
}

function extractBuildImageSignature(workerSource) {
    const start = workerSource.indexOf('function buildImageSignature(params) {');
    const end = workerSource.indexOf('async function buildImageLookupCandidates', start);
    assert.ok(start >= 0 && end > start, 'worker buildImageSignature anchor drifted');
    const context = vm.createContext({});
    vm.runInContext(
        `const IMAGE_SIGNATURE_KEYS = ${JSON.stringify(IMAGE_SIGNATURE_KEYS)};\n${workerSource.slice(start, end)}\nthis.fn = buildImageSignature;`,
        context
    );
    return context.fn;
}

function canonical(api, record, ownerUuid) {
    return JSON.parse(JSON.stringify(api.normalizeImageRenderRecord(record, ownerUuid)));
}

function sampleRenderUrl(paramsSnapshot, prompt) {
    const params = new URLSearchParams();
    for (const key of IMAGE_SIGNATURE_KEYS) {
        params.set(key, key === 'tag' ? String(prompt || '').slice(0, 2000) : String(paramsSnapshot[key] || ''));
    }
    if (paramsSnapshot.rerollNonce) params.set('reroll_nonce', String(paramsSnapshot.rerollNonce));
    params.set('character_name', String(paramsSnapshot.characterName || '未命名角色'));
    return `/api/rp-image?${params.toString()}`;
}

assert.equal(sha256(fs.readFileSync(BASE_ZIP)), BASE_ZIP_SHA256, 'baseline ZIP SHA-256 drifted');
assert.ok(fs.existsSync(path.join(MOGAI_ROOT, 'assets/js/image-assets.js')), 'new magic sample is missing');
assert.ok(fs.existsSync(path.join(MOGAI_ROOT_187, 'assets/js/image-assets.js')), '1.8.7 magic sample is missing');
const mogaiImageSource = fs.readFileSync(path.join(MOGAI_ROOT, 'assets/js/image-assets.js'), 'utf8');
const mogaiImageSource187 = fs.readFileSync(path.join(MOGAI_ROOT_187, 'assets/js/image-assets.js'), 'utf8');
const mogaiWorkerSource = fs.readFileSync(path.join(MOGAI_ROOT, '_worker.js'), 'utf8');
for (const [label, source] of [['1.8.8', mogaiImageSource], ['1.8.7', mogaiImageSource187]]) {
    assert.match(source, /delete paramsSnapshot\.prompt;\s*delete paramsSnapshot\.tag;/,
        `${label} magic normalizeRecord no longer removes prompt/tag from its snapshot`);
    assert.match(source, /delete paramsSnapshot\.characterUuid;/,
        `${label} magic normalizeRecord no longer removes characterUuid from its snapshot`);
    assert.match(source, /key === 'tag' \? String\(record\.prompt \|\| ''\)\.slice\(0, 2000\)/,
        `${label} magic render URL no longer reconstructs tag from record.prompt`);
    assert.match(source, /rerollNonce/, `${label} magic sample no longer carries rerollNonce`);
}
const mogai = extractMogaiNormalizer(mogaiImageSource, '1.8.8');
const mogai187 = extractMogaiNormalizer(mogaiImageSource187, '1.8.7');
assert.equal(mogai.buildRecordKey({ messageId: 'm', messageIndex: 2, contentHash: 'c', occurrenceIndex: 1, promptHash: 'p' }),
    'm:1:p', 'magic buildRecordKey is not the 3-segment messageId:occurrenceIndex:promptHash');
assert.equal(mogai.buildRecordKey({ messageId: '', messageIndex: 2, contentHash: 'c', occurrenceIndex: 1, promptHash: 'p' }),
    'index:2:1:p', 'id-less magic buildRecordKey does not use the index:<messageIndex> first segment');
for (const probe of [
    { messageId: 'm', messageIndex: 2, contentHash: 'c', occurrenceIndex: 1, promptHash: 'p' },
    { messageId: '', messageIndex: 2, contentHash: 'c', occurrenceIndex: 1, promptHash: 'p' }
]) {
    assert.equal(mogai187.buildRecordKey(probe), mogai.buildRecordKey(probe),
        '1.8.7 and 1.8.8 magic buildRecordKey disagree');
    assert.equal(mogai187.hashText('silver hair'), mogai.hashText('silver hair'),
        '1.8.7 and 1.8.8 magic hashText disagree');
}

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rph-mogai-relay-unit-'));
try {
    const tamperedBase = path.join(runtimeRoot, 'tampered-base.zip');
    const tamperedBytes = fs.readFileSync(BASE_ZIP);
    tamperedBytes[tamperedBytes.length - 1] ^= 0x01;
    fs.writeFileSync(tamperedBase, tamperedBytes);
    assert.throws(
        () => buildMigrationRelay({
            base: tamperedBase,
            releaseRoot: path.join(runtimeRoot, 'tampered-release'),
            timestamp: '20990101-000000'
        }),
        /Baseline ZIP SHA-256 mismatch.*Refusing to build/,
        'tampered baseline ZIP was not rejected'
    );

    const result = buildMigrationRelay({
        base: BASE_ZIP,
        dist: path.join(runtimeRoot, 'relay-dist'),
        releaseRoot: path.join(runtimeRoot, 'release'),
        timestamp: '20990101-010101'
    });
    assert.equal(result.ok, true);
    assert.equal(result.baseSha256, BASE_ZIP_SHA256);
    assert.equal(result.baseFileCount, 15);
    assert.equal(result.fileCount, 15);
    assert.equal(result.imageModule.beforeSha256, BASE_IMAGE_MODULE_SHA256);
    assert.deepEqual(result.changedFiles, ['DB/image-module.js', '_worker.js']);
    assert.equal(result.unchangedFiles.length, 13);
    assert.equal(result.imageModule.afterSha256.slice(0, 12).toLowerCase(), result.imageModule.version);
    assert.equal(result.workerVersionReference.after, `/DB/image-module.js?v=${result.imageModule.version}`);
    assert.equal(sha256(fs.readFileSync(result.zip)), result.zipSha256);
    for (const relativePath of result.unchangedFiles) {
        assert.equal(result.afterHashes[relativePath], result.beforeHashes[relativePath], `${relativePath} changed`);
    }

    const relayModuleFile = path.join(result.dist, 'DB', 'image-module.js');
    const relayWorkerFile = path.join(result.dist, '_worker.js');
    const { api, source: relayModuleSource } = loadImageModule(relayModuleFile);
    const relayWorkerSource = fs.readFileSync(relayWorkerFile, 'utf8');
    assert.match(relayModuleSource,
        /const mogaiShapedRecord = !paramsSnapshot\.tag && !paramsSnapshot\.prompt && !paramsSnapshot\.upstreamParams\s*\n\s*&& paramsSnapshot\.source !== 'upstream' && prompt;/,
        'v3 single-field backfill guard is missing');
    assert.match(relayModuleSource, /if \(mogaiShapedRecord\) \{\s*\n\s*paramsSnapshot\.tag = prompt\.slice\(0, 2000\);/);
    assert.match(relayModuleSource,
        /normalized\.key = mogaiShapedRecord\s*\n\s*\? buildImageRenderRecordKey\(normalized\)\s*\n\s*: normalized\.key \|\| buildImageRenderRecordKey\(normalized\);/,
        'v3 magic record key recompute is missing');
    assert.match(relayModuleSource, /async function convertAllImageRecordBuckets\(\) \{/,
        'v3 full bucket sweep definition is missing');
    assert.match(relayModuleSource,
        /scheduleFullScan\(0\);\s*\n\s*convertAllImageRecordBuckets\(\)\.catch/,
        'v3 full bucket sweep is not scheduled at module initialization');
    assert.match(relayModuleSource, /JSON\.stringify\(value\) !== JSON\.stringify\(records\)/,
        'normalized record persistence bridge is missing');
    assert.doesNotMatch(relayModuleSource, /IMAGE_AUTO_ENTRY_MIGRATION_KEY|migrateNativeAutoImageEntry|buildNativeAutoImagePrompt/,
        'retired world-info seeding logic leaked into the relay');

    const ownerUuid = 'face0000-0000-4000-8000-000000000001';
    const ownerName = '魔改迁移角色';
    const prompt = 'silver hair, blue eyes, moonlit library';
    const magicSnapshot = {
        provider: 'std',
        model: 'nai-diffusion-4-5-full',
        artist: 'artist:test',
        size: '竖图',
        steps: '40',
        scale: '6',
        cfg: '0',
        sampler: 'k_dpmpp_2m_sde',
        negative: 'bad anatomy',
        nocache: '0',
        rerollNonce: '',
        noise_schedule: 'karras',
        characterName: ownerName
    };

    // Persisted fixtures are produced by the magic client's own extracted
    // buildDescriptor + normalizeRecord — never hand-assembled.
    function mogaiPersistedRecord({ message, prompt: recordPrompt, occurrenceIndex = 0, paramsSnapshot }) {
        const descriptor = mogai.buildDescriptor(recordPrompt, occurrenceIndex, {
            message,
            index: message?.index ?? null
        });
        return mogai.normalizeRecord({ ...descriptor, paramsSnapshot }, ownerName);
    }

    const axisCases = [
        ['messageId, no rerollNonce', {
            message: { id: 'mogai-msg-1', index: 1, content: `image###${prompt}###` },
            prompt,
            paramsSnapshot: { ...magicSnapshot }
        }],
        ['messageId + rerollNonce', {
            message: { id: 'mogai-msg-2', index: 2, content: `image###${prompt}### and more` },
            prompt: `${prompt} and more`,
            paramsSnapshot: { ...magicSnapshot, nocache: '1', rerollNonce: 'nonce-from-mogai' }
        }],
        ['no messageId, no rerollNonce', {
            message: { id: '', index: 3, content: `image###${prompt}###` },
            prompt,
            paramsSnapshot: { ...magicSnapshot }
        }],
        ['no messageId + rerollNonce', {
            message: { id: '', index: 4, content: `image###${prompt}### revisited` },
            prompt: `${prompt} revisited`,
            paramsSnapshot: { ...magicSnapshot, nocache: '1', rerollNonce: 'nonce-mogai-2' }
        }]
    ];
    const migratedByLabel = {};
    for (const [label, input] of axisCases) {
        const fixture = mogaiPersistedRecord(input);
        assertMagicPersistedShape(fixture, label, mogai);
        const migrated = canonical(api, fixture, ownerUuid);
        migratedByLabel[label] = migrated;
        assert.equal(migrated.prompt, input.prompt, `${label}: prompt lost`);
        assert.equal(migrated.paramsSnapshot.tag, input.prompt, `${label}: tag was not backfilled`);
        assert.equal(migrated.paramsSnapshot.prompt, undefined, `${label}: snapshot gained prompt`);
        assert.equal(migrated.paramsSnapshot.characterUuid, ownerUuid, `${label}: owner uuid not backfilled`);
        assert.equal(migrated.paramsSnapshot.characterName, ownerName, `${label}: character name lost`);
        assert.equal(migrated.key, nativeRecordKey(fixture),
            `${label}: stored key was not recomputed to the native 4-segment key`);
        assert.equal(migrated.key.split(':').length, 4, `${label}: recomputed key is not 4-segment`);
        assert.notEqual(migrated.key, fixture.key, `${label}: magic 3-segment key survived conversion`);
        assert.equal(migrated.imageSignature, api.buildImageRenderSignature(migrated.paramsSnapshot),
            `${label}: signature was not rebuilt`);
        assert.equal(migrated.paramsSnapshot.rerollNonce, fixture.paramsSnapshot.rerollNonce,
            `${label}: rerollNonce changed`);
        assert.equal(jsonBytes(canonical(api, migrated, ownerUuid)), jsonBytes(migrated),
            `${label}: second normalize changed an already converted record`);
    }
    const migrated = migratedByLabel['messageId, no rerollNonce'];
    const migratedUrl = new URL(api.buildImageRenderUrl(migrated.paramsSnapshot), 'https://relay.test');
    assert.equal(migratedUrl.searchParams.get('tag'), prompt);
    assert.equal(migratedUrl.searchParams.get('character_id'), ownerUuid);
    const rerollMigrated = migratedByLabel['messageId + rerollNonce'];
    const rerollUrl = new URL(api.buildImageRenderUrl(rerollMigrated.paramsSnapshot), 'https://relay.test');
    assert.equal(rerollUrl.searchParams.get('reroll_nonce'), 'nonce-from-mogai');

    // An old-lineage magic record that somehow already carries a native
    // 4-segment key recomputes to the same value — harmless by design.
    const lineageFixture = mogaiPersistedRecord(axisCases[0][1]);
    lineageFixture.key = nativeRecordKey(lineageFixture);
    const lineageMigrated = canonical(api, lineageFixture, ownerUuid);
    assert.equal(lineageMigrated.key, lineageFixture.key, 'old-lineage 4-segment key changed under recompute');
    assert.equal(lineageMigrated.paramsSnapshot.tag, prompt);

    const empty = canonical(api, { paramsSnapshot: { provider: 'std' }, imageSignature: '' }, ownerUuid);
    assert.equal(empty.prompt, '');
    assert.equal(empty.paramsSnapshot.tag, undefined);
    assert.equal(empty.imageSignature, '');

    const producedKey = nativeRecordKey({
        messageId: 'relay-message',
        contentHash: 'relay-content',
        occurrenceIndex: 0,
        promptHash: 'relay-prompt'
    });
    const producedBase = {
        key: producedKey,
        messageId: 'relay-message',
        messageIndex: 1,
        contentHash: 'relay-content',
        occurrenceIndex: 0,
        prompt,
        promptHash: 'relay-prompt'
    };
    const producedCases = [
        ['rendered', {
            ...producedBase,
            imageSignature: 'rendered-signature',
            paramsSnapshot: { ...magicSnapshot, prompt, tag: prompt, characterUuid: ownerUuid },
            status: 'rendered',
            createdAt: 1700000000010,
            updatedAt: 1700000000010,
            rerollCount: 0
        }],
        ['skipped', {
            ...producedBase,
            imageSignature: '',
            skipped: true,
            paramsSnapshot: { ...magicSnapshot, prompt, tag: prompt, characterUuid: ownerUuid },
            createdAt: 1700000000020,
            updatedAt: 1700000000020
        }],
        ['upstream', {
            ...producedBase,
            imageSignature: 'upstream-signature',
            paramsSnapshot: {
                ...magicSnapshot,
                prompt,
                tag: prompt,
                source: 'upstream',
                characterUuid: ownerUuid,
                upstreamParams: { provider: 'std', tag: prompt, model: 'nai-diffusion-4-5-full' },
                upstreamSourceSignature: 'upstream-source'
            },
            createdAt: 1700000000030,
            updatedAt: 1700000000030
        }]
    ];
    for (const [label, input] of producedCases) {
        const first = canonical(api, input, ownerUuid);
        const second = canonical(api, first, ownerUuid);
        assert.equal(jsonBytes(second), jsonBytes(first), `${label} record changed under relay normalization`);
        assert.equal(first.key, producedKey, `${label} self-produced record key was touched`);
    }
    const taggedWithoutSignature = canonical(api, {
        ...producedBase,
        imageSignature: '',
        paramsSnapshot: { ...magicSnapshot, tag: prompt, prompt: '' },
        createdAt: 1700000000040,
        updatedAt: 1700000000040
    }, ownerUuid);
    assert.equal(taggedWithoutSignature.imageSignature, '', 'non-migrated tagged record gained a signature');
    assert.equal(taggedWithoutSignature.key, producedKey, 'non-migrated tagged record key was touched');

    // Fixture teeth: the very same fixture fed to a 141800-style conversion
    // (tag backfill WITHOUT the key recompute) must fail this suite's key
    // assertion.  Synthesize that legacy module by reverting only the v3
    // key-recompute hunk on the relay source.
    const legacyModuleSource = relayModuleSource.replace(
        '        normalized.key = mogaiShapedRecord\n            ? buildImageRenderRecordKey(normalized)\n            : normalized.key || buildImageRenderRecordKey(normalized);',
        '        normalized.key = normalized.key || buildImageRenderRecordKey(normalized);'
    );
    assert.notEqual(legacyModuleSource, relayModuleSource, 'legacy key-recompute revert anchor drifted');
    const { api: legacyApi } = loadImageModuleSource(legacyModuleSource, 'legacy-141800-style-image-module.js');
    const teethFixture = mogaiPersistedRecord(axisCases[0][1]);
    assertMagicPersistedShape(teethFixture, 'teeth', mogai);
    const legacyMigrated = canonical(legacyApi, teethFixture, ownerUuid);
    assert.equal(legacyMigrated.paramsSnapshot.tag, prompt, 'legacy conversion lost the tag backfill');
    assert.equal(legacyMigrated.key, teethFixture.key,
        'legacy conversion unexpectedly recomputed the key');
    assert.throws(
        () => assert.equal(legacyMigrated.key, nativeRecordKey(legacyMigrated)),
        /AssertionError/,
        '141800-style conversion passed the v3 key assertion — the fixture has no teeth'
    );

    // The checksum is produced by the worker from exactly the 12 signature
    // keys plus reroll_nonce; character attribution is deliberately absent.
    const relayBuildSignature = extractBuildImageSignature(relayWorkerSource);
    const mogaiBuildSignature = extractBuildImageSignature(mogaiWorkerSource);
    const relayParams = Object.fromEntries(IMAGE_SIGNATURE_KEYS.map((key) => [
        key, migrated.paramsSnapshot[key] || ''
    ]));
    relayParams.reroll_nonce = migrated.paramsSnapshot.rerollNonce || '';
    const mogaiSignatureJson = mogaiBuildSignature(relayParams);
    const relaySignatureJson = relayBuildSignature({
        ...relayParams,
        character_id: ownerUuid,
        character_name: ownerName
    });
    assert.equal(relaySignatureJson, mogaiSignatureJson, 'worker signature JSON differs from magic worker');
    assert.equal(sha256(relaySignatureJson), sha256(mogaiSignatureJson), 'R2 checksum differs across workers');
    const magicUrl = new URL(sampleRenderUrl(migrated.paramsSnapshot, prompt), 'https://relay.test');
    for (const key of IMAGE_SIGNATURE_KEYS) {
        assert.equal(migratedUrl.searchParams.get(key), magicUrl.searchParams.get(key), `${key} URL value differs`);
    }
    assert.equal(migratedUrl.searchParams.get('reroll_nonce'), magicUrl.searchParams.get('reroll_nonce'));
    assert.equal(mogaiSignatureJson.includes(ownerUuid), false, 'character_id entered the checksum');

    const baselineModule = fs.readFileSync(path.join(runtimeRoot, 'relay-dist', 'DB', 'image-module.js'), 'utf8')
        .replace("        const prompt = String(record.prompt || paramsSnapshot.prompt || paramsSnapshot.tag || '');\n", '');
    assert.throws(
        () => patchImageModule(baselineModule),
        /expected exactly once; found 0/i,
        'patch anchor drift did not fail closed'
    );
    const pristineModuleFile = path.join(ROOT_DIR, 'DB', 'image-module.js');
    assert.equal(sha256(fs.readFileSync(pristineModuleFile)), '249632CA94EB6034A1A0A665DC1F21BFA0A4D798A29EE4217440627DB3804085',
        'tree image-module drifted from the baseline module');
    const pristineModule = fs.readFileSync(pristineModuleFile, 'utf8');
    assert.throws(
        () => patchImageModule(pristineModule.replace(
            '        normalized.key = normalized.key || buildImageRenderRecordKey(normalized);', '')),
        /magic record key recompute.*found 0/i,
        'key recompute anchor drift did not fail closed'
    );
    assert.throws(
        () => patchImageModule(pristineModule.replace('    async function initialize() {', '')),
        /full bucket sweep definition.*found 0/i,
        'bucket sweep definition anchor drift did not fail closed'
    );
    assert.throws(
        () => patchImageModule(pristineModule.replace(
            '        scheduleFullScan(0);\n    }\n\n    state.ready = new Promise((resolve) => {',
            '        scheduleFullScan(1);\n    }\n\n    state.ready = new Promise((resolve) => {')),
        /full bucket sweep invocation.*found 0/i,
        'bucket sweep invocation anchor drift did not fail closed'
    );
    assert.throws(
        () => rewriteImageModuleVersion(`${relayWorkerSource}\n/DB/image-module.js?v=duplicate`, Buffer.from(relayModuleSource)),
        /found 2/,
        'duplicate worker version anchors did not fail closed'
    );

    console.log(JSON.stringify({
        ok: true,
        baselineZipSha256: BASE_ZIP_SHA256,
        relayModuleSha256: result.imageModule.afterSha256,
        relayVersion: result.imageModule.version,
        relayZipSha256: result.zipSha256,
        changedFiles: result.changedFiles,
        fixtureAxes: axisCases.map(([label]) => label),
        keyRecompute: {
            magicKey: mogaiPersistedRecord(axisCases[0][1]).key,
            nativeKey: migrated.key,
            legacy141800Key: legacyMigrated.key
        },
        migrated: {
            tag: migrated.paramsSnapshot.tag,
            tagLength: migrated.paramsSnapshot.tag.length,
            characterUuid: migrated.paramsSnapshot.characterUuid,
            rerollNonce: rerollMigrated.paramsSnapshot.rerollNonce,
            checksum: sha256(relaySignatureJson)
        },
        zeroImpactRecords: producedCases.map(([label]) => label)
    }, null, 2));
    console.log('mogai-migration-relay.test.mjs: build, 3-segment key recompute, fixture teeth, checksum parity, idempotence, and zero-impact assertions passed');
} finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
}
