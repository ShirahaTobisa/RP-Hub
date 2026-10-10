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

    // 按 Vue <transition name="modal"> 的顺序切换类名：*-from + *-active → 下一帧 *-to → 结束后清理。
    function transition(root, phase, done) {
        const from = `modal-${phase}-from`;
        const active = `modal-${phase}-active`;
        const to = `modal-${phase}-to`;
        root.classList.add(from, active);
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            root.classList.remove(active, to);
            done?.();
        };
        requestAnimationFrame(() => requestAnimationFrame(() => {
            root.classList.remove(from);
            root.classList.add(to);
            root.addEventListener('transitionend', (event) => { if (event.target === root) finish(); });
            setTimeout(finish, phase === 'enter' ? ENTER_FALLBACK_MS : LEAVE_FALLBACK_MS);
        }));
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
            root.remove();
            stack.splice(stack.indexOf(modal), 1);
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
        const native = appProxy()?.showToast;
        if (typeof native === 'function') {
            native(text, type, duration);
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

    // 运行日志：记下警告、报错和未捕获的异常，存在本机（不进云同步），手机上没有控制台也能查看和复制。
    const LOG_KEY = 'rphub_debug_log_v1';
    const LOG_LIMIT = 300;
    let logs = [];
    let saveTimer = 0;
    try { logs = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (_) { logs = []; }
    if (!Array.isArray(logs)) logs = [];

    function saveLogs() {
        clearTimeout(saveTimer);
        saveTimer = 0;
        try { localStorage.setItem(LOG_KEY, JSON.stringify(logs)); } catch (_) { /* 存满时只保留内存里的 */ }
    }

    function formatLogPart(value) {
        if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value); } catch (_) { return String(value); }
    }

    function record(level, parts) {
        const time = new Date();
        const text = parts.map(formatLogPart).join(' ').slice(0, 2000);
        logs.push(`${time.toLocaleString('zh-CN', { hour12: false })} [${level}] ${text}`);
        if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
        if (!saveTimer) saveTimer = setTimeout(saveLogs, 1000);
    }

    for (const level of ['warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => { record(level, args); original(...args); };
    }
    window.addEventListener('error', (event) => record('error', [event.error || event.message]));
    window.addEventListener('unhandledrejection', (event) => record('error', ['未处理的异常', event.reason]));
    window.addEventListener('pagehide', saveLogs);

    function openLogViewer() {
        openModal({
            title: '运行日志',
            attributes: { 'data-rph-log-viewer': '' },
            render(body) {
                const note = document.createElement('p');
                note.className = 'rph-ui-muted';
                note.textContent = `最近 ${LOG_LIMIT} 条警告和报错，只存在这台设备上。遇到问题时复制发给开发者。`;
                const area = document.createElement('textarea');
                area.className = 'rph-ui-input';
                area.readOnly = true;
                area.style.cssText = 'width:100%;min-height:50vh;margin:0.75rem 0;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;';
                const show = () => { area.value = logs.length ? logs.slice().reverse().join('\n\n') : '暂无日志'; };
                show();
                const actions = document.createElement('div');
                actions.className = 'rph-ui-actions';
                const clear = button('清空', 'danger');
                const copy = button('复制全部', 'primary');
                clear.addEventListener('click', async () => {
                    if (!await confirm({ title: '清空日志', message: '清空后无法恢复。', confirmText: '清空', danger: true })) return;
                    logs = [];
                    saveLogs();
                    show();
                });
                copy.addEventListener('click', async () => {
                    try {
                        await navigator.clipboard.writeText(area.value);
                    } catch (_) {
                        area.select();
                        document.execCommand('copy');
                    }
                    toast('已复制日志', { kind: 'success' });
                });
                actions.append(clear, copy);
                body.append(note, area, actions);
            }
        });
    }

    window.RPHubUI = Object.freeze({ openModal, confirm, button, toast, openLogViewer });
})();
