// Nai2API 网页任务生图：不走 /generate 直链，改用 POST /api/web/jobs 提交任务，支持 1–50 步。
// 超过 28 步（或 2K/4K 分辨率）按 NovelAI 官方价格计费，设置页的步数滑条下会显示每张图的点数。
// 装好后在 RPH「设置」→「生图设置」→「生图接口」里选「Nai2API 网页任务」。
(() => {
    'use strict';
    const DEFAULT_BASE = 'https://nai.sta1n.cn';
    const POLL_MS = 2000;
    const MAX_WAIT_MS = 10 * 60_000;

    RPHubSDK.register({
        id: 'nai2api-web', name: 'Nai2API 网页任务生图', version: '1.1.0', requiresApi: 5,
        init(ctx) {
            const base = () => String(ctx.storage.get('base') || DEFAULT_BASE).replace(/\/+$/, '');
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

            ctx.image.registerProvider({
                id: 'nai2api-web',
                label: 'Nai2API 网页任务',
                maxSteps: 50,
                // 点数用生图模块统一的估算（与 Nai2API 价格表一致）。
                costHint({ steps, model, size }) {
                    const estimate = globalThis.RPHubImageModule?.estimateImagePoints;
                    if (!estimate) return '';
                    const points = estimate(model, size, steps);
                    const standard = estimate(model, size, 28);
                    return points > standard
                        ? `当前设置每张图约 ${points} 点（28 步只要 ${standard} 点），超过 28 步按官方价格计费。`
                        : `当前设置每张图 ${points} 点。`;
                },
                async generate({ params, token }) {
                    if (!token) throw new Error('缺少生图密钥');
                    const auth = { authorization: `Bearer ${token}` };
                    const body = {};
                    for (const key of ['tag', 'model', 'artist', 'size', 'steps', 'scale', 'cfg', 'sampler', 'negative', 'nocache', 'noise_schedule', 'seed']) {
                        if (params[key] !== undefined) body[key] = params[key];
                    }
                    const read = async (response) => {
                        const value = await response.json().catch(() => null);
                        if (!response.ok || !value?.id) throw new Error(`网页任务失败：${value?.error || value?.message || `HTTP ${response.status}`}`);
                        return value;
                    };
                    let job = await read(await fetch(`${base()}/api/web/jobs`, {
                        method: 'POST',
                        headers: { ...auth, 'content-type': 'application/json' },
                        body: JSON.stringify(body)
                    }));
                    const deadline = Date.now() + MAX_WAIT_MS;
                    // 同一任务串行查询，上一次返回后再发下一次（Nai2API 的建议）。
                    while (job.status !== 'done') {
                        if (job.status === 'failed') throw new Error(`网页任务失败：${job.error || '生成失败'}`);
                        if (Date.now() > deadline) throw new Error('网页任务等待超时，请稍后重试');
                        await sleep(POLL_MS);
                        job = await read(await fetch(`${base()}/api/jobs/${encodeURIComponent(job.id)}`, { headers: auth }));
                    }
                    const image = await fetch(`${base()}/api/jobs/${encodeURIComponent(job.id)}/content`, { headers: auth });
                    if (!image.ok || image.headers.get('x-error')) throw new Error(`网页任务取图失败：HTTP ${image.status}`);
                    return image.blob();
                }
            });

            ctx.ui.addSidebarEntry({
                label: 'Nai2API 网页任务',
                onClick() {
                    ctx.ui.openPanel({
                        title: 'Nai2API 网页任务生图',
                        render(panel) {
                            panel.innerHTML = `
                                <p class="rph-ui-muted">在「设置」→「生图设置」→「生图接口」里选「Nai2API 网页任务」后生效。步数可设 1–50；超过 28 步按官方价格计费。</p>
                                <label class="rph-ui-field">服务地址
                                    <input class="rph-ui-input" data-base placeholder="${DEFAULT_BASE}"></label>
                                <div class="rph-ui-actions">
                                    <button type="button" class="modal-secondary-button rph-ui-button" data-reset>恢复默认</button>
                                    <button type="button" class="modal-primary-button rph-ui-button" data-save>保存</button>
                                </div>`;
                            const input = panel.querySelector('[data-base]');
                            input.value = ctx.storage.get('base') || '';
                            panel.querySelector('[data-save]').onclick = () => {
                                const value = input.value.trim();
                                if (value && !/^https:\/\//.test(value)) return ctx.ui.toast('服务地址必须以 https:// 开头');
                                ctx.storage.set('base', value);
                                ctx.ui.toast('已保存', { kind: 'success' });
                            };
                            panel.querySelector('[data-reset]').onclick = () => { input.value = ''; ctx.storage.remove('base'); };
                        }
                    });
                }
            });
        }
    });
})();
