// 魔改版（cy-2-u/rp）会给 RPHubDB 加它自己的表，把版本升到 2；RPH 和生图模块固定按版本 1 打开，
// 同一网址换成测试版后浏览器会拒绝（VersionError），页面报“加载保存的数据失败”。
// 按版本 1 打开 RPHubDB 时改为按它现有的版本打开：新库照样建成版本 1，版本 1 的库不受影响。
(function () {
    'use strict';
    if (typeof IDBFactory === 'undefined') return;
    const nativeOpen = IDBFactory.prototype.open;
    if (nativeOpen.rphVersionTolerant) return;
    const open = function (name, version) {
        return name === 'RPHubDB' && version === 1 ? nativeOpen.call(this, name) : nativeOpen.apply(this, arguments);
    };
    open.rphVersionTolerant = true;
    IDBFactory.prototype.open = open;
})();

(function () {
    'use strict';

    const DB_NAME = 'RPHubDB';
    const STORE_NAME = 'store';
    const LEGACY_KEY = 'rp_hub_characters';
    const INDEX_KEY = 'rp_hub_character_index';
    const CHARACTER_KEY_PREFIX = 'rp_hub_character_';
    const LARGE_RECORD_LENGTH = 100 * 1024 * 1024;
    const APP_JS_URL = '/assets/js/app.js';
    const UNPATCHED_CHARACTER_SAVE = /setStoredValue\(\s*['"]characters['"]\s*,/;

    const hashCache = new Map();
    let dbPromise = null;
    let mutationQueue = Promise.resolve();
    let patchAudit = { status: 'pending', reason: '' };
    let patchAuditPromise = null;

    function isPullRestoreInProgress() {
        return globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true;
    }

    function deferPersistenceMutation(operation) {
        const deferWrite = globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE;
        if (typeof deferWrite !== 'function') {
            return Promise.reject(new Error('RP Sync 恢复写入队列不可用，已停止角色卡持久化。'));
        }
        return deferWrite(operation);
    }

    function createSaveSummary() {
        return { writtenKeys: [], deletedKeys: [], indexWritten: false };
    }

    function characterKey(uuid) {
        return `${CHARACTER_KEY_PREFIX}${uuid}`;
    }

    function openDatabase() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
            request.onerror = () => {
                dbPromise = null;
                reject(request.error || new Error('RPHubDB 打开失败。'));
            };
            request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.close();
                    dbPromise = null;
                    reject(new Error('RPHubDB 缺少 store 对象仓库。'));
                    return;
                }
                db.onversionchange = () => {
                    db.close();
                    dbPromise = null;
                };
                resolve(db);
            };
        });
        return dbPromise;
    }

    function readValue(db, key) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const request = tx.objectStore(STORE_NAME).get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error(`读取 ${key} 失败。`));
        });
    }

    // 一个只读事务里把所有键一起读出来，不是一张卡开一个事务。
    function readValues(db, keys) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const results = keys.map((key) => store.get(key));
            tx.oncomplete = () => resolve(results.map((request) => request.result));
            tx.onerror = () => reject(tx.error || new Error('读取角色卡失败。'));
            tx.onabort = () => reject(tx.error || new Error('读取角色卡事务已中止。'));
        });
    }

    function enqueueMutation(task) {
        const result = mutationQueue.then(task, task);
        mutationQueue = result.catch(() => undefined);
        return result;
    }

    function fnv1a(text) {
        let hash = 0x811c9dc5;
        for (let index = 0; index < text.length; index += 1) {
            hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    }

    function valueHash(serialized) {
        return `${serialized.length}:${fnv1a(serialized)}`;
    }

    function serializeCard(card) {
        // 头像通常是整张 PNG 的 data URL；直接比较字符串，避免每次保存都复制它。
        const { avatar, ...content } = card;
        const serialized = JSON.stringify(content);
        if (typeof serialized !== 'string') {
            throw new TypeError(`角色卡 ${card.uuid} 无法序列化。`);
        }
        return { serialized, hash: valueHash(serialized), avatar };
    }

    function cloneCard({ serialized, avatar }) {
        const value = JSON.parse(serialized);
        if (avatar !== undefined) value.avatar = avatar;
        return value;
    }

    function logLargeRecord(key, serializedLength) {
        if (serializedLength <= LARGE_RECORD_LENGTH) return;
        console.error(
            `[RPHubCharStore] ${key} 序列化后约 ${(serializedLength / 1024 / 1024).toFixed(2)}MiB，超过 100MiB；仍将尝试写入。`
        );
    }

    function normalizeUuid(card) {
        const value = card?.uuid;
        if (value !== undefined && value !== null && value !== '') {
            if (typeof value !== 'string') {
                throw new TypeError('角色卡 UUID 必须是字符串，已取消写入以保护关联聊天和记忆。');
            }
            if (value === 'index') {
                throw new Error('角色卡 UUID index 与角色卡索引键冲突，已取消写入。');
            }
            return value;
        }
        const generated = crypto.randomUUID();
        card.uuid = generated;
        return generated;
    }

    function prepareCards(list) {
        if (!Array.isArray(list)) throw new TypeError('角色卡列表必须是数组。');
        const seen = new Set();
        return list.map((card, index) => {
            if (!card || typeof card !== 'object' || Array.isArray(card)) {
                throw new TypeError(`第 ${index + 1} 张角色卡格式无效。`);
            }
            const uuid = normalizeUuid(card);
            if (seen.has(uuid)) {
                throw new Error(`角色卡 UUID 重复：${uuid}。为避免合并存档，已取消写入。`);
            }
            seen.add(uuid);
            const key = characterKey(uuid);
            const prepared = serializeCard(card);
            logLargeRecord(key, prepared.serialized.length + (prepared.avatar?.length || 0));
            return { uuid, key, ...prepared };
        });
    }

    function normalizeIndexOrder(indexValue) {
        if (!indexValue || !Array.isArray(indexValue.order)) {
            throw new TypeError('角色卡索引格式无效。');
        }
        const order = [];
        const seen = new Set();
        for (const value of indexValue.order) {
            if (typeof value !== 'string' || value === '') {
                throw new TypeError('角色卡索引包含无效 UUID。');
            }
            const uuid = value;
            if (uuid === 'index') {
                throw new Error('角色卡索引包含保留 UUID index。');
            }
            if (seen.has(uuid)) {
                throw new Error(`角色卡索引包含重复 UUID：${uuid}。`);
            }
            seen.add(uuid);
            order.push(uuid);
        }
        return order;
    }

    function sameOrder(left, right) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function rememberPrepared(prepared) {
        hashCache.clear();
        for (const { uuid, hash, avatar } of prepared) hashCache.set(uuid, { hash, avatar });
    }

    async function migrateNow() {
        if (isPullRestoreInProgress()) {
            return deferPersistenceMutation(migrateNow);
        }
        const db = await openDatabase();
        if (isPullRestoreInProgress()) {
            return deferPersistenceMutation(migrateNow);
        }
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            let firstError = null;
            let prepared = null;
            let migratedCards = null;

            const rememberError = (error) => {
                if (!firstError) firstError = error;
            };
            const trackWrite = (request, key) => {
                request.onerror = () => rememberError(
                    new Error(`角色卡迁移写入 ${key} 失败。`, { cause: request.error })
                );
            };

            tx.oncomplete = () => {
                if (prepared) rememberPrepared(prepared);
                resolve(migratedCards);
            };
            tx.onerror = () => rememberError(tx.error || new Error('角色卡迁移事务失败。'));
            tx.onabort = () => reject(firstError || tx.error || new Error('角色卡迁移事务已中止。'));

            const legacyRequest = store.get(LEGACY_KEY);
            legacyRequest.onerror = () => rememberError(
                new Error(`读取旧角色卡记录 ${LEGACY_KEY} 失败。`, { cause: legacyRequest.error })
            );
            legacyRequest.onsuccess = () => {
                const legacyValue = legacyRequest.result;
                if (legacyValue === undefined) return;
                try {
                    if (!Array.isArray(legacyValue)) {
                        throw new TypeError(`旧角色卡记录 ${LEGACY_KEY} 不是数组。`);
                    }
                    prepared = prepareCards(legacyValue);
                    migratedCards = prepared.map(cloneCard);
                    for (const [index, item] of prepared.entries()) {
                        trackWrite(store.put(migratedCards[index], item.key), item.key);
                    }
                    trackWrite(
                        store.put({ order: prepared.map((item) => item.uuid) }, INDEX_KEY),
                        INDEX_KEY
                    );
                    trackWrite(store.delete(LEGACY_KEY), LEGACY_KEY);
                } catch (error) {
                    rememberError(error);
                    tx.abort();
                }
            };
        });
    }

    function migrate() {
        return enqueueMutation(migrateNow);
    }

    async function loadAll() {
        await mutationQueue;
        const db = await openDatabase();
        const [indexValue, legacyValue] = await Promise.all([
            readValue(db, INDEX_KEY),
            readValue(db, LEGACY_KEY)
        ]);
        if (indexValue !== undefined && legacyValue !== undefined) {
            throw new Error('检测到旧角色卡记录与分键索引同时存在，已停止加载以避免覆盖数据。');
        }
        if (indexValue === undefined) {
            if (legacyValue === undefined) {
                hashCache.clear();
                return null;
            }
            // 两个 loadAll 同时跑时，排在后面的迁移会发现旧表已经没了、返回 null：这时按索引再读一遍，
            // 别把"没数据"交出去（页面会当成没有角色，下次保存把分键全删光）。
            return (await migrate()) ?? loadAll();
        }

        const order = normalizeIndexOrder(indexValue);
        const cards = [];
        hashCache.clear();
        const values = await readValues(db, order.map(characterKey));
        for (const [index, uuid] of order.entries()) {
            const card = values[index];
            if (card === undefined) {
                console.warn(`[RPHubCharStore] 角色卡索引引用了缺失记录：${characterKey(uuid)}`);
                continue;
            }
            const { hash, avatar } = serializeCard(card);
            hashCache.set(uuid, { hash, avatar });
            cards.push(card);
        }
        return cards;
    }

    async function saveAllNow(list) {
        if (isPullRestoreInProgress()) {
            return deferPersistenceMutation(() => saveAllNow(list));
        }
        const prepared = prepareCards(list);
        const newOrder = prepared.map((item) => item.uuid);
        const newUuidSet = new Set(newOrder);
        const db = await openDatabase();
        if (isPullRestoreInProgress()) {
            return deferPersistenceMutation(() => saveAllNow(list));
        }

        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const summary = createSaveSummary();
            let firstError = null;
            let indexReady = false;
            let legacyReady = false;
            let indexValue;
            let legacyValue;
            let processed = false;

            const rememberError = (error) => {
                if (!firstError) firstError = error;
            };
            const trackWrite = (request, key) => {
                request.onerror = () => rememberError(
                    new Error(`角色卡记录 ${key} 写入失败。`, { cause: request.error })
                );
            };

            tx.oncomplete = () => {
                rememberPrepared(prepared);
                resolve(summary);
            };
            tx.onerror = () => rememberError(tx.error || new Error('角色卡保存事务失败。'));
            tx.onabort = () => reject(firstError || tx.error || new Error('角色卡保存事务已中止。'));

            const processReads = () => {
                if (!indexReady || !legacyReady || processed) return;
                processed = true;
                try {
                    if (legacyValue !== undefined) {
                        throw new Error('旧角色卡记录仍存在，说明迁移尚未成功；已取消保存以保护原始数据。');
                    }
                    const oldOrder = indexValue === undefined
                        ? []
                        : normalizeIndexOrder(indexValue);

                    for (const item of prepared) {
                        const cached = hashCache.get(item.uuid);
                        if (indexValue !== undefined && cached?.hash === item.hash && cached.avatar === item.avatar) continue;
                        summary.writtenKeys.push(item.key);
                        trackWrite(store.put(cloneCard(item), item.key), item.key);
                    }

                    for (const uuid of oldOrder) {
                        if (newUuidSet.has(uuid)) continue;
                        const key = characterKey(uuid);
                        summary.deletedKeys.push(key);
                        trackWrite(store.delete(key), key);
                    }

                    if (indexValue === undefined || !sameOrder(oldOrder, newOrder)) {
                        summary.indexWritten = true;
                        trackWrite(store.put({ order: newOrder }, INDEX_KEY), INDEX_KEY);
                    }
                } catch (error) {
                    rememberError(error);
                    tx.abort();
                }
            };

            const indexRequest = store.get(INDEX_KEY);
            indexRequest.onerror = () => rememberError(
                new Error(`读取角色卡索引 ${INDEX_KEY} 失败。`, { cause: indexRequest.error })
            );
            indexRequest.onsuccess = () => {
                indexValue = indexRequest.result;
                indexReady = true;
                processReads();
            };

            const legacyRequest = store.get(LEGACY_KEY);
            legacyRequest.onerror = () => rememberError(
                new Error(`读取旧角色卡记录 ${LEGACY_KEY} 失败。`, { cause: legacyRequest.error })
            );
            legacyRequest.onsuccess = () => {
                legacyValue = legacyRequest.result;
                legacyReady = true;
                processReads();
            };
        });
    }

    function saveAll(list) {
        return enqueueMutation(() => saveAllNow(list));
    }

    async function waitForPendingMutations() {
        await mutationQueue;
    }

    async function auditCurrentAppJs() {
        try {
            const response = await fetch(APP_JS_URL, {
                cache: 'no-store',
                credentials: 'same-origin'
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const source = await response.text();
            if (UNPATCHED_CHARACTER_SAVE.test(source)) {
                const reason = '检测到当前 app.js 未应用角色卡分键补丁。为避免新旧存储并存，本次上传已被阻止；请先更新程序。';
                patchAudit = { status: 'blocked', reason };
                console.error(`[RPHubCharStore] ${reason}`);
                try {
                    globalThis.alert?.(reason);
                } catch (_) { }
                return patchAudit;
            }
            patchAudit = { status: 'ok', reason: '' };
            return patchAudit;
        } catch (_) {
            patchAudit = { status: 'skipped', reason: '' };
            return patchAudit;
        }
    }

    function startPatchAudit() {
        if (patchAuditPromise) return patchAuditPromise;
        patchAuditPromise = new Promise((resolve) => {
            const run = () => setTimeout(() => {
                auditCurrentAppJs().then(resolve);
            }, 0);
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', run, { once: true });
            } else {
                run();
            }
        });
        return patchAuditPromise;
    }

    async function assertPushAllowed() {
        await startPatchAudit();
        if (patchAudit.status === 'blocked') throw new Error(patchAudit.reason);
        return true;
    }

    globalThis.RPHubCharStore = Object.freeze({
        loadAll,
        saveAll,
        migrate,
        waitForPendingMutations,
        assertPushAllowed,
        getPatchAuditStatus: () => ({ ...patchAudit })
    });
})();
