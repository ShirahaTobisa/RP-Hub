import assert from 'node:assert/strict';
import {
    patchRpHubCloudBackupJs, RpHubAppPatchError, RP_HUB_APP_PATCH_REVISION, RP_HUB_CLOUD_BACKUP_META_NAME
} from '../DB/app-patches.mjs';

// 上游 2.0.4 起的 cloud-backup.js：三处读整表 'characters'（一处经 storage()）、一处写，都要换成分键角色存储；
// 服务地址的 meta 改读外壳改过的名字。这里用照它写法缩写的片段，真文件在 tests/cloud-backup-restore.runner.mjs 里过。
const upstream = `(function () {
    const apiUrl = String(document.querySelector('meta[name="rphub-update-api"]')?.content || '').trim();
    const storage = () => window.RPHubStorage;
    const createBackup = async () => {
        const { getScopedStoredValue, getStoredValue } = storage();
        const characters = ((await getStoredValue('characters')) || []).filter(character => character?.uuid);
    };
    const fetchBackup = async () => {
        const local = new Map(((await storage().getStoredValue('characters')) || []).map(character => [character?.uuid, character]));
    };
    const applyBackup = async () => {
        const { getStoredValue, setStoredValue } = storage();
        const localCharacters = (await getStoredValue('characters')) || [];
        const merged = localCharacters.slice();
        await setStoredValue('characters', merged, { clone: false, force: true });
    };
})();`;

const { code, report } = patchRpHubCloudBackupJs(upstream, { version: '2.0.5' });
assert.equal(report.revision, RP_HUB_APP_PATCH_REVISION);
assert.deepEqual(report.detected, { characterLoad: 3, characterSave: 1, metaSelector: 1, residualCharacterLoad: 0, residualCharacterSave: 0 });
assert.equal(code.split('await window.RPHubCharStore.loadAll()').length - 1, 3);
assert.ok(code.includes('await window.RPHubCharStore.saveAll(merged);'));
assert.ok(code.includes(`meta[name="${RP_HUB_CLOUD_BACKUP_META_NAME}"]`));
assert.ok(!code.includes('rphub-update-api'));
assert.ok(!/StoredValue\(\s*'characters'/.test(code));
console.log('PASS cloud-backup.js reads and writes characters through the split store and reads the renamed meta');

// 上游换了写法就拒绝：漏掉任何一处都会写回旧的整表键，和分键索引并存后页面加载会停下。
const rejects = (source, label) => assert.throws(() => patchRpHubCloudBackupJs(source, { version: 'x' }), RpHubAppPatchError, label);
rejects(upstream.replace("setStoredValue('characters', merged, { clone: false, force: true })", "setStoredValue('characters', await rebuild(merged), { force: true })"), '写法变了的保存');
rejects(upstream.replace("(await storage().getStoredValue('characters'))", "(storage().getStoredValue('characters'))"), '没有 await 的读取');
rejects(upstream.replace('meta[name="rphub-update-api"]', 'meta[name="rphub-backup-api"]'), '服务地址的 meta 换了名字');
rejects(upstream.replace("await setStoredValue('characters', merged, { clone: false, force: true });", ''), '没有保存');
rejects(42, '不是字符串');
console.log('PASS cloud-backup.js patch refuses an upstream it no longer recognises');
