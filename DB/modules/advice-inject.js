// 输入转 advice：把用户最新一轮输入改写成 advice，注入到上一条 AI 回复末尾；聊天界面仍显示原话。
// 两种用法：直接发送时只改发往主聊天的请求体；点输入框上方的「选」按钮则把改写结果直接写进聊天记录再发送。
(() => {
    'use strict';
    const DEFAULTS = {
        enabled: '1',
        template: '<选项>\n{{input}}\n<选项/>',
        userSlot: '按照选项继续'
    };

    RPHubSDK.register({
        id: 'advice-inject', name: '输入转 advice', version: '1.2.2', requiresApi: 4,
        init(ctx) {
            const get = key => ctx.storage.get(key) ?? DEFAULTS[key];
            const render = input => get('template').replace('{{input}}', () => input);
            // 开了 UI 模板时，回复末尾有 <ui_template_updates> 变量块；RPH 编辑消息和发请求时会把这个块连同它后面的内容一起去掉，
            // 所以 advice 要插在这个块前面，不能直接接在末尾。
            const withAdvice = (content, input) => {
                const block = content.search(/<ui_template_updates\b[^>]*>(?![\s\S]*<ui_template_updates\b)/i);
                const advice = render(input);
                return block < 0 ? `${content}\n\n${advice}` : `${content.slice(0, block).trimEnd()}\n\n${advice}\n\n${content.slice(block)}`;
            };
            let writtenToHistory = false;

            // 找到含原话的最新用户消息，把原话换成 userSlot，并把 advice 追加到它前面最近的 AI 消息。
            // 聊天记录最后一条不是用户消息（续写、工具调用后的再次请求）时不改；该改却没改成时提示原因。
            ctx.requests.onChat(({ messages }) => {
                if (writtenToHistory) {
                    writtenToHistory = false;
                    return;
                }
                const history = ctx.app.get('chatHistory');
                const last = history?.[history.length - 1];
                const input = get('enabled') === '1' && last?.role === 'user' ? String(last.content || '').trim() : '';
                if (!input) return;
                const lastAssistant = messages.findLastIndex(m => m?.role === 'assistant');
                const userIndex = messages.findLastIndex(m => m?.role === 'user' && typeof m.content === 'string' && m.content.includes(input));
                if (userIndex < 0 || lastAssistant < 0 || userIndex < lastAssistant || typeof messages[lastAssistant].content !== 'string') {
                    const reason = userIndex < 0 ? '请求里找不到你的原话（可能被正则或其他插件改过）' : '前面没有可以写入的 AI 回复';
                    ctx.ui.toast(`输入转 advice 本次没生效：${reason}，原话按普通消息发出。可改用输入框上方的「选」按钮。`);
                    return;
                }
                messages[userIndex].content = messages[userIndex].content.replace(input, () => get('userSlot'));
                messages[lastAssistant].content = withAdvice(messages[lastAssistant].content, input);
            });

            // 「选」按钮：把改写结果写进上一条 AI 回复（随聊天记录保存），输入框换成 userSlot 后发送。
            ctx.ui.addComposerButton({
                label: '写入选项并发送',
                text: '选',
                async onClick() {
                    const input = String(ctx.app.get('userInput') || '').trim();
                    if (!input) return ctx.ui.toast('先在输入框里写好内容', { kind: 'info' });
                    if (ctx.app.get('isConversationBusy')) return ctx.ui.toast('正在回复，请稍后再试', { kind: 'info' });
                    const history = ctx.app.get('chatHistory');
                    const last = history?.[history.length - 1];
                    if (last?.role !== 'assistant' || typeof last.content !== 'string') return ctx.ui.toast('最后一条不是 AI 回复，无法写入');
                    last.content = withAdvice(last.content, input);
                    writtenToHistory = true;
                    ctx.app.set('userInput', get('userSlot'));
                    try {
                        await ctx.app.get('sendMessage')();
                    } finally {
                        writtenToHistory = false;
                    }
                }
            });

            ctx.ui.addSidebarEntry({
                label: '输入转 advice',
                onClick() {
                    ctx.ui.openPanel({
                        title: '输入转 advice',
                        render(body) {
                            // 样式类名见 WORKSHOP-MOD-GUIDE.md「面板样式」，跟随页面主题和深色模式。
                            body.innerHTML = `
                                <label class="rph-ui-check rph-ui-field"><input type="checkbox" class="settings-toggle-input sr-only" data-k="enabled"><span class="settings-toggle"></span>发送时自动改写请求</label>
                                <label class="rph-ui-field">advice 格式（{{input}} 会换成你的原话，追加在上一条 AI 回复末尾）
                                    <textarea class="rph-ui-input" data-k="template" rows="5"></textarea></label>
                                <label class="rph-ui-field">原话位置改成（留在最后一条用户消息里）
                                    <textarea class="rph-ui-input" data-k="userSlot" rows="3"></textarea></label>
                                <p class="rph-ui-muted">输入框上方的「选」按钮会把改写结果直接写进聊天记录再发送，不受上面开关影响。</p>
                                <div class="rph-ui-actions">
                                    <button type="button" class="modal-secondary-button rph-ui-button" data-reset>恢复默认</button>
                                    <button type="button" class="modal-primary-button rph-ui-button" data-save>保存</button>
                                </div>`;
                            const fields = [...body.querySelectorAll('[data-k]')];
                            const fill = read => fields.forEach(el => {
                                const value = read(el.dataset.k);
                                if (el.type === 'checkbox') el.checked = value === '1'; else el.value = value;
                            });
                            fill(get);
                            body.querySelector('[data-save]').onclick = () => {
                                fields.forEach(el => ctx.storage.set(el.dataset.k, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value));
                                ctx.ui.toast('已保存，下次发送生效', { kind: 'info' });
                            };
                            body.querySelector('[data-reset]').onclick = () => fill(key => DEFAULTS[key]);
                        }
                    });
                }
            });
        }
    });
})();
