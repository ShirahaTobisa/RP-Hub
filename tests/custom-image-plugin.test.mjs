import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';

// 自定义生图插件：三种接口格式发出去的请求（地址、密钥、请求体、尺寸）、返回的图片怎么取出来、出错时的提示，以及删除后的处理。
const source = fs.readFileSync(new URL('../DB/modules/custom-image.js', import.meta.url), 'utf8');
let manifest = null;
new Function('RPHubSDK', source)({ register(value) { manifest = value; } });
assert.equal(manifest.id, 'custom-image');
assert.equal(manifest.requiresApi, 5);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
// 最小的 zip：一个文件，method 0 存储或 8 deflate，带中央目录和结尾记录。
function zip(name, content, method) {
    const data = method === 8 ? zlib.deflateRawSync(content) : content;
    const fileName = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(0, 42);
    const centralStart = local.length + fileName.length + data.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + fileName.length, 12); end.writeUInt32LE(centralStart, 16);
    return Buffer.concat([local, fileName, data, central, fileName, end]);
}

const calls = [];
let reply = null;
globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return reply(call);
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const bytesOf = async (blob) => Buffer.from(await blob.arrayBuffer());

const storage = new Map();
const providers = new Map();
const start = (services) => {
    storage.set('services', JSON.stringify(services));
    providers.clear();
    manifest.init({
        image: { registerProvider(value) { providers.set(value.id, value); } },
        storage: { get: (key) => storage.get(key) ?? null, set: (key, value) => storage.set(key, value) },
        ui: { addSidebarEntry() {}, openPanel() {}, toast() {} }
    });
};
const params = { tag: '1girl, rain, umbrella', artist: 'masterpiece, artist:foo', model: 'nai-diffusion-4-5-full', size: '竖图', steps: '28', scale: '6', cfg: '0', sampler: 'k_dpmpp_2m_sde', noise_schedule: 'karras', negative: 'lowres', seed: '123456' };

start([
    { id: 'ci-gpt', name: 'GPT 生图', format: 'openai', base: '', key: 'sk-test', model: 'gpt-image-1', extra: '日系动漫风格' },
    { id: 'ci-relay', name: '中转', format: 'openai', base: 'https://relay.example.com', key: 'sk-relay', model: 'flux', extra: '' },
    { id: 'ci-gem', name: 'Gemini 生图', format: 'gemini', base: '', key: 'g-key', model: 'models/gemini-2.5-flash-image', extra: '' },
    { id: 'ci-nai', name: 'NAI 官方', format: 'novelai', base: '', key: 'pst-key', model: '', extra: '' },
    { id: 'ci-bad', name: '坏数据', format: 'unknown' }
]);
assert.deepEqual([...providers.keys()], ['ci-gpt', 'ci-relay', 'ci-gem', 'ci-nai'], 'unknown formats are dropped');
assert.equal(providers.get('ci-gpt').label, 'GPT 生图');
assert.equal(providers.get('ci-nai').maxSteps, 50);
assert.equal(providers.get('ci-gpt').costHint(), '步数、采样器等参数对此服务无效');
assert.equal(providers.get('ci-nai').costHint(), '');
console.log('PASS saved services are registered as image generators; unknown formats are skipped');

// OpenAI：官方地址补 /v1，提示词后面接附加提示词，竖图 → 1024x1536；b64_json 取出 PNG。
reply = () => json({ data: [{ b64_json: PNG.toString('base64') }] });
calls.length = 0;
let blob = await providers.get('ci-gpt').generate({ params });
assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
assert.equal(calls[0].headers.authorization, 'Bearer sk-test');
assert.deepEqual(calls[0].body, { model: 'gpt-image-1', prompt: '1girl, rain, umbrella, 日系动漫风格', n: 1, size: '1024x1536' });
assert.equal(blob.type, 'image/png');
assert.deepEqual(await bytesOf(blob), PNG);
// 中转地址没写 /v1 时补上；2K横图 → 1536x1024；只回图片地址时去下载，按文件头认出 JPEG。
reply = (call) => (call.url.endsWith('/images/generations') ? json({ data: [{ url: 'https://cdn.example.com/a.jpg' }] }) : new Response(JPEG));
calls.length = 0;
blob = await providers.get('ci-relay').generate({ params: { ...params, size: '2K横图' } });
assert.equal(calls[0].url, 'https://relay.example.com/v1/images/generations');
assert.equal(calls[0].body.size, '1536x1024');
assert.equal(calls[0].body.prompt, '1girl, rain, umbrella');
assert.equal(calls[1].url, 'https://cdn.example.com/a.jpg');
assert.equal(blob.type, 'image/jpeg');
console.log('PASS OpenAI format: endpoint, key, prompt with the extra prompt, size by orientation, base64 or image URL');

