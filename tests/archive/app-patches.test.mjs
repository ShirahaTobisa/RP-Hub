import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
    APP_PATCH_MODES,
    RP_HUB_APP_PATCH_REVISION,
    RpHubAppPatchError,
    patchRpHubAppJs,
    verifyRpHubAppJs
} from '../DB/app-patches.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(testDirectory, '..', '..');
const upstreamRepository = resolve(projectDirectory, 'RP-Hub');
const generatedAppPath = resolve(testDirectory, '..', 'assets', 'js', 'app.js');
const UPSTREAM_181_OLD_COMMIT = '8fe31a6429bd933fa903aea057bda2659188e294';
const UPSTREAM_181_NEW_COMMIT = '8911f4bba41cfe3b1a092862697b99faf7716d7d';

function readUpstreamApp(reference) {
    return execFileSync(
        'git',
        ['-C', upstreamRepository, 'cat-file', 'blob', `${reference}:assets/js/app.js`],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
    );
}

function normalizeEol(text) {
    return text.replace(/\r\n/g, '\n');
}

const expectedBridge = `const flushPersistenceForRpSync = async () => {
    if (!_initComplete) throw new Error('RP-Hub 数据仍在初始化，请稍后再同步或切换版本');
    if (isConversationBusy?.value) throw new Error('对话仍在生成，请等待生成结束后再同步或切换版本');
    const saved = await saveData();
    const chatSaved = await flushPendingChatHistorySave();
    if (saved === false) throw new Error('RP-Hub 数据保存失败，已取消同步或版本切换');
    if (chatSaved === false) throw new Error('聊天记录保存失败，已取消同步或版本切换');
    return true;
};
globalThis.RPH_R2_FLUSH_PERSISTENCE = flushPersistenceForRpSync;`;
const expectedIndentedBridge = expectedBridge
    .split('\n')
    .map((line) => `        ${line}`)
    .join('\n');
const dbSetToDeferMarker = 'return deferWrite(() => dbSetTo(targetDb, key, deferredValue, { clone: false }));';
const dbDeleteFromDeferMarker = 'return deferWrite(() => dbDeleteFrom(targetDb, key));';
const supportedFixtures = [
    ['1.7.3', '1.7.3', '1.7.3', 4],
    ['1.7.4', '1.7.4', '1.7.4', 6],
    ['1.7.5', '1.7.5', '1.7.5', 6],
    ['1.7.6', '1.7.6', '1.7.6', 6],
    ['1.7.7', '1.7.7', '1.7.7', 5],
    ['1.7.8', '1.7.8', '1.7.8', 6],
    ['1.7.9', '1.7.9', '1.7.9', 10],
    ['1.8.0', '1.8.0', '1.8.0', 10],
    ['1.8.1 old 8fe31a6', UPSTREAM_181_OLD_COMMIT, '1.8.1', 10],
    ['1.8.1 new 8911f4b', UPSTREAM_181_NEW_COMMIT, '1.8.1', 1]
];

