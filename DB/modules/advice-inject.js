// 输入转 advice：把用户最新一轮输入改写成 advice，注入到上一条 AI 回复末尾；聊天界面仍显示原话。
// 两种用法：直接发送时只改发往主聊天的请求体；点输入框上方的「选」按钮则把改写结果直接写进聊天记录再发送。
(() => {
    'use strict';
    const DEFAULTS = {
        enabled: '1',
        template: '<选项>\n{{input}}\n<选项/>',
        userSlot: '按照选项继续'
    };
    const FIELD_STYLE = 'display:block;box-sizing:border-box;width:100%;margin:4px 0 12px;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#18212f;font:inherit;';
    const BUTTON_STYLE = 'min-height:34px;padding:6px 12px;margin-right:8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;font:inherit;cursor:pointer;';

    RPHubSDK.register({
        id: 'advice-inject', name: '输入转 advice', version: '1.2.0', requiresApi: 4,
        init(ctx) {
            const get = key => ctx.storage.get(key) ?? DEFAULTS[key];
            const render = input => get('template').replace('{{input}}', () => input);
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
                messages[lastAssistant].content += '\n\n' + render(input);
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
                    last.content += '\n\n' + render(input);
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
                            body.innerHTML = `
                                <label style="display:block;margin-bottom:12px"><input type="checkbox" data-k="enabled"> 发送时自动改写请求</label>
                                <label style="display:block">advice 格式（{{input}} 会换成你的原话，追加在上一条 AI 回复末尾）</label>
                                <textarea data-k="template" rows="5" style="${FIELD_STYLE}"></textarea>
                                <label style="display:block">原话位置改成（留在最后一条用户消息里）</label>
                                <textarea data-k="userSlot" rows="3" style="${FIELD_STYLE}"></textarea>
                                <p style="margin:0 0 12px;color:#64748b">输入框上方的「选」按钮会把改写结果直接写进聊天记录再发送，不受上面开关影响。</p>
                                <button type="button" data-save style="${BUTTON_STYLE}border-color:#2563eb;background:#2563eb;color:#fff;">保存</button><button type="button" data-reset style="${BUTTON_STYLE}">恢复默认</button>`;
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
