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