for (const [label, reference, version] of supportedFixtures) {
    test(`patches upstream ${label} and preserves valid JavaScript`, () => {
        const source = readUpstreamApp(reference);
        const { code, report } = patchRpHubAppJs(source, { version });
        const storageExternalized = version === '1.8.1';
        const expectedGateCount = storageExternalized ? 0 : 1;

        assert.ok(report.replacements.characterSave >= 1);
        assert.ok(report.replacements.characterLoad >= 1);
        assert.equal(report.replacements.persistenceBridge, 1);
        assert.equal(report.revision, RP_HUB_APP_PATCH_REVISION);
        assert.equal(report.revision, 'r2-character-split-e2b-v3');
        assert.equal(report.storageExternalized, storageExternalized);
        assert.deepEqual(report.pullRestoreWriteGates, {
            dbSetTo: expectedGateCount,
            dbDeleteFrom: expectedGateCount
        });
        assert.deepEqual(report.invariants, {
            residualCharacterSave: 0,
            residualCharacterLoad: 0,
            flushBridgeMarker: 1,
            executableCharacterSave: report.replacements.characterSave,
            executableCharacterLoad: report.replacements.characterLoad,
            executablePersistenceBridge: 1,
            persistenceReturnSemantics: 1,
            pullRestoreDbSetGate: expectedGateCount,
            pullRestoreDbDeleteGate: expectedGateCount
        });
        assert.equal(report.persistenceHardening.flush, 1);
        assert.equal(report.persistenceHardening.saveData, 1);
        assert.match(code, /const chatSaved = await saveChatHistoryNow\(\);/);
        assert.match(code, /return true;\s*\} catch \(e\) \{\s*console\.error\('Save failed:', e\);/);
        assert.match(code, /console\.error\('Save failed:', e\);[\s\S]*?return false;/);
        assert.match(code, /return await (?:saveChatHistoryNow\(\)|chatHistorySaveQueue);/);
        assert.ok(normalizeEol(code).includes(expectedIndentedBridge));
        assert.equal(code.split(dbSetToDeferMarker).length - 1, expectedGateCount);
        assert.equal(code.split(dbDeleteFromDeferMarker).length - 1, expectedGateCount);
        assert.doesNotThrow(() => new vm.Script(code, { filename: `app-${label.replaceAll(' ', '-')}.js` }));
        assert.equal(verifyRpHubAppJs(code, report.replacements).valid, true);
    });
}

test('known upstream storage hook counts remain stable', () => {
    for (const [label, reference, version, saveCount] of supportedFixtures) {
        const { report } = patchRpHubAppJs(readUpstreamApp(reference), { version });
        assert.equal(report.replacements.characterSave, saveCount, label);
        assert.equal(report.replacements.characterLoad, 1, label);
    }
});

test('1.7.3 through 1.8.0 patched bytes match the pre-change SHA-256 baseline', () => {
    const baselineHashes = {
        '1.7.3': '313D73F33D4668A31EDB017B9E4874CB28C4BA29C765FB39327EFD67AC68DA9B',
        '1.7.4': 'AE68214D75FF6909B90E0E5DBFEEAB5AFB5F0CF1244FC5C524CCF5B5895FEE4F',
        '1.7.5': '1531FD9E563517F642B57AB5CC9C821796753F813EF244370402CE772AA47B0C',
        '1.7.6': '761C95276662D6C659ED2AA6026E992CF0CA26E2929C7B12C12C0DB9F70E309A',
        '1.7.7': '52ABAB9BF80C12DEF0A0FC7CED4E6926BEC0CBC8741967A2C29DAA5239E725E2',
        '1.7.8': '86EDED9C346ABF6757B39D4B4E0A262F2D85468843348CD478A8567BE22A854D',
        '1.7.9': 'B5A1295F8DD6BCACCF3B3DE284BEA065846333772BCDAF44FD42881E6020D7C7',
        '1.8.0': 'D535D0FED09F22D9F5DA67DCCDC1E17515AA11A4754482CFBCD22AA5A3E3E20C'
    };
    for (const [tag, expectedHash] of Object.entries(baselineHashes)) {
        const code = patchRpHubAppJs(readUpstreamApp(tag), { version: tag }).code;
        const actualHash = createHash('sha256').update(Buffer.from(code, 'utf8')).digest('hex').toUpperCase();
        assert.equal(actualHash, expectedHash, tag);
    }
});

