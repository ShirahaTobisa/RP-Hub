// 预设方案：把 RPH 预设列表里“哪些条目开着”存成方案，一键切换（像酒馆切预设那样）。
// 方案只记开关、不存条目内容：内容只在 RPH 的预设里改一次，切换方案不会把改过的内容换回去。
// 条目按名字对应，同名的按先后顺序对应；存方案之后才加的条目，切换时保持原样。
// 方案存在插件数据里，随云同步；可以导出成文件分享，导入时同名方案会被替换。
RPHubSDK.register({
    id: 'preset-schemes', name: '预设方案', version: '1.0.0', requiresApi: 4,
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
        // 每个条目对应成 [名字, 第几个同名, 条目]。
        function keyed(list) {
            const seen = new Map();
            return list.map((preset) => {
                const name = String(preset.name);
                const index = seen.get(name) || 0;
                seen.set(name, index + 1);
                return [name, index, preset];
            });
        }
        // 方案里记的开关：名字 → 按顺序的开关列表。
        function recorded(scheme) {
            const map = new Map();
            for (const [name, on] of scheme.states) {
                if (!map.has(name)) map.set(name, []);
                map.get(name).push(on);
            }
            return map;
        }
        const snapshot = () => presets().map((preset) => [String(preset.name), preset.enabled !== false]);
        const isOn = (preset) => preset.enabled !== false;

        // 切换到这个方案要改的条目：[条目, 方案里的开关]；compared 是方案里记了、页面上也还在的条目数。
        function differences(scheme) {
            const wanted = recorded(scheme);
            const changes = [];
            let compared = 0;
            for (const [name, index, preset] of keyed(presets())) {
                const on = wanted.get(name)?.[index];
                if (on === undefined) continue;
                compared += 1;
                if (isOn(preset) !== on) changes.push([preset, on]);
            }
            return { changes, compared };
        }

        function apply(scheme) {
            const { changes } = differences(scheme);
            for (const [preset, on] of changes) preset.enabled = on;
            return changes.length;
        }

        function isCurrent(scheme) {
            const { changes, compared } = differences(scheme);
            return compared > 0 && !changes.length;
        }

        // 列表里的说明：正在用的写开着几条；别的写切换后会开、关哪些（内置条目大家都开着，列出来分不出方案）。
        function describe(scheme, current) {
            if (scheme === current) return `开着 ${scheme.states.filter(([, on]) => on).length} 条`;
            const { changes, compared } = differences(scheme);
            if (!compared) return '方案里记的条目都已经不在了';
            if (!changes.length) return '和现在的开关一样';
            const names = (list) => (list.length > 4 ? `${list.slice(0, 4).join('、')} 等 ${list.length} 条` : list.join('、'));
            const turnOn = changes.filter(([, on]) => on).map(([preset]) => preset.name);
            const turnOff = changes.filter(([, on]) => !on).map(([preset]) => preset.name);
            return `切换后：${[turnOn.length && `开 ${names(turnOn)}`, turnOff.length && `关 ${names(turnOff)}`].filter(Boolean).join('；')}`;
        }

        function download(text, name) {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
            link.download = name;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        }

        function readImport(text) {
            const value = JSON.parse(text);
            const list = value?.format === FORMAT && Array.isArray(value.schemes) ? value.schemes : null;
            const valid = (scheme) => typeof scheme?.name === 'string' && scheme.name.trim() && Array.isArray(scheme.states)
                && scheme.states.every((state) => Array.isArray(state) && typeof state[0] === 'string' && typeof state[1] === 'boolean');
            if (!list || !list.every(valid)) throw new Error('不是预设方案文件。');
            return list.map((scheme) => ({ name: scheme.name.trim(), states: scheme.states.map(([name, on]) => [name, on]) }));
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
                            <p class="rph-ui-note">方案记下 RPH 预设里哪些条目开着，点「切换」一键换过去。条目内容还在 RPH 的预设里改，切换方案不会动内容；存方案之后才加的条目，切换时保持原样。</p>
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
                                const changed = apply(scheme);
                                ctx.ui.toast(changed ? `已切换到「${scheme.name}」，改了 ${changed} 个条目的开关` : `已经是「${scheme.name}」的开关了`, { kind: 'success' });
                                list();
                            });
                            act('edit', () => edit(scheme));
                            act('update', async () => {
                                scheme.states = snapshot();
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
                            schemes = [...schemes, { id: `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, states: snapshot() }];
                            await save();
                            ctx.ui.toast(`已存成方案「${name}」`, { kind: 'success' });
                            list();
                        };
                        body.querySelector('[data-act="import"]').onclick = () => {
                            const input = document.createElement('input');
                            input.type = 'file';
                            input.accept = '.json,application/json';
                            input.onchange = async () => {
                                try {
                                    const imported = readImport(await input.files[0].text());
                                    const names = new Set(imported.map((scheme) => scheme.name));
                                    schemes = [...schemes.filter((scheme) => !names.has(scheme.name)),
                                        ...imported.map((scheme, index) => ({ ...scheme, id: `s-${Date.now().toString(36)}${index}` }))];
                                    await save();
                                    ctx.ui.toast(`导入了 ${imported.length} 个方案（同名的已替换）`, { kind: 'success' });
                                    list();
                                } catch (error) { ctx.ui.toast(`导入失败：${error.message}`); }
                            };
                            input.click();
                        };
                        const exporter = body.querySelector('[data-act="export"]');
                        if (exporter) exporter.onclick = () => download(JSON.stringify({ format: FORMAT, schemes: schemes.map(({ name, states }) => ({ name, states })) }, null, 2), 'RPH 预设方案.json');
                    };

                    // 编辑方案：不改现在的开关，只改方案里记的；还没记进方案的条目默认关着，标出来。
                    const edit = (scheme) => {
                        const wanted = recorded(scheme);
                        const entries = keyed(presets()).map(([name, index, preset]) => ({ name, preset, on: wanted.get(name)?.[index] }));
                        body.innerHTML = `
                            <label class="rph-ui-field">方案名<input class="rph-ui-input" data-name value="${escapeHtml(scheme.name)}"></label>
                            <label class="rph-ui-field">找条目<input class="rph-ui-input" data-filter placeholder="输入名字筛选"></label>
                            <div data-entries>${entries.map((entry, index) => `<div class="rph-ui-row" data-entry="${index}">
                                <div class="rph-ui-row-main"><b>${escapeHtml(entry.name)}</b>
                                    <span class="rph-ui-muted">· ${ROLES[entry.preset.role] || '系统'}${entry.on === undefined ? ' · 新条目，还没记进方案' : ''}</span></div>
                                <label class="rph-ui-check"><input type="checkbox" class="settings-toggle-input sr-only" aria-label="${escapeHtml(entry.name)}" ${entry.on ? 'checked' : ''}><span class="settings-toggle"></span></label>
                            </div>`).join('')}</div>
                            <div class="rph-ui-actions">
                                <button type="button" class="modal-secondary-button rph-ui-button" data-act="back">返回</button>
                                <button type="button" class="modal-primary-button rph-ui-button" data-act="save">保存方案</button>
                            </div>`;
                        body.querySelector('[data-filter]').oninput = (event) => {
                            const text = event.target.value.trim().toLowerCase();
                            for (const row of body.querySelectorAll('[data-entry]')) row.hidden = Boolean(text) && !entries[row.dataset.entry].name.toLowerCase().includes(text);
                        };
                        body.querySelector('[data-act="back"]').onclick = list;
                        body.querySelector('[data-act="save"]').onclick = async () => {
                            const name = body.querySelector('[data-name]').value.trim();
                            if (!name) return ctx.ui.toast('方案名不能空着', { kind: 'warning' });
                            scheme.name = name;
                            scheme.states = [...body.querySelectorAll('[data-entry]')].map((row) => [entries[row.dataset.entry].name, row.querySelector('input').checked]);
                            await save();
                            ctx.ui.toast(`已保存「${name}」；要用它就点「切换」`, { kind: 'success' });
                            list();
                        };
                    };
                    list();
                }
            });
        }

        ctx.ui.addComposerButton({ label: '预设方案', text: '方案', onClick: openPanel });
        ctx.ui.addSidebarEntry({ label: '预设方案', onClick: openPanel });
    }
});
