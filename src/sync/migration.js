    async function readForkPackList(root) {
        const packs = [];
        let chain = '0'.repeat(64);
        for (let index = 0; index < Number(root.pageCount); index += 1) {
            const { packs: items } = await postSync({ action: 'fork-page', checksum: root.checksum, index });
            chain = await sha256(JSON.stringify(['rp-sync-manifest-page-v1', index, chain,
                items.map((pack) => [pack.bucketKey, pack.group, pack.part, pack.checksum, pack.length, pack.entryCount])]));
            packs.push(...items);
        }
        const checksum = await sha256(JSON.stringify([FORK_SNAPSHOT_FORMAT, 13, root.totalBytes, packs.length,
            root.entryCount, root.pageCount, chain, root.bloomChecksum]));
        if (chain !== root.pageRoot || checksum !== root.checksum) throw new Error('魔改版云端清单校验失败。');
        return packs.map((pack, index) => ({ index, checksum: pack.checksum, length: pack.length }));
    }

    function readLocalPresets() {
        return new Promise((resolve) => {
            const request = indexedDB.open('RPHubDB');
            request.onupgradeneeded = () => request.transaction.abort(); // 本机还没有数据库：不顺手建一个空的
            request.onerror = () => resolve(undefined);
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('store')) { db.close(); resolve(undefined); return; }
                const read = db.transaction('store').objectStore('store').get('rp_hub_presets');
                read.onsuccess = () => { db.close(); resolve(read.result); };
                read.onerror = () => { db.close(); resolve(undefined); };
            };
        });
    }

    // 魔改版的数据包里是同一套记录（每行一条，顺序也一样），只是没有我们的开头、本地设置结束和结尾标记，
    // 数组的长度写在数组结尾而不是开头，还夹着它自己的本地设置。这里补上标记、把长度挪到开头、
    // 去掉它自己的设置，再交给原来的校验和恢复。
    // 它从不上传 API 预设：把本机的预设当成云端有的记录写回，不然恢复会当成云端没有而删掉。
    class ForkSnapshotLines {
        constructor(target, presets) {
            this.target = target;
            this.presets = presets;
            this.recordCount = 0;
            this.started = false;
            this.localStorageEnded = false;
            this.array = null;
        }

        async consume(lineText) {
            let line;
            try { line = JSON.parse(lineText); } catch (_) { throw new Error('魔改版数据包记录格式不正确。'); }
            await this.start();
            if (line?.type === 'recordArrayStart') {
                this.array = { start: line, items: [] };
                return;
            }
            if (this.array) {
                if (line?.type === 'recordArrayItem') {
                    this.array.items.push(lineText);
                    return;
                }
                const { start, items } = this.array;
                if (line?.type !== 'recordArrayEnd' || Number(line.length) !== items.length) throw new Error('魔改版数组记录不完整。');
                this.array = null;
                await this.emit({ ...start, length: items.length });
                for (const text of items) await this.emit({ type: 'recordArrayItem' }, text);
            }
            if (line?.type === 'localStorage') {
                if (!isAppLocalStorageKey(String(line.key))) return;
            } else {
                await this.endLocalStorage();
            }
            const presetsStore = line?.database === 'RPHubDB' && line.store === 'store';
            if (presetsStore && line.type === 'record' && line.key === 'rp_hub_presets') this.presets = undefined;
            if (presetsStore && line.type === 'storeEnd' && this.presets !== undefined) {
                await this.emit({ type: 'record', database: 'RPHubDB', store: 'store', key: 'rp_hub_presets', value: this.presets });
            }
            await this.emit(line, lineText);
        }

        async start() {
            if (this.started) return;
            this.started = true;
            await this.emit({ type: 'snapshot', format: SNAPSHOT_FORMAT, schemaVersion: RAW_SCHEMA_VERSION });
        }

        async endLocalStorage() {
            if (this.localStorageEnded) return;
            this.localStorageEnded = true;
            await this.emit({ type: 'localStorageEnd' });
        }

        async emit(line, text = JSON.stringify(line)) {
            if (['localStorage', 'record', 'recordArrayEnd'].includes(line.type)) this.recordCount += 1;
            await this.target.consume(text);
        }

        async finish() {
            await this.start();
            await this.endLocalStorage();
            this.target.expectedRecordCount = this.recordCount;
            await this.emit({ type: 'snapshotEnd', recordCount: this.recordCount });
            this.target.finish();
        }
    }

    // ---- 换成魔改版：把云端数据转成魔改版（cy-2-u/rp）schema 13 存进同一个桶 ----
    // 魔改版读不懂我们的格式（会当成旧数据跳过），只能趁站点还是测试版时转。来源是云端（和「下载」一样），写法照它的规则：
    // 每条记录一行规范 JSON（键名排序）；头尾各一桶、数组 32 项一页、其余按 id 哈希分 256 桶；桶内按排序键打包
    // （≤1MiB、≤512 条），清单 32 包一页、哈希逐页串起来，外加它清理旧数据用的布隆过滤器。
    // 魔改版不同步的不导出：插件、API 预设、它不认的本地设置（都还在各设备本机和测试版的云端备份里）。
    const FORK_STORES = { RPHubDB: ['store'], AICharGen: ['characters'] };
    const FORK_PACK_BYTES = 1024 * 1024;
    const FORK_PACK_ENTRIES = 512;
    const FORK_BLOOM_BYTES = 32 * 1024;

    function forkHash(text) {
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
        return hash >>> 0;
    }

    function canonicalJson(value) {
        if (Array.isArray(value)) return value.map(canonicalJson);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
    }

    // 照魔改版的 snapshotEntryGroup / Source / Bucket 算分组、桶和桶内排序键。
    function forkPlacement(value) {
        const { type } = value;
        const source = type === 'localStorage' ? `ls:${value.key}` : type === 'database' ? `db:${value.name}`
            : type === 'databaseEnd' ? `db-end:${value.name}` : type === 'storeEnd' ? `store-end:${value.database}/${value.store}`
            : `${value.database}/${value.store}/${JSON.stringify(value.key)}`;
        const group = type === 'localStorage' ? 'localStorage' : type === 'database' ? `db:${value.name}:header`
            : type === 'databaseEnd' ? `db:${value.name}:footer` : type === 'storeEnd' ? `store:${value.database}/${value.store}:footer`
            : `store:${value.database}/${value.store}:data`;
        const sequence = { recordArrayStart: '0', recordArrayItem: `1:${String(value.index).padStart(12, '0')}`, recordArrayEnd: '2' }[type] || '1';
        const sortKey = `${source}|${sequence}`;
        if (group.endsWith(':header')) return { group, bucketKey: `${group}|h`, sortKey };
        if (group.endsWith(':footer')) return { group, bucketKey: `${group}|z`, sortKey };
        if (type.startsWith('recordArray')) {
            const page = type === 'recordArrayItem' ? Math.floor(value.index / 32) : type === 'recordArrayEnd' ? Math.floor(value.length / 32) : 0;
            const token = `${forkHash(`a:${source}`).toString(16).padStart(8, '0')}${forkHash(`b:${source}`).toString(16).padStart(8, '0')}-${source.length}`;
            return { group, bucketKey: `${group}|a${token}|q${String(page).padStart(10, '0')}`, sortKey };
        }
        const id = type === 'localStorage' ? source : `record:${source}`;
        return { group, bucketKey: `${group}|s${String(forkHash(id) % 256).padStart(3, '0')}`, sortKey };
    }

    // 照魔改版的 buildCachedPacks：条目依次写入，写满 1MiB 就换下一包（一行可以跨包），每包最多 512 条。
    function buildForkPacks(entries) {
        const packs = [];
        let parts = [];
        let used = 0;
        let entryCount = 0;
        const flush = () => {
            if (!used) return;
            const bytes = new Uint8Array(used);
            let offset = 0;
            for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
            packs.push({ bytes, entryCount });
            parts = [];
            used = 0;
            entryCount = 0;
        };
        for (const bytes of entries) {
            for (let offset = 0; offset < bytes.byteLength;) {
                const length = Math.min(FORK_PACK_BYTES - used, bytes.byteLength - offset);
                parts.push(bytes.subarray(offset, offset + length));
                used += length;
                offset += length;
                if (used === FORK_PACK_BYTES) flush();
            }
            parts.push(new Uint8Array([10]));
            used += 1;
            entryCount += 1;
            if (used === FORK_PACK_BYTES || entryCount === FORK_PACK_ENTRIES) flush();
        }
        flush();
        return packs;
    }

    // 我们的生图记录 → 魔改版：分支记到 storyScopeId，哈希去掉补的零，key 按它的拼法，再记上图片在 R2 的准确位置
    // （按记录参数问一次本站，有图才有）。其余字段原样留着，换回测试版时还用得上。
    async function toForkImageRecord(record) {
        if (!record || typeof record !== 'object') return record;
        const unpad = (hash) => String(hash || '').replace(/^0+(?=.)/, '');
        const scope = String(record.branchId || 'main');
        const contentHash = unpad(record.contentHash);
        const promptHash = unpad(record.promptHash);
        const slot = record.messageId || ((record.messageIndex ?? null) !== null ? `index:${record.messageIndex}` : contentHash || 'message');
        const url = record.status !== 'skipped' && record.paramsSnapshot ? globalThis.RPHubImageModule?.buildImageRenderUrl(record.paramsSnapshot) : '';
        const response = url ? await fetch(url, { method: 'HEAD', credentials: 'same-origin' }).catch(() => null) : null;
        const found = response?.ok && response.headers.get('x-rp-image-cache') === 'HIT' ? decodeURIComponent(response.headers.get('x-rp-image-key') || '') : '';
        const imageKey = found || record.paramsSnapshot?.imageKey;
        return {
            ...record, storyScopeId: scope, contentHash, promptHash,
            key: [encodeURIComponent(scope), slot, record.occurrenceIndex ?? 0, promptHash].join(':'),
            ...(imageKey ? { imageKey } : {})
        };
    }

    // 把我们的快照行换成魔改版的条目：数组每一行都带上 key、长度写在数组结尾，去掉开头结尾标记和它不同步的东西。
    class ForkExportLines {
        constructor() {
            this.buckets = new Map();
            this.groups = [];
            this.skipDatabase = null;
            this.array = null;
            this.images = [];
        }

        async consume(lineText) {
            const line = JSON.parse(lineText);
            if (line.type === 'snapshot' || line.type === 'localStorageEnd' || line.type === 'snapshotEnd') return;
            if (line.type === 'localStorage') {
                if (/^(?:rp_hub_|ai_chargen_)/.test(line.key) && !line.key.startsWith('rp_hub_sync_')) this.add(line);
                return;
            }
            if (line.type === 'database') {
                const stores = FORK_STORES[line.name];
                this.skipDatabase = stores ? null : line.name;
                if (stores) this.add({ ...line, stores: line.stores.filter((store) => stores.includes(store.name)) });
                return;
            }
            const database = line.type === 'databaseEnd' ? line.name : line.database;
            if (database === this.skipDatabase || (line.store && !FORK_STORES[database]?.includes(line.store))) return;
            if (line.type === 'recordArrayStart') {
                this.array = { key: line.key, length: line.length };
                delete line.length;
            } else if (line.type === 'recordArrayItem' || line.type === 'recordArrayEnd') {
                line.key = this.array.key;
                if (line.type === 'recordArrayEnd') line.length = this.array.length;
            }
            if (database === 'RPHubDB' && line.key === 'rp_hub_presets') return;
            if (line.type === 'recordArrayItem' && database === 'RPHubDB' && String(line.key).startsWith('rp_hub_image_renders_')) {
                this.images.push(line);
                if (this.images.length >= 12) await this.flushImages();
                return;
            }
            this.add(line);
        }

        async flushImages() {
            const lines = this.images.splice(0);
            await Promise.all(lines.map(async (line) => { line.value = await toForkImageRecord(line.value); }));
            lines.forEach((line) => this.add(line));
        }

        add(value) {
            const bytes = new TextEncoder().encode(JSON.stringify(canonicalJson(value)));
            if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('有一条数据超过魔改版 64MB 的上限，没法转过去。');
            const { group, bucketKey, sortKey } = forkPlacement(value);
            if (!this.groups.includes(group)) this.groups.push(group);
            if (!this.buckets.has(bucketKey)) this.buckets.set(bucketKey, { group, entries: [] });
            this.buckets.get(bucketKey).entries.push({ sortKey, bytes });
        }

        finish() {
            return this.flushImages();
        }
    }

    async function sendForkPack(pack) {
        for (let attempt = 0; ; attempt += 1) {
            const response = await fetch(`${CONFIG.apiEndpoint}?action=fork-export-pack&checksum=${pack.checksum}`, {
                method: 'POST', headers: { ...buildSyncHeaders(), 'content-type': 'application/octet-stream' }, body: pack.bytes, credentials: 'same-origin'
            }).catch(() => null);
            if (response?.ok) return;
            if (attempt >= CONFIG.retryCount) throw new Error(`魔改版数据包上传失败：HTTP ${response?.status || '网络错误'}`);
            await wait(CONFIG.retryDelayMs);
        }
    }

    async function exportForkSnapshot() {
        updateProgress(5, '正在读取云端数据...');
        const { remote } = await postSync({ action: 'pull-manifest' });
        if (remote?.snapshotFormat !== SNAPSHOT_FORMAT || !isStreamSchema(remote.schemaVersion)) throw new Error('云端还没有测试版的数据，先上传一次再换。');
        const chunkManifest = await validateStreamSnapshotManifest(remote);
        const exporter = new ForkExportLines();
        const validator = new StreamSnapshotValidator(remote.recordCount);
        const stagingDb = await openDownloadStagingDb();
        try {
            await downloadSnapshotToStaging(remote, chunkManifest, stagingDb);
            updateProgress(0, '正在转成魔改版的格式...');
            await parseStagedStreamSnapshot(stagingDb, chunkManifest, {
                consume: (line) => { validator.consume(line); return exporter.consume(line); },
                finish: () => { validator.finish(); return exporter.finish(); }
            });
        } finally {
            await clearDownloadStagingStore(stagingDb).catch(() => { });
            stagingDb.close();
        }

        const descriptors = [];
        const running = new Set();
        for (const [bucketKey, { group, entries }] of exporter.buckets) {
            entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
            for (const [part, pack] of buildForkPacks(entries.map((entry) => entry.bytes)).entries()) {
                pack.checksum = await sha256Bytes(pack.bytes);
                descriptors.push({ bucketKey, group, part, checksum: pack.checksum, length: pack.bytes.byteLength, entryCount: pack.entryCount });
                const task = sendForkPack(pack);
                running.add(task);
                task.then(() => running.delete(task), () => { });
                if (running.size >= 4) await Promise.race(running);
            }
            exporter.buckets.delete(bucketKey);
            updateProgress(50, `正在上传魔改版数据包 ${descriptors.length} 个...`);
        }
        await Promise.all(running);

        const order = new Map(exporter.groups.map((group, index) => [group, index]));
        descriptors.sort((a, b) => order.get(a.group) - order.get(b.group) || a.bucketKey.localeCompare(b.bucketKey) || a.part - b.part);
        const pages = [];
        let previousPageHash = '0'.repeat(64);
        for (let index = 0; index * 32 < descriptors.length; index += 1) {
            const packs = descriptors.slice(index * 32, index * 32 + 32);
            const pageHash = await sha256(JSON.stringify(['rp-sync-manifest-page-v1', index, previousPageHash,
                packs.map((pack) => [pack.bucketKey, pack.group, pack.part, pack.checksum, pack.length, pack.entryCount])]));
            pages.push({ previousPageHash, pageHash, packs });
            previousPageHash = pageHash;
        }
        const bloom = new Uint8Array(FORK_BLOOM_BYTES);
        for (const { checksum } of descriptors) {
            for (const offset of [0, 8, 16, 24]) {
                const bit = parseInt(checksum.slice(offset, offset + 8), 16) % (FORK_BLOOM_BYTES * 8);
                bloom[bit >>> 3] |= 1 << (bit & 7);
            }
        }
        const totalBytes = descriptors.reduce((sum, pack) => sum + pack.length, 0);
        const entryCount = descriptors.reduce((sum, pack) => sum + pack.entryCount, 0);
        const checksum = await sha256(JSON.stringify([FORK_SNAPSHOT_FORMAT, 13, totalBytes, descriptors.length, entryCount,
            pages.length, previousPageHash, await sha256Bytes(bloom)]));
        let binary = '';
        for (let index = 0; index < bloom.length; index += 0x2000) binary += String.fromCharCode(...bloom.subarray(index, index + 0x2000));
        updateProgress(85, '正在换上魔改版的云端清单...');
        await postSync({ action: 'fork-export-commit', expectedChecksum: remote.checksum, checksum, pages, bloom: btoa(binary) },
            { retryCount: 0, timeoutMs: CONFIG.commitTimeoutMs });
    }

