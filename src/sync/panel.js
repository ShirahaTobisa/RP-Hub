    function updateProgress(progress, text) {
        state.progress = Math.max(0, Math.min(100, progress));
        state.statusText = text || state.statusText;
        if (modalProgressBar) {
            modalProgressBar.style.width = `${state.progress}%`;
        }
        if (modalProgressValue) {
            modalProgressValue.textContent = `${Math.round(state.progress)}%`;
        }
        if (modalStatus) {
            modalStatus.textContent = state.statusText;
        }
        if (state.background && floatRoot && !floatRoot.hidden && floatRoot.dataset.kind === 'busy') {
            showFloat({ text: `上传中… ${Math.round(state.progress)}%`, progress: state.progress });
        }
    }

    function stopEstimatedProgress() {
        if (estimatedProgressTimer) {
            clearInterval(estimatedProgressTimer);
            estimatedProgressTimer = null;
        }
    }

    function startEstimatedProgress(options = {}) {
        stopEstimatedProgress();
        const startedAt = Date.now();
        const from = Number(options.from || state.progress || 8);
        const to = Number(options.to || 88);
        const durationMs = Number(options.durationMs || 150_000);
        const text = options.text || '正在下载更新';

        updateProgress(from, `${text}，已等待 0 秒…`);
        estimatedProgressTimer = setInterval(() => {
            const elapsedMs = Date.now() - startedAt;
            const elapsedSeconds = Math.floor(elapsedMs / 1000);
            const ratio = Math.min(1, elapsedMs / durationMs);
            const eased = 1 - Math.pow(1 - ratio, 2);
            const nextProgress = Math.min(to, Math.round(from + (to - from) * eased));
            updateProgress(nextProgress, `${text}，已等待 ${elapsedSeconds} 秒…`);
        }, 800);
    }

    function updateButtonState() {
        syncEntry?.update({ label: state.syncing ? '处理中' : '同步', busy: state.syncing });
    }

    function setActionButtonsDisabled(disabled) {
        if (pullButton) pullButton.disabled = disabled;
        if (pushButton) pushButton.disabled = disabled;
        if (pushFullButton) pushFullButton.disabled = disabled;
        if (appUpdateCheckButton) appUpdateCheckButton.disabled = disabled;
        if (appUpdateApplyButton) appUpdateApplyButton.disabled = disabled;
        if (appUpdateRollbackButton) appUpdateRollbackButton.disabled = disabled;
        for (const button of [selfUpdateCheckButton, selfUpdateApplyButton, selfUpdateRollbackButton, selfUpdateVersionButton]) {
            if (button) button.disabled = disabled;
        }
        if (appUpdateVersionButton) appUpdateVersionButton.disabled = disabled;
        if (closeButton) closeButton.disabled = disabled;
    }

    function getVueProxy() {
        const app = document.getElementById('app')?.__vue_app__;
        return app?._instance?.proxy || app?._container?._vnode?.component?.proxy || null;
    }

    async function flushAppState() {
        if (typeof globalThis.RPH_R2_FLUSH_PERSISTENCE !== 'function') {
            throw new Error('程序尚未加载完成，请稍后重试。');
        }
        await globalThis.RPH_R2_FLUSH_PERSISTENCE();
        await globalThis.RPHubSDK?.flush?.();
    }

    async function getAuthStatus(password = getStoredSyncPassword()) {
        return postSync({ action: 'auth-status' }, {
            password,
            keepPasswordOnAuthError: true
        });
    }

    function ensurePasswordModal() {
        if (passwordModalRoot) return;

        passwordModalRoot = document.createElement('div');
        passwordModalRoot.className = 'rp-sync-modal rp-sync-password-modal';
        passwordModalRoot.innerHTML = `
            <div class="rp-sync-modal__backdrop"></div>
            <form class="rp-sync-modal__panel compact-modal-panel rp-sync-password-panel">
                <div class="rp-sync-modal__header editor-modal-header">
                    <div>
                        <div class="rp-sync-modal__eyebrow">Sync Password</div>
                        <h3 class="rp-sync-modal__title">同步密码</h3>
                    </div>
                    <button type="button" class="rp-sync-modal__close modal-close-button" aria-label="关闭"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
                </div>
                <p class="rp-sync-modal__intro">输入一次后，本浏览器会记住密码。</p>
                <label class="rp-sync-password-field">
                    <span>密码</span>
                    <input type="password" autocomplete="current-password" placeholder="请输入同步密码">
                </label>
                <p class="rp-sync-password-status">请输入同步密码。</p>
                <div class="rp-sync-modal__actions">
                    <button type="button" class="rp-sync-modal__button modal-secondary-button" data-action="cancel-password">取消</button>
                    <button type="submit" class="rp-sync-modal__button modal-primary-button" data-action="submit-password">确定</button>
                </div>
            </form>
        `;

        document.body.appendChild(passwordModalRoot);
        passwordInput = passwordModalRoot.querySelector('input');
        passwordStatus = passwordModalRoot.querySelector('.rp-sync-password-status');
        passwordSubmitButton = passwordModalRoot.querySelector('[data-action="submit-password"]');

        const closePasswordModal = () => {
            if (checkingPassword) return;
            passwordModalRoot.classList.remove('is-open');
            returnSyncFocus();
        };

        passwordModalRoot.querySelector('.rp-sync-modal__close').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('[data-action="cancel-password"]').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', closePasswordModal);
        passwordModalRoot.querySelector('form').addEventListener('submit', (event) => {
            event.preventDefault();
            submitSyncPassword().catch(() => { });
        });
    }

    function openPasswordModal(message = '请输入同步密码。') {
        rememberSyncFocus();
        ensurePasswordModal();
        passwordStatus.textContent = message;
        passwordInput.value = '';
        passwordSubmitButton.disabled = false;
        passwordModalRoot.classList.add('is-open');
        setTimeout(() => passwordInput.focus(), 0);
    }

    function openSyncPanel() {
        state.statusText = '请选择上传或下载。';
        state.progress = 0;
        openModal();
    }

    // 确认框用 DB/ui-kit.js 的原生样式弹窗，叠在同步面板上面。
    function openInlineConfirm(options = {}) {
        return window.RPHubUI.confirm({
            title: options.title,
            message: options.message || '继续执行这个操作吗？',
            confirmText: options.confirmText,
            danger: options.variant === 'danger'
        });
    }

    function formatShortSha(value) {
        return typeof value === 'string' && value ? value.slice(0, 18) : '未知';
    }

    function formatCurrentAppVersion(result) {
        const current = result?.current || {};
        if (current.label) return current.label;
        if (current.version) return current.source === 'bundle' ? `内置 ${current.version}` : current.version;
        if (current.tag) return current.tag;
        if (current.source === 'bundle') return '内置版本';
        return formatShortSha(current.sha);
    }

    function setModalTitle() {
        if (!modalTitle) return;
        modalTitle.innerHTML = `
            <span class="rp-sync-modal__title-sub">R2 Sync</span>
            <span class="rp-sync-modal__title-main">云同步</span>
        `;
    }

    function getSelectedAppUpdateTarget() {
        return appUpdateSelectedTarget || '';
    }

    function formatAppUpdateVersionLabel(version, index = 0) {
        if (!version) return '最新版';
        const tag = version.tag || version.sha || '未知版本';
        const title = String(version.name || version.message || '').split('\n')[0].replace(tag, '').trim();
        const date = version.date ? new Date(version.date).toLocaleDateString('zh-CN') : '';
        const parts = [
            index === 0 ? `最新版：${tag}` : tag,
            date,
            title.slice(0, 36)
        ].filter(Boolean);
        return parts.join(' · ');
    }

    // 版本下拉：程序更新和测试版更新共用。默认选中第一项（最新版），选中时回调 onSelect(版本)。
    function renderVersionPicker(button, menu, versions, formatLabel, onSelect) {
        const list = Array.isArray(versions) ? versions : [];
        const choose = (version, index) => {
            button.textContent = version ? formatLabel(version, index) : '最新版';
            onSelect(version || null);
        };
        menu.innerHTML = '';
        choose(list[0], 0);
        list.forEach((version, index) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'rp-sync-version-option';
            item.textContent = formatLabel(version, index);
            item.addEventListener('click', () => {
                choose(version, index);
                menu.classList.remove('is-open');
            });
            menu.appendChild(item);
        });
    }

    function renderAppUpdateVersions(versions) {
        if (!appUpdateVersionButton || !appUpdateVersionMenu) return;
        renderVersionPicker(appUpdateVersionButton, appUpdateVersionMenu, versions, formatAppUpdateVersionLabel, (version) => {
            appUpdateSelectedTarget = version?.tag || version?.sha || '';
        });
    }

    async function checkAppUpdate() {
        if (state.syncing) return;

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);

        try {
            updateProgress(15, '正在检查更新…');
            const result = await postSync({ action: 'app-update-check' });
            renderAppUpdateVersions(result?.versions);
            const current = formatCurrentAppVersion(result);
            const latest = result?.latest?.tag || formatShortSha(result?.latest?.sha);
            const previous = result?.previous?.tag || result?.previous?.sha ? `，可回退到 ${result?.previous?.tag || formatShortSha(result.previous.sha)}` : '';
            if (result?.updateAvailable) {
                updateProgress(100, `发现新版本 ${latest}，当前版本 ${current}${previous}。`);
            } else {
                updateProgress(100, `已是最新版本：${current}${previous}。`);
            }
        } catch (error) {
            updateProgress(100, error.message || '检查更新失败，请稍后重试。');
        } finally {
            state.syncing = false;
            setActionButtonsDisabled(false);
            updateButtonState();
        }
    }

    async function applyAppUpdate() {
        if (state.syncing) return;

        const target = getSelectedAppUpdateTarget();
        const targetText = target || '最新版';
        const confirmed = await openInlineConfirm({
            title: '更新程序',
            message: `程序将更新到 ${targetText}，云同步数据不受影响。`,
            confirmText: '更新'
        });
        if (!confirmed) return;

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);

        try {
            await flushAppState();
            startEstimatedProgress({
                from: 10,
                to: 88,
                durationMs: 165_000,
                text: '正在下载更新'
            });
            let result = await postSync({ action: 'app-update-apply', target }, { timeoutMs: 180_000, retryCount: 1 });
            // 站点每个请求只处理一部分文件（Cloudflare 每个请求的子请求有限），没处理完就带着进度接着请求。
            while (result?.done === false) {
                startEstimatedProgress({ to: 88, durationMs: 165_000, text: `正在下载更新 ${result.staged}/${result.total}` });
                result = await postSync({ action: 'app-update-apply', target, slot: result.slot, offset: result.staged }, { timeoutMs: 180_000, retryCount: 1 });
            }
            stopEstimatedProgress();
            const latest = result?.latest?.tag || formatShortSha(result?.latest?.sha);
            if (result?.alreadyUpToDate) {
                updateProgress(100, `已是最新版本：${latest}。`);
                setActionButtonsDisabled(false);
                return;
            }
            updateProgress(100, `更新完成：${latest}，页面即将刷新…`);
            setTimeout(() => {
                location.reload();
            }, 900);
        } catch (error) {
            stopEstimatedProgress();
            updateProgress(100, error.message || '更新失败，请稍后重试。');
            setActionButtonsDisabled(false);
        } finally {
            stopEstimatedProgress();
            state.syncing = false;
            updateButtonState();
        }
    }

    async function rollbackAppUpdate() {
        if (state.syncing) return;

        const confirmed = await openInlineConfirm({
            title: '回退上一版',
            message: '程序将回退到上一版，云同步数据不受影响。',
            confirmText: '回退',
            variant: 'danger'
        });
        if (!confirmed) return;

        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);

        try {
            await flushAppState();
            updateProgress(20, '正在回退…');
            const result = await postSync({ action: 'app-update-rollback' }, {
                timeoutMs: 120_000,
                retryCount: 1
            });
            updateProgress(100, `已回退到 ${result?.rolledBackTo?.tag || formatShortSha(result?.rolledBackTo?.sha)}，页面即将刷新…`);
            setTimeout(() => {
                location.reload();
            }, 900);
        } catch (error) {
            updateProgress(100, error.message || '回退失败，请稍后重试。');
            setActionButtonsDisabled(false);
        } finally {
            state.syncing = false;
            updateButtonState();
        }
    }

    async function submitSyncPassword() {
        if (checkingPassword) return;

        const password = passwordInput.value;
        if (!password) {
            passwordStatus.textContent = '请输入同步密码。';
            passwordInput.focus();
            return;
        }

        checkingPassword = true;
        passwordSubmitButton.disabled = true;
        passwordStatus.textContent = '正在验证密码…';

        try {
            const auth = await getAuthStatus(password);
            if (auth.authRequired && !auth.authenticated) {
                clearStoredSyncPassword();
                passwordStatus.textContent = '密码错误，请重新输入。';
                passwordInput.select();
                return;
            }

            if (auth.authRequired) {
                saveStoredSyncPassword(password);
            } else {
                clearStoredSyncPassword();
            }
            passwordModalRoot.classList.remove('is-open');
            openSyncPanel();
        } catch (error) {
            passwordStatus.textContent = error.message || '密码验证失败，请稍后重试。';
        } finally {
            checkingPassword = false;
            passwordSubmitButton.disabled = false;
        }
    }

    async function handleSyncButtonClick() {
        if (state.syncing) return openModal(); // 正在同步（比如后台上传）：打开面板看进度
        if (checkingPassword) return;

        syncEntry?.update({ busy: true });
        try {
            const auth = await getAuthStatus();
            if (!auth.authRequired || auth.authenticated) {
                openSyncPanel();
                return;
            }

            clearStoredSyncPassword();
            openPasswordModal('请输入同步密码后继续。');
        } catch (error) {
            if (error.status === 401) {
                clearStoredSyncPassword();
                openPasswordModal('请输入同步密码后继续。');
                return;
            }

            window.RPHubUI.toast(error.message || '连接失败，请稍后重试。', { kind: 'error' });
        } finally {
            updateButtonState();
        }
    }

    function ensureModal() {
        if (modalRoot) return;

        modalRoot = document.createElement('div');
        modalRoot.className = 'rp-sync-modal';
        modalRoot.innerHTML = `
            <div class="rp-sync-modal__backdrop"></div>
            <div class="rp-sync-modal__panel compact-modal-panel">
                <div class="rp-sync-modal__header editor-modal-header">
                    <h3 class="rp-sync-modal__title">
                        <span class="rp-sync-modal__title-sub">R2 Sync</span>
                        <span class="rp-sync-modal__title-main">云同步</span>
                    </h3>
                    <button type="button" class="rp-sync-modal__close modal-close-button" aria-label="关闭"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg></button>
                </div>
                <div class="rp-sync-main-actions">
                    <button type="button" class="rp-sync-action-button" data-action="pull">下载</button>
                    <button type="button" class="rp-sync-action-button is-primary" data-action="push">快速上传</button>
                    <button type="button" class="rp-sync-action-button" data-action="push-full">完整上传</button>
                </div>
                <p class="rp-sync-modal__status">请选择上传或下载。</p>
                <div class="rp-sync-progress">
                    <div class="rp-sync-progress__bar"></div>
                </div>
                <div class="rp-sync-progress__value">0%</div>
                <details class="rp-sync-update-details">
                    <summary>程序更新</summary>
                    <div class="rp-sync-update-body">
                        <p class="rp-sync-choice__desc">只显示 RP-Hub 官方正式版。</p>
                        <div class="rp-sync-version-fields">
                            <label>
                                <span>目标版本</span>
                                <div class="rp-sync-version-picker">
                                    <button type="button" class="rp-sync-version-button" data-action="app-update-version-button">最新版</button>
                                    <div class="rp-sync-version-menu" data-action="app-update-version-menu"></div>
                                </div>
                            </label>
                        </div>
                        <div class="rp-sync-inline-actions">
                            <button type="button" class="rp-sync-modal__button modal-secondary-button" data-action="app-update-check">检查更新</button>
                            <button type="button" class="rp-sync-modal__button modal-primary-button" data-action="app-update-apply">立即更新</button>
                            <button type="button" class="rp-sync-modal__button modal-secondary-button" data-action="app-update-rollback">回退上一版</button>
                        </div>
                    </div>
                </details>
                <details class="rp-sync-update-details">
                    <summary>测试版更新</summary>
                    <div class="rp-sync-update-body">
                        <p class="rp-sync-choice__desc" data-role="self-update-info">从分发站获取测试版，设置 CF_API_TOKEN 后可直接更新。</p>
                        <div class="rp-sync-version-fields">
                            <label>
                                <span>目标版本</span>
                                <div class="rp-sync-version-picker">
                                    <button type="button" class="rp-sync-version-button" data-action="self-update-version-button">最新版</button>
                                    <div class="rp-sync-version-menu" data-action="self-update-version-menu"></div>
                                </div>
                            </label>
                        </div>
                        <div class="rp-sync-inline-actions">
                            <button type="button" class="rp-sync-modal__button modal-secondary-button" data-action="self-update-check">检查更新</button>
                            <button type="button" class="rp-sync-modal__button modal-primary-button" data-action="self-update-apply">立即更新</button>
                            <button type="button" class="rp-sync-modal__button modal-secondary-button" data-action="self-update-rollback">回退上一版</button>
                        </div>
                    </div>
                </details>
            </div>
        `;

        document.body.appendChild(modalRoot);
        modalTitle = modalRoot.querySelector('.rp-sync-modal__title');
        modalStatus = modalRoot.querySelector('.rp-sync-modal__status');
        modalProgressBar = modalRoot.querySelector('.rp-sync-progress__bar');
        modalProgressValue = modalRoot.querySelector('.rp-sync-progress__value');
        pullButton = modalRoot.querySelector('[data-action="pull"]');
        pushButton = modalRoot.querySelector('[data-action="push"]');
        pushFullButton = modalRoot.querySelector('[data-action="push-full"]');
        appUpdateCheckButton = modalRoot.querySelector('[data-action="app-update-check"]');
        appUpdateApplyButton = modalRoot.querySelector('[data-action="app-update-apply"]');
        appUpdateRollbackButton = modalRoot.querySelector('[data-action="app-update-rollback"]');
        selfUpdateCheckButton = modalRoot.querySelector('[data-action="self-update-check"]');
        selfUpdateApplyButton = modalRoot.querySelector('[data-action="self-update-apply"]');
        selfUpdateRollbackButton = modalRoot.querySelector('[data-action="self-update-rollback"]');
        selfUpdateInfo = modalRoot.querySelector('[data-role="self-update-info"]');
        selfUpdateVersionButton = modalRoot.querySelector('[data-action="self-update-version-button"]');
        selfUpdateVersionMenu = modalRoot.querySelector('[data-action="self-update-version-menu"]');
        appUpdateVersionButton = modalRoot.querySelector('[data-action="app-update-version-button"]');
        appUpdateVersionMenu = modalRoot.querySelector('[data-action="app-update-version-menu"]');
        closeButton = modalRoot.querySelector('.rp-sync-modal__close');

        modalRoot.querySelector('.rp-sync-modal__backdrop').addEventListener('click', () => closeModal());
        pullButton.addEventListener('click', () => pullFromServer().catch(() => { }));
        pushButton.addEventListener('click', () => pushToServer('fast').catch(() => { }));
        pushFullButton.addEventListener('click', () => pushToServer('full').catch(() => { }));
        appUpdateCheckButton.addEventListener('click', () => checkAppUpdate().catch(() => { }));
        appUpdateApplyButton.addEventListener('click', () => applyAppUpdate().catch(() => { }));
        appUpdateRollbackButton.addEventListener('click', () => rollbackAppUpdate().catch(() => { }));
        selfUpdateCheckButton.addEventListener('click', () => checkSelfUpdate().catch(() => { }));
        selfUpdateApplyButton.addEventListener('click', () => applySelfUpdate().catch(() => { }));
        selfUpdateRollbackButton.addEventListener('click', () => rollbackSelfUpdate().catch(() => { }));
        for (const [button, menu] of [[appUpdateVersionButton, appUpdateVersionMenu], [selfUpdateVersionButton, selfUpdateVersionMenu]]) {
            button.addEventListener('click', () => {
                if (!state.syncing) menu.classList.toggle('is-open');
            });
        }
        document.addEventListener('click', (event) => {
            if (!modalRoot?.contains(event.target)) return;
            const picker = event.target.closest('.rp-sync-version-picker');
            modalRoot.querySelectorAll('.rp-sync-version-menu.is-open').forEach((menu) => {
                if (menu.parentElement !== picker) menu.classList.remove('is-open');
            });
        });
        if (closeButton) closeButton.addEventListener('click', closeModal);
    }

    function rememberSyncFocus() {
        const active = document.activeElement;
        if (!modalRoot?.contains(active) && !passwordModalRoot?.contains(active)) syncReturnFocus = active;
    }

    // 测试版：外壳从分发端取发布包部署到本站；站点没设置 CF_API_TOKEN 时改为下载部署包。
    async function runSelfUpdateTask(task) {
        if (state.syncing) return;
        state.syncing = true;
        updateButtonState();
        openModal();
        setActionButtonsDisabled(true);
        try {
            await task();
        } catch (error) {
            updateProgress(100, error.message || '操作失败，请稍后重试。');
        } finally {
            state.syncing = false;
            setActionButtonsDisabled(false);
            updateButtonState();
        }
    }

    function reloadAfterDeploy(text) {
        updateProgress(100, `${text}约 30 秒后生效，页面将自动刷新。`);
        setTimeout(() => location.reload(), 40_000);
    }

    function checkSelfUpdate() {
        return runSelfUpdateTask(async () => {
            updateProgress(20, '正在检查更新…');
            selfUpdateStatus = await postSync({ action: 'self-update-status' });
            selfUpdateApplyButton.textContent = selfUpdateStatus.selfDeploy ? '立即更新' : '下载部署包';
            const current = selfUpdateStatus.current;
            const formatLabel = (version, index) => [index === 0 ? `最新版：${version.tag}` : version.tag,
                version.publishedAt ? new Date(version.publishedAt).toLocaleDateString('zh-CN') : '',
                version.tag === current ? '当前' : ''].filter(Boolean).join(' · ');
            renderVersionPicker(selfUpdateVersionButton, selfUpdateVersionMenu, selfUpdateStatus.versions, formatLabel, (version) => {
                selfUpdateSelected = version;
                selfUpdateInfo.textContent = version ? `${version.tag}：${version.notes || '暂无更新说明'}` : '暂无测试版。';
            });
            updateProgress(100, selfUpdateStatus.updateAvailable
                ? `发现新版本 ${selfUpdateStatus.latest}，当前版本 ${selfUpdateStatus.current}。`
                : `已是最新版本：${selfUpdateStatus.current}。`);
        });
    }

    async function applySelfUpdate() {
        if (!selfUpdateStatus) await checkSelfUpdate();
        const target = selfUpdateSelected;
        if (!target) return;
        if (!selfUpdateStatus.selfDeploy) {
            if (target.zipUrl) window.open(target.zipUrl, '_blank', 'noopener');
            updateProgress(100, `未设置 CF_API_TOKEN，请下载部署包并上传到 Cloudflare Pages：${target.zipUrl || '暂无下载地址'}`);
            return;
        }
        const confirmed = await openInlineConfirm({
            title: '更新测试版',
            message: `将更新到测试版 ${target.tag}，云同步数据不受影响。`,
            confirmText: '更新'
        });
        if (!confirmed) return;
        await runSelfUpdateTask(async () => {
            await flushAppState();
            updateProgress(30, `正在更新到 ${target.tag}…`);
            const result = await postSync({ action: 'self-update-apply', target: target.tag }, { timeoutMs: 180_000, retryCount: 0 });
            reloadAfterDeploy(`测试版 ${result.version} 正在部署，`);
        });
    }

    async function rollbackSelfUpdate() {
        const confirmed = await openInlineConfirm({
            title: '回退上一版',
            message: '将回退到上一次部署的版本，云同步数据不受影响。',
            confirmText: '回退',
            variant: 'danger'
        });
        if (!confirmed) return;
        await runSelfUpdateTask(async () => {
            updateProgress(30, '正在回退…');
            await postSync({ action: 'self-update-rollback' }, { timeoutMs: 120_000, retryCount: 0 });
            reloadAfterDeploy('正在回退，');
        });
    }

    // 换成魔改版的第一步：本站把云端数据转成它的格式。程序由魔改版自己的部署页「更新」这个站点来换，测试版不替别人部署代码。
    async function convertToFork() {
        const confirmed = await openInlineConfirm({
            title: '迁移到魔改版',
            message: '云端数据将转换为魔改版（cy-2-u/rp）格式，测试版数据另存一份；插件、API 预设等魔改版不同步的数据不会转换，仍保留在各设备上。',
            confirmText: '转换'
        });
        if (!confirmed) return;
        await runSelfUpdateTask(async () => {
            await exportForkSnapshot();
            updateProgress(100, '转换完成。请用魔改版的一键部署页更新本站，完成后在每台设备的魔改版里点击「从云端恢复」。');
        });
    }

    // 这个按钮很少用，怕误触，不放同步面板，放在 RPH 设置页最底下「空间管理」里。
    function ensureForkExportEntry() {
        const headings = [...document.querySelectorAll('h4.settings-subheading')];
        if (!headings.length || document.querySelector('[data-action="fork-export"]')) return;
        // 2.0.3 及更早放进上游的「空间管理」；2.0.4 起上游删了这一段，就在设置页最底下自己补一段。
        let section = headings.find((node) => node.textContent.trim() === '空间管理')?.closest('.pt-6');
        const row = document.createElement('div');
        row.className = `flex items-center justify-between gap-3 text-xs text-gray-500${section ? ' mt-6' : ''}`;
        row.innerHTML = '<span>迁移到魔改版（cy-2-u/rp）</span><button type="button" class="settings-action flex-shrink-0 whitespace-nowrap" data-action="fork-export">转换数据</button>';
        row.lastChild.addEventListener('click', () => convertToFork().catch(() => { }));
        if (!section) {
            const last = headings[headings.length - 1].closest('.pt-6');
            if (!last?.parentElement) return;
            section = document.createElement('div');
            section.className = 'pt-6 border-t border-gray-100 mt-6';
            last.parentElement.appendChild(section);
        }
        section.appendChild(row);
    }

    // 上游 2.0.4 起的「备份与转移」是传到原作者服务器的云端备份。只留「下载备份」，给从官方 RP-Hub 搬过来的人用；
    // 「上传备份」会把这个站的数据送到原作者那里，藏掉。
    function ensureCloudBackupEntry() {
        const heading = [...document.querySelectorAll('h4.settings-subheading')].find((node) => node.textContent.trim() === '备份与转移');
        const grid = heading?.parentElement.querySelector('.grid');
        if (!grid || grid.dataset.rphCloudRestore) return;
        grid.dataset.rphCloudRestore = '1';
        grid.classList.replace('grid-cols-2', 'grid-cols-1');
        for (const button of grid.children) if (button.textContent.includes('上传备份')) button.hidden = true;
        grid.insertAdjacentHTML('afterend', '<p class="mt-3 text-xs text-gray-500">从官方 RP-Hub 迁移：在官方设置页点击「上传备份」获取密钥，再在这里点击「下载备份」输入，角色卡和聊天记录会合并到本机。</p>');
    }

    function decorateSettingsView() {
        ensureForkExportEntry();
        ensureCloudBackupEntry();
    }

    // 只在设置页打开时观察页面变化，离开就停，不影响聊天时的性能。
    function watchSettingsView() {
        let observer = null;
        const start = setInterval(() => {
            const proxy = getVueProxy();
            if (!proxy || !globalThis.Vue?.watch) return;
            clearInterval(start);
            globalThis.Vue.watch(() => proxy.currentView, (view) => {
                observer?.disconnect();
                observer = null;
                if (view !== 'settings') return;
                decorateSettingsView();
                observer = new MutationObserver(decorateSettingsView);
                observer.observe(document.getElementById('app'), { childList: true, subtree: true });
            }, { immediate: true });
        }, 1000);
    }

    function returnSyncFocus() {
        if (syncReturnFocus?.isConnected && syncReturnFocus.getClientRects().length) syncReturnFocus.focus();
        syncReturnFocus = null;
    }

    function openModal() {
        rememberSyncFocus();
        ensureModal();
        hideFloat();
        modalRoot.classList.add('is-open');
        setModalTitle();
        updateProgress(state.progress, state.statusText || '请选择上传或下载。');
        setActionButtonsDisabled(state.syncing);
        if (!modalRoot.contains(document.activeElement)) closeButton?.focus();
    }

    // 后台上传时也能关，关了进度显示在悬浮条上
    function closeModal() {
        if ((state.syncing && !state.background) || !modalRoot) return;
        modalRoot.classList.remove('is-open');
        returnSyncFocus();
        if (state.background) showFloat({ text: `上传中… ${Math.round(state.progress)}%`, progress: state.progress });
    }

