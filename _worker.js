import {
    patchRpHubAppJs,
    RpHubAppPatchError,
    RP_HUB_APP_PATCH_REVISION
} from './DB/app-patches.mjs';

// 测试版版本号，打包时由 scripts/package.mjs --version 写入；本地源码保持 dev。
const RPH_RELEASE_VERSION = 'dev';
const DATASET_ID = 'main';
const R2_BINDING = 'RP_SYNC_R2';
const SYNC_PASSWORD_ENV = 'RP_SYNC_PASSWORD';
const SYNC_PASSWORD_HEADER = 'x-rp-sync-password';
const API_PATH = '/api/rp-sync';
const R2_PREFIX = `rp-sync/${DATASET_ID}`;
const MANIFEST_KEY = `${R2_PREFIX}/manifest.json`;
const CHUNK_PREFIX = `${R2_PREFIX}/chunks`;
const MANIFEST_HISTORY_PREFIX = `${R2_PREFIX}/manifest-history`;
const APP_UPDATE_PREFIX = 'rp-app-update';
const APP_UPDATE_MANIFEST_KEY = `${APP_UPDATE_PREFIX}/manifest.json`;
const APP_RELEASE_CACHE_KEY = `${APP_UPDATE_PREFIX}/release-cache.json`;
const APP_RELEASE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const APP_RELEASE_VERSION_LIMIT = 12;
const UPSTREAM_REPO = 'STA1N156/RP-Hub';
const UPSTREAM_BRANCH = 'main';
const CURRENT_UPSTREAM_VERSION = '1.9.8';
const CURRENT_UPSTREAM_SHA = '53a8d80951e594e717b8081873b2f77eb809d0fc';
const APP_UPDATE_DOWNLOAD_TIMEOUT_MS = 20000;
const APP_UPDATE_MIRROR_ENV = 'APP_UPDATE_MIRROR_BASE';
const DEFAULT_APP_UPDATE_MIRROR_BASE = 'https://update.rph.mornye.uk';
const APP_UPDATE_DOWNLOAD_PROXY_ENV = 'APP_UPDATE_DOWNLOAD_PROXIES';
const MAX_APP_UPDATE_EXTERNAL_REQUESTS = 50;
const MAX_APP_UPDATE_REDIRECTS = 5;
const DEFAULT_APP_UPDATE_DOWNLOAD_PROXIES = [
    'https://ghfast.top/',
    'https://gh.llkk.cc/',
    'https://ghproxy.net/',
    'https://ghproxy.cc/'
];
const PRESERVED_APP_UPDATE_ROOTS = new Set([
    'DB',
    '_worker.js',
    'work.js',
    'wrangler.toml',
    'update-upstream.bat',
    '.git',
    '.github'
]);
const REQUIRED_UPSTREAM_FILES = new Set([
    'index.html',
    'assets/css/styles.css',
    'assets/js/app.js'
]);
const MAX_APP_UPDATE_FILES = 32;
const MAX_APP_UPDATE_TOTAL_BYTES = 160 * 1024 * 1024;
const MAX_APP_UPDATE_FILE_BYTES = 32 * 1024 * 1024;
const APP_UPDATE_FILE_CONCURRENCY = 4;
const MAX_PART_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_CHUNK_COUNT = 10000;
const MAX_PULL_CHUNKS = 8;
const MANIFEST_HISTORY_KEEP = 5;
const CHUNK_GC_GRACE_MS = 24 * 60 * 60 * 1000;
const CHUNK_GC_MAX_DELETE = 100;
const STREAM_SNAPSHOT_FORMAT = 'rp-sync-jsonl-v1';
const STREAM_SNAPSHOT_SCHEMA_VERSION = 4;
const LEGACY_SNAPSHOT_FORMAT = 'rp-sync-json-v3';

const IMAGE_ADMIN_AUTH_COOKIE = 'rp_image_admin_auth';
const IMAGE_API_PATH = '/api/rp-image';
const IMAGE_THUMB_API_PATH = '/api/rp-image-thumb';
const IMAGE_TOKEN_HEADER = 'x-rp-image-token';
const IMAGE_ADMIN_PATH = '/image';
const IMAGE_PREFIX = 'rp-images';
const IMAGE_OBJECT_PREFIX = `${IMAGE_PREFIX}/characters`;
const IMAGE_THUMB_PREFIX = `${IMAGE_PREFIX}/thumbs`;
const IMAGE_DELETED_PREFIX = `${IMAGE_PREFIX}/_deleted`;
const IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const IMAGE_THUMB_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_MAX_REQUEST_URL_LENGTH = 32 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 120000;
const IMAGE_THUMB_READ_TIMEOUT_MS = 30000;
const IMAGE_DEFAULT_MODEL = 'nai-diffusion-4-5-full';
const IMAGE_DEFAULT_SIZE = '竖图';
const IMAGE_DEFAULT_STEPS = '40';
const IMAGE_DEFAULT_SCALE = '6';
const IMAGE_DEFAULT_CFG = '0';
const IMAGE_DEFAULT_SAMPLER = 'k_dpmpp_2m_sde';
const IMAGE_DEFAULT_NOISE_SCHEDULE = 'karras';
const IMAGE_PROVIDER_STD_ENV = 'IMAGE_PROVIDER_STD_URL';
const IMAGE_PROVIDER_STA1N_ENV = 'IMAGE_PROVIDER_STA1N_URL';
const IMAGE_RASTER_CONTENT_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/avif',
    'image/gif'
]);
const IMAGE_SIGNATURE_KEYS = [
    'provider',
    'tag',
    'model',
    'artist',
    'size',
    'steps',
    'scale',
    'cfg',
    'sampler',
    'negative',
    'nocache',
    'noise_schedule'
];
const IMAGE_NON_GENERATION_QUERY_KEYS = new Set([
    ...IMAGE_SIGNATURE_KEYS,
    'character_id',
    'character_uuid',
    'character_name',
    'provider',
    'requested_provider',
    'reroll_nonce',
    'token',
    '_rph_retry'
]);
const IMAGE_GENERATION_PARAM_NAME_PATTERN = /^[A-Za-z0-9_.~-]{1,80}$/;

function buildInjectedBootstrap(updateInfo = null, mirrorBase = '') {
    const safeInfo = updateInfo && typeof updateInfo === 'object'
        ? JSON.stringify(updateInfo).replace(/</g, '\\u003c')
        : 'null';
    // 分发端地址给模块管理的“工坊”用；分发端关闭时为空字符串。
    const safeMirrorBase = JSON.stringify(String(mirrorBase || '')).replace(/</g, '\\u003c');
return `
<script>window.RPH_R2_UPDATE_INFO=${safeInfo};window.RPH_R2_MIRROR_BASE=${safeMirrorBase};</script>
<link rel="stylesheet" href="/DB/styles.css?v=r2-rebuild-1">
<script src="/DB/ui-kit.js?v=r2-ui-1"></script>
<script src="/DB/nav-adapter.js?v=sync-195"></script>
<script src="/DB/char-store.js?v=r2-rebuild-1"></script>
<script src="/DB/bootstrap.js?v=r2-rebuild-1"></script>
<script src="/DB/image-module.js?v=r2-img-1"></script>
<script src="/DB/module-loader.js?v=r2-workshop-1"></script>
`;
}

const updateNoticeButtonRewriter = {
    element(element) {
        if (element.getAttribute('@click') !== 'closeUpdateModal') return;
        element.setAttribute('@click', 'updateCountdown = 0; closeUpdateModal()');
        element.removeAttribute(':disabled');
        element.removeAttribute(':class');
    }
};

// 1.9.x 起公告弹窗在 ui-components.js 里倒计时 10 秒才能关闭；返回该文件时去掉倒计时，公告可以直接跳过。
const UPDATE_NOTICE_SCRIPT_PATH = 'assets/js/ui-components.js';
const UPDATE_NOTICE_COUNTDOWN_PATTERN = /countdownEndsAt = Date\.now\(\) \+ [\d_]+;/;

async function skipUpdateNoticeCountdown(response) {
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    const text = (await response.text()).replace(UPDATE_NOTICE_COUNTDOWN_PATTERN, 'countdownEndsAt = Date.now();');
    return new Response(text, { status: response.status, headers });
}

// Upstream 1.8.4/1.8.5 phone-home switches: presence.js / update-check.js
// no-op when their meta is absent. The script files themselves must keep
// being served (ui-components hard-references their globals).
const remotePingMetaRewriter = {
    element(element) {
        element.remove();
    }
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store'
        }
    });
}

function error(message, status = 400, extra = {}) {
    return json({ ok: false, error: message, ...extra }, status);
}

function createHttpError(message, status) {
    const failure = new Error(message);
    failure.status = status;
    return failure;
}

function getErrorStatus(err, fallback = 500) {
    const status = Number(err?.status);
    return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}

function shouldInject(pathname) {
    return pathname === '/' || pathname === '/index.html';
}

function normalizeStaticPath(pathname) {
    if (pathname === '/') return 'index.html';
    const normalized = pathname.replace(/^\/+/, '');
    if (!normalized || normalized.includes('..') || normalized.startsWith('/')) return null;
    return normalized;
}

