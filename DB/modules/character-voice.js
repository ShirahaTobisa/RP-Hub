// 角色语音：让 AI 回复里的人物开口说话（旁白、叙述不念，那是「朗读」插件的事）。
// 一次 AI 调用（插件接口 API 7 的 ctx.ai）分析每句是谁说的、用什么语气；人物的台词按「配音表」用 Fish Audio 的声音念，
// 语气写成 Fish 认的句首 [方括号]。音色从 Fish 公共声音库里挑（不占 Fish 账号的保存名额）：可以让 AI 按世界书挑，也可以自己搜、试听。
// 聊天页有个状态悬浮窗：显示最新回复分析了没有、谁说了几句、正在说谁的台词，带「分析」「播放/停止」按钮。
// 分析过的回复里，人物的每句台词画虚线，点一下能看是谁说的、什么语气，能只播这一句或从这句开始；句与句之间按 AI 给的节奏停顿。
(() => {
    'use strict';
    const DEFAULTS = { fishKey: '', fishModel: 'fish-audio/s2.1-pro-free', analysisModel: '', analyzeMode: 'click', autoPlay: '0', userLines: '0', widget: '1' };
    const FISH_SPEECH = 'https://api.fish.audio/compat/v1/audio/speech';
    const FISH_LIBRARY = 'https://api.fish.audio/model';
    const NARRATOR = '旁白';
    const DIALOGUE = '对白'; // 分析失败时引号里的话记在这名下，用 Fish 的默认声音
    const WIDGET_KEY = 'rph_voice_widget'; // 悬浮窗的位置和收起状态，每台设备单独存，不跟云同步
    const PAGE_SIZE = 20; // 手动搜声音库每页 20 个
    const LIMIT = 200; // 每段最多 200 字：太长等得久，太短请求多
    const CACHE_SIZE = 80; // 重听不重新生成（不再花钱），最多留 80 段，刷新页面后清空
    const ANALYSIS_KEEP = 40; // 每张卡最多存 40 条回复的分析结果
    const ERROR_HINTS = { 400: '多半是声音 ID 填错了', 401: '密钥不对', 402: '余额不足', 403: '密钥没有权限', 429: '请求太频繁或额度用完了' };
    const SILENT = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    const SPEAKING = 'rph-voice-speaking';
    const QUOTE = '“[^”]*”|「[^」]*」|『[^』]*』|"[^"\\n]*"';
    // 正文里不念的东西：插图、折叠块、表格、代码、按钮、隐藏的元素。
    const SKIP = 'img,svg,iframe,video,audio,canvas,picture,object,embed,pre,code,table,details,button,input,select,textarea,'
        + 'style,script,noscript,template,sup,[hidden],[aria-hidden="true"],[data-rph-image-frame],.html-card-container';
    // Fish 中文声音库里常见的标签，给 AI 挑音色时选。
    const VOICE_TAGS = 'gentle, soft, warm, calm, deep, clear, bright, crisp, breathy, raspy, smooth, high, cheerful, playful, energetic, '
        + 'enthusiastic, serious, confident, authoritative, mysterious, expressive, dramatic, intimate, empathetic, relaxed, animated, '
        + 'character-voice, anime, storytelling, ASMR';
    const ANALYZE_PROMPT = [
        '你是有声剧的配音导演。下面是一段角色扮演回复里的句子，每行开头是编号。',
        '逐行判断这一句是谁说的、该用什么语气念、念完停多久。',
        '说话人：叙述、动作、环境描写写「旁白」；人物说的话（包括心里话）写人物名字，尽量用已知人物里的名字。',
        '语气：用 2～5 个英文单词描述怎么念，比如 cheerful and teasing、whispering nervously、cold and distant。',
        '停顿：这一句念完后停几秒（0～3，可以带小数），按剧情节奏定：接得紧的对话 0.3～0.6，换人说话 0.6～1，情绪重、要留白的地方停久一点。',
        '只输出 JSON 数组，每行一项：[编号, "说话人", "语气", 停顿秒数]，不要输出别的文字。'
    ].join('\n');
    const PICK_PROMPT = [
        '你是配音选角。根据人物资料，给这个人物写在声音库里找声音的条件。',
        '只输出 JSON：{"gender":"male|female|unknown","age":"young|middle-aged|old|unknown","tags":[2～4 个英文标签],"keywords":[1～2 个中文搜索词，比如 少女、御姐、少年、大叔、老人、萝莉、正太、公子、温柔男声],"reason":"一句中文理由"}',
        `英文标签只能从这里选：${VOICE_TAGS}`
    ].join('\n');
    const ICON_TALK = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path>';
    const ICON_STOP = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path>';
    // 台词的虚线、正在说的那句的底色、点开的小卡片和悬浮窗。颜色用 RPH 自己的主题变量，深色模式跟着变。
    // 虚线和底色用浏览器的文字高亮画，不改正文的网页结构；不支持文字高亮的浏览器退回给整段标底色。
    const STYLE = `.${SPEAKING}{background:rgba(96,165,250,.18);border-radius:6px;box-shadow:0 0 0 3px rgba(96,165,250,.18)}
::highlight(rph-voice-line){text-decoration:underline dotted rgba(96,165,250,.85);text-decoration-thickness:1.5px}
::highlight(rph-voice-now){background-color:rgba(96,165,250,.28)}
.rph-voice-pop{position:fixed;z-index:60;max-width:min(300px,calc(100vw - 16px));padding:10px 12px;border-radius:12px;background:var(--c-elevated,#fff);color:var(--c-text,#111827);border:1px solid var(--c-border-soft,#e5e7eb);box-shadow:0 8px 24px rgba(0,0,0,.16);font-size:13px}
.rph-voice-pop__tone{margin:2px 0 8px;color:var(--c-text-3,#6b7280);font-size:12px;overflow-wrap:anywhere}
.rph-voice-pop__actions{display:flex;gap:6px}
.rph-voice-pop__actions>button{flex:1;min-width:0;padding:4px 8px;font-size:12px}
.rph-voice-widget{position:fixed;z-index:45;right:12px;bottom:150px;font-size:13px;color:var(--c-text,#111827)}
.rph-voice-widget[hidden]{display:none}
.rph-voice-widget__card{width:220px;padding:10px 12px;border-radius:14px;background:var(--c-elevated,#fff);border:1px solid var(--c-border-soft,#e5e7eb);box-shadow:0 8px 24px rgba(0,0,0,.14)}
.rph-voice-widget__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;cursor:move;user-select:none;touch-action:none}
.rph-voice-widget__fold{border:0;background:none;color:var(--c-text-3,#6b7280);cursor:pointer;padding:0 4px;font-size:16px;line-height:1}
.rph-voice-widget__status{margin:0 0 8px;color:var(--c-text-3,#6b7280);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.rph-voice-widget__actions{display:flex;gap:6px}
.rph-voice-widget__actions>button{flex:1;min-width:0;padding:4px 8px;font-size:12px}
.rph-voice-widget__dot{display:none;width:42px;height:42px;align-items:center;justify-content:center;border-radius:999px;border:1px solid var(--c-border-soft,#e5e7eb);background:var(--c-elevated,#fff);color:var(--c-accent-text,#2563eb);box-shadow:0 6px 18px rgba(0,0,0,.16);cursor:pointer;touch-action:none}
.rph-voice-widget.is-folded .rph-voice-widget__card{display:none}
.rph-voice-widget.is-folded .rph-voice-widget__dot{display:flex}
.rph-voice-widget.is-busy .rph-voice-widget__dot{box-shadow:0 0 0 3px rgba(96,165,250,.45),0 6px 18px rgba(0,0,0,.16)}`;

    RPHubSDK.register({
        id: 'character-voice', name: '角色语音', version: '1.1.0', requiresApi: 7,
        init(ctx) {
            const player = new Audio(); // 都用这一个播放器：手机上点过一次以后，自动播放也能出声
            const preview = new Audio(); // 声音库的试听
            const style = document.createElement('style');
            style.textContent = STYLE;
            document.head.appendChild(style);

            const get = (key) => ctx.storage.get(key) ?? DEFAULTS[key];
            const character = () => ctx.app.get('currentCharacter') || {};
            const characterId = () => character().uuid || '';
            const userName = () => ctx.app.get('user')?.name || '';
            const isNarrator = (speaker) => !speaker || speaker === NARRATOR || /narrat/i.test(speaker);
            // 要念的台词：人物说的；用户扮演的角色默认不念。
            const voiced = (speaker) => !isNarrator(speaker) && (speaker !== userName() || get('userLines') === '1');
            const readJson = (key, fallback) => {
                try { return JSON.parse(ctx.storage.get(key) || 'null') ?? fallback; } catch (_) { return fallback; }
            };

            // 配音表（按角色卡）：每个人物用哪个 Fish 声音。[{ name, id, title, sample }]。
            // 不预先放卡名（很多卡是整个世界观，卡名不是人），说话的人物由分析加进来，也可以手动加。
            const castKey = () => `cast:${characterId()}`;
            const readCast = () => readJson(castKey(), []).filter((person) => person?.name);
            const saveCast = (people) => ctx.storage.set(castKey(), JSON.stringify(people));
            // 名字完全一样优先；其次互相包含（两边都至少两个字，免得「白」对上「对白」）。
            const personOf = (speaker, people) => people.find((item) => item.name === speaker)
                || people.find((item) => item.name.length > 1 && speaker.length > 1 && (speaker.includes(item.name) || item.name.includes(speaker)));

            const plain = (el) => el.textContent.replace(/\s+/g, ' ').trim();
            // 一个块里没有句号问号、也没有引号，却有数字、冒号或竖线，多半是状态栏（「好感度：80/100」）。
            const looksLikeStatus = (text) => text.length < 300 && !/[。！？!?…“”「」『』"]/.test(text) && /[\d:：|｜]/.test(text);

            // 页面上显示出来的正文，按块切成段：{ el（所在的块）, raw（这块的原文）, nodes（每个文字节点在 raw 里从哪开始） }。
            function segments(body) {
                const list = [];
                let last = null;
                const visit = (node, block) => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        if (last?.el !== block) list.push(last = { el: block, raw: '', nodes: [] });
                        last.nodes.push({ node, start: last.raw.length });
                        last.raw += node.nodeValue;
                        return;
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(SKIP)) return;
                    if (node.tagName === 'BR') {
                        if (last) last.raw += '\n';
                        return;
                    }
                    const style = getComputedStyle(node);
                    if (style.display === 'none' || style.visibility === 'hidden') return;
                    const isBlock = !style.display.startsWith('inline');
                    if (isBlock && looksLikeStatus(plain(node))) return;
                    node.childNodes.forEach((child) => visit(child, isBlock ? node : block));
                };
                body.childNodes.forEach((child) => visit(child, body));
                return list;
            }
            // 去掉插图标记、空白并成一个空格、去掉首尾空格；at[i] 是整理后第 i 个字在原文里的位置。
            function normalize(raw) {
                const skip = new Uint8Array(raw.length);
                for (const match of raw.matchAll(/(?:rph-image-marker|image)###[\s\S]*?###/g)) skip.fill(1, match.index, match.index + match[0].length);
                let text = '';
                const at = [];
                for (let i = 0; i < raw.length; i += 1) {
                    if (skip[i]) continue;
                    if (/\s/.test(raw[i])) {
                        if (!text || text.endsWith(' ')) continue;
                        text += ' ';
                    } else {
                        text += raw[i];
                    }
                    at.push(i);
                }
                if (text.endsWith(' ')) {
                    text = text.slice(0, -1);
                    at.pop();
                }
                return { text, at };
            }

            const messageBody = (index) => document.querySelector(`[data-chat-index="${index}"] .message-content-wrapper > .markdown-body`);
            const lastReplyIndex = () => (ctx.app.get('chatHistory') || []).findLastIndex((message) => message?.role === 'assistant');
            // 一条回复按引号切成句：{ el, text, quote（是不是引号里的话）, segment, from, to（在这块原文里的位置，画线和点选用） }。
            function linesOf(index) {
                const body = messageBody(index);
                const lines = [];
                for (const segment of body ? segments(body) : []) {
                    const { text, at } = normalize(segment.raw);
                    const pieces = [];
                    let cursor = 0;
                    for (const match of text.matchAll(new RegExp(QUOTE, 'g'))) {
                        if (match.index > cursor) pieces.push([cursor, match.index, false]);
                        pieces.push([match.index, match.index + match[0].length, true]);
                        cursor = match.index + match[0].length;
                    }
                    if (cursor < text.length) pieces.push([cursor, text.length, false]);
                    for (let [start, end, quote] of pieces) {
                        while (start < end && text[start] === ' ') start += 1;
                        while (end > start && text[end - 1] === ' ') end -= 1;
                        if (start < end) lines.push({ el: segment.el, text: text.slice(start, end), quote, segment, from: at[start], to: at[end - 1] + 1 });
                    }
                }
                return lines;
            }
            // 一句话在页面上的范围（给浏览器的文字高亮用）。
            function rangeOf(line) {
                const { nodes } = line.segment;
                const locate = (offset) => {
                    let item = nodes[0];
                    for (const candidate of nodes) {
                        if (candidate.start > offset) break;
                        item = candidate;
                    }
                    return [item.node, Math.min(offset - item.start, item.node.nodeValue.length)];
                };
                const range = document.createRange();
                range.setStart(...locate(line.from));
                range.setEnd(...locate(line.to));
                return range;
            }

            // 太长的句子按逗号切成不超过 LIMIT 字的小段。
            function splitText(text) {
                const out = [];
                let current = '';
                for (const piece of text.length > LIMIT ? text.match(/[^，,；;、。！？!?]+[，,；;、。！？!?”」』"]*/g) || [text] : [text]) {
                    for (let i = 0; i < piece.length; i += LIMIT) {
                        const part = piece.slice(i, i + LIMIT);
                        if (current && (current + part).length > LIMIT) {
                            out.push(current);
                            current = '';
                        }
                        current += part;
                    }
                }
                if (current.trim()) out.push(current);
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
            const keyOf = (lines) => hash(lines.map((line) => line.text).join('\n'));

            // 分析结果按回复存进 ctx.data（随云同步），重听和别的设备不用再分析；这里留一份在内存里给悬浮窗用。
            let store = { card: null, data: {} };
            async function loadStore() {
                const card = characterId();
                if (store.card === card) return;
                const data = (await ctx.data.get(`analysis:${card}`).catch(() => null)) || {};
                if (characterId() === card) store = { card, data };
            }
            function cachedLabels(lines) {
                const saved = store.card === characterId() ? store.data[keyOf(lines)] : null;
                return Array.isArray(saved) && saved.length === lines.length ? saved.map(([speaker, tone, pause]) => ({ speaker, tone, pause })) : null;
            }

            let analyzing = null; // 正在分析的回复序号
            const failures = new Map(); // 回复序号 → 分析失败的原因
            const inflight = new Map(); // 同一条回复同时只分析一次
            // 分析失败时：引号里的用 Fish 默认声音念，其余算旁白（不念）。force 为 true 时不用存下的结果，重新分析。
            async function analyze(index, force = false) {
                const lines = linesOf(index);
                if (!lines.length) return { lines, labels: [] };
                await loadStore();
                const cached = force ? null : cachedLabels(lines);
                if (cached) return { lines, labels: cached };
                const card = characterId();
                const key = keyOf(lines);
                if (!inflight.has(key)) inflight.set(key, requestLabels(index, lines, card, key).finally(() => inflight.delete(key)));
                return { lines, labels: await inflight.get(key) };
            }
            async function requestLabels(index, lines, card, key) {
                const fallback = lines.map((line) => ({ speaker: line.quote ? DIALOGUE : NARRATOR, tone: '' }));
                analyzing = index;
                failures.delete(index);
                renderWidget();
                try {
                    if (!widgetVisible()) ctx.ui.toast('正在分析每句是谁说的、用什么语气……', { kind: 'info' });
                    const reply = await ctx.ai.complete({
                        model: get('analysisModel').trim() || undefined,
                        messages: [
                            { role: 'system', content: ANALYZE_PROMPT },
                            { role: 'user', content: `已知人物：${readCast().map((person) => person.name).join('、') || '（还没有）'}；用户扮演：${userName() || '未知'}\n\n${lines.map((line, i) => `${i + 1}. ${line.text.slice(0, 300)}`).join('\n')}` }
                        ]
                    });
                    const rows = parseJson(reply, '[');
                    if (!Array.isArray(rows)) throw new Error('AI 没有按格式回答');
                    const labels = fallback.map((item, i) => {
                        const row = rows.find((entry) => Array.isArray(entry) && Number(entry[0]) === i + 1);
                        if (!row) return item;
                        const pause = Number(row[3]);
                        return {
                            speaker: String(row[1] || '').trim() || NARRATOR,
                            tone: String(row[2] || '').replace(/[[\]]/g, '').trim().slice(0, 60),
                            pause: Number.isFinite(pause) ? Math.min(Math.max(pause, 0), 3) : null
                        };
                    });
                    if (store.card === card) {
                        store.data = { ...store.data, [key]: labels.map((label) => [label.speaker, label.tone, label.pause]) };
                        Object.keys(store.data).slice(0, -ANALYSIS_KEEP).forEach((old) => delete store.data[old]);
                        ctx.data.set(`analysis:${card}`, store.data).catch((error) => ctx.log('分析结果没存上', error));
                    }
                    // 新出现的人物（不算用户扮演的）加进配音表，等用户挑音色；挑之前用 Fish 的默认声音。
                    const people = readCast();
                    const fresh = [...new Set(labels.map((label) => label.speaker))].filter((speaker) => !isNarrator(speaker) && speaker !== userName() && !personOf(speaker, people));
                    if (fresh.length && characterId() === card) saveCast([...people, ...fresh.map((name) => ({ name }))]);
                    markRows([...document.querySelectorAll(`[data-chat-index="${index}"]`)]);
                    return labels;
                } catch (error) {
                    failures.set(index, error?.message || String(error));
                    ctx.ui.toast(`分析说话人失败：${error?.message || error}。这次引号里的话先用 Fish 的默认声音念`, { kind: 'warning' });
                    return fallback;
                } finally {
                    if (analyzing === index) analyzing = null;
                    renderWidget();
                }
            }

            // 念完一句停多久（毫秒）：AI 给了就用 AI 的；没给按上下文估——同一人接着说短一点，换人、换段、中间隔着旁白、
            // 句尾拖长（……、——）都多停一会儿。
            function pauseAfter(lines, labels, i, next) {
                if (labels[i].pause !== null && labels[i].pause !== undefined) return labels[i].pause * 1000;
                let ms = labels[next].speaker === labels[i].speaker ? 350 : 650;
                if (lines[next].el !== lines[i].el) ms += 250;
                if (next > i + 1) ms += 300;
                if (/(…|—)[”」』"]?$/.test(lines[i].text)) ms += 300;
                return ms;
            }
            // 要说的小段：只留人物说的，每句单独合成（各用各的语气），太长的句子再切开；
            // from 是从第几句开始，only 为 true 时只说这一句。每段带上念完后停多久。
            function itemsOf(lines, labels, from = 0, only = false) {
                const people = readCast();
                const picked = lines.map((_, i) => i).filter((i) => i >= from && (!only || i === from) && voiced(labels[i].speaker));
                const items = [];
                picked.forEach((i, k) => {
                    const { speaker, tone } = labels[i];
                    const voice = personOf(speaker, people)?.id || '';
                    const chunks = splitText(lines[i].text);
                    const next = picked[k + 1];
                    chunks.forEach((text, c) => items.push({
                        line: lines[i], text, voice, tone, speaker,
                        pause: c < chunks.length - 1 ? 150 : next === undefined ? 0 : pauseAfter(lines, labels, i, next)
                    }));
                });
                return items;
            }

            let session = null; // 正在说的：{ index, stopped, abort, finish, speaker }
            function stop() {
                if (session) {
                    session.stopped = true;
                    session.abort.abort();
                    session.finish?.();
                }
                session = null;
                player.pause();
                refreshButtons();
                renderWidget();
            }

            // 手机浏览器只让「点了之后」出声：第一次点按钮时先用同一个播放器放一下静音，之后自动播放也能播。
            let unlocked = false;
            function unlock() {
                if (unlocked) return;
                unlocked = true;
                player.src = SILENT;
                player.play().catch(() => {});
            }

            const cache = new Map();
            async function synthesize({ text, voice, tone }, signal) {
                const input = tone ? `[${tone}] ${text}` : text;
                const model = get('fishModel');
                const key = [model, voice, input].join('\n');
                if (cache.has(key)) return cache.get(key);
                const response = await fetch(FISH_SPEECH, {
                    method: 'POST',
                    signal,
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${get('fishKey').trim()}` },
                    body: JSON.stringify({ model, input, voice, response_format: 'mp3' })
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

            // 正在说的那句：支持文字高亮的浏览器只标这一句，否则给整段标底色。
            const highlights = globalThis.CSS?.highlights && typeof globalThis.Highlight === 'function' ? CSS.highlights : null;
            function showSpeaking(line) {
                if (highlights) {
                    if (line) highlights.set('rph-voice-now', new Highlight(rangeOf(line)));
                    else highlights.delete('rph-voice-now');
                    return;
                }
                document.querySelectorAll(`.${SPEAKING}`).forEach((el) => el.classList.remove(SPEAKING));
                line?.el.classList.add(SPEAKING);
            }
            // 句与句之间的停顿，停止时马上结束。
            const wait = (ms, current) => new Promise((resolve) => {
                const timer = setTimeout(resolve, ms);
                current.abort.signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });
            });

            // 说一条回复：没分析过先分析，再按人物的声音一句句说，句与句之间按节奏停顿；边播边生成下一段。
            // from 是从第几句开始，only 为 true 时只说这一句（点台词时用）。
            async function speak(index, { from = 0, only = false } = {}) {
                stop();
                if (!get('fishKey').trim()) return ctx.ui.toast('先在「角色语音设置」里填好 Fish Audio 的密钥', { kind: 'warning' });
                const current = session = { index, stopped: false, abort: new AbortController(), speaker: '' };
                refreshButtons();
                renderWidget();
                try {
                    const { lines, labels } = await analyze(index);
                    if (current.stopped) return;
                    const items = itemsOf(lines, labels, from, only);
                    if (!items.length) ctx.ui.toast('这条回复里没有人物说的话', { kind: 'info' });
                    const loads = [];
                    const load = (i) => (loads[i] ??= synthesize(items[i], current.abort.signal));
                    for (let i = 0; i < items.length && !current.stopped; i += 1) {
                        const blob = await load(i);
                        if (i + 1 < items.length) load(i + 1).catch(() => {});
                        if (current.stopped) break;
                        current.speaker = items[i].speaker;
                        renderWidget();
                        showSpeaking(items[i].line);
                        try {
                            await play(blob, current);
                        } finally {
                            showSpeaking(null);
                        }
                        if (items[i].pause && !current.stopped) await wait(items[i].pause, current);
                    }
                } catch (error) {
                    if (!current.stopped) {
                        ctx.ui.toast(error?.name === 'NotAllowedError' ? '浏览器拦住了自动播放，点一下「角色语音」就能听' : error?.message || String(error), { kind: 'error' });
                    }
                } finally {
                    if (session === current) {
                        session = null;
                        refreshButtons();
                        renderWidget();
                    }
                }
            }
            function toggleSpeaking(index) {
                if (session?.index === index) return stop();
                if (!messageBody(index)) return ctx.ui.toast('这条消息没有能念的文字', { kind: 'info' });
                unlock();
                speak(index).catch((error) => ctx.log('角色语音失败', error));
            }

            // 每条 AI 回复下方那排按钮里加一个「角色语音」，说话的时候变成「停止角色语音」。
            function decorate(row) {
                if (row.dataset.role !== 'assistant') return;
                const bar = row.querySelector('.message-action-bar');
                if (!bar) return;
                let button = bar.querySelector('[data-rph-voice]');
                if (!button) {
                    button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'message-action-button';
                    button.dataset.rphVoice = '';
                    button.innerHTML = '<svg class="w-3.5 h-3.5 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"></svg>';
                    button.addEventListener('click', () => toggleSpeaking(Number(button.closest('[data-chat-index]').dataset.chatIndex)));
                    bar.prepend(button);
                }
                const active = session?.index === Number(row.dataset.chatIndex);
                button.title = active ? '停止角色语音' : '角色语音';
                button.setAttribute('aria-label', button.title);
                const icon = active ? ICON_STOP : ICON_TALK;
                if (button.firstChild.innerHTML !== icon) button.firstChild.innerHTML = icon;
            }
            function refreshButtons() {
                document.querySelectorAll('[data-chat-index][data-role="assistant"]').forEach(decorate);
            }

            // ---- 分析过的回复里，人物的台词画虚线；点一下弹小卡片：谁说的、什么语气，能只播这句或从这句开始 ----
            const marks = new Map(); // 聊天行 → [{ range, index（第几条消息）, line（第几句）, speaker, tone }]
            function markRows(rows) {
                if (!highlights) return;
                for (const row of rows) {
                    marks.delete(row);
                    if (row.dataset.role !== 'assistant' || store.card !== characterId()) continue;
                    const index = Number(row.dataset.chatIndex);
                    if (index === lastReplyIndex() && ctx.app.get('isGenerating') === true) continue;
                    const lines = linesOf(index);
                    const labels = lines.length ? cachedLabels(lines) : null;
                    if (!labels) continue;
                    const found = [];
                    lines.forEach((line, i) => {
                        if (voiced(labels[i].speaker)) found.push({ range: rangeOf(line), index, line: i, speaker: labels[i].speaker, tone: labels[i].tone });
                    });
                    if (found.length) marks.set(row, found);
                }
                for (const row of marks.keys()) if (!row.isConnected) marks.delete(row);
                highlights.set('rph-voice-line', new Highlight(...[...marks.values()].flat().map((mark) => mark.range)));
            }
            const markAll = () => markRows([...document.querySelectorAll('[data-chat-index][data-role="assistant"]')]);

            let popover = null;
            function closePopover() {
                popover?.remove();
                popover = null;
            }
            function openPopover(mark, x, y) {
                closePopover();
                popover = document.createElement('div');
                popover.className = 'rph-voice-pop';
                popover.dataset.rphVoicePop = '';
                popover.innerHTML = `<strong></strong><div class="rph-voice-pop__tone"></div>
                    <div class="rph-voice-pop__actions">
                        <button type="button" class="modal-secondary-button rph-ui-button" data-one>播放这句</button>
                        <button type="button" class="modal-primary-button rph-ui-button" data-from>从这句开始</button>
                    </div>`;
                popover.querySelector('strong').textContent = mark.speaker;
                popover.querySelector('.rph-voice-pop__tone').textContent = mark.tone ? `AI 分析的语气：${mark.tone}` : 'AI 没给这句标语气';
                const start = (only) => {
                    closePopover();
                    unlock();
                    speak(mark.index, { from: mark.line, only }).catch((error) => ctx.log('角色语音失败', error));
                };
                popover.querySelector('[data-one]').onclick = () => start(true);
                popover.querySelector('[data-from]').onclick = () => start(false);
                document.body.appendChild(popover);
                // 放在点的位置下面，挤不下就放上面，左右不出屏幕。
                const { width, height } = popover.getBoundingClientRect();
                const left = Math.min(Math.max(8, x - width / 2), innerWidth - width - 8);
                const top = y + 14 + height < innerHeight ? y + 14 : Math.max(8, y - height - 14);
                Object.assign(popover.style, { left: `${left}px`, top: `${top}px` });
            }
            // 点到台词上才弹；选文字、点别处不打扰。
            document.addEventListener('click', (event) => {
                if (popover?.contains(event.target)) return;
                closePopover();
                if (!marks.size || !getSelection()?.isCollapsed) return;
                const row = event.target.closest?.('[data-chat-index]');
                const found = row && marks.get(row);
                if (!found) return;
                let node = null;
                let offset = 0;
                if (document.caretPositionFromPoint) {
                    const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
                    [node, offset] = [caret?.offsetNode, caret?.offset];
                } else if (document.caretRangeFromPoint) {
                    const caret = document.caretRangeFromPoint(event.clientX, event.clientY);
                    [node, offset] = [caret?.startContainer, caret?.startOffset];
                }
                const mark = node && found.find((item) => item.range.isPointInRange(node, offset));
                if (mark) openPopover(mark, event.clientX, event.clientY);
            });
            addEventListener('keydown', (event) => { if (event.key === 'Escape') closePopover(); });
            addEventListener('scroll', closePopover, true);

            // ---- 状态悬浮窗：聊天页右下角，能拖动、能收起成小圆点，位置记在这台设备上 ----
            let widget = null;
            const widgetVisible = () => get('widget') === '1' && ctx.app.get('currentView') === 'chat' && !!characterId();
            function saveWidgetState() {
                const rect = widget.getBoundingClientRect();
                try {
                    localStorage.setItem(WIDGET_KEY, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top), folded: widget.classList.contains('is-folded') }));
                } catch (_) { /* storage blocked */ }
            }
            function placeWidget(x, y) {
                const width = widget.offsetWidth || 220;
                const height = widget.offsetHeight || 100;
                const left = Math.min(Math.max(4, x), Math.max(4, innerWidth - width - 4));
                const top = Math.min(Math.max(4, y), Math.max(4, innerHeight - height - 4));
                Object.assign(widget.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
            }
            // 按住拖动；没怎么动就算点击。
            function draggable(handle, onClick) {
                handle.addEventListener('pointerdown', (event) => {
                    if (event.button !== 0 || event.target.closest('[data-collapse]')) return;
                    const rect = widget.getBoundingClientRect();
                    const start = { x: event.clientX, y: event.clientY };
                    let moved = false;
                    handle.setPointerCapture?.(event.pointerId);
                    const move = (next) => {
                        const dx = next.clientX - start.x;
                        const dy = next.clientY - start.y;
                        if (!moved && Math.hypot(dx, dy) < 5) return;
                        moved = true;
                        placeWidget(rect.left + dx, rect.top + dy);
                    };
                    const end = () => {
                        handle.removeEventListener('pointermove', move);
                        handle.removeEventListener('pointerup', end);
                        handle.removeEventListener('pointercancel', end);
                        if (moved) saveWidgetState(); else onClick?.();
                    };
                    handle.addEventListener('pointermove', move);
                    handle.addEventListener('pointerup', end);
                    handle.addEventListener('pointercancel', end);
                });
            }
            function setFolded(folded) {
                widget.classList.toggle('is-folded', folded);
                const rect = widget.getBoundingClientRect();
                if (widget.style.left) placeWidget(rect.left, rect.top);
                saveWidgetState();
            }
            function ensureWidget() {
                if (widget) return widget;
                widget = document.createElement('div');
                widget.className = 'rph-voice-widget';
                widget.dataset.rphVoiceWidget = '';
                widget.hidden = true;
                widget.innerHTML = `
                    <button type="button" class="rph-voice-widget__dot" data-expand title="角色语音" aria-label="展开角色语音"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">${ICON_TALK}</svg></button>
                    <div class="rph-voice-widget__card">
                        <div class="rph-voice-widget__head" data-drag><strong>角色语音</strong><button type="button" class="rph-voice-widget__fold" data-collapse title="收起" aria-label="收起">－</button></div>
                        <p class="rph-voice-widget__status" data-status></p>
                        <div class="rph-voice-widget__actions">
                            <button type="button" class="modal-secondary-button rph-ui-button" data-analyze>分析</button>
                            <button type="button" class="modal-primary-button rph-ui-button" data-play>播放</button>
                        </div>
                    </div>`;
                document.body.appendChild(widget);
                let saved = null;
                try { saved = JSON.parse(localStorage.getItem(WIDGET_KEY) || 'null'); } catch (_) { /* storage blocked */ }
                if (saved?.folded) widget.classList.add('is-folded');
                if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) placeWidget(saved.x, saved.y);
                draggable(widget.querySelector('[data-drag]'));
                draggable(widget.querySelector('[data-expand]'), () => setFolded(false));
                widget.querySelector('[data-collapse]').onclick = () => setFolded(true);
                widget.querySelector('[data-analyze]').onclick = () => {
                    const index = lastReplyIndex();
                    if (index >= 0) analyze(index, true).catch((error) => ctx.log('分析失败', error));
                };
                widget.querySelector('[data-play]').onclick = () => {
                    if (session) return stop();
                    const index = lastReplyIndex();
                    if (index >= 0) toggleSpeaking(index);
                };
                addEventListener('resize', () => {
                    if (widget.style.left) placeWidget(parseFloat(widget.style.left), parseFloat(widget.style.top));
                });
                return widget;
            }
            function renderWidget() {
                const root = ensureWidget();
                root.hidden = !widgetVisible();
                if (root.hidden) return;
                if (store.card !== characterId()) loadStore().then(renderWidget, () => {});
                const status = root.querySelector('[data-status]');
                const analyzeButton = root.querySelector('[data-analyze]');
                const playButton = root.querySelector('[data-play]');
                const index = lastReplyIndex();
                const generating = ctx.app.get('isGenerating') === true;
                root.classList.toggle('is-busy', !!session || analyzing !== null);
                playButton.textContent = session ? '停止' : '播放';
                playButton.disabled = !session && (generating || index < 0);
                analyzeButton.textContent = '分析';
                analyzeButton.disabled = generating || index < 0 || analyzing !== null;
                if (analyzing !== null) return void (status.textContent = '正在分析每句是谁说的……');
                if (session) return void (status.textContent = `正在说：${session.speaker || '……'}`);
                if (generating) return void (status.textContent = '等回复写完……');
                if (index < 0) return void (status.textContent = '还没有 AI 回复');
                const lines = linesOf(index);
                const labels = cachedLabels(lines);
                if (!labels) {
                    status.textContent = failures.has(index) ? `分析失败：${failures.get(index)}` : (lines.length ? '最新回复还没分析' : '最新回复里没有能念的文字');
                    return;
                }
                analyzeButton.textContent = '重新分析';
                const counts = new Map();
                labels.forEach(({ speaker }) => { if (voiced(speaker)) counts.set(speaker, (counts.get(speaker) || 0) + 1); });
                status.textContent = counts.size ? `最新回复：${[...counts].map(([name, count]) => `${name} ${count} 句`).join(' · ')}` : '最新回复里没有人物台词';
            }

            ctx.events.on('chat-mutation', ({ dirtyRows }) => {
                try {
                    dirtyRows.forEach(decorate);
                    markRows(dirtyRows);
                    renderWidget();
                } catch (error) {
                    ctx.log('角色语音按钮没加上', error);
                }
            });
            ctx.events.on('generation-start', () => {
                try {
                    if (session) stop(); else renderWidget();
                } catch (error) {
                    ctx.log('停止角色语音失败', error);
                }
            });
            // 回复结束：开了自动说就分析并说；只开了自动分析就只分析。同一条只自动处理一次（工具调用续写变长了会再来）。
            let lastAuto = null;
            ctx.events.on('generation-end', () => {
                renderWidget();
                if (get('autoPlay') !== '1' && get('analyzeMode') !== 'auto') return;
                setTimeout(() => {
                    try {
                        const index = lastReplyIndex();
                        const history = ctx.app.get('chatHistory') || [];
                        const message = history[index];
                        if (index < 0 || index !== history.length - 1 || message.responseError || ctx.app.get('isGenerating')) return;
                        const key = `${message.id ?? index}:${String(message.content || '').length}`;
                        if (key === lastAuto) return;
                        lastAuto = key;
                        if (get('autoPlay') === '1') speak(index).catch((error) => ctx.log('自动角色语音失败', error));
                        else analyze(index).catch((error) => ctx.log('自动分析失败', error));
                    } catch (error) {
                        ctx.log('自动角色语音失败', error);
                    }
                }, 800);
            });
            ctx.app.watch(() => [characterId(), ctx.app.get('currentView')], ([id], [previousId] = []) => {
                if (session && id !== previousId) stop();
                closePopover();
                renderWidget();
                loadStore().then(markAll, () => {});
            });
            refreshButtons();
            renderWidget();
            loadStore().then(markAll, () => {});

            // ---- 挑音色：Fish 公共声音库（不用密钥，网页能直接搜），用库里的声音不占 Fish 账号的保存名额 ----
            const toVoice = (item) => ({ id: item._id, title: item.title || item._id, tags: (item.tags || []).slice(0, 5), sample: item.samples?.[0]?.audio || '' });
            // 搜一页中文声音，按热度排；返回 Fish 原样的 { items, total }。
            async function libraryPage({ title = '', tags = [], page = 1 }) {
                const url = new URL(FISH_LIBRARY);
                url.searchParams.set('page_size', String(PAGE_SIZE));
                url.searchParams.set('page_number', String(page));
                url.searchParams.set('sort_by', 'score');
                url.searchParams.set('language', 'zh');
                if (title) url.searchParams.set('title', title);
                tags.filter((tag) => tag && tag !== 'unknown').forEach((tag) => url.searchParams.append('tag', tag));
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Fish 声音库搜索失败（${response.status}）`);
                return response.json();
            }
            async function searchPage(title, page) {
                const data = await libraryPage({ title, page });
                return { voices: (data.items || []).filter((item) => item?._id).map(toVoice), total: Number(data.total) || 0 };
            }
            // AI 挑：几组条件各搜一页，合在一起按对得上的程度排，取前 8 个。
            async function searchLibrary(queries, want = {}) {
                const found = new Map();
                for (const query of queries) {
                    for (const item of (await libraryPage(query)).items || []) if (item?._id && !found.has(item._id)) found.set(item._id, item);
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

            // 分析用的模型列表：和 RPH 自己获取模型一样，用站点的 AI 接口和密钥去取，去掉嵌入模型。
            let models = null;
            async function listModels() {
                const settings = ctx.app.get('settings') || {};
                const endpoint = globalThis.RPHubApiUtils?.buildApiEndpoint;
                const client = globalThis.RPHubApiClient;
                if (!endpoint || !client?.requestJson) throw new Error('这个版本的 RPH 取不到模型列表');
                const apiKey = String(settings.apiKey || '').trim();
                if (!apiKey) throw new Error('先在 RPH 设置里填好 AI 接口的密钥');
                const data = await client.requestJson({ url: endpoint(settings.apiUrl, 'models'), apiKey });
                return (data?.data || []).map((model) => String(model?.id || '')).filter((id) => id && !/embedding/i.test(id));
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
                const reply = await ctx.ai.complete({
                    model: get('analysisModel').trim() || undefined,
                    messages: [{ role: 'system', content: PICK_PROMPT }, { role: 'user', content: `人物：${name}\n资料：\n${aboutPerson(name) || '（世界书里没找到这个人的资料，按名字推测）'}` }]
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

            ctx.ui.addComposerButton({
                label: '让人物说出最新回复里的台词（说话中再点一下停止）',
                text: '语音',
                onClick() {
                    if (session) return stop();
                    const index = lastReplyIndex();
                    if (index < 0) return ctx.ui.toast('还没有 AI 回复', { kind: 'info' });
                    toggleSpeaking(index);
                }
            });

            ctx.ui.addSidebarEntry({
                label: '角色语音设置',
                onClick() {
                    ctx.ui.openPanel({
                        title: '角色语音',
                        render(body) {
                            // 样式类名见 WORKSHOP-MOD-GUIDE.md「面板样式」，跟随页面主题和深色模式。
                            // 密钥框不用 type=password：浏览器会把它当成网站登录密码，配音表一重画就弹「要更新密码吗」，点了还会把站点密码换成 Fish 密钥。
                            const toggle = (key, label) => `<div class="rph-ui-field"><label class="rph-ui-check" style="white-space:normal"><input type="checkbox" class="settings-toggle-input sr-only" data-k="${key}"><span class="settings-toggle" style="flex-shrink:0"></span><span>${label}</span></label></div>`;
                            body.innerHTML = `
                                <p class="rph-ui-muted">让回复里的人物开口说话：AI 分析每句是谁说的、用什么语气，人物的台词按下面的配音表用 Fish Audio 的声音念。旁白和叙述不念。</p>
                                <label class="rph-ui-field">Fish Audio 密钥<input class="rph-ui-input" type="text" data-k="fishKey" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" style="-webkit-text-security:disc" placeholder="在 fish.audio 的开发者页面申请"></label>
                                <label class="rph-ui-field">模型<select class="rph-ui-input" data-k="fishModel">
                                    <option value="fish-audio/s2.1-pro-free">S2.1 Pro 免费版</option>
                                    <option value="fish-audio/s2.1-pro">S2.1 Pro（按字数收费）</option>
                                </select></label>
                                <p class="rph-ui-muted">免费版和收费版是同一个模型，但 Fish 说免费版的请求可能会被留下来改进模型。密钥会随云同步存进你自己的存储桶。</p>
                                <label class="rph-ui-field">分析用的模型<select class="rph-ui-input" data-k="analysisModel"></select></label>
                                <div class="rph-ui-actions" style="justify-content:space-between;align-items:center;margin:-0.25rem 0 0.75rem"><span class="rph-ui-muted" data-models-note></span><button type="button" class="modal-secondary-button rph-ui-button" data-refresh-models>刷新模型列表</button></div>
                                <label class="rph-ui-field">什么时候分析<select class="rph-ui-input" data-k="analyzeMode">
                                    <option value="click">点「分析」或播放时才分析</option>
                                    <option value="auto">每条回复结束后自动分析</option>
                                </select></label>
                                <p class="rph-ui-muted">每条回复分析一次（一次 AI 调用），结果会存下来，重听不再分析。</p>
                                ${toggle('autoPlay', '回复结束后自动说')}
                                ${toggle('userLines', '你扮演的角色的台词也念')}
                                ${toggle('widget', '在聊天页显示状态悬浮窗')}
                                <section class="rph-ui-section">
                                    <h3>配音表（只对当前角色卡）</h3>
                                    <p class="rph-ui-muted">点悬浮窗的「分析」后，回复里说话的人物会自己加进来；也可以在下面手动添加。音色从 Fish 公共声音库里挑，不占你 Fish 账号的保存名额，没挑的用 Fish 的默认声音。</p>
                                    <div data-cast></div>
                                    <div class="rph-ui-actions" style="margin-top:0.75rem"><input class="rph-ui-input" data-new-person placeholder="人物名字" style="flex:1;min-width:0"><button type="button" class="modal-secondary-button rph-ui-button" data-add-person>添加人物</button></div>
                                </section>`;

                            // 分析用的模型：从站点的 AI 接口取模型列表（和 RPH 自己获取模型一样，去掉嵌入模型），这次打开页面只取一次。
                            const modelSelect = body.querySelector('[data-k="analysisModel"]');
                            const modelsNote = body.querySelector('[data-models-note]');
                            const fillModels = () => {
                                const saved = get('analysisModel');
                                const list = models || [];
                                modelSelect.replaceChildren(new Option('跟随 RPH 的分析模型（没设就用主模型）', ''), ...list.map((id) => new Option(id, id)));
                                if (saved && !list.includes(saved)) modelSelect.appendChild(new Option(`${saved}（不在列表里）`, saved));
                                modelSelect.value = saved;
                            };
                            const loadModels = async () => {
                                modelsNote.textContent = '正在获取模型列表……';
                                try {
                                    models = await listModels();
                                    modelsNote.textContent = `共 ${models.length} 个模型`;
                                } catch (error) {
                                    modelsNote.textContent = `获取模型列表失败：${error?.message || error}`;
                                }
                                fillModels();
                            };
                            fillModels();
                            if (models) modelsNote.textContent = `共 ${models.length} 个模型`; else loadModels();
                            body.querySelector('[data-refresh-models]').onclick = loadModels;

                            // 设置项改了立即保存。
                            body.querySelectorAll('[data-k]').forEach((field) => {
                                const key = field.dataset.k;
                                const value = () => (field.type === 'checkbox' ? (field.checked ? '1' : '0') : field.value);
                                const save = () => {
                                    ctx.storage.set(key, value());
                                    renderWidget();
                                };
                                if (field.type === 'checkbox') field.checked = get(key) === '1'; else field.value = get(key);
                                field.addEventListener('input', save);
                                field.addEventListener('change', save);
                            });

                            // 配音表：每行一个人物，可以让 AI 挑、自己搜、试听、清掉或删除。
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
                                saveCast(readCast().map((person) => (person.name === name ? { name, id: voice.id, title: voice.title, sample: voice.sample } : person)));
                                renderCast();
                            };
                            // 一个候选声音：能试听、选用。
                            const voiceRow = (name, voice) => {
                                const row = element('div', 'rph-ui-row');
                                row.dataset.voiceId = voice.id;
                                const main = element('div', 'rph-ui-row-main');
                                main.append(element('strong', '', voice.title), element('div', 'rph-ui-muted', voice.tags.join(' · ')));
                                const actions = element('div', 'rph-ui-row-actions');
                                actions.append(smallButton('试听', () => playSample(voice.sample)), smallButton('用这个', () => assign(name, voice)));
                                row.append(main, actions);
                                return row;
                            };
                            const showVoices = (area, name, voices, note = '') => {
                                area.replaceChildren();
                                if (note) area.appendChild(element('p', 'rph-ui-muted', note));
                                if (!voices.length) area.appendChild(element('p', 'rph-ui-muted', '没找到合适的声音，换个词搜搜。'));
                                voices.forEach((voice) => area.appendChild(voiceRow(name, voice)));
                            };
                            // 自己搜：每页 20 个，写出一共多少个，底下「加载更多」往后翻。
                            const searchBox = (area, name) => {
                                area.replaceChildren();
                                const form = element('div', 'rph-ui-actions');
                                form.style.marginTop = '0.5rem';
                                const input = element('input', 'rph-ui-input');
                                input.placeholder = '搜声音，比如 少女、御姐、大叔';
                                input.style.cssText = 'flex:1;min-width:0';
                                const results = element('div');
                                let page = 0;
                                const more = smallButton('加载更多', () => load(false));
                                more.style.marginTop = '0.5rem';
                                const load = async (fresh) => {
                                    if (fresh) {
                                        page = 0;
                                        results.replaceChildren(element('p', 'rph-ui-muted', '正在搜……'));
                                    }
                                    more.disabled = true;
                                    try {
                                        const { voices, total } = await searchPage(input.value.trim(), page + 1);
                                        page += 1;
                                        if (fresh) results.replaceChildren(element('p', 'rph-ui-muted', total ? `一共 ${total} 个声音` : '没找到声音，换个词搜搜。'));
                                        more.remove();
                                        voices.forEach((voice) => results.appendChild(voiceRow(name, voice)));
                                        if (page * PAGE_SIZE < total) results.appendChild(more);
                                    } catch (error) {
                                        results.replaceChildren(element('p', 'rph-ui-muted', error?.message || String(error)));
                                    } finally {
                                        more.disabled = false;
                                    }
                                };
                                input.onkeydown = (event) => { if (event.key === 'Enter') load(true); };
                                form.append(input, smallButton('搜索', () => load(true)));
                                area.append(form, results);
                                input.focus();
                            };
                            function renderCast() {
                                castBox.replaceChildren();
                                const people = readCast();
                                if (!people.length) castBox.appendChild(element('p', 'rph-ui-muted', '还没有人物。'));
                                people.forEach((person) => {
                                    const row = element('div', 'rph-ui-row');
                                    row.dataset.person = person.name;
                                    const main = element('div', 'rph-ui-row-main');
                                    main.append(element('strong', '', person.name), element('div', 'rph-ui-muted', person.id ? person.title || person.id : 'Fish 默认声音'));
                                    const actions = element('div', 'rph-ui-row-actions');
                                    const area = element('div');
                                    area.dataset.pick = person.name;
                                    area.style.marginBottom = '0.5rem';
                                    actions.append(smallButton('AI 挑', async () => {
                                        area.replaceChildren(element('p', 'rph-ui-muted', '正在按世界书找声音……'));
                                        try {
                                            const { voices, reason } = await aiPick(person.name);
                                            if (voices[0]) assign(person.name, voices[0]);
                                            const fresh = castBox.querySelector(`[data-pick="${CSS.escape(person.name)}"]`);
                                            showVoices(fresh, person.name, voices, voices[0] ? `已选「${voices[0].title}」。${reason}` : reason);
                                        } catch (error) {
                                            area.replaceChildren(element('p', 'rph-ui-muted', `没挑成：${error?.message || error}`));
                                        }
                                    }), smallButton('搜索', () => searchBox(area, person.name)));
                                    if (person.id) actions.append(smallButton('试听', () => playSample(person.sample)));
                                    actions.append(smallButton('删除', () => {
                                        saveCast(readCast().filter((item) => item.name !== person.name));
                                        renderCast();
                                    }));
                                    row.append(main, actions);
                                    castBox.append(row, area);
                                });
                            }
                            renderCast();
                            const newPerson = body.querySelector('[data-new-person]');
                            body.querySelector('[data-add-person]').onclick = () => {
                                const name = newPerson.value.trim();
                                const people = readCast();
                                if (!name || name === NARRATOR || people.some((person) => person.name === name)) return;
                                saveCast([...people, { name }]);
                                newPerson.value = '';
                                renderCast();
                            };
                        }
                    });
                }
            });
        }
    });
})();
