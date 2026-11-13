// 预设方案：把 RPH 预设列表里“哪些条目开着”存成方案，一键切换（像酒馆切预设那样）。全局正则的开关也一起记、一起切，角色卡自带的正则不管。
// 方案只记开关、不存条目内容：内容只在 RPH 的预设里改一次，切换方案不会把改过的内容换回去。
// 条目和正则按名字对应，同名的按先后顺序对应；存方案之后才加的，切换时保持原样；没记正则的旧方案切换时不动正则。
// 「预设管理」页顶上有方案下拉框，选中就切换；聊天输入框上方的「方案」按钮和模块管理里也能打开方案面板。
// 方案存在插件数据里，随云同步。导出的文件带上方案用到的条目和正则，别人导入时缺的会补上（先关着），同名方案会被替换。
RPHubSDK.register({
    id: 'preset-schemes', name: '预设方案', version: '1.3.0', requiresApi: 4,
    init(ctx) {
        'use strict';
        const FORMAT = 'rph-preset-schemes-v1';
        const ROLES = { system: '系统', user: '用户', assistant: '助手' };
        const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
        let schemes = null;
        const load = async () => { schemes ??= (await ctx.data.get('schemes')) || []; return schemes; };
        const save = () => ctx.data.set('schemes', schemes);

        function presets() {
            const list = ctx.app.get('presets');
            if (!Array.isArray(list)) throw new Error('页面的预设还没加载好，稍后再试。');
            return list;
        }
        // 全局正则；角色卡自带的正则跟着卡走，方案不管。
        function regexes() {
            const list = ctx.app.get('regexScripts');
            if (!Array.isArray(list)) throw new Error('页面的正则还没加载好，稍后再试。');
            return list.filter((script) => script?.scope === 'global');
        }
        const nameOf = (item) => String(item.name ?? item.scriptName ?? '');
        // 每个条目（或正则）对应成 [名字, 第几个同名, 条目]。
        function keyed(list) {
            const seen = new Map();
            return list.map((item) => {
                const name = nameOf(item);
                const index = seen.get(name) || 0;
                seen.set(name, index + 1);
                return [name, index, item];
            });
        }
        // 方案里记的开关：名字 → 按顺序的开关列表。
        function recorded(states) {
            const map = new Map();
            for (const [name, on] of states) {
                if (!map.has(name)) map.set(name, []);
                map.get(name).push(on);
            }
            return map;
        }
        const isOn = (item) => item.enabled !== false;
        const snapshot = () => ({
            states: presets().map((preset) => [nameOf(preset), isOn(preset)]),
            regexStates: regexes().map((script) => [nameOf(script), isOn(script)])
        });

        // 切换到这个方案要改的：[条目或正则, 方案里的开关]；compared 是方案里记了、页面上也还在的个数。没记正则的旧方案不比正则。
        function differences(scheme) {
            const changes = [], regexChanges = [];
            let compared = 0;
            const walk = (list, states, out) => {
                const wanted = recorded(states);
                for (const [name, index, item] of keyed(list)) {
                    const on = wanted.get(name)?.[index];
                    if (on === undefined) continue;
                    compared += 1;
                    if (isOn(item) !== on) out.push([item, on]);
                }
            };
            walk(presets(), scheme.states, changes);
            if (scheme.regexStates) walk(regexes(), scheme.regexStates, regexChanges);
            return { changes, regexChanges, compared };
        }

        function apply(scheme) {
            const { changes, regexChanges } = differences(scheme);
            for (const [item, on] of [...changes, ...regexChanges]) item.enabled = on;
            return [changes.length, regexChanges.length];
        }

        function isCurrent(scheme) {
            const { changes, regexChanges, compared } = differences(scheme);
            return compared > 0 && !changes.length && !regexChanges.length;
        }

        function switchTo(scheme) {
            const [changed, regexChanged] = apply(scheme);
            const what = [changed && `${changed} 个条目`, regexChanged && `${regexChanged} 条正则`].filter(Boolean).join('、');
            ctx.ui.toast(what ? `已切换到「${scheme.name}」，改了 ${what}的开关` : `已经是「${scheme.name}」的开关了`, { kind: 'success' });
        }

        // 列表里的说明：正在用的写开着几条；别的写切换后会开、关哪些条目（内置条目大家都开着，列出来分不出方案），正则只写条数。
        function describe(scheme, current) {
            const count = (states) => states.filter(([, on]) => on).length;
            if (scheme === current) return `开着 ${count(scheme.states)} 条${scheme.regexStates ? `，正则 ${count(scheme.regexStates)} 条` : ''}`;
            const { changes, regexChanges, compared } = differences(scheme);
            if (!compared) return '方案里记的条目都已经不在了';
            if (!changes.length && !regexChanges.length) return '和现在的开关一样';
            const names = (list) => (list.length > 4 ? `${list.slice(0, 4).join('、')} 等 ${list.length} 条` : list.join('、'));
            const turnOn = changes.filter(([, on]) => on).map(([preset]) => preset.name);
            const turnOff = changes.filter(([, on]) => !on).map(([preset]) => preset.name);
            const regexOn = regexChanges.filter(([, on]) => on).length, regexOff = regexChanges.length - regexOn;
            return `切换后：${[turnOn.length && `开 ${names(turnOn)}`, turnOff.length && `关 ${names(turnOff)}`,
                regexOn && `开正则 ${regexOn} 条`, regexOff && `关正则 ${regexOff} 条`].filter(Boolean).join('；')}`;
        }

        // 方案文件带上方案用到的预设条目（名字、内容、角色）和正则：对方没有时一起导入，方案才切得动。
        function exportSchemes(list, fileName) {
            if (!list.length) return ctx.ui.toast('还没有方案可以导出', { kind: 'warning' });
            const used = (key) => new Set(list.flatMap((scheme) => (scheme[key] || []).map(([name]) => name)));
            const usedPresets = used('states'), usedRegex = used('regexStates');
            const entries = presets().filter((preset) => usedPresets.has(nameOf(preset)))
                .map((preset) => ({ name: nameOf(preset), content: String(preset.content ?? ''), role: preset.role || 'system' }));
            const regex = regexes().filter((script) => usedRegex.has(nameOf(script)))
                .map(({ enabled, disabled, scope, ...script }) => ({ ...script, name: nameOf(script) }));
            const file = { format: FORMAT, schemes: list.map(({ name, states, regexStates }) => ({ name, states, ...(regexStates && { regexStates }) })), presets: entries };
            if (regex.length) file.regex = regex;
            const link = document.createElement('a');
            link.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
            link.download = fileName;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        }

        // 导入：同名方案替换。文件里带的条目和正则，本地没有的（同名的按个数补齐）加到列表末尾，先关着，切到方案时才打开；
        // 本地已有的同名条目、正则用本地的。
        async function importSchemes(text) {
            const value = JSON.parse(text);
            const validStates = (states) => Array.isArray(states)
                && states.every((state) => Array.isArray(state) && typeof state[0] === 'string' && typeof state[1] === 'boolean');
            const validScheme = (scheme) => typeof scheme?.name === 'string' && scheme.name.trim() && validStates(scheme.states)
                && (scheme.regexStates === undefined || validStates(scheme.regexStates));
            const validList = (list, check) => list === undefined || (Array.isArray(list) && list.every(check));
            if (value?.format !== FORMAT || !Array.isArray(value.schemes) || !value.schemes.every(validScheme)
                || !validList(value.presets, (entry) => typeof entry?.name === 'string' && typeof entry.content === 'string')
                || !validList(value.regex, (script) => typeof script?.name === 'string' && typeof script.regex === 'string')) {
                throw new Error('不是预设方案文件。');
            }
            const addMissing = (have, items = [], add) => {
                const count = new Map(), seen = new Map();
                for (const item of have) count.set(nameOf(item), (count.get(nameOf(item)) || 0) + 1);
                let added = 0;
                for (const item of items) {
                    const index = (seen.get(item.name) || 0) + 1;
                    seen.set(item.name, index);
                    if (index <= (count.get(item.name) || 0)) continue;
                    add(item);
                    added += 1;
                }
                return added;
            };
            const list = presets();
            const added = addMissing(list, value.presets,
                (entry) => list.push({ name: entry.name, content: entry.content, role: ROLES[entry.role] ? entry.role : 'system', enabled: false }));
            const addedRegex = value.regex?.length
                ? addMissing(regexes(), value.regex, ({ disabled, ...script }) => ctx.app.get('regexScripts').push({ ...script, scope: 'global', enabled: false }))
                : 0;
            const copy = (states) => states.map(([name, on]) => [name, on]);
            const imported = value.schemes.map((scheme, index) => ({
                id: `s-${Date.now().toString(36)}${index}`, name: scheme.name.trim(), states: copy(scheme.states),
                ...(scheme.regexStates && { regexStates: copy(scheme.regexStates) })
            }));
            const names = new Set(imported.map((scheme) => scheme.name));
            schemes = [...schemes.filter((scheme) => !names.has(scheme.name)), ...imported];
            await save();
            const what = [added && `${added} 个预设条目`, addedRegex && `${addedRegex} 条正则`].filter(Boolean).join('、');
            return `导入了 ${imported.length} 个方案（同名的已替换）${what ? `，新加了 ${what}，先关着，切到方案时打开` : ''}`;
        }

        // 选文件导入，面板和预设页的导入按钮共用。
        function pickImport(done) {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = async () => {
                try {
                    ctx.ui.toast(await importSchemes(await input.files[0].text()), { kind: 'success' });
                    done?.();
                } catch (error) { ctx.ui.toast(`导入失败：${error.message}`); }
                syncBar();
            };
            input.click();
        }

        async function openPanel() {
            try { await load(); } catch (error) { return ctx.ui.toast(`预设方案读取失败：${error.message}`); }
            ctx.ui.openPanel({
                title: '预设方案',
                render(body) {
                    const list = () => {
                        let current = null;
                        try { current = schemes.find(isCurrent) || null; } catch (error) { body.innerHTML = `<p class="rph-ui-note">${escapeHtml(error.message)}</p>`; return; }
                        body.innerHTML = `
                            <p class="rph-ui-note">方案记下 RPH 预设里哪些条目开着（全局正则也一起记），点「切换」一键换过去。条目内容还在 RPH 的预设里改，切换方案不会动内容；存方案之后才加的条目，切换时保持原样。</p>
                            <p class="rph-ui-muted">${current ? `现在用的是「${escapeHtml(current.name)}」` : schemes.length ? '现在的开关和哪个方案都不一样' : '还没有方案，先把现在的开关存成一个。'}</p>
                            ${schemes.map((scheme) => `<div class="rph-ui-row" data-scheme="${escapeHtml(scheme.id)}">
                                    <div class="rph-ui-row-main"><b>${escapeHtml(scheme.name)}</b>
                                        <div class="rph-ui-muted">${escapeHtml(describe(scheme, current))}</div></div>
                                    <div class="rph-ui-actions">
                                        ${scheme === current ? '<span class="rph-ui-muted">正在用</span>' : '<button type="button" class="modal-primary-button rph-ui-button" data-act="apply">切换</button>'}
                                        <button type="button" class="modal-secondary-button rph-ui-button" data-act="edit">编辑</button>
                                        <button type="button" class="modal-secondary-button rph-ui-button" data-act="update" title="把现在的开关存进这个方案">更新</button>
                                        <button type="button" class="modal-secondary-button rph-ui-button rph-ui-danger" data-act="delete">删除</button>
                                    </div>
                                </div>`).join('')}
                            <section class="rph-ui-section" style="margin-top:16px">
                                <h3>把现在的开关存成新方案</h3>
                                <label class="rph-ui-field">方案名<input class="rph-ui-input" data-new placeholder="比如：日常、战斗、第三人称"></label>
                                <div class="rph-ui-actions">
                                    <button type="button" class="modal-secondary-button rph-ui-button" data-act="import">导入</button>
                                    ${schemes.length ? '<button type="button" class="modal-secondary-button rph-ui-button" data-act="export">导出全部</button>' : ''}
                                    <button type="button" class="modal-primary-button rph-ui-button" data-act="add">存成方案</button>
                                </div>
                            </section>`;
                        for (const row of body.querySelectorAll('[data-scheme]')) {
                            const scheme = schemes.find((item) => item.id === row.dataset.scheme);
                            const act = (name, handler) => { const button = row.querySelector(`[data-act="${name}"]`); if (button) button.onclick = handler; };
                            act('apply', () => {
                                switchTo(scheme);
                                list();
                            });
                            act('edit', () => edit(scheme));
                            act('update', async () => {
                                Object.assign(scheme, snapshot());
                                await save();
                                ctx.ui.toast(`已把现在的开关存进「${scheme.name}」`, { kind: 'success' });
                                list();
                            });
                            act('delete', async () => {
                                if (!await window.RPHubUI.confirm({ title: '删除方案', message: `删除方案「${scheme.name}」？预设条目本身不受影响。`, confirmText: '删除', danger: true })) return;
                                schemes = schemes.filter((item) => item !== scheme);
                                await save();
                                list();
                            });
                        }
                        body.querySelector('[data-act="add"]').onclick = async () => {
                            const name = body.querySelector('[data-new]').value.trim();
                            if (!name) return ctx.ui.toast('先给方案起个名字', { kind: 'warning' });
                            schemes = [...schemes, { id: `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, ...snapshot() }];
                            await save();
                            ctx.ui.toast(`已存成方案「${name}」`, { kind: 'success' });
                            list();
                        };
                        body.querySelector('[data-act="import"]').onclick = () => pickImport(list);
                        const exporter = body.querySelector('[data-act="export"]');
                        if (exporter) exporter.onclick = () => exportSchemes(schemes, 'RPH 预设方案.json');
                        syncBar();
                    };

                    // 编辑方案：不改现在的开关，只改方案里记的；还没记进方案的条目、正则默认关着，标出来。没记正则的旧方案不列正则。
                    const edit = (scheme) => {
                        const rows = (items, states) => {
                            const wanted = recorded(states);
                            return keyed(items).map(([name, index, item]) => ({ name, item, on: wanted.get(name)?.[index] }));
                        };
                        const kinds = { entry: rows(presets(), scheme.states), regex: scheme.regexStates ? rows(regexes(), scheme.regexStates) : [] };
                        const row = (kind, entry, index) => `<div class="rph-ui-row" data-${kind}="${index}">
                                <div class="rph-ui-row-main"><b>${escapeHtml(entry.name)}</b>
                                    <span class="rph-ui-muted">· ${kind === 'regex' ? '正则' : ROLES[entry.item.role] || '系统'}${entry.on === undefined ? ` · 新${kind === 'regex' ? '正则' : '条目'}，还没记进方案` : ''}</span></div>
                                <label class="rph-ui-check"><input type="checkbox" class="settings-toggle-input sr-only" aria-label="${escapeHtml(entry.name)}" ${entry.on ? 'checked' : ''}><span class="settings-toggle"></span></label>
                            </div>`;
                        body.innerHTML = `
                            <label class="rph-ui-field">方案名<input class="rph-ui-input" data-name value="${escapeHtml(scheme.name)}"></label>
                            <label class="rph-ui-field">找条目<input class="rph-ui-input" data-filter placeholder="输入名字筛选"></label>
                            <div data-entries>${Object.entries(kinds).map(([kind, list]) => list.map((entry, index) => row(kind, entry, index)).join('')).join('')}</div>
                            <div class="rph-ui-actions">
                                <button type="button" class="modal-secondary-button rph-ui-button" data-act="back">返回</button>
                                <button type="button" class="modal-secondary-button rph-ui-button" data-act="export">导出这个方案</button>
                                <button type="button" class="modal-primary-button rph-ui-button" data-act="save">保存方案</button>
                            </div>`;
                        const each = (handle) => Object.keys(kinds).forEach((kind) => body.querySelectorAll(`[data-${kind}]`)
                            .forEach((item) => handle(item, kinds[kind][item.dataset[kind]], kind)));
                        body.querySelector('[data-filter]').oninput = (event) => {
                            const text = event.target.value.trim().toLowerCase();
                            each((item, entry) => { item.hidden = Boolean(text) && !entry.name.toLowerCase().includes(text); });
                        };
                        // 编辑框里现在的样子（没保存也算），保存和导出都用它。
                        const draft = () => {
                            const states = { entry: [], regex: [] };
                            each((item, entry, kind) => states[kind].push([entry.name, item.querySelector('input').checked]));
                            return { name: body.querySelector('[data-name]').value.trim(), states: states.entry, ...(scheme.regexStates && { regexStates: states.regex }) };
                        };
                        body.querySelector('[data-act="back"]').onclick = list;
                        body.querySelector('[data-act="export"]').onclick = () => {
                            const { name, ...states } = draft();
                            exportSchemes([{ name: name || scheme.name, ...states }], `RPH 预设方案-${name || scheme.name}.json`);
                        };
                        body.querySelector('[data-act="save"]').onclick = async () => {
                            const { name, ...states } = draft();
                            if (!name) return ctx.ui.toast('方案名不能空着', { kind: 'warning' });
                            Object.assign(scheme, { name, ...states });
                            await save();
                            ctx.ui.toast(`已保存「${name}」；要用它就点「切换」`, { kind: 'success' });
                            list();
                        };
                    };
                    list();
                }
            });
        }

        // 原生「预设管理」页：列表上方加一个方案下拉框（像酒馆预设面板顶上的下拉框），选中就切换，旁边「管理方案」打开面板。
        // 用 RPH 自己的下拉框组件，样式和设置页一致；页面切走时随原页面一起销毁，切回来再加上。
        let bar = null;
        function syncBar() {
            if (!bar?.root.isConnected) return;
            let current = null;
            try { current = schemes.find(isCurrent) || null; } catch (_) { /* 预设还没加载好 */ }
            // 官方 2.0.5 的下拉框去掉了占位文字，没对上方案时在最上面放一条点不了的提示，各版本显示一样。
            const hint = { value: '', label: schemes.length ? '现在的开关没存成方案' : '还没有方案，点「管理方案」存一个', disabled: true };
            Object.assign(bar.view, {
                value: current?.id || '',
                options: [...(current ? [] : [hint]), ...schemes.map((scheme) => ({ value: scheme.id, label: scheme.name }))]
            });
        }
        async function mountBar() {
            await load();
            const list = document.getElementById('presets-list');
            const Select = window.RPHubCustomSelect;
            const Vue = globalThis.Vue;
            if (bar?.root.isConnected || !list || !Select || !Vue?.createApp) return syncBar();
            const root = document.createElement('div');
            root.className = 'mb-4';
            root.dataset.presetSchemesBar = '';
            const icon = (name, label) => `<button type="button" class="settings-icon-button" data-${name} title="${label}" aria-label="${label}">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><use href="#icon-${name}"></use></svg></button>`;
            root.innerHTML = `<label class="settings-label">预设方案</label>
                <div class="flex items-center gap-2"><div class="flex-1 min-w-0" data-select></div>
                ${icon('export', '导出全部方案')}${icon('import', '导入方案')}
                <button type="button" class="modal-secondary-button rph-ui-button" data-manage>管理方案</button></div>`;
            root.querySelector('[data-manage]').onclick = openPanel;
            root.querySelector('[data-import]').onclick = () => pickImport();
            root.querySelector('[data-export]').onclick = () => exportSchemes(schemes, 'RPH 预设方案.json');
            const view = Vue.reactive({ value: '', options: [] });
            const app = Vue.createApp({
                render: () => Vue.h(Select, {
                    modelValue: view.value, options: view.options, buttonClass: 'settings-control',
                    'onUpdate:modelValue': (id) => {
                        const scheme = schemes.find((item) => item.id === id);
                        if (scheme) switchTo(scheme);
                        syncBar();
                    }
                })
            });
            app.mount(root.querySelector('[data-select]'));
            list.before(root);
            bar = { root, view, app };
            syncBar();
        }
        ctx.app.watch(() => ctx.app.get('currentView'), (view) => {
            if (view !== 'presets') {
                bar?.app.unmount();
                bar = null;
                return;
            }
            globalThis.Vue.nextTick(() => mountBar().catch((error) => ctx.log('预设页方案栏没加上', error)));
        }, { immediate: true });
        // 在原生列表里手动开关条目或全局正则后，下拉框跟着显示对应的方案（或「没存成方案」）。
        ctx.app.watch(() => [...(ctx.app.get('presets') || []), ...(ctx.app.get('regexScripts') || []).filter((script) => script?.scope === 'global')]
            .map((item) => `${nameOf(item)}\n${isOn(item)}`).join('\n'), syncBar);

        ctx.ui.addComposerButton({ label: '预设方案', text: '方案', onClick: openPanel });
        ctx.ui.addSidebarEntry({ label: '预设方案', onClick: openPanel });
    }
});
