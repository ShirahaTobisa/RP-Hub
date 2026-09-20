const resultNode = document.getElementById('result');
const api = globalThis.__RPHBootstrapTest;

function installIndexedDbHandlerDiagnostics() {
    for (const [prototype, properties] of [
        [IDBRequest.prototype, ['onsuccess', 'onerror']],
        [IDBTransaction.prototype, ['oncomplete', 'onerror', 'onabort']]
    ]) {
        for (const property of properties) {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
            if (!descriptor?.configurable || typeof descriptor.set !== 'function') continue;
            Object.defineProperty(prototype, property, {
                ...descriptor,
                set(handler) {
                    if (typeof handler !== 'function') return descriptor.set.call(this, handler);
                    return descriptor.set.call(this, function diagnosticHandler(...args) {
                        try {
                            return handler.apply(this, args);
                        } catch (error) {
                            globalThis.__bootstrapIdbHandlerError ||= error?.stack || error?.message || String(error);
                            throw error;
                        }
                    });
                }
            });
        }
    }
}

installIndexedDbHandlerDiagnostics();

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

function assertDeepEqual(actual, expected, message) {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) {
        throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
    }
}

async function captureRejection(promise, message) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error(`${message}: promise resolved unexpectedly`);
}

function finish(status, message) {
    resultNode.dataset.status = status;
    resultNode.textContent = `${status.toUpperCase()}: ${message}`;
}

function wait(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
}

function transactionDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed.'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
    });
}

async function deleteRPHubDatabase() {
    const request = indexedDB.deleteDatabase('RPHubDB');
    await new Promise((resolve, reject) => {
        let blocked = false;
        const timeoutId = setTimeout(() => reject(new Error(
            blocked
                ? 'deleteDatabase remained blocked; an IndexedDB connection was not closed.'
                : 'deleteDatabase timed out.'
        )), 5000);
        request.onsuccess = () => {
            clearTimeout(timeoutId);
            resolve();
        };
        request.onerror = () => {
            clearTimeout(timeoutId);
            reject(request.error || new Error('deleteDatabase failed.'));
        };
        request.onblocked = () => { blocked = true; };
    });
}

async function openRPHubDatabase() {
    const request = indexedDB.open('RPHubDB', 1);
    request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('store')) {
            request.result.createObjectStore('store');
        }
    };
    return requestResult(request);
}

async function seedRecords(records) {
    const db = await openRPHubDatabase();
    try {
        const tx = db.transaction(['store'], 'readwrite');
        const done = transactionDone(tx);
        const store = tx.objectStore('store');
        for (const [key, value] of records) store.put(value, key);
        await done;
    } finally {
        db.close();
    }
}

async function readRecord(key) {
    const db = await openRPHubDatabase();
    try {
        return await requestResult(db.transaction(['store'], 'readonly').objectStore('store').get(key));
    } finally {
        db.close();
    }
}

async function readAllRecords() {
    const db = await openRPHubDatabase();
    try {
        const tx = db.transaction(['store'], 'readonly');
        const store = tx.objectStore('store');
        const [keys, values] = await Promise.all([
            requestResult(store.getAllKeys()),
            requestResult(store.getAll())
        ]);
        return keys.map((key, index) => [key, values[index]]);
    } finally {
        db.close();
    }
}

function legacyStoreDefinition(cards, extraRecords = []) {
    return {
        databaseName: 'RPHubDB',
        name: 'store',
        keyPath: null,
        autoIncrement: false,
        records: [
            { key: 'rp_hub_characters', value: cards },
            ...extraRecords
        ]
    };
}

async function testLegacyExpansionAndAtomicValidation() {
    await deleteRPHubDatabase();
    await seedRecords([
        ['rp_hub_characters', [{ uuid: 'old-local', name: 'old' }]],
        ['rp_hub_character_stale', { uuid: 'stale', name: 'stale' }],
        ['local-only', { shouldDisappear: true }]
    ]);

    const cards = [
        { uuid: 'card-a', name: 'A' },
        { name: 'B' },
        { uuid: 'card-c', name: 'C' }
    ];
    const chat = [{ role: 'user', content: 'hello' }];
    const memories = [{ summary: 'remember' }];
    const db = await openRPHubDatabase();
    try {
        await api.syncObjectStoreRecords(db, legacyStoreDefinition(cards, [
            { key: 'rp_hub_chat_card-a', value: chat },
            { key: 'rp_hub_memories_card-a', value: memories }
        ]));
    } finally {
        db.close();
    }

    assertEqual(await readRecord('rp_hub_characters'), undefined, 'legacy monolithic record was retained');
    assert(typeof cards[1].uuid === 'string' && cards[1].uuid.length > 0, 'missing UUID was not generated');
    const expectedOrder = cards.map((card) => card.uuid);
    assertDeepEqual((await readRecord('rp_hub_character_index')).order, expectedOrder,
        'legacy expansion changed card order');
    for (const card of cards) {
        assertDeepEqual(await readRecord(`rp_hub_character_${card.uuid}`), card,
            `generated incoming key was deleted for ${card.uuid}`);
    }
    assertDeepEqual(await readRecord('rp_hub_chat_card-a'), chat, 'incoming chat record was deleted');
    assertDeepEqual(await readRecord('rp_hub_memories_card-a'), memories, 'incoming memory record was deleted');
    assertEqual(await readRecord('rp_hub_character_stale'), undefined, 'stale split record was not cleaned');
    assertEqual(await readRecord('local-only'), undefined, 'local-only record was not cleaned');

    const beforeInvalidRestores = await readAllRecords();
    const duplicateError = await captureRejection((async () => {
        const duplicateDb = await openRPHubDatabase();
        try {
            await api.syncObjectStoreRecords(duplicateDb, legacyStoreDefinition([
                { uuid: 'duplicate', name: 'one' },
                { uuid: 'duplicate', name: 'two' }
            ]));
        } finally {
            duplicateDb.close();
        }
    })(), 'duplicate UUID restore');
    assert(/UUID 重复/.test(duplicateError.message), 'duplicate UUID error was not explicit');
    assertDeepEqual(await readAllRecords(), beforeInvalidRestores,
        'duplicate UUID restore changed existing store data');

    const invalidError = await captureRejection((async () => {
        const invalidDb = await openRPHubDatabase();
        try {
            await api.syncObjectStoreRecords(invalidDb, legacyStoreDefinition([
                { uuid: 'valid', name: 'valid' },
                null,
                { uuid: 'unreached', name: 'unreached' }
            ]));
        } finally {
            invalidDb.close();
        }
    })(), 'invalid card restore');
    assert(/格式无效/.test(invalidError.message), 'invalid card error was not explicit');
    assertDeepEqual(await readAllRecords(), beforeInvalidRestores,
        'invalid card restore changed existing store data');
}

async function testPerPutFailureRollsBack() {
    await deleteRPHubDatabase();
    await seedRecords([
        ['keep', { revision: 'before' }],
        ['stale', { mustSurviveAbort: true }]
    ]);
    const before = await readAllRecords();
    const badValue = { text: '汉'.repeat(50_000) };
    const expectedMegabytes = (new TextEncoder().encode(JSON.stringify(badValue)).byteLength / 1024 / 1024).toFixed(2);
    let preventDefaultCalled = false;
    const nativePut = IDBObjectStore.prototype.put;

    IDBObjectStore.prototype.put = function patchedPut(value, key) {
        if (key !== 'bad-unicode-record') return nativePut.apply(this, arguments);
        const fakeRequest = { error: new DOMException('simulated put failure', 'UnknownError') };
        Object.defineProperty(fakeRequest, 'onerror', {
            set(handler) {
                queueMicrotask(() => handler({
                    preventDefault() { preventDefaultCalled = true; }
                }));
            }
        });
        return fakeRequest;
    };

    let error;
    try {
        const db = await openRPHubDatabase();
        try {
            error = await captureRejection(api.syncObjectStoreRecords(db, {
                databaseName: 'RPHubDB',
                name: 'store',
                keyPath: null,
                autoIncrement: false,
                records: [
                    { key: 'keep', value: { revision: 'after' } },
                    { key: 'bad-unicode-record', value: badValue }
                ]
            }), 'per-put failure');
        } finally {
            db.close();
        }
    } finally {
        IDBObjectStore.prototype.put = nativePut;
    }

    assert(preventDefaultCalled, 'per-put handler did not prevent the generic IndexedDB error');
    assert(error.message.includes('bad-unicode-record'), 'per-put error omitted the record key');
    assert(error.message.includes(`${expectedMegabytes}MB`), 'per-put error did not report UTF-8 byte size');
    assertDeepEqual(await readAllRecords(), before, 'per-put failure did not roll back the whole transaction');
}

