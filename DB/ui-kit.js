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

    function toast(message, { kind = 'info', duration = 3200 } = {}) {
        const text = String(message || '').trim();
        if (!text) return;
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', () => toast(text, { kind, duration }), { once: true });
            return;
        }
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

    window.RPHubUI = Object.freeze({ openModal, confirm, button, toast });
})();
