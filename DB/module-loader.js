/* RP-Hub workshop module loader and plugin SDK v4. */
(() => {
    'use strict';

    const API_VERSION = 10;
    const LOADER_VERSION = 'r2-workshop-9';
    const LIST_KEY = 'rp_hub_workshop_modules_v1';
    // ctx.ui.addStyle(css, { early: true }) 的样式存在插件自己 storage 里的这个名字下，随卸载清理、随云同步走。
    const EARLY_STYLE_NAME = 'early-style';
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
    const RISK_WARNING = '插件将获得页面的全部权限（包括同步密码和生图密钥），请只安装可信来源的插件。';
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
        earlyStyles: new Map(),
        attachments: [],
        attachTimer: 0,
        services: new Map(),
        hooks: { functions: null, handlers: new Map() },
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
            beforeMount: value.beforeMount === true,
            hooks: value.hooks === true
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
                ...(entry.beforeMount ? { beforeMount: true } : {}),
                ...(entry.hooks ? { hooks: true } : {})
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
            throw new Error('插件文件不能为空，且不能超过 8 MB');
        }
        return workshopWrite('scripts', url, store => store.put(code, url));
    }

    async function loadModuleSource(entry) {
        const cached = await workshopTransaction('scripts', 'readonly', store => store.get(entry.url));
        if (typeof cached === 'string' && cached.trim()) return cached;
        if (!allowedUrl(entry.url)) throw new Error('插件文件缺失，请重新导入');
        const response = await fetch(entry.url, { credentials: 'omit', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`插件下载失败：HTTP ${response.status}`);
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
        if (state.writeErrors.size) throw new Error('插件数据保存失败，已取消上传', { cause: state.writeErrors.values().next().value });
    }

    // 提示条、面板、确认框都交给 DB/ui-kit.js，外观和动画跟页面原生弹窗一致。
    function showToast(message, options = {}) {
        window.RPHubUI.toast(message, { kind: options.kind || 'error', duration: 4_200 });
    }

    function confirmRisk() {
        return window.RPHubUI.confirm({ title: '安装插件', message: RISK_WARNING, confirmText: '安装', danger: true });
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

    // API 10：插件的样式。early 的那份记在本机，下次打开页面时第一帧就生效（那时插件还没加载），换配色不会先闪一下默认的；每个插件一份。
    function earlyStyleKey(owner) {
        return `rph_mod_${owner}::${EARLY_STYLE_NAME}`;
    }

    function styleNode(owner, css) {
        const node = element('style', '', css);
        node.dataset.rphWorkshopStyle = owner;
        document.head.appendChild(node);
        return node;
    }

    function applyEarlyStyles(entries) {
        for (const { id } of entries) {
            let css = '';
            try { css = id && localStorage.getItem(earlyStyleKey(id)); } catch (_) { /* storage blocked */ }
            if (css) state.earlyStyles.set(id, styleNode(id, css));
        }
    }

    function addStyle(owner, css, options = {}) {
        const early = options.early === true;
        const key = earlyStyleKey(owner);
        const node = (early && state.earlyStyles.get(owner)) || styleNode(owner, '');
        if (early) state.earlyStyles.set(owner, node);
        const set = (value) => {
            const text = String(value ?? '');
            if (early && storageByteLength(text) > STORAGE_VALUE_LIMIT) throw new RangeError('early style exceeds 64KB');
            node.textContent = text;
            if (early) persistSetting(key, () => (text ? localStorage.setItem(key, text) : localStorage.removeItem(key)));
        };
        // early 的样式不传内容时沿用上次记下的那份。
        if (css != null) set(css);
        return Object.freeze({
            set,
            remove() {
                set('');
                node.remove();
                if (state.earlyStyles.get(owner) === node) state.earlyStyles.delete(owner);
            }
        });
    }

    // API 10：把一块内容挂到页面里。anchor 是选择器或返回元素的函数，position 是 before / after / prepend / append。
    // 页面重画把它冲掉、或者锚点后来才出现时由加载器补回去；render(node) 只在第一次挂上时调用。
    function ensureAttachments() {
        state.attachTimer = 0;
        for (const item of state.attachments) {
            if (item.node.isConnected) continue;
            let target = null;
            try { target = typeof item.anchor === 'function' ? item.anchor() : document.querySelector(item.anchor); }
            catch (error) { log(`attach anchor for ${item.owner} failed`, error); }
            if (!target?.isConnected) continue;
            target[item.position](item.node);
            if (item.render) safeCall(`attach for ${item.owner}`, item.render, item.node);
            item.render = null;
        }
    }

    function attach(owner, options) {
        const { anchor, position = 'after', render } = options || {};
        if (typeof render !== 'function') throw new TypeError('attach render must be a function');
        if (typeof anchor !== 'string' && typeof anchor !== 'function') throw new TypeError('attach anchor must be a selector or a function');
        if (!['before', 'after', 'prepend', 'append'].includes(position)) throw new TypeError('unsupported attach position');
        const node = element('div');
        node.dataset.rphWorkshopAttach = owner;
        const item = { owner, node, anchor, position, render };
        state.attachments.push(item);
        ensureAttachments();
        return Object.freeze({
            node,
            remove() {
                state.attachments = state.attachments.filter((other) => other !== item);
                node.remove();
            }
        });
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
        'api-mismatch': ['版本不兼容', 'error']
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
        showToast('插件列表保存失败');
        return false;
    }

    async function installFromInput(input) {
        const url = String(input.value || '').trim();
        if (url.length > 500) {
            showToast('插件地址不能超过 500 个字符');
            return;
        }
        if (!allowedUrl(url)) {
            showToast('请输入 https:// 开头的插件地址');
            return;
        }
        if (state.installations.some((entry) => entry.url === url)) {
            showToast('该插件已安装');
            return;
        }
        if (!await confirmRisk()) return;
        try { await loadModuleSource({ url }); }
        catch (error) {
            showToast(`安装失败：${error.message}，也可以导入 JS 文件安装`);
            return;
        }
        if (state.installations.some(entry => entry.url === url)) return;
        if (!addInstallation({ id: '', url, enabled: true, addedAt: Date.now(), lastStatus: '' })) return;
        input.value = '';
        refreshManagementPanel();
        showToast('插件已安装，刷新后生效', { kind: 'info' });
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
                if (file.size > SOURCE_VALUE_LIMIT) throw new Error('插件文件不能超过 8 MB');
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
        if (!response.ok) throw new Error(`插件下载失败：HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        if (digest !== plugin.file.sha256) throw new Error('文件校验失败，请稍后重试');
        return new TextDecoder().decode(bytes);
    }

    // 更新写回原安装的文件，安装身份、启用状态和插件数据都保留。
    async function installWorkshopPlugin(plugin, installed) {
        if (!installed && !await confirmRisk()) {
            refreshManagementPanel();
            return;
        }
        try {
            const code = await fetchWorkshopSource(plugin);
            if (installed) {
                await saveModuleSource(installed.url, code);
                installed.version = plugin.version;
                writeInstallations();
                showToast(`${plugin.name} 已更新到 ${plugin.version}，刷新后生效`, { kind: 'info' });
            } else {
                const url = workshopBase() + plugin.file.path;
                await saveModuleSource(url, code);
                if (addInstallation({ id: '', name: plugin.name, version: plugin.version, url, enabled: true, addedAt: Date.now(), lastStatus: '' })) {
                    showToast(`${plugin.name} 已安装，刷新后生效`, { kind: 'info' });
                }
            }
        } catch (error) {
            showToast(`${plugin.name}：${error.message}`);
        }
        refreshManagementPanel();
    }

    function workshopRow(plugin) {
        const installed = state.installations.find((entry) => entry.id === plugin.id || entry.url === workshopBase() + plugin.file.path);
        const running = installed && state.runtimesByUrl.get(installed.url)?.manifest?.version;
        const row = element('div', 'rph-ui-row');
        row.dataset.rphWorkshopMarketRow = plugin.id;
        const info = element('div', 'rph-ui-row-main');
        info.append(element('div', '', `${plugin.name} · v${plugin.version} · ${plugin.author}`), element('div', 'rph-ui-muted', plugin.description));
        const [label, enabled] = plugin.requiresApi > API_VERSION ? ['需要更新测试版', false]
            : !installed ? ['安装', true]
                : installed.version !== plugin.version ? ['更新', true]
                    : running && running !== plugin.version ? ['刷新后生效', false] : ['已安装', false];
        const action = makeButton(label, enabled ? 'primary' : 'secondary');
        action.dataset.rphWorkshopMarketAction = plugin.id;
        action.disabled = !enabled;
        action.addEventListener('click', () => {
            action.disabled = true;
            installWorkshopPlugin(plugin, installed);
        });
        row.append(info, action);
        return row;
    }

    function renderWorkshopMarket(container) {
        const status = element('p', 'rph-ui-muted');
        container.appendChild(status);
        if (!workshopBase()) {
            status.textContent = '分发站已关闭，工坊不可用';
            return;
        }
        status.textContent = '加载中…';
        loadWorkshopIndex().then((index) => {
            if (!container.isConnected) return;
            const plugins = Array.isArray(index?.plugins) ? index.plugins : [];
            if (plugins.length) status.remove(); else status.textContent = '暂无插件';
            for (const plugin of plugins) container.appendChild(workshopRow(plugin));
        }, (error) => {
            if (container.isConnected) status.textContent = `加载失败：${error.message}`;
        });
    }

    function renderManagementPanel(body) {
        body.replaceChildren();
        state.managementBody = body;
        renderPluginLauncher(body);

        const addRow = element('div', 'rph-ui-inline');
        const input = element('input', 'rph-ui-input');
        input.type = 'url';
        input.placeholder = '输入插件地址';
        input.maxLength = 501;
        input.dataset.rphWorkshopUrlInput = '';
        const install = makeButton('安装', 'primary');
        install.dataset.rphWorkshopInstall = '';
        install.addEventListener('click', () => installFromInput(input));
        input.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            installFromInput(input);
        });
        const importButton = makeButton('导入 JS 文件');
        importButton.dataset.rphWorkshopImport = '';
        const fileInput = moduleFileInput(async file => {
            if (!await confirmRisk()) return;
            const url = 'rphub-file:' + crypto.randomUUID() + '/' + encodeURIComponent(file.name);
            await saveModuleSource(url, await file.text());
            if (!addInstallation({ id: '', name: file.name, url, enabled: true, addedAt: Date.now(), lastStatus: '' })) return;
            refreshManagementPanel();
            showToast('插件已安装，刷新后生效', { kind: 'info' });
        });
        importButton.onclick = () => fileInput.click();
        addRow.append(input, install, importButton, fileInput);

        const toolbar = element('div', 'rph-ui-inline');
        const count = element('span', 'rph-ui-muted', `已安装 ${state.installations.length} 个插件`);
        const disableAll = makeButton('全部禁用');
        disableAll.dataset.rphWorkshopDisableAll = '';
        disableAll.disabled = !state.installations.some((entry) => entry.enabled);
        disableAll.addEventListener('click', () => {
            const changed = state.installations.some((entry) => entry.enabled);
            if (!changed) return;
            for (const entry of state.installations) entry.enabled = false;
            if (!writeInstallations()) {
                showToast('插件列表保存失败');
                return;
            }
            refreshManagementPanel();
            showToast('已禁用全部插件，刷新后生效', { kind: 'info' });
        });
        toolbar.append(count, disableAll);

        const list = element('div', 'rph-ui-list');
        list.dataset.rphWorkshopModuleList = '';
        if (!state.installations.length) list.appendChild(element('p', 'rph-ui-empty', '暂无插件'));
        for (const entry of state.installations) {
            const runtime = state.runtimesByUrl.get(entry.url);
            const manifest = runtime?.manifest || null;
            const row = element('div', 'rph-ui-row');
            row.dataset.rphWorkshopModuleRow = entry.url;
            const displayUrl = entry.url.startsWith('rphub-file:') ? '本地导入' : entry.url;
            const version = manifest?.version || entry.version;
            const identity = element('div', 'rph-ui-row-main');
            identity.append(
                element('div', '', manifest?.name || entry.name || entry.id || displayUrl),
                element('div', 'rph-ui-muted', version ? `${displayUrl} · v${version}` : displayUrl)
            );
            const actions = element('div', 'rph-ui-row-actions');
            const [statusLabel, tone] = STATUS_LABELS[entry.lastStatus] || ['未加载', 'muted'];
            const badge = element('span', 'rph-ui-badge', statusLabel);
            badge.dataset.rphWorkshopStatus = entry.lastStatus;
            if (tone) badge.dataset.tone = tone;
            const toggleLabel = element('label', 'rph-ui-check');
            const toggle = element('input', 'settings-toggle-input sr-only');
            toggle.type = 'checkbox';
            toggle.checked = entry.enabled;
            toggle.dataset.rphWorkshopEnabled = entry.url;
            toggle.addEventListener('change', () => {
                const previous = entry.enabled;
                entry.enabled = toggle.checked;
                if (!writeInstallations()) {
                    entry.enabled = previous;
                    toggle.checked = previous;
                    showToast('插件列表保存失败');
                    return;
                }
                showToast('刷新后生效', { kind: 'info' });
            });
            toggleLabel.append(toggle, element('span', 'settings-toggle'), document.createTextNode('启用'));
            const uninstall = makeButton('卸载', 'danger');
            uninstall.dataset.rphWorkshopUninstall = entry.url;
            uninstall.addEventListener('click', async () => {
                const index = state.installations.indexOf(entry);
                if (index < 0) return;
                state.installations.splice(index, 1);
                if (!writeInstallations()) {
                    state.installations.splice(index, 0, entry);
                    showToast('插件列表保存失败');
                    return;
                }
                releaseSidebarEntries(entry.id);
                try {
                    await removeModuleStorage(entry.id);
                    await workshopWrite('scripts', entry.url, store => store.delete(entry.url));
                } catch (error) { showToast(`插件数据清理失败：${error.message}`); }
                refreshManagementPanel();
                showToast('插件已卸载，刷新后生效', { kind: 'info' });
            });
            const replace = makeButton('更新文件');
            replace.dataset.rphWorkshopReplace = entry.url;
            const replacement = moduleFileInput(async file => {
                await saveModuleSource(entry.url, await file.text());
                showToast('插件已更新，刷新后生效', { kind: 'info' });
            });
            replace.onclick = () => replacement.click();
            actions.append(badge, toggleLabel, replace, replacement, uninstall);
            row.append(identity, actions);
            list.appendChild(row);
        }
        const market = element('section', 'rph-ui-section');
        market.dataset.rphWorkshopMarket = '';
        market.appendChild(element('h3', '', '工坊'));
        renderWorkshopMarket(market);
        body.append(addRow, toolbar, list, market);
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

    // API 9：插件改过 chatHistory 里的消息之后调用，RPH 按自己的流程（排队、失败重试、失败提示）把当前聊天记录存盘，返回是否存成。
    // RPH 只在消息条数变化、自己编辑或生成结束时才存，插件改了正文不存就等于没改。
    function saveChatHistory() {
        const save = globalThis.RPH_R2_SAVE_CHAT_HISTORY;
        if (typeof save !== 'function') throw new Error('当前版本不支持插件保存聊天记录');
        return save();
    }

    // API 10：插件之间互相提供接口。use 返回 Promise，等有插件 provide 了这个名字才有结果，所以不用管谁先加载。
    function service(name) {
        const key = String(name);
        if (!state.services.has(key)) {
            const slot = { owner: '' };
            slot.promise = new Promise((resolve) => { slot.resolve = resolve; });
            state.services.set(key, slot);
        }
        return state.services.get(key);
    }

    function provide(owner, name, api) {
        const slot = service(name);
        if (slot.owner) throw new Error(`接口 ${name} 已经由 ${slot.owner} 提供`);
        slot.owner = owner;
        slot.resolve(api);
    }

    // API 10：ctx.hooks，让插件包住官方主程序里的函数。做法和柳贯一的五槽一样，挂载前把官方 setup 的源码改写后重新生成：
    // 顶层的「const 名字 = (参数) => …」改名成「名字$rph」，再补一个同名函数转给 hookCall，于是官方内部互相调用和页面按钮都会经过插件。
    // 官方写法变了对不上、或者改写后有语法错误，就保持原样，只是 ctx.hooks 用不了，页面和其他插件不受影响。
    function installHooks(options) {
        try {
            const source = String(options.setup);
            const head = /^(?:function\s*)?[\w$]*\s*(\([^)]*\))\s*\{/.exec(source);
            const indent = /\n([ \t]+)\S/.exec(source)?.[1];
            if (!head || !indent) throw new Error('setup 的写法对不上');
            const names = [];
            const body = source.slice(head[0].length).replace(
                new RegExp(`^(${indent}const )([A-Za-z_$][\\w$]*)(?= = (?:async )?(?:\\([^\\n]*\\)|[A-Za-z_$][\\w$]*) => )`, 'gm'),
                (match, declaration, name) => { names.push(name); return `${declaration}${name}$rph`; }
            );
            if (!names.length) throw new Error('没有找到可以包住的函数');
            const wrappers = names.map((name) => `function ${name}(...args) { return rphSetup.call$('${name}', ${name}$rph, args); }`).join(' ');
            const setup = (0, eval)(`(function rphSetup${head[1]} { rphSetup.bind$({ ${names.join(', ')} }); ${wrappers}${body})`);
            setup.call$ = hookCall;
            setup.bind$ = (functions) => { state.hooks.functions = functions; };
            options.setup = setup;
        } catch (error) {
            log('official function hooks unavailable', error);
        }
    }

    function hookCall(name, original, args) {
        const chain = state.hooks.handlers.get(name);
        return chain?.length ? runHook(name, chain, chain.length - 1, original, args) : original(...args);
    }

    // 一个插件的包装出错（没来得及调用 next，或者调完之后自己出错）只记日志，照常走官方流程和别的插件；官方函数自己抛的错原样往上抛。
    function runHook(name, chain, position, original, args) {
        if (position < 0) return original(...args);
        const { id, handler } = chain[position];
        let called = false, official = false, result;
        const next = (...nextArgs) => {
            called = true;
            try { result = runHook(name, chain, position - 1, original, nextArgs); }
            catch (error) { official = true; throw error; }
            if (typeof result?.then === 'function') result.then(undefined, () => { official = true; });
            return result;
        };
        const recover = (error) => {
            if (official) throw error;
            log(`hook ${name} of ${id} failed`, error);
            return called ? result : runHook(name, chain, position - 1, original, args);
        };
        try {
            const value = handler(next, ...args);
            return typeof value?.then === 'function' ? value.then(undefined, recover) : value;
        } catch (error) {
            return recover(error);
        }
    }

    function wrapHook(id, name, handler) {
        if (typeof handler !== 'function') throw new TypeError('hook handler must be a function');
        const key = String(name);
        const entry = { id, handler };
        if (!state.hooks.handlers.has(key)) state.hooks.handlers.set(key, []);
        state.hooks.handlers.get(key).push(entry);
        return () => {
            const chain = state.hooks.handlers.get(key);
            const index = chain.indexOf(entry);
            if (index >= 0) chain.splice(index, 1);
        };
    }

    function hasHook(name) {
        return !!state.hooks.functions && Object.hasOwn(state.hooks.functions, String(name));
    }

    function callHook(name, args) {
        if (!hasHook(name)) throw new Error(`官方函数 ${name} 现在调不到`);
        return state.hooks.functions[String(name)](...args);
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
            if (state.attachments.length && !state.attachTimer) state.attachTimer = requestAnimationFrame(ensureAttachments);
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
                db.onversionchange = () => { db.close(); state.dbPromise = null; };
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

        // operation 只负责排入请求；事务真正提交后才返回，任何同步错误都回滚本次事务。
    function withStore(db, name, mode, operation) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(name, mode);
            let result, failure;
            const abort = error => {
                if (failure) return;
                failure = error;
                tx.abort();
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = event => { failure ||= event.target.error; };
            tx.onabort = () => {
                const error = failure || tx.error || new Error('数据库事务已中止。');
                globalThis.RPHubDiagnostics?.failure('database-error', error);
                reject(error);
            };
            try { result = operation(tx.objectStore(name), abort); }
            catch (error) { abort(error); }
        });
    }


    async function appDbGet(key) {
        const db = await openAppDatabase();
        const request = await withStore(db, DB_STORE, 'readonly', store => store.get(String(key)));
        return request.result;
    }

    async function appDbKeys(prefix) {
        const db = await openAppDatabase();
        const keyPrefix = String(prefix || '');
        return withStore(db, DB_STORE, 'readonly', store => {
            const keys = [];
            const request = store.openKeyCursor(IDBKeyRange.bound(keyPrefix, keyPrefix + '\uffff'));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                if (typeof cursor.key === 'string' && cursor.key.startsWith(keyPrefix)) keys.push(cursor.key);
                cursor.continue();
            };
            return keys;
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
                addPage: (options) => addPage(id, options),
                addStyle: (css, options) => addStyle(id, css, options),
                attach: (options) => attach(id, options),
                openPanel
            },
            // API 10：插件之间互相提供接口。
            provide: (name, api) => provide(id, name, api),
            use: (name) => service(name).promise,
            // API 10：包住或调用官方主程序里的函数，manifest 要写 hooks: true。
            hooks: {
                has: hasHook,
                names: () => Object.keys(state.hooks.functions || {}),
                wrap: (name, handler) => wrapHook(id, name, handler),
                call: (name, ...args) => callHook(name, args)
            },
            events: {
                on: (name, callback) => subscribe(id, name, callback)
            },
            app: {
                get: appGet,
                set: appSet,
                watch: appWatch,
                saveChatHistory
            },
            requests: {
                onChat: callback => onChatRequest(id, callback)
            },
            // API 5：生图接口和生图参数，由生图模块（DB/image-module.js）实现。
            image: {
                registerProvider: (provider) => imageModule().registerImageProvider(provider),
                onParams: (handler) => imageModule().onImageParams(handler)
            },
            // API 7：用站点设置里的 AI 发一次请求，返回回复文字。
            ai: {
                complete: (options) => aiComplete(options)
            }
        };
    }

    // 默认用 RPH 设置里的「分析模型」（UI 模板分析那个），没设就用主模型；走 RPH 自己的请求函数，多接口分流照常生效。
    // 系统提示开头带上标记，加载器认得出这是附带请求，不交给 ctx.requests.onChat 改写。
    async function aiComplete({ messages, model, temperature = 0.3, signal } = {}) {
        const client = globalThis.RPHubApiClient;
        const endpoint = globalThis.RPHubApiUtils?.buildApiEndpoint;
        if (!client?.requestChatCompletion || !endpoint) throw new Error('当前版本不支持插件调用 AI');
        if (!Array.isArray(messages) || !messages.length) throw new TypeError('ctx.ai.complete 需要 messages');
        const settings = appGet('settings') || {};
        if (!String(settings.apiUrl || '').trim()) throw new Error('请先在设置中填写 API 地址');
        const marked = typeof messages[0]?.content === 'string' && messages[0].role === 'system'
            ? [{ ...messages[0], content: AI_REQUEST_MARKER + messages[0].content }, ...messages.slice(1)]
            : [{ role: 'system', content: AI_REQUEST_MARKER }, ...messages];
        const result = await client.requestChatCompletion({
            url: endpoint(settings.apiUrl, 'chat/completions'),
            apiKey: settings.apiKey,
            model: String(model || settings.uiTemplateModel || settings.model || '').trim(),
            messages: marked, temperature, stream: false, signal
        });
        return String(result?.content || '');
    }

    function imageModule() {
        if (!globalThis.RPHubImageModule?.registerImageProvider) throw new Error('生图模块没有加载，无法使用 ctx.image');
        return globalThis.RPHubImageModule;
    }

    function setRuntimeStatus(runtime, status) {
        runtime.entry.lastStatus = status;
        if (status.endsWith('error') || status === 'api-mismatch') window.RPHubDiagnostics?.record('plugin-error', { plugin: runtime.entry.id });
        writeInstallations();
        refreshManagementPanel();
    }

    async function initializeRuntime(runtime) {
        try {
            await runtime.manifest.init(runtime.ctx);
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
            init: manifest.init,
            beforeMount: typeof manifest.beforeMount === 'function' ? manifest.beforeMount : null,
            hooks: manifest.hooks === true
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
            showToast(`${checked.name} 需要更新测试版`);
            return false;
        }
        state.registeredIds.set(checked.id, runtime);
        runtime.entry.id = checked.id;
        runtime.entry.name = checked.name;
        runtime.entry.version = checked.version;
        runtime.entry.lastStatus = '';
        runtime.ctx = buildContext(checked.id);
        if ((checked.beforeMount && !runtime.entry.beforeMount) || (checked.hooks && !runtime.entry.hooks)) {
            showToast(`${checked.name} 需要再刷新一次才能完全生效`, { kind: 'info' });
        }
        runtime.entry.beforeMount = !!checked.beforeMount;
        runtime.entry.hooks = checked.hooks;
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
        runtime.loading = (entry.beforeMount ? Promise.resolve() : appSettled).then(async () => {
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
        if (appState()) window.RPHubDiagnostics?.attachApp({ get: appGet, watch: appWatch });
    }

    function startDomRuntime() {

        if (state.safeMode) {
            const enabledCount = state.installations.filter((entry) => entry.enabled).length;
            showToast(`安全模式：已跳过 ${enabledCount} 个插件`, { kind: 'info' });
        }
        if (state.runtimeActive) installRuntimeHooks();
        Promise.resolve(state.mounted).finally(() => setTimeout(settleApp, APP_STARTUP_SETTLE_MS));
    }

    // API 6：上次运行时登记过 beforeMount 的插件先于页面加载，官方 app.mount('#app') 等它们加载完
    // （最多 REGISTER_TIMEOUT_MS）再挂载，插件借此改官方根组件和页面模板。新装或更新的插件刷新一次后生效。
    // API 10：有插件登记过 hooks 时，挂载前再改写官方 setup；排在各插件的 beforeMount 之后，它们看到的还是官方原文。
    function holdMount(runtimes, hooks) {
        const createApp = window.Vue?.createApp;
        if ((!runtimes.length && !hooks) || typeof createApp !== 'function') return;
        window.Vue.createApp = function (...args) {
            const app = createApp.apply(this, args);
            const mount = app.mount;
            app.mount = function (target, ...rest) {
                if (target !== '#app') return mount.call(this, target, ...rest);
                window.Vue.createApp = createApp;
                const finish = () => {
                    for (const runtime of runtimes) {
                        if (state.registeredIds.get(runtime.manifest?.id) !== runtime) continue;
                        try { runtime.manifest.beforeMount?.({ options: app._component, root: document.querySelector(target), ctx: runtime.ctx }); }
                        catch (error) { log(`module ${runtime.manifest.id} beforeMount failed`, error); }
                    }
                    if (hooks) installHooks(app._component);
                    return mount.call(app, target, ...rest);
                };
                if (!runtimes.length) return finish();
                const timeout = new Promise((resolve) => setTimeout(resolve, REGISTER_TIMEOUT_MS));
                state.mounted = Promise.race([Promise.allSettled(runtimes.map((runtime) => runtime.loading)), timeout]).then(finish);
            };
            return app;
        };
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
        applyEarlyStyles(enabled);
        for (const entry of enabled) createRuntime(entry);
        holdMount(enabled.filter((entry) => entry.beforeMount).map((entry) => state.runtimesByUrl.get(entry.url)),
            enabled.some((entry) => entry.hooks));
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startDomRuntime, { once: true });
    } else startDomRuntime();
})();
