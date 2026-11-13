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
        if (typeof save !== 'function') throw new Error('这个版本的 RPH 不支持插件保存聊天记录');
        return save();
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

