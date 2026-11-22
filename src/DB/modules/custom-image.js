// 自定义生图：自己添加生图服务（OpenAI 图片接口、Gemini、NovelAI 官方接口），加到「设置」→「生图设置」→「生图接口」的下拉框里。
// 在浏览器里直接请求服务（三家都允许网页直接调用），出的图交给外壳上传存进 R2，存放位置和直链生图相同。
// 外壳给的是 NovelAI 那套参数（tag 提示词、artist 画风串、size 竖图/2K竖图…、步数、采样器、负面词、种子）：
// NovelAI 官方接口全部照用；OpenAI 和 Gemini 只用提示词和尺寸，画风串是 NovelAI 的写法不发，要画风就在服务里填附加提示词。
(() => {
    'use strict';
/* @shared/styled-select */

    // model 是填写模型时的示例。
    const FORMATS = {
        openai: { label: 'OpenAI 图片接口', base: 'https://api.openai.com/v1', model: 'gpt-image-1' },
        gemini: { label: 'Gemini', base: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash-image' },
        novelai: { label: 'NovelAI 官方接口', base: 'https://image.novelai.net' }
    };
    // 外壳生图模块的尺寸表（像素），NovelAI 按它出图；OpenAI、Gemini 只看横竖。
    const PIXELS = {
        竖图: [832, 1216], 横图: [1216, 832], 方图: [1024, 1024],
        '2K竖图': [1088, 1600], '2K横图': [1600, 1088], '2K方图': [1344, 1344],
        '4K竖图': [1344, 1984], '4K横图': [1984, 1344], '4K方图': [1728, 1728]
    };
    const shapeOf = (size) => (/横/.test(size) ? 'landscape' : /方/.test(size) ? 'square' : 'portrait');
    const OPENAI_SIZES = { portrait: '1024x1536', landscape: '1536x1024', square: '1024x1024' };
    const GEMINI_RATIOS = { portrait: '2:3', landscape: '3:2', square: '1:1' };
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const promptOf = (service, params) => [params.tag, service.extra].map((text) => String(text || '').trim()).filter(Boolean).join(', ');

    // 请求生图服务。连不上（地址写错、服务不允许网页调用）和服务报错，都换成一句看得懂的原因。
    async function send(url, init) {
        let response;
        try { response = await fetch(url, init); } catch (_) { throw new Error('无法连接生图服务：请检查接口地址，或该服务不支持网页直接调用'); }
        if (response.ok) return response;
        const text = await response.text().catch(() => '');
        let data = null;
        try { data = JSON.parse(text); } catch (_) { /* 不是 JSON 就直接用原文 */ }
        const reason = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.message || text.slice(0, 200);
        throw new Error(`生图服务返回错误（HTTP ${response.status}）${reason ? `：${reason}` : ''}`);
    }

    // 按文件头认图片格式（PNG、JPEG、WebP），服务没写类型或写错时也能存。
    function imageBlob(data, type = '') {
        const bytes = typeof data === 'string' ? Uint8Array.from(atob(data), (char) => char.charCodeAt(0)) : data;
        const sniffed = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
            : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
            : String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP' ? 'image/webp' : '';
        const mime = sniffed || (String(type).startsWith('image/') ? type : '');
        if (!mime) throw new Error('生图服务返回的不是图片');
        return new Blob([bytes], { type: mime });
    }

    // NovelAI 的返回有两种：JSON {images:[{image: base64 的 PNG}]}（2026-11-21 用官方密钥实测是这种），
    // 或 zip（里面是 image_0.png，从中央目录读第一项，存储和 deflate 两种压缩方式都认）。直接回图片的转发也照收。
    async function readNovelAI(buffer) {
        const bytes = new Uint8Array(buffer);
        if (bytes[0] === 0x7b) {
            let data = null;
            try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch (_) { /* 不是 JSON 就按图片认，认不出会报错 */ }
            const image = data?.images?.[0];
            const base64 = typeof image === 'string' ? image : image?.image;
            if (base64) return imageBlob(base64.replace(/^data:[^,]*,/, ''));
        }
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return imageBlob(bytes);
        const view = new DataView(buffer);
        let end = buffer.byteLength - 22;
        while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
        if (end < 0) throw new Error('生图服务返回的不是图片');
        const entry = view.getUint32(end + 16, true);
        const method = view.getUint16(entry + 10, true);
        const size = view.getUint32(entry + 20, true);
        const local = view.getUint32(entry + 42, true);
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = bytes.subarray(start, start + size);
        if (method === 0) return imageBlob(data);
        if (method !== 8) throw new Error('生图服务返回的压缩格式不支持');
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return imageBlob(new Uint8Array(await new Response(stream).arrayBuffer()));
    }

    const GENERATORS = {
        async openai(service, params) {
            const root = service.base || FORMATS.openai.base;
            const response = await send(`${/\/v\d+$/i.test(root) ? root : `${root}/v1`}/images/generations`, {
                method: 'POST',
                headers: { authorization: `Bearer ${service.key}`, 'content-type': 'application/json' },
                body: JSON.stringify({ model: service.model, prompt: promptOf(service, params), n: 1, size: OPENAI_SIZES[shapeOf(params.size)] })
            });
            const data = await response.json().catch(() => null);
            const item = data?.data?.[0] || data?.images?.[0];
            if (item?.b64_json) return imageBlob(item.b64_json);
            if (item?.url) return imageBlob(new Uint8Array(await (await send(item.url)).arrayBuffer()));
            throw new Error('生图服务没有返回图片');
        },
        async gemini(service, params) {
            const root = (service.base || FORMATS.gemini.base).replace(/\/v1(beta)?$/i, '');
            const model = service.model.replace(/^models\//, '');
            const response = await send(`${root}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
                method: 'POST',
                headers: { 'x-goog-api-key': service.key, 'content-type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: promptOf(service, params) }] }],
                    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: GEMINI_RATIOS[shapeOf(params.size)] } }
                })
            });
            const data = await response.json().catch(() => null);
            const candidate = data?.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            const inline = parts.map((part) => part.inlineData || part.inline_data).find((item) => item?.data);
            if (inline) return imageBlob(inline.data, inline.mimeType || inline.mime_type);
            // 被拦下或模型只回了文字：把原因和那段文字带上。
            const reason = data?.promptFeedback?.blockReason || candidate?.finishReason || '';
            const text = parts.map((part) => part.text).filter(Boolean).join(' ').trim().slice(0, 200);
            throw new Error(`生图服务没有返回图片${reason ? `（${reason}）` : ''}${text ? `：${text}` : ''}`);
        },
        // 请求体照 NovelAI 网页版：V4/V4.5 用 params_version 3；V5 用 4，并且不带 noise_schedule 和 skip_cfg_above_sigma。
        async novelai(service, params) {
            const root = service.base || FORMATS.novelai.base;
            const model = String(params.model || 'nai-diffusion-4-5-full');
            const v5 = model.includes('diffusion-5');
            const [width, height] = PIXELS[params.size] || PIXELS.竖图;
            const prompt = [params.artist, params.tag].map((text) => String(text || '').trim()).filter(Boolean).join(', ');
            const negative = String(params.negative || '');
            const seed = Number.parseInt(params.seed, 10);
            const parameters = {
                params_version: v5 ? 4 : 3, width, height, n_samples: 1,
                steps: Number(params.steps) || 28, scale: Number(params.scale) || 6, cfg_rescale: Number(params.cfg) || 0,
                sampler: params.sampler || 'k_dpmpp_2m_sde', noise_schedule: params.noise_schedule || 'karras',
                seed: Number.isFinite(seed) ? seed : Math.floor(Math.random() * 4294967296),
                ucPreset: 3, qualityToggle: false, dynamic_thresholding: false, controlnet_strength: 1,
                legacy: false, legacy_uc: false, legacy_v3_extend: false, add_original_image: true,
                skip_cfg_above_sigma: null, use_coords: false, characterPrompts: [], negative_prompt: negative,
                v4_prompt: { caption: { base_caption: prompt, char_captions: [] }, use_coords: false, use_order: true },
                v4_negative_prompt: { caption: { base_caption: negative, char_captions: [] }, legacy_uc: false }
            };
            if (v5) {
                delete parameters.noise_schedule;
                delete parameters.skip_cfg_above_sigma;
            }
            const response = await send(`${root}/ai/generate-image`, {
                method: 'POST',
                headers: { authorization: `Bearer ${service.key}`, 'content-type': 'application/json' },
                body: JSON.stringify({ input: prompt, model, action: 'generate', parameters })
            });
            return readNovelAI(await response.arrayBuffer());
        }
    };

    RPHubSDK.register({
        id: 'custom-image', name: '自定义生图', version: '1.0.1', requiresApi: 5,
        init(ctx) {
            let services = [];
            try { services = (JSON.parse(ctx.storage.get('services')) || []).filter((item) => FORMATS[item?.format]); } catch (_) { services = []; }
            const save = () => ctx.storage.set('services', JSON.stringify(services));

            // 外壳没有「取消注册」：删掉的服务在下拉框里标成「已删除」，刷新页面后消失；选着它生图会提示重新选择。
            const register = (service, removed = false) => ctx.image.registerProvider({
                id: service.id,
                label: removed ? `${service.name}（已删除）` : service.name,
                maxSteps: service.format === 'novelai' ? 50 : 28,
                costHint: () => (service.format === 'novelai' ? '' : '步数、采样器等参数对此服务无效'),
                generate: ({ params }) => {
                    const current = services.find((item) => item.id === service.id);
                    if (!current) throw new Error('该生图服务已删除，请在「生图接口」中重新选择');
                    return GENERATORS[current.format](current, params || {});
                }
            });
            services.forEach((service) => register(service));

            function openPanel() {
                ctx.ui.openPanel({
                    title: '自定义生图',
                    render(body) {
                        let editing = null; // 正在编辑的服务 id；没有就是添加
                        let select = { unmount() {} };
                        const draw = () => {
                            select.unmount();
                            const current = services.find((item) => item.id === editing) || null;
                            body.innerHTML = `
                                <p class="rph-ui-muted">添加后在「设置」→「生图设置」→「生图接口」中选择。</p>
                                ${services.length ? services.map((service) => `<div class="rph-ui-row" data-service="${escapeHtml(service.id)}">
                                    <div class="rph-ui-row-main"><b>${escapeHtml(service.name)}</b>
                                        <div class="rph-ui-muted">${escapeHtml([FORMATS[service.format].label, service.model].filter(Boolean).join(' · '))}</div>
                                    </div>
                                    <div class="rph-ui-actions">
                                        <button type="button" class="modal-secondary-button rph-ui-button" data-act="edit">编辑</button>
                                        <button type="button" class="modal-secondary-button rph-ui-button rph-ui-danger" data-act="delete">删除</button>
                                    </div>
                                </div>`).join('') : '<p class="rph-ui-empty">暂无生图服务</p>'}
                                <section class="rph-ui-section" style="margin-top:16px">
                                    <h3>${current ? `编辑「${escapeHtml(current.name)}」` : '添加生图服务'}</h3>
                                    <label class="rph-ui-field">名称<input class="rph-ui-input" data-field="name" placeholder="例如：GPT 生图"></label>
                                    <label class="rph-ui-field">接口格式<select class="rph-ui-input" data-field="format">
                                        ${Object.entries(FORMATS).map(([value, format]) => `<option value="${value}">${format.label}</option>`).join('')}
                                    </select></label>
                                    <label class="rph-ui-field">接口地址<input class="rph-ui-input" data-field="base" placeholder="留空使用官方地址，或填写中转地址"></label>
                                    <label class="rph-ui-field">密钥<input class="rph-ui-input" type="password" data-field="key"></label>
                                    <label class="rph-ui-field" data-model-only>模型<input class="rph-ui-input" data-field="model"></label>
                                    <label class="rph-ui-field" data-model-only>附加提示词<input class="rph-ui-input" data-field="extra" placeholder="加在每张图的提示词后面，例如：日系动漫风格"></label>
                                    <div class="rph-ui-actions">
                                        ${current ? '<button type="button" class="modal-secondary-button rph-ui-button" data-act="cancel">取消</button>' : ''}
                                        <button type="button" class="modal-primary-button rph-ui-button" data-act="save">${current ? '保存' : '添加'}</button>
                                    </div>
                                </section>`;
                            const field = (name) => body.querySelector(`[data-field="${name}"]`);
                            for (const name of ['name', 'format', 'base', 'key', 'model', 'extra']) field(name).value = current?.[name] || (name === 'format' ? 'openai' : '');
                            // NovelAI 的模型跟随「生图设置」，不填模型和附加提示词。
                            const follow = () => {
                                const example = FORMATS[field('format').value].model;
                                field('model').placeholder = example ? `例如：${example}` : '';
                                for (const label of body.querySelectorAll('[data-model-only]')) label.style.display = example ? '' : 'none';
                            };
                            field('format').onchange = follow;
                            follow();
                            select = styledSelect(field('format'));

                            for (const row of body.querySelectorAll('[data-service]')) {
                                const service = services.find((item) => item.id === row.dataset.service);
                                row.querySelector('[data-act="edit"]').onclick = () => { editing = service.id; draw(); };
                                row.querySelector('[data-act="delete"]').onclick = async () => {
                                    if (!await window.RPHubUI.confirm({ title: '删除生图服务', message: `「${service.name}」及其密钥将被删除。`, confirmText: '删除', danger: true })) return;
                                    services = services.filter((item) => item.id !== service.id);
                                    save();
                                    register(service, true);
                                    if (editing === service.id) editing = null;
                                    draw();
                                };
                            }
                            const cancel = body.querySelector('[data-act="cancel"]');
                            if (cancel) cancel.onclick = () => { editing = null; draw(); };
                            body.querySelector('[data-act="save"]').onclick = () => {
                                const value = (name) => field(name).value.trim();
                                const format = field('format').value;
                                const needsModel = Boolean(FORMATS[format].model);
                                const next = {
                                    id: current?.id || `ci-${Date.now().toString(36)}`, name: value('name'), format,
                                    base: value('base').replace(/\/+$/, ''), key: value('key'),
                                    model: needsModel ? value('model') : '', extra: needsModel ? value('extra') : ''
                                };
                                if (!next.name || !next.key || (needsModel && !next.model)) {
                                    return ctx.ui.toast(needsModel ? '请填写名称、密钥和模型' : '请填写名称和密钥', { kind: 'warning' });
                                }
                                if (next.base && !/^https:\/\//i.test(next.base)) return ctx.ui.toast('接口地址必须以 https:// 开头', { kind: 'warning' });
                                services = current ? services.map((item) => (item.id === next.id ? next : item)) : [...services, next];
                                save();
                                register(next);
                                ctx.ui.toast(current ? `已保存「${next.name}」` : `已添加「${next.name}」`, { kind: 'success' });
                                editing = null;
                                draw();
                            };
                        };
                        draw();
                    }
                });
            }

            ctx.ui.addSidebarEntry({ label: '自定义生图', onClick: openPanel });
        }
    });
})();