function getContentType(path) {
    if (path.endsWith('.html')) return 'text/html; charset=utf-8';
    if (path.endsWith('.css')) return 'text/css; charset=utf-8';
    if (path.endsWith('.js')) return 'application/javascript; charset=utf-8';
    if (path.endsWith('.json')) return 'application/json; charset=utf-8';
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
    if (path.endsWith('.webp')) return 'image/webp';
    if (path.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
    return 'application/octet-stream';
}

async function sha256Text(text) {
    return sha256Bytes(new TextEncoder().encode(text));
}

async function sha256Bytes(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getSyncPassword(env) {
    const password = env?.[SYNC_PASSWORD_ENV];
    return typeof password === 'string' && password.length > 0 ? password : '';
}

async function timingSafeTextEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const [leftHash, rightHash] = await Promise.all([sha256Text(left), sha256Text(right)]);
    return leftHash === rightHash;
}

async function isRequestAuthorized(request, env) {
    const expectedPassword = getSyncPassword(env);
    if (!expectedPassword) return true;
    const providedPassword = request.headers.get(SYNC_PASSWORD_HEADER) || '';
    if (!providedPassword) return false;
    return timingSafeTextEqual(providedPassword, expectedPassword);
}

async function handleAuthStatus(request, env) {
    const authRequired = Boolean(getSyncPassword(env));
    const authenticated = !authRequired || await isRequestAuthorized(request, env);
    return json({ ok: true, authRequired, authenticated });
}

function getBucket(env) {
    const bucket = env?.[R2_BINDING];
    if (
        bucket
        && typeof bucket.get === 'function'
        && typeof bucket.put === 'function'
        && typeof bucket.delete === 'function'
        && typeof bucket.list === 'function'
    ) {
        return bucket;
    }
    throw new Error('Missing R2 binding: RP_SYNC_R2');
}

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
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
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
    const bucket = getBucket(env);

    // Check all provider candidates for tombstones before checking any cache.
    for (const candidate of candidates) {
        const deleted = await bucket.get(candidate.deletedKey);
        if (deleted) {
            return imageResponse(request.method === 'HEAD' ? null : deletedImagePlaceholder(candidate.params.character_name), 'image/svg+xml; charset=utf-8', {
                'cache-control': 'private, no-store',
                'content-security-policy': "default-src 'none'; sandbox",
                'x-rp-image-cache': 'DELETED',
                'x-rp-image-key': imageHeaderValue(candidate.key)
            });
        }
    }

    for (const candidate of candidates) {
        const cached = await bucket.get(candidate.key);
        if (cached) {
            const contentType = normalizeRasterContentType(cached.httpMetadata?.contentType);
            if (!contentType) return error('缓存图片格式不受支持。', 415);
            return imageResponse(request.method === 'HEAD' ? null : cached.body, contentType, {
                'content-length': String(cached.size || 0),
                'x-rp-image-cache': 'HIT',
                'x-rp-image-key': imageHeaderValue(candidate.key)
            });
        }
    }

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
    if (!clientToken) {
        if (!getSyncPassword(env)) {
            return error('使用 Worker 生图密钥时必须配置 RP_SYNC_PASSWORD。', 503);
        }
        if (!await isRequestAuthorized(request, env)) {
            return error('Sync password required.', 401, { authRequired: true });
        }
    }
    assertImageTokenProvider(primary.params, token);

    const imageSettings = await readImageSettings(bucket);
    const upstreamResponse = imageSettings.mode === 'web'
        ? await fetchWebJobImage(primary.params, token, env, imageSettings.steps)
        : await fetchImageWithTimeout(buildImageUpstreamUrl(primary.params, token, env));
    if (!upstreamResponse.ok) {
        return error(`生图服务返回异常：HTTP ${upstreamResponse.status}`, upstreamResponse.status);
    }
    const contentType = (upstreamResponse.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!IMAGE_RASTER_CONTENT_TYPES.has(contentType)) return error('生图服务没有返回受支持的栅格图片。', 502);
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
    const stored = await bucket.get(primary.key);
    if (!stored) throw createHttpError('图片写入 R2 后无法读取。', 502);
    return imageResponse(stored.body, contentType, {
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
        if (await bucket.get(candidate.key)) {
            imageKey = candidate.key;
            thumbKey = createImageThumbKey(candidate.params.character_name, candidate.checksum);
            break;
        }
    }
    if (!imageKey) return error('原图不存在，不能保存缩略图。', 404);
    const existing = await bucket.get(thumbKey);
    if (existing) return json({ ok: true, existed: true, key: thumbKey });
    const bytes = await readThumbnailBytes(request);
    await putImageThumbnail(bucket, imageKey, bytes);
    return json({ ok: true, key: thumbKey, bytes: bytes.byteLength });
}

function readCookie(request, name) {
    const header = request.headers.get('cookie') || '';
    const prefix = `${name}=`;
    return header.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) || '';
}

async function imageAdminSessionToken(password) {
    return sha256Text(`rp-image-admin:${password}`);
}

function imageAdminSessionCookie(value) {
    return `${IMAGE_ADMIN_AUTH_COOKIE}=${value}; Path=/image; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`;
}

async function isImageAdminAuthorized(request, env) {
    const expectedPassword = getSyncPassword(env);
    if (!expectedPassword) return true;
    const providedPassword = request.headers.get(SYNC_PASSWORD_HEADER) || '';
    if (providedPassword && await timingSafeTextEqual(providedPassword, expectedPassword)) return true;
    const sessionToken = readCookie(request, IMAGE_ADMIN_AUTH_COOKIE);
    return Boolean(sessionToken) && await timingSafeTextEqual(sessionToken, await imageAdminSessionToken(expectedPassword));
}

function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Math.max(0, Number(bytes) || 0);
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

