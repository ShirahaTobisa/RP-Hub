    function headers() {
        let password = '';
        try { password = localStorage.getItem(PASSWORD_KEY) || ''; } catch (_) { /* storage blocked */ }
        return { 'x-rp-sync-password': password, 'content-type': 'application/json' };
    }

    async function api(path, init = {}) {
        const response = await fetch(path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
        return body;
    }

    const imageModule = () => globalThis.RPHubImageModule;

    function appProxy() {
        const app = document.getElementById('app')?.__vue_app__;
        return app?._instance?.proxy || app?._container?._vnode?.component?.proxy || null;
    }

    function findGrid() {
        const heading = [...document.querySelectorAll('h4.settings-subheading')].find((node) => node.textContent.trim() === '生图设置');
        return heading?.closest('.pt-6')?.querySelector('.grid') || null;
    }

    function element(tag, className = '', text = '') {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function cell(label, control, wide = false) {
        const wrap = element('div', wide ? 'min-w-0 md:col-span-2' : 'min-w-0');
        wrap.setAttribute(FIELD_ATTR, '');
        wrap.append(element('label', 'settings-label', label), control);
        return wrap;
    }

    // 下拉框用 RPH 自己的 custom-select 组件，展开的列表、动画和黑夜模式都和原生下拉框一致。
    // 值仍放在隐藏的 <select> 里，其余代码照旧读写 .value；代码改了选项或值之后调用 sync() 刷新显示。
    // 页面没有这个组件（旧版 RPH）时直接显示 <select>。放进格子里的是 control。
    // 离开设置页时要收拾的东西（这些下拉组件、对 RPH 设置的监听）。
    const cleanups = [];

    function select(options) {
        const node = element('select', 'settings-control');
        for (const [value, label] of options) node.appendChild(Object.assign(document.createElement('option'), { value, textContent: label }));
        node.control = node;
        node.sync = () => {};
        const Component = window.RPHubCustomSelect;
        const Vue = globalThis.Vue;
        if (!Component || !Vue?.createApp) return node;
        const view = Vue.reactive({ value: '', options: [] });
        node.sync = () => Object.assign(view, { value: node.value, options: [...node.options].map((option) => ({ value: option.value, label: option.textContent })) });
        node.control = element('div');
        const app = Vue.createApp({
            render: () => Vue.h(Component, {
                modelValue: view.value, options: view.options, buttonClass: 'settings-control', menuClass: 'text-sm',
                'onUpdate:modelValue': (value) => { node.value = value; node.sync(); node.dispatchEvent(new Event('change')); }
            })
        });
        app.mount(node.control);
        cleanups.push(() => app.unmount());
        node.hidden = true;
        node.control.appendChild(node);
        return node;
    }

    // 和记忆系统「补录并发数」一样的滑条：标题 + 右侧数值 + 滑轨。
    function slider(label, { min, max, step, unit = '' }) {
        const wrap = element('div', 'min-w-0 md:col-span-2');
        wrap.setAttribute(FIELD_ATTR, '');
        const head = element('div', 'flex justify-between items-center mb-2');
        const value = element('span', BADGE_CLASS);
        head.append(element('label', 'text-sm font-semibold text-gray-700', label), value);
        const input = element('input', RANGE_CLASS);
        Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step) });
        const hint = element('p', 'text-xs text-gray-500 mt-2');
        const show = () => { value.textContent = `${input.value}${unit}`; };
        input.addEventListener('input', show);
        wrap.append(head, input, hint);
        return { wrap, input, hint, show };
    }

    function buildFields(grid) {
        const settings = imageModule()?.getGenerationSettings?.() || { generator: 'direct', params: {} };
        const params = settings.params || {};
        const generator = select([['direct', '直链（最高 28 步）']]);
        const sampler = select(SAMPLERS.map((value) => [value, value]));
        const noise = select(NOISE_SCHEDULES.map((value) => [value, value]));
        const resolution = select([['', '标准'], ['2K', '2K'], ['4K', '4K']]);
        const steps = slider('生成步数', { min: 1, max: 28, step: 1, unit: ' 步' });
        const scale = slider('提示词引导值', { min: 0, max: 10, step: 0.1 });
        const cfg = slider('缩放引导值', { min: 0, max: 1, step: 0.02 });
        const negative = element('textarea', 'settings-control');
        negative.rows = 4;
        negative.style.resize = 'vertical';
        const negativeCell = cell('负面提示词', negative, true);
        const resetNegative = element('button', 'text-xs text-primary-600 mt-1', '恢复默认负面提示词');
        resetNegative.type = 'button';
        const status = element('p', 'text-xs text-gray-500 md:col-span-2');
        status.setAttribute(FIELD_ATTR, '');
        negativeCell.appendChild(resetNegative);

        // 站点存的步数。滑条只显示当前接口会用的步数（上限由接口决定，直链 28），不会因为显示而改掉存的值。
        let storedSteps = Number(params.steps ?? 28);
        const providers = () => imageModule()?.listImageProviders?.() || [];
        const current = () => providers().find((item) => item.id === generator.value) || null;
        const fillProviders = () => {
            const selected = generator.value || settings.generator;
            generator.replaceChildren(Object.assign(document.createElement('option'), { value: 'direct', textContent: '直链（最高 28 步）' }));
            for (const item of providers()) generator.appendChild(Object.assign(document.createElement('option'), { value: item.id, textContent: `${item.label}（插件，最高 ${item.maxSteps} 步）` }));
            if (selected !== 'direct' && !providers().some((item) => item.id === selected)) {
                generator.appendChild(Object.assign(document.createElement('option'), { value: selected, textContent: `${selected}（插件未加载）` }));
            }
            generator.value = selected;
            generator.sync();
        };
        const refresh = () => {
            const provider = current();
            steps.input.max = String(provider?.maxSteps || 28);
            steps.input.value = String(Math.min(storedSteps, Number(steps.input.max)));
            [steps, scale, cfg].forEach((item) => item.show());
            const app = appProxy()?.settings || {};
            const query = { steps: Number(steps.input.value), sampler: sampler.value, model: app.imageModel, size: `${resolution.value}${app.imageSize || '竖图'}` };
            let cost = '';
            try { cost = provider?.costHint?.(query) || ''; } catch (_) { cost = ''; }
            if (!provider && generator.value !== 'direct') {
                cost = `「${generator.value}」插件没有加载，这个页面现在生不了图；请在模块管理里启用它，或改回直链。`;
            } else if (!cost && !provider) {
                const points = imageModule()?.estimateImagePoints?.(query.model, query.size, Math.min(28, query.steps));
                cost = `直链最高按 28 步生成${points ? `，当前设置每张图约 ${points} 点` : ''}。`;
            }
            steps.hint.textContent = cost;
        };

        generator.value = settings.generator || 'direct';
        sampler.value = params.sampler || 'k_dpmpp_2m_sde';
        noise.value = params.noise_schedule || 'karras';
        resolution.value = params.resolution || '';
        scale.input.value = String(params.scale ?? 6);
        cfg.input.value = String(params.cfg ?? 0);
        negative.value = params.negative || imageModule()?.defaultNegativePrompt || '';
        fillProviders();
        [sampler, noise, resolution].forEach((item) => item.sync());
        refresh();

        // 只保存改动的那几项：别的设备改过的设置，不会被这个页面上没动过的旧值盖掉。
        let timer = null;
        const changed = new Set();
        const valueOf = {
            steps: () => storedSteps,
            scale: () => Number(scale.input.value),
            cfg: () => Number(cfg.input.value),
            sampler: () => sampler.value,
            noise_schedule: () => noise.value,
            resolution: () => resolution.value,
            negative: () => {
                const defaultNegative = imageModule()?.defaultNegativePrompt || '';
                return negative.value.trim() === defaultNegative.trim() ? '' : negative.value;
            }
        };
        const readChanges = () => {
            const body = { params: {} };
            for (const key of changed) {
                if (key === 'generator') body.generator = generator.value;
                else body.params[key] = valueOf[key]();
            }
            return body;
        };
        const send = () => {
            clearTimeout(timer);
            if (!changed.size) return saveInFlight;
            const body = readChanges();
            changed.clear();
            saveInFlight = (async () => {
                try {
                    const result = await api('/image/api/settings', { method: 'PUT', body: JSON.stringify(body) });
                    imageModule()?.applyGenerationSettings?.(result.settings);
                    status.textContent = '生图参数已保存，所有设备共用；只影响之后的新图，已生成的图不会重新生成。';
                } catch (error) {
                    // 没存上：提示出来，并把设置页恢复成站点上的真实值，免得以为已经改好了。
                    window.RPHubUI?.toast(`生图设置没有保存成功：${error.message}。已恢复为站点上的设置，请检查同步密码后重试。`, { kind: 'error', duration: 8000 });
                    await imageModule()?.reloadGenerationSettings?.();
                    rebuildFields();
                }
            })();
            return saveInFlight;
        };
        flushPendingSave = send;
        const save = (key) => {
            changed.add(key);
            refresh();
            // 换到上限更低的接口（比如直链）时，存的步数跟着降到它实际会用的步数。
            if (key === 'generator' && storedSteps > Number(steps.input.max)) {
                storedSteps = Number(steps.input.max);
                changed.add('steps');
            }
            // 改动马上在本页生效：保存还没发出就离开设置页再回来，也显示刚改的值。
            const local = imageModule()?.getGenerationSettings?.();
            const pending = readChanges();
            if (local) imageModule().applyGenerationSettings({ ...local, ...(pending.generator ? { generator: pending.generator } : {}), params: { ...local.params, ...pending.params } });
            clearTimeout(timer);
            timer = setTimeout(send, 400);
        };
        const controls = [[generator, 'generator'], [resolution, 'resolution'], [sampler, 'sampler'], [noise, 'noise_schedule'],
            [negative, 'negative'], [steps.input, 'steps'], [scale.input, 'scale'], [cfg.input, 'cfg']];
        for (const [control, key] of controls) control.addEventListener('change', () => save(key));
        // 点数跟着变：拖动步数时、插件恢复步数时、改 RPH 原生的「生图比例」「生图模型」时都重新算。
        steps.input.addEventListener('input', () => { storedSteps = Number(steps.input.value); refresh(); });
        const appSettings = appProxy()?.settings;
        if (appSettings && globalThis.Vue?.watch) cleanups.push(globalThis.Vue.watch(() => [appSettings.imageSize, appSettings.imageModel], refresh));
        resetNegative.addEventListener('click', () => { negative.value = imageModule()?.defaultNegativePrompt || ''; save('negative'); });
        // 插件比设置页晚加载时：接口和它声明的步数上限到了以后，按存的值重新显示。
        const onProviders = () => { fillProviders(); refresh(); };
        window.addEventListener('rph-image-providers-change', onProviders);
        cleanups.push(() => window.removeEventListener('rph-image-providers-change', onProviders));
        grid.append(cell('生图接口', generator.control), cell('分辨率', resolution.control), cell('采样器', sampler.control), cell('噪声调度', noise.control), steps.wrap, scale.wrap, cfg.wrap, negativeCell, status);
    }

    function ensureFields() {
        const grid = findGrid();
        if (grid && !grid.querySelector(`[${FIELD_ATTR}]`)) buildFields(grid);
    }

    function rebuildFields() {
        cleanups.splice(0).forEach((cleanup) => cleanup());
        findGrid()?.querySelectorAll(`[${FIELD_ATTR}]`).forEach((node) => node.remove());
        ensureFields();
    }

    // 只在设置页打开时观察页面变化，离开就停，不影响聊天时的性能。
    let observer = null;
    let viewVersion = 0;
    // 设置页里还没发出的改动：离开设置页时立即发出；再进设置页时先等它存完，再从站点读最新值。
    let saveInFlight = Promise.resolve();
    let flushPendingSave = () => saveInFlight;
    function onView(view) {
        const saved = flushPendingSave();
        observer?.disconnect();
        observer = null;
        cleanups.splice(0).forEach((cleanup) => cleanup());
        const version = ++viewVersion;
        if (view !== 'settings') return;
        // 先从站点读最新设置再画：页面记着的可能是别的设备改之前的旧值。
        saved.then(() => imageModule()?.reloadGenerationSettings?.()).then(() => {
            if (version !== viewVersion) return;
            ensureFields();
            observer = new MutationObserver(ensureFields);
            observer.observe(document.getElementById('app'), { childList: true, subtree: true });
        });
    }

    async function checkStorage() {
        let last = 0;
        try { last = Number(localStorage.getItem(CHECK_KEY)) || 0; } catch (_) { /* storage blocked */ }
        if (Date.now() - last < DAY_MS || !window.RPHubUI) return;
        let report;
        try { report = await api('/image/api/storage'); } catch (_) { return; }
        try { localStorage.setItem(CHECK_KEY, String(Date.now())); } catch (_) { /* storage blocked */ }
        if (!report.over || !report.cleanup.count) return;
        const ok = await window.RPHubUI.confirm({
            title: 'R2 存储超出清理上限',
            message: `已用 ${report.totalHuman}，清理上限 ${report.limitHuman}（免费额度 10 GB，超出会收费）。\n\n要从最早的图开始删除 ${report.cleanup.count} 张，腾出 ${report.cleanup.human} 吗？删除的图在聊天里显示为「已删除」，不会重新生成。`,
            confirmText: '清理',
            cancelText: '今天不再提醒',
            danger: true
        });
        if (!ok) return;
        let deleted = 0;
        try {
            for (let round = 0; round < 50; round += 1) {
                const result = await api('/image/api/storage/cleanup', { method: 'POST', body: '{}' });
                deleted += result.deletedCount;
                if (!result.remaining || !result.deletedCount) break;
            }
            window.RPHubUI.toast(`已清理 ${deleted} 张旧图。`, { kind: 'success' });
        } catch (error) {
            window.RPHubUI.toast(`清理失败：${error.message}`, { kind: 'error' });
        }
    }

    const start = setInterval(() => {
        const proxy = appProxy();
        if (!proxy || !globalThis.Vue?.watch) return;
        clearInterval(start);
        globalThis.Vue.watch(() => proxy.currentView, onView, { immediate: true });
        setTimeout(checkStorage, 15_000);
    }, 1000);
})();
