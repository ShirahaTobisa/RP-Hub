// 随 ui-kit 提前加载；只记录固定字段，不复制控制台参数、消息正文或请求内容。
(() => {
    const LOG_KEY = 'rphub_diagnostics_log_v1';
    const SETTINGS_KEY = 'rphub_diagnostics_settings_v1';
    const session = crypto.randomUUID().slice(0, 8);
    const cards = new Map();
    const encoder = new TextEncoder();
    const bytes = value => encoder.encode(JSON.stringify(value)).byteLength;
    let events = [], settings = { enabled: true }, timer;
    try {
        events = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
        settings = { ...settings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch { settings.enabled = false; }
    if (!Array.isArray(events)) events = [];
    events = events.slice(-300);
    let eventBytes = events.reduce((size, event) => size + bytes(event), 0);
    const trim = () => {
        while (events.length > 300 || eventBytes > 64 * 1024) eventBytes -= bytes(events.shift());
    };
    trim();

    function save() {
        clearTimeout(timer);
        timer = 0;
        try { localStorage.setItem(LOG_KEY, JSON.stringify(events)); } catch { /* 存满时保留内存记录 */ }
    }

    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 不影响页面功能 */ }
    }

    function card(id) {
        if (!id) return '';
        if (!cards.has(id)) cards.set(id, 'C' + (cards.size + 1));
        return cards.get(id);
    }

    function record(kind, detail = {}) {
        const event = { at: Date.now(), session, kind };
        for (const key of ['owner', 'current']) if (detail[key]) event[key] = card(detail[key]);
        for (const key of ['count', 'status']) if (Number.isFinite(detail[key])) event[key] = detail[key];
        if (/^[a-z0-9-]{3,32}$/.test(detail.plugin || '')) event.plugin = detail.plugin;
        if (detail.errorName) event.errorName = /^[\w.]{1,60}$/.test(detail.errorName) ? detail.errorName : 'Error';
        if (detail.frames) event.frames = detail.frames;
        events.push(event);
        eventBytes += bytes(event);
        trim();
        if (!timer) timer = setTimeout(save, 1000);
    }

    function failure(kind, error) {
        // 错误消息本身也可能带正文或令牌，只取类型和本地脚本位置。
        const frames = String(error?.stack || '').split('\n').slice(1, 9).map(line => {
            const match = line.match(/(?:https?:\/\/[^\s/]+)?(\/(?:DB|assets\/js)\/[\w.-]+\.m?js)(?:\?[^\s):]*)?:(\d+):(\d+)/);
            return match ? `${match[1]}:${match[2]}:${match[3]}`.slice(0, 150) : '[外部或内联脚本]';
        });
        record(kind, { errorName: error?.name || 'Error', status: error?.status, frames });
    }

    for (const level of ['warn', 'error']) {
        const original = console[level];
        console[level] = function (...args) {
            failure('console-' + level, args.find(value => value instanceof Error) || new Error());
            return original.apply(this, args);
        };
    }
    addEventListener('error', event => failure('page-error', event.error));
    addEventListener('unhandledrejection', event => failure('unhandled-rejection', event.reason));
    addEventListener('pagehide', save);

    async function send(action, report) {
        const password = localStorage.getItem('rp_hub_sync_password_v1') || '';
        const response = await fetch('/api/rp-feedback', {
            method: 'POST', headers: { 'content-type': 'application/json', ...(password ? { 'x-rp-sync-password': password } : {}) },
            body: JSON.stringify({ action, ...(report ? { report } : {}) }), signal: AbortSignal.timeout(10000)
        });
        if (response.status === 401) throw new Error('请先在云同步中填写同步密码，或下载报告文件。');
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '发送失败，请稍后重试或下载报告文件。');
        return result;
    }

    async function usage() {
        if (!settings.enabled || !window.RPH_R2_DIAGNOSTICS?.usage || document.visibilityState === 'hidden') return;
        const day = new Date().toISOString().slice(0, 10);
        if (settings.day === day) return;
        settings.day = day;
        saveSettings();
        try { await send('usage'); } catch { /* 统计失败当天不重试 */ }
    }

    function report() {
        let plugins = [];
        try { plugins = JSON.parse(localStorage.getItem('rp_hub_workshop_modules_v1') || '[]'); } catch { /* 启动故障时列表可能不可读 */ }
        const version = window.RPH_R2_DIAGNOSTICS || {};
        return { schema: 1, release: version.release || 'dev', upstream: version.upstream || '',
            browser: navigator.userAgent.slice(0, 250), issue: 'other', note: '',
            plugins: Array.isArray(plugins) ? plugins.filter(item => item.enabled).slice(0, 100).map(({ id, version, lastStatus }) => ({
                id: String(id || '').slice(0, 32), version: String(version || '').slice(0, 40), status: String(lastStatus || '').slice(0, 30) })) : [],
            events: events.slice() };
    }

    window.RPHubDiagnostics = {
        record, failure, send, report,
        clear() { events = []; eventBytes = 0; save(); },
        get enabled() { return settings.enabled; },
        set enabled(value) { settings.enabled = value; saveSettings(); if (value) usage(); },
        start() {
            if (window.RPH_R2_DIAGNOSTICS?.usage && !settings.notified) {
                window.RPHubUI.toast('测试版按 Cloudflare 账户统计活跃量，可在「运行日志」关闭。问题日志仅在你点击发送后上传。', { duration: 12000 });
                settings.notified = true;
                saveSettings();
            }
            usage();
            addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') usage(); });
            setInterval(usage, 60 * 60 * 1000);
        },
        attachApp({ get, watch }) {
            watch(() => get('currentCharacter')?.uuid, current => record('character-switch', { current }), { immediate: true });
            let owner = '';
            watch(() => get('isGenerating') === true, busy => {
                const current = get('currentCharacter')?.uuid;
                if (busy) owner = current;
                record(busy ? 'generation-start' : 'generation-end', { owner, current, count: get('chatHistory')?.length || 0 });
            });
        }
    };
    record('page-start');
})();
/* RP-Hub 覆盖层共用界面：弹窗、确认框、按钮、提示条都套用 RPH 原生的结构、样式类名和动画，跟随深色模式。
 * 弹窗：app-modal-overlay / compact-modal-panel / editor-modal-header / modal-close-button，进出场用 RPH 的 modal 过渡类名。
 * 提示条：优先调用页面自己的 showToast；页面还没挂载时用同样类名的备用提示条。 */
