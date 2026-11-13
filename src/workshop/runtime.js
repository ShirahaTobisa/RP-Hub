    function setRuntimeStatus(runtime, status) {
        runtime.entry.lastStatus = status;
        if (status.endsWith('error') || status === 'api-mismatch') window.RPHubDiagnostics?.record('plugin-error', { plugin: runtime.entry.id });
        writeInstallations();
        refreshManagementPanel();
    }

    async function initializeRuntime(runtime) {
        try {
            await runtime.manifest.init(buildContext(runtime.manifest.id));
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
            beforeMount: typeof manifest.beforeMount === 'function' ? manifest.beforeMount : null
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
            showToast(`模块 ${checked.name} 需要 API ${checked.requiresApi}，当前为 ${API_VERSION}`);
            return false;
        }
        state.registeredIds.set(checked.id, runtime);
        runtime.entry.id = checked.id;
        runtime.entry.name = checked.name;
        runtime.entry.version = checked.version;
        runtime.entry.lastStatus = '';
        if (checked.beforeMount && !runtime.entry.beforeMount) showToast(`${checked.name} 要再刷新一次才能完整生效`, { kind: 'info' });
        runtime.entry.beforeMount = !!checked.beforeMount;
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
            showToast(`安全模式:已跳过 ${enabledCount} 个模块`, { kind: 'info' });
        }
        if (state.runtimeActive) installRuntimeHooks();
        Promise.resolve(state.mounted).finally(() => setTimeout(settleApp, APP_STARTUP_SETTLE_MS));
    }

    // API 6：上次运行时登记过 beforeMount 的插件先于页面加载，官方 app.mount('#app') 等它们加载完
    // （最多 REGISTER_TIMEOUT_MS）再挂载，插件借此改官方根组件和页面模板。新装或更新的插件刷新一次后生效。
    function holdMount(runtimes) {
        const createApp = window.Vue?.createApp;
        if (!runtimes.length || typeof createApp !== 'function') return;
        window.Vue.createApp = function (...args) {
            const app = createApp.apply(this, args);
            const mount = app.mount;
            app.mount = function (target, ...rest) {
                if (target !== '#app') return mount.call(this, target, ...rest);
                window.Vue.createApp = createApp;
                const timeout = new Promise((resolve) => setTimeout(resolve, REGISTER_TIMEOUT_MS));
                state.mounted = Promise.race([Promise.allSettled(runtimes.map((runtime) => runtime.loading)), timeout]).then(() => {
                    for (const runtime of runtimes) {
                        if (state.registeredIds.get(runtime.manifest?.id) !== runtime) continue;
                        try { runtime.manifest.beforeMount?.({ options: app._component, root: document.querySelector(target) }); }
                        catch (error) { log(`module ${runtime.manifest.id} beforeMount failed`, error); }
                    }
                    mount.call(app, target, ...rest);
                });
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
        for (const entry of enabled) createRuntime(entry);
        holdMount(enabled.filter((entry) => entry.beforeMount).map((entry) => state.runtimesByUrl.get(entry.url)));
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startDomRuntime, { once: true });
    } else startDomRuntime();
})();
