// 角色语音：让 AI 回复里的人物开口说话（旁白、叙述不念，那是「朗读」插件的事）。
// 一次 AI 调用（插件接口 API 7 的 ctx.ai）分析每句是谁说的、用什么语气；人物的台词按「配音表」里各自的声音念。
// 语音接口两种：Fish Audio（官方，或 new-api、fish2api 这类中转；语气写成句首 [方括号]，音色从公共声音库里让 AI 挑、自己搜，或粘贴声音 ID），
// 和 OpenAI 语音格式的接口（声音填名字）。声音带语言（Fish 声音库里的自带，搜索时可以按语言找，也能在人物那行改）：和正文不是一种语言时，分析顺便把这个人的台词译成声音的语言，念译文，页面上标的还是原文。
// 聊天页有个状态悬浮窗：显示最新回复分析了没有、谁说了几句、正在说谁的台词，带「分析」「播放/停止」，说话时多出上一句、暂停、下一句。
// 分析过的回复里，人物的每句台词画虚线，点一下能看是谁说的、什么语气，能只播这一句或从这句开始；句与句之间按 AI 给的节奏停顿。
(() => {
    'use strict';
    /* @shared/reply-task */
    const DEFAULTS = {
        provider: 'fish', fishProtocol: 'compat', fishUrl: '', fishKey: '', fishModel: 'fish-audio/s2.1-pro-free', fishCustomModel: '', fishFormat: 'mp3',
        openaiTemplate: 'openai', openaiUrl: 'https://api.openai.com', openaiKey: '', openaiModel: 'gpt-4o-mini-tts', openaiVoice: '', openaiTone: 'instructions', openaiFormat: 'mp3',
        analysisModel: '', analyzeMode: 'click', autoPlay: '0', continuous: '0', userLines: '0', widget: '1', follow: '1', hotkeys: '1', persistCache: '0', volume: '1', speed: '1'
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
    // 声音念什么语言：没有就是跟正文一样；是别的语言，分析时把这个人的台词译过去。
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
    const CACHE_SIZE = 80; // 重听不重新生成（不再花钱），内存最多留 80 段；开启持久缓存时存进 IndexedDB
    const PERSIST_CACHE_LIMIT = 200 * 1024 * 1024; // 本地持久音频缓存上限 200 MB
    const ANALYSIS_TIMEOUT = 180000; // AI 分析超时（3 分钟，兼顾推理模型）
    const ANALYSIS_KEEP = 40; // 每张卡最多存 40 条回复的分析结果
    const ERROR_HINTS = { 400: '请检查声音和模型', 401: '密钥无效', 402: '余额不足', 403: '密钥权限不足', 429: '请求过于频繁或额度已用完' };
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
    const LIST_PATH = 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4';
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
.rph-voice-widget.is-busy .rph-voice-widget__dot{box-shadow:0 0 0 3px rgba(96,165,250,.45),0 6px 18px rgba(0,0,0,.16)}
.rph-voice-preview-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 0;border-top:1px solid var(--c-border-soft,#e5e7eb)}
.rph-voice-preview-row.is-skipped{opacity:.5}
.rph-voice-preview-text{flex:1 1 100%;font-size:13px;line-height:1.5;overflow-wrap:anywhere}`;

    RPHubSDK.register({
        id: 'character-voice', name: '角色语音', version: '1.4.0', requiresApi: 7,
        init(ctx) {
            const player = new Audio(); // 都用这一个播放器：手机上点过一次以后，自动播放也能出声
            const preview = new Audio(); // 声音库的试听
            const style = document.createElement('style');
            style.textContent = STYLE;
            document.head.appendChild(style);

            const get = (key) => ctx.storage.get(key) ?? DEFAULTS[key];
            // 语音接口：Fish（地址留空是官方，也可以填中转，支持兼容和原生格式）或 OpenAI 语音格式的接口。
            const isFish = () => get('provider') === 'fish';
            const fishUrl = () => get('fishUrl').trim() || FISH;
            const fishModelName = () => (get('fishModel') === '__custom__' ? get('fishCustomModel').trim() : get('fishModel').trim());
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
                const vol = numberOf('volume', 0, 1);
                player.volume = vol;
                preview.volume = vol;
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
            // 切换接口时把每家已配的声音分别收进 cast-stash，换回来不丢。
            const castKey = () => `cast:${characterId()}`;
            const stashKey = () => `cast-stash:${characterId()}`;
            const readCast = () => readJson(castKey(), []).filter((person) => person?.name);
            const saveCast = (people) => ctx.storage.set(castKey(), JSON.stringify(people));
            const switchProviderCast = (prevProvider, nextProvider) => {
                if (!characterId() || prevProvider === nextProvider) return;
                const people = readCast();
                const stash = readJson(stashKey(), {});
                const bucket = stash[prevProvider] || {};
                for (const person of people) {
                    if (person.id && (person.provider || 'fish') === prevProvider) {
                        bucket[person.name] = { id: person.id, title: person.title, sample: person.sample, provider: person.provider };
                    }
                }
                stash[prevProvider] = bucket;
                ctx.storage.set(stashKey(), JSON.stringify(stash));
                const nextBucket = stash[nextProvider] || {};
                const restored = people.map((person) => {
                    const saved = nextBucket[person.name];
                    if (saved?.id) {
                        const next = { ...person, id: saved.id, title: saved.title, sample: saved.sample };
                        if (saved.provider) next.provider = saved.provider; else delete next.provider;
                        return next;
                    }
                    return person;
                });
                saveCast(restored);
            };
            // 名字完全一样优先；其次互相包含（两边都至少两个字，免得「白」对上「对白」）。
            const personOf = (speaker, people) => people.find((item) => item.name === speaker)
                || people.find((item) => item.name.length > 1 && speaker.length > 1 && (speaker.includes(item.name) || item.name.includes(speaker)));
            // 人物配的声音只在选它时的那个接口上算数（没标的是 Fish 的）；换了接口就用默认声音。
            const voiceOf = (person, provider = get('provider')) => (person?.id && (person.provider || 'fish') === provider ? person.id : '');

            const plain = (el) => el.textContent.replace(/\s+/g, ' ').trim();
            // 只把带明确属性/状态标签的短块当成状态栏；含数字或冒号的普通叙述（如时间、章节、无引号台词）保留。
            const looksLikeStatus = (text) => text.length <= 80 && !/[。！？!?，,；;]|\.(?:\s|$)/.test(text)
                && /^(?:好感(?:度)?|信任(?:度)?|体力|精力|生命(?:值)?|魔力|HP|MP|TIME|时间|日期|位置|地点|等级|金钱|余额|状态|SAN|理智|心情)\s*(?:[:：=]\s*\S|[-+]?\d)/i.test(text);

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
            const targetsSignature = (people) => people
                .filter((person) => LANGS[person.lang])
                .map((person) => `${person.name}:${person.lang}`)
                .sort()
                .join('|');
            function saveAnalysisLabels(card, key, labels) {
                if (store.card !== card) return;
                store.data = { ...store.data, [key]: labels.map((label) => [label.speaker, label.tone, label.pause ?? null, ...(label.lang ? [label.translation || '', label.lang] : [])]) };
                Object.keys(store.data).slice(0, -ANALYSIS_KEEP).forEach((old) => delete store.data[old]);
                ctx.data.set(`analysis:${card}`, store.data).catch((error) => ctx.log('分析结果没存上', error));
            }
            // 每行存 [说话人, 语气, 停顿, 译文, 译成的语言]，后两项只在翻译过时有。
            // anyLang：只要说话人和语气（画线、悬浮窗用）；不传时还要求译文的语言和人物现在配的一致，换过语言的要重新分析。
            function cachedLabels(lines, anyLang = false) {
                const saved = store.card === characterId() ? store.data[keyOf(lines)] : null;
                if (!Array.isArray(saved) || saved.length !== lines.length) return null;
                const people = anyLang ? null : readCast();
                if (people && saved.some(([speaker, , , , lang = '']) => langOf(speaker, people) !== lang)) return null;
                return saved.map(([speaker, tone, pause, translation, lang = '']) => ({ speaker, tone, pause, translation: translation || '', lang }));
            }

            let analyzing = null; // 正在分析的回复序号
            const analyzingTasks = new Map(); // taskKey → { index, card, controller, promise }
            const failures = new Map(); // 回复序号 → 分析失败的原因
            const inflight = new Map(); // 同一条回复同时只分析一次（按 card+key 索引）
            function syncAnalyzing() {
                const current = characterId();
                let active = null;
                for (const item of analyzingTasks.values()) if (item.card === current) active = item.index;
                analyzing = active;
            }
            function abortAnalyses(card = null) {
                for (const [taskKey, task] of [...inflight.entries()]) {
                    if (card && task.card !== card) continue;
                    task.controller?.abort();
                    inflight.delete(taskKey);
                    analyzingTasks.delete(taskKey);
                }
                syncAnalyzing();
            }
            // 分析失败时：引号里的用默认声音念，其余算旁白（不念）。force 为 true 时放弃缓存和旧的同消息分析，重新分析。
            async function analyze(index, force = false) {
                const card = characterId(), lines = linesOf(index);
                if (!lines.length) return { lines, labels: [] };
                if (store.card !== card) await loadStore();
                if (characterId() !== card) return { lines: [], labels: [] };
                const cached = force ? null : cachedLabels(lines);
                if (cached) return { lines, labels: cached };
                const key = keyOf(lines), taskKey = JSON.stringify([card, key]);
                const sig = `${get('analysisModel') || ''}|${targetsSignature(readCast())}`;
                const existing = inflight.get(taskKey);
                if (!force && existing && existing.sig === sig) return { lines, labels: await existing.promise };
                if (existing) {
                    existing.controller?.abort();
                    inflight.delete(taskKey);
                    analyzingTasks.delete(taskKey);
                }
                const controller = typeof AbortController === 'function' ? new AbortController() : null;
                const entry = { index, card, sig, controller, promise: null };
                entry.promise = requestLabels(index, lines, card, key, entry).finally(() => {
                    if (inflight.get(taskKey) === entry) inflight.delete(taskKey);
                    if (analyzingTasks.get(taskKey) === entry) analyzingTasks.delete(taskKey);
                    syncAnalyzing();
                    renderWidget();
                });
                inflight.set(taskKey, entry);
                analyzingTasks.set(taskKey, entry);
                syncAnalyzing();
                renderWidget();
                return { lines, labels: await entry.promise };
            }

            async function requestLabels(index, lines, card, key, entry) {
                const fallback = lines.map((line) => ({ speaker: line.quote ? DIALOGUE : NARRATOR, tone: '', pause: null, translation: '', lang: '' }));
                const rowRe = typeof ROW !== 'undefined' ? ROW : /\[\s*\d+\s*,\s*"(?:\\.|[^"\\])*"\s*,\s*"(?:\\.|[^"\\])*"(?:\s*,\s*\d+(?:\.\d+)?)?(?:\s*,\s*"(?:\\.|[^"\\])*")?\s*\]/g;
                const timeoutMs = typeof ANALYSIS_TIMEOUT === 'number' ? ANALYSIS_TIMEOUT : 180000;
                const signal = entry?.controller?.signal;
                let timedOut = false;
                let timer = null;
                if (entry?.controller && typeof setTimeout === 'function') {
                    timer = setTimeout(() => { timedOut = true; entry.controller.abort(); }, timeoutMs);
                }
                failures.delete(index);
                try {
                    if (!widgetVisible()) ctx.ui.toast('正在分析说话人和语气…', { kind: 'info' });
                    // 角色设定的前几百字，帮模型认人名。
                    const profile = String(character().description || '').replace(/\s+/g, ' ').trim().slice(0, 600);
                    // 声音标了语言的人物：让模型顺便把他的台词译过去。
                    const known = readCast();
                    const targets = known.filter((person) => LANGS[person.lang]).map((person) => `${person.name} → ${LANGS[person.lang]}`);
                    const maxChars = targets.length ? 1200 : 400;
                    const reply = await ctx.ai.complete({
                        model: get('analysisModel').trim() || undefined,
                        ...(signal ? { signal } : {}),
                        messages: [
                            { role: 'system', content: analyzePrompt(targets.length > 0) },
                            { role: 'user', content: [
                                `已知人物：${known.map((person) => person.name).join('、') || '（正文里出现谁就用谁的名字）'}`,
                                `用户扮演：${userName() || '未知'}`,
                                ...(targets.length ? [`声音语言：${targets.join('，')}`] : []),
                                ...(profile ? [`角色设定摘录：${profile}`] : []),
                                '\n正文：',
                                ...lines.map((line, i) => `${i + 1}. [${line.quote ? '对白' : '叙述'}] ${line.text.slice(0, maxChars)}`)
                            ].join('\n') }
                        ]
                    });
                    if (signal?.aborted) return fallback;
                    const parsed = parseJson(reply, '[');
                    const rows = (Array.isArray(parsed) ? parsed : [...reply.matchAll(rowRe)].map((match) => JSON.parse(match[0]))).filter(Array.isArray);
                    if (!rows.length) throw new Error(reply.trim() ? 'AI 返回的格式不正确' : 'AI 未返回内容，请更换分析模型');
                    const labels = new Array(lines.length);
                    const seen = new Set();
                    for (const row of rows) {
                        const i = Number(row[0]) - 1;
                        if (!Number.isInteger(i) || i < 0 || i >= lines.length || typeof row[1] !== 'string' || typeof row[2] !== 'string'
                            || (row[4] != null && typeof row[4] !== 'string')) {
                            throw new Error('配音表行号或内容无效，请重新分析');
                        }
                        if (seen.has(i)) throw new Error('配音表存在重复行号，请重新分析');
                        seen.add(i);
                        const pause = row[3] == null || row[3] === '' ? NaN : Number(row[3]);
                        const speaker = row[1].trim() || NARRATOR;
                        const lang = langOf(speaker, known);
                        labels[i] = {
                            speaker,
                            tone: row[2].replace(/[[\]]/g, '').trim().slice(0, 60),
                            pause: Number.isFinite(pause) ? Math.min(Math.max(pause, 0), 3) : null,
                            translation: lang ? String(row[4] || '').trim() : '',
                            lang
                        };
                    }
                    if (seen.size !== lines.length) throw new Error(`配音表不完整（${seen.size} / ${lines.length} 行），请重新分析`);
                    if (store.card === card && characterId() === card) {
                        saveAnalysisLabels(card, key, labels);
                    }
                    // 新出现的人物（不算旁白、回退占位「对白」和用户扮演的）加进配音表，等用户挑音色；挑之前用默认声音。
                    const people = readCast();
                    const fresh = [...new Set(labels.map((label) => label.speaker))]
                        .filter((speaker) => !isNarrator(speaker) && speaker !== DIALOGUE && speaker !== userName() && !people.some((item) => item.name === speaker));
                    if (fresh.length && characterId() === card) saveCast([...people, ...fresh.map((name) => ({ name }))]);
                    markRows([...document.querySelectorAll(`[data-chat-index="${index}"]`)]);
                    return labels;
                } catch (error) {
                    if (signal?.aborted && !timedOut) return fallback;
                    if (characterId() !== card) return fallback;
                    const reason = timedOut ? '分析超时，请更换更快的分析模型或重试' : (error?.message || String(error));
                    failures.set(index, reason);
                    ctx.ui.toast(`分析失败，本次引号内的台词使用默认声音：${reason}`, { kind: 'warning' });
                    return fallback;
                } finally {
                    if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer);
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
            function itemsOf(lines, labels, from = 0, only = false, provider = get('provider')) {
                const people = readCast();
                const rules = readJson('pronunciations', []).filter((rule) => rule?.from);
                const picked = lines.map((_, i) => i).filter((i) => i >= from && (!only || i === from) && voiced(labels[i].speaker));
                const items = [];
                picked.forEach((i, k) => {
                    const { speaker, tone, translation } = labels[i];
                    const voice = voiceOf(personOf(speaker, people), provider);
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

            // 本地持久音频缓存（可选开启，存在独立 IndexedDB 库里，不进云同步）。
            let audioDb = null;
            function openAudioDb() {
                if (!globalThis.indexedDB) return Promise.resolve(null);
                audioDb ||= new Promise((resolve, reject) => {
                    const req = indexedDB.open('RPHubVoiceAudio', 1);
                    req.onupgradeneeded = () => {
                        if (!req.result.objectStoreNames.contains('audio')) req.result.createObjectStore('audio', { keyPath: 'key' });
                    };
                    req.onsuccess = () => {
                        const db = req.result;
                        db.onversionchange = () => { db.close(); audioDb = null; };
                        resolve(db);
                    };
                    req.onerror = () => reject(req.error);
                    req.onblocked = () => reject(new Error('音频缓存库被占用'));
                }).catch(() => { audioDb = null; return null; });
                return audioDb;
            }
            async function audioTx(mode, op) {
                const db = await openAudioDb();
                if (!db) return undefined;
                return new Promise((resolve, reject) => {
                    const tx = db.transaction('audio', mode);
                    const req = op(tx.objectStore('audio'));
                    tx.oncomplete = () => resolve(req?.result);
                    tx.onerror = tx.onabort = () => reject(tx.error || new Error('音频缓存操作失败'));
                });
            }
            const persistEnabled = () => get('persistCache') === '1';
            const dbGetAudio = (key) => (persistEnabled() ? audioTx('readonly', (s) => s.get(key)).then((row) => row?.blob).catch(() => undefined) : Promise.resolve(undefined));
            const dbPutAudio = (key, blob) => (persistEnabled() ? audioTx('readwrite', (s) => s.put({ key, blob, size: blob.size, time: Date.now() })).catch(() => {}) : Promise.resolve());
            const dbDelAudio = (key) => audioTx('readwrite', (s) => s.delete(key)).catch(() => {});
            const dbClearAudio = () => audioTx('readwrite', (s) => s.clear()).catch(() => {});
            async function dbTrimAudio() {
                if (!persistEnabled()) return;
                const rows = await audioTx('readonly', (s) => s.getAll()).catch(() => []);
                if (!Array.isArray(rows) || !rows.length) return;
                rows.sort((a, b) => (b.time || 0) - (a.time || 0));
                let total = 0;
                const victims = rows.filter((row) => (total += row.size || 0) > PERSIST_CACHE_LIMIT);
                if (victims.length) await audioTx('readwrite', (s) => { victims.forEach((row) => s.delete(row.key)); return { result: victims.length }; }).catch(() => {});
            }

            // 把几段音频拼成一个 wav 下载（16 位 PCM，默认 24kHz 控制体积）。
            async function mergeToWav(blobs, pauses, signal) {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                let audioCtx;
                try { audioCtx = new AudioCtx({ sampleRate: 24000 }); } catch (_) { audioCtx = new AudioCtx(); }
                try {
                    const buffers = [];
                    for (let i = 0; i < blobs.length; i += 1) {
                        if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
                        try { buffers.push(await audioCtx.decodeAudioData(await blobs[i].arrayBuffer())); }
                        catch (error) { throw Object.assign(error, { audioIndex: i }); }
                    }
                    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
                    const rate = audioCtx.sampleRate;
                    const channels = Math.max(1, ...buffers.map((b) => b.numberOfChannels));
                    const gapList = buffers.map((_, i) => (i < buffers.length - 1 ? Math.round(((pauses[i] ?? 200) / 1000) * rate) : 0));
                    const frames = buffers.reduce((sum, b, i) => sum + b.length + gapList[i], 0);
                    const bytes = frames * channels * 2;
                    const view = new DataView(new ArrayBuffer(44 + bytes));
                    const write = (off, str) => { for (let i = 0; i < str.length; i += 1) view.setUint8(off + i, str.charCodeAt(i)); };
                    write(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); write(8, 'WAVE');
                    write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
                    view.setUint32(24, rate, true); view.setUint32(28, rate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
                    write(36, 'data'); view.setUint32(40, bytes, true);
                    let offset = 44;
                    buffers.forEach((buffer, idx) => {
                        const tracks = Array.from({ length: channels }, (_, c) => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
                        for (let i = 0; i < buffer.length; i += 1) {
                            for (const track of tracks) {
                                view.setInt16(offset, Math.round(Math.max(-1, Math.min(1, track[i])) * 32767), true);
                                offset += 2;
                            }
                        }
                        offset += gapList[idx] * channels * 2;
                    });
                    return new Blob([view.buffer], { type: 'audio/wav' });
                } finally {
                    audioCtx.close().catch(() => {});
                }
            }
            function downloadBlob(blob, filename) {
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = filename.replace(/[\\/:*?"<>|\r\n]+/g, '_');
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }

            const media = navigator.mediaSession;
            const setMediaState = (state) => { if (media) try { media.playbackState = state; } catch (_) { /* 浏览器不支持 */ } };
            const setMediaMeta = (item) => {
                if (media && typeof window.MediaMetadata === 'function') {
                    try { media.metadata = new MediaMetadata({ title: item.text.slice(0, 80), artist: item.speaker || '角色语音', album: character().name || '角色语音' }); } catch (_) { /* ignore */ }
                }
            };

            // 正在说的：{ index, stopped, abort, speaker, paused, at（说到第几段）, seek（要跳去的那段）, finish（结束正在放的这段）, move（叫醒在等的循环） }
            let session = null;
            let exportAbort = null;
            function stop(cancelAnalysis = false) {
                exportAbort?.abort();
                exportAbort = null;
                if (cancelAnalysis) abortAnalyses();
                if (session) {
                    session.stopped = true;
                    session.abort.abort();
                    session.finish?.();
                    session.move?.();
                }
                session = null;
                player.pause();
                setMediaState('none');
                refreshButtons();
                renderWidget();
            }
            // 暂停、继续：正在放的这段跟着停、接着放；还在等合成的，合成好了先不放。
            function togglePause() {
                if (!session) return;
                const current = session;
                current.paused = !current.paused;
                if (current.finish) {
                    if (current.paused) {
                        player.pause();
                    } else {
                        player.play().catch((error) => {
                            if (session === current && error?.name !== 'AbortError') {
                                ctx.log('继续播放失败', error);
                                ctx.ui.toast(`继续播放失败：${error?.message || error}`);
                                stop();
                            }
                        });
                    }
                }
                setMediaState(current.paused ? 'paused' : 'playing');
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
            if (media) {
                for (const [action, handler] of [['play', () => { if (session?.paused) togglePause(); }], ['pause', () => { if (session && !session.paused) togglePause(); }], ['stop', () => stop()], ['nexttrack', () => seek(1)], ['previoustrack', () => seek(-1)]]) {
                    try { media.setActionHandler(action, handler); } catch (_) { /* ignore */ }
                }
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
                if (signal?.aborted) return resolve();
                const timer = setTimeout(() => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve();
                }, ms);
                const onAbort = () => {
                    clearTimeout(timer);
                    resolve();
                };
                signal?.addEventListener('abort', onAbort, { once: true });
            });

            // 接口地址可以只填域名，也可以填到 /v1 或完整的 …/audio/speech，中转的路径前缀留着；
            // mode: 'compat'（Fish 兼容，没填 /v1 走 /compat/v1/audio/speech）、'native'（Fish 原生 /v1/tts）、'openai'（/v1/audio/speech）。
            function apiUrl(address, mode) {
                let url = null;
                try { url = new URL(address); } catch (_) { /* 和协议不对一起报 */ }
                if (!/^https?:$/.test(url?.protocol)) throw new Error('接口地址必须以 http:// 或 https:// 开头');
                const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:audio\/speech|tts)$/, '');
                const base = path.replace(/\/v1$/, '');
                if (mode === 'native') {
                    url.pathname = `${base.replace(/\/compat$/, '')}/v1/tts`;
                } else {
                    const compat = mode === true || mode === 'compat';
                    url.pathname = `${compat && base === path ? `${base.replace(/\/compat$/, '')}/compat` : base}/v1/audio/speech`;
                }
                url.hash = '';
                return url.href;
            }
            // 固定本次播放/导出的接口设置，途中修改设置不串线。
            function captureConfig() {
                const provider = get('provider');
                const url = fishUrl();
                let isOfficialFish = false;
                try { isOfficialFish = new URL(url).origin === FISH; } catch (_) { /* ignore */ }
                return {
                    provider,
                    fishProtocol: get('fishProtocol') === 'native' ? 'native' : 'compat',
                    fishUrl: url,
                    fishKey: get('fishKey').trim(),
                    fishModel: fishModelName(),
                    fishFormat: get('fishFormat') || 'mp3',
                    official: isOfficialFish,
                    openaiUrl: get('openaiUrl').trim(),
                    openaiKey: get('openaiKey').trim(),
                    openaiModel: get('openaiModel').trim(),
                    openaiVoice: get('openaiVoice').trim(),
                    openaiTone: get('openaiTone'),
                    openaiFormat: get('openaiFormat') || 'mp3',
                    fallbackVoice: template().voices[0] || 'alloy'
                };
            }
            function validateConfig(config) {
                if (config.provider === 'fish') {
                    if (config.official && !config.fishKey) return '请先在角色语音设置中填写 Fish Audio 密钥';
                    if (!config.fishModel) return '请先在角色语音设置中填写 Fish 模型名';
                    return '';
                }
                if (!config.openaiUrl) return '请先在角色语音设置中填写语音接口地址';
                if (!config.openaiModel) return '请先在角色语音设置中填写语音模型名';
                return '';
            }
            // 这一段向哪个接口要、带什么去要。语气：Fish 和选了「句首方括号」的接口写在句首；选了 instructions 的放那个字段（tts-1 系列不认，不传）。
            function speechRequest({ text, voice, tone }, config = captureConfig()) {
                const cleanTone = String(tone || '').replace(/[[\]]/g, '').trim();
                if (config.provider === 'fish') {
                    const input = cleanTone ? `[${cleanTone}] ${text}` : text;
                    if (config.fishProtocol === 'native') {
                        return {
                            url: apiUrl(config.fishUrl, 'native'),
                            key: config.fishKey,
                            headers: { model: config.fishModel.replace(/^fish-audio\//, '') },
                            body: { text: input, ...(voice ? { reference_id: voice } : {}), format: config.fishFormat }
                        };
                    }
                    return {
                        url: apiUrl(config.fishUrl, 'compat'),
                        key: config.fishKey,
                        body: { model: config.fishModel, input, voice, response_format: config.fishFormat }
                    };
                }
                const mode = config.openaiTone;
                const model = config.openaiModel;
                return {
                    url: apiUrl(config.openaiUrl, 'openai'),
                    key: config.openaiKey,
                    body: {
                        model,
                        input: mode === 'bracket' && cleanTone ? `[${cleanTone}] ${text}` : text,
                        voice: voice || config.openaiVoice || config.fallbackVoice,
                        response_format: config.openaiFormat,
                        ...(mode === 'instructions' && cleanTone && !/(?:^|\/)tts-1(?:-hd)?(?:-\d+)?$/i.test(model) ? { instructions: cleanTone } : {})
                    }
                };
            }

            const cache = new Map();
            const cacheKeyOf = (target) => JSON.stringify([target.url, target.headers || null, target.body]);
            const failure = (message, status) => Object.assign(new Error(message), { status });
            // 向接口要一段语音。出错时带上状态码，播放那边据此决定重试、跳过还是停。
            async function request({ url, key, body, headers }, signal) {
                const controller = new AbortController();
                const cancel = () => controller.abort();
                if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
                const timer = setTimeout(cancel, TIMEOUT);
                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        signal: controller.signal,
                        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(headers || {}) },
                        body: JSON.stringify(body)
                    });
                    if (!response.ok) {
                        const detail = await response.text().catch(() => '');
                        let reason = detail;
                        try {
                            const json = JSON.parse(detail);
                            const picked = [json.error?.message, json.message, json.detail, json.error].find((item) => item != null && item !== '');
                            reason = typeof picked === 'string' ? picked : (picked ? JSON.stringify(picked) : detail);
                        } catch (_) { /* 不是 JSON，用原文 */ }
                        const status = ERROR_HINTS[response.status] ? `${response.status}，${ERROR_HINTS[response.status]}` : response.status;
                        throw failure(`语音合成失败（${status}）：${String(reason).slice(0, 200) || response.statusText}`, response.status);
                    }
                    const contentType = response.headers.get('content-type') || '';
                    if (/json|^text\//i.test(contentType)) throw failure('语音接口返回的不是音频');
                    const blob = await response.blob();
                    // 回的是一段文字（出错了却没给错误码）或者空的：不当成语音存下来。
                    if (!blob.size || /json|^text\//i.test(blob.type)) throw failure('语音接口返回的不是音频');
                    return blob;
                } catch (error) {
                    if (controller.signal.aborted && !signal.aborted) throw failure('语音接口响应超时', 408);
                    // 浏览器只说 Failed to fetch：地址写错、接口不通，或者接口不让网页直接调用。
                    throw error instanceof TypeError ? failure('无法连接语音接口：请检查接口地址，或该接口不支持网页直接调用') : error;
                } finally {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', cancel);
                }
            }
            async function synthesize(item, signal, config = captureConfig()) {
                const target = speechRequest(item, config);
                const key = cacheKeyOf(target);
                if (cache.has(key)) return { blob: cache.get(key), key };
                const persisted = await dbGetAudio(key);
                if (signal.aborted) throw new DOMException('已停止', 'AbortError');
                if (persisted) {
                    cache.set(key, persisted);
                    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
                    return { blob: persisted, key };
                }
                const blob = await request(target, signal).catch(async (error) => {
                    if (signal.aborted || !RETRYABLE.includes(error.status)) throw error;
                    await wait(1500, signal);
                    if (signal.aborted) throw error;
                    return request(target, signal);
                });
                cache.set(key, blob);
                if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
                await dbPutAudio(key, blob);
                return { blob, key };
            }
            function evictAudio(key) {
                if (!key) return;
                cache.delete(key);
                dbDelAudio(key);
            }

            function play(blob, current) {
                return new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(blob);
                    let settled = false;
                    const finish = (error) => {
                        if (settled) return;
                        settled = true;
                        player.pause(); // 换句时这段还没放完，先停下，别和下一段叠在一起
                        player.onended = player.onerror = null;
                        if (current.finish === cancelPlay) current.finish = null;
                        player.removeAttribute('src');
                        player.load();
                        URL.revokeObjectURL(url);
                        if (error) reject(error); else resolve();
                    };
                    const cancelPlay = () => finish();
                    current.finish = cancelPlay;
                    player.onended = () => finish();
                    player.onerror = () => finish(new DOMException('播放失败，接口返回的可能不是音频', 'EncodingError'));
                    player.src = url;
                    tune();
                    player.play().catch((error) => finish(error));
                });
            }

            // 正在说的那句：支持文字高亮的浏览器只标这一句，否则给整段标底色。
            const highlights = globalThis.CSS?.highlights && typeof globalThis.Highlight === 'function' ? CSS.highlights : null;
            function revealLine(line) {
                if (!line || get('follow') !== '1') return;
                try {
                    const target = highlights ? rangeOf(line) : line.el;
                    const rect = target.getBoundingClientRect();
                    if (rect.top >= 0 && rect.bottom <= innerHeight) return;
                    line.el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                } catch (_) { /* 正文已重画 */ }
            }
            function showSpeaking(line) {
                if (highlights) {
                    if (line) {
                        highlights.set('rph-voice-now', new Highlight(rangeOf(line)));
                        revealLine(line);
                    } else {
                        highlights.delete('rph-voice-now');
                    }
                    return;
                }
                document.querySelectorAll(`.${SPEAKING}`).forEach((el) => el.classList.remove(SPEAKING));
                if (line?.el) {
                    line.el.classList.add(SPEAKING);
                    revealLine(line);
                }
            }
            // 说一条回复：没分析过先分析，再按人物的声音一句句说，句与句之间按节奏停顿；边播边生成下一段。
            // from 是从第几句开始，only 为 true 时只说这一句（点台词时用）。
            async function speak(index, { from = 0, only = false } = {}) {
                stop();
                const config = captureConfig();
                const invalid = validateConfig(config);
                if (invalid) return ctx.ui.toast(invalid, { kind: 'warning' });
                // 通知其他语音插件（如「朗读」）停下，避免重叠出声。
                try { window.dispatchEvent(new CustomEvent('rph:voice-start', { detail: { source: 'character-voice' } })); } catch (_) { /* ignore */ }
                const current = session = { index, stopped: false, abort: new AbortController(), speaker: '', paused: false, at: 0, seek: null };
                const signal = current.abort.signal;
                let finished = false; // 自己说完的（没被停、没出错）才接着说后面的回复
                refreshButtons();
                renderWidget();
                try {
                    const { lines, labels } = await analyze(index);
                    if (current.stopped) return;
                    const items = itemsOf(lines, labels, from, only, config.provider);
                    if (!items.length) ctx.ui.toast('这条回复里没有人物台词', { kind: 'info' });
                    const loads = new Map();
                    const loadKey = (i) => cacheKeyOf(speechRequest(items[i], config));
                    const load = (i) => {
                        const key = loadKey(i);
                        if (!loads.has(key)) {
                            const pending = synthesize(items[i], signal, config);
                            pending.catch(() => {}); // 防止预取失败或切句放弃等待时产生未捕获拒绝
                            loads.set(key, pending);
                        }
                        return loads.get(key);
                    };
                    let failed = 0; // 连着几句没合成出来
                    let i = 0;
                    while (!current.stopped) {
                        // 上一句、下一句：跳到那一段；跳过了最后一段就结束。
                        if (current.seek !== null) [i, current.seek] = [current.seek, null];
                        if (i >= items.length) break;
                        current.at = i;
                        const moved = new Promise((resolve) => { current.move = resolve; }); // 换句时不再等这一段
                        const pending = load(i);
                        let result;
                        try {
                            result = await Promise.race([pending, moved]);
                        } catch (error) {
                            loads.delete(loadKey(i)); // 消费失败后再清除，既避免预取失败重发，也允许上一句重试
                            failed += 1;
                            if (current.stopped || !SKIPPABLE.includes(error.status)) throw error;
                            if (failed >= 3) throw new Error(`连续 3 句合成失败，已停止：${error.message}`);
                            ctx.ui.toast(`已跳过一句：${error.message}`, { kind: 'warning' });
                            i += 1;
                            continue;
                        }
                        if (current.seek !== null || !result) continue;
                        failed = 0;
                        if (i + 1 < items.length) load(i + 1).catch(() => {});
                        while (current.paused && !current.stopped && current.seek === null) await Promise.race([wait(200, signal), moved]);
                        if (current.stopped || current.seek !== null) continue;
                        current.speaker = items[i].speaker;
                        setMediaMeta(items[i]);
                        setMediaState('playing');
                        renderWidget();
                        showSpeaking(items[i].line);
                        try {
                            await play(result.blob, current);
                        } catch (error) {
                            if (['EncodingError', 'NotSupportedError'].includes(error?.name)) evictAudio(result.key);
                            throw error;
                        } finally {
                            showSpeaking(null);
                        }
                        if (items[i].pause && !current.stopped && current.seek === null) await Promise.race([wait(items[i].pause, signal), moved]);
                        if (current.seek === null) i += 1;
                    }
                    finished = !current.stopped && failed === 0;
                } catch (error) {
                    if (!current.stopped) {
                        ctx.ui.toast(error?.name === 'NotAllowedError' ? '浏览器阻止了自动播放，请手动点击播放' : error?.message || String(error), { kind: 'error' });
                    }
                } finally {
                    if (session === current) {
                        session = null;
                        setMediaState('none');
                        refreshButtons();
                        renderWidget();
                    }
                    dbTrimAudio();
                }
                // 连播：这条自己说完了，接着说后面的回复。
                if (finished && !only && get('continuous') === '1') {
                    const next = (ctx.app.get('chatHistory') || []).findIndex((message, i) => i > index && message?.role === 'assistant');
                    if (next >= 0 && messageBody(next)) await speak(next);
                }
            }
            async function exportWav(index) {
                stop();
                const config = captureConfig();
                const invalid = validateConfig(config);
                if (invalid) return ctx.ui.toast(invalid, { kind: 'warning' });
                const card = characterId();
                const controller = new AbortController();
                exportAbort = controller;
                const { signal } = controller;
                const keys = [];
                try {
                    const { lines, labels } = await analyze(index);
                    if (signal.aborted || characterId() !== card) return;
                    const items = itemsOf(lines, labels, 0, false, config.provider);
                    if (!items.length) return ctx.ui.toast('这条回复里没有人物台词', { kind: 'info' });
                    ctx.ui.toast(`正在合成并导出（共 ${items.length} 段）…`, { kind: 'info' });
                    const blobs = [];
                    const pauses = [];
                    for (let i = 0; i < items.length; i += 1) {
                        if (signal.aborted || characterId() !== card) return;
                        const { blob, key } = await synthesize(items[i], signal, config);
                        blobs.push(blob);
                        pauses.push(items[i].pause || 200);
                        keys.push(key);
                    }
                    const wav = await mergeToWav(blobs, pauses, signal);
                    if (signal.aborted || characterId() !== card) return;
                    downloadBlob(wav, `${character().name || '角色语音'}-${index + 1}.wav`);
                    ctx.ui.toast(`导出完成，共 ${items.length} 段`, { kind: 'success' });
                } catch (error) {
                    if (typeof error?.audioIndex === 'number') evictAudio(keys[error.audioIndex]);
                    if (!signal.aborted && error?.name !== 'AbortError') ctx.ui.toast(`导出失败：${error?.message || error}`);
                } finally {
                    if (exportAbort === controller) exportAbort = null;
                    dbTrimAudio();
                }
            }
            function toggleSpeaking(index) {
                if (session?.index === index) return stop();
                if (!messageBody(index)) return ctx.ui.toast('这条消息没有可播放的文字', { kind: 'info' });
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
                popover.querySelector('.rph-voice-pop__tone').textContent = mark.tone ? `语气：${mark.tone}` : '未标注语气';
                popover.querySelector('.rph-voice-pop__said').textContent = mark.translation ? `译文：${mark.translation}` : '';
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
                const sel = getSelection();
                if (!marks.size || (sel && !sel.isCollapsed)) return;
                const row = event.target.closest?.('[data-chat-index]');
                const found = row && marks.get(row);
                if (!found) return;
                const { clientX: x, clientY: y } = event;
                const hit = (rect) => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2;
                const mark = found.find((item) => [...item.range.getClientRects()].some(hit));
                if (mark) openPopover(mark, x, y);
            });
            addEventListener('keydown', (event) => {
                if (event.key === 'Escape') closePopover();
                if (!event.altKey || event.ctrlKey || event.metaKey || get('hotkeys') !== '1' || ctx.app.get('currentView') !== 'chat') return;
                const actions = {
                    KeyP: () => {
                        if (session) return togglePause();
                        const index = lastReplyIndex();
                        if (index >= 0) toggleSpeaking(index);
                    },
                    KeyS: () => stop(true),
                    BracketLeft: () => seek(-1),
                    BracketRight: () => seek(1)
                };
                if (!actions[event.code]) return;
                event.preventDefault();
                actions[event.code]();
            });
            addEventListener('scroll', closePopover, true);
            addEventListener('pagehide', () => {
                stop(true);
                preview.pause();
            });
            addEventListener('rph:voice-start', (event) => {
                if (event?.detail?.source && event.detail.source !== 'character-voice' && session) stop();
            });

            // 预览与编辑弹窗：查看并修改最新回复每句的说话人、语气、译文，可从某句开始播放、重新分析或导出 WAV。
            async function openPreviewModal(index, force = false) {
                const card = characterId();
                if (index < 0 || !messageBody(index)) return ctx.ui.toast('暂无可预览的回复', { kind: 'info' });
                const { lines, labels } = await analyze(index, force);
                if (!lines.length || characterId() !== card) return;
                const key = keyOf(lines);
                ctx.ui.openPanel({
                    title: '配音预览与编辑',
                    render(body, modal) {
                        const people = readCast();
                        const knownNames = [...new Set([NARRATOR, userName(), ...people.map((p) => p.name)].filter(Boolean))];
                        const datalistId = `rph-voice-names-${Date.now()}`;
                        const datalist = document.createElement('datalist');
                        datalist.id = datalistId;
                        knownNames.forEach((name) => datalist.appendChild(new Option(name)));
                        const hint = document.createElement('p');
                        hint.className = 'rph-ui-muted';
                        hint.textContent = '可修改每句的说话人、语气和译文（灰显表示按当前设置不朗读）。';
                        const list = document.createElement('div');
                        list.style.cssText = 'max-height:55vh;overflow:auto;margin:0.5rem 0';
                        const inputs = [];
                        lines.forEach((line, i) => {
                            const label = labels[i];
                            const row = document.createElement('div');
                            row.className = `rph-voice-preview-row${voiced(label.speaker) ? '' : ' is-skipped'}`;
                            const playOne = document.createElement('button');
                            playOne.type = 'button';
                            playOne.className = 'modal-secondary-button rph-ui-button';
                            playOne.textContent = '▶';
                            playOne.title = '从这句开始播放';
                            const speakerInput = Object.assign(document.createElement('input'), {
                                className: 'rph-ui-input', value: label.speaker, placeholder: '说话人', autocomplete: 'off'
                            });
                            speakerInput.setAttribute('list', datalistId);
                            speakerInput.style.cssText = 'width:7.5rem;min-width:0;padding:4px 8px;font-size:12px';
                            speakerInput.oninput = () => row.classList.toggle('is-skipped', !voiced(speakerInput.value.trim() || NARRATOR));
                            const toneInput = Object.assign(document.createElement('input'), {
                                className: 'rph-ui-input', value: label.tone || '', placeholder: '语气（英文）', autocomplete: 'off'
                            });
                            toneInput.style.cssText = 'flex:1;min-width:8rem;padding:4px 8px;font-size:12px';
                            const textDiv = document.createElement('div');
                            textDiv.className = 'rph-voice-preview-text';
                            textDiv.textContent = line.text;
                            let transInput = null;
                            if (label.translation || label.lang || langOf(label.speaker, people)) {
                                transInput = Object.assign(document.createElement('input'), {
                                    className: 'rph-ui-input', value: label.translation || '', placeholder: '译文（留空念原文）', autocomplete: 'off'
                                });
                                transInput.style.cssText = 'flex:1 1 100%;padding:4px 8px;font-size:12px';
                            }
                            const collectAndSave = () => {
                                const curPeople = readCast();
                                const edited = inputs.map((item, idx) => {
                                    const sp = item.speakerInput.value.trim() || NARRATOR;
                                    const lang = langOf(sp, curPeople) || labels[idx].lang || '';
                                    return {
                                        speaker: sp,
                                        tone: item.toneInput.value.replace(/[[\]]/g, '').trim().slice(0, 60),
                                        pause: labels[idx].pause ?? null,
                                        translation: item.transInput ? item.transInput.value.trim() : (labels[idx].translation || ''),
                                        lang
                                    };
                                });
                                saveAnalysisLabels(card, key, edited);
                                const fresh = [...new Set(edited.map((item) => item.speaker))]
                                    .filter((sp) => !isNarrator(sp) && sp !== DIALOGUE && sp !== userName() && !curPeople.some((p) => p.name === sp));
                                if (fresh.length && characterId() === card) saveCast([...curPeople, ...fresh.map((name) => ({ name }))]);
                                markAll();
                                renderWidget();
                            };
                            playOne.onclick = () => {
                                collectAndSave();
                                modal?.close();
                                unlock();
                                speak(index, { from: i }).catch((error) => ctx.log('角色语音失败', error));
                            };
                            inputs.push({ speakerInput, toneInput, transInput, collectAndSave });
                            row.append(playOne, speakerInput, toneInput, textDiv);
                            if (transInput) row.append(transInput);
                            list.appendChild(row);
                        });
                        const actions = document.createElement('div');
                        actions.className = 'rph-ui-actions';
                        actions.style.cssText = 'justify-content:flex-end;flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem';
                        const makeBtn = (label, primary, onClick) => {
                            const btn = document.createElement('button');
                            btn.type = 'button';
                            btn.className = `${primary ? 'modal-primary-button' : 'modal-secondary-button'} rph-ui-button`;
                            btn.textContent = label;
                            btn.onclick = onClick;
                            return btn;
                        };
                        const saveAll = () => inputs[0]?.collectAndSave();
                        actions.append(
                            makeBtn('重新分析', false, () => { modal?.close(); openPreviewModal(index, true).catch((error) => ctx.log('分析失败', error)); }),
                            makeBtn('导出 WAV', false, () => { saveAll(); modal?.close(); exportWav(index); }),
                            makeBtn('保存并播放', true, () => { saveAll(); modal?.close(); unlock(); speak(index).catch((error) => ctx.log('角色语音失败', error)); })
                        );
                        body.append(datalist, hint, list, actions);
                    }
                });
            }

            // ---- 状态悬浮窗：聊天页右下角，能拖动、能收起成小圆点，位置记在这台设备上 ----
            let widget = null;
            let widgetPlacedAfterShow = false;
            const widgetVisible = () => get('widget') === '1' && ctx.app.get('currentView') === 'chat' && !!characterId();
            function saveWidgetState() {
                const rect = widget.getBoundingClientRect();
                try {
                    localStorage.setItem(WIDGET_KEY, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top), folded: widget.classList.contains('is-folded') }));
                } catch (_) { /* storage blocked */ }
            }
            function placeWidget(x, y) {
                const folded = widget.classList.contains('is-folded');
                const width = widget.offsetWidth || (folded ? 42 : 220);
                const height = widget.offsetHeight || (folded ? 42 : 100);
                const left = Math.min(Math.max(4, x), Math.max(4, innerWidth - width - 4));
                const top = Math.min(Math.max(4, y), Math.max(4, innerHeight - height - 4));
                Object.assign(widget.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
            }
            // 按住拖动；没怎么动就算点击。
            function draggable(handle, onClick) {
                handle.addEventListener('pointerdown', (event) => {
                    if (event.button !== 0 || event.target.closest('[data-collapse], [data-settings], [data-preview]')) return;
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
                        <div class="rph-voice-widget__head" data-drag><strong>角色语音</strong><span class="rph-voice-widget__tools"><button type="button" class="rph-voice-widget__fold" data-preview title="预览与编辑配音" aria-label="预览与编辑配音">${icon([LIST_PATH], 'w-4 h-4')}</button><button type="button" class="rph-voice-widget__fold" data-settings title="角色语音设置" aria-label="角色语音设置">${icon(GEAR_PATHS, 'w-4 h-4')}</button><button type="button" class="rph-voice-widget__fold" data-collapse title="收起" aria-label="收起">－</button></span></div>
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
                const expandBtn = widget.querySelector('[data-expand]');
                draggable(expandBtn, () => setFolded(false));
                expandBtn.addEventListener('keydown', (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setFolded(false);
                });
                widget.querySelector('[data-collapse]').onclick = () => setFolded(true);
                widget.querySelector('[data-settings]').onclick = () => openSettings();
                widget.querySelector('[data-preview]').onclick = () => {
                    const index = lastReplyIndex();
                    if (index >= 0) openPreviewModal(index).catch((error) => ctx.log('打开预览失败', error));
                };
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
                if (!widgetPlacedAfterShow) {
                    widgetPlacedAfterShow = true;
                    if (root.style.left) placeWidget(parseFloat(root.style.left), parseFloat(root.style.top));
                }
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
                if (analyzing !== null) return void (status.textContent = '分析中…');
                if (session) return void (status.textContent = `${session.paused ? '已暂停' : '正在播放'}：${session.speaker || '…'}`);
                if (generating) return void (status.textContent = '回复生成中…');
                if (index < 0) return void (status.textContent = '暂无 AI 回复');
                const lines = linesOf(index);
                const labels = cachedLabels(lines, true);
                if (!labels) {
                    status.textContent = failures.has(index) ? `分析失败：${failures.get(index)}` : (lines.length ? '最新回复未分析' : '最新回复里没有可播放的文字');
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
                const [nextCard] = value.split('\n');
                const [prevCard] = previous.split('\n');
                if (nextCard !== prevCard) {
                    abortAnalyses(prevCard);
                    if (session) stop();
                }
                closePopover();
                renderWidget();
                loadStore().then(markAll, () => {});
            });
            refreshButtons();
            renderWidget();
            loadStore().then(markAll, () => {});

            // ---- 挑音色：Fish 公共声音库（不用密钥，网页能直接搜），用库里的声音不占 Fish 账号的保存名额 ----
            // 声音自带语言（Fish 给每个声音标的）：选了它，这个人的台词就念那种语言。自己账号里的私有声音 Fish 猜得不准，不带，留给人物那行自己选。
            const toVoice = (item) => ({
                id: item._id, title: item.title || item._id, tags: (item.tags || []).slice(0, 5), sample: item.samples?.[0]?.audio || '',
                lang: item.visibility !== 'private' && LANGS[item.languages?.[0]] ? item.languages[0] : ''
            });
            // 搜一页某种语言的声音（language 空着是不限语言），按热度排；返回 Fish 原样的 { items, total }。
            async function libraryPage({ title = '', tags = [], page = 1, language = 'zh' }) {
                const url = new URL(FISH_LIBRARY);
                url.searchParams.set('page_size', String(PAGE_SIZE));
                url.searchParams.set('page_number', String(page));
                url.searchParams.set('sort_by', 'score');
                if (language) url.searchParams.set('language', language);
                if (title) url.searchParams.set('title', title);
                tags.filter((tag) => tag && tag !== 'unknown').forEach((tag) => url.searchParams.append('tag', tag));
                const response = await fetch(url);
                if (!response.ok) throw new Error(`Fish 声音库搜索失败（${response.status}）`);
                return response.json();
            }
            async function searchPage(title, page, language) {
                const data = await libraryPage({ title, page, language });
                return { voices: (data.items || []).filter((item) => item?._id).map(toVoice), total: Number(data.total) || 0 };
            }
            // 按 ID 查一个声音；带上密钥，自己账号里的私有声音也查得到。
            // 走中转时密钥是中转的，不发给 Fish 官方：私有声音就查不到，照样让用，名字写成 ID。
            async function lookupVoice(id) {
                const key = official() ? get('fishKey').trim() : '';
                const response = await fetch(`${FISH_LIBRARY}/${id}`, key ? { headers: { Authorization: `Bearer ${key}` } } : {});
                if (response.status === 404 && !official()) return { id, title: id, tags: [], sample: '' };
                if (!response.ok) throw new Error(response.status === 404 ? '未找到该声音，请检查声音 ID' : `查询声音失败（${response.status}）`);
                return toVoice(await response.json());
            }
            // AI 推荐：几组条件各搜一页，合在一起按对得上的程度排，取前 8 个。
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

            // 分析用的模型列表：和 RPH 自己获取模型一样，用站点的 AI 接口去取（本地无密钥接口也允许），去掉嵌入模型。
            let models = null;
            async function listModels() {
                const settings = ctx.app.get('settings') || {};
                const endpoint = globalThis.RPHubApiUtils?.buildApiEndpoint;
                const client = globalThis.RPHubApiClient;
                if (!endpoint || !client?.requestJson) throw new Error('当前版本的 RPH 不支持获取模型列表');
                if (!String(settings.apiUrl || '').trim()) throw new Error('请先在 RPH 设置中填写 AI 接口地址');
                const apiKey = String(settings.apiKey || '').trim();
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

            // language：在哪种语言的声音里挑。
            async function aiPick(name, language) {
                const reply = await ctx.ai.complete({
                    model: get('analysisModel').trim() || undefined,
                    messages: [{ role: 'system', content: PICK_PROMPT }, { role: 'user', content: `人物：${name}\n资料：\n${aboutPerson(name) || '（世界书里没找到这个人的资料，按名字推测）'}` }]
                });
                const want = parseJson(reply, '{');
                if (!want) throw new Error('AI 返回的格式不正确');
                const keywords = (Array.isArray(want.keywords) ? want.keywords : []).map(String).filter(Boolean).slice(0, 2);
                const gender = ['male', 'female'].includes(want.gender) ? want.gender : '';
                const age = ['young', 'middle-aged', 'old'].includes(want.age) ? want.age : '';
                const voices = await searchLibrary([...keywords.map((title) => ({ title, tags: [gender], language })), { tags: [gender, age], language }],
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
                let sampleUrl = '';
                let sampleAbort = null;
                let sampleOwner = null;
                let sampleTurn = 0;
                const stopSample = () => {
                    sampleTurn += 1;
                    sampleAbort?.abort();
                    sampleAbort = null;
                    if (sampleOwner) {
                        sampleOwner.textContent = '试听';
                        sampleOwner.disabled = false;
                        sampleOwner = null;
                    }
                    preview.pause();
                    preview.removeAttribute('src');
                    preview.load();
                    if (sampleUrl) {
                        URL.revokeObjectURL(sampleUrl);
                        sampleUrl = '';
                    }
                };
                preview.onended = preview.onerror = () => stopSample();
                const paint = () => {
                    stopSample();
                    selects.forEach((item) => item.unmount());
                    // 样式类名见 WORKSHOP-MOD-GUIDE.md「面板样式」，跟随页面主题和深色模式。
                    // 密钥框不用 type=password：浏览器会把它当成网站登录密码，配音表一重画就弹「要更新密码吗」，点了还会把站点密码换成语音接口的密钥。
                    const fish = isFish();
                    const customFish = get('fishModel') === '__custom__';
                    const SECRET = 'data-1p-ignore data-lpignore="true" style="-webkit-text-security:disc"';
                    const card = (title, paths, content, note = '') => `<div class="settings-card">
                        <div class="settings-card__header"><div class="settings-card__title">${icon(paths, 'w-5 h-5 mr-2')}${title}${note}</div></div>
                        <div class="settings-card__body">${content}</div></div>`;
                    const text = (key, label, placeholder, attrs = '') => `<label class="rph-ui-field">${label}<input class="rph-ui-input" type="text" data-k="${key}" autocomplete="off" spellcheck="false" ${attrs} placeholder="${placeholder}"></label>`;
                    const select = (key, label, options) => `<div class="rph-ui-field"><span>${label}</span><select class="rph-ui-input" data-k="${key}">${options.map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}</select></div>`;
                    const toggle = (key, label) => `<div class="rph-ui-field"><label class="rph-ui-check" style="white-space:normal"><input type="checkbox" class="settings-toggle-input sr-only" data-k="${key}"><span class="settings-toggle" style="flex-shrink:0"></span><span>${label}</span></label></div>`;
                    const range = (key, label, min, max) => `<label class="rph-ui-field"><span>${label} <span data-show="${key}"></span></span><input type="range" min="${min}" max="${max}" step="0.05" class="${RANGE_CLASS}" data-k="${key}"></label>`;
                    body.innerHTML = card('语音接口', [SPEAKER_PATH], select('provider', '接口', [['fish', 'Fish Audio'], ['openai', 'OpenAI 兼容接口']]) + (fish
                        ? select('fishProtocol', '接口格式', [['compat', 'OpenAI 兼容格式'], ['native', 'Fish 原生格式（/v1/tts）']])
                            + text('fishUrl', '接口地址', '留空使用官方地址，或填写中转地址')
                            + text('fishKey', '密钥', '官方密钥在 fish.audio 获取（无认证自建可留空）', SECRET)
                            + select('fishModel', '模型', [['fish-audio/s2.1-pro-free', 'S2.1 Pro 免费版'], ['fish-audio/s2.1-pro', 'S2.1 Pro（按字数收费）'], ['__custom__', '自定义模型…']])
                            + (customFish ? text('fishCustomModel', '自定义模型名', '如 s1、speech-1.6 或中转配置的模型名') : '')
                            + select('fishFormat', '音频格式', [['mp3', 'mp3'], ['wav', 'wav（不压缩，体积大）']])
                        : select('openaiTemplate', '常用提供商', TEMPLATES.map((item) => [item.id, item.label]))
                            + text('openaiUrl', '接口地址', 'https://…，可填域名或 /v1 地址')
                            + text('openaiKey', '密钥', '无需密钥的接口可留空', SECRET)
                            + text('openaiModel', '模型', '按接口文档填写')
                            + text('openaiVoice', '默认声音', `留空使用 ${template().voices[0] || 'alloy'}`)
                            + select('openaiTone', '语气传递方式', [['instructions', 'instructions 字段（gpt-4o-mini-tts 等）'], ['bracket', '句首方括号（Fish 格式）'], ['none', '不传递']])
                            + select('openaiFormat', '音频格式', ['mp3', 'wav', 'opus', 'aac', 'flac'].map((name) => [name, name]))))
                        + card('基本设置', GEAR_PATHS, `
                        <div class="rph-ui-field"><span>分析模型</span><select class="rph-ui-input" data-k="analysisModel"></select></div>
                        <div class="rph-ui-actions" style="justify-content:space-between;align-items:center;margin:-0.25rem 0 0.75rem"><span class="rph-ui-muted" data-models-note></span><button type="button" class="modal-secondary-button rph-ui-button" data-refresh-models>刷新模型列表</button></div>
                        ${select('analyzeMode', '分析时机', [['click', '点击「分析」或播放时'], ['auto', '回复完成后自动分析']])}
                        ${toggle('autoPlay', '自动播放')}
                        ${toggle('continuous', '连续播放')}
                        ${toggle('userLines', '播放用户台词')}
                        ${toggle('widget', '显示悬浮窗')}
                        ${toggle('follow', '播放时跟随滚动到正在念的句子')}
                        ${toggle('hotkeys', '快捷键（Alt+P 播放/暂停，Alt+S 停止，Alt+[/] 上下句）')}
                        ${toggle('persistCache', '本地持久缓存合成音频（刷新后免重复扣费）')}
                        <div class="rph-ui-actions" style="justify-content:flex-end;margin:-0.25rem 0 0.75rem"><button type="button" class="modal-secondary-button rph-ui-button" data-clear-audio>清空音频缓存</button></div>
                        ${range('volume', '音量', 0, 1)}
                        ${range('speed', '语速', 0.5, 2)}`)
                        + card('读音替换', [SWAP_PATH], '<div data-rules></div><div class="rph-ui-actions" style="margin-top:0.75rem"><button type="button" class="modal-secondary-button rph-ui-button" data-add-rule>添加</button></div>')
                        + card('配音表', [PEOPLE_PATH], `
                            <div data-cast></div>
                            <div class="rph-ui-actions" style="margin-top:0.75rem"><input class="rph-ui-input" data-new-person placeholder="人物名称" style="flex:1;min-width:0"><button type="button" class="modal-secondary-button rph-ui-button" data-add-person>添加人物</button></div>`,
                        '<span class="rph-ui-muted" style="margin-left:0.5rem;font-weight:400" data-card-name></span>');
                    body.querySelector('[data-card-name]').textContent = character().name ? `当前角色卡：${character().name}` : '请先打开角色卡';
                    body.querySelector('[data-clear-audio]').onclick = async () => {
                        cache.clear();
                        await dbClearAudio();
                        ctx.ui.toast('音频缓存已清空', { kind: 'info' });
                    };

                    // 分析用的模型：从站点的 AI 接口取模型列表（和 RPH 自己获取模型一样，去掉嵌入模型），这次打开页面只取一次。
                    const modelSelect = body.querySelector('[data-k="analysisModel"]');
                    const modelsNote = body.querySelector('[data-models-note]');
                    const fillModels = () => {
                        if (!body.isConnected || !modelSelect.isConnected) return;
                        const saved = get('analysisModel');
                        const list = models || [];
                        modelSelect.replaceChildren(new Option('跟随 RPH 分析模型（未设置时使用主模型）', ''), ...list.map((id) => new Option(id, id)));
                        if (saved && !list.includes(saved)) modelSelect.appendChild(new Option(`${saved}（不在列表里）`, saved));
                        modelSelect.value = saved;
                    };
                    const loadModels = async () => {
                        modelsNote.textContent = '正在获取模型列表…';
                        try {
                            models = await listModels();
                            if (!body.isConnected || !modelsNote.isConnected) return;
                            modelsNote.textContent = `共 ${models.length} 个模型`;
                        } catch (error) {
                            if (!body.isConnected || !modelsNote.isConnected) return;
                            modelsNote.textContent = `获取模型列表失败：${error?.message || error}`;
                        }
                        fillModels();
                    };
                    fillModels();
                    if (models) modelsNote.textContent = `共 ${models.length} 个模型`; else loadModels();
                    body.querySelector('[data-refresh-models]').onclick = loadModels;

                    // 设置项改了立即保存。换接口、换常用提供商后重画：下面的设置项跟着变。
                    const SHOW = { volume: (value) => `${Math.round(value * 100)}%`, speed: (value) => `${Number(value).toFixed(2)}x` };
                    const WIDGET_KEYS = new Set(['widget', 'userLines', 'analyzeMode']);
                    body.querySelectorAll('[data-k]').forEach((field) => {
                        const key = field.dataset.k;
                        const value = () => (field.type === 'checkbox' ? (field.checked ? '1' : '0') : field.value);
                        const show = () => {
                            if (SHOW[key]) body.querySelector(`[data-show="${key}"]`).textContent = SHOW[key](field.value);
                        };
                        const save = () => {
                            const prev = get(key);
                            const next = value();
                            ctx.storage.set(key, next);
                            if (key === 'provider') {
                                switchProviderCast(prev, next);
                                return paint();
                            }
                            if (key === 'openaiTemplate') {
                                const { url, model, tone, format = 'mp3', voices: presets = [] } = template();
                                Object.entries({ openaiUrl: url, openaiModel: model, openaiTone: tone, openaiFormat: format, openaiVoice: '' }).forEach(([name, v]) => ctx.storage.set(name, v));
                                const stale = readCast().filter((person) => person.id && (person.provider || 'fish') === 'openai' && (!presets.length || !presets.includes(person.id)));
                                if (stale.length) ctx.ui.toast(`已切换预设；配音表中 ${stale.length} 位人物的旧声音名可能不兼容，可在下方重新选择`, { kind: 'info' });
                                return paint();
                            }
                            if (key === 'fishModel' && (prev === '__custom__' || next === '__custom__')) return paint();
                            show();
                            tune();
                            if (WIDGET_KEYS.has(key)) {
                                if (key === 'userLines') markAll();
                                renderWidget();
                            }
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
                    // 语言下拉框（RPH 的样式）。empty 是「不选」那一项的名字；返回装着它的盒子和存值的原生下拉框。
                    const languageSelect = (empty, value, onChange) => {
                        const select = element('select', 'rph-ui-input');
                        select.append(new Option(empty, ''), ...Object.entries(LANGS).map(([code, label]) => new Option(label, code)));
                        select.value = LANGS[value] ? value : '';
                        select.onchange = onChange;
                        const box = element('div');
                        box.style.width = '8.5rem';
                        box.appendChild(select);
                        castSelects.push(styledSelect(select));
                        return { box, select };
                    };

                    // 读音替换：念之前把左边的字换成右边的，页面上还是原文。改完一格就存；左边空着的不算。
                    const rulesBox = body.querySelector('[data-rules]');
                    const saveRules = (rules) => ctx.storage.set('pronunciations', JSON.stringify(rules));
                    const renderRules = () => {
                        const rules = readJson('pronunciations', []);
                        rulesBox.replaceChildren();
                        if (!rules.length) rulesBox.appendChild(element('p', 'rph-ui-muted', '人名或多音字读错时，可在此替换为读音正确的字，如「黍 → 蜀」。'));
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
                            line.append(cell('from', '原文'), element('span', 'rph-ui-muted', '→'), cell('to', '替换为'), smallButton('删除', () => {
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

                    // 配音表：每行一个人物，选声音念什么语言，可以 AI 推荐、自己搜或填声音名、试听、恢复默认、删除。
                    const castBox = body.querySelector('[data-cast]');
                    // 试听：声音自带试听就放它的；没有就用现在的接口合成一句；再次点同一按钮停止，切页/关窗自动停。
                    const playSample = async (voice, button) => {
                        const same = button && sampleOwner === button;
                        stopSample();
                        if (same) return;
                        const turn = sampleTurn;
                        const controller = sampleAbort = new AbortController();
                        sampleOwner = button || null;
                        if (button) {
                            button.textContent = '加载中…';
                            button.disabled = true;
                        }
                        try {
                            const sample = voiceOf(voice) && voice.sample;
                            let src = sample;
                            if (!src) {
                                const config = captureConfig();
                                const invalid = validateConfig(config);
                                if (invalid) throw new Error(invalid);
                                const { blob } = await synthesize({ text: SAMPLES[voice.lang] || SAMPLE, voice: voiceOf(voice), tone: '' }, controller.signal, config);
                                if (turn !== sampleTurn || !body.isConnected) return;
                                sampleUrl = URL.createObjectURL(blob);
                                src = sampleUrl;
                            }
                            if (turn !== sampleTurn || !body.isConnected) return;
                            preview.src = src;
                            tune();
                            if (button) {
                                button.textContent = '停止';
                                button.disabled = false;
                            }
                            await preview.play();
                        } catch (error) {
                            if (turn === sampleTurn) stopSample();
                            if (error?.name !== 'AbortError') ctx.ui.toast(`试听失败：${error?.message || error}`);
                        }
                    };
                    // 选了声音，这个人就念这个声音的语言；声音没带语言的（填的名字、私有声音）不动他原来选的。
                    const assign = (name, voice) => {
                        saveCast(readCast().map((person) => (person.name === name
                            ? { ...person, id: voice.id, title: voice.title, sample: voice.sample, provider: fish ? undefined : 'openai', lang: voice.lang || person.lang } : person)));
                        if (body.isConnected) renderCast();
                    };
                    const clearVoice = (name) => {
                        saveCast(readCast().map((person) => {
                            if (person.name !== name) return person;
                            const next = { name: person.name };
                            if (person.lang) next.lang = person.lang;
                            return next;
                        }));
                        const stash = readJson(stashKey(), {});
                        const cur = get('provider');
                        if (stash[cur]?.[name]) {
                            delete stash[cur][name];
                            ctx.storage.set(stashKey(), JSON.stringify(stash));
                        }
                        renderCast();
                    };
                    // 一个候选声音：写着它的语言和标签，能试听、选用。
                    const voiceRow = (name, voice) => {
                        const row = element('div', 'rph-ui-row');
                        row.dataset.voiceId = voice.id;
                        const main = element('div', 'rph-ui-row-main');
                        main.append(element('strong', '', voice.title), element('div', 'rph-ui-muted', [LANGS[voice.lang], ...voice.tags].filter(Boolean).join(' · ')));
                        const actions = element('div', 'rph-ui-row-actions');
                        const tryBtn = smallButton('试听', () => playSample(voice, tryBtn));
                        actions.append(tryBtn, smallButton('使用', () => assign(name, voice)));
                        row.append(main, actions);
                        return row;
                    };
                    const showVoices = (area, name, voices, note = '') => {
                        if (!area || !area.isConnected) return;
                        area.replaceChildren();
                        if (note) area.appendChild(element('p', 'rph-ui-muted', note));
                        if (!voices.length) area.appendChild(element('p', 'rph-ui-muted', '未找到合适的声音，请尝试手动搜索。'));
                        voices.forEach((voice) => area.appendChild(voiceRow(name, voice)));
                    };
                    // 自己搜：选在哪种语言的声音里搜（先按这个人现在的语言，没选过是中文），每页 20 个，写出一共多少个，底下「加载更多」往后翻。
                    // 粘贴的是声音 ID 或 fish.audio 声音页网址时直接按 ID 查。
                    const searchBox = (area, name, language) => {
                        area.replaceChildren();
                        const form = element('div', 'rph-ui-actions');
                        form.style.cssText = 'margin-top:0.5rem;flex-wrap:wrap'; // 手机上搜索框占一行，语言和按钮换到下一行
                        const input = element('input', 'rph-ui-input');
                        input.placeholder = '搜索声音，或粘贴声音 ID / 链接';
                        input.style.cssText = 'flex:1 1 12rem;min-width:0';
                        const scope = languageSelect('全部语言', language || 'zh', () => load(true));
                        const results = element('div');
                        let page = 0;
                        let searchTurn = 0;
                        const more = smallButton('加载更多', () => load(false));
                        more.style.marginTop = '0.5rem';
                        const load = async (fresh) => {
                            const mine = searchTurn += 1;
                            if (fresh) {
                                page = 0;
                                results.replaceChildren(element('p', 'rph-ui-muted', '搜索中…'));
                            }
                            more.disabled = true;
                            try {
                                const text = input.value.trim();
                                const id = text.match(/(?:^|\/m\/)([0-9a-f]{32})\b/i)?.[1];
                                const { voices, total } = id ? { voices: [await lookupVoice(id)], total: 1 } : await searchPage(text, page + 1, scope.select.value);
                                if (mine !== searchTurn || !results.isConnected) return;
                                page += 1;
                                if (fresh) results.replaceChildren(element('p', 'rph-ui-muted', total ? `共 ${total} 个声音` : '未找到相关声音，请更换关键词。'));
                                more.remove();
                                voices.forEach((voice) => results.appendChild(voiceRow(name, voice)));
                                if (page * PAGE_SIZE < total) results.appendChild(more);
                            } catch (error) {
                                if (mine !== searchTurn || !results.isConnected) return;
                                const message = error?.message || String(error);
                                if (fresh) results.replaceChildren(element('p', 'rph-ui-muted', message));
                                else ctx.ui.toast(`加载更多失败：${message}`);
                            } finally {
                                if (mine === searchTurn) more.disabled = false;
                            }
                        };
                        input.onkeydown = (event) => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) load(true); };
                        form.append(input, scope.box, smallButton('搜索', () => load(true)));
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
                        input.placeholder = '声音名称，按接口文档填写';
                        input.style.cssText = 'flex:1;min-width:0';
                        input.onkeydown = (event) => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) pick(input.value.trim()); };
                        form.append(input, smallButton('使用', () => pick(input.value.trim())));
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
                        if (!people.length) castBox.appendChild(element('p', 'rph-ui-muted', '还没有人物，分析回复后会自动加入。'));
                        people.forEach((person) => {
                            const row = element('div', 'rph-ui-row');
                            row.dataset.person = person.name;
                            const main = element('div', 'rph-ui-row-main');
                            const hasCurrent = !!voiceOf(person);
                            main.append(element('strong', '', person.name), element('div', 'rph-ui-muted', hasCurrent ? person.title || person.id : `${fish ? 'Fish ' : ''}默认声音`));
                            const actions = element('div', 'rph-ui-row-actions');
                            const area = element('div');
                            area.dataset.pick = person.name;
                            area.style.marginBottom = '0.5rem';
                            // 这个人的声音念什么语言：选声音时跟着声音带过来，也可以在这里改。和正文不是一种语言时，分析会把他的台词译过去再念。
                            const lang = languageSelect('与正文相同', person.lang, () => {
                                saveCast(readCast().map((item) => (item.name === person.name ? { ...item, lang: lang.select.value || undefined } : item)));
                                markAll();
                                renderWidget();
                            });
                            lang.box.title = '声音语言';
                            actions.append(lang.box);
                            if (!fish) {
                                actions.append(smallButton('选择声音', () => nameBox(area, person.name)));
                            } else {
                                const aiBtn = smallButton('AI 推荐', async () => {
                                    const startCard = characterId();
                                    aiBtn.disabled = true;
                                    area.replaceChildren(element('p', 'rph-ui-muted', '推荐中…'));
                                    try {
                                        const { voices, reason } = await aiPick(person.name, lang.select.value || 'zh');
                                        if (!body.isConnected || characterId() !== startCard) return;
                                        if (!readCast().some((item) => item.name === person.name)) return;
                                        if (voices[0]) assign(person.name, voices[0]);
                                        const fresh = castBox.querySelector(`[data-pick="${CSS.escape(person.name)}"]`);
                                        if (fresh) showVoices(fresh, person.name, voices, voices[0] ? `已选「${voices[0].title}」。${reason}` : reason);
                                    } catch (error) {
                                        if (body.isConnected && characterId() === startCard && area.isConnected) {
                                            area.replaceChildren(element('p', 'rph-ui-muted', `推荐失败：${error?.message || error}`));
                                        }
                                    } finally {
                                        aiBtn.disabled = false;
                                    }
                                });
                                actions.append(aiBtn, smallButton('搜索', () => searchBox(area, person.name, lang.select.value)));
                            }
                            const tryBtn = smallButton('试听', () => playSample(person, tryBtn));
                            actions.append(tryBtn);
                            if (hasCurrent) actions.append(smallButton('恢复默认', () => clearVoice(person.name)));
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
                    const addPerson = () => {
                        const name = newPerson.value.trim();
                        if (!name) return;
                        if (name === NARRATOR) return ctx.ui.toast('旁白不需要加入配音表', { kind: 'info' });
                        const people = readCast();
                        if (people.some((person) => person.name === name)) return ctx.ui.toast(`「${name}」已在配音表中`, { kind: 'info' });
                        saveCast([...people, { name }]);
                        newPerson.value = '';
                        renderCast();
                    };
                    newPerson.onkeydown = (event) => { if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) addPerson(); };
                    body.querySelector('[data-add-person]').onclick = addPerson;
                };
                paint();
                let stopWatch = null;
                stopWatch = ctx.app.watch(() => characterId(), () => (body.isConnected ? paint() : stopWatch?.()));
                return () => {
                    stopSample();
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