test('old 1.8.1 commit patched bytes match the accepted output exactly', () => {
    const { code, report } = patchRpHubAppJs(readUpstreamApp(UPSTREAM_181_OLD_COMMIT), { version: '1.8.1' });
    const bytes = Buffer.from(code, 'utf8');

    assert.equal(bytes.byteLength, 465358);
    assert.equal(
        createHash('sha256').update(bytes).digest('hex').toUpperCase(),
        '2217C07B3B1A85DCEFC2FB00D584B48FCAF8B0E65B6C45F995B5C3518376397A'
    );
    assert.deepEqual(report.replacements, {
        characterSave: 10,
        characterLoad: 1,
        persistenceBridge: 1
    });
    assert.deepEqual(report.pullRestoreWriteGates, { dbSetTo: 0, dbDeleteFrom: 0 });
    assert.equal(report.storageExternalized, true);
    assert.equal(report.revision, 'r2-character-split-e2b-v3');
});

test('retagged 1.8.1 commit patched bytes match the accepted output exactly', () => {
    const { code, report } = patchRpHubAppJs(readUpstreamApp(UPSTREAM_181_NEW_COMMIT), { version: '1.8.1' });
    const bytes = Buffer.from(code, 'utf8');

    assert.equal(bytes.byteLength, 467646);
    assert.equal(
        createHash('sha256').update(bytes).digest('hex').toUpperCase(),
        '948C6560DE09E4CAD27BE091B812E241F56F30E53D0618561057E23E3C9750FE'
    );
    assert.deepEqual(report.replacements, {
        characterSave: 1,
        characterLoad: 1,
        persistenceBridge: 1
    });
    assert.match(code, /await window\.RPHubCharStore\.saveAll\(unwrapForStorage\(characters\.value\)\)/);
    assert.deepEqual(report.pullRestoreWriteGates, { dbSetTo: 0, dbDeleteFrom: 0 });
    assert.equal(report.storageExternalized, true);
    assert.equal(report.revision, 'r2-character-split-e2b-v3');
});

test('character save anchor accepts only the two approved value shapes', () => {
    const matches = (source) => [...source.matchAll(new RegExp(
        APP_PATCH_MODES.characterSave.source,
        APP_PATCH_MODES.characterSave.flags
    ))];
    const oldShape = matches("await setStoredValue('characters', characters.value)");
    const newShape = matches("await setStoredValue('characters', unwrapForStorage(characters.value), { clone: false })");

    assert.equal(oldShape.length, 1);
    assert.equal(oldShape[0][1], 'characters.value');
    assert.equal(newShape.length, 1);
    assert.equal(newShape[0][1], 'unwrapForStorage(characters.value)');
    for (const rejected of [
        "await setStoredValue('settings', unwrapForStorage(characters.value), { clone: false })",
        "await setStoredValue('characters', outer(unwrapForStorage(characters.value)), { clone: false })",
        "await setStoredValue('characters', unwrapForStorage(characters.value), options)",
        'await setStoredValue("characters", unwrapForStorage(characters.value), { clone: false })'
    ]) {
        assert.equal(matches(rejected).length, 0, rejected);
    }
});

test('externalized storage mode is fail-closed without exactly one RPHubStorage signature', () => {
    const source = readUpstreamApp(UPSTREAM_181_NEW_COMMIT);
    const missingSignature = source.replace('} = window.RPHubStorage;', '} = window.RPHubStorageChanged;');
    const duplicateSignature = `${source}\nconst {} = window.RPHubStorage;\n`;

    for (const [version, candidate] of [
        ['1.8.1-missing-storage-signature', missingSignature],
        ['1.8.1-duplicate-storage-signature', duplicateSignature]
    ]) {
        assert.throws(
            () => patchRpHubAppJs(candidate, { version }),
            (error) => error instanceof RpHubAppPatchError
                && error.details?.stage === 'pull-restore-write-gates'
                && error.details?.reason === 'section-start'
                && error.details?.matches === 0
        );
    }
});

test('verification independently recomputes externalized storage mode from the code', () => {
    const patched = patchRpHubAppJs(readUpstreamApp(UPSTREAM_181_NEW_COMMIT), { version: '1.8.1' });
    assert.equal(verifyRpHubAppJs(patched.code, patched.report.replacements).valid, true);

    const withoutSignature = patched.code.replace(
        '} = window.RPHubStorage;',
        '} = window.RPHubStorageChanged;'
    );
    const verification = verifyRpHubAppJs(withoutSignature, patched.report.replacements);
    assert.equal(verification.valid, false);
    assert.equal(verification.invariants.pullRestoreDbSetGate, 0);
    assert.equal(verification.invariants.pullRestoreDbDeleteGate, 0);
});

