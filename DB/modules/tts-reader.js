// 朗读：把 AI 回复念出来。两种方式：
// - 浏览器自带的语音：免费，声音看设备。
// - Fish Audio：多一次 AI 调用（插件接口 API 7 的 ctx.ai）分析每句是谁说的、用什么语气，再按「配音表」给旁白和每个人物用不同的音色。
//   音色从 Fish 公共声音库里挑（不占 Fish 账号的保存名额）：可以让 AI 按世界书挑，也可以自己搜、试听。
// 读的是页面上显示出来的正文，不是原文：思维链和变量面板本来就不在正文格子里；插图、折叠块、表格、代码、按钮这些跳过，
// 看起来像状态栏的短行（数字、冒号）也跳过；其他带样式的框（多是角色卡正则换出来的）可以在设置里按卡关掉。念到哪一段，那一段标上底色。
(() => {
    'use strict';
    const DEFAULTS = {
        engine: 'browser', rate: '1', pitch: '1', autoRead: '0', onlyQuotes: '0', skipParens: '0', skipActions: '0',
        fishKey: '', fishModel: 'fish-audio/s2.1-pro-free', analyze: '1', analysisModel: ''
    };
    const FISH_SPEECH = 'https://api.fish.audio/compat/v1/audio/speech';
    const FISH_LIBRARY = 'https://api.fish.audio/model';
    const NARRATOR = '旁白';
    const VOICE_KEY = 'rph_tts_voice'; // 浏览器自带的声音每台设备不一样，单独存在本机，不跟云同步
    const BROWSER_LIMIT = 60; // 浏览器自带朗读每次最多念 60 字：Chrome 一次念太久（十几秒以上）会被掐断
    const ONLINE_LIMIT = 200; // Fish 每段最多 200 字：太长等得久，太短请求多
    const CACHE_SIZE = 80; // 重听不重新生成（不再花钱），最多留 80 段，刷新页面后清空
    const ANALYSIS_KEEP = 40; // 每张卡最多存 40 条回复的分析结果
    const ERROR_HINTS = { 400: '多半是声音 ID 填错了', 401: '密钥不对', 402: '余额不足', 403: '密钥没有权限', 429: '请求太频繁或额度用完了' };
    const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    const READING = 'rph-tts-reading';
    const QUOTE = '“[^”]*”|「[^」]*」|『[^』]*』|"[^"\\n]*"';
    const SKIP = 'img,svg,iframe,video,audio,canvas,picture,object,embed,pre,code,table,details,button,input,select,textarea,'
        + 'style,script,noscript,template,sup,[hidden],[aria-hidden="true"],[data-rph-image-frame],.html-card-container';
    // Fish 中文声音库里常见的标签，给 AI 挑音色时选。
    const VOICE_TAGS = 'gentle, soft, warm, calm, deep, clear, bright, crisp, breathy, raspy, smooth, high, cheerful, playful, energetic, '
        + 'enthusiastic, serious, confident, authoritative, mysterious, expressive, dramatic, intimate, empathetic, relaxed, animated, '
        + 'character-voice, anime, storytelling, narration, ASMR';
    const ANALYZE_PROMPT = [
        '你是有声书的配音导演。下面是一段角色扮演回复里要念的句子，每行开头是编号。',
        '逐行判断这一句是谁说的、该用什么语气念。',
        '说话人：叙述、动作、环境描写写「旁白」；人物说的话写人物名字，尽量用已知人物里的名字。',
        '语气：用 2～5 个英文单词描述怎么念，比如 cheerful and teasing、whispering nervously、cold and distant；旁白写 calm narration 这类。',
        '只输出 JSON 数组，每行一项：[编号, "说话人", "语气"]，不要输出别的文字。'
    ].join('\n');
    const PICK_PROMPT = [
        '你是配音选角。根据人物资料，给这个人物写在声音库里找声音的条件。',
        '只输出 JSON：{"gender":"male|female|unknown","age":"young|middle-aged|old|unknown","tags":[2～4 个英文标签],"keywords":[1～2 个中文搜索词，比如 少女、御姐、少年、大叔、老人、萝莉、正太、公子、温柔男声],"reason":"一句中文理由"}',
        `英文标签只能从这里选：${VOICE_TAGS}`
    ].join('\n');
    const ICON_PLAY = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"></path>';
    const ICON_STOP = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path>';
    const RANGE_CLASS = 'compact-range w-full h-1.5 bg-primary-100 rounded-lg appearance-none cursor-pointer accent-primary-500';

    RPHubSDK.register({
        id: 'tts-reader', name: '朗读', version: '2.0.0', requiresApi: 4,
        init(ctx) {
            const synth = typeof window.SpeechSynthesisUtterance === 'function' ? window.speechSynthesis : null;
            const player = new Audio(); // Fish 的语音都用这一个播放器：手机上点过一次以后，自动朗读也能出声
            const preview = new Audio(); // 声音库的试听
            const highlight = document.createElement('style');
            highlight.textContent = `.${READING}{background:rgba(250,204,21,.22);border-radius:6px;box-shadow:0 0 0 3px rgba(250,204,21,.22)}`;
            document.head.appendChild(highlight);

            const get = (key) => ctx.storage.get(key) ?? DEFAULTS[key];
            const fish = () => get('engine') === 'fish';
            const canAnalyze = () => typeof ctx.ai?.complete === 'function'; // 外壳更新到插件接口 7 才有
            const rate = () => Number(get('rate')) || 1;
            const options = () => ({ onlyQuotes: get('onlyQuotes') === '1', skipParens: get('skipParens') === '1', skipActions: get('skipActions') === '1' });
            const isChinese = (voice) => /^(zh|cmn|yue)/i.test(voice.lang);
            const character = () => ctx.app.get('currentCharacter') || {};
            const characterId = () => character().uuid || '';
            const isNarrator = (speaker) => !speaker || speaker === NARRATOR || /narrat/i.test(speaker);

            // 浏览器自带的声音：选过就用选过的；没选过挑中文声音里最自然的：在线自然人声（Edge 的晓晓等）> 其他在线声音 > 本机声音。
            function pickBrowserVoice() {
                let saved = '';
                try { saved = localStorage.getItem(VOICE_KEY) || ''; } catch (_) { /* storage blocked */ }
                const all = synth?.getVoices() || [];
                const chinese = all.filter(isChinese);
                return all.find((voice) => voice.name === saved)
                    || chinese.find((voice) => /natural/i.test(voice.name))
                    || chinese.find((voice) => !voice.localService)
                    || chinese[0] || null;
            }

            // 框的「样子」：标签、类名、样式都一样的，多半是同一条正则换出来的。不读的框按角色卡记。
            const signature = (el) => `${el.tagName.toLowerCase()}|${[...el.classList].filter((name) => name !== READING).sort().join('.')}|${(el.getAttribute('style') || '').replace(/\s+/g, '')}`;
            const boxesKey = () => `skip:${characterId()}`;
            const readJson = (key, fallback) => {
                try { return JSON.parse(ctx.storage.get(key) || 'null') ?? fallback; } catch (_) { return fallback; }
            };
            const skippedBoxes = () => readJson(boxesKey(), []);

            // 配音表（按角色卡）：旁白和每个人物用哪个 Fish 声音。{ narrator: 声音, people: [{ name, ...声音 }] }，声音是 { id, title, sample }。
            const castKey = () => `cast:${characterId()}`;
            function readCast() {
                const cast = readJson(castKey(), {});
                const people = Array.isArray(cast.people) ? cast.people.filter((person) => person?.name) : [];
                const name = character().name;
                if (name && !people.some((person) => person.name === name)) people.unshift({ name });
                return { narrator: cast.narrator || {}, people };
            }
            const saveCast = (cast) => ctx.storage.set(castKey(), JSON.stringify(cast));
            function voiceOf(speaker, cast) {
                if (isNarrator(speaker)) return cast.narrator.id || '';
                const person = cast.people.find((item) => item.name === speaker)
                    || cast.people.find((item) => speaker.includes(item.name) || item.name.includes(speaker));
                return person?.id || cast.narrator.id || '';
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
                if (opts.onlyQuotes) text = (text.match(new RegExp(QUOTE, 'g')) || []).join('\n');
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

            // 按段落、句子切成不超过 limit 字的小段；太长的句子再按逗号切。
            function splitText(text, limit) {
                const out = [];
                for (const paragraph of text.split('\n')) {
                    let current = '';
                    for (const sentence of paragraph.match(/[^。！？!?…]+[。！？!?…”」』"]*/g) || []) {
                        for (const piece of sentence.length > limit ? sentence.match(/[^，,；;、]+[，,；;、]*/g) || [sentence] : [sentence]) {
                            for (let i = 0; i < piece.length; i += limit) {
                                const part = piece.slice(i, i + limit);
                                if (current && (current + part).length > limit) {
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

            const parseJson = (text, open) => {
                const start = text.indexOf(open);
                const end = text.lastIndexOf(open === '[' ? ']' : '}');
                if (start < 0 || end <= start) return null;
                try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
            };
            const hash = (text) => {
                let value = 0x811c9dc5;
                for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193);
                return (value >>> 0).toString(16);
            };

            // 分析每句是谁说的、什么语气。结果按回复存进 ctx.data（随云同步），重听和别的设备不用再分析。
            // 没开分析、外壳太旧或分析失败时：引号里的算角色卡本人，其余算旁白。
            async function labelLines(lines, signal) {
                const fallback = lines.map((line) => ({ speaker: line.quote ? character().name || NARRATOR : NARRATOR, tone: '' }));
                if (get('analyze') !== '1' || !canAnalyze()) return fallback;
                const store = `analysis:${characterId()}`;
                const key = hash(lines.map((line) => line.text).join('\n'));
                const saved = (await ctx.data.get(store).catch(() => null)) || {};
                if (Array.isArray(saved[key]) && saved[key].length === lines.length) return saved[key].map(([speaker, tone]) => ({ speaker, tone }));
                let labels;
                try {
                    ctx.ui.toast('正在分析每句是谁说的、用什么语气……', { kind: 'info' });
                    const names = readCast().people.map((person) => person.name).join('、') || '（还没有）';
                    const reply = await ctx.ai.complete({
                        model: get('analysisModel').trim() || undefined,
                        signal,
                        messages: [
                            { role: 'system', content: ANALYZE_PROMPT },
                            { role: 'user', content: `已知人物：${names}；用户扮演：${ctx.app.get('user')?.name || '未知'}\n\n${lines.map((line, i) => `${i + 1}. ${line.text.slice(0, 300)}`).join('\n')}` }
                        ]
                    });
                    const rows = parseJson(reply, '[');
                    if (!Array.isArray(rows)) throw new Error('AI 没有按格式回答');
                    labels = fallback.map((item, i) => {
                        const row = rows.find((entry) => Array.isArray(entry) && Number(entry[0]) === i + 1);
                        if (!row) return item;
                        return { speaker: String(row[1] || '').trim() || NARRATOR, tone: String(row[2] || '').replace(/[[\]]/g, '').trim().slice(0, 60) };
                    });
                } catch (error) {
                    if (signal?.aborted) throw error;
                    ctx.ui.toast(`分析说话人失败：${error?.message || error}。这次先按引号分对白和旁白`, { kind: 'warning' });
                    return fallback;
                }
                const next = { ...saved, [key]: labels.map((label) => [label.speaker, label.tone]) };
                Object.keys(next).slice(0, -ANALYSIS_KEEP).forEach((old) => delete next[old]);
                ctx.data.set(store, next).catch((error) => ctx.log('分析结果没存上', error));
                // 新出现的人物加进配音表，等用户挑音色；挑之前先用旁白的声音。
                const cast = readCast();
                const fresh = [...new Set(labels.map((label) => label.speaker))].filter((speaker) => !isNarrator(speaker) && !cast.people.some((person) => person.name === speaker));
                if (fresh.length) saveCast({ ...cast, people: [...cast.people, ...fresh.map((name) => ({ name }))] });
                return labels;
            }

            // Fish：按引号切成句，分析后合并同一段里连着、同一声音同一语气的句子，少发请求；语气写成句首的 [方括号]。
            async function fishItems(list, current) {
                const lines = [];
                for (const { el, text } of list) {
                    text.split(new RegExp(`(${QUOTE})`)).forEach((run, i) => {
                        if (run.trim()) lines.push({ el, text: run.trim(), quote: i % 2 === 1 });
                    });
                }
                const labels = await labelLines(lines, current.abort.signal);
                const cast = readCast();
                const items = [];
                lines.forEach((line, i) => {
                    const { speaker, tone } = labels[i];
                    const voice = voiceOf(speaker, cast);
                    const last = items[items.length - 1];
                    if (last && last.el === line.el && last.voice === voice && last.tone === tone && (last.text + line.text).length <= ONLINE_LIMIT) {
                        last.text += line.text;
                        return;
                    }
                    for (const chunk of splitText(line.text, ONLINE_LIMIT)) items.push({ el: line.el, text: chunk, voice, tone });
                });
                return items;
            }
            const browserItems = (list) => list.flatMap(({ el, text }) => splitText(text, BROWSER_LIMIT).map((chunk) => ({ el, text: chunk })));

            let session = null; // 正在念的：{ index（第几条消息，试听时为 null）, stopped, abort, finish }
            function stop() {
                if (session) {
                    session.stopped = true;
                    session.abort.abort();
                    session.finish?.();
                }
                session = null;
                synth?.cancel();
                player.pause();
                refreshButtons();
            }

            // 手机浏览器只让「点了之后」出声：第一次点朗读时先用同一个播放器放一下静音，之后自动朗读也能播。
            let unlocked = false;
            function unlock() {
                if (unlocked || !fish()) return;
                unlocked = true;
                player.src = SILENT;
                player.play().catch(() => {});
            }

            function speakPart(text, voice, current) {
                return new Promise((resolve) => {
                    const utterance = new SpeechSynthesisUtterance(text);
                    utterance.lang = voice?.lang || 'zh-CN';
                    if (voice) utterance.voice = voice;
                    utterance.rate = rate();
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

            const cache = new Map();
            async function synthesize({ text, voice, tone }, signal) {
                const input = tone ? `[${tone}] ${text}` : text;
                const model = get('fishModel');
                const key = [model, voice, rate(), input].join('\n');
                if (cache.has(key)) return cache.get(key);
                const response = await fetch(FISH_SPEECH, {
                    method: 'POST',
                    signal,
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${get('fishKey').trim()}` },
                    body: JSON.stringify({ model, input, voice, response_format: 'mp3', speed: rate() })
                });
                if (!response.ok) {
                    const detail = await response.text().catch(() => '');
                    let reason = detail;
                    try {
                        const json = JSON.parse(detail);
                        reason = [json.error?.message, json.message, json.detail, json.error].find((item) => typeof item === 'string' && item) || detail;
                    } catch (_) { /* 不是 JSON，用原文 */ }
                    const status = ERROR_HINTS[response.status] ? `${response.status}，${ERROR_HINTS[response.status]}` : response.status;
                    throw new Error(`Fish 报错（${status}）：${String(reason).slice(0, 200) || response.statusText}`);
                }
                const blob = await response.blob();
                cache.set(key, blob);
                if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
                return blob;
            }

            function play(blob, current) {
                return new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(blob);
                    const finish = (error) => {
                        player.onended = player.onerror = null;
                        current.finish = null;
                        URL.revokeObjectURL(url);
                        if (error) reject(error); else resolve();
                    };
                    current.finish = () => finish();
                    player.onended = () => finish();
                    player.onerror = () => finish(new Error('这段语音放不出来，Fish 返回的可能不是音频'));
                    player.src = url;
                    player.play().catch(finish);
                });
            }

            // build(current) 返回要念的小段：Fish 的是 { el, text, voice, tone }，浏览器自带的是 { el, text }。
            async function speak(build, index) {
                stop();
                const isFish = fish();
                if (!isFish && !synth) return ctx.ui.toast('这个浏览器不支持自带朗读，可以在「朗读设置」里改用 Fish Audio', { kind: 'warning' });
                if (isFish && !get('fishKey').trim()) return ctx.ui.toast('先在「朗读设置」里填好 Fish Audio 的密钥', { kind: 'warning' });
                const current = session = { index, stopped: false, abort: new AbortController() };
                refreshButtons();
                try {
                    const items = await build(current);
                    const loads = [];
                    // 边播边生成下一段，段与段之间不停顿。
                    const load = (i) => (loads[i] ??= synthesize(items[i], current.abort.signal));
                    const voice = isFish ? null : pickBrowserVoice();
                    for (let i = 0; i < items.length && !current.stopped; i += 1) {
                        const blob = isFish ? await load(i) : null;
                        if (isFish && i + 1 < items.length) load(i + 1).catch(() => {});
                        if (current.stopped) break;
                        items[i].el?.classList.add(READING);
                        try {
                            await (isFish ? play(blob, current) : speakPart(items[i].text, voice, current));
                        } finally {
                            items[i].el?.classList.remove(READING);
                        }
                    }
                } catch (error) {
                    if (!current.stopped) {
                        ctx.ui.toast(error?.name === 'NotAllowedError' ? '浏览器拦住了自动播放，点一下「朗读」就能听' : error?.message || String(error), { kind: 'error' });
                    }
                } finally {
                    if (session === current) {
                        session = null;
                        refreshButtons();
                    }
                }
            }

            const messageBody = (index) => document.querySelector(`[data-chat-index="${index}"] .message-content-wrapper > .markdown-body`);
            function startReading(index) {
                const body = messageBody(index);
                const list = body ? segments(body) : [];
                if (!list.length) return ctx.ui.toast('这条消息没有要读的文字', { kind: 'info' });
                speak((current) => (fish() ? fishItems(list, current) : browserItems(list)), index).catch((error) => ctx.log('朗读失败', error));
            }
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
                    button.addEventListener('click', () => {
                        const index = Number(button.closest('[data-chat-index]').dataset.chatIndex);
                        if (session?.index === index) return stop();
                        unlock();
                        startReading(index);
                    });
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
            ctx.app.watch(() => characterId(), () => { if (session) stop(); });
            refreshButtons();

            ctx.ui.addComposerButton({
                label: '朗读最新回复（朗读中再点一下停止）',
                text: '朗读',
                onClick() {
                    if (session) return stop();
                    const index = lastReplyIndex();
                    if (index < 0) return ctx.ui.toast('还没有 AI 回复', { kind: 'info' });
                    unlock();
                    startReading(index);
                }
            });

            // ---- 挑音色：Fish 公共声音库（不用密钥，网页能直接搜），用库里的声音不占 Fish 账号的保存名额 ----
            const toVoice = (item) => ({ id: item._id, title: item.title || item._id, tags: (item.tags || []).slice(0, 5), sample: item.samples?.[0]?.audio || '' });
            async function searchLibrary(queries, want = {}) {
                const found = new Map();
                for (const { title = '', tags = [] } of queries) {
                    const url = new URL(FISH_LIBRARY);
                    url.searchParams.set('page_size', '20');
                    url.searchParams.set('sort_by', 'score');
                    url.searchParams.set('language', 'zh');
                    if (title) url.searchParams.set('title', title);
                    tags.filter((tag) => tag && tag !== 'unknown').forEach((tag) => url.searchParams.append('tag', tag));
                    const response = await fetch(url);
                    if (!response.ok) throw new Error(`Fish 声音库搜索失败（${response.status}）`);
                    for (const item of (await response.json()).items || []) if (item?._id && !found.has(item._id)) found.set(item._id, item);
                }
                // 排序：性别、年龄、标签、搜索词对得上的靠前，用的人多的稍微靠前。
                const wanted = new Set((want.tags || []).map((tag) => String(tag).toLowerCase()));
                const score = (item) => {
                    const tags = (item.tags || []).map((tag) => String(tag).toLowerCase());
                    return (tags.includes(want.gender) ? 3 : 0) + (tags.includes(want.age) ? 2 : 0) + tags.filter((tag) => wanted.has(tag)).length
                        + ((want.keywords || []).some((word) => String(item.title || '').includes(word)) ? 2 : 0) + Math.log10((item.task_count || 0) + 1) / 2;
                };
                return [...found.values()].sort((a, b) => score(b) - score(a)).slice(0, 8).map(toVoice);
            }

            // 人物资料：角色卡本人的描述，加上世界书里触发词或标题对得上这个名字的条目。
            function aboutPerson(name) {
                const card = character();
                const keysOf = (entry) => (Array.isArray(entry.keys) ? entry.keys : String(entry.keys || entry.key || '').split(/[,，]/)).map((key) => String(key).trim()).filter(Boolean);
                const entries = [...(card.worldInfo || []), ...(ctx.app.get('globalWorldInfo') || [])].filter((entry) => entry && entry.enabled !== false);
                const matched = entries.filter((entry) => keysOf(entry).some((key) => key === name || (key.length > 1 && name.includes(key))) || String(entry.comment || '').includes(name));
                const parts = name === card.name ? [String(card.description || '')] : [];
                (matched.length ? matched : entries.filter((entry) => String(entry.content || '').includes(name)).slice(0, 3)).forEach((entry) => parts.push(String(entry.content || '')));
                return parts.filter(Boolean).join('\n\n').slice(0, 4000);
            }

            async function aiPick(name) {
                const info = name === NARRATOR
                    ? `这是旁白，负责念叙述、动作和环境描写，要和故事的气质相配。故事背景：${String(character().description || '').slice(0, 1500)}`
                    : aboutPerson(name) || '（世界书里没找到这个人的资料，按名字推测）';
                const reply = await ctx.ai.complete({
                    model: get('analysisModel').trim() || undefined,
                    messages: [{ role: 'system', content: PICK_PROMPT }, { role: 'user', content: `人物：${name}\n资料：\n${info}` }]
                });
                const want = parseJson(reply, '{');
                if (!want) throw new Error('AI 没有按格式回答');
                const keywords = (Array.isArray(want.keywords) ? want.keywords : []).map(String).filter(Boolean).slice(0, 2);
                const gender = ['male', 'female'].includes(want.gender) ? want.gender : '';
                const age = ['young', 'middle-aged', 'old'].includes(want.age) ? want.age : '';
                const voices = await searchLibrary([...keywords.map((title) => ({ title, tags: [gender] })), { tags: [gender, age] }],
                    { gender, age, keywords, tags: Array.isArray(want.tags) ? want.tags : [] });
                return { voices, reason: String(want.reason || '') };
            }

            ctx.ui.addSidebarEntry({
                label: '朗读设置',
                onClick() {
                    ctx.ui.openPanel({
                        title: '朗读',
                        render(body) {
                            // 样式类名见 WORKSHOP-MOD-GUIDE.md「面板样式」，跟随页面主题和深色模式。
                            const toggle = (attrs, label) => `<div class="rph-ui-field"><label class="rph-ui-check" style="white-space:normal"><input type="checkbox" class="settings-toggle-input sr-only" ${attrs}><span class="settings-toggle" style="flex-shrink:0"></span><span>${label}</span></label></div>`;
                            const range = (key, label) => `<label class="rph-ui-field"><span>${label} <span data-show="${key}"></span></span><input type="range" min="0.5" max="2" step="0.1" class="${RANGE_CLASS}" data-k="${key}"></label>`;
                            const button = (attrs, label, primary = false) => `<button type="button" class="${primary ? 'modal-primary-button' : 'modal-secondary-button'} rph-ui-button" ${attrs}>${label}</button>`;
                            body.innerHTML = `
                                <label class="rph-ui-field">朗读方式<select class="rph-ui-input" data-k="engine">
                                    <option value="browser">浏览器自带（免费，声音看设备）</option>
                                    <option value="fish">Fish Audio（按人物配音色、带语气）</option>
                                </select></label>
                                <div data-engine="browser">
                                    <label class="rph-ui-field">声音<select class="rph-ui-input" data-voice></select></label>
                                    <p class="rph-ui-muted">声音来自浏览器和系统，每台设备不一样，只存在这台设备上。电脑上用 Edge 浏览器能用到微软的自然人声。</p>
                                    ${range('pitch', '音调')}
                                </div>
                                <div data-engine="fish">
                                    <label class="rph-ui-field">Fish Audio 密钥<input class="rph-ui-input" type="password" data-k="fishKey" autocomplete="off" placeholder="在 fish.audio 的开发者页面申请"></label>
                                    <label class="rph-ui-field">模型<select class="rph-ui-input" data-k="fishModel">
                                        <option value="fish-audio/s2.1-pro-free">S2.1 Pro 免费版</option>
                                        <option value="fish-audio/s2.1-pro">S2.1 Pro（按字数收费）</option>
                                    </select></label>
                                    <p class="rph-ui-muted">免费版和收费版是同一个模型，但 Fish 说免费版的请求可能会被留下来改进模型。密钥会随云同步存进你自己的存储桶。</p>
                                    <div data-needs-ai>
                                        ${toggle('data-k="analyze"', '让 AI 分析每句是谁说的、用什么语气')}
                                        <p class="rph-ui-muted">朗读一条回复时多一次 AI 调用，结果会存下来，重听不再分析。</p>
                                        <label class="rph-ui-field">分析用的模型<input class="rph-ui-input" data-k="analysisModel" autocomplete="off" placeholder="留空用 RPH 设置里的分析模型，没设就用主模型"></label>
                                    </div>
                                    <p class="rph-ui-muted" data-old-shell hidden>测试版更新到插件接口 7 以后，才能用 AI 分析说话人和 AI 挑音色；现在按引号分对白（角色卡本人）和旁白。</p>
                                    <section class="rph-ui-section">
                                        <h3>配音表（只对当前角色卡）</h3>
                                        <p class="rph-ui-muted">音色从 Fish 公共声音库里挑，不占你 Fish 账号的保存名额。没挑的用 Fish 的默认声音；新出现的人物会自己加进来，挑好之前先用旁白的声音。</p>
                                        <div data-cast></div>
                                        <div class="rph-ui-actions"><input class="rph-ui-input" data-new-person placeholder="人物名字" style="flex:1;min-width:0">${button('data-add-person', '添加人物')}</div>
                                    </section>
                                </div>
                                ${range('rate', '语速')}
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
                                    ${button('data-preview', '看看最新回复会读什么')}
                                    ${button('data-try', '试听', true)}
                                </div>
                                <div class="rph-ui-note" data-preview-text hidden style="white-space:pre-wrap;max-height:40vh;overflow:auto"></div>`;

                            // 设置项改了立即保存；滑条拖完再存。
                            body.querySelectorAll('[data-k]').forEach((field) => {
                                const key = field.dataset.k;
                                const show = body.querySelector(`[data-show="${key}"]`);
                                const value = () => (field.type === 'checkbox' ? (field.checked ? '1' : '0') : field.value);
                                const paint = () => { if (show) show.textContent = `${Number(field.value).toFixed(1)}×`; };
                                if (field.type === 'checkbox') field.checked = get(key) === '1'; else field.value = get(key);
                                paint();
                                field.addEventListener('input', () => {
                                    paint();
                                    if (field.type !== 'range') ctx.storage.set(key, value());
                                });
                                field.addEventListener('change', () => ctx.storage.set(key, value()));
                            });
                            const engine = body.querySelector('[data-k="engine"]');
                            const showEngine = () => body.querySelectorAll('[data-engine]').forEach((part) => { part.hidden = part.dataset.engine !== engine.value; });
                            engine.addEventListener('change', showEngine);
                            showEngine();
                            body.querySelector('[data-needs-ai]').hidden = !canAnalyze();
                            body.querySelector('[data-old-shell]').hidden = canAnalyze();

                            // 浏览器自带的声音
                            const select = body.querySelector('[data-voice]');
                            const fillVoices = () => {
                                if (!select.isConnected && select.options.length) return synth?.removeEventListener?.('voiceschanged', fillVoices);
                                const all = synth?.getVoices() || [];
                                const list = all.some(isChinese) ? all.filter(isChinese) : all;
                                const current = pickBrowserVoice();
                                select.innerHTML = '';
                                if (!list.length) select.appendChild(new Option('这个设备没有可用的声音', ''));
                                list.forEach((voice) => select.appendChild(new Option(`${voice.name}（${voice.lang}）`, voice.name, false, voice === current)));
                            };
                            fillVoices();
                            synth?.addEventListener?.('voiceschanged', fillVoices);
                            select.onchange = () => {
                                try { localStorage.setItem(VOICE_KEY, select.value); } catch (_) { /* storage blocked */ }
                            };

                            // 配音表：每行一个人物（第一行是旁白），可以让 AI 挑、自己搜、试听、清掉。
                            const castBox = body.querySelector('[data-cast]');
                            const element = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
                            const smallButton = (label, onClick) => {
                                const item = element('button', 'modal-secondary-button rph-ui-button', label);
                                item.type = 'button';
                                item.onclick = onClick;
                                return item;
                            };
                            const playSample = (url) => {
                                if (!url) return ctx.ui.toast('这个声音没有试听', { kind: 'info' });
                                preview.src = url;
                                preview.play().catch((error) => ctx.ui.toast(`试听放不出来：${error?.message || error}`));
                            };
                            const assign = (name, voice) => {
                                const cast = readCast();
                                const picked = { id: voice.id, title: voice.title, sample: voice.sample };
                                if (name === NARRATOR) cast.narrator = picked;
                                else cast.people = cast.people.map((person) => (person.name === name ? { name, ...picked } : person));
                                saveCast(cast);
                                renderCast();
                            };
                            // 候选声音列表：每个都能试听、选用。
                            const showVoices = (area, name, voices, note = '') => {
                                area.replaceChildren();
                                if (note) area.appendChild(element('p', 'rph-ui-muted', note));
                                if (!voices.length) area.appendChild(element('p', 'rph-ui-muted', '没找到合适的声音，换个词搜搜。'));
                                voices.forEach((voice) => {
                                    const row = element('div', 'rph-ui-row');
                                    const main = element('div', 'rph-ui-row-main');
                                    main.append(element('strong', '', voice.title), element('div', 'rph-ui-muted', voice.tags.join(' · ')));
                                    const actions = element('div', 'rph-ui-row-actions');
                                    actions.append(smallButton('试听', () => playSample(voice.sample)), smallButton('用这个', () => assign(name, voice)));
                                    row.append(main, actions);
                                    row.dataset.voiceId = voice.id;
                                    area.appendChild(row);
                                });
                            };
                            const searchBox = (area, name) => {
                                area.replaceChildren();
                                const form = element('div', 'rph-ui-actions');
                                const input = element('input', 'rph-ui-input');
                                Object.assign(input, { placeholder: '搜声音，比如 少女、御姐、大叔', value: '' });
                                input.style.cssText = 'flex:1;min-width:0';
                                const results = element('div');
                                const run = async () => {
                                    results.replaceChildren(element('p', 'rph-ui-muted', '正在搜……'));
                                    try {
                                        showVoices(results, name, await searchLibrary([{ title: input.value.trim() }], { keywords: [input.value.trim()].filter(Boolean) }));
                                    } catch (error) {
                                        results.replaceChildren(element('p', 'rph-ui-muted', error?.message || String(error)));
                                    }
                                };
                                input.onkeydown = (event) => { if (event.key === 'Enter') run(); };
                                form.append(input, smallButton('搜索', run));
                                area.append(form, results);
                                input.focus();
                            };
                            function renderCast() {
                                const cast = readCast();
                                castBox.replaceChildren();
                                [{ name: NARRATOR, ...cast.narrator }, ...cast.people].forEach((person) => {
                                    const row = element('div', 'rph-ui-row');
                                    row.dataset.person = person.name;
                                    const main = element('div', 'rph-ui-row-main');
                                    main.append(element('strong', '', person.name), element('div', 'rph-ui-muted', person.id ? person.title || person.id : 'Fish 默认声音'));
                                    const actions = element('div', 'rph-ui-row-actions');
                                    const area = element('div');
                                    area.dataset.pick = person.name;
                                    if (canAnalyze()) {
                                        actions.appendChild(smallButton('AI 挑', async () => {
                                            area.replaceChildren(element('p', 'rph-ui-muted', '正在按世界书找声音……'));
                                            try {
                                                const { voices, reason } = await aiPick(person.name);
                                                if (voices[0]) assign(person.name, voices[0]);
                                                const fresh = castBox.querySelector(`[data-pick="${CSS.escape(person.name)}"]`);
                                                showVoices(fresh, person.name, voices, voices[0] ? `已选「${voices[0].title}」。${reason}` : reason);
                                            } catch (error) {
                                                area.replaceChildren(element('p', 'rph-ui-muted', `没挑成：${error?.message || error}`));
                                            }
                                        }));
                                    }
                                    actions.append(smallButton('搜索', () => searchBox(area, person.name)));
                                    if (person.id) actions.append(smallButton('试听', () => playSample(person.sample)));
                                    if (person.name !== NARRATOR && person.name !== character().name) {
                                        actions.append(smallButton('删除', () => {
                                            const next = readCast();
                                            saveCast({ ...next, people: next.people.filter((item) => item.name !== person.name) });
                                            renderCast();
                                        }));
                                    } else if (person.id) {
                                        actions.append(smallButton('清掉', () => assign(person.name, { id: '', title: '', sample: '' })));
                                    }
                                    row.append(main, actions);
                                    castBox.append(row, area);
                                });
                            }
                            renderCast();
                            const newPerson = body.querySelector('[data-new-person]');
                            body.querySelector('[data-add-person]').onclick = () => {
                                const name = newPerson.value.trim();
                                const cast = readCast();
                                if (!name || name === NARRATOR || cast.people.some((person) => person.name === name)) return;
                                saveCast({ ...cast, people: [...cast.people, { name }] });
                                newPerson.value = '';
                                renderCast();
                            };

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
                                const box = boxes.querySelector(`[data-box="${i}"]`);
                                box.nextElementSibling.nextElementSibling.textContent = kind.sample;
                                box.checked = !saved.some((item) => item.key === kind.key);
                                box.onchange = () => {
                                    const rest = skippedBoxes().filter((item) => item.key !== kind.key);
                                    ctx.storage.set(boxesKey(), JSON.stringify(box.checked ? rest : [...rest, kind]));
                                };
                            });

                            const previewText = body.querySelector('[data-preview-text]');
                            body.querySelector('[data-preview]').onclick = () => {
                                const message = latest();
                                previewText.textContent = message ? (segments(message).map((item) => item.text).join('\n') || '最新回复里没有要读的文字。') : '还没有 AI 回复，或者最新回复不在当前页面上。';
                                previewText.hidden = false;
                            };
                            body.querySelector('[data-try]').onclick = () => {
                                unlock();
                                const text = '你好，这是朗读的试听。语速和声音可以在上面调整。';
                                speak(() => [{ el: null, text, voice: readCast().narrator.id || '', tone: '' }], null).catch((error) => ctx.log('试听失败', error));
                            };
                        }
                    });
                }
            });
        }
    });
})();
