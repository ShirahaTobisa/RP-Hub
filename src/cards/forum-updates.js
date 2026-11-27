    // ---- 万相广场的卡有新版本：打开角色卡管理时自动查（每天最多一次），点右上角的「检查更新」马上查全部，
    // 点卡片上的「检查更新」只查那一张（认不出对应广场上哪张时自己选）；
    // 点「更新」在内嵌的万相广场打开那张卡，在那里点「导入」就原地换成新版，聊天记录不动 ----
    const FORUM_BASE = 'https://rphforum.zeabur.app';
    const CARD_UPDATES_KEY = 'rp_hub_card_updates_v1';
    const CARD_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    // 本机和广场的时钟可能差几分钟：导入前后 10 分钟内的改动不算更新。
    const CARD_CLOCK_SLACK_MS = 10 * 60 * 1000;
    const CARD_UPDATE_BATCH = 5;
    const REFRESH_ICON = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>';
    const seenCardActions = new WeakSet();
    let cardUpdates = null;
    let cardCheck = null;
    let pendingCardUpdate = null;

    function readCardUpdates() {
        if (!cardUpdates) {
            try { cardUpdates = JSON.parse(localStorage.getItem(CARD_UPDATES_KEY)); } catch (_) { /* 读不到就重新查 */ }
            if (!cardUpdates?.cards) cardUpdates = { checkedAt: 0, cards: {} };
        }
        return cardUpdates;
    }

    function saveCardUpdates(next) {
        cardUpdates = next;
        try { localStorage.setItem(CARD_UPDATES_KEY, JSON.stringify(next)); } catch (_) { /* storage full or blocked */ }
    }

    // 从广场下载的卡，头像就是广场给的 PNG：紧跟在 IHDR 后面的是存卡片数据的 tEXt「chara」块。
    function isForumDownload(char) {
        const prefix = 'data:image/png;base64,';
        if (typeof char?.avatar !== 'string' || !char.avatar.startsWith(prefix) || !Number.isFinite(char.createdAt)) return false;
        try { return atob(char.avatar.slice(prefix.length, prefix.length + 64)).slice(37, 47) === 'tEXtchara\0'; } catch (_) { return false; }
    }

    // 广场上的卡在本机导入（或上次原地更新）之后改过，而且本机还没有改过之后再导入的同名卡。
    function isOutdated(char, entry, chars) {
        return Boolean(entry) && entry.updatedAt > Math.max(char.createdAt, entry.syncedAt || 0) + CARD_CLOCK_SLACK_MS
            && !chars.some((other) => other.name === char.name && other.createdAt > entry.updatedAt);
    }

    function outdatedCards() {
        const { cards } = readCardUpdates();
        const chars = getVueProxy()?.characters || [];
        return chars.filter((char) => isOutdated(char, cards[char.uuid], chars)).map((char) => ({ char, ...cards[char.uuid] }));
    }

    // 本机的卡对应广场上哪张：认出过或选过的那张（作者改卡后要重新审核，审核期间搜不到就先不变）
    // → 导入前就有、简介和作者备注都一样的那张 → 导入前就有的唯一一张同名卡。
    function matchForumCard(char, found, known) {
        if (known) return found.find((card) => card.id === known.id);
        const before = found.filter((card) => card.createdAt <= char.createdAt + CARD_CLOCK_SLACK_MS);
        return before.find((card) => card.same) || (before.length === 1 ? before[0] : undefined);
    }

    // 广场没开跨域，由本站代查同名的卡；每张卡的结果是同名卡的列表，查不到那张时是 null。
    async function searchForumCards(chars) {
        const { results } = await postSync({ action: 'forum-cards', cards: chars.map((char) => (
            { name: char.name, description: char.description, creatorNotes: char.creator_notes })) },
        { retryCount: 0, keepPasswordOnAuthError: true });
        return results || [];
    }

    // 每天自动查一次，点右上角「检查更新」时（force）马上查；正在查就等这次查完。
    function checkCardUpdates(force) {
        const chars = getVueProxy()?.characters || [];
        if (!cardCheck && chars.length && (force || Date.now() - readCardUpdates().checkedAt >= CARD_UPDATE_INTERVAL_MS)) {
            cardCheck = queryCardUpdates(chars.filter(isForumDownload)).finally(() => {
                cardCheck = null;
                decorateCharactersView();
            });
        }
        return cardCheck || Promise.resolve();
    }

    // 本站接口或广场暂时不可用时，之前查到的照旧显示，并报错给「检查更新」。
    async function queryCardUpdates(chars) {
        const state = readCardUpdates();
        const cards = {};
        let failed = false;
        try {
            for (let index = 0; index < chars.length; index += CARD_UPDATE_BATCH) {
                const batch = chars.slice(index, index + CARD_UPDATE_BATCH);
                const results = await searchForumCards(batch);
                batch.forEach((char, offset) => {
                    const known = state.cards[char.uuid];
                    if (!Array.isArray(results[offset])) failed = true;
                    const match = matchForumCard(char, results[offset] || [], known);
                    const entry = match ? { ...known, id: match.id, updatedAt: match.updatedAt } : known;
                    if (entry) cards[char.uuid] = entry;
                });
            }
        } catch (error) {
            saveCardUpdates({ ...state, checkedAt: Date.now() });
            throw error;
        }
        saveCardUpdates({ checkedAt: Date.now(), cards });
        if (failed) throw new Error('万相广场暂时不可用');
    }

    // 在 RP-Hub 内嵌的万相广场里打开这张卡；离开广场之前在那里导入同名的卡，就原地更新这张卡。
    // 页面上没有万相广场时开新标签页，只能手动导入。
    async function openCardUpdate(char, id) {
        const url = `${FORUM_BASE}/card/${encodeURIComponent(id)}`;
        const proxy = getVueProxy();
        if (!proxy || !('squareUrl' in proxy)) return void window.open(url, '_blank', 'noopener');
        if (proxy.currentView !== 'square') {
            proxy.currentView = 'square';
            await globalThis.Vue.nextTick(); // 切到广场时官方会把地址换回广场首页，等它换完再改成这张卡
        }
        proxy.squareUrl = `${url}?t=${Date.now()}`;
        pendingCardUpdate = { uuid: char.uuid, name: char.name };
        const stop = globalThis.Vue.watch(() => proxy.currentView, (view) => {
            if (view === 'square') return;
            pendingCardUpdate = null;
            stop();
        });
        window.RPHubUI.toast('在万相广场点「导入」即可更新，聊天记录保留');
    }

    // 状态栏的数值是剧情进度，接着用；作者新版里新加的变量（包括对象里新加的项）用作者给的初始值。
    function withNewVariables(state, initial) {
        const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
        if (state === undefined) return structuredClone(initial);
        if (!isObject(state) || !isObject(initial)) return state;
        const next = { ...state };
        for (const key of Object.keys(initial)) next[key] = withNewVariables(state[key], initial[key]);
        return next;
    }

    // 和官方导入一样整理新卡，只换内容字段；角色卡编号不变，聊天记录、分支、记忆、生图记录都还在。
    // 同名的界面模板沿用旧模板的编号、变化记录和各分支的数值，游戏进度不会清零。
    async function updateCardInPlace(char, data, buffer) {
        const cards = window.RPHubCardUtils, ui = window.RPHubUiTemplateUtils, config = window.RPHubConfig;
        const imported = cards.parseImportedCharacterCard(data);
        const oldTemplates = new Map((char.uiTemplates || []).map((template) => [template.name, template]));
        const uiTemplates = imported.uiTemplates.map((template) => {
            const next = ui.normalizeUiTemplate({ ...ui.sanitizeUiTemplateImportEntry(template), id: window.RPHubUtils.generateUUID(), scope: 'character' });
            const old = oldTemplates.get(next.name);
            oldTemplates.delete(next.name);
            if (!old) return next;
            const keep = (state) => withNewVariables(state, next.initialVariableState);
            return { ...next, id: old.id, variableState: keep(old.variableState), changeLog: old.changeLog,
                runtimeByCharacter: Object.fromEntries(Object.entries(old.runtimeByCharacter || {}).map(([scope, runtime]) => (
                    [scope, { ...runtime, variableState: keep(runtime?.variableState) }]))) };
        });
        Object.assign(char, {
            name: imported.name, description: imported.description, first_mes: imported.first_mes,
            personality: imported.personality, creator_notes: imported.creator_notes,
            avatar: await cards.blobToDataUrl(new Blob([buffer], { type: 'image/png' })),
            worldInfo: imported.worldInfoEntries.map((entry) => cards.normalizeWorldInfoEntry({ ...entry, scope: 'character' },
                { systemNames: config.systemWorldInfoNames })).filter((entry) => entry.scope !== 'global'),
            regexScripts: imported.regexScripts.map((script) => cards.normalizeImportedRegexScript({ ...script, scope: 'character' },
                { fallbackScope: 'character', systemNames: config.systemRegexNames })).filter((script) => script.scope !== 'global'),
            uiTemplates
        });
        const state = readCardUpdates();
        if (state.cards[char.uuid]) state.cards[char.uuid].syncedAt = Date.now();
        saveCardUpdates(state);
        await flushAppState().catch(() => { /* 正在生成回复时存不了，官方一秒后会自己存 */ });
    }

    // 从「更新」打开的广场里导入同名的卡：不新建角色卡，原地更新；别的导入照旧交给官方。
    // 在捕获阶段先于官方的监听处理，处理了就拦下，并替官方给广场回导入结果。
    window.addEventListener('message', (event) => {
        const target = pendingCardUpdate;
        const { type, requestId, buffer } = event.data || {};
        if (!target || type !== 'RPH_FORUM_IMPORT_CARD' || event.origin !== FORUM_BASE) return;
        if (![...document.querySelectorAll('iframe')].some((frame) => frame.contentWindow === event.source)) return;
        if (typeof requestId !== 'string' || !/^[\w-]{1,80}$/.test(requestId) || !(buffer instanceof ArrayBuffer)) return;
        let data;
        try { data = window.RPHubCardUtils.parsePngCharacterData(buffer).data; } catch (_) { return; }
        const char = getVueProxy()?.characters?.find((item) => item.uuid === target.uuid);
        if (!char || String((data?.data || data)?.name || '').trim() !== target.name) return;
        event.stopImmediatePropagation();
        pendingCardUpdate = null;
        const reply = (result) => event.source.postMessage({ type: 'RPHUB_IMPORT_RESULT', requestId, ...result }, event.origin);
        updateCardInPlace(char, data, buffer).then(() => {
            reply({ name: char.name });
            window.RPHubUI.toast(`已更新「${char.name}」`, { kind: 'success' });
            decorateCharactersView();
        }, (error) => reply({ error: `更新失败：${error?.message || '请重试'}` }));
    }, true);

    function formatDay(time) {
        const date = new Date(time);
        return date.toLocaleDateString('zh-CN', { ...(date.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }), month: 'long', day: 'numeric' });
    }

    function actionButton(label, kind, onClick) {
        const button = window.RPHubUI.button(label, kind);
        button.addEventListener('click', onClick);
        return button;
    }

    // 弹窗里的列表：每行一个标题、一行灰字，右边一个按钮或一段灰字。
    function updateList(items) {
        const list = document.createElement('div');
        list.className = 'rph-ui-list';
        for (const [title, detail, action] of items) {
            const row = document.createElement('div');
            row.className = 'rph-ui-row';
            row.innerHTML = '<div class="rph-ui-row-main"><div></div><div class="rph-ui-muted"></div></div><div class="rph-ui-row-actions"></div>';
            const [main, muted] = row.firstChild.children;
            main.textContent = title;
            muted.textContent = detail;
            row.lastChild.append(typeof action === 'string' ? Object.assign(document.createElement('span'), { className: 'rph-ui-muted', textContent: action }) : action);
            list.appendChild(row);
        }
        return list;
    }

    // 弹窗开头的一行灰字：先显示「正在检查…」，查完换成结果。
    function openCheckModal(title, check) {
        window.RPHubUI.openModal({ title, size: 'sm', render(body, modal) {
            const note = Object.assign(document.createElement('div'), { className: 'rph-ui-muted', textContent: '正在检查…' });
            body.appendChild(note);
            check(body, note, modal).catch((error) => { note.textContent = `检查失败：${error.message}`; });
        } });
    }

    // 右上角的「检查更新」：先查一次全部，再列出有新版本的卡；查不成时也列出之前查到的。
    function openCardUpdates() {
        openCheckModal('角色卡更新', async (body, note, modal) => {
            const error = await checkCardUpdates(true).then(() => null, (failure) => failure);
            const items = outdatedCards();
            if (error || !items.length) note.textContent = error ? `检查失败：${error.message}` : '已是最新版本';
            else note.remove();
            if (items.length) body.appendChild(updateList(items.map(({ char, id, updatedAt }) => [char.name, `万相广场 ${formatDay(updatedAt)}更新`,
                actionButton('更新', 'primary', () => { modal.close(); openCardUpdate(char, id); })])));
        });
    }

    // 卡片上的「检查更新」：只查这一张。认出来就说有没有新版本；广场上有几张同名卡时都列出来（新上传的在前），
    // 可以选对应的一张，选过的记住，以后按它检查和更新。
    function openCardCheck(uuid) {
        const find = () => (getVueProxy()?.characters || []).find((item) => item.uuid === uuid);
        openCheckModal('检查更新', async (body, note, modal) => {
            await cardCheck?.catch(() => { /* 等自动检查查完，免得它把这里选的覆盖掉 */ });
            const [found] = await searchForumCards([find()]);
            if (!Array.isArray(found)) throw new Error('万相广场暂时不可用');
            found.sort((a, b) => b.createdAt - a.createdAt);
            const show = () => {
                const char = find();
                if (!char) return modal.close();
                const state = readCardUpdates();
                const match = matchForumCard(char, found, state.cards[uuid]);
                if (match) state.cards[uuid] = { ...state.cards[uuid], id: match.id, updatedAt: match.updatedAt };
                saveCardUpdates(state);
                const outdated = Boolean(match) && isOutdated(char, state.cards[uuid], getVueProxy().characters);
                note.textContent = !found.length ? `万相广场上没有找到「${char.name}」`
                    : !match ? '请选择万相广场上对应的卡'
                        : outdated ? `「${char.name}」有新版本` : `「${char.name}」已是最新版本`;
                body.replaceChildren(note);
                const rows = found.length > 1 || !match || outdated ? found : [];
                if (rows.length) body.appendChild(updateList(rows.map((card) => [`${formatDay(card.createdAt)}上传`, `${formatDay(card.updatedAt)}更新`,
                    card !== match ? actionButton('选择', 'secondary', () => {
                        const next = readCardUpdates();
                        next.cards[uuid] = { id: card.id, updatedAt: card.updatedAt };
                        saveCardUpdates(next);
                        show();
                    }) : outdated ? actionButton('更新', 'primary', () => { modal.close(); openCardUpdate(char, card.id); }) : '当前'])));
                decorateCharactersView();
            };
            show();
        });
    }

    // 页面上每张卡片是哪个角色：卡片组件带着 char 参数，从 Vue 的组件树里按卡片的根元素找
    // （同一张卡导入两次时头像一模一样，靠图片认不出）。
    function cardOwners() {
        const owners = new Map();
        const walk = (vnode) => {
            const instance = vnode?.component;
            if (instance) {
                if (instance.props?.char?.uuid) owners.set(instance.subTree?.el, instance.props.char.uuid);
                walk(instance.subTree);
            } else if (Array.isArray(vnode?.children)) vnode.children.forEach(walk);
        };
        walk(getVueProxy()?.$?.subTree);
        return owners;
    }

    // 角色卡管理右上角（手机、电脑各一组按钮）在「添加角色卡」那组按钮最前面放「检查更新」，有新版本时带数字；
    // 每张从广场下载的卡，右上角那列按钮（编辑、导出、收藏、删除）里也放一个，只查这一张。没有广场下载的卡就都不放。
    function decorateCharactersView() {
        checkCardUpdates().catch(() => { /* 明天再查，或点「检查更新」 */ });
        const chars = getVueProxy()?.characters || [];
        const forum = chars.some(isForumDownload);
        const count = outdatedCards().length;
        const label = count ? `${count} 张卡可更新` : '检查更新';
        for (const add of document.querySelectorAll('.character-management-header .settings-create-button')) {
            let button = add.parentElement.querySelector('[data-rph-card-updates]');
            if (!forum) {
                button?.remove();
                continue;
            }
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = 'settings-icon-button rph-card-updates';
                button.dataset.rphCardUpdates = '';
                button.innerHTML = `<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">${REFRESH_ICON}</svg><span></span>`;
                button.addEventListener('click', openCardUpdates);
                add.parentElement.prepend(button);
            }
            if (button.title !== label) {
                button.title = label;
                button.setAttribute('aria-label', label);
                button.lastChild.textContent = count || '';
            }
        }
        const fresh = [...document.querySelectorAll('.char-grid-item .character-card-actions')].filter((actions) => !seenCardActions.has(actions));
        if (!fresh.length) return;
        const owners = cardOwners();
        for (const actions of fresh) {
            // 网格里的卡片拿到的是精简过的角色，按编号找回完整的。
            const uuid = owners.get(actions.closest('.char-grid-item'));
            const char = uuid && chars.find((item) => item.uuid === uuid);
            if (!char) continue;
            seenCardActions.add(actions);
            if (!isForumDownload(char)) continue;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = actions.firstElementChild.className;
            button.title = '检查更新';
            button.setAttribute('aria-label', '检查更新');
            button.dataset.rphCardCheck = '';
            button.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">${REFRESH_ICON}</svg>`;
            button.addEventListener('click', (event) => { event.stopPropagation(); openCardCheck(uuid); });
            (actions.querySelector('[title="导出角色"]') || actions.lastElementChild).after(button);
        }
    }

