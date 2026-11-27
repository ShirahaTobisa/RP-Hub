    // ---- 万相广场的卡有新版本：打开角色卡管理时查一次（每天最多一次），标题旁显示「N 张卡可更新」，点开给出广场链接 ----
    const FORUM_BASE = 'https://rphforum.zeabur.app';
    const CARD_UPDATES_KEY = 'rp_hub_card_updates_v1';
    const CARD_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
    // 本机和广场的时钟可能差几分钟：导入前后 10 分钟内的改动不算更新。
    const CARD_CLOCK_SLACK_MS = 10 * 60 * 1000;
    const CARD_UPDATE_BATCH = 5;
    let cardUpdates = null;
    let checkingCardUpdates = false;

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

    // 广场上的卡在本机导入之后改过，而且本机还没有改过之后再导入的同名卡。
    function outdatedCards() {
        const { cards } = readCardUpdates();
        const chars = getVueProxy()?.characters || [];
        return chars.filter((char) => {
            const entry = cards[char.uuid];
            return entry && entry.updatedAt > char.createdAt + CARD_CLOCK_SLACK_MS
                && !chars.some((other) => other.name === char.name && other.createdAt > entry.updatedAt);
        }).map((char) => ({ char, ...cards[char.uuid] }));
    }

    // 本机的卡对应广场上哪张：上次认出的那张 → 简介和作者备注都一样的那张 → 只有一张同名卡时就是它。
    // 广场上的卡要在本机导入之前就有；作者改卡后要重新审核，审核期间搜不到，这时沿用上次的结果。
    async function checkCardUpdates() {
        const state = readCardUpdates();
        const all = getVueProxy()?.characters || [];
        if (checkingCardUpdates || !all.length || Date.now() - state.checkedAt < CARD_UPDATE_INTERVAL_MS) return;
        checkingCardUpdates = true;
        const chars = all.filter(isForumDownload);
        const cards = {};
        try {
            for (let index = 0; index < chars.length; index += CARD_UPDATE_BATCH) {
                const batch = chars.slice(index, index + CARD_UPDATE_BATCH);
                const { results } = await postSync({ action: 'forum-cards', cards: batch.map((char) => (
                    { name: char.name, description: char.description, creatorNotes: char.creator_notes })) },
                { retryCount: 0, keepPasswordOnAuthError: true });
                batch.forEach((char, offset) => {
                    const known = state.cards[char.uuid];
                    const found = (results?.[offset] || []).filter((card) => card.createdAt <= char.createdAt + CARD_CLOCK_SLACK_MS);
                    const match = found.find((card) => card.id === known?.id) || found.find((card) => card.same)
                        || (found.length === 1 ? found[0] : null);
                    const entry = match ? { id: match.id, updatedAt: match.updatedAt } : known;
                    if (entry) cards[char.uuid] = entry;
                });
            }
            saveCardUpdates({ checkedAt: Date.now(), cards });
        } catch (_) {
            // 本站接口或广场暂时不可用：明天再查，之前查到的照旧显示。
            saveCardUpdates({ ...state, checkedAt: Date.now() });
        } finally {
            checkingCardUpdates = false;
        }
        decorateCharactersView();
    }

    // 在 RP-Hub 内嵌的万相广场里打开这张卡，可以直接导入新版本；页面上没有万相广场时开新标签页。
    async function openForumCard(id) {
        const url = `${FORUM_BASE}/card/${encodeURIComponent(id)}`;
        const proxy = getVueProxy();
        if (!proxy || !('squareUrl' in proxy)) return void window.open(url, '_blank', 'noopener');
        if (proxy.currentView !== 'square') {
            proxy.currentView = 'square';
            await globalThis.Vue.nextTick(); // 切到广场时官方会把地址换回广场首页，等它换完再改成这张卡
        }
        proxy.squareUrl = `${url}?t=${Date.now()}`;
    }

    function openCardUpdates() {
        window.RPHubUI.openModal({ title: '角色卡更新', size: 'sm', render(body, modal) {
            const list = document.createElement('div');
            list.className = 'rph-ui-list';
            for (const { char, id, updatedAt } of outdatedCards()) {
                const row = document.createElement('div');
                row.className = 'rph-ui-row';
                row.innerHTML = '<div class="rph-ui-row-main"><div></div><div class="rph-ui-muted"></div></div><div class="rph-ui-row-actions"></div>';
                const [name, date] = row.firstChild.children;
                name.textContent = char.name;
                date.textContent = `万相广场 ${new Date(updatedAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}更新`;
                const view = window.RPHubUI.button('查看', 'primary');
                view.addEventListener('click', () => { modal.close(); openForumCard(id); });
                row.lastChild.appendChild(view);
                list.appendChild(row);
            }
            body.appendChild(list);
        } });
    }

    // 角色卡管理右上角（手机、电脑各一组按钮）在「添加角色卡」那组按钮最前面放一个带数字的更新按钮。
    function decorateCharactersView() {
        checkCardUpdates();
        const count = outdatedCards().length;
        const label = `${count} 张卡可更新`;
        for (const add of document.querySelectorAll('.character-management-header .settings-create-button')) {
            let button = add.parentElement.querySelector('[data-rph-card-updates]');
            if (!count) {
                button?.remove();
                continue;
            }
            if (!button) {
                button = document.createElement('button');
                button.type = 'button';
                button.className = 'settings-icon-button rph-card-updates';
                button.dataset.rphCardUpdates = '';
                button.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg><span></span>';
                button.addEventListener('click', openCardUpdates);
                add.parentElement.prepend(button);
            }
            if (button.title !== label) {
                button.title = label;
                button.setAttribute('aria-label', label);
                button.lastChild.textContent = count;
            }
        }
    }

