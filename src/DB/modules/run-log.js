// 运行日志：记下页面上的警告、报错和未捕获的异常，存在本机（不进云同步），手机上没有控制台也能查看和复制。
// 插件加载后才开始记录，页面刚打开那一瞬间（插件加载前）的报错记不到。
RPHubSDK.register({
    id: 'run-log', name: '运行日志', version: '1.0.0', requiresApi: 1,
    init(ctx) {
        'use strict';
        // 测试版 2026.10.11 外壳自带运行日志，两份同时记录会互相覆盖，这时插件不做任何事。
        if (window.RPHubUI?.openLogViewer) return;
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

        function formatPart(value) {
            if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
            if (typeof value === 'string') return value;
            try { return JSON.stringify(value); } catch (_) { return String(value); }
        }

        function record(level, parts) {
            const text = parts.map(formatPart).join(' ').slice(0, 2000);
            logs.push(`${new Date().toLocaleString('zh-CN', { hour12: false })} [${level}] ${text}`);
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

        ctx.ui.addSidebarEntry({
            label: '运行日志',
            onClick() {
                ctx.ui.openPanel({
                    title: '运行日志',
                    render(body) {
                        body.innerHTML = `
                            <p class="rph-ui-muted">最近 ${LOG_LIMIT} 条警告和报错，只存在这台设备上。遇到问题时复制发给开发者。</p>
                            <textarea class="rph-ui-input" readonly data-log style="width:100%;min-height:50vh;margin:0.75rem 0;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap"></textarea>
                            <div class="rph-ui-actions">
                                <button type="button" class="modal-secondary-button rph-ui-button rph-ui-danger" data-act="clear">清空</button>
                                <button type="button" class="modal-primary-button rph-ui-button" data-act="copy">复制全部</button>
                            </div>`;
                        const area = body.querySelector('[data-log]');
                        const show = () => { area.value = logs.length ? logs.slice().reverse().join('\n\n') : '暂无日志'; };
                        show();
                        body.querySelector('[data-act="clear"]').onclick = async () => {
                            if (!await window.RPHubUI.confirm({ title: '清空日志', message: '清空后无法恢复。', confirmText: '清空', danger: true })) return;
                            logs = [];
                            saveLogs();
                            show();
                        };
                        body.querySelector('[data-act="copy"]').onclick = async () => {
                            try {
                                await navigator.clipboard.writeText(area.value);
                            } catch (_) {
                                area.select();
                                document.execCommand('copy');
                            }
                            ctx.ui.toast('已复制日志', { kind: 'success' });
                        };
                    }
                });
            }
        });
    }
});
