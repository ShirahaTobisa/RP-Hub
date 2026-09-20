/* Workshop fixture: a small third-party module served from a foreign origin.
   Modules that watch chat DOM changes should subscribe to the loader's
   chat-mutation event instead of creating their own full-page MutationObserver. */
(() => {
    'use strict';

    const flags = (globalThis.__rphHelloFlags = {
        registered: false,
        initDone: false,
        storageOk: false,
        flushSeen: 0,
        sidebarClicks: 0
    });

    const accepted = globalThis.RPHubSDK.register({
        id: 'hello-demo',
        name: 'Hello Demo',
        version: '1.0.0',
        requiresApi: 1,
        init(ctx) {
            ctx.storage.set('greet', 'hi');
            flags.storageOk = ctx.storage.get('greet') === 'hi'
                && localStorage.getItem('rph_mod_hello-demo::greet') === 'hi';
            ctx.ui.addSidebarEntry({
                label: 'Hello Demo',
                onClick() {
                    flags.sidebarClicks += 1;
                    ctx.ui.openPanel({
                        title: 'Hello Demo',
                        render(bodyEl) { bodyEl.textContent = 'Hello from the workshop module.'; }
                    });
                }
            });
            ctx.ui.toast('Hello Demo 已加载', { kind: 'info' });
            ctx.events.on('persistence-flush', () => { flags.flushSeen += 1; });
            flags.initDone = true;
            ctx.log('initialized');
        }
    });
    flags.registered = accepted === true;
})();
