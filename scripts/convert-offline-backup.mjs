import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';

const OUTPUT_FORMAT_SCHEMA3 = 'schema3';
const OUTPUT_FORMAT_JSONL_V4 = 'jsonl-v4';

function parseArguments(argv) {
    const options = { format: OUTPUT_FORMAT_SCHEMA3 };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--input') options.input = argv[++index];
        else if (argument === '--output') options.output = argv[++index];
        else if (argument === '--format') options.format = argv[++index];
        else throw new Error(`Unknown argument: ${argument}`);
    }
    if (!options.input || !options.output) {
        throw new Error('Usage: node scripts/convert-offline-backup.mjs --input <jsonl> --output <file> [--format schema3|jsonl-v4]');
    }
    if (options.format !== OUTPUT_FORMAT_SCHEMA3 && options.format !== OUTPUT_FORMAT_JSONL_V4) {
        throw new Error(`Unsupported output format: ${options.format}. Expected schema3 or jsonl-v4.`);
    }
    return options;
}

function isCharacterRecord(database, store, key, value) {
    return database === 'RPHubDB'
        && store === 'store'
        && key === 'rp_hub_characters'
        && Array.isArray(value);
}

async function convertBackup(options) {
    const inputPath = path.resolve(options.input);
    const outputPath = path.resolve(options.output);
    if (inputPath === outputPath) throw new Error('Input and output paths must differ.');
    if (!fs.existsSync(inputPath)) throw new Error(`Input backup does not exist: ${inputPath}`);
    if (fs.existsSync(outputPath)) {
        throw new Error(`Refusing to overwrite existing output: ${outputPath}`);
    }

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
    const input = fs.createReadStream(inputPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const output = fs.createWriteStream(temporaryPath, { encoding: 'utf8', flags: 'wx' });
    const outputHash = createHash('sha256');

    let outputBytes = 0;
    async function write(text) {
        outputHash.update(text);
        outputBytes += Buffer.byteLength(text);
        if (!output.write(text)) await once(output, 'drain');
    }

    const stats = {
        inputLines: 0,
        localStorageRecords: 0,
        databases: 0,
        outputRecords: 0,
        charactersSplit: 0,
        generatedCharacterUuids: 0
    };
    const localStorageEntries = [];
    let sawHeader = false;
    let rootStarted = false;
    let rootClosed = false;
    let firstDatabase = true;
    let currentDatabase = null;
    let currentStore = null;
    let currentArray = null;
    const jsonlV4 = options.format === OUTPUT_FORMAT_JSONL_V4;

    async function writeJsonLine(value) {
        await write(`${JSON.stringify(value)}\n`);
    }

    async function startRoot() {
        if (rootStarted) return;
        if (jsonlV4) {
            await writeJsonLine({ type: 'snapshot', format: 'rp-sync-jsonl-v1', schemaVersion: 4 });
            for (const entry of localStorageEntries) {
                await writeJsonLine({ type: 'localStorage', key: entry.key, value: entry.value });
            }
            await writeJsonLine({ type: 'localStorageEnd' });
        } else {
            await write(`{"schemaVersion":3,"localStorage":${JSON.stringify(localStorageEntries)},"indexedDB":[`);
        }
        rootStarted = true;
    }

    async function startDatabase(event) {
        if (currentDatabase || currentStore || currentArray) throw new Error('Nested database event in backup.');
        await startRoot();
        if (!jsonlV4 && !firstDatabase) await write(',');
        firstDatabase = false;
        const stores = Array.isArray(event.stores) ? event.stores : [];
        currentDatabase = {
            name: event.name,
            stores,
            storeMetadata: new Map(stores.map((store) => [store.name, store])),
            seenStores: new Set(),
            firstStore: true
        };
        if (jsonlV4) {
            await writeJsonLine({
                type: 'database',
                name: event.name,
                version: event.version,
                stores: stores.map((store) => ({
                    name: store.name,
                    keyPath: store.keyPath ?? null,
                    autoIncrement: Boolean(store.autoIncrement)
                }))
            });
        } else {
            await write(`{"name":${JSON.stringify(event.name)},"version":${JSON.stringify(event.version)},"stores":[`);
        }
        stats.databases += 1;
    }

    async function startStore(storeName) {
        if (!currentDatabase) throw new Error(`Store ${storeName} appeared outside a database.`);
        if (currentStore) {
            if (currentStore.name !== storeName) throw new Error(`Store changed before storeEnd: ${currentStore.name} -> ${storeName}`);
            return;
        }
        const metadata = currentDatabase.storeMetadata.get(storeName);
        if (!metadata) throw new Error(`Store ${storeName} was not declared by database ${currentDatabase.name}.`);
        if (currentDatabase.seenStores.has(storeName)) throw new Error(`Store ${storeName} appeared more than once.`);
        if (!jsonlV4) {
            if (!currentDatabase.firstStore) await write(',');
            currentDatabase.firstStore = false;
        }
        currentDatabase.seenStores.add(storeName);
        currentStore = { name: storeName, firstRecord: true };
        if (!jsonlV4) {
            await write(`{"name":${JSON.stringify(metadata.name)},"keyPath":${JSON.stringify(metadata.keyPath ?? null)},"autoIncrement":${Boolean(metadata.autoIncrement)},"records":[`);
        }
    }

    async function writeRecord(key, value) {
        if (!currentStore) throw new Error('Record appeared outside a store.');
        if (jsonlV4) {
            await writeJsonLine({
                type: 'record',
                database: currentDatabase.name,
                store: currentStore.name,
                key,
                value
            });
        } else {
            if (!currentStore.firstRecord) await write(',');
            currentStore.firstRecord = false;
            await write(JSON.stringify({ key, value }));
        }
        stats.outputRecords += 1;
    }

    async function writeCharacter(character, state) {
        if (!character || typeof character !== 'object' || Array.isArray(character)) {
            throw new Error('Legacy character array contains a non-object item; conversion stopped without replacing the source backup.');
        }
        const rawUuid = character.uuid;
        let uuid;
        if (rawUuid === undefined || rawUuid === null || rawUuid === '') {
            uuid = randomUUID();
            character.uuid = uuid;
            stats.generatedCharacterUuids += 1;
        } else if (typeof rawUuid !== 'string') {
            throw new Error('Legacy character uuid is not a string; conversion stopped to preserve chat and memory associations.');
        } else {
            uuid = rawUuid;
        }
        if (uuid === 'index') {
            throw new Error('Legacy character uuid index conflicts with the character index key; conversion stopped.');
        }
        if (state.seen.has(uuid)) {
            throw new Error(`Legacy character array contains duplicate uuid ${uuid}; refusing to merge records.`);
        }
        state.seen.add(uuid);
        state.order.push(uuid);
        state.count += 1;
        await writeRecord(`rp_hub_character_${uuid}`, character);
        stats.charactersSplit += 1;
    }

    async function writeSplitCharacters(characters) {
        const state = { order: [], seen: new Set(), count: 0 };
        for (const character of characters) await writeCharacter(character, state);
        await writeRecord('rp_hub_character_index', { order: state.order });
    }

    async function closeStore(expectedName) {
        if (!currentStore) await startStore(expectedName);
        if (currentStore.name !== expectedName) throw new Error(`Unexpected storeEnd for ${expectedName}.`);
        if (currentArray) throw new Error(`Array record in ${expectedName} was not closed.`);
        if (jsonlV4) {
            await writeJsonLine({ type: 'storeEnd', database: currentDatabase.name, store: expectedName });
        } else {
            await write(']}');
        }
        currentStore = null;
    }

    async function closeDatabase(expectedName) {
        if (!currentDatabase || currentDatabase.name !== expectedName) {
            throw new Error(`Unexpected databaseEnd for ${expectedName}.`);
        }
        if (currentStore || currentArray) throw new Error(`Database ${expectedName} ended with an open store or record.`);
        for (const metadata of currentDatabase.stores) {
            if (!currentDatabase.seenStores.has(metadata.name)) {
                await startStore(metadata.name);
                await closeStore(metadata.name);
            }
        }
        if (jsonlV4) {
            await writeJsonLine({ type: 'databaseEnd', name: expectedName });
        } else {
            await write(']}');
        }
        currentDatabase = null;
    }

    try {
        for await (const line of lines) {
            stats.inputLines += 1;
            if (!line.trim()) continue;
            let event;
            try {
                event = JSON.parse(line);
            } catch (error) {
                throw new Error(`Invalid JSON on backup line ${stats.inputLines}: ${error.message}`);
            }

            switch (event?.type) {
                case 'snapshot':
                    if (sawHeader) throw new Error('Backup contains more than one snapshot header.');
                    if (event.format !== 'rp-sync-jsonl-v2' || Number(event.schemaVersion) !== 5) {
                        throw new Error('Unsupported backup event format. Expected rp-sync-jsonl-v2 schemaVersion 5.');
                    }
                    sawHeader = true;
                    break;
                case 'localStorage':
                    if (rootStarted) throw new Error('localStorage event appeared after database data.');
                    localStorageEntries.push({ key: event.key, value: event.value });
                    stats.localStorageRecords += 1;
                    break;
                case 'localStorageEnd':
                    break;
                case 'database':
                    await startDatabase(event);
                    break;
                case 'record':
                    await startStore(event.store);
                    if (isCharacterRecord(event.database, event.store, event.key, event.value)) {
                        await writeSplitCharacters(event.value);
                    } else {
                        await writeRecord(event.key, event.value);
                    }
                    break;
                case 'recordArrayStart':
                    await startStore(event.store);
                    if (currentArray) throw new Error('Nested array record in backup.');
                    if (event.database === 'RPHubDB' && event.store === 'store' && event.key === 'rp_hub_characters') {
                        currentArray = {
                            mode: 'characters',
                            expected: Number(event.length),
                            count: 0,
                            order: [],
                            seen: new Set()
                        };
                    } else {
                        if (jsonlV4) {
                            await writeJsonLine({
                                type: 'recordArrayStart',
                                database: currentDatabase.name,
                                store: currentStore.name,
                                key: event.key,
                                length: event.length
                            });
                        } else {
                            if (!currentStore.firstRecord) await write(',');
                            currentStore.firstRecord = false;
                            await write(`{"key":${JSON.stringify(event.key)},"value":[`);
                        }
                        currentArray = { mode: 'generic', expected: Number(event.length), count: 0, firstItem: true };
                    }
                    break;
                case 'recordArrayItem':
                    if (!currentArray) throw new Error('recordArrayItem appeared without recordArrayStart.');
                    if (currentArray.mode === 'characters') {
                        await writeCharacter(event.value, currentArray);
                    } else {
                        if (jsonlV4) {
                            await writeJsonLine({
                                type: 'recordArrayItem',
                                database: currentDatabase.name,
                                store: currentStore.name,
                                index: currentArray.count,
                                value: event.value === undefined ? null : event.value
                            });
                        } else {
                            if (!currentArray.firstItem) await write(',');
                            currentArray.firstItem = false;
                            await write(JSON.stringify(event.value));
                        }
                        currentArray.count += 1;
                    }
                    break;
                case 'recordArrayEnd':
                    if (!currentArray) throw new Error('recordArrayEnd appeared without recordArrayStart.');
                    if (currentArray.mode === 'characters') {
                        if (Number.isInteger(currentArray.expected) && currentArray.count !== currentArray.expected) {
                            throw new Error(`Legacy character array length mismatch: ${currentArray.count}/${currentArray.expected}.`);
                        }
                        const order = currentArray.order;
                        currentArray = null;
                        await writeRecord('rp_hub_character_index', { order });
                    } else {
                        if (Number.isInteger(currentArray.expected) && currentArray.count !== currentArray.expected) {
                            throw new Error(`Array record length mismatch: ${currentArray.count}/${currentArray.expected}.`);
                        }
                        if (jsonlV4) {
                            await writeJsonLine({
                                type: 'recordArrayEnd',
                                database: currentDatabase.name,
                                store: currentStore.name
                            });
                        } else {
                            await write(']}');
                        }
                        stats.outputRecords += 1;
                        currentArray = null;
                    }
                    break;
                case 'storeEnd':
                    await closeStore(event.store);
                    break;
                case 'databaseEnd':
                    await closeDatabase(event.name);
                    break;
                case 'snapshotEnd':
                    if (!sawHeader) throw new Error('Backup header is missing.');
                    if (currentDatabase || currentStore || currentArray) throw new Error('Backup ended with an open database, store, or record.');
                    await startRoot();
                    if (jsonlV4) {
                        await writeJsonLine({
                            type: 'snapshotEnd',
                            recordCount: stats.localStorageRecords + stats.outputRecords
                        });
                    } else {
                        await write(']}');
                    }
                    rootClosed = true;
                    break;
                default:
                    throw new Error(`Unsupported backup event type on line ${stats.inputLines}: ${String(event?.type)}`);
            }
        }

        if (!sawHeader || !rootClosed) throw new Error('Backup is incomplete.');
        output.end();
        await once(output, 'finish');
        fs.renameSync(temporaryPath, outputPath);
        return {
            ...stats,
            outputBytes,
            outputSha256: outputHash.digest('hex'),
            output: outputPath
        };
    } catch (error) {
        lines.close();
        input.destroy();
        output.destroy();
        try { fs.rmSync(temporaryPath); } catch {}
        throw error;
    }
}

const options = parseArguments(process.argv.slice(2));
const result = await convertBackup(options);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
