function imageJson(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...extraHeaders
        }
    });
}

function normalizeImageParam(value, maxLength = 30000) {
    const text = String(value || '').trim();
    return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function collectExtraImageParams(url) {
    const entries = [];
    for (const [rawKey, rawValue] of url.searchParams.entries()) {
        const key = String(rawKey || '').trim();
        if (!IMAGE_GENERATION_PARAM_NAME_PATTERN.test(key)) continue;
        if (IMAGE_NON_GENERATION_QUERY_KEYS.has(key.toLowerCase())) continue;
        entries.push([key, normalizeImageParam(rawValue)]);
    }
    entries.sort((left, right) => {
        if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
        if (left[1] === right[1]) return 0;
        return left[1] < right[1] ? -1 : 1;
    });
    return entries;
}

function sanitizeImageKeySegment(value, fallback = '未命名角色') {
    const normalized = String(value || '')
        .normalize('NFKC')
        .trim()
        .replace(/[\\/:*?"<>|#%&{}$!`'@+=\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 96);
    return normalized || fallback;
}

function normalizeImageCharacterId(value) {
    const normalized = String(value || '').normalize('NFKC').trim();
    if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) return '';
    return normalized;
}

function getImageProviderBase(provider, token) {
    const normalized = String(provider || '').trim().toLowerCase();
    if (normalized === 'sta1n') return 'https://nai.sta1n.cn';
    if (normalized === 'std') return 'https://std.loliyc.com';
    return String(token || '').trim().toUpperCase().startsWith('STA1N')
        ? 'https://nai.sta1n.cn'
        : 'https://std.loliyc.com';
}

function getImageProviderName(provider, token) {
    return getImageProviderBase(provider, token).includes('nai.sta1n.cn') ? 'sta1n' : 'std';
}

function getImageTokenProviderName(token) {
    const normalized = String(token || '').trim().toUpperCase();
    if (normalized.startsWith('STA1N')) return 'sta1n';
    if (normalized.startsWith('STD')) return 'std';
    return '';
}

function getImageClientToken(request, url) {
    return normalizeImageParam(request?.headers?.get(IMAGE_TOKEN_HEADER), 1000)
        || normalizeImageParam(url.searchParams.get('token'), 1000);
}

function getImageRequestToken(request, url, env) {
    return getImageClientToken(request, url)
        || normalizeImageParam(env?.IMAGE_GEN_TOKEN, 1000);
}

function assertImageTokenProvider(params, token) {
    const tokenProvider = getImageTokenProviderName(token);
    const requestedProvider = String(params.requested_provider || '').trim();
    if (tokenProvider && requestedProvider && tokenProvider !== requestedProvider) {
        throw createHttpError('生图密钥与图片记录的 provider 不匹配。', 409);
    }
}

function buildImageParams(url, token) {
    const params = {};
    for (const key of IMAGE_SIGNATURE_KEYS) {
        params[key] = normalizeImageParam(url.searchParams.get(key));
    }
    params.reroll_nonce = normalizeImageParam(url.searchParams.get('reroll_nonce'), 120);
    params.extra_params = collectExtraImageParams(url);
    const requestedProvider = String(params.provider || '').trim().toLowerCase();
    params.requested_provider = requestedProvider === 'sta1n' || requestedProvider === 'std'
        ? requestedProvider
        : '';
    // Keep the legacy provider normalization so old image signatures remain stable.
    params.provider = getImageProviderName(requestedProvider, token);
    params.character_id = normalizeImageCharacterId(
        url.searchParams.get('character_id') || url.searchParams.get('character_uuid')
    );
    params.character_name = normalizeImageParam(url.searchParams.get('character_name'), 300) || '未命名角色';
    params.model = params.model || IMAGE_DEFAULT_MODEL;
    params.size = params.size || IMAGE_DEFAULT_SIZE;
    params.steps = params.steps || IMAGE_DEFAULT_STEPS;
    params.scale = params.scale || IMAGE_DEFAULT_SCALE;
    params.cfg = params.cfg || IMAGE_DEFAULT_CFG;
    params.sampler = params.sampler || IMAGE_DEFAULT_SAMPLER;
    params.nocache = params.nocache || '0';
    params.noise_schedule = params.noise_schedule || IMAGE_DEFAULT_NOISE_SCHEDULE;
    return params;
}

function buildImageSignature(params) {
    const signature = {};
    for (const key of IMAGE_SIGNATURE_KEYS) signature[key] = params[key] || '';
    if (params.reroll_nonce) signature.reroll_nonce = params.reroll_nonce;
    if (params.extra_params?.length) signature.extra_params = params.extra_params;
    return JSON.stringify(signature);
}

async function buildImageLookupCandidates(params, token, allowProviderFallback = false) {
    const providers = allowProviderFallback && !params.requested_provider
        ? [params.provider, 'std', 'sta1n']
        : [params.provider];
    const candidates = [];
    for (const provider of [...new Set(providers.filter(Boolean))]) {
        const candidateParams = provider === params.provider
            ? params
            : { ...params, provider };
        const checksum = await sha256Text(buildImageSignature(candidateParams));
        candidates.push({
            params: candidateParams,
            checksum,
            key: createImageKey(candidateParams.character_name, checksum),
            deletedKey: createImageDeletedKey(candidateParams.character_name, checksum)
        });
    }
    return candidates;
}

function createImageKey(characterName, checksum) {
    return `${IMAGE_OBJECT_PREFIX}/${sanitizeImageKeySegment(characterName)}/${checksum}`;
}

function createImageThumbKey(characterName, checksum) {
    return `${IMAGE_THUMB_PREFIX}/${sanitizeImageKeySegment(characterName)}/${checksum}.webp`;
}

function createImageDeletedKey(characterName, checksum) {
    return `${IMAGE_DELETED_PREFIX}/${sanitizeImageKeySegment(characterName)}/${checksum}.json`;
}

function getImageChecksumFromKey(key) {
    const fileName = String(key || '').split('/').pop() || '';
    const match = fileName.match(/^([a-f0-9]{64})$/i);
    return match ? match[0].toLowerCase() : '';
}

function parseImageObjectKey(key) {
    const parts = String(key || '').split('/');
    if (parts[0] !== IMAGE_PREFIX || parts[1] !== 'characters') return null;
    const checksum = getImageChecksumFromKey(key);
    if (!checksum) return null;
    if (parts.length !== 4 || !parts[2]) return null;
    return {
        key: String(key),
        checksum,
        characterName: parts[2],
        groupId: parts[2]
    };
}

function createImageThumbKeyFromImageKey(key) {
    const parsed = parseImageObjectKey(key);
    if (!parsed) return '';
    return createImageThumbKey(parsed.characterName, parsed.checksum);
}

function getImageProviderOverride(params, env) {
    const provider = getImageProviderName(params?.provider, '');
    const configured = provider === 'sta1n'
        ? env?.[IMAGE_PROVIDER_STA1N_ENV]
        : env?.[IMAGE_PROVIDER_STD_ENV];
    const value = String(configured || '').trim();
    if (!value) return '';
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        return url.origin;
    } catch (_) {
        return '';
    }
}

function buildImageUpstreamUrl(params, token, env) {
    if (!params.tag) throw new Error('缺少生图提示词。');
    if (!token) throw new Error('缺少生图密钥。');
    const upstream = new URL('/generate', getImageProviderOverride(params, env) || getImageProviderBase(params.provider, token));
    upstream.searchParams.set('tag', params.tag);
    upstream.searchParams.set('token', token);
    upstream.searchParams.set('model', params.model);
    upstream.searchParams.set('artist', params.artist || '');
    upstream.searchParams.set('size', params.size);
    upstream.searchParams.set('steps', params.steps);
    upstream.searchParams.set('scale', params.scale);
    upstream.searchParams.set('cfg', params.cfg);
    upstream.searchParams.set('sampler', params.sampler);
    upstream.searchParams.set('negative', params.negative || '');
    upstream.searchParams.set('nocache', params.nocache);
    upstream.searchParams.set('noise_schedule', params.noise_schedule);
    if (params.reroll_nonce) upstream.searchParams.set('reroll_nonce', params.reroll_nonce);
    for (const [key, value] of params.extra_params || []) upstream.searchParams.append(key, value);
    return upstream.toString();
}

async function fetchImageWithTimeout(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, {
            headers: {
                accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif',
                'user-agent': 'RPH-R2-Image-Cache'
            },
            signal: controller.signal
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw createHttpError('生图服务请求超时。', 504);
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

// 不用的 R2 对象把流关掉，不留给 GC。
async function discardBody(object) {
    try { await object?.body?.cancel?.(); } catch (_) { }
}

function imageResponse(body, contentType, extraHeaders = {}) {
    return new Response(body, {
        headers: {
            'content-type': contentType || 'image/png',
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            ...extraHeaders
        }
    });
}

function imageHeaderValue(value) {
    return encodeURIComponent(String(value || ''));
}

function normalizeRasterContentType(value) {
    const contentType = String(value || '').split(';', 1)[0].trim().toLowerCase();
    return IMAGE_RASTER_CONTENT_TYPES.has(contentType) ? contentType : '';
}

function deletedImagePlaceholder(characterName) {
    const safeName = String(characterName || 'character')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .slice(0, 80);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640">
<rect width="960" height="640" rx="28" fill="#f6f7f9"/>
<rect x="56" y="56" width="848" height="528" rx="24" fill="#ffffff" stroke="#dfe3e8" stroke-width="2"/>
<text x="480" y="292" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#3f4652">图片已清理</text>
<text x="480" y="348" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#7b8491">${safeName}</text>
</svg>`;
}

async function readStreamChunk(reader, deadline, label) {
    if (!deadline) return reader.read();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw createHttpError(`${label}读取超时。`, 504);
    let timeout;
    try {
        return await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(createHttpError(`${label}读取超时。`, 504)), remaining);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

// 生图服务出错时常常照样回 200，只是正文不是图：Nai2API 直链回一张写着原因的 SVG，别的服务回 JSON 或网页。把原因挖出来给用户看。
async function describeNonImageReply(response, contentType) {
    let text = '';
    try { text = new TextDecoder().decode(await readLimitedBody(response.body, 64 * 1024, '生图服务回复')); } catch (_) { /* 读不到正文就只报类型 */ }
    let reason = '';
    try {
        const data = JSON.parse(text);
        reason = [data.error?.message, data.message, data.detail, data.error].find((item) => typeof item === 'string' && item) || '';
    } catch (_) {
        reason = (text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || text.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    }
    return reason ? `它说：${reason.slice(0, 200)}` : `回的是 ${contentType || '不明类型'}`;
}

async function readLimitedBody(body, maxBytes, label, emptyStatus = 400, expectedBytes = 0, timeoutMs = 0) {
    if (!body || typeof body.getReader !== 'function') {
        throw createHttpError(`${label}为空。`, emptyStatus);
    }
    const reader = body.getReader();
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    const expected = Number(expectedBytes);
    let capacity = Number.isFinite(expected) && expected > 0
        ? Math.min(maxBytes, Math.max(1, Math.floor(expected)))
        : Math.min(maxBytes, 64 * 1024);
    let bytes = new Uint8Array(capacity);
    let total = 0;
    try {
        while (true) {
            const next = await readStreamChunk(reader, deadline, label);
            if (next.done) break;
            const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
            const required = total + chunk.byteLength;
            if (required > maxBytes) {
                await reader.cancel();
                throw createHttpError(`${label}过大：${required}/${maxBytes}`, 413);
            }
            if (required > bytes.byteLength) {
                let nextCapacity = Math.max(1, bytes.byteLength);
                while (nextCapacity < required) nextCapacity = Math.min(maxBytes, nextCapacity * 2);
                const expanded = new Uint8Array(nextCapacity);
                expanded.set(bytes.subarray(0, total));
                bytes = expanded;
            }
            bytes.set(chunk, total);
            total = required;
        }
    } catch (error) {
        try {
            await reader.cancel(error);
        } catch {
            // The upstream stream may already be closed.
        }
        throw error;
    } finally {
        reader.releaseLock();
    }
    if (total === 0) throw createHttpError(`${label}为空。`, emptyStatus);
    return bytes.subarray(0, total);
}

function createLimitedBodyStream(body, maxBytes, label, emptyStatus = 400, timeoutMs = 0) {
    if (!body || typeof body.getReader !== 'function') {
        throw createHttpError(`${label}为空。`, emptyStatus);
    }
    const reader = body.getReader();
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
    let total = 0;
    let failure = null;
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        reader.releaseLock();
    };
    const stream = new ReadableStream({
        async pull(controller) {
            try {
                const next = await readStreamChunk(reader, deadline, label);
                if (next.done) {
                    if (total === 0) throw createHttpError(`${label}为空。`, emptyStatus);
                    release();
                    controller.close();
                    return;
                }
                const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
                const required = total + chunk.byteLength;
                if (required > maxBytes) {
                    throw createHttpError(`${label}过大：${required}/${maxBytes}`, 413);
                }
                total = required;
                controller.enqueue(chunk);
            } catch (error) {
                failure = error;
                try {
                    await reader.cancel(error);
                } catch {
                    // The upstream stream may already be closed.
                }
                release();
                controller.error(error);
            }
        },
        async cancel(reason) {
            try {
                await reader.cancel(reason);
            } finally {
                release();
            }
        }
    });
    return {
        stream,
        get bytes() { return total; },
        get error() { return failure; }
    };
}

async function handleImageRender(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST' && request.method !== 'PUT') {
        return error('Method not allowed.', 405);
    }
    if (request.url.length > IMAGE_MAX_REQUEST_URL_LENGTH) {
        return error('生图请求参数过长。', 414);
    }
    const url = new URL(request.url);
    const clientToken = getImageClientToken(request, url);
    const serverToken = normalizeImageParam(env?.IMAGE_GEN_TOKEN, 1000);
    const token = clientToken || serverToken;
    const params = buildImageParams(url, token);
    const candidates = await buildImageLookupCandidates(params, token, request.method !== 'POST');
    const primary = candidates[0];
    if (!primary) return error('缺少有效的角色名称。', 400);
    // 从魔改版迁移来的图：记录里存着它在 R2 的准确位置，按参数找不到时就用它（只用于显示，不用于生成）。
    const migrated = request.method === 'POST' ? null : parseImageObjectKey(url.searchParams.get('image_key'));
    if (migrated) candidates.push({ params, key: migrated.key, deletedKey: createImageDeletedKey(migrated.characterName, migrated.checksum) });
    const bucket = getBucket(env);

    // 墓碑和原图一起并行查，不再逐个等：有墓碑就回占位图（删掉的图不能再显示），否则按候选顺序取第一张存在的图。
    const [tombstones, objects] = await Promise.all([
        Promise.all(candidates.map((candidate) => bucket.get(candidate.deletedKey))),
        Promise.all(candidates.map((candidate) => bucket.get(candidate.key)))
    ]);
    const deletedAt = tombstones.findIndex(Boolean);
    const hitAt = deletedAt >= 0 ? -1 : objects.findIndex(Boolean);
    await Promise.all([...tombstones, ...objects.filter((object, index) => index !== hitAt)].map(discardBody));
    if (deletedAt >= 0) {
        const candidate = candidates[deletedAt];
        return imageResponse(request.method === 'HEAD' ? null : deletedImagePlaceholder(candidate.params.character_name), 'image/svg+xml; charset=utf-8', {
            'cache-control': 'private, no-store',
            'content-security-policy': "default-src 'none'; sandbox",
            'x-rp-image-cache': 'DELETED',
            'x-rp-image-key': imageHeaderValue(candidate.key)
        });
    }
    if (hitAt >= 0) {
        const candidate = candidates[hitAt];
        const cached = objects[hitAt];
        const contentType = normalizeRasterContentType(cached.httpMetadata?.contentType);
        if (!contentType) return error('缓存图片格式不受支持。', 415);
        // 存好的图不会再变（重新生成会换 seed，地址就不同）：让浏览器留一份，每次显示前只带 ETag 问一句“变了没”，
        // 没变回 304 不传正文；删掉的图在上面已经回了占位图。
        const headers = {
            'cache-control': 'private, no-cache',
            etag: cached.httpEtag,
            'x-rp-image-cache': 'HIT',
            'x-rp-image-key': imageHeaderValue(candidate.key)
        };
        if (cached.httpEtag && request.headers.get('if-none-match') === cached.httpEtag) {
            await discardBody(cached);
            return new Response(null, { status: 304, headers });
        }
        if (request.method === 'HEAD') await discardBody(cached);
        return imageResponse(request.method === 'HEAD' ? null : cached.body, contentType, {
            'content-length': String(cached.size || 0),
            ...headers
        });
    }

    if (request.method === 'PUT') return storeUploadedImage(request, env, bucket, primary);
    if (request.method !== 'POST') {
        return new Response(null, {
            status: 404,
            headers: {
                'cache-control': 'no-store',
                'x-rp-image-cache': 'MISS',
                'x-rp-image-key': imageHeaderValue(primary.key),
                'x-rp-image-generate-method': 'POST'
            }
        });
    }

    if (!token) return error('缺少生图密钥。', 401);
    if (!clientToken && !getSyncPassword(env)) return error('使用 Worker 生图密钥时必须配置 RP_SYNC_PASSWORD。', 503);
    // 配了同步密码就一律要带（和上传接口一样）：不然谁拿个生图密钥都能往这个站的 R2 里写图、把站主最旧的图挤掉。
    if (getSyncPassword(env) && !await isRequestAuthorized(request, env)) {
        return error('Sync password required.', 401, { authRequired: true });
    }
    assertImageTokenProvider(primary.params, token);

    const upstreamResponse = await fetchImageWithTimeout(buildImageUpstreamUrl(primary.params, token, env));
    if (!upstreamResponse.ok) {
        await discardBody(upstreamResponse);
        return error(`生图服务返回异常：HTTP ${upstreamResponse.status}`, upstreamResponse.status);
    }
    const contentType = (upstreamResponse.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!IMAGE_RASTER_CONTENT_TYPES.has(contentType)) return error(`生图服务没有返回图片，${await describeNonImageReply(upstreamResponse, contentType)}`, 502);
    const contentLength = Number(upstreamResponse.headers.get('content-length') || 0);
    if (contentLength > IMAGE_MAX_BYTES) return error(`图片过大：${contentLength}/${IMAGE_MAX_BYTES}`, 413);
    const imageBytes = await readLimitedBody(
        upstreamResponse.body,
        IMAGE_MAX_BYTES,
        '图片',
        502,
        contentLength,
        IMAGE_FETCH_TIMEOUT_MS
    );
    await bucket.put(primary.key, imageBytes, {
        httpMetadata: { contentType },
        customMetadata: {
            checksum: primary.checksum,
            characterName: primary.params.character_name,
            provider: getImageProviderName(primary.params.provider, token),
            createdAt: String(Date.now())
        }
    });
    return imageResponse(imageBytes, contentType, {
        'content-length': String(imageBytes.byteLength),
        'x-rp-image-cache': 'MISS',
        'x-rp-image-key': imageHeaderValue(primary.key)
    });
}

// 生图插件在浏览器里生成好图片后上传到这里；存放位置由参数算出（和直链生图同一个位置），插件不能指定。
async function storeUploadedImage(request, env, bucket, primary) {
    if (getSyncPassword(env) && !await isRequestAuthorized(request, env)) {
        return error('Sync password required.', 401, { authRequired: true });
    }
    const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!IMAGE_RASTER_CONTENT_TYPES.has(contentType)) return error('只接受 PNG、JPEG、WebP、AVIF 或 GIF 图片。', 415);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > IMAGE_MAX_BYTES) return error(`图片过大：${contentLength}/${IMAGE_MAX_BYTES}`, 413);
    const imageBytes = await readLimitedBody(request.body, IMAGE_MAX_BYTES, '图片', 413, contentLength, IMAGE_FETCH_TIMEOUT_MS);
    if (!imageBytes.byteLength) return error('图片为空。', 400);
    await bucket.put(primary.key, imageBytes, {
        httpMetadata: { contentType },
        customMetadata: {
            checksum: primary.checksum,
            characterName: primary.params.character_name,
            provider: 'plugin',
            createdAt: String(Date.now())
        }
    });
    return imageResponse(imageBytes, contentType, {
        'content-length': String(imageBytes.byteLength),
        'x-rp-image-cache': 'MISS',
        'x-rp-image-key': imageHeaderValue(primary.key)
    });
}

async function readThumbnailBytes(request) {
    const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'image/webp') throw createHttpError('缩略图格式必须是 WebP。', 415);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > IMAGE_THUMB_MAX_BYTES) {
        throw createHttpError(`缩略图过大：${contentLength}/${IMAGE_THUMB_MAX_BYTES}`, 413);
    }
    return readLimitedBody(
        request.body,
        IMAGE_THUMB_MAX_BYTES,
        '缩略图',
        413,
        contentLength,
        IMAGE_THUMB_READ_TIMEOUT_MS
    );
}

async function putImageThumbnail(bucket, imageKey, bytes) {
    const parsed = parseImageObjectKey(imageKey);
    if (!parsed) throw new Error('图片路径无效。');
    const thumbKey = createImageThumbKey(parsed.characterName, parsed.checksum);
    await bucket.put(thumbKey, bytes, {
        httpMetadata: { contentType: 'image/webp' },
        customMetadata: {
            imageKey,
            checksum: parsed.checksum,
            characterName: parsed.characterName,
            createdAt: String(Date.now())
        }
    });
    return thumbKey;
}

async function handleImageThumbUpload(request, env) {
    if (request.method !== 'PUT' && request.method !== 'POST') return error('Method not allowed.', 405);
    if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });
    const url = new URL(request.url);
    const token = getImageRequestToken(request, url, env);
    const params = buildImageParams(url, token);
    const candidates = await buildImageLookupCandidates(params, token, true);
    const bucket = getBucket(env);
    let imageKey = '';
    let thumbKey = '';
    for (const candidate of candidates) {
        if (await bucket.head(candidate.key)) {
            imageKey = candidate.key;
            thumbKey = createImageThumbKey(candidate.params.character_name, candidate.checksum);
            break;
        }
    }
    if (!imageKey) return error('原图不存在，不能保存缩略图。', 404);
    if (await bucket.head(thumbKey)) return json({ ok: true, existed: true, key: thumbKey });
    const bytes = await readThumbnailBytes(request);
    await putImageThumbnail(bucket, imageKey, bytes);
    return json({ ok: true, key: thumbKey, bytes: bytes.byteLength });
}

