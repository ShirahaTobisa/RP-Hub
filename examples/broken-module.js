/* Workshop fixture: registration succeeds, then init fails synchronously. */
(() => {
    'use strict';

    globalThis.RPHubSDK.register({
        id: 'broken-demo',
        name: 'Broken Demo',
        version: '1.0.0',
        requiresApi: 1,
        init() {
            throw new Error('intentional workshop fixture failure');
        }
    });
})();
