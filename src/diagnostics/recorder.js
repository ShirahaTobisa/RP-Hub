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