async function testRecordSizeGuard() {
    assertEqual(api.CONFIG.warnRecordBytes, 128, 'test warning threshold injection failed');
    assertEqual(api.CONFIG.maxRecordBytes, 256, 'test block threshold injection failed');

    await installSyntheticData({
        localStorageEntries: [],
        indexedDbDatabases: [{
            name: 'RPHubDB',
            version: 1,
            stores: [{
                name: 'store',
                records: [{ key: 'warn-key', value: { text: '汉'.repeat(50) } }]
            }]
        }]
    });
    const warnings = [];
    const nativeWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(' '));
    try {
        await api.scanStreamSnapshot('cdc');
    } finally {
        console.warn = nativeWarn;
    }
    assert(warnings.some((message) => message.includes('warn-key')), '32MiB-equivalent warning omitted the key');

    await installSyntheticData({
        localStorageEntries: [],
        indexedDbDatabases: [{
            name: 'RPHubDB',
            version: 1,
            stores: [{
                name: 'store',
                records: [{ key: 'blocked-key', value: { text: '汉'.repeat(100) } }]
            }]
        }]
    });
    const blockError = await captureRejection(api.scanStreamSnapshot('cdc'), '100MiB-equivalent record block');
    const blockErrorText = `${blockError.message} ${blockError.cause?.message || ''}`;
    assert(blockErrorText.includes('blocked-key'), 'record-size block omitted the key');
    assert(blockErrorText.includes('100MiB'), 'record-size block omitted recovery-limit guidance');
}

async function installSyntheticData(snapshot) {
    await deleteRPHubDatabase();
    localStorage.clear();
    for (const entry of snapshot.localStorageEntries || []) localStorage.setItem(entry.key, entry.value);
    const database = snapshot.indexedDbDatabases?.find((item) => item.name === 'RPHubDB');
    const store = database?.stores?.find((item) => item.name === 'store');
    await seedRecords((store?.records || []).map((record) => [record.key, record.value]));
}

async function collectSnapshotChunks(profile = 'cdc') {
    const stats = { recordCount: 0, totalBytes: 0 };
    const chunks = [];
    for await (const chunk of api.iterateSnapshotChunks(stats, profile)) chunks.push(chunk);
    return { stats, chunks };
}

function chunkSignature(chunk) {
    return `${chunk.checksum}:${chunk.length}`;
}

function syntheticSnapshotData() {
    const records = Array.from({ length: 180 }, (_, index) => ({
        key: `rp_hub_chat_${String(index).padStart(3, '0')}`,
        value: [{
            role: index % 2 ? 'assistant' : 'user',
            content: `record-${index}-${'x'.repeat(700)}-汉😀-${String.fromCharCode(0xd800)}`
        }]
    }));
    const localStorageEntries = Array.from({ length: 12 }, (_, index) => ({
        key: `rp_hub_setting_${String(index).padStart(2, '0')}`,
        value: `setting-${index}-${'y'.repeat(240)}`
    }));
    const indexedDbDatabases = [{
        name: 'RPHubDB',
        version: 1,
        stores: [{ name: 'store', keyPath: null, autoIncrement: false, records }]
    }];
    return { localStorageEntries, indexedDbDatabases };
}

async function sha256Bytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

async function testCdcPropertiesAndLocality() {
    const productionChunkSize = api.CONFIG.chunkSize;
    api.CONFIG.maxRecordBytes = 4 * 1024 * 1024;
    assertEqual(productionChunkSize, 2 * 1024 * 1024, 'CDC target metadata is not 2MiB');
    assertEqual(api.CONFIG.uploadPartConcurrency, 6, 'mainline upload concurrency changed from six');
    assertEqual(api.CONFIG.jsonDownloadPartChunks, 8, 'download range was not raised to eight chunks');
    assertEqual(api.fnv1a32(new TextEncoder().encode('')), 0x811c9dc5, 'FNV empty vector mismatch');
    assertEqual(api.fnv1a32(new TextEncoder().encode('a')), 0xe40c292c, 'FNV single-byte vector mismatch');
    assertEqual(api.fnv1a32(new TextEncoder().encode('foobar')), 0xbf9cf968, 'FNV foobar vector mismatch');

    const checksumFixture = {
        recordCount: 3,
        totalBytes: 9,
        chunkerProfile: 'must-not-affect-checksum',
        chunkManifest: [
            { index: 0, checksum: 'A'.repeat(64), length: 4 },
            { index: 1, checksum: 'b'.repeat(64), length: 5 }
        ]
    };
    const checksumFixtureSource = api.buildStreamSnapshotChecksumSource(checksumFixture);
    assertEqual(checksumFixtureSource,
        '["rp-sync-jsonl-v1",4,3,9,[["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",4],["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",5]]]',
        'v4 checksum source changed byte representation');
    assertEqual(await sha256Bytes(new TextEncoder().encode(checksumFixtureSource)),
        '3bd9f7faf0b3291de8e6fdfb0669f6294c43bc078650765b1e5aa60bffdad04b',
        'v4 checksum fixture diverged from the production R2-pics algorithm');

    api.CONFIG.chunkSize = 32 * 1024;
    try {
        const baseData = syntheticSnapshotData();
        await installSyntheticData(baseData);
        const base = await api.scanStreamSnapshot('cdc');
        const baseCollected = await collectSnapshotChunks('cdc');
        assert(base.chunkManifest.length > 1, 'synthetic CDC fixture did not produce multiple chunks');
        assert(base.chunkManifest.every((chunk) => chunk.length > 0 && chunk.length <= 8 * 1024 * 1024),
            'CDC chunk size invariant failed');
        assertDeepEqual(baseCollected.chunks.map(chunkSignature), base.chunkManifest.map(chunkSignature),
            'manifest did not match streamed chunk bytes');
        assertEqual(baseCollected.stats.totalBytes, base.totalBytes, 'CDC total byte count changed between scans');
        const repeatedCollected = await collectSnapshotChunks('cdc');
        assertEqual(await sha256Bytes(await mergeChunks(baseCollected.chunks)),
            await sha256Bytes(await mergeChunks(repeatedCollected.chunks)),
            'CDC chunks did not reassemble byte-for-byte');
        const checksumSource = api.buildStreamSnapshotChecksumSource(base);
        assertEqual(await sha256Bytes(new TextEncoder().encode(checksumSource)), base.checksum,
            'manifest checksum does not use the v4 checksum source');

        const repeated = await api.scanStreamSnapshot('cdc');
        assertDeepEqual(repeated.chunkManifest.map(chunkSignature), base.chunkManifest.map(chunkSignature),
            'CDC boundaries are not deterministic');

        const changedData = structuredClone(baseData);
        changedData.indexedDbDatabases[0].stores[0].records[80].value[0].content += '-changed';
        await installSyntheticData(changedData);
        assertLocality(base.chunkManifest, (await api.scanStreamSnapshot('cdc')).chunkManifest,
            'single-record modification');

        const addedData = structuredClone(baseData);
        addedData.indexedDbDatabases[0].stores[0].records.splice(80, 0, {
            key: 'rp_hub_chat_080-new',
            value: [{ role: 'user', content: `new-${'n'.repeat(700)}-汉😀` }]
        });
        await installSyntheticData(addedData);
        assertLocality(base.chunkManifest, (await api.scanStreamSnapshot('cdc')).chunkManifest,
            'single-record insertion');

        const deletedData = structuredClone(baseData);
        deletedData.indexedDbDatabases[0].stores[0].records.splice(80, 1);
        await installSyntheticData(deletedData);
        assertLocality(base.chunkManifest, (await api.scanStreamSnapshot('cdc')).chunkManifest,
            'single-record deletion');

        const writer = new api.SnapshotChunkWriter('cdc', 32, 128, 1024 * 1024);
        const lines = ['{"type":"snapshot"}\n', ...Array.from({ length: 30 }, (_, index) =>
            JSON.stringify({ type: 'record', index }) + '\n')];
        const expectedBytes = new TextEncoder().encode(lines.join(''));
        const writerChunks = [];
        for (const line of lines) writerChunks.push(...writer.appendLine(line));
        writerChunks.push(...writer.finish());
        assert(writerChunks.length > 1, 'direct CDC writer fixture did not produce multiple chunks');
        assert(writerChunks.every((chunk) => chunk.byteLength > 0 && chunk.byteLength <= 128),
            'direct CDC writer exceeded hard maximum');
        assertEqual(await sha256Bytes(await mergeChunks(writerChunks)), await sha256Bytes(expectedBytes),
            'CDC writer did not losslessly reassemble JSONL');
        assert(writerChunks.slice(0, -1).every((chunk) => chunk[chunk.length - 1] === 0x0a),
            'CDC split a normal JSONL record');

        const oversizedLine = `${JSON.stringify({ type: 'record', value: 'z'.repeat(400) })}\n`;
        const oversizedWriter = new api.SnapshotChunkWriter('cdc', 32, 128, 1024 * 1024);
        const oversizedChunks = [
            ...oversizedWriter.appendLine('{"type":"small"}\n'),
            ...oversizedWriter.appendLine(oversizedLine),
            ...oversizedWriter.finish()
        ];
        assert(oversizedChunks.every((chunk) => chunk.byteLength <= 128),
            'oversized JSONL record exceeded hard maximum');
        assertEqual(await sha256Bytes(await mergeChunks(oversizedChunks)),
            await sha256Bytes(new TextEncoder().encode(`{"type":"small"}\n${oversizedLine}`)),
            'oversized JSONL record chunks were not lossless');
        assertEqual(oversizedChunks[0][oversizedChunks[0].length - 1], 0x0a,
            'oversized record was mixed with a preceding JSONL record');

        await installSyntheticData(baseData);
        globalThis.__RPH_FORCE_CDC_FAILURE = true;
        globalThis.__bootstrapScanProfiles = [];
        const warnings = [];
        const nativeWarn = console.warn;
        console.warn = (...args) => warnings.push(args.map(String).join(' '));
        let fallback;
        try {
            fallback = await api.buildStreamSnapshotManifest();
        } finally {
            console.warn = nativeWarn;
            globalThis.__RPH_FORCE_CDC_FAILURE = false;
        }
        assert(warnings.some((message) => message.includes('回退旧定长切块')), 'CDC failure did not warn and fall back');
        assert(!fallback.chunkerProfile, 'fixed fallback retained the CDC profile');
        assertDeepEqual(globalThis.__bootstrapScanProfiles, ['cdc', 'fixed'],
            'CDC fallback did not rescan using fixed chunks');
    } finally {
        api.CONFIG.chunkSize = productionChunkSize;
        api.CONFIG.maxRecordBytes = 100 * 1024 * 1024;
    }
}

