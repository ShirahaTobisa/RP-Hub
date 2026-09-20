(function () {
    if (window.RPHubNavAdapter) return;
    const entries = new Map();
    const marker = 'data-rph-nav-entry';
    const panelSelector = '#app-navigation-panel.app-navigation-panel';
    let observer;
    let scheduled = false;
    let closing = null;

    function locate() {
        const panel = document.querySelector(panelSelector);
        if (panel) {
            const container = [...panel.querySelectorAll('.app-navigation-grid')].at(-1);
            const template = container?.querySelector(`button:not([${marker}])`);
            return template ? { container, template, panel } : null;
        }
        const sidebar = document.querySelector('#app .app-sidebar');
        const anchor = [...(sidebar?.querySelectorAll('button, a, [role="button"]') || [])]
            .find((node) => !node.hasAttribute(marker) && node.textContent.trim() === '设置');
        if (!anchor) return null;
        const template = anchor.classList.contains('bg-primary-50')
            ? [...anchor.parentElement.children].find(node => node.matches('button, a, [role="button"]')
                && !node.hasAttribute(marker) && !node.classList.contains('bg-primary-50')) || anchor
            : anchor;
        return { container: anchor.parentElement, template, anchor, panel: null };
    }

    function labelNode(node) {
        return [...node.querySelectorAll('*')].find((child) => !child.closest('svg')
            && !child.children.length && child.textContent.trim());
    }

    function cleanClass(value) {
        return value.split(/\s+/).filter((name) => !/^(is-(current|active|selected|disabled)|bg-primary-50|text-primary-700)$/.test(name)).join(' ');
    }

    function setAttribute(node, name, value) {
        if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }

    function render(entry, template) {
        const node = entry.node;
        setAttribute(node, 'class', cleanClass(template.getAttribute('class') || ''));
        for (const [source, target] of [
            [template.querySelector('svg'), node.querySelector('svg')],
            [labelNode(template), node.querySelector('[data-rph-nav-label]')]
        ]) {
            if (!source || !target) continue;
            setAttribute(target, 'class', cleanClass(source.getAttribute('class') || ''));
            const display = getComputedStyle(source).display === 'none' ? 'none' : '';
            if (target.style.display !== display) target.style.display = display;
        }
        const label = node.querySelector('[data-rph-nav-label]');
        if (label.textContent !== entry.label) label.textContent = entry.label;
        setAttribute(node, 'title', entry.label);
        setAttribute(node, 'aria-label', entry.label);
        setAttribute(node, 'aria-busy', String(entry.busy));
        if (node instanceof HTMLButtonElement) node.disabled = entry.busy;
    }

    function invoke(entry) {
        if (entries.get(entry.id) !== entry || entry.busy) return;
        try {
            Promise.resolve(entry.onClick()).catch((error) => console.warn('[RPH nav]', entry.id, error));
        } catch (error) { console.warn('[RPH nav]', entry.id, error); }
    }

    function finishClose(timedOut = false) {
        const activation = closing;
        if (!activation || (!timedOut && activation.panel.isConnected)) return;
        closing = null;
        clearTimeout(activation.timer);
        document.removeEventListener('focusin', activation.onFocus, true);
        document.removeEventListener('pointerdown', activation.onInput, true);
        document.removeEventListener('keydown', activation.onInput, true);
        if (timedOut) {
            console.warn('[RPH nav] 导航未及时关闭，已取消等待中的激活。', activation.entry.id);
            return;
        }
        // Vue's after-leave focus restoration has run before this DOM observation.
        if (activation.entry.waitForClose) invoke(activation.entry);
        else if (!activation.userMoved && activation.target?.isConnected
            && document.activeElement?.matches('.app-nav-trigger')) {
            activation.target.focus({ preventScroll: true });
        }
    }

    function activate(entry, event) {
        event.preventDefault();
        event.stopPropagation();
        if (entry.busy || closing) return;
        const panel = entry.node.closest(panelSelector);
        if (!panel) { invoke(entry); return; }
        const close = panel.querySelector('.app-navigation-close');
        if (!close) {
            console.warn('[RPH nav] 找不到导航关闭按钮，已取消激活。', entry.id);
            return;
        }
        const activation = {
            entry, panel, target: null, userMoved: false,
            onInput: () => { activation.userMoved = true; },
            onFocus: (focusEvent) => {
                const target = focusEvent.target;
                if (!activation.userMoved && target instanceof HTMLElement
                    && target !== document.body && !panel.contains(target)
                    && !target.matches('.app-nav-trigger')) activation.target = target;
            }
        };
        closing = activation;
        document.addEventListener('focusin', activation.onFocus, true);
        document.addEventListener('pointerdown', activation.onInput, true);
        document.addEventListener('keydown', activation.onInput, true);
        activation.timer = setTimeout(() => finishClose(true), 2000);
        close.click();
        if (!entry.waitForClose) invoke(entry);
        scheduleMount();
    }

    function createEntry(entry, template) {
        const node = template.cloneNode(true);
        for (const child of [node, ...node.querySelectorAll('*')]) {
            for (const attr of [...child.attributes]) {
                if (/^(id|disabled|selected|checked|tabindex|aria-current|aria-selected|aria-disabled)$/.test(attr.name)
                    || /^(on|v-|:|@)/i.test(attr.name)) child.removeAttribute(attr.name);
            }
            if (child.hasAttribute('class')) child.setAttribute('class', cleanClass(child.getAttribute('class')));
        }
        node.removeAttribute('href');
        node.querySelectorAll('.app-navigation-status').forEach((status) => status.remove());
        node.setAttribute(marker, entry.id);
        for (const [name, value] of Object.entries(entry.attributes)) node.setAttribute(name, value);
        if (node instanceof HTMLButtonElement) node.type = 'button';
        else {
            node.setAttribute('role', 'button');
            node.tabIndex = 0;
            node.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') activate(entry, event);
            });
        }
        const label = labelNode(node) || node.appendChild(document.createElement('span'));
        label.setAttribute('data-rph-nav-label', '');
        const svg = node.querySelector('svg');
        if (svg) svg.replaceChildren(...entry.iconPaths.map((data) => {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', data);
            path.setAttribute('stroke-width', '2');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            return path;
        }));
        node.addEventListener('click', (event) => activate(entry, event));
        entry.node = node;
        return node;
    }

    function mount() {
        scheduled = false;
        finishClose();
        const location = locate();
        for (const entry of entries.values()) {
            if (entry.node && (!entry.node.isConnected || entry.node.parentElement !== location?.container)) {
                entry.node.remove();
                entry.node = null;
            }
        }
        if (!location) return;
        const { container, template, panel } = location;
        for (const node of container.querySelectorAll(`[${marker}]`)) {
            if (entries.get(node.getAttribute(marker))?.node !== node) node.remove();
        }
        let anchor = location.anchor || template;
        for (const entry of entries.values()) {
            const node = entry.node || createEntry(entry, template);
            render(entry, template);
            if (panel) {
                if (node.parentElement !== container) container.appendChild(node);
            } else if (anchor.nextElementSibling !== node) anchor.after(node);
            anchor = node;
        }
    }

    function scheduleMount() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(mount);
    }

    window.RPHubNavAdapter = Object.freeze({
        registerEntry({ id, label, iconPaths = [], attributes = {}, onClick, waitForClose = false }) {
            if (!id || typeof onClick !== 'function') throw new TypeError('导航入口需要 id 和点击回调。');
            const previous = entries.get(id);
            previous?.node?.remove();
            if (previous) previous.node = null;
            const entry = { id, label: String(label), iconPaths, attributes, onClick, waitForClose, busy: false, node: null };
            entries.set(id, entry);
            if (!observer) {
                observer = new MutationObserver(scheduleMount);
                observer.observe(document.documentElement, {
                    childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style']
                });
            }
            mount();
            return Object.freeze({
                update({ label, busy } = {}) {
                    if (entries.get(id) !== entry) return;
                    if (label !== undefined) entry.label = String(label);
                    if (busy !== undefined) entry.busy = Boolean(busy);
                    mount();
                },
                dispose() {
                    if (entries.get(id) !== entry) return;
                    entry.node?.remove();
                    entry.node = null;
                    entries.delete(id);
                    if (!entries.size) { observer.disconnect(); observer = null; }
                }
            });
        }
    });
})();
