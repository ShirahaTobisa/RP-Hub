/* RP-Hub workshop module loader and plugin SDK v4. */
(() => {
    'use strict';

    const API_VERSION = 4;
    const LOADER_VERSION = 'r2-workshop-4';
    const LIST_KEY = 'rp_hub_workshop_modules_v1';
    const DB_NAME = 'RPHubDB';
    const DB_STORE = 'store';
    const STORAGE_VALUE_LIMIT = 64 * 1024;
    const SOURCE_VALUE_LIMIT = 8 * 1024 * 1024;
    const REGISTER_TIMEOUT_MS = 3_000;
    const APP_STARTUP_SETTLE_MS = 1_000;
    const CHAT_MUTATION_THROTTLE_MS = 500;
    const VALID_STATUSES = new Set(['ok', 'load-error', 'init-error', 'api-mismatch', '']);
    const VALID_EVENTS = new Set(['ready', 'visibility', 'chat-mutation', 'persistence-flush', 'generation-start', 'generation-end']);
    // 记忆总结、二次压缩、UI 变量分析等副请求的开头文字；带这些文字的请求不算主聊天。
    const AUXILIARY_REQUEST_MARKERS = ['你是角色扮演对话的逐轮记忆整理器', '你是角色扮演长期记忆压缩器', '只分析一个UI模板'];
    const MODULE_ID_PATTERN = /^[a-z0-9-]{3,32}$/;

    const state = {
        installations: [],
        runtimesByUrl: new Map(),
        runtimesByScript: new WeakMap(),
        registeredIds: new Map(),
        sidebarEntries: new Map(),
        panelRoot: null,
        panelReturnFocus: null,
        panelEscapeHandler: null,
        managementBody: null,
        toastHost: null,
        appSettled: false,
        resolveAppSettled: null,
        runtimeActive: false,
        safeMode: false,
        chatObserver: null,
        dirtyRows: new Set(),
        chatDispatchTimer: null,
        flushHooked: globalThis.__rphWorkshopFlushHooked === true,
        flushRetryTimer: null,
        dbPromise: null,
        workshopDbPromise: null,
        pendingWrites: new Set(),
        writeErrors: new Map(),
        nextSidebarEntryId: 1,
        generationWatch: null,
        chatRequestHandlers: new Set(),
        fetchWrapped: false,
        composerButtons: [],
        listeners: {
            ready: new Set(),
            visibility: new Set(),
            'chat-mutation': new Set(),
            'persistence-flush': new Set(),
            'generation-start': new Set(),
            'generation-end': new Set()
        }
    };

    const appSettled = new Promise((resolve) => { state.resolveAppSettled = resolve; });

    function log(...args) {
        try { console.warn('[RPH-workshop]', ...args); } catch (_) { /* no-op */ }
    }

    function normalizeInstallation(value) {
        if (!value || typeof value !== 'object' || typeof value.url !== 'string') return null;
        const url = value.url.trim();
        if (!url) return null;
        return {
            id: typeof value.id === 'string' ? value.id : '',
            name: typeof value.name === 'string' ? value.name : '',
            version: typeof value.version === 'string' ? value.version : '',
            url,
            enabled: value.enabled === true,
            addedAt: Number.isFinite(value.addedAt) ? value.addedAt : 0,
            lastStatus: VALID_STATUSES.has(value.lastStatus) ? value.lastStatus : ''
        };
    }

    function readInstallations() {
        try {
            const parsed = JSON.parse(localStorage.getItem(LIST_KEY) || '[]');
            if (!Array.isArray(parsed)) return [];
            const urls = new Set();
            const result = [];
            for (const value of parsed) {
                const entry = normalizeInstallation(value);
                if (!entry || urls.has(entry.url)) continue;
                urls.add(entry.url);
                result.push(entry);
            }
            return result;
        } catch (_) {
            return [];
        }
    }

    function writeInstallations() {
        if (globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS) return false;
        try {
            localStorage.setItem(LIST_KEY, JSON.stringify(state.installations.map((entry) => ({
                id: entry.id,
                name: entry.name || '',
                version: entry.version || '',
                url: entry.url,
                enabled: entry.enabled,
                addedAt: entry.addedAt,
                lastStatus: entry.lastStatus
            }))));
            return true;
        } catch (error) {
            log('module list persistence failed', error);
            return false;
        }
    }

    function allowedUrl(value) {
        if (typeof value !== 'string' || value.length > 500) return false;
        try {
            const url = new URL(value);
            if (url.protocol === 'https:') return true;
            // Test-only exception. Production third-party URLs must use HTTPS.
            return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
        } catch (_) {
            return false;
        }
    }

    function openWorkshopDatabase() {
        if (state.workshopDbPromise) return state.workshopDbPromise;
        state.workshopDbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubWorkshop', 1);
            request.onupgradeneeded = () => {
                for (const name of ['scripts', 'data']) {
                    if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
                }
            };
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => { db.close(); state.workshopDbPromise = null; };
                resolve(db);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('请关闭其他 RP-Hub 页面后重试'));
        }).catch(error => { state.workshopDbPromise = null; throw error; });
        return state.workshopDbPromise;
    }

    async function workshopTransaction(storeName, mode, operation) {
        const db = await openWorkshopDatabase();
        if (mode === 'readwrite' && globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS) {
            return globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE(() => workshopTransaction(storeName, mode, operation));
        }
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            let request;
            try { request = operation(tx.objectStore(storeName)); }
            catch (error) { tx.abort(); reject(error); return; }
            tx.oncomplete = () => resolve(request?.result);
            tx.onabort = tx.onerror = () => reject(tx.error || new Error('插件数据保存失败'));
        });
    }

    function trackPersistence(identity, operation) {
        const pending = Promise.resolve().then(operation);
        state.pendingWrites.add(pending);
        pending.then(() => {
            state.pendingWrites.delete(pending);
            state.writeErrors.delete(identity);
        }, error => {
            state.pendingWrites.delete(pending);
            state.writeErrors.set(identity, error);
        });
        return pending;
    }

    function workshopWrite(storeName, key, operation) {
        return trackPersistence(storeName + ':' + key, () => workshopTransaction(storeName, 'readwrite', operation));
    }

    function validateData(value, seen = new Set()) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
        if (typeof value === 'number' && Number.isFinite(value)) return;
        if (typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
            || seen.has(value)) throw new TypeError('插件数据必须是 JSON 数据；文件请先转成文本分块');
        seen.add(value);
        for (const item of Object.values(value)) validateData(item, seen);
        seen.delete(value);
    }

    function saveModuleSource(url, code) {
        if (!code.trim() || storageByteLength(code) > SOURCE_VALUE_LIMIT) {
            throw new Error('插件文件不能为空，且不能超过 8 MiB');
        }
        return workshopWrite('scripts', url, store => store.put(code, url));
    }

    async function loadModuleSource(entry) {
        const cached = await workshopTransaction('scripts', 'readonly', store => store.get(entry.url));
        if (typeof cached === 'string' && cached.trim()) return cached;
        if (!allowedUrl(entry.url)) throw new Error('插件文件缺失，请重新导入');
        const response = await fetch(entry.url, { credentials: 'omit', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`插件下载失败 (${response.status})`);
        const code = await response.text();
        await saveModuleSource(entry.url, code);
        return code;
    }

    async function flushWorkshop() {
        for (const runtime of state.runtimesByUrl.values()) {
            await runtime.loading;
            await runtime.initializing;
            if (runtime.entry.enabled && runtime.initError) throw runtime.initError;
        }
        for (const entry of state.installations) await loadModuleSource(entry);
        while (state.pendingWrites.size) await Promise.allSettled([...state.pendingWrites]);
        if (state.writeErrors.size) throw new Error('插件数据尚未保存成功，已取消上传', { cause: state.writeErrors.values().next().value });
    }

    function showToast(message, options = {}) {
        const text = String(message || '').trim();
        if (!text) return;
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', () => showToast(text, options), { once: true });
            return;
        }
        let host = state.toastHost;
        if (!host?.isConnected) {
            host = document.createElement('div');
            host.id = 'rph-workshop-toast-host';
            host.setAttribute('aria-live', 'assertive');
            host.setAttribute('aria-atomic', 'false');
            host.style.cssText = 'position:fixed;left:50%;top:16px;z-index:2147483646;display:flex;flex-direction:column;align-items:center;gap:8px;width:min(440px,calc(100vw - 24px));pointer-events:none;font:13px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';
            document.body.appendChild(host);
            state.toastHost = host;
        }
        const duplicate = [...host.children].find((item) => item.textContent === text);
        if (duplicate) duplicate.remove();
        const toast = document.createElement('div');
        const kind = options.kind === 'info' ? 'info' : 'error';
        toast.dataset.rphWorkshopToast = kind;
        toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        toast.textContent = text;
        toast.style.cssText = kind === 'info'
            ? 'max-width:100%;padding:9px 12px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#334155;box-shadow:0 8px 22px rgba(15,23,42,.16);overflow-wrap:anywhere;'
            : 'max-width:100%;padding:9px 12px;border:1px solid #fecaca;border-radius:7px;background:#fff;color:#991b1b;box-shadow:0 8px 22px rgba(15,23,42,.16);overflow-wrap:anywhere;';
        host.appendChild(toast);
        setTimeout(() => {
            toast.remove();
            if (host.childElementCount === 0) {
                host.remove();
                if (state.toastHost === host) state.toastHost = null;
            }
        }, 4_200);
    }

    function closePanel() {
        if (state.panelEscapeHandler) document.removeEventListener('keydown', state.panelEscapeHandler);
        state.panelEscapeHandler = null;
        state.managementBody = null;
        state.panelRoot?.remove();
        state.panelRoot = null;
        if (state.panelReturnFocus?.isConnected && state.panelReturnFocus.getClientRects().length) state.panelReturnFocus.focus();
        state.panelReturnFocus = null;
    }

    function openPanel(options) {
        if (!options || typeof options !== 'object' || typeof options.render !== 'function') {
            throw new TypeError('panel render must be a function');
        }
        const title = String(options.title || '').trim();
        closePanel();
        state.panelReturnFocus = document.activeElement;
        const root = document.createElement('div');
        root.dataset.rphWorkshopPanel = '';
        root.style.cssText = 'position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.48);font:14px/1.45 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';
        const dialog = document.createElement('section');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', title || '面板');
        dialog.style.cssText = 'display:flex;flex-direction:column;width:min(720px,100%);max-height:min(760px,calc(100vh - 32px));overflow:hidden;border:1px solid #d8dee8;border-radius:8px;background:#fff;color:#18212f;box-shadow:0 22px 60px rgba(15,23,42,.28);';
        const header = document.createElement('header');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid #e5e9f0;';
        const heading = document.createElement('h2');
        heading.textContent = title;
        heading.style.cssText = 'min-width:0;margin:0;font-size:17px;font-weight:650;line-height:1.3;overflow-wrap:anywhere;';
        const close = document.createElement('button');
        close.type = 'button';
        close.dataset.rphWorkshopPanelClose = '';
        close.setAttribute('aria-label', '关闭');
        close.setAttribute('title', '关闭');
        close.textContent = '×';
        close.style.cssText = 'flex:0 0 32px;width:32px;height:32px;border:0;border-radius:6px;background:transparent;color:#475569;font-size:24px;line-height:30px;cursor:pointer;';
        close.addEventListener('click', closePanel);
        header.append(heading, close);
        const body = document.createElement('div');
        body.dataset.rphWorkshopPanelBody = '';
        body.style.cssText = 'min-height:0;overflow:auto;padding:16px;';
        dialog.append(header, body);
        root.appendChild(dialog);
        root.addEventListener('click', (event) => { if (event.target === root) closePanel(); });
        state.panelEscapeHandler = (event) => { if (event.key === 'Escape') closePanel(); };
        document.addEventListener('keydown', state.panelEscapeHandler);
        document.body.appendChild(root);
        state.panelRoot = root;
        try {
            options.render(body);
            if (!root.contains(document.activeElement)) close.focus();
        } catch (error) {
            closePanel();
            throw error;
        }
    }

    // 输入框上方那排按钮（“快捷面板”所在行）。页面重新渲染会丢掉插入的按钮，由 ensureComposerButtons 补回。
    const COMPOSER_ANCHOR = 'button[aria-controls="chat-quick-panel"]';

    function ensureComposerButtons() {
        if (state.composerButtons.every((button) => button.isConnected)) return;
        const anchor = document.querySelector(COMPOSER_ANCHOR);
        if (!anchor) return;
        for (const button of state.composerButtons) {
            if (button.isConnected) continue;
            button.className = anchor.className;
            anchor.before(button);
        }
    }

    function addComposerButton(owner, options) {
        if (!options || typeof options.onClick !== 'function') throw new TypeError('composer button onClick must be a function');
        const label = String(options.label || '').trim();
        if (!label) throw new TypeError('composer button label is required');
        const button = document.createElement('button');
        button.type = 'button';
        button.title = label;
        button.setAttribute('aria-label', label);
        button.dataset.rphWorkshopComposerButton = owner;
        button.textContent = String(options.text || label).slice(0, 2);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            safeCall(`composer button for ${owner}`, options.onClick);
        });
        state.composerButtons.push(button);
        ensureComposerButtons();
    }

    function releaseSidebarEntries(owner) {
        for (const entry of state.sidebarEntries.get(owner) || []) entry.dispose();
        state.sidebarEntries.delete(owner);
    }

    function addSidebarEntry(owner, options) {
        if (!options || typeof options.onClick !== 'function') throw new TypeError('sidebar entry onClick must be a function');
        const label = String(options.label || '').trim();
        if (!label) throw new TypeError('sidebar entry label is required');
        const key = 'module-' + state.nextSidebarEntryId++;
        const entry = window.RPHubNavAdapter.registerEntry({
            id: key, label, attributes: { 'data-rph-workshop-sidebar-entry': key, 'data-rph-workshop-module-id': owner },
            iconPaths: ['M8 3v4M16 3v4M6 7h12a2 2 0 012 2v7a4 4 0 01-4 4H8a4 4 0 01-4-4V9a2 2 0 012-2z', 'M9 12h.01M15 12h.01'],
            onClick: options.onClick, waitForClose: false
        });
        if (!state.sidebarEntries.has(owner)) state.sidebarEntries.set(owner, []);
        state.sidebarEntries.get(owner).push(entry);
    }

    function statusPresentation(status) {
        if (status === 'ok') return { label: '正常', color: '#166534', background: '#dcfce7' };
        if (status === 'load-error') return { label: '加载失败', color: '#991b1b', background: '#fee2e2' };
        if (status === 'init-error') return { label: '初始化失败', color: '#991b1b', background: '#fee2e2' };
        if (status === 'api-mismatch') return { label: 'API 不符', color: '#92400e', background: '#fef3c7' };
        return { label: '未加载', color: '#475569', background: '#e2e8f0' };
    }

    function makeButton(label, kind = 'secondary') {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.cssText = kind === 'primary'
            ? 'min-height:36px;padding:7px 12px;border:1px solid #2563eb;border-radius:6px;background:#2563eb;color:#fff;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap;'
            : kind === 'danger'
                ? 'min-height:34px;padding:6px 10px;border:1px solid #fecaca;border-radius:6px;background:#fff;color:#b91c1c;font:inherit;cursor:pointer;white-space:nowrap;'
                : 'min-height:36px;padding:7px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;font:inherit;cursor:pointer;white-space:nowrap;';
        return button;
    }

    function refreshManagementPanel() {
        if (state.managementBody?.isConnected) renderManagementPanel(state.managementBody);
    }

    function removeModuleStorage(id) {
        if (!MODULE_ID_PATTERN.test(id)) return;
        const prefix = `rph_mod_${id}::`;
        try {
            for (let index = localStorage.length - 1; index >= 0; index -= 1) {
                const key = localStorage.key(index);
                if (typeof key === 'string' && key.startsWith(prefix)) localStorage.removeItem(key);
            }
        } catch (error) {
            log(`storage cleanup failed for ${id}`, error);
        }
        const dataPrefix = id + '::';
        return workshopWrite('data', dataPrefix, store => {
            const request = store.openCursor(IDBKeyRange.bound(dataPrefix, dataPrefix + '\uffff'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) { cursor.delete(); cursor.continue(); }
            };
            return request;
        });
    }

    async function installFromInput(input) {
        const url = String(input.value || '').trim();
        if (url.length > 500) {
            showToast('模块 URL 不能超过 500 个字符');
            return;
        }
        if (!allowedUrl(url)) {
            showToast('模块 URL 必须使用 HTTPS');
            return;
        }
        if (state.installations.some((entry) => entry.url === url)) {
            showToast('该模块 URL 已安装');
            return;
        }
        const warning = '风险警告：第三方代码拥有页面全部权限，包括云同步密码与生图密钥。仅安装你信任的来源。\n\n确认安装此模块吗？';
        if (!globalThis.confirm(warning)) return;
        try { await loadModuleSource({ url }); }
        catch (error) {
            showToast(`无法保存插件文件：${error.message}。地址须支持跨域下载，也可导入 JS 文件。`);
            return;
        }
        if (state.installations.some(entry => entry.url === url)) return;
        state.installations.push({ id: '', url, enabled: true, addedAt: Date.now(), lastStatus: '' });
        if (!writeInstallations()) {
            state.installations.pop();
            showToast('模块安装列表保存失败');
            return;
        }
        input.value = '';
        refreshManagementPanel();
        showToast('模块已安装，刷新后生效', { kind: 'info' });
    }

    function moduleFileInput(onFile) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.js,text/javascript';
        input.hidden = true;
        input.onchange = async () => {
            const file = input.files[0];
            input.value = '';
            if (!file) return;
            try {
                if (file.size > SOURCE_VALUE_LIMIT) throw new Error('插件文件不能超过 8 MiB');
                await onFile(file);
            } catch (error) { showToast(error.message); }
        };
        return input;
    }

    function renderManagementPanel(body) {
        body.replaceChildren();
        state.managementBody = body;
        const note = document.createElement('p');
        note.dataset.rphWorkshopNotice = '';
        note.textContent = '改动刷新后生效；插件文件、启用状态和插件数据随云同步保存。';
        note.style.cssText = 'margin:0 0 14px;padding:9px 11px;border-left:3px solid #2563eb;background:#eff6ff;color:#1e3a5f;';

        const addRow = document.createElement('div');
        addRow.style.cssText = 'display:flex;align-items:stretch;gap:8px;margin-bottom:12px;';
        const input = document.createElement('input');
        input.type = 'url';
        input.placeholder = 'https://example.com/module.js';
        input.maxLength = 501;
        input.dataset.rphWorkshopUrlInput = '';
        input.style.cssText = 'min-width:0;flex:1;height:36px;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#18212f;font:inherit;';
        const install = makeButton('安装', 'primary');
        install.dataset.rphWorkshopInstall = '';
        install.addEventListener('click', () => installFromInput(input));
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            installFromInput(input);
        });
        addRow.append(input, install);

        const importButton = makeButton('导入 JS 文件');
        importButton.dataset.rphWorkshopImport = '';
        const fileInput = moduleFileInput(async file => {
            if (!confirm('插件拥有页面全部权限。确认安装此文件并将它纳入云同步吗？')) return;
            const url = 'rphub-file:' + crypto.randomUUID() + '/' + encodeURIComponent(file.name);
            await saveModuleSource(url, await file.text());
            state.installations.push({ id: '', name: file.name, url, enabled: true, addedAt: Date.now(), lastStatus: '' });
            if (!writeInstallations()) { state.installations.pop(); throw new Error('安装列表保存失败'); }
            refreshManagementPanel();
            showToast('插件文件已保存，刷新后生效', { kind: 'info' });
        });
        importButton.onclick = () => fileInput.click();

        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;';
        const count = document.createElement('span');
        count.textContent = `已安装 ${state.installations.length} 个模块`;
        count.style.cssText = 'color:#64748b;font-size:13px;';
        const disableAll = makeButton('全部禁用');
        disableAll.dataset.rphWorkshopDisableAll = '';
        disableAll.disabled = !state.installations.some((entry) => entry.enabled);
        disableAll.addEventListener('click', () => {
            const changed = state.installations.some((entry) => entry.enabled);
            if (!changed) return;
            for (const entry of state.installations) entry.enabled = false;
            if (!writeInstallations()) {
                showToast('模块安装列表保存失败');
                return;
            }
            refreshManagementPanel();
            showToast('已禁用全部模块，刷新后生效', { kind: 'info' });
        });
        toolbar.append(count, disableAll);

        const list = document.createElement('div');
        list.dataset.rphWorkshopModuleList = '';
        list.style.cssText = 'border-top:1px solid #e5e9f0;';
        if (!state.installations.length) {
            const empty = document.createElement('p');
            empty.textContent = '尚未安装模块';
            empty.style.cssText = 'margin:0;padding:24px 8px;text-align:center;color:#64748b;';
            list.appendChild(empty);
        }
        for (const entry of state.installations) {
            const runtime = state.runtimesByUrl.get(entry.url);
            const manifest = runtime?.manifest || null;
            const row = document.createElement('div');
            row.dataset.rphWorkshopModuleRow = entry.url;
            row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:13px 4px;border-bottom:1px solid #e5e9f0;';
            const identity = document.createElement('div');
            identity.style.cssText = 'min-width:0;flex:1 1 220px;';
            const displayUrl = entry.url.startsWith('rphub-file:') ? '已保存的插件文件' : entry.url;
            const name = document.createElement('div');
            name.textContent = manifest?.name || entry.name || entry.id || displayUrl;
            name.style.cssText = 'font-weight:650;overflow-wrap:anywhere;';
            const detail = document.createElement('div');
            const version = manifest?.version || entry.version;
            detail.textContent = version ? `${displayUrl} · v${version}` : displayUrl;
            detail.style.cssText = 'margin-top:3px;color:#64748b;font-size:12px;overflow-wrap:anywhere;';
            identity.append(name, detail);
            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;gap:9px;flex-wrap:wrap;';
            const presentation = statusPresentation(entry.lastStatus);
            const badge = document.createElement('span');
            badge.dataset.rphWorkshopStatus = entry.lastStatus;
            badge.textContent = presentation.label;
            badge.style.cssText = `padding:3px 7px;border-radius:999px;background:${presentation.background};color:${presentation.color};font-size:12px;white-space:nowrap;`;
            const toggleLabel = document.createElement('label');
            toggleLabel.style.cssText = 'display:inline-flex;align-items:center;gap:5px;color:#475569;white-space:nowrap;cursor:pointer;';
            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.checked = entry.enabled;
            toggle.dataset.rphWorkshopEnabled = entry.url;
            toggle.addEventListener('change', () => {
                const previous = entry.enabled;
                entry.enabled = toggle.checked;
                if (!writeInstallations()) {
                    entry.enabled = previous;
                    toggle.checked = previous;
                    showToast('模块安装列表保存失败');
                    return;
                }
                showToast('模块启停改动将在刷新后生效', { kind: 'info' });
            });
            toggleLabel.append(toggle, document.createTextNode('启用'));
            const uninstall = makeButton('卸载', 'danger');
            uninstall.dataset.rphWorkshopUninstall = entry.url;
            uninstall.addEventListener('click', async () => {
                const index = state.installations.indexOf(entry);
                if (index < 0) return;
                state.installations.splice(index, 1);
                if (!writeInstallations()) {
                    state.installations.splice(index, 0, entry);
                    showToast('模块安装列表保存失败');
                    return;
                }
                releaseSidebarEntries(entry.id);
                try {
                    await removeModuleStorage(entry.id);
                    await workshopWrite('scripts', entry.url, store => store.delete(entry.url));
                } catch (error) { showToast(`插件数据清理失败：${error.message}`); }
                refreshManagementPanel();
                showToast('模块已卸载，刷新后生效', { kind: 'info' });
            });
            const replace = makeButton('更新文件');
            replace.dataset.rphWorkshopReplace = entry.url;
            const replacement = moduleFileInput(async file => {
                await saveModuleSource(entry.url, await file.text());
                showToast('插件文件已更新，原数据保留，刷新后生效', { kind: 'info' });
            });
            replace.onclick = () => replacement.click();
            actions.append(badge, toggleLabel, replace, replacement, uninstall);
            row.append(identity, actions);
            list.appendChild(row);
        }
        body.append(note, addRow, importButton, fileInput, toolbar, list);
    }

    function openManagementPanel() {
        openPanel({ title: '模块管理', render: renderManagementPanel });
    }

    // 调用插件回调：同步异常和被拒绝的 Promise 都只记日志，不影响页面和其他插件。
    function safeCall(label, callback, ...args) {
        try {
            const result = callback(...args);
            if (result && typeof result.then === 'function') result.catch((error) => log(`${label} failed`, error));
        } catch (error) {
            log(`${label} failed`, error);
        }
    }

    function dispatchEvent(name, payload) {
        for (const listener of [...state.listeners[name]]) {
            safeCall(`${name} listener for ${listener.id}`, listener.callback, payload);
        }
    }

    function subscribe(id, name, callback) {
        if (!VALID_EVENTS.has(name)) throw new TypeError(`unsupported event: ${name}`);
        if (typeof callback !== 'function') throw new TypeError('event callback must be a function');
        if (name.startsWith('generation-') && !state.generationWatch) {
            state.generationWatch = appWatch(() => appGet('isGenerating') === true,
                busy => dispatchEvent(busy ? 'generation-start' : 'generation-end'));
        }
        const listener = { id, callback };
        state.listeners[name].add(listener);
        if (name === 'ready' && state.appSettled) queueMicrotask(() => {
            if (state.listeners.ready.has(listener)) safeCall(`ready listener for ${id}`, callback);
        });
    }

    function appState() {
        const app = document.getElementById('app')?.__vue_app__;
        return (app?._instance || app?._container?._vnode?.component)?.setupState || null;
    }

    // 读页面数据或方法（如 chatHistory、settings、userInput、isGenerating、sendMessage）；返回的是页面里的原对象。
    function appGet(name) {
        const value = appState()?.[String(name)];
        return globalThis.Vue?.isRef?.(value) ? value.value : value;
    }

    // 改页面状态，如 set('userInput', '文字')；只改已有的状态，不新增。
    function appSet(name, value) {
        const state = appState();
        const key = String(name);
        if (!state || !(key in state) || typeof state[key] === 'function') throw new Error(`页面没有可修改的状态：${key}`);
        state[key] = value;
    }

    // getter 里用 appGet 读到的数据一变，就调用 callback(新值, 旧值)；返回停止监听的函数。
    function appWatch(getter, callback, options = {}) {
        if (typeof getter !== 'function' || typeof callback !== 'function') throw new TypeError('watch getter and callback must be functions');
        if (typeof globalThis.Vue?.watch !== 'function' || !appState()) throw new Error('页面尚未就绪，无法监听数据');
        return globalThis.Vue.watch(getter, (value, previous) => safeCall('app watch callback', callback, value, previous),
            { deep: options.deep === true, immediate: options.immediate === true });
    }

    function isMainChatRequest(url, body) {
        return /chat\/completions/i.test(url) && Array.isArray(body?.messages) && appGet('isGenerating') === true
            && !body.messages.some(message => AUXILIARY_REQUEST_MARKERS.some(marker => String(message?.content || '').includes(marker)));
    }

    // 主聊天请求发出前，依次交给插件修改请求体；某个插件出错时丢弃它的改动，其余照常。
    function wrapFetchOnce() {
        if (state.fetchWrapped) return;
        state.fetchWrapped = true;
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = async function (input, init) {
            const url = typeof input === 'string' ? input : input?.url || '';
            let body = null;
            try { if (typeof init?.body === 'string' && /chat\/completions/i.test(url)) body = JSON.parse(init.body); } catch (_) { /* 非 JSON 请求原样发送 */ }
            if (isMainChatRequest(url, body)) {
                for (const handler of [...state.chatRequestHandlers]) {
                    try {
                        const draft = structuredClone(body);
                        await handler.callback(draft);
                        body = draft;
                    } catch (error) {
                        log(`chat request handler failed for ${handler.id}`, error);
                    }
                }
                init = { ...init, body: JSON.stringify(body) };
            }
            return Reflect.apply(nativeFetch, this, [input, init]);
        };
    }

    function onChatRequest(id, callback) {
        if (typeof callback !== 'function') throw new TypeError('chat request handler must be a function');
        const handler = { id, callback };
        state.chatRequestHandlers.add(handler);
        wrapFetchOnce();
        return () => state.chatRequestHandlers.delete(handler);
    }

    function collectDirtyRows(records) {
        const addClosest = (node) => {
            const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
            const row = element?.closest?.('[data-chat-index]');
            if (row) state.dirtyRows.add(row);
        };
        const addContained = (node) => {
            if (node?.nodeType !== Node.ELEMENT_NODE) return;
            if (node.matches?.('[data-chat-index]')) state.dirtyRows.add(node);
            for (const row of node.querySelectorAll?.('[data-chat-index]') || []) state.dirtyRows.add(row);
        };
        for (const record of records) {
            addClosest(record.target);
            if (record.type !== 'childList') continue;
            for (const node of record.addedNodes || []) {
                addClosest(node);
                addContained(node);
            }
        }
    }

    function scheduleChatMutationDispatch() {
        if (state.chatDispatchTimer || state.dirtyRows.size === 0) return;
        state.chatDispatchTimer = setTimeout(() => {
            state.chatDispatchTimer = null;
            const dirtyRows = [...state.dirtyRows].filter((row) => row.isConnected);
            state.dirtyRows.clear();
            if (dirtyRows.length) dispatchEvent('chat-mutation', { dirtyRows });
        }, CHAT_MUTATION_THROTTLE_MS);
    }

    function copyRphProperties(source, target) {
        for (const name of Object.getOwnPropertyNames(source)) {
            if (!name.startsWith('__rph')) continue;
            try { Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name)); }
            catch (error) { log(`flush marker propagation failed for ${name}`, error); }
        }
    }

    function wrapPersistenceFlushOnce() {
        if (state.flushHooked || globalThis.__rphWorkshopFlushHooked === true) {
            state.flushHooked = true;
            return true;
        }
        const current = globalThis.RPH_R2_FLUSH_PERSISTENCE;
        if (typeof current !== 'function') return false;
        const original = current;
        const wrapped = async function (...args) {
            try {
                return await Reflect.apply(original, this, args);
            } finally {
                dispatchEvent('persistence-flush');
            }
        };
        copyRphProperties(original, wrapped);
        if (wrapped.__rphWorkshopFlushWrapper !== true) {
            Object.defineProperty(wrapped, '__rphWorkshopFlushWrapper', { value: true });
        }
        try { globalThis.RPH_R2_FLUSH_PERSISTENCE = wrapped; }
        catch (error) { log('persistence flush wrapper installation failed', error); return false; }
        if (globalThis.RPH_R2_FLUSH_PERSISTENCE !== wrapped) return false;
        state.flushHooked = true;
        globalThis.__rphWorkshopFlushHooked = true;
        return true;
    }

    function retryPersistenceFlushHook() {
        state.flushRetryTimer = null;
        if (wrapPersistenceFlushOnce()) return;
        state.flushRetryTimer = setTimeout(retryPersistenceFlushHook, 250);
    }

    function installRuntimeHooks() {
        if (state.chatObserver || !state.runtimeActive) return;
        state.chatObserver = new MutationObserver((records) => {
            if (state.composerButtons.length) ensureComposerButtons();
            if (state.listeners['chat-mutation'].size === 0) return;
            collectDirtyRows(records);
            scheduleChatMutationDispatch();
        });
        state.chatObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
        document.addEventListener('visibilitychange', () => {
            dispatchEvent('visibility', {
                visibilityState: document.visibilityState,
                hidden: document.hidden
            });
        });
        retryPersistenceFlushHook();
    }

    function openAppDatabase() {
        if (state.dbPromise) return state.dbPromise;
        state.dbPromise = new Promise((resolve, reject) => {
            if (!globalThis.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
            const request = indexedDB.open(DB_NAME);
            let unexpectedUpgrade = false;
            request.onupgradeneeded = () => {
                unexpectedUpgrade = true;
                try { request.transaction.abort(); } catch (_) { /* no-op */ }
            };
            request.onsuccess = () => {
                const db = request.result;
                if (unexpectedUpgrade || !db.objectStoreNames.contains(DB_STORE)) {
                    db.close();
                    reject(new Error('RPHubDB/store unavailable'));
                    return;
                }
                db.onversionchange = () => db.close();
                resolve(db);
            };
            request.onerror = () => reject(request.error || new Error('RPHubDB open failed'));
            request.onblocked = () => reject(new Error('RPHubDB open blocked'));
        }).catch((error) => {
            state.dbPromise = null;
            throw error;
        });
        return state.dbPromise;
    }

    async function appDbGet(key) {
        const db = await openAppDatabase();
        return new Promise((resolve, reject) => {
            let request;
            try { request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(String(key)); }
            catch (error) { reject(error); return; }
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
        });
    }

    async function appDbKeys(prefix) {
        const db = await openAppDatabase();
        const keyPrefix = String(prefix || '');
        return new Promise((resolve, reject) => {
            const keys = [];
            let request;
            try {
                const range = IDBKeyRange.bound(keyPrefix, `${keyPrefix}\uffff`);
                request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).openKeyCursor(range);
            } catch (error) { reject(error); return; }
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) { resolve(keys); return; }
                if (typeof cursor.key === 'string' && cursor.key.startsWith(keyPrefix)) keys.push(cursor.key);
                cursor.continue();
            };
            request.onerror = () => reject(request.error || new Error('IndexedDB key scan failed'));
        });
    }

    function storageByteLength(value) {
        if (globalThis.TextEncoder) return new TextEncoder().encode(value).byteLength;
        return new Blob([value]).size;
    }

    function persistSetting(key, operation) {
        if (!globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS) return operation();
        void trackPersistence('setting:' + key, () => globalThis.RPH_R2_DEFER_PERSISTENCE_WRITE(operation))
            .catch(error => log('deferred module setting failed', error));
    }

    function buildContext(id) {
        const prefix = `rph_mod_${id}::`;
        return {
            log: (...args) => console.info(`[RPH-mod:${id}]`, ...args),
            version: { api: API_VERSION, loader: LOADER_VERSION },
            upstream: { updateInfo: globalThis.RPH_R2_UPDATE_INFO ?? null },
            storage: {
                get(key) {
                    try { return localStorage.getItem(prefix + String(key)); }
                    catch (_) { return null; }
                },
                set(key, value) {
                    const serialized = String(value);
                    if (storageByteLength(serialized) > STORAGE_VALUE_LIMIT) {
                        throw new RangeError('module storage value exceeds 64KB');
                    }
                    persistSetting(prefix + String(key), () => localStorage.setItem(prefix + String(key), serialized));
                },
                remove(key) {
                    try { persistSetting(prefix + String(key), () => localStorage.removeItem(prefix + String(key))); } catch (_) { /* no-op */ }
                }
            },
            appDb: {
                get: appDbGet,
                keys: appDbKeys
            },
            data: {
                get: key => workshopTransaction('data', 'readonly', store => store.get(id + '::' + String(key))),
                set(key, value) {
                    validateData(value);
                    const copy = structuredClone(value);
                    const fullKey = id + '::' + String(key);
                    return workshopWrite('data', fullKey, store => store.put(copy, fullKey));
                },
                remove(key) {
                    const fullKey = id + '::' + String(key);
                    return workshopWrite('data', fullKey, store => store.delete(fullKey));
                }
            },
            persistence: {
                track: (key, operation) => trackPersistence(id + ':' + String(key), operation)
            },
            ui: {
                toast: showToast,
                addSidebarEntry: (options) => addSidebarEntry(id, options),
                addComposerButton: (options) => addComposerButton(id, options),
                openPanel
            },
            events: {
                on: (name, callback) => subscribe(id, name, callback)
            },
            app: {
                get: appGet,
                set: appSet,
                watch: appWatch
            },
            requests: {
                onChat: callback => onChatRequest(id, callback)
            }
        };
    }

    function setRuntimeStatus(runtime, status) {
        runtime.entry.lastStatus = status;
        writeInstallations();
        refreshManagementPanel();
    }

    async function initializeRuntime(runtime) {
        try {
            await runtime.manifest.init(buildContext(runtime.manifest.id));
            setRuntimeStatus(runtime, 'ok');
            log(`module ${runtime.manifest.id} ready`);
        } catch (error) {
            runtime.initError = error;
            releaseSidebarEntries(runtime.manifest.id);
            setRuntimeStatus(runtime, 'init-error');
            log(`module ${runtime.manifest.id} initialization failed`, error);
        }
    }

    function validateManifest(manifest) {
        if (!manifest || typeof manifest !== 'object') return null;
        if (typeof manifest.id !== 'string' || !MODULE_ID_PATTERN.test(manifest.id)) return null;
        if (typeof manifest.name !== 'string' || !manifest.name.trim()) return null;
        if (typeof manifest.version !== 'string' || !manifest.version.trim()) return null;
        if (!Number.isInteger(manifest.requiresApi)) return null;
        if (typeof manifest.init !== 'function') return null;
        return {
            id: manifest.id,
            name: manifest.name.trim(),
            version: manifest.version.trim(),
            requiresApi: manifest.requiresApi,
            init: manifest.init
        };
    }

    function register(manifest) {
        const runtime = state.runtimesByScript.get(document.currentScript);
        if (!runtime || runtime.registrationAttempted) {
            log('ignored register call outside an active module script');
            return false;
        }
        runtime.registrationAttempted = true;
        if (runtime.registrationTimer) clearTimeout(runtime.registrationTimer);
        runtime.registrationTimer = null;
        let checked;
        try { checked = validateManifest(manifest); }
        catch (error) { log('module manifest validation failed', error); }
        if (!checked || state.registeredIds.has(checked.id)) {
            setRuntimeStatus(runtime, 'load-error');
            return false;
        }
        runtime.manifest = checked;
        if (checked.requiresApi > API_VERSION) {
            setRuntimeStatus(runtime, 'api-mismatch');
            showToast(`模块 ${checked.name} 需要 API ${checked.requiresApi}，当前为 ${API_VERSION}`);
            return false;
        }
        state.registeredIds.set(checked.id, runtime);
        runtime.entry.id = checked.id;
        runtime.entry.name = checked.name;
        runtime.entry.version = checked.version;
        runtime.entry.lastStatus = '';
        writeInstallations();
        refreshManagementPanel();
        runtime.initializing = appSettled.then(() => initializeRuntime(runtime));
        return true;
    }

    const sdk = Object.freeze({ apiVersion: API_VERSION, register, flush: flushWorkshop });
    globalThis.RPHubSDK = sdk;

    function createRuntime(entry) {
        const runtime = {
            entry,
            manifest: null,
            registrationAttempted: false,
            registrationTimer: null
        };
        state.runtimesByUrl.set(entry.url, runtime);
        entry.lastStatus = '';
        if (!allowedUrl(entry.url) && !entry.url.startsWith('rphub-file:')) {
            setRuntimeStatus(runtime, 'load-error');
            return;
        }
        const script = document.createElement('script');
        script.setAttribute('data-rph-workshop-module-script', '');
        state.runtimesByScript.set(script, runtime);
        script.onerror = () => {
            if (!runtime.registrationAttempted) setRuntimeStatus(runtime, 'load-error');
        };
        const awaitRegistration = () => {
            if (runtime.registrationAttempted) return;
            runtime.registrationTimer = setTimeout(() => {
                runtime.registrationTimer = null;
                if (!runtime.registrationAttempted) setRuntimeStatus(runtime, 'load-error');
            }, REGISTER_TIMEOUT_MS);
        };
        runtime.loading = appSettled.then(async () => {
            const code = await loadModuleSource(entry);
            script.textContent = code;
            document.head.appendChild(script);
            awaitRegistration();
        }).catch(error => {
            setRuntimeStatus(runtime, 'load-error');
            log('module source load failed', entry.url, error);
        });
    }

    function settleApp() {
        if (state.appSettled) return;
        state.appSettled = true;
        state.resolveAppSettled();
        dispatchEvent('ready');
    }

    function startDomRuntime() {

        if (state.safeMode) {
            const enabledCount = state.installations.filter((entry) => entry.enabled).length;
            showToast(`安全模式:已跳过 ${enabledCount} 个模块`, { kind: 'info' });
        }
        if (state.runtimeActive) installRuntimeHooks();
        setTimeout(settleApp, APP_STARTUP_SETTLE_MS);
    }

    window.RPHubNavAdapter.registerEntry({
        id: 'workshop', label: '模块管理',
        attributes: { 'data-rph-workshop-sidebar-entry': 'manager', 'data-rph-workshop-manager-entry': '' },
        iconPaths: ['M8.5 3h7l1 3H20a1 1 0 011 1v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a1 1 0 011-1h3.5l1-3z', 'M8 12h8M12 8v8'],
        onClick: openManagementPanel, waitForClose: true
    });
    state.installations = readInstallations();
    state.safeMode = new URLSearchParams(location.search).get('rph_safe_mode') === '1';
    const enabled = state.installations.filter((entry) => entry.enabled);
    state.runtimeActive = !state.safeMode && enabled.length > 0;
    if (state.runtimeActive) {
        for (const entry of enabled) createRuntime(entry);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startDomRuntime, { once: true });
    } else startDomRuntime();
})();