async function mergeChunks(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + (chunk.bytes?.byteLength ?? chunk.byteLength), 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        const bytes = chunk.bytes || chunk;
        merged.set(bytes, offset);
        offset += bytes.byteLength;
    }
    return merged;
}

function assertLocality(before, after, label) {
    const beforeSet = new Set(before.map(chunkSignature));
    const afterSet = new Set(after.map(chunkSignature));
    const newOnly = after.filter((chunk) => !beforeSet.has(chunkSignature(chunk)));
    const oldOnly = before.filter((chunk) => !afterSet.has(chunkSignature(chunk)));
    assert(newOnly.length >= 1 && newOnly.length <= 3,
        `${label} changed ${newOnly.length} new chunks, expected 1..3`);
    assert(oldOnly.length <= 3,
        `${label} retired ${oldOnly.length} chunks, expected <=3`);
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}

async function buildV4Remote(snapshotText, recordCount, chunkSize = 17) {
    const bytes = new TextEncoder().encode(snapshotText);
    const chunks = [];
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength)));
    }
    const chunkManifest = [];
    for (let index = 0; index < chunks.length; index += 1) {
        chunkManifest.push({
            index,
            checksum: await sha256Bytes(chunks[index]),
            length: chunks[index].byteLength
        });
    }
    const totalBytes = bytes.byteLength;
    const checksumSource = JSON.stringify([
        'rp-sync-jsonl-v1',
        4,
        Number(recordCount),
        Number(totalBytes),
        chunkManifest.map((chunk) => [chunk.checksum, chunk.length])
    ]);
    return {
        version: 1,
        snapshotFormat: 'rp-sync-jsonl-v1',
        schemaVersion: 4,
        recordCount,
        totalBytes,
        chunkCount: chunkManifest.length,
        chunkManifest,
        checksum: await sha256Bytes(new TextEncoder().encode(checksumSource)),
        bytes,
        chunks
    };
}

function makeV4Snapshot(recordCount = 3, characters = [
    { uuid: 'v4-card', name: 'v4 card' },
    { uuid: 'v4-card-second', name: 'v4 card second' }
]) {
    return [
        { type: 'snapshot', format: 'rp-sync-jsonl-v1', schemaVersion: 4 },
        { type: 'localStorage', key: 'rp_hub_v4_setting', value: 'restored' },
        { type: 'localStorageEnd' },
        {
            type: 'database',
            name: 'RPHubDB',
            version: 1,
            stores: [{ name: 'store', keyPath: null, autoIncrement: false }]
        },
        {
            type: 'recordArrayStart',
            database: 'RPHubDB',
            store: 'store',
            key: 'rp_hub_characters',
            length: characters.length
        },
        ...characters.map((value, index) => ({
            type: 'recordArrayItem',
            database: 'RPHubDB',
            store: 'store',
            index,
            value
        })),
        { type: 'recordArrayEnd', database: 'RPHubDB', store: 'store' },
        { type: 'recordArrayStart', database: 'RPHubDB', store: 'store', key: 'rp_hub_chat_v4-card', length: 1 },
        {
            type: 'recordArrayItem',
            database: 'RPHubDB',
            store: 'store',
            index: 0,
            value: { role: 'assistant', content: 'v4 chat' }
        },
        { type: 'recordArrayEnd', database: 'RPHubDB', store: 'store' },
        { type: 'storeEnd', database: 'RPHubDB', store: 'store' },
        { type: 'databaseEnd', name: 'RPHubDB' },
        { type: 'snapshotEnd', recordCount }
    ].map((event) => JSON.stringify(event)).join('\n') + '\n';
}

async function readStagingKeys() {
    const db = await api.openDownloadStagingDb();
    try {
        const request = db.transaction(['chunks'], 'readonly').objectStore('chunks').getAllKeys();
        return await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('staging key read failed'));
        });
    } finally {
        db.close();
    }
}