test('generated app.js is exactly the shared patcher output for tag 1.7.5', () => {
    const expected = patchRpHubAppJs(readUpstreamApp('1.7.5'), { version: '1.7.5' }).code;
    const actual = readFileSync(generatedAppPath, 'utf8');
    assert.equal(actual, expected);
});

test('renamed character storage API is rejected with the adaptation message', () => {
    const source = readUpstreamApp('1.7.5').replaceAll('setStoredValue', 'writeStoredValue');
    assert.throws(
        () => patchRpHubAppJs(source, { version: '1.7.6-test' }),
        (error) => error instanceof RpHubAppPatchError
            && error.code === 'RP_HUB_APP_PATCH_REJECTED'
            && error.message === '上游 1.7.6-test 改动了角色卡存储接口，需人工适配后再更新。'
    );
});

test('a double-quoted character storage call is rejected as an unpatched residual', () => {
    const source = readUpstreamApp('1.7.5')
        .replace("setStoredValue('characters', characters.value)", 'setStoredValue("characters", characters.value)');
    assert.throws(
        () => patchRpHubAppJs(source, { version: 'quote-change-test' }),
        (error) => error instanceof RpHubAppPatchError
            && error.code === 'RP_HUB_APP_PATCH_REJECTED'
            && error.details?.stage === 'invariant-check'
            && error.details?.invariants?.residualCharacterSave === 1
    );
});

test('a storage hook found only in a comment cannot satisfy the executable-hook invariant', () => {
    const source = `${readUpstreamApp('1.7.5')
        .replaceAll("await setStoredValue('characters', characters.value)", 'await writeStoredValue(\'characters\', characters.value)')}\n// await setStoredValue('characters', characters.value)\n`;
    assert.throws(
        () => patchRpHubAppJs(source, { version: 'comment-only-test' }),
        (error) => error instanceof RpHubAppPatchError
            && error.details?.stage === 'invariant-check'
            && error.details?.invariants?.executableCharacterSave === 0
    );
});

test('a save hook found only in a block comment, string, template, or regex cannot satisfy the executable invariant', () => {
    const base = readUpstreamApp('1.7.5')
        .replaceAll("await setStoredValue('characters', characters.value)", 'await writeStoredValue(\'characters\', characters.value)');
    for (const suffix of [
        "\n/*\nawait setStoredValue('characters', characters.value)\n*/\n",
        "\nconst staleExample = \"await setStoredValue('characters', characters.value)\";\n",
        "\nconst staleTemplate = `\nawait setStoredValue('characters', characters.value)\n`;\n",
        "\nconst staleRegex = /await setStoredValue('characters', characters.value)/;\n"
    ]) {
        assert.throws(
            () => patchRpHubAppJs(`${base}${suffix}`, { version: 'non-code-hook-test' }),
            (error) => error instanceof RpHubAppPatchError
                && error.details?.stage === 'invariant-check'
                && error.details?.invariants?.executableCharacterSave === 0
        );
    }
});

test('a load hook found only in a regex cannot satisfy the executable-hook invariant', () => {
    const source = `${readUpstreamApp('1.7.5')
        .replaceAll("await getStoredValue('characters')", "await readStoredValue('characters')")}
const staleLoadRegex = /await getStoredValue('characters')/;
`;
    assert.throws(
        () => patchRpHubAppJs(source, { version: 'regex-load-test' }),
        (error) => error instanceof RpHubAppPatchError
            && error.details?.stage === 'invariant-check'
            && error.details?.invariants?.executableCharacterLoad === 0
    );
});

