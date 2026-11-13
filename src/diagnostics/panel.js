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