async function testV4PullCompatibilityAndValidation() {
    const validRemote = await buildV4Remote(makeV4Snapshot(), 3, 23);
    const oldClientPayloadChecksum = await sha256Bytes(validRemote.bytes);
    assert(oldClientPayloadChecksum !== validRemote.checksum,
        'v4 Merkle checksum unexpectedly matched the legacy full-payload sha256');
    let oldClientWriteCount = 0;
    try {
        if (oldClientPayloadChecksum !== validRemote.checksum) {
            throw new Error('服务器数据整体校验失败。');
        }
        oldClientWriteCount += 1;
    } catch (error) {
        assert(/整体校验失败/.test(error.message), 'old-client switch-window failure was not clean');
    }
    assertEqual(oldClientWriteCount, 0, 'old-client switch-window checksum failure changed local data');
    await deleteRPHubDatabase();
    localStorage.clear();
    await seedRecords([['keep-local', { value: 'before' }]]);

    const nativeFetch = globalThis.fetch;
    const nativeSetTimeout = globalThis.setTimeout;
    const actions = [];
    let reloadScheduled = 0;
    globalThis.fetch = async (_input, init) => {
        const payload = JSON.parse(init.body);
        actions.push(payload.action);
        if (payload.action === 'pull-manifest') return jsonResponse({ ok: true, remote: validRemote });
        if (payload.action === 'pull-json-part') {
            const start = Number(payload.start);
            const count = Number(payload.count);
            const selected = validRemote.chunks.slice(start, start + count);
            const length = selected.reduce((sum, chunk) => sum + chunk.byteLength, 0);
            const merged = new Uint8Array(length);
            let offset = 0;
            for (const chunk of selected) {
                merged.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return new Response(merged, {
                status: 200,
                headers: { 'x-rp-sync-byte-length': String(merged.byteLength) }
            });
        }
        throw new Error(`unexpected v4 pull action ${payload.action}`);
    };
    globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 700) {
            reloadScheduled += 1;
            return 2_147_483_000;
        }
        return nativeSetTimeout(callback, delay, ...args);
    };
    try {
        await api.pullFromServer();
    } finally {
        globalThis.fetch = nativeFetch;
        globalThis.setTimeout = nativeSetTimeout;
    }
    assertEqual(reloadScheduled, 1, 'v4 fixed-boundary pull did not schedule reload');
    assert(/页面即将刷新/.test(api.state.statusText), 'v4 pull did not complete restore');
    assertEqual(validRemote.recordCount, 3,
        'legacy character array must count as one remote snapshot record');
    assertEqual(await readRecord('rp_hub_characters'), undefined,
        'v4 restore retained the legacy monolithic character key');
    assertDeepEqual(await readRecord('rp_hub_character_v4-card'), { uuid: 'v4-card', name: 'v4 card' },
        'v4 fixed-boundary pull did not restore character record');
    assertDeepEqual(await readRecord('rp_hub_character_v4-card-second'),
        { uuid: 'v4-card-second', name: 'v4 card second' },
        'v4 fixed-boundary pull did not restore the second character record');
    assertDeepEqual((await readRecord('rp_hub_character_index')).order,
        ['v4-card', 'v4-card-second'],
        'v4 legacy character expansion changed character index order');
    assertDeepEqual(await readRecord('rp_hub_chat_v4-card'), [{ role: 'assistant', content: 'v4 chat' }],
        'v4 fixed-boundary pull did not restore array record');
    assertEqual(localStorage.getItem('rp_hub_v4_setting'), 'restored', 'v4 pull did not restore localStorage');
    assertEqual((await readStagingKeys()).length, 0, 'successful v4 pull left staging chunks behind');
    assert(actions.includes('pull-manifest') && actions.includes('pull-json-part'),
        'v4 pull did not use manifest/range protocol');
    delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
    api.state.syncing = false;
    api.state.reloadPending = false;

    await deleteRPHubDatabase();
    localStorage.clear();
    await seedRecords([['keep-duplicate-local', { value: 'must survive duplicate UUID validation' }]]);
    const duplicateRemote = await buildV4Remote(makeV4Snapshot(3, [
        { uuid: 'v4-duplicate', name: 'first duplicate' },
        { uuid: 'v4-duplicate', name: 'second duplicate' }
    ]), 3, 23);
    let duplicateRestoreStarted = false;
    globalThis.fetch = async (_input, init) => {
        const payload = JSON.parse(init.body);
        if (payload.action !== 'pull-json-part') throw new Error(`unexpected duplicate UUID action ${payload.action}`);
        const selected = duplicateRemote.chunks
            .slice(Number(payload.start), Number(payload.start) + Number(payload.count));
        const bytes = await mergeChunks(selected);
        return new Response(bytes, {
            status: 200,
            headers: { 'x-rp-sync-byte-length': String(bytes.byteLength) }
        });
    };
    try {
        const duplicateError = await captureRejection(
            api.restoreStreamSnapshot(duplicateRemote, () => { duplicateRestoreStarted = true; }),
            'v4 duplicate UUID first-pass validation'
        );
        assert(/UUID 重复/.test(duplicateError.message), 'duplicate legacy character UUID was accepted');
    } finally {
        globalThis.fetch = nativeFetch;
    }
    assert(!duplicateRestoreStarted, 'duplicate UUID validation started second-pass writes');
    assertDeepEqual(await readRecord('keep-duplicate-local'),
        { value: 'must survive duplicate UUID validation' },
        'duplicate UUID validation changed local data');
    assertEqual(await readRecord('rp_hub_character_v4-duplicate'), undefined,
        'duplicate UUID validation wrote a split character record');
    assertEqual((await readStagingKeys()).length, 0,
        'duplicate UUID validation left staging chunks behind');

    await deleteRPHubDatabase();
    localStorage.clear();
    await seedRecords([['keep-local', { value: 'must survive' }]]);
    const badRemote = await buildV4Remote(makeV4Snapshot(99), 99, 23);
    let restoreStarted = false;
    globalThis.fetch = async (_input, init) => {
        const payload = JSON.parse(init.body);
        if (payload.action !== 'pull-json-part') throw new Error(`unexpected validation action ${payload.action}`);
        const selected = badRemote.chunks.slice(Number(payload.start), Number(payload.start) + Number(payload.count));
        const length = selected.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const merged = new Uint8Array(length);
        let offset = 0;
        for (const chunk of selected) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return new Response(merged, {
            status: 200,
            headers: { 'x-rp-sync-byte-length': String(merged.byteLength) }
        });
    };
    try {
        const validationError = await captureRejection(
            api.restoreStreamSnapshot(badRemote, () => { restoreStarted = true; }),
            'v4 first-pass validation failure'
        );
        assert(/记录数量校验失败/.test(validationError.message), 'bad v4 record count was not rejected');
    } finally {
        globalThis.fetch = nativeFetch;
    }
    assert(!restoreStarted, 'first-pass validation failure started local restore writes');
    assertDeepEqual(await readRecord('keep-local'), { value: 'must survive' },
        'first-pass validation failure changed local data');
    assertEqual((await readStagingKeys()).length, 0, 'failed first pass left staging chunks behind');

    restoreStarted = false;
    globalThis.fetch = async (_input, init) => {
        const payload = JSON.parse(init.body);
        if (payload.action !== 'pull-json-part') throw new Error(`unexpected corrupt-chunk action ${payload.action}`);
        const selected = validRemote.chunks
            .slice(Number(payload.start), Number(payload.start) + Number(payload.count))
            .map((chunk) => chunk.slice());
        if (Number(payload.start) === 0) selected[0][0] ^= 0xff;
        const bytes = await mergeChunks(selected);
        return new Response(bytes, {
            status: 200,
            headers: { 'x-rp-sync-byte-length': String(bytes.byteLength) }
        });
    };
    try {
        const chunkError = await captureRejection(
            api.restoreStreamSnapshot(validRemote, () => { restoreStarted = true; }),
            'v4 corrupt chunk validation failure'
        );
        assert(/分片内容校验失败/.test(chunkError.message), 'corrupt v4 chunk was not rejected');
    } finally {
        globalThis.fetch = nativeFetch;
    }
    assert(!restoreStarted, 'corrupt chunk started local restore writes');
    assertDeepEqual(await readRecord('keep-local'), { value: 'must survive' },
        'corrupt chunk changed local data');
    assertEqual((await readStagingKeys()).length, 0, 'corrupt chunk left staging data behind');

    const unsupportedActions = [];
    globalThis.fetch = async (_input, init) => {
        const payload = JSON.parse(init.body);
        unsupportedActions.push(payload.action);
        return jsonResponse({
            ok: true,
            remote: {
                snapshotFormat: 'rp-sync-jsonl-v2',
                schemaVersion: 5,
                version: 1,
                chunkCount: 1,
                totalBytes: 1,
                checksum: 'unsupported'
            }
        });
    };
    try {
        await api.pullFromServer();
    } finally {
        globalThis.fetch = nativeFetch;
    }
    assert(/格式不受支持/.test(api.state.statusText), 'jsonl-v2/schema5 manifest was accepted');
    assertDeepEqual(unsupportedActions, ['pull-manifest'], 'unsupported manifest triggered data downloads');
}

