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
                    : running && running !== plugin.version ? ['已更新，刷新后生效', false] : ['已安装', false];
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
            status.textContent = '分发端已关闭，工坊不可用。';
            return;
        }
        status.textContent = '正在读取工坊目录…';
        loadWorkshopIndex().then((index) => {
            if (!container.isConnected) return;
            const plugins = Array.isArray(index?.plugins) ? index.plugins : [];
            status.textContent = plugins.length ? '经审核上架的插件，安装或更新后刷新页面生效。' : '工坊暂无插件。';
            for (const plugin of plugins) container.appendChild(workshopRow(plugin));
        }, (error) => {
            if (container.isConnected) status.textContent = `工坊目录读取失败：${error.message}`;
        });
    }

    function renderManagementPanel(body) {
        body.replaceChildren();
        state.managementBody = body;
        renderPluginLauncher(body);
        const note = element('p', 'rph-ui-note', '改动刷新后生效；插件文件、启用状态和插件数据随云同步保存。');
        note.dataset.rphWorkshopNotice = '';

        const addRow = element('div', 'rph-ui-inline');
        const input = element('input', 'rph-ui-input');
        input.type = 'url';
        input.placeholder = 'https://example.com/module.js';
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
            if (!await confirmRisk('插件拥有页面全部权限。确认安装此文件并将它纳入云同步吗？')) return;
            const url = 'rphub-file:' + crypto.randomUUID() + '/' + encodeURIComponent(file.name);
            await saveModuleSource(url, await file.text());
            if (!addInstallation({ id: '', name: file.name, url, enabled: true, addedAt: Date.now(), lastStatus: '' })) return;
            refreshManagementPanel();
            showToast('插件文件已保存，刷新后生效', { kind: 'info' });
        });
        importButton.onclick = () => fileInput.click();
        addRow.append(input, install, importButton, fileInput);

        const toolbar = element('div', 'rph-ui-inline');
        const count = element('span', 'rph-ui-muted', `已安装 ${state.installations.length} 个模块`);
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

        const list = element('div', 'rph-ui-list');
        list.dataset.rphWorkshopModuleList = '';
        if (!state.installations.length) list.appendChild(element('p', 'rph-ui-empty', '尚未安装模块'));
        for (const entry of state.installations) {
            const runtime = state.runtimesByUrl.get(entry.url);
            const manifest = runtime?.manifest || null;
            const row = element('div', 'rph-ui-row');
            row.dataset.rphWorkshopModuleRow = entry.url;
            const displayUrl = entry.url.startsWith('rphub-file:') ? '已保存的插件文件' : entry.url;
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
                    showToast('模块安装列表保存失败');
                    return;
                }
                showToast('模块启停改动将在刷新后生效', { kind: 'info' });
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
        const market = element('section', 'rph-ui-section');
        market.dataset.rphWorkshopMarket = '';
        market.appendChild(element('h3', '', '工坊'));
        renderWorkshopMarket(market);
        body.append(note, addRow, toolbar, list, market);
    }

    function openManagementPanel() {
        openPanel({ title: '模块管理', render: renderManagementPanel });
    }

    // 调用插件回调：同步异常和被拒绝的 Promise 都只记日志，不影响页面和其他插件。