test('a save hook inside nested template expressions remains executable code', () => {
    const source = `${readUpstreamApp('1.7.5')}
async function nestedTemplateHook() {
    return \`prefix \${\`nested \${await setStoredValue('characters', characters.value)}\`}\`;
}
`;
    const { code, report } = patchRpHubAppJs(source, { version: 'template-expression-test' });
    assert.equal(report.replacements.characterSave, 7);
    assert.equal(report.invariants.executableCharacterSave, 7);
    assert.doesNotThrow(() => new vm.Script(code, { filename: 'template-expression-app.js' }));
});

test('a manualSave anchor found only in a block comment or template cannot satisfy the bridge invariant', () => {
    const anchor = `        const manualSave = () => {
            saveData();
            showToast('设置已保存', 'success');
        };`;
    const base = readUpstreamApp('1.7.5').replace('const manualSave = () => {', 'const manualSave = async () => {');
    for (const suffix of [
        `\n/*\n${anchor}\n*/\n`,
        `\nconst staleBridge = \`\n${anchor}\n\`;\n`
    ]) {
        assert.throws(
            () => patchRpHubAppJs(`${base}${suffix}`, { version: 'non-code-bridge-test' }),
            (error) => error instanceof RpHubAppPatchError
                && error.details?.stage === 'invariant-check'
                && error.details?.invariants?.executablePersistenceBridge === 0
        );
    }
});

test('changed manualSave anchor is rejected and an already patched file is not patched twice', () => {
    const source = readUpstreamApp('1.7.5');
    const changedAnchor = source.replace('const manualSave = () => {', 'const manualSave = async () => {');
    assert.throws(
        () => patchRpHubAppJs(changedAnchor, { version: 'anchor-test' }),
        RpHubAppPatchError
    );

    const once = patchRpHubAppJs(source, { version: '1.7.5' }).code;
    assert.throws(
        () => patchRpHubAppJs(once, { version: '1.7.5' }),
        RpHubAppPatchError
    );
});

test('renamed saveConversationMutationNow anchor is rejected', () => {
    const source = readUpstreamApp('1.7.7')
        .replaceAll('saveConversationMutationNow', 'saveConversationMutationSoon');
    assert.throws(
        () => patchRpHubAppJs(source, { version: '1.7.7-renamed-anchor' }),
        RpHubAppPatchError
    );
});

test('manualSave substring blocks the modern bridge fallback', () => {
    const source = `${readUpstreamApp('1.7.7')}\nconst manualSaveShim = 1;\n`;
    assert.throws(
        () => patchRpHubAppJs(source, { version: '1.7.7-manual-save-shim' }),
        RpHubAppPatchError
    );
});

test('an already patched 1.7.7 file is not patched twice', () => {
    const once = patchRpHubAppJs(readUpstreamApp('1.7.7'), { version: '1.7.7' }).code;
    assert.throws(
        () => patchRpHubAppJs(once, { version: '1.7.7' }),
        RpHubAppPatchError
    );
});

test('pull restore write gates are mandatory and must each occur exactly once', () => {
    const patched = patchRpHubAppJs(readUpstreamApp('1.7.5'), { version: '1.7.5' });
    const missingSetGate = patched.code.replace(dbSetToDeferMarker, 'return Promise.resolve();');
    const duplicateDeleteGate = patched.code.replace(
        dbDeleteFromDeferMarker,
        `${dbDeleteFromDeferMarker}\n                ${dbDeleteFromDeferMarker}`
    );

    const missingVerification = verifyRpHubAppJs(missingSetGate, patched.report.replacements);
    assert.equal(missingVerification.valid, false);
    assert.equal(missingVerification.invariants.pullRestoreDbSetGate, 0);

    const duplicateVerification = verifyRpHubAppJs(duplicateDeleteGate, patched.report.replacements);
    assert.equal(duplicateVerification.valid, false);
    assert.equal(duplicateVerification.invariants.pullRestoreDbDeleteGate, 0);
});