async function testLargeStreamingRoundTrip() {
    const payloadBytes = 1024 * 1024;
    const recordTotal = 65;
    const payloadText = 'streaming-payload-'.padEnd(payloadBytes, 's');
    const records = Array.from({ length: recordTotal }, (_, index) => [
        `rp_hub_stream_probe_${String(index).padStart(3, '0')}`,
        { index, payload: payloadText }
    ]);

    await deleteRPHubDatabase();
    localStorage.clear();
    localStorage.setItem('rp_hub_stream_probe_setting', 'large-round-trip');
    await seedRecords(records);

    const nativeFetch = globalThis.fetch;
    const nativeSetTimeout = globalThis.setTimeout;
    const uploadedChunks = new Map();
    let pendingManifest = null;
    let remote = null;
    let reloadScheduled = 0;
    globalThis.__bootstrapIterateSnapshotProfiles = [];
    globalThis.__bootstrapStagingOpenCalls = 0;
    globalThis.RPHubCharStore = { async assertPushAllowed() {} };
    globalThis.RPH_R2_FLUSH_PERSISTENCE = async () => {};

    globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.searchParams.get('action') === 'upload-part') {
            const index = Number(url.searchParams.get('index'));
            const bytes = new Uint8Array(init.body);
            const headers = new Headers(init.headers);
            assertEqual(bytes.byteLength, Number(headers.get('x-rp-part-length')),
                `large upload part ${index} length header mismatch`);
            assertEqual(await sha256Bytes(bytes), headers.get('x-rp-part-checksum'),
                `large upload part ${index} checksum header mismatch`);
            uploadedChunks.set(index, bytes);
            return jsonResponse({ ok: true, index, partNumber: index + 1, key: `fixture/${index}` });
        }

        const request = JSON.parse(init.body);
        if (request.action === 'pull-manifest') return jsonResponse({ ok: true, remote });
        if (request.action === 'upload-create') {
            pendingManifest = structuredClone(request);
            return jsonResponse({
                ok: true,
                alreadyUpToDate: false,
                previousVersion: 0,
                missingIndices: request.chunkManifest.map((chunk) => chunk.index)
            });
        }
        if (request.action === 'upload-complete') {
            assert(pendingManifest, 'large upload completed without an upload-create request');
            assertEqual(request.expectedVersion, 0, 'large upload lost CAS expectedVersion');
            assertDeepEqual(request.chunkManifest, pendingManifest.chunkManifest,
                'large upload changed its manifest between scans');
            assertEqual(uploadedChunks.size, request.chunkManifest.length,
                'large upload omitted one or more chunks');
            for (const chunk of request.chunkManifest) {
                const bytes = uploadedChunks.get(chunk.index);
                assert(bytes, `large upload omitted chunk ${chunk.index}`);
                assertEqual(bytes.byteLength, chunk.length, `large upload chunk ${chunk.index} length changed`);
                assertEqual(await sha256Bytes(bytes), chunk.checksum,
                    `large upload chunk ${chunk.index} checksum changed`);
            }
            const independentChecksumSource = JSON.stringify([
                'rp-sync-jsonl-v1',
                4,
                Number(request.recordCount),
                Number(request.totalBytes),
                request.chunkManifest.map((chunk) => [String(chunk.checksum).toLowerCase(), Number(chunk.length)])
            ]);
            assertEqual(await sha256Bytes(new TextEncoder().encode(independentChecksumSource)), request.checksum,
                'large upload manifest checksum was not R2-pics compatible');
            remote = { ...structuredClone(request), version: 1 };
            delete remote.action;
            delete remote.expectedVersion;
            return jsonResponse({ ok: true, version: 1 });
        }
        if (request.action === 'pull-json-part') {
            assert(remote, 'large pull started before a committed manifest existed');
            const selected = remote.chunkManifest
                .slice(Number(request.start), Number(request.start) + Number(request.count))
                .map((chunk) => uploadedChunks.get(chunk.index));
            const bytes = await mergeChunks(selected);
            return new Response(bytes, {
                status: 200,
                headers: { 'x-rp-sync-byte-length': String(bytes.byteLength) }
            });
        }
        throw new Error(`unexpected large streaming action ${request.action}`);
    };

    try {
        await api.pushToServer();
        assertEqual(api.state.statusText, '上传成功。', 'large streaming push did not complete');
        assert(remote, 'large streaming push did not commit a remote manifest');
        assertEqual(remote.snapshotFormat, 'rp-sync-jsonl-v1', 'large streaming push changed wire format');
        assertEqual(remote.schemaVersion, 4, 'large streaming push changed schema version');
        assert(remote.totalBytes >= 64 * 1024 * 1024,
            `large streaming fixture was only ${remote.totalBytes} bytes`);
        assert(remote.chunkManifest.length > 8, 'large streaming fixture did not exercise ranged downloads');
        assertDeepEqual(globalThis.__bootstrapIterateSnapshotProfiles, ['cdc', 'cdc'],
            'large push did not use manifest scan plus one streaming upload scan');

        await deleteRPHubDatabase();
        localStorage.clear();
        await seedRecords([['stale-large-round-trip', { stale: true }]]);
        globalThis.setTimeout = (callback, delay, ...args) => {
            if (delay === 700) {
                reloadScheduled += 1;
                return 2_147_483_000;
            }
            return nativeSetTimeout(callback, delay, ...args);
        };
        await api.pullFromServer();
    } finally {
        globalThis.fetch = nativeFetch;
        globalThis.setTimeout = nativeSetTimeout;
    }

    assertEqual(api.state.statusText, '服务器数据已写入本地，页面即将刷新...',
        'large staged pull did not complete');
    assertEqual(reloadScheduled, 1, 'large staged pull did not schedule one reload');
    assert(globalThis.__bootstrapStagingOpenCalls >= 1, 'large staged pull bypassed the staging database');
    assertEqual((await readStagingKeys()).length, 0, 'large staged pull left chunks behind');
    assertEqual(await readRecord('stale-large-round-trip'), undefined,
        'large staged pull retained stale local data');
    const first = await readRecord('rp_hub_stream_probe_000');
    const last = await readRecord(`rp_hub_stream_probe_${String(recordTotal - 1).padStart(3, '0')}`);
    assertEqual(first?.index, 0, 'large staged pull lost its first record');
    assertEqual(last?.index, recordTotal - 1, 'large staged pull lost its last record');
    assertEqual(first?.payload?.length, payloadBytes, 'large staged pull truncated its first record');
    assertEqual(last?.payload?.length, payloadBytes, 'large staged pull truncated its last record');
    assertEqual(localStorage.getItem('rp_hub_stream_probe_setting'), 'large-round-trip',
        'large staged pull lost localStorage data');
    delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
    api.state.syncing = false;
    api.state.reloadPending = false;
}

async function testBridgeAndPullIsolation() {
    delete globalThis.RPH_R2_FLUSH_PERSISTENCE;
    const missingBridgeError = await captureRejection(api.flushAppState(), 'missing persistence bridge');
    assert(/缺少持久化同步桥/.test(missingBridgeError.message), 'missing bridge was not a hard failure');

    globalThis.RPH_R2_FLUSH_PERSISTENCE = async () => {
        throw new Error('bridge exploded');
    };
    const throwingBridgeError = await captureRejection(api.flushAppState(), 'throwing persistence bridge');
    assertEqual(throwingBridgeError.message, 'bridge exploded', 'bridge error was swallowed or rewritten');

    let remoteBytes = new TextEncoder().encode(JSON.stringify({
        schemaVersion: 3,
        localStorage: [],
        indexedDB: [{
            name: 'RPHubDB',
            version: 1,
            stores: [legacyStoreDefinition([
                { uuid: 'duplicate', name: 'one' },
                { uuid: 'duplicate', name: 'two' }
            ])]
        }]
    }));
    let remoteChecksum = await sha256Bytes(remoteBytes);
    let explicitLegacyFormat = true;
    let bridgeCalls = 0;
    let reloadScheduled = 0;
    const actions = [];
    globalThis.RPH_R2_FLUSH_PERSISTENCE = async () => {
        bridgeCalls += 1;
        throw new Error('pull must never invoke this bridge');
    };
    const nativeFetch = globalThis.fetch;
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.fetch = async (_input, init) => {
        const payload = JSON.parse(init.body);
        actions.push(payload.action);
        if (payload.action === 'pull-manifest') {
            const remote = {
                version: 1,
                mode: 'r2-chunk-manifest-v1',
                chunkSize: 2 * 1024 * 1024,
                chunkCount: 1,
                totalBytes: remoteBytes.byteLength,
                checksum: remoteChecksum,
                chunkManifest: [{ index: 0, checksum: remoteChecksum, length: remoteBytes.byteLength }]
            };
            if (explicitLegacyFormat) {
                remote.snapshotFormat = 'rp-sync-json-v3';
                remote.schemaVersion = 3;
            }
            return jsonResponse({
                ok: true,
                remote
            });
        }
        if (payload.action === 'pull-json-part') {
            return new Response(remoteBytes, {
                status: 200,
                headers: { 'x-rp-sync-byte-length': String(remoteBytes.byteLength) }
            });
        }
        throw new Error(`unexpected pull action ${payload.action}`);
    };
    globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 700) {
            reloadScheduled += 1;
            return 2_147_483_000;
        }
        return nativeSetTimeout(callback, delay, ...args);
    };
    try {
        await api.pullFromServer();
        assert(globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS !== true,
            'failed pull left the restore flag enabled');
        assertEqual(reloadScheduled, 0, 'failed pull scheduled a reload');
        assert(/UUID 重复/.test(api.state.statusText), 'failed pull did not report the restore validation error');

        remoteBytes = new TextEncoder().encode(JSON.stringify({
            schemaVersion: 3,
            localStorage: [],
            indexedDB: []
        }));
        remoteChecksum = await sha256Bytes(remoteBytes);
        explicitLegacyFormat = false;
        await api.pullFromServer();
    } finally {
        globalThis.fetch = nativeFetch;
        globalThis.setTimeout = nativeSetTimeout;
    }

    assertEqual(bridgeCalls, 0, 'pull invoked the persistence bridge');
    assertDeepEqual(actions, [
        'pull-manifest', 'pull-json-part',
        'pull-manifest', 'pull-json-part'
    ], 'pull did not execute the expected restore paths');
    assertEqual(reloadScheduled, 1, 'successful pull did not schedule exactly one reload');
    assertEqual(globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS, true,
        'successful pull did not keep the restore flag until reload');
    assert(/页面即将刷新/.test(api.state.statusText), 'successful pull did not reach restore completion');
    delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
    api.state.syncing = false;
    api.state.reloadPending = false;
}

