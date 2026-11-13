function buildGitHubHeaders(env, accept = 'application/octet-stream') {
    return {
        accept,
        'user-agent': 'RP-Hub-R2-Updater'
    };
}

function createAppUpdateRequestBudget() {
    return {
        used: 0,
        consume() {
            if (this.used >= MAX_APP_UPDATE_EXTERNAL_REQUESTS) {
                const failure = new Error(`在线更新外部请求超过 ${MAX_APP_UPDATE_EXTERNAL_REQUESTS} 次限制，已拒绝更新。`);
                failure.code = 'RP_HUB_APP_UPDATE_REQUEST_LIMIT';
                throw failure;
            }
            this.used += 1;
        }
    };
}

function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithBudgetedRedirects(url, options = {}, requestBudget = null) {
    let currentUrl = new URL(String(url));
    for (let redirectCount = 0; ; redirectCount += 1) {
        requestBudget?.consume();
        const response = await fetch(currentUrl.toString(), {
            ...options,
            redirect: 'manual'
        });
        if (!isRedirectStatus(response.status)) return response;
        if (redirectCount >= MAX_APP_UPDATE_REDIRECTS) {
            await response.body?.cancel().catch(() => {});
            throw new Error(`在线更新重定向超过 ${MAX_APP_UPDATE_REDIRECTS} 次限制。`);
        }
        const location = response.headers.get('location');
        if (!location) {
            await response.body?.cancel().catch(() => {});
            throw new Error('在线更新收到缺少 Location 的重定向响应。');
        }
        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.protocol !== 'https:' && nextUrl.protocol !== 'http:') {
            await response.body?.cancel().catch(() => {});
            throw new Error(`在线更新拒绝非 HTTP 重定向：${nextUrl.protocol}`);
        }
        await response.body?.cancel().catch(() => {});
        currentUrl = nextUrl;
    }
}

async function fetchGitHubText(url, env, accept = 'text/plain; charset=utf-8', requestBudget = null) {
    const response = await fetchWithBudgetedRedirects(url, {
        headers: buildGitHubHeaders(env, accept)
    }, requestBudget);
    const text = await response.text();
    if (!response.ok) {
        throw new Error(text || `GitHub 请求失败：HTTP ${response.status}`);
    }
    return text;
}

async function fetchGitHubJson(url, env, requestBudget = null) {
    const text = await fetchGitHubText(
        url,
        env,
        'application/vnd.github+json, application/json',
        requestBudget
    );
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error('GitHub 返回的数据不是有效 JSON。');
    }
}

