// 全站备份：把本站浏览器里的全部数据（所有数据库 + 本地存储）导出成一个文件，可以导入到本站或别的站点。
// 改编自柳贯一插件 v20.0.3 的全站备份（作者 苏萝萝），导出格式与它相同，互相可以导入。
// 和原版的区别：同步密码、同步状态、测试版的同步缓存不导出；导入时保留目标站点自己的这些设置；
// 导入期间暂停页面自动保存（与云同步恢复相同的做法），写完立即刷新。
RPHubSDK.register({
    id: 'site-backup', name: '全站备份', version: '1.0.0', requiresApi: 1,
    init(ctx) {
        'use strict';
        const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        // 每个站点各自的东西：同步密码和同步状态；同步用的下载缓存库体积大，换站点也用不上。
        const SKIP_DATABASES = new Set(['RPHubSyncStaging', 'RPHubSyncChunkCache']);
        const isSiteKey = (key) => key === 'rp_hub_sync_password_v1' || key.startsWith('rp_hub_sync_');

        let jszipPromise = null;
        function loadJSZip() {
            if (window.JSZip) return Promise.resolve(window.JSZip);
            jszipPromise ??= new Promise((resolve, reject) => {
                const script = Object.assign(document.createElement('script'), { src: JSZIP_URL, crossOrigin: 'anonymous' });
                script.onload = () => (window.JSZip ? resolve(window.JSZip) : reject(new Error('ZIP 组件加载失败')));
                script.onerror = () => { jszipPromise = null; reject(new Error('ZIP 组件下载失败，请检查网络后重试，或改用 JSON 导出')); };
                document.head.appendChild(script);
            });
            return jszipPromise;
        }

        const confirmAction = (title, message, confirmText) => (window.RPHubUI?.confirm
            ? window.RPHubUI.confirm({ title, message, confirmText, danger: true })
            : Promise.resolve(window.confirm(`${title}\n\n${message}`)));
        const stamp = () => {
            const d = new Date();
            const p = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
        };

        // ---------- 二进制 ↔ base64：数据库里的 ArrayBuffer/Blob 归档成 {__rphub_bin__}，导入时还原 ----------
        function bytesToB64(u8) {
            let binary = '';
            for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
            return btoa(binary);
        }
        function b64ToBytes(b64) {
            const binary = atob(b64);
            const u8 = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
            return u8;
        }
        async function normalizeDeep(value) {
            if (value === null || value === undefined) return value;
            const type = typeof value;
            if (type === 'string' || type === 'number' || type === 'boolean') return value;
            if (value instanceof Date) return value.toISOString();
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                return { __rphub_bin__: bytesToB64(new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength)) };
            }
            if (value instanceof Blob) {
                try { return { __rphub_bin__: bytesToB64(new Uint8Array(await value.arrayBuffer())), __rphub_mime__: value.type || '' }; }
                catch (_) { return null; }
            }
            if (Array.isArray(value)) {
                const out = new Array(value.length);
                for (let i = 0; i < value.length; i++) out[i] = await normalizeDeep(value[i]);
                return out;
            }
            if (type === 'object') {
                const out = {};
                for (const key of Object.keys(value)) {
                    const normalized = await normalizeDeep(value[key]).catch(() => undefined);
                    if (normalized !== undefined) out[key] = normalized;
                }
                return out;
            }
            return undefined;
        }
        function restoreDeep(value) {
            if (value === null || typeof value !== 'object') return value;
            if (typeof value.__rphub_bin__ === 'string') {
                const u8 = b64ToBytes(value.__rphub_bin__);
                return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
            }
            if (Array.isArray(value)) return value.map(restoreDeep);
            const out = {};
            for (const key of Object.keys(value)) out[key] = restoreDeep(value[key]);
            return out;
        }

        // ---------- 读：枚举本站全部数据库 ----------
        async function listDatabases() {
            const fallback = ['RPHubDB', 'RPHubWorkshop', 'AICharGen'];
            try {
                const names = (await indexedDB.databases()).map((item) => item?.name).filter(Boolean);
                return [...new Set([...names, ...fallback])].filter((name) => !SKIP_DATABASES.has(name));
            } catch (_) { return fallback; }
        }
        function openExisting(name) {
            return new Promise((resolve) => {
                try {
                    const request = indexedDB.open(name); // 不指定版本：不存在不创建、已存在不改结构
                    let created = false;
                    request.onupgradeneeded = () => { created = true; };
                    request.onsuccess = () => {
                        if (created) { request.result.close(); indexedDB.deleteDatabase(name); resolve(null); return; }
                        resolve(request.result);
                    };
                    request.onerror = () => resolve(null);
                    request.onblocked = () => resolve(null);
                } catch (_) { resolve(null); }
            });
        }
        function readStore(db, storeName) {
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction([storeName], 'readonly');
                    const store = tx.objectStore(storeName);
                    const records = [];
                    const request = store.openCursor();
                    request.onsuccess = () => { const cursor = request.result; if (cursor) { records.push({ k: cursor.key, v: cursor.value }); cursor.continue(); } };
                    tx.oncomplete = () => resolve({ records, keyPath: store.keyPath ?? null, autoInc: !!store.autoIncrement });
                    tx.onerror = tx.onabort = () => resolve({ records: [], keyPath: store.keyPath ?? null, autoInc: !!store.autoIncrement });
                } catch (_) { resolve({ records: [], keyPath: null, autoInc: false }); }
            });
        }
        async function dumpAllDatabases(progress) {
            const out = [];
            for (const name of await listDatabases()) {
                const db = await openExisting(name);
                if (!db) continue;
                const dump = { name, stores: [] };
                for (const storeName of Array.from(db.objectStoreNames)) {
                    progress(`读取 ${name} / ${storeName}…`);
                    const result = await readStore(db, storeName);
                    if (!result.records.length) continue;
                    const records = [];
                    for (const record of result.records) records.push({ k: await normalizeDeep(record.k), v: await normalizeDeep(record.v) });
                    dump.stores.push({ store: storeName, keyPath: result.keyPath, autoInc: result.autoInc, records });
                }
                db.close();
                if (dump.stores.length) out.push(dump);
            }
            return out;
        }
        function readWebStorage(storage) {
            const out = {};
            try {
                for (let i = 0; i < storage.length; i++) {
                    const key = storage.key(i);
                    if (key !== null && !isSiteKey(key)) out[key] = storage.getItem(key);
                }
            } catch (_) { /* storage blocked */ }
            return out;
        }

        // ---------- 写：覆盖导入；本站的同步密码和同步状态保留 ----------
        function openForImport(name, stores) {
            return new Promise((resolve, reject) => {
                const first = indexedDB.open(name);
                first.onerror = () => reject(first.error || new Error('打开数据库失败：' + name));
                first.onblocked = () => reject(new Error('数据库被占用，请关闭本站的其他标签页后重试'));
                first.onupgradeneeded = () => stores.forEach((def) => {
                    if (!first.result.objectStoreNames.contains(def.store)) {
                        first.result.createObjectStore(def.store, { ...(def.keyPath ? { keyPath: def.keyPath } : {}), ...(def.autoInc ? { autoIncrement: true } : {}) });
                    }
                });
                first.onsuccess = () => {
                    const db = first.result;
                    const missing = stores.filter((def) => !db.objectStoreNames.contains(def.store));
                    if (!missing.length) { resolve(db); return; }
                    // 已有的库缺少备份里的表：升一个版本补上。
                    const version = db.version + 1;
                    db.close();
                    const upgrade = indexedDB.open(name, version);
                    upgrade.onupgradeneeded = () => missing.forEach((def) => upgrade.result.createObjectStore(def.store, {
                        ...(def.keyPath ? { keyPath: def.keyPath } : {}), ...(def.autoInc ? { autoIncrement: true } : {})
                    }));
                    upgrade.onsuccess = () => resolve(upgrade.result);
                    upgrade.onerror = () => reject(upgrade.error || new Error('升级数据库失败：' + name));
                    upgrade.onblocked = () => reject(new Error('数据库被占用，请关闭本站的其他标签页后重试'));
                };
            });
        }
        function replaceStore(db, storeName, records) {
            return new Promise((resolve, reject) => {
                const tx = db.transaction([storeName], 'readwrite');
                const store = tx.objectStore(storeName);
                store.clear();
                for (const record of records) {
                    const value = restoreDeep(record.v);
                    if (store.keyPath) store.put(value); else store.put(value, restoreDeep(record.k));
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('写入失败：' + storeName));
            });
        }
        function replaceWebStorage(storage, data) {
            if (!data || typeof data !== 'object') return;
            for (let i = storage.length - 1; i >= 0; i--) {
                const key = storage.key(i);
                if (key !== null && !isSiteKey(key)) storage.removeItem(key);
            }
            for (const [key, value] of Object.entries(data)) if (!isSiteKey(key)) storage.setItem(key, String(value));
        }
        // 与云同步恢复相同：先暂停页面自动保存，免得写完又被内存里的旧数据盖回去；写完立即刷新。
        async function applyImport(databases, webStorage, progress) {
            globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS = true;
            try {
                for (const { name, stores } of databases) {
                    if (SKIP_DATABASES.has(name)) continue;
                    progress(`写入 ${name}…`);
                    const db = await openForImport(name, stores);
                    for (const def of stores) await replaceStore(db, def.store, def.records);
                    db.close();
                }
                if (webStorage.localStorage) replaceWebStorage(localStorage, webStorage.localStorage);
                if (webStorage.sessionStorage) replaceWebStorage(sessionStorage, webStorage.sessionStorage);
            } catch (error) {
                delete globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS;
                throw error;
            }
            progress('导入完成，页面即将刷新…');
            setTimeout(() => location.reload(), 600);
        }

        function download(blob, filename) {
            const url = URL.createObjectURL(blob);
            const link = Object.assign(document.createElement('a'), { href: url, download: filename, rel: 'noopener' });
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 180000);
        }

        // ---------- 导出 ----------
        async function exportZip(progress) {
            const JSZip = await loadJSZip();
            const databases = await dumpAllDatabases(progress);
            const ls = readWebStorage(localStorage);
            const ss = readWebStorage(sessionStorage);
            const zip = new JSZip();
            const manifest = {
                format: 'rphub-backup-zip', version: '1.0', plugin: '全站备份', pluginVersion: '1.0.0',
                createdAt: new Date().toISOString(), databases: [], webStorage: {}, totalRecords: 0
            };
            for (const db of databases) {
                const entry = { name: db.name, stores: [] };
                for (const store of db.stores) {
                    const chunks = [];
                    for (let i = 0; i < store.records.length; i += 100000) {
                        const path = `${db.name}/${store.store}/chunk-${String(chunks.length).padStart(4, '0')}.jsonl`;
                        zip.file(path, store.records.slice(i, i + 100000).map((record) => JSON.stringify(record)).join('\n'));
                        chunks.push(path);
                    }
                    manifest.totalRecords += store.records.length;
                    entry.stores.push({ store: store.store, keyPath: store.keyPath, autoInc: store.autoInc, records: store.records.length, chunks });
                }
                manifest.databases.push(entry);
            }
            zip.file('storage/localStorage.json', JSON.stringify(ls));
            zip.file('storage/sessionStorage.json', JSON.stringify(ss));
            manifest.webStorage = { localStorage: Object.keys(ls).length, sessionStorage: Object.keys(ss).length };
            zip.file('manifest.json', JSON.stringify(manifest, null, 2));
            const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true },
                (meta) => progress(`压缩 ${Math.round(meta.percent || 0)}%`));
            download(blob, `RPHub全站备份_${stamp()}.zip`);
            return `已导出 ZIP：${(blob.size / 1048576).toFixed(2)} MB，数据库 ${databases.length} 个，记录 ${manifest.totalRecords} 条。`;
        }
        async function exportJson(progress) {
            const databases = await dumpAllDatabases(progress);
            const parts = [`{"__rphub_backup__":1,"version":8,"exportedAt":${JSON.stringify(new Date().toISOString())},"databases":{`];
            databases.forEach((db, dbIndex) => {
                parts.push(`${dbIndex ? ',' : ''}${JSON.stringify(db.name)}:{`);
                db.stores.forEach((store, storeIndex) => {
                    parts.push(`${storeIndex ? ',' : ''}${JSON.stringify(store.store)}:[`);
                    for (let i = 0; i < store.records.length; i += 20000) {
                        parts.push((i ? ',' : '') + store.records.slice(i, i + 20000).map((record) => JSON.stringify(record)).join(','));
                    }
                    parts.push(']');
                });
                parts.push('}');
            });
            parts.push(`},"webStorage":{"localStorage":${JSON.stringify(readWebStorage(localStorage))},"sessionStorage":${JSON.stringify(readWebStorage(sessionStorage))}}}`);
            const blob = new Blob(parts, { type: 'application/json' });
            download(blob, `RPHub全站备份_${stamp()}.json`);
            return `已导出 JSON：${(blob.size / 1048576).toFixed(2)} MB，数据库 ${databases.length} 个。`;
        }

        // ---------- 导入：识别 ZIP 和新版流式 JSON（柳贯一 v20 导出的也能导入） ----------
        async function importFile(file, progress) {
            // 按文件开头判断（ZIP 都以 "PK" 开头），文件被改名也能认出来。
            const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
            if (head[0] === 0x50 && head[1] === 0x4b) {
                const JSZip = await loadJSZip();
                progress('解压校验中…');
                const zip = await JSZip.loadAsync(file);
                const manifest = JSON.parse(await (zip.file('manifest.json') || { async: () => { throw new Error('不是有效的备份：缺少 manifest.json'); } }).async('string'));
                if (manifest.format !== 'rphub-backup-zip') throw new Error('备份格式不匹配');
                const ws = manifest.webStorage || {};
                const ok = await confirmAction('导入全站备份', `备份时间：${manifest.createdAt || '未知'}\n数据库 ${(manifest.databases || []).length} 个 · 记录 ${manifest.totalRecords || 0} 条 · 本地存储 ${ws.localStorage || 0} 项\n\n本站同名数据会被覆盖（本站的同步密码和同步设置保留）。导入后页面会刷新。`, '覆盖导入');
                if (!ok) return '已取消导入。';
                const databases = [];
                for (const db of manifest.databases || []) {
                    const stores = [];
                    for (const store of db.stores || []) {
                        const records = [];
                        for (const path of store.chunks || []) {
                            const text = await zip.file(path)?.async('string');
                            if (text) text.split('\n').forEach((line) => { if (line) records.push(JSON.parse(line)); });
                        }
                        stores.push({ store: store.store, keyPath: store.keyPath, autoInc: store.autoInc, records });
                    }
                    databases.push({ name: db.name, stores });
                }
                const read = async (path) => JSON.parse((await zip.file(path)?.async('string')) || 'null');
                await applyImport(databases, { localStorage: await read('storage/localStorage.json'), sessionStorage: await read('storage/sessionStorage.json') }, progress);
                return '';
            }
            progress('解析备份中…');
            const pack = JSON.parse(await file.text());
            if (!pack?.__rphub_backup__ || Number(pack.version) < 8 || !pack.databases || Array.isArray(pack.databases) || pack.databases.main !== undefined) {
                throw new Error('不支持这个备份：只能导入 ZIP 或新版 JSON 备份（柳贯一 v20 以前的旧格式请先在旧站点重新导出）');
            }
            let total = 0;
            const databases = Object.entries(pack.databases).map(([name, stores]) => ({
                name,
                stores: Object.entries(stores || {}).map(([store, records]) => { total += (records || []).length; return { store, records: records || [] }; })
            }));
            const ok = await confirmAction('导入全站备份', `备份时间：${pack.exportedAt || '未知'}\n数据库 ${databases.length} 个 · 记录 ${total} 条\n\n本站同名数据会被覆盖（本站的同步密码和同步设置保留）。导入后页面会刷新。`, '覆盖导入');
            if (!ok) return '已取消导入。';
            await applyImport(databases, pack.webStorage || {}, progress);
            return '';
        }

        ctx.ui.addSidebarEntry({
            label: '全站备份',
            onClick() {
                ctx.ui.openPanel({
                    title: '全站备份',
                    render(body) {
                        body.innerHTML = `
                            <p class="rph-ui-note">把本站浏览器里的全部数据（角色卡、聊天、世界书、设置、插件和插件数据等）导出成一个文件，可以导入到本站或别的站点。</p>
                            <p class="rph-ui-muted">不包含：本站的同步密码和同步设置；生成的图片（存在站点的 R2 里，不在浏览器中）。导入到新站点后，旧图会显示为读取失败，需要的话可以在图片上点重新生成。</p>
                            <div class="rph-ui-actions" style="justify-content:flex-start;flex-wrap:wrap">
                                <button type="button" class="modal-primary-button rph-ui-button" data-act="zip">导出 ZIP（推荐）</button>
                                <button type="button" class="modal-secondary-button rph-ui-button" data-act="json">导出 JSON</button>
                                <button type="button" class="modal-secondary-button rph-ui-button" data-act="import">导入备份</button>
                            </div>
                            <p class="rph-ui-muted" data-status style="margin-top:12px"></p>`;
                        const status = body.querySelector('[data-status]');
                        const buttons = [...body.querySelectorAll('[data-act]')];
                        const progress = (text) => { status.textContent = text; };
                        const run = async (task) => {
                            buttons.forEach((button) => { button.disabled = true; });
                            try {
                                const message = await task();
                                if (message) { progress(message); ctx.ui.toast(message, { kind: 'success' }); }
                            } catch (error) {
                                progress('失败：' + error.message);
                                ctx.ui.toast('全站备份失败：' + error.message);
                            } finally {
                                buttons.forEach((button) => { button.disabled = false; });
                            }
                        };
                        body.querySelector('[data-act="zip"]').onclick = () => run(() => exportZip(progress));
                        body.querySelector('[data-act="json"]').onclick = () => run(() => exportJson(progress));
                        body.querySelector('[data-act="import"]').onclick = () => {
                            const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.zip,.json,application/zip,application/json' });
                            input.onchange = () => { const file = input.files?.[0]; if (file) run(() => importFile(file, progress)); };
                            input.click();
                        };
                    }
                });
            }
        });
    }
});