async function testPushSelfCheckAndConflictWorkflow() {
    let bridgeCalls = 0;
    let networkCalls = 0;
    delete globalThis.RPHubCharStore;
    globalThis.RPH_R2_FLUSH_PERSISTENCE = async () => { bridgeCalls += 1; };
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        networkCalls += 1;
        throw new Error('network must not run before self-check');
    };
    try {
        await api.pushToServer();
    } finally {
        globalThis.fetch = nativeFetch;
    }
    assertEqual(bridgeCalls, 0, 'push called bridge after unavailable self-check');
    assertEqual(networkCalls, 0, 'push accessed network after unavailable self-check');
    assert(/角色卡存储自检不可用/.test(api.state.statusText), 'unavailable self-check did not block push');

    await deleteRPHubDatabase();
    await seedRecords([
        ['rp_hub_character_card-a', { uuid: 'card-a', name: 'A' }],
        ['rp_hub_character_index', { order: ['card-a'] }]
    ]);
    localStorage.setItem('rp_hub_behavior_test', 'same snapshot');

    const events = [];
    const createPayloads = [];
    const completePayloads = [];
    const partBodies = [];
    let createCount = 0;
    let completeCount = 0;
    globalThis.__bootstrapScanProfiles = [];
    globalThis.__bootstrapIterateSnapshotProfiles = [];
    globalThis.RPHubCharStore = {
        async assertPushAllowed() { events.push('self-check'); }
    };
    globalThis.RPH_R2_FLUSH_PERSISTENCE = async () => { events.push('bridge'); };
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), location.href);
        if (url.searchParams.get('action') === 'upload-part') {
            events.push('upload-part');
            partBodies.push(new TextDecoder().decode(init.body));
            return jsonResponse({
                ok: true,
                partNumber: Number(url.searchParams.get('partNumber')),
                key: `part-${url.searchParams.get('index')}`
            });
        }

        const payload = JSON.parse(init.body);
        events.push(payload.action);
        if (payload.action === 'pull-manifest') {
            const latest = createPayloads.at(-1);
            return jsonResponse({
                ok: true,
                remote: {
                    checksum: completeCount >= 4 ? latest?.checksum || 'different' : 'different',
                    version: completeCount >= 4 ? 44 : 40,
                    snapshotFormat: 'rp-sync-jsonl-v1',
                    schemaVersion: 4
                }
            });
        }
        if (payload.action === 'upload-create') {
            createPayloads.push(payload);
            const previousVersion = 40 + createCount;
            createCount += 1;
            return jsonResponse({ ok: true, previousVersion, missingIndices: [0] });
        }
        if (payload.action === 'upload-complete') {
            completePayloads.push(payload);
            completeCount += 1;
            if (completeCount <= 3) return jsonResponse({ ok: false, error: 'simulated conflict' }, 409);
            return jsonResponse({ ok: true, version: 44 });
        }
        throw new Error(`unexpected push action ${payload.action}`);
    };

    try {
        await api.pushToServer();
    } finally {
        globalThis.fetch = nativeFetch;
        localStorage.removeItem('rp_hub_behavior_test');
    }

    assertDeepEqual(events, [
        'self-check', 'bridge', 'pull-manifest',
        'upload-create', 'upload-part', 'upload-complete',
        'upload-create', 'upload-part', 'upload-complete',
        'upload-create', 'upload-part', 'upload-complete',
        'upload-create', 'upload-part', 'upload-complete', 'pull-manifest'
    ], 'push did not run self-check first or retry the complete workflow');
    assertDeepEqual(globalThis.__bootstrapScanProfiles, ['cdc'],
        'push performed more than one manifest scan before upload');
    assertEqual(globalThis.__bootstrapIterateSnapshotProfiles.length, 5,
        'push did not rescan the local stream for each upload session');
    assertEqual(createPayloads.length, 4, '409 handling did not perform first attempt plus three retries');
    assertEqual(completePayloads.length, 4, '409 handling did not retry upload-complete three times');
    assertEqual(partBodies.length, 4, '409 handling did not revisit missing parts for every new session');
    assert(createPayloads.every((payload) => payload.checksum === createPayloads[0].checksum),
        '409 retries did not reuse the snapshot checksum');
    assert(createPayloads.every((payload) => payload.totalBytes === createPayloads[0].totalBytes),
        '409 retries did not reuse the snapshot byte length');
    assert(partBodies.every((body) => body === partBodies[0]), '409 retries uploaded different snapshot bytes');
    assertDeepEqual(completePayloads.map((payload) => payload.expectedVersion), [40, 41, 42, 43],
        'upload-complete did not use each new session previousVersion');
    assert(completePayloads.every((payload) => payload.checksum === createPayloads[0].checksum),
        'upload-complete checksum diverged from the reused snapshot');
    assertEqual(api.state.statusText, '上传成功。', 'push did not finish successfully after the fourth session');
}

