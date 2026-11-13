import {
    patchRpHubAppJs,
    patchRpHubCloudBackupJs,
    RpHubAppPatchError,
    RP_HUB_APP_PATCH_REVISION,
    RP_HUB_CLOUD_BACKUP_PATH,
    RP_HUB_CLOUD_BACKUP_META_NAME
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
// 魔改版（cy-2-u/rp）的云端数据：根清单和我们的清单在同一个位置，分页清单、数据包在旁边。
// 「下载」能把它导进来；第一次上传会覆盖根清单，先另存一份，退回魔改版时放回原处就行。
const FORK_ROOT_FORMAT = 'rp-sync-manifest-root-v1';
const FORK_ROOT_BACKUP_KEY = `${R2_PREFIX}/fork-root-backup.json`;
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
const MAX_APP_UPDATE_FILES = 200;
const MAX_APP_UPDATE_TOTAL_BYTES = 160 * 1024 * 1024;
const MAX_APP_UPDATE_FILE_BYTES = 32 * 1024 * 1024;
const APP_UPDATE_FILE_CONCURRENCY = 4;
// Cloudflare 免费版每个请求最多 50 次子请求（下载和 R2 读写都算），每个文件要下载一次、写一次，所以一次只处理 8 个，剩下的由页面接着请求。
const APP_UPDATE_FILES_PER_REQUEST = 8;
const MAX_PART_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_COUNT = 10000;
const MAX_PULL_CHUNKS = 8;
const MANIFEST_HISTORY_KEEP = 5;
const CHUNK_GC_GRACE_MS = 24 * 60 * 60 * 1000;
const CHUNK_GC_MAX_DELETE = 100;
const STREAM_SNAPSHOT_FORMAT = 'rp-sync-jsonl-v1';
const STREAM_SNAPSHOT_SCHEMA_VERSION = 4;
// 分块压缩后上传（gzip，由手机压缩和解压，服务器只存取不计算）。压缩块单独存放，和不压缩的块互不顶替。
const STREAM_GZIP_SCHEMA_VERSION = 6;
const STREAM_SCHEMA_VERSIONS = [STREAM_SNAPSHOT_SCHEMA_VERSION, STREAM_GZIP_SCHEMA_VERSION];

function chunkEncodingForSchema(schemaVersion) {
    return Number(schemaVersion) === STREAM_GZIP_SCHEMA_VERSION ? 'gzip' : 'raw-bytes';
}
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
const IMAGE_FETCH_TIMEOUT_MS = 300000;
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
    'image_key',
    '_rph_retry'
]);
const IMAGE_GENERATION_PARAM_NAME_PATTERN = /^[A-Za-z0-9_.~-]{1,80}$/;

function buildInjectedBootstrap(updateInfo = null, mirrorBase = '', usage = false) {
    const safeInfo = updateInfo && typeof updateInfo === 'object'
        ? JSON.stringify(updateInfo).replace(/</g, '\\u003c')
        : 'null';
    // 分发端地址给模块管理的“工坊”用；分发端关闭时为空字符串。
    const safeMirrorBase = JSON.stringify(String(mirrorBase || '')).replace(/</g, '\\u003c');
    const diagnostics = JSON.stringify({ release: RPH_RELEASE_VERSION, upstream: updateInfo?.tag || CURRENT_UPSTREAM_VERSION, usage }).replace(/</g, '\\u003c');
return `
<script>window.RPH_R2_UPDATE_INFO=${safeInfo};window.RPH_R2_MIRROR_BASE=${safeMirrorBase};window.RPH_R2_DIAGNOSTICS=${diagnostics};</script>
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

// 2.0.4 起 cloud-backup.js 也从 rphub-update-api 这个 meta 拿服务地址。改个名留给它（打过补丁的 cloud-backup.js
// 读新名字），update-check.js 照旧找不到、不心跳。只有用户自己输入密钥点「下载备份」时才会连原作者的服务器。
const cloudBackupMetaRewriter = {
    element(element) {
        element.setAttribute('name', RP_HUB_CLOUD_BACKUP_META_NAME);
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

