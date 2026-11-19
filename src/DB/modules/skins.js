// 皮肤：换整站配色、开屏图、页面背景和图标。自带里见茜一套，别的从分发端的「皮肤工坊」下载（皮肤包只有图和颜色，不带代码）；
// 每套都能再调主题色、底色饱和度和背景图透明度，也可以上传自己的图片（能预览手机和电脑上的样子、拖动调整位置），「自定义」能导出成皮肤包投稿到皮肤工坊。
// 配色只换官方 theme.css 里那些颜色变量的色相和浓淡，明暗不动，所以官方调好的文字对比度不变，官方改版也照常跟。
// 别的插件可以再加皮肤：ctx.use('skins').then((skins) => skins.register({ id, name, note, accent, neutral, colors, art, wide, icons, css, apply, remove }))。
// accent 是主题色，neutral 定底色的色调，colors 是这套皮肤自己的几个备选主题色；art 是皮肤的图（竖图，一张或几张，每次打开随机用一张，
// 当开屏图和页面背景），wide 是和 art 一一对应的横版（可以不给），横屏（电脑）时用它。电脑上聊天栏在正中间，横版里人物要靠一边，
// 并在图片地址末尾写上 #left 或 #right 告诉插件是哪边；icons 是 6 列 4 行的图标表（格子顺序见 ICON_NAMES），
// css 是额外样式，apply / remove 在选中和换走时调用。
// 别的插件自己画的入口想用皮肤的图标：给元素写上 data-rph-icon="设置" 这样的名字，里面放一个 svg；画好或重画之后调一下 skins.refreshIcons()。
(() => {
    'use strict';

/* @shared/skin-art */

    const SKINS = [
        // 配色取自角色身上：挂绳的钴蓝、眼睛的金、针织衫的炭蓝。
        { id: 'akane', name: '里见茜', note: '永远的7日之都', accent: '#2f55c8', neutral: '#a39c8f', colors: ['#2f55c8', '#c2901c', '#56627f'], art: SKIN_ART.akane, wide: SKIN_WIDE.akane, icons: SKIN_ICONS.akane }
    ];
    const CUSTOM = { id: 'custom', name: '自定义', note: '自选颜色和图片', accent: '#5a6ff0' };
    const COLORS = ['#e0527a', '#e2733a', '#c79a1e', '#3f9d5b', '#1f9d93', '#3f8fd6', '#5a6ff0', '#8b66d9'];
    const RANGE_CLASS = 'compact-range w-full h-1.5 bg-primary-100 rounded-lg appearance-none cursor-pointer accent-primary-500'; // RPH 自己的滑块样式
    const MAX_PHOTOS = 12;
    // 图标表里各格画的是什么，按从左到右、从上到下排；用页面上的文字对应（导航入口、设置页分区、页面标题），一格可以有几个名字。
    const ICON_NAMES = '聊天,角色卡管理,记忆系统,UI模板,用量统计,设置,角色卡生成,小说生成,万相广场,预设|预设管理,世界书,正则|正则脚本,工具,运行日志,图片管理,模块管理,同步,用户设置,API 连接与服务,高级设置,皮肤,角色语音,生图设置,更多'.split(',');
    const ICON_CELL = new Map(ICON_NAMES.flatMap((names, cell) => names.split('|').map((name) => [name, cell])));
    // 这几项各管一块样式，都默认开着；皮肤栏里可以单独关。
    const OPTIONS = [
        ['splash', '显示开屏图'],
        ['backdrop', '页面背景使用皮肤图片'],
        ['chat', '聊天背景使用皮肤图片'],
        ['icons', '使用皮肤图标']
    ];
    const CSS = {
        // 开屏：借官方的开屏层，换成皮肤的图，标志挪到下方；插件没来得及收起时 8 秒后自己消失。图偏暗时用深色底、浅色标志。
        // 横屏时有横版就铺满，没有就把竖图居中放一条、两边淡出。
        splash: `.entry-transition{align-items:flex-end;animation-delay:8s!important;pointer-events:auto}
.entry-transition::before{content:"";position:absolute;inset:0 auto 0 50%;width:min(100%,66.7vh);transform:translateX(-50%) scale(var(--rph-skin-zoom,1));transform-origin:var(--rph-skin-pos,center 20%);background:var(--rph-skin-art) var(--rph-skin-pos,center 20%)/cover no-repeat;opacity:0;transition:opacity .5s ease}
.rph-skin-art .entry-transition::before{opacity:1}
.entry-transition::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,var(--rph-skin-scrim,var(--c-canvas)) 4%,transparent 36%)}
.entry-transition-brand{position:relative;z-index:1;padding-bottom:max(9vh,2rem);color:var(--rph-skin-ink,var(--c-text))}
.entry-transition-book{display:none}
.entry-transition.rph-skin-out{animation:entry-screen-out .6s var(--ease-in-out) both!important;pointer-events:none}
.rph-skin-dark .entry-transition{--rph-skin-scrim:#0e1016;--rph-skin-ink:#f5f5f8;background:#0e1016}
@media (min-aspect-ratio:1/1){.entry-transition::before{-webkit-mask-image:linear-gradient(to right,transparent,#000 16%,#000 84%,transparent);mask-image:linear-gradient(to right,transparent,#000 16%,#000 84%,transparent)}
.rph-skin-wide .entry-transition::before{inset:0;width:auto;transform:scale(var(--rph-skin-wide-zoom,1));transform-origin:var(--rph-skin-wide-pos,var(--rph-skin-side,center) 30%);background-image:var(--rph-skin-wide);background-position:var(--rph-skin-wide-pos,var(--rph-skin-side,center) 30%);-webkit-mask-image:none;mask-image:none}}`,
        backdrop: `.app-main{isolation:isolate}
.app-main::before{content:"";position:absolute;inset:0;z-index:-1;background:var(--rph-skin-art) var(--rph-skin-pos,center 18%)/cover no-repeat;transform:scale(var(--rph-skin-zoom,1));transform-origin:var(--rph-skin-pos,center 18%);opacity:var(--rph-skin-fade,.18);pointer-events:none}
:root[data-app-theme="dark"] .app-main::before{opacity:calc(var(--rph-skin-fade,.18) + .06)}
@media (min-aspect-ratio:1/1){.rph-skin-wide .app-main::before{background-image:var(--rph-skin-wide);background-position:var(--rph-skin-wide-pos,var(--rph-skin-side,center) 30%);transform:scale(var(--rph-skin-wide-zoom,1));transform-origin:var(--rph-skin-wide-pos,var(--rph-skin-side,center) 30%)}}`,
        // 聊天页：官方把背景图模糊了一层（它用的是小头像）；皮肤图够清楚，人物是给人看的，手机和电脑都不模糊。
        chat: `.char-bg-blur{background-image:var(--rph-skin-art)!important;background-position:var(--rph-skin-pos,center 18%)!important;transform:scale(var(--rph-skin-zoom,1));transform-origin:var(--rph-skin-pos,center 18%)}
.rph-skin-art .char-bg-blur{filter:none!important}
@media (min-aspect-ratio:1/1){.rph-skin-wide .char-bg-blur{background-image:var(--rph-skin-wide)!important;background-position:var(--rph-skin-wide-pos,var(--rph-skin-side,center) 30%)!important;transform:scale(var(--rph-skin-wide-zoom,1));transform-origin:var(--rph-skin-wide-pos,var(--rph-skin-side,center) 30%)}}`,
        icons: `[data-rph-skin-icon]{padding:0!important;background:var(--rph-skin-icons) calc(var(--rph-skin-x)*20%) calc(var(--rph-skin-y)*33.3333%)/600% 400% no-repeat!important}
[data-rph-skin-icon]>*{opacity:0}
.app-navigation-icon[data-rph-skin-icon]{width:34px;height:34px;border-radius:0}
.settings-card__title>svg[data-rph-skin-icon]{width:2.5rem;height:2.5rem;border-radius:0}
h2>svg[data-rph-skin-icon]{width:2.125rem;height:2.125rem}`
    };
    const PICKER_CSS = `.rph-skin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(5.5rem,1fr));gap:.75rem;max-width:40rem}
.rph-skin-card{display:flex;flex-direction:column;gap:.375rem;padding:.375rem .375rem .625rem;border:1px solid var(--c-border);border-radius:var(--r-lg);background:var(--c-surface);text-align:left;cursor:pointer;transition:border-color var(--dur-2) var(--ease-out),box-shadow var(--dur-2) var(--ease-out)}
.rph-skin-card:hover{border-color:var(--c-border-strong)}
.rph-skin-card[aria-pressed="true"]{border-color:rgb(var(--primary-500));box-shadow:var(--ring)}
.rph-skin-thumb{aspect-ratio:3/4;border-radius:var(--r-md);background:rgb(var(--gray-100)) center 18%/cover no-repeat}
.rph-skin-name{padding:0 .375rem;color:var(--c-text);font-size:.875rem;font-weight:600}
.rph-skin-note{padding:0 .375rem;color:var(--c-text-3);font-size:.75rem}
.rph-skin-row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-top:1rem}
.rph-skin-dot{position:relative;width:2rem;height:2rem;border:2px solid var(--c-surface);border-radius:999px;box-shadow:0 0 0 1px var(--c-border);cursor:pointer;overflow:hidden}
.rph-skin-dot[aria-pressed="true"]{box-shadow:0 0 0 2px rgb(var(--primary-500))}
.rph-skin-dot input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}
.rph-skin-photo{position:relative;width:3.5rem;aspect-ratio:3/4}
.rph-skin-photo>button{position:absolute;inset:0;border-radius:var(--r-sm);background:center/cover no-repeat}
.rph-skin-photo>button[aria-pressed="true"]{box-shadow:0 0 0 2px rgb(var(--primary-500))}
.rph-skin-photo>button+button{inset:-.375rem -.375rem auto auto;width:1.25rem;height:1.25rem;border-radius:999px;background:var(--c-elevated);color:var(--c-text-2);box-shadow:var(--shadow-1);font-size:.75rem;line-height:1}
.rph-skin-preview{display:grid;gap:.75rem;max-width:40rem;margin-top:1rem}
.rph-skin-preview>div{display:grid;gap:.375rem}
.rph-skin-label{color:var(--c-text-2);font-size:.8125rem}
.rph-skin-frames{display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem}
.rph-skin-preview>div:first-child .rph-skin-frames{max-width:16rem}
.rph-skin-frames figure{display:grid;gap:.25rem;margin:0;color:var(--c-text-3);font-size:.75rem;text-align:center}
.rph-skin-frame{position:relative;display:block;width:100%;padding:0;overflow:hidden;container-type:inline-size;border:1px solid var(--c-border);border-radius:var(--r-md);background:var(--c-canvas);cursor:zoom-in}
.rph-skin-frame[data-device="phone"]{aspect-ratio:390/844}
.rph-skin-frame[data-device="desktop"]{aspect-ratio:1440/900}
.rph-skin-frame-art{position:absolute;inset:0;background:center/cover no-repeat}
.rph-skin-frame[data-kind="page"] .rph-skin-frame-art{opacity:var(--rph-skin-fade,.18)}
.rph-skin-frame-art.rph-skin-frame-column{left:29.15%;right:29.15%;-webkit-mask-image:linear-gradient(to right,transparent,#000 16%,#000 84%,transparent);mask-image:linear-gradient(to right,transparent,#000 16%,#000 84%,transparent)}
.rph-skin-frame i{position:absolute;border-radius:3cqw;background:var(--c-surface);opacity:.92}
.rph-skin-frame[data-device="desktop"] i{border-radius:.8cqw}
.rph-skin-frame[data-kind="splash"]::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,var(--c-canvas) 4%,transparent 36%)}
.rph-skin-frame[data-kind="splash"][data-dark]{background:#0e1016}
.rph-skin-frame[data-kind="splash"][data-dark]::after{background:linear-gradient(to top,#0e1016 4%,transparent 36%)}
.rph-skin-frame b{position:absolute;z-index:1;inset:auto 0 9%;color:var(--c-text);font:700 9cqw/1 Georgia,serif;text-align:center}
.rph-skin-frame[data-device="desktop"] b{font-size:2.6cqw}
.rph-skin-frame[data-dark] b{color:#f5f5f8}
.rph-skin-frame b span{margin-left:.2em;color:rgb(var(--primary-500));font:600 .62em/1 sans-serif;letter-spacing:.12em}
.rph-skin-viewer{display:grid;gap:.75rem}
.rph-skin-viewer .rph-skin-row{margin-top:0}
.rph-skin-viewer .rph-skin-row:last-child>span{flex:1}
.rph-skin-tab{padding:.25rem .75rem;border:1px solid var(--c-border);border-radius:999px;background:var(--c-surface);color:var(--c-text-2);font-size:.8125rem}
.rph-skin-tab[aria-pressed="true"]{border-color:transparent;background:rgb(var(--primary-500));color:#fff}
.rph-skin-viewer .rph-skin-frame{justify-self:center;cursor:grab;touch-action:none}
.rph-skin-viewer .rph-skin-frame[data-device="phone"]{width:calc(min(62vh,40rem)*390/844)}
.rph-skin-viewer .rph-skin-frame[data-device="desktop"]{width:min(100%,calc(62vh*1.6))}
.rph-skin-viewer .rph-skin-slider{justify-self:center;width:min(100%,24rem);margin:0}
.rph-skin-slider{max-width:24rem;margin:1rem 0 0;color:var(--c-text-2);font-size:.8125rem}
.rph-skin-shop{max-width:40rem;margin-top:1.5rem}
.rph-skin-shop-title{margin-bottom:.25rem;color:var(--c-text);font-size:.875rem;font-weight:600}
.rph-skin-shop-item{display:flex;align-items:center;gap:.75rem;padding:.5rem 0;border-top:1px solid var(--c-border-soft)}
.rph-skin-shop-cover{flex:none;width:2.5rem;aspect-ratio:3/4;border-radius:var(--r-sm);background:rgb(var(--gray-100)) center 18%/cover no-repeat}
.rph-skin-shop-item>span:nth-child(2){display:grid;flex:1;min-width:0}
.rph-skin-shop-item .rph-skin-name,.rph-skin-shop-item .rph-skin-note{padding:0}`;

    let ctx = null;
    let style = null;
    let applied = null;
    let palette = '';
    let photos = [];
    let spots = []; // 自己上传的图调过的位置，和 photos 一一对应：[横, 竖, 缩放]（都是百分比），没调过是空
    let shown = null; // 现在页面上用的是哪张图：{ url, wide }
    let selected = 0; // 皮肤栏里正在预览第几张自己的图
    const measured = new Map();
    const extra = [];
    const pickers = new Set();
    const root = document.documentElement;

    // ---- 颜色换算：换色相和浓淡，人眼看到的明暗保持和原色一样 ----
    const linear = (value) => { const v = value / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const luminance = ([r, g, b]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    const hexToRgb = (hex) => [1, 3, 5].map((index) => parseInt(String(hex).slice(index, index + 2), 16) || 0);
    function toHsl(color) {
        const [r, g, b] = color.map((value) => value / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
        const hue = !delta ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
        const light = (max + min) / 2;
        return [(hue * 60 + 360) % 360, delta ? delta / (1 - Math.abs(2 * light - 1)) : 0, light];
    }
    function toRgb(hue, saturation, light) {
        const chroma = (1 - Math.abs(2 * light - 1)) * saturation;
        const channel = (offset) => {
            const k = (offset + hue / 30) % 12;
            return Math.round(255 * (light - chroma / 2 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
        };
        return [channel(0), channel(8), channel(4)];
    }
    function recolor(color, hue, saturation) {
        const target = luminance(color);
        let low = 0, high = 1;
        for (let step = 0; step < 16; step += 1) {
            const middle = (low + high) / 2;
            if (luminance(toRgb(hue, saturation, middle)) < target) low = middle; else high = middle;
        }
        return toRgb(hue, saturation, (low + high) / 2);
    }

    // 角色卡生成页（DaisyUI）的颜色写成「亮度% 彩度 色相」，数值就是官方配色里的这几档。
    const DAISY = {
        light: { p: 'primary-600', n: 'gray-800', nc: 'gray-100', b1: 'surface', b2: 'gray-100', b3: 'gray-200', bc: 'gray-900' },
        dark: { p: 'primary-500', n: 'c-elevated', nc: 'gray-800', b1: 'surface', b2: 'gray-100', b3: 'gray-200', bc: 'gray-800' }
    };
    function toOklch(color) {
        const [r, g, b] = color.map(linear);
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        const green = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
        const blue = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
        return `${(100 * (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s)).toFixed(2)}% ${Math.hypot(green, blue).toFixed(4)} ${((Math.atan2(blue, green) * 180 / Math.PI + 360) % 360).toFixed(2)}`;
    }

    // 官方 theme.css 里浅色、深色两套颜色变量。
    function officialRules() {
        const found = {};
        for (const sheet of document.styleSheets) {
            if (sheet.ownerNode?.dataset?.rphWorkshopStyle) continue;
            let rules = [];
            try { rules = sheet.cssRules; } catch (_) { /* 别的网站的样式表读不了 */ }
            for (const rule of rules) {
                const theme = rule.selectorText === ':root' ? 'light' : rule.selectorText === ':root[data-app-theme="dark"]' ? 'dark' : '';
                if (theme && !found[theme] && rule.style.getPropertyValue('--primary-600')) found[theme] = rule;
            }
        }
        return Object.entries(found);
    }

    function paletteCss({ accent, neutral, tint = 100 }) {
        const [accentHue, accentSaturation] = toHsl(hexToRgb(accent));
        const [neutralHue, neutralBase] = neutral ? toHsl(hexToRgb(neutral)) : [accentHue, 0.1];
        const neutralSaturation = Math.min(1, neutralBase * tint / 100);
        return officialRules().map(([theme, rule]) => {
            const colors = {};
            let css = '';
            for (const name of rule.style) {
                const isAccent = /^--primary-(text-)?\d+$/.test(name);
                if (!isAccent && !/^--((gray|stone)-(fill-)?\d+|surface|surface-edge|c-elevated|glass-bg|glass-bg-strong)$/.test(name)) continue;
                css += `${name}:${rule.style.getPropertyValue(name).trim().replace(/(\d+)([ ,]+)(\d+)([ ,]+)(\d+)/, (match, r, gap1, g, gap2, b) => {
                    const color = [+r, +g, +b];
                    const [red, green, blue] = colors[name.slice(2)] = isAccent ? recolor(color, accentHue, Math.min(1, toHsl(color)[1] * accentSaturation / 0.83))
                        : recolor(color, neutralHue, neutralSaturation);
                    return red + gap1 + green + gap2 + blue;
                })};`;
            }
            const daisy = Object.entries(DAISY[theme]).map(([token, step]) => (colors[step] ? `--${token}:${toOklch(colors[step])};` : '')).join('');
            return `${rule.selectorText}{${css}}\n${rule.selectorText}[data-theme]{${daisy}}`;
        }).join('\n');
    }

    // ---- 当前皮肤 ----
    const setting = (key, fallback = '') => ctx.storage.get(key) ?? fallback;
    const allSkins = () => [...SKINS, ...extra];
    const artOf = (skin) => [].concat(skin?.art || []);
    // 用户对某套皮肤的调节：{ accent 主题色, tint 底色饱和度（百分比，100 是原样）, fade 背景图的不透明度（百分比，界面上显示成透明度） }，按皮肤分别记。
    function tunes() {
        try { return JSON.parse(setting('tune', '{}')) || {}; } catch (_) { return {}; }
    }
    function tune(id, change, redraw = true) {
        const all = tunes();
        if (change) all[id] = { ...all[id], ...change }; else delete all[id];
        ctx.storage.set('tune', JSON.stringify(all));
        apply();
        if (redraw) refresh();
    }
    function currentSkin() {
        const id = setting('active');
        const wides = photos.filter((photo) => photo.endsWith('#wide'));
        const talls = photos.filter((photo) => !photo.endsWith('#wide'));
        const skin = id === 'custom' ? { ...CUSTOM, art: talls.length ? talls : wides, wide: wides } : allSkins().find((item) => item.id === id);
        return skin ? { ...skin, ...tunes()[id] } : null;
    }
    const call = (callback) => { try { callback?.(); } catch (error) { ctx.log('皮肤回调出错', error); } };

    function apply() {
        const id = setting('active');
        const skin = currentSkin();
        // 选中的皮肤来自还没加载的插件：先留着上次的样式，等它登记。
        if (id && !skin) return;
        if (applied && applied.id !== id) call(applied.remove);
        palette = skin ? paletteCss(skin) : '';
        const has = { splash: artOf(skin).length, backdrop: artOf(skin).length, chat: artOf(skin).length, icons: skin?.icons };
        const fade = Number.isFinite(skin?.fade) ? `:root{--rph-skin-fade:${skin.fade / 100}}` : '';
        style.set(skin ? [palette, ...OPTIONS.map(([key]) => (has[key] && setting(key) !== 'off' ? CSS[key] : '')), fade, skin.css || ''].join('\n') : '');
        paintFrames();
        if (applied?.id !== id) showArt(skin);
        if (skin?.icons) root.style.setProperty('--rph-skin-icons', `url("${skin.icons}")`); else root.style.removeProperty('--rph-skin-icons');
        tagIcons();
        if (skin && applied?.id !== id) call(skin.apply);
        applied = skin || { id };
    }

    // 角色卡生成、小说这两个内嵌页面用的是同一份 theme.css，把配色也送进去。
    function paintFrames(frames = document.querySelectorAll('iframe')) {
        for (const frame of frames) {
            if (!/\/(character|novel)\/index\.html/.test(frame.src)) continue;
            const page = frame.contentDocument;
            if (!page?.head) continue;
            const node = page.getElementById('rph-skin') || page.head.appendChild(Object.assign(page.createElement('style'), { id: 'rph-skin' }));
            node.textContent = palette;
        }
    }

    // 这次用皮肤的哪张图：带了几张就随机挑一张，当开屏图和页面背景；图偏暗时开屏用深色底、浅色标志。
    // 竖图给竖屏（手机），横图给横屏（电脑）：横图和竖图一样多就是一一对应的同一幅画，挑同一对；不一样多（自己放的图）就各挑各的。
    // 横版地址末尾的 #left / #right 是人物在哪边，图就按那一边对齐。
    function showArt(skin) {
        const list = artOf(skin);
        const wides = [].concat(skin?.wide || []);
        const index = Math.floor(Math.random() * list.length);
        const url = list[index];
        const wide = wides.length === list.length ? wides[index] : wides[Math.floor(Math.random() * wides.length)];
        root.classList.remove('rph-skin-art', 'rph-skin-dark', 'rph-skin-wide');
        root.style.removeProperty('--rph-skin-art');
        root.style.removeProperty('--rph-skin-wide');
        root.style.removeProperty('--rph-skin-side');
        const current = shown = url ? { url, wide } : null;
        placeArt();
        if (!url) return;
        measure(url).then((info) => {
            if (!info || shown !== current) return;
            root.style.setProperty('--rph-skin-art', `url("${url}")`);
            if (wide) {
                root.style.setProperty('--rph-skin-wide', `url("${wide}")`);
                root.style.setProperty('--rph-skin-side', /#(left|right)$/.exec(wide)?.[1] || 'center');
            }
            root.classList.add('rph-skin-art');
            root.classList.toggle('rph-skin-wide', !!wide);
            root.classList.toggle('rph-skin-dark', info.dark);
        });
    }

    // 图的原始尺寸和明暗（图偏暗时开屏用深色底），按地址记下来。
    function measure(url) {
        if (!measured.has(url)) measured.set(url, new Promise((resolve) => {
            const image = new Image();
            image.onload = () => {
                const canvas = Object.assign(document.createElement('canvas'), { width: 8, height: 12 });
                const context = canvas.getContext('2d');
                context.drawImage(image, 0, 0, 8, 12);
                const pixels = context.getImageData(0, 0, 8, 12).data;
                let light = 0;
                for (let index = 0; index < pixels.length; index += 4) light += luminance([pixels[index], pixels[index + 1], pixels[index + 2]]);
                resolve({ width: image.naturalWidth, height: image.naturalHeight, dark: light / 96 < 0.2 });
            };
            image.onerror = () => resolve(null);
            image.src = url;
        }));
        return measured.get(url);
    }

    // 自己上传的图调过位置的，页面上正在用它时把位置放上去；皮肤包的图不在 photos 里，照旧。
    const spotOf = (url) => spots[photos.indexOf(url)];
    function placeArt() {
        for (const [name, url] of [['--rph-skin', shown?.url], ['--rph-skin-wide', shown?.wide]]) {
            const spot = url && spotOf(url);
            if (spot) {
                root.style.setProperty(`${name}-pos`, `${spot[0]}% ${spot[1]}%`);
                root.style.setProperty(`${name}-zoom`, String((spot[2] || 100) / 100));
            } else {
                root.style.removeProperty(`${name}-pos`);
                root.style.removeProperty(`${name}-zoom`);
            }
        }
    }

    // 给导航入口、设置页分区、页面标题的图标标上它在图标表里的位置；皮肤没有图标表或关了图标时把标记去掉。
    function tagIcons() {
        const on = !!currentSkin()?.icons && setting('icons') !== 'off';
        for (const label of document.querySelectorAll('.app-navigation-item, .settings-card__title, .management-page-heading h2, [data-rph-icon]')) {
            const icon = label.querySelector('.app-navigation-icon, svg');
            const cell = on ? ICON_CELL.get(label.dataset.rphIcon || label.textContent.trim()) : undefined;
            if (!icon) continue;
            if (cell === undefined) { icon.removeAttribute('data-rph-skin-icon'); continue; }
            icon.dataset.rphSkinIcon = '';
            icon.style.setProperty('--rph-skin-x', cell % 6);
            icon.style.setProperty('--rph-skin-y', Math.floor(cell / 6));
        }
    }

    // ---- 皮肤工坊：分发端上的皮肤包。下载后存在插件数据里（跟着云同步走），打开页面时读出来 ----
    const MIRROR = (typeof globalThis.RPH_R2_MIRROR_BASE === 'string' ? globalThis.RPH_R2_MIRROR_BASE : 'https://update.rph.mornye.uk').replace(/\/+$/, '');
    const IMAGE = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}(#(?:left|right))?$/;
    const HEX = /^#[0-9a-f]{6}$/i;
    let catalog = null;             // 皮肤工坊的目录：null 是还没读，'' 是读不到
    let catalogLoading = null;
    const busy = new Set();         // 正在下载的皮肤
    const downloaded = () => { try { return JSON.parse(setting('downloaded', '[]')) || []; } catch (_) { return []; } };

    // 皮肤包里只认图和颜色，别的一概不要。
    function fromPackage(pack) {
        const images = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string' && IMAGE.test(item)) : []);
        if (!/^[a-z0-9-]{3,32}$/.test(pack?.id || '') || pack.id === 'custom' || typeof pack.name !== 'string' || !HEX.test(pack.accent || '') || !images(pack.art).length) throw new Error('皮肤包格式不正确');
        return {
            id: pack.id, version: String(pack.version || ''), name: pack.name.slice(0, 20), note: typeof pack.note === 'string' ? pack.note.slice(0, 40) : '',
            accent: pack.accent, neutral: HEX.test(pack.neutral || '') ? pack.neutral : undefined,
            colors: Array.isArray(pack.colors) ? pack.colors.filter((color) => HEX.test(color)).slice(0, 8) : undefined,
            art: images(pack.art), wide: images(pack.wide), icons: IMAGE.test(pack.icons || '') ? pack.icons : undefined, workshop: true
        };
    }

    function keep(skin) {
        const index = extra.findIndex((item) => item.id === skin.id);
        if (index >= 0) extra.splice(index, 1, skin); else extra.push(skin);
    }

    function loadCatalog() {
        catalogLoading ||= fetch(`${MIRROR}/workshop/skins/index.json`, { credentials: 'omit', signal: AbortSignal.timeout(15000) })
            .then((response) => (response.ok ? response.json() : { skins: [] }))
            .then((value) => { catalog = Array.isArray(value?.skins) ? value.skins : []; })
            .catch(() => { catalog = ''; catalogLoading = null; })
            .finally(refresh);
        return catalogLoading;
    }

    // 下载（或更新）一套皮肤：按目录里的指纹核对，存进插件数据。activate 为真时下载完就换上。
    async function download(item, activate) {
        if (busy.has(item.id)) return;
        busy.add(item.id);
        refresh();
        try {
            const response = await fetch(MIRROR + item.file.path, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(60000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = await response.arrayBuffer();
            const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
            if (digest !== item.file.sha256) throw new Error('文件校验失败，请稍后重试');
            const skin = fromPackage(JSON.parse(new TextDecoder().decode(bytes)));
            await ctx.data.set(`skin:${skin.id}`, skin);
            ctx.storage.set('downloaded', JSON.stringify([...downloaded().filter((id) => id !== skin.id), skin.id]));
            keep(skin);
            // 正在用的这套更新了：重新挑图。
            if (activate || setting('active') === skin.id) { applied = null; select(skin.id); }
        } catch (error) {
            ctx.ui.toast(`下载失败：${error.message}`);
        } finally {
            busy.delete(item.id);
            refresh();
        }
    }

    async function forget(id) {
        await ctx.data.remove(`skin:${id}`);
        ctx.storage.set('downloaded', JSON.stringify(downloaded().filter((other) => other !== id)));
        extra.splice(extra.findIndex((item) => item.id === id), 1);
        if (setting('active') === id) select(''); else refresh();
    }

    // 正在用的皮肤这台设备上没有（比如以前自带、现在挪进皮肤工坊的谬因、莫宁）：皮肤工坊里有就自动下回来，配色在这之前照旧。
    function restoreActive() {
        const id = setting('active');
        if (!MIRROR || !id || id === 'custom' || currentSkin()) return;
        loadCatalog().then(() => {
            const item = catalog && catalog.find((entry) => entry.id === setting('active'));
            if (item && !currentSkin()) download(item, false);
        });
    }

    // 「自定义」导出成皮肤包：一个 .json 文件，到分发端「投稿皮肤」上传；名字和 id 在投稿页改。
    function exportCustom() {
        const skin = currentSkin();
        const strip = (url) => url.replace(/#wide$/, '');
        const side = (url) => { const x = spotOf(url)?.[0]; return x <= 25 ? '#left' : x >= 75 ? '#right' : ''; };
        const pack = { schema: 1, id: 'my-skin', version: '1.0.0', name: '我的皮肤', note: '', accent: skin.accent, art: skin.art.slice(0, 4).map(strip), wide: skin.wide.slice(0, 4).map((url) => strip(url) + side(url)) };
        const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([JSON.stringify(pack)], { type: 'application/json' })), download: 'my-skin.json' });
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        ctx.ui.toast('已导出皮肤包，可以到分发站投稿分享', { kind: 'info' });
    }

    function select(id) {
        ctx.storage.set('active', id);
        apply();
        refresh();
    }

    const leaveSplash = () => document.querySelector('.entry-transition')?.classList.add('rph-skin-out');

    function start(context) {
        if (ctx) return;
        ctx = context;
        style = ctx.ui.addStyle(null, { early: true });
        document.querySelector('.entry-transition')?.addEventListener('click', leaveSplash);
        document.addEventListener('load', (event) => { if (event.target.tagName === 'IFRAME') paintFrames([event.target]); }, true);
        // 上次的配色已经由加载器在第一帧放好了；这里读出自己放的图和下载过的皮肤，再按现在的官方配色重算一遍。
        const read = (key) => ctx.data.get(key).catch((error) => { ctx.log(`${key} 读取失败`, error); return null; });
        Promise.all([read('photos'), read('photo-spots'), ...downloaded().map((id) => read(`skin:${id}`))]).then(([saved, savedSpots, ...packs]) => {
            if (Array.isArray(saved)) photos = saved;
            if (Array.isArray(savedSpots)) spots = savedSpots;
            for (const pack of packs) {
                try { keep(fromPackage(pack)); } catch (_) { /* 读坏了的包跳过，皮肤工坊里能重新下载 */ }
            }
            apply();
            refresh();
            restoreActive();
        });
    }

    // ---- 皮肤栏 ----
    const element = (tag, className, text) => Object.assign(document.createElement(tag), { className: className || '', textContent: text || '' });
    function refresh() {
        for (const body of pickers) {
            if (body.isConnected) renderPicker(body); else pickers.delete(body);
        }
    }

    async function addPhotos(files) {
        const first = photos.length;
        for (const file of [...files].slice(0, MAX_PHOTOS - photos.length)) {
            const bitmap = await createImageBitmap(file);
            const scale = Math.min(1, 1440 / Math.max(bitmap.width, bitmap.height));
            const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
            canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            // 横图在地址末尾记一个 #wide（图片地址里 # 后面的部分不影响显示），选图时靠它分横竖。
            photos.push(canvas.toDataURL('image/jpeg', 0.85) + (canvas.width > canvas.height ? '#wide' : ''));
        }
        selected = Math.min(first, photos.length - 1);
        await savePhotos();
    }

    async function savePhotos() {
        await ctx.data.set('photos', photos);
        await ctx.data.set('photo-spots', spots);
        applied = null;
        apply();
        refresh();
    }

    function renderPicker(body) {
        pickers.add(body);
        const active = setting('active');
        const skin = currentSkin();
        const saved = tunes();
        const grid = element('div', 'rph-skin-grid');
        const card = (id, name, note, art, color) => {
            const button = element('button', 'rph-skin-card');
            button.type = 'button';
            button.dataset.skin = id;
            button.setAttribute('aria-pressed', String(active === id));
            const thumb = element('span', 'rph-skin-thumb');
            if (art) thumb.style.backgroundImage = `url("${art}")`; else thumb.style.background = color;
            button.append(thumb, element('span', 'rph-skin-name', name), element('span', 'rph-skin-note', note));
            button.addEventListener('click', () => select(id));
            grid.appendChild(button);
        };
        card('', '默认', '官方配色', '', 'linear-gradient(160deg,#e3e9ff,#f7f7f9 55%,#dcefeb)');
        for (const item of [...allSkins(), CUSTOM]) {
            card(item.id, item.name, item.note || '', item === CUSTOM ? photos[0] : artOf(item)[0], saved[item.id]?.accent || item.accent);
        }
        body.replaceChildren(grid);

        if (skin) {
            // 当前这套皮肤的调节：主题色（它自己的几个颜色排前面，后面是通用色和自选）、底色饱和度、背景图透明度。
            const own = active === 'custom' ? CUSTOM : allSkins().find((item) => item.id === active);
            const choices = [...new Set([...(own.colors || [own.accent]), ...COLORS])];
            const colors = element('div', 'rph-skin-row');
            for (const color of choices) {
                const dot = element('button', 'rph-skin-dot');
                dot.type = 'button';
                dot.title = color;
                dot.style.background = color;
                dot.setAttribute('aria-pressed', String(skin.accent === color));
                dot.addEventListener('click', () => tune(active, { accent: color }));
                colors.appendChild(dot);
            }
            const other = element('label', 'rph-skin-dot');
            other.title = '自定义颜色';
            other.style.background = choices.includes(skin.accent) ? 'conic-gradient(#e0527a,#c79a1e,#3f9d5b,#3f8fd6,#8b66d9,#e0527a)' : skin.accent;
            other.setAttribute('aria-pressed', String(!choices.includes(skin.accent)));
            const input = Object.assign(element('input'), { type: 'color', value: skin.accent });
            input.addEventListener('change', () => tune(active, { accent: input.value }));
            other.appendChild(input);
            colors.appendChild(other);
            body.appendChild(colors);

            const slider = (key, label, min, max, value, store = (shown) => shown) => {
                const field = element('label', 'rph-ui-field rph-skin-slider');
                const range = Object.assign(element('input', RANGE_CLASS), { type: 'range', min, max, step: 1, value });
                range.dataset.tune = key;
                // 拖动时只换样式、不重画皮肤栏，不然手里的滑块会被换掉。
                range.addEventListener('input', () => tune(active, { [key]: store(Number(range.value)) }, false));
                field.append(element('span', '', label), range);
                body.appendChild(field);
            };
            slider('tint', '底色饱和度', 0, 200, skin.tint ?? 100);
            // 透明度越高图越淡；存的是图的不透明度（百分比）。
            if (artOf(skin).length) slider('fade', '背景图透明度', 40, 100, 100 - (skin.fade ?? 18), (shown) => 100 - shown);

            if (active === 'custom') {
                const gallery = element('div', 'rph-skin-row');
                photos.forEach((photo, index) => {
                    const item = element('div', 'rph-skin-photo');
                    const pick = element('button');
                    pick.type = 'button';
                    pick.style.backgroundImage = `url("${photo}")`;
                    pick.setAttribute('aria-label', `预览第 ${index + 1} 张`);
                    pick.setAttribute('aria-pressed', String(index === selected));
                    pick.addEventListener('click', () => { selected = index; refresh(); });
                    const remove = element('button', '', '×');
                    remove.type = 'button';
                    remove.setAttribute('aria-label', '删除图片');
                    remove.addEventListener('click', () => {
                        measured.delete(photos[index]);
                        photos.splice(index, 1);
                        spots.splice(index, 1);
                        if (selected > index || selected >= photos.length) selected = Math.max(0, selected - 1);
                        savePhotos();
                    });
                    item.append(pick, remove);
                    gallery.appendChild(item);
                });
                const file = Object.assign(element('input'), { type: 'file', accept: 'image/*', multiple: true, hidden: true });
                file.addEventListener('change', () => addPhotos(file.files).catch((error) => ctx.ui.toast(`图片上传失败：${error.message}`)));
                const add = window.RPHubUI.button('上传图片');
                add.disabled = photos.length >= MAX_PHOTOS;
                add.addEventListener('click', () => file.click());
                gallery.append(add, file);
                if (photos.length) {
                    const share = window.RPHubUI.button('导出皮肤包');
                    share.dataset.export = '';
                    share.addEventListener('click', exportCustom);
                    gallery.appendChild(share);
                }
                body.appendChild(gallery);
                if (photos.length) renderPreview(body);
            }
            if (saved[active]) {
                const reset = window.RPHubUI.button('恢复默认');
                reset.dataset.reset = '';
                reset.addEventListener('click', () => tune(active, null));
                const row = element('div', 'rph-skin-row');
                row.appendChild(reset);
                body.appendChild(row);
            }
        }

        for (const [key, text] of OPTIONS) {
            const toggle = element('label', 'rph-ui-check rph-skin-row');
            const checkbox = Object.assign(element('input', 'settings-toggle-input sr-only'), { type: 'checkbox', checked: setting(key) !== 'off' });
            checkbox.dataset.option = key;
            checkbox.addEventListener('change', () => { ctx.storage.set(key, checkbox.checked ? 'on' : 'off'); apply(); });
            toggle.append(checkbox, element('span', 'settings-toggle'), document.createTextNode(text));
            body.appendChild(toggle);
        }
        if (MIRROR) renderShop(body);
    }

    // ---- 预览：选中的那张图在手机、电脑上开屏、页面、聊天里的样子，点开放大，放大后拖动调整位置 ----
    const DEVICES = { phone: '手机', desktop: '电脑' };
    const KINDS = { splash: '开屏', page: '页面', chat: '聊天' };
    // 示意里的界面块，按真实页面量的（手机 390×844、电脑 1440×900），单位是页面宽度的百分比：[左, 上, 宽, 高]，负数从右边、底边算。
    const BLOCKS = {
        phone: { page: [[5, 4, 48, 8], [5, 20, 90, 50], [5, 76, 90, 90]], chat: [[13, 22, 22, 11], [-13, 53, 33, 12], [13, 85, 84, 19], [2, -2, 96, 26]] },
        desktop: { page: [[2.5, 1.4, 14, 3], [30, 7, 40, 18], [30, 27, 40, 26]], chat: [[28, 7, 6.4, 3], [-28, 15.5, 9.8, 3.5], [28, 25, 38.6, 3.2], [32.2, -0.8, 35.6, 6.9]] }
    };
    const isWide = (photo) => photo.endsWith('#wide');
    // 手机用竖图（一张竖图都没有才用横图），电脑用横图（一张横图都没有才用竖图）。
    function devicesOf(photo) {
        const tall = photos.some((item) => !isWide(item));
        const wide = photos.some(isWide);
        return Object.keys(DEVICES).filter((device) => (device === 'phone' ? !isWide(photo) || !tall : isWide(photo) || !wide));
    }
    // 没调过位置时各处原来的位置：电脑上的横图 center 30%，竖图开屏 center 20%、页面和聊天 center 18%。
    const startSpot = (photo, device, kind) => [50, device === 'desktop' && isWide(photo) ? 30 : kind === 'splash' ? 20 : 18, 100];
    // 位置和缩放：以调好的点为中心放大，和页面上一样。
    const place = (art, spot) => {
        art.style.backgroundPosition = art.style.transformOrigin = `${spot[0]}% ${spot[1]}%`;
        art.style.transform = `scale(${(spot[2] || 100) / 100})`;
    };

    function frame(index, device, kind) {
        const photo = photos[index];
        const node = element('button', 'rph-skin-frame');
        node.type = 'button';
        Object.assign(node.dataset, { device, kind });
        node.setAttribute('aria-label', DEVICES[device] + KINDS[kind]);
        // 电脑上没有横图时，开屏把竖图居中放一条、两边淡出。
        const art = element('span', 'rph-skin-frame-art' + (device === 'desktop' && kind === 'splash' && !isWide(photo) ? ' rph-skin-frame-column' : ''));
        const spot = spots[index] || startSpot(photo, device, kind);
        art.style.backgroundImage = `url("${photo}")`;
        place(art, spot);
        node.appendChild(art);
        for (const [left, top, width, height] of BLOCKS[device][kind] || []) {
            const block = element('i');
            block.style.cssText = `${left < 0 ? 'right' : 'left'}:${Math.abs(left)}cqw;${top < 0 ? 'bottom' : 'top'}:${Math.abs(top)}cqw;width:${width}cqw;height:${height}cqw`;
            node.appendChild(block);
        }
        if (kind === 'splash') {
            node.appendChild(element('b', '', 'RP')).appendChild(element('span', '', 'HUB'));
            measure(photo).then((info) => { if (info?.dark) node.dataset.dark = ''; });
        }
        return node;
    }

    function renderPreview(body) {
        selected = Math.min(selected, photos.length - 1);
        const photo = photos[selected];
        const devices = devicesOf(photo);
        const box = element('div', 'rph-skin-preview');
        for (const device of Object.keys(DEVICES)) {
            const group = element('div');
            group.appendChild(element('span', 'rph-skin-label', DEVICES[device]));
            if (devices.includes(device)) {
                const frames = element('div', 'rph-skin-frames');
                for (const kind of Object.keys(KINDS)) {
                    const figure = element('figure');
                    const node = frame(selected, device, kind);
                    node.addEventListener('click', () => openViewer(selected, device, kind));
                    figure.append(node, element('figcaption', '', KINDS[kind]));
                    frames.appendChild(figure);
                }
                group.appendChild(frames);
            } else {
                group.appendChild(element('span', 'rph-skin-note', device === 'phone' ? '手机上显示竖图。' : '电脑上显示横图。'));
            }
            box.appendChild(group);
        }
        body.appendChild(box);
    }

    function openViewer(index, device, kind) {
        window.RPHubUI.openModal({ title: '预览', size: 'min(96vw, 64rem)', render(body, modal) {
            body.classList.add('rph-skin-viewer');
            const draw = () => {
                const photo = photos[index];
                if (!photo) return modal.close();
                const devices = devicesOf(photo);
                if (!devices.includes(device)) device = devices[0];
                const tabs = element('div', 'rph-skin-row');
                const tab = (label, pressed, choose) => {
                    const button = element('button', 'rph-skin-tab', label);
                    button.type = 'button';
                    button.setAttribute('aria-pressed', String(pressed));
                    button.addEventListener('click', () => { choose(); draw(); });
                    tabs.appendChild(button);
                };
                if (devices.length > 1) for (const item of devices) tab(DEVICES[item], item === device, () => { device = item; });
                for (const item of Object.keys(KINDS)) tab(KINDS[item], item === kind, () => { kind = item; });
                const node = frame(index, device, kind);
                const start = startSpot(photo, device, kind);
                measure(photo).then((info) => info && drag(node, index, info, start, draw));
                const zoom = Object.assign(element('input', RANGE_CLASS), { type: 'range', min: 100, max: 300, step: 5, value: spots[index]?.[2] || 100 });
                zoom.addEventListener('input', () => {
                    const spot = spots[index] || start;
                    spots[index] = [spot[0], spot[1], Number(zoom.value)];
                    place(node.firstChild, spots[index]);
                });
                zoom.addEventListener('change', () => { saveSpots(); draw(); });
                const field = element('label', 'rph-ui-field rph-skin-slider');
                field.append(element('span', '', '缩放'), zoom);
                const actions = element('div', 'rph-skin-row');
                actions.appendChild(element('span', 'rph-skin-note', '拖动图片调整位置'));
                if (spots[index]) {
                    const reset = window.RPHubUI.button('恢复默认');
                    reset.addEventListener('click', () => { spots[index] = null; saveSpots(); draw(); });
                    actions.appendChild(reset);
                }
                const done = window.RPHubUI.button('完成', 'primary');
                done.addEventListener('click', () => modal.close());
                actions.appendChild(done);
                body.replaceChildren(tabs, node, field, actions);
            };
            draw();
        } });
    }

    // 拖动：按图盖满画面（再乘上缩放）时多出来的那部分换算成百分比；松手后存下，开屏、页面、聊天都用这个位置。
    function drag(node, index, info, start, done) {
        const art = node.firstChild;
        node.addEventListener('pointerdown', (event) => {
            const from = spots[index] || start;
            const [width, height] = [art.offsetWidth, art.offsetHeight];
            const scale = Math.max(width / info.width, height / info.height) * (from[2] || 100) / 100;
            const room = [info.width * scale - width, info.height * scale - height];
            let moved = false;
            node.setPointerCapture(event.pointerId);
            const move = (next) => {
                const delta = [next.clientX - event.clientX, next.clientY - event.clientY];
                const spot = [0, 1].map((axis) => (room[axis] < 1 ? from[axis] : Math.round(Math.min(100, Math.max(0, from[axis] - delta[axis] / room[axis] * 100)))));
                if (spot[0] === from[0] && spot[1] === from[1]) return;
                moved = true;
                spots[index] = [...spot, from[2] || 100];
                place(art, spots[index]);
            };
            const end = () => {
                node.removeEventListener('pointermove', move);
                node.removeEventListener('pointerup', end);
                node.removeEventListener('pointercancel', end);
                if (moved) { saveSpots(); done(); }
            };
            node.addEventListener('pointermove', move);
            node.addEventListener('pointerup', end);
            node.addEventListener('pointercancel', end);
        });
    }

    function saveSpots() {
        ctx.data.set('photo-spots', spots).catch((error) => ctx.log('图片位置保存失败', error));
        placeArt();
        refresh();
    }

    // 皮肤工坊：能下载的皮肤一行一个；下载过的可以更新、删除（删了还能再下）。皮肤工坊里下架了的也列在这，方便删掉。
    function renderShop(body) {
        const shop = element('div', 'rph-skin-shop');
        shop.dataset.skinShop = '';
        shop.appendChild(element('div', 'rph-skin-shop-title', '皮肤工坊'));
        body.appendChild(shop);
        if (catalog === null) { loadCatalog(); shop.appendChild(element('span', 'rph-skin-note', '加载中…')); return; }
        if (catalog === '') {
            const retry = window.RPHubUI.button('加载失败，点击重试');
            retry.addEventListener('click', () => { catalog = null; refresh(); });
            shop.appendChild(retry);
            return;
        }
        const gone = extra.filter((skin) => skin.workshop && !catalog.some((item) => item.id === skin.id));
        if (!catalog.length && !gone.length) shop.appendChild(element('span', 'rph-skin-note', '暂无皮肤'));
        for (const item of [...catalog, ...gone]) {
            const have = extra.find((skin) => skin.workshop && skin.id === item.id);
            const fresh = have && (!item.file || have.version === item.version);
            const row = element('div', 'rph-skin-shop-item');
            row.dataset.shopSkin = item.id;
            const cover = element('span', 'rph-skin-shop-cover');
            cover.style.backgroundImage = `url("${item.cover ? MIRROR + item.cover.path : item.art[0]}")`;
            const info = element('span');
            const size = item.file ? `${Math.max(1, Math.round(item.file.size / 1024))} KB` : '已下架';
            info.append(element('span', 'rph-skin-name', item.name), element('span', 'rph-skin-note', [item.note, item.author, size].filter(Boolean).join(' · ')));
            const action = window.RPHubUI.button(busy.has(item.id) ? '下载中…' : fresh ? '删除' : have ? '更新' : '下载', fresh ? 'secondary' : 'primary');
            action.disabled = busy.has(item.id);
            action.addEventListener('click', () => (fresh ? forget(item.id) : download(item, !have)));
            row.append(cover, info, action);
            shop.appendChild(row);
        }
    }

    RPHubSDK.register({
        id: 'skins', name: '皮肤', version: '1.3.1', requiresApi: 10,
        beforeMount({ ctx: context }) {
            start(context);
            // 页面挂上后就收起开屏，至少显示 1.6 秒，不用等插件全部就绪。
            setTimeout(leaveSplash, Math.max(400, 1600 - performance.now()));
        },
        init(context) {
            start(context);
            // 第一次安装时还没排到挂载前加载，在这里收。
            leaveSplash();
            ctx.ui.addStyle(PICKER_CSS);
            ctx.ui.addSidebarEntry({ label: '皮肤', onClick: () => ctx.ui.openPanel({ title: '皮肤', render: renderPicker }) });
            ctx.ui.attach({
                anchor: () => document.querySelector('.settings-view:not([data-rph-workshop-page]) .settings-stack'),
                position: 'append',
                render(node) {
                    node.className = 'settings-card';
                    node.innerHTML = '<div class="settings-card__header"><div class="settings-card__title"><svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3a9 9 0 100 18c1.1 0 2-.9 2-2 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.2 0-1.1.9-2 2-2H17a4 4 0 004-4c0-4.1-4-7.5-9-7.5zM7.5 12.5h.01M9.5 8.5h.01M14.5 8.5h.01"></path></svg>皮肤</div></div><div class="settings-card__body"></div>';
                    renderPicker(node.lastElementChild);
                }
            });
            // 导航面板打开、换页面之后，页面上的图标是新画的，重新标一遍（面板里外壳加的入口稍晚才出现，所以隔一会儿再标一次）。
            ctx.app.watch(() => `${ctx.app.get('isNavigationOpen')} ${ctx.app.get('currentView')}`, () => {
                requestAnimationFrame(tagIcons);
                setTimeout(tagIcons, 300);
            }, { immediate: true });
            ctx.provide('skins', {
                register(skin) {
                    if (!/^[a-z0-9-]{3,32}$/.test(skin?.id || '') || !skin.name || !/^#[0-9a-f]{6}$/i.test(skin.accent || '')) throw new TypeError('皮肤要有 id、name 和 #rrggbb 格式的 accent');
                    if (skin.id === 'custom' || allSkins().some((other) => other.id === skin.id)) throw new Error(`皮肤 ${skin.id} 已经有了`);
                    extra.push({ ...skin });
                    if (setting('active') === skin.id) apply();
                    refresh();
                },
                use: select,
                refreshIcons: tagIcons,
                get current() { return setting('active'); }
            });
        }
    });
})();
