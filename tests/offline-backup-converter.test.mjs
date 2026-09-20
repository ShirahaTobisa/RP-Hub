import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'scripts', 'convert-offline-backup.mjs');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rph-backup-converter-'));
const input = path.join(temporaryDirectory, 'backup.jsonl');
const output = path.join(temporaryDirectory, 'snapshot.json');
const jsonlOutput = path.join(temporaryDirectory, 'snapshot-v4.jsonl');

const events = [
    { type: 'snapshot', format: 'rp-sync-jsonl-v2', schemaVersion: 5 },
    { type: 'localStorage', key: 'rp_hub_setting', value: 'kept' },
    { type: 'localStorageEnd' },
    { type: 'database', name: 'RPHubDB', version: 1, stores: [{ name: 'store', keyPath: null, autoIncrement: false }] },
    { type: 'recordArrayStart', database: 'RPHubDB', store: 'store', key: 'rp_hub_characters', length: 3 },
    { type: 'recordArrayItem', database: 'RPHubDB', store: 'store', value: { uuid: 'char-a', name: 'Same name', payload: 'a' } },
    { type: 'recordArrayItem', database: 'RPHubDB', store: 'store', value: { uuid: 'char-b', name: 'Same name', payload: 'b' } },
    { type: 'recordArrayItem', database: 'RPHubDB', store: 'store', value: { name: 'Missing uuid', payload: 'c' } },
    { type: 'recordArrayEnd', database: 'RPHubDB', store: 'store' },
    { type: 'recordArrayStart', database: 'RPHubDB', store: 'store', key: 'rp_hub_chat_char-a', length: 1 },
    { type: 'recordArrayItem', database: 'RPHubDB', store: 'store', value: { role: 'assistant', content: 'kept chat' } },
    { type: 'recordArrayEnd', database: 'RPHubDB', store: 'store' },
    { type: 'record', database: 'RPHubDB', store: 'store', key: 'rp_hub_memories_char-a', value: [{ content: 'kept memory' }] },
    { type: 'storeEnd', database: 'RPHubDB', store: 'store' },
    { type: 'databaseEnd', name: 'RPHubDB' },
    { type: 'snapshotEnd', recordCount: 3 }
];
fs.writeFileSync(input, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

const converted = spawnSync(process.execPath, [script, '--input', input, '--output', output], { encoding: 'utf8' });
assert.equal(converted.status, 0, converted.stderr || converted.stdout);
const snapshot = JSON.parse(fs.readFileSync(output, 'utf8'));
assert.equal(snapshot.schemaVersion, 3);
assert.deepEqual(snapshot.localStorage, [{ key: 'rp_hub_setting', value: 'kept' }]);

const records = snapshot.indexedDB[0].stores[0].records;
assert.equal(records.some((record) => record.key === 'rp_hub_characters'), false);
const characterRecords = records.filter((record) => record.key.startsWith('rp_hub_character_') && record.key !== 'rp_hub_character_index');
assert.equal(characterRecords.length, 3);
assert.deepEqual(characterRecords.slice(0, 2).map((record) => record.value.payload), ['a', 'b']);
assert.notEqual(characterRecords[2].value.uuid, undefined);
assert.deepEqual(records.find((record) => record.key === 'rp_hub_character_index').value.order,
    characterRecords.map((record) => record.value.uuid));
assert.deepEqual(records.find((record) => record.key === 'rp_hub_chat_char-a').value,
    [{ role: 'assistant', content: 'kept chat' }]);
assert.deepEqual(records.find((record) => record.key === 'rp_hub_memories_char-a').value,
    [{ content: 'kept memory' }]);

const convertedJsonl = spawnSync(process.execPath, [
    script,
    '--input', input,
    '--output', jsonlOutput,
    '--format', 'jsonl-v4'
], { encoding: 'utf8' });
assert.equal(convertedJsonl.status, 0, convertedJsonl.stderr || convertedJsonl.stdout);
const jsonlEvents = fs.readFileSync(jsonlOutput, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));

assert.deepEqual(jsonlEvents[0], {
    type: 'snapshot',
    format: 'rp-sync-jsonl-v1',
    schemaVersion: 4
});
assert.deepEqual(jsonlEvents[1], { type: 'localStorage', key: 'rp_hub_setting', value: 'kept' });
assert.deepEqual(jsonlEvents[2], { type: 'localStorageEnd' });
assert.deepEqual(jsonlEvents[3], {
    type: 'database',
    name: 'RPHubDB',
    version: 1,
    stores: [{ name: 'store', keyPath: null, autoIncrement: false }]
});

const jsonlRecords = jsonlEvents.filter((event) => event.type === 'record');
assert.equal(jsonlRecords.some((record) => record.key === 'rp_hub_characters'), false);
const jsonlCharacterRecords = jsonlRecords.filter((record) =>
    record.key.startsWith('rp_hub_character_') && record.key !== 'rp_hub_character_index');
assert.equal(jsonlCharacterRecords.length, 3);
assert.deepEqual(jsonlCharacterRecords.slice(0, 2).map((record) => record.value.payload), ['a', 'b']);
assert.notEqual(jsonlCharacterRecords[2].value.uuid, undefined);
assert.deepEqual(
    jsonlRecords.find((record) => record.key === 'rp_hub_character_index').value.order,
    jsonlCharacterRecords.map((record) => record.value.uuid)
);

const arrayStart = jsonlEvents.find((event) => event.type === 'recordArrayStart');
const arrayItem = jsonlEvents.find((event) => event.type === 'recordArrayItem');
const arrayEnd = jsonlEvents.find((event) => event.type === 'recordArrayEnd');
assert.deepEqual(arrayStart, {
    type: 'recordArrayStart',
    database: 'RPHubDB',
    store: 'store',
    key: 'rp_hub_chat_char-a',
    length: 1
});
assert.deepEqual(arrayItem, {
    type: 'recordArrayItem',
    database: 'RPHubDB',
    store: 'store',
    index: 0,
    value: { role: 'assistant', content: 'kept chat' }
});
assert.deepEqual(arrayEnd, { type: 'recordArrayEnd', database: 'RPHubDB', store: 'store' });
assert.deepEqual(jsonlRecords.find((record) => record.key === 'rp_hub_memories_char-a').value,
    [{ content: 'kept memory' }]);
assert.deepEqual(jsonlEvents.at(-3), { type: 'storeEnd', database: 'RPHubDB', store: 'store' });
assert.deepEqual(jsonlEvents.at(-2), { type: 'databaseEnd', name: 'RPHubDB' });
assert.deepEqual(jsonlEvents.at(-1), { type: 'snapshotEnd', recordCount: 7 });

const refused = spawnSync(process.execPath, [script, '--input', input, '--output', output], { encoding: 'utf8' });
assert.notEqual(refused.status, 0);
assert.match(refused.stderr, /Refusing to overwrite existing output/);

const refusedJsonl = spawnSync(process.execPath, [
    script,
    '--input', input,
    '--output', jsonlOutput,
    '--format', 'jsonl-v4'
], { encoding: 'utf8' });
assert.notEqual(refusedJsonl.status, 0);
assert.match(refusedJsonl.stderr, /Refusing to overwrite existing output/);

fs.rmSync(temporaryDirectory, { recursive: true, force: true });
console.log('offline backup converter assertions passed');
