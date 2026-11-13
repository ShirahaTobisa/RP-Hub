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
const IMAGE_SAMPLERS = ['k_euler', 'k_euler_ancestral', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_sde'];
// 分辨率和 RPH 的「生图比例」拼成尺寸名，如「2K竖图」；上游 2026-08-21 删掉了 2K/4K 选项，这里补回。
const IMAGE_RESOLUTIONS = ['', '2K', '4K'];
const IMAGE_NOISE_SCHEDULES = ['karras', 'native', 'exponential', 'polyexponential'];
// generator：'direct' 是现在的直链；其他值是生图插件注册的接口 id。负面提示词留空表示用生图模块自带的默认值。
const IMAGE_SETTINGS_DEFAULTS = Object.freeze({
    storageLimitGb: 9,
    generator: 'direct',
    params: Object.freeze({ steps: 28, scale: 6, cfg: 0, sampler: IMAGE_DEFAULT_SAMPLER, noise_schedule: 'karras', resolution: '', negative: '' })
});
const R2_FREE_BYTES = 10 * 1024 ** 3;
// 一次请求最多删多少张：免费版每个请求只有 50 次子请求（列表、写墓碑、删除都算），超了会在写完墓碑、还没删原图时中断，
// 图就成了"已删除"却还占着空间，下次清理又选中同一批、在同一处失败。剩下的由前端继续调用。
const STORAGE_CLEANUP_BATCH = 15;

function clampNumber(value, min, max, fallback, digits = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const factor = 10 ** digits;
    return Math.min(max, Math.max(min, Math.round(number * factor) / factor));
}

function normalizeImageSettings(value = {}) {
    // 上限至少 0.1 GB：填 0 或太小的数会把所有图都列进清理计划，按无效处理。
    const limit = Math.round(Number(value.storageLimitGb) * 10) / 10;
    const params = value.params && typeof value.params === 'object' ? value.params : {};
    const defaults = IMAGE_SETTINGS_DEFAULTS.params;
    const generator = String(value.generator || '').trim();
    return {
        storageLimitGb: Number.isFinite(limit) && limit >= 0.1 ? Math.min(1024, limit) : IMAGE_SETTINGS_DEFAULTS.storageLimitGb,
        generator: /^[a-z0-9-]{3,32}$/.test(generator) || generator === 'direct' ? generator : 'direct',
        params: {
            steps: clampNumber(params.steps, 1, 50, defaults.steps),
            scale: clampNumber(params.scale, 0, 10, defaults.scale, 1),
            cfg: clampNumber(params.cfg, 0, 1, defaults.cfg, 2),
            sampler: IMAGE_SAMPLERS.includes(params.sampler) ? params.sampler : defaults.sampler,
            noise_schedule: IMAGE_NOISE_SCHEDULES.includes(params.noise_schedule) ? params.noise_schedule : defaults.noise_schedule,
            resolution: IMAGE_RESOLUTIONS.includes(params.resolution) ? params.resolution : defaults.resolution,
            negative: typeof params.negative === 'string' ? params.negative.slice(0, 2000) : defaults.negative
        }
    };
}

async function readImageSettings(bucket) {
    const object = await bucket.get(IMAGE_SETTINGS_KEY);
    if (!object) return normalizeImageSettings();
    try {
        return normalizeImageSettings(JSON.parse(await object.text()));
    } catch (_) {
        return normalizeImageSettings();
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

// 先写删除记录（聊天里显示“已删除”而不是重新生成），再把原图和缩略图一次删掉；返回释放的字节数。
async function deleteImageObjects(bucket, objects, reason) {
    await Promise.all(objects.map((object) => writeImageTombstone(bucket, object, reason)));
    const keys = objects.flatMap((object) => object.thumbKey ? [object.key, object.thumbKey] : [object.key]);
    for (let index = 0; index < keys.length; index += 1000) await bucket.delete(keys.slice(index, index + 1000));
    return objects.reduce((sum, object) => sum + object.size, 0);
}

// 按清理计划删除一批最旧的图；剩下的由前端继续调用。
async function runStorageCleanup(bucket) {
    const report = await buildStorageReport(bucket);
    const batch = new Set(report.cleanup.keys.slice(0, STORAGE_CLEANUP_BATCH));
    const objects = (await listImageObjects(bucket)).filter((object) => batch.has(object.key));
    const deletedBytes = await deleteImageObjects(bucket, objects, 'storage-cleanup');
    return {
        ok: true,
        deletedCount: objects.length,
        deletedHuman: formatBytes(deletedBytes),
        remaining: Math.max(0, report.cleanup.count - objects.length)
    };
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
#app{height:100%;display:grid;grid-template-columns:240px minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
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
.storage{grid-column:1/-1;max-width:720px}.storage h3{margin:18px 0 10px;font-size:13px}.meter{position:relative;height:12px;border-radius:999px;background:var(--raised);overflow:hidden}.meter-bar{height:100%;border-radius:inherit;background:var(--accent)}.meter-bar.over{background:var(--danger)}.meter-limit{position:absolute;top:0;bottom:0;width:3px;background:var(--text)}.meter-text{margin-top:8px;color:var(--muted)}.big{font-size:22px;font-weight:700;color:var(--text)}.cat{display:grid;grid-template-columns:110px minmax(0,1fr) 90px;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--line)}.cat .meter{height:8px}.cat-size{text-align:right;color:var(--muted)}.cleanup{margin-top:18px;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}.cleanup p{margin:0 0 10px}.limit-row{display:flex;align-items:center;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}.limit-input{width:80px;height:32px;margin:0 4px;padding:0 8px;border:1px solid var(--line);border-radius:8px;background:var(--raised)}
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
function renderGallery(){shown=0;gallery.innerHTML='';renderHead();if(current===STORAGE){renderStorage();return;}if(!images().length){gallery.innerHTML='<div class="empty">'+(groups().length?'这里没有图片':'还没有图片')+'</div>';return;}appendBatch();fillGallery();}
// 底部标记离屏幕底部不到 800px 就继续加载，直到填满；按屏幕位置判断，不管是图片区还是整个页面在滚动。
function fillGallery(){var sentinel=$('sentinel');for(var i=0;i<20&&shown<images().length&&sentinel.getBoundingClientRect().top<window.innerHeight+800;i++)appendBatch();}
function selectGroup(id){current=id;setSelecting(false);document.body.classList.add('show-main');renderCharacters();renderGallery();$('scroll').scrollTop=0;}
function syncSelectBar(){$('selectMode').classList.toggle('on',selecting);selectBar.classList.toggle('hidden',!selecting);selectCount.textContent='已选 '+selected.size+' 张';deleteSelectedButton.disabled=!selected.size;gallery.classList.toggle('selecting',selecting);}
function setSelecting(on){selecting=on;selected.clear();gallery.querySelectorAll('.photo.selected').forEach(function(n){n.classList.remove('selected');});syncSelectBar();}
function applyBlur(){var on=stored(blurStorageKey)==='1';gallery.classList.toggle('blurred',on);blurToggle.classList.toggle('on',on);blurToggle.title=on?'显示图片':'隐藏图片';}
function ask(title,text,ok,danger){return new Promise(function(resolve){$('dialogTitle').textContent=title;$('dialogText').textContent=text;$('dialogOk').textContent=ok||'删除';$('dialogOk').className='btn '+(danger===false?'primary':'danger-fill');$('dialog').classList.remove('hidden');function done(v){$('dialog').classList.add('hidden');$('dialogOk').onclick=null;$('dialogCancel').onclick=null;resolve(v);}$('dialogOk').onclick=function(){done(true);};$('dialogCancel').onclick=function(){done(false);};$('dialogOk').focus();});}
function forget(keys){var keySet=new Set(keys);data.characters=groups().map(function(g){g.images=g.images.filter(function(img){return !keySet.has(img.key);});return g;}).filter(function(g){return g.images.length;});cachedAll=null;if(current!==ALL&&!groups().some(function(g){return g.id===current;}))current=ALL;}
async function remove(keys,title,text){if(!keys.length||!await ask(title,text))return false;try{var r,count=0,bytes=0;do{r=await api('/image/api/delete',{method:'POST',body:JSON.stringify({keys:keys})});count+=r.deletedCount;bytes+=r.deletedBytes;}while(r.remaining&&r.deletedCount);forget(keys);selected.clear();renderStats();renderCharacters();renderGallery();syncSelectBar();setNotice('已删除 '+count+' 张，释放 '+fmt(bytes)+'。');return true;}catch(e){setNotice(e.message,true);return false;}}
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
async function renderStorage(){gallery.innerHTML='<div class="storage empty">正在统计存储桶…</div>';try{var r=await api('/image/api/storage');if(current!==STORAGE)return;var scale=Math.max(r.freeBytes,r.totalBytes),html='<div class="storage"><div class="big">'+esc(r.totalHuman)+'</div><div class="meter" style="margin-top:8px"><div class="meter-bar'+(r.over?' over':'')+'" style="width:'+Math.min(100,r.totalBytes/scale*100).toFixed(2)+'%"></div><div class="meter-limit" style="left:'+Math.min(100,r.limitBytes/scale*100).toFixed(2)+'%"></div></div><div class="meter-text">免费额度 '+fmt(r.freeBytes)+' · 清理上限 '+esc(r.limitHuman)+'（竖线）</div><h3>按类别</h3>';r.categories.filter(function(c){return c.bytes>0;}).sort(function(a,b){return b.bytes-a.bytes;}).forEach(function(c){html+='<div class="cat"><span>'+esc(c.label)+'</span>'+bar(c.bytes,r.totalBytes)+'<span class="cat-size">'+esc(c.human)+'</span></div>';});html+='<div class="cleanup">'+(r.over?'<p>已超出清理上限。从最早的图开始删除 <b>'+r.cleanup.count+'</b> 张，可腾出 <b>'+esc(r.cleanup.human)+'</b>'+(r.cleanup.enough?'。':'；只删图片仍降不到上限，其余是同步数据等其他内容。')+'</p><button id="runCleanup" class="btn danger-fill"'+(r.cleanup.count?'':' disabled')+'>立即清理</button>':'<p>未超出清理上限。</p>')+'<div class="limit-row"><label>清理上限 <input id="limitInput" class="limit-input" type="number" min="0.1" step="0.5" value="'+(Math.round(r.limitBytes/1073741824*10)/10)+'"> GB</label><button id="saveLimit" class="btn">保存</button></div><p class="sub" style="margin:10px 0 0">超出上限时，聊天页每天最多提醒一次，由你决定是否清理。删除的图在聊天里显示为「已删除」，不会重新生成。</p></div></div>';gallery.innerHTML=html;var run=$('runCleanup');if(run)run.onclick=function(){cleanupStorage(r.cleanup.count,r.cleanup.human);};$('saveLimit').onclick=async function(){try{var res=await api('/image/api/settings',{method:'PUT',body:JSON.stringify({storageLimitGb:Number($('limitInput').value)})});setNotice('清理上限已改为 '+res.settings.storageLimitGb+' GB。');renderStorage();}catch(e){setNotice('保存失败：'+e.message,true);}};}catch(e){gallery.innerHTML='<div class="storage empty">'+esc(e.message)+'</div>';}}
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
$('scroll').addEventListener('scroll',fillGallery,{passive:true});window.addEventListener('scroll',fillGallery,{passive:true});window.addEventListener('resize',fillGallery);
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
        if (!key.startsWith(`${IMAGE_OBJECT_PREFIX}/`) || !parseImageObjectKey(key)) return error('图片路径无效。', 400);
        const object = await bucket.get(key);
        if (!object) return error('图片不存在。', 404);
        const contentType = normalizeRasterContentType(object.httpMetadata?.contentType);
        if (!contentType) return error('图片格式不受支持。', 415);
        if (request.method === 'HEAD') await discardBody(object);
        return imageResponse(request.method === 'HEAD' ? null : object.body, contentType, {
            'content-length': String(object.size || 0), 'cache-control': 'private, no-store'
        });
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/thumb`) {
        const key = url.searchParams.get('key') || '';
        if (!key.startsWith(`${IMAGE_OBJECT_PREFIX}/`) || !parseImageObjectKey(key)) return error('图片路径无效。', 400);
        const thumbKey = createImageThumbKeyFromImageKey(key);
        if (request.method === 'GET' || request.method === 'HEAD') {
            const object = await bucket.get(thumbKey);
            if (!object) return error('缩略图不存在。', 404);
            if (request.method === 'HEAD') await discardBody(object);
        return imageResponse(request.method === 'HEAD' ? null : object.body, object.httpMetadata?.contentType || 'image/webp', {
                'content-length': String(object.size || 0), 'cache-control': 'private, no-store'
            });
        }
        if (request.method !== 'PUT' && request.method !== 'POST') return error('Method not allowed.', 405);
        if (!await bucket.head(key)) return error('原图不存在，不能保存缩略图。', 404);
        const bytes = await readThumbnailBytes(request);
        const savedKey = await putImageThumbnail(bucket, key, bytes);
        return json({ ok: true, key: savedKey, bytes: bytes.byteLength });
    }
    if (url.pathname === `${IMAGE_ADMIN_PATH}/api/settings`) {
        if (request.method === 'GET') return json({ ok: true, settings: await readImageSettings(bucket) });
        if (request.method !== 'PUT') return error('Method not allowed.', 405);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') return error('Invalid JSON body.');
        const current = await readImageSettings(bucket);
        return json({ ok: true, settings: await writeImageSettings(bucket, { ...current, ...body, params: { ...current.params, ...(body.params || {}) } }) });
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
        const matched = objects.filter((object) => keySet.has(object.key)
            || groupSet.has(object.groupId)
            || characterSet.has(object.characterName));
        const targets = matched.slice(0, STORAGE_CLEANUP_BATCH);
        const deletedBytes = await deleteImageObjects(bucket, targets, 'manual-delete');
        return json({ ok: true, deletedCount: targets.length, deletedBytes, deletedHuman: formatBytes(deletedBytes), remaining: matched.length - targets.length });
    }
    return error('Not found.', 404);
}


