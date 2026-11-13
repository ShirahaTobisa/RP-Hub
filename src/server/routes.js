async function handleApi(request, env, url, ctx) {
    const action = url.searchParams.get('action');
    if (action !== 'upload-part' && action !== 'fork-export-pack') return handleJsonApi(request, env, ctx);
    if (request.method !== 'POST') return error('Method not allowed.', 405);
    if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });
    const handler = action === 'upload-part' ? handleUploadPart : handleForkExportPack;
    return handler(request, getBucket(env), url);
}

async function serveStatic(request, env) {
    if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') {
        throw new Error('Missing ASSETS binding. Pages Advanced Mode requires env.ASSETS.fetch(request).');
    }
    const pathname = new URL(request.url).pathname;
    const staticPath = normalizeStaticPath(pathname);
    let response = null;
    let appUpdateInfo = null;

    if (staticPath && isAllowedAppUpdatePath(staticPath)) {
        try {
            const bucket = getBucket(env);
            const manifest = await getAppliedAppUpdateManifest(bucket).catch(() => null);
            const current = getActiveManifestCurrent(manifest);
            if (current) {
                const slot = getStoredAppUpdateSlot(current, 'current');
                const object = await bucket.get(getStoredAppUpdateKey(slot, staticPath));
                if (object) {
                    // 首页要注入覆盖层，不缓存；其他文件带 ETag，浏览器复查时内容没变就只回 304，不再重传。
                    const etag = shouldInject(pathname) ? '' : object.httpEtag || '';
                    if (etag && request.headers.get('if-none-match') === etag) {
                        await object.body?.cancel?.();
                        response = new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-cache' } });
                    } else {
                        response = new Response(object.body, {
                            headers: {
                                'content-type': object.httpMetadata?.contentType || getContentType(staticPath),
                                'cache-control': etag ? 'no-cache' : 'no-store',
                                ...(etag ? { etag } : {})
                            }
                        });
                    }
                }
            }
            if (shouldInject(pathname)) {
                if (current) {
                    appUpdateInfo = {
                        tag: current.upstreamTag || getStoredVersionRef(current),
                        appliedAt: Number(current.appliedAt || 0)
                    };
                }
            }
        } catch (err) {
            console.warn('[RP App Update] Failed to read updated static file:', err);
        }
    }

    if (!response) {
        response = await env.ASSETS.fetch(request);
        // 覆盖层按内容哈希加 ?v=（打包时写入），内容变了地址就变，浏览器可以一直用缓存，不必每次复查。
        if (response.ok && pathname.startsWith('/DB/') && /^[a-f0-9]{12}$/.test(new URL(request.url).searchParams.get('v') || '')) {
            response = new Response(response.body, response);
            response.headers.set('cache-control', 'public, max-age=31536000, immutable');
        }
    }

    if (staticPath === UPDATE_NOTICE_SCRIPT_PATH && response.ok) return skipUpdateNoticeCountdown(response);
    const contentType = response.headers.get('content-type') || '';
    if (!shouldInject(pathname) || !contentType.includes('text/html')) return response;
    return new HTMLRewriter()
        .on('head', {
            element(element) {
                let mirrorBase = '';
                try { mirrorBase = getAppUpdateMirrorBase(env); } catch (_) { /* 地址配置无效时工坊不可用 */ }
                element.append(buildInjectedBootstrap(appUpdateInfo, mirrorBase, Boolean(mirrorBase && (env.CF_ACCOUNT_ID || env.CF_API_TOKEN))), { html: true });
            }
        })
        .on('button', updateNoticeButtonRewriter)
        .on('meta[name="rphub-presence-api"]', remotePingMetaRewriter)
        .on('meta[name="rphub-update-api"]', cloudBackupMetaRewriter)
        .transform(response);
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        try {
            if (url.pathname === FEEDBACK_PATH) return await handleFeedback(request, env);
            if (url.pathname === IMAGE_API_PATH) return await handleImageRender(request, env);
            if (url.pathname === IMAGE_THUMB_API_PATH) return await handleImageThumbUpload(request, env);
            if (url.pathname === IMAGE_ADMIN_PATH || url.pathname.startsWith(IMAGE_ADMIN_PATH + '/')) {
                return await handleImageAdmin(request, env, url);
            }
            if (url.pathname === API_PATH) return await handleApi(request, env, url, ctx);
        } catch (err) {
            return error(err instanceof Error ? err.message : 'Unexpected server error.', getErrorStatus(err));
        }
        return serveStatic(request, env);
    }
};
