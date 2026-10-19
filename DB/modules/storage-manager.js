// 空间管理：官方 2.0.4 把设置页的「空间管理」删了，这个插件照 2.0.3 原样补在设置页最底下：
// 看网页存储用了多少、各类数据各占多少，一键清理已删角色留下的聊天、记忆、分支和旧版残留。
// 官方页面还有「空间管理」时（2.0.3 及更早）什么都不做。
RPHubSDK.register({
    id: 'storage-manager', name: '空间管理', version: '1.0.0', requiresApi: 3,
    init(ctx) {
        'use strict';
        const SCOPED_NAMES = ['chat', 'classic_memories', 'branches'];
        const CATEGORIES = [
            { key: 'characters', label: '角色卡', color: '#4659e2' },
            { key: 'chat', label: '聊天记录', color: '#7b8ff8' },
            { key: 'classic', label: '记忆系统', color: '#4fb3a4' },
            { key: 'other', label: '其他', color: '#9d9dab' }
        ];
        const state = { loading: false, cleaning: false, measured: false, error: '', usage: 0, quota: 0, orphanBytes: 0, orphans: { main: [], legacy: [] }, categories: [] };
        let section = null;

        const formatSize = (bytes) => {
            const size = Math.max(0, Number(bytes) || 0);
            if (size < 1024) return `${Math.round(size)} B`;
            const units = ['KB', 'MB', 'GB'];
            let value = size / 1024;
            let unit = 0;
            while (unit < units.length - 1 && value >= 1024) { value /= 1024; unit++; }
            return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
        };
        const valueSize = (value, seen = new WeakSet()) => {
            if (value == null) return 0;
            if (typeof value === 'string') return value.length * 2;
            if (typeof value === 'number' || typeof value === 'bigint') return 8;
            if (typeof value === 'boolean') return 4;
            if (typeof value !== 'object') return 0;
            if (value instanceof Blob) return value.size;
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
            if (seen.has(value)) return 0;
            seen.add(value);
            if (Array.isArray(value)) {
                if (value.length && typeof value[0] === 'number') return value.length * 8;
                return value.reduce((total, item) => total + valueSize(item, seen), 0);
            }
            return Object.keys(value).reduce((total, key) => total + key.length * 2 + valueSize(value[key], seen), 0);
        };
        const entrySize = (key, value) => String(key).length * 2 + valueSize(value);
        const categoryOf = (logical) => (logical === 'characters' || logical.startsWith('character_') ? 'characters'
            : logical.startsWith('chat_') ? 'chat' : logical.startsWith('classic_memories_') ? 'classic' : 'other');
        const scopeOf = (logical) => {
            const name = SCOPED_NAMES.find((item) => logical.startsWith(`${item}_`));
            return name ? { name, id: logical.slice(name.length + 1) } : null;
        };
        const scan = (db, source, visit) => new Promise((resolve, reject) => {
            if (!db) return resolve();
            const request = db.transaction(['store'], 'readonly').objectStore('store').openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return resolve();
                visit(source, String(cursor.key), cursor.value);
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        });
        const remove = (db, keys) => new Promise((resolve, reject) => {
            if (!db || !keys.length) return resolve();
            const transaction = db.transaction(['store'], 'readwrite');
            const store = transaction.objectStore('store');
            keys.forEach((key) => store.delete(key));
            transaction.oncomplete = () => resolve();
            transaction.onerror = transaction.onabort = () => reject(transaction.error);
        });

        async function measure() {
            if (state.loading) return;
            state.loading = true;
            state.error = '';
            render();
            try {
                const storage = window.RPHubStorage;
                if (!storage?.getMainDb()) throw new Error('数据库还没打开');
                const characters = ctx.app.get('characters') || [];
                // 现有角色既看页面，也看库里存着的角色（官方存一整个 characters，测试版按 character_<uuid> 分开存），
                // 页面没加载全时也不会把别人的聊天当成残留。
                const live = new Set(characters.map((character) => character?.uuid).filter(Boolean));
                const entries = [];
                const visit = (source, key, value) => {
                    const logical = storage.getStorageLogicalKey(key);
                    if (logical === 'characters' && Array.isArray(value)) value.forEach((character) => character?.uuid && live.add(character.uuid));
                    else if (logical.startsWith('character_') && logical !== 'character_index') live.add(logical.slice('character_'.length));
                    entries.push({ source, key, logical, bytes: entrySize(key, value) });
                };
                const [estimate] = await Promise.all([
                    navigator.storage?.estimate?.().catch(() => ({})) ?? {},
                    scan(storage.getMainDb(), 'main', visit),
                    scan(storage.getLegacyDb(), 'legacy', visit)
                ]);

                const mainLogical = new Set(entries.filter((entry) => entry.source === 'main').map((entry) => entry.logical));
                const scopedLogical = new Set(entries.map((entry) => entry.logical).filter(scopeOf));
                const isOrphan = ({ source, logical }) => {
                    // 旧版正文分片早已停用。
                    if (logical.startsWith('memories_')) return true;
                    if (source === 'legacy' && mainLogical.has(logical)) return true;
                    const scoped = scopeOf(logical);
                    if (!scoped || live.has(scoped.id.split('__branch__')[0])) return false;
                    if (scoped.name !== 'chat' || !/^\d+$/.test(scoped.id)) return true;
                    // 很老的版本按角色序号存聊天：那个序号的角色已经有按 uuid 存的聊天，才算残留。
                    const character = characters[Number(scoped.id)];
                    return characters.length > 0 && (!character || (!!character.uuid && scopedLogical.has(`chat_${character.uuid}`)));
                };

                const bytesBy = new Map(CATEGORIES.map((category) => [category.key, 0]));
                const add = (logical, bytes) => bytesBy.set(categoryOf(logical), bytesBy.get(categoryOf(logical)) + bytes);
                const orphans = { main: [], legacy: [] };
                let orphanBytes = 0;
                for (const entry of entries) {
                    add(entry.logical, entry.bytes);
                    if (!isOrphan(entry)) continue;
                    orphans[entry.source].push(entry.key);
                    orphanBytes += entry.bytes;
                }
                try {
                    for (let index = 0; index < localStorage.length; index++) {
                        const key = localStorage.key(index) || '';
                        add(key, entrySize(key, localStorage.getItem(key) || ''));
                    }
                } catch (_) { }

                // 和官方一样：按估算的比例摊到浏览器实测的占用上。
                const counted = [...bytesBy.values()].reduce((total, bytes) => total + bytes, 0);
                const usage = Number(estimate.usage) || counted;
                const scale = counted > 0 ? usage / counted : 1;
                Object.assign(state, {
                    usage, quota: Number(estimate.quota) || 0, orphanBytes: orphanBytes * scale, orphans, measured: true,
                    categories: CATEGORIES.map((category) => ({ ...category, bytes: bytesBy.get(category.key) * scale })).filter((category) => category.bytes > 0)
                });
            } catch (error) {
                ctx.log('读取存储信息失败', error);
                Object.assign(state, { error: '读取存储信息失败，请稍后重试', orphanBytes: 0, orphans: { main: [], legacy: [] }, categories: [] });
            } finally {
                state.loading = false;
                render();
            }
        }

        async function cleanup() {
            await measure();
            if (state.error) return;
            const { orphans, orphanBytes } = state;
            const count = orphans.main.length + orphans.legacy.length;
            if (!count) return ctx.ui.toast('没有发现无用残留', { kind: 'info' });
            const message = `将清理 ${count} 项无用残留（约 ${formatSize(orphanBytes)}）。现有角色的数据不会受到影响。`;
            if (!await window.RPHubUI.confirm({ title: '清理无用残留', message, confirmText: '清理', danger: true })) return;
            if (globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true) return ctx.ui.toast('正在从云端恢复数据，恢复完再清理', { kind: 'warning' });
            state.cleaning = true;
            render();
            try {
                const storage = window.RPHubStorage;
                await Promise.all([remove(storage.getMainDb(), orphans.main), remove(storage.getLegacyDb(), orphans.legacy)]);
                ctx.ui.toast(`已清理 ${count} 项无用残留，约 ${formatSize(orphanBytes)}`, { kind: 'success' });
            } catch (error) {
                ctx.log('清理失败', error);
                ctx.ui.toast('清理失败，请稍后重试', { kind: 'error' });
            } finally {
                state.cleaning = false;
            }
            await measure();
        }

        function render() {
            if (!section?.isConnected) return;
            const part = (name) => section.querySelector(`[data-part="${name}"]`);
            const busy = state.loading || state.cleaning;
            const count = state.orphans.main.length + state.orphans.legacy.length;
            Object.assign(part('measure'), { disabled: busy, textContent: state.loading ? '统计中...' : state.measured ? '重新统计' : '统计' });
            Object.assign(part('clean'), { disabled: busy || !count, textContent: state.cleaning ? '清理中...' : `清理无用残留（${formatSize(state.orphanBytes)}）` });
            Object.assign(part('error'), { hidden: !state.error, textContent: state.error });
            part('body').hidden = !!state.error;
            part('usage').textContent = formatSize(state.usage);
            part('quota').textContent = state.quota ? formatSize(state.quota) : '未知';
            part('bar').style.width = `${Math.min(100, Math.max(state.usage ? 1 : 0, state.quota ? state.usage / state.quota * 100 : 0))}%`;
            part('list').hidden = !state.categories.length;
            part('list').innerHTML = state.categories.map((category) => `<div class="flex items-center justify-between gap-4 py-3.5 text-sm">
                <div class="flex items-center min-w-0 text-gray-600"><span class="w-1 h-5 rounded-full mr-3 flex-shrink-0" style="background-color:${category.color}"></span><span class="truncate">${category.label}</span></div>
                <span class="font-semibold text-gray-600 tabular-nums whitespace-nowrap">${formatSize(category.bytes)}</span></div>`).join('');
        }

        function mount() {
            if (document.getElementById('rph-storage-manager')) return;
            const headings = [...document.querySelectorAll('h4.settings-subheading')];
            if (!headings.length || headings.some((heading) => heading.textContent.trim() === '空间管理')) return;
            const last = headings.at(-1).closest('.pt-6');
            if (!last) return;
            section = document.createElement('div');
            section.id = 'rph-storage-manager';
            section.className = 'pt-6 border-t border-gray-100 mt-6';
            section.innerHTML = `<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
                <h4 class="settings-subheading flex items-center !mb-0"><svg class="w-4 h-4 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7c0 1.1 3.58 2 8 2s8-.9 8-2m-16 0c0-1.1 3.58-2 8-2s8 .9 8 2m-16 0v5c0 1.1 3.58 2 8 2s8-.9 8-2V7m-16 5v5c0 1.1 3.58 2 8 2s8-.9 8-2v-5"></path></svg>空间管理</h4>
                <div class="flex flex-wrap items-center gap-2">
                    <button type="button" class="settings-action" data-part="measure"></button>
                    <button type="button" class="settings-action text-red-600 hover:bg-red-50" data-part="clean"></button>
                </div>
            </div>
            <div class="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-600" data-part="error"></div>
            <div class="space-y-6" data-part="body">
                <div>
                    <div class="flex items-center justify-between gap-3 mb-3 text-sm">
                        <span class="font-bold text-gray-600">网页存储空间</span>
                        <span class="font-semibold text-gray-500 whitespace-nowrap"><span class="text-gray-700" data-part="usage"></span><span class="mx-1 text-gray-300">/</span><span data-part="quota"></span></span>
                    </div>
                    <div class="h-2 rounded-full bg-primary-50 overflow-hidden"><div class="h-full rounded-full bg-primary-500 transition-all duration-300" data-part="bar"></div></div>
                </div>
                <div class="border-y border-gray-100 divide-y divide-gray-100" data-part="list"></div>
            </div>`;
            section.querySelector('[data-part="measure"]').addEventListener('click', () => measure());
            section.querySelector('[data-part="clean"]').addEventListener('click', () => cleanup());
            last.after(section);
            render();
        }

        ctx.app.watch(() => ctx.app.get('currentView'), (view) => {
            if (view === 'settings') globalThis.Vue.nextTick(mount);
        }, { immediate: true });
    }
});