// Gemini：v1beta 地址、去掉 models/ 前缀、密钥放 x-goog-api-key；方图 → 1:1；inlineData 取图。
reply = () => json({ candidates: [{ content: { parts: [{ text: '好的' }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }] } }] });
calls.length = 0;
blob = await providers.get('ci-gem').generate({ params: { ...params, size: '方图' } });
assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent');
assert.equal(calls[0].headers['x-goog-api-key'], 'g-key');
assert.deepEqual(calls[0].body, {
    contents: [{ role: 'user', parts: [{ text: '1girl, rain, umbrella' }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } }
});
assert.deepEqual(await bytesOf(blob), PNG);
// 被拦下、只回了文字：提示里带上原因和那段文字。
reply = () => json({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [{ text: '无法生成这张图片' }] } }] });
await assert.rejects(providers.get('ci-gem').generate({ params }), { message: '生图服务没有返回图片（IMAGE_SAFETY）：无法生成这张图片' });
console.log('PASS Gemini format: v1beta endpoint, header key, aspect ratio, inline image, refusal reason');

// NovelAI 官方：画风串在前、提示词在后；尺寸按外壳尺寸表；参数原样带上；返回的 JSON 或 zip（存储或 deflate）里取出 PNG。
reply = () => new Response(zip('image_0.png', PNG, 0));
calls.length = 0;
blob = await providers.get('ci-nai').generate({ params: { ...params, size: '2K竖图' } });
const sent = calls[0];
assert.equal(sent.url, 'https://image.novelai.net/ai/generate-image');
assert.equal(sent.headers.authorization, 'Bearer pst-key');
assert.equal(sent.body.input, 'masterpiece, artist:foo, 1girl, rain, umbrella');
assert.equal(sent.body.model, 'nai-diffusion-4-5-full');
assert.equal(sent.body.action, 'generate');
const p = sent.body.parameters;
assert.deepEqual([p.params_version, p.width, p.height, p.steps, p.scale, p.cfg_rescale, p.sampler, p.noise_schedule, p.seed, p.negative_prompt],
    [3, 1088, 1600, 28, 6, 0, 'k_dpmpp_2m_sde', 'karras', 123456, 'lowres']);
assert.equal(p.v4_prompt.caption.base_caption, 'masterpiece, artist:foo, 1girl, rain, umbrella');
assert.equal(p.v4_negative_prompt.caption.base_caption, 'lowres');
assert.deepEqual(await bytesOf(blob), PNG);
reply = () => new Response(zip('image_0.png', PNG, 8));
assert.deepEqual(await bytesOf(await providers.get('ci-nai').generate({ params })), PNG);
reply = () => new Response(PNG);
assert.equal((await providers.get('ci-nai').generate({ params })).type, 'image/png');
// 官方接口实测回的是 JSON：images[0].image 是 base64 的 PNG。
reply = () => json({ images: [{ image: PNG.toString('base64') }] });
assert.deepEqual(await bytesOf(await providers.get('ci-nai').generate({ params })), PNG);
// V5：params_version 4，不带 noise_schedule 和 skip_cfg_above_sigma。
reply = () => new Response(zip('image_0.png', PNG, 0));
calls.length = 0;
await providers.get('ci-nai').generate({ params: { ...params, model: 'nai-diffusion-5-full' } });
assert.equal(calls[0].body.parameters.params_version, 4);
assert.equal('noise_schedule' in calls[0].body.parameters, false);
assert.equal('skip_cfg_above_sigma' in calls[0].body.parameters, false);
console.log('PASS NovelAI format: artist before tags, shell sizes, all parameters, V5 differences, JSON, stored or deflated zip, or a plain image');

// 出错：服务报错带上它的原因；连不上换成能看懂的一句；回的不是图片要说清楚。
reply = () => json({ error: { message: 'Incorrect API key provided' } }, 401);
await assert.rejects(providers.get('ci-gpt').generate({ params }), { message: '生图服务返回错误（HTTP 401）：Incorrect API key provided' });
reply = () => json({ statusCode: 402, message: 'An active subscription is required' }, 402);
await assert.rejects(providers.get('ci-nai').generate({ params }), { message: '生图服务返回错误（HTTP 402）：An active subscription is required' });
reply = () => { throw new TypeError('Failed to fetch'); };
await assert.rejects(providers.get('ci-gem').generate({ params }), { message: '无法连接生图服务：请检查接口地址，或该服务不支持网页直接调用' });
reply = () => json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] });
await assert.rejects(providers.get('ci-gpt').generate({ params }), { message: '生图服务返回的不是图片' });
console.log('PASS errors carry the service reason, a connection failure and a non-image reply are explained');
