async function handleJsonApi(request, env, ctx) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS' } });
    }
    if (request.method !== 'POST') return error('Method not allowed.', 405);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return error('Invalid JSON body.');
    if (body.action === 'auth-status') return handleAuthStatus(request, env);
    if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });

    const bucket = getBucket(env);
    const actions = {
        'pull-manifest': () => handleStatus(bucket, true),
        status: () => handleStatus(bucket, false),
        'pull-json-part': () => handlePullJsonPart(bucket, body),
        'fork-page': () => handleForkPage(bucket, body),
        'fork-packs': () => handleForkPacks(bucket, body),
        'fork-export-commit': () => handleForkExportCommit(bucket, body),
        'upload-create': () => handleUploadCreate(bucket, body),
        'upload-complete': () => handleUploadComplete(bucket, body, ctx),
        'app-update-versions': () => handleAppUpdateVersions(bucket, env, body),
        'app-update-check': () => handleAppUpdateCheck(bucket, env),
        'app-update-apply': () => handleAppUpdateApply(bucket, body, env, ctx),
        'app-update-rollback': () => handleAppUpdateRollback(bucket),
        'self-update-status': () => handleSelfUpdateStatus(env),
        'self-update-apply': () => handleSelfUpdateApply(request, env, body),
        'self-update-rollback': () => handleSelfUpdateRollback(request, env)
    };
    if (!Object.hasOwn(actions, body.action)) return error('Unsupported action.', 404);
    return actions[body.action]();
}

// ---- 测试版自更新：从分发端取发布包，用 CF_API_TOKEN 部署到本站所在的 Pages 项目 ----
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const TEST_RELEASE_MANIFEST_PATH = '/test-releases/manifest.json';
const TEST_RELEASE_TAG_PATTERN = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const MAX_PAGES_PROJECT_LIST_PAGES = 10;

