function compareReleaseVersions(left, right) {
    const a = String(left).split('.').map(Number);
    const b = String(right).split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const diff = (a[index] || 0) - (b[index] || 0);
        if (diff) return diff;
    }
    return 0;
}

async function cfApi(path, token, init = {}) {
    const response = await fetch(CF_API_BASE + path, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
    const data = await response.json().catch(() => null);
    if (!data?.success) {
        const detail = (data?.errors || []).map((item) => item?.message).filter(Boolean).join('；') || `HTTP ${response.status}`;
        throw createHttpError(`Cloudflare 接口调用失败（${path.split('?')[0]}）：${detail}`, 502);
    }
    return data.result;
}

async function fetchTestReleaseManifest(env) {
    const base = getAppUpdateMirrorBase(env);
    if (!base) throw createHttpError('分发端已关闭（APP_UPDATE_MIRROR_BASE=off）。', 409);
    const response = await fetchWithTimeout(base + TEST_RELEASE_MANIFEST_PATH, { headers: { accept: 'application/json' } });
    if (!response.ok) throw createHttpError(`分发端测试版清单请求失败：HTTP ${response.status}`, 502);
    const manifest = await response.json().catch(() => null);
    if (!Array.isArray(manifest?.versions)) throw createHttpError('分发端测试版清单格式无效。', 502);
    const versions = manifest.versions.filter((version) => TEST_RELEASE_TAG_PATTERN.test(version?.tag)
        && /^\/test-releases\//.test(version.bundle?.path) && /^[a-f0-9]{64}$/.test(version.bundle?.sha256));
    return { base, versions };
}

// 用令牌找出本站所在的账户和 Pages 项目；只有 Pages 编辑权限的令牌列不出账户，此时要求设置 CF_ACCOUNT_ID。
async function resolvePagesTarget(env, host) {
    // 没有同步密码时接口对所有人开放，不能让任何人都能给站点部署或回退。
    if (!getSyncPassword(env)) throw createHttpError('站点未设置同步密码 RP_SYNC_PASSWORD，为了安全不允许一键更新和回退。', 409);
    const token = String(env.CF_API_TOKEN || '').trim();
    if (!token) throw createHttpError('站点未设置 CF_API_TOKEN，无法一键更新；可下载部署包手动上传。', 409);
    const configuredAccount = String(env.CF_ACCOUNT_ID || '').trim();
    const accounts = configuredAccount ? [configuredAccount] : (await cfApi('/accounts', token)).map((account) => account.id);
    if (!accounts.length) throw createHttpError('令牌查不到账户：请给令牌加上“帐户设置：读取”权限，或在项目变量中设置 CF_ACCOUNT_ID。', 409);
    for (const account of accounts) {
        for (let page = 1; page <= MAX_PAGES_PROJECT_LIST_PAGES; page += 1) {
            const projects = await cfApi(`/accounts/${account}/pages/projects?page=${page}`, token);
            const project = projects.find((item) => host === item.subdomain || host.endsWith(`.${item.subdomain}`)
                || (item.domains || []).includes(host));
            if (project) {
                return { token, account, project: project.name, branch: project.production_branch,
                    currentDeployment: project.canonical_deployment?.id || '' };
            }
            if (!projects.length) break;
        }
    }
    throw createHttpError(`找不到网址 ${host} 对应的 Pages 项目，请确认令牌有该账户的 Pages 编辑权限。`, 409);
}

function validateReleaseBundle(bundle, tag) {
    const validPath = (path) => typeof path === 'string' && path && !path.startsWith('/') && !path.includes('..') && path !== '_worker.js';
    if (bundle?.format !== 'rph-release-bundle-v1' || bundle.version !== tag || typeof bundle.worker !== 'string' || !bundle.worker
        || !Array.isArray(bundle.assets) || !bundle.assets.length
        || !bundle.assets.every((asset) => validPath(asset?.path) && typeof asset.base64 === 'string')) {
        throw createHttpError('发布包内容格式无效，已取消更新。', 502);
    }
    return bundle;
}

function assetExtension(path) {
    const name = path.split('/').pop();
    return name.includes('.') ? name.split('.').pop() : '';
}

// 按 Cloudflare Pages 直传流程部署：取上传凭证 → 上传缺失文件 → 登记 → 带外壳代码创建生产部署。
// 资产键用 SHA-256(base64 + 扩展名) 前 32 位，已实测被 Cloudflare 接受。
async function deployReleaseBundle(target, bundle) {
    const projectPath = `/accounts/${target.account}/pages/projects/${target.project}`;
    const post = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const { jwt } = await cfApi(`${projectPath}/upload-token`, target.token);
    const assets = await Promise.all(bundle.assets.map(async (asset) => ({
        ...asset,
        hash: (await sha256Text(asset.base64 + assetExtension(asset.path))).slice(0, 32)
    })));
    const hashes = assets.map((asset) => asset.hash);
    const missing = await cfApi('/pages/assets/check-missing', jwt, post({ hashes }));
    const uploads = assets.filter((asset) => missing.includes(asset.hash)).map((asset) => ({
        key: asset.hash, value: asset.base64, metadata: { contentType: getContentType(asset.path) }, base64: true
    }));
    if (uploads.length) await cfApi('/pages/assets/upload', jwt, post(uploads));
    await cfApi('/pages/assets/upsert-hashes', jwt, post({ hashes }));

    const workerBundle = new FormData();
    workerBundle.set('metadata', JSON.stringify({ main_module: '_worker.js' }));
    workerBundle.set('_worker.js', new File([bundle.worker], '_worker.js', { type: 'application/javascript+module' }));
    const form = new FormData();
    form.set('manifest', JSON.stringify(Object.fromEntries(assets.map((asset) => [`/${asset.path}`, asset.hash]))));
    form.set('branch', target.branch || 'main');
    form.set('commit_message', `RP-Hub 测试版 ${bundle.version}（站内一键更新）`);
    form.set('_worker.bundle', new File([await new Response(workerBundle).blob()], '_worker.bundle'));
    const deployment = await cfApi(`${projectPath}/deployments`, target.token, { method: 'POST', body: form });
    return { id: deployment.id, url: deployment.url, uploaded: uploads.length };
}

async function handleSelfUpdateStatus(env) {
    const { base, versions } = await fetchTestReleaseManifest(env);
    const latest = versions[0]?.tag || '';
    return json({
        ok: true,
        current: RPH_RELEASE_VERSION,
        latest,
        updateAvailable: Boolean(latest) && (!TEST_RELEASE_TAG_PATTERN.test(RPH_RELEASE_VERSION) || compareReleaseVersions(latest, RPH_RELEASE_VERSION) > 0),
        selfDeploy: Boolean(String(env.CF_API_TOKEN || '').trim()),
        versions: versions.slice(0, 10).map((version) => ({
            tag: version.tag,
            name: String(version.name || version.tag),
            notes: String(version.notes || ''),
            publishedAt: Number(version.publishedAt || 0),
            zipUrl: /^\/test-releases\//.test(version.zip?.path) ? base + version.zip.path : ''
        }))
    });
}

async function handleSelfUpdateApply(request, env, body) {
    const target = await resolvePagesTarget(env, new URL(request.url).hostname);
    const { base, versions } = await fetchTestReleaseManifest(env);
    const tag = String(body.target || versions[0]?.tag || '');
    const version = versions.find((item) => item.tag === tag);
    if (!version) return error(`分发端没有测试版 ${tag || '（空）'}。`, 404);
    const response = await fetchWithTimeout(base + version.bundle.path);
    if (!response.ok) return error(`发布包下载失败：HTTP ${response.status}`, 502);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (await sha256Bytes(bytes) !== version.bundle.sha256) return error('发布包校验失败，已取消更新。', 502);
    const bundle = validateReleaseBundle(JSON.parse(new TextDecoder().decode(bytes)), version.tag);
    const deployment = await deployReleaseBundle(target, bundle);
    return json({ ok: true, version: version.tag, deployment });
}

// 回退到当前生产部署之前的那一次部署。
async function handleSelfUpdateRollback(request, env) {
    const target = await resolvePagesTarget(env, new URL(request.url).hostname);
    const projectPath = `/accounts/${target.account}/pages/projects/${target.project}`;
    const deployments = await cfApi(`${projectPath}/deployments?env=production`, target.token);
    const currentIndex = deployments.findIndex((item) => item.id === target.currentDeployment);
    const previous = deployments[currentIndex + 1];
    if (currentIndex < 0 || !previous) return error('没有可回退的上一次部署。', 409);
    const result = await cfApi(`${projectPath}/deployments/${previous.id}/rollback`, target.token, { method: 'POST' });
    return json({ ok: true, deployment: { id: result.id, url: result.url } });
}