async function testExternalizedStorageAssignmentGate() {
    assertEqual(window.RPHubStorage, undefined,
        'RPHubStorage accessor was not inert before an upstream assignment');
    const descriptor = Object.getOwnPropertyDescriptor(window, 'RPHubStorage');
    assert(descriptor?.configurable === true && descriptor?.enumerable === true,
        'RPHubStorage accessor descriptor is incompatible');

    const methodCalls = [];
    const cloneInputs = [];
    const writeMethod = (name) => function (...args) {
        methodCalls.push({ name, args, thisValue: this });
        return Promise.resolve(name);
    };
    const originalStorage = {
        marker: 'first-assignment',
        cloneForStorage(value) {
            cloneInputs.push(value);
            return structuredClone(value);
        },
        initDB() {},
        getMainDb() {},
        setStoredValue: writeMethod('setStoredValue'),
        setScopedStoredValue: writeMethod('setScopedStoredValue'),
        deleteStoredValue: writeMethod('deleteStoredValue'),
        deleteScopedStoredValue: writeMethod('deleteScopedStoredValue'),
        deleteStorageKeys: writeMethod('deleteStorageKeys')
    };
    Object.defineProperty(originalStorage, 'hiddenReadPath', {
        enumerable: false,
        value: () => 'preserved'
    });
    Object.freeze(originalStorage);
    window.RPHubStorage = originalStorage;

    const wrapped = window.RPHubStorage;
    assert(wrapped !== originalStorage, 'RPHubStorage assignment was not wrapped');
    assert(Object.isFrozen(wrapped), 'wrapped RPHubStorage was not frozen');
    assertEqual(wrapped.marker, 'first-assignment', 'ordinary storage property was lost');
    assertEqual(wrapped.initDB, originalStorage.initDB, 'read path was not passed through');
    assertEqual(wrapped.hiddenReadPath(), 'preserved', 'non-enumerable storage property was lost');
    assertEqual(Object.prototype.propertyIsEnumerable.call(wrapped, 'hiddenReadPath'), false,
        'non-enumerable storage property changed enumerability');

    const directResult = await wrapped.setStoredValue('settings', { mode: 'direct' });
    assertEqual(directResult, 'setStoredValue', 'direct set result was not passed through');
    assertEqual(methodCalls.length, 1, 'direct set did not call the original method once');
    assertEqual(methodCalls[0].thisValue, originalStorage,
        'direct set did not bind this to the original storage object');
    assertEqual(cloneInputs.length, 0, 'direct set unexpectedly cloned before pass-through');

    const snapshotValue = { nested: { value: 1 } };
    const noCloneValue = { nested: { value: 10 } };
    globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
    let snapshotSettled = false;
    const snapshotWrite = wrapped.setStoredValue('settings', snapshotValue, { source: 'snapshot' })
        .then((value) => {
            snapshotSettled = true;
            return value;
        });
    const noCloneWrite = wrapped.setScopedStoredValue('chat', 'card-a', noCloneValue, {
        clone: false,
        source: 'no-clone'
    });
    snapshotValue.nested.value = 2;
    noCloneValue.nested.value = 11;
    await Promise.resolve();
    assertEqual(methodCalls.length, 1, 'set method wrote directly during restore');
    assertEqual(snapshotSettled, false, 'deferred set settled before queue release');
    assertEqual(cloneInputs.length, 1, 'default set path did not snapshot exactly once');

    delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
    await api.releaseDeferredPersistenceWrites();
    await Promise.all([snapshotWrite, noCloneWrite]);
    assertEqual(methodCalls.length, 3, 'deferred set methods were not replayed');
    const snapshotCall = methodCalls[1];
    const noCloneCall = methodCalls[2];
    assertEqual(snapshotCall.thisValue, originalStorage,
        'deferred set did not bind this to the original storage object');
    assertDeepEqual(snapshotCall.args[1], { nested: { value: 1 } },
        'deferred set did not preserve the call-time value snapshot');
    assertDeepEqual(snapshotCall.args[2], { source: 'snapshot', clone: false },
        'deferred set did not preserve options while disabling a second clone');
    assertEqual(noCloneCall.args[2].nested.value, 11,
        'clone:false set path did not retain the original value reference');
    assertDeepEqual(noCloneCall.args[3], { clone: false, source: 'no-clone' },
        'scoped set options changed during deferral');

    const deleteKeys = ['one', 'two'];
    globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
    const deleteStart = methodCalls.length;
    const deleteWrites = [
        wrapped.deleteStoredValue('settings'),
        wrapped.deleteScopedStoredValue('chat', 'card-a'),
        wrapped.deleteStorageKeys({ name: 'db' }, deleteKeys)
    ];
    await Promise.resolve();
    assertEqual(methodCalls.length, deleteStart, 'delete method wrote directly during restore');
    delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
    await api.releaseDeferredPersistenceWrites();
    await Promise.all(deleteWrites);
    assertDeepEqual(methodCalls.slice(deleteStart).map((entry) => entry.name), [
        'deleteStoredValue',
        'deleteScopedStoredValue',
        'deleteStorageKeys'
    ], 'delete methods were not replayed in queue order');
    assertEqual(methodCalls.at(-1).args[1], deleteKeys,
        'deleteStorageKeys did not replay the original keys argument');

    const nativeDefer = globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE;
    delete globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE;
    globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
    const unavailableError = await captureRejection(
        wrapped.setStoredValue('settings', { blocked: true }),
        'missing externalized storage defer queue'
    );
    assertEqual(unavailableError.message, 'RP Sync 恢复写入队列不可用，已停止持久化。',
        'missing queue rejection message changed');
    globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE = nativeDefer;
    delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;

    window.RPHubStorage = { ...originalStorage, marker: 'second-assignment' };
    assert(window.RPHubStorage !== wrapped, 'a repeated RPHubStorage assignment reused the old wrapper');
    assertEqual(window.RPHubStorage.marker, 'second-assignment',
        'a repeated RPHubStorage assignment did not wrap the new value');

    await deleteRPHubDatabase();
    globalThis.Vue = {};
    await loadScript('./data-services-storage-1.8.1.js');
    const storage = window.RPHubStorage;
    assert(Object.isFrozen(storage), 'actual 1.8.1 RPHubStorage export was not frozen after wrapping');
    for (const methodName of [
        'cloneForStorage',
        'initDB',
        'getMainDb',
        'getStoredValue',
        'setStoredValue',
        'setScopedStoredValue',
        'deleteStoredValue',
        'deleteScopedStoredValue',
        'deleteStorageKeys'
    ]) {
        assert(typeof storage[methodName] === 'function', `1.8.1 storage method was lost: ${methodName}`);
    }

    await storage.initDB();
    const seedSettings = { theme: 'seed', nested: { version: 1 } };
    const seedChat = [{ role: 'assistant', content: 'seed chat' }];
    await storage.setStoredValue('settings', seedSettings);
    await storage.setScopedStoredValue('chat', 'card-a', seedChat);
    assertDeepEqual(await storage.getStoredValue('settings'), seedSettings,
        'normal 1.8.1 settings write was not readable');
    assertDeepEqual(await storage.getScopedStoredValue('chat', 'card-a'), seedChat,
        'normal 1.8.1 scoped chat write was not readable');

    const { setStoredValue } = storage;
    const deferredSettings = { theme: 'deferred', nested: { version: 2 } };
    globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
    let actualWriteSettled = false;
    const actualWrite = setStoredValue('settings', deferredSettings).then(() => {
        actualWriteSettled = true;
    });
    deferredSettings.nested.version = 999;
    await wait(10);
    assertEqual(actualWriteSettled, false,
        'destructured 1.8.1 setStoredValue settled during restore');
    assertDeepEqual(await storage.getStoredValue('settings'), seedSettings,
        'destructured 1.8.1 setStoredValue wrote during restore');

    delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
    await api.releaseDeferredPersistenceWrites();
    await actualWrite;
    assertDeepEqual(await storage.getStoredValue('settings'), {
        theme: 'deferred',
        nested: { version: 2 }
    }, 'deferred 1.8.1 settings write did not land with its call-time snapshot');

    const dailySettings = { theme: 'daily', saved: true };
    await storage.setStoredValue('settings', dailySettings);
    assertDeepEqual(await storage.getStoredValue('settings'), dailySettings,
        'normal 1.8.1 storage stopped working after a deferred restore write');
    storage.getMainDb()?.close();
    delete globalThis.Vue;
}

