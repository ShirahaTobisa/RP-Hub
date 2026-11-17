// 油猴版外壳：不装测试版、直接在官方 RPH 页面上跑自有插件。只实现自有插件用到的 ctx，写法照 src/workshop 的加载器；
// 设置（ctx.storage）和插件数据（ctx.data）都只存在这个浏览器里，官方页面没有云同步。
const RPHubSDK = (() => {
    'use strict';
    const SETTLE_MS = 1_000; // 和加载器一样：页面挂好后等一会儿再启动插件，让官方先读完设置和聊天
    const CHAT_MUTATION_THROTTLE_MS = 500;
    const AI_REQUEST_MARKER = '（插件附带请求）';
    const listeners = { 'chat-mutation': new Set(), 'generation-start': new Set(), 'generation-end': new Set() };
    const dirtyRows = new Set();
    const pages = new Map();
    let chatObserver = null, chatTimer = null, generationWatch = null, pageWatch = null, panel = null, database = null;

    // 测试版外壳的样式表（rph-ui-* 等）。插在页面运行时生成的样式（Tailwind）前面，和测试版里的顺序一样：
    // 同样分量的规则让 Tailwind 说了算，比如官方下拉框的小号字，否则字变大、手机上会顶出卡片。
    const style = document.createElement('style');
    style.textContent = /* @text/DB/styles.css */;
    document.head.insertBefore(style, document.head.querySelector('style'));

    function log(...args) {
        console.warn('[RPH 油猴版]', ...args);
    }

    function safeCall(label, callback, ...args) {
        try {
            const result = callback(...args);
            if (result && typeof result.then === 'function') result.catch((error) => log(`${label} failed`, error));
        } catch (error) {
            log(`${label} failed`, error);
        }
    }

    function element(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function appState() {
        const app = document.getElementById('app')?.__vue_app__;
        return (app?._instance || app?._container?._vnode?.component)?.setupState || null;
    }

    function appGet(name) {
        const value = appState()?.[String(name)];
        return globalThis.Vue?.isRef?.(value) ? value.value : value;
    }

    function appSet(name, value) {
        const state = appState();
        const key = String(name);
        if (!state || !(key in state) || typeof state[key] === 'function') throw new Error(`页面没有可修改的状态：${key}`);
        state[key] = value;
    }

    function appWatch(getter, callback, options = {}) {
        return globalThis.Vue.watch(getter, (value, previous) => safeCall('app watch callback', callback, value, previous),
            { deep: options.deep === true, immediate: options.immediate === true });
    }

    function dispatch(name, payload) {
        for (const callback of [...listeners[name]]) safeCall(name, callback, payload);
    }

    // 聊天区有变化时，把变了的消息行（[data-chat-index]）攒半秒一起交给插件。
    function watchChat() {
        const closest = (node) => (node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement)?.closest?.('[data-chat-index]');
        chatObserver = new MutationObserver((records) => {
            for (const record of records) {
                const added = record.type === 'childList' ? [...record.addedNodes] : [];
                for (const node of [record.target, ...added]) {
                    const row = closest(node);
                    if (row) dirtyRows.add(row);
                }
                for (const node of added) {
                    if (node.nodeType === Node.ELEMENT_NODE) node.querySelectorAll('[data-chat-index]').forEach((row) => dirtyRows.add(row));
                }
            }
            if (chatTimer || !dirtyRows.size) return;
            chatTimer = setTimeout(() => {
                chatTimer = null;
                const rows = [...dirtyRows].filter((row) => row.isConnected);
                dirtyRows.clear();
                if (rows.length) dispatch('chat-mutation', { dirtyRows: rows });
            }, CHAT_MUTATION_THROTTLE_MS);
        });
        chatObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    }

    function on(name, callback) {
        if (!listeners[name]) throw new TypeError(`油猴版不支持这个事件：${name}`);
        if (name === 'chat-mutation') {
            if (!chatObserver) watchChat();
        } else {
            generationWatch ||= appWatch(() => appGet('isGenerating') === true, (busy) => dispatch(busy ? 'generation-start' : 'generation-end'));
        }
        listeners[name].add(callback);
    }

    // 插件数据放自己的库，不碰官方的 RPHubDB。
    function dataTransaction(mode, operation) {
        database ||= new Promise((resolve, reject) => {
            const request = indexedDB.open('RPHubUserscript', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('data');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        }).catch((error) => { database = null; throw error; });
        return database.then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction('data', mode);
            const request = operation(tx.objectStore('data'));
            tx.oncomplete = () => resolve(request.result);
            tx.onabort = tx.onerror = () => reject(tx.error || new Error('插件数据保存失败'));
        }));
    }

    // 用官方设置里的 AI 发一次请求：默认用「分析模型」（UI 模板分析那个），没设就用主模型。
    async function aiComplete({ messages, model, temperature = 0.3, signal } = {}) {
        const client = globalThis.RPHubApiClient;
        const endpoint = globalThis.RPHubApiUtils?.buildApiEndpoint;
        if (!client?.requestChatCompletion || !endpoint) throw new Error('这个版本的 RPH 不支持插件调用 AI');
        if (!Array.isArray(messages) || !messages.length) throw new TypeError('ctx.ai.complete 需要 messages');
        const settings = appGet('settings') || {};
        if (!String(settings.apiUrl || '').trim()) throw new Error('还没在 RPH 设置里填 AI 接口');
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

    function toast(message, options = {}) {
        window.RPHubUI.toast(message, { kind: options.kind || 'error', duration: 4_200 });
    }

    function openPanel({ title, render }) {
        panel?.close();
        panel = window.RPHubUI.openModal({ title: String(title || '').trim(), render });
    }

    // 插件自己的整页：导航菜单里加一个入口，点开像「设置」那样占满主区域；没有主区域的页面退回弹窗。
    function addPage(owner, { label, iconPaths = [], render }) {
        const page = { owner, label, iconPaths, view: `rph-page-${owner}`, render, root: null, cleanup: null };
        pages.set(owner, page);
        const open = () => (document.querySelector('#app .app-main') ? appSet('currentView', page.view) : openPanel({ title: label, render }));
        window.RPHubNavAdapter.registerEntry({
            id: `page-${owner}`, label, iconPaths, attributes: { 'data-rph-workshop-page-entry': owner }, onClick: open, waitForClose: true
        });
        if (pageWatch) syncPages(appGet('currentView'));
        else pageWatch = appWatch(() => appGet('currentView'), syncPages, { immediate: true });
        return Object.freeze({ open });
    }

    function syncPages(view) {
        for (const page of pages.values()) {
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

    function buildContext(id) {
        const prefix = `rph_mod_${id}::`;
        const dataKey = (key) => `${id}::${key}`;
        return {
            log: (...args) => console.info(`[RPH-mod:${id}]`, ...args),
            storage: {
                get(key) {
                    try { return localStorage.getItem(prefix + key); } catch (_) { return null; }
                },
                set: (key, value) => localStorage.setItem(prefix + key, String(value)),
                remove(key) {
                    try { localStorage.removeItem(prefix + key); } catch (_) { /* no-op */ }
                }
            },
            data: {
                get: (key) => dataTransaction('readonly', (store) => store.get(dataKey(key))),
                set(key, value) {
                    const copy = structuredClone(value);
                    return dataTransaction('readwrite', (store) => store.put(copy, dataKey(key)));
                },
                remove: (key) => dataTransaction('readwrite', (store) => store.delete(dataKey(key)))
            },
            ui: { toast, openPanel, addPage: (options) => addPage(id, options) },
            events: { on },
            app: { get: appGet, set: appSet, watch: appWatch },
            ai: { complete: aiComplete }
        };
    }

    // 油猴脚本可能比官方页面挂好得早，等页面挂好再启动插件。
    const ready = new Promise((resolve) => {
        const wait = () => (appState() && globalThis.Vue?.watch ? setTimeout(resolve, SETTLE_MS) : setTimeout(wait, 300));
        wait();
    });

    return Object.freeze({
        register(manifest) {
            ready.then(() => manifest.init(buildContext(manifest.id))).catch((error) => {
                log(`${manifest.name} 启动失败`, error);
                toast(`${manifest.name}没能启动：${error?.message || error}`);
            });
        }
    });
})();
