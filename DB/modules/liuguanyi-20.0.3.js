// Adapted from RP-Hub 终极美化 & 全功能增强 v20.0.3, author 苏萝萝.
// Workshop edition: no image-generation integration; persistent data supports cloud sync.
RPHubSDK.register({
    id: 'liuguanyi', name: '柳贯一增强（无生图）', version: '20.0.3-rph.1', requiresApi: 2,
    async init(ctx) {
    'use strict';
    if (globalThis.__rphLiuguanyiInitialized) return;
    if (window.fetch.__sakura_hooked__) throw new Error('请先停用此站点的旧版柳贯一油猴脚本，再刷新启用工坊版');
    globalThis.__rphLiuguanyiInitialized = true;
    const pluginStorage = {
        get length() { return localStorage.length; }, key: i => localStorage.key(i),
        getItem: key => localStorage.getItem(key),
        setItem(key, value) { if (!globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS) localStorage.setItem(key, value); },
        removeItem(key) { if (!globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS) localStorage.removeItem(key); }
    };
    const idbGetMoments = () => ctx.data.get('moments');
    const idbPutMoments = list => ctx.data.set('moments', list).then(() => true);
    async function saveLocalTrackFile(id, blob) {
        const chunks = [{ mime: blob.type || 'application/octet-stream' }];
        for (let offset = 0; offset < blob.size; offset += 192 * 1024) {
            chunks.push(await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob.slice(offset, offset + 192 * 1024));
            }));
        }
        await ctx.data.set('track:' + id, chunks);
        return true;
    }
    async function getLocalTrackBlob(id) {
        const chunks = await ctx.data.get('track:' + id);
        if (!Array.isArray(chunks)) return null;
        return new Blob(chunks.slice(1).map(chunk => Uint8Array.from(atob(chunk), c => c.charCodeAt(0))), { type: chunks[0].mime });
    }
    const removeLocalTrackFile = id => ctx.data.remove('track:' + id);
    async function openLegacyDatabase(name) {
        return new Promise((resolve, reject) => {
            let missing = false;
            const request = indexedDB.open(name);
            request.onupgradeneeded = () => { missing = true; request.transaction.abort(); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => missing ? resolve(null) : reject(request.error);
            request.onblocked = () => reject(new Error('旧插件数据库正被其他页面使用'));
        });
    }
    function readLegacyRecord(db, store, key) {
        return new Promise((resolve, reject) => {
            const request = db.transaction(store).objectStore(store).get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    async function migratePrivateData() {
        if (await ctx.data.get('legacy-migrated')) return;
        if (!Array.isArray(await idbGetMoments())) {
            const db = await openLegacyDatabase('SakuraMomentsDB');
            let list;
            try { if (db?.objectStoreNames.contains('moments')) list = await readLegacyRecord(db, 'moments', 'list'); }
            finally { db?.close(); }
            await idbPutMoments(Array.isArray(list) ? list.filter(Boolean).map(({ images, ...text }) => text) : readLegacyMomentsFromLS());
        }
        const tracks = JSON.parse(pluginStorage.getItem(GRAMOPHONE_STORAGE_KEY) || '[]');
        const db = await openLegacyDatabase('sakura_gramophone_db');
        try {
            if (db?.objectStoreNames.contains('tracks')) {
                for (const track of Array.isArray(tracks) ? tracks : []) {
                    if (track.type !== 'local' || await ctx.data.get('track:' + track.id)) continue;
                    const legacy = await readLegacyRecord(db, 'tracks', track.id);
                    if (legacy?.blob instanceof Blob) await saveLocalTrackFile(track.id, legacy.blob);
                }
            }
        } finally { db?.close(); }
        await ctx.data.set('legacy-migrated', true);
    }

    const SPLASH_IMG_URL = 'https://img.scdn.io/i/6a8a449fb590e_1787446431.webp';
    const CACHE_KEY = 'rphub_custom_splash_b64';
    const DB_NAME = 'RPHubDB';
    const LEGACY_DB_NAME = String.fromCharCode(83, 105, 108, 108, 121, 84, 97, 118, 101, 114, 110, 68, 66);
    const DB_VERSION = 1;
    const STORE = 'store';
    const NOTE_KEY = 'rphub_notes_v1';
    const MOMENTS_KEY = 'rphub_moments_v1';
    const SPLIT_API_KEY = 'rphub_split_apis_v2';
    const USER_TEMP_KEY = 'rphub_user_temperature_pref';
    const USER_STREAM_KEY = 'rphub_user_stream_pref';
    const USER_CHARVIEW_KEY = 'rphub_user_characterview_pref';
    // 官方经典记忆有两条请求提示词：逐轮分片总结与五轮二次压缩。
    // 两者必须使用同一套 memory 分流 API，否则二次压缩会误走主对话的地址和密钥。
    const FP_MEMORY = '你是角色扮演对话的逐轮记忆整理器';
    const FP_MEMORY_SECONDARY = '你是角色扮演长期记忆压缩器';
    // 温度/思考强度持久化：只记忆玩家主动调整过的值，绝不注入任何默认值。
    // 无存档 = 官方默认原样（温度1、思考强度默认），插件一个字节都不碰。
    // 思考强度滑块（max=5）与温度滑块（max=1）分开记忆，互不干扰。

    // 只把真正的主聊天补全交给向量兜底。官方记忆总结、二次压缩和 UI 变量副模型同样使用 chat/completions，不能误处理。
    function isUiTemplateAnalysisMessages(messages) {
        return Array.isArray(messages) && messages.some(message => {
            if (message?.role !== 'system') return false;
            const content = String(message?.content || '');
            return /只分析一个UI模板/.test(content)
                && /<ui_template_updates>/.test(content)
                && /只根据用户消息里提供的最近对话/.test(content);
        });
    }
    function isAuxiliaryModelMessages(messages) {
        return Array.isArray(messages) && (messages.some(message => {
            const content = String(message?.content || '');
            return content.includes(FP_MEMORY) || content.includes(FP_MEMORY_SECONDARY);
        }) || isUiTemplateAnalysisMessages(messages));
    }

    // 内置供应商预设列表
    const PROVIDER_PRESETS = [
        { id: 'sta1n', name: 'STA1N API', apiUrl: 'https://cdn.sta1n.cn/v1', defaultModel: 'deepseek-chat', icon: 'https://img.cdn1.vip/i/69c18cc07538b_1774292160.webp' },
        { id: 'deepseek', name: 'DeepSeek', apiUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', icon: 'https://www.deepseek.com/favicon.ico' },
        { id: 'openrouter', name: 'OpenRouter', apiUrl: 'https://openrouter.ai/api/v1', defaultModel: 'deepseek/deepseek-chat', icon: 'https://openrouter.ai/favicon.ico' },
        { id: 'siliconflow', name: 'SiliconFlow', apiUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'deepseek-ai/DeepSeek-V3', icon: 'https://siliconflow.cn/favicon.ico' },
        { id: 'custom', name: '自定义 1', apiUrl: '', defaultModel: '', icon: '' },
        { id: 'custom2', name: '自定义 2', apiUrl: '', defaultModel: '', icon: '' },
        { id: 'custom3', name: '自定义 3', apiUrl: '', defaultModel: '', icon: '' }
    ];

    const POPULAR_FAMILIES = ['claude', 'gemini', 'deepseek', 'gpt', 'qwen', 'llama', 'glm', 'minimax', 'moonshot', 'grok', 'embedding'];

    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
    }

    // ================= ⚡ 模块零：单点 fetch 分流引擎 =================

    function stripNextResponseProtocol(text) {
        if (typeof text !== 'string') return text;
        return text
            .replace(/<next_response\b[^>]*>[\s\S]*?<\/next_response>/gi, '')
            .replace(/<next_response\b[^>]*>[\s\S]*$/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // 上下文查看器使用官方生成前的快照；请求体清理后同步清理这份显示快照，
    // 不改聊天历史、不改官方卡片/发送状态，只隐藏已被移除的官方协议块。
    // 官方弹窗用 v-html 渲染 message.renderedContent（escapeHtml 转义版），
    // 因此必须同步清洗转义后的 HTML 文本，否则协议块仍会原样显示。
    function stripNextResponseProtocolInHtml(html) {
        if (typeof html !== 'string') return html;
        return html
            .replace(/&lt;next_response\b[\s\S]*?&gt;[\s\S]*?&lt;\/next_response&gt;/gi, '')
            .replace(/&lt;next_response\b[\s\S]*?&gt;[\s\S]*$/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function scrubContextViewerNextResponse() {
        try {
            const st = getVueState();
            const holder = st?.lastContextMessages;
            const current = unref(holder);
            if (!Array.isArray(current)) return;
            const cleaned = current
                .map(message => {
                    if (!message || typeof message.content !== 'string') return message;
                    const nextContent = stripNextResponseProtocol(message.content);
                    const nextRendered = typeof message.renderedContent === 'string'
                        ? stripNextResponseProtocolInHtml(message.renderedContent)
                        : message.renderedContent;
                    return { ...message, content: nextContent, renderedContent: nextRendered };
                })
                .filter(message => !message || typeof message.content !== 'string' || message.content.trim() !== '');
            // Vue setupState/proxy 可能已经自动解包 ref，此时 holder 本身就是数组。
            if (Array.isArray(holder)) {
                holder.splice(0, holder.length, ...cleaned);
            } else if (holder && typeof holder === 'object' && 'value' in holder) {
                holder.value = cleaned;
            }
        } catch (_) {}
    }

    function scrubContextViewerDom() {
        try {
            // 🚀 快速短路：候选选择器与下方收集一致，无任何弹窗/浮层时直接退出，
            // 避免 TreeWalker 全文档遍历（流式打字期间的主要隐形开销）。
            if (!document.querySelector('[role="dialog"], .fixed, [class*="modal"]')) return;
            const title = '真实上下文请求';
            const candidates = [...document.querySelectorAll('[role="dialog"], .fixed, [class*="modal"]')]
                .filter(el => String(el.textContent || '').includes(title));
            candidates.forEach(root => {
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
                const nodes = [];
                let node;
                while ((node = walker.nextNode())) nodes.push(node);
                let stripping = false;
                nodes.forEach(textNode => {
                    const value = textNode.nodeValue || '';
                    if (!stripping && /<next_response\b[^>]*>/i.test(value)) {
                        const start = value.search(/<next_response\b[^>]*>/i);
                        const before = value.slice(0, start);
                        const afterStart = value.slice(start);
                        const endMatch = afterStart.match(/<\/next_response>/i);
                        if (endMatch) {
                            textNode.nodeValue = before + afterStart.slice(endMatch.index + endMatch[0].length);
                        } else {
                            textNode.nodeValue = before;
                            stripping = true;
                        }
                    } else if (stripping) {
                        const endMatch = value.match(/<\/next_response>/i);
                        if (endMatch) {
                            textNode.nodeValue = value.slice(endMatch.index + endMatch[0].length);
                            stripping = false;
                        } else {
                            textNode.nodeValue = '';
                        }
                    } else if (/完整承接最新用户输入中已经发生的言行/i.test(value)) {
                        textNode.nodeValue = stripNextResponseProtocol(value);
                    }
                });
            });
        } catch (_) {}
    }

    let contextViewerDomObserver = null;
    let _cvScrubPending = false;
    function startContextViewerDomScrubber() {
        if (contextViewerDomObserver || !document.documentElement) return;
        // 🚀 性能：characterData 监听在流式打字时每字符触发一次；rAF 合并同帧多次变更，
        // 弹窗不存在时 scrubContextViewerDom 内部零成本短路——视觉行为完全不变。
        contextViewerDomObserver = new MutationObserver(() => {
            if (_cvScrubPending) return;
            _cvScrubPending = true;
            requestAnimationFrame(() => {
                _cvScrubPending = false;
                scrubContextViewerDom();
            });
        });
        contextViewerDomObserver.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        scrubContextViewerDom();
    }
    function getInitialChannelState() {
        return {
            selectedId: 'custom',
            keys: {},
            models: {},
            customUrls: { custom: '', custom2: '', custom3: '' }
        };
    }

    function loadSplitApis() {
        try {
            const raw = pluginStorage.getItem(SPLIT_API_KEY);
            if (!raw) {
                const oldRaw = pluginStorage.getItem('rphub_split_apis_v1');
                if (oldRaw) {
                    const oldData = JSON.parse(oldRaw);
                    const migrated = {
                        memory: { selectedId: 'custom', keys: { custom: oldData.memory?.key || '' }, customUrls: { custom: oldData.memory?.url || '', custom2: '', custom3: '' } },
                        ui: { selectedId: 'custom', keys: { custom: oldData.ui?.key || '' }, customUrls: { custom: oldData.ui?.url || '', custom2: '', custom3: '' } }
                    };
                    saveSplitApis(migrated);
                    return migrated;
                }
            }
            const data = raw ? JSON.parse(raw) : {};
            return {
                memory: Object.assign(getInitialChannelState(), data.memory || {}),
                ui: Object.assign(getInitialChannelState(), data.ui || {})
            };
        } catch (e) {
            return { memory: getInitialChannelState(), ui: getInitialChannelState() };
        }
    }

    function saveSplitApis(data) {
        try { pluginStorage.setItem(SPLIT_API_KEY, JSON.stringify(data)); } catch (e) {}
    }

    // ================= 向量缓存仓库：换 API 站不再重复付向量钱 =================
    // 原理：向量结果只由「embedding 模型 + 输入内容」决定，跟你在哪个 API 站请求无关。
    // 所以缓存键不绑定站点地址——换对话站、换记忆分流站，只要模型名一致，直接复用旧向量。
    const EMBEDDING_CACHE_DB = 'SakuraEmbeddingCacheV1';
    const EMBEDDING_CACHE_STORE = 'vectors';
    let _embeddingCacheDbPromise = null;

    // 网络层向量缓存：同一「向量模型 + 输入内容」下，相同输入必然得到相同向量。
    // 命中即直接返回缓存的响应体，官方以为补录完成，实际零请求、零花费。
    function openEmbeddingCacheDb() {
        if (_embeddingCacheDbPromise) return _embeddingCacheDbPromise;
        _embeddingCacheDbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(EMBEDDING_CACHE_DB, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(EMBEDDING_CACHE_STORE)) {
                    db.createObjectStore(EMBEDDING_CACHE_STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        return _embeddingCacheDbPromise;
    }

    function embeddingCacheRead(key) {
        return openEmbeddingCacheDb().then(db => new Promise(resolve => {
            const request = db.transaction(EMBEDDING_CACHE_STORE, 'readonly')
                .objectStore(EMBEDDING_CACHE_STORE).get(key);
            request.onsuccess = () => resolve(request.result?.payload || '');
            request.onerror = () => resolve('');
        })).catch(() => '');
    }

    function embeddingCacheWrite(key, payload) {
        return openEmbeddingCacheDb().then(db => new Promise(resolve => {
            const request = db.transaction(EMBEDDING_CACHE_STORE, 'readwrite')
                .objectStore(EMBEDDING_CACHE_STORE).put({ key, payload, updatedAt: Date.now() });
            request.onsuccess = () => resolve(true);
            request.onerror = () => resolve(false);
        })).catch(() => false);
    }

    // djb2 字符串哈希：把嵌入输入压成短键，避免 IndexedDB 键过长。
    function sakuraHash(str) {
        let h = 5381;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }

    // 从 embeddings 请求体提取规范化输入文本，顺序敏感（官方按 index 回填）。
    function normalizeEmbeddingInputs(body) {
        const raw = body?.input;
        if (typeof raw === 'string') return [raw];
        if (Array.isArray(raw)) {
            return raw.map(item => typeof item === 'string' ? item : String(item?.text || item?.input || ''));
        }
        return null;
    }

    function makeCachedJsonResponse(payload) {
        return new Response(payload, {
            status: 200,
            statusText: 'OK',
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // 向量缓存身份 = 向量模型 + 输入内容。
    // 关键：不绑定 API 站地址。换对话站、换记忆分流站，只要 embedding 模型名一致，
    // 向量空间就是同一个，旧结果可以直接复用——这才是真正省钱的点。
    function getEmbeddingModelKey(parsedBody) {
        const st = getVueState();
        const memorySettings = getRuntimeValue(st?.memorySettings) || {};
        return String(parsedBody?.model || memorySettings.embeddingModel || '').trim();
    }

    // 网络层向量缓存：同一向量模型 + 同一输入 → 必然同一结果。
    // 命中直接合成响应返回，官方以为补录完成，实际零请求、零计费。
    async function cachedEmbeddingFetch(modelKey, inputs, doFetch) {
        if (!modelKey || !Array.isArray(inputs) || !inputs.length) return doFetch();
        const key = `emb:${sakuraHash(`${modelKey}\u0000${inputs.join('\u0001')}`)}`;
        const hit = await embeddingCacheRead(key);
        if (hit) {
            console.log(`[苏萝萝] 向量缓存命中（${modelKey}），跳过重复计费`);
            return makeCachedJsonResponse(hit);
        }
        const response = await doFetch();
        try {
            if (response && response.ok) {
                const text = await response.clone().text();
                if (text) await embeddingCacheWrite(key, text);
            }
        } catch (_) {}
        return response;
    }

    function getActiveChannelConfig(channelState) {
        const p = PROVIDER_PRESETS.find(x => x.id === channelState.selectedId) || PROVIDER_PRESETS[4];
        const isCustom = p.id.startsWith('custom');
        const url = (isCustom ? (channelState.customUrls[p.id] || '') : p.apiUrl).trim();
        const key = (channelState.keys[p.id] || '').trim();
        const model = (channelState.models && channelState.models[p.id] ? channelState.models[p.id] : (p.defaultModel || '')).trim();
        return { url, key, model, provider: p, isCustom };
    }

    function buildCustomEndpoint(rawBaseUrl, path) {
        const baseUrl = String(rawBaseUrl || '').replace(/\/+$/, '');
        const apiUrl = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
        return `${apiUrl}/${String(path || '').replace(/^\/+/, '')}`;
    }

    function getRuntimeValue(value) {
        return value && typeof value === 'object' && 'value' in value ? value.value : value;
    }

    function isOfficialApiEndpoint(requestUrl) {
        try {
            const st = getVueState();
            const officialApiUrl = getRuntimeValue(st?.settings)?.apiUrl || '';
            if (!requestUrl || !officialApiUrl) return false;
            const request = new URL(String(requestUrl), location.href);
            const official = new URL(String(officialApiUrl), location.href);
            const basePath = official.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
            const requestPath = request.pathname.replace(/\/+$/, '');
            return request.origin === official.origin
                && (requestPath === basePath
                    || requestPath.startsWith(`${basePath}/v1/`)
                    || (basePath === '' && requestPath.startsWith('/v1/')));
        } catch (_) {
            return false;
        }
    }
    // 插件只屏蔽明确的废话八股：独立成句的“不是A。是B。”、“不是A，是B。”，以及“不是A，是B，像C……”这种先假纠正、再接空泛比喻凑字数的句子。
    // 规则必须从句首/上一句结束处开始，并在本句结束处收口；不会扫掉长剧情里的解释、转折或正常对白。
    // 这里只认“是”，不认“而是”：后者可能承担真实的纠正、转折或剧情解释。
    // 其他正常的“不是因为……是因为……”、因果说明、比喻、弧度、像在、像是全部放行。
    // 官方 UI模板变量块：文风过滤必须整体保护(官方 filterBlockedStyleText 同款边界)，
    // 变量值是自然语言(如“不是恋人，是共犯”)，裸跑窄规则会啃坏块导致变量更新失败。
    const UI_TEMPLATE_BLOCK = /<ui_template_updates>[\s\S]*?<\/ui_template_updates>|<ui_template_updates>[\s\S]*$/gi;
    const STYLE_QUOTED_BLOCK = /“[\s\S]*?”|『[\s\S]*?』|「[\s\S]*?」|《[\s\S]*?》|〈[\s\S]*?〉|【[\s\S]*?】|"[^"\n]*"|'[^'\n]*'|[「」『』“”《》〈〉【】]/g;
    const STYLE_NOT_IS_EXCLUDE = '(?:因为|由于|为了|在于|关于|事实是|问题是|原因是|可能是|并不是因为|不只是|不仅是|只是|正在|并非)';
    const STYLE_USELESS_NOT_IS_DOT = new RegExp(
        '(^|[\\n。！？!?])([ \\t]*不是(?!' + STYLE_NOT_IS_EXCLUDE + ')[^。！？!?，,\\n]{1,16}[。！？!?]+[ \\t]*是(?!' + STYLE_NOT_IS_EXCLUDE + ')[^。！？!?，,\\n]{1,16}[。！？!?]+)',
        'gm'
    );
    const STYLE_USELESS_NOT_IS_METAPHOR = new RegExp(
        '(^|[\\n。！？!?])([ \\t]*不是(?!' + STYLE_NOT_IS_EXCLUDE + ')[^。！？!?，,\\n]{1,20}[，,][ \\t]*是(?!' + STYLE_NOT_IS_EXCLUDE + ')[^。！？!?，,\\n]{1,32}[，,][^。！？!?\\n]*?(?:像(?:是|在)?|仿佛|如同|宛如)[^。！？!?\\n]{1,120}[。！？!?]+)(?=\\s*(?:\\n\\s*){2,}|\\s*$)',
        'gm'
    );
    const STYLE_USELESS_NOT_IS_COMMA = new RegExp(
        '(^|[\\n。！？!?])([ \\t]*不是(?!' + STYLE_NOT_IS_EXCLUDE + ')[^。！？!?，,\\n]{1,20}[，,][ \\t]*是(?!' + STYLE_NOT_IS_EXCLUDE + ')(?![^。！？!?\\n]*(?:像(?:是|在)?|仿佛|如同|宛如))[^。！？!?，,\\n]{1,20}[。！？!?]+)',
        'gm'
    );
    function filterStylePlainText(text) {
        const source = String(text || '');
        if (!source) return { text: source, count: 0, hits: [] };
        const protectedBlocks = [];
        const protectedSource = source
            .replace(UI_TEMPLATE_BLOCK, match => {
                const token = `\u0000RPHUB_UI_TPL_${protectedBlocks.length}\u0000`;
                protectedBlocks.push(match);
                return token;
            })
            .replace(STYLE_QUOTED_BLOCK, match => {
                const token = `\u0000RPHUB_STYLE_QUOTE_${protectedBlocks.length}\u0000`;
                protectedBlocks.push(match);
                return token;
            });
        const hits = [];
        let filtered = protectedSource
            .replace(STYLE_USELESS_NOT_IS_METAPHOR, (match, boundary, body) => {
                hits.push(body.trim());
                return boundary || '';
            })
            .replace(STYLE_USELESS_NOT_IS_DOT, (match, boundary, body) => {
                hits.push(body.trim());
                return boundary || '';
            })
            .replace(STYLE_USELESS_NOT_IS_COMMA, (match, boundary, body) => {
                hits.push(body.trim());
                return boundary || '';
            });
        filtered = filtered
            .replace(/\u0000RPHUB_UI_TPL_(\d+)\u0000/g, (_, index) => protectedBlocks[Number(index)] || '')
            .replace(/\u0000RPHUB_STYLE_QUOTE_(\d+)\u0000/g, (_, index) => protectedBlocks[Number(index)] || '');
        return { text: filtered, count: hits.length, hits };
    }
    function sanitizeOutgoingAssistantMessages(messages) {
        // 不在请求层清洗 assistant 历史，避免改变模型上下文；只在最终 assistant 正文显示/落盘阶段处理。
        return;
    }
    function sanitizeAssistantCliches() {
        // 兼容旧入口；真实处理由原始响应恢复链调用 filterStylePlainText。
        return;
    }
    // 剥掉生图提示词。官方生图格式为 image###提示词###（可能跨行），
    // embeddings 分流链路仍需要它做输入清洗。
    function stripImageGenPrompts(text) {
        return String(text || '').replace(/image###[\s\S]*?###/gi, '');
    }

    // 官方页面会在响应进入 chatHistory 后再执行 filterBlockedStyleText()。
    // 插件不能改官方闭包，所以在网络层旁路保存主聊天的原始 assistant 输出，待官方处理完成后恢复正文。
    // 只对主 chat/completions 生效；记忆/UI/embedding 请求完全不碰。
    //
    // v17.7 误伤防护（实测案例：整段「」对话被官方句级正则整句吞掉）：
    // 官方 quotedDialoguePattern 只保护 “...”『...』"..."，不保护「」；
    // 且官方句级正则的「不是...，(而)是...」分支用 [^。！？!?\n]* 横扫逗号，
    // 会把「她哭了，不是因为恐惧，是因为……」这种正常剧情对话整句吃掉。
    // 策略：先按官方规则算出"会被官方删掉什么"；如果官方会删除的内容里
    // 含有「」对话引号或省略号悬垂（剧情对话特征），则判定为高风险误伤，
    // 恢复整段原文（官方已删的我们救回来），只保留插件自己的两条窄规则结果。
    function detectOfficialOverreach(rawText) {
        const text = String(rawText || '');
        if (!text) return null;
        const officialSentence = /[^。！？!?\n]*(?:不容置疑|(?:不易|难以)(?:察觉|觉察)|(?:微|几)不可察|一抹|弧度|生理性|微微泛|因为用力|像在|风箱|手术刀|上扬|带着一种|语气很平|声音很平|(?:指尖|指节|指关节)[^。！？!?\n]*(?:发白|泛白)|像(?:是)?[^。！？!?\n]*?[，,]\s*又像(?:是)?|不是[^。！？!?\n]*?(?:而是|就是|[，,]\s*(?:是|(?:更|倒|反倒)?像是)))[^。！？!?\n]*(?:[。！？!?]+[”’」』】）)]*(?:\*\*|__)?)?/g;
        const officialClause = /(?:^|[，,；;])[^，,。！？!?；;\n*_]*(?:微微泛|因为用力|像在|风箱|手术刀|上扬|带着一种|(?:指尖|指节|指关节)[^，,。！？!?；;\n]*(?:发白|泛白))[^，,。！？!?；;\n*_]*(?=(?:\*\*|__)?[ \t]*(?:$|[，,。！？!?；;\n]))/gm;
        const officialWord = /极其/g;
        const officialQuoted = /(“[\s\S]*?”|『[\s\S]*?』|"[\s\S]*?")/g;
        const removed = [];
        const parts = text.split(officialQuoted);
        parts.forEach((part, index) => {
            if (!part || index % 2 === 1) return;
            part.replace(officialSentence, match => {
                const trimmed = match.trim();
                if (trimmed) removed.push(trimmed);
                return '';
            });
            part.replace(officialClause, match => {
                const trimmed = match.trim();
                if (trimmed) removed.push(trimmed);
                return '';
            });
            part.replace(officialWord, match => {
                removed.push(match);
                return '';
            });
        });
        if (!removed.length) return null;
        const joined = removed.join('\n');
        const dialogueKiller = /[「」]/.test(joined);
        const ellipsisKiller = /[。！？!?]?\.{3,}|……/.test(joined) && /不是|就是|是因为/.test(joined);
        // 只要官方规则在原文中有命中，就允许恢复链接管；插件自己的窄规则仍会先行清理。
        // 这里不能再只依赖“像在/弧度”几个词，否则“一抹/上扬/极其”等官方独杀词会漏网。
        return { removed, joined, dialogueKiller, ellipsisKiller };

    }
    function extractRawAssistantContentFromCompletion(raw) {
        const text = String(raw || '');
        if (!text.trim()) return '';
        try {
            const json = JSON.parse(text);
            const choice = json?.choices?.[0];
            return String(choice?.message?.content ?? choice?.text ?? '');
        } catch (_) {}
        const chunks = [];
        for (const line of text.split(/\r?\n/)) {
            const value = line.replace(/^data:\s?/, '').trim();
            if (!value || value === '[DONE]') continue;
            try {
                const json = JSON.parse(value);
                const choice = json?.choices?.[0];
                const delta = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? '';
                if (delta) chunks.push(String(delta));
            } catch (_) {}
        }
        return chunks.join('');
    }
    function restoreRawAssistantAfterOfficialFilter(rawContent) {
        const raw = String(rawContent || '');
        if (!raw) return;
        const restore = () => {
            try {
                const state = getVueState();
                const history = getRuntimeValue(state?.chatHistory);
                if (!Array.isArray(history)) return false;
                const assistant = [...history].reverse().find(message => message?.role === 'assistant');
                const filteredResult = filterStylePlainText(raw);
                const officialOverreach = detectOfficialOverreach(raw);
                // 官方过滤命中任意已知宽泛规则时，都以“原文 − 插件窄规则”覆盖官方结果。
                // 不再依赖像在/弧度等少数词作为触发门槛，避免一抹、上扬、极其等独杀词漏恢复。
                if (!officialOverreach && filteredResult.count === 0) return false;
                if (!assistant) return false;
                const current = String(assistant.content || '');
                if (current === filteredResult.text) return true;
                assistant.content = filteredResult.text;
                if (filteredResult.hits?.length) assistant.styleFilterHits = filteredResult.hits;
                else delete assistant.styleFilterHits;
                return true;
            } catch (_) {
                return false;
            }
        };
        // 流式响应结束、官方 finally 过滤、Vue 渲染分别可能处于不同微任务中，分层补偿但不循环监听。
        [0, 80, 250, 700, 1400].forEach(delay => setTimeout(restore, delay));
    }
    function observeMainChatCompletionResponse(response) {
        try {
            if (!response || typeof response.clone !== 'function') return response;
            response.clone().text().then(raw => {
                const content = extractRawAssistantContentFromCompletion(raw);
                if (content) restoreRawAssistantAfterOfficialFilter(content);
            }).catch(() => {});
        } catch (_) {}
        return response;
    }

    const _nativeFetch = window.fetch;
    let memoryRouteActive = 0;
    const memoryRouteQueue = [];
    const runMemoryRoute = task => new Promise((resolve, reject) => {
        memoryRouteQueue.push({ task, resolve, reject });
        const pump = () => {
            if (memoryRouteActive >= 2 || memoryRouteQueue.length === 0) return;
            const item = memoryRouteQueue.shift();
            memoryRouteActive++;
            Promise.resolve().then(item.task).then(item.resolve, item.reject).finally(() => {
                memoryRouteActive--;
                pump();
            });
            pump();
        };
        pump();
    });
    const hookedFetch = async function(input, init) {
        let isAuxiliaryRequest = false;
        try {
            const allConf = loadSplitApis();
            const memConf = getActiveChannelConfig(allConf.memory);
            const uiConf = getActiveChannelConfig(allConf.ui);
            const newInit = Object.assign({}, init);
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            let parsedBody = null;
            const rawBody = typeof newInit.body === 'string' ? newInit.body : '';
            try { parsedBody = rawBody ? JSON.parse(rawBody) : null; } catch (_) { parsedBody = null; }
            const isChatCompletionRequest = /chat\/completions/i.test(url);
            const isOfficialMemoryEmbeddingRequest = /embeddings/i.test(url) && isOfficialApiEndpoint(url);
            const detectedAuxiliaryRequest = isAuxiliaryModelMessages(parsedBody?.messages);
            isAuxiliaryRequest = detectedAuxiliaryRequest || isOfficialMemoryEmbeddingRequest;
            const isMainChatRequest = isChatCompletionRequest && !isAuxiliaryRequest;

            if (parsedBody && Array.isArray(parsedBody.messages) && isMainChatRequest) {
                // 只有主聊天允许插件清洗；记忆/UI副模型请求保持官方原始消息。
                parsedBody.messages.forEach(msg => {
                    if (msg && typeof msg.content === 'string') {
                        msg.content = stripNextResponseProtocol(msg.content);
                    }
                });
                sanitizeOutgoingAssistantMessages(parsedBody.messages);
            }

            const reroute = (newUrl, key, options = {}) => {
        const { retryTransient = false, maxRetries = 2 } = options;
        const requestBody = parsedBody ? JSON.stringify(parsedBody) : newInit.body;
        const send = async attempt => {
            const headers = new Headers((newInit && newInit.headers) || {});
            headers.set('Authorization', `Bearer ${key.trim()}`);
            let response;
            try {
                response = await _nativeFetch.call(this, newUrl, Object.assign({}, newInit, {
                    headers,
                    body: requestBody
                }));
            } catch (error) {
                if (retryTransient && attempt < maxRetries && !newInit.signal?.aborted) {
                    await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
                    return send(attempt + 1);
                }
                throw error;
            }
            if (retryTransient && (response.status === 502 || response.status === 524)
                && attempt < maxRetries && !newInit.signal?.aborted) {
                await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
                return send(attempt + 1);
            }
            return response;
        };
        return send(0);
    };

            if (/embeddings/i.test(url)) {
                if (!isOfficialApiEndpoint(url)) return _nativeFetch.call(this, input, newInit);
                // 输入清洗：剥掉生图提示词（分流与主通道一致处理，保证缓存键与实际发送内容一致）
                if (parsedBody && typeof parsedBody.input === 'string' && parsedBody.input.trim().length > 0) {
                    const cleaned = stripImageGenPrompts(parsedBody.input);
                    if (cleaned !== parsedBody.input) parsedBody.input = cleaned;
                } else if (parsedBody && Array.isArray(parsedBody.input)) {
                    parsedBody.input = parsedBody.input.map(item => {
                        const s = typeof item === 'string' ? item : String(item?.text || item?.input || '');
                        const cleaned = stripImageGenPrompts(s);
                        return typeof item === 'string' ? cleaned : Object.assign({}, item, { text: cleaned });
                    });
                }
                if (parsedBody) newInit.body = JSON.stringify(parsedBody);

                const modelKey = getEmbeddingModelKey(parsedBody);
                const inputs = normalizeEmbeddingInputs(parsedBody);
                const doFetch = () => {
                    // 记忆分流：未配置时默认跟随官方主 API 向量通道，配置后全权分流隔离
                    if (!memConf.url || !memConf.key) {
                        return _nativeFetch.call(this, input, newInit);
                    }
                    return runMemoryRoute(() => reroute(buildCustomEndpoint(memConf.url, 'embeddings'), memConf.key, { retryTransient: true }));
                };
                // 🧠 向量缓存：同模型 + 同输入 → 直接复用，换 API 站不再重复计费。
                return cachedEmbeddingFetch(modelKey, inputs, doFetch);
            }

            if (parsedBody && Array.isArray(parsedBody.messages)) {
                newInit.body = JSON.stringify(parsedBody);
                // 请求体采用同一清理结果后，再同步上下文查看器显示层。
                scrubContextViewerNextResponse();
                startContextViewerDomScrubber();
            }

            const isClassicMemoryRequest = parsedBody?.messages?.some(message => {
                const content = String(message?.content || '');
                return content.includes(FP_MEMORY) || content.includes(FP_MEMORY_SECONDARY);
            });

            // A. 经典记忆总结与二次压缩请求
            if (isClassicMemoryRequest) {
                if (memConf.url && memConf.key) {
                    // 用户配置了记忆分流：分流接管！
                    // 仅当请求体未指定模型时，才使用预设模型兜底；
                    // 若官方已指定副模型（如在官方记忆设置中选了 claude/gemini/gpt 等与主API同款的模型），严禁强行篡改成 deepseek-chat！
                    if (parsedBody && !parsedBody.model) {
                        parsedBody.model = memConf.model;
                    }
                    return runMemoryRoute(() => reroute(buildCustomEndpoint(memConf.url, 'chat/completions'), memConf.key, { retryTransient: true }));
                } else {
                    // 未配置分流：默认使用主 API / 官方默认链路，绝不擅自掐死！
                    return _nativeFetch.call(this, input, newInit);
                }
            }

            // B. UI 变量模板分析请求
            const isUiAnalysisRequest = isUiTemplateAnalysisMessages(parsedBody?.messages);
            if (isUiAnalysisRequest) {
                if (uiConf.url && uiConf.key) {
                    // 用户配置了副模型分流：分流接管！若选了预设供应商（如 DeepSeek）才自动替换，自定义地址若未指定则不乱改
                    if (uiConf.model && parsedBody && !uiConf.isCustom) {
                        parsedBody.model = uiConf.model;
                    }
                    return reroute(buildCustomEndpoint(uiConf.url, 'chat/completions'), uiConf.key);
                } else {
                    // 未配置分流：默认使用主 API / 官方默认副通道，保证正常分析，井水不犯河水！
                    return _nativeFetch.call(this, input, newInit);
                }
            }

            // C. 主聊天会话请求
            // V4：网络层零改写。温度由 UI 层 Vue 同步 watch 守护（installPreferenceGuards），
            // 官方请求体读的就是 settings.temperature，天然正确；流式同理跟随 settings.stream。
            if (isMainChatRequest) {
                const response = await _nativeFetch.call(this, input, newInit);
                return observeMainChatCompletionResponse(response);
            }

            return _nativeFetch.call(this, input, newInit);
        } catch (e) {
            // 分流如果配置了但网络/密钥报错，明确报错给用户查看，绝不偷偷跑回主 API 扣钱！
            if (isAuxiliaryRequest) {
                console.error('[苏萝萝分流] 副通道调用失败 (已阻止回退主通道):', e);
                throw e;
            }
            console.warn('[苏萝萝分流] 主请求拦截异常，回退原生:', e);
            return _nativeFetch.apply(this, arguments);
        }
    };
    hookedFetch.__sakura_hooked__ = true;
    window.fetch = hookedFetch;

    // 卡片交互保持 RP-Hub 1.8.8 官方逻辑，不注入自动发送桥。

    // ================= CSS 零延迟注入（消除 FOUC 闪烁） =================

    // ================= 🧩 公共工具 =================
    function getVueState() {
        try {
            const el = document.getElementById('app');
            if (el && el.__vue_app__ && el.__vue_app__._instance) {
                return el.__vue_app__._instance.setupState || el.__vue_app__._instance.proxy || null;
            }
            if (el && el.__vue_app__ && el.__vue_app__._container && el.__vue_app__._container._vnode) {
                return el.__vue_app__._container._vnode.component?.setupState || null;
            }
        } catch (e) {}
        return null;
    }

    function unref(x) {
        if (x && typeof x === 'object' && 'value' in x) return x.value;
        return x;
    }

    function installCardKeyboardSuppression() {
        if (window.__sakuraCardKeyboardSuppressionInstalled) return true;
        const originalTriggerSlash = window.triggerSlash;
        if (typeof originalTriggerSlash !== 'function') return false;
        if (originalTriggerSlash.__sakuraCardKeyboardSuppression__) return true;

        const wrappedTriggerSlash = async function(...args) {
            const patched = [];
            const noopFocus = function() {};
            const patchPrototype = (proto) => {
                if (!proto) return;
                const desc = Object.getOwnPropertyDescriptor(proto, 'focus');
                if (!desc || typeof desc.value !== 'function') return;
                try {
                    Object.defineProperty(proto, 'focus', {
                        configurable: desc.configurable,
                        enumerable: desc.enumerable,
                        writable: desc.writable,
                        value: noopFocus
                    });
                    patched.push([proto, desc]);
                } catch (_) {}
            };

            // 官方最终拿到的通常是 HTMLInputElement/HTMLTextAreaElement 的原型方法，
            // 三层一起拦，覆盖 Vue ref 解包和浏览器原生调用路径。
            patchPrototype(window.HTMLElement && window.HTMLElement.prototype);
            patchPrototype(window.HTMLInputElement && window.HTMLInputElement.prototype);
            patchPrototype(window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype);

            // 兼容少数浏览器/框架给 ref 元素挂载了自己的 focus 方法的情况。
            const st = getVueState();
            const input = unref(st?.inputBox);
            let ownDesc = null;
            if (input && typeof input.focus === 'function') {
                ownDesc = Object.getOwnPropertyDescriptor(input, 'focus');
                try {
                    Object.defineProperty(input, 'focus', {
                        configurable: true,
                        enumerable: ownDesc ? ownDesc.enumerable : false,
                        writable: true,
                        value: noopFocus
                    });
                } catch (_) { ownDesc = null; }
            }

            try {
                // 保持官方 pendingCardInteraction、nextTick 和预输入流程，禁止的只有 focus。
                return await originalTriggerSlash.apply(this, args);
            } finally {
                if (input) {
                    try {
                        if (ownDesc) Object.defineProperty(input, 'focus', ownDesc);
                        else delete input.focus;
                    } catch (_) {}
                }
                for (let i = patched.length - 1; i >= 0; i--) {
                    try { Object.defineProperty(patched[i][0], 'focus', patched[i][1]); } catch (_) {}
                }
            }
        };
        wrappedTriggerSlash.__sakuraCardKeyboardSuppression__ = true;
        window.triggerSlash = wrappedTriggerSlash;
        window.__sakuraCardKeyboardSuppressionInstalled = true;
        return true;
    }

    let cardKeyboardSuppressionAttempts = 0;
    const cardKeyboardSuppressionTimer = setInterval(() => {
        cardKeyboardSuppressionAttempts++;
        if (installCardKeyboardSuppression() || cardKeyboardSuppressionAttempts >= 240) {
            clearInterval(cardKeyboardSuppressionTimer);
        }
    }, 250);

function getCharKey() {
        try {
            const st = getVueState();
            const c = st && unref(st.currentCharacter);
            if (c && (c.id || c.name)) return String(c.id || c.name);
        } catch (e) {}
        return 'default';
    }


    function mkBtn(label, main, handler) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sakura-btn' + (main ? ' sakura-btn--main' : '');
        b.textContent = label;
        b.addEventListener('click', handler);
        return b;
    }

    // 🛡️ 官方底层持久化保存桥
    async function commitModelSelection(target, modelId) {
        const st = getVueState();
        if (st) {
            if ('modelSelectionTarget' in st) st.modelSelectionTarget = target;
            if (typeof st.selectModel === 'function') {
                try { st.selectModel(modelId); } catch (_) {}
            } else if (target === 'memoryEmbeddingModel' && st.memorySettings) {
                st.memorySettings.embeddingModel = modelId;
            } else if (target === 'memoryClassicModel' && st.memorySettings) {
                st.memorySettings.classicModel = modelId;
            } else if (st.settings) {
                st.settings[target] = modelId;
            }

            // 1.9.5 官方不再导出 saveMemorySettingsNow / saveData（1.9.4 有）；
            // 内存改完后统一走下方 RPHubStorage 存储层落库，这里仅在旧版存在时调用。
            if ((target === 'memoryEmbeddingModel' || target === 'memoryClassicModel') && typeof st.saveMemorySettingsNow === 'function') {
                try { await st.saveMemorySettingsNow(); } catch (_) {}
            } else if (target === 'uiTemplateModel' && typeof st.saveData === 'function') {
                try { await st.saveData(); } catch (_) {}
            }
        }

        if (window.RPHubStorage && typeof window.RPHubStorage.getStoredValue === 'function' && typeof window.RPHubStorage.setStoredValue === 'function') {
            try {
                if (target === 'memoryEmbeddingModel' || target === 'memoryClassicModel') {
                    const currentMem = (await window.RPHubStorage.getStoredValue('memory_settings')) || {};
                    if (target === 'memoryEmbeddingModel') currentMem.embeddingModel = modelId;
                    else currentMem.classicModel = modelId;
                    await window.RPHubStorage.setStoredValue('memory_settings', currentMem);
                } else if (target === 'uiTemplateModel') {
                    const currentSettings = (await window.RPHubStorage.getStoredValue('settings')) || {};
                    currentSettings.uiTemplateModel = modelId;
                    await window.RPHubStorage.setStoredValue('settings', currentSettings);
                }
            } catch (err) {
                console.warn('[苏萝萝] RPHubStorage 写入异常:', err);
            }
        }
    }

    function updateModelButton(button, modelId) {
        const span = button && button.querySelector('span');
        if (span) {
            span.textContent = modelId;
            span.className = 'text-gray-700 font-semibold';
        }
    }

    // ================= 📝 模块：经典记忆可编辑（真生效，AI 收到编辑后的 summary） =================
    function injectClassicMemoryEditButtons() {
        // ===== V20 原生派（官方 2.0.0） =====
        // 官方记忆项从 1.9.8 的 article.memory-summary（内部 .mb-2.5 / .whitespace-pre-line）
        // 全面重构为 ol.memory-timeline > li.memory-item，子结构：
        //   .memory-item__head（含 .memory-item__turn 轮次、.memory-item__chars 字数、.memory-item__retry 重试键）
        //   .memory-item__text（摘要正文）
        // 旧锚点全部失效 → 编辑/删除入口全挂。这里对齐新 DOM，同时兼容旧结构。
        const cards = document.querySelectorAll('li.memory-item, article.memory-summary');
        if (cards.length === 0) return;
        const st = getVueState();
        const memories = st && Array.isArray(unref(st.displayedClassicMemories))
            ? unref(st.displayedClassicMemories)
            : (st && Array.isArray(unref(st.classicMemories)) ? unref(st.classicMemories) : null);
        if (!memories) return;
        let injected = 0;
        cards.forEach(card => {
            if (card.querySelector('.sakura-mem-edit')) return;
            // 新版：.memory-item__text；旧版兼容：.whitespace-pre-line
            const summaryEl = card.querySelector('.memory-item__text, .whitespace-pre-line');
            if (!summaryEl) return;
            const summaryText = (summaryEl.textContent || '').trim();
            if (!summaryText) return;
            const mem = memories.find(m => (m.summary || '').trim() === summaryText);
            if (!mem) return;
            // 新版头容器：.memory-item__head；旧版兼容：mb-2.5 / mb-3 / firstElementChild
            const header = card.querySelector('.memory-item__head') || card.querySelector('[class*="mb-2.5"]') || card.querySelector('.mb-3') || card.firstElementChild;
            if (!header) return;
            // 官方重试键（新版 .memory-item__retry；旧版 button[title*="重新生成"]）作为锚点
            const retryBtn = header.querySelector('.memory-item__retry') || card.querySelector('button[title*="重新生成"]');
            const anchor = retryBtn || header;
            const mkIconBtn = (cls, title, svg) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = cls;
                b.title = title;
                b.innerHTML = svg;
                b.dataset.memId = String(mem.id || '');
                return b;
            };
            const btn = mkIconBtn('sakura-mem-edit', '编辑这条总结',
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>');
            const delBtn = mkIconBtn('sakura-mem-del', '删除这条总结',
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>');
            delBtn.addEventListener('click', ev => {
                ev.preventDefault();
                ev.stopPropagation();
                deleteClassicMemoryEntry(mem);
            });
            // 新版头容器为 flex + gap，官方 retry 已是紧凑方块，直接相邻插入
            if (anchor === header) {
                header.appendChild(btn);
                header.appendChild(delBtn);
            } else {
                anchor.insertAdjacentElement('afterend', delBtn);
                anchor.insertAdjacentElement('afterend', btn);
            }
            injected++;
        });
        if (injected) console.log(`[苏萝萝] 已注入 ${injected} 个经典记忆编辑按钮`);
    }

    // 删除单条经典记忆：与编辑同机制（官方存储层直写 + 正门重载）。
    // 注意：官方没有单条删除接口，只能整库改写；删除后若该轮对话正文仍在，
    // 官方下次补录可能重新生成该轮记忆（这是官方行为，非插件可控）。
    async function deleteClassicMemoryEntry(memory) {
        const turnLabel = Number(memory.turn) || '?';
        if (!window.confirm(`确定删除第 ${turnLabel} 轮的总结记忆吗？\n（若该轮对话正文还在，官方补录时可能重新生成）`)) return;
        const st = getVueState();
        const scopeId = (typeof sakuraMemScopeId === 'function') ? sakuraMemScopeId() : null;
        let ok = false;
        if (scopeId && window.RPHubStorage && typeof window.RPHubStorage.getScopedStoredValue === 'function') {
            try {
                const list = await window.RPHubStorage.getScopedStoredValue('classic_memories', scopeId);
                const arr = Array.isArray(list) ? list : [];
                const next = arr.filter(m => String(m.id) !== String(memory.id));
                if (next.length === arr.length) { alert('未找到该记忆，可能已删除'); return; }
                await window.RPHubStorage.setScopedStoredValue('classic_memories', scopeId, next);
                ok = true;
            } catch (err) {
                console.warn('[苏萝萝] 记忆删除写库失败:', err);
            }
        }
        // 兼容旧版（1.9.4 及以前）：真 ref 可写时走内存改 + 官方保存
        if (!ok && st && Array.isArray(unref(st.classicMemories))) {
            const arr = unref(st.classicMemories);
            const idx = arr.findIndex(m => String(m.id) === String(memory.id));
            if (idx === -1) { alert('未找到该记忆，可能已删除'); return; }
            arr.splice(idx, 1);
            if (typeof st.saveClassicMemoriesNow === 'function') {
                try { await st.saveClassicMemoriesNow(); } catch (_) {}
            }
            ok = true;
        }
        if (!ok) { alert('无法访问记忆数据'); return; }
        if (typeof sakuraMemHotReload === 'function') {
            try { await sakuraMemHotReload(); } catch (_) {}
        }
        // 兜底：直接从 DOM 摘掉卡片（重载失败时也能立即消失）
        const card = document.querySelector(`.sakura-mem-del[data-mem-id="${String(memory.id)}"]`)?.closest('li.memory-item, article.memory-summary, article');
        if (card) card.remove();
        alert(`已删除第 ${turnLabel} 轮的总结记忆`);
    }

    function openClassicMemoryEditor(memory) {
        const exist = document.getElementById('sakura-mem-editor');
        if (exist) exist.remove();
        const mask = document.createElement('div');
        mask.id = 'sakura-mem-editor';
        mask.className = 'sakura-mask';
        const box = document.createElement('div');
        box.className = 'sakura-box';
        const head = document.createElement('div');
        head.className = 'sakura-head';
        head.innerHTML = `
            <div class="sakura-modal-topbar">
                <div class="sakura-title-with-icon">
                    <span>编辑记忆分片</span>
                </div>
                <button type="button" class="sakura-close-btn" title="关闭">✕</button>
            </div>
            <div class="sakura-sub">第 ${Number(memory.turn) || '?'} 轮 · 修改后保存，AI 将收到编辑后的内容</div>
        `;
        const body = document.createElement('div');
        body.className = 'sakura-body';
        const ta = document.createElement('textarea');
        ta.className = 'sakura-note-area';
        ta.style.minHeight = '40vh';
        ta.value = memory.summary || '';
        ta.spellcheck = false;
        body.appendChild(ta);
        const foot = document.createElement('div');
        foot.className = 'sakura-foot';
        const saveBtn = mkBtn('保存', true, async () => {
            const newVal = ta.value.trim();
            if (!newVal) { alert('内容不能为空'); return; }
            const st = getVueState();
            const scopeId = (typeof sakuraMemScopeId === 'function') ? sakuraMemScopeId() : null;
            // 1.9.5 官方不再导出 classicMemories / saveClassicMemoriesNow（1.9.4 有），
            // 改为直接经官方存储层改写 classic_memories 库中的 summary 字段，再走官方正门重载刷面板。
            let ok = false;
            if (scopeId && window.RPHubStorage && typeof window.RPHubStorage.getScopedStoredValue === 'function') {
                try {
                    const list = await window.RPHubStorage.getScopedStoredValue('classic_memories', scopeId);
                    const arr = Array.isArray(list) ? list : [];
                    const idx = arr.findIndex(m => String(m.id) === String(memory.id));
                    if (idx === -1) { alert('未找到该记忆，可能已删除'); mask.remove(); return; }
                    arr[idx] = { ...arr[idx], summary: newVal };
                    await window.RPHubStorage.setScopedStoredValue('classic_memories', scopeId, arr);
                    ok = true;
                } catch (err) {
                    console.warn('[苏萝萝] 记忆保存写库失败:', err);
                }
            }
            // 兼容旧版（1.9.4 及以前）：真 ref 可写时优先走内存改 + 官方保存
            if (!ok && st && Array.isArray(unref(st.classicMemories))) {
                const arr = unref(st.classicMemories);
                const idx = arr.findIndex(m => String(m.id) === String(memory.id));
                if (idx === -1) { alert('未找到该记忆，可能已删除'); mask.remove(); return; }
                arr[idx].summary = newVal;
                if (typeof st.saveClassicMemoriesNow === 'function') {
                    try { await st.saveClassicMemoriesNow(); } catch (_) {}
                }
                ok = true;
            }
            if (!ok) { alert('无法访问记忆数据'); return; }
            // 走官方正门重载，把新数据灌进真 ref（面板/对话立即生效）
            if (typeof sakuraMemHotReload === 'function') {
                try { await sakuraMemHotReload(); } catch (_) {}
            }
            // 更新 DOM 显示
            const card = document.querySelector(`[data-mem-id="${String(memory.id)}"]`)?.closest('li.memory-item, article.memory-summary, article');
            const summaryEl = card && card.querySelector('.memory-item__text, .whitespace-pre-line');
            if (summaryEl) summaryEl.textContent = newVal;
            alert('已保存，AI 将收到编辑后的记忆');
            mask.remove();
        });
        foot.appendChild(mkBtn('取消', false, () => mask.remove()));
        foot.appendChild(saveBtn);
        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        mask.appendChild(box);
        head.querySelector('.sakura-close-btn').onclick = () => mask.remove();
        mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
        document.body.appendChild(mask);
        ta.focus();
    }

    // ================= 📖 模块二：名场面回忆手记（高光收录） =================
    let lastMomentSaveError = null;
    let _momentsCache = null;
    let _momentsHydrated = false;
    // pluginStorage 遗留数据读取（v19.4.7 及更早的扁平数组 / 更早的分桶对象），一次性搬进 IDB。
    function readLegacyMomentsFromLS() {
        try {
            const raw = pluginStorage.getItem(MOMENTS_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            let list;
            if (Array.isArray(parsed)) {
                list = parsed.filter(Boolean);
            } else {
                const merged = [];
                if (parsed && typeof parsed === 'object') {
                    Object.values(parsed).forEach(l => { if (Array.isArray(l)) merged.push(...l.filter(Boolean)); });
                }
                list = merged;
            }
            return list.map(({ images, ...text }) => text);
        } catch (e) { return []; }
    }
    // 瘦身镜像：只留最近20条、砍图、截断长文，给 pluginStorage 减负，也当灾备。
    function writeMomentsMirror(list) {
        const mirror = (Array.isArray(list) ? list : []).slice(0, 20).map(m => {
            if (!m || typeof m !== 'object') return m;
            const clone = { ...m };
            delete clone.images;
            if (typeof clone.aiText === 'string' && clone.aiText.length > 3000) clone.aiText = clone.aiText.slice(0, 3000);
            if (typeof clone.userPrompt === 'string' && clone.userPrompt.length > 500) clone.userPrompt = clone.userPrompt.slice(0, 500);
            return clone;
        });
        pluginStorage.setItem(MOMENTS_KEY, JSON.stringify(mirror));
    }
    async function ensureMomentsHydrated() {
        if (_momentsHydrated) return;
        const list = await idbGetMoments();
        _momentsCache = Array.isArray(list) ? list.filter(Boolean) : [];
        _momentsHydrated = true;
    }
    // 同步读取：水合完成前回退 pluginStorage 镜像；主链路（面板/保存）都会先 ensure。
    function getMomentsStore() {
        if (_momentsHydrated) return _momentsCache.slice();
        return readLegacyMomentsFromLS();
    }
    async function saveMomentsStore(list) {
        const base = Array.isArray(list) ? list : [];
        try {
            await idbPutMoments(base);
            _momentsCache = base.slice();
            lastMomentSaveError = null;
            try { writeMomentsMirror(base); } catch (_) {}
            return true;
        } catch (error) { lastMomentSaveError = error; return false; }
    }
    function getCharacterMoments() {
        return getMomentsStore();
    }
    async function saveCharacterMoment(moment) {
        if (!moment || typeof moment !== 'object') return false;
        await ensureMomentsHydrated();
        const list = getMomentsStore();
        list.unshift(moment);
        return saveMomentsStore(list);
    }
    async function deleteCharacterMoment(momentId) {
        await ensureMomentsHydrated();
        const list = getMomentsStore();
        const next = list.filter(m => m && m.id !== momentId);
        if (next.length !== list.length) await saveMomentsStore(next);
    }


    // 文字收藏：思考折叠与正文显示，不执行生图或自定义 HTML 规则
    function renderMomentFormattedText(raw) {
        if (!raw) return { cotHtml: '', mainHtml: '' };
        let text = String(raw);

        // 1. 拆解思维链思考内容与正文
        let cotContent = '';
        let mainText = text;

        const thinkMatch = text.match(/<think(?:>|\s+[^>]*>)([\s\S]*?)<\/think>/i) ||
                           text.match(/<thought(?:>|\s+[^>]*>)([\s\S]*?)<\/thought>/i) ||
                           text.match(/<cot(?:>|\s+[^>]*>)([\s\S]*?)<\/cot>/i);

        if (thinkMatch) {
            cotContent = thinkMatch[1].trim();
            mainText = text.replace(thinkMatch[0], '').trim();
        }

        // 2. 处理 COT 的展示
        let cotHtml = '';
        if (cotContent) {
            const escapedCot = cotContent
                .replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '"', "'": '&#39;' }[m]))
                .replace(/\n/g, '<br>');
            const charCount = cotContent.length;
            cotHtml = `
                <details class="sakura-moment-cot">
                    <summary>
                        <span class="smcot-label">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                            思考过程 / 思维链
                        </span>
                        <span class="smcot-count">${charCount} 字 · 点击展开</span>
                    </summary>
                    <div class="smcot-body">${escapedCot}</div>
                </details>
            `;
        }


        const mainHtml = mainText.replace(/image###[\s\S]*?###/gi, '[图片]')
            .replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
            .replace(/\n/g, '<br>');
        return { cotHtml, mainHtml };
    }

    function openMomentsPanel() {
        const exist = document.getElementById('sakura-moments-mask');
        if (exist) exist.remove();
        const mask = document.createElement('div');
        mask.id = 'sakura-moments-mask';
        mask.className = 'sakura-mask';

        const box = document.createElement('div');
        box.className = 'sakura-box';
        mask.appendChild(box);

        const head = document.createElement('div');
        head.className = 'sm-head';
        box.appendChild(head);

        const body = document.createElement('div');
        body.className = 'sm-body';
        box.appendChild(body);

        const esc = s => String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '"', "'": '&#39;' }[m]));
        const plainText = t => String(t || '')
            .replace(/<think[\s\S]*?<\/think>/gi, '').replace(/<thought[\s\S]*?<\/thought>/gi, '').replace(/<cot[\s\S]*?<\/cot>/gi, '')
            .replace(/image###[\s\S]*?###/gi, '［图］').replace(/\s+/g, ' ').trim();
        const closeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 18L18 6M6 6l12 12"/></svg>';
        const backIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';

        const renderHeader = (mode, item, pageText) => {
            head.innerHTML = mode === 'detail'
                ? `<div class="sm-head-inner">
                    <button type="button" class="sm-icon-btn" data-act="back" aria-label="返回">${backIcon}</button>
                    <div class="sm-title-wrap">
                        <div class="sm-title sm-ellipsis">${gpEsc(item?.title || '名场面')}</div>
                        <div class="sm-sub sm-ellipsis">${gpEsc(item?.timestamp || '')}</div>
                    </div>
                    <button type="button" class="sm-icon-btn" data-act="close" aria-label="关闭">${closeIcon}</button>
                </div>`
                : `<div class="sm-head-inner">
                    <div class="sm-title-wrap">
                        <div class="sm-title">名场面手记</div>
                        <div class="sm-sub">共 ${getCharacterMoments().length} 则珍藏${pageText || ''}</div>
                    </div>
                    <button type="button" class="sm-icon-btn" data-act="close" aria-label="关闭">${closeIcon}</button>
                </div>`;
            head.querySelector('[data-act="close"]').onclick = () => mask.remove();
            const back = head.querySelector('[data-act="back"]');
            if (back) back.onclick = () => renderList();
        };

        // 分页条：紧凑页码 + 省略号折叠，超过 5 页自动收拢；仅列表视图显示。
        const renderPager = (totalPages) => {
            if (totalPages <= 1) return null;
            const pager = document.createElement('div');
            pager.className = 'sm-pager';
            const mkBtn = (label, page, opts = {}) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'sm-page-btn' + (opts.active ? ' is-active' : '');
                b.textContent = label;
                if (opts.disabled) b.disabled = true;
                else b.onclick = () => renderList(page);
                return b;
            };
            const pages = [];
            for (let p = 1; p <= totalPages; p++) {
                if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1) pages.push(p);
                else if (pages[pages.length - 1] !== '…') pages.push('…');
            }
            pager.appendChild(mkBtn('‹', currentPage - 1, { disabled: currentPage <= 1 }));
            pages.forEach(p => {
                if (p === '…') {
                    const dots = document.createElement('span');
                    dots.className = 'sm-page-dots';
                    dots.textContent = '…';
                    pager.appendChild(dots);
                } else {
                    pager.appendChild(mkBtn(String(p), p, { active: p === currentPage }));
                }
            });
            pager.appendChild(mkBtn('›', currentPage + 1, { disabled: currentPage >= totalPages }));
            return pager;
        };


        // 列表视图：卡片墙 + 分页（每页 9 张），仅展示标题、摘要和时间，点击进入详情。
        let currentPage = 1;
        const PAGE_SIZE = 9;
        const renderList = (page) => {
            if (Number.isInteger(page)) currentPage = page;
            const moments = getCharacterMoments();
            const totalPages = Math.max(1, Math.ceil(moments.length / PAGE_SIZE));
            if (currentPage > totalPages) currentPage = totalPages;
            renderHeader('list', null, totalPages > 1 ? ` · 第 ${currentPage} / ${totalPages} 页` : '');
            body.innerHTML = '';
            const view = document.createElement('div');
            view.className = 'sm-view-anim';
            if (!moments.length) {
                view.innerHTML = `<div class="sm-empty">
                    <svg class="sm-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>
                    当前剧情分支暂无收录<br>在 AI 消息底部点「收录」书签，即可珍藏高光时刻
                </div>`;
            } else {
                const start = (currentPage - 1) * PAGE_SIZE;
                const pageItems = moments.slice(start, start + PAGE_SIZE);
                const grid = document.createElement('div');
                grid.className = 'sm-grid';
                pageItems.forEach(item => {
                    const card = document.createElement('div');
                    card.className = 'sm-card';
                    const plain = plainText(item.aiText);
                    const excerpt = plain.length > 72 ? plain.slice(0, 72) + '…' : plain;
                    card.innerHTML = `
                        <div class="sm-card-title sm-ellipsis">${gpEsc(item.title || '名场面')}</div>
                        <div class="sm-card-excerpt">${gpEsc(excerpt)}</div>
                        <div class="sm-card-foot">
                            <span class="sm-card-time">${gpEsc(item.timestamp || '')}</span>
                        </div>
                        <button type="button" class="sm-card-del" aria-label="删除">${closeIcon}</button>
                    `;
                    card.addEventListener('click', () => renderDetail(item));
                    card.querySelector('.sm-card-del').addEventListener('click', e => {
                        e.stopPropagation();
                        openMomentConfirmDialog(`确认移除名场面「${item.title || '名场面'}」？`, async () => {
                            await deleteCharacterMoment(item.id);
                            renderList();
                        });
                    });
                    grid.appendChild(card);
                });
                view.appendChild(grid);
                const pager = renderPager(totalPages);
                if (pager) view.appendChild(pager);
            }
            body.appendChild(view);
        };

        // 详情视图：显示完整文字，折叠思考过程。
        const renderDetail = (item) => {
            renderHeader('detail', item);
            body.innerHTML = '';
            const view = document.createElement('div');
            view.className = 'sm-view-anim';
            const rendered = renderMomentFormattedText(item.aiText);
            const avatar = item.aiAvatar
                ? `<img class="sm-ai-avatar" src="${gpEsc(item.aiAvatar)}" alt="">`
                : `<div class="sm-ai-avatar sm-ai-avatar-fallback">AI</div>`;
            view.innerHTML = `
                ${item.userPrompt ? `<div class="sm-user"><b>我：</b>${gpEsc(item.userPrompt).replace(/\n/g, '<br>')}</div>` : ''}
                <div class="sm-ai-head">${avatar}<span class="sm-ai-name">${gpEsc(item.aiName || 'AI')}</span></div>
                ${rendered.cotHtml}
                <div class="markdown-body message-content-wrapper sm-content">${rendered.mainHtml}</div>
            `;
            body.appendChild(view);
        };

        if (!_momentsHydrated) {
            body.innerHTML = '<div class="sakura-loading-hint">正在翻开手记…</div>';
            ensureMomentsHydrated().then(() => { try { renderList(); } catch (_) {} }).catch(() => { try { renderList(); } catch (_) {} });
        } else {
            renderList();
        }
        mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
        document.body.appendChild(mask);
    }

// ================= 🎵 暗夜留声机（随身听）核心引擎与持久化 =================
function gpEsc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '"');
}
const GRAMOPHONE_DB_NAME = 'sakura_gramophone_db';
const GRAMOPHONE_DB_STORE = 'tracks';
const GRAMOPHONE_STORAGE_KEY = 'sakura_gramophone_playlist_v6';
const GRAMOPHONE_SETTINGS_KEY = 'sakura_gramophone_settings_v1';

// 默认沉浸式高音质白噪音/纯音（精选稳定可商用直链，冷调无杂音）
const DEFAULT_TRACKS = [];

let _gpAudio = null;
let _gpBlobUrlCache = new Map(); // LRU blob URL 缓存池（上限 2 首），杜绝 62MB 级重复 IO 与内存峰值抖动
let _gpDb = null;
let _gpPlaylist = [];
let _gpCurrentIndex = 0;
let _gpIsPlaying = false;
let _gpLoopMode = 'list'; // 'list' | 'single' | 'random'
let _gpVolume = 0.35;
let _gpPanelOpen = false;
let _gpCurrentPage = 1;
const GP_PAGE_SIZE = 5;

// 2. 歌单与设置持久化
function loadGramophoneData() {
    try {
        const savedSettings = JSON.parse(pluginStorage.getItem(GRAMOPHONE_SETTINGS_KEY) || '{}');
        if (typeof savedSettings.volume === 'number') _gpVolume = Math.min(1, Math.max(0, savedSettings.volume));
        if (savedSettings.loopMode) _gpLoopMode = savedSettings.loopMode;

        const savedList = JSON.parse(pluginStorage.getItem(GRAMOPHONE_STORAGE_KEY) || 'null');
        if (Array.isArray(savedList) && savedList.length > 0) {
            _gpPlaylist = savedList;
        } else {
            _gpPlaylist = [...DEFAULT_TRACKS];
            saveGramophonePlaylist();
        }
    } catch (_) {
        _gpPlaylist = [...DEFAULT_TRACKS];
    }
}

function saveGramophonePlaylist() {
    try {
        pluginStorage.setItem(GRAMOPHONE_STORAGE_KEY, JSON.stringify(_gpPlaylist));
    } catch (_) {}
}

function saveGramophoneSettings() {
    try {
        pluginStorage.setItem(GRAMOPHONE_SETTINGS_KEY, JSON.stringify({
            volume: _gpVolume,
            loopMode: _gpLoopMode
        }));
    } catch (_) {}
}

// 3. 播放引擎初始化与事件
function getGramophoneAudio() {
    if (!_gpAudio) {
        _gpAudio = new Audio();
        // 移除跨域限制，允许普通外链媒体流原生播放
        _gpAudio.volume = _gpVolume;
        _gpAudio.preload = 'metadata';

        _gpAudio.addEventListener('ended', () => {
            if (_gpLoopMode === 'single') {
                playTrack(_gpCurrentIndex, true);
            } else if (_gpLoopMode === 'random') {
                playRandomTrack();
            } else {
                playNextTrack();
            }
        });

        _gpAudio.addEventListener('timeupdate', () => {
            updateGramophoneProgress();
        });

        _gpAudio.addEventListener('play', () => {
            _gpIsPlaying = true;
            updateGramophoneUiState();
        });

        _gpAudio.addEventListener('pause', () => {
            _gpIsPlaying = false;
            updateGramophoneUiState();
        });

        _gpAudio.addEventListener('error', () => {
            showMomentToast('当前曲目加载失败');
            _gpIsPlaying = false;
            updateGramophoneUiState();
        });
    }
    return _gpAudio;
}

// 4. 播放控制逻辑
async function playTrack(index, forcePlay = true) {
    if (index < 0 || index >= _gpPlaylist.length) return;
    _gpCurrentIndex = index;
    // 自动跟随切页：正在播放的曲目始终在视野内
    const targetPage = Math.floor(index / GP_PAGE_SIZE) + 1;
    if (_gpCurrentPage !== targetPage) {
        _gpCurrentPage = targetPage;
    }
    const track = _gpPlaylist[index];
    const audio = getGramophoneAudio();

    try {
        let srcUrl = track.url;
        if (track.type === 'local') {
            // 如果已经在播放这首歌，直接从头播放，避免反复销毁重建导致解码器卡死
            if (audio._currentTrackId === track.id && audio.src) {
                audio.currentTime = 0;
                if (forcePlay) {
                    await audio.play();
                    _gpIsPlaying = true;
                }
                updateGramophoneUiState();
                return;
            }

            // LRU 缓存池命中：直接复用既有 blob URL，免去 62MB 级 IndexedDB 重复读取
            if (_gpBlobUrlCache.has(track.id)) {
                srcUrl = _gpBlobUrlCache.get(track.id);
                _gpBlobUrlCache.delete(track.id);
                _gpBlobUrlCache.set(track.id, srcUrl); // 刷新 LRU 热度
                audio._currentTrackId = track.id;
            } else {
                const blob = await getLocalTrackBlob(track.id);
                if (!blob) {
                    showMomentToast('本地音频文件未找到');
                    return;
                }
                srcUrl = URL.createObjectURL(blob);
                _gpBlobUrlCache.set(track.id, srcUrl);
                // 上限 2 首，超出即淘汰最旧并释放内存
                while (_gpBlobUrlCache.size > 2) {
                    const oldestKey = _gpBlobUrlCache.keys().next().value;
                    const oldestUrl = _gpBlobUrlCache.get(oldestKey);
                    _gpBlobUrlCache.delete(oldestKey);
                    try { URL.revokeObjectURL(oldestUrl); } catch (_) {}
                }
                audio._currentTrackId = track.id;
            }
        } else {
            audio._currentTrackId = track.id;
        }

        // 关键时序：load() 后必须等解码器真正就绪（canplay）再 play，
        // 彻底杜绝 Android WebView 硬解器重置窗口期的竞态卡顿
        audio.pause();
        audio.src = srcUrl;
        audio.volume = _gpVolume;
        audio.load();

        if (forcePlay) {
            await new Promise(resolve => {
                let settled = false;
                const onReady = () => {
                    if (settled) return;
                    settled = true;
                    audio.removeEventListener('canplay', onReady);
                    resolve();
                };
                audio.addEventListener('canplay', onReady);
                setTimeout(onReady, 2500); // 兜底：个别 ROM 不触发 canplay
            });
            await audio.play();
            _gpIsPlaying = true;
        }
    } catch (e) {
        console.warn('[留声机] 播放失败:', e);
        _gpIsPlaying = false;
    }
    updateGramophoneUiState();
}

function togglePlay() {
    const audio = getGramophoneAudio();
    if (_gpIsPlaying) {
        audio.pause();
    } else {
        if (!audio.src && _gpPlaylist.length > 0) {
            playTrack(_gpCurrentIndex, true);
        } else {
            audio.play().catch(() => {
                if (_gpPlaylist.length > 0) playTrack(_gpCurrentIndex, true);
            });
        }
    }
}

function playNextTrack() {
    if (_gpPlaylist.length === 0) return;
    const next = (_gpCurrentIndex + 1) % _gpPlaylist.length;
    playTrack(next, true);
}

function playPrevTrack() {
    if (_gpPlaylist.length === 0) return;
    const prev = (_gpCurrentIndex - 1 + _gpPlaylist.length) % _gpPlaylist.length;
    playTrack(prev, true);
}

function playRandomTrack() {
    if (_gpPlaylist.length <= 1) {
        playTrack(0, true);
        return;
    }
    let rand = _gpCurrentIndex;
    while (rand === _gpCurrentIndex) {
        rand = Math.floor(Math.random() * _gpPlaylist.length);
    }
    playTrack(rand, true);
}

function toggleLoopMode() {
    if (_gpLoopMode === 'list') _gpLoopMode = 'single';
    else if (_gpLoopMode === 'single') _gpLoopMode = 'random';
    else _gpLoopMode = 'list';
    saveGramophoneSettings();
    updateGramophoneUiState();
}

function seekProgress(pct) {
    if (!_gpAudio || !Number.isFinite(_gpAudio.duration)) return;
    _gpAudio.currentTime = _gpAudio.duration * pct;
}

function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// 5. 曲目管理（添加外链、本地导入、删除）
function openGramophoneUrlDialog(onConfirm) {
    const exist = document.getElementById('sakura-gramophone-url-dialog');
    if (exist) exist.remove();
    const mask = document.createElement('div');
    mask.id = 'sakura-gramophone-url-dialog';
    mask.className = 'sgp-dialog-mask';

    const box = document.createElement('div');
    box.className = 'sgp-dialog-box';
    box.innerHTML = `
        <div class="sgp-dialog-head">
            <div class="sgp-dialog-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
                </svg>
                <span>添加网络音频直链</span>
            </div>
            <div class="sgp-dialog-sub">输入音频 URL 直链即可永久收录入唱片夹</div>
        </div>
        <div class="sgp-dialog-body">
            <input class="sgp-dialog-input sgp-url-name" type="text" maxlength="30" placeholder="曲目名称（可选，留空从链接提取）">
            <input class="sgp-dialog-input sgp-url-link" type="text" placeholder="音频直链 https://.../audio.mp3">
        </div>
        <div class="sgp-dialog-foot">
            <button type="button" class="sgp-dialog-cancel">取消</button>
            <button type="button" class="sgp-dialog-submit">添加入夹</button>
        </div>
    `;
    mask.appendChild(box);

    const nameInput = box.querySelector('.sgp-url-name');
    const linkInput = box.querySelector('.sgp-url-link');

    const close = () => { document.removeEventListener('keydown', onKey, true); mask.remove(); };
    const confirm = () => {
        let title = nameInput.value.trim();
        let url = linkInput.value.trim();
        if (!url) {
            if (title.includes('|')) {
                const parts = title.split('|');
                title = parts[0].trim();
                url = parts.slice(1).join('|').trim();
            } else if (/^https?:\/\//i.test(title)) {
                url = title;
                title = '';
            }
        }
        if (!/^https?:\/\//i.test(url)) {
            showMomentToast('请输入以 http:// 或 https:// 开头的音频直链');
            linkInput.focus();
            return;
        }
        if (!title) {
            try {
                title = decodeURIComponent(url.split('/').pop().split('?')[0]) || '自定义外链';
            } catch (_) {
                title = url.split('/').pop().split('?')[0] || '自定义外链';
            }
        }
        close();
        onConfirm(title.slice(0, 30), url);
    };

    const onKey = e => {
        if (e.key === 'Escape') { e.stopPropagation(); close(); }
        else if (e.key === 'Enter') { e.stopPropagation(); confirm(); }
    };

    box.querySelector('.sgp-dialog-cancel').onclick = close;
    box.querySelector('.sgp-dialog-submit').onclick = confirm;
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(mask);
    setTimeout(() => linkInput.focus(), 60);
}
function addDirectUrlTrack() {
    openGramophoneUrlDialog((title, url) => {
        const newTrack = {
            id: 'url-' + Date.now(),
            title,
            type: 'url',
            url
        };
        _gpPlaylist.push(newTrack);
        saveGramophonePlaylist();
        renderGramophoneList();
        showMomentToast(`已加入留声机: ${title}`);
    });
}

async function importLocalTrackFiles(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    for (const file of files) {
        const id = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const title = file.name.replace(/\.[^/.]+$/, '').slice(0, 30);
        await saveLocalTrackFile(id, file);
        _gpPlaylist.push({
            id,
            title: title,
            type: 'local'
        });
    }
    saveGramophonePlaylist();
    renderGramophoneList();
    showMomentToast(`已成功导入 ${files.length} 首本地曲目`);
    e.target.value = '';
}

function deleteTrack(index) {
    if (index < 0 || index >= _gpPlaylist.length) return;
    const track = _gpPlaylist[index];
    openMomentConfirmDialog(`确定从留声机中移除《${track.title}》吗？`, () => {
        if (track.type === 'local') {
            removeLocalTrackFile(track.id);
            const cachedUrl = _gpBlobUrlCache.get(track.id);
            if (cachedUrl) {
                try { URL.revokeObjectURL(cachedUrl); } catch (_) {}
                _gpBlobUrlCache.delete(track.id);
            }
        }
        _gpPlaylist.splice(index, 1);
        saveGramophonePlaylist();
        if (_gpCurrentIndex === index) {
            if (_gpPlaylist.length > 0) {
                _gpCurrentIndex = _gpCurrentIndex % _gpPlaylist.length;
                if (_gpIsPlaying) playTrack(_gpCurrentIndex, true);
            } else {
                if (_gpAudio) { _gpAudio.pause(); _gpAudio.src = ''; }
                _gpIsPlaying = false;
            }
        } else if (_gpCurrentIndex > index) {
            _gpCurrentIndex -= 1;
        }
        const maxPage = Math.max(1, Math.ceil(_gpPlaylist.length / GP_PAGE_SIZE));
        if (_gpCurrentPage > maxPage) _gpCurrentPage = maxPage;
        renderGramophoneList();
        updateGramophoneUiState();
        showMomentToast('已移除曲目');
    });
}

// ================= 🎵 暗夜留声机 UI 渲染与底栏挂载 =================
function renderGramophoneList() {
    const listEl = document.querySelector('#sakura-gramophone-panel .sgp-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const pagerExist = document.querySelector('#sakura-gramophone-panel .sgp-pager');
    if (pagerExist) pagerExist.remove();

    if (_gpPlaylist.length === 0) {
        listEl.innerHTML = '<div class="gp-empty"><svg viewBox="0 0 24 24" fill="none" stroke="#6d5f66" stroke-width="1.2" style="width:30px;height:30px;margin-bottom:8px;opacity:.75;"><circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="6" stroke-dasharray="2 2" stroke-opacity=".5"/><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r=".8" fill="#6d5f66" stroke="none"/></svg><div class="gp-empty-title">唱片夹空空如也</div><div class="gp-empty-sub">支持无损永久存储 · 点下方导入专属曲库</div></div>';
        return;
    }

    const totalPages = Math.max(1, Math.ceil(_gpPlaylist.length / GP_PAGE_SIZE));
    if (_gpCurrentPage > totalPages) _gpCurrentPage = totalPages;
    if (_gpCurrentPage < 1) _gpCurrentPage = 1;

    const startIdx = (_gpCurrentPage - 1) * GP_PAGE_SIZE;
    const pageTracks = _gpPlaylist.slice(startIdx, startIdx + GP_PAGE_SIZE);

    pageTracks.forEach((t, i) => {
        const idx = startIdx + i;
        const item = document.createElement('div');
        const isActive = idx === _gpCurrentIndex;
        item.className = 'sgp-item' + (isActive ? ' is-active' : '');
        item.innerHTML = `
            <div class="sgp-item-left">
                <div class="sgp-item-status">
                    ${isActive && _gpIsPlaying
                        ? '<span class="sgp-playing-bars"><span></span><span></span><span></span></span>'
                        : '<span class="sgp-idle-dot"></span>'}
                </div>
                <div class="sgp-item-info">
                    <span class="sgp-item-title">${gpEsc(t.title)}</span>
                </div>
            </div>
            <div class="sgp-item-right">
                <span class="sgp-item-badge">${t.type === 'local' ? '本地' : '外链'}</span>
                <button class="sgp-item-del" title="移除此曲目"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
            </div>
        `;
        item.addEventListener('click', (e) => {
            if (e.target.closest('.sgp-item-del')) {
                e.stopPropagation();
                deleteTrack(idx);
                return;
            }
            if (_gpCurrentIndex === idx && _gpIsPlaying) {
                togglePlay();
            } else {
                playTrack(idx, true);
            }
        });
        listEl.appendChild(item);
    });

    // 只有当总曲目大于 5 首时，才优雅呈现迷你暗金分页条
    if (totalPages > 1) {
        const pager = document.createElement('div');
        pager.className = 'sgp-pager';
        pager.innerHTML = `
            <button class="sgp-page-btn sgp-prev-page" ${_gpCurrentPage <= 1 ? 'disabled' : ''} title="上一页">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <span class="sgp-page-info">${_gpCurrentPage} / ${totalPages}</span>
            <button class="sgp-page-btn sgp-next-page" ${_gpCurrentPage >= totalPages ? 'disabled' : ''} title="下一页">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><path d="M9 18l6-6-6-6"/></svg>
            </button>
        `;
        pager.querySelector('.sgp-prev-page').addEventListener('click', () => {
            if (_gpCurrentPage > 1) {
                _gpCurrentPage--;
                renderGramophoneList();
            }
        });
        pager.querySelector('.sgp-next-page').addEventListener('click', () => {
            if (_gpCurrentPage < totalPages) {
                _gpCurrentPage++;
                renderGramophoneList();
            }
        });
        listEl.parentElement.insertBefore(pager, listEl.nextSibling);
    }
}

function updateGramophoneProgress() {
    if (!_gpAudio) return;
    const trackBar = document.querySelector('#sakura-gramophone-panel .sgp-bar-track');
    if (trackBar && trackBar.classList.contains('is-dragging')) return; // 用户正在拖动时不被播放进度打架
    const cur = _gpAudio.currentTime || 0;
    const dur = _gpAudio.duration || 0;
    const curEl = document.querySelector('.sgp-cur-time');
    const durEl = document.querySelector('.sgp-dur-time');
    const barEl = document.querySelector('.sgp-bar-fill');
    if (curEl) curEl.textContent = formatTime(cur);
    if (durEl) durEl.textContent = Number.isFinite(dur) ? formatTime(dur) : '--:--';
    if (barEl && dur > 0) {
        barEl.style.width = Math.min(100, Math.max(0, (cur / dur) * 100)) + '%';
    }
}

function updateGramophoneUiState() {
    const curTrack = _gpPlaylist[_gpCurrentIndex] || null;
    const vinyl = document.querySelector('.sgp-vinyl');
    const nameEl = document.querySelector('.sgp-song-name');
    const tagEl = document.querySelector('.sgp-song-tag');
    const playBtn = document.querySelector('.sgp-play-btn');
    const loopBtn = document.querySelector('.sgp-loop-btn');
    const triggerBtn = document.querySelector('#sakura-gramophone-trigger');

    if (vinyl) {
        if (_gpIsPlaying) vinyl.classList.add('is-playing');
        else vinyl.classList.remove('is-playing');
    }
    if (triggerBtn) {
        if (_gpIsPlaying) triggerBtn.classList.add('sgp-btn-spin');
        else triggerBtn.classList.remove('sgp-btn-spin');
    }
    if (nameEl) nameEl.textContent = curTrack ? curTrack.title : '暂无曲目';
    if (tagEl && curTrack) {
        const typeText = curTrack.type === 'builtin' ? '内置氛围音' : (curTrack.type === 'local' ? '本地导入' : '网络直链');
        tagEl.innerHTML = `<span class="sgp-badge">${typeText}</span> · ${_gpPlaylist.length} 首唱片`;
    }
    if (playBtn) {
        playBtn.innerHTML = _gpIsPlaying
            ? '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    }
    if (loopBtn) {
        let loopIcon = '';
        let loopTip = '';
        if (_gpLoopMode === 'list') {
            loopTip = '列表循环';
            loopIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 01-4 4H3"/></svg>';
        } else if (_gpLoopMode === 'single') {
            loopTip = '单曲循环';
            loopIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 01-4 4H3"/><text x="10" y="15" font-size="8" font-family="sans-serif" font-weight="bold" fill="currentColor">1</text></svg>';
        } else {
            loopTip = '随机播放';
            loopIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>';
        }
        loopBtn.innerHTML = loopIcon;
        loopBtn.title = loopTip;
    }

    renderGramophoneList();
}

function openGramophonePanel() {
    try {
        if (_gpPanelOpen) {
            closeGramophonePanel();
            return;
        }
        const exist = document.getElementById('sakura-gramophone-panel');
        if (exist) exist.remove();

        loadGramophoneData();

        const panel = document.createElement('div');
        panel.id = 'sakura-gramophone-panel';
    panel.innerHTML = `
        <div class="sgp-head">
            <div class="sgp-title">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
            <circle cx="12" cy="12" r="9.5"></circle>
            <circle cx="12" cy="12" r="6.5" stroke-dasharray="2.5 2.5" stroke-opacity="0.6"></circle>
            <circle cx="12" cy="12" r="3.5"></circle>
            <circle cx="12" cy="12" r="1.2" fill="currentColor"></circle>
        </svg>
                <span>暗夜留声机</span>
                <span class="sgp-title-sub">GRAMOPHONE</span>
            </div>
            <button class="sgp-close" title="收起">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
        </div>
        <div class="sgp-player">
            <div class="sgp-now">
                <div class="sgp-vinyl ${(_gpIsPlaying ? 'is-playing' : '')}"></div>
                <div class="sgp-meta">
                    <div class="sgp-song-name">${gpEsc((_gpPlaylist[_gpCurrentIndex] && _gpPlaylist[_gpCurrentIndex].title) || '准备就绪')}</div>
                    <div class="sgp-song-tag">${_gpPlaylist.length > 0 ? `<span class="sgp-badge">${_gpPlaylist[_gpCurrentIndex] && _gpPlaylist[_gpCurrentIndex].type === 'local' ? '本地导入' : '网络直链'}</span> · ${_gpPlaylist.length} 首唱片` : '留声机唱片夹'}</div>
                </div>
            </div>
            <div class="sgp-progress-wrap">
                <span class="sgp-time sgp-cur-time">${_gpAudio ? formatTime(_gpAudio.currentTime || 0) : '0:00'}</span>
                <div class="sgp-bar-track">
                    <div class="sgp-bar-fill" style="width:${(_gpAudio && _gpAudio.duration > 0) ? Math.min(100, Math.max(0, ((_gpAudio.currentTime || 0) / _gpAudio.duration) * 100)) : 0}%">
                        <div class="sgp-bar-thumb"></div>
                    </div>
                </div>
                <span class="sgp-time sgp-dur-time">${(_gpAudio && Number.isFinite(_gpAudio.duration) && _gpAudio.duration > 0) ? formatTime(_gpAudio.duration) : '--:--'}</span>
            </div>
            <div class="sgp-controls">
                <button class="sgp-ctrl-btn sgp-loop-btn" title="列表循环"></button>
                <button class="sgp-ctrl-btn sgp-prev-btn" title="上一首">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
                </button>
                <button class="sgp-play-btn" title="播放 / 暂停">
                    <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <button class="sgp-ctrl-btn sgp-next-btn" title="下一首">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
                </button>
            </div>
        </div>
        <div class="sgp-list custom-scrollbar"></div>
        <div class="sgp-foot">
            <input type="file" id="sgp-file-input" accept="audio/*" multiple style="display:none">
            <button class="sgp-action-btn sgp-add-url-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg><span>添加外链</span>
            </button>
            <button class="sgp-action-btn sgp-import-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px;"><path stroke-linecap="round" stroke-linejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg><span>导入本地音频</span>
            </button>
        </div>
    `;

    document.body.appendChild(panel);
    _gpPanelOpen = true;

    // 绑定面板事件
    panel.querySelector('.sgp-close').addEventListener('click', closeGramophonePanel);
    panel.querySelector('.sgp-play-btn').addEventListener('click', togglePlay);
    panel.querySelector('.sgp-prev-btn').addEventListener('click', playPrevTrack);
    panel.querySelector('.sgp-next-btn').addEventListener('click', playNextTrack);
    panel.querySelector('.sgp-loop-btn').addEventListener('click', toggleLoopMode);

    const trackBar = panel.querySelector('.sgp-bar-track');
    let isSeeking = false;
    const updateSeekVisual = (clientX) => {
        const rect = trackBar.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const fill = trackBar.querySelector('.sgp-bar-fill');
        if (fill) fill.style.width = (pct * 100) + '%';
        if (_gpAudio && Number.isFinite(_gpAudio.duration)) {
            const curEl = panel.querySelector('.sgp-cur-time');
            if (curEl) curEl.textContent = formatTime(_gpAudio.duration * pct);
        }
        return pct;
    };

    trackBar.addEventListener('mousedown', (e) => {
        isSeeking = true;
        trackBar.classList.add('is-dragging');
        const pct = updateSeekVisual(e.clientX);
        const onMove = (me) => { if (isSeeking) updateSeekVisual(me.clientX); };
        const onUp = (ue) => {
            if (isSeeking) {
                isSeeking = false;
                trackBar.classList.remove('is-dragging');
                seekProgress(updateSeekVisual(ue.clientX));
            }
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    });

    trackBar.addEventListener('touchstart', (e) => {
        isSeeking = true;
        trackBar.classList.add('is-dragging');
        if (e.touches[0]) updateSeekVisual(e.touches[0].clientX);
    }, { passive: true });

    trackBar.addEventListener('touchmove', (e) => {
        if (isSeeking && e.touches[0]) updateSeekVisual(e.touches[0].clientX);
    }, { passive: true });

    trackBar.addEventListener('touchend', (e) => {
        if (isSeeking) {
            isSeeking = false;
            trackBar.classList.remove('is-dragging');
            if (e.changedTouches[0]) seekProgress(updateSeekVisual(e.changedTouches[0].clientX));
        }
    }, { passive: true });

    const fileInput = panel.querySelector('#sgp-file-input');
    panel.querySelector('.sgp-import-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', importLocalTrackFiles);

    panel.querySelector('.sgp-add-url-btn').addEventListener('click', addDirectUrlTrack);

    updateGramophoneUiState();
    } catch (err) {
        console.error('[留声机] 打开面板异常:', err);
        showMomentToast('打开留声机失败: ' + (err && err.message ? err.message : err));
    }
}

function closeGramophonePanel() {
    const panel = document.getElementById('sakura-gramophone-panel');
    if (panel) panel.remove();
    _gpPanelOpen = false;
}

// 6. 底栏第 5 按钮精准挂载
function injectGramophoneButton() {
    const branchBtn = document.querySelector('button[title*="剧情分支"]');
    if (!branchBtn || !branchBtn.parentElement) return;

    const parent = branchBtn.parentElement;
    if (parent.querySelector('#sakura-gramophone-trigger')) return;

    const gBtn = document.createElement('button');
    gBtn.id = 'sakura-gramophone-trigger';
    gBtn.type = 'button';
    // V20 原生派：挂入官方 2.0.0 的 .island-button，与发图/上下文/剧情分支同规格同质感
    gBtn.className = 'island-button';
    gBtn.title = '暗夜留声机（随身听）';
    gBtn.innerHTML = `
<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.75">
            <circle cx="12" cy="12" r="9.5"></circle>
            <circle cx="12" cy="12" r="6.5" stroke-dasharray="2.5 2.5" stroke-opacity="0.6"></circle>
            <circle cx="12" cy="12" r="3.5"></circle>
            <circle cx="12" cy="12" r="1.2" fill="currentColor"></circle>
        </svg>
    `;

    gBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openGramophonePanel();
    });

    // 紧贴在剧情分支按钮右边
    if (branchBtn.nextSibling) {
        parent.insertBefore(gBtn, branchBtn.nextSibling);
    } else {
        parent.appendChild(gBtn);
    }

    if (_gpIsPlaying) {
        gBtn.classList.add('sgp-btn-spin');
    }
}

    // 自定义命名弹窗：替代浏览器原生 prompt，暗夜绒面风格与手记展柜统一。
    // onConfirm(title) 在确认时回调；取消/Esc/点遮罩均静默关闭。
    function openMomentNamingDialog(defaultTitle, onConfirm) {
        const exist = document.getElementById('sakura-moment-naming');
        if (exist) exist.remove();
        const mask = document.createElement('div');
        mask.id = 'sakura-moment-naming';
        mask.className = 'sakura-mask';

        const box = document.createElement('div');
        box.className = 'sakura-box';
        box.innerHTML = `
            <div class="sn-head">
                <div class="sn-title">收录至名场面手记</div>
                <div class="sn-sub">为这段高光时刻取个名字吧</div>
            </div>
            <div class="sn-body">
                <input class="sn-input" type="text" maxlength="40" placeholder="名场面名称">
            </div>
            <div class="sn-foot">
                <button type="button" class="sn-btn sn-btn-cancel">取消</button>
                <button type="button" class="sn-btn sn-btn-ok">收录</button>
            </div>
        `;
        mask.appendChild(box);

        const input = box.querySelector('.sn-input');
        input.value = defaultTitle || '';
        const close = () => { document.removeEventListener('keydown', onKey, true); mask.remove(); };
        const confirm = () => {
            const title = input.value.trim() || defaultTitle || '名场面';
            close();
            onConfirm(title);
        };
        const onKey = e => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); }
            else if (e.key === 'Enter') { e.stopPropagation(); confirm(); }
        };
        box.querySelector('.sn-btn-cancel').onclick = close;
        box.querySelector('.sn-btn-ok').onclick = confirm;
        mask.addEventListener('click', e => { if (e.target === mask) close(); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(mask);
        requestAnimationFrame(() => { input.focus(); input.select(); });
    }

    // 自定义确认弹窗：替代浏览器原生 confirm，暗夜绒面风格与命名弹窗同血统。
    // onConfirm() 仅在点击"移除"时回调；取消/Esc/点遮罩静默关闭。
    function openMomentConfirmDialog(message, onConfirm) {
        const exist = document.getElementById('sakura-moment-confirm');
        if (exist) exist.remove();
        const mask = document.createElement('div');
        mask.id = 'sakura-moment-confirm';
        mask.className = 'sakura-mask';

        const box = document.createElement('div');
        box.className = 'sakura-box';
        box.innerHTML = `
            <div class="sn-head">
                <div class="sn-title">移除名场面</div>
                <div class="sn-sub">此操作不可撤销</div>
            </div>
            <div class="sn-body">
                <div class="sn-msg">${String(message || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '"', "'": '&#39;' }[m]))}</div>
            </div>
            <div class="sn-foot">
                <button type="button" class="sn-btn sn-btn-cancel">取消</button>
                <button type="button" class="sn-btn sn-btn-danger">移除</button>
            </div>
        `;
        mask.appendChild(box);

        const close = () => { document.removeEventListener('keydown', onKey, true); mask.remove(); };
        const onKey = e => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); }
            else if (e.key === 'Enter') { e.stopPropagation(); box.querySelector('.sn-btn-danger').click(); }
        };
        box.querySelector('.sn-btn-cancel').onclick = close;
        box.querySelector('.sn-btn-danger').onclick = () => { close(); onConfirm(); };
        mask.addEventListener('click', e => { if (e.target === mask) close(); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(mask);
    }

    // 轻量提示气泡：非阻断反馈（收录成功/失败），自动消失，不抢焦点。
    function showMomentToast(text) {
        const old = document.getElementById('sakura-moment-toast');
        if (old) old.remove();
        const toast = document.createElement('div');
        toast.id = 'sakura-moment-toast';
        toast.textContent = String(text || '');
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('is-out');
            setTimeout(() => toast.remove(), 450);
        }, 1800);
    }

    // 在官方每条消息底部的操作按钮组追加一个“收录名场面”书签按钮
    function injectMessageBookmarkButtons() {
        const actionButtons = document.querySelectorAll('.message-action-button');
        actionButtons.forEach(btn => {
            const bar = btn.parentElement;
            if (!bar || bar.querySelector('.sakura-bookmark-btn')) return;

            const wrap = bar.closest('[data-chat-index]');
            if (!wrap) return;
            if (wrap.getAttribute('data-role') !== 'assistant') return;

            const idx = parseInt(wrap.getAttribute('data-chat-index'), 10);
            if (isNaN(idx)) return;

            const bBtn = document.createElement('button');
            bBtn.type = 'button';
            bBtn.className = 'message-action-button sakura-bookmark-btn';
            bBtn.setAttribute('title', '收录至名场面手记');
            bBtn.innerHTML = '<svg class="w-3.5 h-3.5 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"></path></svg>';
            bBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();

                const state = getVueState();
                const history = state?.chatHistory || [];
                const currentMsg = history[idx];
                if (!currentMsg) {
                    showMomentToast('未找到该条消息记录');
                    return;
                }

                // 向上追溯用户前导消息（对戏上下文）
                let userPrompt = '';
                for (let i = idx - 1; i >= 0; i--) {
                    if (history[i]?.role === 'user' || history[i]?.isSelf) {
                        userPrompt = String(history[i]?.content || '').slice(0, 160);
                        break;
                    }
                }

                const defaultTitle = (String(currentMsg.content || '').replace(/<think[\s\S]*?<\/think>/i, '').replace(/<cot[\s\S]*?<\/cot>/i, '').trim().slice(0, 10) || '高光时刻') + '...';

                // 自定义命名弹窗替代原生 prompt；确认后执行收录。
                openMomentNamingDialog(defaultTitle, async (inputTitle) => {

                    const moment = {
                        id: 'moment_' + Date.now(),
                        title: inputTitle,
                        timestamp: new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString().slice(0, 5),
                        aiName: state?.currentCharacter?.name || 'AI',
                        aiAvatar: state?.currentCharacter?.avatar || '',
                        aiText: currentMsg.content || '',
                        userPrompt: userPrompt,
                    };

                    if (await saveCharacterMoment(moment)) {
                        bBtn.style.color = '#f472b6';
                        setTimeout(() => { bBtn.style.color = ''; }, 1500);
                        showMomentToast(`已收录「${moment.title}」`);
                    } else {
                        const errText = String((lastMomentSaveError && (lastMomentSaveError.name || lastMomentSaveError.message)) || '');
                        const usedKB = estimateStorageUsageKB();
                        if (/quota|exceed/i.test(errText) || usedKB > 4500) {
                            showMomentToast('空间不足(约' + usedKB + 'KB)，已自动清缓存仍不够，请开存储管家清理');
                            setTimeout(() => { try { openStorageJanitor(); } catch (_) {} }, 600);
                        } else if (errText) {
                            showMomentToast('保存失败：' + errText.slice(0, 50));
                        } else {
                            showMomentToast('保存失败：写入校验未通过，请重试');
                        }
                    }
                });
            };

            // 插入位置：垃圾桶（title="删除"）永远保持操作栏最右，书签插在它前面，
            // 避免用户按肌肉记忆点最右误触删除。
            const delBtn = bar.querySelector('button[title="删除"]');
            if (delBtn) bar.insertBefore(bBtn, delBtn);
            else bar.appendChild(bBtn);
        });
    }

    // ================= 📝 模块：全屏输入编辑器（长文畅写，回车不误发） =================
    function injectFullscreenComposer() {
        // ===== V20 原生派（官方 2.0.0） =====
        // 官方输入区重构为 .input-island > textarea.island-input + .island-toolbar，
        // 旧版依赖的 .flex.items-end 与 nextElementSibling 已完全失效（nextElementSibling 现在是宽度巨大的工具栏，
        // 会把按钮推出屏幕）。策略：全屏按钮直接作为原生 .island-button
        // 挂载进工具栏左侧工具组，完全跟随官方方块玻璃风格，不再做任何绝对定位。
        const island = document.querySelector('.input-island');
        if (!island) return;
        if (island.querySelector('.sakura-fs-btn')) return;
        const toolbar = island.querySelector('.island-toolbar');
        if (!toolbar) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        // 复用官方 .island-button 尺寸与动效，仅额外挂 .sakura-fs-btn 作为事件委托钩子
        btn.className = 'sakura-fs-btn island-button';
        btn.title = '全屏编辑';
        btn.setAttribute('aria-label', '全屏编辑');
        btn.innerHTML = '<svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 3H5a2 2 0 0 0-2 2v3"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 8V5a2 2 0 0 0-2-2h-3"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 16v3a2 2 0 0 0 2 2h3"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
        // 工具栏左侧第一个子容器就是工具组（flex items-center gap-0.5）
        const leftGroup = toolbar.firstElementChild;
        if (leftGroup) leftGroup.appendChild(btn);
        else toolbar.appendChild(btn);
    }

    function openFullscreenComposer() {
        const exist = document.getElementById('sakura-fs-composer');
        if (exist) exist.remove();
        const st = getVueState();
        // Vue3 setupState 里 ref 会被自动 unwrap，st.userInput 可能是字符串值也可能是 ref 对象
        if (!st || !('userInput' in st)) { alert('无法访问输入框'); return; }
        const getInput = () => {
            const v = st.userInput;
            return (v && typeof v === 'object' && 'value' in v) ? v.value : (v || '');
        };
        const setInput = (val) => {
            const v = st.userInput;
            if (v && typeof v === 'object' && 'value' in v) v.value = val;
            else st.userInput = val;
        };
        const mask = document.createElement('div');
        mask.id = 'sakura-fs-composer';
        mask.className = 'sakura-mask';
        mask.style.zIndex = '99999';
        const box = document.createElement('div');
        box.className = 'sakura-box';
        box.style.setProperty('width', 'min(760px, calc(100vw - 24px))', 'important');
        box.style.setProperty('maxWidth', '760px', 'important');
        box.style.setProperty('height', 'min(calc(100dvh - 28px), 760px)', 'important');
        box.style.setProperty('maxHeight', 'calc(100dvh - 28px)', 'important');
        box.style.setProperty('minHeight', '0', 'important');
        box.style.boxSizing = 'border-box';
        box.style.display = 'flex';
        box.style.flexDirection = 'column';
        const head = document.createElement('div');
        head.className = 'sakura-head';
        head.innerHTML = `
            <div class="sakura-modal-topbar">
                <div class="sakura-title-with-icon">
                    <svg class="sakura-title-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
                    <span>全屏编辑</span>
                </div>
                <button type="button" class="sakura-close-btn" title="关闭">✕</button>
            </div>
            <div class="sakura-sub">回车换行，不误发 · 写完整段再发送</div>
        `;
        const body = document.createElement('div');
        body.className = 'sakura-body';
        body.style.flex = '1';
        body.style.display = 'flex';
        body.style.minHeight = '0';
        const ta = document.createElement('textarea');
        ta.className = 'sakura-note-area custom-scrollbar';
        ta.style.flex = '1';
        ta.style.minHeight = '0';
        ta.style.height = '100%';
        ta.style.resize = 'none';
        ta.style.fontSize = '15px';
        ta.style.lineHeight = '1.7';
        ta.placeholder = '在这里尽情写，回车换行不会发送…';
        ta.value = getInput();
        ta.spellcheck = false;
        body.appendChild(ta);
        const foot = document.createElement('div');
        foot.className = 'sakura-foot';
        const hint = document.createElement('div');
        hint.className = 'sakura-note-hint';
        const mark = txt => {
            hint.textContent = txt;
            hint.classList.add('is-on');
            setTimeout(() => hint.classList.remove('is-on'), 1400);
        };
        foot.appendChild(hint);
        // 保存回输入框（不发送）
        foot.appendChild(mkBtn('保存到输入框', false, () => {
            setInput(ta.value);
            mark('已保存到输入框');
        }));
        // 发送
        foot.appendChild(mkBtn('发送', true, () => {
            const val = ta.value.trim();
            if (!val) { alert('内容不能为空'); return; }
            setInput(val);
            mask.remove();
            if (typeof st.sendMessage === 'function') {
                try { st.sendMessage(); } catch (e) { console.warn('[苏萝萝] 发送失败:', e); }
            }
        }));
        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        mask.appendChild(box);
        head.querySelector('.sakura-close-btn').onclick = () => mask.remove();
        mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
        document.body.appendChild(mask);
        // 不自动聚焦，避免打开全屏编辑器时唤起移动端输入法
    }

    // ================= 🤖 模块三：官方同款大容量模型拉取弹窗 =================
    async function fetchCustomApiModels(url, key) {
        if (!url || !key) throw new Error('请先在分流卡片中配置好 API 地址与 Key');
        const res = await _nativeFetch(buildCustomEndpoint(url, 'models'), {
            headers: { 'Authorization': `Bearer ${key.trim()}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText || '拉取失败'}`);
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.data || data.models || []);
        const formatted = list.map(m => typeof m === 'string' ? { id: m } : { id: m.id || m.name || '' }).filter(m => m.id);
        if (formatted.length === 0) throw new Error('未获取到任何可用模型');
        return formatted;
    }

    function formatModelItemHtml(rawId) {
        let prefix = '';
        let coreName = rawId;
        const match = rawId.match(/^(\[[^\]]+\]|\([^\)]+\)|[a-zA-Z0-9_-]+\/)(.*)$/);
        if (match) {
            prefix = `<span class="sakura-model-prefix-tag">${match[1]}</span>`;
            coreName = match[2];
        }
        return `
            <div class="sakura-model-title-wrap">
                ${prefix}
                <span class="sakura-model-core-name font-mono">${coreName}</span>
            </div>
        `;
    }

    function openCustomModelModal({ title, subTitle, url, key, currentVal, onSelect }) {
        const exist = document.getElementById('sakura-model-modal');
        if (exist) exist.remove();
        const mask = document.createElement('div');
        mask.id = 'sakura-model-modal';
        mask.className = 'sakura-mask';
        const box = document.createElement('div');
        box.className = 'sakura-box sakura-box--wide';
        const head = document.createElement('div');
        head.className = 'sakura-head';
        head.innerHTML = `
            <div class="sakura-modal-topbar">
                <div>
                    <div class="sakura-title-with-icon">
                        <svg class="sakura-title-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-4.5a1 1 0 0 1-2 0V7a1 1 0 0 1 2 0z"/></svg>
                        <span>${title || '选择专属模型'}</span>
                    </div>
                    <div class="sakura-sub">${subTitle || ''}</div>
                </div>
                <button type="button" class="sakura-close-btn" title="关闭">✕</button>
            </div>
            <div class="sakura-searchbar">
                <input type="text" class="sakura-input sakura-model-search" placeholder="输入关键词快速检索 (点此输入)...">
            </div>
            <div class="sakura-tag-bar custom-scrollbar"></div>
        `;
        const body = document.createElement('div');
        body.className = 'sakura-body sakura-model-list-body custom-scrollbar';
        body.innerHTML = `
            <div class="sakura-model-loading">
                <div class="sakura-bloom-spinner">
                    <span class="petal p1"></span><span class="petal p2"></span><span class="petal p3"></span><span class="petal p4"></span>
                </div>
                <span>正在连接专属 API 拉取模型列表...</span>
            </div>
        `;
        const foot = document.createElement('div');
        foot.className = 'sakura-foot';
        foot.appendChild(mkBtn('取消', false, () => mask.remove()));
        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        mask.appendChild(box);
        document.body.appendChild(mask);

        head.querySelector('.sakura-close-btn').onclick = () => mask.remove();
        const searchInput = head.querySelector('.sakura-model-search');
        const tagBar = head.querySelector('.sakura-tag-bar');

        let allModels = [];
        let activeTag = 'all';

        const renderTags = (tags) => {
            tagBar.innerHTML = '';
            tags.forEach(tag => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'sakura-tag-btn' + (activeTag === tag.name ? ' is-active' : '');
                btn.innerHTML = `<span>${tag.name === 'all' ? '全部' : (tag.name === 'other' ? '其他' : tag.name.toUpperCase())}</span><span class="sakura-tag-count">${tag.count}</span>`;
                btn.onclick = () => {
                    activeTag = tag.name;
                    tagBar.querySelectorAll('.sakura-tag-btn').forEach(b => b.classList.remove('is-active'));
                    btn.classList.add('is-active');
                    renderList();
                };
                tagBar.appendChild(btn);
            });
        };

        const renderList = () => {
            const kw = searchInput.value.toLowerCase().trim();
            const filtered = allModels.filter(m => {
                const id = m.id.toLowerCase();
                const matchKw = !kw || id.includes(kw);
                if (!matchKw) return false;
                if (activeTag === 'all') return true;
                if (activeTag === 'other') {
                    return !POPULAR_FAMILIES.some(f => id.includes(f));
                }
                return id.includes(activeTag);
            });

            body.innerHTML = '';
            if (filtered.length === 0) {
                body.innerHTML = '<div class="sakura-empty">未找到匹配的模型喵~</div>';
                return;
            }
            filtered.forEach(m => {
                const row = document.createElement('div');
                row.className = 'sakura-model-row' + (m.id === currentVal ? ' is-selected' : '');
                row.innerHTML = `
                    <span class="sakura-model-indicator-bar"></span>
                    <div class="sakura-model-name-box">
                        ${formatModelItemHtml(m.id)}
                    </div>
                    ${m.id === currentVal ? '<span class="sakura-model-check">✓</span>' : ''}
                `;
                row.onclick = () => {
                    if (typeof onSelect === 'function') onSelect(m.id);
                    mask.remove();
                };
                body.appendChild(row);
            });
        };

        fetchCustomApiModels(url, key).then(models => {
            allModels = models;
            const counts = { all: models.length, other: 0 };
            const tagSet = new Set();
            models.forEach(m => {
                const id = m.id.toLowerCase();
                let found = false;
                for (const family of POPULAR_FAMILIES) {
                    if (id.includes(family)) {
                        tagSet.add(family);
                        counts[family] = (counts[family] || 0) + 1;
                        found = true;
                        break;
                    }
                }
                if (!found) counts.other++;
            });
            const tagList = [{ name: 'all', count: counts.all }];
            Array.from(tagSet).sort().forEach(t => tagList.push({ name: t, count: counts[t] }));
            if (counts.other > 0) tagList.push({ name: 'other', count: counts.other });

            renderTags(tagList);
            renderList();
            searchInput.oninput = () => renderList();
        }).catch(err => {
            body.innerHTML = `<div class="sakura-empty sakura-empty--danger"><p style="font-weight:700;margin-bottom:4px;">⚠️ 模型拉取失败</p><p style="font-size:11.5px;opacity:.9;">${err.message || err}</p><p class="sakura-empty-sub" style="margin-top:8px;">请检查当前供应商配置的 API 地址与 Key 是否有效。</p></div>`;
        });
    }

    // ================= 🎛️ 模块四：官方同款极简折叠分流卡片 =================
    function createSplitCard(channelType, shortTitle, descText) {
        const allData = loadSplitApis();
        let chanState = allData[channelType];

        const card = document.createElement('div');
        card.className = 'bg-white/70 backdrop-blur-sm p-1 rounded-2xl border border-gray-200 shadow-sm mb-4 overflow-hidden sakura-native-split-card' + (channelType === 'memory' ? ' is-memory' : ' is-ui');

        const conf = getActiveChannelConfig(chanState);
        const activeP = conf.provider;
        const hasCustomUrl = conf.isCustom;

        card.innerHTML = `
            <button type="button" class="settings-collapse-trigger sakura-split-collapse-btn w-full flex justify-between items-center px-4 py-3 rounded-xl font-bold transition-all text-gray-700 hover:bg-gray-50">
                <span class="flex items-center min-w-0">
                    <div class="sakura-split-icon-badge p-1.5 rounded-lg mr-3 bg-gray-100 text-gray-500 transition-colors flex-shrink-0">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                        </svg>
                    </div>
                    <span class="truncate text-sm font-bold text-gray-800">${shortTitle}</span>
                </span>
                <span class="flex items-center gap-2.5 flex-shrink-0 ml-2">
                    <span class="sakura-status-tag text-xs font-bold ${conf.url && conf.key ? 'text-primary-600' : 'text-gray-400'}">
                        ${conf.url && conf.key ? activeP.name : '跟随主 API'}
                    </span>
                    <svg class="settings-collapse-chevron sakura-split-chevron w-5 h-5 text-gray-400 transition-transform duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
                    </svg>
                </span>
            </button>

            <div class="settings-collapse sakura-split-drawer">
                <div class="settings-collapse__inner">
                    <div class="settings-collapse__content px-4 pb-4 pt-3 border-t border-gray-100 space-y-4">
                        <div class="text-xs text-gray-500 font-medium">${descText}（未配置时自动继承主 API 连接设置）</div>

                        <div>
                            <label class="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 ml-1">API 供应商预设</label>
                            <div class="sakura-provider-dropdown relative">
                                <button type="button" class="sakura-provider-current-btn w-full bg-gray-50/60 border-2 border-gray-100 rounded-xl px-3.5 py-2.5 flex items-center justify-between text-gray-800 font-medium hover:border-primary-200 transition-all">
                                    <span class="flex items-center gap-2.5">
                                        <span class="w-6 h-6 rounded-lg bg-white border border-gray-200 flex items-center justify-center overflow-hidden flex-shrink-0 text-xs shadow-sm">
                                            ${activeP.icon ? `<img src="${activeP.icon}" class="w-4 h-4 object-contain" onerror="this.style.display='none'">` : '🌸'}
                                        </span>
                                        <span class="sakura-current-pname text-sm font-bold text-gray-800">${activeP.name}</span>
                                    </span>
                                    <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                                </button>
                                <div class="sakura-provider-menu custom-scrollbar" style="display:none;">
                                    ${PROVIDER_PRESETS.map(p => `
                                        <div class="sakura-provider-option ${p.id === activeP.id ? 'is-selected' : ''}" data-pid="${p.id}">
                                            <span class="sakura-provider-icon-box">
                                                ${p.icon ? `<img src="${p.icon}" class="sakura-provider-icon" onerror="this.style.display='none'">` : '🌸'}
                                            </span>
                                            <span class="sakura-provider-option-detail">
                                                <span class="sakura-provider-opt-name">${p.name}</span>
                                                <span class="sakura-provider-opt-url font-mono">${p.id.startsWith('custom') ? (chanState.customUrls[p.id] || '自定义地址') : p.apiUrl}</span>
                                            </span>
                                            ${p.id === activeP.id ? '<span class="sakura-provider-opt-check">✓</span>' : ''}
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                        </div>

                        <div class="space-y-3">
                            <div class="sakura-custom-url-wrap" style="${hasCustomUrl ? '' : 'display:none;'}">
                                <label class="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1 ml-1">API 接口地址 (URL)</label>
                                <input type="text" class="sakura-split-input sakura-input-url w-full bg-gray-50/60 border-2 border-gray-100 rounded-xl px-3.5 py-2.5 text-gray-800 font-mono text-xs focus:bg-white focus:border-primary-500 focus:outline-none transition-all" placeholder="例如: https://api.openai.com/v1" value="${chanState.customUrls[activeP.id] || ''}">
                            </div>
                            <div>
                                <label class="sakura-key-label block text-xs font-bold text-gray-500 uppercase tracking-wider mb-1 ml-1">${activeP.name} 专属 API Key</label>
                                <input type="password" class="sakura-split-input sakura-input-key w-full bg-gray-50/60 border-2 border-gray-100 rounded-xl px-3.5 py-2.5 text-gray-800 font-mono text-xs focus:bg-white focus:border-primary-500 focus:outline-none transition-all" placeholder="在此填入 ${activeP.name} 的 Key (sk-...)" value="${chanState.keys[activeP.id] || ''}">
                            </div>

                        </div>

                        <div class="flex justify-between items-center pt-2 border-t border-gray-100">
                            <div class="flex items-center gap-2 text-xs font-semibold text-gray-600">
                                <span class="sakura-status-indicator ${conf.url && conf.key ? 'is-active' : ''}"></span>
                                <span class="sakura-status-text">${conf.url && conf.key ? `分流已就绪` : '未配置 Key，跟随主 API'}</span>
                            </div>
                            <button type="button" class="sakura-ping-btn" style="${conf.url && conf.key ? '' : 'display:none;'}" title="测试此分流 API 连通性">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                                <span>立即检测</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const collapseTrigger = card.querySelector('.sakura-split-collapse-btn');
        const drawer = card.querySelector('.sakura-split-drawer');
        const chevron = card.querySelector('.sakura-split-chevron');
        const iconBadge = card.querySelector('.sakura-split-icon-badge');

        collapseTrigger.onclick = () => {
            const isOpen = drawer.classList.toggle('is-open');
            card.classList.toggle('is-expanded', isOpen);
            chevron.classList.toggle('rotate-180', isOpen);
            if (isOpen) {
                iconBadge.classList.remove('bg-gray-100', 'text-gray-500');
                iconBadge.classList.add('bg-primary-100', 'text-primary-600');
            } else {
                iconBadge.classList.add('bg-gray-100', 'text-gray-500');
                iconBadge.classList.remove('bg-primary-100', 'text-primary-600');
            }
        };

        const dropdownBtn = card.querySelector('.sakura-provider-current-btn');
        const menu = card.querySelector('.sakura-provider-menu');
        if (dropdownBtn && menu) {
            dropdownBtn.onclick = (e) => {
                e.stopPropagation();
                menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
            };
        }

        const urlInput = card.querySelector('.sakura-input-url');
        const keyInput = card.querySelector('.sakura-input-key');
        const customUrlWrap = card.querySelector('.sakura-custom-url-wrap');
        const keyLabel = card.querySelector('.sakura-key-label');
        const currentPName = card.querySelector('.sakura-current-pname');
        const statusTag = card.querySelector('.sakura-status-tag');
        const statusInd = card.querySelector('.sakura-status-indicator');
        const statusTxt = card.querySelector('.sakura-status-text');
        const pingBtn = card.querySelector('.sakura-ping-btn');

        function updateUIState() {
            const c = getActiveChannelConfig(chanState);
            const p = c.provider;
            currentPName.textContent = p.name;
            keyLabel.textContent = `${p.name} 专属 API Key`;
            keyInput.placeholder = `在此填入 ${p.name} 的 Key (sk-...)`;
            customUrlWrap.style.display = c.isCustom ? 'block' : 'none';
            urlInput.value = chanState.customUrls[p.id] || '';
            keyInput.value = chanState.keys[p.id] || '';


            if (c.url && c.key) {
                statusTag.className = 'sakura-status-tag text-xs font-bold text-primary-600';
                statusTag.textContent = p.name;
                statusInd.className = 'sakura-status-indicator is-active';
                statusTxt.textContent = '分流已就绪';
                pingBtn.style.display = 'inline-flex';
            } else {
                statusTag.className = 'sakura-status-tag text-xs font-bold text-gray-400';
                statusTag.textContent = '跟随主 API';
                statusInd.className = 'sakura-status-indicator';
                statusTxt.textContent = '未配置 Key，跟随主 API';
                pingBtn.style.display = 'none';
            }
        }

        card.querySelectorAll('.sakura-provider-option').forEach(opt => {
            opt.onclick = (e) => {
                e.stopPropagation();
                const pid = opt.getAttribute('data-pid');
                chanState.selectedId = pid;
                const all = loadSplitApis();
                all[channelType] = chanState;
                saveSplitApis(all);
                card.querySelectorAll('.sakura-provider-option').forEach(o => o.classList.toggle('is-selected', o.getAttribute('data-pid') === pid));
                menu.style.display = 'none';
                updateUIState();
            };
        });

        if (urlInput) {
            urlInput.oninput = () => {
                const c = getActiveChannelConfig(chanState);
                chanState.customUrls[c.provider.id] = urlInput.value.trim();
                const all = loadSplitApis();
                all[channelType] = chanState;
                saveSplitApis(all);
                updateUIState();
            };
        }

        if (keyInput) {
            keyInput.oninput = () => {
                const c = getActiveChannelConfig(chanState);
                chanState.keys[c.provider.id] = keyInput.value.trim();
                const all = loadSplitApis();
                all[channelType] = chanState;
                saveSplitApis(all);
                updateUIState();
            };
        }



        if (pingBtn) {
            pingBtn.onclick = async (e) => {
                e.stopPropagation();
                const c = getActiveChannelConfig(chanState);
                if (!c.url || !c.key) return;

                statusInd.className = 'sakura-status-indicator is-checking';
                statusTxt.textContent = '正在检测连通性...';
                pingBtn.disabled = true;
                const tStart = performance.now();

                try {
                    const res = await _nativeFetch(buildCustomEndpoint(c.url, 'models'), {
                        headers: { 'Authorization': `Bearer ${c.key.trim()}` }
                    });
                    const lat = Math.round(performance.now() - tStart);
                    if (res.ok) {
                        statusInd.className = 'sakura-status-indicator is-active';
                        statusTxt.innerHTML = `连接正常 <span class="sakura-ping-latency font-mono">${lat}ms</span>`;
                    } else {
                        statusInd.className = 'sakura-status-indicator is-error';
                        statusTxt.textContent = `HTTP ${res.status} 鉴权异常`;
                    }
                } catch (err) {
                    statusInd.className = 'sakura-status-indicator is-error';
                    statusTxt.textContent = '连接失败: ' + (err.message || '网络超时');
                } finally {
                    pingBtn.disabled = false;
                }
            };
        }

        document.addEventListener('click', (e) => {
            if (!card.contains(e.target) && menu) menu.style.display = 'none';
        });

        return card;
    }

    function injectSplitApiPanels() {
        const headers = document.querySelectorAll('settings-page-header, .settings-page-header');
        for (const hdr of headers) {
            if ((hdr.textContent || '').includes('记忆系统')) {
                const container = hdr.parentElement;
                if (container && !container.querySelector('.sakura-native-split-card.is-memory')) {
                    const card = createSplitCard('memory', '分流接口设置', '逐轮记忆总结与向量嵌入将独立分流调用此接口');
                    if (hdr.nextElementSibling) container.insertBefore(card, hdr.nextElementSibling);
                    else container.appendChild(card);
                }
                break;
            }
        }
        for (const hdr of headers) {
            if ((hdr.textContent || '').includes('UI模板') || (hdr.textContent || '').includes('UI 模板')) {
                const container = hdr.parentElement;
                if (container && !container.querySelector('.sakura-native-split-card.is-ui')) {
                    const card = createSplitCard('ui', '分流接口设置', '副模型变量分析将独立分流调用此接口');
                    if (hdr.nextElementSibling) container.insertBefore(card, hdr.nextElementSibling);
                    else container.appendChild(card);
                }
                break;
            }
        }
    }

    // ================= 🎯 模块四：事件委托与全通道模型原生持久化 =================
    // 删除消息 / 发送 / AI 生成后的滚动行为全部回归官方原生逻辑，插件零干预。

    document.addEventListener('click', function(e) {
        const t = e.target;
        if (!t || !t.closest) return;

        // 🌸 樱花个性化分区卡片：全局委托处理。
        // 直连监听会被 Vue3 重绘/水合替换节点时弄丢，document 级委托不受任何动态重绘影响，
        // 只要 .sakura-personal-card 出现在页面里，无论被重建多少次都能响应。
        const personalCard = t.closest('.sakura-personal-card');
        if (personalCard && personalCard.getAttribute('data-entry')) {
            e.preventDefault();
            e.stopPropagation();
            const entry = personalCard.getAttribute('data-entry');
            if (entry === 'theme') openThemePanel();
            else if (entry === 'splash') openSplashPanel();
            else if (entry === 'janitor') openStorageJanitor();
            return;
        }
        // 🛡️ 经典记忆编辑按钮：点击打开编辑器
        const memEditBtn = t.closest('.sakura-mem-edit');
        if (memEditBtn) {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            const memId = memEditBtn.dataset.memId;
            const st = getVueState();
            // 1.9.5 官方不再导出 classicMemories（1.9.4 有）：优先用官方导出的 displayedClassicMemories，
            // 拿不到再从存储层按 id 捞（跨页也能命中）。
            let mem = null;
            const shown = st && Array.isArray(unref(st.displayedClassicMemories)) ? unref(st.displayedClassicMemories) : null;
            if (shown) mem = shown.find(m => String(m.id) === String(memId)) || null;
            if (!mem && st && Array.isArray(unref(st.classicMemories))) {
                mem = unref(st.classicMemories).find(m => String(m.id) === String(memId)) || null;
            }
            if (mem) { openClassicMemoryEditor(mem); return; }
            (async () => {
                try {
                    const scopeId = (typeof sakuraMemScopeId === 'function') ? sakuraMemScopeId() : null;
                    if (scopeId && window.RPHubStorage?.getScopedStoredValue) {
                        const list = await window.RPHubStorage.getScopedStoredValue('classic_memories', scopeId);
                        const found = (Array.isArray(list) ? list : []).find(m => String(m.id) === String(memId));
                        if (found) { openClassicMemoryEditor(found); return; }
                    }
                } catch (_) {}
                console.warn('[苏萝萝] 未找到记忆:', memId);
            })();
            return;
        }
        // 🖥️ 全屏输入编辑器按钮：点击打开
        const fsBtn = t.closest('.sakura-fs-btn');
        if (fsBtn) {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            openFullscreenComposer();
            return;
        }

        const modelBtn = t.closest('.settings-model-button');
        if (modelBtn) {
            const allConf = loadSplitApis();
            const memConf = getActiveChannelConfig(allConf.memory);
            const uiConf = getActiveChannelConfig(allConf.ui);
            const st = getVueState();
            const viewText = modelBtn.closest('.management-view')?.innerText || '';

            // 🎯 按钮级身份判定：只读「这个按钮自己所属 settings-field 的 label」。
            // 绝不能拿整页文本做 includes —— 增强模式下「总结模型」与「向量模型」两个 label
            // 同时存在，includes('向量模型') 必然命中，会导致点总结框也弹向量模型（历史 Bug）。
            const field = modelBtn.closest('.settings-field');
            const fieldLabel = (field?.querySelector('label')?.textContent || '').trim();
            // title 兜底：未选模型时官方 title 为「请选择总结模型 / 请选择向量模型」
            const btnTitle = (modelBtn.getAttribute('title') || '').trim();
            const isVectorField = fieldLabel.includes('向量模型') || fieldLabel.includes('向量嵌入模型')
                || btnTitle.includes('向量模型') || btnTitle.includes('向量嵌入模型');
            const isSummaryField = fieldLabel.includes('总结模型') || btnTitle.includes('总结模型');

            if ((isVectorField || isSummaryField) && memConf.url && memConf.key) {
                const isVector = isVectorField;
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
                openCustomModelModal({
                    title: isVector ? '向量嵌入模型（已解禁）' : '记忆总结副模型',
                    subTitle: `从 [${memConf.provider.name}] 实时拉取模型列表`,
                    url: memConf.url,
                    key: memConf.key,
                    currentVal: isVector ? (st?.memorySettings?.embeddingModel || '') : (st?.memorySettings?.classicModel || ''),
                    onSelect: async (mId) => {
                        await commitModelSelection(isVector ? 'memoryEmbeddingModel' : 'memoryClassicModel', mId);
                        updateModelButton(modelBtn, mId);
                    }
                });
                return;
            }

            if ((viewText.includes('UI模板') || viewText.includes('变量系统设置')) && uiConf.url && uiConf.key) {
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
                openCustomModelModal({
                    title: 'UI 变量分析模型',
                    subTitle: `从 [${uiConf.provider.name}] 实时拉取模型列表`,
                    url: uiConf.url,
                    key: uiConf.key,
                    currentVal: st?.settings?.uiTemplateModel || '',
                    onSelect: async (mId) => {
                        await commitModelSelection('uiTemplateModel', mId);
                        updateModelButton(modelBtn, mId);
                    }
                });
                return;
            }
        }
    }, true);

    // ================= 1. 全站美化 CSS（双端响应式高光 + 移动端性能优化） =================

    // 🚀 CSS 注入提前到 document-start：消除页面切换时官方默认样式闪烁（FOUC）
    const css = `
    /* v15.2 视觉重构：克制层级、减少大面积渐变与重阴影 */
    .sakura-mask{background:rgba(28,18,24,.42)!important;backdrop-filter:blur(8px) saturate(105%)!important;-webkit-backdrop-filter:blur(8px) saturate(105%)!important}
    .sakura-box{max-width:520px!important;border:1px solid rgba(235,190,204,.85)!important;border-radius:20px!important;box-shadow:0 18px 48px rgba(45,18,30,.18),0 2px 8px rgba(45,18,30,.06)!important}
    /* 全屏编辑器独立于通用弹窗尺寸：放宽，但始终留出移动端安全边距 */
    #sakura-fs-composer .sakura-box{width:min(760px,calc(100vw - 24px))!important;max-width:760px!important;height:min(calc(100dvh - 28px),760px)!important;max-height:calc(100dvh - 28px)!important;min-height:0!important;box-sizing:border-box!important;overflow:hidden!important}
    #sakura-fs-composer .sakura-body{min-height:0!important;overflow:hidden!important}
    #sakura-fs-composer .sakura-foot{flex-shrink:0!important;padding-bottom:max(12px,env(safe-area-inset-bottom))!important}
    @media(max-width:767px){#sakura-fs-composer .sakura-box{width:calc(100vw - 20px)!important;max-width:none!important;height:calc(100dvh - 24px)!important;max-height:calc(100dvh - 24px)!important}}

    .sakura-head{padding:15px 18px 12px!important;background:#fffafd!important;border-bottom:1px solid rgba(235,210,218,.85)!important}
    .sakura-modal-topbar{min-height:28px!important}
    .sakura-title-with-icon{gap:9px!important;color:#5d3044!important;font-size:15px!important;letter-spacing:.1px!important}
    .sakura-title-svg{width:18px!important;height:18px!important;color:#c66a86!important;filter:none!important}
    .sakura-sub{margin-top:4px!important;color:#a27b89!important;font-size:11px!important}
    .sakura-close-btn{width:30px!important;height:30px!important;border-radius:9px!important;background:transparent!important;color:#a88a95!important;box-shadow:none!important}
    .sakura-close-btn:hover{background:#fff0f4!important;color:#c65373!important}
    .sakura-body{padding:16px 18px!important;background:#fff!important}
    .sakura-foot{padding:11px 16px!important;background:#fffafd!important;border-top:1px solid rgba(235,210,218,.85)!important}
    .sakura-note-area{border:1px solid #ead6dd!important;border-radius:14px!important;background:#fff!important;color:#4a3540!important;box-shadow:inset 0 1px 2px rgba(66,30,45,.035)!important}
    .sakura-note-area:focus{border-color:#d6859b!important;box-shadow:0 0 0 3px rgba(214,133,155,.13)!important}
    .sakura-note-area::placeholder{color:#b7a0aa!important}
    .sakura-note-hint{color:#a9687e!important;font-weight:600!important}
    .sakura-btn{border:1px solid #e6cbd4!important;border-radius:10px!important;background:#fff!important;color:#805064!important;box-shadow:none!important;transition:background .15s ease,border-color .15s ease,color .15s ease,transform .12s ease!important}
    .sakura-btn:hover{background:#fff4f7!important;border-color:#d99aae!important;color:#a24d6c!important}
    .sakura-btn--main{background:#c95f7d!important;border-color:#c95f7d!important;color:#fff!important;box-shadow:0 3px 10px rgba(201,95,125,.18)!important}
    .sakura-btn--main:hover{background:#b9506e!important;border-color:#b9506e!important}
    /* V20 原生派：全屏入口改为 .island-button 原生方块，样式全部交还官方 */
    .sakura-fs-composer{align-items:center!important;padding:12px!important}
    #sakura-fs-composer .sakura-box{width:min(760px,calc(100vw - 24px))!important;max-width:760px!important;height:auto!important;max-height:calc(100dvh - 24px)!important;overflow:hidden!important}
    #sakura-fs-composer .sakura-body{max-height:calc(100dvh - 150px)!important;overflow-y:auto!important;min-height:0!important}
    #sakura-fs-composer .sakura-foot{flex-shrink:0!important}
    @media(max-width:767px){#sakura-fs-composer .sakura-box{width:calc(100vw - 20px)!important;max-width:none!important;max-height:calc(100dvh - 18px)!important}#sakura-fs-composer .sakura-body{max-height:calc(100dvh - 145px)!important}}
`;
     const cssLegacy = `
    :root{--p:#ff6b95!important;--pf:#e83a5e!important;--pc:#ffffff!important}
    ::selection{background:#ffccd5!important;color:#7a2245!important}
    ::-moz-selection{background:#ffccd5!important;color:#7a2245!important}
    ::-webkit-scrollbar{width:5px;height:5px}
    ::-webkit-scrollbar-track{background:transparent}
    ::-webkit-scrollbar-thumb{background:rgba(255,160,185,.45);border-radius:99px;transition:all .2s ease}
    ::-webkit-scrollbar-thumb:hover{background:rgba(255,107,149,.8)}
    @keyframes sakuraPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,107,149,.3),0 4px 14px rgba(255,107,149,.2)}50%{box-shadow:0 0 14px 4px rgba(255,107,149,.5),0 6px 20px rgba(255,71,126,.35)}}
    @keyframes pulseEmerald{0%,100%{box-shadow:0 0 0 0 rgba(16,185,129,.4)}50%{box-shadow:0 0 8px 3px rgba(16,185,129,.7)}}
    @keyframes noteBadgeGlow{0%,100%{transform:scale(1);box-shadow:0 0 4px rgba(255,77,121,.6)}50%{transform:scale(1.15);box-shadow:0 0 9px rgba(255,77,121,.95)}}
    @keyframes kenBurnsZoom{0%{transform:scale(1.05) translate3d(0, 0, 0)}100%{transform:scale(1.0) translate3d(0, 0, 0)}}
    @keyframes sakuraBoxIn{0%{opacity:0;transform:translateY(18px) scale(.95)}100%{opacity:1;transform:translateY(0) scale(1)}}
    @keyframes sakuraSpin{100%{transform:rotate(360deg)}}
    @keyframes sakuraBloom{0%{transform:rotate(0) scale(.8);opacity:.5}50%{transform:rotate(180deg) scale(1.1);opacity:1}100%{transform:rotate(360deg) scale(.8);opacity:.5}}
    .entry-transition{display:none!important}
    #custom-splash-screen{position:fixed;inset:0;z-index:999999;background:#ffeef3;overflow:hidden;cursor:pointer;opacity:0;transition:opacity .5s cubic-bezier(.22,1,.36,1), transform .6s cubic-bezier(.22,1,.36,1), filter .6s cubic-bezier(.22,1,.36,1);will-change:opacity, transform, filter;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
    #custom-splash-screen.splash-ready{opacity:1}
    #custom-splash-screen.splash-fade-out{opacity:0!important;transform:scale(1.03);filter:blur(8px);pointer-events:none}
    .splash-bg-layer{position:absolute;inset:-2%;background-position:center center;background-repeat:no-repeat;background-size:cover;will-change:transform;animation:kenBurnsZoom 3s cubic-bezier(.16,1,.3,1) forwards;filter:brightness(1.02) contrast(1.02);pointer-events:none;-webkit-user-drag:none;user-select:none}
    /* 底部极细进度条：3 秒走满，颜色跟随主题色 */
    .splash-progress{position:absolute;left:0;right:0;bottom:0;height:3px;z-index:10;background:rgba(255,255,255,.22);overflow:hidden;pointer-events:none}
    .splash-progress-bar{height:100%;width:0;background:var(--sakura-theme-color,#ff6b95);box-shadow:0 0 8px color-mix(in srgb,var(--sakura-theme-color,#ff6b95) 70%,transparent);border-radius:0 99px 99px 0;transition:width .1s linear}
    /* 🖥️ 桌面端适配：进度条加粗、鼠标指针、禁止拖图与选中 */
    @media (min-width: 768px) and (hover: hover) and (pointer: fine){
        .splash-progress{height:4px}
        #custom-splash-screen{cursor:pointer}
        #custom-splash-screen *{cursor:pointer}
        #custom-splash-screen img,#custom-splash-screen .splash-bg-layer{-webkit-user-drag:none;user-drag:none;pointer-events:none}
    }
    .sidebar-nav-button.bg-primary-50,.advanced-nav-trigger.bg-primary-50,.advanced-nav.is-open .advanced-nav-trigger{background:linear-gradient(135deg,rgba(255,248,250,.98),rgba(255,238,245,.9))!important;color:#d43b60!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.8),0 2px 8px rgba(255,107,149,.12)!important}
    .sidebar-nav-button:hover,.advanced-nav-trigger:hover{background:rgba(255,245,248,.75)!important;color:#ff4d79!important}
    .sidebar-nav-button.bg-primary-50::before,.advanced-nav.is-open .advanced-nav-trigger::before{content:''!important;display:block!important;position:absolute!important;left:.35rem!important;top:50%!important;width:3.5px!important;height:1.25rem!important;border-radius:999px!important;background:linear-gradient(180deg,#ff8da8,#ff4d79)!important;transform:translateY(-50%)!important;box-shadow:0 0 8px rgba(255,77,121,.6)!important}
    .advanced-nav-chevron{color:#ff6b95!important;transition:transform .28s cubic-bezier(.22,1,.36,1)!important}
    .advanced-nav-item.bg-primary-50{background:rgba(255,235,242,.75)!important;color:#b03a68!important;border-radius:12px!important}
    .item-action-button{color:#c79cab!important;border-radius:0.6rem!important;transition:all .18s cubic-bezier(.34,1.56,.64,1)!important}
    .item-action-button--edit:hover,.item-action-button--edit:active{background:rgba(255,240,245,.95)!important;color:#ff4d80!important;transform:scale(1.1)!important;box-shadow:0 2px 8px rgba(255,107,149,.2)!important}
    .item-action-button--delete:hover,.item-action-button--delete:active{background:#fff0f2!important;color:#e83a5e!important;transform:scale(1.1)!important}

    /* 🌸 角色卡组左右翻页箭头：完全跟随玩家全局自定义主题色，中间进入按钮保持原生动态取色 */
    .character-deck__arrow {
        color: var(--sakura-theme-color, #ff6b95) !important;
        transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease !important;
    }
    .character-deck__arrow svg {
        color: var(--sakura-theme-color, #ff6b95) !important;
        stroke: currentColor !important;
    }
    .character-deck__arrow:hover:not(:disabled), .character-deck__arrow:active:not(:disabled) {
        color: var(--sakura-theme-color, #ff6b95) !important;
        border-color: var(--sakura-theme-color, #ff6b95) !important;
        box-shadow: 0 0 12px rgba(255, 107, 149, 0.35) !important;
        transform: translateY(-2px) scale(1.05) !important;
    }

    .sakura-native-split-card{border:1.5px solid rgba(255,204,215,.8)!important;transition:border-color .25s ease, box-shadow .25s ease!important}
    .sakura-native-split-card.is-expanded{border-color:#ff9ebb!important;box-shadow:0 6px 20px rgba(255,107,149,.15)!important}

    .sakura-split-collapse-btn:hover{background:rgba(255,245,248,.6)!important}
    .sakura-provider-dropdown{position:relative}
    .sakura-provider-menu{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:50;max-height:230px;overflow-y:auto;background:rgba(255,255,255,.98);backdrop-filter:blur(20px);border:1.5px solid #ffccd5;border-radius:16px;box-shadow:0 16px 36px -8px rgba(255,77,121,.32);padding:6px;display:flex;flex-direction:column;gap:3px}
    .sakura-provider-option{display:flex;align-items:center;padding:8px 10px;border-radius:11px;cursor:pointer;transition:all .15s ease;gap:9px}
    .sakura-provider-option:hover{background:#fff0f5;transform:translateX(2px)}
    .sakura-provider-option.is-selected{background:linear-gradient(135deg,#ffe8f0,#ffdce6)}
    .sakura-provider-icon-box{width:26px;height:26px;border-radius:8px;background:#fff0f5;border:1px solid #ffd0dc;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;font-size:12px}
    .sakura-provider-icon{width:18px;height:18px;object-fit:contain}
    .sakura-provider-option-detail{flex:1;min-width:0;display:flex;flex-direction:column}
    .sakura-provider-opt-name{font-size:12.5px;font-weight:700;color:#5c2438}
    .sakura-provider-opt-url{font-size:10.5px;color:#a86a80;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sakura-provider-opt-check{font-size:13px;font-weight:800;color:#ff4d79}
    .sakura-status-indicator{width:8.5px;height:8.5px;border-radius:50%;background:#d1d5db;transition:all .3s ease;flex-shrink:0}
    .sakura-status-indicator.is-active{background:#10b981;animation:pulseEmerald 2.5s infinite ease-in-out}
    .sakura-status-indicator.is-checking{background:#f59e0b;animation:noteBadgeGlow 1.2s infinite ease-in-out}
    .sakura-status-indicator.is-error{background:#ef4444;box-shadow:0 0 6px rgba(239,68,68,.7)}
    .sakura-ping-latency{color:#059669;font-weight:800;margin-left:4px;background:#ecfdf5;padding:1px 5px;border-radius:4px;border:1px solid #a7f3d0}
    .sakura-ping-btn{display:inline-flex;align-items:center;gap:4px;padding:3.5px 10px;font-size:11px;font-weight:700;border-radius:999px;border:1px solid #ffb3c6;background:#ffffff;color:#ff4d80;cursor:pointer;transition:all .15s cubic-bezier(.34,1.56,.64,1)}
    .sakura-ping-btn:hover{background:#fff0f5;border-color:#ff7597;transform:scale(1.04)}
    .sakura-ping-btn:active{transform:scale(0.94)}
    .sakura-ping-btn:disabled{opacity:.5;cursor:not-allowed}
    .sakura-mask{position:fixed;inset:0;z-index:1000000;background:rgba(70,20,40,.36);backdrop-filter:blur(12px) saturate(140%);-webkit-backdrop-filter:blur(12px) saturate(140%);display:flex;align-items:center;justify-content:center;padding:12px}
    .sakura-box{width:100%;max-width:440px;max-height:86vh;display:flex;flex-direction:column;background:rgba(255,255,255,.98);border:1.5px solid rgba(255,204,215,.95);border-radius:26px;box-shadow:inset 0 1px 0 rgba(255,255,255,.95),0 28px 72px -20px rgba(255,77,121,.48);overflow:hidden;animation:sakuraBoxIn .3s cubic-bezier(.16,1,.3,1)}
    #sakura-janitor-mask .sakura-box{max-width:520px}
    #sakura-janitor-mask .sakura-body{padding:12px 14px}
    .sakura-box--wide{width:95vw;max-width:520px;height:86vh}
    @media (min-width: 768px){.sakura-box{max-width:480px}.sakura-box--wide{max-width:640px;height:82vh}.sakura-note-area{min-height:52vh!important}}

    /* 🚀 移动端性能优化：毛玻璃降级 + transition 精简 */
    @media (max-width: 767px) {
        .sakura-mask{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:rgba(70,20,40,.5)!important}
        .sakura-provider-menu{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:rgba(255,255,255,1)!important}
        .toast-item,.toast-stack > div{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;background:rgba(255,255,255,.98)!important}
        .splash-progress{background:rgba(255,255,255,.28)!important}
        .splash-progress-bar{box-shadow:none!important}
        /* V20 原生派：移除对 2.0.0 .island-input 的粉色渐变强加，输入区背景交还官方玻璃岛 */
        .sakura-model-row{transition:transform .12s ease,border-color .12s ease!important}
        .sakura-provider-option{transition:background .12s ease!important}
        /* 🚀 移动端官方组件毛玻璃降级 */
        .navbar,.app-sidebar,.app-navigation-panel,.app-nav-trigger--embedded,.bg-white\/80{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
        .backdrop-blur-md,.backdrop-blur-sm,.backdrop-blur{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}
        /* 🚀 移动端 box-shadow 精简（减少 GPU 合成层） */
        .msg-bubble-glass{box-shadow:0 1px 3px rgba(0,0,0,.06)!important}
        .toast-item,.toast-stack > div{box-shadow:0 2px 8px rgba(0,0,0,.08)!important}
        /* 🚀 移动端 transition 精简
           ⚠️ v19.5.4 性能修复：移除 *{transition-duration:.12s!important} 通配符。
           原通配符会把官方浮空导航面板的 0.38s cubic-bezier 入场动画砍成 0.12s，
           造成开合"顿挫感"；同时强制全站每个元素计算过渡时长，是移动端卡顿主源。
           改为只对已知重组件做精准精简，导航动画完整保留。 */
        .sakura-box,.sakura-mask,.sakura-provider-menu,.toast-item,.toast-stack > div,.sakura-model-row,.sakura-provider-option{transition-duration:.12s!important}
    }
    .sakura-head{padding:16px 18px 11px;border-bottom:1px solid rgba(255,204,213,.75);background:linear-gradient(135deg,rgba(255,248,251,.98),rgba(255,238,245,.95))}
    .sakura-modal-topbar{display:flex;justify-content:space-between;align-items:center}
    .sakura-title-with-icon{display:flex;align-items:center;gap:6px;font-size:16px;font-weight:800;color:#c2255c;letter-spacing:.2px}
    .sakura-title-svg{width:17px;height:17px;color:#ff4d79;filter:drop-shadow(0 0 4px rgba(255,77,121,.4))}
    .sakura-close-btn{background:transparent;border:none;color:#b07a8c;font-size:16px;cursor:pointer;padding:3px 7px;border-radius:8px;transition:all .15s ease}
    .sakura-close-btn:hover{color:#e83a5e;background:#ffe8f0}
    .sakura-sub{margin-top:4px;font-size:11.5px;color:#b07a8c}
    .sakura-searchbar{margin-top:11px}
    .sakura-input{width:100%;padding:9px 14px;font-size:13px;border-radius:13px;border:1.5px solid #ffb3c6;background:#ffffff;color:#4a2030;outline:none;box-sizing:border-box;transition:all .18s ease}
    .sakura-input:focus{border-color:#ff6b95;box-shadow:0 0 0 3.5px rgba(255,107,149,.22)}
    .sakura-tag-bar{display:flex;flex-wrap:nowrap;overflow-x:auto;gap:6px;padding-top:10px;padding-bottom:3px}
    .sakura-tag-btn{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;font-size:11px;font-weight:700;border-radius:999px;border:1.5px solid #ffd0dc;background:#ffffff;color:#8a4058;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all .15s cubic-bezier(.34,1.56,.64,1)}
    .sakura-tag-btn:hover{background:#fff0f5;border-color:#ff9ebb}
    .sakura-tag-btn.is-active{background:linear-gradient(135deg,#ff8da8,#ff4d79);color:#ffffff;border-color:#ff4d79;box-shadow:0 2px 8px rgba(255,77,121,.35)}
    .sakura-tag-count{font-size:10px;opacity:.85;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
    .sakura-body{flex:1;overflow-y:auto;padding:10px 13px;display:flex;flex-direction:column;gap:7.5px}
    .sakura-empty{padding:32px 12px;text-align:center;font-size:12.5px;color:#b07a8c}
    .sakura-model-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px 16px;gap:12px;font-size:12.5px;color:#b07a8c}
    .sakura-bloom-spinner{position:relative;width:30px;height:30px;animation:sakuraBloom 2.2s infinite ease-in-out}
    .sakura-bloom-spinner .petal{position:absolute;width:12px;height:12px;border-radius:12px 0 12px 0;background:linear-gradient(135deg,#ff9ebb,#ff4d79);opacity:.85}
    .sakura-bloom-spinner .p1{top:0;left:0}.sakura-bloom-spinner .p2{top:0;right:0;transform:rotate(90deg)}.sakura-bloom-spinner .p3{bottom:0;right:0;transform:rotate(180deg)}.sakura-bloom-spinner .p4{bottom:0;left:0;transform:rotate(270deg)}
    .sakura-model-row{position:relative;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 10px 15px;border-radius:14px;background:rgba(255,250,252,.95);border:1.5px solid rgba(255,204,213,.7);cursor:pointer;overflow:hidden;min-height:46px;box-sizing:border-box;transition:all .18s cubic-bezier(.22,1,.36,1)}
    .sakura-model-indicator-bar{position:absolute;left:0;top:0;bottom:0;width:3.5px;background:linear-gradient(180deg,#ff8da8,#ff4d79);opacity:0;transform:scaleY(.3);transition:all .2s ease}
    .sakura-model-row:hover,.sakura-model-row:active{background:rgba(255,236,243,.98);border-color:#ff9ebb;transform:translateX(3px)}
    .sakura-model-row:hover .sakura-model-indicator-bar,.sakura-model-row:active .sakura-model-indicator-bar{opacity:1;transform:scaleY(1)}
    .sakura-model-row.is-selected{background:linear-gradient(135deg,rgba(255,232,240,.96),rgba(255,218,228,.92));border-color:#ff6b95;font-weight:700}
    .sakura-model-row.is-selected .sakura-model-indicator-bar{opacity:1;transform:scaleY(1);box-shadow:0 0 6px rgba(255,77,121,.7)}
    .sakura-model-name-box{flex:1;min-width:0;display:flex;align-items:center}
    .sakura-model-title-wrap{display:inline-flex;flex-wrap:wrap;align-items:center;gap:5px;line-height:1.45;word-break:break-all}
    .sakura-model-prefix-tag{display:inline-flex;align-items:center;padding:1.5px 6px;font-size:10px;font-weight:800;border-radius:6px;background:#ffe4ec;color:#c2255c;border:1px solid #ffb8cd;letter-spacing:.2px;white-space:nowrap;line-height:1.2}
    .sakura-model-core-name{font-size:12.5px;color:#6b213f;line-height:1.45;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;letter-spacing:-0.1px}
    .sakura-model-check{font-size:14px;color:#ff4d79;font-weight:800;margin-left:6px;flex-shrink:0}
/* v19.5.5 显示修复①：官方 1.9.6 模型选择器选中态为 bg-primary-50 浅底 + text-primary-800 深字，
   插件原先把所有 text-primary-* 一刀切映射成亮粉 #ff6b95，浅粉底+亮粉字对比度仅约 2:1，模型名直接糊掉。
   这里让深阶 primary 文字回归深色，并精准保护官方模型列表/模型按钮的文字可读性。 */
[class*="text-primary-700"],[class*="text-primary-800"],[class*="text-primary-900"]{color:#5c2040!important}
.model-selector-list button[aria-pressed="true"],.model-selector-list button[aria-pressed="true"] span,.model-selector-list [class*="font-mono"],.model-selector-list [class*="text-primary-"]{color:#7a1f45!important}
.settings-model-button,.settings-model-button *{color:#5c2040!important}
.model-setting-row .font-mono,.model-setting-row [class*="text-gray-"]{color:#3f3f46!important}
    .sakura-note-area{flex:1;width:100%;min-height:44vh;resize:none;padding:13px 15px;font-family:inherit;font-size:13.5px;line-height:1.75;color:#5c3a4d;background:rgba(255,250,252,.95);border:1.5px solid #ffccd5;border-radius:18px;outline:none;box-sizing:border-box;transition:border-color .18s ease,box-shadow .18s ease;-webkit-tap-highlight-color:transparent}
    .sakura-note-area:focus{border-color:#ff6b95;box-shadow:0 0 0 3.5px rgba(255,107,149,.22);background:#ffffff}
    .sakura-note-area::placeholder{color:rgba(190,130,155,.72);line-height:1.7}
    .sakura-note-hint{flex:1;text-align:center;font-size:11.5px;font-weight:700;color:#ff6b95;opacity:0;transform:translateY(4px);transition:all .22s ease;pointer-events:none}
    .sakura-note-hint.is-on{opacity:1;transform:translateY(0)}
    .sakura-btn{flex:none;padding:7px 15px;font-size:12px;font-weight:700;border-radius:12px;border:1.5px solid #ffccd5;background:#ffffff;color:#d43b60;cursor:pointer;transition:all .15s cubic-bezier(.34,1.56,.64,1);-webkit-tap-highlight-color:transparent}
    .sakura-btn:active{transform:scale(.92)}
    .sakura-btn--quiet{background:rgba(255,250,252,.9)!important;color:#b07a8c!important;border-color:rgba(255,204,213,.75)!important}
    .sakura-btn--main{background:linear-gradient(135deg,#ff527b 0%,#e0245e 100%);border-color:#ff2a60;color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,.22);padding:7px 20px;box-shadow:0 3px 10px rgba(255,42,96,.3)}
    .sakura-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid rgba(255,204,213,.75);background:rgba(255,250,252,.95)}
    [class*="from-teal-"],[class*="to-emerald-"],[class*="from-emerald-"]{background-image:linear-gradient(135deg,#ff9ebb 0%,#ff6b95 100%)!important}
    [class*="text-teal-"],[class*="text-emerald-"]{color:#ff4d79!important}
    [class*="bg-teal-50"],[class*="bg-emerald-50"]{background:linear-gradient(135deg,rgba(255,240,245,.95),rgba(255,225,235,.88))!important;color:#d43b60!important}
    [class*="hover:border-teal-"],[class*="border-teal-"]{border-color:#ffb3c6!important}
    .toast-item,.toast-stack > div{min-width:300px!important;padding:12px 24px!important;background:rgba(255,255,255,.94)!important;backdrop-filter:blur(16px) saturate(1.4)!important;-webkit-backdrop-filter:blur(16px) saturate(1.4)!important;border:1px solid #ffccd5!important;border-radius:9999px!important;box-shadow:0 8px 24px rgba(0,0,0,.06),0 2px 8px rgba(255,107,149,.15)!important;color:#374151!important;white-space:nowrap!important}.toast-item svg{color:#ff6b95!important;filter:drop-shadow(0 0 4px rgba(255,107,149,.4))!important}.toast-item.bg-red-50 svg{color:#e83a5e!important}.typing-indicator{background:transparent!important;padding:4px 6px!important}.typing-indicator span{background:linear-gradient(135deg,#ff9ebb 0%,#ff6b95 100%)!important;box-shadow:0 0 6px rgba(255,107,149,.6)!important;width:8px!important;height:8px!important}.typing-timer-badge{background:rgba(255,245,248,.75)!important;border-color:rgba(255,182,193,.5)!important;color:#9e4668!important}.cot-ui,.native-thinking-card{background:rgba(255,255,255,.9)!important;border:1.5px solid #ffccd5!important;border-radius:18px!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.9)!important}.cot-ui.is-live,.native-thinking-card.is-live{border-color:#ff6b95!important;animation:sakuraPulse 2.5s infinite ease-in-out!important}.cot-ui.is-open,.native-thinking-card.is-open{border-color:#ffb3c6!important;box-shadow:0 4px 14px rgba(255,107,149,.15)!important}.cot-ui.is-open .cot-header{background:rgba(255,240,245,.8)!important;color:#ff6b95!important}.cot-header:hover{background:rgba(255,240,245,.6)!important;color:#ff6b95!important}.thinking-summary-dots,.live-dots,.ui-build-dots{color:#ff6b95!important}.thinking-summary-dots i,.live-dots i,.ui-build-dots i{background:#ff6b95!important;box-shadow:0 0 4px rgba(255,107,149,.6)!important}.thinking-summary-bulb{color:#ff7597!important}.settings-create-button,button.settings-create-button{background:linear-gradient(135deg,#ff9ebb 0%,#ff6b95 100%)!important;border:1px solid #ffccd5!important;color:#ffffff!important;box-shadow:0 4px 12px rgba(255,107,149,.35)!important;border-radius:0.75rem!important;transition:all .15s ease!important}.settings-create-button:active{transform:scale(0.92)!important;background:linear-gradient(135deg,#ff7597 0%,#e83a5e 100%)!important}[class~="bg-primary-500"],[class~="bg-primary-600"],[class~="bg-primary-700"],[class~="bg-blue-500"],[class~="bg-blue-600"],[class~="bg-indigo-500"],[class~="bg-indigo-600"],[class~="bg-violet-500"],[class~="bg-violet-600"],[class~="from-primary-400"],[class~="from-primary-500"],[class~="from-primary-600"],[class~="to-primary-400"],[class~="to-primary-500"],[class~="to-primary-600"],[class~="from-blue-400"],[class~="from-blue-500"],[class~="from-indigo-400"],[class~="from-indigo-500"],[class~="to-indigo-400"],[class~="to-indigo-500"],[class~="to-violet-400"],[class~="to-violet-500"],[class~="from-purple-400"],[class~="from-purple-500"],.modal-primary-button{background:linear-gradient(135deg,#ff9ebb 0%,#ff6b95 100%)!important;border-color:#ff6b95!important;color:#ffffff!important}[class~="bg-primary-50"],[class~="bg-primary-100"],[class~="bg-blue-50"],[class~="bg-blue-100"],[class~="bg-indigo-50"],[class~="bg-indigo-100"],.sidebar-nav-button.bg-primary-50{background:rgba(255,240,245,.9)!important;border-color:rgba(255,182,193,.6)!important;box-shadow:inset 0 0 0 1px rgba(255,107,149,.2)!important}div[data-role="user"] .msg-bubble-glass{background:linear-gradient(135deg,rgba(255,242,246,.96),rgba(255,230,238,.92))!important;border:1.5px solid #ffb3c6!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.9),0 4px 14px rgba(255,107,149,.15)!important;color:#4a2030!important}div[data-role="user"] .markdown-body{color:inherit!important}[class~="text-primary-400"],[class~="text-primary-500"],[class~="text-primary-600"],[class~="text-primary-700"],[class~="text-primary-800"],[class~="text-primary-900"],[class~="text-blue-400"],[class~="text-blue-500"],[class~="text-blue-600"],[class~="text-indigo-400"],[class~="text-indigo-500"],[class~="text-indigo-600"],[class~="text-violet-400"],[class~="text-violet-500"],[class~="text-violet-600"],.segmented-switch__option.is-active,.thinking-summary-dots,.settings-help-trigger:hover,.settings-help-trigger.is-open{color:#ff6b95!important}[class~="border-primary-200"],[class~="border-primary-300"],[class~="border-primary-400"],[class~="border-primary-500"],[class~="border-blue-300"],[class~="border-blue-400"],[class~="border-blue-500"],[class~="border-indigo-300"],[class~="border-indigo-400"],[class~="border-indigo-500"],.settings-help-trigger:hover{border-color:#ffb3c6!important}[class~="ring-primary-100"],[class~="ring-primary-200"],[class~="ring-primary-300"],[class~="ring-primary-400"],[class~="ring-primary-500"],[class~="ring-blue-300"],[class~="ring-blue-400"],[class~="ring-indigo-300"],[class~="ring-indigo-400"],.settings-model-button:hover,.settings-model-button:focus-visible{--tw-ring-color:rgba(255,107,149,.35)!important;box-shadow:0 0 0 3px rgba(255,107,149,.25)!important;border-color:#ffb3c6!important}.sidebar-nav-button.bg-primary-50::before{background:#ff6b95!important}input[type="checkbox"]:checked,input[type="radio"]:checked{background-color:#ff6b95!important;border-color:#ff6b95!important}.toggle:checked,[class*="toggle-primary"]:checked,[class*="toggle-accent"]:checked{background-color:#ff6b95!important;border-color:#ff6b95!important}.settings-toggle-input:checked + .settings-toggle,.settings-toggle-input:checked + .settings-toggle--indigo,.settings-toggle-input:checked + .settings-toggle--solid,.settings-toggle-input:checked + .settings-toggle--compact{background:linear-gradient(135deg,#ff9ebb 0%,#ff6b95 100%)!important;border-color:#ff6b95!important}div.w-7.h-7.rounded-full.bg-blue-600,div.w-9.h-9.rounded-full.bg-blue-600,div[class*="rounded-full"][class*="bg-blue-"],div.w-9.h-9.rounded-full div{background:linear-gradient(135deg,#ff9ebb,#ff6b95)!important;color:#fff!important}div.h-3.rounded-full.bg-gray-200 div.bg-primary-500{background:linear-gradient(90deg,#ffb3c6,#ff6b95)!important;box-shadow:0 0 8px rgba(255,107,149,.5)!important}span.w-1.h-5.rounded-full{background:linear-gradient(180deg,#ff9ebb,#ff6b95)!important;box-shadow:0 0 4px rgba(255,107,149,.6)!important}input[type="range"],input[type="range"].compact-range{accent-color:#ff6b95!important}input[type="range"]::-webkit-slider-runnable-track,input[type="range"].compact-range::-webkit-slider-runnable-track{background:rgba(255,200,215,.6)!important;height:6px!important;border-radius:3px!important}input[type="range"]::-webkit-slider-thumb,input[type="range"].compact-range::-webkit-slider-thumb{background:#ff6b95!important;border:2px solid #ffffff!important;box-shadow:0 2px 6px rgba(255,107,149,.45)!important;margin-top:-5px!important;border-radius:50%!important}/* ===== V20 原生派：输入区完全交还官方 .input-island 玻璃岛体系 ===== 删除旧版对 textarea.chat-input-scrollbar 的粉色圆角强制覆盖、button[title*=发送]的圆形+猫爪伪元素、伪造 placeholder、中止按钮粉圆 —— 均基于 1.9.8 圆形按钮，2.0.0 已改为方形 island，保留会造成混血与暗夜割裂。官方 theme.css 变量体系自会渲染。 */
    div[class*="w-\\[250px\\]"] textarea,div[class*="w-\\[320px\\]"] textarea{background:rgba(255,245,248,.8)!important;border-color:#ffb3c6!important;color:#5c3a4d!important}
    div[class*="w-\\[250px\\]"] textarea:focus,div[class*="w-\\[320px\\]"] textarea:focus{border-color:#ff6b95!important;box-shadow:0 0 0 2px rgba(255,107,149,.25)!important}.story-route-map-panel{border-color:#ffccd5!important}.story-route-canvas{background-image:radial-gradient(circle,rgba(255,107,149,.25) 1px,transparent 1px)!important;background-color:#fffbfc!important}.story-route-node{background:rgba(255,255,255,.95)!important;border:2px solid #ffccd5!important;border-radius:18px!important;backdrop-filter:blur(8px)!important;transition:all .25s ease!important}.story-route-node.is-current,.story-route-node.is-selected{border-color:#ff6b95!important;animation:sakuraPulse 2.5s infinite ease-in-out!important}.story-route-node-checkpoint{background:#ff6b95!important;border:2px solid #ffffff!important;box-shadow:0 0 8px rgba(255,107,149,.8)!important}.story-route-node strong{color:#5c3245!important}.story-route-node small{color:#a8627d!important}.story-route-node-current{background:linear-gradient(135deg,#ff9ebb,#ff6b95)!important;color:#fff!important;border-radius:10px!important}.story-route-node-type{background:rgba(255,215,225,.9)!important;color:#c04870!important;border-radius:8px!important}.story-route-link{stroke:#ffd0dc!important;stroke-width:3px!important}.story-route-link.is-active,.story-route-link.is-selected{stroke:#ff6b95!important;filter:drop-shadow(0 0 4px rgba(255,107,149,.6))!important}.story-route-enter-button:not(:disabled){background:linear-gradient(135deg,#ff9ebb,#ff6b95)!important;border-color:#ff6b95!important;color:#fff!important}.story-route-enter-button:disabled{background:rgba(255,230,238,.6)!important;border-color:#ffccd5!important;color:rgba(180,100,125,.4)!important}.story-route-edit-button{border-color:#ffb3c6!important;color:#b03a68!important}.story-route-delete-button{border-color:#ff99aa!important;color:#d43b60!important}
    /* ===== V20.0.2 修复③：消息编辑框「文字与背景融合」（浏览器暗色·网站暗色·日光全兼容） =====
       官方编辑框是 textarea.custom-scrollbar（外层 .message-edit-group / .animate-fade-in），
       靠 Tailwind 固定类 bg-white/50（半透明白底）+ text-gray-700（深字）渲染。
       页面此前未声明 color-scheme，一旦浏览器/系统开暗色，就被强制暗化/叠暗半透明白底，
       深字压暗底 → 糊成一片。双管齐下：
       ① :root 声明 color-scheme:light，明确告知浏览器本页自带配色、勿强制反转；网站暗色/夜间则声明 dark。
       ② 编辑框锁死不透明底 + 明确字色（含 -webkit-text-fill-color 防引擎覆盖填充），四态各一套。 */
    :root{color-scheme:light}
    :root[data-app-theme="dark"]{color-scheme:dark}
    .message-edit-group textarea,.animate-fade-in textarea,textarea.custom-scrollbar,div:has(> button[title="编辑"]) textarea{background:#ffffff!important;border:1.5px solid #ffccd5!important;color:#374151!important;-webkit-text-fill-color:#374151!important;caret-color:#ff6b95!important}
    .message-edit-group textarea::placeholder,.animate-fade-in textarea::placeholder,textarea.custom-scrollbar::placeholder{color:#9aa0a6!important;-webkit-text-fill-color:#9aa0a6!important}
    :root[data-app-theme="dark"] .message-edit-group textarea,:root[data-app-theme="dark"] .animate-fade-in textarea,:root[data-app-theme="dark"] textarea.custom-scrollbar,.dark .message-edit-group textarea,.dark .animate-fade-in textarea,.dark textarea.custom-scrollbar{background:#39393d!important;border-color:rgba(255,255,255,.16)!important;color:#ececec!important;-webkit-text-fill-color:#ececec!important;caret-color:#ff8fae!important}
    @media (prefers-color-scheme: dark){:root:not([data-app-theme="light"]) .message-edit-group textarea,:root:not([data-app-theme="light"]) .animate-fade-in textarea,:root:not([data-app-theme="light"]) textarea.custom-scrollbar{background:#39393d!important;border-color:rgba(255,255,255,.16)!important;color:#ececec!important;-webkit-text-fill-color:#ececec!important;caret-color:#ff8fae!important}}
    :root[data-sakura-night="1"] .message-edit-group textarea,:root[data-sakura-night="1"] .animate-fade-in textarea,:root[data-sakura-night="1"] textarea.custom-scrollbar,:root[data-sakura-night="1"] div:has(> button[title="编辑"]) textarea{background:#39393d!important;border-color:rgba(255,255,255,.16)!important;color:#ececec!important;-webkit-text-fill-color:#ececec!important;caret-color:#ff8fae!important}
    .animate-fade-in button.bg-primary-500,.animate-fade-in button[class*="bg-primary-"],div.flex.justify-end.space-x-2.mt-3 > button.bg-primary-500{background:linear-gradient(135deg,#ff3366 0%,#e6004c 100%)!important;border:1px solid #ff0044!important;color:#ffffff!important;font-weight:800!important;letter-spacing:.05em!important;text-shadow:0 1px 2px rgba(0,0,0,.35)!important;box-shadow:0 4px 12px rgba(255,0,68,.35)!important}
    .animate-fade-in button.bg-primary-500:active{transform:scale(.95)!important;background:#cc0044!important}
    /* V20 原生派：旧绝对定位圆形全屏按钮样式已移除（会将按钮推出屏幕外） */

    /* ================= 🩹 v19.5.9 显示修复层②：官方 1.9.6 新 UI 文字可读性 + 自定义主题全量适配 =================
       根因：插件历史规则里的 [class*="..."] 是子串匹配，会把 hover:bg-primary-50/40 这类
       变体 class 一并命中，给官方新版「模型选择器」列表硬塞 color:#fff!important，
       于是浅底 + 白字，模型名根本看不清。A 段已收窄宽匹配；这里再做一层高特异性精确反制。
       配色统一走樱花粉家族 hex，交给主题引擎重映射，玩家换任何自定义主题都会跟着变，
       绝不写死在粉色上。 */
    /* 模型选择器：未选中项 —— 白底深字 */
    .model-selector-list button:not([aria-pressed="true"]){background:#ffffff!important;border-color:#e8d8de!important;color:#3f3f46!important}
    .model-selector-list button:not([aria-pressed="true"]) span{color:#3f3f46!important;opacity:1!important}
    .model-selector-list button:not([aria-pressed="true"]):hover{background:#fff2f7!important;border-color:#ffb3c6!important}
    .model-selector-list button:not([aria-pressed="true"]):hover span{color:#6f2040!important}
    /* 模型选择器：选中项 —— 浅粉底 + 深粉字 */
    .model-selector-list button[aria-pressed="true"]{background:#ffe9f1!important;border-color:#ff8fb0!important;color:#7e2549!important}
    .model-selector-list button[aria-pressed="true"] span{color:#7e2549!important;opacity:1!important}
    .model-selector-list button[aria-pressed="true"] svg{color:#e8487a!important}
    /* 模型选择器：头部标题 / 空态文案 */
    .model-selector-heading h3,.model-selector-heading .text-gray-900{color:#4a323c!important}
    .model-selector-heading button{color:#6b5560!important}
    .model-selector-list .text-gray-500{color:#8a7078!important}
    /* 槽位选择按钮（聊天模型槽位 1/2/3） */
    .model-selector-heading + div button{color:#3f3f46!important}
    /* 官方设置页：模型按钮 / 模型行 */
    .settings-model-button,.settings-model-button *{color:#4a323c!important}
    .settings-model-button svg{color:#c2255c!important}
    .model-setting-row .font-mono,.model-setting-row [class*="text-gray-"]{color:#3f3f46!important}

    `;
    const styleEl = document.createElement('style');


    function syncSakuraNight() {
        try {
            const dark = document.documentElement.getAttribute('data-app-theme') === 'dark';
            document.documentElement.setAttribute('data-sakura-night', dark ? '1' : '0');
        } catch (_) {}
    }
    // View Transition 期间 attribute 变更可能落在快照帧里，做多重校准兜底。
    function bumpSakuraNight() {
        syncSakuraNight();
        try { [0, 120, 300, 620].forEach(function (d) { setTimeout(syncSakuraNight, d); }); } catch (_) {}
        try { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(syncSakuraNight); } catch (_) {}
    }
    bumpSakuraNight();
    window.addEventListener('rphub-theme-change', bumpSakuraNight);
    try {
        new MutationObserver(bumpSakuraNight).observe(document.documentElement, {
            attributes: true, attributeFilter: ['data-app-theme']
        });
    } catch (_) {}
    // ⚠️ 官方 theme.js 用 Object.freeze 冻结了 window.RPHubTheme，严禁覆写 set()。
    // 旧版 hook 在 'use strict' 下抛 TypeError: Cannot assign to read only property 'set'，
    // 直接中断整个 IIFE（插件全废）。这里彻底移除，改为纯监听：
    //   · rphub-theme-change 事件（官方每次 apply() 都派发）
    //   · MutationObserver 监听 documentElement[data-app-theme]
    //   · 多重 setTimeout / rAF 校准兜底

    const cssPolish = `
    /* v15.7 猫娘风最终视觉层：只做样式收口，不改业务结构 */
    :root{--sakura-ink:#553746;--sakura-muted:#a8798c;--sakura-pink:#e86f95;--sakura-pink-deep:#c85278;--sakura-blush:#fff1f5;--sakura-line:#efd2dc}
    body{color:var(--sakura-ink)!important}
    /* 官方字体扩展样式已移除 */
    body.rphub-clean-view .sakura-clean-view-btn{z-index:20!important;background:rgba(74,35,51,.45)!important;border-radius:999px!important;color:rgba(255,220,231,.9)!important}
    body.rphub-clean-view .sakura-clean-view-btn[aria-pressed="true"]{background:rgba(74,35,51,.52)!important;box-shadow:none!important}
    /* v16.3：樱花猫系细节收口，不覆盖角色卡背景 */
    .app-main{--sakura-soft-pink:#fff4f7;--sakura-border:#f2cbd7;--sakura-deep:#c85d7d}
    .app-main .message-action-bar{border-top:1px solid rgba(242,203,215,.32)!important;background:inherit!important;border-radius:0 0 12px 12px!important}
    .app-main .message-action-button{color:inherit!important;border-radius:7px!important;transition:background-color .16s ease,color .16s ease,box-shadow .16s ease!important}
    .app-main .message-action-button:hover,.app-main .message-action-button:focus-visible{background:rgba(255,234,241,.42)!important;color:#c44f73!important;outline:none!important;box-shadow:0 2px 8px rgba(200,93,125,.08)!important}
    .app-main .message-action-button:active{background:rgba(255,220,231,.52)!important}
    /* v18.5：仅修正日间模式消息操作图标颜色；不改工具栏结构、圆角、背景或交互 */
    @media (prefers-color-scheme: light){
        .app-main .message-action-button{color:rgba(75,85,99,.78)!important}
        .app-main .message-action-button:hover,.app-main .message-action-button:focus-visible{color:#c44f73!important}
        .app-main .message-action-button[aria-label*="删除"]:hover,.app-main .message-action-button[title*="删除"]:hover{color:#dc2626!important}
    }
    .app-main .msg-bubble-glass{border-color:rgba(242,203,215,.72)!important;box-shadow:0 5px 18px rgba(183,99,128,.08),inset 0 1px 0 rgba(255,255,255,.72)!important}
    .app-main div[data-role="user"] .msg-bubble-glass{border-color:rgba(232,156,180,.72)!important;box-shadow:0 5px 18px rgba(205,91,125,.12),inset 0 1px 0 rgba(255,255,255,.78)!important}
    .app-main .markdown-body a{color:#c85d7d!important;text-decoration-color:rgba(200,93,125,.35)!important;text-underline-offset:3px!important}
    .app-main .markdown-body blockquote{border-left:3px solid #f0a8bd!important;background:rgba(255,244,247,.68)!important;border-radius:0 10px 10px 0!important;padding:7px 11px!important}
    .app-main .markdown-body code{border:1px solid rgba(240,168,189,.42)!important;border-radius:6px!important;background:#fff3f7!important;color:#a84e6d!important}
    .app-main .markdown-body pre{border:1px solid rgba(240,168,189,.42)!important;border-radius:10px!important;box-shadow:0 4px 12px rgba(183,99,128,.08)!important}
    .app-main ::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#f7b6c9,#d87898)!important;border-color:rgba(255,255,255,.8)!important}
    .sakura-clean-view-btn{transition:color .12s ease,background-color .12s ease!important;transform:none!important;will-change:auto!important}
    /* v16.3 全站细节：侧栏、设置、弹窗、控件统一樱花粉质感 */
    .app-sidebar{border-right:1px solid rgba(239,191,208,.72)!important;box-shadow:10px 0 28px rgba(183,99,128,.06)!important}
    .sidebar-nav-button{border-radius:12px!important;color:#805064!important;transition:background-color .16s ease,color .16s ease,box-shadow .16s ease,transform .16s ease!important}
    .sidebar-nav-button:hover{background:rgba(255,235,242,.72)!important;color:#c85278!important;transform:translateX(2px)!important}
    .sidebar-nav-button.bg-primary-50{background:linear-gradient(135deg,#fff0f5,#ffe4ed)!important;color:#c44f73!important;box-shadow:inset 3px 0 0 #e98eaa,0 3px 10px rgba(200,93,125,.08)!important}
    /* ===== v19.5.4：RP-Hub 1.9.5 浮空导航卡片（AppNavigation）樱花粉适配 ===== */
    .app-navigation-layer::before{background:rgba(74,35,51,.20)!important}
    .app-navigation-panel{
        background:linear-gradient(145deg,rgba(255,247,250,.95),rgba(255,235,243,.84) 60%,rgba(255,250,252,.92))!important;
        border:1px solid rgba(255,182,193,.78)!important;
        box-shadow:inset 0 1px 0 rgba(255,255,255,.98),inset 0 -1px 0 rgba(255,255,255,.5),0 28px 72px -22px rgba(183,99,128,.42),0 0 0 1px rgba(233,142,170,.22)!important;
        color:#553746!important;
    }
    .app-navigation-header{border-bottom:1px solid rgba(239,191,208,.5)!important}
    .app-navigation-brand::after{background:linear-gradient(90deg,var(--sakura-theme-color,#ff6b95),#ffb3c6)!important}
    .app-navigation-brand > span{color:#8c3f5d!important}
    .app-navigation-brand em{color:#c07d97!important}
    .app-navigation-close{color:#c07d97!important}
    .app-navigation-close:hover{color:#e83a5e!important;background:rgba(255,235,242,.85)!important}
    .app-navigation-content::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#f7b6c9,#d87898)!important;border-radius:99px!important}
    .app-navigation-content::-webkit-scrollbar-track{background:rgba(255,240,245,.45)!important}
    .app-navigation-section h3{color:#b06a86!important}
    .app-navigation-item{
        background:rgba(255,255,255,.42)!important;
        border:1px solid rgba(255,214,226,.62)!important;
        color:#7a4a5e!important;
        border-radius:17px!important;
    }
    .app-navigation-item .app-navigation-icon{color:#c07d97!important;background:rgba(255,240,245,.72)!important;border-radius:10px!important}
    .app-navigation-item:hover{background:rgba(255,240,245,.92)!important;border-color:rgba(255,182,193,.88)!important;color:#c85278!important}
    .app-navigation-item:hover .app-navigation-icon{color:#ff4d79!important}
    .app-navigation-item.is-current{
        color:#c44f73!important;
        background:linear-gradient(135deg,rgba(255,240,245,.98),rgba(255,222,233,.9))!important;
        border-color:rgba(255,182,193,.92)!important;
        box-shadow:inset 0 -1px 0 rgba(233,142,170,.25),0 4px 12px -6px rgba(200,93,125,.4)!important;
    }
    .app-navigation-item.is-current .app-navigation-icon{color:var(--sakura-theme-color,#ff6b95)!important;background:rgba(255,235,242,.9)!important}
    .app-navigation-item.is-current::before{content:''!important;position:absolute!important;left:0!important;top:50%!important;width:3.5px!important;height:1.25rem!important;border-radius:999px!important;background:linear-gradient(180deg,#ff8da8,#ff4d79)!important;transform:translateY(-50%)!important;box-shadow:0 0 8px rgba(255,77,121,.6)!important}
    .app-navigation-status{background:var(--sakura-theme-color,#ff6b95)!important}
    .app-navigation-user{background:rgba(255,240,245,.55)!important;border:1px solid rgba(255,182,193,.68)!important}
    .app-navigation-avatar{background:linear-gradient(145deg,#ff9ebb,#ff6b95)!important}
    .app-navigation-user strong{color:#8c3f5d!important}
    .app-navigation-user-mark{background:linear-gradient(90deg,var(--sakura-theme-color,#ff6b95),rgba(255,179,198,.4))!important}
    .app-nav-trigger--embedded{color:#c85278!important;background:linear-gradient(145deg,rgba(255,247,250,.95),rgba(255,232,241,.86))!important;border:1px solid rgba(255,182,193,.72)!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.95),0 8px 24px -14px rgba(200,93,125,.45)!important}
    .app-nav-trigger--embedded:hover{color:#ff4d79!important}
    .app-nav-trigger--chat{color:rgba(255,225,235,.9)!important}
    .app-nav-trigger--chat:hover{color:#fff!important}
    /* 注：app-nav-trigger--characters 已被官方 1.9.5 后续提交删除，此条为 1.9.4 兼容保留 */
    .app-nav-trigger--characters{background:rgba(255,247,250,.95)!important;border-color:rgba(255,182,193,.72)!important;color:#c85278!important}
    .app-nav-trigger:focus-visible,.app-navigation-item:focus-visible,.app-navigation-close:focus-visible{outline-color:var(--sakura-theme-color,#ff6b95)!important}
    /* 1.9.5 浮空导航：移动端关掉毛玻璃后补实色，避免透底 */
    @media (max-width:767px){
        .app-navigation-panel{background:linear-gradient(145deg,#fff7fa,#ffeaf2 60%,#fffafc)!important}
        .app-nav-trigger--embedded{background:linear-gradient(145deg,#fff7fa,#ffe8f1)!important}
        /* 🚀 移动端导航面板阴影降级：官方 0 28px 72px -22px 是大半径模糊，
           开合时每帧重绘成本高，是"点一下慢半拍"的次要元凶。压到 0 12px 28px -14px，观感几乎无差。 */
        .app-navigation-panel{box-shadow:inset 0 1px 0 rgba(255,255,255,.98),0 12px 28px -14px rgba(183,99,128,.34),0 0 0 1px rgba(233,142,170,.22)!important}
    }
    /* 🚀 导航开合跟手优化（v19.5.4）：
       官方入场 380ms + cubic-bezier(.22,1,.36,1)（easeOutQuint）——该曲线前 30% 时间就走完 85% 位移，
       剩下 70% 时间在磨尾巴，观感就是"点一下慢悠悠才出来"。
       压到 200ms 并减小初始位移（-8px/scale.94 → -3px/scale.975），点击即出、收尾利落，保留浮出质感。 */
    .app-navigation-enter-active .app-navigation-panel{transition:transform .2s cubic-bezier(.22,1,.36,1),opacity .16s ease!important}
    .app-navigation-leave-active .app-navigation-panel{transition:transform .14s ease,opacity .12s ease!important}
    .app-navigation-enter-active::before,.app-navigation-leave-active::before{transition:opacity .16s ease!important}
    .app-navigation-enter-from .app-navigation-panel,.app-navigation-leave-to .app-navigation-panel{opacity:0;transform:translateY(-3px) scale(.975)!important}
    @media (prefers-reduced-motion:reduce){
        .app-navigation-enter-active .app-navigation-panel,.app-navigation-leave-active .app-navigation-panel,
        .app-navigation-enter-active::before,.app-navigation-leave-active::before{transition:none!important}
    }
    .settings-page-header{border-bottom:1px solid rgba(239,191,208,.64)!important;background:rgba(255,250,252,.82)!important}
    .settings-field{border-bottom-color:rgba(239,191,208,.52)!important}
    .settings-model-button,.sakura-mem-io-export,.sakura-mem-io-import{border-color:#efc5d3!important;border-radius:12px!important;box-shadow:0 2px 8px rgba(183,99,128,.05)!important;transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease!important}
    .settings-model-button:hover,.settings-model-button:focus-visible,.sakura-mem-io-export:hover,.sakura-mem-io-import:hover{border-color:#e98eaa!important;box-shadow:0 0 0 3px rgba(233,142,170,.16),0 4px 12px rgba(183,99,128,.08)!important;outline:none!important}
    .sakura-mem-io-export:active,.sakura-mem-io-import:active{transform:scale(.94)!important}
    .modal-close-button:hover,.sakura-close-btn:hover{background:#ffeaf1!important;color:#c85278!important}
    .modal-secondary-button{border-color:#efbfd0!important;color:#b45b79!important;background:#fff8fb!important}
    .modal-secondary-button:hover{background:#ffeaf1!important;border-color:#e98eaa!important;color:#c44f73!important}
    .toast-stack{filter:drop-shadow(0 5px 12px rgba(183,99,128,.1))}
    .toast-item{border-color:#efbfd0!important;box-shadow:0 6px 20px rgba(183,99,128,.12)!important}
    .segmented-switch__option.is-active{box-shadow:inset 0 0 0 1px rgba(233,142,170,.5),0 2px 8px rgba(200,93,125,.08)!important}
    input[type="checkbox"],input[type="radio"],input[type="range"]{accent-color:#e98eaa!important}
    input:not([type="checkbox"]):not([type="radio"]),select{border-color:#efc5d3!important}
    input:not([type="checkbox"]):not([type="radio"]):focus,select:focus{border-color:#e98eaa!important;box-shadow:0 0 0 3px rgba(233,142,170,.16)!important;outline:none!important}

    ::selection{background:#ffd6e2!important;color:#663246!important}
    ::-webkit-scrollbar{width:6px!important;height:6px!important}
    ::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#f4aac0,#d97899)!important;border:1px solid rgba(255,255,255,.75)!important;border-radius:99px!important}
    ::-webkit-scrollbar-track{background:rgba(255,240,245,.45)!important}


/* ================= 🎵 留声机专属外链弹窗（暗夜微光黑金） ================= */
.sgp-dialog-mask{
    position:fixed;inset:0;z-index:1000000;
    background:rgba(0,0,0,.75)!important;
    backdrop-filter:blur(16px) saturate(120%)!important;
    -webkit-backdrop-filter:blur(16px) saturate(120%)!important;
    display:flex;align-items:center;justify-content:center;padding:16px;
    animation:sgpFadeIn .2s ease;
    -webkit-tap-highlight-color:transparent;user-select:none;
}
@keyframes sgpFadeIn{from{opacity:0}to{opacity:1}}
.sgp-dialog-box{
    width:100%;max-width:380px;
    background:linear-gradient(170deg,#18111a 0%,#110c13 55%,#0b080c 100%)!important;
    border:1px solid rgba(201,168,106,.28)!important;
    border-radius:20px!important;
    box-shadow:0 24px 60px rgba(0,0,0,.9),0 0 35px rgba(201,168,106,.08),inset 0 1px 0 rgba(255,255,255,.08)!important;
    padding:20px 22px!important;
    display:flex;flex-direction:column;gap:16px;
    animation:sgpZoomIn .22s cubic-bezier(.16,1,.3,1);
    box-sizing:border-box;
}
@keyframes sgpZoomIn{from{opacity:0;transform:scale(.95) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}
.sgp-dialog-head{display:flex;flex-direction:column;gap:5px}
.sgp-dialog-title{
    font-size:14px;font-weight:700;letter-spacing:1px;color:#f0e6d6;
    display:flex;align-items:center;gap:8px;
}
.sgp-dialog-title svg{width:16px;height:16px;color:#c9a86a;flex-shrink:0}
.sgp-dialog-sub{font-size:11px;color:#8e7d86;line-height:1.4}
.sgp-dialog-body{display:flex;flex-direction:column;gap:11px}
.sgp-dialog-input{
    width:100%;padding:11px 14px;border-radius:12px;
    background:rgba(255,255,255,.04)!important;
    border:1px solid rgba(201,168,106,.2)!important;
    color:#f5ede3!important;font-size:12.5px;box-sizing:border-box;
    transition:all .18s ease;outline:none!important;
}
.sgp-dialog-input:focus{
    background:rgba(255,255,255,.07)!important;
    border-color:rgba(201,168,106,.6)!important;
    box-shadow:0 0 12px rgba(201,168,106,.25)!important;
}
.sgp-dialog-input::placeholder{color:#6c5d65}
.sgp-dialog-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:4px}
.sgp-dialog-cancel{
    background:none;border:none;color:#9b8b93;cursor:pointer;
    font-size:12.5px;padding:8px 14px;border-radius:9px;transition:all .15s ease;
}
.sgp-dialog-cancel:hover{color:#f0e6d6;background:rgba(255,255,255,.06)}
.sgp-dialog-submit{
    background:linear-gradient(135deg,#c9a86a 0%,#a0824a 100%)!important;
    color:#141014!important;font-weight:700;font-size:12.5px;
    border:none;border-radius:10px;padding:8px 18px;cursor:pointer;
    box-shadow:0 4px 14px rgba(201,168,106,.3),inset 0 1px 0 rgba(255,255,255,.3);
    transition:all .15s ease;
}
.sgp-dialog-submit:hover{transform:scale(1.03);box-shadow:0 6px 18px rgba(201,168,106,.45)}
.sgp-dialog-submit:active{transform:scale(.97)}

/* ================= 🎵 暗夜留声机（随身听）视觉系统 v2 ================= */
#sakura-gramophone-panel{
    position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    width:min(400px,calc(100vw - 28px));max-height:min(560px,80vh);
    background:linear-gradient(170deg,#171019 0%,#120c14 55%,#0d0a0f 100%);
    border:1px solid rgba(201,168,106,.22);border-radius:20px;
    box-shadow:0 24px 60px rgba(0,0,0,.8),0 0 40px rgba(201,168,106,.06),inset 0 1px 0 rgba(255,255,255,.06);
    backdrop-filter:blur(24px) saturate(120%);-webkit-backdrop-filter:blur(24px) saturate(120%);
    color:#e8ddcf;z-index:99999;display:flex;flex-direction:column;overflow:hidden;
    animation:sgpIn .24s cubic-bezier(.16,1,.3,1);
    -webkit-tap-highlight-color:transparent;user-select:none;
}
@keyframes sgpIn{from{opacity:0;transform:translateX(-50%) translateY(14px) scale(.98)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
.sgp-head{
    padding:13px 18px;border-bottom:1px solid rgba(201,168,106,.12);
    display:flex;align-items:center;justify-content:space-between;
    background:linear-gradient(180deg,rgba(201,168,106,.045),transparent);
}
.sgp-title{font-size:13px;font-weight:700;letter-spacing:1.5px;display:flex;align-items:baseline;gap:8px;color:#d9c7a8}
.sgp-title svg{width:15px;height:15px;color:#c9a86a;flex-shrink:0;align-self:center}
.sgp-title-sub{font-size:8.5px;font-weight:600;letter-spacing:2.5px;color:#8d7a5e;opacity:.8}
.sgp-close{
    background:none;border:none;color:#7d6f75;cursor:pointer;
    padding:5px;border-radius:8px;transition:all .15s ease;display:flex;align-items:center;justify-content:center;
}
.sgp-close svg{width:13px;height:13px}
.sgp-close:hover{color:#e8ddcf;background:rgba(255,255,255,.06)}
.sgp-player{
    padding:16px 20px 14px;display:flex;flex-direction:column;gap:13px;
    background:linear-gradient(180deg,rgba(201,168,106,.025) 0%,transparent 100%);
}
.sgp-now{display:flex;align-items:center;gap:15px}
.sgp-vinyl{
    width:58px;height:58px;border-radius:50%;flex-shrink:0;
    background:radial-gradient(circle at center,
        #1a1a1c 0%,#0b0b0d 30%,#1e1e22 31%,#0a0a0c 48%,
        #212126 49%,#0a0a0c 66%,#1c1c20 67%,#08080a 100%);
    border:1.5px solid rgba(201,168,106,.35);
    box-shadow:0 6px 20px rgba(0,0,0,.85),inset 0 0 0 1px rgba(255,255,255,.05);
    display:flex;align-items:center;justify-content:center;position:relative;
}
.sgp-vinyl::before{
    content:"";position:absolute;inset:5px;border-radius:50%;
    border:1px dashed rgba(255,255,255,.06);pointer-events:none;
}
.sgp-vinyl::after{
    content:"";width:19px;height:19px;border-radius:50%;
    background:radial-gradient(circle at center,#a83232 0%,#7d1f2a 55%,#3d0f14 100%);
    border:1.5px solid rgba(201,168,106,.75);
    box-shadow:0 0 5px rgba(0,0,0,.7),inset 0 0 3px rgba(0,0,0,.5);
}
.sgp-vinyl.is-playing{animation:sgpSpin 12s linear infinite}
@keyframes sgpSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.sgp-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.sgp-song-name{font-size:14px;font-weight:600;color:#f0e6d6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.2px}
.sgp-song-tag{font-size:10.5px;color:#8d7f88;font-weight:500;display:flex;align-items:center;gap:6px}
.sgp-badge{
    font-size:9px;padding:1px 6px;border-radius:4px;letter-spacing:.5px;
    background:rgba(201,168,106,.1);color:#c9a86a;border:1px solid rgba(201,168,106,.25);
}
.sgp-progress-wrap{display:flex;align-items:center;gap:12px;padding:6px 0}
.sgp-time{font-size:11px;font-family:ui-monospace,monospace;color:#a89890;flex-shrink:0;width:38px;text-align:center;letter-spacing:.5px}
.sgp-bar-track{
    flex:1;height:7px;border-radius:99px;
    background:rgba(255,255,255,.22);
    position:relative;cursor:pointer;touch-action:none;
    box-shadow:inset 0 1px 3px rgba(0,0,0,.8),0 1px 0 rgba(255,255,255,.05);
}
.sgp-bar-track:hover .sgp-bar-thumb,.sgp-bar-track.is-dragging .sgp-bar-thumb{
    transform:translateY(-50%) scale(1.25);box-shadow:0 0 14px #d9b87a,0 0 4px #fff;
}
.sgp-bar-fill{
    height:100%;background:linear-gradient(90deg,#8a6d3b,#c9a86a 60%,#e8cf9a);
    border-radius:99px;width:0%;position:relative;pointer-events:none;
    box-shadow:0 0 10px rgba(201,168,106,.6),inset 0 1px 0 rgba(255,255,255,.35);
}
.sgp-bar-thumb{
    position:absolute;right:-7px;top:50%;transform:translateY(-50%);
    width:14px;height:14px;border-radius:50%;
    background:radial-gradient(circle at 35% 35%,#fff,#e8d9b8 70%,#c9a86a 100%);
    box-shadow:0 0 10px rgba(201,168,106,.9),0 2px 4px rgba(0,0,0,.5);
    transition:transform .15s ease,box-shadow .15s ease;
}
.sgp-controls{display:flex;align-items:center;justify-content:center;gap:26px;padding:4px 0}
.sgp-ctrl-btn{
    background:none;border:none;color:#a89790;cursor:pointer;padding:6px;border-radius:10px;
    display:flex;align-items:center;justify-content:center;transition:all .15s ease;
}
.sgp-ctrl-btn:hover{color:#f0e6d6;background:rgba(201,168,106,.1)}
.sgp-ctrl-btn svg{width:17px;height:17px}
.sgp-play-btn{
    width:40px;height:40px;border-radius:50%;
    background:linear-gradient(135deg,#c9a86a,#a0824a);color:#141014;
    border:none;box-shadow:0 4px 16px rgba(201,168,106,.3),inset 0 1px 0 rgba(255,255,255,.25);
    cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s ease;
}
.sgp-play-btn:hover{transform:scale(1.06);box-shadow:0 6px 20px rgba(201,168,106,.45),inset 0 1px 0 rgba(255,255,255,.15)}
.sgp-play-btn:active{transform:scale(.94)}
.sgp-play-btn svg{width:18px;height:18px;fill:currentColor}
.sgp-list{
    flex:1;overflow-y:auto;padding:4px 16px 8px;display:flex;flex-direction:column;gap:5px;
    max-height:210px;border-top:1px solid rgba(201,168,106,.1);
}
.sgp-list::-webkit-scrollbar{width:3px}
.sgp-list::-webkit-scrollbar-thumb{background:rgba(201,168,106,.25);border-radius:99px}
.sgp-item{
    display:flex;align-items:center;justify-content:space-between;
    padding:10px 12px;border-radius:10px;background:transparent;
    border:1px solid transparent;cursor:pointer;transition:all .15s ease;
}
.sgp-item:hover{background:rgba(255,255,255,.03)}
.sgp-item.is-active{
    background:linear-gradient(90deg,rgba(201,168,106,.1),rgba(201,168,106,.02) 75%);
    border-color:rgba(201,168,106,.18);
}
.sgp-item-left{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.sgp-item-status{width:14px;height:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.sgp-idle-dot{width:4px;height:4px;border-radius:50%;background:#6d5f66}
.sgp-item.is-active .sgp-idle-dot{background:#c9a86a;box-shadow:0 0 5px #c9a86a}
.sgp-playing-bars{display:flex;align-items:flex-end;gap:2px;height:11px}
.sgp-playing-bars span{width:2px;background:#c9a86a;border-radius:1px;animation:sgpBarAnim .8s ease infinite alternate}
.sgp-playing-bars span:nth-child(1){height:50%;animation-delay:0s}
.sgp-playing-bars span:nth-child(2){height:100%;animation-delay:.2s}
.sgp-playing-bars span:nth-child(3){height:70%;animation-delay:.4s}
@keyframes sgpBarAnim{0%{height:25%}100%{height:100%}}
.sgp-item-info{min-width:0;flex:1}
.sgp-item-title{font-size:12.5px;color:#d9cdc0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.sgp-item.is-active .sgp-item-title{color:#f5ecdd;font-weight:600}
.sgp-item-right{display:flex;align-items:center;gap:7px;flex-shrink:0}
.sgp-item-badge{
    font-size:9.5px;padding:0;letter-spacing:1px;
    background:none;color:#75676f;border:none;
}
.sgp-item.is-active .sgp-item-badge{color:#c9a86a}
.sgp-item-del{
    background:none;border:none;color:#5d5057;cursor:pointer;
    padding:4px;border-radius:6px;line-height:1;transition:all .15s ease;
    display:flex;align-items:center;justify-content:center;
}
.sgp-item-del svg{width:11px;height:11px}
.sgp-item-del:hover{color:#e0647e;background:rgba(224,100,126,.1)}
/* 唱片夹迷你优雅分页条 */
.sgp-pager{
    display:flex;align-items:center;justify-content:center;gap:12px;
    padding:4px 0 2px;margin-top:2px;
}
.sgp-page-btn{
    background:rgba(255,255,255,.04);border:1px solid rgba(201,168,106,.2);
    color:#c9a86a;border-radius:6px;width:22px;height:22px;
    display:flex;align-items:center;justify-content:center;
    cursor:pointer;transition:all .15s ease;
}
.sgp-page-btn:hover:not(:disabled){background:rgba(201,168,106,.15);border-color:rgba(201,168,106,.4);color:#f0e6d6}
.sgp-page-btn:disabled{opacity:.25;cursor:not-allowed;border-color:transparent}
.sgp-page-info{font-size:11px;font-family:ui-monospace,monospace;color:#8d7d84;letter-spacing:1px}
.sgp-foot{
    padding:10px 16px;border-top:1px solid rgba(201,168,106,.1);
    display:flex;align-items:center;justify-content:flex-end;gap:8px;
    background:rgba(0,0,0,.2);
}
.sgp-action-btn{
    font-size:11.5px;font-weight:600;padding:7px 13px;border-radius:9px;cursor:pointer;
    background:rgba(201,168,106,.08);color:#d9c7a8;border:1px solid rgba(201,168,106,.22);
    display:flex;align-items:center;gap:5px;transition:all .15s ease;
}
.sgp-action-btn:hover{
    background:rgba(201,168,106,.16);border-color:rgba(201,168,106,.4);color:#f0e6d6;
}
#sakura-gramophone-trigger.sgp-btn-spin{
    color:#c9a86a!important;border-color:rgba(201,168,106,.6)!important;
    box-shadow:0 0 12px rgba(201,168,106,.4)!important;
}
#sakura-gramophone-trigger.sgp-btn-spin svg{
    animation:sgpTriggerSpin 12s linear infinite;
}
@keyframes sgpTriggerSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}


    /* 全站视觉收口：柔和、清晰、少一点廉价荧光 */
    .sakura-box,.modal-content,[role=dialog]{border-color:rgba(232,174,193,.72)!important;border-radius:22px!important}
    .sakura-head,.modal-header{background:linear-gradient(180deg,#fffafd,#fff5f8)!important}
    .sakura-body,.modal-body{color:var(--sakura-ink)!important}
    .sakura-btn,.sakura-tag-btn,.sakura-ping-btn{font-family:inherit!important;letter-spacing:.1px!important}
    .sakura-btn--main,.modal-primary-button{background:linear-gradient(135deg,#ed8eaa,#d75c82)!important;border-color:#d75c82!important;box-shadow:0 4px 12px rgba(215,92,130,.2)!important}
    .sakura-btn--main:hover,.modal-primary-button:hover{background:linear-gradient(135deg,#e67c9c,#ca4f76)!important}
    .sakura-close-btn{font-size:15px!important;color:#b88799!important}
    .sakura-close-btn:hover{background:#ffeaf1!important;color:#c85278!important}

    /* V20 原生派：名场面顶替自动生图的设定保留，但外观彻底回归官方 .island-button ghost 风格，不再强加粉底/粉边 */

    /* 对话卡片、思考卡片和提示统一质感 */
    .msg-bubble-glass,.native-thinking-card,.cot-ui{border-radius:18px!important;border-color:rgba(232,184,200,.62)!important}
    .msg-bubble-glass{line-height:1.72!important}
    .native-thinking-card,.cot-ui{background:rgba(255,250,252,.88)!important;box-shadow:0 3px 12px rgba(125,65,90,.06)!important}
    .toast-item,.toast-stack>div{font-family:inherit!important;border-radius:14px!important}
        .sakura-title-with-icon:after{content:"ฅ^•ﻌ•^ฅ"!important;margin-left:3px!important;font-size:11px!important;color:#df7897!important;opacity:.78!important;letter-spacing:-1px!important}
    .sakura-note-hint{color:#d46d8c!important}
    @media(max-width:767px){.sakura-box,.modal-content,[role=dialog]{border-radius:18px!important}.sakura-title-with-icon:after{font-size:10px!important}}

    /* 🌸 设置页「樱花个性化」分区：完全对齐官方原生分区质感 */
    .sakura-personal-card{position:relative;display:block;width:100%;text-align:left;padding:16px;border-radius:0.75rem;border:1px solid rgba(240,168,189,.45);background:linear-gradient(145deg,rgba(255,250,252,.96),rgba(255,241,246,.9));box-shadow:0 2px 10px rgba(183,99,128,.06);cursor:pointer;transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease,background .18s ease;-webkit-tap-highlight-color:transparent}
    .sakura-personal-card:hover{border-color:#e98eaa!important;background:linear-gradient(145deg,#fff7fa,#ffeef5)!important;box-shadow:0 4px 14px rgba(200,93,125,.14)!important;transform:translateY(-1px)!important}
    .sakura-personal-card:active{transform:scale(.98)!important}
    .sakura-personal-card-title{font-size:14px;font-weight:800;color:#c2255c;letter-spacing:.2px}
    .sakura-personal-card-desc{margin-top:5px;font-size:11.5px;color:#a27b89;line-height:1.5}
    .sakura-personal-card::after{content:'›';position:absolute;right:14px;top:50%;transform:translateY(-50%);font-size:18px;color:#dfa4b8;font-weight:700}
    @media (prefers-color-scheme: dark){
        .sakura-personal-card{border-color:rgba(255,140,170,.32)!important;background:linear-gradient(145deg,rgba(56,38,48,.96),rgba(42,28,36,.92))!important;box-shadow:0 2px 10px rgba(0,0,0,.25)!important}
        .sakura-personal-card:hover{border-color:#ff8da8!important;background:linear-gradient(145deg,rgba(66,44,56,.98),rgba(52,34,44,.95))!important}
        .sakura-personal-card-title{color:#ffa3b8!important}
        .sakura-personal-card-desc{color:#c79cab!important}
        .sakura-personal-card::after{color:#a06a80!important}
    }
    /* 🌸 V20 原生派记忆按钮：官方 2.0.0 重构为 li.memory-item 后，
       插件编辑/删除按钮直接嵌入 .memory-item__head，与官方 .memory-item__retry 同盖同尺寸。
       同时兼容旧版 .sakura-mem-actions 容器结构（保留后向兼容）。 */
    .sakura-mem-actions{gap:6px!important;align-items:center!important}
    .sakura-mem-actions > div{margin-right:10px!important}
    .sakura-mem-actions > button,
    .memory-item__head > .sakura-mem-edit,
    .memory-item__head > .sakura-mem-del{
        display:inline-flex!important;align-items:center!important;justify-content:center!important;
        width:1.75rem!important;height:1.75rem!important;min-width:1.75rem!important;flex:0 0 auto!important;
        padding:0!important;margin:0!important;border-radius:0.5rem!important;cursor:pointer!important;
        background:transparent!important;border:0!important;color:var(--c-text-3,#6b7280)!important;
        transition:background-color .15s ease,color .15s ease,transform .12s ease!important;
        -webkit-tap-highlight-color:transparent;
    }
    .sakura-mem-actions > button svg,
    .memory-item__head > .sakura-mem-edit svg,
    .memory-item__head > .sakura-mem-del svg{width:.9375rem!important;height:.9375rem!important;display:block!important}
    .sakura-mem-actions > button[title*="重新生成"] span{display:none!important}
    .sakura-mem-actions > button:hover,
    .memory-item__head > .sakura-mem-edit:hover{background:rgb(var(--gray-500,115 115 132) / .12)!important;color:var(--c-accent-text,#d43b60)!important}
    .memory-item__head > .sakura-mem-del:hover{background:rgba(220,53,69,.1)!important;color:#d6455c!important}
    .sakura-mem-actions > button:active,
    .memory-item__head > .sakura-mem-edit:active,
    .memory-item__head > .sakura-mem-del:active{transform:scale(.9)}
    /* 字数统计与按钮组之间留呼吸感，遥控到官方头部 gap */
    .memory-item__head{gap:0.5rem!important}
    .memory-item__retry{margin-left:0!important}
    /* v17.4：全站轻量收口层。只补交互反馈与边界层次，不新增全局模糊、动画或监听。 */
    :where(button,input,textarea,select,[role="button"]){-webkit-tap-highlight-color:transparent}
    :where(button,select,[role="button"]):focus-visible{outline:2px solid #ffb3c6!important;outline-offset:2px}
    /* ===== V20.0.1 修复①：输入框聚焦框不再是生硬直角 =====
       旧规则对 input/textarea 通配了 outline，而 outline 天生是直角矩形、不随圆角、还外扩 2px，
       又画在 .island-input（textarea 自身无圆角）上，于是生出一条硬边紫框，与官方玻璃岛 1.375rem 圆角
       严重方圆割裂（边角凸出、不丝滑）。现把 input/textarea 从全局 outline 摘除，聚焦反馈交给
       .input-island:focus-within 的柔和环形阴影，天然跟随岛体圆角、贴着包裹。 */
    .island-input:focus,.island-input:focus-visible,textarea.island-input:focus{outline:none!important;box-shadow:none!important}
    .input-island:focus-within{border-color:rgb(var(--primary-500) / .38)!important;box-shadow:var(--glass-highlight),var(--shadow-3),0 0 0 3px rgb(var(--primary-500) / .12)!important;transition:box-shadow .2s ease,border-color .2s ease!important}
    /* ===== V20.0.1 修复②：复活猫爪发送键 =====
       仅锁定 2.0.0 官方方形发送岛 .island-send（发送态，排除中止红块 .island-send--stop），
       沿用官方 2.25rem / 0.75rem 同心方块形制，不回落 1.9.8 的圆形，避免方圆混血；
       隐藏官方箭头 svg，用 ::before 覆盖上猫爪；禁用态用浅粉示意，仍见爪。 */
    .island-send:not(.island-send--stop){position:relative!important;background:linear-gradient(135deg,#ff9ebb 0%,#ff6b95 50%,#ff477e 100%)!important;border:2px solid #ffffff!important;box-shadow:0 4px 12px rgba(255,105,180,.45)!important;outline:none!important;-webkit-tap-highlight-color:transparent!important;transition:background-color .15s ease,box-shadow .15s ease,opacity .15s ease!important}
    .island-send:not(.island-send--stop) svg{display:none!important;opacity:0!important;visibility:hidden!important}
    .island-send:not(.island-send--stop)::before{content:""!important;display:block!important;position:absolute!important;top:50%!important;left:50%!important;width:1.45rem!important;height:1.45rem!important;transform:translate(-50%,-50%)!important;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cellipse cx='50' cy='65' rx='22' ry='16' fill='%23ffffff'/%3E%3Ccircle cx='23' cy='42' r='9' fill='%23ffffff'/%3E%3Ccircle cx='41' cy='30' r='9' fill='%23ffffff'/%3E%3Ccircle cx='59' cy='30' r='9' fill='%23ffffff'/%3E%3Ccircle cx='77' cy='42' r='9' fill='%23ffffff'/%3E%3Cellipse cx='50' cy='66' rx='14' ry='10' fill='%23ff7597'/%3E%3Ccircle cx='23' cy='42' r='5.5' fill='%23ff7597'/%3E%3Ccircle cx='41' cy='30' r='5.5' fill='%23ff7597'/%3E%3Ccircle cx='59' cy='30' r='5.5' fill='%23ff7597'/%3E%3Ccircle cx='77' cy='42' r='5.5' fill='%23ff7597'/%3E%3C/svg%3E") center/contain no-repeat!important;transition:transform .15s cubic-bezier(.34,1.56,.64,1)!important;z-index:5!important;pointer-events:none!important}
    .island-send:not(.island-send--stop):disabled{background:linear-gradient(135deg,#ffd8e2,#ffb6c8)!important;opacity:.8!important;box-shadow:none!important;cursor:not-allowed!important}
    .island-send:not(.island-send--stop):active:not(:disabled){background:linear-gradient(135deg,#ff7597 0%,#e83a5e 100%)!important}
    .island-send:not(.island-send--stop):active:not(:disabled)::before{transform:translate(-50%,-50%) scale(.82) rotate(-12deg)!important}
    :root[data-sakura-night="1"] .island-send:not(.island-send--stop){box-shadow:0 4px 14px rgba(255,105,180,.32)!important}
    :where(button,input,textarea,select):disabled{cursor:not-allowed!important}
    .settings-field input:not([type="checkbox"]):not([type="radio"]),.settings-field textarea,.settings-field select{border-radius:12px;transition:border-color .12s ease,box-shadow .12s ease,background-color .12s ease}
    .settings-field input:not([type="checkbox"]):not([type="radio"]):focus,.settings-field textarea:focus,.settings-field select:focus{border-color:#ff9ebb!important;box-shadow:0 0 0 2px rgba(255,107,149,.12)!important;outline:none!important}
    .settings-section-heading{letter-spacing:.01em}
    .sakura-personal-card{contain:paint}
    @media (max-width:767px){
        .sakura-personal-card{box-shadow:0 2px 8px rgba(80,35,50,.07)!important}
        .story-route-node{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;transition:border-color .12s ease,background-color .12s ease!important}
    }
/* ================= 名场面手记展柜 + 命名弹窗（主题联动：全部使用樱花粉家族色值，换主题自动重映射） ================= */
    #sakura-moments-mask .sakura-box{
        width:min(680px,calc(100vw - 20px))!important;max-width:680px!important;
        max-height:calc(100dvh - 30px)!important;display:flex!important;flex-direction:column!important;padding:0!important;
        background:linear-gradient(168deg,#2b1e2b 0%,#241826 52%,#1e1320 100%)!important;
        border:1px solid rgba(255,182,193,.15)!important;border-radius:18px!important;
        box-shadow:0 24px 64px rgba(0,0,0,.55),0 2px 10px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.045)!important;
        -webkit-tap-highlight-color:transparent;overflow:hidden;
    }
    #sakura-moments-mask .sm-head{flex-shrink:0;padding:14px 16px 12px;border-bottom:1px solid rgba(255,182,193,.09);background:linear-gradient(180deg,rgba(255,182,193,.055),rgba(255,182,193,0))}
    #sakura-moments-mask .sm-head-inner{display:flex;align-items:center;gap:12px}
    #sakura-moments-mask .sm-title-wrap{flex:1;min-width:0}
    #sakura-moments-mask .sm-title{font-size:14.5px;font-weight:700;color:#ffd9e6;letter-spacing:.5px}
    #sakura-moments-mask .sm-sub{font-size:10.5px;color:rgba(255,182,193,.42);margin-top:3px;letter-spacing:.3px}
    #sakura-moments-mask .sm-icon-btn{width:30px;height:30px;flex-shrink:0;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,182,193,.14);border-radius:9px;background:rgba(255,255,255,.03);color:rgba(255,214,229,.72);cursor:pointer;transition:border-color .18s,color .18s,transform .12s;user-select:none;-webkit-tap-highlight-color:transparent;padding:0}
    #sakura-moments-mask .sm-icon-btn svg{width:15px;height:15px}
    #sakura-moments-mask .sm-icon-btn:active{transform:scale(.92);background:rgba(255,182,193,.1)}
    @media(hover:hover){#sakura-moments-mask .sm-icon-btn:hover{border-color:rgba(255,182,193,.35);color:#ffd9e6}}
    #sakura-moments-mask .sm-body{flex:1;min-height:0;overflow-y:auto;padding:14px}
    #sakura-moments-mask .sm-view-anim{animation:smViewIn .22s ease}
    @keyframes smViewIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    #sakura-moments-mask .sm-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
    @media(min-width:600px){#sakura-moments-mask .sm-grid{grid-template-columns:repeat(3,1fr)}}
    #sakura-moments-mask .sm-card{position:relative;border:1px solid rgba(255,182,193,.13);border-radius:13px;padding:12px 12px 10px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;background:linear-gradient(172deg,rgba(255,255,255,.045),rgba(255,255,255,.012));transition:border-color .18s,transform .18s,box-shadow .18s}
    #sakura-moments-mask .sm-card:active{transform:scale(.975)}
    @media(hover:hover){#sakura-moments-mask .sm-card:hover{border-color:rgba(255,182,193,.32);transform:translateY(-2px);box-shadow:0 10px 24px rgba(0,0,0,.35)}}
    #sakura-moments-mask .sm-card-title{font-size:13px;font-weight:600;color:#ffd9e6;padding-right:20px}
    #sakura-moments-mask .sm-card-excerpt{font-size:11.5px;line-height:1.65;color:rgba(255,255,255,.52);margin-top:6px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
    #sakura-moments-mask .sm-card-foot{display:flex;align-items:center;gap:8px;margin-top:9px;min-height:20px}
    #sakura-moments-mask .sm-thumb{width:34px;height:34px;border-radius:8px;object-fit:cover;border:1px solid rgba(255,182,193,.22);flex-shrink:0}
    #sakura-moments-mask .sm-card-time{font-size:10px;color:rgba(255,255,255,.32)}
    #sakura-moments-mask .sm-card-del{position:absolute;top:8px;right:8px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border:none;background:transparent;color:rgba(255,255,255,.28);cursor:pointer;opacity:.55;transition:color .15s,opacity .15s;user-select:none;-webkit-tap-highlight-color:transparent;padding:0}
    #sakura-moments-mask .sm-card-del svg{width:11px;height:11px}
    #sakura-moments-mask .sm-card-del:active{color:#ef7d9d;opacity:1}
    @media(hover:hover){#sakura-moments-mask .sm-card-del:hover{color:#ef7d9d;opacity:1}}
    #sakura-moments-mask .sm-empty{padding:58px 20px;text-align:center;color:rgba(255,255,255,.38);font-size:12.5px;line-height:1.9}
    #sakura-moments-mask .sm-empty-icon{width:34px;height:34px;color:rgba(255,182,193,.35);margin-bottom:10px}
    #sakura-moments-mask .sm-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #sakura-moments-mask .sm-user{background:rgba(255,182,193,.06);border-left:2px solid rgba(255,182,193,.45);border-radius:0 10px 10px 0;padding:9px 12px;font-size:12px;line-height:1.7;color:rgba(255,255,255,.72);margin-bottom:12px;word-break:break-word}
    #sakura-moments-mask .sm-user b{color:#ffc9dc;font-weight:600}
    #sakura-moments-mask .sm-ai-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
    #sakura-moments-mask .sm-ai-avatar{width:26px;height:26px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,182,193,.3);flex-shrink:0}
    #sakura-moments-mask .sm-ai-avatar-fallback{display:flex;align-items:center;justify-content:center;font-size:10px;color:#ffb9d0;background:rgba(255,182,193,.12)}
    #sakura-moments-mask .sm-ai-name{font-size:12px;font-weight:600;color:#ffd0e1}
    #sakura-moments-mask .sm-content{font-size:13px;line-height:1.75;color:rgba(255,255,255,.88);word-break:break-word}
    /* 手记分页条：结构对齐、极简、主题联动 */
    #sakura-moments-mask .sm-pager{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:14px;user-select:none;-webkit-tap-highlight-color:transparent}
    #sakura-moments-mask .sm-page-btn{min-width:30px;height:30px;padding:0 8px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;border:1px solid rgba(255,182,193,.14);background:rgba(255,255,255,.03);color:rgba(255,214,229,.72);font-size:12px;cursor:pointer;transition:border-color .15s,background-color .15s,transform .12s;-webkit-tap-highlight-color:transparent}
    #sakura-moments-mask .sm-page-btn:active{transform:scale(.92)}
    #sakura-moments-mask .sm-page-btn.is-active{background:rgba(255,182,193,.14);border-color:rgba(255,182,193,.45);color:#ffd9e6;font-weight:700}
    @media(hover:hover){#sakura-moments-mask .sm-page-btn:hover{border-color:rgba(255,182,193,.35);color:#ffd9e6}}
    #sakura-moments-mask .sm-page-btn:disabled{opacity:.35;cursor:default;transform:none}
    #sakura-moments-mask .sm-page-dots{color:rgba(255,182,193,.4);font-size:12px;padding:0 2px}
    /* 思维链折叠卡（展柜内） */
    .sakura-moment-cot{margin-bottom:12px;background:rgba(255,255,255,.028);border:1px solid rgba(255,182,193,.13);border-radius:10px;padding:9px 12px;font-size:12px;color:rgba(255,255,255,.62);transition:border-color .18s}
    .sakura-moment-cot summary{cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;font-weight:600;color:rgba(255,201,220,.88);display:flex;align-items:center;justify-content:space-between;outline:none;list-style:none}
    .sakura-moment-cot summary::-webkit-details-marker{display:none}
    .sakura-moment-cot .smcot-label{display:inline-flex;align-items:center;gap:6px}
    .sakura-moment-cot .smcot-label svg{width:13px;height:13px;opacity:.75}
    .sakura-moment-cot .smcot-count{font-size:10.5px;opacity:.55}
    .sakura-moment-cot .smcot-body{margin-top:8px;line-height:1.65;font-size:11.5px;white-space:pre-wrap;word-break:break-word;color:rgba(255,255,255,.55);border-top:1px solid rgba(255,255,255,.06);padding-top:8px}
    /* 收录命名弹窗 + 删除确认弹窗（与展柜同血统，主题联动） */
    #sakura-moment-naming .sakura-box,#sakura-moment-confirm .sakura-box{
        width:min(360px,calc(100vw - 36px))!important;max-width:360px!important;
        background:linear-gradient(168deg,#2b1e2b 0%,#241826 52%,#1e1320 100%)!important;
        border:1px solid rgba(255,182,193,.16)!important;border-radius:16px!important;
        box-shadow:0 24px 64px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.045)!important;
        -webkit-tap-highlight-color:transparent;overflow:hidden;animation:smNamingIn .2s ease;
    }
    @keyframes smNamingIn{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
    #sakura-moment-naming .sn-head,#sakura-moment-confirm .sn-head{padding:16px 18px 0}
    #sakura-moment-naming .sn-title,#sakura-moment-confirm .sn-title{font-size:14.5px;font-weight:700;color:#ffd9e6;letter-spacing:.4px}
    #sakura-moment-naming .sn-sub,#sakura-moment-confirm .sn-sub{font-size:11px;color:rgba(255,182,193,.45);margin-top:4px}
    #sakura-moment-naming .sn-body,#sakura-moment-confirm .sn-body{padding:14px 18px 4px}
    #sakura-moment-confirm .sn-msg{font-size:12.5px;line-height:1.7;color:rgba(255,255,255,.78);word-break:break-word}
    #sakura-moment-naming .sn-input{
        width:100%;box-sizing:border-box;min-height:40px;padding:9px 12px;
        background:rgba(255,255,255,.045);border:1px solid rgba(255,182,193,.18);border-radius:10px;
        color:rgba(255,255,255,.92);font-size:13px;outline:none;user-select:text;-webkit-user-select:text;
        transition:border-color .18s,box-shadow .18s;
    }
    #sakura-moment-naming .sn-input::placeholder{color:rgba(255,255,255,.28)}
    #sakura-moment-naming .sn-input:focus{border-color:rgba(255,182,193,.5);box-shadow:0 0 0 3px rgba(255,182,193,.08)}
    #sakura-moment-naming .sn-foot,#sakura-moment-confirm .sn-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px 16px}
    #sakura-moment-naming .sn-btn,#sakura-moment-confirm .sn-btn{
        min-height:34px;padding:0 16px;border-radius:9px;font-size:12.5px;cursor:pointer;
        user-select:none;-webkit-tap-highlight-color:transparent;transition:transform .12s,filter .18s,border-color .18s;
        display:inline-flex;align-items:center;justify-content:center;
    }
    #sakura-moment-naming .sn-btn:active,#sakura-moment-confirm .sn-btn:active{transform:scale(.95)}
    #sakura-moment-naming .sn-btn-cancel,#sakura-moment-confirm .sn-btn-cancel{background:rgba(255,255,255,.05);border:1px solid rgba(255,182,193,.14);color:rgba(255,255,255,.62)}
    #sakura-moment-naming .sn-btn-ok{background:linear-gradient(135deg,#f08bab,#e06a92);border:1px solid rgba(255,182,193,.4);color:#fff;font-weight:600;box-shadow:0 4px 14px rgba(224,106,146,.28)}
    #sakura-moment-naming .sn-btn-ok:hover{filter:brightness(1.06)}
    #sakura-moment-confirm .sn-btn-danger{background:linear-gradient(135deg,#e0647e,#c94a66);border:1px solid rgba(255,150,170,.4);color:#fff;font-weight:600;box-shadow:0 4px 14px rgba(201,74,102,.3)}
    #sakura-moment-confirm .sn-btn-danger:hover{filter:brightness(1.06)}
    /* 轻量提示气泡（收录成功/失败等非阻断反馈） */
    #sakura-moment-toast{
        position:fixed;left:50%;bottom:30px;transform:translateX(-50%);
        z-index:1000002;padding:10px 18px;border-radius:12px;max-width:calc(100vw - 40px);text-align:center;
        background:linear-gradient(168deg,#2b1e2b,#1e1320);border:1px solid rgba(255,182,193,.25);
        color:#ffd9e6;font-size:12.5px;line-height:1.6;box-shadow:0 12px 32px rgba(0,0,0,.5);
        animation:smToastIn .22s ease;transition:opacity .4s ease,transform .4s ease;
        user-select:none;-webkit-tap-highlight-color:transparent;pointer-events:none;
    }
    #sakura-moment-toast.is-out{opacity:0;transform:translateX(-50%) translateY(8px)}
    @keyframes smToastIn{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
    /* 🧹 存储管家：全部改用类 + 粉色 hex，主题引擎换色时自动重映射（不再固定粉红） */
    .sakura-janitor-stat{text-align:center;padding:6px 0 12px}
    .sakura-janitor-total{font-size:30px;font-weight:800}
    .sakura-janitor-hint{font-size:11.5px;color:#b07a8c;margin-top:2px}
    .sakura-janitor-bar{height:8px;border-radius:99px;background:#ffe3ec;margin-top:10px;overflow:hidden}
    .sakura-janitor-bar-fill{height:100%;border-radius:99px;transition:width .4s;background:linear-gradient(90deg,#ff8da8,#ffb3c6)}
    .sakura-janitor-cachehint{font-size:11px;color:#b07a8c;margin-top:8px}
    .sakura-janitor-real{font-size:11px;color:#b07a8c;margin-top:6px}
    .sakura-janitor-row{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid #ffd6e1;border-radius:12px;background:#fffafa}
    .sakura-janitor-rowmain{flex:1;min-width:0}
    .sakura-janitor-label{font-size:13px;font-weight:700;color:#4a2030}
    .sakura-janitor-desc{font-weight:400;color:#b07a8c;font-size:11px}
    .sakura-janitor-key{font-size:11px;color:#a85a78;margin-top:2px;font-family:monospace}
    .sakura-janitor-empty{font-size:11px;color:#c9a5b2;flex-shrink:0}
    .sakura-janitor-note{font-size:11px;color:#b07a8c;margin-top:10px;line-height:1.6}
    .sakura-janitor-clean{padding:6px 12px;font-size:12px;flex-shrink:0}
    /* 同类漏网：加载提示 / 拉取失败提示也改为类，跟随主题换色 */
    .sakura-loading-hint{padding:34px 12px;text-align:center;font-size:12.5px;color:#b07a8c}
    .sakura-empty--danger{color:#e83a5e}
    .sakura-empty--danger .sakura-empty-sub{font-size:11px;color:#a85a78}
    /* 留声机空列表：同样改类，跟随主题换色 */
    .gp-empty{text-align:center;padding:30px 16px;font-size:12px;line-height:1.9;color:#a88da0}
    .gp-empty .gp-empty-title{letter-spacing:1.5px}
    .gp-empty .gp-empty-sub{font-size:11px;color:#7e6475;margin-top:3px}
    @media (prefers-color-scheme: dark){
        .sakura-janitor-hint,.sakura-janitor-cachehint,.sakura-janitor-real,.sakura-janitor-note{color:#d8aebd}
        .sakura-janitor-bar{background:#4a2b3a}
        .sakura-janitor-row{border-color:#6b3b52;background:#331f2b}
        .sakura-janitor-label{color:#ffd6e1}
        .sakura-janitor-desc{color:#d8aebd}
        .sakura-janitor-key{color:#e8b3c4}
        .sakura-janitor-empty{color:#a8808f}
    }
    /* ============ v19.6.3 官方硬编码蓝全量接管（日间）============
       官方 styles.css 用写死的蓝色系字面量（#2563eb / #3b82f6 / #4f68cb / #7198f2 / #93c5fd 等，
       色相约 212-222°）渲染下列组件，不落在插件「樱花粉系 290-360°」色相旋转范围内，
       因此此前换肤时这些块永远保持官方蓝。统一改写为粉系字面量，交给主池色相旋转按当前主题轮转。 */
    .settings-card__title > svg{background:#ffeaf2!important;color:#e0457b!important}
    .memory-compression__after,.memory-compression__before{color:#c2477a!important}
    .memory-compression__track{background:#ffe0ec!important}
    .memory-compression__fill{background:linear-gradient(90deg,#ff9dbb,#e0457b)!important}
    .memory-compression__marker-before{background:#ffbcd2!important}
    .memory-compression__marker-after{background:#ef6ba0!important}
    /* v19.6.5：不再依赖官方 --badge-* 变量（会被官方 styles.css 抢先），直接写死选中态，
       用 --sakura-theme-color 跟随主题色；背景浅粉由色相旋转自动转成主题浅色。 */
    .message-placement{--badge-color:var(--sakura-theme-color,#ff6b95)!important;--badge-bg:#ffeaf2!important;--badge-border:#ffc2d6!important}
    .message-placement.is-selected{background:#ffeaf2!important;border-color:var(--sakura-theme-color,#ff6b95)!important;color:var(--sakura-theme-color,#ff6b95)!important}
    .message-placement.is-selected .message-placement-check{background:var(--sakura-theme-color,#ff6b95)!important;border-color:var(--sakura-theme-color,#ff6b95)!important}
    .message-placement-check{border-color:#ffc2d6!important}
    /* v19.6.5：官方设置页 segmented-switch 底色硬编码 #f5f8ff 浅蓝，日间同样接管 */
    .settings-view .segmented-switch{background:#fff5f9!important}
    .segmented-switch__indicator{background:#fff!important;box-shadow:0 1px 2px rgba(0,0,0,.06),0 0 0 1px rgba(233,142,170,.5)!important}
    .segmented-switch__option.is-active{color:var(--sakura-theme-color,#ff6b95)!important}

    /* ================== 🎯 v19.6.6：全站「聚焦/选中」官方蓝终结层 ==================
       官方三路蓝往控件 :focus 上糊：
         styles.css:1345/1346  .settings-control:hover/:focus   → #acbfe0 / #5281ec + rgba(59,130,246,.1)
         styles.css:1367       .settings-action:focus-visible    → outline #5281ec
         styles.css:1472       .settings-toggle-input:focus-visible + … → shadow #93c5fd
         styles.css:1677       .settings-help-trigger:focus-visible → outline rgba(59,130,246,.28)
         styles.css:2460/2544/3223  角色卡/剧本节点 focus-visible → #93c5fd / #60a5fa
         theme.css:113         [dark] .settings-control:focus     → #86adf4
         theme.css:485         [dark] [aria-pressed=true].border-primary-400 → #7099e1（带 !important）
         Tailwind CDN          focus:border-primary-500 / focus:ring-* → #3b82f6 + blue ring
       策略：全部换成粉系字面量（rgba 与 hex 都在 290°~360° 旋转池里），
       自定义主题时会被 themeRecolorCss 自动旋转成目标色，不依赖 color-mix。
       特异性用 :root:root 抬高，压住后加载的官方样式与 Tailwind 运行时样式。 */
    :root:not([data-sakura-night="1"]) .settings-view .settings-control{border-color:#f3d9e4!important}
    :root:root .settings-view .settings-control:hover{border-color:#e9aec4!important}
    :root:root .settings-view .settings-control:focus,
    :root:root .settings-view .settings-control:focus-visible,
    :root:root .settings-view button.settings-control:focus,
    :root:root .settings-view textarea.settings-control:focus,
    :root:root .settings-view input.settings-control:focus{
        border-color:#ff6b95!important;
        box-shadow:0 0 0 3px rgba(255,107,149,.2)!important;
        outline:none!important;
    }
    :root:root [class~="focus:border-primary-400"]:focus,
    :root:root [class~="focus:border-primary-500"]:focus,
    :root:root [class~="focus:border-primary-600"]:focus,
    :root:root [class~="focus:ring"]:focus,
    :root:root [class~="focus:ring-2"]:focus,
    :root:root [class~="focus:ring-4"]:focus,
    :root:root [class~="focus:ring-8"]:focus,
    :root:root [class~="focus:ring-primary-400"]:focus,
    :root:root [class~="focus:ring-primary-500"]:focus,
    :root:root [class~="focus:ring-primary-500/10"]:focus,
    :root:root [class~="focus:ring-primary-500/20"]:focus{
        border-color:#ff6b95!important;
        --tw-ring-color:rgba(255,107,149,.3)!important;
        --tw-ring-shadow:0 0 0 3px rgba(255,107,149,.24)!important;
        box-shadow:0 0 0 3px rgba(255,107,149,.24)!important;
        outline:none!important;
    }
    :root:root [class~="focus:ring-primary-500/5"]:focus{border-color:#ff6b95!important;box-shadow:0 0 0 2px rgba(255,107,149,.16)!important}
    :root:root .settings-action:focus-visible,
    :root:root .settings-icon-button:focus-visible,
    :root:root .settings-model-button:focus-visible,
    :root:root .settings-help-trigger:focus-visible,
    :root:root .modal-close-button:focus-visible,
    :root:root .pagination-button:focus-visible,
    :root:root .modal-secondary-button:focus-visible,
    :root:root .modal-primary-button:focus-visible{outline-color:#ff6b95!important}
    :root:root .settings-action:focus-visible{outline:2px solid #ff6b95!important;outline-offset:2px!important}
    :root:root .settings-toggle-input:focus-visible + .settings-toggle{box-shadow:0 0 0 2px rgba(255,107,149,.4)!important}
    :root:root .character-deck:focus-visible,
    :root:root .character-deck__peek:focus-visible,
    :root:root .story-route-node:focus-visible{outline-color:#ff6b95!important}
    :root:root .character-deck__arrow:hover:not(:disabled){color:#ff6b95!important;background:#fff0f5!important}
    :root:root .story-route-node:hover{border-color:#e9aec4!important}
    :root:root .story-route-node.is-selected{border-color:#ff6b95!important;background:#fff0f5!important}
    :root:root [class~="hover:bg-primary-50"]:hover,
    :root:root [class~="hover:bg-primary-100"]:hover{background:#fff0f5!important}
    :root:root [class~="hover:text-primary-600"]:hover,
    :root:root [class~="hover:text-primary-700"]:hover{color:#ff6b95!important}
    :root:root [class~="bg-primary-300"],[class~="bg-blue-300"],[class~="bg-indigo-300"]{background:#ffd9e6!important}
    :root:root .settings-help-trigger:hover{color:#ff6b95!important;border-color:#e9aec4!important;background:#fff0f5!important}
    :root:root .settings-help-trigger.is-open{color:#e0457b!important;border-color:#ff6b95!important;background:#ffe0ec!important;box-shadow:0 1px 2px rgba(255,107,149,.16)!important}
    /* Tailwind 的 aria-pressed 选中态（主题色按钮）官方也钉了蓝，一并接管 */
    :root:root [aria-pressed="true"].border-primary-400{border-color:#ff6b95!important}
    :root:root[data-app-theme="dark"] [aria-pressed="true"].border-primary-400{border-color:#ff6b95!important;background-color:#4a2634!important;color:#f1f6ff!important}
    /* 夜间：底深、字亮，聚焦环用亮粉保证对比 */
    :root:root[data-sakura-night="1"] .settings-view .settings-control:focus,
    :root:root[data-sakura-night="1"] .settings-view .settings-control:focus-visible,
    :root:root[data-sakura-night="1"] [class~="focus:ring-2"]:focus,
    :root:root[data-sakura-night="1"] [class~="focus:ring-4"]:focus{
        border-color:#ff9ec2!important;
        box-shadow:0 0 0 3px rgba(255,158,194,.24)!important;
    }

    /* ============ 🩹 v19.6.7：最后一批官方蓝漏网点（+ 插件自身历史遗留蓝） ============
       逐条对过官方 styles.css / theme.css 全量蓝规则，以下 10 处以前没被接管：
         styles.css:855  @keyframes message-action-tap 50%      → #2563eb（触摸设备点按闪烁）
         styles.css:869  .message-action-button:focus           → #2563eb（不带 visible，点后残焦）
         styles.css:817  .message-style-filter-button.is-active → #2563eb
         styles.css:1100 .meta-badge--global                    → #4868b8/#eef3ff/#cedafa
         styles.css:1689 .settings-help-popover                 → border #dbeafe
         styles.css:1728 .settings-help-popover-content         → border-left #60a5fa
         styles.css:23   .embedded-loading-spinner              → #2563eb
         styles.css:1439 .pagination-button:hover:not(:disabled)→ #bfdbfe/#2563eb
         styles.css:742  .settings-create-button:hover          → #bfdbfe/#eff6ff/#1d4ed8
         styles.css:1900 .markdown-body code / a                → #2563eb/#1d4ed8（插件旧规则只盖了 .app-main 内）
         styles.css:3149 .story-route-map-scroll                → #fbfdff
         styles.css:1371 .settings-toggle-row                   → #e6edf7
       全部改回粉系字面量（色相 326°~343°，落在 290°~360° 旋转池内，换主题自动跟随）。 */
    .app-main .message-action-button:hover,
    .app-main .message-action-button:focus-visible{color:#c44f73!important}
    .message-action-button:focus{color:#c44f73!important;background:rgba(255,243,247,.5)!important;outline:none!important}
    .message-action-button--danger:hover,
    .message-action-button--danger:focus{color:#dc2626!important;background:rgba(254,242,242,.82)!important}
    /* 官方 @keyframes 自带蓝闪，整体重写（同名后定义优先） */
    @keyframes message-action-tap{
        0%,100%{color:rgba(75,85,99,.78);background:transparent;transform:none}
        50%{color:#c44f73;background:rgba(255,243,247,.86);transform:translateY(-1px)}
    }
    .message-style-filter-button.is-active{color:#c85278!important;background:rgba(255,240,245,.9)!important}
    .meta-badge--global{--badge-color:#b0466e!important;--badge-bg:#fff0f5!important;--badge-border:#f7c6d8!important}
    .settings-help-popover{border-color:#f4cfdd!important}
    .settings-help-popover-content{border-left-color:#e98eaa!important}
    .embedded-loading-spinner{color:#e98eaa!important}
    .pagination-button:hover:not(:disabled){border-color:#f4cfdd!important;color:#c85278!important}
    .settings-create-button:hover{border-color:#f4cfdd!important;background:#fff0f5!important;color:#b0466e!important}
    :root:root .markdown-body code{color:#a84e6d!important}
    :root:root .markdown-body a{color:#c85d7d!important}
    :root:root .markdown-body a:hover{color:#b0466e!important}
    :root:root .story-route-map-scroll{background:#fffafc!important}
    :root:root .settings-toggle-row{border-color:#f6e2ea!important}
    /* 夜间反制：上面这批日间规则带 !important，夜间必须同层换深底亮字，不能压成浅块 */
    :root[data-sakura-night="1"] .message-action-button:focus{color:#ffb3c6!important;background:rgba(255,255,255,.06)!important}
    :root[data-sakura-night="1"] .message-style-filter-button.is-active{color:#ffb3c6!important;background:rgba(255,182,193,.14)!important}
    :root[data-sakura-night="1"] .meta-badge--global{--badge-color:#ffb3c6!important;--badge-bg:#3d2b33!important;--badge-border:#6b4653!important}
    :root[data-sakura-night="1"] .settings-help-popover{border-color:#4a3a44!important}
    :root[data-sakura-night="1"] .settings-help-popover-content{border-left-color:#8a5568!important}
    :root[data-sakura-night="1"] .embedded-loading-spinner{color:#e98eaa!important}
    :root[data-sakura-night="1"] .pagination-button:hover:not(:disabled){border-color:#6b4653!important;color:#ffb3c6!important}
    :root[data-sakura-night="1"] .settings-create-button:hover{background:#4a3a44!important;color:#ffb3c6!important;border-color:#6b4653!important}
    :root[data-sakura-night="1"] .markdown-body code{color:#ffb3c6!important;background:#3d3136!important;border-color:#5a4149!important}
    :root[data-sakura-night="1"] .markdown-body a{color:#ff9ec2!important}
    :root[data-sakura-night="1"] .markdown-body a:hover{color:#ffb3c6!important}
    :root[data-sakura-night="1"] .story-route-map-scroll{background:#2f2f2f!important}
    :root[data-sakura-night="1"] .settings-toggle-row{border-color:#4a4a4a!important}
    /* v19.6.8：末轮收口——官方残余蓝色投影 / 剧本线悬停浅蓝 / 思维链卡蓝影，全部改粉系字面量 */
    .settings-help-popover{box-shadow:0 12px 28px -14px rgba(200,93,125,.35)!important}
    .story-route-node:hover{box-shadow:0 12px 25px rgba(200,93,125,.12)!important}
    .story-route-node.is-selected{background:#fff0f5!important;box-shadow:0 12px 28px rgba(200,93,125,.16)!important}
    .story-route-edit-button:hover:not(:disabled){border-color:#ffc2d6!important;background:#fff5f9!important;color:#b0466e!important}
    .cot-ui.is-open,.native-thinking-card.is-open,.native-thinking-card.is-live{box-shadow:0 4px 12px -2px rgba(255,107,149,.1),0 2px 6px -2px rgba(255,107,149,.05)!important}
    :root[data-sakura-night="1"] .settings-help-popover{box-shadow:0 12px 28px -14px rgba(0,0,0,.5)!important}
    :root[data-sakura-night="1"] .story-route-node.is-selected{background:#41323a!important;box-shadow:0 12px 28px rgba(0,0,0,.4)!important}
    :root[data-sakura-night="1"] .story-route-edit-button:hover:not(:disabled){background:#41323a!important;border-color:#6b4653!important;color:#ffb3c6!important}
    /* v19.6.9：定稿收口——系统点按高亮 / 文本选中色 / 官方存储面板内联色 */
    *{-webkit-tap-highlight-color:transparent!important}
    ::selection{background:#ffccd5!important;color:#7a2245!important}
    [class~="selection:bg-primary-200"]::selection{background:#ffccd5!important;color:#7a2245!important}
    :root[data-sakura-night="1"] ::selection{background:#6b4653!important;color:#ffe6ef!important}
    /* 官方存储面板分类图例色由 Vue 内联 style 控制，CSS 只能 !important 反制 */
    .settings-view span.w-1.h-5.rounded-full{background:#ff9ec2!important}
    :root[data-sakura-night="1"] .settings-view span.w-1.h-5.rounded-full{background:#e98eaa!important}
    /* ============ 🩹 v19.7.1：适配官方 1.9.7 夜间体系重写 ============ */
    /* ① 官方夜间蓝变量 → 粉系（所有吃 var(--night-*) 的官方规则自动变粉） */
    :root:root[data-app-theme="dark"]{
        --night-accent:#f0a8bd!important;
        --night-primary:#c2477a!important;
        --night-primary-hover:#a83a66!important;
        --night-selected:#412832!important;
        --night-tint:#3b2730!important;
    }
    :root:root[data-app-theme="dark"] .msg-bubble-glass{--bubble-rgb:43,34,38!important}
    /* ② 夜间：官方 1.9.7 新增的硬编码蓝边框 → 品牌深粉 */
    :root:root:root[data-app-theme="dark"] :is([class~="border-blue-100"],[class~="border-blue-200"],[class~="border-blue-200/50"],[class~="border-blue-200/60"],
        [class~="border-primary-100"],[class~="border-primary-200"],[class~="border-primary-200/80"],
        [class~="border-primary-300"],[class~="border-primary-300/50"],[class~="border-primary-400"],
        [class~="border-primary-500"],[class~="border-primary-600"],
        [class~="focus:border-blue-400"],[class~="focus:border-primary-400"],[class~="focus:border-primary-500"],
        [class~="hover:border-primary-200"],[class~="hover:border-primary-300"],[class~="hover:border-primary-400"]){border-color:#5c3a46!important}
    /* ③ 夜间：官方 Tailwind ring 环 → 品牌粉 */
    :root:root:root[data-app-theme="dark"] :is([class~="focus-visible:ring-primary-500/40"],[class~="focus:ring-blue-100"],
        [class~="focus:ring-primary-100"],[class~="focus:ring-primary-300"],[class~="focus:ring-primary-400"],
        [class~="focus:ring-primary-500"],[class~="focus:ring-primary-500/10"],[class~="focus:ring-primary-500/20"],
        [class~="focus:ring-primary-500/30"],[class~="ring-primary-500"],[class~="ring-primary-500/10"]){--tw-ring-color:rgba(255,107,149,.45)!important}
    /* ④ 官方 1.9.7 新加控件/导航/开关的夜间蓝 */
    :root:root[data-app-theme="dark"] .compact-range{background-color:#3d2b33!important;accent-color:#ff6b95!important}
    :root:root[data-app-theme="dark"] .chat-quick-panel .compact-range{background:linear-gradient(#3d2b33,#3d2b33) center / 100% 3px no-repeat!important}
    :root:root[data-app-theme="dark"] .compact-range::-webkit-slider-thumb{background:#ff6b95!important}
    :root:root[data-app-theme="dark"] .compact-range::-moz-range-thumb{background:#ff6b95!important}
    :root:root[data-app-theme="dark"] :is(input,textarea,select){caret-color:#ff6b95!important}
    :root:root[data-app-theme="dark"] :is(.app-nav-trigger:not(.app-nav-trigger--chat),.app-navigation-close,.app-navigation-section h3,.app-navigation-icon){color:#c9a2b0!important}
    :root:root[data-app-theme="dark"] .app-navigation-item.is-current{border-color:#7a4a5c!important;color:#ffeaf0!important}
    :root:root[data-app-theme="dark"] .app-navigation-item.is-current .app-navigation-icon{color:#ff9ec2!important}
    :root:root[data-app-theme="dark"] .app-navigation-brand em{color:#d891a8!important}
    :root:root[data-app-theme="dark"] .segmented-switch__indicator{box-shadow:inset 0 0 0 1px #7a4a5c!important}
    :root:root[data-app-theme="dark"] .settings-toggle-input:checked + .settings-toggle{background:#c2477a!important}
    :root:root[data-app-theme="dark"] .settings-toggle-input:not(:checked) + .settings-toggle::after{border-color:#5a4149!important}
    :root:root[data-app-theme="dark"] .settings-view .settings-control:focus{border-color:#ff9ec2!important;box-shadow:0 0 0 3px rgba(255,158,194,.18)!important}
    :root:root[data-app-theme="dark"] .app-navigation-layer::before{background:rgba(30,20,24,.24)!important}
    :root:root[data-app-theme="dark"] .character-deck__backdrop{background:#2b2628!important}
    :root:root[data-app-theme="dark"] .character-deck__backdrop::after{background:linear-gradient(180deg,rgba(32,26,28,.7),rgba(32,26,28,.4) 50%,rgba(32,26,28,.75))!important}
    :root:root[data-app-theme="dark"] :is(.ui-template-pending-icon,.ui-template-pending-icon .live-dots){background:#3d2b33!important;color:#ff9ec2!important}
    :root:root[data-app-theme="dark"] .tab-slider{background:#ff6b95!important}
    /* ⑤ 官方 1.9.7 夜间气泡 !important 抢了插件日间底 → 提升特异性抢回 */
    :root:root:root[data-sakura-night="1"] .msg-bubble-glass{background-color:#2b2226!important;border-color:#4a3a42!important}
    :root:root:root[data-sakura-night="1"] .msg-bubble-glass[class~="bg-blue-50/85"]{background-color:#2b2226!important}
    :root:root:root[data-sakura-night="1"] .msg-bubble-glass[class~="bg-red-50/70"]{background-color:#422c3a!important}
    :root:root:root[data-sakura-night="1"] div[data-role="user"] .msg-bubble-glass{background:#3d3236!important;border-color:#ff6b95!important;color:#ececec!important}
    /* ⑥ 官方 1.9.7 夜间消息操作按钮蓝底蓝字 → 品牌粉 */
    :root:root[data-sakura-night="1"] :is(.message-action-button:hover,.message-action-button:focus-visible,.message-style-filter-button.is-active){background:rgba(255,107,149,.16)!important;color:#ffb3c6!important}
    /* ⑦ 特异性压制：官方 1.9.7 用 :is() 把 meta-badge/placement 抬到 (0,3,0)，插件必须抬更高 */
    :root:root:root[data-sakura-night="1"] :is(.meta-badge--global,.message-placement.is-selected){--badge-color:#ff9ec2!important;--badge-bg:#412832!important;--badge-border:#6b4653!important}
    :root:root:root[data-sakura-night="1"] .message-placement{--badge-color:#ff8ab0!important;--badge-bg:#41323a!important;--badge-border:#5f3b4b!important}
    :root:root:root[data-sakura-night="1"] .message-placement-check{background:#3b3b3b!important;border-color:#6b4653!important}
    :root:root:root[data-sakura-night="1"] .message-placement.is-selected .message-placement-check{background:#ff6b95!important;border-color:#ff6b95!important}
    :root:root:root[data-sakura-night="1"] .segmented-switch__indicator{background:#412832!important;box-shadow:inset 0 0 0 1px #7a4a5c!important}
    /* 日间也用高特异性锁一遍，防官方 Tailwind 运行时反压 */
    :root:root:root .meta-badge--global{--badge-color:#b0466e!important;--badge-bg:#fff0f5!important;--badge-border:#f7c6d8!important}
    :root:root:root .message-placement.is-selected{background:#ffeaf2!important;border-color:#ff6b95!important;color:#ff6b95!important}
    :root:root:root .message-placement.is-selected .message-placement-check{background:#ff6b95!important;border-color:#ff6b95!important}


    [class~="bg-primary-300"],[class~="bg-blue-300"],[class~="bg-indigo-300"]{background:rgba(255,193,214,.92)!important}
    @media (prefers-reduced-motion:reduce){
        *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.001ms!important}
    }
    `;
    styleEl.textContent = cssLegacy + '\n' + css + '\n' + cssPolish;
    (document.head || document.documentElement).appendChild(styleEl);

    // 🎯 追加：添加角色卡弹窗三个导入选项 + 消息操作按钮全面粉化（覆盖官方默认蓝）+ 滚动锚定禁用
    const choiceCardCss = `
    .choice-card:hover{border-color:#ffb3c6!important;background:#fff0f5!important;color:#d43b60!important}
    .choice-card:hover .choice-card__icon{transform:scale(1.1)!important}
    .choice-card__icon svg,.choice-card .choice-card__icon svg{color:#ff6b95!important}
    @media (prefers-color-scheme: dark){.choice-card:hover{border-color:rgba(255,140,170,.4)!important;background:rgba(80,42,58,.95)!important;color:#ffa3b8!important}.choice-card__icon svg,.choice-card .choice-card__icon svg{color:#ff7597!important}}
    :root{--sakura-theme-color:#ff6b95!important}
    .sakura-clean-view-btn{background:transparent!important;color:rgba(255,255,255,.7)!important;box-shadow:none!important;transform:none!important}
    .sakura-clean-view-btn:hover,.sakura-clean-view-btn:focus-visible{background:rgba(255,255,255,.1)!important;color:#fff!important;box-shadow:none!important;outline:none!important}
    .sakura-clean-view-btn:active{background:rgba(255,255,255,.1)!important;color:#fff!important;transform:none!important}
    /* v18.3：右上角新增工具按钮只跟随官方透明白灰，不再使用主题色。 */
    .chat-view-root .sakura-clean-view-btn{background:transparent!important;color:rgba(255,255,255,.7)!important;border:0!important;box-shadow:none!important;transform:none!important}
    .chat-view-root .sakura-clean-view-btn:hover,.chat-view-root .sakura-clean-view-btn:focus-visible{background:rgba(255,255,255,.1)!important;color:#fff!important;box-shadow:none!important;outline:none!important}
    .chat-view-root .sakura-clean-view-btn:active{background:rgba(255,255,255,.1)!important;color:#fff!important;transform:none!important}

    .message-action-button{-webkit-tap-highlight-color:transparent!important}
    /* ================== 🌙 v19.5.9 夜间适配层（已并入主主题重映射池） ==================
       关键变化：不再单独挂 <style>，而是并入 cssPolish → 随 applyThemeColor() 一起做
       色相旋转。因此这里写死的粉系字面量会自动跟随自定义主题色；中性灰（s<8）
       不会被误转。强调项统一用 var(--sakura-theme-color)，保证「蓝色主题」在夜间呈蓝。 */
    :root[data-sakura-night="1"]{color-scheme:dark}

    /* v19.6.2 夜间官方白底兜底：官方 theme.css 未覆盖 bg-white 弹层面板（如模型选择器 model-selector-panel）、
       默认会呈现白底白字（插件已把标题提亮）而无法阅读。此处统一翻深灰并压低边框亮度；
       放在本层最前，后续插件更具体规则（sakura-* / 导航 / 气泡）仍可覆盖。 */
    :root[data-sakura-night="1"] [class~="bg-white"],
    :root[data-sakura-night="1"] [class~="bg-white/95"],
    :root[data-sakura-night="1"] [class~="bg-white/90"],
    :root[data-sakura-night="1"] [class~="bg-white/80"],
    :root[data-sakura-night="1"] [class~="bg-white/70"],
    :root[data-sakura-night="1"] [class~="bg-gray-50/40"],
    :root[data-sakura-night="1"] [class~="bg-gray-50/60"],
    :root[data-sakura-night="1"] [class~="bg-gray-100"],
    :root[data-sakura-night="1"] [class~="bg-gray-100/70"]{background-color:#343434!important;border-color:#4a4a4a!important}
    :root[data-sakura-night="1"] [class~="bg-gray-200"],
    :root[data-sakura-night="1"] [class~="bg-gray-200/70"]{background-color:#3d3d3d!important}
    :root[data-sakura-night="1"] [class~="text-gray-900"]{color:#eaeaea!important}
    :root[data-sakura-night="1"] [class~="border-gray-100"],
    :root[data-sakura-night="1"] [class~="border-gray-200"],
    :root[data-sakura-night="1"] [class~="border-gray-200/70"],
    :root[data-sakura-night="1"] [class~="border-gray-200/50"]{border-color:#4a4a4a!important}

    /* —— 官方顶栏 / 设置页头部：日间被插件刷成近白粉，夜间必须翻深 —— */
    :root[data-sakura-night="1"] .settings-page-header{background:rgba(46,46,46,.82)!important;border-bottom-color:rgba(255,255,255,.08)!important}

    /* —— 插件自建弹窗骨架 —— */
    :root[data-sakura-night="1"] .sakura-box{background:#333!important;border-color:#4a4a4a!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 28px 72px -20px rgba(0,0,0,.78)!important}
    :root[data-sakura-night="1"] .sakura-mask{background:rgba(10,8,10,.64)!important}
    :root[data-sakura-night="1"] .sakura-head{background:#3d3d3d!important;border-bottom-color:#4a4a4a!important}
    :root[data-sakura-night="1"] .sakura-body{background:#333!important}
    :root[data-sakura-night="1"] .sakura-foot{background:#383838!important;border-top-color:#4a4a4a!important}
    :root[data-sakura-night="1"] .sakura-title-with-icon{color:#ecdfe3!important}
    :root[data-sakura-night="1"] .sakura-sub{color:#b7a0aa!important}
    :root[data-sakura-night="1"] .sakura-close-btn{color:#b7a0aa!important}
    :root[data-sakura-night="1"] .sakura-close-btn:hover{color:var(--sakura-theme-color,#ff6b95)!important;background:#463a40!important}

    /* —— 输入域 —— */
    :root[data-sakura-night="1"] .sakura-input,
    :root[data-sakura-night="1"] .sakura-note-area{background:#3b3b3b!important;border-color:#555!important;color:#f0f0f0!important}
    :root[data-sakura-night="1"] .sakura-input::placeholder,
    :root[data-sakura-night="1"] .sakura-note-area::placeholder{color:#8f8f8f!important}
    :root[data-sakura-night="1"] .sakura-note-area:focus{background:#414141!important;border-color:var(--sakura-theme-color,#ff8ab0)!important}

    /* —— 按钮 —— */
    :root[data-sakura-night="1"] .sakura-btn{background:#414141!important;border-color:#575757!important;color:#e0d2d7!important}
    :root[data-sakura-night="1"] .sakura-btn--quiet{background:#3a3a3a!important;color:#b7a0aa!important;border-color:#4e4e4e!important}
    :root[data-sakura-night="1"] .sakura-btn--main{background:var(--sakura-theme-color,#e8457a)!important;border-color:var(--sakura-theme-color,#ff5f92)!important;color:#fff!important}

    /* —— 模型列表 —— */
    :root[data-sakura-night="1"] .sakura-model-row{background:#3a3a3a!important;border-color:#4d4d4d!important}
    :root[data-sakura-night="1"] .sakura-model-row:hover,
    :root[data-sakura-night="1"] .sakura-model-row:active{background:#454545!important;border-color:var(--sakura-theme-color,#ff8ab0)!important}
    :root[data-sakura-night="1"] .sakura-model-row.is-selected{background:#41323a!important;border-color:var(--sakura-theme-color,#ff6b95)!important}
    :root[data-sakura-night="1"] .sakura-model-core-name{color:#f4e6ec!important}
    :root[data-sakura-night="1"] .sakura-model-prefix-tag{background:#4a3a44!important;color:#ffb0c4!important;border-color:#6b4654!important}
    :root[data-sakura-night="1"] .sakura-model-check{color:var(--sakura-theme-color,#ff8ab0)!important}
    :root[data-sakura-night="1"] .sakura-empty,
    :root[data-sakura-night="1"] .sakura-model-loading{color:#b7a0aa!important}

    /* —— 标签栏 / 供应商下拉 —— */
    :root[data-sakura-night="1"] .sakura-tag-btn{background:#3f3f3f!important;border-color:#565656!important;color:#dcc4cf!important}
    :root[data-sakura-night="1"] .sakura-tag-btn:hover{background:#484848!important;border-color:var(--sakura-theme-color,#ff8ab0)!important}
    :root[data-sakura-night="1"] .sakura-provider-menu{background:#343434!important;border-color:#575757!important}
    :root[data-sakura-night="1"] .sakura-provider-option{color:#e6e6e6!important}
    :root[data-sakura-night="1"] .sakura-provider-option:hover{background:#454545!important}

    /* —— 设置页「樱花个性化」卡片：标题跟随主题色 —— */
    :root[data-sakura-night="1"] .sakura-personal-card{background:linear-gradient(145deg,#3b3b3b,#333)!important;border-color:#4d4d4d!important}
    :root[data-sakura-night="1"] .sakura-personal-card:hover{background:linear-gradient(145deg,#454545,#3b3b3b)!important;border-color:var(--sakura-theme-color,#ff8ab0)!important}
    :root[data-sakura-night="1"] .sakura-personal-card-title{color:var(--sakura-theme-color,#ffa9c0)!important}
    :root[data-sakura-night="1"] .sakura-personal-card-desc{color:#c0a8b2!important}
    :root[data-sakura-night="1"] .sakura-personal-card::after{color:#8d6d7a!important}

    /* —— 记忆区操作按钮 / 导入导出 —— */
    /* V20 原生派：记忆按钮夜间跟随官方变量，去掉硬编码深灰 */
    :root[data-sakura-night="1"] .sakura-mem-actions>button,
    :root[data-sakura-night="1"] .sakura-mem-edit,
    :root[data-sakura-night="1"] .sakura-mem-del,
    :root[data-sakura-night="1"] .sakura-mem-io-export,
    :root[data-sakura-night="1"] .sakura-mem-io-import{background:transparent!important;border-color:transparent!important;color:var(--c-text-3,#c9c9c9)!important}
    :root[data-sakura-night="1"] .sakura-mem-actions>button:hover,
    :root[data-sakura-night="1"] .sakura-mem-edit:hover,
    :root[data-sakura-night="1"] .sakura-mem-del:hover{background:rgb(var(--gray-500,172 172 185) / .14)!important;border-color:transparent!important;color:#ffa9c0!important}

    /* —— 留声机 / 名场面 —— */
    :root[data-sakura-night="1"] #sakura-gramophone-panel,
    :root[data-sakura-night="1"] #sakura-moments-mask .sakura-box,
    :root[data-sakura-night="1"] #sakura-moment-naming .sakura-box,
    :root[data-sakura-night="1"] #sakura-moment-confirm .sakura-box{background:#3b3b3b!important;border-color:#4d4d4d!important;color:#e6e6e6!important}

    /* —— 分流设置卡片 —— */
    :root[data-sakura-night="1"] .sakura-native-split-card{background:#3b3b3b!important;border-color:#4d4d4d!important}
    :root[data-sakura-night="1"] .sakura-native-split-card .settings-collapse-trigger{color:#e6e6e6!important}
    :root[data-sakura-night="1"] .sakura-native-split-card .settings-collapse-trigger:hover{background:#454545!important}
    :root[data-sakura-night="1"] .sakura-native-split-card .text-gray-800,
    :root[data-sakura-night="1"] .sakura-native-split-card .text-gray-700,
    :root[data-sakura-night="1"] .sakura-native-split-card .text-gray-600{color:#e4e4e4!important}
    :root[data-sakura-night="1"] .sakura-native-split-card .text-gray-500{color:#ababab!important}
    :root[data-sakura-night="1"] .sakura-native-split-card .border-gray-100,
    :root[data-sakura-night="1"] .sakura-native-split-card .border-gray-200{border-color:#4d4d4d!important}
    :root[data-sakura-night="1"] .sakura-native-split-card .sakura-provider-current-btn{background:#3f3f3f!important;border-color:#555!important;color:#e8e8e8!important}
    :root[data-sakura-night="1"] .sakura-native-split-card .sakura-split-input{background:#3b3b3b!important;border-color:#555!important;color:#f0f0f0!important}
    :root[data-sakura-night="1"] .sakura-native-split-card .sakura-split-input::placeholder{color:#8f8f8f!important}
    :root[data-sakura-night="1"] .sakura-native-split-card .sakura-split-icon-badge{background:#454545!important;color:#c9c9c9!important}

    /* —— 官方新版模型选择器 —— */
    :root[data-sakura-night="1"] .model-selector-heading h3,
    :root[data-sakura-night="1"] .model-selector-heading .text-gray-900{color:#f2f2f2!important}
    :root[data-sakura-night="1"] .model-selector-list .text-gray-500,
    :root[data-sakura-night="1"] .model-selector-list .text-gray-800{color:#d6d6d6!important}
    :root[data-sakura-night="1"] .model-selector-list button:not([aria-pressed="true"]){background:#3a3a3a!important;border-color:#4d4d4d!important}
    :root[data-sakura-night="1"] .model-selector-list button:not([aria-pressed="true"]) span{color:#e4e4e4!important}
    :root[data-sakura-night="1"] .model-selector-list button[aria-pressed="true"]{background:#41323a!important;border-color:var(--sakura-theme-color,#ff8ab0)!important}
    :root[data-sakura-night="1"] .model-selector-list button[aria-pressed="true"] span,
    :root[data-sakura-night="1"] .model-selector-list button[aria-pressed="true"] svg{color:#f0dbe2!important}

    /* —— 官方对话气泡（用户侧）：日间被插件刷成浅粉，夜间必须翻深灰 —— */
    :root[data-sakura-night="1"] div[data-role="user"] .msg-bubble-glass{background:#3d3d3d!important;border-color:var(--sakura-theme-color,#ff6b95)!important;box-shadow:0 4px 14px rgba(0,0,0,.28)!important;color:#ececec!important}
    :root[data-sakura-night="1"] div[data-role="user"] .markdown-body{color:inherit!important}

    /* —— 官方输入岛 / 输入框：夜间翻深 —— */
    :root[data-sakura-night="1"] .input-island,

    /* —— 动作按钮栏 / 思考卡片 / Toast —— */
    :root[data-sakura-night="1"] .app-main .message-action-bar{background:transparent!important;border-top-color:rgba(255,255,255,.08)!important}
    :root[data-sakura-night="1"] .app-main .message-action-button:hover,
    :root[data-sakura-night="1"] .app-main .message-action-button:focus-visible{background:rgba(255,255,255,.08)!important;color:#f0f0f0!important}
    :root[data-sakura-night="1"] .native-thinking-card,
    :root[data-sakura-night="1"] .cot-ui{background:#373737!important;border-color:#4d4d4d!important}
    :root[data-sakura-night="1"] .toast-item,
    :root[data-sakura-night="1"] .toast-stack>div{background:rgba(55,55,55,.96)!important;border-color:#555!important;color:#ececec!important}
    :root[data-sakura-night="1"] .typing-timer-badge{background:rgba(55,55,55,.8)!important;border-color:#555!important;color:#c9c9c9!important}

    /* ========== v19.5.9 补充：导航面板 / 快捷面板 / 官方组件全面日夜适配 ========== */

    /* —— 浮空导航面板：日间被插件刷成浅粉白，夜间必须翻深 —— */
    :root[data-sakura-night="1"] .app-navigation-layer::before{background:rgba(0,0,0,.5)!important}
    :root[data-sakura-night="1"] .app-navigation-panel{background:linear-gradient(145deg,#333,#2c2c2c)!important;border-color:#464646!important;color:#e6e6e6!important;box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 22px 52px -22px rgba(0,0,0,.8)!important}
    :root[data-sakura-night="1"] .app-navigation-header{border-bottom-color:#464646!important}
    :root[data-sakura-night="1"] .app-navigation-brand > span{color:#e8dde1!important}
    :root[data-sakura-night="1"] .app-navigation-brand em{color:#b09aa3!important}
    :root[data-sakura-night="1"] .app-navigation-close{color:#b09aa3!important}
    :root[data-sakura-night="1"] .app-navigation-close:hover{color:var(--sakura-theme-color,#ff6b95)!important;background:#3d3d3d!important}
    :root[data-sakura-night="1"] .app-navigation-section h3{color:#a89aa0!important}
    :root[data-sakura-night="1"] .app-navigation-item{background:#3a3a3a!important;border-color:#4a4a4a!important;color:#ded2d7!important}
    :root[data-sakura-night="1"] .app-navigation-item .app-navigation-icon{color:#b09aa3!important;background:#434343!important}
    :root[data-sakura-night="1"] .app-navigation-item:hover{background:#444!important;border-color:var(--sakura-theme-color,#ff8ab0)!important;color:#f0f0f0!important}
    :root[data-sakura-night="1"] .app-navigation-item:hover .app-navigation-icon{color:var(--sakura-theme-color,#ff6b95)!important}
    :root[data-sakura-night="1"] .app-navigation-item.is-current{color:#f0e2e7!important;background:#41323a!important;border-color:var(--sakura-theme-color,#ff8ab0)!important;box-shadow:none!important}
    :root[data-sakura-night="1"] .app-navigation-item.is-current .app-navigation-icon{color:var(--sakura-theme-color,#ff6b95)!important;background:#4a3a44!important}
    :root[data-sakura-night="1"] .app-navigation-user{background:#3a3a3a!important;border-color:#4a4a4a!important}
    :root[data-sakura-night="1"] .app-navigation-user strong{color:#e8dde1!important}
    :root[data-sakura-night="1"] .app-nav-trigger--embedded{color:#e0d2d7!important;background:#3a3a3a!important;border-color:#4a4a4a!important;box-shadow:none!important}
    :root[data-sakura-night="1"] .app-nav-trigger--embedded:hover{color:var(--sakura-theme-color,#ff6b95)!important}
    :root[data-sakura-night="1"] .app-navigation-content::-webkit-scrollbar-thumb{background:#555!important}
    :root[data-sakura-night="1"] .app-navigation-content::-webkit-scrollbar-track{background:transparent!important}

    /* —— 对话页快捷面板（chat-quick-panel）：官方在暗色下已处理，这里只补插件覆盖不到的字 —— */
    :root[data-sakura-night="1"] .chat-quick-panel{background:rgba(45,45,45,.96)!important;border-color:rgba(255,255,255,.1)!important;box-shadow:0 12px 40px rgba(0,0,0,.5)!important}
    :root[data-sakura-night="1"] .chat-quick-panel .text-gray-700,
    :root[data-sakura-night="1"] .chat-quick-panel .text-gray-600,
    :root[data-sakura-night="1"] .chat-quick-panel .text-gray-500{color:#c9c9c9!important}
    :root[data-sakura-night="1"] .chat-quick-panel .bg-gray-50,
    :root[data-sakura-night="1"] .chat-quick-panel .bg-gray-100\/70{background:#3a3a3a!important}
    :root[data-sakura-night="1"] .chat-quick-panel .border-gray-200\/70{border-color:#4a4a4a!important}
    :root[data-sakura-night="1"] .chat-model-slots .segmented-switch__indicator{background:#4a3a44!important}

    /* —— 通用：夜间所有残留白底卡片/输入框兜底 —— */
    :root[data-sakura-night="1"] .settings-card{background:#373737!important;border-color:#4a4a4a!important}
    :root[data-sakura-night="1"] .settings-view .settings-control{background:#303030!important;color:#e4e4e4!important;border-color:#4a4a4a!important}
    :root[data-sakura-night="1"] .settings-label{color:#c2c2c2!important}
    :root[data-sakura-night="1"] .settings-action{background:#3d3d3d!important;border-color:#4a4a4a!important;color:#e4e4e4!important}
    :root[data-sakura-night="1"] .settings-icon-button{background:#3d3d3d!important;border-color:#4a4a4a!important;color:#c9c9c9!important}
    /* —— v19.6.3 正则脚本「高级选项」选择卡：夜间深底 + 品牌色，避免亮粉底压深字 —— */
    :root[data-sakura-night="1"] .message-placement{--badge-color:#ff8ab0;--badge-bg:#41323a;--badge-border:#5f3b4b;background:#333!important;border-color:#4a4a4a!important;color:#c2c2c2!important}
    :root[data-sakura-night="1"] .message-placement-check{background:#3b3b3b!important;border-color:#555!important}
    :root[data-sakura-night="1"] .message-placement.is-selected{background:#41323a!important;border-color:var(--sakura-theme-color,#ff6b95)!important;color:#f0dbe2!important}
    :root[data-sakura-night="1"] .message-placement.is-selected .message-placement-check{background:var(--sakura-theme-color,#ff6b95)!important;border-color:var(--sakura-theme-color,#ff6b95)!important}
    /* v19.6.5：官方夜间给 segmented-switch__indicator 加了官方蓝内框 box-shadow: inset 0 0 0 1px #5b87cb，
       与插件主题色底并排就是“蓝框+主题色”双色的怪状。这里用主题色描边接管。 */
    :root[data-sakura-night="1"] .segmented-switch,
    :root[data-sakura-night="1"] .settings-view .segmented-switch{background:#303030!important;border-color:#4a4a4a!important;box-shadow:none!important}
    :root[data-sakura-night="1"] .segmented-switch__indicator{background:#41323a!important;box-shadow:inset 0 0 0 1px var(--sakura-theme-color,#ff6b95)!important}
    :root[data-sakura-night="1"] .segmented-switch__option{color:#9a9a9a!important}
    :root[data-sakura-night="1"] .segmented-switch__option.is-active{color:#f1f1f1!important}
    /* —— v19.6.3 配套夜间反制：上述日间块带 !important，夜间必须翻深，
       否则设置页图标方块/记忆压缩条会呈浅底方块。使用注入的 --night-* 品牌变量。 —— */
    :root[data-sakura-night="1"] .settings-card__title > svg{background:#3b3b3b!important;color:#e0a8bd!important}
    :root[data-sakura-night="1"] .memory-compression__track{background:#3d3d3d!important}
    :root[data-sakura-night="1"] .memory-compression__fill{background:linear-gradient(90deg,#c2477a,#ff9dbb)!important}
    :root[data-sakura-night="1"] .memory-compression__before{color:#9a9a9a!important}
    :root[data-sakura-night="1"] .memory-compression__after{color:#ff9dbb!important}
    :root[data-sakura-night="1"] .memory-compression__marker-before{background:#6b6b6b!important}
    :root[data-sakura-night="1"] .memory-compression__marker-after{background:#ff9dbb!important}
    :root[data-sakura-night="1"] [class~="bg-primary-300"]{background:#c2477a!important}
    :root[data-sakura-night="1"] .settings-create-button{color:#fff!important;border-color:var(--sakura-theme-color,#ff6b95)!important}
    :root[data-sakura-night="1"] .settings-subheading,
    :root[data-sakura-night="1"] .settings-card__title{color:#e4e4e4!important}

    /* —— 通用：夜间官方灰字统一抬亮，避免看不清 —— */
    :root[data-sakura-night="1"] .text-gray-800,
    :root[data-sakura-night="1"] .text-gray-700{color:#e4e4e4!important}
    :root[data-sakura-night="1"] .text-gray-600{color:#d0d0d0!important}
    :root[data-sakura-night="1"] .text-gray-500{color:#b4b4b4!important}
    :root[data-sakura-night="1"] .text-gray-400{color:#9a9a9a!important}

    /* —— 日间：确保浅底上的主题色文字足够深（对比度）—— */
    :root:not([data-sakura-night="1"]) .settings-model-button .text-gray-700{color:#3f3f46!important}
    :root:not([data-sakura-night="1"]) .model-selector-list button:not([aria-pressed="true"]) span{color:#3f3f46!important}



    `;
    const choiceCardStyle = document.createElement('style');
    choiceCardStyle.textContent = choiceCardCss;
    (document.head || document.documentElement).appendChild(choiceCardStyle);

    // ================= 🎨 全局主题换色引擎（粉系色相整体重映射） =================
    // 原理：全站视觉由本文件注入的 CSS 驱动；换主题时对整段 CSS 文本做一次
    // 「樱花粉家族 → 目标色相家族」的确定性重映射。非粉色语义色（状态绿、琥珀警示、
    // 中性黑白灰、深色遮罩）通过 HSL 分类保持原样；边框/底色/阴影/夜间模式的深浅层次
    // 按原始亮度与饱和度比例自动继承，保证任何主色下整套界面协调。
    function themeClamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
    function themeNormalizeHex(value) {
        let hex = String(value == null ? '' : value).trim().replace(/^#/, '');
        if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.split('').map(c => c + c).join('');
        if (!/^[0-9a-fA-F]{6}$/.test(hex)) return '';
        return '#' + hex.toLowerCase();
    }
    function themeHexToRgb(hex) {
        const norm = themeNormalizeHex(hex);
        if (!norm) return null;
        const n = parseInt(norm.slice(1), 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    function themeRgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h = 0, s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }
        return { h: h, s: s * 100, l: l * 100 };
    }
    function themeHslToRgb(h, s, l) {
        h = ((h % 360) + 360) % 360;
        s = themeClamp(s, 0, 100) / 100;
        l = themeClamp(l, 0, 100) / 100;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c / 2;
        let rp = 0, gp = 0, bp = 0;
        if (h < 60) { rp = c; gp = x; }
        else if (h < 120) { rp = x; gp = c; }
        else if (h < 180) { gp = c; bp = x; }
        else if (h < 240) { gp = x; bp = c; }
        else if (h < 300) { rp = x; bp = c; }
        else { rp = c; bp = x; }
        return { r: Math.round((rp + m) * 255), g: Math.round((gp + m) * 255), b: Math.round((bp + m) * 255) };
    }
    function themeRgbToHex(r, g, b) {
        const to = v => ('0' + themeClamp(Math.round(v), 0, 255).toString(16)).slice(-2);
        return '#' + to(r) + to(g) + to(b);
    }
    const THEME_KEY = 'rphub_theme_color_v1';
    const THEME_DEFAULT = '#ff6b95';
    const THEME_ANCHOR_HUE = themeRgbToHsl(255, 107, 149).h;
    // 「樱花家族」判定 v2：不只认亮色高饱和粉。夜间模式的深底色、侧栏渐变、灰玫瑰
    // 文字本质都是低饱和粉（黑里掺粉），只看饱和度会被漏掉，导致换主题后夜间配色
    // 仍是旧粉系。现在统一按「色相落在 290°-360° 且带一点彩度」认定，夜间整套配色
    // 跟随主题一起旋转；纯黑白灰与状态语义色（s<8 或色相不在区间）依旧保持原样。
    function themeIsAccentFamily(r, g, b) {
        const hsl = themeRgbToHsl(r, g, b);
        if (hsl.s < 8 || hsl.l < 4 || hsl.l > 99.6) return false;
        return hsl.h >= 290 && hsl.h <= 360.01;
    }
    function themeShiftRgb(r, g, b, targetHex) {
        const target = themeHexToRgb(targetHex);
        if (!target) return { r: r, g: g, b: b };
        const targetHsl = themeRgbToHsl(target.r, target.g, target.b);
        const cur = themeRgbToHsl(r, g, b);
        const deltaH = ((targetHsl.h - THEME_ANCHOR_HUE + 540) % 360) - 180;
        const nextS = themeClamp(cur.s * (targetHsl.s / 82), 0, 100);
        return themeHslToRgb(cur.h + deltaH, nextS, cur.l);
    }
    function themeRecolorCss(cssText, targetHex) {
        const norm = themeNormalizeHex(targetHex);
        if (!norm || norm === THEME_DEFAULT) return String(cssText || '');
        const hexCache = new Map();
        const rgbCache = new Map();
        const remapHexToken = raw => {
            const key = String(raw).toLowerCase();
            if (hexCache.has(key)) return hexCache.get(key);
            let hex = key;
            if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
            let out = hex;
            const n = parseInt(hex, 16);
            const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
            if (themeIsAccentFamily(r, g, b)) {
                const shifted = themeShiftRgb(r, g, b, norm);
                out = themeRgbToHex(shifted.r, shifted.g, shifted.b).slice(1);
            }
            hexCache.set(key, out);
            return out;
        };
        return String(cssText || '')
            .replace(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(,\s*[\d.]+\s*)?\)/g, (m, r, g, b, alpha) => {
                const key = r + '|' + g + '|' + b;
                if (!rgbCache.has(key)) {
                    const ri = Number(r), gi = Number(g), bi = Number(b);
                    rgbCache.set(key, themeIsAccentFamily(ri, gi, bi)
                        ? (t => t.r + ',' + t.g + ',' + t.b)(themeShiftRgb(ri, gi, bi, norm))
                        : r + ',' + g + ',' + b);
                }
                return (alpha !== undefined ? 'rgba(' : 'rgb(') + rgbCache.get(key) + (alpha !== undefined ? alpha : '') + ')';
            })
            .replace(/%23([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g, (m, hx) => '%23' + remapHexToken(hx))
            .replace(/(?<!%)#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g, (m, hx) => '#' + remapHexToken(hx));
    }
    const THEME_ORIG_MAIN_CSS = cssLegacy + '\n' + css + '\n' + cssPolish;
    const THEME_ORIG_CHOICE_CSS = choiceCardCss;
    function themeStoredColor() {
        try { return themeNormalizeHex(pluginStorage.getItem(THEME_KEY) || ''); } catch (_) { return ''; }
    }
    // 官方 theme.css 用 :root[data-app-theme="dark"] :is(.bg-primary-600,...){background:var(--night-primary)!important}
    // 把主色钉成官方蓝。这里同源覆盖官方 --night-* 变量（内联优先级高于样式表常规声明），
    // 让官方自己的规则跟着插件主题色走，避免“官方蓝盖主题色”。
    function applyNightVars(targetHex) {
        const root = document.documentElement;
        const norm = themeNormalizeHex(targetHex);
        const set = (name, val) => { try { if (val) root.style.setProperty(name, val); else root.style.removeProperty(name); } catch (_) {} };
        // v19.6.1：默认（樱花粉）主题也必须注入同源 --night-* ，否则一旦 removeProperty，
        // 官方 theme.css 的 :root[data-app-theme="dark"]{--night-primary:#426bd8} 会让
        // 官方原生组件（模型选择器/主按钮/导航 current）在夜间回落成官方蓝，与樱花粉主色打架。
        const pick = (norm && norm !== THEME_DEFAULT) ? norm : themeNormalizeHex(THEME_DEFAULT);
        const base = themeHexToRgb(pick);
        if (!base) {
            ['--night-primary', '--night-primary-hover', '--night-accent', '--night-tint', '--night-selected'].forEach(function (n) { set(n, ''); });
            return;
        }
        const hsl = themeRgbToHsl(base.r, base.g, base.b);
        const mk = function (l, sMul) {
            const c = themeHslToRgb(hsl.h, themeClamp(hsl.s * (sMul || 1), 0, 100), l);
            return themeRgbToHex(c.r, c.g, c.b);
        };
        set('--night-primary', mk(58, 1));
        set('--night-primary-hover', mk(64, 1));
        set('--night-accent', mk(76, 0.55));
        set('--night-tint', mk(24, 0.8));
        set('--night-selected', mk(34, 0.9));
    }

    function applyThemeColor(targetHex, options) {
        const opts = options || {};
        const norm = themeNormalizeHex(targetHex);
        try {
            if (!norm || norm === THEME_DEFAULT) {
                styleEl.textContent = THEME_ORIG_MAIN_CSS;
                choiceCardStyle.textContent = THEME_ORIG_CHOICE_CSS;
                document.documentElement.style.setProperty('--sakura-theme-color', THEME_DEFAULT);
                document.documentElement.removeAttribute('data-sakura-accent');
                applyNightVars('');
                if (opts.persist !== false) pluginStorage.removeItem(THEME_KEY);
                return true;
            }
            styleEl.textContent = themeRecolorCss(THEME_ORIG_MAIN_CSS, norm);
            choiceCardStyle.textContent = themeRecolorCss(THEME_ORIG_CHOICE_CSS, norm);
            document.documentElement.style.setProperty('--sakura-theme-color', norm);
            document.documentElement.setAttribute('data-sakura-accent', norm);
            applyNightVars(norm);
            if (opts.persist !== false) pluginStorage.setItem(THEME_KEY, norm);
            return true;
        } catch (e) {
            console.warn('[苏萝萝主题] 应用失败:', e);
            return false;
        }
    }

    const THEME_PRESETS = [
        { name: '樱花粉', value: '#ff6b95' },
        { name: '蜜桃橙', value: '#ff8a5c' },
        { name: '暮山紫', value: '#a78bfa' },
        { name: '海盐蓝', value: '#58a6f5' },
        { name: '抹茶绿', value: '#4ade80' },
        { name: '暗夜金', value: '#e0b35c' }
    ];
    const THEME_SLOTS_KEY = 'rphub_theme_custom_slots_v1';
    function themeLoadSlots() {
        try {
            const arr = JSON.parse(pluginStorage.getItem(THEME_SLOTS_KEY) || '[]');
            return [0, 1, 2].map(i => themeNormalizeHex(arr[i] || ''));
        } catch (_) { return ['', '', '']; }
    }
    function themeSaveSlots(slots) {
        try { pluginStorage.setItem(THEME_SLOTS_KEY, JSON.stringify(slots)); } catch (_) {}
    }
    // v17.6：自定义主题命名。名称与颜色分开存储；旧数据没有名称时自动回退「自定义①②③」。
    const THEME_NAMES_KEY = 'rphub_theme_custom_names_v1';
    function themeLoadNames() {
        try {
            const arr = JSON.parse(pluginStorage.getItem(THEME_NAMES_KEY) || '[]');
            return [0, 1, 2].map(i => (typeof arr[i] === 'string' ? arr[i].trim().slice(0, 12) : ''));
        } catch (_) { return ['', '', '']; }
    }
    function themeSaveNames(names) {
        try { pluginStorage.setItem(THEME_NAMES_KEY, JSON.stringify(names)); } catch (_) {}
    }
    function themeSlotLabel(index) {
        const names = themeLoadNames();
        return names[index] || ('自定义' + '①②③'[index]);
    }
    function themeCurrentLabel() {
        const cur = themeNormalizeHex(document.documentElement.getAttribute('data-sakura-accent') || '');
        if (!cur || cur === themeNormalizeHex(THEME_DEFAULT)) return '默认 · 樱花粉';
        const preset = THEME_PRESETS.find(p => themeNormalizeHex(p.value) === cur);
        if (preset) return preset.name;
        const slotIndex = themeLoadSlots().indexOf(cur);
        if (slotIndex >= 0) return themeSlotLabel(slotIndex);
        return '自定义 ' + cur.toUpperCase();
    }
    // [已移除] 统计栏旁的旧「🎨 主题」按钮入口：功能已迁入设置页「樱花个性化」分区，不再重复注入。

    // ================= 🌸 设置页「樱花个性化」独立分区 =================
    // 位置：官方「高级参数」和「空间管理」之间；样式完全对齐官方原生分区骨架。
    // 后续新增的个性化功能入口统一挂到这里，不再挤备份按钮那一排。
    const SPLASH_CUSTOM_KEY = 'rphub_splash_custom_v1';   // 旧版单图键：仅用于一次性兼容迁移
    const SPLASH_LIST_KEY = 'rphub_splash_list_v1';       // 多图列表键
    const SPLASH_MAX = 8;
    function getSplashList() {
        try {
            const raw = pluginStorage.getItem(SPLASH_LIST_KEY);
            if (raw) {
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) return arr.filter(function (u) { return typeof u === 'string' && u.startsWith('data:image'); }).slice(0, SPLASH_MAX);
            }
        } catch (_) {}
        // 旧单图自动迁移进新列表（v18.9：迁移成功后清掉旧键，防止「删了又复活」）。
        try {
            const legacy = pluginStorage.getItem(SPLASH_CUSTOM_KEY) || '';
            if (legacy.startsWith('data:image')) {
                try {
                    pluginStorage.setItem(SPLASH_LIST_KEY, JSON.stringify([legacy]));
                    pluginStorage.removeItem(SPLASH_CUSTOM_KEY);
                } catch (_) {}
                return [legacy];
            }
        } catch (_) {}
        return [];
    }
    function setSplashList(arr) {
        try {
            const list = (Array.isArray(arr) ? arr : []).filter(function (u) { return typeof u === 'string' && u.startsWith('data:image'); }).slice(0, SPLASH_MAX);
            pluginStorage.setItem(SPLASH_LIST_KEY, JSON.stringify(list));
            return list;
        } catch (_) {
            // v18.9：配额不足兜底——清掉旧版单图键后重试一次；列表将清空时再清图床缓存。
            try {
                const list = (Array.isArray(arr) ? arr : []).filter(function (u) { return typeof u === 'string' && u.startsWith('data:image'); }).slice(0, SPLASH_MAX);
                pluginStorage.removeItem(SPLASH_CUSTOM_KEY);
                if (list.length === 0) { try { pluginStorage.removeItem(CACHE_KEY); } catch (_) {} }
                pluginStorage.setItem(SPLASH_LIST_KEY, JSON.stringify(list));
                return list;
            } catch (_) { return null; }
        }
    }
    // 压缩用户图片：限制最长边、转 webp，防止 localStorage 撑爆。
    function compressSplashImage(file, maxEdge) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error('读取图片失败'));
            reader.onload = () => {
                const img = new Image();
                img.onerror = () => reject(new Error('图片解析失败'));
                img.onload = () => {
                    try {
                        const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
                        const w = Math.max(1, Math.round(img.naturalWidth * scale));
                        const h = Math.max(1, Math.round(img.naturalHeight * scale));
                        const canvas = document.createElement('canvas');
                        canvas.width = w; canvas.height = h;
                        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                        let out = canvas.toDataURL('image/webp', 0.86);
                        if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/jpeg', 0.86);
                        resolve(out);
                    } catch (e) { reject(e); }
                };
                img.src = String(reader.result || '');
            };
            reader.readAsDataURL(file);
        });
    }
    function openSplashPanel() {
        const exist = document.getElementById('sakura-splash-mask');
        if (exist) return;
        const mask = document.createElement('div');
        mask.id = 'sakura-splash-mask';
        mask.className = 'sakura-mask';
        const prevOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
        const unlockScroll = () => { document.documentElement.style.overflow = prevOverflow; };
        const box = document.createElement('div');
        box.className = 'sakura-box';
        const head = document.createElement('div');
        head.className = 'sakura-head';
        head.innerHTML = '<div class="sakura-modal-topbar"><div class="sakura-title-with-icon"><span>🖼️ 开屏图设置</span></div><button type="button" class="sakura-close-btn" title="关闭">✕</button></div><div class="sakura-sub">最多 8 张 · 每次启动随机展示一张</div>';
        const body = document.createElement('div');
        body.className = 'sakura-body';
        // —— 缩略图九宫格：每张可单独删除，未满 8 张时显示「+」继续添加 ——
        const gridWrap = document.createElement('div');
        gridWrap.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.style.display = 'none';
        let splashBusy = false;
        const statusLine = document.createElement('div');
        statusLine.style.cssText = 'margin-top:10px;font-size:11.5px;font-weight:700;color:#c2255c;min-height:16px;';
        const hint = document.createElement('div');
        hint.style.cssText = 'margin-top:10px;font-size:11.5px;color:#a27b89;line-height:1.6;';
        hint.textContent = '支持 JPG / PNG / WEBP，自动压缩。每次启动从列表里随机抽一张展示；删光则回到默认开屏图。';
        const renderGrid = () => {
            gridWrap.innerHTML = '';
            const list = getSplashList();
            list.forEach((url, idx) => {
                const cell = document.createElement('div');
                cell.style.cssText = 'position:relative;border-radius:12px;overflow:hidden;border:1.5px solid rgba(255,204,213,.8);aspect-ratio:16/9;background:linear-gradient(135deg,#fff5f8,#ffe9f0);';
                const im = document.createElement('img');
                im.src = url;
                im.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
                const del = document.createElement('button');
                del.type = 'button';
                del.textContent = '✕';
                del.title = '删除这张';
                del.style.cssText = 'position:absolute;top:3px;right:3px;width:26px;height:26px;border:none;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.3);';
                del.addEventListener('click', () => {
                    const arr = getSplashList();
                    if (idx < 0 || idx >= arr.length) { renderGrid(); return; }
                    arr.splice(idx, 1);
                    const saved = setSplashList(arr);
                    if (!saved) { statusLine.textContent = '⚠️ 删除失败：浏览器存储被锁定或已满，请刷新页面后重试'; return; }
                    renderGrid();
                    statusLine.textContent = '✅ 已删除 1 张，剩余 ' + saved.length + ' 张';
                });
                cell.appendChild(im);
                cell.appendChild(del);
                gridWrap.appendChild(cell);
            });
            if (list.length < SPLASH_MAX) {
                const addCell = document.createElement('button');
                addCell.type = 'button';
                addCell.style.cssText = 'border:1.5px dashed rgba(224,138,166,.7);border-radius:12px;aspect-ratio:16/9;background:rgba(255,241,246,.55);color:#c2255c;font-size:26px;font-weight:300;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;';
                addCell.textContent = '+';
                addCell.addEventListener('click', () => { if (!splashBusy) fileInput.click(); });
                gridWrap.appendChild(addCell);
            }
        };
        fileInput.addEventListener('change', async () => {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = '';
            if (!file || splashBusy) return;
            if (!/^image\//.test(file.type || '')) { statusLine.textContent = '⚠️ 请选择图片文件'; return; }
            splashBusy = true;
            statusLine.textContent = '⏳ 正在压缩图片…';
            try {
                const dataUrl = await compressSplashImage(file, 1600);
                let writable = false;
                try { pluginStorage.setItem(SPLASH_LIST_KEY + '.probe', dataUrl); pluginStorage.removeItem(SPLASH_LIST_KEY + '.probe'); writable = true; } catch (_) {}
                if (!writable) { statusLine.textContent = '⚠️ 图片过大保存失败，请换一张小一点的'; return; }
                const list = getSplashList();
                if (list.length >= SPLASH_MAX) { statusLine.textContent = '⚠️ 最多只能存 ' + SPLASH_MAX + ' 张'; return; }
                list.push(dataUrl);
                const saved = setSplashList(list);
                if (!saved) { statusLine.textContent = '⚠️ 保存失败，存储空间可能已满'; return; }
                renderGrid();
                const kb = Math.round(dataUrl.length * 0.75 / 1024);
                statusLine.textContent = '✅ 已添加（约 ' + kb + ' KB），共 ' + saved.length + ' 张';
            } catch (e) {
                statusLine.textContent = '⚠️ 处理失败：' + (e?.message || '未知错误');
            } finally {
                splashBusy = false;
            }
        });
        renderGrid();
        body.appendChild(gridWrap);
        body.appendChild(fileInput);
        body.appendChild(statusLine);
        body.appendChild(hint);
        const foot = document.createElement('div');
        foot.className = 'sakura-foot';
        const doneBtn = document.createElement('button');
        doneBtn.type = 'button';
        doneBtn.className = 'sakura-btn sakura-btn--main';
        doneBtn.style.marginLeft = 'auto';
        doneBtn.textContent = '完成';
        doneBtn.addEventListener('click', () => { unlockScroll(); mask.remove(); });
        foot.appendChild(doneBtn);
        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        mask.appendChild(box);
        head.querySelector('.sakura-close-btn').onclick = () => { unlockScroll(); mask.remove(); };
        let pressStartedOnMask = false;
        const markPressStart = e => { pressStartedOnMask = (e.target === mask); };
        mask.addEventListener('touchstart', markPressStart, { passive: true });
        mask.addEventListener('mousedown', markPressStart);
        mask.addEventListener('click', e => {
            if (e.target !== mask) return;
            if (!pressStartedOnMask) return;
            if (!e.isTrusted) return;
            unlockScroll();
            mask.remove();
        });
        document.body.appendChild(mask);
    }
    function injectSakuraSettingsSection() {
        if (document.getElementById('sakura-personal-section')) return;
        // 锚点：官方「空间管理」标题（settings-section-heading 内含该文案）所在的分区容器。
        const headings = document.querySelectorAll('h4.settings-section-heading, h4.settings-subheading');
        let storageSection = null;
        for (const h of headings) {
            if ((h.textContent || '').includes('空间管理')) {
                storageSection = h.closest('div.pt-6') || h.parentElement?.parentElement;
                break;
            }
        }
        if (!storageSection || !storageSection.parentElement) return;
        const section = document.createElement('div');
        section.id = 'sakura-personal-section';
        section.className = 'pt-6 border-t border-gray-100 mt-6';
        section.innerHTML = '<h4 class="settings-subheading"><svg class="w-4 h-4 mr-2 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3l1.9 5.8a2 2 0 001.3 1.3L21 12l-5.8 1.9a2 2 0 00-1.3 1.3L12 21l-1.9-5.8a2 2 0 00-1.3-1.3L3 12l5.8-1.9a2 2 0 001.3-1.3L12 3z"></path></svg>樱花个性化</h4><div class="grid grid-cols-1 md:grid-cols-3 gap-4"><button type="button" id="sakura-entry-theme" class="sakura-personal-card" data-entry="theme"><div class="sakura-personal-card-title">🎨 主题换色</div><div class="sakura-personal-card-desc">全站配色自定义，预设与 HEX 任选</div></button><button type="button" id="sakura-entry-splash" class="sakura-personal-card" data-entry="splash"><div class="sakura-personal-card-title">🖼️ 开屏图</div><div class="sakura-personal-card-desc">上传多张开屏图，启动时随机展示</div></button><button type="button" id="sakura-entry-janitor" class="sakura-personal-card" data-entry="janitor"><div class="sakura-personal-card-title">🧹 存储管家</div><div class="sakura-personal-card-desc">透视空间占用 · 一键瘦身与清理</div></button></div>';
        // —— 沉浸时长徽章：今天 + 近 7 天滚动累计，实时刷新 ——
        const badgeRow = document.createElement('div');
        badgeRow.style.cssText = 'margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;';
        const mkBadge = () => {
            const el = document.createElement('span');
            el.style.cssText = 'display:inline-flex;align-items:center;padding:5px 11px;border-radius:999px;border:1px solid color-mix(in srgb,var(--sakura-theme-color,#ff6b95) 45%,transparent);background:color-mix(in srgb,var(--sakura-theme-color,#ff6b95) 12%,transparent);font-size:11.5px;font-weight:700;color:var(--sakura-theme-color,#ff6b95);';
            return el;
        };
        const todayBadge = mkBadge();
        const weekBadge = mkBadge();
        badgeRow.appendChild(todayBadge);
        badgeRow.appendChild(weekBadge);
        section.appendChild(badgeRow);
        const refreshBadges = () => {
            if (!todayBadge.isConnected || !weekBadge.isConnected) return false;
            try {
                todayBadge.textContent = '⏳ 今日沉浸 ' + formatDuration(presenceTodayLive());
                weekBadge.textContent = '🌸 本周累计 ' + formatDuration(presenceWeekLive());
            } catch (_) {}
            return true;
        };
        // 只注册到全局唯一的 5 秒校准器，不给每个分区单独开循环。
        presenceBadgeRefreshers.push(refreshBadges);
        storageSection.parentElement.insertBefore(section, storageSection);
        // 必须在插入 DOM 后刷新，否则 isConnected 尚未成立会留下空徽章。
        refreshBadges();
        // 点击处理走全局事件委托（见 document click 委托里的 .sakura-personal-card 分支），
        // 这里绝不直连 addEventListener：Vue3 重绘替换节点会导致监听丢失、点击无反应。
    }
    // ================= ⏳ 沉浸时长统计（稳定版） =================
    // 页面在前台就算，挂机也算；每 5 秒校准一次，使用真实时间差，不依赖定时器是否准时触发。
    // 切后台/锁屏时结算最后一段并停表，后台停留时间不计。全模块只有一个 interval。
    const PRESENCE_KEY = 'rphub_presence_days_v1';
    let presenceMem = null;
    let presenceAnchor = Date.now();
    let presenceTimer = null;
    const presenceBadgeRefreshers = [];
    function presenceDayKey(offsetDays) {
        const d = new Date(Date.now() - (offsetDays || 0) * 86400000);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function presenceLoadOnce() {
        if (presenceMem) return presenceMem;
        const out = {};
        try {
            const arr = JSON.parse(pluginStorage.getItem(PRESENCE_KEY) || '[]');
            if (Array.isArray(arr)) arr.forEach(it => {
                if (it && typeof it.day === 'string' && Number.isFinite(it.sec)) out[it.day] = Math.max(0, it.sec);
            });
        } catch (_) {}
        presenceMem = out;
        return out;
    }
    function presencePersist() {
        try {
            const mem = presenceLoadOnce();
            const days = Object.keys(mem).sort().slice(-7);
            pluginStorage.setItem(PRESENCE_KEY, JSON.stringify(days.map(day => ({ day, sec: Math.round(mem[day]) }))));
        } catch (_) {}
    }
    function presenceAdd(sec) {
        if (!(sec > 0)) return;
        const mem = presenceLoadOnce();
        const day = presenceDayKey(0);
        mem[day] = (mem[day] || 0) + sec;
        presencePersist();
    }
    function presenceSettle(force) {
        const now = Date.now();
        const elapsed = Math.floor((now - presenceAnchor) / 1000);
        if (!(elapsed > 0)) return;
        // 只接受合理的前台区间；休眠/异常恢复的大跨度不虚算。
        if (elapsed > 600) { presenceAnchor = now; return; }
        if (force || elapsed >= 5) {
            presenceAdd(elapsed);
            presenceAnchor = now;
        }
    }
    function presenceTodayLive() {
        const mem = presenceLoadOnce();
        const pending = document.hidden ? 0 : Math.max(0, Math.floor((Date.now() - presenceAnchor) / 1000));
        return (mem[presenceDayKey(0)] || 0) + pending;
    }
    function presenceWeekLive() {
        const mem = presenceLoadOnce();
        let total = presenceTodayLive();
        for (let i = 1; i < 7; i++) total += mem[presenceDayKey(i)] || 0;
        return total;
    }
    function refreshPresenceBadges() {
        for (let i = presenceBadgeRefreshers.length - 1; i >= 0; i--) {
            try {
                if (presenceBadgeRefreshers[i]() === false) presenceBadgeRefreshers.splice(i, 1);
            } catch (_) {
                presenceBadgeRefreshers.splice(i, 1);
            }
        }
    }
    function presencePulse() {
        if (!document.hidden) presenceSettle(false);
        refreshPresenceBadges();
    }
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) presenceSettle(true);
        else presenceAnchor = Date.now();
        refreshPresenceBadges();
    });
    // 只创建一次：不会随设置页重绘增加定时器。
    presenceTimer = setInterval(presencePulse, 5000);
    function formatDuration(sec) {
        sec = Math.max(0, Math.round(sec));
        if (sec < 60) return sec + ' 秒';
        const m = Math.floor(sec / 60);
        if (m < 60) return m + ' 分钟';
        const h = Math.floor(m / 60);
        if (h < 48) {
            const rm = m % 60;
            return h + ' 小时' + (rm ? ' ' + rm + ' 分' : '');
        }
        return (h / 24).toFixed(1) + ' 天';
    }
    // ================= 🧹 模块：存储管家（localStorage 占用透视 + 一键瘦身） =================
    // 只动插件自己的可再生缓存与手记存档，绝不碰官方 IndexedDB（角色卡/聊天/设置）。
    const SAKURA_JANITOR_TARGETS = [
        { key: 'rphub_custom_splash_b64', label: '旧版开屏图缓存', desc: '早期单图开屏的 base64 遗留，新版已不用', kind: 'cache' },
        { key: 'rphub_splash_list_v1', label: '开屏图列表', desc: '自定义开屏图（base64 内嵌，通常最肥）', kind: 'media' },
        { key: 'rphub_moments_v1', label: '名场面手记', desc: '本体已迁入 IndexedDB 大仓库；此处显示的是瘦身灾备镜像', kind: 'media' },
        { key: 'sakura_gramophone_playlist_v6', label: '留声机歌单', desc: '留声机曲目列表（仅存链接与歌词）', kind: 'media' },
        { key: 'rphub_notes_v1', label: '便签', desc: '随手记事本内容', kind: 'text' },
        { key: 'rphub_theme_custom_slots_v1', label: '自定义主题色槽位', desc: '你保存过的自定义配色', kind: 'text' },
        { key: 'rphub_theme_custom_names_v1', label: '主题色命名', desc: '自定义配色的名字', kind: 'text' },
        { key: 'rphub_presence_days_v1', label: '沉浸时长记录', desc: '每日在线时长统计（极小）', kind: 'text' },
        { key: 'rphub_split_apis_v2', label: '分流 API 配置', desc: '记忆/UI 副模型的分流地址与密钥（含密钥，谨慎导出）', kind: 'text' }
    ];
    function estimateStorageUsageKB() {
        let total = 0;
        try {
            for (let i = 0; i < pluginStorage.length; i++) {
                const k = pluginStorage.key(i);
                if (k != null) total += (pluginStorage.getItem(k) || '').length + k.length;
            }
        } catch (_) {}
        return Math.round(total / 1024);
    }
    function openStorageJanitor() {
        const exist = document.getElementById('sakura-janitor-mask');
        if (exist) return;
        const mask = document.createElement('div');
        mask.id = 'sakura-janitor-mask';
        mask.className = 'sakura-mask';
        const box = document.createElement('div');
        box.className = 'sakura-box';
        const head = document.createElement('div');
        head.className = 'sakura-head';
        head.innerHTML = '<div class="sakura-modal-topbar"><div class="sakura-title-with-icon"><span>🧹 存储管家</span></div><button type="button" class="sakura-close-btn" title="关闭">✕</button></div><div class="sakura-sub">透视浏览器给本站的 localStorage 占用 · 只清可再生缓存，不碰角色卡与聊天</div>';
        const body = document.createElement('div');
        body.className = 'sakura-body';
        const foot = document.createElement('div');
        foot.className = 'sakura-foot';
        const render = () => {
            const totalKB = estimateStorageUsageKB();
            const rows = [];
            let cacheKB = 0;
            SAKURA_JANITOR_TARGETS.forEach(t => {
                let size = 0;
                try { size = (pluginStorage.getItem(t.key) || '').length; } catch (_) {}
                const kb = Math.round(size / 1024 * 10) / 10;
                if (t.kind === 'cache') cacheKB += kb;
                rows.push({ ...t, kb });
            });
            rows.sort((a, b) => b.kb - a.kb);
            const pct = Math.min(100, Math.round(totalKB / 5120 * 100));
            const pctColor = pct > 85 ? '#e83a5e' : (pct > 60 ? '#e8890c' : '#2fae6d');
            let html = `
                <div class="sakura-janitor-stat">
                    <div class="sakura-janitor-total" style="color:${pctColor}">${totalKB} KB</div>
                    <div class="sakura-janitor-hint">当前总占用（浏览器配额通常 5MB 左右，已用约 ${pct}%）</div>
                    <div class="sakura-janitor-bar">
                        <div class="sakura-janitor-bar-fill" style="width:${pct}%"></div>
                    </div>
                    <div class="sakura-janitor-cachehint">💡 其中「可再生的缓存」共约 <b>${Math.round(cacheKB)} KB</b>，清掉不影响任何存档</div>
                    <div class="sakura-janitor-real"></div>
                </div>`;
            rows.forEach(r => {
                const canClean = r.kb > 0;
                html += `
                    <div class="sakura-janitor-row">
                        <div class="sakura-janitor-rowmain">
                            <div class="sakura-janitor-label">${r.label} <span class="sakura-janitor-desc">${r.desc}</span></div>
                            <div class="sakura-janitor-key">${r.key} · ${r.kb} KB</div>
                        </div>
                        ${canClean ? `<button type="button" class="sakura-btn sakura-janitor-clean" data-key="${r.key}">清理</button>` : '<span class="sakura-janitor-empty">空</span>'}
                    </div>`;
            });
            html += '<div class="sakura-janitor-note">⚠️ 官方角色卡、聊天记录、世界书存在 IndexedDB 里，这里看不到也动不到，随便清都安全。若总占用长期高于 4500KB，建议先「全站灾备」备份，再清理最大的几项。</div>';
            body.innerHTML = html;
            // 真实占用：navigator.storage.estimate 能拿到浏览器层面的实际用量与总配额（含 IndexedDB）。
            try {
                if (navigator.storage && navigator.storage.estimate) {
                    navigator.storage.estimate().then(est => {
                        const el = body.querySelector('.sakura-janitor-real');
                        if (el && est && est.quota) {
                            el.textContent = '📊 浏览器实际总占用 ' + ((est.usage || 0) / 1048576).toFixed(2) + ' MB（含 IndexedDB）· 总配额约 ' + (est.quota / 1048576).toFixed(0) + ' MB';
                        }
                    }).catch(() => {});
                }
            } catch (_) {}
            body.querySelectorAll('.sakura-janitor-clean').forEach(btn => {
                btn.onclick = () => {
                    const key = btn.dataset.key;
                    const target = SAKURA_JANITOR_TARGETS.find(t => t.key === key);
                    if (!target) return;
                    openMomentConfirmDialog(`确认清理「${target.label}」？${target.kind === 'media' ? '该项含你的自定义内容，清理后不可恢复。' : '该项为可再生缓存，清理无损失。'}`, () => {
                        try { pluginStorage.removeItem(key); } catch (_) {}
                        render();
                    });
                };
            });
        };
        foot.appendChild(mkBtn('🧨 一键清空可再生缓存', false, () => {
            openMomentConfirmDialog('一键清理所有可再生缓存（图片锁定缓存/旧版开屏遗留）？\n角色卡、聊天、手记、主题全部不受影响。', () => {
                let freed = 0;
                SAKURA_JANITOR_TARGETS.filter(t => t.kind === 'cache').forEach(t => {
                    try {
                        const before = (pluginStorage.getItem(t.key) || '').length;
                        pluginStorage.removeItem(t.key);
                        freed += before;
                    } catch (_) {}
                });
                render();
                try { showMomentToast('已释放约 ' + Math.round(freed / 1024) + ' KB 空间'); } catch (_) {}
            });
        }));
        foot.appendChild(mkBtn('完成', true, () => { mask.remove(); }));
        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        mask.appendChild(box);
        head.querySelector('.sakura-close-btn').onclick = () => mask.remove();
        mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
        document.body.appendChild(mask);
        render();
    }
    function openThemePanel() {
        // 已打开则直接复用，不销毁重建，避免任何重复触发把面板弄丢。
        const exist = document.getElementById('sakura-theme-mask');
        if (exist) return;
        const current = themeNormalizeHex(document.documentElement.getAttribute('data-sakura-accent') || '') || THEME_DEFAULT;
        const mask = document.createElement('div');
        mask.id = 'sakura-theme-mask';
        mask.className = 'sakura-mask';
        // 面板打开期间冻结整页滚动：手指滑动只作用于面板内部，不再产生页面级滚动/惯性，
        // 从根上杜绝“滚动几下后面板自己消失”的误关闭链路。
        const prevOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
        const unlockScroll = () => { document.documentElement.style.overflow = prevOverflow; };
        const box = document.createElement('div');
        box.className = 'sakura-box';
        const head = document.createElement('div');
        head.className = 'sakura-head';
        head.innerHTML = '<div class="sakura-modal-topbar"><div class="sakura-title-with-icon"><span>🎨 主题换色</span></div><div style="display:flex;align-items:center;gap:6px"><button type="button" class="sakura-btn sakura-theme-janitor-btn" style="padding:4px 9px;font-size:11.5px;border-radius:8px" title="打开存储管家">🧹 存储管家</button><button type="button" class="sakura-close-btn" title="关闭">✕</button></div></div><div class="sakura-sub">全站配色实时生效 · 自动适配深浅模式</div>';
        const storageEntry = mkBtn('🧹 存储管家', false, () => { mask.remove(); unlockScroll(); openStorageJanitor(); });
        const body = document.createElement('div');
        body.className = 'sakura-body';
                const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;';
        let picker = null, hexInput = null;
        // v17.6：pendingSlotIndex 记录「刚点过的空槽」，HEX 回车后存进该槽，而不是永远存第一个空槽。
        let pendingSlotIndex = null;
        const curLabel = document.createElement('div');
        curLabel.style.cssText = 'margin-bottom:10px;font-size:12px;font-weight:700;color:#805064;';
        const refreshCurrentLabel = () => { curLabel.textContent = '当前主题：' + themeCurrentLabel(); };
        refreshCurrentLabel();
        const isCurrent = hex => hex && (themeNormalizeHex(document.documentElement.getAttribute('data-sakura-accent') || '') || THEME_DEFAULT) === themeNormalizeHex(hex);
        // 九宫格：六预设 + 三个 HEX 直输槽。空槽点击聚焦输入框；输入合法色值回车即存即用。
        const renderGrid = () => {
            grid.innerHTML = '';
            const slots = themeLoadSlots();
            const cells = [
                ...THEME_PRESETS.map(p => ({ name: p.name, value: p.value, preset: true })),
                ...[0, 1, 2].map(i => ({ slotIndex: i, value: slots[i] }))
            ];
            cells.forEach(c => {
                if (c.slotIndex !== undefined && !c.value) {
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:12px 6px;border-radius:14px;border:' + (pendingSlotIndex === c.slotIndex ? '2px solid #d6859b;box-shadow:0 0 0 3px rgba(214,133,155,.18)' : '1.5px dashed rgba(214,133,155,.55)') + ';background:rgba(255,250,252,.6);cursor:pointer;font:inherit;';
                    const plus = document.createElement('span');
                    plus.style.cssText = 'width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;color:#c66a86;background:#fff0f4;';
                    plus.textContent = '#';
                    const label = document.createElement('span');
                    label.style.cssText = 'font-size:11px;font-weight:700;color:#a27b89;';
                    label.textContent = themeSlotLabel(c.slotIndex);
                    cell.appendChild(plus);
                    cell.appendChild(label);
                    cell.addEventListener('click', () => {
                        pendingSlotIndex = c.slotIndex;
                        hexInput.focus();
                        hexInput.select();
                        hexInput.placeholder = '输入「' + themeSlotLabel(c.slotIndex) + '」的HEX，如 #58a6f5';
                        renderGrid();
                    });
                    grid.appendChild(cell);
                    return;
                }
                const isSlot = c.slotIndex !== undefined;
                const value = isSlot ? c.value : c.value;
                const name = isSlot ? themeSlotLabel(c.slotIndex) : c.name;
                const cell = document.createElement('button');
                cell.type = 'button';
                const active = isCurrent(value);
                cell.style.cssText = 'position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 6px;border-radius:14px;border:' + (active ? '2px solid #d6859b' : '1.5px solid rgba(255,204,213,.7)') + ';background:#fff;cursor:pointer;font:inherit;box-shadow:' + (active ? '0 0 0 3px rgba(214,133,155,.18)' : 'none') + ';';
                const dot = document.createElement('span');
                dot.style.cssText = 'width:34px;height:34px;border-radius:50%;background:' + value + ';box-shadow:inset 0 1px 0 rgba(255,255,255,.5),0 2px 8px rgba(0,0,0,.12);border:2px solid #fff;';
                const label = document.createElement('span');
                label.style.cssText = 'font-size:11px;font-weight:700;color:#805064;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                label.textContent = name;
                cell.appendChild(dot);
                cell.appendChild(label);
                cell.addEventListener('click', () => {
                    applyThemeColor(value);
                    picker.value = value;
                    hexInput.value = value.toUpperCase();
                    pendingSlotIndex = null;
                    refreshCurrentLabel();
                    renderGrid();
                });
                if (isSlot) {
                    const rename = document.createElement('span');
                    rename.textContent = '✎';
                    rename.title = '重命名该主题';
                    rename.style.cssText = 'position:absolute;top:4px;left:6px;width:16px;height:16px;line-height:15px;text-align:center;border-radius:50%;font-size:9px;color:#8a4058;background:rgba(255,240,245,.95);border:1px solid rgba(214,133,155,.4);cursor:pointer;';
                    rename.addEventListener('click', e => {
                        e.stopPropagation();
                        const names = themeLoadNames();
                        const next = window.prompt('给这个主题起个名字（最多 12 字，留空恢复「自定义」）：', names[c.slotIndex] || '');
                        if (next === null) return;
                        names[c.slotIndex] = String(next).trim().slice(0, 12);
                        themeSaveNames(names);
                        refreshCurrentLabel();
                        renderGrid();
                    });
                    cell.appendChild(rename);
                    const del = document.createElement('span');
                    del.textContent = '✕';
                    del.title = '清除该自定义颜色';
                    del.style.cssText = 'position:absolute;top:4px;right:6px;width:16px;height:16px;line-height:15px;text-align:center;border-radius:50%;font-size:10px;color:#b07a8c;background:rgba(255,240,245,.95);border:1px solid rgba(214,133,155,.4);cursor:pointer;';
                    del.addEventListener('click', e => {
                        e.stopPropagation();
                        const arr = themeLoadSlots();
                        arr[c.slotIndex] = '';
                        themeSaveSlots(arr);
                        const names = themeLoadNames();
                        names[c.slotIndex] = '';
                        themeSaveNames(names);
                        pendingSlotIndex = null;
                        if (isCurrent(value)) { applyThemeColor(''); refreshCurrentLabel(); }
                        renderGrid();
                    });
                    cell.appendChild(del);
                }
                grid.appendChild(cell);
            });
        };
        renderGrid();
        const customRow = document.createElement('div');
        customRow.style.cssText = 'margin-top:12px;display:flex;align-items:center;gap:10px;';
        picker = document.createElement('input');
        picker.type = 'color';
        picker.value = current;
        picker.style.cssText = 'width:46px;height:38px;border:1.5px solid rgba(255,204,213,.8);border-radius:11px;background:#fff;padding:3px;cursor:pointer;';
        hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.value = current.toUpperCase();
        hexInput.placeholder = '#ff6b95';
        hexInput.spellcheck = false;
        hexInput.autocapitalize = 'off';
        hexInput.autocomplete = 'off';
        hexInput.setAttribute('enterkeyhint', 'done');
        hexInput.style.cssText = 'flex:1;min-width:0;padding:9px 12px;border-radius:12px;border:1.5px solid #ffb3c6;background:#fff;color:#4a2030;font-size:13px;outline:none;box-sizing:border-box;';
        customRow.appendChild(picker);
        customRow.appendChild(hexInput);
        const hint = document.createElement('div');
        hint.style.cssText = 'margin-top:10px;font-size:11.5px;color:#a27b89;line-height:1.6;';
        hint.textContent = '点格子立即换主题；先点某个空槽再输入 #色值 回车，就存进那个槽（没点则存第一个空槽，全满覆盖①）。✎ 重命名 · ✕ 清除。';
        body.appendChild(grid);
        body.appendChild(customRow);
        body.appendChild(hint);
        const foot = document.createElement('div');
        foot.className = 'sakura-foot';
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'sakura-btn sakura-btn--quiet';
        resetBtn.textContent = '恢复默认';
        resetBtn.addEventListener('click', () => {
            applyThemeColor('');
            picker.value = THEME_DEFAULT;
            hexInput.value = THEME_DEFAULT.toUpperCase();
            pendingSlotIndex = null;
            refreshCurrentLabel();
            renderGrid();
        });
        const doneBtn = document.createElement('button');
        doneBtn.type = 'button';
        doneBtn.className = 'sakura-btn sakura-btn--main';
        doneBtn.style.marginLeft = 'auto';
        doneBtn.textContent = '完成';
        doneBtn.addEventListener('click', () => {
            const v = themeNormalizeHex(hexInput.value);
            applyThemeColor(v || '');
            refreshCurrentLabel();
            unlockScroll();
            mask.remove();
        });
        foot.appendChild(storageEntry);
        foot.appendChild(resetBtn);
        foot.appendChild(doneBtn);
        picker.addEventListener('input', () => {
            hexInput.value = picker.value.toUpperCase();
            applyThemeColor(picker.value, { persist: false });
            refreshCurrentLabel();
        });
        picker.addEventListener('change', () => { applyThemeColor(picker.value); refreshCurrentLabel(); });
        const commitHex = () => {
            const v = themeNormalizeHex(hexInput.value);
            if (!v && hexInput.value.trim()) {
                hexInput.value = (themeNormalizeHex(document.documentElement.getAttribute('data-sakura-accent') || '') || THEME_DEFAULT).toUpperCase();
                return;
            }
            picker.value = v || THEME_DEFAULT;
            applyThemeColor(v || '');
            refreshCurrentLabel();
            // HEX 输入回车：优先存进「刚点过的空槽」（pendingSlotIndex）；
            // 没点过则存第一个空槽；全满则覆盖①。同色已存在时不再重复占槽。
            if (v) {
                const arr = themeLoadSlots();
                const existing = arr.indexOf(v);
                if (existing === -1) {
                    let idx = pendingSlotIndex;
                    if (idx === null || arr[idx] !== '') idx = arr.indexOf('');
                    if (idx === -1) idx = 0;
                    arr[idx] = v;
                    themeSaveSlots(arr);
                }
                pendingSlotIndex = null;
                renderGrid();
            }
        };
        hexInput.addEventListener('change', commitHex);
        hexInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitHex(); } });
        body.insertBefore(curLabel, body.firstChild);
        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        mask.appendChild(box);
        head.querySelector('.sakura-close-btn').onclick = () => { unlockScroll(); mask.remove(); };
        const jtrHeadBtn = head.querySelector('.sakura-theme-janitor-btn');
        if (jtrHeadBtn) jtrHeadBtn.onclick = () => { unlockScroll(); mask.remove(); openStorageJanitor(); };
        // 点空白关闭：只信任真实用户手势，且按下起点必须在遮罩空白处。
        // 防止：打开面板的那次点击的迟到合成事件、系统取色器收起后的穿透点击、
        // 滚动惯性结束等被误判成“点击外部”，导致面板几秒后自己消失。
        let pressStartedOnMask = false;
        const markPressStart = e => { pressStartedOnMask = (e.target === mask); };
        mask.addEventListener('touchstart', markPressStart, { passive: true });
        mask.addEventListener('mousedown', markPressStart);
        mask.addEventListener('click', e => {
            if (e.target !== mask) return;
            if (!pressStartedOnMask) return;
            if (!e.isTrusted) return;
            unlockScroll();
            mask.remove();
        });
        document.body.appendChild(mask);
    }
    applyThemeColor(themeStoredColor(), { persist: false });
    // 调试/测试钩子：控制台可手动 window.__sakuraApplyTheme('#58a6f5') 换色
    try { window.__sakuraApplyTheme = applyThemeColor; } catch (_) {}


    // ================= 2. 开屏 =================
    function initCustomSplash() {
        if (document.getElementById('custom-splash-screen')) return;
        const splash = document.createElement('div');
        splash.id = 'custom-splash-screen';
        const bgLayer = document.createElement('div');
        bgLayer.className = 'splash-bg-layer';
        // 底部极细进度条（替代原来的右上角跳过按钮，避免误触删除聊天记录）
        const progressWrap = document.createElement('div');
        progressWrap.className = 'splash-progress';
        const progressBar = document.createElement('div');
        progressBar.className = 'splash-progress-bar';
        progressWrap.appendChild(progressBar);

        const SPLASH_DURATION = 3000;   // 3 秒，维持原时长
        let closed = false;
        let countdownTimer = null;

        // 🛡️ 防点击穿透：开屏消失后，下面就是对话页右上角的「删除聊天记录」。
        // 点击跳过时，快触事件的后半段会落到下层页面 —— 必须在捕获阶段吃掉这一下。
        // 仅「用户主动跳过」时才需要：自动倒计时结束没有用户手势，不存在穿透风险。
        const swallowGhostClick = () => {
            const block = e => { e.stopPropagation(); e.preventDefault(); };
            const opts = { capture: true, passive: false };
            document.addEventListener('click', block, opts);
            document.addEventListener('touchend', block, opts);
            document.addEventListener('pointerup', block, opts);
            // 覆盖淡出动画全程（600ms）+ 合成点击窗口，之后自动卸载
            setTimeout(() => {
                document.removeEventListener('click', block, opts);
                document.removeEventListener('touchend', block, opts);
                document.removeEventListener('pointerup', block, opts);
            }, 750);
        };

        // 🖥️ 桌面端：键盘跳过（ESC / 空格 / 回车），符合电脑用户习惯
        const onKeyDown = e => {
            if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                closeSplash(false);
            }
        };

        // swallow=true 仅用于「用户主动点击跳过」，防止那一下穿透到下层删除键
        const closeSplash = (swallow = false) => {
            if (closed) return;
            closed = true;
            if (countdownTimer) clearInterval(countdownTimer);
            document.removeEventListener('keydown', onKeyDown, true);
            if (swallow) swallowGhostClick();
            splash.classList.add('splash-fade-out');
            setTimeout(() => { splash.remove(); }, 600);
        };

        // 点屏幕任意处 → 跳过（主动点击，需要防穿透）
        splash.addEventListener('click', () => closeSplash(true));
        splash.addEventListener('touchend', e => { e.preventDefault(); closeSplash(true); }, { passive: false });
        document.addEventListener('keydown', onKeyDown, true);
        // 拖拽图片会触发浏览器原生拖拽（桌面端很丑），直接拦截
        splash.addEventListener('dragstart', e => e.preventDefault());
        splash.addEventListener('contextmenu', e => e.preventDefault());

        splash.appendChild(bgLayer);
        splash.appendChild(progressWrap);
        (document.body || document.documentElement).appendChild(splash);
        // 自定义多图列表优先：每次启动随机抽一张；图床缓存只作无自定义时的默认兜底。
        const customSplashList = getSplashList();
        let cachedImg = pluginStorage.getItem(CACHE_KEY);
        // v18.9：无自定义图但残留旧图片缓存时，清掉残留（旧版单图键 + 图床缓存），确保「删光 = 回到默认开屏图」。
        if (customSplashList.length === 0 && (cachedImg || pluginStorage.getItem(SPLASH_CUSTOM_KEY))) {
            try { pluginStorage.removeItem(SPLASH_CUSTOM_KEY); } catch (_) {}
            try { pluginStorage.removeItem(CACHE_KEY); } catch (_) {}
            cachedImg = null; // v18.9b：同步置空，本次启动立即走默认开屏，不再显示一次幽灵图
        }
        const startCountdown = () => {
            splash.classList.add('splash-ready');
            const startedAt = Date.now();
            // 进度条：每 50ms 刷新一次宽度，3 秒线性走满，与倒计时同步。
            countdownTimer = setInterval(() => {
                const elapsed = Date.now() - startedAt;
                const percent = Math.min(100, (elapsed / SPLASH_DURATION) * 100);
                progressBar.style.width = `${percent}%`;
                if (elapsed >= SPLASH_DURATION) closeSplash();
            }, 50);
        };
        if (customSplashList.length > 0) {
            bgLayer.style.backgroundImage = `url('${customSplashList[Math.floor(Math.random() * customSplashList.length)]}')`;
            startCountdown();
        } else if (cachedImg) {
            bgLayer.style.backgroundImage = `url('${cachedImg}')`;
            startCountdown();
        } else {
            const targetUrl = SPLASH_IMG_URL;
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = targetUrl;
            img.onload = () => {
                bgLayer.style.backgroundImage = `url('${targetUrl}')`;
                startCountdown();
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    canvas.getContext('2d').drawImage(img, 0, 0);
                    pluginStorage.setItem(CACHE_KEY, canvas.toDataURL('image/webp'));
                } catch (e) {}
            };
            img.onerror = () => {
                bgLayer.style.backgroundImage = `url('${targetUrl}')`;
                startCountdown();
            };
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCustomSplash);
    } else {
        initCustomSplash();
    }

    // ================= 3. 温度/流式真实记忆（V4 极简重构：Vue 同步 watch 底层直通） =================
    // 官方行为：app.js 每次启动 await loadData() 之后硬编码 settings.temperature = 1.0；
    //           onMounted 里强制 settings.stream = true。
    // 旧方案：2 秒轮询 + 12 秒守护窗口 + 4000ms 定时器赌命，越补越多，页面静止就漏网。
    // 新方案：用 Vue 同步 watch（flush:'sync'）直挂 settings，官方赋值的同一瞬间当场纠偏，
    //         零轮询、零延迟、无 UI 闪烁。玩家改值由捕获阶段 input 事件直接落盘，
    //         watch 只需比对“当前值 vs 存档”即可区分玩家操作与官方重置。一个模块闭环，别处零依赖。
    function installPreferenceGuards() {
        if (window.__sakuraPrefGuardsInstalled__) return true;
        if (!window.Vue || typeof window.Vue.watch !== 'function') return false;
        const st = getVueState();
        if (!st || !st.settings) return false;
        window.__sakuraPrefGuardsInstalled__ = true;

        const OFFICIAL_TEMP = 1.0;      // 官方启动重置目标值
        const OFFICIAL_STREAM = true;   // 官方启动重置目标值

        const readTemp = () => {
            const v = pluginStorage.getItem(USER_TEMP_KEY);
            return (v !== null && !isNaN(parseFloat(v))) ? parseFloat(v) : null;
        };
        const readStream = () => {
            const v = pluginStorage.getItem(USER_STREAM_KEY);
            return v === null ? null : v === 'true';
        };

        // 玩家改值：捕获阶段直接落盘（先于 Vue 的 v-model 更新），
        // 这样 watch 里比对“当前值 vs 存档”就能区分玩家操作与官方重置，无需任何意图标记。
        // 绑 input + change 双事件：range 走 input，checkbox 的 v-model 走 change，两边都兜住。
        const onUserEdit = (e) => {
            const el = e.target;
            if (!el || el.tagName !== 'INPUT') return;
            if (el.type === 'range' && (el.getAttribute('aria-label') === '温度' || (el.step === '0.01' && el.max === '1'))) {
                const v = parseFloat(el.value);
                if (!isNaN(v)) pluginStorage.setItem(USER_TEMP_KEY, String(v));
            } else if (el.type === 'checkbox' && ((el.closest('label') || el.parentElement)?.textContent || '').includes('流式输出')) {
                pluginStorage.setItem(USER_STREAM_KEY, String(el.checked));
            }
        };
        document.addEventListener('input', onUserEdit, true);
        document.addEventListener('change', onUserEdit, true);

        // 🌡️ 温度：官方拍 1.0 的同一瞬间当场纠偏；玩家改值已落盘，直接放行
        window.Vue.watch(() => st.settings.temperature, (raw) => {
            const val = parseFloat(raw);
            if (isNaN(val)) return;
            const saved = readTemp();
            if (saved === null) { pluginStorage.setItem(USER_TEMP_KEY, String(val)); return; }
            if (Math.abs(val - saved) < 0.001) return;                 // 与存档一致（玩家刚改过）
            if (Math.abs(val - OFFICIAL_TEMP) < 0.001) {               // 官方重置 → 当场纠偏
                st.settings.temperature = saved;
                console.log(`[苏萝萝] 温度守护：拦截官方重置，恢复 ${saved}`);
                return;
            }
            pluginStorage.setItem(USER_TEMP_KEY, String(val));           // 其他变化 → 落盘
        }, { flush: 'sync' });

        // 📡 流式：同上
        window.Vue.watch(() => st.settings.stream, (raw) => {
            const val = !!raw;
            const saved = readStream();
            if (saved === null) { pluginStorage.setItem(USER_STREAM_KEY, String(val)); return; }
            if (val === saved) return;
            if (val === OFFICIAL_STREAM) {
                st.settings.stream = saved;
                console.log(`[苏萝萝] 流式守护：拦截官方重置，恢复 ${saved ? '开' : '关'}`);
                return;
            }
            pluginStorage.setItem(USER_STREAM_KEY, String(val));
        }, { flush: 'sync' });

        // 安装时补一次纠偏：若官方重置发生在 watch 安装之前，watch 永远看不到那次变化
        const savedTemp0 = readTemp();
        if (savedTemp0 !== null && Math.abs(Number(st.settings.temperature) - savedTemp0) > 0.001) {
            st.settings.temperature = savedTemp0;
            console.log(`[苏萝萝] 温度守护：安装时纠偏为 ${savedTemp0}`);
        }
        const savedStream0 = readStream();
        if (savedStream0 !== null && !!st.settings.stream !== savedStream0) {
            st.settings.stream = savedStream0;
            console.log(`[苏萝萝] 流式守护：安装时纠偏为 ${savedStream0 ? '开' : '关'}`);
        }

        // 🃏 角色卡视图：官方 watch(currentView) 进角色页时写死 characterGridView = false（app.js 1517 行）。
        // 与温度/流式同理，改成同步 watch 当场纠偏，进页面直接就是玩家选的布局，不再"先卡片后跳表格"。
        // 区分玩家操作与官方重置：按钮是 @click 翻转（没有 DOM 值可读），
        // 所以在捕获阶段打一个"玩家意图"时间戳（早于 Vue 的 @click 翻转），watch 里比对时间戳即可。
        if ('characterGridView' in st) {
            const readView = () => {
                const v = pluginStorage.getItem(USER_CHARVIEW_KEY);
                return v === null ? null : v === 'true';
            };
            document.addEventListener('click', (e) => {
                const btn = e.target?.closest?.('button[aria-label="切换为网格布局"], button[aria-label="切换为叠卡布局"]');
                if (btn) window.__sakuraViewToggleAt__ = Date.now();
            }, true);

            window.Vue.watch(() => st.characterGridView, (raw) => {
                const val = !!raw;
                const saved = readView();
                // 玩家意图窗口 400ms：捕获阶段刚打过标记 → 视为玩家主动切换，落盘放行。
                // ⚠️ 标记必须"一次性消费"：否则官方重置紧跟玩家切换（同一毫秒内）也会被误判成玩家操作。
                if (Date.now() - (window.__sakuraViewToggleAt__ || 0) < 400) {
                    window.__sakuraViewToggleAt__ = 0;   // 消费标记，只认这一次
                    pluginStorage.setItem(USER_CHARVIEW_KEY, String(val));
                    console.log(`[苏萝萝] 记住角色卡视图偏好: ${val ? '网格' : '叠卡'}`);
                    return;
                }
                if (saved === null) return;   // 无存档 → 官方默认原样
                if (val === saved) return;    // 与存档一致
                // 官方重置（进页拍回叠卡）→ 当场纠偏
                st.characterGridView = saved;
                console.log(`[苏萝萝] 角色卡视图守护：拦截官方重置，恢复 ${saved ? '网格' : '叠卡'}`);
            }, { flush: 'sync' });

            // 安装时补一次纠偏：官方重置若发生在 watch 安装之前，watch 永远看不到那次变化
            const savedView0 = readView();
            if (savedView0 !== null && !!st.characterGridView !== savedView0) {
                st.characterGridView = savedView0;
                console.log(`[苏萝萝] 角色卡视图守护：安装时纠偏为 ${savedView0 ? '网格' : '叠卡'}`);
            }
        }

        console.log('[苏萝萝] 温度/流式/角色卡视图 同步守护已安装（Vue watch · flush sync）');
        // 🧠 向量缓存说明：换 API 站不再重复补录，由网络层缓存（cachedEmbeddingFetch）自动处理。
        //    缓存键 = embedding 模型 + 输入内容，与站点地址无关，故无需任何 watch / 重载。
        return true;
    }

// ================= 3.5 角色卡视图记忆 =================
    // 已并入 installPreferenceGuards（Vue 同步 watch · flush sync）：
    //   官方 watch(currentView) 进角色页时写死 characterGridView = false（app.js 1517 行），
    //   同步 watch 在赋值同一瞬间当场纠偏，进页面直接就是玩家选的布局，不再"先卡片后跳表格"。
    //   玩家操作由捕获阶段 click 时间戳识别，watch 里比对后落盘。
    //   旧的 2 秒轮询版 manageCharacterViewPersistence 已删除（轮询必然慢一拍，且与新 watch 重复）。

    // ================= 🧠 模块：记忆导入/导出（1.8.9 原生复刻，官方 1.9.1 删除后还原） =================
    // 复刻自 RP-Hub 1.8.9 app.js 的 exportMemories / importMemories：
    //   - 总结模式：type=rp-hub-summary-memories, version=2，按 turn 排序，展开 secondaryCompressed 来源，
    //     去重键 = sourceAssistantIds.join('|') 或 `turn:${turn}`（getClassicMemoryKey 原版）
    //   - 向量模式：紧凑分片数组（compactMemoryForStorage 原版：剥离运行时字段 + int8:maxabs:v1 量化）
    //   - 存储：经官方 window.RPHubStorage.get/setScopedStoredValue 读写（1.9.4 RPHubDB 为单一 store 仓库 + rp_hub_ 逻辑键，
    //     严禁把逻辑键名当 objectStore 用；官方 API 自动处理键前缀、旧库迁移与断线重连）
    //   - 导入后热刷新：官方 selectCharacter(idx, true, { silent: true }) 正门重载（1.9.4 未导出内部 memories ref，
    //     直写 setupState 是死属性）；切换保存阶段的记忆写库由 IDBObjectStore.put 层劫持保护，防空内存回写覆盖
    function sakuraMemRead(storeName, scopeId) {
        // 1.9.4 存储结构：RPHubDB 只有单一 'store' 仓库，所有数据挂在逻辑键 rp_hub_<name>_<scopeId> 下。
        // 必须走官方 RPHubStorage API（自动处理键前缀、旧 SillyTavernDB 迁移、断线重连）；
        // 直接把逻辑键名当 objectStore 用必然 NotFoundError（1.9.4 无 classic_memories/memories 仓库）。
        return Promise.resolve()
            .then(() => window.RPHubStorage.getScopedStoredValue(storeName, scopeId))
            .then(v => (v === undefined || v === null) ? [] : v);
    }
    function sakuraMemWrite(storeName, scopeId, value) {
        return Promise.resolve()
            .then(() => window.RPHubStorage.setScopedStoredValue(storeName, scopeId, value))
            .then(() => true);
    }
    function sakuraMemScopeId() {
        // 与官方 getStoryBranchScopeId 完全一致：main 分支省略后缀，自定义分支拼 __branch__
        try {
            const st = getVueState();
            const char = st && unref(st.currentCharacter);
            const uuid = char && (char.uuid || char.id);
            if (!uuid) return null;
            let branchId = 'main';
            // 1.9.5 官方不再导出 activeStoryBranchId（1.9.4 有）：依次尝试
            // ① 旧版真 ref ② 官方导出的 currentStoryBranch（computed，含 .id）③ 兜底 main。
            const active = st && unref(st.activeStoryBranchId);
            if (typeof active === 'string' && active) {
                branchId = active;
            } else {
                const cur = st && unref(st.currentStoryBranch);
                if (cur && typeof cur.id === 'string' && cur.id) branchId = cur.id;
            }
            // 优先白嫖官方分支工具（1.9.4 RPHubStoryBranches 导出），保证与官方键规则永远同步
            try {
                if (window.RPHubStoryBranches && typeof window.RPHubStoryBranches.getStoryBranchScopeId === 'function') {
                    const official = window.RPHubStoryBranches.getStoryBranchScopeId(String(uuid), branchId);
                    if (official) return String(official);
                }
            } catch (_) {}
            return branchId === 'main' ? String(uuid) : `${uuid}__branch__${branchId}`;
        } catch (_) { return null; }
    }
    function sakuraMemCharName() {
        try {
            const st = getVueState();
            const char = st && unref(st.currentCharacter);
            if (char && char.name) return String(char.name);
        } catch (_) {}
        return 'unknown';
    }
    function sakuraMemMode() {
        try {
            const st = getVueState();
            const ms = st && getRuntimeValue(st.memorySettings);
            // RP-Hub 1.9.5 起记忆模式只有 classic / enhanced 两种；旧的 vector 已并入 enhanced。
            if (ms && ms.mode) return ms.mode === 'classic' ? 'classic' : 'enhanced';
        } catch (_) {}
        return 'classic';
    }
    function sakuraMemUUID() {
        try {
            if (window.RPHubUtils && typeof window.RPHubUtils.generateUUID === 'function') {
                return window.RPHubUtils.generateUUID();
            }
        } catch (_) {}
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }
    function sakuraToast(msg, type) {
        try {
            const st = getVueState();
            if (st && typeof st.showToast === 'function') { st.showToast(msg, type); return; }
            // 1.9.4 未导出 showToast，但导出了 toasts 数组；按官方 showToast 的数据格式直接推送
            const toasts = st && getRuntimeValue(st.toasts);
            if (Array.isArray(toasts)) {
                const item = { id: `sakura-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, message: msg, type: type || 'info' };
                toasts.push(item);
                // 按 id 过滤移除（官方 showToast 同款）：按对象引用 indexOf 在 Vue 响应式数组里必然失配
                // （读取时被代理包装，引用不等）→ 永远删不掉 → toast 永久挂起。官方就是按 id 过滤的。
                setTimeout(() => {
                    try {
                        const arr = getRuntimeValue(getVueState()?.toasts);
                        if (Array.isArray(arr)) {
                            const i = arr.findIndex(t => t && t.id === item.id);
                            if (i >= 0) arr.splice(i, 1);
                        }
                    } catch (_) {}
                }, 2500);
                return;
            }
        } catch (_) {}
        console.log(`[苏萝萝·记忆] ${msg}`);
    }
    // —— 1.8.9 normalizeClassicMemoryForRuntime 原版（导入规范化校验） ——
    function sakuraMemNormalizeClassic(memory, includeSources = true) {
        if (!memory || memory.classicMemory !== true || !String(memory.summary || '').trim()) return null;
        const fallbackTurn = Math.max(1, Number(memory.turn) || 1);
        const secondaryCompressed = memory.secondaryCompressed === true;
        const turnStart = secondaryCompressed
            ? Math.max(1, Number(memory.turnStart) || fallbackTurn)
            : fallbackTurn;
        const turnEnd = secondaryCompressed
            ? Math.max(turnStart, Number(memory.turnEnd) || fallbackTurn)
            : fallbackTurn;
        const normalized = {
            ...memory,
            turn: secondaryCompressed ? turnEnd : fallbackTurn,
            summary: String(memory.summary || '').trim(),
            sourceUserIds: Array.isArray(memory.sourceUserIds) ? memory.sourceUserIds.filter(Boolean) : [],
            sourceAssistantIds: Array.isArray(memory.sourceAssistantIds) ? memory.sourceAssistantIds.filter(Boolean) : []
        };
        if (secondaryCompressed) {
            normalized.secondaryCompressed = true;
            normalized.turnStart = turnStart;
            normalized.turnEnd = turnEnd;
            normalized.sourceMemories = includeSources && Array.isArray(memory.sourceMemories)
                ? memory.sourceMemories.map(item => sakuraMemNormalizeClassic(item, false)).filter(Boolean)
                : [];
        }
        return normalized;
    }
    // —— 1.8.9 getClassicMemoryKey 原版（去重键） ——
    function sakuraMemClassicKey(sourceAssistantIds, turn = 0) {
        const ids = Array.isArray(sourceAssistantIds) ? sourceAssistantIds.filter(Boolean) : [];
        return ids.length > 0 ? ids.join('|') : `turn:${Number(turn) || 0}`;
    }
    // —— 1.8.9 downloadJsonFile 原版（revokeDelay: 1000） ——
    function sakuraMemDownload(data, fileName, spacing) {
        const json = JSON.stringify(data, null, spacing);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return blob;
    }
    async function sakuraMemExport() {
        const scopeId = sakuraMemScopeId();
        if (!scopeId) { sakuraToast('请先选择角色卡，再导出记忆', 'error'); return; }
        const isClassicMode = sakuraMemMode() === 'classic';
        const charName = sakuraMemCharName();
        if (isClassicMode) {
            const list = await sakuraMemRead('classic_memories', scopeId);
            if (!Array.isArray(list) || list.length === 0) { sakuraToast('当前模式没有记忆可导出', 'info'); return; }
            const exportedMemories = [...list]
                .sort((a, b) => (a.turn || 0) - (b.turn || 0))
                .map(memory => {
                    const isSecondary = memory?.secondaryCompressed === true;
                    // 1.8.9 getSecondaryClassicSourceMemories：取规范化后的非压缩子项做正文聚合
                    const sourceMemories = isSecondary
                        ? (Array.isArray(memory.sourceMemories) ? memory.sourceMemories : [])
                              .map(item => sakuraMemNormalizeClassic(item, false))
                              .filter(Boolean)
                              .filter(item => item?.secondaryCompressed !== true)
                        : [];
                    return {
                        turn: memory.turn,
                        turnStart: memory.turnStart,
                        turnEnd: memory.turnEnd,
                        secondaryCompressed: memory.secondaryCompressed === true,
                        summaryModel: memory.summaryModel || '',
                        user: {
                            content: memory.sourceUserText
                                || sourceMemories.map(item => item.sourceUserText || '').filter(Boolean).join('\n\n'),
                            messageIds: memory.sourceUserIds || []
                        },
                        assistant: {
                            content: memory.sourceAssistantText
                                || sourceMemories.map(item => item.sourceAssistantText || '').filter(Boolean).join('\n\n'),
                            messageIds: memory.sourceAssistantIds || []
                        },
                        summary: memory.summary,
                        sourceMemories: isSecondary ? (memory.sourceMemories || []) : undefined
                    };
                });
            const exportData = {
                type: 'rp-hub-summary-memories',
                version: 2,
                character: charName,
                exportedAt: new Date().toISOString(),
                total: exportedMemories.length,
                memories: exportedMemories
            };
            const blob = sakuraMemDownload(exportData, `summary_memories_${charName}.json`, 2);
            sakuraToast(`总结模式记忆已导出，约 ${Math.max(1, Math.round(blob.size / 1024))} KB`, 'success');
        } else {
            // RP-Hub 1.9.5 起“增强模式”取代向量模式，官方已移除 memories 分片库，插件不再提供分片导出。
            sakuraToast('1.9.5 增强模式已无向量分片库，无需导出', 'info');
        }
    }
    let _memImportBusy = false;
    async function sakuraMemImport(file) {
        if (_memImportBusy) { sakuraToast('正在处理上一次导入，请稍候…', 'info'); return; }
        const scopeId = sakuraMemScopeId();
        if (!scopeId) { sakuraToast('请先选择角色卡，再导入记忆', 'error'); return; }
        const isClassicMode = sakuraMemMode() === 'classic';
        let data;
        try {
            data = JSON.parse(await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = ({ target }) => resolve(target.result);
                reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
                reader.readAsText(file);
            }));
        } catch (error) {
            sakuraToast(`导入失败: ${error.message || 'JSON 格式错误'}`, 'error');
            return;
        }
        _memImportBusy = true;
        try {
            if (isClassicMode) {
                if (data?.type !== 'rp-hub-summary-memories' || !Array.isArray(data.memories)) {
                    throw new Error('这不是总结模式记忆文件');
                }
                const normalized = data.memories.map(memory => sakuraMemNormalizeClassic({
                    id: sakuraMemUUID(),
                    timestamp: Date.now(),
                    turn: memory?.turn,
                    turnStart: memory?.turnStart,
                    turnEnd: memory?.turnEnd,
                    summary: memory?.summary,
                    enabled: true,
                    classicMemory: true,
                    secondaryCompressed: memory?.secondaryCompressed === true,
                    summaryModel: String(memory?.summaryModel || ''),
                    sourceUserIds: Array.isArray(memory?.user?.messageIds) ? memory.user.messageIds : [],
                    sourceAssistantIds: Array.isArray(memory?.assistant?.messageIds) ? memory.assistant.messageIds : [],
                    sourceUserText: String(memory?.user?.content || ''),
                    sourceAssistantText: String(memory?.assistant?.content || ''),
                    sourceMemories: Array.isArray(memory?.sourceMemories) ? memory.sourceMemories : []
                })).filter(Boolean);
                if (normalized.length === 0) throw new Error('文件中没有有效的总结模式记忆');
                const existing = await sakuraMemRead('classic_memories', scopeId);
                const current = Array.isArray(existing) ? existing : [];
                const existingKeys = new Set(current.map(memory => sakuraMemClassicKey(memory.sourceAssistantIds, memory.turn)));
                const added = normalized.filter(memory => {
                    const key = sakuraMemClassicKey(memory.sourceAssistantIds, memory.turn);
                    if (existingKeys.has(key)) return false;
                    existingKeys.add(key);
                    return true;
                });
                await sakuraMemWrite('classic_memories', scopeId, [...current, ...added]);
                sakuraToast(`写入 ${added.length} 条总结记忆完成，正在刷新面板…`, 'info');
            } else {
                // RP-Hub 1.9.5 起“增强模式”取代向量模式，官方已移除 memories 分片库，插件不再接受分片导入。
                throw new Error('1.9.5 增强模式已无向量分片库，无法导入旧分片文件');
            }
            const rl = await sakuraMemHotReload();
            if (rl && rl.ok) {
                sakuraToast(`导入完成：总结 ${rl.classic} 条，已生效`, 'success');
            } else {
                sakuraToast('数据已写入，但自动刷新未完成——重新进入记忆页面即可看到', 'warning');
            }
        } catch (error) {
            sakuraToast(`导入失败: ${error.message || '未知错误'}`, 'error');
        } finally {
            _memImportBusy = false;
        }
    }
    async function sakuraMemHotReload() {
        // ⚠️ 1.9.4 终极方案：put 层劫持 + 官方正门重载。
        // 官方 1.9.4 的 setupState 根本没导出 memories/classicMemories 内部 ref（return 块已审计），
        // 任何"直写 setupState"都是挂死属性——面板 computed 与对话注入读的是闭包真 ref，永远看不见。
        // 唯一能把数据灌进真 ref 的正门 = 官方 selectCharacter（内部 readCharacterMemories 读库后直写并置 loaded 旗标）。
        // 但 selectCharacter 开头会 saveCurrentStoryBranchState → saveMemoriesNow/saveClassicMemoriesNow
        // 把内存里的陈旧数组写回库，覆盖刚导入的数据（官方守卫 _memoriesLoaded 在已加载场景恒为 true，拦不住）。
        // 解法：临时劫持 IDBObjectStore.prototype.put —— 切换保存阶段凡是写本角色记忆键的调用，
        // 一律偷换成刚导入的数据（保库）；随后官方读库自然把新数据灌进真 ref，面板/对话全部复活。
        try {
            const st = getVueState();
            if (!st) throw new Error('无法访问 Vue 运行时');
            const scopeId = sakuraMemScopeId();
            if (!scopeId) throw new Error('无法确定角色/分支存储范围');
            const idx = Number(unref(st.currentCharacterIndex));
            if (!Number.isInteger(idx) || idx < 0) throw new Error('无法确定当前角色索引');
            const classicRaw = await window.RPHubStorage.getScopedStoredValue('classic_memories', scopeId);
            const classicList = Array.isArray(classicRaw) ? classicRaw : [];
            if (classicList.length === 0) {
                console.warn('[苏萝萝] 热重载中止：库内无记忆数据（导入可能未落库）');
                return { ok: false };
            }
            const StoreProto = window.IDBObjectStore && window.IDBObjectStore.prototype;
            if (!StoreProto || typeof StoreProto.put !== 'function') throw new Error('IndexedDB put 拦截不可用');
            const nativePut = StoreProto.put;
            const guardKeys = new Set([`rp_hub_classic_memories_${scopeId}`]);
            StoreProto.put = function sakuraPatchedPut(value, key) {
                try {
                    const k = key == null ? '' : String(key);
                    if (guardKeys.has(k)) {
                        return nativePut.call(this, classicList, key);
                    }
                } catch (_) {}
                return nativePut.call(this, value, key);
            };
            try {
                if (typeof st.selectCharacter !== 'function') throw new Error('官方 selectCharacter 未导出');
                await st.selectCharacter(idx, true, { silent: true });
            } finally {
                StoreProto.put = nativePut;
            }
console.log(`[苏萝萝] 记忆热重载完成（官方式重载）：总结 ${classicList.length} 条`);
            return { ok: true, vector: 0, classic: classicList.length };
        } catch (e) {
            console.warn('[苏萝萝] 记忆热重载失败，请重新进入记忆页面刷新显示:', e);
            return { ok: false };
        }
    }
    // —— 官方 UI 模板导出同款禁用逻辑：无记忆可导出时按钮置灰（disabled + 官方 disabled 样式），点击无任何响应 ——
    async function sakuraMemCount() {
        const scopeId = sakuraMemScopeId();
        if (!scopeId) return 0;
        const list = await sakuraMemRead('classic_memories', scopeId);
        return Array.isArray(list) ? list.length : 0;
    }
    function applyMemExportDisabled(btn, empty) {
        if (!btn || !btn.isConnected) return;
        if (btn.disabled !== empty) {
            btn.disabled = empty;
            btn.title = empty ? '暂无记忆可导出' : '导出';
        }
    }
    let _memExportStateLast = 0;
    function refreshMemExportDisabled(btn, force) {
        if (!btn || !btn.isConnected) return;
        const now = Date.now();
        if (!force && now - _memExportStateLast < 1500) return; // 节流：IDB 读取最勤 1.5 秒一次
        _memExportStateLast = now;
        sakuraMemCount().then(count => applyMemExportDisabled(btn, count === 0)).catch(() => {});
    }
    function restoreMemoryImportExport() {
        const headers = document.querySelectorAll('settings-page-header, .settings-page-header');
        let header = null;
        for (const hdr of headers) {
            if ((hdr.textContent || '').includes('记忆系统')) { header = hdr; break; }
        }
        if (!header) return;
        // 官方插槽包装层是唯一稳定锚点：SettingsPageHeader 模板恒渲染 <div class="flex space-x-2 md:space-x-3"><slot/></div>。
        // 旧版拿垃圾桶当锚点 → 无记忆时垃圾桶 v-if 消失，按钮被甩到 header 根节点（justify-between 拉得老开）；
        // 导入后垃圾桶在 v-if 锚点位置插队到按钮前面 → 挤成一团。切页重渲染才碰巧归位。
        const clearBtn = header.querySelector('button[title*="清空"]');
        const wrapper = (clearBtn && clearBtn.parentElement && clearBtn.parentElement !== header)
            ? clearBtn.parentElement
            : header.querySelector('div.space-x-2');
        if (!wrapper) return; // 包装层未渲染（理论不发生），等下一轮 observer 再试
        // 收敛式守卫：全局清点注入按钮——header 外的孤儿残留直接清除；
        // header 内不满足「同在包装层、导出在前导入在后、垃圾桶在最后」即全部移除重建。
        let insideCount = 0;
        document.querySelectorAll('.sakura-mem-io-export, .sakura-mem-io-import').forEach(el => {
            if (header.contains(el)) insideCount++;
            else el.remove();
        });
        if (insideCount === 2) {
            const ex = header.querySelector('.sakura-mem-io-export');
            const im = header.querySelector('.sakura-mem-io-import');
            const orderOk = !!(ex && im && (ex.compareDocumentPosition(im) & Node.DOCUMENT_POSITION_FOLLOWING));
            const sameHost = !!(ex && im && ex.parentElement === wrapper && im.parentElement === wrapper);
            const trashOk = !clearBtn || !!(im.compareDocumentPosition(clearBtn) & Node.DOCUMENT_POSITION_FOLLOWING);
            if (orderOk && sameHost && trashOk) {
                refreshMemExportDisabled(ex); // 无记忆→灰，有记忆→亮（导入/删除/切角色后自动跟随）
                return;
            }
        }
        document.querySelectorAll('.sakura-mem-io-export, .sakura-mem-io-import').forEach(el => {
            if (header.contains(el)) el.remove();
        });
        // 1.9.4 已删除 .settings-icon-button CSS 类；官方清空按钮用内联 Tailwind 类，按钮外观与其完全一致
        const ICON_BTN_CLS = 'p-2.5 bg-white text-gray-600 rounded-xl border border-gray-200 shadow-sm active:scale-95 transition-all animate-fade-in';
        const btnExport = document.createElement('button');
        btnExport.type = 'button';
        btnExport.className = ICON_BTN_CLS + ' sakura-mem-io-export disabled:opacity-50 disabled:cursor-not-allowed';
        btnExport.title = '导出';
        btnExport.setAttribute('aria-label', '导出记忆');
        btnExport.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>';
        btnExport.addEventListener('click', e => {
            e.preventDefault();
            e.stopImmediatePropagation();
            sakuraMemExport().catch(err => {
                console.error('[苏萝萝] 导出失败:', err);
                sakuraToast(`导出失败: ${err.message || err}`, 'error');
            });
        });
        // 创建即校验一次（不节流）：无记忆 → 立即置灰，与官方 UI 模板导出键行为完全一致
        refreshMemExportDisabled(btnExport, true);
        const labelImport = document.createElement('label');
        labelImport.className = ICON_BTN_CLS + ' cursor-pointer sakura-mem-io-import';
        labelImport.title = '导入';
        labelImport.setAttribute('aria-label', '导入记忆');
        labelImport.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.className = 'hidden';
        fileInput.addEventListener('change', e => {
            const file = e.target.files && e.target.files[0];
            if (file) sakuraMemImport(file);
            e.target.value = '';
        });
        labelImport.appendChild(fileInput);
        // 1.8.9 顺序：导出 → 导入 → 清空。统一注入官方插槽包装层（flex space-x-2，自带间距）：
        // 有垃圾桶插到它前面，没有则追加到包装层尾部——有无记忆两种状态下按钮都稳稳待在右侧按钮组里。
        if (clearBtn) {
            wrapper.insertBefore(btnExport, clearBtn);
            wrapper.insertBefore(labelImport, clearBtn);
        } else {
            wrapper.appendChild(btnExport);
            wrapper.appendChild(labelImport);
        }
        console.log('[苏萝萝] 记忆导入/导出已恢复（1.8.9 原生复刻）');
    }
    // ================= 4. 调度 =================
    function safe(fn) {
        try { fn(); } catch (e) { console.warn('[苏萝萝] 模块异常:', e); }
    }

    // 🚀 性能优化：注入类零延迟（状态类已全部改为 Vue 同步 watch，不再需要防抖轮询）
    function syncState() {
        if (document.hidden) return; // 🚀 后台标签页零消耗；回前台后下一轮轮询（≤2s）自动补上
        // 注入类操作：复用统一入口（内含守卫，幂等轻量）
        runInjections();
        // 温度 / 流式 / 角色卡视图守护：幂等安装（Vue 同步 watch），装好即返回，零轮询开销
        safe(installPreferenceGuards);
    }

    // 🚀 性能优化（v19.5.4 修复）：注入类操作加时间闸门。
    //   原实现每帧（rAF）都跑 8~11 个全页 querySelectorAll，流式打字时每秒数百次全页扫描，
    //   是移动端"点哪都卡"的主源之一。改为最多每 150ms 跑一次（肉眼无感的注入延迟），
    //   负载直降约 10 倍；切页时仍由下方 syncState() 立即补一次，保证按钮即时出现。
    let _rafPending = false;
    let _lastInjectAt = 0;
    const INJECT_MIN_INTERVAL = 150;
    function runInjections() {
        // 只跑注入类（零延迟，同一帧内执行），不触发状态类防抖，保证切页时卡片立即出现无闪烁
        safe(injectSakuraSettingsSection);
        safe(injectMessageBookmarkButtons);
        safe(injectGramophoneButton);
        safe(injectSplitApiPanels);
        safe(injectClassicMemoryEditButtons);
        safe(restoreMemoryImportExport);
        safe(injectFullscreenComposer);
        // ⚠️ 注意：温度 / 流式 / 角色卡视图守护已全部改为 Vue 同步 watch（installPreferenceGuards），
        // 不受 Observer 闸门影响，也不在本函数里跑。
    }
    const observer = new MutationObserver(() => {
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => {
            _rafPending = false;
            const now = Date.now();
            if (now - _lastInjectAt < INJECT_MIN_INTERVAL) return;
            _lastInjectAt = now;
            runInjections();
        });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // 低频兜底轮询：覆盖 observer 可能漏掉的情况
    setInterval(syncState, 2000);
    await migratePrivateData();
    await ensureMomentsHydrated();
    syncState();
    // 🚀 启动快速探针：Vue 挂载可能晚于首次 syncState，用 100ms 粒度尽快把温度/流式守护装上
    //（幂等函数，装上即返回 true，随即停表；最坏 4 秒放弃，交给 2 秒兜底轮询）
    (function prefGuardFastProbe() {
        let tries = 0;
        const timer = setInterval(() => {
            let ok = false;
            try { ok = installPreferenceGuards(); } catch (_) {}
            if (ok || ++tries > 40) clearInterval(timer);
        }, 100);
    })();

// ============ 纯净观看模式：隐藏聊天壳层，只保留对话内容 ============
    let cleanViewHidden = [];
    function rememberCleanHidden(el) {
        if (!el || !el.isConnected || cleanViewHidden.some(item => item.el === el)) return;
        cleanViewHidden.push({
            el,
            display: el.style.getPropertyValue('display'),
            priority: el.style.getPropertyPriority('display')
        });
        el.style.setProperty('display', 'none', 'important');
    }
    function findCleanComposer() {
        const input = document.querySelector('textarea.chat-input-scrollbar, textarea[placeholder*="输入"], textarea[placeholder*="消息"]');
        if (!input) return null;
        let node = input;
        for (let depth = 0; node && node.parentElement && depth < 8; depth++) {
            const parent = node.parentElement;
            const clue = `${parent.tagName} ${parent.id || ''} ${parent.className || ''}`;
            if (parent.tagName === 'FORM' || /fixed|bottom|composer|input-area|chat-input/i.test(clue)) return parent;
            node = parent;
        }
        return input.parentElement?.parentElement || input.parentElement;
    }
    function collectCleanChrome() {
        // 只记录真正需要隐藏的壳层，按钮保持原 DOM、原位置，不把工具栏父节点隐藏。
        document.querySelectorAll('.app-sidebar, .app-nav-trigger--embedded, .app-nav-trigger').forEach(rememberCleanHidden);
        const clean = document.querySelector('.sakura-clean-view-btn');
        const full = document.querySelector('button[title="全屏聊天"],button[title="退出全屏"]');
        const toolWrap = clean?.parentElement || full?.parentElement;
        if (toolWrap) {
            // 纯净模式右侧只保留眼睛按钮。
            [...toolWrap.children].forEach(el => {
                if (el !== clean) rememberCleanHidden(el);
            });
        }
        const composer = findCleanComposer();
        if (composer) rememberCleanHidden(composer);
        const input = document.querySelector('textarea.chat-input-scrollbar');
        // V20 原生派：2.0.0 输入区容器为 .input-island，外层为 .input-area-mobile（旧 .flex.items-end 已废）
        const inputShell = input?.closest('.input-island')?.parentElement;
        if (inputShell && inputShell !== composer) rememberCleanHidden(inputShell);
    }
    function setCleanView(enabled) {
        const btn = document.querySelector('.sakura-clean-view-btn');
        if (!enabled) {
            cleanViewHidden.forEach(item => {
                if (item.el?.isConnected) {
                    if (item.display) item.el.style.setProperty('display', item.display, item.priority);
                    else item.el.style.removeProperty('display');
                }
            });
            cleanViewHidden = [];
            document.body.classList.remove('rphub-clean-view');
            btn?.setAttribute('aria-pressed', 'false');
            btn?.setAttribute('title', '纯净观看');
            return;
        }
        if (!btn) return;
        cleanViewHidden = [];
        collectCleanChrome();
        document.body.classList.add('rphub-clean-view');
        btn.setAttribute('aria-pressed', 'true');
        btn.setAttribute('title', '恢复界面');
    }
    function toggleCleanView() {
        setCleanView(!document.body.classList.contains('rphub-clean-view'));
    }
    function injectCleanViewButton() {
        if (document.querySelector('.sakura-clean-view-btn')) return;
        const full = document.querySelector('button[title="全屏聊天"], button[title="退出全屏"]');
        const wrap = full?.parentElement;
        if (!wrap) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        // V20 原生派：跟随官方 2.0.0 顶栏 chat-header-button 方形风格，不再挂旧圆形类名
        btn.className = 'sakura-clean-view-btn chat-header-button';
        btn.title = '纯净观看';
        btn.setAttribute('aria-label', '纯净观看');
        btn.setAttribute('aria-pressed', 'false');
        btn.innerHTML = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>';
        btn.onclick = e => { e.preventDefault(); e.stopImmediatePropagation(); toggleCleanView(); };
        wrap.insertBefore(btn, full);
    }
    setInterval(() => {
        if (document.hidden) return; // 🚀 后台标签页零消耗
        try { injectCleanViewButton(); } catch (_) {}
    }, 1800);
    try { injectCleanViewButton(); } catch (_) {}
    // ============================================================

    ctx.ui.addSidebarEntry({ label: '文字名场面', onClick: openMomentsPanel });
    ctx.ui.addSidebarEntry({ label: '便签', onClick() {
        ctx.ui.openPanel({ title: '便签', render(body) {
            const textarea = document.createElement('textarea');
            textarea.setAttribute('aria-label', '便签内容');
            textarea.value = pluginStorage.getItem(NOTE_KEY) || '';
            textarea.style.cssText = 'width:100%;min-height:45vh;padding:12px;box-sizing:border-box;font:inherit;';
            textarea.addEventListener('input', () => {
                try { pluginStorage.setItem(NOTE_KEY, textarea.value); }
                catch (error) { ctx.ui.toast('便签保存失败：' + error.message); }
            });
            body.append(textarea);
        } });
    } });

    }
});

