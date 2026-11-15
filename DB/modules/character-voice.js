// 角色语音：让 AI 回复里的人物开口说话（旁白、叙述不念，那是「朗读」插件的事）。
// 一次 AI 调用（插件接口 API 7 的 ctx.ai）分析每句是谁说的、用什么语气；人物的台词按「配音表」里各自的声音念。
// 语音接口两种：Fish Audio（官方，或 new-api、fish2api 这类中转；语气写成句首 [方括号]，音色从公共声音库里让 AI 挑、自己搜，或粘贴声音 ID），
// 和 OpenAI 语音格式的接口（声音填名字）。人物的声音可以标语言：分析时顺便把这个人的台词译过去，念译文，页面上标的还是原文。
// 聊天页有个状态悬浮窗：显示最新回复分析了没有、谁说了几句、正在说谁的台词，带「分析」「播放/停止」，说话时多出上一句、暂停、下一句。
// 分析过的回复里，人物的每句台词画虚线，点一下能看是谁说的、什么语气，能只播这一句或从这句开始；句与句之间按 AI 给的节奏停顿。
(() => {
    'use strict';
        // 延迟朗读只属于触发它的角色和回复；切卡、换回复或再次生成就取消。
    function onReplyReady(ctx, { enabled, latest, run, label }) {
        let timer, last;
        const cardId = () => ctx.app.get('currentCharacter')?.uuid || '';
        const cancel = () => { clearTimeout(timer); };
        ctx.events.on('generation-start', cancel);
        ctx.app.watch(cardId, cancel);
        ctx.events.on('generation-end', () => {
            cancel();
            if (!enabled()) return;
            const card = cardId(), index = latest();
            const message = ctx.app.get('chatHistory')?.[index];
            if (!card || !message) return;
            const id = message.id ?? index, content = String(message.content || '');
            timer = setTimeout(() => {
                const history = ctx.app.get('chatHistory') || [];
                const current = history[index];
                if (!enabled() || cardId() !== card || !current || (current.id ?? index) !== id
                    || index !== history.length - 1 || String(current.content || '') !== content
                    || current.responseError || ctx.app.get('isGenerating')) return;
                if (last?.card === card && last.id === id && last.content === content) return;
                last = { card, id, content };
                try { Promise.resolve(run(index)).catch(error => ctx.log(label, error)); }
                catch (error) { ctx.log(label, error); }
            }, 800);
        });
    }

    const DEFAULTS = {
        provider: 'fish', fishUrl: '', fishKey: '', fishModel: 'fish-audio/s2.1-pro-free',
        openaiTemplate: 'openai', openaiUrl: 'https://api.openai.com', openaiKey: '', openaiModel: 'gpt-4o-mini-tts', openaiVoice: '', openaiTone: 'instructions', openaiFormat: 'mp3',
        analysisModel: '', analyzeMode: 'click', autoPlay: '0', continuous: '0', userLines: '0', widget: '1', volume: '1', speed: '1'
    };
    const FISH = 'https://api.fish.audio';
    const FISH_LIBRARY = `${FISH}/model`;
    // OpenAI 语音格式的常用接口（都允许网页直接调用）：选一家就填好地址、模型、语气怎么传和声音名，密钥自己填。
    const TEMPLATES = [
        { id: 'openai', label: 'OpenAI 官方', url: 'https://api.openai.com', model: 'gpt-4o-mini-tts', tone: 'instructions',
            voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] },
        { id: 'siliconflow', label: '硅基流动（CosyVoice2）', url: 'https://api.siliconflow.cn', model: 'FunAudioLLM/CosyVoice2-0.5B', tone: 'none',
            voices: ['alex', 'benjamin', 'charles', 'david', 'anna', 'bella', 'claire', 'diana'].map((name) => `FunAudioLLM/CosyVoice2-0.5B:${name}`) },
        { id: 'groq', label: 'Groq（Orpheus，英文）', url: 'https://api.groq.com/openai', model: 'canopylabs/orpheus-v1-english', tone: 'bracket', format: 'wav',
            voices: ['troy', 'autumn', 'diana', 'hannah', 'austin', 'daniel'] },
        { id: 'custom', label: '自定义', url: '', model: '', tone: 'instructions', voices: [] }
    ];
    // 声音念什么语言：没选就是跟正文一样；选了别的，分析时把这个人的台词译过去。
    const LANGS = { zh: '中文', ja: '日文', en: '英文', ko: '韩文', de: '德文', fr: '法文', es: '西班牙文', ru: '俄文', pt: '葡萄牙文', it: '意大利文' };
    // 没有试听的声音点「试听」时现合成的一句。
    const SAMPLES = { ja: 'これは試聴用の一文です。声の雰囲気を確かめてください。', en: 'This is a short sample sentence, just to hear how this voice sounds.', ko: '이것은 시청용 문장입니다. 목소리 분위기를 확인해 보세요.' };
    const SAMPLE = '这是一句试听用的话，听听这个声音合不合适。';
    const RANGE_CLASS = 'compact-range w-full h-1.5 bg-primary-100 rounded-lg appearance-none cursor-pointer accent-primary-500'; // RPH 自己的滑块样式
    const NARRATOR = '旁白';
    const DIALOGUE = '对白'; // 分析失败时引号里的话记在这名下，用默认声音
    const WIDGET_KEY = 'rph_voice_widget'; // 悬浮窗的位置和收起状态，每台设备单独存，不跟云同步
    const PAGE_SIZE = 20; // 手动搜声音库每页 20 个
    const LIMIT = 200; // 每段最多 200 字：太长等得久，太短请求多
    const CACHE_SIZE = 80; // 重听不重新生成（不再花钱），最多留 80 段，刷新页面后清空
    const ANALYSIS_KEEP = 40; // 每张卡最多存 40 条回复的分析结果
    const ERROR_HINTS = { 400: '多半是声音或模型填错了', 401: '密钥不对', 402: '余额不足', 403: '密钥没有权限', 429: '请求太频繁或额度用完了' };
    const TIMEOUT = 60000; // 接口一分钟没回应算超时
    const RETRYABLE = [429, 500, 502, 503, 504]; // 等一下多半就好的错，自动再试一次
    const SKIPPABLE = [400, 408, 422, ...RETRYABLE]; // 只坏这一句的错（内容被拒、超时、重试后还是不行）：跳过接着说
    // AI 回的配音表里的一行。整段解析不了时（多说了话、少了括号）就一行行捞。
    const ROW = /\[\s*\d+\s*,\s*"(?:\\.|[^"\\])*"\s*,\s*"(?:\\.|[^"\\])*"(?:\s*,\s*\d+(?:\.\d+)?)?(?:\s*,\s*"(?:\\.|[^"\\])*")?\s*\]/g;
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
    // translate：有人物的声音标了别的语言时，每行多要一项译文。
    const analyzePrompt = (translate) => `你是一部有声剧的配音导演。下面是一段角色扮演正文，已按行编号，每行开头标了类型（对白 / 叙述）。请判断每一行由谁来念、用什么语气念、念完停多久，列出配音表。

判断说话人：
1. 第三人称的叙述、环境和动作描写、系统提示、作者的话，不是人物自己念的，说话人写「${NARRATOR}」。
2. 引号里的话是人物开口说的。先看前后有没有「某某说」「她笑道」「他压低声音」这类提示，有就用那个人；没有就按上下文推断：谁在场、上一句是谁说的（对话通常轮流）、称呼和口吻、内容符合谁的身份。
3. 人物的心理活动、内心独白、自言自语，以及没加引号但明显是人物在说或在想的话（比如单独一行的「你……能听到吗？」、喊话、诗句），都算那个人物自己念，不算「${NARRATOR}」；语气写得轻一些，比如 soft inner voice、murmuring to herself、whispering。
4. 一行里既有叙述又夹着一小段人物的话，按说话的那个人物算。
5. 同一个人全文只用一个名字，优先用「已知人物」里的写法；正文里的外号、代称（她、少女、红龙）都换成本名。用户扮演的角色说的话，说话人写用户的名字。
6. 实在分不清是谁，写「${NARRATOR}」，不要编造正文里没有的名字。

语气：
7. 语气是给配音演员的指令，用 2 到 6 个英文单词写清情绪和说法，例如 soft and gentle、angry shouting、whispering nervously、teasing with a smirk、cold and indifferent、tearful and pleading、breathless and flustered、cheerful and energetic。
8. 要贴合这一句的内容和前后文，同一个人在不同句子可以不同，不要千篇一律。
9. 「${NARRATOR}」的语气固定写 calm narration。

停顿：
10. 这一句念完后停几秒（0～3，可以带小数），按剧情节奏定：接得紧的对话 0.3～0.6，换人说话 0.6～1，情绪重、要留白的地方停久一点。
${translate ? `
翻译：
11. 「声音语言」里列出的人物，把他的每句台词译成那种语言，填在第 5 项：自然口语、保留语气和称呼、不加解释、不加引号。这句本来就是那种语言，或者说话人没有列出，第 5 项留空。
` : ''}
输出：
只输出一个 JSON 数组，不要解释、不要 Markdown 代码块。每个元素是 [行号, "说话人", "语气", 停顿秒数${translate ? ', "译文"' : ''}]，行号从 1 开始，正文有几行就要有几个元素，不能漏也不能重复。
示例：[[1,"${NARRATOR}","calm narration",0.5${translate ? ',""' : ''}],[2,"阿玲","playful and feigning sternness",0.8${translate ? ',"もう、覗き見は入場料を取るわよ！"' : ''}]]`;
    const PICK_PROMPT = [
        '你是配音选角。根据人物资料，给这个人物写在声音库里找声音的条件。',
        '只输出 JSON：{"gender":"male|female|unknown","age":"young|middle-aged|old|unknown","tags":[2～4 个英文标签],"keywords":[1～2 个中文搜索词，比如 少女、御姐、少年、大叔、老人、萝莉、正太、公子、温柔男声],"reason":"一句中文理由"}',
        `英文标签只能从这里选：${VOICE_TAGS}`
    ].join('\n');
    const TALK_PATH = 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z';
    const GEAR_PATHS = ['M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z', 'M15 12a3 3 0 11-6 0 3 3 0 016 0z'];
    const PEOPLE_PATH = 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z';
    const SPEAKER_PATH = 'M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z';
    const SWAP_PATH = 'M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4';
    const icon = (paths, className) => `<svg class="${className}" fill="none" stroke="currentColor" viewBox="0 0 24 24">${paths.map((d) => `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${d}"></path>`).join('')}</svg>`;
    const ICON_TALK = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${TALK_PATH}"></path>`;
    const ICON_STOP = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"></path>';
    // 台词的虚线、正在说的那句的底色、点开的小卡片和悬浮窗。颜色用 RPH 自己的主题变量，深色模式跟着变。
    // 虚线和底色用浏览器的文字高亮画，不改正文的网页结构；不支持文字高亮的浏览器退回给整段标底色。
    const STYLE = `.${SPEAKING}{background:rgba(96,165,250,.18);border-radius:6px;box-shadow:0 0 0 3px rgba(96,165,250,.18)}
::highlight(rph-voice-line){text-decoration:underline dotted rgba(96,165,250,.85);text-decoration-thickness:1.5px}
::highlight(rph-voice-now){background-color:rgba(96,165,250,.28)}
.rph-voice-pop{position:fixed;z-index:60;max-width:min(300px,calc(100vw - 16px));padding:10px 12px;border-radius:12px;background:var(--c-elevated,#fff);color:var(--c-text,#111827);border:1px solid var(--c-border-soft,#e5e7eb);box-shadow:0 8px 24px rgba(0,0,0,.16);font-size:13px}
.rph-voice-pop__tone,.rph-voice-pop__said{margin:2px 0 8px;color:var(--c-text-3,#6b7280);font-size:12px;overflow-wrap:anywhere}
.rph-voice-pop__said:empty{display:none}
.rph-voice-pop__actions{display:flex;gap:6px}
.rph-voice-pop__actions>button{flex:1;min-width:0;padding:4px 8px;font-size:12px}
.rph-voice-widget{position:fixed;z-index:45;right:12px;bottom:150px;font-size:13px;color:var(--c-text,#111827)}
.rph-voice-widget[hidden]{display:none}
.rph-voice-widget__card{width:220px;padding:10px 12px;border-radius:14px;background:var(--c-elevated,#fff);border:1px solid var(--c-border-soft,#e5e7eb);box-shadow:0 8px 24px rgba(0,0,0,.14)}
.rph-voice-widget__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;cursor:move;user-select:none;touch-action:none}
.rph-voice-widget__tools{display:flex;align-items:center;gap:2px}
.rph-voice-widget__fold{display:inline-flex;align-items:center;border:0;background:none;color:var(--c-text-3,#6b7280);cursor:pointer;padding:0 4px;font-size:16px;line-height:1}
.rph-voice-widget__status{margin:0 0 8px;color:var(--c-text-3,#6b7280);font-size:12px;line-height:1.5;overflow-wrap:anywhere}
.rph-voice-widget__actions{display:flex;gap:6px}
.rph-voice-widget__actions[hidden]{display:none}
.rph-voice-widget__actions+.rph-voice-widget__actions{margin-top:6px}
.rph-voice-widget__actions>button{flex:1;min-width:0;padding:4px 8px;font-size:12px}
.rph-voice-widget__dot{display:none;width:42px;height:42px;align-items:center;justify-content:center;border-radius:999px;border:1px solid var(--c-border-soft,#e5e7eb);background:var(--c-elevated,#fff);color:var(--c-accent-text,#2563eb);box-shadow:0 6px 18px rgba(0,0,0,.16);cursor:pointer;touch-action:none}
.rph-voice-widget.is-folded .rph-voice-widget__card{display:none}
.rph-voice-widget.is-folded .rph-voice-widget__dot{display:flex}
.rph-voice-widget.is-busy .rph-voice-widget__dot{box-shadow:0 0 0 3px rgba(96,165,250,.45),0 6px 18px rgba(0,0,0,.16)}`;

    RPHubSDK.register({
        id: 'character-voice', name: '角色语音', version: '1.3.0', requiresApi: 7,
        init(ctx) {
            const player = new Audio(); // 都用这一个播放器：手机上点过一次以后，自动播放也能出声
            const preview = new Audio(); // 声音库的试听
            const style = document.createElement('style');
            style.textContent = STYLE;
            document.head.appendChild(style);

            const get = (key) => ctx.storage.get(key) ?? DEFAULTS[key];
            // 语音接口：Fish（地址留空是官方，也可以填中转）或 OpenAI 语音格式的接口。
            const isFish = () => get('provider') === 'fish';
            const fishUrl = () => get('fishUrl').trim() || FISH;
            const official = () => {
                try { return new URL(fishUrl()).origin === FISH; } catch (_) { return false; }
            };
            const template = () => TEMPLATES.find((item) => item.id === get('openaiTemplate')) || TEMPLATES.at(-1);
            // 音量、语速：存的值不对就用默认的。
            const numberOf = (key, min, max) => {
                const value = Number(get(key));
                return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : Number(DEFAULTS[key]);
            };
            // 语速直接变速，不用重新合成。换一段语音时浏览器会把语速改回 1，所以每次开始放都要再设一遍。
            const tune = () => {
                player.volume = numberOf('volume', 0, 1);
                player.playbackRate = numberOf('speed', 0.5, 2);
            };
            let openSettings = () => {};
            const character = () => ctx.app.get('currentCharacter') || {};
            const characterId = () => character().uuid || '';
            const userName = () => ctx.app.get('user')?.name || '';
            const isNarrator = (speaker) => !speaker || speaker === NARRATOR || /narrat/i.test(speaker);
            // 要念的台词：人物说的；用户扮演的角色默认不念。
            const voiced = (speaker) => !isNarrator(speaker) && (speaker !== userName() || get('userLines') === '1');
            const readJson = (key, fallback) => {
                try { return JSON.parse(ctx.storage.get(key) || 'null') ?? fallback; } catch (_) { return fallback; }
            };

            // 配音表（按角色卡）：每个人物用哪个声音、念什么语言。[{ name, id, title, sample, lang, provider }]。
            // 不预先放卡名（很多卡是整个世界观，卡名不是人），说话的人物由分析加进来，也可以手动加。
            const castKey = () => `cast:${characterId()}`;
            const readCast = () => readJson(castKey(), []).filter((person) => person?.name);
            const saveCast = (people) => ctx.storage.set(castKey(), JSON.stringify(people));
            // 名字完全一样优先；其次互相包含（两边都至少两个字，免得「白」对上「对白」）。
            const personOf = (speaker, people) => people.find((item) => item.name === speaker)
                || people.find((item) => item.name.length > 1 && speaker.length > 1 && (speaker.includes(item.name) || item.name.includes(speaker)));
            // 人物配的声音只在选它时的那个接口上算数（没标的是 Fish 的）；换了接口就用默认声音。
            const voiceOf = (person) => (person?.id && (person.provider || 'fish') === get('provider') ? person.id : '');

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
            // 这个说话人的声音念什么语言（没选是空）。
            const langOf = (speaker, people) => {
                const lang = personOf(speaker, people)?.lang;
                return LANGS[lang] ? lang : '';
            };
            // 每行存 [说话人, 语气, 停顿, 译文, 译成的语言]，后两项只在翻译过时有。
            // anyLang：只要说话人和语气（画线、悬浮窗用）；不传时还要求译文的语言和人物现在配的一致，换过语言的要重新分析。
            function cachedLabels(lines, anyLang = false) {
                const saved = store.card === characterId() ? store.data[keyOf(lines)] : null;
                if (!Array.isArray(saved) || saved.length !== lines.length) return null;
                const people = anyLang ? null : readCast();
                if (people && saved.some(([speaker, , , , lang = '']) => langOf(speaker, people) !== lang)) return null;
                return saved.map(([speaker, tone, pause, translation]) => ({ speaker, tone, pause, translation }));
            }

            let analyzing = null; // 正在分析的回复序号
            const failures = new Map(); // 回复序号 → 分析失败的原因
            const inflight = new Map(); // 同一条回复同时只分析一次
            // 分析失败时：引号里的用默认声音念，其余算旁白（不念）。force 为 true 时不用存下的结果，重新分析。
            async function analyze(index, force = false) {
                const card = characterId(), lines = linesOf(index);
                if (!lines.length) return { lines, labels: [] };
                await loadStore();
                if (characterId() !== card) return { lines: [], labels: [] };
                const cached = force ? null : cachedLabels(lines);
                if (cached) return { lines, labels: cached };
                const key = keyOf(lines), task = JSON.stringify([card, key]);
                if (!inflight.has(task)) inflight.set(task, requestLabels(index, lines, card, key).finally(() => inflight.delete(task)));
                return { lines, labels: await inflight.get(task) };
            }

            async function requestLabels(index, lines, card, key) {
                const fallback = lines.map((line) => ({ speaker: line.quote ? DIALOGUE : NARRATOR, tone: '' }));
                analyzing = index;
                failures.delete(index);
                renderWidget();
                try {
                    if (!widgetVisible()) ctx.ui.toast('正在分析每句是谁说的、用什么语气……', { kind: 'info' });
                    // 角色设定的前几百字，帮模型认人名。
                    const profile = String(character().description || '').replace(/\s+/g, ' ').trim().slice(0, 600);
                    // 声音标了语言的人物：让模型顺便把他的台词译过去。
                    const known = readCast();
                    const targets = known.filter((person) => LANGS[person.lang]).map((person) => `${person.name} → ${LANGS[person.lang]}`);
                    const reply = await ctx.ai.complete({
                        model: get('analysisModel').trim() || undefined,
                        messages: [
                            { role: 'system', content: analyzePrompt(targets.length > 0) },
                            { role: 'user', content: [
                                `已知人物：${known.map((person) => person.name).join('、') || '（正文里出现谁就用谁的名字）'}`,
                                `用户扮演：${userName() || '未知'}`,
                                ...(targets.length ? [`声音语言：${targets.join('，')}`] : []),
                                ...(profile ? [`角色设定摘录：${profile}`] : []),
                                '\n正文：',
                                ...lines.map((line, i) => `${i + 1}. [${line.quote ? '对白' : '叙述'}] ${line.text.slice(0, 300)}`)
                            ].join('\n') }
                        ]
                    });
                    const rows = (parseJson(reply, '[') || [...reply.matchAll(ROW)].map((match) => JSON.parse(match[0]))).filter(Array.isArray);
                    if (!rows.length) throw new Error(reply.trim() ? 'AI 没有按格式回答' : 'AI 没有返回内容，换个分析模型试试');
                    const labels = fallback.map((item, i) => {
                        const row = rows.find((entry) => Number(entry[0]) === i + 1);
                        if (!row) return item;
                        const pause = Number(row[3]);
                        const speaker = String(row[1] || '').trim() || NARRATOR;
                        const lang = langOf(speaker, known);
                        return {
                            speaker,
                            tone: String(row[2] || '').replace(/[[\]]/g, '').trim().slice(0, 60),
                            pause: Number.isFinite(pause) ? Math.min(Math.max(pause, 0), 3) : null,
                            translation: lang ? String(row[4] || '').trim() : '',
                            lang
                        };
                    });
                    if (store.card === card) {
                        store.data = { ...store.data, [key]: labels.map((label) => [label.speaker, label.tone, label.pause, ...(label.lang ? [label.translation, label.lang] : [])]) };
                        Object.keys(store.data).slice(0, -ANALYSIS_KEEP).forEach((old) => delete store.data[old]);
                        ctx.data.set(`analysis:${card}`, store.data).catch((error) => ctx.log('分析结果没存上', error));
                    }
                    // 新出现的人物（不算用户扮演的）加进配音表，等用户挑音色；挑之前用默认声音。
                    const people = readCast();
                    const fresh = [...new Set(labels.map((label) => label.speaker))].filter((speaker) => !isNarrator(speaker) && speaker !== userName() && !personOf(speaker, people));
                    if (fresh.length && characterId() === card) saveCast([...people, ...fresh.map((name) => ({ name }))]);
                    markRows([...document.querySelectorAll(`[data-chat-index="${index}"]`)]);
                    return labels;
                } catch (error) {
                    if (characterId() !== card) return fallback;
                    failures.set(index, error?.message || String(error));
                    ctx.ui.toast(`分析说话人失败：${error?.message || error}。这次引号里的话先用默认声音念`, { kind: 'warning' });
                    return fallback;
                } finally {
                    if (characterId() === card && analyzing === index) analyzing = null;
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
                const rules = readJson('pronunciations', []).filter((rule) => rule?.from);
                const picked = lines.map((_, i) => i).filter((i) => i >= from && (!only || i === from) && voiced(labels[i].speaker));
                const items = [];
                picked.forEach((i, k) => {
                    const { speaker, tone, translation } = labels[i];
                    const voice = voiceOf(personOf(speaker, people));
                    // 念的是译文（有的话），再按读音替换表把左边的字换成右边的；页面上标的还是原文。
                    const chunks = splitText(rules.reduce((text, rule) => text.split(rule.from).join(rule.to || ''), translation || lines[i].text));
                    const next = picked[k + 1];
                    chunks.forEach((text, c) => items.push({
                        line: lines[i], text, voice, tone, speaker,
                        pause: c < chunks.length - 1 ? 150 : next === undefined ? 0 : pauseAfter(lines, labels, i, next)
                    }));
                });
                return items;
            }

            // 正在说的：{ index, stopped, abort, speaker, paused, at（说到第几段）, seek（要跳去的那段）, finish（结束正在放的这段）, move（叫醒在等的循环） }
            let session = null;
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
            // 暂停、继续：正在放的这段跟着停、接着放；还在等合成的，合成好了先不放。
            function togglePause() {
                if (!session) return;
                session.paused = !session.paused;
                if (session.finish) session.paused ? player.pause() : player.play().catch(() => {});
                renderWidget();
            }
            // 上一句（-1）、下一句（1）。这段已经念了两秒以上时，「上一句」是重念这一段。
            function seek(step) {
                if (!session) return;
                session.seek = Math.max(0, session.at + (step < 0 && session.finish && player.currentTime > 2 ? 0 : step));
                session.paused = false;
                session.finish?.();
                session.move?.();
            }

            // 手机浏览器只让「点了之后」出声：第一次点按钮时先用同一个播放器放一下静音，之后自动播放也能播。
            let unlocked = false;
            function unlock() {
                if (unlocked) return;
                unlocked = true;
                player.src = SILENT;
                player.play().catch(() => {});
            }

            // 等一会儿（句与句之间的停顿、重试前的间隔），停止时马上结束。
            const wait = (ms, signal) => new Promise((resolve) => {
                const timer = setTimeout(resolve, ms);
                signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });
            });

            // 接口地址可以只填域名，也可以填到 /v1 或完整的 …/audio/speech，中转的路径前缀留着；Fish 的地址没填到 /v1 时走它的 /compat/v1。
            function apiUrl(address, compat) {
                let url = null;
                try { url = new URL(address); } catch (_) { /* 和协议不对一起报 */ }
                if (!/^https?:$/.test(url?.protocol)) throw new Error('接口地址要以 http:// 或 https:// 开头');
                const path = url.pathname.replace(/\/+$/, '').replace(/\/audio\/speech$/, '');
                const base = path.replace(/\/v1$/, '');
                url.pathname = `${compat && base === path ? `${base.replace(/\/compat$/, '')}/compat` : base}/v1/audio/speech`;
                return url.href;
            }
            // 这一段向哪个接口要、带什么去要。语气：Fish 和选了「句首方括号」的接口写在句首；选了 instructions 的放那个字段（tts-1 不认，不传）。
            function speechRequest({ text, voice, tone }) {
                if (isFish()) {
                    return { name: 'Fish', url: apiUrl(fishUrl(), true), key: get('fishKey').trim(),
                        body: { model: get('fishModel'), input: tone ? `[${tone}] ${text}` : text, voice, response_format: 'mp3' } };
                }
                const mode = get('openaiTone');
                const model = get('openaiModel').trim();
                return { name: '语音接口', url: apiUrl(get('openaiUrl').trim(), false), key: get('openaiKey').trim(), body: {
                    model, input: mode === 'bracket' && tone ? `[${tone}] ${text}` : text,
                    voice: voice || get('openaiVoice').trim() || template().voices[0] || 'alloy', response_format: get('openaiFormat'),
                    ...(mode === 'instructions' && tone && !/^tts-1/.test(model) ? { instructions: tone } : {})
                } };
            }

            const cache = new Map();
            const failure = (message, status) => Object.assign(new Error(message), { status });
            // 向接口要一段语音。出错时带上状态码，播放那边据此决定重试、跳过还是停。
            async function request({ name, url, key, body }, signal) {
                const controller = new AbortController();
                const cancel = () => controller.abort();
                if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
                const timer = setTimeout(cancel, TIMEOUT);
                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        signal: controller.signal,
                        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
                        body: JSON.stringify(body)
                    });
                    if (!response.ok) {
                        const detail = await response.text().catch(() => '');
                        let reason = detail;
                        try {
                            const json = JSON.parse(detail);
                            reason = [json.error?.message, json.message, json.detail, json.error].find((item) => typeof item === 'string' && item) || detail;
                        } catch (_) { /* 不是 JSON，用原文 */ }
                        const status = ERROR_HINTS[response.status] ? `${response.status}，${ERROR_HINTS[response.status]}` : response.status;
                        throw failure(`${name} 报错（${status}）：${String(reason).slice(0, 200) || response.statusText}`, response.status);
                    }
                    const blob = await response.blob();
                    // 回的是一段文字（出错了却没给错误码）或者空的：不当成语音存下来。
                    if (!blob.size || /json|^text\//i.test(blob.type)) throw failure(`${name} 返回的不是语音`);
                    return blob;
                } catch (error) {
                    if (controller.signal.aborted && !signal.aborted) throw failure(`${name} 一分钟没回应`, 408);
                    // 浏览器只说 Failed to fetch：地址写错、接口不通，或者接口不让网页直接调用。
                    throw error instanceof TypeError ? failure(`${name} 连不上：检查接口地址，或者它不让网页直接调用`) : error;
                } finally {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', cancel);
                }
            }
            async function synthesize(item, signal) {
                const target = speechRequest(item);
                const key = JSON.stringify([target.url, target.body]);
                if (cache.has(key)) return cache.get(key);
                const blob = await request(target, signal).catch(async (error) => {
                    if (!RETRYABLE.includes(error.status)) throw error;
                    await wait(1500, signal);
                    return request(target, signal);
                });
                cache.set(key, blob);
                if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
                return blob;
            }

            function play(blob, current) {
                return new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(blob);
                    const finish = (error) => {
                        player.pause(); // 换句时这段还没放完，先停下，别和下一段叠在一起
                        player.onended = player.onerror = null;
                        current.finish = null;
                        URL.revokeObjectURL(url);
                        if (error) reject(error); else resolve();
                    };
                    current.finish = () => finish();
                    player.onended = () => finish();
                    player.onerror = () => finish(new Error('这段语音放不出来，接口返回的可能不是音频'));
                    player.src = url;
                    tune();
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
            // 说一条回复：没分析过先分析，再按人物的声音一句句说，句与句之间按节奏停顿；边播边生成下一段。
            // from 是从第几句开始，only 为 true 时只说这一句（点台词时用）。
            async function speak(index, { from = 0, only = false } = {}) {
                stop();
                if (isFish() && official() && !get('fishKey').trim()) return ctx.ui.toast('先在「角色语音」设置里填好 Fish Audio 的密钥', { kind: 'warning' });
                const current = session = { index, stopped: false, abort: new AbortController(), speaker: '', paused: false, at: 0, seek: null };
                const signal = current.abort.signal;
                let finished = false; // 自己说完的（没被停、没出错）才接着说后面的回复
                refreshButtons();
                renderWidget();
                try {
                    const { lines, labels } = await analyze(index);
                    if (current.stopped) return;
                    const items = itemsOf(lines, labels, from, only);
                    if (!items.length) ctx.ui.toast('这条回复里没有人物说的话', { kind: 'info' });
                    const loads = [];
                    const load = (i) => (loads[i] ??= synthesize(items[i], signal));
                    let failed = 0; // 连着几句没合成出来
                    let i = 0;
                    while (!current.stopped) {
                        // 上一句、下一句：跳到那一段；跳过了最后一段就结束。
                        if (current.seek !== null) [i, current.seek] = [current.seek, null];
                        if (i >= items.length) break;
                        current.at = i;
                        const moved = new Promise((resolve) => { current.move = resolve; }); // 换句时不再等这一段
                        let blob;
                        try {
                            blob = await Promise.race([load(i), moved]);
                        } catch (error) {
                            failed += 1;
                            if (current.stopped || !SKIPPABLE.includes(error.status)) throw error;
                            if (failed >= 3) throw new Error(`连着三句都没合成出来，停了：${error.message}`);
                            ctx.ui.toast(`有一句没合成出来，跳过了：${error.message}`, { kind: 'warning' });
                            i += 1;
                            continue;
                        }
                        if (current.seek !== null) continue;
                        failed = 0;
                        if (i + 1 < items.length) load(i + 1).catch(() => {});
                        while (current.paused && !current.stopped && current.seek === null) await Promise.race([wait(200, signal), moved]);
                        if (current.stopped || current.seek !== null) continue;
                        current.speaker = items[i].speaker;
                        renderWidget();
                        showSpeaking(items[i].line);
                        try {
                            await play(blob, current);
                        } finally {
                            showSpeaking(null);
                        }
                        if (items[i].pause && !current.stopped && current.seek === null) await Promise.race([wait(items[i].pause, signal), moved]);
                        if (current.seek === null) i += 1;
                    }
                    finished = !current.stopped;
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
                // 连播：这条自己说完了，接着说后面的回复。
                if (finished && !only && get('continuous') === '1') {
                    const next = (ctx.app.get('chatHistory') || []).findIndex((message, i) => i > index && message?.role === 'assistant');
                    if (next >= 0 && messageBody(next)) await speak(next);
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
                    const labels = lines.length ? cachedLabels(lines, true) : null;
                    if (!labels) continue;
                    const found = [];
                    lines.forEach((line, i) => {
                        if (voiced(labels[i].speaker)) found.push({ range: rangeOf(line), index, line: i, ...labels[i] });
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
                popover.innerHTML = `<strong></strong><div class="rph-voice-pop__tone"></div><div class="rph-voice-pop__said"></div>
                    <div class="rph-voice-pop__actions">
                        <button type="button" class="modal-secondary-button rph-ui-button" data-one>播放这句</button>
                        <button type="button" class="modal-primary-button rph-ui-button" data-from>从这句开始</button>
                    </div>`;
                popover.querySelector('strong').textContent = mark.speaker;
                popover.querySelector('.rph-voice-pop__tone').textContent = mark.tone ? `AI 分析的语气：${mark.tone}` : 'AI 没给这句标语气';
                popover.querySelector('.rph-voice-pop__said').textContent = mark.translation ? `念的是：${mark.translation}` : '';
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
            // 点到台词的字上才弹（看点的位置在不在这句话占的那几块里；点旁边空白不算）；选文字、点别处不打扰。
            document.addEventListener('click', (event) => {
                if (popover?.contains(event.target)) return;
                closePopover();
                if (!marks.size || !getSelection()?.isCollapsed) return;
                const row = event.target.closest?.('[data-chat-index]');
                const found = row && marks.get(row);
                if (!found) return;
                const { clientX: x, clientY: y } = event;
                const hit = (rect) => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2;
                const mark = found.find((item) => [...item.range.getClientRects()].some(hit));
                if (mark) openPopover(mark, x, y);
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
                    if (event.button !== 0 || event.target.closest('[data-collapse], [data-settings]')) return;
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
                        <div class="rph-voice-widget__head" data-drag><strong>角色语音</strong><span class="rph-voice-widget__tools"><button type="button" class="rph-voice-widget__fold" data-settings title="角色语音设置" aria-label="角色语音设置">${icon(GEAR_PATHS, 'w-4 h-4')}</button><button type="button" class="rph-voice-widget__fold" data-collapse title="收起" aria-label="收起">－</button></span></div>
                        <p class="rph-voice-widget__status" data-status></p>
                        <div class="rph-voice-widget__actions">
                            <button type="button" class="modal-secondary-button rph-ui-button" data-analyze>分析</button>
                            <button type="button" class="modal-primary-button rph-ui-button" data-play>播放</button>
                        </div>
                        <div class="rph-voice-widget__actions" data-controls hidden>
                            <button type="button" class="modal-secondary-button rph-ui-button" data-prev>上一句</button>
                            <button type="button" class="modal-secondary-button rph-ui-button" data-pause>暂停</button>
                            <button type="button" class="modal-secondary-button rph-ui-button" data-next>下一句</button>
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
                widget.querySelector('[data-settings]').onclick = () => openSettings();
                widget.querySelector('[data-analyze]').onclick = () => {
                    const index = lastReplyIndex();
                    if (index >= 0) analyze(index, true).catch((error) => ctx.log('分析失败', error));
                };
                widget.querySelector('[data-play]').onclick = () => {
                    if (session) return stop();
                    const index = lastReplyIndex();
                    if (index >= 0) toggleSpeaking(index);
                };
                widget.querySelector('[data-prev]').onclick = () => seek(-1);
                widget.querySelector('[data-pause]').onclick = togglePause;
                widget.querySelector('[data-next]').onclick = () => seek(1);
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
                // 说话时多一排：上一句、暂停、下一句。窗口变高了，贴着屏幕底边的话往上挪一点。
                const controls = root.querySelector('[data-controls]');
                if (controls.hidden === !!session) {
                    controls.hidden = !session;
                    if (root.style.left) placeWidget(parseFloat(root.style.left), parseFloat(root.style.top));
                }
                root.querySelector('[data-pause]').textContent = session?.paused ? '继续' : '暂停';
                analyzeButton.textContent = '分析';
                analyzeButton.disabled = generating || index < 0 || analyzing !== null;
                if (analyzing !== null) return void (status.textContent = '正在分析每句是谁说的……');
                if (session) return void (status.textContent = `${session.paused ? '已暂停' : '正在说'}：${session.speaker || '……'}`);
                if (generating) return void (status.textContent = '等回复写完……');
                if (index < 0) return void (status.textContent = '还没有 AI 回复');
                const lines = linesOf(index);
                const labels = cachedLabels(lines, true);
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
            ctx.events.on('generation-end', renderWidget);
            onReplyReady(ctx, {
                enabled: () => get('autoPlay') === '1' || get('analyzeMode') === 'auto',
                latest: lastReplyIndex,
                run: index => get('autoPlay') === '1' ? speak(index) : analyze(index),
                label: '自动角色语音失败'
            });

            // 监听值用字符串：返回数组的话每次都算「变了」。
            ctx.app.watch(() => `${characterId()}\n${ctx.app.get('currentView')}`, (value, previous = '') => {
                if (session && value.split('\n')[0] !== previous.split('\n')[0]) stop();
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
            // 按 ID 查一个声音；带上密钥，自己账号里的私有声音也查得到。
            // 走中转时密钥是中转的，不发给 Fish 官方：私有声音就查不到，照样让用，名字写成 ID。
            async function lookupVoice(id) {
                const key = official() ? get('fishKey').trim() : '';
                const response = await fetch(`${FISH_LIBRARY}/${id}`, key ? { headers: { Authorization: `Bearer ${key}` } } : {});
                if (response.status === 404 && !official()) return { id, title: id, tags: [], sample: '' };
                if (!response.ok) throw new Error(response.status === 404 ? '没找到这个声音，检查一下 ID' : `查声音失败（${response.status}）`);
                return toVoice(await response.json());
            }
            // AI 挑：几组条件各搜一页，合在一起按对得上的程度排，取前 8 个。
            async function searchLibrary(queries, want = {}) {
                const found = new Map();
                for (const data of await Promise.all(queries.map((query) => libraryPage(query)))) {
                    for (const item of data.items || []) if (item?._id && !found.has(item._id)) found.set(item._id, item);
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

            // 把原生下拉框换成 RPH 自己的下拉框（展开的列表、深色模式都和原生设置页一样）。值还在隐藏的 <select> 里，
            // 别的代码照旧读写 .value、监听 change；选项或选中项变了会自己跟上。页面没有这个组件（旧版 RPH）时保持原生下拉框。
            function styledSelect(select) {
                const Component = window.RPHubCustomSelect;
                const Vue = globalThis.Vue;
                if (!select || !Component || !Vue?.createApp) return { unmount() {} };
                const view = Vue.reactive({ value: '', options: [] });
                const sync = () => Object.assign(view, {
                    value: select.value,
                    options: [...select.options].map((option) => ({ value: option.value, label: option.textContent, disabled: option.disabled }))
                });
                const host = document.createElement('div');
                const app = Vue.createApp({
                    render: () => Vue.h(Component, {
                        modelValue: view.value, options: view.options, buttonClass: 'rph-ui-input', menuClass: 'text-sm',
                        'onUpdate:modelValue': (value) => {
                            select.value = value;
                            sync();
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    })
                });
                app.mount(host);
                select.hidden = true;
                select.after(host);
                const observer = new MutationObserver(sync);
                observer.observe(select, { childList: true, subtree: true, attributes: true });
                sync();
                return {
                    unmount() {
                        observer.disconnect();
                        app.unmount();
                    }
                };
            }

            // 设置页：插件接口 8 起在导航菜单里单独一项，点开占满主区域；旧外壳没有页面接口时退回「模块管理」里的弹窗。
            // 切换角色卡时重画（配音表按卡记）。
            function renderSettings(body) {
                let selects = [];
                let castSelects = []; // 配音表每行的语言下拉框，重画配音表时先拆掉
                const paint = () => {
                    selects.forEach((item) => item.unmount());
                    // 样式类名见 WORKSHOP-MOD-GUIDE.md「面板样式」，跟随页面主题和深色模式。
                    // 密钥框不用 type=password：浏览器会把它当成网站登录密码，配音表一重画就弹「要更新密码吗」，点了还会把站点密码换成语音接口的密钥。
                    const fish = isFish();
                    const SECRET = 'data-1p-ignore data-lpignore="true" style="-webkit-text-security:disc"';
                    const card = (title, paths, content, note = '') => `<div class="settings-card">
                        <div class="settings-card__header"><div class="settings-card__title">${icon(paths, 'w-5 h-5 mr-2')}${title}${note}</div></div>
                        <div class="settings-card__body">${content}</div></div>`;
                    const text = (key, label, placeholder, attrs = '') => `<label class="rph-ui-field">${label}<input class="rph-ui-input" type="text" data-k="${key}" autocomplete="off" spellcheck="false" ${attrs} placeholder="${placeholder}"></label>`;
                    const select = (key, label, options) => `<div class="rph-ui-field"><span>${label}</span><select class="rph-ui-input" data-k="${key}">${options.map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}</select></div>`;
                    const toggle = (key, label) => `<div class="rph-ui-field"><label class="rph-ui-check" style="white-space:normal"><input type="checkbox" class="settings-toggle-input sr-only" data-k="${key}"><span class="settings-toggle" style="flex-shrink:0"></span><span>${label}</span></label></div>`;
                    const range = (key, label, min, max) => `<label class="rph-ui-field"><span>${label} <span data-show="${key}"></span></span><input type="range" min="${min}" max="${max}" step="0.05" class="${RANGE_CLASS}" data-k="${key}"></label>`;
                    body.innerHTML = card('语音接口', [SPEAKER_PATH], select('provider', '接口', [['fish', 'Fish Audio'], ['openai', 'OpenAI 兼容接口']]) + (fish
                        ? text('fishUrl', '接口地址', '留空用官方，或填中转的地址')
                            + text('fishKey', '密钥', '官方的在 fish.audio 申请', SECRET)
                            + select('fishModel', '模型', [['fish-audio/s2.1-pro-free', 'S2.1 Pro 免费版'], ['fish-audio/s2.1-pro', 'S2.1 Pro（按字数收费）']])
                        : select('openaiTemplate', '常用提供商', TEMPLATES.map((item) => [item.id, item.label]))
                            + text('openaiUrl', '接口地址', 'https://…，填域名或填到 /v1 都行')
                            + text('openaiKey', '密钥', '不用密钥的接口留空', SECRET)
                            + text('openaiModel', '模型', '照接口文档填')
                            + text('openaiVoice', '默认声音', `人物没配声音时用，留空是 ${template().voices[0] || 'alloy'}`)
                            + select('openaiTone', '语气怎么传', [['instructions', '放 instructions（gpt-4o-mini-tts 这类）'], ['bracket', '放句首方括号（Fish 风格）'], ['none', '不传']])
                            + select('openaiFormat', '音频格式', ['mp3', 'wav', 'opus', 'aac', 'flac'].map((name) => [name, name]))))
                        + card('基本设置', GEAR_PATHS, `
                        <div class="rph-ui-field"><span>分析用的模型</span><select class="rph-ui-input" data-k="analysisModel"></select></div>
                        <div class="rph-ui-actions" style="justify-content:space-between;align-items:center;margin:-0.25rem 0 0.75rem"><span class="rph-ui-muted" data-models-note></span><button type="button" class="modal-secondary-button rph-ui-button" data-refresh-models>刷新模型列表</button></div>
                        ${select('analyzeMode', '什么时候分析', [['click', '点「分析」或播放时才分析'], ['auto', '每条回复结束后自动分析']])}
                        ${toggle('autoPlay', '回复结束后自动说')}
                        ${toggle('continuous', '说完这条接着说后面的回复')}
                        ${toggle('userLines', '你扮演的角色的台词也念')}
                        ${toggle('widget', '在聊天页显示状态悬浮窗')}
                        ${range('volume', '音量', 0, 1)}
                        ${range('speed', '语速', 0.5, 2)}`)
                        + card('读音替换', [SWAP_PATH], '<div data-rules></div><div class="rph-ui-actions" style="margin-top:0.75rem"><button type="button" class="modal-secondary-button rph-ui-button" data-add-rule>加一条</button></div>')
                        + card('配音表', [PEOPLE_PATH], `
                            <div data-cast></div>
                            <div class="rph-ui-actions" style="margin-top:0.75rem"><input class="rph-ui-input" data-new-person placeholder="人物名字" style="flex:1;min-width:0"><button type="button" class="modal-secondary-button rph-ui-button" data-add-person>添加人物</button></div>`,
                        '<span class="rph-ui-muted" style="margin-left:0.5rem;font-weight:400" data-card-name></span>');
                    body.querySelector('[data-card-name]').textContent = character().name ? `当前角色卡：${character().name}` : '先打开一张角色卡';

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

                    // 设置项改了立即保存。换接口、换常用提供商后重画：下面的设置项跟着变。
                    const SHOW = { volume: (value) => `${Math.round(value * 100)}%`, speed: (value) => `${Number(value).toFixed(2)}x` };
                    body.querySelectorAll('[data-k]').forEach((field) => {
                        const key = field.dataset.k;
                        const value = () => (field.type === 'checkbox' ? (field.checked ? '1' : '0') : field.value);
                        const show = () => {
                            if (SHOW[key]) body.querySelector(`[data-show="${key}"]`).textContent = SHOW[key](field.value);
                        };
                        const save = () => {
                            ctx.storage.set(key, value());
                            if (key === 'openaiTemplate') {
                                const { url, model, tone, format = 'mp3' } = template();
                                Object.entries({ openaiUrl: url, openaiModel: model, openaiTone: tone, openaiFormat: format, openaiVoice: '' }).forEach(([name, next]) => ctx.storage.set(name, next));
                            }
                            if (key === 'provider' || key === 'openaiTemplate') return paint();
                            show();
                            tune();
                            renderWidget();
                        };
                        if (field.type === 'checkbox') field.checked = get(key) === '1'; else field.value = get(key);
                        show();
                        field.addEventListener(['text', 'range'].includes(field.type) ? 'input' : 'change', save);
                    });
                    selects = [...body.querySelectorAll('select[data-k]')].map((select) => styledSelect(select));

                    const element = (tag, className = '', text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
                    const smallButton = (label, onClick) => {
                        const item = element('button', 'modal-secondary-button rph-ui-button', label);
                        item.type = 'button';
                        item.onclick = onClick;
                        return item;
                    };

                    // 读音替换：念之前把左边的字换成右边的，页面上还是原文。改完一格就存；左边空着的不算。
                    const rulesBox = body.querySelector('[data-rules]');
                    const saveRules = (rules) => ctx.storage.set('pronunciations', JSON.stringify(rules));
                    const renderRules = () => {
                        const rules = readJson('pronunciations', []);
                        rulesBox.replaceChildren();
                        if (!rules.length) rulesBox.appendChild(element('p', 'rph-ui-muted', '人名、多音字念错了，在这里换成好念的字，比如「黍 → 蜀」。'));
                        rules.forEach((rule, i) => {
                            const cell = (key, placeholder) => {
                                const input = Object.assign(element('input', 'rph-ui-input'), { value: rule[key] || '', placeholder });
                                input.style.cssText = 'flex:1;min-width:0';
                                input.onchange = () => {
                                    rules[i] = { ...rules[i], [key]: input.value };
                                    saveRules(rules);
                                };
                                return input;
                            };
                            const line = element('div', 'rph-ui-actions');
                            line.style.cssText = 'margin-bottom:0.5rem;align-items:center';
                            line.append(cell('from', '原文'), element('span', 'rph-ui-muted', '→'), cell('to', '念成'), smallButton('删除', () => {
                                saveRules(rules.filter((_, n) => n !== i));
                                renderRules();
                            }));
                            rulesBox.appendChild(line);
                        });
                    };
                    renderRules();
                    body.querySelector('[data-add-rule]').onclick = () => {
                        saveRules([...readJson('pronunciations', []), { from: '', to: '' }]);
                        renderRules();
                        rulesBox.querySelector('div:last-child input')?.focus();
                    };

                    // 配音表：每行一个人物，选声音念什么语言，可以让 AI 挑、自己搜或填声音名、试听、删除。
                    const castBox = body.querySelector('[data-cast]');
                    // 试听：声音自带试听就放它的；没有就用现在的接口合成一句（同一句再点不重复合成）。
                    let sampleUrl = '';
                    const playSample = async (voice) => {
                        try {
                            const sample = voiceOf(voice) && voice.sample;
                            if (!sample) {
                                URL.revokeObjectURL(sampleUrl);
                                sampleUrl = URL.createObjectURL(await synthesize({ text: SAMPLES[voice.lang] || SAMPLE, voice: voiceOf(voice), tone: '' }, new AbortController().signal));
                            }
                            preview.src = sample || sampleUrl;
                            await preview.play();
                        } catch (error) {
                            ctx.ui.toast(`试听放不出来：${error?.message || error}`);
                        }
                    };
                    // 换声音不动这个人已经选的语言。
                    const assign = (name, voice) => {
                        saveCast(readCast().map((person) => (person.name === name
                            ? { ...person, id: voice.id, title: voice.title, sample: voice.sample, provider: fish ? undefined : 'openai' } : person)));
                        renderCast();
                    };
                    // 一个候选声音：能试听、选用。
                    const voiceRow = (name, voice) => {
                        const row = element('div', 'rph-ui-row');
                        row.dataset.voiceId = voice.id;
                        const main = element('div', 'rph-ui-row-main');
                        main.append(element('strong', '', voice.title), element('div', 'rph-ui-muted', voice.tags.join(' · ')));
                        const actions = element('div', 'rph-ui-row-actions');
                        actions.append(smallButton('试听', () => playSample(voice)), smallButton('用这个', () => assign(name, voice)));
                        row.append(main, actions);
                        return row;
                    };
                    const showVoices = (area, name, voices, note = '') => {
                        area.replaceChildren();
                        if (note) area.appendChild(element('p', 'rph-ui-muted', note));
                        if (!voices.length) area.appendChild(element('p', 'rph-ui-muted', '没找到合适的声音，换个词搜搜。'));
                        voices.forEach((voice) => area.appendChild(voiceRow(name, voice)));
                    };
                    // 自己搜：每页 20 个，写出一共多少个，底下「加载更多」往后翻。粘贴的是声音 ID 或 fish.audio 声音页网址时直接按 ID 查。
                    const searchBox = (area, name) => {
                        area.replaceChildren();
                        const form = element('div', 'rph-ui-actions');
                        form.style.marginTop = '0.5rem';
                        const input = element('input', 'rph-ui-input');
                        input.placeholder = '搜声音，或粘贴声音 ID、网址';
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
                                const text = input.value.trim();
                                const id = text.match(/(?:^|\/m\/)([0-9a-f]{32})\b/i)?.[1];
                                const { voices, total } = id ? { voices: [await lookupVoice(id)], total: 1 } : await searchPage(text, page + 1);
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
                    // OpenAI 格式的接口没有能搜的声音库：直接填声音名，或点这家常用的声音名。
                    const nameBox = (area, name) => {
                        area.replaceChildren();
                        const pick = (id) => id && assign(name, { id, title: id, sample: '' });
                        const form = element('div', 'rph-ui-actions');
                        form.style.marginTop = '0.5rem';
                        const input = element('input', 'rph-ui-input');
                        input.placeholder = '声音名字，照接口文档填';
                        input.style.cssText = 'flex:1;min-width:0';
                        input.onkeydown = (event) => { if (event.key === 'Enter' && !event.isComposing) pick(input.value.trim()); };
                        form.append(input, smallButton('用这个', () => pick(input.value.trim())));
                        const presets = element('div', 'rph-ui-actions');
                        presets.style.cssText = 'justify-content:flex-start;flex-wrap:wrap;margin-top:0.5rem';
                        template().voices.forEach((voice) => presets.appendChild(smallButton(voice, () => pick(voice))));
                        area.append(form, presets);
                        input.focus();
                    };
                    function renderCast() {
                        castSelects.forEach((item) => item.unmount());
                        castSelects = [];
                        castBox.replaceChildren();
                        const people = readCast();
                        if (!people.length) castBox.appendChild(element('p', 'rph-ui-muted', '还没有人物，分析回复后会自动加进来。'));
                        people.forEach((person) => {
                            const row = element('div', 'rph-ui-row');
                            row.dataset.person = person.name;
                            const main = element('div', 'rph-ui-row-main');
                            main.append(element('strong', '', person.name), element('div', 'rph-ui-muted', voiceOf(person) ? person.title || person.id : `${fish ? 'Fish ' : ''}默认声音`));
                            const actions = element('div', 'rph-ui-row-actions');
                            const area = element('div');
                            area.dataset.pick = person.name;
                            area.style.marginBottom = '0.5rem';
                            // 这个人的声音念什么语言：选了别的，分析时把他的台词译过去再念。
                            const lang = element('select', 'rph-ui-input');
                            lang.dataset.lang = '';
                            lang.append(new Option('不翻译', ''), ...Object.entries(LANGS).map(([code, label]) => new Option(label, code)));
                            lang.value = LANGS[person.lang] ? person.lang : '';
                            lang.onchange = () => saveCast(readCast().map((item) => (item.name === person.name ? { ...item, lang: lang.value || undefined } : item)));
                            const langBox = element('div');
                            langBox.title = '这个声音念什么语言';
                            langBox.style.width = '6.5rem';
                            langBox.appendChild(lang);
                            castSelects.push(styledSelect(lang));
                            actions.append(langBox);
                            if (!fish) actions.append(smallButton('填声音', () => nameBox(area, person.name)));
                            else actions.append(smallButton('AI 挑', async () => {
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
                            actions.append(smallButton('试听', () => playSample(person)), smallButton('删除', () => {
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
                };
                paint();
                let stopWatch = null;
                stopWatch = ctx.app.watch(() => characterId(), () => (body.isConnected ? paint() : stopWatch?.()));
                return () => {
                    stopWatch?.();
                    [...selects, ...castSelects].forEach((item) => item.unmount());
                };
            }
            const page = typeof ctx.ui.addPage === 'function' ? ctx.ui.addPage({ label: '角色语音', iconPaths: [TALK_PATH], render: renderSettings }) : null;
            if (!page) ctx.ui.addSidebarEntry({ label: '角色语音设置', onClick: () => ctx.ui.openPanel({ title: '角色语音', render: renderSettings }) });
            openSettings = () => (page ? page.open() : ctx.ui.openPanel({ title: '角色语音', render: renderSettings }));
        }
    });
})();