function decodeXmlText(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function sanitizeReleaseTag(value) {
    const tag = String(value || '').trim();
    return /^[A-Za-z0-9._/-]{1,120}$/.test(tag) && !tag.includes('..') ? tag : '';
}

function parseReleaseFeed(xml) {
    const versions = [];
    const entryPattern = /<entry\b[\s\S]*?<\/entry>/g;
    const entries = String(xml || '').match(entryPattern) || [];
    for (const entry of entries) {
        const link = entry.match(/<link\b[^>]*href="([^"]*\/releases\/tag\/([^"]+))"[^>]*>/i);
        if (!link) continue;
        const tag = sanitizeReleaseTag(decodeURIComponent(decodeXmlText(link[2])));
        if (!tag) continue;
        const title = decodeXmlText((entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || tag).trim();
        const updated = decodeXmlText((entry.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i) || [])[1] || '').trim();
        versions.push({
            tag,
            sha: tag,
            shortSha: tag,
            name: title || tag,
            date: updated,
            message: title || tag,
            url: decodeXmlText(link[1]),
            zipUrl: `https://github.com/${UPSTREAM_REPO}/archive/refs/tags/${encodeURIComponent(tag)}.zip`
        });
    }
    return versions;
}

async function fetchReleaseVersions(env, requestBudget = null) {
    const xml = await fetchGitHubText(
        `https://github.com/${UPSTREAM_REPO}/releases.atom`,
        env,
        'application/atom+xml, text/xml, text/plain',
        requestBudget
    );
    const versions = parseReleaseFeed(xml);
    if (versions.length === 0) throw new Error('没有从 RP-Hub Releases 读取到版本。');
    return versions.slice(0, APP_RELEASE_VERSION_LIMIT);
}

function getAppUpdateMirrorBase(env) {
    const configured = typeof env?.[APP_UPDATE_MIRROR_ENV] === 'string'
        ? env[APP_UPDATE_MIRROR_ENV].trim()
        : '';
    if (configured === 'off') return '';
    const rawBase = configured || DEFAULT_APP_UPDATE_MIRROR_BASE;
    let url;
    try {
        url = new URL(rawBase);
    } catch {
        throw new Error(`在线更新镜像地址无效：${rawBase}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(`在线更新镜像地址必须使用 HTTP(S)：${rawBase}`);
    }
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
}

function normalizeMirrorFile(file) {
    const path = typeof file?.path === 'string' ? file.path : '';
    const sha256 = typeof file?.sha256 === 'string' ? file.sha256.toLowerCase() : '';
    const size = Number(file?.size);
    if (!isAllowedAppUpdatePath(path)) throw new Error(`镜像清单包含非法文件路径：${path || '(empty)'}`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`镜像清单文件 SHA-256 无效：${path}`);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_APP_UPDATE_FILE_BYTES) {
        throw new Error(`镜像清单文件大小无效：${path}`);
    }
    return { path, sha256, size };
}

function parseMirrorManifest(value, mirrorBase) {
    if (!value || typeof value !== 'object' || value.schema !== 1 || value.upstreamRepo !== UPSTREAM_REPO) {
        throw new Error(`在线更新镜像清单格式无效：${mirrorBase}/manifest.json`);
    }
    if (!Array.isArray(value.versions) || value.versions.length === 0) {
        throw new Error(`在线更新镜像没有可用版本：${mirrorBase}/manifest.json`);
    }
    const versions = value.versions.slice(0, APP_RELEASE_VERSION_LIMIT).map((version) => {
        const tag = sanitizeReleaseTag(version?.tag);
        const commit = typeof version?.commit === 'string' ? version.commit.toLowerCase() : '';
        if (!tag || !/^[a-f0-9]{40}$/.test(commit) || !Array.isArray(version?.files)) {
            throw new Error(`在线更新镜像版本条目无效：${tag || '(unknown)'}`);
        }
        const files = version.files.map(normalizeMirrorFile);
        if (new Set(files.map((file) => file.path)).size !== files.length) {
            throw new Error(`在线更新镜像版本包含重复文件：${tag}`);
        }
        return {
            tag,
            sha: commit,
            shortSha: commit.slice(0, 16),
            name: typeof version.name === 'string' && version.name ? version.name : tag,
            date: typeof version.date === 'string' ? version.date : '',
            message: typeof version.name === 'string' && version.name ? version.name : tag,
            url: `https://github.com/${UPSTREAM_REPO}/releases/tag/${encodeURIComponent(tag)}`,
            zipUrl: `https://github.com/${UPSTREAM_REPO}/archive/refs/tags/${encodeURIComponent(tag)}.zip`,
            files
        };
    });
    return versions;
}

async function fetchMirrorReleaseVersions(mirrorBase, requestBudget = null) {
    let response;
    try {
        response = await fetchWithTimeout(`${mirrorBase}/manifest.json`, {
            headers: { accept: 'application/json' }
        }, requestBudget);
    } catch (err) {
        throw new Error(`在线更新镜像不可达（${mirrorBase}）：${err?.name === 'AbortError' ? 'timeout' : err?.message || 'request failed'}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`在线更新镜像请求失败（${mirrorBase}）：HTTP ${response.status}`);
    let manifest;
    try {
        manifest = JSON.parse(text);
    } catch {
        throw new Error(`在线更新镜像清单不是有效 JSON：${mirrorBase}/manifest.json`);
    }
    return parseMirrorManifest(manifest, mirrorBase);
}

async function getMirrorReleaseVersions(bucket, env, mirrorBase, options = {}) {
    // Mirror manifests are intentionally checked live; force remains a compatible no-op.
    void options.force;
    const now = Date.now();
    const versions = await fetchMirrorReleaseVersions(mirrorBase, options.requestBudget || null);
    return { versions, cache: { hit: false, stale: false, cachedAt: now } };
}

async function getReleaseVersions(bucket, env, options = {}) {
    const force = Boolean(options.force);
    const cached = await readR2Json(bucket, APP_RELEASE_CACHE_KEY).catch(() => null);
    const now = Date.now();
    if (
        !force
        && Array.isArray(cached?.versions)
        && cached.versions.length > 0
        && now - Number(cached.cachedAt || 0) < APP_RELEASE_CACHE_TTL_MS
    ) {
        return { versions: cached.versions, cache: { hit: true, stale: false, cachedAt: cached.cachedAt } };
    }

    try {
        const versions = await fetchReleaseVersions(env, options.requestBudget || null);
        const nextCache = {
            upstreamRepo: UPSTREAM_REPO,
            cachedAt: now,
            ttlMs: APP_RELEASE_CACHE_TTL_MS,
            versions
        };
        await bucket.put(APP_RELEASE_CACHE_KEY, JSON.stringify(nextCache, null, 2), {
            httpMetadata: { contentType: 'application/json; charset=utf-8' }
        });
        return { versions, cache: { hit: false, stale: false, cachedAt: now } };
    } catch (err) {
        if (Array.isArray(cached?.versions) && cached.versions.length > 0) {
            return {
                versions: cached.versions,
                cache: {
                    hit: true,
                    stale: true,
                    cachedAt: cached.cachedAt,
                    error: err instanceof Error ? err.message : '版本列表刷新失败。'
                }
            };
        }
        throw err;
    }
}

async function getConfiguredReleaseVersions(bucket, env, options = {}) {
    const mirrorBase = getAppUpdateMirrorBase(env);
    return mirrorBase
        ? getMirrorReleaseVersions(bucket, env, mirrorBase, options)
        : getReleaseVersions(bucket, env, options);
}

async function getAppliedAppUpdateManifest(bucket) {
    return readR2Json(bucket, APP_UPDATE_MANIFEST_KEY);
}

async function getAppliedAppUpdateManifestState(bucket) {
    const state = await readR2JsonObject(bucket, APP_UPDATE_MANIFEST_KEY);
    return { object: state.object, manifest: state.value };
}

function getManifestCurrent(manifest) {
    return manifest?.current && (typeof manifest.current.upstreamTag === 'string' || typeof manifest.current.upstreamSha === 'string') ? manifest.current : null;
}

function getManifestPrevious(manifest) {
    return manifest?.previous && (typeof manifest.previous.upstreamTag === 'string' || typeof manifest.previous.upstreamSha === 'string') ? manifest.previous : null;
}

function hasCurrentAppPatchRevision(version) {
    return version?.patchRevision === RP_HUB_APP_PATCH_REVISION;
}

function getActiveManifestCurrent(manifest) {
    const current = getManifestCurrent(manifest);
    return hasCurrentAppPatchRevision(current) ? current : null;
}

function getRollbackManifestPrevious(manifest) {
    const previous = getManifestPrevious(manifest);
    return hasCurrentAppPatchRevision(previous) ? previous : null;
}

function getStoredVersionRef(version) {
    return typeof version?.upstreamTag === 'string' && version.upstreamTag
        ? version.upstreamTag
        : typeof version?.upstreamSha === 'string' ? version.upstreamSha : '';
}

function normalizeAppUpdateSlot(value) {
    const slot = typeof value === 'string' ? value.trim() : '';
    if (!slot || slot.startsWith('/') || slot.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(slot)) return '';
    return slot;
}

function getStoredAppUpdateSlot(version, legacySlot) {
    return normalizeAppUpdateSlot(version?.slot) || legacySlot;
}

function withStoredAppUpdateSlot(version, legacySlot) {
    if (!version) return null;
    return {
        ...version,
        slot: getStoredAppUpdateSlot(version, legacySlot)
    };
}

function createAppUpdateSlot(tag) {
    const safeTag = String(tag || 'release').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'release';
    return `versions/${safeTag}-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function getStoredAppUpdateKey(slot, filePath) {
    return `${APP_UPDATE_PREFIX}/${slot}/${filePath}`;
}

function normalizeVersionTag(value) {
    return String(value || '').trim().replace(/^v/i, '');
}

function parseBundledVersionFromAppJs(text) {
    const match = String(text || '').match(/RP-Hub\s+v?(\d+(?:\.\d+){1,3})/i);
    return match ? match[1] : '';
}

async function getBundledAppVersion(env) {
    if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') return CURRENT_UPSTREAM_VERSION;
    try {
        const response = await env.ASSETS.fetch(new Request('https://rph.local/assets/js/app.js'));
        if (!response.ok) return CURRENT_UPSTREAM_VERSION;
        return parseBundledVersionFromAppJs(await response.text()) || CURRENT_UPSTREAM_VERSION;
    } catch (err) {
        return CURRENT_UPSTREAM_VERSION;
    }
}

function getStoredFilePath(file) {
    if (typeof file === 'string') return file;
    return typeof file?.path === 'string' ? file.path : '';
}

async function deleteStoredFiles(bucket, slot, files) {
    const normalizedSlot = normalizeAppUpdateSlot(slot);
    if (!normalizedSlot) return;
    const keys = [...new Set((Array.isArray(files) ? files : [])
        .map(getStoredFilePath)
        .filter(isAllowedAppUpdatePath)
        .map((filePath) => getStoredAppUpdateKey(normalizedSlot, filePath)))];
    if (keys.length > 0) await bucket.delete(keys);
}

// 新版本槽里实际存着的文件（一次 list 就够，不用逐个 head）。
async function listStagedAppUpdateFiles(bucket, slot) {
    const prefix = getStoredAppUpdateKey(slot, '');
    const files = [];
    for (let cursor; ;) {
        const page = await bucket.list({ prefix, cursor, include: ['customMetadata'] });
        for (const object of page.objects || []) {
            files.push({
                path: object.key.slice(prefix.length),
                checksum: String(object.customMetadata?.checksum || ''),
                byteLength: Number(object.size) || 0,
                source: String(object.customMetadata?.source || '')
            });
        }
        if (!page.truncated || !page.cursor) return files.sort((left, right) => left.path.localeCompare(right.path));
        cursor = page.cursor;
    }
}

function getReferencedAppUpdateSlots(manifest) {
    const slots = new Set();
    const current = getManifestCurrent(manifest);
    const previous = getManifestPrevious(manifest);
    if (current) slots.add(getStoredAppUpdateSlot(current, 'current'));
    if (previous) slots.add(getStoredAppUpdateSlot(previous, 'previous'));
    return slots;
}

async function deleteAppUpdateSlotIfUnreferenced(bucket, slot, files, warningLabel) {
    let latestManifest;
    try {
        latestManifest = await getAppliedAppUpdateManifest(bucket);
    } catch (err) {
        console.warn(`[RP App Update] ${warningLabel}; latest manifest could not be read, preserving slot ${slot}:`, err);
        return false;
    }
    if (getReferencedAppUpdateSlots(latestManifest).has(slot)) return false;
    await deleteStoredFiles(bucket, slot, files);
    return true;
}

async function cleanupUnreferencedAppUpdateVersions(bucket, candidates) {
    for (const candidate of candidates) {
        if (!candidate?.version) continue;
        const slot = getStoredAppUpdateSlot(candidate.version, candidate.legacySlot);
        await deleteAppUpdateSlotIfUnreferenced(
            bucket,
            slot,
            candidate.version.files,
            'Failed to verify an unreferenced version slot'
        );
    }
}

// 更新中途断掉（关掉页面、首个请求超时后页面重发了不带 slot 的请求）留下的半截槽没人引用也没人删，
// 每个最多 160MB：按槽名里的时间戳，隔天还没进清单的整槽删掉；正在写的新槽不到一天，不会误删。
async function cleanupStaleAppUpdateSlots(bucket) {
    const keysBySlot = new Map();
    let cursor;
    do {
        const page = await bucket.list({ prefix: `${APP_UPDATE_PREFIX}/versions/`, cursor, limit: 1000 });
        for (const object of page.objects || []) {
            const slot = object.key.slice(APP_UPDATE_PREFIX.length + 1).split('/').slice(0, 2).join('/');
            if (!keysBySlot.has(slot)) keysBySlot.set(slot, []);
            keysBySlot.get(slot).push(object.key);
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (!keysBySlot.size) return;
    const referenced = getReferencedAppUpdateSlots(await getAppliedAppUpdateManifest(bucket));
    for (const [slot, keys] of keysBySlot) {
        const createdAt = parseInt(slot.match(/-([0-9a-z]+)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)?.[1] || '', 36);
        if (referenced.has(slot) || !Number.isFinite(createdAt) || Date.now() - createdAt < 24 * 60 * 60 * 1000) continue;
        for (let index = 0; index < keys.length; index += 1000) await bucket.delete(keys.slice(index, index + 1000));
    }
}

function scheduleAppUpdateCleanup(ctx, bucket, candidates) {
    const cleanup = cleanupUnreferencedAppUpdateVersions(bucket, candidates).then(() => cleanupStaleAppUpdateSlots(bucket)).catch((err) => {
        console.warn('[RP App Update] Failed to clean unreferenced version slot:', err);
    });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(cleanup);
    else void cleanup;
}

function getAppUpdateManifestPutOptions(object) {
    return {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        onlyIf: object
            ? { etagMatches: object.etag }
            : { etagDoesNotMatch: '*' }
    };
}

async function handleAppUpdateCheck(bucket, env) {
    const [releaseResult, applied, bundledVersion] = await Promise.all([
        getConfiguredReleaseVersions(bucket, env),
        getAppliedAppUpdateManifest(bucket),
        getBundledAppVersion(env)
    ]);
    const latest = releaseResult.versions[0];
    const current = getActiveManifestCurrent(applied);
    const previous = getRollbackManifestPrevious(applied);
    const mirrorBase = getAppUpdateMirrorBase(env);
    const currentRef = mirrorBase
        ? (current?.upstreamSha || CURRENT_UPSTREAM_SHA)
        : (getStoredVersionRef(current) || bundledVersion || CURRENT_UPSTREAM_SHA);
    const latestRef = mirrorBase ? (latest?.sha || '') : (latest?.tag || latest?.sha || '');

    return json({
        ok: true,
        current: {
            tag: current?.upstreamTag || '',
            sha: currentRef,
            shortSha: currentRef.slice(0, 16),
            version: current?.upstreamTag || bundledVersion || '',
            label: current?.upstreamTag || (bundledVersion ? `内置 ${bundledVersion}` : ''),
            source: current ? 'r2' : 'bundle',
            appliedAt: Number(current?.appliedAt || 0),
            fileCount: Array.isArray(current?.files) ? current.files.length : 0
        },
        previous: previous ? {
            tag: previous.upstreamTag || getStoredVersionRef(previous),
            sha: getStoredVersionRef(previous),
            shortSha: getStoredVersionRef(previous).slice(0, 16),
            appliedAt: Number(previous.appliedAt || 0),
            fileCount: Array.isArray(previous.files) ? previous.files.length : 0
        } : null,
        latest,
        cache: releaseResult.cache,
        versions: releaseResult.versions,
        updateAvailable: normalizeVersionTag(currentRef) !== normalizeVersionTag(latestRef)
    });
}

function parseProxyList(value) {
    if (typeof value !== 'string') return [];
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeProxyPrefix(proxy) {
    const trimmed = String(proxy || '').trim();
    if (!trimmed) return '';
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function encodePathSegments(path) {
    return String(path || '').split('/').map((part) => encodeURIComponent(part)).join('/');
}

function buildRawFileUrl(path, ref) {
    return `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${encodeURIComponent(ref)}/${encodePathSegments(path)}`;
}

function buildProxyUrl(proxy, upstreamUrl) {
    const prefix = normalizeProxyPrefix(proxy);
    if (!prefix) return upstreamUrl;
    return `${prefix}${upstreamUrl}`;
}

function getDownloadSources(path, ref, env) {
    const upstreamUrl = buildRawFileUrl(path, ref);
    const proxyList = parseProxyList(env?.[APP_UPDATE_DOWNLOAD_PROXY_ENV]);
    const proxies = proxyList.length ? proxyList : DEFAULT_APP_UPDATE_DOWNLOAD_PROXIES;
    const seen = new Set([upstreamUrl]);
    const sources = [{
        name: 'github',
        url: upstreamUrl,
        proxied: false
    }];
    for (const proxy of proxies) {
        const url = buildProxyUrl(proxy, upstreamUrl);
        if (seen.has(url)) continue;
        seen.add(url);
        sources.push({
            name: normalizeProxyPrefix(proxy).replace(/\/$/, ''),
            url,
            proxied: true
        });
    }
    return sources;
}

async function fetchWithTimeout(url, options = {}, requestBudget = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), APP_UPDATE_DOWNLOAD_TIMEOUT_MS);
    try {
        return await fetchWithBudgetedRedirects(url, {
            ...options,
            signal: controller.signal
        }, requestBudget);
    } finally {
        clearTimeout(timeout);
    }
}

async function fetchUpstreamFile(path, ref, env, requestBudget = null) {
    const failures = [];
    const sources = getDownloadSources(path, ref, env);
    for (const source of sources) {
        try {
            const response = await fetchWithTimeout(source.url, {
                headers: source.proxied
                    ? { accept: 'application/octet-stream' }
                    : buildGitHubHeaders(env, 'application/octet-stream')
            }, requestBudget);
            if (!response.ok) {
                failures.push(`${source.name}: HTTP ${response.status}`);
                continue;
            }
            return {
                bytes: await response.arrayBuffer(),
                source: source.name
            };
        } catch (err) {
            if (err?.code === 'RP_HUB_APP_UPDATE_REQUEST_LIMIT') throw err;
            failures.push(`${source.name}: ${err?.name === 'AbortError' ? 'timeout' : err?.message || 'request failed'}`);
        }
    }
    throw new Error(`下载上游文件失败：${path}；${failures.join('；')}`);
}

async function fetchMirrorUpstreamFile(path, version, mirrorBase, requestBudget = null) {
    const tag = sanitizeReleaseTag(version?.tag);
    const commit = typeof version?.sha === 'string' ? version.sha.toLowerCase() : '';
    const descriptor = Array.isArray(version?.files)
        ? version.files.find((file) => file.path === path)
        : null;
    if (!tag || !/^[a-f0-9]{40}$/.test(commit) || !descriptor) {
        throw new Error(`在线更新镜像缺少文件清单项：${path}`);
    }
    const url = `${mirrorBase}/snapshots/${encodePathSegments(tag)}/${commit}/${encodePathSegments(path)}`;
    let response;
    try {
        response = await fetchWithTimeout(url, {
            headers: { accept: 'application/octet-stream' }
        }, requestBudget);
    } catch (err) {
        if (err?.code === 'RP_HUB_APP_UPDATE_REQUEST_LIMIT') throw err;
        throw new Error(`下载镜像文件失败（${mirrorBase}）：${path}；${err?.name === 'AbortError' ? 'timeout' : err?.message || 'request failed'}`);
    }
    if (!response.ok) throw new Error(`下载镜像文件失败（${mirrorBase}）：${path}；HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const checksum = await sha256Bytes(bytes);
    if (checksum !== descriptor.sha256) {
        throw new Error(`镜像文件 SHA-256 不匹配，已拒绝更新：${path}`);
    }
    return { bytes, source: 'mirror' };
}

async function fetchConfiguredUpstreamFile(path, version, env, requestBudget = null) {
    const mirrorBase = getAppUpdateMirrorBase(env);
    return mirrorBase
        ? fetchMirrorUpstreamFile(path, version, mirrorBase, requestBudget)
        : fetchUpstreamFile(path, version.tag, env, requestBudget);
}

function patchUpstreamTextFile(path, text, version = 'unknown') {
    if (path === RP_HUB_CLOUD_BACKUP_PATH) return patchRpHubCloudBackupJs(text, { version }).code;
    if (path !== 'assets/js/app.js') return text;
    return patchRpHubAppJs(text, { version }).code;
}

function shouldPatchAsText(path) {
    return path === 'assets/js/app.js' || path === RP_HUB_CLOUD_BACKUP_PATH;
}

function encodeText(text) {
    return new TextEncoder().encode(text);
}

async function runConcurrent(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);

    async function runNext() {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    }

    if (workerCount === 0) return results;
    await Promise.all(Array.from({ length: workerCount }, () => runNext()));
    return results;
}

function isAllowedAppUpdatePath(path) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..')) return false;
    const rootName = path.split('/')[0];
    if (PRESERVED_APP_UPDATE_ROOTS.has(rootName)) return false;
    return true;
}

async function listUpstreamFilesFromContents(ref, env, requestBudget = null) {
    const files = [];
    const queue = [''];
    const seenDirs = new Set();
    while (queue.length > 0) {
        const directory = queue.shift();
        if (seenDirs.has(directory)) continue;
        seenDirs.add(directory);

        const encodedPath = directory
            ? directory.split('/').map((part) => encodeURIComponent(part)).join('/')
            : '';
        const url = `https://api.github.com/repos/${UPSTREAM_REPO}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
        const entries = await fetchGitHubJson(url, env, requestBudget);
        if (!Array.isArray(entries)) throw new Error('GitHub 文件列表格式异常。');

        for (const entry of entries) {
            const path = typeof entry?.path === 'string' ? entry.path : '';
            if (!isAllowedAppUpdatePath(path)) continue;
            if (entry.type === 'dir') {
                queue.push(path);
                continue;
            }
            if (entry.type !== 'file') continue;
            const size = Number(entry.size || 0);
            if (size > MAX_APP_UPDATE_FILE_BYTES) {
                throw new Error(`上游文件过大，已停止更新：${path}`);
            }
            files.push(path);
            if (files.length > MAX_APP_UPDATE_FILES) {
                throw new Error(`上游文件数量超过限制（${MAX_APP_UPDATE_FILES}），已停止更新。`);
            }
        }
    }
    files.sort((a, b) => a.localeCompare(b));
    for (const required of REQUIRED_UPSTREAM_FILES) {
        if (!files.includes(required)) throw new Error(`上游 Release 缺少必要文件：${required}`);
    }
    return files;
}

async function getUpstreamFilesForUpdate(ref, env, requestBudget = null) {
    try {
        return {
            files: await listUpstreamFilesFromContents(ref, env, requestBudget),
            source: 'github-contents'
        };
    } catch (err) {
        const failure = new Error(`读取上游完整文件列表失败，已拒绝更新：${err instanceof Error ? err.message : '未知错误'}`);
        failure.code = 'RP_HUB_APP_FILE_LIST_FAILED';
        throw failure;
    }
}

async function getMirrorUpstreamFilesForUpdate(version) {
    try {
        const descriptors = Array.isArray(version?.files) ? version.files.map(normalizeMirrorFile) : [];
        if (descriptors.length > MAX_APP_UPDATE_FILES) {
            throw new Error(`上游文件数量超过限制（${MAX_APP_UPDATE_FILES}），已停止更新。`);
        }
        const files = descriptors.map((file) => file.path).sort((a, b) => a.localeCompare(b));
        for (const required of REQUIRED_UPSTREAM_FILES) {
            if (!files.includes(required)) throw new Error(`上游 Release 缺少必要文件：${required}`);
        }
        return { files, source: 'mirror-manifest' };
    } catch (err) {
        const failure = new Error(`读取上游完整文件列表失败，已拒绝更新：${err instanceof Error ? err.message : '未知错误'}`);
        failure.code = 'RP_HUB_APP_FILE_LIST_FAILED';
        throw failure;
    }
}

async function getConfiguredUpstreamFilesForUpdate(version, env, requestBudget = null) {
    return getAppUpdateMirrorBase(env)
        ? getMirrorUpstreamFilesForUpdate(version)
        : getUpstreamFilesForUpdate(version.tag, env, requestBudget);
}

async function handleAppUpdateApply(bucket, body = {}, env, ctx) {
    const requestBudget = createAppUpdateRequestBudget();
    const releaseResult = await getConfiguredReleaseVersions(bucket, env, { requestBudget });
    const targetTag = sanitizeReleaseTag(body.target) || releaseResult.versions[0]?.tag || '';
    if (!targetTag) return error('没有可更新的 Release 版本。', 409);
    const latest = releaseResult.versions.find((version) => version.tag === targetTag) || {
        tag: targetTag,
        sha: targetTag,
        shortSha: targetTag,
        name: targetTag,
        date: '',
        message: targetTag
    };
    const manifestState = await getAppliedAppUpdateManifestState(bucket);
    const applied = manifestState.manifest;
    const current = getManifestCurrent(applied);
    const previous = getManifestPrevious(applied);
    const currentPatchCompatible = hasCurrentAppPatchRevision(current);
    const mirrorBase = getAppUpdateMirrorBase(env);
    const currentVersionRef = mirrorBase
        ? (typeof current?.upstreamSha === 'string' ? current.upstreamSha : '')
        : getStoredVersionRef(current);
    const latestVersionRef = mirrorBase ? latest.sha : latest.tag;
    if (currentVersionRef === latestVersionRef && currentPatchCompatible) {
        return json({ ok: true, alreadyUpToDate: true, latest });
    }

    let upstreamFileResult;
    try {
        upstreamFileResult = await getConfiguredUpstreamFilesForUpdate(latest, env, requestBudget);
    } catch (err) {
        if (err?.code === 'RP_HUB_APP_FILE_LIST_FAILED') {
            return error(err.message, 409, { code: err.code });
        }
        throw err;
    }
    const upstreamFiles = upstreamFileResult.files;
    // 分批：续传时页面带回上次的新版本槽和已处理的文件数。槽必须是 versions/ 下、还没启用的那个，免得写到正在用的版本上。
    const continuedSlot = typeof body.slot === 'string' && /^versions\/[A-Za-z0-9._-]+$/.test(body.slot)
        && !getReferencedAppUpdateSlots(applied).has(body.slot) ? body.slot : '';
    const offset = continuedSlot && Number.isInteger(body.offset) && body.offset > 0 && body.offset <= upstreamFiles.length ? body.offset : 0;
    const stagingSlot = offset > 0 ? continuedSlot : createAppUpdateSlot(latest.tag);
    const batch = upstreamFiles.slice(offset, offset + APP_UPDATE_FILES_PER_REQUEST);
    let files = [];
    let totalBytes = 0;
    let committed = false;
    let committedManifest = null;
    try {
        const outcomes = await runConcurrent(batch, APP_UPDATE_FILE_CONCURRENCY, async (path) => {
            try {
                const upstreamFile = await fetchConfiguredUpstreamFile(path, latest, env, requestBudget);
                let bytes = new Uint8Array(upstreamFile.bytes);
                if (shouldPatchAsText(path)) {
                    const text = new TextDecoder().decode(bytes);
                    bytes = encodeText(patchUpstreamTextFile(path, text, latest.tag));
                }
                if (bytes.byteLength > MAX_APP_UPDATE_FILE_BYTES) {
                    throw new Error(`上游文件过大，已停止更新：${path}`);
                }
                const checksum = await sha256Bytes(bytes);
                const stored = await bucket.put(getStoredAppUpdateKey(stagingSlot, path), bytes, {
                    httpMetadata: { contentType: getContentType(path) },
                    customMetadata: { upstreamTag: latest.tag, checksum, source: upstreamFile.source }
                });
                if (!stored) throw new Error(`写入新版本槽失败：${path}`);
                return {
                    path,
                    checksum,
                    byteLength: bytes.byteLength,
                    source: upstreamFile.source
                };
            } catch (err) {
                return {
                    path,
                    error: err instanceof Error ? err.message : '下载上游文件失败。',
                    code: err?.code || '',
                    patchRejected: err instanceof RpHubAppPatchError || err?.code === 'RP_HUB_APP_PATCH_REJECTED'
                };
            }
        });

        const failed = outcomes.find((outcome) => outcome?.code === 'RP_HUB_APP_UPDATE_REQUEST_LIMIT')
            || outcomes.find((outcome) => outcome?.error);
        if (failed) {
            const failure = new Error(failed.error);
            if (failed.patchRejected) failure.code = 'RP_HUB_APP_PATCH_REJECTED';
            else if (failed.code) failure.code = failed.code;
            throw failure;
        }
        const staged = offset + batch.length;
        if (staged < upstreamFiles.length) {
            return json({ ok: true, alreadyUpToDate: false, done: false, latest, slot: stagingSlot, staged, total: upstreamFiles.length });
        }
        // 全部文件都进了新版本槽：按槽里实际存的文件记清单，少了就不启用。
        files = await listStagedAppUpdateFiles(bucket, stagingSlot);
        const missing = upstreamFiles.find((path) => !files.some((file) => file.path === path));
        if (missing) {
            const failure = new Error(`新版本文件没有存全（${missing}），请重新更新。`);
            failure.code = 'RP_HUB_APP_RELEASE_INCOMPLETE';
            throw failure;
        }
        totalBytes = files.reduce((sum, file) => sum + file.byteLength, 0);
        if (totalBytes > MAX_APP_UPDATE_TOTAL_BYTES) {
            throw new Error(`上游文件总大小超过限制（${Math.round(MAX_APP_UPDATE_TOTAL_BYTES / 1024 / 1024)}MiB），已停止更新。`);
        }
        for (const required of REQUIRED_UPSTREAM_FILES) {
            if (!files.some((file) => file.path === required)) {
                const failure = new Error(`上游 Release 缺少必要文件：${required}`);
                failure.code = 'RP_HUB_APP_RELEASE_INCOMPLETE';
                throw failure;
            }
        }

        committedManifest = {
            upstreamRepo: UPSTREAM_REPO,
            upstreamBranch: UPSTREAM_BRANCH,
            updatedAt: Date.now(),
            current: {
                slot: stagingSlot,
                patchRevision: RP_HUB_APP_PATCH_REVISION,
                upstreamTag: latest.tag,
                upstreamSha: mirrorBase ? latest.sha : latest.tag,
                upstreamDate: latest.date,
                upstreamMessage: latest.message,
                appliedAt: Date.now(),
                files,
                fileListSource: upstreamFileResult.source,
                totalBytes
            },
            previous: currentPatchCompatible
                ? withStoredAppUpdateSlot(current, 'current')
                : null
        };

        let committedObject;
        try {
            committedObject = await bucket.put(
                APP_UPDATE_MANIFEST_KEY,
                JSON.stringify(committedManifest, null, 2),
                getAppUpdateManifestPutOptions(manifestState.object)
            );
        } catch (err) {
            const observed = await getAppliedAppUpdateManifest(bucket).catch(() => null);
            if (!getReferencedAppUpdateSlots(observed).has(stagingSlot)) throw err;
            committedObject = true;
        }
        if (!committedObject) {
            await deleteAppUpdateSlotIfUnreferenced(
                bucket,
                stagingSlot,
                upstreamFiles,
                'Failed to verify a conflicted version slot'
            ).catch((cleanupError) => {
                console.warn('[RP App Update] Failed to clean conflicted version slot:', cleanupError);
            });
            return error('在线更新冲突：当前版本已被其他请求切换，请重新检查后重试。', 409, {
                code: 'RP_HUB_APP_UPDATE_CONFLICT'
            });
        }
        committed = true;
    } catch (err) {
        if (!committed) {
            await deleteAppUpdateSlotIfUnreferenced(
                bucket,
                stagingSlot,
                upstreamFiles,
                'Failed to verify a rejected version slot'
            ).catch((cleanupError) => {
                console.warn('[RP App Update] Failed to clean rejected version slot:', cleanupError);
            });
        }
        if (
            err?.code === 'RP_HUB_APP_PATCH_REJECTED'
            || err?.code === 'RP_HUB_APP_RELEASE_INCOMPLETE'
            || err?.code === 'RP_HUB_APP_UPDATE_REQUEST_LIMIT'
        ) {
            return error(err.message, 409, { code: err.code });
        }
        throw err;
    }

    scheduleAppUpdateCleanup(ctx, bucket, [
        { version: current, legacySlot: 'current' },
        { version: previous, legacySlot: 'previous' }
    ]);

    return json({
        ok: true,
        alreadyUpToDate: false,
        done: true,
        latest,
        fileCount: files.length,
        totalBytes,
        fileListSource: upstreamFileResult.source
    });
}

async function handleAppUpdateVersions(bucket, env, body = {}) {
    const result = await getConfiguredReleaseVersions(bucket, env, { force: Boolean(body.force) });
    return json({ ok: true, versions: result.versions, cache: result.cache });
}

async function handleAppUpdateRollback(bucket) {
    const manifestState = await getAppliedAppUpdateManifestState(bucket);
    const applied = manifestState.manifest;
    const current = getManifestCurrent(applied);
    const previous = getManifestPrevious(applied);
    if (!previous) return error('没有可回滚的上一版。', 409);
    if (!hasCurrentAppPatchRevision(previous)) {
        return error('上一版未通过当前角色卡存储补丁验证，已拒绝回滚。', 409, {
            code: 'RP_HUB_APP_ROLLBACK_PATCH_MISMATCH'
        });
    }

    const manifest = {
        upstreamRepo: UPSTREAM_REPO,
        upstreamBranch: UPSTREAM_BRANCH,
        updatedAt: Date.now(),
        current: withStoredAppUpdateSlot(previous, 'previous'),
        previous: withStoredAppUpdateSlot(current, 'current')
    };
    let committedObject;
    try {
        committedObject = await bucket.put(
            APP_UPDATE_MANIFEST_KEY,
            JSON.stringify(manifest, null, 2),
            getAppUpdateManifestPutOptions(manifestState.object)
        );
    } catch (err) {
        const observed = await getAppliedAppUpdateManifest(bucket).catch(() => null);
        const observedCurrent = getManifestCurrent(observed);
        const observedPrevious = getManifestPrevious(observed);
        const observedPreviousSlot = observedPrevious
            ? getStoredAppUpdateSlot(observedPrevious, 'previous')
            : null;
        if (
            getStoredAppUpdateSlot(observedCurrent, 'current') !== manifest.current.slot
            || observedPreviousSlot !== (manifest.previous?.slot || null)
        ) {
            throw err;
        }
        committedObject = true;
    }
    if (!committedObject) {
        return error('在线更新冲突：当前版本已被其他请求切换，请重新检查后重试。', 409, {
            code: 'RP_HUB_APP_UPDATE_CONFLICT'
        });
    }

    return json({
        ok: true,
        rolledBackTo: {
            tag: previous.upstreamTag || getStoredVersionRef(previous),
            sha: getStoredVersionRef(previous),
            shortSha: getStoredVersionRef(previous).slice(0, 16)
        }
    });
}