async function testDeferredWritesAcrossPullOutcomes() {
    assert(typeof globalThis.__RPH_TEST_DB_SET_TO === 'function', 'patched dbSetTo fixture is unavailable');
    assert(typeof globalThis.__RPH_TEST_DB_DELETE_FROM === 'function', 'patched dbDeleteFrom fixture is unavailable');

    await deleteRPHubDatabase();
    await seedRecords([
        ['rp_hub_character_seed-card', { uuid: 'seed-card', name: 'seed' }],
        ['rp_hub_character_index', { order: ['seed-card'] }],
        ['delete-me', { value: 'must be deleted after failed restore' }]
    ]);
    await loadScript('../DB/char-store.js');
    await wait(20);

    const appDb = await openRPHubDatabase();
    const nativeFetch = globalThis.fetch;
    const nativeSetTimeout = globalThis.setTimeout;
    const nativePut = IDBObjectStore.prototype.put;
    let remoteBytes = null;
    let reloadScheduled = 0;
    let bridgeCalls = 0;

    globalThis.RPH_R2_FLUSH_PERSISTENCE = async () => {
        bridgeCalls += 1;
        throw new Error('pull must never invoke the persistence bridge');
    };
    globalThis.fetch = async (_input, init) => {
        const payload = JSON.parse(init.body);
        if (payload.action === 'pull-manifest') {
            return jsonResponse({
                ok: true,
                remote: { version: 2, chunkCount: 1, totalBytes: remoteBytes.byteLength, checksum: '' }
            });
        }
        if (payload.action === 'pull-json-part') {
            return new Response(remoteBytes, {
                status: 200,
                headers: { 'x-rp-sync-byte-length': String(remoteBytes.byteLength) }
            });
        }
        throw new Error(`unexpected pull action ${payload.action}`);
    };
    globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay === 700) {
            reloadScheduled += 1;
            return 2_147_483_000;
        }
        return nativeSetTimeout(callback, delay, ...args);
    };

    try {
        let failureWrites = null;
        let failureAbortQueued = false;
        IDBObjectStore.prototype.put = function failureRacePut(value, key) {
            const request = nativePut.apply(this, arguments);
            if (key === 'restore-trigger' && !failureWrites) {
                failureWrites = [
                    globalThis.__RPH_TEST_DB_SET_TO(
                        appDb,
                        'rp_hub_chat_pending-b',
                        [{ role: 'assistant', content: 'local deferred chat' }],
                        { clone: false }
                    ),
                    globalThis.__RPH_TEST_DB_DELETE_FROM(appDb, 'delete-me'),
                    globalThis.RPHubCharStore.saveAll([{ uuid: 'pending-a', name: 'first queued local card' }]),
                    globalThis.RPHubCharStore.saveAll([{ uuid: 'pending-b', name: 'latest queued local card' }])
                ];
            }
            if (key === 'restore-fail' && !failureAbortQueued) {
                failureAbortQueued = true;
                queueMicrotask(() => {
                    try { this.transaction.abort(); } catch (_) { }
                });
            }
            return request;
        };
        remoteBytes = new TextEncoder().encode(JSON.stringify({
            schemaVersion: 3,
            localStorage: [],
            indexedDB: [{
                name: 'RPHubDB',
                version: 1,
                stores: [{
                    name: 'store',
                    keyPath: null,
                    autoIncrement: false,
                    records: [
                        { key: 'restore-trigger', value: { source: 'remote' } },
                        { key: 'restore-fail', value: { source: 'abort transaction' } }
                    ]
                }]
            }]
        }));

        await api.pullFromServer();
        assert(failureWrites && failureWrites.length === 4, 'failed restore did not queue all pending writes');
        await Promise.all(failureWrites);
        assert(globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS !== true,
            'failed restore did not clear the pull flag');
        assertEqual(reloadScheduled, 0, 'failed restore scheduled a reload');
        assertEqual(await readRecord('restore-trigger'), undefined,
            'aborted restore committed a remote record');
        assertEqual(await readRecord('delete-me'), undefined,
            'deferred dbDeleteFrom did not run after restore failure');
        assertDeepEqual(await readRecord('rp_hub_chat_pending-b'),
            [{ role: 'assistant', content: 'local deferred chat' }],
            'deferred dbSetTo did not run after restore failure');
        assertDeepEqual((await readRecord('rp_hub_character_index')).order, ['pending-b'],
            'queued char-store writes were not fully drained after restore failure');
        assertEqual((await readRecord('rp_hub_character_pending-b')).name, 'latest queued local card',
            'latest queued char-store write was not persisted after restore failure');

        let successWrites = null;
        const settled = { set: false, delete: false, charFirst: false, charSecond: false };
        IDBObjectStore.prototype.put = function successRacePut(value, key) {
            const request = nativePut.apply(this, arguments);
            if (key === 'rp_hub_chat_remote-card' && !successWrites) {
                successWrites = [
                    globalThis.__RPH_TEST_DB_SET_TO(
                        appDb,
                        'rp_hub_chat_remote-card',
                        [{ role: 'assistant', content: 'stale local chat' }],
                        { clone: false }
                    ),
                    globalThis.__RPH_TEST_DB_DELETE_FROM(appDb, 'remote-delete-target'),
                    globalThis.RPHubCharStore.saveAll([{ uuid: 'stale-a', name: 'stale local card A' }]),
                    globalThis.RPHubCharStore.saveAll([{ uuid: 'stale-b', name: 'stale local card B' }])
                ];
                successWrites[0].then(() => { settled.set = true; }, () => { settled.set = true; });
                successWrites[1].then(() => { settled.delete = true; }, () => { settled.delete = true; });
                successWrites[2].then(() => { settled.charFirst = true; }, () => { settled.charFirst = true; });
                successWrites[3].then(() => { settled.charSecond = true; }, () => { settled.charSecond = true; });
            }
            return request;
        };
        remoteBytes = new TextEncoder().encode(JSON.stringify({
            schemaVersion: 3,
            localStorage: [],
            indexedDB: [{
                name: 'RPHubDB',
                version: 1,
                stores: [{
                    name: 'store',
                    keyPath: null,
                    autoIncrement: false,
                    records: [
                        { key: 'rp_hub_character_remote-card', value: { uuid: 'remote-card', name: 'remote card' } },
                        { key: 'rp_hub_character_index', value: { order: ['remote-card'] } },
                        { key: 'remote-delete-target', value: { source: 'remote must remain' } },
                        { key: 'rp_hub_chat_remote-card', value: [{ role: 'assistant', content: 'remote chat' }] }
                    ]
                }]
            }]
        }));

        await api.pullFromServer();
        await wait(20);
        assert(successWrites && successWrites.length === 4, 'successful restore did not encounter pending writes');
        assertEqual(globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS, true,
            'successful restore did not retain the pull flag');
        assertEqual(reloadScheduled, 1, 'successful restore did not schedule one reload');
        assertDeepEqual(settled, { set: false, delete: false, charFirst: false, charSecond: false },
            'successful restore released a deferred local write before reload');
        assertDeepEqual(await readRecord('rp_hub_chat_remote-card'),
            [{ role: 'assistant', content: 'remote chat' }],
            'deferred dbSetTo overwrote restored remote data');
        assertDeepEqual(await readRecord('remote-delete-target'), { source: 'remote must remain' },
            'deferred dbDeleteFrom removed restored remote data');
        assertDeepEqual((await readRecord('rp_hub_character_index')).order, ['remote-card'],
            'deferred char-store save replaced the restored character index');
        assertEqual((await readRecord('rp_hub_character_remote-card')).name, 'remote card',
            'deferred char-store save replaced the restored character record');
        assertEqual(await readRecord('rp_hub_character_stale-a'), undefined,
            'a deferred char-store record was written during successful restore');
    } finally {
        IDBObjectStore.prototype.put = nativePut;
        globalThis.fetch = nativeFetch;
        globalThis.setTimeout = nativeSetTimeout;
        appDb.close();
    }

    assertEqual(bridgeCalls, 0, 'pull race path invoked the persistence bridge');
}

async function run() {
    assert(api, 'bootstrap test exports were not injected');
    globalThis.__bootstrapTestPhase = 'legacy expansion';
    await testLegacyExpansionAndAtomicValidation();
    globalThis.__bootstrapTestPhase = 'per-put rollback';
    await testPerPutFailureRollsBack();
    globalThis.__bootstrapTestPhase = 'record size guard';
    await testRecordSizeGuard();
    globalThis.__bootstrapTestPhase = 'CDC chunking';
    await testCdcPropertiesAndLocality();
    globalThis.__bootstrapTestPhase = 'v4 pull compatibility and staging';
    await testV4PullCompatibilityAndValidation();
    globalThis.__bootstrapTestPhase = '64MiB streaming round trip';
    await testLargeStreamingRoundTrip();
    globalThis.__bootstrapTestPhase = 'bridge and pull isolation';
    await testBridgeAndPullIsolation();
    globalThis.__bootstrapTestPhase = 'push conflict workflow';
    await testPushSelfCheckAndConflictWorkflow();
    globalThis.__bootstrapTestPhase = '1.8.1 externalized storage gate';
    await testExternalizedStorageAssignmentGate();
    globalThis.__bootstrapTestPhase = 'deferred pull writes';
    await testDeferredWritesAcrossPullOutcomes();
    finish('pass', 'legacy split, atomic restore, externalized storage gating, CAS retry, and pull write deferral');
}

try {
    await run();
} catch (error) {
    console.error(error);
    const idbDetail = globalThis.__bootstrapIdbHandlerError
        ? `\nIndexedDB handler: ${globalThis.__bootstrapIdbHandlerError}`
        : '';
    finish('fail', `[${globalThis.__bootstrapTestPhase || 'startup'}] ${error?.stack || error?.message || String(error)}${idbDetail}`);
}