async function listImageThumbKeys(bucket) {
    const keys = new Set();
    let cursor;
    do {
        const page = await bucket.list({ prefix: `${IMAGE_THUMB_PREFIX}/`, cursor, limit: 1000 });
        for (const object of page.objects || []) keys.add(object.key);
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
}

async function listImageObjects(bucket) {
    const rawObjects = [];
    const thumbKeysPromise = listImageThumbKeys(bucket);
    let cursor;
    do {
        const page = await bucket.list({
            prefix: `${IMAGE_OBJECT_PREFIX}/`,
            cursor,
            limit: 1000,
            include: ['httpMetadata', 'customMetadata']
        });
        for (const object of page.objects || []) {
            const parsed = parseImageObjectKey(object.key);
            if (!parsed) continue;
            const thumbKey = createImageThumbKeyFromImageKey(object.key);
            rawObjects.push({
                ...parsed,
                thumbKey,
                hasThumb: false,
                size: Number(object.size || 0),
                uploaded: object.uploaded ? new Date(object.uploaded).toISOString() : '',
                contentType: object.httpMetadata?.contentType || 'image/png',
                characterName: object.customMetadata?.characterName || parsed.characterName
            });
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const thumbKeys = await thumbKeysPromise;
    return rawObjects.map((object) => ({
        ...object,
        hasThumb: object.thumbKey ? thumbKeys.has(object.thumbKey) : false
    }));
}

function buildImageLibrary(objects) {
    const groups = new Map();
    for (const object of objects) {
        const groupId = object.groupId || object.characterName || '未命名角色';
        if (!groups.has(groupId)) {
            groups.set(groupId, {
                id: groupId,
                name: object.characterName || '未命名角色',
                count: 0,
                size: 0,
                sizeHuman: '0 B',
                images: []
            });
        }
        const group = groups.get(groupId);
        group.count += 1;
        group.size += object.size;
        group.sizeHuman = formatBytes(group.size);
        group.images.push({
            key: object.key,
            thumbKey: object.thumbKey,
            hasThumb: object.hasThumb,
            size: object.size,
            sizeHuman: formatBytes(object.size),
            uploaded: object.uploaded,
            contentType: object.contentType,
            characterName: object.characterName,
            groupId
        });
    }
    return Array.from(groups.values())
        .map((group) => ({
            ...group,
            images: group.images.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)))
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id));
}

async function writeImageTombstone(bucket, object, reason = 'manual-delete') {
    const parsed = parseImageObjectKey(object.key);
    if (!parsed) return;
    await bucket.put(
        createImageDeletedKey(parsed.characterName, parsed.checksum),
        JSON.stringify({
            key: object.key,
            characterName: object.characterName || parsed.characterName,
            deletedAt: new Date().toISOString(),
            reason
        }),
        { httpMetadata: { contentType: 'application/json; charset=utf-8' } }
    );
}

// ---- 测试版生图设置（存在 R2，不进 RPH 设置数据）与 R2 存储管理 ----
const IMAGE_SETTINGS_KEY = `${IMAGE_PREFIX}/_settings.json`;
const IMAGE_SETTINGS_DEFAULTS = Object.freeze({ mode: 'direct', steps: 28, storageLimitGb: 9 });
const R2_FREE_BYTES = 10 * 1024 ** 3;
// 免费版 Worker 每次请求最多向外发 50 个请求：1 次提交 + 最多 40 次查询 + 1 次取图。
const WEB_JOB_MAX_POLLS = 40;
const STORAGE_CLEANUP_BATCH = 300;

function normalizeImageSettings(value = {}) {
    const steps = Math.round(Number(value.steps));
    // 上限至少 0.1 GB：填 0 或太小的数会把所有图都列进清理计划，按无效处理。
    const limit = Math.round(Number(value.storageLimitGb) * 10) / 10;
    return {
        mode: value.mode === 'web' ? 'web' : 'direct',
        steps: Number.isFinite(steps) ? Math.min(50, Math.max(1, steps)) : IMAGE_SETTINGS_DEFAULTS.steps,
        storageLimitGb: Number.isFinite(limit) && limit >= 0.1 ? Math.min(1024, limit) : IMAGE_SETTINGS_DEFAULTS.storageLimitGb
    };
}

async function readImageSettings(bucket) {
    const object = await bucket.get(IMAGE_SETTINGS_KEY);
    if (!object) return { ...IMAGE_SETTINGS_DEFAULTS };
    try {
        return normalizeImageSettings(JSON.parse(await object.text()));
    } catch (_) {
        return { ...IMAGE_SETTINGS_DEFAULTS };
    }
}

async function writeImageSettings(bucket, value) {
    const settings = normalizeImageSettings(value);
    await bucket.put(IMAGE_SETTINGS_KEY, JSON.stringify(settings), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
    return settings;
}

const STORAGE_CATEGORIES = [
    [`${IMAGE_OBJECT_PREFIX}/`, 'images', '生成的图片'],
    [`${IMAGE_THUMB_PREFIX}/`, 'thumbs', '缩略图'],
    [`${IMAGE_PREFIX}/`, 'imageMeta', '生图记录'],
    ['rp-sync/', 'sync', '云同步数据'],
    [`${APP_UPDATE_PREFIX}/`, 'appUpdate', '在线更新的页面']
];

// 统计整个存储桶；清理计划从最旧的图开始，连同缩略图一起算，直到总量回到上限以下。
async function buildStorageReport(bucket) {
    const categories = new Map(STORAGE_CATEGORIES.map(([, id, label]) => [id, { id, label, bytes: 0, count: 0 }]));
    categories.set('other', { id: 'other', label: '其他', bytes: 0, count: 0 });
    const images = [];
    const thumbSizes = new Map();
    let totalBytes = 0;
    let cursor;
    do {
        const page = await bucket.list({ cursor, limit: 1000 });
        for (const object of page.objects || []) {
            const size = Number(object.size || 0);
            totalBytes += size;
            const id = STORAGE_CATEGORIES.find(([prefix]) => object.key.startsWith(prefix))?.[1] || 'other';
            const category = categories.get(id);
            category.bytes += size;
            category.count += 1;
            if (id === 'images' && parseImageObjectKey(object.key)) {
                images.push({ key: object.key, size, uploaded: object.uploaded ? new Date(object.uploaded).getTime() : 0 });
            } else if (id === 'thumbs') {
                thumbSizes.set(object.key, size);
            }
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const settings = await readImageSettings(bucket);
    const limitBytes = settings.storageLimitGb * 1024 ** 3;
    const keys = [];
    let freed = 0;
    for (const image of images.sort((a, b) => a.uploaded - b.uploaded)) {
        if (totalBytes - freed <= limitBytes) break;
        keys.push(image.key);
        freed += image.size + (thumbSizes.get(createImageThumbKeyFromImageKey(image.key)) || 0);
    }
    return {
        ok: true,
        totalBytes,
        totalHuman: formatBytes(totalBytes),
        freeBytes: R2_FREE_BYTES,
        limitBytes,
        limitHuman: formatBytes(limitBytes),
        over: totalBytes > limitBytes,
        categories: [...categories.values()].map((item) => ({ ...item, human: formatBytes(item.bytes) })),
        cleanup: { keys, count: keys.length, bytes: freed, human: formatBytes(freed), enough: totalBytes - freed <= limitBytes }
    };
}

// 按清理计划删除一批最旧的图（写删除记录，聊天里显示“已删除”而不是重新生成）；剩下的由前端继续调用。
async function runStorageCleanup(bucket) {
    const report = await buildStorageReport(bucket);
    const batch = new Set(report.cleanup.keys.slice(0, STORAGE_CLEANUP_BATCH));
    const objects = (await listImageObjects(bucket)).filter((object) => batch.has(object.key));
    let deletedBytes = 0;
    for (const object of objects) {
        await writeImageTombstone(bucket, object, 'storage-cleanup');
        deletedBytes += object.size;
    }
    const keys = objects.flatMap((object) => object.thumbKey ? [object.key, object.thumbKey] : [object.key]);
    for (let index = 0; index < keys.length; index += 1000) await bucket.delete(keys.slice(index, index + 1000));
    return {
        ok: true,
        deletedCount: objects.length,
        deletedHuman: formatBytes(deletedBytes),
        remaining: Math.max(0, report.cleanup.count - objects.length)
    };
}

// 网页任务接口（Nai2API 的 POST /api/web/jobs）：支持 1–50 步；超过 28 步按官方价格计费。
async function fetchWebJobImage(params, token, env, steps) {
    if (!params.tag) throw createHttpError('缺少生图提示词。', 400);
    const base = getImageProviderOverride(params, env) || getImageProviderBase(params.provider, token);
    const auth = { authorization: `Bearer ${token}`, 'user-agent': 'RPH-R2-Image-Cache' };
    const body = {
        tag: params.tag, model: params.model, artist: params.artist || '', size: params.size, steps,
        scale: params.scale, cfg: params.cfg, sampler: params.sampler, negative: params.negative || '',
        nocache: params.nocache, noise_schedule: params.noise_schedule
    };
    if (params.reroll_nonce) body.reroll_nonce = params.reroll_nonce;
    for (const [key, value] of params.extra_params || []) body[key] = value;
    const readJob = async (response) => {
        const value = await response.json().catch(() => null);
        if (!response.ok || !value?.id) {
            const status = response.status === 404 ? 502 : response.status || 502;
            const reason = response.status === 404 ? '该生图服务不支持网页任务接口' : (value?.error || value?.message || `HTTP ${response.status}`);
            throw createHttpError(`网页任务失败：${reason}`, status);
        }
        return value;
    };
    let job = await readJob(await fetch(new URL('/api/web/jobs', base), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body)
    }));
    for (let poll = 0; job.status !== 'done' && poll < WEB_JOB_MAX_POLLS; poll += 1) {
        if (job.status === 'failed') throw createHttpError(`网页任务失败：${job.error || '生成失败'}`, 502);
        await new Promise((resolve) => setTimeout(resolve, poll < 10 ? 3000 : 6000));
        job = await readJob(await fetch(new URL(`/api/jobs/${encodeURIComponent(job.id)}`, base), { headers: auth }));
    }
    if (job.status !== 'done') throw createHttpError('网页任务等待超时，请稍后重试。', 504);
    return fetch(new URL(`/api/jobs/${encodeURIComponent(job.id)}/content`, base), {
        headers: { ...auth, accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' }
    });
}

function imageAdminHtml() {
    return new Response(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>角色图片管理</title>
<style>
:root{color-scheme:light;--bg:#f7f8fa;--surface:#fff;--raised:#eef0f4;--hover:#f1f3f7;--line:#e4e7ec;--text:#1a1d23;--muted:#7a8191;--accent:#3b6cf6;--accent-soft:#e8eefe;--danger:#e04646;--danger-soft:#fdecec}
:root[data-theme=dark]{color-scheme:dark;--bg:#16171b;--surface:#1e1f24;--raised:#2a2b31;--hover:#26272d;--line:#31323a;--text:#e5e6ea;--muted:#8e92a0;--accent:#7f9cff;--accent-soft:#283157;--danger:#f07070;--danger-soft:#3b2326}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;font:13px/1.45 Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:var(--bg);color:var(--text)}
button,input,a{font:inherit;color:inherit}.hidden{display:none!important}svg{width:15px;height:15px;flex:none;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;padding:0 11px;border:1px solid var(--line);border-radius:8px;background:var(--surface);font-weight:600;cursor:pointer;text-decoration:none;white-space:nowrap;transition:background .15s,border-color .15s,transform .1s}.btn:hover{background:var(--hover)}.btn:active{transform:scale(.97)}.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}.btn.icon{width:32px;padding:0}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}.btn.danger{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 35%,var(--line))}.btn.danger:hover{background:var(--danger-soft)}.btn.danger-fill{background:var(--danger);border-color:var(--danger);color:#fff}.btn.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
.sub{color:var(--muted);font-size:11px}
.auth{min-height:100%;display:grid;place-items:center;padding:20px}.card{width:min(360px,100%);padding:26px;background:var(--surface);border:1px solid var(--line);border-radius:14px}.card h2{margin:0 0 4px;font-size:18px}.card input{width:100%;height:40px;margin:18px 0 12px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--raised)}.card .btn{width:100%;height:40px}.msg{min-height:20px;margin-top:10px;color:var(--danger)}
#app{height:100%;display:grid;grid-template-columns:240px minmax(0,1fr)}
.side{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line);background:var(--surface)}.side-head{padding:14px 12px 10px}.side-head h1{margin:0;font-size:15px}.search{position:relative;display:block;margin-top:10px}.search svg{position:absolute;left:10px;top:50%;margin-top:-7.5px;color:var(--muted)}.search input{width:100%;height:33px;padding:0 10px 0 31px;border:1px solid var(--line);border-radius:8px;background:var(--raised)}.search input:focus,.card input:focus{outline:none;border-color:var(--accent)}
.char-list{flex:1;min-height:0;overflow:auto;padding:2px 8px 10px}.char{display:flex;align-items:center;gap:9px;width:100%;height:36px;margin-bottom:2px;padding:0 8px;border:0;border-radius:8px;background:none;text-align:left;cursor:pointer}.char:hover{background:var(--hover)}.char.active{background:var(--accent-soft);color:var(--accent)}
.avatar{flex:none;width:22px;height:22px;border-radius:50%;background:var(--raised);display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--muted);overflow:hidden}.avatar img{width:100%;height:100%;object-fit:cover}.char.active .avatar{background:var(--accent);color:#fff}.char-name{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.char-count{color:var(--muted);font-size:11px}
.main{min-width:0;min-height:0;display:flex;flex-direction:column}
.main-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--line);background:var(--surface)}.main-title{flex:1;min-width:0}.main-title h2{margin:0;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.actions{display:flex;gap:6px}
.scroll{flex:1;min-height:0;overflow:auto;padding:14px 18px 90px}
.notice{margin-bottom:12px;padding:8px 12px;border-radius:8px;background:var(--accent-soft);color:var(--text)}.notice:empty{display:none}.notice.error{background:var(--danger-soft);color:var(--danger)}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px}.photo{position:relative;padding:0;border:0;border-radius:10px;overflow:hidden;background:var(--raised);cursor:pointer;aspect-ratio:2/3;content-visibility:auto;contain-intrinsic-size:112px 168px}.photo img{width:100%;height:100%;object-fit:cover;display:block;transition:filter .2s}
.photo-size{position:absolute;left:7px;bottom:6px;font-size:10px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6)}.photo-owner{position:absolute;left:7px;top:6px;max-width:calc(100% - 14px);font-size:10px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blurred .photo img{filter:blur(18px) saturate(.6);opacity:.35}.blurred .photo::after{content:"";position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;background:var(--muted);-webkit-mask:var(--eye-off) center/contain no-repeat;mask:var(--eye-off) center/contain no-repeat}.blurred .photo-size,.blurred .photo-owner{color:var(--muted);text-shadow:none}
:root{--eye-off:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round'%3E%3Cpath d='M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22'/%3E%3C/svg%3E")}
.check{position:absolute;top:7px;right:7px;width:20px;height:20px;border-radius:50%;border:2px solid #fff;background:rgba(0,0,0,.25);box-shadow:0 1px 4px rgba(0,0,0,.3);display:none}.selecting .check{display:block}.photo.selected{box-shadow:0 0 0 3px var(--accent) inset}.photo.selected .check{background:var(--accent)}.photo.selected .check::after{content:"";position:absolute;left:5px;top:1px;width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.empty{padding:70px 20px;text-align:center;color:var(--muted)}
.storage{grid-column:1/-1;max-width:720px}.storage h3{margin:18px 0 10px;font-size:13px}.meter{position:relative;height:12px;border-radius:999px;background:var(--raised);overflow:hidden}.meter-bar{height:100%;border-radius:inherit;background:var(--accent)}.meter-bar.over{background:var(--danger)}.meter-limit{position:absolute;top:0;bottom:0;width:3px;background:var(--text)}.meter-text{margin-top:8px;color:var(--muted)}.big{font-size:22px;font-weight:700;color:var(--text)}.cat{display:grid;grid-template-columns:110px minmax(0,1fr) 90px;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}.cat .meter{height:8px}.cat-size{text-align:right;color:var(--muted)}.cleanup{margin-top:18px;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.cleanup p{margin:0 0 10px}
.select-bar{position:fixed;left:calc(50% + 120px);bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:8px 8px 8px 16px;border:1px solid var(--line);border-radius:12px;background:var(--surface);box-shadow:0 10px 30px -12px rgba(0,0,0,.35);z-index:5;white-space:nowrap}
.viewer{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(10,10,14,.94)}.viewer img{max-width:calc(100vw - 140px);max-height:calc(100vh - 100px);object-fit:contain;border-radius:6px;user-select:none}.viewer-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;color:#ddd}.viewer-top .btn{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.14);color:#fff}.viewer-top .btn.danger{color:#ff9d9d}
.nav{position:absolute;top:50%;width:44px;height:44px;margin-top:-22px;border:0;border-radius:50%;background:rgba(255,255,255,.1);color:#fff;font-size:26px;cursor:pointer}.nav:hover{background:rgba(255,255,255,.2)}.nav:disabled{opacity:.2;cursor:default}.prev{left:14px}.next{right:14px}
.dialog{position:fixed;inset:0;z-index:30;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.4);backdrop-filter:blur(4px)}.dialog-box{width:min(360px,100%);padding:20px;border:1px solid var(--line);border-radius:14px;background:var(--surface);animation:pop .18s ease-out}.dialog-box h3{margin:0 0 8px;font-size:16px}.dialog-box p{margin:0 0 18px;color:var(--muted);line-height:1.6}.dialog-actions{display:flex;justify-content:flex-end;gap:8px}@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.97)}}
.mobile-only{display:none}
@media(max-width:720px){#app{grid-template-columns:minmax(0,1fr)}.side{border-right:0}.show-main .side{display:none}body:not(.show-main) .main{display:none}.mobile-only{display:inline-flex}.main-head{padding:10px 12px;flex-wrap:wrap}.actions{width:100%}.actions .btn{flex:1}.scroll{padding:10px 10px 90px}.gallery{grid-template-columns:repeat(3,1fr);gap:6px}.viewer img{max-width:100vw;max-height:calc(100vh - 110px);border-radius:0}.nav{display:none}.select-bar{left:10px;right:10px;bottom:10px;transform:none;justify-content:space-between}}
</style></head><body>
<section id="auth" class="auth hidden"><div class="card"><h2>角色图片管理</h2><div class="sub">输入云同步密码后进入。</div><input id="password" type="password" placeholder="同步密码" autocomplete="current-password"><button id="login" class="btn primary">进入</button><div id="authMsg" class="msg"></div></div></section>
<section id="app" class="hidden">
<aside class="side"><div class="side-head"><h1>角色图片管理</h1><div id="stats" class="sub">读取中…</div><label class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="filter" type="search" placeholder="搜索角色卡"></label></div><div id="characters" class="char-list"></div></aside>
<main class="main"><div class="main-head"><button id="back" class="btn icon mobile-only" type="button" aria-label="返回">‹</button><div class="main-title"><h2 id="groupTitle"></h2><div id="groupMeta" class="sub"></div></div><div class="actions">
<button id="refresh" class="btn icon" title="刷新"><svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg></button>
<button id="blurToggle" class="btn icon" title="隐藏图片"><svg viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22"/></svg></button>
<button id="exportZip" class="btn"><svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>导出</button>
<button id="selectMode" class="btn danger"><svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>删除</button>
</div></div><div id="scroll" class="scroll"><div id="notice" class="notice"></div><div id="gallery" class="gallery"></div><div id="sentinel"></div></div></main>
<div id="selectBar" class="select-bar hidden"><span id="selectCount">已选 0 张</span><button id="selectAll" class="btn">全选</button><button id="cancelSelect" class="btn">取消</button><button id="deleteSelected" class="btn danger-fill" disabled>删除</button></div>
</section>
<section id="viewer" class="viewer hidden"><div class="viewer-top"><span id="viewerInfo"></span><div class="actions"><a id="viewerDownload" class="btn" download>下载</a><button id="viewerDelete" class="btn danger">删除</button><button id="closeViewer" class="btn">关闭</button></div></div><button id="prev" class="nav prev" aria-label="上一张">‹</button><img id="viewerImage" alt=""><button id="next" class="nav next" aria-label="下一张">›</button></section>
<div id="dialog" class="dialog hidden"><div class="dialog-box" role="dialog" aria-modal="true"><h3 id="dialogTitle"></h3><p id="dialogText"></p><div class="dialog-actions"><button id="dialogCancel" class="btn">取消</button><button id="dialogOk" class="btn danger-fill">删除</button></div></div></div>
<script>
var passwordStorageKey='rp_hub_sync_password_v1',themeStorageKey='rphub-appearance',blurStorageKey='rph_image_admin_blur',ALL='__all__',STORAGE='__storage__',BATCH=60,EXPORT_WARN_BYTES=500*1024*1024;
function $(id){return document.getElementById(id);}
var passwordInput=$('password'),authBox=$('auth'),appBox=$('app'),authMsg=$('authMsg'),stats=$('stats'),notice=$('notice'),filter=$('filter'),characters=$('characters'),gallery=$('gallery'),groupTitle=$('groupTitle'),groupMeta=$('groupMeta'),selectBar=$('selectBar'),selectCount=$('selectCount'),deleteSelectedButton=$('deleteSelected'),viewer=$('viewer'),viewerImage=$('viewerImage'),viewerInfo=$('viewerInfo'),viewerDownload=$('viewerDownload'),blurToggle=$('blurToggle'),exportButton=$('exportZip');
var data=null,current=ALL,selecting=false,selected=new Set(),shown=0,viewIndex=-1,thumbQueue=[],thumbBusy=0,exporting=false;
function esc(s){return String(s||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function stored(k){try{return localStorage.getItem(k)||'';}catch(e){return '';}}
function store(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function pass(){return stored(passwordStorageKey);}
function applyTheme(){document.documentElement.dataset.theme=stored(themeStorageKey)==='dark'?'dark':'light';}
function headers(){return {'x-rp-sync-password':pass(),'content-type':'application/json'};}
async function api(path,options){var res=await fetch(path,Object.assign({},options||{},{headers:Object.assign(headers(),(options&&options.headers)||{})})),body=await res.json().catch(function(){return {ok:false,error:'响应异常'};});if(!res.ok||body.ok===false)throw new Error(body.error||('HTTP '+res.status));return body;}
function imgUrl(k){return '/image/api/image?key='+encodeURIComponent(k);}
function thumbUrl(k){return '/image/api/thumb?key='+encodeURIComponent(k);}
function fmt(bytes){var u=['B','KB','MB','GB'],v=Math.max(0,Number(bytes)||0),i=0;while(v>=1024&&i<u.length-1){v/=1024;i++;}return v.toFixed(i?2:0)+' '+u[i];}
function day(s){return s?String(s).slice(0,16).replace('T',' '):'';}
function sum(list){var n=0;list.forEach(function(img){n+=img.size||0;});return n;}
function setNotice(s,b){notice.textContent=s||'';notice.classList.toggle('error',Boolean(b));}
function groups(){return (data&&data.characters)||[];}
function allImages(){var list=[];groups().forEach(function(g){g.images.forEach(function(img){list.push(img);});});return list.sort(function(a,b){return String(b.uploaded).localeCompare(String(a.uploaded));});}
var cachedAll=null;
function images(){if(current===STORAGE)return [];if(current===ALL)return cachedAll||(cachedAll=allImages());var list=groups();for(var i=0;i<list.length;i++)if(list[i].id===current)return list[i].images;return [];}
function viewName(){if(current===STORAGE)return '存储空间';if(current===ALL)return '全部图片';var g=groups().filter(function(x){return x.id===current;})[0];return g?g.name:'';}
function renderStats(){var all=allImages();stats.textContent=all.length+' 张图片 / '+fmt(sum(all));}
function renderCharacters(){var q=filter.value.trim().toLowerCase(),list=groups().filter(function(g){return !q||String(g.name||'').toLowerCase().indexOf(q)>=0;});var html='<button class="char'+(current===ALL?' active':'')+'" data-group="'+ALL+'"><span class="avatar"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></span><span class="char-name">全部图片</span><span class="char-count">'+allImages().length+'</span></button><button class="char'+(current===STORAGE?' active':'')+'" data-group="'+STORAGE+'"><span class="avatar"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg></span><span class="char-name">存储空间</span><span class="char-count"></span></button>';html+=list.map(function(g){return '<button class="char'+(g.id===current?' active':'')+'" data-group="'+esc(g.id)+'" title="'+esc(g.name)+'"><span class="avatar">'+esc(String(g.name||'?').replace(/^[“"'「『【[(（]+/,'').slice(0,1)||'?')+'</span><span class="char-name">'+esc(g.name)+'</span><span class="char-count">'+g.images.length+'</span></button>';}).join('');if(q&&!list.length)html+='<div class="empty">没有匹配的角色</div>';characters.innerHTML=html;}
function renderHead(){var list=images(),storage=current===STORAGE;groupTitle.textContent=viewName();groupMeta.textContent=storage?'R2 存储桶用量与清理':list.length+' 张 · '+fmt(sum(list));[blurToggle,exportButton,$('selectMode')].forEach(function(b){b.classList.toggle('hidden',storage);});exportButton.disabled=!list.length||exporting;$('selectMode').disabled=!list.length;}
function tile(img,index){return '<button class="photo'+(selected.has(img.key)?' selected':'')+'" data-index="'+index+'"><img loading="lazy" decoding="async" src="'+esc(img.hasThumb?thumbUrl(img.key):imgUrl(img.key))+'" alt=""'+(img.hasThumb?'':' data-needs-thumb="1"')+'>'+(current===ALL?'<span class="photo-owner">'+esc(img.characterName)+'</span>':'')+'<span class="photo-size">'+esc(img.sizeHuman)+'</span><span class="check"></span></button>';}
function appendBatch(){var list=images();if(shown>=list.length)return;var html='',end=Math.min(list.length,shown+BATCH);for(var i=shown;i<end;i++)html+=tile(list[i],i);shown=end;gallery.insertAdjacentHTML('beforeend',html);}
function renderGallery(){shown=0;gallery.innerHTML='';renderHead();if(current===STORAGE){renderStorage();return;}if(!images().length){gallery.innerHTML='<div class="empty">'+(groups().length?'这里没有图片':'还没有图片')+'</div>';return;}appendBatch();}
function selectGroup(id){current=id;setSelecting(false);document.body.classList.add('show-main');renderCharacters();renderGallery();$('scroll').scrollTop=0;}
function syncSelectBar(){$('selectMode').classList.toggle('on',selecting);selectBar.classList.toggle('hidden',!selecting);selectCount.textContent='已选 '+selected.size+' 张';deleteSelectedButton.disabled=!selected.size;gallery.classList.toggle('selecting',selecting);}
function setSelecting(on){selecting=on;selected.clear();gallery.querySelectorAll('.photo.selected').forEach(function(n){n.classList.remove('selected');});syncSelectBar();}
function applyBlur(){var on=stored(blurStorageKey)==='1';gallery.classList.toggle('blurred',on);blurToggle.classList.toggle('on',on);blurToggle.title=on?'显示图片':'隐藏图片';}
function ask(title,text,ok,danger){return new Promise(function(resolve){$('dialogTitle').textContent=title;$('dialogText').textContent=text;$('dialogOk').textContent=ok||'删除';$('dialogOk').className='btn '+(danger===false?'primary':'danger-fill');$('dialog').classList.remove('hidden');function done(v){$('dialog').classList.add('hidden');$('dialogOk').onclick=null;$('dialogCancel').onclick=null;resolve(v);}$('dialogOk').onclick=function(){done(true);};$('dialogCancel').onclick=function(){done(false);};$('dialogOk').focus();});}
function forget(keys){var keySet=new Set(keys);data.characters=groups().map(function(g){g.images=g.images.filter(function(img){return !keySet.has(img.key);});return g;}).filter(function(g){return g.images.length;});cachedAll=null;if(current!==ALL&&!groups().some(function(g){return g.id===current;}))current=ALL;}
async function remove(keys,title,text){if(!keys.length||!await ask(title,text))return false;try{var r=await api('/image/api/delete',{method:'POST',body:JSON.stringify({keys:keys})});forget(keys);selected.clear();renderStats();renderCharacters();renderGallery();syncSelectBar();setNotice('已删除 '+r.deletedCount+' 张，释放 '+r.deletedHuman+'。');return true;}catch(e){setNotice(e.message,true);return false;}}
function openViewer(index){var list=images(),img=list[index];if(!img)return;viewIndex=index;viewerImage.src=imgUrl(img.key);viewerDownload.href=imgUrl(img.key);viewerDownload.setAttribute('download',fileName(img,index));viewerInfo.textContent=(index+1)+' / '+list.length+' · '+(current===ALL?img.characterName+' · ':'')+img.sizeHuman+(img.uploaded?' · '+day(img.uploaded):'');$('prev').disabled=index===0;$('next').disabled=index===list.length-1;viewer.classList.remove('hidden');}
function closeViewer(){viewer.classList.add('hidden');viewerImage.removeAttribute('src');viewIndex=-1;}
function step(delta){var next=viewIndex+delta;if(viewIndex>=0&&next>=0&&next<images().length)openViewer(next);}
function queueThumb(node){thumbQueue.push(node);pumpThumbs();}
function pumpThumbs(){while(thumbBusy<2&&thumbQueue.length){var node=thumbQueue.shift();thumbBusy++;makeThumb(node).catch(function(){}).then(function(){thumbBusy--;pumpThumbs();});}}
async function makeThumb(node){var tileNode=node.closest('.photo'),img=tileNode&&images()[Number(tileNode.dataset.index)];if(!img||img.hasThumb||!node.naturalWidth)return;var ratio=Math.min(1,360/Math.max(node.naturalWidth,node.naturalHeight)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(node.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(node.naturalHeight*ratio));canvas.getContext('2d').drawImage(node,0,0,canvas.width,canvas.height);var blob=await new Promise(function(resolve){canvas.toBlob(resolve,'image/webp',0.8);});if(!blob||blob.type!=='image/webp')return;var res=await fetch(thumbUrl(img.key),{method:'PUT',headers:{'x-rp-sync-password':pass(),'content-type':'image/webp'},body:blob});if(res.ok)img.hasThumb=true;}
function fileName(img,index){var ext=(String(img.contentType||'').split('/')[1]||'png').replace('jpeg','jpg');return String(index+1).padStart(4,'0')+'-'+String(img.uploaded||'').slice(0,10)+'.'+ext;}
var crcTable=null;function crc32(bytes){if(!crcTable){crcTable=new Uint32Array(256);for(var n=0;n<256;n++){var c=n;for(var k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c>>>0;}}var crc=0xffffffff;for(var i=0;i<bytes.length;i++)crc=crcTable[(crc^bytes[i])&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function safePart(s){return String(s||'未命名').replace(/[<>:"|?*]/g,'_').replace(/[\\/]/g,'_').trim().slice(0,80)||'未命名';}
async function exportZip(){var list=images().slice();if(!list.length||exporting)return;var total=sum(list);if(total>EXPORT_WARN_BYTES&&!await ask('导出 '+fmt(total),'图片较多，打包会占用较多内存，手机上可能失败。建议按角色分别导出。仍要继续吗？','继续',false))return;exporting=true;renderHead();var parts=[],central=[],offset=0,enc=new TextEncoder(),now=new Date(),dosTime=(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1),dosDate=((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate(),counters={};try{for(var i=0;i<list.length;i++){var img=list[i];setNotice('正在打包 '+(i+1)+' / '+list.length+'…');var res=await fetch(imgUrl(img.key),{headers:{'x-rp-sync-password':pass()}});if(!res.ok)throw new Error('第 '+(i+1)+' 张下载失败：HTTP '+res.status);var bytes=new Uint8Array(await res.arrayBuffer()),folder=safePart(img.characterName);counters[folder]=(counters[folder]||0)+1;var name=enc.encode((current===ALL?folder+'/':'')+fileName(img,counters[folder]-1)),crc=crc32(bytes),head=new DataView(new ArrayBuffer(30));head.setUint32(0,0x04034b50,true);head.setUint16(4,20,true);head.setUint16(6,0x0800,true);head.setUint16(10,dosTime,true);head.setUint16(12,dosDate,true);head.setUint32(14,crc,true);head.setUint32(18,bytes.length,true);head.setUint32(22,bytes.length,true);head.setUint16(26,name.length,true);parts.push(head.buffer,name,bytes);var dir=new DataView(new ArrayBuffer(46));dir.setUint32(0,0x02014b50,true);dir.setUint16(4,20,true);dir.setUint16(6,20,true);dir.setUint16(8,0x0800,true);dir.setUint16(12,dosTime,true);dir.setUint16(14,dosDate,true);dir.setUint32(16,crc,true);dir.setUint32(20,bytes.length,true);dir.setUint32(24,bytes.length,true);dir.setUint16(28,name.length,true);dir.setUint32(42,offset,true);central.push(dir.buffer,name);offset+=30+name.length+bytes.length;}var size=0;central.forEach(function(p){size+=p.byteLength;});var end=new DataView(new ArrayBuffer(22));end.setUint32(0,0x06054b50,true);end.setUint16(8,list.length,true);end.setUint16(10,list.length,true);end.setUint32(12,size,true);end.setUint32(16,offset,true);var blob=new Blob(parts.concat(central,[end.buffer]),{type:'application/zip'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=safePart(viewName())+'.zip';document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(link.href);},60000);setNotice('已导出 '+list.length+' 张 · '+fmt(total)+'。');}catch(e){setNotice('导出失败：'+e.message,true);}finally{exporting=false;renderHead();}}
function bar(part,whole,cls){return '<div class="meter"><div class="meter-bar'+(cls?' '+cls:'')+'" style="width:'+Math.min(100,whole?part/whole*100:0).toFixed(2)+'%"></div></div>';}
async function renderStorage(){gallery.innerHTML='<div class="storage empty">正在统计存储桶…</div>';try{var r=await api('/image/api/storage');if(current!==STORAGE)return;var scale=Math.max(r.freeBytes,r.totalBytes),html='<div class="storage"><div class="big">'+esc(r.totalHuman)+'</div><div class="meter" style="margin-top:8px"><div class="meter-bar'+(r.over?' over':'')+'" style="width:'+Math.min(100,r.totalBytes/scale*100).toFixed(2)+'%"></div><div class="meter-limit" style="left:'+Math.min(100,r.limitBytes/scale*100).toFixed(2)+'%"></div></div><div class="meter-text">免费额度 '+fmt(r.freeBytes)+' · 清理上限 '+esc(r.limitHuman)+'（竖线）</div><h3>按类别</h3>';r.categories.filter(function(c){return c.bytes>0;}).sort(function(a,b){return b.bytes-a.bytes;}).forEach(function(c){html+='<div class="cat"><span>'+esc(c.label)+'</span>'+bar(c.bytes,r.totalBytes)+'<span class="cat-size">'+esc(c.human)+'</span></div>';});html+='<div class="cleanup">'+(r.over?'<p>已超出清理上限。从最早的图开始删除 <b>'+r.cleanup.count+'</b> 张，可腾出 <b>'+esc(r.cleanup.human)+'</b>'+(r.cleanup.enough?'。':'；只删图片仍降不到上限，其余是同步数据等其他内容。')+'</p><button id="runCleanup" class="btn danger-fill"'+(r.cleanup.count?'':' disabled')+'>立即清理</button>':'<p>未超出清理上限。</p>')+'<p class="sub" style="margin:10px 0 0">清理上限在 RPH「设置」→「测试版生图设置」里修改。删除的图在聊天里显示为「已删除」，不会重新生成。</p></div></div>';gallery.innerHTML=html;var run=$('runCleanup');if(run)run.onclick=function(){cleanupStorage(r.cleanup.count,r.cleanup.human);};}catch(e){gallery.innerHTML='<div class="storage empty">'+esc(e.message)+'</div>';}}
async function cleanupStorage(count,human){if(!await ask('清理旧图','将从最早的图开始删除 '+count+' 张，腾出 '+human+'。删除后不能恢复。','清理'))return;try{var done=0,res;for(var i=0;i<50;i++){setNotice('正在清理… 已删除 '+done+' 张');res=await api('/image/api/storage/cleanup',{method:'POST',body:'{}'});done+=res.deletedCount;if(!res.remaining||!res.deletedCount)break;}setNotice('已清理 '+done+' 张。');data=await api('/image/api/library');cachedAll=null;renderStats();renderCharacters();renderStorage();}catch(e){setNotice('清理失败：'+e.message,true);}}
async function load(){setNotice('');stats.textContent='读取中…';try{data=await api('/image/api/library');cachedAll=null;if(current!==ALL&&!groups().some(function(g){return g.id===current;}))current=ALL;renderStats();renderCharacters();renderGallery();syncSelectBar();}catch(e){stats.textContent='读取失败';setNotice(e.message,true);}}
function checkAuth(p){return api('/image/api/auth-status',{method:'GET',headers:{'x-rp-sync-password':p||pass()}}).then(function(r){return r.authenticated;}).catch(function(){return false;});}
function showApp(){authBox.classList.add('hidden');appBox.classList.remove('hidden');load();}
function enter(){var p=passwordInput.value;authMsg.textContent='';checkAuth(p).then(function(ok){if(!ok){authMsg.textContent='密码不正确';passwordInput.focus();return;}store(passwordStorageKey,p);showApp();});}
$('login').onclick=enter;passwordInput.onkeydown=function(e){if(e.key==='Enter')enter();};
$('refresh').onclick=load;filter.oninput=renderCharacters;exportButton.onclick=exportZip;
blurToggle.onclick=function(){store(blurStorageKey,stored(blurStorageKey)==='1'?'0':'1');applyBlur();};
$('back').onclick=function(){document.body.classList.remove('show-main');setSelecting(false);};
$('selectMode').onclick=function(){setSelecting(!selecting);};$('cancelSelect').onclick=function(){setSelecting(false);};
$('selectAll').onclick=function(){images().forEach(function(img){selected.add(img.key);});gallery.querySelectorAll('.photo').forEach(function(n){n.classList.add('selected');});syncSelectBar();};
deleteSelectedButton.onclick=function(){remove(Array.from(selected),'删除图片','确定删除选中的 '+selected.size+' 张图片吗？删除后不能恢复。').then(function(done){if(done)setSelecting(false);});};
characters.onclick=function(e){var item=e.target.closest('[data-group]');if(item)selectGroup(item.dataset.group);};
gallery.onclick=function(e){var node=e.target.closest('.photo');if(!node)return;var index=Number(node.dataset.index),img=images()[index];if(!img)return;if(selecting){if(selected.has(img.key))selected.delete(img.key);else selected.add(img.key);node.classList.toggle('selected');syncSelectBar();}else openViewer(index);};
gallery.addEventListener('load',function(e){if(e.target.dataset&&e.target.dataset.needsThumb){delete e.target.dataset.needsThumb;queueThumb(e.target);}},true);
$('viewerDelete').onclick=function(){var img=images()[viewIndex];if(!img)return;var at=viewIndex;remove([img.key],'删除图片','确定删除这张图片吗？删除后不能恢复。').then(function(done){if(!done)return;if(images().length)openViewer(Math.min(at,images().length-1));else closeViewer();});};
$('closeViewer').onclick=closeViewer;$('prev').onclick=function(){step(-1);};$('next').onclick=function(){step(1);};
viewer.onclick=function(e){if(e.target===viewer)closeViewer();};
var touchX=null;viewer.addEventListener('touchstart',function(e){touchX=e.touches[0].clientX;},{passive:true});viewer.addEventListener('touchend',function(e){if(touchX===null)return;var dx=e.changedTouches[0].clientX-touchX;touchX=null;if(Math.abs(dx)>50)step(dx<0?1:-1);});
document.addEventListener('keydown',function(e){if(!$('dialog').classList.contains('hidden')){if(e.key==='Escape')$('dialogCancel').click();return;}if(viewIndex<0)return;if(e.key==='Escape')closeViewer();else if(e.key==='ArrowLeft')step(-1);else if(e.key==='ArrowRight')step(1);});
if('IntersectionObserver' in window)new IntersectionObserver(function(entries){if(entries[0].isIntersecting)appendBatch();},{root:$('scroll'),rootMargin:'600px'}).observe($('sentinel'));
window.addEventListener('storage',function(e){if(e.key===themeStorageKey)applyTheme();});
applyTheme();applyBlur();passwordInput.value=pass();checkAuth().then(function(ok){if(ok)showApp();else authBox.classList.remove('hidden');});
    </script></body></html>`, { headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
        'x-content-type-options': 'nosniff'
    } });
}

async function handleImageAdmin(request, env, url) {
    if (url.pathname === IMAGE_ADMIN_PATH || url.pathname === `${IMAGE_ADMIN_PATH}/`) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return error('Method not allowed.', 405);
        const page = imageAdminHtml();
        return request.method === 'HEAD' ? new Response(null, { status: page.status, headers: page.headers }) : page;
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/auth-status`) {
        if (request.method !== 'GET') return error('Method not allowed.', 405);
        const authRequired = Boolean(getSyncPassword(env));
        const authenticated = !authRequired || await isImageAdminAuthorized(request, env);
        const headers = authRequired && authenticated
            ? { 'set-cookie': imageAdminSessionCookie(await imageAdminSessionToken(getSyncPassword(env))) }
            : {};
        return imageJson({ ok: true, authRequired, authenticated }, 200, headers);
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/library` && request.method !== 'GET') return error('Method not allowed.', 405);
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/image` && request.method !== 'GET' && request.method !== 'HEAD') {
        return error('Method not allowed.', 405);
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/thumb`
        && request.method !== 'GET' && request.method !== 'HEAD'
        && request.method !== 'PUT' && request.method !== 'POST') {
        return error('Method not allowed.', 405);
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/delete` && request.method !== 'POST') return error('Method not allowed.', 405);
    if (!await isImageAdminAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });
    const bucket = getBucket(env);
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/library`) {
        if (request.method !== 'GET') return error('Method not allowed.', 405);
        const objects = await listImageObjects(bucket);
        const totalBytes = objects.reduce((sum, object) => sum + object.size, 0);
        return json({ ok: true, totalCount: objects.length, totalBytes, totalHuman: formatBytes(totalBytes), characters: buildImageLibrary(objects) });
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/image`) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return error('Method not allowed.', 405);
        const key = url.searchParams.get('key') || '';
        if (!key.startsWith(`${IMAGE_OBJECT_PREFIX}/`) || key.includes('..') || !parseImageObjectKey(key)) return error('图片路径无效。', 400);
        const object = await bucket.get(key);
        if (!object) return error('图片不存在。', 404);
        const contentType = normalizeRasterContentType(object.httpMetadata?.contentType);
        if (!contentType) return error('图片格式不受支持。', 415);
        return imageResponse(request.method === 'HEAD' ? null : object.body, contentType, {
            'content-length': String(object.size || 0), 'cache-control': 'private, no-store'
        });
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/thumb`) {
        const key = url.searchParams.get('key') || '';
        if (!key.startsWith(`${IMAGE_OBJECT_PREFIX}/`) || key.includes('..') || !parseImageObjectKey(key)) return error('图片路径无效。', 400);
        const thumbKey = createImageThumbKeyFromImageKey(key);
        if (request.method === 'GET' || request.method === 'HEAD') {
            const object = await bucket.get(thumbKey);
            if (!object) return error('缩略图不存在。', 404);
            return imageResponse(request.method === 'HEAD' ? null : object.body, object.httpMetadata?.contentType || 'image/webp', {
                'content-length': String(object.size || 0), 'cache-control': 'private, no-store'
            });
        }
        if (request.method !== 'PUT' && request.method !== 'POST') return error('Method not allowed.', 405);
        if (!await bucket.get(key)) return error('原图不存在，不能保存缩略图。', 404);
        const bytes = await readThumbnailBytes(request);
        const savedKey = await putImageThumbnail(bucket, key, bytes);
        return json({ ok: true, key: savedKey, bytes: bytes.byteLength });
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/settings`) {
        if (request.method === 'GET') return json({ ok: true, settings: await readImageSettings(bucket) });
        if (request.method !== 'PUT') return error('Method not allowed.', 405);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') return error('Invalid JSON body.');
        return json({ ok: true, settings: await writeImageSettings(bucket, { ...await readImageSettings(bucket), ...body }) });
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/storage`) {
        if (request.method !== 'GET') return error('Method not allowed.', 405);
        return json(await buildStorageReport(bucket));
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/storage/cleanup`) {
        if (request.method !== 'POST') return error('Method not allowed.', 405);
        return json(await runStorageCleanup(bucket));
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/delete`) {
        if (request.method !== 'POST') return error('Method not allowed.', 405);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') return error('Invalid JSON body.');
        const objects = await listImageObjects(bucket);
        const keySet = new Set(Array.isArray(body.keys) ? body.keys : []);
        const groupSet = new Set(Array.isArray(body.groupIds) ? body.groupIds : []);
        const characterSet = new Set(Array.isArray(body.characterNames) ? body.characterNames : []);
        const targets = objects.filter((object) => keySet.has(object.key)
            || groupSet.has(object.groupId)
            || characterSet.has(object.characterName));
        let deletedCount = 0;
        let deletedBytes = 0;
        for (const object of targets) {
            await writeImageTombstone(bucket, object);
            if (object.thumbKey) await bucket.delete(object.thumbKey);
            await bucket.delete(object.key);
            deletedCount += 1;
            deletedBytes += object.size;
        }
        return json({ ok: true, deletedCount, deletedBytes, deletedHuman: formatBytes(deletedBytes) });
    }
    return error('Not found.', 404);
}


function createChunkKey(checksum) {
    return `${CHUNK_PREFIX}/${String(checksum || '').toLowerCase()}.bin`;
}

async function readR2JsonObject(bucket, key) {
    const object = await bucket.get(key);
    if (!object) return { object: null, value: null };
    try {
        return {
            object,
            value: JSON.parse(await object.text())
        };
    } catch (err) {
        throw new Error('R2 JSON 数据已损坏。');
    }
}

async function readR2Json(bucket, key) {
    return (await readR2JsonObject(bucket, key)).value;
}

function buildEmptyRemoteInfo(checksum, recordCount, totalBytes, metadata = {}) {
    return {
        version: 0,
        checksum,
        updatedAt: 0,
        recordCount,
        totalBytes,
        chunkCount: 0,
        chunkSize: 0,
        ...metadata
    };
}

function normalizeSnapshotFormat(value) {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === STREAM_SNAPSHOT_FORMAT || value === LEGACY_SNAPSHOT_FORMAT) return value;
    return null;
}

function normalizeSnapshotMetadata(value) {
    if (!value || typeof value !== 'object') return null;
    const snapshotFormat = normalizeSnapshotFormat(value.snapshotFormat);
    const hasSchemaVersion = value.schemaVersion !== undefined
        && value.schemaVersion !== null
        && value.schemaVersion !== '';
    const schemaVersion = hasSchemaVersion ? Number(value.schemaVersion) : undefined;
    const hasChunkerProfile = Object.prototype.hasOwnProperty.call(value, 'chunkerProfile');
    if (snapshotFormat === null
        || (hasSchemaVersion && (!Number.isInteger(schemaVersion) || ![3, 4].includes(schemaVersion)))
        || (hasChunkerProfile && typeof value.chunkerProfile !== 'string')
        || Number(value.schemaVersion) === 5
        || value.snapshotFormat === 'rp-sync-jsonl-v2') return null;
    if (snapshotFormat === STREAM_SNAPSHOT_FORMAT
        && (!hasSchemaVersion || schemaVersion !== STREAM_SNAPSHOT_SCHEMA_VERSION)) return null;
    if (snapshotFormat === LEGACY_SNAPSHOT_FORMAT
        && hasSchemaVersion
        && schemaVersion !== 3) return null;
    if (snapshotFormat === undefined
        && hasSchemaVersion
        && schemaVersion !== 3) return null;

    const metadata = {};
    if (snapshotFormat !== undefined) metadata.snapshotFormat = snapshotFormat;
    if (hasSchemaVersion) metadata.schemaVersion = schemaVersion;
    if (hasChunkerProfile) metadata.chunkerProfile = value.chunkerProfile;
    return metadata;
}

function normalizeChunkManifest(manifest, totalBytes) {
    if (!Array.isArray(manifest) || manifest.length === 0 || manifest.length > MAX_CHUNK_COUNT) return null;

    let byteOffset = 0;
    const normalized = manifest.map((item, index) => {
        const chunkIndex = Number(item?.index);
        const checksum = typeof item?.checksum === 'string' ? item.checksum : '';
        const length = Number(item?.length);
        const key = typeof item?.key === 'string' ? item.key : createChunkKey(checksum);

        if (!Number.isInteger(chunkIndex) || chunkIndex !== index) throw new Error(`分片顺序异常：第 ${index} 片。`);
        if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error(`分片校验码异常：第 ${index} 片。`);
        if (!Number.isInteger(length) || length <= 0 || length > MAX_PART_BYTES) throw new Error(`分片大小异常：第 ${index} 片。`);
        if (key !== createChunkKey(checksum)) throw new Error(`分片存储路径异常：第 ${index} 片。`);

        const nextItem = {
            index,
            checksum: checksum.toLowerCase(),
            length,
            byteOffset,
            byteLength: length,
            key,
            encoding: 'raw-bytes'
        };
        byteOffset += length;
        return nextItem;
    });

    if (byteOffset !== totalBytes) throw new Error('分片大小合计不一致。');
    return normalized;
}

function normalizeManifest(value) {
    if (!value || typeof value !== 'object') return null;
    if (value.mode && value.mode !== 'r2-chunk-manifest-v1') return null;
    const snapshotMetadata = normalizeSnapshotMetadata(value);
    if (!snapshotMetadata) return null;
    const version = Number(value.version || 0);
    const recordCount = value.recordCount;
    const chunkCount = Number(value.chunkCount);
    const totalBytes = Number(value.totalBytes);
    const chunkManifest = Array.isArray(value.chunkManifest) ? value.chunkManifest : [];
    if (!Number.isInteger(version) || version < 0) return null;
    if (!Number.isInteger(recordCount) || recordCount < 0) return null;
    if (!Number.isInteger(chunkCount) || chunkCount < 0 || chunkCount > MAX_CHUNK_COUNT) return null;
    if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_TOTAL_BYTES) return null;
    if (typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(value.checksum)) return null;
    if (chunkCount === 0) {
        return {
            version,
            checksum: value.checksum.toLowerCase(),
            updatedAt: Number(value.updatedAt || 0),
            recordCount,
            totalBytes,
            chunkCount: 0,
            chunkSize: Number(value.chunkSize || 0),
            chunkManifest: [],
            mode: 'r2-chunk-manifest-v1',
            ...snapshotMetadata
        };
    }
    if (chunkManifest.length !== chunkCount) return null;
    let normalizedChunks;
    try {
        normalizedChunks = normalizeChunkManifest(chunkManifest, totalBytes);
    } catch (err) {
        return null;
    }
    if (!normalizedChunks || normalizedChunks.length !== chunkCount) return null;

    return {
        version,
        checksum: value.checksum.toLowerCase(),
        updatedAt: Number(value.updatedAt || 0),
        recordCount,
        totalBytes,
        chunkCount,
        chunkSize: Number(value.chunkSize || 0),
        chunkManifest: normalizedChunks,
        mode: 'r2-chunk-manifest-v1',
        ...snapshotMetadata
    };
}

function getChunkLength(chunk) {
    return Number(chunk?.byteLength || chunk?.length || 0);
}

function isSameChunk(left, right) {
    return Boolean(left && right)
        && String(left.checksum || '').toLowerCase() === String(right.checksum || '').toLowerCase()
        && getChunkLength(left) === getChunkLength(right);
}

function chunkSignature(chunk) {
    const checksum = String(chunk?.checksum || '').toLowerCase();
    const length = getChunkLength(chunk);
    return `${checksum}:${length}`;
}

function buildChunkLookup(manifest) {
    const lookup = new Map();
    for (const chunk of Array.isArray(manifest?.chunkManifest) ? manifest.chunkManifest : []) {
        if (chunk?.checksum) {
            lookup.set(chunkSignature(chunk), chunk);
        }
    }
    return lookup;
}

async function getManifestState(bucket) {
    const state = await readR2JsonObject(bucket, MANIFEST_KEY);
    return {
        manifest: normalizeManifest(state.value),
        rawManifest: state.value,
        object: state.object,
        etag: typeof state.object?.etag === 'string' ? state.object.etag : '',
        httpEtag: typeof state.object?.httpEtag === 'string' ? state.object.httpEtag : ''
    };
}

async function getManifest(bucket) {
    return (await getManifestState(bucket)).manifest;
}

async function listR2Objects(bucket, prefix) {
    if (typeof bucket.list !== 'function') throw new Error('Missing R2 list support.');
    const objects = [];
    let cursor;
    do {
        const page = await bucket.list({ prefix, cursor, limit: 1000 });
        for (const object of page.objects || []) {
            if (object?.key) objects.push(object);
        }
        if (page.truncated && !page.cursor) throw new Error('R2 list cursor missing.');
        cursor = page.truncated ? page.cursor : null;
    } while (cursor);
    return objects;
}

async function deleteR2Objects(bucket, keys) {
    const uniqueKeys = [...new Set(keys)].filter(Boolean);
    for (let offset = 0; offset < uniqueKeys.length; offset += 1000) {
        await bucket.delete(uniqueKeys.slice(offset, offset + 1000));
    }
}

function manifestHistoryKey(version) {
    return `${MANIFEST_HISTORY_PREFIX}/v${String(version).padStart(20, '0')}.json`;
}

async function writeManifestHistory(bucket, manifest) {
    await bucket.put(manifestHistoryKey(manifest.version), JSON.stringify(manifest), {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: { dataset: DATASET_ID, version: String(manifest.version) }
    });
}

async function readRecentManifestHistory(bucket) {
    const historyObjects = await listR2Objects(bucket, `${MANIFEST_HISTORY_PREFIX}/`);
    historyObjects.sort((left, right) => right.key.localeCompare(left.key));
    const retainedObjects = historyObjects.slice(0, MANIFEST_HISTORY_KEEP);
    const staleHistoryKeys = historyObjects.slice(MANIFEST_HISTORY_KEEP).map((object) => object.key);
    if (staleHistoryKeys.length > 0) await deleteR2Objects(bucket, staleHistoryKeys);

    const manifests = await Promise.all(retainedObjects.map(async (object) => {
        const manifest = normalizeManifest(await readR2Json(bucket, object.key));
        if (!manifest) throw new Error(`历史 manifest 无效：${object.key}`);
        return manifest;
    }));
    manifests.sort((left, right) => right.version - left.version);
    return manifests;
}

function hasContiguousRecentHistory(currentManifest, historyManifests) {
    const requiredCount = Math.min(MANIFEST_HISTORY_KEEP, currentManifest.version);
    if (historyManifests.length < requiredCount) return false;
    for (let index = 0; index < requiredCount; index += 1) {
        if (historyManifests[index]?.version !== currentManifest.version - index) return false;
    }
    return true;
}

function collectReferencedChunkKeys(currentManifest, historyManifests) {
    const referencedKeys = new Set();
    for (const manifest of [currentManifest, ...historyManifests]) {
        for (const chunk of manifest?.chunkManifest || []) {
            if (chunk?.key) referencedKeys.add(chunk.key);
        }
    }
    return referencedKeys;
}

async function cleanupUnusedChunks(bucket, currentManifest, historyManifests) {
    const referencedKeys = collectReferencedChunkKeys(currentManifest, historyManifests);
    const storedObjects = await listR2Objects(bucket, `${CHUNK_PREFIX}/`);
    const cutoff = Date.now() - CHUNK_GC_GRACE_MS;
    const staleKeys = storedObjects
        .filter((object) => {
            const uploadedAt = object?.uploaded instanceof Date
                ? object.uploaded.getTime()
                : new Date(object?.uploaded || 0).getTime();
            return object?.key
                && !referencedKeys.has(object.key)
                && Number.isFinite(uploadedAt)
                && uploadedAt < cutoff;
        })
        .sort((left, right) => {
            const uploadedDifference = new Date(left.uploaded).getTime() - new Date(right.uploaded).getTime();
            return uploadedDifference || left.key.localeCompare(right.key);
        })
        .slice(0, CHUNK_GC_MAX_DELETE)
        .map((object) => object.key);
    if (staleKeys.length > 0) await deleteR2Objects(bucket, staleKeys);
}

async function maintainCommittedManifest(bucket, manifest) {
    await writeManifestHistory(bucket, manifest);
    const historyManifests = await readRecentManifestHistory(bucket);
    if (!hasContiguousRecentHistory(manifest, historyManifests)) {
        console.warn('[RP Sync] Manifest history is not contiguous yet; chunk GC deferred.');
        return;
    }
    await cleanupUnusedChunks(bucket, manifest, historyManifests);
}

function scheduleManifestMaintenance(ctx, bucket, manifest) {
    const maintenance = maintainCommittedManifest(bucket, manifest).catch((err) => {
        console.warn('[RP Sync] Failed to maintain manifest history or chunks:', err);
    });
    if (ctx && typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(maintenance);
    }
}

function buildRemoteInfo(manifest, includeChunkManifest = false) {
    const remote = {
        version: manifest.version,
        checksum: manifest.checksum,
        updatedAt: manifest.updatedAt,
        recordCount: manifest.recordCount,
        totalBytes: manifest.totalBytes,
        chunkCount: manifest.chunkCount,
        chunkSize: manifest.chunkSize,
        ...(manifest.snapshotFormat === undefined ? {} : { snapshotFormat: manifest.snapshotFormat }),
        ...(manifest.schemaVersion === undefined ? {} : { schemaVersion: manifest.schemaVersion }),
        ...(manifest.chunkerProfile === undefined ? {} : { chunkerProfile: manifest.chunkerProfile })
    };
    if (includeChunkManifest) {
        remote.chunkManifest = (manifest.chunkManifest || []).map((chunk) => ({
            index: chunk.index,
            checksum: chunk.checksum,
            length: getChunkLength(chunk)
        }));
    }
    return remote;
}

async function handleStatus(bucket, includeChunkManifest = false) {
    const manifest = await getManifest(bucket);
    return json({ ok: true, remote: manifest ? buildRemoteInfo(manifest, includeChunkManifest) : null });
}

async function handlePullJsonPart(bucket, body) {
    const manifest = await getManifest(bucket);
    if (!manifest) return error('服务器当前没有可同步的数据。', 404);

    const version = Number(body.version);
    const start = Number(body.start);
    const count = Number(body.count);
    if (!Number.isInteger(version) || version !== manifest.version) return error('服务器版本已变化，请重试。', 409);
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count <= 0 || count > MAX_PULL_CHUNKS) {
        return error('下载分段范围无效。');
    }
    if (start >= manifest.chunkCount || start + count > manifest.chunkCount) return error('下载分段范围无效。');

    const selectedChunks = manifest.chunkManifest.slice(start, start + count);
    const byteLength = selectedChunks.reduce((sum, item) => sum + Number(item.byteLength || item.length || 0), 0);
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
        return error('R2 分段字节信息异常。', 409);
    }

    const merged = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of selectedChunks) {
        const object = await bucket.get(chunk.key);
        if (!object) return error('R2 快照分片不存在。', 404);

        const bytes = new Uint8Array(await object.arrayBuffer());
        const expectedLength = getChunkLength(chunk);
        if (bytes.byteLength !== expectedLength) return error('R2 快照分片大小校验失败。', 409);
        merged.set(bytes, offset);
        offset += bytes.byteLength;
    }

    return new Response(merged, {
        status: 200,
        headers: {
            'content-type': 'application/octet-stream',
            'cache-control': 'no-store',
            'x-rp-sync-start': String(start),
            'x-rp-sync-count': String(count),
            'x-rp-sync-byte-length': String(byteLength)
        }
    });
}

async function handleUploadCreate(bucket, body) {
    const checksum = typeof body.checksum === 'string' ? body.checksum.toLowerCase() : '';
    const recordCount = body.recordCount;
    const chunkSize = Number.isFinite(Number(body.chunkSize)) ? Number(body.chunkSize) : 0;
    const chunkCount = Number.isFinite(Number(body.chunkCount)) ? Number(body.chunkCount) : 0;
    const totalBytes = Number.isFinite(Number(body.totalBytes)) ? Number(body.totalBytes) : 0;
    const snapshotMetadata = normalizeSnapshotMetadata(body);

    if (!/^[a-f0-9]{64}$/i.test(checksum)) return error('本地数据校验码无效。');
    if (!snapshotMetadata) return error('本地快照格式无效。');
    if (!Number.isInteger(recordCount) || recordCount < 0) return error('本地数据记录数量异常。');
    if (chunkCount === 0 && totalBytes === 0) {
        return json({ ok: true, alreadyUpToDate: true, remote: buildEmptyRemoteInfo(checksum, recordCount, totalBytes, snapshotMetadata) });
    }
    if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) return error(`本地数据数量异常：${chunkCount}/${MAX_CHUNK_COUNT}。`);
    if (!Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_TOTAL_BYTES) return error(`本地数据太大：${totalBytes}/${MAX_TOTAL_BYTES}。`);

    let chunkManifest;
    try {
        chunkManifest = normalizeChunkManifest(body.chunkManifest, totalBytes);
    } catch (err) {
        return error(err instanceof Error ? err.message : '分片清单无效。');
    }
    if (!chunkManifest || chunkManifest.length !== chunkCount) return error('分片清单数量不一致。');
    if (snapshotMetadata.snapshotFormat === STREAM_SNAPSHOT_FORMAT
        && await sha256Text(JSON.stringify([
            STREAM_SNAPSHOT_FORMAT,
            STREAM_SNAPSHOT_SCHEMA_VERSION,
            Number(recordCount || 0),
            Number(totalBytes || 0),
            chunkManifest.map((chunk) => [String(chunk.checksum).toLowerCase(), getChunkLength(chunk)])
        ])) !== checksum) {
        return error('本地快照清单校验失败。');
    }

    const current = await getManifest(bucket);
    if (current?.checksum === checksum) {
        return json({ ok: true, alreadyUpToDate: true, remote: buildRemoteInfo(current, true) });
    }

    const currentChunkLookup = buildChunkLookup(current);
    const missingIndices = [];
    const reusableIndices = [];
    const plannedUploadSignatures = new Set();
    for (const item of chunkManifest) {
        const signature = chunkSignature(item);
        if (isSameChunk(item, currentChunkLookup.get(signature)) || plannedUploadSignatures.has(signature)) {
            reusableIndices.push(item.index);
        } else {
            missingIndices.push(item.index);
            plannedUploadSignatures.add(signature);
        }
    }

    return json({
        ok: true,
        alreadyUpToDate: false,
        chunkSize,
        chunkCount,
        totalBytes,
        recordCount,
        ...snapshotMetadata,
        missingIndices,
        reusableIndices,
        previousVersion: current?.version || 0
    });
}

async function handleUploadPart(request, bucket, url) {
    const partNumber = Number(url.searchParams.get('partNumber'));
    const index = Number(url.searchParams.get('index'));
    const expectedChecksum = (request.headers.get('x-rp-part-checksum') || '').toLowerCase();
    const expectedLength = Number(request.headers.get('x-rp-part-length') || 0);

    if (!Number.isInteger(partNumber) || partNumber <= 0 || partNumber > MAX_CHUNK_COUNT) return error('上传数据序号异常。');
    if (!Number.isInteger(index) || index < 0 || index + 1 !== partNumber) return error('上传数据索引异常。');
    if (!/^[a-f0-9]{64}$/i.test(expectedChecksum)) return error('上传数据校验码无效。');
    if (!Number.isInteger(expectedLength) || expectedLength <= 0 || expectedLength > MAX_PART_BYTES) return error('上传数据大小异常。');

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength !== expectedLength) return error('上传数据大小与声明不一致。', 409);
    if (await sha256Bytes(bytes) !== expectedChecksum) return error('上传数据校验失败。', 409);

    const key = createChunkKey(expectedChecksum);
    try {
        await bucket.put(key, bytes, {
            httpMetadata: { contentType: 'application/octet-stream' },
            customMetadata: { dataset: DATASET_ID, checksum: expectedChecksum }
        });
    } catch (err) {
        return error(err instanceof Error ? err.message : '上传数据失败。', 409);
    }
    return json({
        ok: true,
        partNumber,
        index,
        byteLength: bytes.byteLength,
        checksum: expectedChecksum,
        key
    });
}

async function handleUploadComplete(bucket, body, ctx) {
    const checksum = typeof body.checksum === 'string' ? body.checksum.toLowerCase() : '';
    const recordCount = body.recordCount;
    const chunkSize = Number.isFinite(Number(body.chunkSize)) ? Number(body.chunkSize) : 0;
    const chunkCount = Number.isFinite(Number(body.chunkCount)) ? Number(body.chunkCount) : 0;
    const totalBytes = Number.isFinite(Number(body.totalBytes)) ? Number(body.totalBytes) : 0;
    const expectedVersion = Number(body.expectedVersion);
    const snapshotMetadata = normalizeSnapshotMetadata(body);

    if (!/^[a-f0-9]{64}$/i.test(checksum)) return error('本地数据校验码无效。');
    if (!snapshotMetadata) return error('本地快照格式无效。');
    if (!Number.isInteger(recordCount) || recordCount < 0) return error('本地数据记录数量异常。');
    if (!Number.isInteger(chunkCount) || chunkCount <= 0 || chunkCount > MAX_CHUNK_COUNT) return error('上传数据数量异常。');
    if (!Number.isInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_TOTAL_BYTES) return error(`本地数据太大：${totalBytes}/${MAX_TOTAL_BYTES}。`);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return error('上传会话版本无效，请重新开始上传。', 409);

    let chunkManifest;
    try {
        chunkManifest = normalizeChunkManifest(body.chunkManifest, totalBytes);
    } catch (err) {
        return error(err instanceof Error ? err.message : '上传数据清单无效。');
    }
    if (!chunkManifest || chunkManifest.length !== chunkCount) return error('上传数据清单数量不一致。');
    if (snapshotMetadata.snapshotFormat === STREAM_SNAPSHOT_FORMAT
        && await sha256Text(JSON.stringify([
            STREAM_SNAPSHOT_FORMAT,
            STREAM_SNAPSHOT_SCHEMA_VERSION,
            Number(recordCount || 0),
            Number(totalBytes || 0),
            chunkManifest.map((chunk) => [String(chunk.checksum).toLowerCase(), getChunkLength(chunk)])
        ])) !== checksum) {
        return error('本地快照清单校验失败。');
    }

    const manifestState = await getManifestState(bucket);
    const previous = manifestState.manifest;
    if (previous?.checksum === checksum) {
        return json({
            ok: true,
            version: previous.version,
            checksum: previous.checksum,
            updatedAt: previous.updatedAt,
            reusedChunkCount: 0,
            alreadyCommitted: true,
            ...Object.fromEntries(Object.entries({
                snapshotFormat: previous.snapshotFormat,
                schemaVersion: previous.schemaVersion,
                chunkerProfile: previous.chunkerProfile
            }).filter(([, value]) => value !== undefined))
        });
    }

    const actualVersion = Number(previous?.version || 0);
    if (actualVersion !== expectedVersion) {
        return error('同步冲突：云端数据已被其他设备更新，请重试。', 409);
    }

    const committedManifest = {
        version: actualVersion + 1,
        checksum,
        updatedAt: Date.now(),
        recordCount,
        totalBytes,
        chunkSize,
        chunkCount,
        chunkManifest,
        mode: 'r2-chunk-manifest-v1',
        ...snapshotMetadata
    };

    let onlyIf;
    if (manifestState.object) {
        const etag = manifestState.etag || manifestState.httpEtag.replace(/^"|"$/g, '');
        if (!etag) throw new Error('R2 manifest 缺少 ETag，无法安全提交。');
        onlyIf = { etagMatches: etag };
    } else {
        onlyIf = { etagDoesNotMatch: '*' };
    }

    const committedObject = await bucket.put(MANIFEST_KEY, JSON.stringify(committedManifest), {
        onlyIf,
        httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
    if (!committedObject) {
        return error('同步冲突：云端数据已被其他设备更新，请重试。', 409);
    }

    scheduleManifestMaintenance(ctx, bucket, committedManifest);

    return json({
        ok: true,
        version: committedManifest.version,
        checksum: committedManifest.checksum,
        updatedAt: committedManifest.updatedAt,
        reusedChunkCount: 0,
        ...snapshotMetadata
    });
}

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

function scheduleAppUpdateCleanup(ctx, bucket, candidates) {
    const cleanup = cleanupUnreferencedAppUpdateVersions(bucket, candidates).catch((err) => {
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
    if (path !== 'assets/js/app.js') return text;
    return patchRpHubAppJs(text, { version }).code;
}

function shouldPatchAsText(path) {
    return path === 'assets/js/app.js';
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
    const files = [];
    let totalBytes = 0;
    const stagingSlot = createAppUpdateSlot(latest.tag);
    let committed = false;
    let committedManifest = null;
    try {
        const outcomes = await runConcurrent(upstreamFiles, APP_UPDATE_FILE_CONCURRENCY, async (path) => {
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
                    customMetadata: { upstreamTag: latest.tag, checksum }
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
        for (const outcome of outcomes) {
            if (!outcome || outcome.error) continue;
            files.push({
                path: outcome.path,
                checksum: outcome.checksum,
                byteLength: outcome.byteLength,
                source: outcome.source
            });
            totalBytes += outcome.byteLength;
            if (totalBytes > MAX_APP_UPDATE_TOTAL_BYTES) {
                throw new Error(`上游文件总大小超过限制（${Math.round(MAX_APP_UPDATE_TOTAL_BYTES / 1024 / 1024)}MiB），已停止更新。`);
            }
        }
        if (failed) {
            const failure = new Error(failed.error);
            if (failed.patchRejected) failure.code = 'RP_HUB_APP_PATCH_REJECTED';
            else if (failed.code) failure.code = failed.code;
            throw failure;
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
    if (body.action === 'pull-manifest') return handleStatus(bucket, true);
    if (body.action === 'status') return handleStatus(bucket, false);
    if (body.action === 'pull-json-part') return handlePullJsonPart(bucket, body);
    if (body.action === 'upload-create') return handleUploadCreate(bucket, body);
    if (body.action === 'upload-complete') return handleUploadComplete(bucket, body, ctx);
    if (body.action === 'app-update-versions') return handleAppUpdateVersions(bucket, env, body);
    if (body.action === 'app-update-check') return handleAppUpdateCheck(bucket, env);
    if (body.action === 'app-update-apply') return handleAppUpdateApply(bucket, body, env, ctx);
    if (body.action === 'app-update-rollback') return handleAppUpdateRollback(bucket);
    if (body.action.startsWith('self-update-')) {
        const handlers = {
            'self-update-status': () => handleSelfUpdateStatus(env),
            'self-update-apply': () => handleSelfUpdateApply(request, env, body),
            'self-update-rollback': () => handleSelfUpdateRollback(request, env)
        };
        if (handlers[body.action]) {
            return handlers[body.action]().catch((err) => error(err instanceof Error ? err.message : '测试版更新失败。', getErrorStatus(err)));
        }
    }
    return error('Unsupported action.', 404);
}

// ---- 测试版自更新：从分发端取发布包，用 CF_API_TOKEN 部署到本站所在的 Pages 项目 ----
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const TEST_RELEASE_MANIFEST_PATH = '/test-releases/manifest.json';
const TEST_RELEASE_TAG_PATTERN = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;
const MAX_PAGES_PROJECT_LIST_PAGES = 10;

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

async function handleApi(request, env, url, ctx) {
    try {
        if (url.searchParams.get('action') === 'upload-part') {
            if (request.method !== 'POST') return error('Method not allowed.', 405);
            if (!await isRequestAuthorized(request, env)) return error('Sync password required.', 401, { authRequired: true });
            return handleUploadPart(request, getBucket(env), url);
        }
        return await handleJsonApi(request, env, ctx);
    } catch (err) {
        return error(err instanceof Error ? err.message : 'Unexpected server error.', 500);
    }
}

async function serveStatic(request, env) {
    if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') {
        throw new Error('Missing ASSETS binding. Pages Advanced Mode requires env.ASSETS.fetch(request).');
    }
    const pathname = new URL(request.url).pathname;
    const staticPath = normalizeStaticPath(pathname);
    let response = null;
    let appUpdateInfo = null;

    if (staticPath) {
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
                element.append(buildInjectedBootstrap(appUpdateInfo, mirrorBase), { html: true });
            }
        })
        .on('button', updateNoticeButtonRewriter)
        .on('meta[name="rphub-presence-api"]', remotePingMetaRewriter)
        .on('meta[name="rphub-update-api"]', remotePingMetaRewriter)
        .transform(response);
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === IMAGE_API_PATH) {
            try {
                return await handleImageRender(request, env);
            } catch (err) {
                return error(err instanceof Error ? err.message : 'Unexpected server error.', getErrorStatus(err));
            }
        }
        if (url.pathname === IMAGE_THUMB_API_PATH) {
            try {
                return await handleImageThumbUpload(request, env);
            } catch (err) {
                return error(err instanceof Error ? err.message : 'Unexpected server error.', getErrorStatus(err));
            }
        }
        if (url.pathname === IMAGE_ADMIN_PATH || url.pathname.startsWith(`${IMAGE_ADMIN_PATH}/`)) {
            try {
                return await handleImageAdmin(request, env, url);
            } catch (err) {
                return error(err instanceof Error ? err.message : 'Unexpected server error.', getErrorStatus(err));
            }
        }
        if (url.pathname === API_PATH) {
            return handleApi(request, env, url, ctx);
        }
        return serveStatic(request, env);
    }
};
