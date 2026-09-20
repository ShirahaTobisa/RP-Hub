import { patchRpHubAppJs } from '../DB/app-patches.mjs';

let upstreamApp = '';

function json(value, init = {}) {
    return new Response(JSON.stringify(value), {
        ...init,
        headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers }
    });
}

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === 'POST' && url.pathname === '/load') {
            upstreamApp = await request.text();
            return json({ bytes: new TextEncoder().encode(upstreamApp).byteLength });
        }

        if (url.pathname === '/noop') {
            return json({ ok: true });
        }

        if (url.pathname === '/burn') {
            const durationMs = Math.max(1, Math.min(250, Number(url.searchParams.get('ms')) || 100));
            const startedAt = performance.now();
            let value = 0;
            while (performance.now() - startedAt < durationMs) value = (value + 1) >>> 0;
            return json({ durationMs, value });
        }

        if (url.pathname === '/patch') {
            if (!upstreamApp) return json({ error: 'source-not-loaded' }, { status: 412 });
            const iterations = Math.max(1, Math.min(50, Number(url.searchParams.get('iterations')) || 1));
            const startedAt = performance.now();
            let result;
            for (let index = 0; index < iterations; index += 1) {
                result = patchRpHubAppJs(upstreamApp, { version: '1.7.5' });
            }
            return json({
                iterations,
                elapsedMs: performance.now() - startedAt,
                outputLength: result.code.length,
                replacements: result.report.replacements
            });
        }

        return new Response('Not found', { status: 404 });
    }
};
