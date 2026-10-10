// 接口示范 mod：把 RP-Hub 测试版插件接口（API 5）的每一项各用一次，写插件时照着抄。
// 默认不改动任何聊天内容；“请求改写示范”要在面板里手动打开。
(() => {
    'use strict';

    // ① register：文件加载后立刻同步调用，3 秒内没注册会被判为加载失败。
    RPHubSDK.register({
        id: 'api-demo',
        name: '接口示范',
        version: '1.1.0',
        requiresApi: 5,
        init(ctx) {
            // ② 日志、版本、上游信息
            ctx.log('已加载', ctx.version, ctx.upstream.updateInfo);

            // ③ ctx.storage：小型设置（同步读写，单个值最多 64KB，随云同步）
            const events = [];
            const record = (text) => {
                events.unshift(`${new Date().toLocaleTimeString()}  ${text}`);
                events.length = Math.min(events.length, 20);
            };

            // ④ ctx.events：每个回调都要自己 try/catch，出错不能影响页面
            const on = (name, callback) => ctx.events.on(name, (payload) => {
                try { callback(payload); } catch (error) { ctx.log(`${name} 处理失败`, error); }
            });
            on('ready', () => record('页面就绪'));
            on('visibility', ({ hidden }) => record(hidden ? '页面切到后台' : '页面回到前台'));
            on('chat-mutation', ({ dirtyRows }) => record(`聊天区 ${dirtyRows.length} 行有变化`));
            on('generation-start', () => record('AI 开始回复'));
            on('generation-end', () => record('AI 回复结束'));
            // ⑤ ctx.data + ctx.persistence：较大的 JSON 数据（异步，随云同步）；异步保存要登记，推送前会等它完成
            on('persistence-flush', () => {
                ctx.persistence.track('summary', () => ctx.data.set('summary', { savedAt: Date.now(), events: events.slice(0, 5) }));
            });

            // ⑥ ctx.app.watch：数据变了才通知，代替定时轮询
            ctx.app.watch(() => ctx.app.get('chatHistory')?.length ?? 0, (count, previous) => record(`消息数 ${previous} → ${count}`));

            // ⑦ ctx.requests.onChat：发往 AI 的主聊天请求发出前修改请求体（记忆总结等后台请求不会经过这里）
            ctx.requests.onChat((body) => {
                if (ctx.storage.get('rewrite') !== '1') return;
                body.messages.push({ role: 'system', content: '[接口示范] 这是一条由插件追加的系统提示。' });
            });

            // ⑧ ctx.ui.addComposerButton + ctx.app.set：输入框上方加按钮，往输入框里填文字（不发送）
            ctx.ui.addComposerButton({
                label: '接口示范：填入示例文字',
                text: '示',
                onClick() {
                    const character = ctx.app.get('currentCharacter')?.name || '未选择角色';
                    ctx.app.set('userInput', `（接口示范）当前角色：${character}`);
                }
            });

            // ⑪ ctx.image：生图前看一眼（或修改）参数；注册生图接口见 DB/modules/nai2api-web.js
            ctx.image.onParams((params) => record(`新图参数：${params.steps} 步 · ${params.sampler}`));

            // ⑨ ctx.ui.addSidebarEntry + openPanel + toast，⑩ ctx.appDb 只读查询
            ctx.ui.addSidebarEntry({
                label: '接口示范',
                onClick() {
                    ctx.storage.set('open-count', String(Number(ctx.storage.get('open-count') || 0) + 1));
                    ctx.ui.openPanel({ title: '接口示范', render: renderPanel });
                }
            });

            // 面板控件用页面样式类名（见指南「面板样式」），自动跟随主题和深色模式，不用自己写颜色。
            function renderPanel(body) {
                const line = (text) => Object.assign(document.createElement('p'), { className: 'rph-ui-muted', textContent: text });
                const button = (text, onClick) => {
                    const element = Object.assign(document.createElement('button'), { type: 'button', textContent: text, className: 'modal-secondary-button rph-ui-button' });
                    element.addEventListener('click', onClick);
                    return element;
                };
                const rewrite = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'settings-toggle-input sr-only', checked: ctx.storage.get('rewrite') === '1' });
                rewrite.addEventListener('change', () => ctx.storage.set('rewrite', rewrite.checked ? '1' : '0'));
                const rewriteLabel = Object.assign(document.createElement('label'), { className: 'rph-ui-check rph-ui-field' });
                rewriteLabel.append(rewrite, Object.assign(document.createElement('span'), { className: 'settings-toggle' }), '请求改写示范：给每次主聊天请求追加一条系统提示');
                const log = Object.assign(document.createElement('pre'), { className: 'rph-ui-input', textContent: events.join('\n') || '暂无事件' });
                log.style.cssText = 'max-height:180px;overflow:auto;white-space:pre-wrap;';
                const actions = Object.assign(document.createElement('div'), { className: 'rph-ui-actions' });
                body.replaceChildren(
                    line(`面板打开次数：${ctx.storage.get('open-count') || 0}`),
                    line(`当前用户：${ctx.app.get('user')?.name || '未知'}；当前角色：${ctx.app.get('currentCharacter')?.name || '未选择'}；消息数：${ctx.app.get('chatHistory')?.length ?? 0}`),
                    rewriteLabel,
                    log,
                    actions
                );
                actions.append(
                    button('弹出提示', () => ctx.ui.toast('这是 ctx.ui.toast 的提示', { kind: 'info' })),
                    button('统计聊天记录键', async () => {
                        const keys = await ctx.appDb.keys('rp_hub_chat_');
                        ctx.ui.toast(`本地存有 ${keys.length} 个角色的聊天记录`, { kind: 'info' });
                    }),
                    button('读取上次保存的数据', async () => {
                        const summary = await ctx.data.get('summary');
                        ctx.ui.toast(summary ? `上次保存于 ${new Date(summary.savedAt).toLocaleString()}` : '还没有保存过', { kind: 'info' });
                    })
                );
            }
        }
    });
})();
