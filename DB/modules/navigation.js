// 导航：导航面板里的入口自己挑显示哪些；手机上把常用的几个固定在底部，聊天页也在（键盘弹出、全屏时收起）。
// 入口直接从面板上认：官方的按文字，外壳和别的插件加的按它们登记的编号（文字会变，比如「同步」同步时显示「处理中」），
// 所以官方加减入口、装卸插件都不用跟着改。哪一步对不上就保持官方原样：找不到放「编辑」的地方就什么都不藏；底栏上的入口没了就自动拿掉；
// 哪个页面没给底栏让出位置，底栏就不在那个页面出现。
(() => {
    'use strict';

    const BAR_MAX = 4;
    const BAR_DEFAULT = ['聊天', '角色卡管理', '预设', '设置'];
    const SVG = 'http://www.w3.org/2000/svg';
    // 入口的图标只记形状和尺寸，画的时候也只认这些，存下来的东西里混不进别的。
    const SHAPE = /^(path|rect|circle|line|polyline|use)$/;
    const GEOMETRY = /^(d|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|points|href|stroke-(width|linecap|linejoin))$/;
    const MORE = [['path', [['d', 'M4 7h16M4 12h16M4 17h16'], ['stroke-width', '1.7'], ['stroke-linecap', 'round']]]];
    const CSS = `#app-navigation-panel:not([data-rph-nav-edit]) :is(.app-navigation-item[data-rph-nav-off],.app-navigation-section[data-rph-nav-empty],.rph-nav-tools [data-mode]){display:none!important}
.rph-nav-tools{display:flex;align-items:center;gap:4px;margin-left:auto}
.rph-nav-tools button{height:30px;padding:0 10px;border-radius:999px;color:var(--c-text-3);font-size:12px;font-weight:600;white-space:nowrap}
.rph-nav-tools button:first-child{order:1}
.rph-nav-tools button[aria-pressed="true"]{background:rgb(var(--primary-500)/.12);color:var(--c-accent-text)}
#app-navigation-panel[data-rph-nav-edit] .app-navigation-brand{display:none}
#app-navigation-panel[data-rph-nav-edit] .rph-nav-tools{flex:1;margin-left:-10px}
#app-navigation-panel[data-rph-nav-edit] .rph-nav-tools button:first-child{margin-left:auto;color:var(--c-accent-text)}
#app-navigation-panel[data-rph-nav-edit="show"] .app-navigation-item[data-rph-nav-off]{opacity:.42;border:1px dashed var(--c-border-strong);background:none;box-shadow:none}
#app-navigation-panel[data-rph-nav-edit="bar"] .app-navigation-item[data-rph-nav-pin]{box-shadow:inset 0 0 0 1.5px rgb(var(--primary-500))}
#app-navigation-panel[data-rph-nav-edit="bar"] .app-navigation-item[data-rph-nav-pin]::after{content:attr(data-rph-nav-pin);position:absolute;top:5px;right:5px;display:grid;place-items:center;width:17px;height:17px;border-radius:50%;background:rgb(var(--primary-500));color:#fff;font-size:11px;font-weight:700;line-height:1}
.rph-nav-bar{display:none}
@media (max-width:767px){#app>.rph-nav-bar:not([hidden]){order:99;display:flex;flex:none;padding:4px 6px calc(4px + env(safe-area-inset-bottom));border-top:1px solid var(--c-border-soft);background:var(--c-surface)}}
.rph-nav-tab{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;padding:3px 2px;border-radius:var(--r-md);color:var(--c-text-3);font-size:11px;font-weight:500;line-height:1.3;transition:transform var(--dur-2) var(--ease-out)}
.rph-nav-tab>span:last-child{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rph-nav-tab.is-current,.rph-nav-tab.is-current .app-navigation-icon{color:var(--c-accent-text)}
.rph-nav-tab:active{transform:scale(.94)}
.rph-nav-quiet .app-navigation-layer{opacity:0!important;pointer-events:none!important}`;

    let ctx;
    let hidden;             // 面板里不显示的入口（记的是 keyOf 认出来的名字）
    let pins;               // 底栏上的入口 { key 认它用的名字, label 文字, icon 图标, view 插件页面的页面名 }；没挑过时是 defaultPins()，读不到官方清单时是 null，第一次打开面板时从面板上取
    let mode = '';          // 编辑中：'show' 挑面板里显示哪些，'bar' 挑底栏放哪些
    let bar;
    let official = null;
    let watched = null;
    let busy = false;
    let skins = null;               // 皮肤插件（装了才有）：底栏画好后让它把图标换成彩绘的
    const cramped = new Set();      // 没给底栏让出位置的页面，底栏不在这些页面出现

    const element = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
    const labelOf = (item) => item.textContent.trim();
    const keyOf = (item) => (item.dataset.rphNavEntry ? `#${item.dataset.rphNavEntry}` : labelOf(item));
    const frame = () => new Promise(requestAnimationFrame);
    const read = (key) => { try { return JSON.parse(ctx.storage.get(key)); } catch (_) { return null; } };

    const readIcon = (svg) => [...(svg?.children || [])].filter((node) => SHAPE.test(node.tagName))
        .map((node) => [node.tagName, [...node.attributes].filter((attribute) => GEOMETRY.test(attribute.name)).map((attribute) => [attribute.name, attribute.value])]);

    function drawIcon(shapes) {
        const svg = document.createElementNS(SVG, 'svg');
        for (const [name, value] of [['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['aria-hidden', 'true']]) svg.setAttribute(name, value);
        for (const [tag, attributes] of Array.isArray(shapes) ? shapes : []) {
            if (!SHAPE.test(tag)) continue;
            const node = svg.appendChild(document.createElementNS(SVG, tag));
            for (const [name, value] of attributes) if (GEOMETRY.test(name)) node.setAttribute(name, String(value));
        }
        return svg;
    }

    // 官方导航组件里的页面清单（文字 → { view 页面名, icon 图标 }），直接从页面上读，官方加减页面不用跟着改。
    // 读不到时底栏改成替用户在面板里点（见 go），默认入口等第一次打开面板时从面板上取（见 syncPanel）。
    function officialItems() {
        if (!official) {
            try {
                const nav = document.getElementById('app')._vnode.component.subTree.children.find((vnode) => vnode?.type === window.RPHubLayoutComponents.AppNavigation);
                official = new Map(nav.component.setupState.sections.flatMap((section) => section.items.map((item) => [item.label, item])));
            } catch (_) { return new Map(); }
        }
        return official;
    }
    const viewOf = (label) => officialItems().get(label)?.view;

    // 还没挑过底栏时先放上几个常用的，图标照官方面板的画法（有路径画路径，没有的是官方的齿轮）。挑过之后存的是用户自己的。
    function defaultPins() {
        const made = BAR_DEFAULT.map((label) => officialItems().get(label)).filter(Boolean).map((item) => ({
            key: item.label,
            label: item.label,
            icon: item.icon ? [['path', [['d', item.icon], ['stroke-width', '1.7'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]]] : [['use', [['href', '#icon-settings']]]]
        }));
        return made.length ? made : null;
    }

    const capture = (item) => ({
        key: keyOf(item),
        label: labelOf(item),
        icon: readIcon(item.querySelector('svg')),
        // 插件自己的整页功能：页面名是加载器按插件 id 定的，记下来只为了在底栏上标出「现在在这页」。
        ...(item.dataset.rphWorkshopPageEntry ? { view: `rph-page-${item.dataset.rphWorkshopPageEntry}` } : {})
    });

    function savePins() {
        ctx.storage.set('bar', JSON.stringify(pins));
        renderBar();
    }

    function tab(label, icon, onClick) {
        const button = element('button', 'rph-nav-tab');
        button.type = 'button';
        button.dataset.rphIcon = label;     // 皮肤插件认这个名字，给它换成彩绘图标
        const holder = element('span', 'app-navigation-icon');
        holder.appendChild(drawIcon(icon));
        button.append(holder, element('span', '', label));
        button.addEventListener('click', onClick);
        return button;
    }

    function renderBar() {
        bar.replaceChildren(...(pins || []).map((pin) => tab(pin.label, pin.icon, () => go(pin))),
            tab('更多', MORE, () => ctx.app.get('toggleNavigation')?.()));
        paint();
        skins?.refreshIcons?.();
    }

    // 在哪一页，底栏上对应的入口亮着；键盘弹出、聊天全屏时收起（读官方页面的状态，官方写在 #app 上的那两个类名不会生效）。
    function paint() {
        const view = ctx.app.get('currentView');
        bar.hidden = !pins?.length || cramped.has(view) || ctx.app.get('isMobileKeyboardOpen') === true || ctx.app.get('isChatFullscreen') === true;
        (pins || []).forEach((pin, index) => bar.children[index].classList.toggle('is-current', (viewOf(pin.key) || pin.view) === view));
        requestAnimationFrame(checkRoom);
    }

    // 底栏占了主区域下面一条，页面要跟着矮一截（聊天页也会，输入框让到底栏上面）。量一下当前页面真让出来了没有，
    // 没有（官方换了写法）就不在这个页面放底栏，不能盖住输入框这类贴底的东西。
    function checkRoom() {
        const main = document.querySelector('#app .app-main');
        if (!main || !bar.offsetParent) return;
        if ([...main.children].some((child) => child.offsetParent === main && child.offsetTop + child.offsetHeight > main.clientHeight + 1)) {
            cramped.add(ctx.app.get('currentView'));
            paint();
        }
    }

    // 点底栏的入口。官方页面直接换过去；别的入口（外壳的、插件的）替用户在面板里点一下：面板先藏着打开，找到就点
    // （入口正忙就不点，比如同步进行中）；找不到说明这个入口没了，从底栏拿掉，把面板亮出来让用户自己选。
    async function go(pin) {
        const view = viewOf(pin.key);
        if (view) { ctx.app.set('currentView', view); return; }
        const togglePanel = ctx.app.get('toggleNavigation');
        if (busy || !togglePanel) return;
        busy = true;
        document.documentElement.classList.add('rph-nav-quiet');
        try {
            if (!ctx.app.get('isNavigationOpen')) togglePanel();
            let item;
            for (let tries = 0; tries < 20 && !item; tries += 1) {
                await frame();
                item = [...document.querySelectorAll('#app-navigation-panel .app-navigation-item')].find((node) => keyOf(node) === pin.key);
            }
            if (item) {
                if (item.disabled) togglePanel(); else item.click();
                // 等面板收完再放开，不然它会闪一下。
                for (let tries = 0; tries < 60 && document.querySelector('.app-navigation-layer'); tries += 1) await frame();
            } else {
                pins = pins.filter((other) => other !== pin);
                savePins();
                ctx.ui.toast(`「${pin.label}」已不存在，已从底部栏移除`, { kind: 'info' });
            }
        } finally {
            document.documentElement.classList.remove('rph-nav-quiet');
            busy = false;
        }
    }

    // 面板标题栏里的「编辑」，点开后多出两个选项：挑面板里显示哪些、挑底部栏放哪些。
    // 「编辑」排在最前（样式把它摆到最右）：官方拿面板里第一个按钮接 Tab 键，它得是一直看得见的那个。
    const tools = element('div', 'rph-nav-tools');
    const toolButton = (text, next, name = '') => {
        const button = element('button', '', text);
        button.type = 'button';
        if (name) button.dataset.mode = name;
        button.addEventListener('click', () => { mode = next(); syncPanel(); });
        return tools.appendChild(button);
    };
    const toggle = toolButton('编辑', () => (mode ? '' : 'show'));
    toolButton('显示/隐藏', () => 'show', 'show');
    toolButton('底部栏', () => 'bar', 'bar');

    // 面板每次打开都是新画的：放上「编辑」，按记下的把入口标成不显示 / 在底栏上，样式照着标记收起或标出来。
    function syncPanel() {
        const panel = document.getElementById('app-navigation-panel');
        const close = panel?.querySelector('.app-navigation-close');
        if (!close) return;
        if (panel !== watched) {
            watched = panel;
            observer.observe(panel, { childList: true, subtree: true });    // 外壳和别的插件的入口晚一步才加进来
        }
        if (tools.parentElement !== close.parentElement) close.before(tools);
        if (!pins) {
            const items = [...panel.querySelectorAll('.app-navigation-item')];
            pins = BAR_DEFAULT.map((label) => items.find((item) => labelOf(item) === label)).filter(Boolean).map(capture);
            savePins();
        }
        if (mode) panel.dataset.rphNavEdit = mode; else delete panel.dataset.rphNavEdit;
        // 文字没变就不写：写一次算一次面板内容变动，会再触发这个函数，停不下来。
        const text = mode ? '完成' : '编辑';
        if (toggle.textContent !== text) toggle.textContent = text;
        for (const button of tools.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
        for (const section of panel.querySelectorAll('.app-navigation-section')) {
            let shown = 0;
            for (const item of section.querySelectorAll('.app-navigation-item')) {
                const key = keyOf(item);
                const order = pins.findIndex((pin) => pin.key === key) + 1;
                item.toggleAttribute('data-rph-nav-off', hidden.has(key));
                if (order) item.dataset.rphNavPin = order; else delete item.dataset.rphNavPin;
                shown += !hidden.has(key);
            }
            section.toggleAttribute('data-rph-nav-empty', !shown);
        }
        // 面板是按打开那一刻的高度摆的位置，之后变高（外壳的入口晚到、进了编辑）会伸出屏幕，往上挪回来。
        const over = panel.offsetTop + panel.offsetHeight + 12 - window.innerHeight;
        if (over > 0 && getComputedStyle(panel).position === 'absolute') panel.style.top = `${Math.max(12, panel.offsetTop - over)}px`;
    }
    const observer = new MutationObserver(syncPanel);

    // 编辑中点入口是挑选，不是打开：抢在官方和外壳的点击处理之前拦下。
    function pick(event) {
        const item = mode && event.target.closest('#app-navigation-panel .app-navigation-item');
        if (!item) return;
        event.preventDefault();
        event.stopPropagation();
        const key = keyOf(item);
        if (mode === 'show') {
            if (!hidden.delete(key)) hidden.add(key);
            ctx.storage.set('hidden', JSON.stringify([...hidden]));
        } else if (pins.some((pin) => pin.key === key)) {
            pins = pins.filter((pin) => pin.key !== key);
            savePins();
        } else if (pins.length < BAR_MAX) {
            pins.push(capture(item));
            savePins();
        } else {
            ctx.ui.toast(`底部栏最多放 ${BAR_MAX} 个`, { kind: 'info' });
        }
        syncPanel();
    }

    RPHubSDK.register({
        id: 'navigation', name: '导航', version: '1.1.2', requiresApi: 10,
        init(context) {
            ctx = context;
            const saved = read('bar');
            hidden = new Set([].concat(read('hidden') || []));
            pins = Array.isArray(saved) ? saved.filter((pin) => typeof pin?.key === 'string' && typeof pin.label === 'string') : defaultPins();
            ctx.ui.addStyle(CSS);
            ctx.ui.attach({
                anchor: '#app', position: 'append',
                render(node) {
                    bar = node;
                    bar.className = 'rph-nav-bar';
                    bar.setAttribute('role', 'navigation');
                    bar.setAttribute('aria-label', '常用页面');
                    renderBar();
                }
            });
            ctx.app.watch(() => [ctx.app.get('currentView'), ctx.app.get('isMobileKeyboardOpen'), ctx.app.get('isChatFullscreen')].join(), paint);
            ctx.app.watch(() => ctx.app.get('isNavigationOpen'), (open) => {
                if (!open) mode = '';
                else requestAnimationFrame(syncPanel);      // 平时面板一出现就处理了，这里兜底
            });
            document.addEventListener('click', pick, true);
            window.addEventListener('resize', () => requestAnimationFrame(checkRoom));     // 屏幕转向、窗口变窄后底栏才出现
            observer.observe(document.getElementById('app'), { childList: true });
            syncPanel();
            ctx.use('skins').then((api) => { skins = api; api.refreshIcons?.(); });
        }
    });
})();
