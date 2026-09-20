/*
 * 官方 mod 模板（复制本文件 -> 改 id/name -> 在 TODO 处填你的逻辑 -> 托管到 https -> 在模块管理面板安装）。
 * 这是教学骨架，不是产品功能；保留每个 SDK 接口的最小可运行示例。
 */
(() => {
    'use strict';

    // ① manifest 与 register
    // id 必须匹配 /^[a-z0-9-]{3,32}$/。register 必须在脚本加载后同步调用；
    // loader 只等待 3 秒，若把 register 放进异步回调，模块会被记为“加载失败”。
    const accepted = globalThis.RPHubSDK.register({
        id: 'template-mod',
        name: '官方模板 mod',
        version: '1.0.0',
        requiresApi: 1,

        // ② init(ctx) 骨架
        init(ctx) {
            ctx.log('模板 mod 已报到');
            const apiVersion = ctx.version?.api;
            const loaderVersion = ctx.version?.loader;
            const updateInfo = ctx.upstream?.updateInfo ?? null;
            ctx.log('SDK', apiVersion, loaderVersion, updateInfo);

            // 空载恒零：init 里不读库、不起周期定时器、不发网络。
            // 需要较重的工作时，把它放到下面的用户按钮或其他用户动作之后。
            // TODO(你): 在这里准备只依赖 manifest/ctx 的轻量状态。

            // ③ UI 占位：只登记入口，真正的面板在用户点击后创建。
            ctx.ui.addSidebarEntry({
                label: '模板 mod',
                onClick() {
                    ctx.ui.openPanel({
                        title: '模板面板',
                        render(bodyEl) {
                            bodyEl.replaceChildren();
                            const note = document.createElement('p');
                            note.textContent = '这是模板面板,把 render 换成你的界面';
                            bodyEl.appendChild(note);

                            const toastButton = document.createElement('button');
                            toastButton.type = 'button';
                            toastButton.textContent = '发个 toast';
                            toastButton.addEventListener('click', () => {
                                ctx.ui.toast('模板 toast 已触发', { kind: 'info' });
                                // TODO(你): 换成你的用户动作。
                            });

                            const keysButton = document.createElement('button');
                            keysButton.type = 'button';
                            keysButton.textContent = '读一次库';
                            keysButton.addEventListener('click', () => {
                                // 只读、只扫键；内部键格式没有稳定性保证，不要解析键名做业务。
                                void ctx.appDb.keys('rp_hub_').then((keys) => {
                                    ctx.log('扫描到键数量', keys.length);
                                    // TODO(你): 根据需要展示结果，不要读取或写入同步协议数据。
                                }).catch((error) => ctx.log('键扫描失败', error));
                            });
                            bodyEl.append(toastButton, keysButton);
                        }
                    });
                }
            });

            // ④ events 四件套：每个回调都自吞异常，这是模块的义务，不是风格偏好。
            ctx.events.on('ready', () => {
                try { ctx.log('ready'); /* TODO(你): */ } catch (_) { /* 必须自吞 */ }
            });
            ctx.events.on('visibility', () => {
                try { ctx.log('visibility'); /* TODO(你): */ } catch (_) { /* 必须自吞 */ }
            });
            ctx.events.on('chat-mutation', ({ dirtyRows } = {}) => {
                try {
                    ctx.log('chat-mutation', dirtyRows?.length || 0);
                    // chat-mutation 已由 loader 以至少 500ms 节流批量派发；dirtyRows 是脏行数组。
                    // TODO(你): 只处理这些行，不要自建全页 MutationObserver。
                } catch (_) { /* 必须自吞 */ }
            });
            ctx.events.on('persistence-flush', () => {
                try {
                    ctx.log('persistence-flush');
                    // 该事件在云同步落盘链路上扇出；不要阻塞或改变同步返回值。
                    // TODO(你): 做轻量的落盘后收尾。
                } catch (_) { /* 必须自吞 */ }
            });

            // ⑤ storage 与 appDb 占位
            // 单值上限 64KB；键会加上 rph_mod_template-mod:: 前缀，卸载时自动清理。
            const stored = ctx.storage.get('template-count');
            ctx.storage.set('template-count', String(Number(stored || 0) + 1));
            ctx.storage.remove('unused-example-key');
            // TODO(你): 把这里的无意义计数换成你自己的小型设置。
        }
    });

    if (accepted !== true) {
        // register 返回 false 时 loader 已记录状态；不要在这里重试或另起异步注册。
        return;
    }

    /*
     * ⑥ 反面清单
     * - 不要自建全页 MutationObserver；订阅 chat-mutation。
     * - 不要碰 rp_hub_settings 或任何同步协议数据。
     * - 不要假设 app 内部 DOM 结构稳定；只依赖 SDK 与你自己的面板节点。
     * - 改代码后用户必须刷新页面才生效，loader 没有热加载。
     * - TODO(你): 发布前删除不需要的教学代码，并保留 fail-soft 的 try/catch。
     */
})();
