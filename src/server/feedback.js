const FEEDBACK_PATH = '/api/rp-feedback';
const USAGE_STATE_KEY = '_feedback/usage.json';

async function forwardFeedback(env, path, payload) {
    const base = getAppUpdateMirrorBase(env);
    if (!base) throw createHttpError('分发端已关闭，请下载报告文件。', 409);
    const response = await fetch(base + '/api/feedback/' + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(8000), redirect: 'error'
    });
    if (!response.ok) throw createHttpError('分发端暂时无法接收，请稍后重试或下载报告文件。', 502);
    return response.json();
}

async function handleFeedback(request, env) {
    if (request.method !== 'POST') return error('Method not allowed.', 405);
    if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401);
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 128 * 1024) return error('报告过大。', 413);
    let body;
    try { body = JSON.parse(text); } catch { return error('Invalid JSON body.'); }
    if (body?.action === 'report') {
        if (body.report?.schema !== 1) return error('报告格式无效。');
        return json(await forwardFeedback(env, 'reports', body.report));
    }
    if (body?.action !== 'usage') return error('Unsupported action.', 404);
    if (!getAppUpdateMirrorBase(env)) return json({ ok: true, counted: false });
    const configuredAccount = String(env.CF_ACCOUNT_ID || '').trim();
    if (!configuredAccount && !String(env.CF_API_TOKEN || '').trim()) return json({ ok: true, counted: false });
    const bucket = getBucket(env), day = new Date().toISOString().slice(0, 10);
    const previous = await bucket.get(USAGE_STATE_KEY);
    if (previous && JSON.parse(await previous.text()).day === day) return json({ ok: true, counted: true });
    const account = configuredAccount || (await resolvePagesTarget(env, new URL(request.url).hostname)).account;
    const manifest = await getAppliedAppUpdateManifest(bucket);
    const current = getActiveManifestCurrent(manifest);
    await forwardFeedback(env, 'usage', { account: await sha256Text('rph-usage-v1:' + account),
        release: RPH_RELEASE_VERSION, upstream: current?.upstreamTag || CURRENT_UPSTREAM_VERSION });
    await bucket.put(USAGE_STATE_KEY, JSON.stringify({ day }));
    return json({ ok: true, counted: true });
}
