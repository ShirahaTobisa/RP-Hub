// 朗读：用浏览器自带的语音把 AI 回复念出来。读的是页面上显示出来的正文，不是原文：
// 思维链和变量面板本来就不在正文格子里；插图、折叠块、表格、代码、按钮这些跳过，看起来像状态栏的短行（数字、冒号）也跳过；
// 其他带样式的框（多是角色卡正则换出来的）可以在设置里按卡关掉。念到哪一段，那一段标上底色。
(() => {
    'use strict';
    const DEFAULTS = { rate: '1', pitch: '1', autoRead: '0', onlyQuotes: '0', skipParens: '0', skipActions: '0' };
    const VOICE_KEY = 'rph_tts_voice'; // 每台设备能用的声音不一样，单独存在本机，不跟云同步
    const LIMIT = 60; // 每次最多念 60 字：Chrome 一次念太久（十几秒以上）会被掐断
    const READING = 'rph-tts-reading';
    const SKIP = 'img,svg,iframe,video,audio,canvas,picture,object,embed,pre,code,table,details,button,input,select,textarea,'
        + 'style,script,noscript,template,sup,[hidden],[aria-hidden="true"],[data-rph-image-frame],.html-card-container';
    const ICON_PLAY = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"></path>';
    const ICON_STOP = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path>';
    const RANGE_CLASS = 'compact-range w-full h-1.5 bg-primary-100 rounded-lg appearance-none cursor-pointer accent-primary-500';

    RPHubSDK.register({
        id: 'tts-reader', name: '朗读', version: '1.0.0', requiresApi: 4,
        init(ctx) {
            const synth = window.speechSynthesis;
            if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
                ctx.ui.addSidebarEntry({ label: '朗读设置', onClick: () => ctx.ui.toast('这个浏览器不支持语音朗读', { kind: 'warning' }) });
                return;
            }
            const highlight = document.createElement('style');
            highlight.textContent = `.${READING}{background:rgba(250,204,21,.22);border-radius:6px;box-shadow:0 0 0 3px rgba(250,204,21,.22)}`;
            document.head.appendChild(highlight);

            const get = (key) => ctx.storage.get(key) ?? DEFAULTS[key];
            const options = () => ({ onlyQuotes: get('onlyQuotes') === '1', skipParens: get('skipParens') === '1', skipActions: get('skipActions') === '1' });
            const isChinese = (voice) => /^(zh|cmn|yue)/i.test(voice.lang);

            // 选过就用选过的；没选过挑中文声音里最自然的：在线自然人声（Edge 的晓晓等）> 其他在线声音 > 本机声音。
            function pickVoice() {
                let saved = '';
                try { saved = localStorage.getItem(VOICE_KEY) || ''; } catch (_) { /* storage blocked */ }
                const all = synth.getVoices();
                const chinese = all.filter(isChinese);
                return all.find((voice) => voice.name === saved)
                    || chinese.find((voice) => /natural/i.test(voice.name))
                    || chinese.find((voice) => !voice.localService)
                    || chinese[0] || null;
            }

            // 框的「样子」：标签、类名、样式都一样的，多半是同一条正则换出来的。不读的框按角色卡记。
            const signature = (el) => `${el.tagName.toLowerCase()}|${[...el.classList].filter((name) => name !== READING).sort().join('.')}|${(el.getAttribute('style') || '').replace(/\s+/g, '')}`;
            const boxesKey = () => `skip:${ctx.app.get('currentCharacter')?.uuid || ''}`;
            function skippedBoxes() {
                try { return JSON.parse(ctx.storage.get(boxesKey()) || '[]'); } catch (_) { return []; }
            }

            const plain = (el) => el.textContent.replace(/\s+/g, ' ').trim();
            // 一个块里没有句号问号、也没有引号，却有数字、冒号或竖线，多半是状态栏（「好感度：80/100」）。
            const looksLikeStatus = (text) => text.length < 300 && !/[。！？!?…“”「」『』"]/.test(text) && /[\d:：|｜]/.test(text);

            function clean(text, opts) {
                text = text.replace(/(?:rph-image-marker|image)###[\s\S]*?###/g, '')
                    .replace(/[ \t ]+/g, ' ')
                    .replace(/\s*\n\s*/g, '\n');
                if (opts.skipParens) text = text.replace(/（[^）]*）|\([^)\n]*\)/g, '');
                if (opts.skipActions) text = text.replace(/\*[^*\n]+\*/g, '');
                if (opts.onlyQuotes) text = (text.match(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g) || []).join('\n');
                return text.trim();
            }

            // 把正文按块切成段：{ el（所在的块，念的时候标底色）, text }。
            function segments(body) {
                const opts = options();
                const skipped = new Set(skippedBoxes().map((box) => box.key));
                const list = [];
                let last = null;
                const visit = (node, block) => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        if (last?.el !== block) list.push(last = { el: block, text: '' });
                        last.text += node.nodeValue;
                        return;
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(SKIP) || skipped.has(signature(node))) return;
                    if (opts.skipActions && node.matches('em, i')) return;
                    if (node.tagName === 'BR') {
                        if (last) last.text += '\n';
                        return;
                    }
                    const style = getComputedStyle(node);
                    if (style.display === 'none' || style.visibility === 'hidden') return;
                    const isBlock = !style.display.startsWith('inline');
                    if (isBlock && looksLikeStatus(plain(node))) return;
                    node.childNodes.forEach((child) => visit(child, isBlock ? node : block));
                };
                body.childNodes.forEach((child) => visit(child, body));
                return list.map((item) => ({ el: item.el, text: clean(item.text, opts) })).filter((item) => item.text);
            }

            // 最新回复里带样式的框，给设置里按卡开关；像状态栏的本来就跳过，不列。
            function boxKinds(body) {
                const kinds = new Map();
                for (const el of body.querySelectorAll('[class], [style], blockquote')) {
                    const key = signature(el);
                    const text = plain(el);
                    if (el.closest(SKIP) || (key.endsWith('||') && el.tagName !== 'BLOCKQUOTE') || !text || looksLikeStatus(text)) continue;
                    if (!kinds.has(key)) kinds.set(key, { key, sample: text.length > 24 ? `${text.slice(0, 24)}…` : text });
                }
                return [...kinds.values()];
            }

            // 按段落、句子切成不超过 LIMIT 字的小段；太长的句子再按逗号切。
            function splitText(text) {
                const out = [];
                for (const paragraph of text.split('\n')) {
                    let current = '';
                    for (const sentence of paragraph.match(/[^。！？!?…]+[。！？!?…”」』"]*/g) || []) {
                        for (const piece of sentence.length > LIMIT ? sentence.match(/[^，,；;、]+[，,；;、]*/g) || [sentence] : [sentence]) {
                            for (let i = 0; i < piece.length; i += LIMIT) {
                                const part = piece.slice(i, i + LIMIT);
                                if (current && (current + part).length > LIMIT) {
                                    out.push(current);
                                    current = '';
                                }
                                current += part;
                            }
                        }
                    }
                    if (current.trim()) out.push(current);
                }
                return out.map((item) => item.trim()).filter(Boolean);
            }

            let session = null; // 正在念的：{ index（第几条消息，试听时为 null）, stopped }
            function stop() {
                if (session) session.stopped = true;
                session = null;
                synth.cancel();
                refreshButtons();
            }

            function speakPart(text, voice, current) {
                return new Promise((resolve) => {
                    const utterance = new SpeechSynthesisUtterance(text);
                    utterance.lang = voice?.lang || 'zh-CN';
                    if (voice) utterance.voice = voice;
                    utterance.rate = Number(get('rate')) || 1;
                    utterance.pitch = Number(get('pitch')) || 1;
                    // 有的浏览器偶尔不发结束事件，按字数给个上限，免得后面的句子卡住。
                    const timer = setTimeout(resolve, 3000 + text.length * 600 / utterance.rate);
                    utterance.onend = utterance.onerror = () => {
                        clearTimeout(timer);
                        resolve();
                    };
                    current.utterance = utterance; // 留着引用：Chrome 会回收没人引用的句子，结束事件就不来了
                    synth.speak(utterance);
                });
            }

            async function speak(list, index) {
                stop();
                const current = session = { index, stopped: false };
                refreshButtons();
                const voice = pickVoice();
                for (const { el, text } of list) {
                    el?.classList.add(READING);
                    try {
                        for (const part of splitText(text)) {
                            if (current.stopped) break;
                            await speakPart(part, voice, current);
                        }
                    } finally {
                        el?.classList.remove(READING);
                    }
                    if (current.stopped) return;
                }
                if (session === current) {
                    session = null;
                    refreshButtons();
                }
            }

            const messageBody = (index) => document.querySelector(`[data-chat-index="${index}"] .message-content-wrapper > .markdown-body`);
            function startReading(index) {
                const body = messageBody(index);
                const list = body ? segments(body) : [];
                if (!list.length) return ctx.ui.toast('这条消息没有要读的文字', { kind: 'info' });
                speak(list, index).catch((error) => ctx.log('朗读失败', error));
            }
            const toggleReading = (index) => (session?.index === index ? stop() : startReading(index));
            const lastReplyIndex = () => (ctx.app.get('chatHistory') || []).findLastIndex((message) => message?.role === 'assistant');

            // 每条 AI 回复下方那排按钮里加一个「朗读」，念的时候变成「停止朗读」。
            function decorate(row) {
                if (row.dataset.role !== 'assistant') return;
                const bar = row.querySelector('.message-action-bar');
                if (!bar) return;
                let button = bar.querySelector('[data-rph-tts]');
                if (!button) {
                    button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'message-action-button';
                    button.dataset.rphTts = '';
                    button.innerHTML = '<svg class="w-3.5 h-3.5 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"></svg>';
                    button.addEventListener('click', () => toggleReading(Number(button.closest('[data-chat-index]').dataset.chatIndex)));
                    bar.prepend(button);
                }
                const active = session?.index === Number(row.dataset.chatIndex);
                button.title = active ? '停止朗读' : '朗读';
                button.setAttribute('aria-label', button.title);
                const icon = active ? ICON_STOP : ICON_PLAY;
                if (button.firstChild.innerHTML !== icon) button.firstChild.innerHTML = icon;
            }
            function refreshButtons() {
                document.querySelectorAll('[data-chat-index][data-role="assistant"]').forEach(decorate);
            }

            ctx.events.on('chat-mutation', ({ dirtyRows }) => {
                try { dirtyRows.forEach(decorate); } catch (error) { ctx.log('朗读按钮没加上', error); }
            });
            ctx.events.on('generation-start', () => {
                try { if (session) stop(); } catch (error) { ctx.log('停止朗读失败', error); }
            });
            // 回复结束后自动念：等页面把插图、面板换好再读，同一条只自动念一次（工具调用续写变长了会再念）。
            let lastAutoRead = null;
            ctx.events.on('generation-end', () => {
                if (get('autoRead') !== '1') return;
                setTimeout(() => {
                    try {
                        const index = lastReplyIndex();
                        const history = ctx.app.get('chatHistory') || [];
                        const message = history[index];
                        if (index < 0 || index !== history.length - 1 || message.responseError || ctx.app.get('isGenerating')) return;
                        const key = `${message.id ?? index}:${String(message.content || '').length}`;
                        if (key === lastAutoRead) return;
                        lastAutoRead = key;
                        startReading(index);
                    } catch (error) {
                        ctx.log('自动朗读失败', error);
                    }
                }, 800);
            });
            ctx.app.watch(() => ctx.app.get('currentCharacter')?.uuid, () => { if (session) stop(); });
            refreshButtons();

            ctx.ui.addComposerButton({
                label: '朗读最新回复（朗读中再点一下停止）',
                text: '朗读',
                onClick() {
                    if (session) return stop();
                    const index = lastReplyIndex();
                    if (index < 0) return ctx.ui.toast('还没有 AI 回复', { kind: 'info' });
                    startReading(index);
                }
            });

            ctx.ui.addSidebarEntry({
                label: '朗读设置',
                onClick() {
                    ctx.ui.openPanel({
                        title: '朗读',
                        render(body) {
                            // 样式类名见 WORKSHOP-MOD-GUIDE.md「面板样式」，跟随页面主题和深色模式。
                            const toggle = (attrs, label) => `<div class="rph-ui-field"><label class="rph-ui-check" style="white-space:normal"><input type="checkbox" class="settings-toggle-input sr-only" ${attrs}><span class="settings-toggle"></span><span>${label}</span></label></div>`;
                            const range = (key, label) => `<label class="rph-ui-field"><span>${label} <span data-show="${key}"></span></span><input type="range" min="0.5" max="2" step="0.1" class="${RANGE_CLASS}" data-k="${key}"></label>`;
                            body.innerHTML = `
                                <label class="rph-ui-field">声音<select class="rph-ui-input" data-voice></select></label>
                                <p class="rph-ui-muted">声音来自浏览器和系统，每台设备不一样，只存在这台设备上。电脑上用 Edge 浏览器能用到微软的自然人声。</p>
                                ${range('rate', '语速')}
                                ${range('pitch', '音调')}
                                ${toggle('data-k="autoRead"', '回复结束后自动朗读')}
                                ${toggle('data-k="onlyQuotes"', '只读引号里的对白')}
                                ${toggle('data-k="skipParens"', '不读括号里的内容')}
                                ${toggle('data-k="skipActions"', '不读星号动作（斜体字）')}
                                <section class="rph-ui-section">
                                    <h3>要读的框（只对当前角色卡）</h3>
                                    <p class="rph-ui-muted">下面是最新回复里带样式的框，关掉的那一类以后不读。状态栏、折叠块、表格、代码和插图本来就不读。</p>
                                    <div data-boxes></div>
                                </section>
                                <div class="rph-ui-actions">
                                    <button type="button" class="modal-secondary-button rph-ui-button" data-preview>看看最新回复会读什么</button>
                                    <button type="button" class="modal-primary-button rph-ui-button" data-try>试听</button>
                                </div>
                                <div class="rph-ui-note" data-preview-text hidden style="white-space:pre-wrap;max-height:40vh;overflow:auto"></div>`;

                            const select = body.querySelector('[data-voice]');
                            const fillVoices = () => {
                                if (!select.isConnected && select.options.length) return synth.removeEventListener?.('voiceschanged', fillVoices);
                                const all = synth.getVoices();
                                const list = all.some(isChinese) ? all.filter(isChinese) : all;
                                const current = pickVoice();
                                select.innerHTML = '';
                                if (!list.length) select.appendChild(new Option('这个设备没有可用的声音', ''));
                                list.forEach((voice) => select.appendChild(new Option(`${voice.name}（${voice.lang}）`, voice.name, false, voice === current)));
                            };
                            fillVoices();
                            synth.addEventListener?.('voiceschanged', fillVoices);
                            select.onchange = () => {
                                try { localStorage.setItem(VOICE_KEY, select.value); } catch (_) { /* storage blocked */ }
                            };

                            body.querySelectorAll('[data-k]').forEach((field) => {
                                const key = field.dataset.k;
                                const show = body.querySelector(`[data-show="${key}"]`);
                                const paint = () => { if (show) show.textContent = `${Number(field.value).toFixed(1)}×`; };
                                if (field.type === 'checkbox') field.checked = get(key) === '1'; else field.value = get(key);
                                paint();
                                field.oninput = paint;
                                field.onchange = () => ctx.storage.set(key, field.type === 'checkbox' ? (field.checked ? '1' : '0') : field.value);
                            });

                            const latest = () => {
                                const index = lastReplyIndex();
                                return index < 0 ? null : messageBody(index);
                            };
                            // 最新回复里的框，加上以前关掉、这次没出现的，都能在这里改回来。
                            const saved = skippedBoxes();
                            const kinds = latest() ? boxKinds(latest()) : [];
                            saved.forEach((box) => { if (!kinds.some((kind) => kind.key === box.key)) kinds.push(box); });
                            const boxes = body.querySelector('[data-boxes]');
                            boxes.innerHTML = kinds.length ? kinds.map((_, i) => toggle(`data-box="${i}"`, '')).join('') : '<p class="rph-ui-muted">最新回复里没有带样式的框。</p>';
                            kinds.forEach((kind, i) => {
                                const input = boxes.querySelector(`[data-box="${i}"]`);
                                input.nextElementSibling.nextElementSibling.textContent = kind.sample;
                                input.checked = !saved.some((box) => box.key === kind.key);
                                input.onchange = () => {
                                    const rest = skippedBoxes().filter((box) => box.key !== kind.key);
                                    ctx.storage.set(boxesKey(), JSON.stringify(input.checked ? rest : [...rest, kind]));
                                };
                            });

                            const preview = body.querySelector('[data-preview-text]');
                            body.querySelector('[data-preview]').onclick = () => {
                                const message = latest();
                                preview.textContent = message ? (segments(message).map((item) => item.text).join('\n') || '最新回复里没有要读的文字。') : '还没有 AI 回复，或者最新回复不在当前页面上。';
                                preview.hidden = false;
                            };
                            body.querySelector('[data-try]').onclick = () => speak([{ el: null, text: '你好，这是朗读的试听。语速和音调可以在上面调整。' }], null).catch((error) => ctx.log('试听失败', error));
                        }
                    });
                }
            });
        }
    });
})();
