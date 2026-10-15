import assert from 'node:assert/strict';
import fs from 'node:fs';

// 生图失败提示条的合并逻辑。模块本身要页面环境，这里只取出相关的几个函数单独跑。
const source = fs.readFileSync(new URL('../DB/image-module.js', import.meta.url), 'utf8');
const start = source.indexOf('    function describeGenerationError');
const end = source.indexOf('    function hashText');
assert.ok(start > 0 && end > start, 'failure toast helpers not found in DB/image-module.js');
const shown = [];
const report = new Function('log', 'showImageToast', `${source.slice(start, end)}
return reportImageGenerationFailure;`)(() => {}, (text) => shown.push(text));
const flush = () => new Promise((resolve) => setTimeout(resolve, 1000));

// 重绘后新旧两个 img 共用一次请求，拿到同一个 Error：只算一张。
const shared = new Error('额度不足：剩余 0 点');
report(shared);
report(shared);
await flush();
assert.deepEqual(shown.splice(0), ['图片生成失败：额度不足：剩余 0 点']);

// 几张图几种原因合成一条；Worker 自己加的前缀去掉。
for (let i = 0; i < 5; i += 1) report(new Error('生图服务返回异常：HTTP 429'));
report(new Error('图片生成失败：HTTP 502'));
await flush();
assert.deepEqual(shown.splice(0), ['图片生成失败（6 张）：生图服务返回异常：HTTP 429；另有 1 种原因']);

// 截断按字符数，不把 emoji 切成半个。
report(new Error('A'.repeat(79) + '😀 尾巴'));
await flush();
assert.deepEqual(shown.splice(0), ['图片生成失败：' + 'A'.repeat(79) + '😀']);

// 拿不到原因时维持原话。
report(null);
report('纯字符串');
await flush();
assert.deepEqual(shown.splice(0), ['图片生成失败，请检查密钥或服务状态']);
console.log('PASS image failure toasts merge per request, keep emoji whole, fall back without a reason');
