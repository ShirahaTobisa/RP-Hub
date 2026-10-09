// 输入转 advice：把用户最新一轮输入改写成 advice，注入到上一条 AI 回复末尾；聊天界面仍显示原话。
// 只改发往主聊天的请求体，不改聊天记录；记忆总结、UI 分析等副请求由加载器排除。
(() => {
    'use strict';
    const DEFAULTS = {
        enabled: '1',
        template: '<advice>\n{{input}}\n</advice>',
        userSlot: '请按照上一条回复末尾 <advice> 中的方向继续写下去。'
    };

    RPHubSDK.register({
        id: 'advice-inject', name: '输入转 advice', version: '1.1.0', requiresApi: 3,
        init(ctx) {
            const get = key => ctx.storage.get(key) ?? DEFAULTS[key];

            // 找到含原话的最新用户消息，把原话换成 userSlot，并把 advice 追加到它前面最近的 AI 消息。
            // 聊天记录最后一条不是用户消息（续写、工具调用后的再次请求）时不改。
            ctx.requests.onChat(({ messages }) => {
                const history = ctx.app.get('chatHistory');
                const last = history?.[history.length - 1];
                const input = get('enabled') === '1' && last?.role === 'user' ? String(last.content || '').trim() : '';
                if (!input) return;
                const lastAssistant = messages.findLastIndex(m => m?.role === 'assistant');
                const userIndex = messages.findLastIndex(m => m?.role === 'user' && typeof m.content === 'string' && m.content.includes(input));
                if (userIndex < lastAssistant || lastAssistant < 0 || typeof messages[lastAssistant].content !== 'string') return;
                messages[userIndex].content = messages[userIndex].content.replace(input, () => get('userSlot'));
                messages[lastAssistant].content += '\n\n' + get('template').replace('{{input}}', () => input);
            });

            ctx.ui.addSidebarEntry({
                label: '输入转 advice',
                onClick() {
                    ctx.ui.openPanel({
                        title: '输入转 advice',
                        render(body) {
                            body.innerHTML = `
                                <label style="display:block;margin-bottom:12px"><input type="checkbox" data-k="enabled"> 启用</label>
                                <label style="display:block">advice 格式（{{input}} 会换成你的原话，追加在上一条 AI 回复末尾）</label>
                                <textarea data-k="template" rows="5" style="width:100%;margin:4px 0 12px"></textarea>
                                <label style="display:block">原话位置改成（留在最后一条用户消息里）</label>
                                <textarea data-k="userSlot" rows="3" style="width:100%;margin:4px 0 12px"></textarea>
                                <button type="button" data-save>保存</button> <button type="button" data-reset>恢复默认</button>`;
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
