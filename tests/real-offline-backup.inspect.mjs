import { createHash } from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';

const MAX_RECORD_BYTES = 100 * 1024 * 1024;
const CHARACTER_PREFIX = 'rp_hub_character_';
const CHARACTER_INDEX_KEY = 'rp_hub_character_index';
const LEGACY_CHARACTER_KEY = 'rp_hub_characters';
const CHAT_PREFIX = 'rp_hub_chat_';
const MEMORY_PREFIX = 'rp_hub_memories_';

function fail(code) {
    throw new Error(`Real backup inspection failed (${code}).`);
}

function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--source') options.source = argv[++index];
        else if (argv[index] === '--snapshot') options.snapshot = argv[++index];
        else fail('arguments');
    }
    if (!options.source || !options.snapshot) fail('arguments');
    return options;
}

function isAppLocalStorageKey(key) {
    return typeof key === 'string'
        && key !== 'rp_hub_sync_password_v1'
        && !key.startsWith('rp_hub_sync_')
        && key !== 'roleplay_hub_update_id'
        && (key.startsWith('rp_hub_') || key.startsWith('ai_chargen_'));
}

function isLegacyCharacterRecord(database, store, key) {
    return database === 'RPHubDB' && store === 'store' && key === LEGACY_CHARACTER_KEY;
}

function isKnownRecord(database, store) {
    return (database === 'RPHubDB' && store === 'store')
        || (database === 'AICharGen' && store === 'characters');
}

function countSourceRecord(stats, event) {
    if (!isKnownRecord(event.database, event.store)) return;
    stats.knownRecords += 1;
    if (event.database === 'AICharGen') stats.aiCharGenRecords += 1;
    if (typeof event.key === 'string' && event.key.startsWith(CHAT_PREFIX)) stats.chats += 1;
    if (typeof event.key === 'string' && event.key.startsWith(MEMORY_PREFIX)) stats.memories += 1;
}

async function inspectSource(sourcePath) {
    const stats = {
        characters: 0,
        chats: 0,
        memories: 0,
        aiCharGenRecords: 0,
        knownRecords: 0,
        legacyCharacterContainers: 0,
        localStorageRecords: 0
    };
    const input = fs.createReadStream(sourcePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let activeArray = null;
    let sawHeader = false;
    let sawEnd = false;

    for await (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            fail('source-json');
        }
        switch (event?.type) {
            case 'snapshot':
                if (sawHeader || event.format !== 'rp-sync-jsonl-v2' || Number(event.schemaVersion) !== 5) {
                    fail('source-header');
                }
                sawHeader = true;
                break;
            case 'localStorage':
                if (isAppLocalStorageKey(event.key)) stats.localStorageRecords += 1;
                break;
            case 'record':
                countSourceRecord(stats, event);
                if (isLegacyCharacterRecord(event.database, event.store, event.key)) {
                    if (!Array.isArray(event.value)) fail('source-legacy-value');
                    stats.legacyCharacterContainers += 1;
                    stats.characters += event.value.length;
                }
                break;
            case 'recordArrayStart':
                if (activeArray) fail('source-nested-array');
                countSourceRecord(stats, event);
                activeArray = {
                    legacyCharacters: isLegacyCharacterRecord(event.database, event.store, event.key),
                    expected: Number(event.length),
                    items: 0
                };
                if (activeArray.legacyCharacters) stats.legacyCharacterContainers += 1;
                break;
            case 'recordArrayItem':
                if (!activeArray) fail('source-array-item');
                activeArray.items += 1;
                break;
            case 'recordArrayEnd':
                if (!activeArray) fail('source-array-end');
                if (Number.isInteger(activeArray.expected) && activeArray.items !== activeArray.expected) {
                    fail('source-array-length');
                }
                if (activeArray.legacyCharacters) stats.characters += activeArray.items;
                activeArray = null;
                break;
            case 'snapshotEnd':
                sawEnd = true;
                break;
            default:
                break;
        }
    }
    if (!sawHeader || !sawEnd || activeArray) fail('source-incomplete');
    return stats;
}

function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

function compareDescriptor(left, right) {
    for (let index = 0; index < 3; index += 1) {
        if (left[index] < right[index]) return -1;
        if (left[index] > right[index]) return 1;
    }
    return 0;
}

