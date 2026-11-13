/* RP-Hub workshop module loader and plugin SDK v4. */
(() => {
    'use strict';

    const API_VERSION = 9;
    const LOADER_VERSION = 'r2-workshop-8';
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
    // 记忆总结、二次压缩、UI 变量分析和插件经 ctx.ai 发的副请求里带的文字；带这些文字的请求不算主聊天。
    const AI_REQUEST_MARKER = '（插件附带请求）';
    const AUXILIARY_REQUEST_MARKERS = ['你是角色扮演对话的逐轮记忆整理器', '你是角色扮演长期记忆压缩器', '只分析一个UI模板', AI_REQUEST_MARKER];
    const MODULE_ID_PATTERN = /^[a-z0-9-]{3,32}$/;
    const RISK_WARNING = '风险警告：第三方代码拥有页面全部权限，包括云同步密码与生图密钥。仅安装你信任的来源。\n\n确认安装此模块吗？';
    const DEFAULT_MIRROR_BASE = 'https://update.rph.mornye.uk';
    const WORKSHOP_INDEX_TTL_MS = 60_000;

    const state = {
        installations: [],
        runtimesByUrl: new Map(),
        runtimesByScript: new WeakMap(),
        registeredIds: new Map(),
        pluginEntries: [],
        panel: null,
        managementBody: null,
        appSettled: false,
        resolveAppSettled: null,
        mounted: null,
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
        generationWatch: null,
        chatRequestHandlers: new Set(),
        fetchWrapped: false,
        composerButtons: [],
        pages: new Map(),
        pageWatch: null,
        workshopIndex: null,
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
            lastStatus: VALID_STATUSES.has(value.lastStatus) ? value.lastStatus : '',
            beforeMount: value.beforeMount === true
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
                lastStatus: entry.lastStatus,
                ...(entry.beforeMount ? { beforeMount: true } : {})
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

    // 提示条、面板、确认框都交给 DB/ui-kit.js，外观和动画跟页面原生弹窗一致。
    function showToast(message, options = {}) {
        window.RPHubUI.toast(message, { kind: options.kind || 'error', duration: 4_200 });
    }

    function confirmRisk(message = RISK_WARNING) {
        return window.RPHubUI.confirm({ title: '安装插件', message, confirmText: '确认安装', danger: true });
    }

    function closePanel() {
        state.panel?.close();
    }

    function openPanel(options) {
        if (!options || typeof options !== 'object' || typeof options.render !== 'function') {
            throw new TypeError('panel render must be a function');
        }
        closePanel();
        const panel = window.RPHubUI.openModal({
            title: String(options.title || '').trim(),
            attributes: { 'data-rph-workshop-panel': '' },
            bodyAttributes: { 'data-rph-workshop-panel-body': '' },
            closeAttributes: { 'data-rph-workshop-panel-close': '' },
            onClose: () => {
                if (state.panel !== panel) return;
                state.panel = null;
                state.managementBody = null;
            },
            render: (body) => options.render(body)
        });
        state.panel = panel;
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

    // API 8：插件自己的整页功能（给完整的新功能用，普通插件仍用 addSidebarEntry）。导航菜单里加一个入口，点开像「设置」那样占满主区域；
    // 页面标题栏和手机上打开导航的按钮由加载器提供，插件只管在 body 里画内容。render(body) 可以返回清理函数，离开页面时调用。
    // 没有主区域的旧版页面退回弹窗。
    function addPage(owner, options) {
        if (!options || typeof options.render !== 'function') throw new TypeError('page render must be a function');
        const label = String(options.label || '').trim();
        if (!label) throw new TypeError('page label is required');
        if (state.pages.has(owner)) throw new Error('每个插件只能有一个页面');
        const iconPaths = Array.isArray(options.iconPaths) ? options.iconPaths.map(String) : [];
        const page = { owner, label, iconPaths, view: `rph-page-${owner}`, render: options.render, root: null, cleanup: null };
        state.pages.set(owner, page);
        const open = () => {
            if (!document.querySelector('#app .app-main')) return openPanel({ title: label, render: options.render });
            appSet('currentView', page.view);
        };
        globalThis.RPHubNavAdapter?.registerEntry({
            id: `page-${owner}`, label, iconPaths, attributes: { 'data-rph-workshop-page-entry': owner }, onClick: open, waitForClose: true
        });
        if (state.pageWatch) syncPages(appGet('currentView'));
        else state.pageWatch = appWatch(() => appGet('currentView'), syncPages, { immediate: true });
        return Object.freeze({ open });
    }

    function syncPages(view) {
        for (const page of state.pages.values()) {
            if (page.view !== view) closePage(page);
            else if (!page.root?.isConnected) openPage(page);
        }
    }

    function openPage(page) {
        const main = document.querySelector('#app .app-main');
        if (!main) return;
        closePage(page);
        const root = element('div', 'management-view settings-view');
        root.dataset.rphWorkshopPage = page.owner;
        const header = element('div', 'settings-page-header');
        const heading = element('div', 'management-page-heading');
        const menu = element('button', 'app-nav-trigger');
        menu.type = 'button';
        menu.setAttribute('aria-label', '打开导航');
        menu.setAttribute('aria-haspopup', 'dialog');
        menu.setAttribute('aria-controls', 'app-navigation-panel');
        menu.innerHTML = '<svg class="w-6 h-6" fill="none" stroke="currentColor"><use href="#icon-menu"></use></svg>';
        menu.addEventListener('click', () => appGet('toggleNavigation')?.());
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('class', 'w-6 h-6 md:w-7 md:h-7 mr-2 text-primary-600');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('viewBox', '0 0 24 24');
        for (const data of page.iconPaths) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', data);
            path.setAttribute('stroke-width', '2');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            icon.appendChild(path);
        }
        const title = element('h2', 'text-xl md:text-2xl font-bold text-gray-800 flex items-center');
        title.append(icon, page.label);
        heading.append(menu, title);
        header.appendChild(heading);
        const body = element('div', 'settings-stack');
        body.dataset.rphWorkshopPageBody = '';
        root.append(header, body);
        main.appendChild(root);
        page.root = root;
        try {
            const cleanup = page.render(body);
            page.cleanup = typeof cleanup === 'function' ? cleanup : null;
        } catch (error) {
            log(`page for ${page.owner} failed`, error);
        }
    }

    function closePage(page) {
        if (page.cleanup) safeCall(`page cleanup for ${page.owner}`, page.cleanup);
        page.cleanup = null;
        page.root?.remove();
        page.root = null;
    }

    // 插件入口集中在「模块管理」面板顶部，不逐个放进导航菜单；装多少插件，导航菜单都不会变长。
    function releaseSidebarEntries(owner) {
        state.pluginEntries = state.pluginEntries.filter((entry) => entry.owner !== owner);
        refreshManagementPanel();
    }

    function addSidebarEntry(owner, options) {
        if (!options || typeof options.onClick !== 'function') throw new TypeError('sidebar entry onClick must be a function');
        const label = String(options.label || '').trim();
        if (!label) throw new TypeError('sidebar entry label is required');
        state.pluginEntries.push({ owner, label, onClick: options.onClick });
        refreshManagementPanel();
    }

    function renderPluginLauncher(body) {
        if (!state.pluginEntries.length) return;
        const section = element('section', 'rph-ui-section');
        section.dataset.rphWorkshopLauncher = '';
        const grid = element('div', 'rph-ui-grid');
        state.pluginEntries.forEach((entry, index) => {
            const button = makeButton(entry.label);
            button.dataset.rphWorkshopSidebarEntry = `module-${index + 1}`;
            button.dataset.rphWorkshopModuleId = entry.owner;
            button.title = state.registeredIds.get(entry.owner)?.manifest?.name || entry.owner;
            button.addEventListener('click', () => {
                closePanel();
                safeCall(`plugin entry for ${entry.owner}`, entry.onClick);
            });
            grid.appendChild(button);
        });
        section.append(element('h3', '', '插件功能'), grid);
        body.appendChild(section);
    }

    const STATUS_LABELS = {
        ok: ['正常', ''],
        'load-error': ['加载失败', 'error'],
        'init-error': ['初始化失败', 'error'],
        'api-mismatch': ['API 不符', 'error']
    };

    function element(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function makeButton(label, kind = 'secondary') {
        return window.RPHubUI.button(label, kind);
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

    function addInstallation(entry) {
        state.installations.push(entry);
        if (writeInstallations()) return true;
        state.installations.pop();
        showToast('模块安装列表保存失败');
        return false;
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
        if (!await confirmRisk()) return;
        try { await loadModuleSource({ url }); }
        catch (error) {
            showToast(`无法保存插件文件：${error.message}。地址须支持跨域下载，也可导入 JS 文件。`);
            return;
        }
        if (state.installations.some(entry => entry.url === url)) return;
        if (!addInstallation({ id: '', url, enabled: true, addedAt: Date.now(), lastStatus: '' })) return;
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

    // ---- 工坊：分发端审核上架的插件，一键安装/更新 ----
    function workshopBase() {
        const injected = globalThis.RPH_R2_MIRROR_BASE;
        return typeof injected === 'string' ? injected.replace(/\/+$/, '') : DEFAULT_MIRROR_BASE;
    }

    function loadWorkshopIndex() {
        if (!state.workshopIndex || Date.now() - state.workshopIndex.at > WORKSHOP_INDEX_TTL_MS) {
            const promise = fetch(`${workshopBase()}/workshop/index.json`, { credentials: 'omit', signal: AbortSignal.timeout(15000) })
                .then((response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.json();
                });
            state.workshopIndex = { at: Date.now(), promise };
            promise.catch(() => { if (state.workshopIndex?.promise === promise) state.workshopIndex = null; });
        }
        return state.workshopIndex.promise;
    }

    // 下载插件并核对工坊目录里的指纹，不一致就拒绝，避免装上被替换或损坏的文件。
    async function fetchWorkshopSource(plugin) {
        const response = await fetch(workshopBase() + plugin.file.path, { credentials: 'omit', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`插件下载失败 (${response.status})`);
        const bytes = await response.arrayBuffer();
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        if (digest !== plugin.file.sha256) throw new Error('插件文件与工坊目录不一致，已取消');
        return new TextDecoder().decode(bytes);
    }

    // 更新写回原安装的文件，安装身份、启用状态和插件数据都保留。