(function () {
    'use strict';
    if (window.RPHubUI) return;

    const CLOSE_ICON = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
    const WIDTHS = { sm: '26rem', md: '42rem' };
    const ENTER_FALLBACK_MS = 600;
    const LEAVE_FALLBACK_MS = 260;
    const stack = [];
    let toastHost = null;

    function appProxy() {
        const app = document.getElementById('app')?.__vue_app__;
        return (app?._instance || app?._container?._vnode?.component)?.proxy || null;
    }

    const transitions = new WeakMap();
    function transition(root, phase, done) {
        transitions.get(root)?.();
        const from = 'modal-' + phase + '-from', active = 'modal-' + phase + '-active', to = 'modal-' + phase + '-to';
        let frame, timer;
        const cancel = () => {
            cancelAnimationFrame(frame);
            clearTimeout(timer);
            root.removeEventListener('transitionend', finish);
            root.classList.remove(from, active, to);
            transitions.delete(root);
        };
        const finish = event => {
            if (event && event.target !== root) return;
            cancel();
            done?.();
        };
        transitions.set(root, cancel);
        root.classList.add(from, active);
        frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
            root.classList.remove(from);
            root.classList.add(to);
            root.addEventListener('transitionend', finish);
            timer = setTimeout(finish, phase === 'enter' ? ENTER_FALLBACK_MS : LEAVE_FALLBACK_MS);
        }); });
    }

    function onKeydown(event) {
        if (event.key === 'Escape' && stack.length) {
            event.stopPropagation();
            stack[stack.length - 1].close();
        }
    }

    function setAttributes(element, attributes = {}) {
        for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    }

    function openModal({ title = '', render, size = 'md', attributes = {}, bodyAttributes = {}, closeAttributes = {}, onClose } = {}) {
        if (typeof render !== 'function') throw new TypeError('modal render must be a function');
        const returnFocus = document.activeElement;
        const root = document.createElement('div');
        root.className = 'app-modal-overlay rph-ui-overlay';
        setAttributes(root, attributes);
        const panel = document.createElement('section');
        panel.className = 'app-modal-panel compact-modal-panel rph-ui-panel';
        panel.style.maxWidth = WIDTHS[size] || size;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', String(title || '面板'));
        panel.tabIndex = -1;
        const header = document.createElement('div');
        header.className = 'editor-modal-header';
        const heading = document.createElement('h3');
        heading.className = 'rph-ui-title';
        heading.textContent = String(title || '');
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'modal-close-button';
        closeButton.setAttribute('aria-label', '关闭');
        closeButton.title = '关闭';
        closeButton.innerHTML = CLOSE_ICON;
        setAttributes(closeButton, closeAttributes);
        header.append(heading, closeButton);
        const body = document.createElement('div');
        body.className = 'rph-ui-body';
        setAttributes(body, bodyAttributes);
        panel.append(header, body);
        root.appendChild(panel);

        let closed = false;
        const modal = {
            root, panel, body, closeButton,
            close() {
                if (closed) return;
                closed = true;
                stack.splice(stack.indexOf(modal), 1);
                if (!stack.length) document.removeEventListener('keydown', onKeydown, true);
                try { onClose?.(); } catch (error) { console.warn('[RPHubUI] onClose failed', error); }
                // 退场动画期间不再响应点击，也不再被选择器当成打开着的面板。
                for (const [element, names] of [[root, attributes], [body, bodyAttributes], [closeButton, closeAttributes]]) {
                    for (const name of Object.keys(names)) element.removeAttribute(name);
                }
                root.style.pointerEvents = 'none';
                transition(root, 'leave', () => root.remove());
                if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true });
            }
        };
        closeButton.addEventListener('click', () => modal.close());
        root.addEventListener('click', (event) => { if (event.target === root) modal.close(); });
        if (!stack.length) document.addEventListener('keydown', onKeydown, true);
        stack.push(modal);
        document.body.appendChild(root);
        try {
            render(body, modal);
        } catch (error) {
            modal.close();
            transitions.get(root)?.();
            root.remove();
            throw error;
        }
        transition(root, 'enter');
        // 焦点放在面板上（不显示焦点框），Tab 键从面板里的第一个控件开始。
        if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
        return modal;
    }

    function button(label, kind = 'secondary') {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = label;
        element.className = `${kind === 'primary' ? 'modal-primary-button' : 'modal-secondary-button'} rph-ui-button${kind === 'danger' ? ' rph-ui-danger' : ''}`;
        return element;
    }

    // 确认框：取消、关闭、点遮罩或按 Esc 都算“否”。
    function confirm({ title = '确认操作', message = '', confirmText = '继续', cancelText = '取消', danger = false } = {}) {
        return new Promise((resolve) => {
            let answer = false;
            openModal({
                title, size: 'sm',
                attributes: { 'data-rph-ui-confirm': '' },
                onClose: () => resolve(answer),
                render(body, modal) {
                    const text = document.createElement('p');
                    text.className = 'rph-ui-message';
                    text.textContent = message;
                    const actions = document.createElement('div');
                    actions.className = 'rph-ui-actions';
                    const cancel = button(cancelText);
                    const accept = button(confirmText, 'primary');
                    if (danger) accept.classList.add('rph-ui-danger');
                    accept.dataset.rphUiConfirmAccept = '';
                    cancel.addEventListener('click', () => modal.close());
                    accept.addEventListener('click', () => { answer = true; modal.close(); });
                    actions.append(cancel, accept);
                    body.append(text, actions);
                    requestAnimationFrame(() => accept.focus({ preventScroll: true }));
                }
            });
        });
    }

    const TOAST_KINDS = new Set(['info', 'success', 'error', 'warning']);
    const shownUntil = new Map();
    let toastSeed = 0;

    // RPH 2.0.1 起提示条固定一行高（收起动画按这个高度把空位折叠掉）；长提示换行后放不下时，
    // 按实际高度设这条的 --toast-height，文字完整显示，收起动画也按实际高度走。
    function fitToast(item) {
        requestAnimationFrame(() => {
            const fixed = item.offsetHeight;
            item.style.height = 'auto';
            const needed = item.offsetHeight;
            item.style.height = '';
            if (needed > fixed + 1) item.style.setProperty('--toast-height', `${needed}px`);
        });
    }

    let toastStackWatched = false;
    function watchToastStack(tries = 40) {
        const stack = document.querySelector('#app .toast-stack');
        if (!stack) {
            if (tries > 0) setTimeout(() => watchToastStack(tries - 1), 500);
            return;
        }
        toastStackWatched = true;
        new MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.addedNodes) if (node.classList?.contains('toast-item')) fitToast(node);
            }
        }).observe(stack, { childList: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => watchToastStack(), { once: true });
    else watchToastStack();

    function toast(message, { kind = 'info', duration = 3200 } = {}) {
        const text = String(message || '').trim();
        if (!text) return;
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', () => toast(text, { kind, duration }), { once: true });
            return;
        }
        // 同一句提示还在显示时不再重复弹（例如多条消息同时报同一个错）。
        if (shownUntil.get(text) > Date.now()) return;
        shownUntil.set(text, Date.now() + duration);
        const type = TOAST_KINDS.has(kind) ? kind : 'info';
        // 交给 RPH 自己的提示条列表显示：图标、动画和原生提示一致。
        const proxy = appProxy();
        if (Array.isArray(proxy?.toasts)) {
            if (!toastStackWatched) watchToastStack(0);
            const id = `rph-ui-${Date.now()}-${toastSeed++}`;
            proxy.toasts.push({ id, message: text, type, icon: window.RPHubUtils?.getToastIcon?.(text, type) || '' });
            setTimeout(() => { proxy.toasts = proxy.toasts.filter((item) => item.id !== id); }, duration);
            return;
        }
        if (!toastHost?.isConnected) {
            toastHost = document.createElement('div');
            toastHost.className = 'toast-stack rph-ui-toast-stack';
            toastHost.setAttribute('aria-live', 'polite');
            document.body.appendChild(toastHost);
        }
        const item = document.createElement('div');
        item.className = `toast-item toast-item--${type}`;
        item.setAttribute('role', type === 'error' ? 'alert' : 'status');
        const textNode = document.createElement('span');
        textNode.className = 'toast-text';
        textNode.textContent = text;
        item.appendChild(textNode);
        toastHost.appendChild(item);
        setTimeout(() => item.remove(), duration);
    }

    window.RPHubUI = Object.freeze({ openModal, confirm, button, toast,
        openLogViewer: () => window.RPHubDiagnostics.openPanel() });
})();
(() => {
    const diagnostics = window.RPHubDiagnostics;
    const ISSUES = { image: '图片不对', save: '保存失败', sync: '同步异常', voice: '朗读异常', startup: '打不开或卡住', other: '其他问题' };
    const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>';
    diagnostics.openPanel = () => {
        let issueApp;
        return window.RPHubUI.openModal({
            title: '运行日志', size: 'sm', attributes: { 'data-rph-diagnostics': '' },
            onClose: () => issueApp?.unmount(),
            render(body) {
                const report = diagnostics.report();
                // 首屏只放选问题、写一句和发送；报告原文和统计开关在下面两行。
                body.innerHTML = `
                    <div class="rph-ui-field"><span>问题类型</span><select class="rph-ui-input" data-issue aria-label="问题类型">
                        ${Object.entries(ISSUES).map(([value, label]) => `<option value="${value}"${value === report.issue ? ' selected' : ''}>${label}</option>`).join('')}
                    </select></div>
                    <label class="rph-ui-field">补充说明（选填）
                        <textarea class="rph-ui-input" data-note maxlength="500" rows="3" placeholder="哪里不对，原本希望怎样？"></textarea>
                    </label>
                    <p class="rph-ui-note" data-result role="status" hidden></p>
                    <div class="rph-ui-actions">
                        <button type="button" class="modal-secondary-button rph-ui-button" data-download>下载报告</button>
                        <button type="button" class="modal-primary-button rph-ui-button" data-send>发送报告</button>
                    </div>
                    <div class="rph-ui-list">
                        <details data-details>
                            <summary class="rph-ui-row"><div class="rph-ui-row-main"><div>报告内容</div><div class="rph-ui-muted" data-count></div></div>${CHEVRON}</summary>
                            <div class="rph-ui-row">
                                <textarea class="rph-ui-input rph-ui-code" readonly data-preview rows="10" aria-label="报告内容"></textarea>
                                <button type="button" class="modal-secondary-button rph-ui-button rph-ui-danger" data-clear>清空本机日志</button>
                            </div>
                        </details>
                        <div class="rph-ui-row">
                            <div class="rph-ui-row-main"><div>使用统计</div><div class="rph-ui-muted">每天一次，按 Cloudflare 账户去重，不含原始 ID。</div></div>
                            <label class="rph-ui-check"><input type="checkbox" class="settings-toggle-input sr-only" data-usage aria-label="参与使用统计"><span class="settings-toggle"></span></label>
                        </div>
                    </div>`;
                const issue = body.querySelector('[data-issue]'), note = body.querySelector('[data-note]');
                const preview = body.querySelector('[data-preview]'), result = body.querySelector('[data-result]');
                const showResult = (parts, tone = '') => { result.replaceChildren(...[parts].flat()); result.dataset.tone = tone; result.hidden = false; };
                const update = () => {
                    report.issue = issue.value;
                    report.note = note.value.trim();
                    preview.value = JSON.stringify(report, null, 2);
                    const errors = report.events.filter(event => /error|rejection/.test(event.kind)).length;
                    body.querySelector('[data-count]').textContent = `版本、插件和 ${report.events.length} 条运行记录${errors ? `（${errors} 条报错）` : ''}，不含聊天、角色和密钥。`;
                };
                const usage = body.querySelector('[data-usage]');
                usage.checked = diagnostics.enabled;
                usage.onchange = () => { diagnostics.enabled = usage.checked; };
                issue.onchange = update;
                note.oninput = update;
                // 用 RPH 的下拉组件；启动失败或旧页面没有组件时仍可选择问题并导出日志。
                if (window.RPHubCustomSelect && window.Vue) {
                    const host = document.createElement('div'), value = Vue.ref(issue.value);
                    issue.hidden = true;
                    issue.after(host);
                    issueApp = Vue.createApp({ render: () => Vue.h(window.RPHubCustomSelect, {
                        modelValue: value.value, options: Object.entries(ISSUES).map(([key, label]) => ({ value: key, label })),
                        buttonClass: 'rph-ui-input', menuClass: 'text-sm',
                        'onUpdate:modelValue': next => { value.value = issue.value = next; update(); }
                    }) });
                    issueApp.mount(host);
                }
                body.querySelector('[data-clear]').onclick = () => {
                    diagnostics.clear(); report.events = []; update(); showResult('本机日志已清空。');
                };
                body.querySelector('[data-download]').onclick = () => {
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(new Blob([preview.value], { type: 'application/json' }));
                    link.download = 'rph-report-' + new Date().toISOString().slice(0, 10) + '.json';
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
                };
                const send = body.querySelector('[data-send]');
                send.onclick = async () => {
                    send.disabled = true;
                    showResult('正在发送…');
                    try {
                        const { id } = await diagnostics.send('report', report);
                        showResult(['已发送，编号 ', Object.assign(document.createElement('b'), { textContent: id }), '。把编号转给开发者即可。']);
                        // 发送成功后这个按钮改成复制编号，避免重复发送。
                        send.textContent = '复制编号';
                        send.onclick = () => navigator.clipboard.writeText(id).then(
                            () => window.RPHubUI.toast('编号已复制', { kind: 'success' }),
                            () => window.RPHubUI.toast('复制失败，请长按编号手动复制', { kind: 'error' }));
                    } catch (error) { showResult('发送失败：' + error.message, 'error'); }
                    send.disabled = false;
                };
                update();
            }
        });
    };
    diagnostics.mount = () => {
        window.RPHubNavAdapter.registerEntry({ id: 'run-log', label: '运行日志',
            attributes: { 'data-rph-diagnostics-entry': '' }, onClick: diagnostics.openPanel, waitForClose: true,
            iconPaths: ['M8 3h8l4 4v14H4V3h4z', 'M8 11h8M8 15h8'] });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', diagnostics.start, { once: true });
        else diagnostics.start();
    };
})();