function inspectSnapshot(snapshotPath, sourceStats) {
    let snapshot;
    try {
        snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    } catch {
        fail('snapshot-json');
    }
    if (Number(snapshot?.schemaVersion) !== 3
        || !Array.isArray(snapshot.localStorage)
        || !Array.isArray(snapshot.indexedDB)) {
        fail('snapshot-structure');
    }

    const descriptors = [];
    const seenStores = new Set();
    const characterUuids = new Set();
    const characterNames = new Map();
    let characterIndex = null;
    let legacyCharacters = 0;
    let characters = 0;
    let chats = 0;
    let memories = 0;
    let aiCharGenRecords = 0;
    let maxRecordBytes = 0;
    let knownRecords = 0;

    for (const database of snapshot.indexedDB) {
        if (!database || typeof database.name !== 'string' || !Array.isArray(database.stores)) {
            fail('snapshot-database');
        }
        for (const store of database.stores) {
            if (!store || typeof store.name !== 'string' || !Array.isArray(store.records)) {
                fail('snapshot-store');
            }
            if (!isKnownRecord(database.name, store.name)) continue;
            const storeToken = `${database.name}\u0000${store.name}`;
            if (seenStores.has(storeToken)) fail('snapshot-duplicate-store');
            seenStores.add(storeToken);
            const keys = new Set();

            for (const record of store.records) {
                if (!record || !Object.prototype.hasOwnProperty.call(record, 'key')) fail('snapshot-record');
                const keyToken = JSON.stringify(record.key);
                if (typeof keyToken !== 'string' || keys.has(keyToken)) fail('snapshot-duplicate-key');
                keys.add(keyToken);

                const valueJson = JSON.stringify(record.value);
                if (typeof valueJson !== 'string') fail('snapshot-value');
                const recordBytes = Buffer.byteLength(valueJson);
                maxRecordBytes = Math.max(maxRecordBytes, recordBytes);
                descriptors.push([database.name, store.name, keyToken, sha256(valueJson)]);
                knownRecords += 1;

                if (database.name === 'AICharGen' && store.name === 'characters') {
                    aiCharGenRecords += 1;
                    continue;
                }
                if (record.key === LEGACY_CHARACTER_KEY) legacyCharacters += 1;
                if (record.key === CHARACTER_INDEX_KEY) {
                    if (characterIndex) fail('snapshot-duplicate-index');
                    characterIndex = record.value;
                    continue;
                }
                if (typeof record.key === 'string' && record.key.startsWith(CHARACTER_PREFIX)) {
                    const character = record.value;
                    if (!character || typeof character !== 'object' || Array.isArray(character)
                        || typeof character.uuid !== 'string'
                        || record.key !== `${CHARACTER_PREFIX}${character.uuid}`
                        || characterUuids.has(character.uuid)) {
                        fail('snapshot-character');
                    }
                    characterUuids.add(character.uuid);
                    characters += 1;
                    if (typeof character.name === 'string') {
                        const group = characterNames.get(character.name) || [];
                        group.push(character.uuid);
                        characterNames.set(character.name, group);
                    }
                    continue;
                }
                if (typeof record.key === 'string' && record.key.startsWith(CHAT_PREFIX)) chats += 1;
                if (typeof record.key === 'string' && record.key.startsWith(MEMORY_PREFIX)) memories += 1;
            }
        }
    }

    if (legacyCharacters !== 0 || !characterIndex || !Array.isArray(characterIndex.order)) {
        fail('snapshot-character-index');
    }
    const indexSet = new Set(characterIndex.order);
    if (characterIndex.order.length !== characters || indexSet.size !== characters
        || characterUuids.size !== characters
        || [...characterUuids].some((uuid) => !indexSet.has(uuid))) {
        fail('snapshot-character-order');
    }
    let duplicateNameGroups = 0;
    for (const uuids of characterNames.values()) {
        if (uuids.length <= 1) continue;
        duplicateNameGroups += 1;
        if (new Set(uuids).size !== uuids.length) fail('snapshot-duplicate-name-uuid');
    }

    const localStorageEntries = snapshot.localStorage
        .filter((entry) => entry && isAppLocalStorageKey(entry.key))
        .map((entry) => ({ key: entry.key, value: String(entry.value ?? '') }))
        .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const expectedKnownRecords = sourceStats.knownRecords
        - sourceStats.legacyCharacterContainers
        + sourceStats.characters
        + sourceStats.legacyCharacterContainers;

    if (sourceStats.legacyCharacterContainers !== 1
        || sourceStats.characters !== 45
        || sourceStats.chats !== 45
        || sourceStats.memories !== 62
        || sourceStats.aiCharGenRecords <= 0
        || characters !== sourceStats.characters
        || chats !== sourceStats.chats
        || memories !== sourceStats.memories
        || aiCharGenRecords !== sourceStats.aiCharGenRecords
        || localStorageEntries.length !== sourceStats.localStorageRecords
        || knownRecords !== expectedKnownRecords
        || maxRecordBytes >= MAX_RECORD_BYTES) {
        fail('snapshot-counts');
    }

    descriptors.sort(compareDescriptor);
    return {
        schemaVersion: 3,
        knownRecordDigest: sha256(JSON.stringify(descriptors)),
        localStorageDigest: sha256(JSON.stringify(localStorageEntries)),
        knownRecords,
        localStorageRecords: localStorageEntries.length,
        characters,
        indexEntries: characterIndex.order.length,
        chats,
        memories,
        aiCharGenRecords,
        maxRecordBytes,
        duplicateNameGroups
    };
}

const options = parseArguments(process.argv.slice(2));
const sourceStats = await inspectSource(options.source);
const result = inspectSnapshot(options.snapshot, sourceStats);
process.stdout.write(`${JSON.stringify(result)}\n`);
