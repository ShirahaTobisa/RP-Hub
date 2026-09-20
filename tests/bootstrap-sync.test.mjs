import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'DB', 'bootstrap.js'), 'utf8');

assert.match(source, /maxSnapshotBytes:\s*1024 \* 1024 \* 1024/);
assert.match(source, /maxRecordBytes:\s*100 \* 1024 \* 1024/);
assert.match(source, /warnRecordBytes:\s*32 \* 1024 \* 1024/);
assert.match(source, /chunkSize:\s*2 \* 1024 \* 1024/);
assert.match(source, /uploadPartConcurrency:\s*6/);
assert.match(source, /downloadPartConcurrency:\s*3/);
assert.match(source, /jsonDownloadPartChunks:\s*8/);
assert.match(source, /const SNAPSHOT_FORMAT = 'rp-sync-jsonl-v1'/);
assert.match(source, /const SNAPSHOT_SCHEMA_VERSION = 4/);
assert.match(source, /const LEGACY_SNAPSHOT_FORMAT = 'rp-sync-json-v3'/);
assert.match(source, /const CHUNKER_PROFILE = 'rph-jsonl-cdc-fnv1a-v1'/);
assert.match(source, /record\?\.key !== 'rp_hub_characters'/);
assert.match(source, /rp_hub_character_\$\{uuid\}/);
assert.match(source, /rp_hub_character_index/);
assert.match(source, /crypto\.randomUUID\(\)/);
assert.doesNotMatch(source, /Math\.random\(\)/);
assert.match(source, /event\.preventDefault\(\)/);
assert.match(source, /tx\.onabort = \(\) => reject\(firstError/);
assert.match(source, /RPH_R2_FLUSH_PERSISTENCE !== 'function'/);
assert.doesNotMatch(source, /manualSave\(\)/);
assert.match(source, /RPHubCharStore\.assertPushAllowed\(\)/);
assert.match(source, /读取本地数据库 \$\{dbName\} 失败，已取消上传以避免云端数据缺失/);
assert.doesNotMatch(source, /console\.warn\('\[RP Sync\] Failed to read IndexedDB:/);
assert.match(source, /conflictAttempt < 4/);
assert.match(source, /expectedVersion: uploadSession\.previousVersion/);
assert.doesNotMatch(source, /status === 409 \|\| status === 429/);
assert.match(source, /action: 'app-update-check'/);
assert.match(source, /action: 'app-update-apply'/);
assert.match(source, /action: 'app-update-rollback'/);
assert.match(source, /data-action="app-update-version-button"/);
assert.match(source, /data-action="app-update-check"/);
assert.match(source, /data-action="app-update-apply"/);
assert.match(source, /data-action="app-update-rollback"/);

const pullBody = source.slice(source.indexOf('async function performPullSync()'), source.indexOf('async function performPushSync()'));
assert.doesNotMatch(pullBody, /flushAppState|RPH_R2_FLUSH_PERSISTENCE|assertPushAllowed/);
assert.match(pullBody, /location\.reload\(\)/);

const pushBody = source.slice(source.indexOf('async function performPushSync()'), source.indexOf('function attachEvents()'));
assert.ok(pushBody.indexOf('RPHubCharStore.assertPushAllowed()') < pushBody.indexOf('flushAppState()'),
    'push must reject an unpatched app before flushing it');
assert.match(source, /async function\* iterateSnapshotLines\(stats\)/);
assert.match(source, /class SnapshotChunkWriter/);
assert.match(source, /async function\* iterateSnapshotChunks\(stats, profile = 'cdc'\)/);
assert.match(source, /async function buildStreamSnapshotManifest\(\)/);
assert.match(source, /scanStreamSnapshot\('fixed'\)/);
assert.match(source, /buildStreamSnapshotChecksumSource\(snapshot\)/);
assert.match(source, /chunkManifest\.map\(\(chunk\) => \[String\(chunk\.checksum\)\.toLowerCase\(\), Number\(chunk\.length\)\]\)/);
assert.match(source, /action: 'upload-create'/);
assert.match(source, /action: 'upload-complete'/);
assert.match(source, /action: 'pull-manifest'/);
assert.match(source, /action: 'pull-json-part'/);
assert.doesNotMatch(source, /action: 'upload-check'|action: 'pull-part'/);
assert.match(source, /class StreamSnapshotValidator/);
assert.match(source, /class StreamSnapshotRestorer/);
assert.match(source, /openDownloadStagingDb\(\)/);
assert.match(source, /downloadSnapshotToStaging\(remote, chunkManifest, stagingDb, /);
assert.match(source, /else await clearDownloadStagingStore\(stagingDb\)/);
assert.match(source, /retainedChunkKeys\(chunkManifest, verified, CONFIG.downloadCacheBytes\)/);
assert.match(source, /remote\.snapshotFormat === 'rp-sync-jsonl-v2' \|\| Number\(remote\.schemaVersion\) === 5/);
assert.match(source, /downloadLegacyRemoteSnapshot\(remote\)/);
assert.doesNotMatch(source, /buildSnapshotFromData|buildStableSnapshot|RPHubSyncLargeValues/);
assert.match(source, /snapshotEncoder\.encode\(serialized\)\.byteLength/);
assert.match(source, /旧快照角色卡 UUID 重复/);

const restoreBody = source.slice(
    source.indexOf('async function restoreStreamSnapshot('),
    source.indexOf('function buildSyncHeaders(')
);
assert.ok(restoreBody.indexOf('new StreamSnapshotValidator') < restoreBody.indexOf('onRestoreStart()'),
    'v4 restore writes can start before the first validation pass');
assert.ok(restoreBody.indexOf("postSync({ action: 'pull-manifest' })") < restoreBody.indexOf('onRestoreStart()'),
    'v4 restore starts before manifest re-confirmation');

console.log('bootstrap sync focused assertions passed');
