// 多供应商模型：同时启用几个 AI 供应商。在 RPH 设置里选模型时，列出所有已启用供应商的模型（旁边标出供应商）；
// 选了哪个模型，请求就自动发到它所在的供应商，地址和密钥跟着换。RPH 设置里当前选的供应商（主供应商）自动包含、最优先。
// 只改发往主供应商地址的请求（聊天、记忆总结与向量、UI 分析、识图，以及角色卡生成页、小说页里的请求）；
// 被别的插件（如柳贯一分流）改到其他地址的请求不动。同名模型按面板里的顺序，取排在前面的供应商。
RPHubSDK.register({
    id: 'multi-provider', name: '多供应商模型', version: '1.0.0', requiresApi: 3,
    init(ctx) {
        'use strict';
        const read = (key, fallback) => { try { return JSON.parse(ctx.storage.get(key)) ?? fallback; } catch (_) { return fallback; } };
        const write = (key, value) => {
            try { ctx.storage.set(key, JSON.stringify(value)); } catch (error) { ctx.log?.('save failed', key, error); }
        };
        // enabled：启用的供应商 id（按优先顺序）；custom：在插件里添加的供应商；routes：模型 → 供应商 id（拉模型列表时生成）。
        let enabled = read('enabled', []);
        let custom = read('custom', []);
        let routes = read('routes', {});
        const SLOTS = [['qualityModel', '主力模型'], ['balancedModel', '均衡模型'], ['fastModel', '快速模型'], ['visionModel', '识图模型'], ['uiTemplateModel', 'UI 模板模型']];

        const settings = () => ctx.app.get('settings') || {};
        const endpoint = (base, path) => {
            const root = String(base || '').replace(/\/+$/, '');
            return `${/\/v1$/i.test(root) ? root : `${root}/v1`}/${path}`;
        };
        const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

        // 可选的供应商：RPH 内置的、RPH 的“自定义”、在插件里添加的。内置和“自定义”的密钥用 RPH 设置里存的那份。
        function allProviders() {
            const s = settings();
            const keys = s.apiProviderKeys || {};
            return [
                ...(ctx.app.get('apiProviderOptions') || []).map((p) => ({ id: p.id, name: p.name, url: p.apiUrl, key: keys[p.id] || '', kind: 'builtin' })),
                { id: 'custom', name: 'RPH 自定义', url: s.customApiUrl || '', key: keys.custom || '', kind: 'rph-custom' },
                ...custom.map((p) => ({ ...p, kind: 'plugin' }))
            ];
        }

        function mainProvider() {
            const s = settings();
            const known = allProviders().find((p) => p.id === s.apiProviderId);
            return { id: s.apiProviderId || 'main', name: known?.name || '主供应商', url: s.apiUrl || '', key: s.apiKey || '', kind: 'main' };
        }

        // 参与列模型和转发的供应商：主供应商在最前，其后是启用了、地址和密钥都填了的。
        function activeProviders() {
            const main = mainProvider();
            const list = [main];
            const providers = allProviders();
            for (const id of enabled) {
                const provider = providers.find((item) => item.id === id);
                if (provider && provider.id !== main.id && provider.url && provider.key) list.push(provider);
            }
            return list;
        }

        // 换成目标供应商的密钥；转成普通对象，嵌入页面（另一个窗口）里的请求也能直接用。
        function withKey(headers, key) {
            const out = {};
            new Headers(headers || {}).forEach((value, name) => { out[name] = value; });
            out.authorization = `Bearer ${key}`;
            return out;
        }

        async function readModels(response) {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            return Array.isArray(body?.data) ? body.data : [];
        }

        // RPH 拉主供应商的模型列表时，同时拉其他已启用供应商的，合并后交回；同名模型取排在前面的供应商。
        async function mergeModels(win, nativeFetch, input, init, providers) {
            const mainResponse = await Reflect.apply(nativeFetch, win, [input, init]);
            const lists = await Promise.all(providers.map((provider, index) => (index === 0
                ? readModels(mainResponse.clone())
                : Reflect.apply(nativeFetch, win, [endpoint(provider.url, 'models'), { headers: { authorization: `Bearer ${provider.key}` }, signal: init?.signal }]).then(readModels))
                .then((models) => ({ models }), (error) => ({ models: [], error }))));
            const failed = providers.map((provider, index) => (lists[index].error ? `${provider.name}（${lists[index].error.message}）` : '')).filter(Boolean);
            if (failed.length) ctx.ui.toast(`这些供应商的模型列表没取到：${failed.join('、')}`, { kind: 'warning' });
            if (lists.every((list) => !list.models.length)) return mainResponse;
            const seen = new Set();
            const data = [];
            const next = {};
            providers.forEach((provider, index) => {
                for (const model of lists[index].models) {
                    const id = String(model?.id || '');
                    if (!id || seen.has(id)) continue;
                    seen.add(id);
                    data.push(model);
                    next[id] = provider.id;
                }
            });
            routes = next;
            write('routes', routes);
            return new win.Response(JSON.stringify({ object: 'list', data }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        function installRouter(win) {
            if (!win?.fetch || win.fetch.__multiProvider) return;
            const nativeFetch = win.fetch;
            const routed = async function (input, init) {
                if (typeof input !== 'string') return Reflect.apply(nativeFetch, this, [input, init]);
                const providers = activeProviders();
                const base = providers[0].url ? endpoint(providers[0].url, '') : '';
                if (providers.length < 2 || !base || !input.startsWith(base)) return Reflect.apply(nativeFetch, this, [input, init]);
                const path = input.slice(base.length).split('?')[0];
                if (path === 'models' && String(init?.method || 'GET').toUpperCase() === 'GET') return mergeModels(win, nativeFetch, input, init, providers);
                if ((path === 'chat/completions' || path === 'embeddings') && typeof init?.body === 'string') {
                    let model = '';
                    try { model = String(JSON.parse(init.body)?.model || ''); } catch (_) { /* 不是 JSON 就原样发 */ }
                    const target = providers.find((provider, index) => index > 0 && provider.id === routes[model]);
                    if (target) return Reflect.apply(nativeFetch, this, [endpoint(target.url, path), { ...init, headers: withKey(init.headers, target.key) }]);
                }
                return Reflect.apply(nativeFetch, this, [input, init]);
            };
            routed.__multiProvider = true;
            win.fetch = routed;
        }

        installRouter(window);
        // 角色卡生成页、小说页是同源的嵌入页面，加载后会先给主页面发消息；收到时把它们的请求也接管。
        window.addEventListener('message', (event) => {
            if (!event.source || event.source === window) return;
            try { installRouter(event.source); } catch (_) { /* 别的网站的嵌入页面，不管 */ }
        });

        // 模型选择框里，在每个模型旁标出供应商。
        let badgeObserver = null;
        function decorate() {
            const providers = activeProviders();
            const names = new Map(providers.length > 1 ? providers.map((provider) => [provider.id, provider.name]) : []);
            for (const button of document.querySelectorAll('button[aria-label][aria-pressed]')) {
                const name = names.get(routes[button.getAttribute('aria-label')]);
                const existing = button.querySelector('[data-multi-provider]');
                if (!name) { existing?.remove(); continue; }
                if (existing?.textContent === name) continue;
                const badge = existing || document.createElement('span');
                badge.dataset.multiProvider = '';
                badge.className = 'rph-ui-muted';
                badge.style.cssText = 'flex-shrink:0;margin-left:6px;padding:1px 7px;border:1px solid currentColor;border-radius:999px;font-size:11px;line-height:1.5;opacity:.8;';
                badge.textContent = name;
                if (!existing) (button.querySelector('span') || button.firstChild)?.after(badge);
            }
        }
        ctx.app.watch(() => ctx.app.get('showModelSelector'), (open) => {
            badgeObserver?.disconnect();
            badgeObserver = null;
            if (!open) return;
            requestAnimationFrame(decorate);
            badgeObserver = new MutationObserver(decorate);
            badgeObserver.observe(document.body, { childList: true, subtree: true });
        });

        // 关掉供应商时：还在用它的模型的模型位要重新选，否则请求会改发到主供应商。
        function slotsUsing(providerId) {
            const s = settings();
            const memory = ctx.app.get('memorySettings') || {};
            return [...SLOTS.map(([key, label]) => [s[key], label]), [memory.classicModel, '记忆总结模型'], [memory.embeddingModel, '记忆向量模型']]
                .filter(([model]) => model && routes[model] === providerId).map(([, label]) => label);
        }

        function openPanel() {
            ctx.ui.openPanel({
                title: '多供应商模型',
                render(body) {
                    const draw = () => {
                        const main = mainProvider();
                        const providers = allProviders().filter((provider) => provider.id !== main.id);
                        const order = (provider) => { const index = enabled.indexOf(provider.id); return index < 0 ? Infinity : index; };
                        providers.sort((left, right) => order(left) - order(right));
                        const counts = {};
                        for (const id of Object.values(routes)) counts[id] = (counts[id] || 0) + 1;
                        body.innerHTML = `
                            <p class="rph-ui-note">启用后，在 RPH「设置」里选模型时会列出所有已启用供应商的模型，旁边标出供应商；选了哪个模型，请求就自动发到它所在的供应商。改完这里的设置，到「设置」里点一次「获取模型」刷新列表。</p>
                            <p class="rph-ui-muted">主供应商：<b>${escapeHtml(main.name)}</b>（在 RPH 设置里选，自动包含，同名模型优先用它）${counts[main.id] ? ` · ${counts[main.id]} 个模型` : ''}</p>
                            ${providers.map((provider) => {
                                const on = enabled.includes(provider.id);
                                return `<div class="rph-ui-row" data-provider="${escapeHtml(provider.id)}">
                                    <div class="rph-ui-row-main">
                                        <b>${escapeHtml(provider.name)}</b>${on && counts[provider.id] ? ` <span class="rph-ui-muted">· ${counts[provider.id]} 个模型</span>` : ''}
                                        <div class="rph-ui-muted">${escapeHtml(provider.url || '（还没填地址，在 RPH 设置里选「自定义」填写）')}</div>
                                        <input class="rph-ui-input" type="password" data-key placeholder="API 密钥" value="${escapeHtml(provider.key)}" style="margin-top:6px">
                                    </div>
                                    <div class="rph-ui-actions">
                                        ${enabled.indexOf(provider.id) > 0 ? '<button type="button" class="modal-secondary-button rph-ui-button" data-act="up" title="排到前面（同名模型优先）">上移</button>' : ''}
                                        ${provider.kind === 'plugin' ? '<button type="button" class="modal-secondary-button rph-ui-button rph-ui-danger" data-act="delete">删除</button>' : ''}
                                        <label class="rph-ui-check"><input type="checkbox" class="settings-toggle-input sr-only" data-act="toggle" ${on ? 'checked' : ''}><span class="settings-toggle"></span><span>启用</span></label>
                                    </div>
                                </div>`;
                            }).join('')}
                            <section class="rph-ui-section" style="margin-top:16px">
                                <h3>添加供应商</h3>
                                <label class="rph-ui-field">名称<input class="rph-ui-input" data-new="name" placeholder="比如：我的中转站"></label>
                                <label class="rph-ui-field">API 地址<input class="rph-ui-input" data-new="url" placeholder="https://example.com/v1"></label>
                                <label class="rph-ui-field">API 密钥<input class="rph-ui-input" type="password" data-new="key"></label>
                                <div class="rph-ui-actions"><button type="button" class="modal-primary-button rph-ui-button" data-act="add">添加并启用</button></div>
                            </section>`;
                        for (const row of body.querySelectorAll('[data-provider]')) {
                            const provider = providers.find((item) => item.id === row.dataset.provider);
                            row.querySelector('[data-key]').onchange = (event) => {
                                const key = event.target.value.trim();
                                if (provider.kind === 'plugin') {
                                    custom = custom.map((item) => (item.id === provider.id ? { ...item, key } : item));
                                    write('custom', custom);
                                } else {
                                    const s = settings();
                                    s.apiProviderKeys = { ...(s.apiProviderKeys || {}), [provider.id]: key };
                                }
                                ctx.ui.toast(`已保存「${provider.name}」的密钥`, { kind: 'success' });
                            };
                            row.querySelector('[data-act="toggle"]').onchange = (event) => {
                                if (event.target.checked) {
                                    if (!provider.url || !(row.querySelector('[data-key]').value.trim())) {
                                        event.target.checked = false;
                                        return ctx.ui.toast(`「${provider.name}」还没填${provider.url ? '密钥' : '地址'}，填好再启用`, { kind: 'warning' });
                                    }
                                    enabled = [...enabled.filter((id) => id !== provider.id), provider.id];
                                } else {
                                    const using = slotsUsing(provider.id);
                                    enabled = enabled.filter((id) => id !== provider.id);
                                    if (using.length) ctx.ui.toast(`这些模型位还在用「${provider.name}」的模型：${using.join('、')}。关掉后它们会改发到主供应商，请到设置里重新选。`, { kind: 'warning' });
                                }
                                write('enabled', enabled);
                                draw();
                            };
                            const up = row.querySelector('[data-act="up"]');
                            if (up) up.onclick = () => {
                                const index = enabled.indexOf(provider.id);
                                if (index > 0) [enabled[index - 1], enabled[index]] = [enabled[index], enabled[index - 1]];
                                write('enabled', enabled);
                                draw();
                            };
                            const remove = row.querySelector('[data-act="delete"]');
                            if (remove) remove.onclick = async () => {
                                if (!await window.RPHubUI.confirm({ title: '删除供应商', message: `删除「${provider.name}」和它的密钥？`, confirmText: '删除', danger: true })) return;
                                custom = custom.filter((item) => item.id !== provider.id);
                                enabled = enabled.filter((id) => id !== provider.id);
                                write('custom', custom);
                                write('enabled', enabled);
                                draw();
                            };
                        }
                        body.querySelector('[data-act="add"]').onclick = () => {
                            const value = (name) => body.querySelector(`[data-new="${name}"]`).value.trim();
                            const name = value('name');
                            const url = value('url').replace(/\/+$/, '');
                            const key = value('key');
                            if (!name || !/^https?:\/\//.test(url) || !key) return ctx.ui.toast('名称、以 http(s):// 开头的地址和密钥都要填', { kind: 'warning' });
                            const id = `p-${Date.now().toString(36)}`;
                            custom = [...custom, { id, name, url, key }];
                            enabled = [...enabled, id];
                            write('custom', custom);
                            write('enabled', enabled);
                            ctx.ui.toast(`已添加并启用「${name}」，到设置里点「获取模型」就能看到它的模型`, { kind: 'success' });
                            draw();
                        };
                    };
                    draw();
                }
            });
        }

        ctx.ui.addSidebarEntry({ label: '多供应商模型', onClick: openPanel });
    }
});
