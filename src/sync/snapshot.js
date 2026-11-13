    async function sha256(text) {
        return sha256Bytes(new TextEncoder().encode(text));
    }

    async function transformBytes(bytes, stream) {
        return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
    }

    const gzipBytes = (bytes) => transformBytes(bytes, new CompressionStream('gzip'));
    const gunzipBytes = (bytes) => transformBytes(bytes, new DecompressionStream('gzip'));

    async function sha256Bytes(bytes) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    function serializeSnapshotLine(value) {
        const json = JSON.stringify(value);
        if (typeof json !== 'string') throw new Error('本地数据包含无法序列化的内容。');
        return `${json}\n`;
    }

    const snapshotEncoder = new TextEncoder();

    function serializeStreamRecord(metadata, key, value) {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== 'string') throw new Error(`记录 ${String(key)} 无法序列化。`);
        const prefix = JSON.stringify(metadata).slice(0, -1) + ',"value":';
        // toJSON may depend on its key; retain the old semantics for it.
        if (value && typeof value.toJSON === 'function') {
            checkStreamRecordSize(key, snapshotEncoder.encode(serialized).byteLength);
            return snapshotEncoder.encode(serializeSnapshotLine({ ...metadata, value }));
        }
        const bytes = snapshotEncoder.encode(prefix + serialized + '}\n');
        checkStreamRecordSize(key, bytes.byteLength - snapshotEncoder.encode(prefix).byteLength - 2);
        return bytes;
    }

    function checkStreamRecordSize(key, size) {
        if (size > CONFIG.maxRecordBytes) {
            throw new Error(`上传已取消：记录 ${String(key)} 约 ${(size / 1024 / 1024).toFixed(2)}MB，超过 Chrome/Edge/安卓浏览器能存的单条上限（127MB），同步到那些设备会失败。`);
        }
        if (size > CONFIG.warnRecordBytes) {
            console.warn(`[RP Sync] Large record ${String(key)}: ${(size / 1024 / 1024).toFixed(2)}MB`);
        }
    }

    // ---- 快照流按「单元」生成 ----
    // 单元：本机设置一段（ls）、每个库的开头（db）、每条记录（rec）、每个表的结尾（se）、每个库的结尾（de）、整个快照的结尾（end）。
    // 单元在流里的先后顺序固定：本机设置最前，然后按 CONFIG.knownDatabases 的顺序每个库，库里按表、表里按键的顺序。
    // 快速上传只重新生成改过的单元附近，所以要能按位置比较单元，也要能只生成两个位置之间的单元。
    function unitOrder(ref) {
        if (ref.k === 'ls') return [-1, 0, 0];
        if (ref.k === 'end') return [Infinity, 0, 0];
        const dbIndex = CONFIG.knownDatabases.findIndex((dbDef) => dbDef.name === ref.d);
        if (ref.k === 'db') return [dbIndex, -1, 0];
        if (ref.k === 'de') return [dbIndex, Infinity, 0];
        const storeIndex = CONFIG.knownDatabases[dbIndex]?.stores.indexOf(ref.s) ?? -1;
        // 表里：ss（表的开头，只用来比较）< 记录 < se（表的结尾）
        if (ref.k === 'ss') return [dbIndex, storeIndex, -1];
        if (ref.k === 'se') return [dbIndex, storeIndex, 1];
        return [dbIndex, storeIndex, 0, ref.key];
    }

    function compareUnits(a, b) {
        const x = unitOrder(a);
        const y = unitOrder(b);
        for (let index = 0; index < 3; index += 1) {
            if (x[index] !== y[index]) return x[index] < y[index] ? -1 : 1;
        }
        return x.length === 4 && y.length === 4 ? indexedDB.cmp(x[3], y[3]) : 0;
    }

    function recordLines(dbName, storeName, record) {
        if (!Array.isArray(record.value)) {
            return [serializeStreamRecord({ type: 'record', database: dbName, store: storeName, key: record.key }, record.key, record.value)];
        }
        const lines = [serializeSnapshotLine({ type: 'recordArrayStart', database: dbName, store: storeName, key: record.key, length: record.value.length })];
        for (let index = 0; index < record.value.length; index += 1) {
            const value = Object.prototype.hasOwnProperty.call(record.value, index) ? record.value[index] : null;
            lines.push(serializeStreamRecord({ type: 'recordArrayItem', database: dbName, store: storeName, index }, `${String(record.key)}[${index}]`, value));
        }
        lines.push(serializeSnapshotLine({ type: 'recordArrayEnd', database: dbName, store: storeName }));
        return lines;
    }

    // 生成 start（含，可以从这个单元的第 line 行起）到 stop（不含；stop.line > 0 时含 stop 单元的前几行）之间的单元；都不传就是整个快照。
    // 结尾那行要写记录总数，由 recordCount() 给。只取了一部分行的单元，firstLine 记它从整个单元的第几行起。
    async function* iterateSnapshotUnits(bounds = {}) {
        const { start, stop } = bounds;
        const behind = (ref) => Boolean(start) && compareUnits(ref, start.ref) < 0;
        const beyond = (ref) => Boolean(stop) && (compareUnits(ref, stop.ref) > 0 || (stop.line === 0 && compareUnits(ref, stop.ref) === 0));
        const inRange = (ref) => !behind(ref) && !beyond(ref);
        const unit = (ref, lines, records = 0) => {
            const firstLine = start && compareUnits(ref, start.ref) === 0 ? start.line : 0;
            const lastLine = stop && compareUnits(ref, stop.ref) === 0 ? stop.line : lines.length;
            // 记录数算在它第一行所在的那一块上：从中间开始的单元这里不算
            return { ref, firstLine, lines: lines.slice(firstLine, lastLine), records: firstLine > 0 ? 0 : records };
        };

        const localRef = { k: 'ls' };
        if (inRange(localRef)) {
            const entries = bounds.localEntries || readLocalStorageSnapshot();
            yield unit(localRef, [
                serializeSnapshotLine({ type: 'snapshot', format: SNAPSHOT_FORMAT, schemaVersion: SNAPSHOT_SCHEMA_VERSION, workshopVersion: 1 }),
                ...entries.map((entry) => serializeSnapshotLine({ type: 'localStorage', key: entry.key, value: entry.value })),
                serializeSnapshotLine({ type: 'localStorageEnd' })
            ], entries.length);
        }

        for (const dbName of await listIndexedDbNames()) {
            const knownDb = CONFIG.knownDatabases.find((dbDef) => dbDef.name === dbName);
            if (!knownDb || behind({ k: 'de', d: dbName }) || beyond({ k: 'db', d: dbName })) continue;

            let db = null;
            try {
                db = await openDbByName(dbName);
                const storeNames = knownDb.stores.filter((name) => db.objectStoreNames.contains(name));
                if (storeNames.length === 0) continue;
                const stores = readStoreDefinitions(db, storeNames);
                const dbRef = { k: 'db', d: dbName };
                if (inRange(dbRef)) yield unit(dbRef, [serializeSnapshotLine({ type: 'database', name: dbName, version: db.version, stores })]);

                for (const storeDef of stores) {
                    const storeName = storeDef.name;
                    // 记录不逐条判断位置，整表看：表尾不晚于起点，记录都在起点之前；表头不早于终点，记录都在终点之后
                    if (!(start && compareUnits({ k: 'se', d: dbName, s: storeName }, start.ref) <= 0) && !beyond({ k: 'ss', d: dbName, s: storeName })) {
                        const sameStore = (ref) => ref?.k === 'rec' && ref.d === dbName && ref.s === storeName;
                        const lower = sameStore(start?.ref) ? start.ref.key : undefined;
                        const upper = sameStore(stop?.ref) ? stop.ref.key : undefined;
                        // 起点那条记录整条都在上一块里时不用再读它
                        for await (const record of iterateObjectStoreRecords(db, storeName, lower, upper, !(stop?.line > 0), start?.line === Infinity)) {
                            yield unit({ k: 'rec', d: dbName, s: storeName, key: record.key }, recordLines(dbName, storeName, record), 1);
                        }
                    }
                    const storeEndRef = { k: 'se', d: dbName, s: storeName };
                    if (inRange(storeEndRef)) yield unit(storeEndRef, [serializeSnapshotLine({ type: 'storeEnd', database: dbName, store: storeName })]);
                }
                const dbEndRef = { k: 'de', d: dbName };
                if (inRange(dbEndRef)) yield unit(dbEndRef, [serializeSnapshotLine({ type: 'databaseEnd', name: dbName })]);
            } catch (error) {
                throw new Error(`读取本地数据库 ${dbName} 失败，已取消上传以避免云端数据缺失。`, { cause: error });
            } finally {
                if (db) db.close();
            }
        }

        const endRef = { k: 'end' };
        if (inRange(endRef)) yield unit(endRef, [serializeSnapshotLine({ type: 'snapshotEnd', recordCount: bounds.recordCount() })]);
    }

    // 整个快照一行一行地给（测试用）
    async function* iterateSnapshotLines(stats) {
        for await (const unit of iterateSnapshotUnits({ recordCount: () => stats.recordCount })) {
            stats.recordCount += unit.records;
            yield* unit.lines;
        }
    }

    function fnv1a32(bytes) {
        let hash = FNV1A_OFFSET_BASIS;
        for (const byte of bytes) {
            hash = Math.imul(hash ^ byte, FNV1A_PRIME) >>> 0;
        }
        return hash >>> 0;
    }

    class CdcChunkingError extends Error {
        constructor(message, options) {
            super(message, options);
            this.name = 'CdcChunkingError';
        }
    }

    class SnapshotChunkWriter {
        constructor(profile, targetBytes, hardMaxBytes) {
            this.profile = profile;
            this.targetBytes = targetBytes;
            this.hardMaxBytes = hardMaxBytes;
            this.encoder = new TextEncoder();
            this.bufferParts = [];
            this.bufferLength = 0;
            this.totalBytes = 0;
        }

        appendBuffer(bytes) {
            if (bytes.byteLength === 0) return;
            this.bufferParts.push(bytes);
            this.bufferLength += bytes.byteLength;
        }

        flushBuffer(completed) {
            if (this.bufferLength === 0) return;
            if (this.bufferLength > this.hardMaxBytes) {
                throw new CdcChunkingError('CDC 生成了越界块。');
            }
            const bytes = new Uint8Array(this.bufferLength);
            let offset = 0;
            for (const part of this.bufferParts) {
                bytes.set(part, offset);
                offset += part.byteLength;
            }
            this.bufferParts = [];
            this.bufferLength = 0;
            completed.push(bytes);
        }

        appendFixed(bytes, completed) {
            let offset = 0;
            while (offset < bytes.byteLength) {
                const available = this.hardMaxBytes - this.bufferLength;
                const length = Math.min(available, bytes.byteLength - offset);
                this.appendBuffer(bytes.subarray(offset, offset + length));
                offset += length;
                if (this.bufferLength === this.hardMaxBytes) this.flushBuffer(completed);
            }
        }

        appendCdc(bytes, completed) {
            if (bytes.byteLength >= this.hardMaxBytes) {
                this.flushBuffer(completed);
                for (let offset = 0; offset < bytes.byteLength; offset += this.hardMaxBytes) {
                    const end = Math.min(offset + this.hardMaxBytes, bytes.byteLength);
                    completed.push(bytes.slice(offset, end));
                }
                return;
            }

            if (this.bufferLength > 0 && this.bufferLength + bytes.byteLength > this.hardMaxBytes) {
                this.flushBuffer(completed);
            }
            this.appendBuffer(bytes);
            const threshold = bytes.byteLength >= this.targetBytes
                ? UINT32_RANGE
                : Math.floor((bytes.byteLength / this.targetBytes) * UINT32_RANGE);
            if (this.bufferLength >= this.hardMaxBytes || fnv1a32(bytes) < threshold) {
                this.flushBuffer(completed);
            }
        }

        appendLine(text) {
            const bytes = text instanceof Uint8Array ? text : this.encoder.encode(text);
            this.totalBytes += bytes.byteLength;
            const completed = [];
            if (this.profile === 'fixed') {
                this.appendFixed(bytes, completed);
            } else {
                this.appendCdc(bytes, completed);
            }
            return completed;
        }

        finish() {
            const completed = [];
            this.flushBuffer(completed);
            return completed;
        }
    }

    // 把单元切成分片。每一块记下它从哪个单元开始（from）、到哪个单元结束（to）、有多少条记录从它开始（records）：
    // 快速上传沿用没改的块时，靠这些找改过的键在哪一块、把没改的块的记录数加进总数。bounds 见 iterateSnapshotUnits。
    async function* iterateSnapshotChunks(stats, profile = 'cdc', bounds = {}) {
        const hardMaxBytes = profile === 'fixed' ? LEGACY_FIXED_CHUNK_BYTES : CDC_HARD_MAX_BYTES;
        const writer = new SnapshotChunkWriter(profile, CONFIG.chunkSize, hardMaxBytes);
        let index = 0;
        let chunkStart = 0;
        let from = null; // 当前缓冲区第一条线所属的单元和它在单元里的行号
        let lastRef = null;
        const starts = []; // 还没归到哪一块的记录起点：[字节位置, 记录数]
        const emit = (bytes, ref, lineStart, lineIndex) => {
            if (bytes.byteLength <= 0 || bytes.byteLength > hardMaxBytes) throw new CdcChunkingError('CDC 生成了越界块。');
            const chunkEnd = chunkStart + bytes.byteLength;
            let records = 0;
            while (starts.length && starts[0][0] < chunkEnd) records += starts.shift()[1];
            const chunk = {
                index, bytes, length: bytes.byteLength, records,
                from: from ? from.ref : ref, fromLine: from ? from.line : lineIndex,
                to: chunkEnd <= lineStart ? lastRef : ref,
                splitLine: chunkEnd > lineStart && chunkEnd < writer.totalBytes // 一条超大的线被切开了，后面的块接着这条线
            };
            chunkStart = chunkEnd;
            from = chunkEnd < writer.totalBytes ? { ref, line: lineIndex } : null; // 这条线还有字节没进块，下一块从它开始
            index += 1;
            if (index > 10_000) throw new CdcChunkingError('CDC 块数量超过10000。');
            return chunk;
        };

        for await (const unit of iterateSnapshotUnits({ ...bounds, recordCount: bounds.recordCount || (() => stats.recordCount) })) {
            if (unit.records) starts.push([writer.totalBytes, unit.records]);
            stats.recordCount += unit.records;
            for (const [offset, line] of unit.lines.entries()) {
                const lineIndex = unit.firstLine + offset;
                const lineStart = writer.totalBytes;
                if (from === null) from = { ref: unit.ref, line: lineIndex };
                let completed;
                try {
                    completed = writer.appendLine(line);
                } catch (error) {
                    if (profile === 'cdc' && !(error instanceof CdcChunkingError)) throw new CdcChunkingError('CDC 切块内部异常。', { cause: error });
                    throw error;
                }
                for (const bytes of completed) {
                    const chunk = emit(bytes, unit.ref, lineStart, lineIndex);
                    yield { ...chunk, checksum: await sha256Bytes(bytes) };
                    await wait(0);
                }
                lastRef = unit.ref;
            }
        }

        for (const bytes of writer.finish()) {
            const chunk = emit(bytes, lastRef, writer.totalBytes, 0);
            yield { ...chunk, checksum: await sha256Bytes(bytes) };
        }
        stats.totalBytes = writer.totalBytes;
        if (index === 0 && bounds.start === undefined && bounds.stop === undefined) throw new CdcChunkingError('本地快照没有生成有效分片。');
    }

    function buildStreamSnapshotChecksumSource(snapshot) {
        return JSON.stringify([
            SNAPSHOT_FORMAT,
            Number(snapshot.schemaVersion ?? SNAPSHOT_SCHEMA_VERSION),
            Number(snapshot.recordCount || 0),
            Number(snapshot.totalBytes || 0),
            snapshot.chunkManifest.map((chunk) => [String(chunk.checksum).toLowerCase(), Number(chunk.length)])
        ]);
    }

    function describeChunk(chunk) {
        return { checksum: chunk.checksum, length: chunk.length, records: chunk.records, from: chunk.from, fromLine: chunk.fromLine, to: chunk.to, splitLine: chunk.splitLine };
    }

    async function scanAllChunks(profile, localEntries) {
        const stats = { recordCount: 0, totalBytes: 0 };
        const chunks = [];
        for await (const chunk of iterateSnapshotChunks(stats, profile, { localEntries })) {
            chunks.push(describeChunk(chunk));
            updateProgress(16, `正在扫描本地数据，已处理 ${chunks.length} 个分片...`);
        }
        if (chunks.reduce((sum, chunk) => sum + chunk.length, 0) !== stats.totalBytes || chunks.length > 10_000) {
            throw new CdcChunkingError('CDC 块集合无法无损重组。');
        }
        return chunks;
    }

    // ---- 上次上传的分片布局：每块的校验码、长度、从它开始的记录数、起止单元（和行号）。数据几 GB 时有一两 MB，放 localStorage 会挤占官方页面的额度，所以存 IndexedDB ----
    const layoutSignature = () => JSON.stringify(CONFIG.knownDatabases.map((dbDef) => [dbDef.name, dbDef.stores]));

    // state 表放上次上传的分片布局；parts 表暂存这次要上传的分片（压缩好的），上传只从这里读，页面接着写也不影响这次上传；
    // uploaded 表记哪些分片已经传成功、什么时候传的（还没提交前断了，续传时跳过它们）。
    function syncStateStore(storeName, mode, operation) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(LAYOUT_DB, 2);
            request.onupgradeneeded = () => {
                for (const name of ['state', 'parts', 'uploaded']) {
                    if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
                }
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('RPHubSyncState blocked'));
            request.onsuccess = () => {
                const db = request.result;
                withStore(db, storeName, mode, operation)
                    .finally(() => db.close())
                    .then(result => resolve(result?.result), reject);
            };
        });
    }
    const layoutStore = (mode, operation) => syncStateStore('state', mode, operation);

    async function loadSyncLayout() {
        try {
            const layout = await layoutStore('readonly', (store) => store.get('layout'));
            if (layout?.v !== 1 || layout.format !== SNAPSHOT_FORMAT || layout.schema !== SNAPSHOT_SCHEMA_VERSION
                || layout.chunkSize !== CONFIG.chunkSize || layout.dbs !== layoutSignature()
                || !Array.isArray(layout.chunks) || !layout.chunks.length
                || layout.chunks.some((chunk) => typeof chunk.c !== 'string' || !Number.isInteger(chunk.l) || !Number.isInteger(chunk.r)
                    || !chunk.f?.k || !Number.isInteger(chunk.fl) || !chunk.t?.k)) {
                return null;
            }
            return layout;
        } catch (_) {
            return null;
        }
    }

    function discardSyncLayout() {
        return layoutStore('readwrite', (store) => store.delete('layout')).catch(() => {});
    }

    async function saveSyncLayout(plan) {
        if (plan.profile !== 'cdc') return discardSyncLayout();
        try {
            await layoutStore('readwrite', (store) => store.put({
                v: 1, format: SNAPSHOT_FORMAT, schema: SNAPSHOT_SCHEMA_VERSION, chunkSize: CONFIG.chunkSize, dbs: layoutSignature(),
                chunks: plan.chunks.map((chunk) => ({ c: chunk.checksum, l: chunk.length, r: chunk.records, f: chunk.from, fl: chunk.fromLine, t: chunk.to, ...(chunk.splitLine ? { sl: 1 } : {}) }))
            }, 'layout'));
        } catch (_) {
            await discardSyncLayout();
        }
    }

    // 要重做的块连成区域，相邻的合并。区域的边界是两头那两块没改的块的起点（单元 + 行号）：没改的记录跨块时只重做落在区域里的那几行，
    // 不牵连邻居；改过的记录跨了几块就整条重做；一条超大的线被切成几块的，整条重做。
    function mergeRegions(chunks, list, isDirty = () => false) {
        const sameUnit = (a, b) => Boolean(a && b) && a.k === b.k && compareUnits(a, b) === 0;
        const extended = list.map(({ start, end }) => {
            while (start > 0 && (chunks[start - 1].splitLine || (sameUnit(chunks[start - 1].to, chunks[start].from) && isDirty(chunks[start].from)))) start -= 1;
            while (end < chunks.length - 1 && (chunks[end].splitLine || (sameUnit(chunks[end].to, chunks[end + 1].from) && isDirty(chunks[end].to)))) end += 1;
            return { start, end };
        }).sort((a, b) => a.start - b.start);
        const merged = [];
        for (const region of extended) {
            const last = merged[merged.length - 1];
            if (last && region.start <= last.end + 1) last.end = Math.max(last.end, region.end);
            else merged.push({ start: region.start, end: region.end });
        }
        // 起点：上一块结束的地方之后——上一块的最后一个单元，跳过它已经写进上一块的那些行（整条都在上一块里就整条跳过），
        // 这样两块之间新加的键也在区域里。终点：下一块开始的地方——下一块的第一个单元，只到它进下一块之前的那些行。
        const after = (index) => {
            const previous = chunks[index - 1];
            return { ref: previous.to, line: sameUnit(previous.to, chunks[index].from) ? chunks[index].fromLine : Infinity };
        };
        return merged.map((region) => ({
            ...region,
            bounds: {
                start: region.start > 0 ? after(region.start) : undefined,
                stop: region.end < chunks.length - 1 ? { ref: chunks[region.end + 1].from, line: chunks[region.end + 1].fromLine } : undefined
            }
        }));
    }

    // 快速上传：按上次的布局找出改过的键在哪些块，只重新生成这些区域；其他块沿用上次的校验码。
    // 本机设置所在的第一块和写着记录总数的最后一块每次都重做。
    async function rebuildDirtyRegions(layout, tokens, localEntries) {
        const old = layout.chunks.map((chunk) => ({ checksum: chunk.c, length: chunk.l, records: chunk.r, from: chunk.f, fromLine: chunk.fl, to: chunk.t, splitLine: chunk.sl === 1 }));
        const marked = new Set([0, old.length - 1]);
        const dirtyStores = new Set();
        for (const token of tokens) {
            let parsed;
            try { parsed = JSON.parse(token); } catch (_) { continue; }
            const [dbName, storeName, key] = Array.isArray(parsed) ? parsed : [];
            if (typeof dbName !== 'string' || typeof storeName !== 'string') continue;
            if (key === null || key === undefined) {
                dirtyStores.add(`${dbName}\n${storeName}`);
                const start = { k: 'ss', d: dbName, s: storeName };
                const end = { k: 'se', d: dbName, s: storeName };
                old.forEach((chunk, index) => { if (compareUnits(chunk.to, start) >= 0 && compareUnits(chunk.from, end) <= 0) marked.add(index); });
            } else {
                const ref = { k: 'rec', d: dbName, s: storeName, key };
                const index = old.findIndex((chunk) => compareUnits(chunk.to, ref) >= 0);
                marked.add(index === -1 ? old.length - 1 : index);
            }
        }
        const dirtyTokens = new Set(tokens);
        const isDirty = (ref) => ref.k === 'ls'
            || (ref.k === 'rec' && (dirtyStores.has(`${ref.d}\n${ref.s}`) || dirtyTokens.has(JSON.stringify([ref.d, ref.s, ref.key]))));
        const regions = mergeRegions(old, [...marked].map((index) => ({ start: index, end: index })), isDirty);
        const inRegion = (index) => regions.some((region) => index >= region.start && index <= region.end);
        const cleanRecords = old.reduce((sum, chunk, index) => sum + (inRegion(index) ? 0 : chunk.records), 0);
        const chunks = [];
        const rebuilt = [];
        let generated = 0;
        let cursor = 0;
        for (const region of regions) {
            while (cursor < region.start) chunks.push(old[cursor++]);
            const stats = { recordCount: 0, totalBytes: 0 };
            const start = chunks.length;
            const bounds = { ...region.bounds, localEntries, recordCount: () => cleanRecords + generated + stats.recordCount };
            for await (const chunk of iterateSnapshotChunks(stats, 'cdc', bounds)) {
                chunks.push(describeChunk(chunk));
                updateProgress(16, `正在重做改过的分片，已处理 ${chunks.length - start} 个...`);
            }
            generated += stats.recordCount;
            if (chunks.length > start) rebuilt.push({ start, end: chunks.length - 1 });
            cursor = region.end + 1;
        }
        while (cursor < old.length) chunks.push(old[cursor++]);
        if (chunks.length > 10_000) throw new CdcChunkingError('CDC 块数量超过10000。');
        return { chunks, rebuilt };
    }

    // 整理出这次要上传的东西：清单、每块的描述、要生成的区域。mode 是 fast（只重做改过的）或 full（全部重新扫描）。
    // 没有上次的布局、改动太多或快速路径出错时自动改成 full。
    async function buildSnapshotPlan(mode = 'full') {
        const dirtyState = takeDirty();
        const tokens = [...dirtyState.marks.keys()];
        // 小说页和角色生成页没有记脏的钩子（覆盖层脚本只注入主页），它们各自写的那个键每次都按改过处理，不然云端会悄悄变旧。
        tokens.push(JSON.stringify(['RPHubDB', 'store', 'rp_hub_novel_library']), JSON.stringify(['AICharGen', 'characters', 'ai_chargen_characters']));
        // 本机设置只读这一次，两遍生成共用：页面（比如生图模块）在上传中途写个设置项，不会让两遍对不上
        const localEntries = readLocalStorageSnapshot();
        const layout = mode === 'fast' ? await loadSyncLayout() : null;
        let profile = 'cdc';
        let chunks = null;
        let rebuilt = null;
        let reason = '';
        if (mode === 'fast') {
            if (!layout) reason = '还没有上次上传的记录，这次完整扫描一遍。';
            else if (dirtyState.full) reason = '改动太多，这次完整扫描一遍。';
            else {
                try {
                    ({ chunks, rebuilt } = await rebuildDirtyRegions(layout, tokens, localEntries));
                } catch (error) {
                    if (!(error instanceof CdcChunkingError)) throw error;
                    console.warn('[RP Sync] 快速上传切块失败，改为完整扫描。', error);
                    reason = '快速上传出了岔子，这次完整扫描一遍。';
                }
            }
            if (reason) updateProgress(16, reason);
        }
        if (!chunks) {
            try {
                chunks = await scanAllChunks('cdc', localEntries);
            } catch (error) {
                if (!(error instanceof CdcChunkingError)) throw error;
                console.warn('[RP Sync] CDC 切块失败，回退旧定长切块。', error);
                profile = 'fixed';
                chunks = await scanAllChunks('fixed', localEntries);
            }
            rebuilt = [{ start: 0, end: chunks.length - 1 }];
        }
        const snapshot = {
            snapshotFormat: SNAPSHOT_FORMAT,
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            chunkerProfile: profile === 'cdc' ? CHUNKER_PROFILE : undefined,
            recordCount: chunks.reduce((sum, chunk) => sum + chunk.records, 0),
            totalBytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
            chunkManifest: chunks.map((chunk, index) => ({ index, checksum: chunk.checksum, length: chunk.length }))
        };
        snapshot.checksum = await sha256(buildStreamSnapshotChecksumSource(snapshot));
        // consumed：这次开始时记下的改过的键和它们的批次记号，上传成功后只清掉记号没变的
        return { snapshot, chunks, rebuilt, profile, localEntries, fast: Boolean(layout) && !reason, consumed: dirtyState };
    }

    async function scanStreamSnapshot(profile = 'cdc') {
        const chunks = await scanAllChunks(profile);
        const snapshot = {
            snapshotFormat: SNAPSHOT_FORMAT,
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            chunkerProfile: profile === 'cdc' ? CHUNKER_PROFILE : undefined,
            recordCount: chunks.reduce((sum, chunk) => sum + chunk.records, 0),
            totalBytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
            chunkManifest: chunks.map((chunk, index) => ({ index, checksum: chunk.checksum, length: chunk.length }))
        };
        snapshot.checksum = await sha256(buildStreamSnapshotChecksumSource(snapshot));
        return snapshot;
    }

    function assertChunkMatchesManifest(chunk, expected) {
        if (!expected
            || chunk.index !== expected.index
            || chunk.length !== expected.length
            || chunk.checksum !== expected.checksum) {
            throw new Error('两次扫描结果不一致，本地数据可能仍在变化，已取消提交。');
        }
    }

    // 第二遍：只重新生成服务器缺的块所在的区域（快速上传就是改过的区域，加上服务器碰巧没有的沿用块），生成出来的必须和第一遍一样；
    // 压缩好存进本机暂存。之后上传只从暂存读，页面接着写也不影响这次上传。
    async function stageMissingChunks(plan, missingIndices) {
        const missing = new Set(missingIndices);
        const { snapshot } = plan;
        const gzip = snapshot.schemaVersion === GZIP_SCHEMA_VERSION;
        const extra = [...missing].filter((index) => !plan.rebuilt.some((region) => index >= region.start && index <= region.end))
            .map((index) => ({ start: index, end: index }));
        const regions = mergeRegions(plan.chunks, [...plan.rebuilt, ...extra]);
        let staged = 0;
        for (const region of regions) {
            if (![...missing].some((index) => index >= region.start && index <= region.end)) continue;
            const stats = { recordCount: 0, totalBytes: 0 };
            let index = region.start;
            for await (const chunk of iterateSnapshotChunks(stats, plan.profile, { ...region.bounds, localEntries: plan.localEntries, recordCount: () => snapshot.recordCount })) {
                assertChunkMatchesManifest({ index, length: chunk.length, checksum: chunk.checksum }, snapshot.chunkManifest[index]);
                if (missing.has(index)) {
                    const part = await preparePart({ ...chunk, index }, gzip);
                    await syncStateStore('parts', 'readwrite', (store) => store.put(part, index));
                    staged += 1;
                    updateProgress(36, `正在整理要上传的分片 ${staged}/${missing.size}...`);
                }
                index += 1;
            }
            if (index !== region.end + 1) throw new Error('两次扫描结果不一致，本地数据可能仍在变化，已取消提交。');
        }
    }

    // 从本机暂存把分片传上去，同时传 uploadPartConcurrency 个；一个失败就都停下。
    // 服务器只认已经提交的数据，没提交前断掉的那次传上去的分片它不知道；这些分片在服务器上至少留 24 小时（清理只删 24 小时前上传、没人用的），
    // 所以 12 小时内传成功过的直接跳过。
    const UPLOADED_TRUST_MS = 12 * 60 * 60 * 1000;
    async function sendStagedParts(indices) {
        const queue = [...indices];
        let done = 0;
        let failed = null;
        const worker = async () => {
            while (queue.length && !failed) {
                const index = queue.shift();
                try {
                    const part = await syncStateStore('parts', 'readonly', (store) => store.get(index));
                    if (!part) throw new Error('本机暂存的上传数据不见了，请再点一次上传。');
                    const id = `${part.checksum}.${part.encoding === 'gzip' ? 'gz' : 'bin'}`;
                    const uploadedAt = await syncStateStore('uploaded', 'readonly', (store) => store.get(id));
                    if (!(uploadedAt > Date.now() - UPLOADED_TRUST_MS)) {
                        await postUploadPart(part);
                        await syncStateStore('uploaded', 'readwrite', (store) => store.put(Date.now(), id));
                    }
                } catch (error) {
                    failed ||= error;
                    throw error;
                }
                done += 1;
                updateProgress(36 + Math.round((done / indices.length) * 52), `正在上传 ${done}/${indices.length}，可以关掉这个窗口接着玩`);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONFIG.uploadPartConcurrency, queue.length) }, worker));
    }

