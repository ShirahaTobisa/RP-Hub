# RP-Hub 创意工坊 Mod 作者指南

这份指南描述当前 `DB/module-loader.js` 的 API 5，兼容原有 API 1～4 模块。指南和 `examples/` 都是教材，
不会进入 `dist/` 或发布 ZIP。

## 1. 这是什么与信任模型

Mod 是由用户在“模块管理”面板通过 URL 或文件导入安装的 JavaScript 文件。它运行在 RP-Hub 页面同一
权限上下文中，拥有页面全部权限，包括云同步密码与生图密钥。loader 不提供沙箱、签名或权限
隔离，因此只安装你信任的来源。

安装面板的风险警告原文是：

> 风险警告：第三方代码拥有页面全部权限，包括云同步密码与生图密钥。仅安装你信任的来源。
>
> 确认安装此模块吗？

## 2. 最小可运行 Mod

下面的完整文件不超过 15 行；`register` 必须同步执行。

```js
(() => {
  'use strict';
  RPHubSDK.register({
    id: 'my-mod', name: '我的 Mod', version: '1.0.0', requiresApi: 2,
    init(ctx) { ctx.log('loaded'); }
  });
})();
```

安装步骤：

1. 打开导航菜单中的“模块管理”。
2. 使用“导入 JS 文件”，或粘贴允许跨域下载（CORS）的 HTTPS JavaScript URL 后点击“安装”。
3. 确认安装；文件不能为空，最多 8 MiB。
4. 刷新页面；loader 从已保存的文件初始化启用的模块。

插件文件、安装列表、启用状态、`ctx.storage` 和 `ctx.data` 随站点的推送和拉取同步。
首次安装后先刷新，等初始化完成，再推送。另一台已升级站点的设备拉取后会自动刷新并恢复模块，
无需再次访问原下载地址。安装、更新文件、启停和卸载都要刷新后才完全生效。

所有参与插件同步的设备都应使用本次升级后的站点代码。新客户端能读取旧快照；旧客户端没有
新增插件数据的完整同步能力，不能混用它来推拉这些数据。原始油猴脚本必须先适配成上述模块格式。

## 3. manifest 字段

| 字段 | 要求 |
| --- | --- |
| `id` | 必填字符串，必须匹配 `^[a-z0-9-]{3,32}$`；也是存储隔离和卸载清理的身份。 |
| `name` | 必填、非空字符串；显示在模块管理面板。 |
| `version` | 必填、非空字符串；loader 不解释版本格式，只负责显示。 |
| `requiresApi` | 必须是整数；大于当前 `apiVersion` 时拒载并显示 `api-mismatch`。当前 API 是 `5`；使用 `ctx.data` 的模块至少声明 `2`，使用 `ctx.app.get/watch`、`ctx.requests` 或生成事件的模块声明 `3`，使用 `ctx.app.set` 或 `ctx.ui.addComposerButton` 的模块声明 `4`，使用 `ctx.image` 的模块声明 `5`。 |
| `init(ctx)` | 必填函数；应用启动落定后调用。抛错会隔离为 `init-error`。 |

文件加载后要立刻同步调用 `RPHubSDK.register(manifest)`。模块必须在 3 秒期限内注册，不能
等网络、定时器或其他异步回调完成后再注册。

## 4. `ctx` API 参考

### `ctx.storage`

`get(key)`、`set(key, value)`、`remove(key)` 使用浏览器 `localStorage`。每个值最多 64KB，
loader 实际使用 `rph_mod_<id>::<key>` 前缀隔离不同模块；卸载模块时会自动清理这个前缀下的键。
这些字符串会进入云同步。其他自行创建的 localStorage 键不自动纳入同步。

### `ctx.data` 与保存完成检查

`get(key)`、`set(key, value)`、`remove(key)` 都返回 Promise，使用 `RPHubWorkshop/data`。
键按模块 `id` 隔离。这里适合完整文字收藏等较大的数据，同样进入云同步。

值必须是 JSON 数据：普通对象、数组、字符串、有限数字、布尔值或 `null`。
不接受 Blob、Date、undefined、函数和循环引用；文件先转成文本分块数组。大数组会按同步协议
拆成多行，但单个字符串或对象仍受站点的单条记录大小限制。`set` 会立即复制传入值。

异步文件转换等工作应从开始就登记，防止转换尚未结束时推送了不完整的内容：

```js
await ctx.persistence.track('import', async () => {
  const data = await prepareData();
  await ctx.data.set('collection', data);
});
```

站点在推送前调用 `RPHubSDK.flush()`，等初始化和已登记的保存完成。保存失败会阻止上传；
以同一 key 重试成功后解除。普通 `ctx.data.set/remove` 已自动登记。不要在 `init` 内调用
`RPHubSDK.flush()`，否则会等待自身完成。自行创建的其他 IndexedDB 数据库不会自动同步。

拉取覆盖本地期间，SDK 写入会等待；拉取成功后通过刷新加载新数据，失败时按站点原有流程
释放等待的写入。插件不应绕过这个保护直接修改站点存储。

### `ctx.appDb`

`get(key)` 返回 `RPHubDB/store` 中一个键的 Promise 结果；`keys(prefix)` 返回只读 key cursor
扫描得到的字符串数组，只扫键、不读值。数据库没有任何写入口。内部键格式没有稳定性保证，
不要解析键名来承载业务逻辑，也不要读取或修改 `rp_hub_settings` 等同步协议数据。

### `ctx.ui`

- `toast(message, { kind })` 用页面自带的提示条显示消息。`kind` 可用 `info`、`success`、`warning`、`error`，不写时按 `error` 显示。
- `addSidebarEntry({ label, onClick })` 登记插件入口。入口集中显示在「模块管理」面板顶部的“插件功能”里，不进导航菜单，插件再多导航也不会变长；点击时先关闭面板再调用 `onClick`。
- `openPanel({ title, render(bodyEl) })` 打开弹窗。外观、进出场动画和深色模式都和页面原生弹窗一致；标题栏和关闭按钮由 loader 提供，点遮罩或按 Esc 也会关闭。同一时间只开一个插件面板。
- `addComposerButton({ label, text, onClick })`（API 4）在输入框上方那排按钮（“快捷面板”所在行）加一个圆形按钮，
  `text` 取前两个字显示，`label` 作为提示文字。页面重新渲染丢掉按钮时 loader 会补回。

#### 面板样式

面板内容不需要自己写颜色。给元素加下面的类名，就会跟随页面主题和深色模式（1.9.x 和 2.0 都适用）：

| 类名 | 用途 |
| --- | --- |
| `modal-primary-button rph-ui-button` | 主按钮 |
| `modal-secondary-button rph-ui-button` | 普通按钮 |
| `rph-ui-actions` | 按钮行，靠右排列 |
| `rph-ui-field` | 一个表单项（`label` 包住说明文字和输入框） |
| `rph-ui-input` | 输入框、多行文本框 |
| `rph-ui-check`，里面放 `input.settings-toggle-input.sr-only` 和 `span.settings-toggle` | 原生样式的开关 |
| `rph-ui-muted` | 次要说明文字 |
| `rph-ui-note` | 带色条的提示块 |
| `rph-ui-section` | 分组，里面的 `h3` 是小标题 |
| `rph-ui-row` / `rph-ui-row-main` / `rph-ui-row-actions` | 列表行：左边信息，右边操作 |

完整写法见 `DB/modules/advice-inject.js` 和 `examples/api-demo-module.js`。

### `ctx.events`

通过 `on(name, callback)` 订阅以下事件：

- `ready`：应用启动落定后派发。
- `visibility`：页面可见性变化，回调收到 `{ visibilityState, hidden }`。
- `chat-mutation`：loader 唯一的聊天 DOM observer 以至少 500ms 节流批量派发，回调收到
  `{ dirtyRows }`，其中 `dirtyRows` 是发生变化的聊天行 `Element[]`。
- `generation-start` / `generation-end`（API 3）：页面进入、退出“生成中”状态时派发，失败和中止也会派发 `generation-end`。
  流式输出期间可以先暂停扫描页面等重活，等 `generation-end` 后再统一处理。
- `persistence-flush`：站点请求保存时派发。需要等候的异步保存，应在回调中立即使用
  `ctx.persistence.track` 登记；事件派发本身不等待回调返回的 Promise。

事件回调必须自行 `try/catch`，失败要 fail-soft；异常不能影响应用、同步或其他模块。

### `ctx.app`（API 3）

- `get(name)`：读取页面数据或方法，如 `chatHistory`、`settings`、`currentCharacter`、`user`、`userInput`、
  `isGenerating`、`sendMessage`。返回页面里的原对象；改聊天记录里的消息内容会在页面下次保存时一起保存。
- `set(name, value)`（API 4）：修改页面已有的状态，如 `set('userInput', '文字')` 填写输入框；不能新增状态或覆盖方法。
- `watch(getter, callback, { deep, immediate })`：`getter` 里通过 `get` 读到的数据变化时调用
  `callback(新值, 旧值)`，返回停止监听的函数。用它代替定时轮询。只能在 `init` 及之后调用。

```js
ctx.app.watch(() => ctx.app.get('chatHistory').length, length => ctx.log('消息数', length));
```

### `ctx.requests`（API 3）

`onChat(handler)` 登记主聊天请求的改写函数，返回取消登记的函数。每次 AI 回复请求发出前，
加载器把请求体（`{ model, messages, ... }` 的副本）交给 `handler`，直接修改它即可，可以是
async 函数。记忆总结、二次压缩和 UI 变量分析等副请求不会交给 `handler`。

多个插件按登记顺序依次处理；某个 `handler` 抛错时只丢弃它这次的改动，请求照常发出。
不要再自己替换 `window.fetch`。

```js
ctx.requests.onChat(body => {
    body.messages.push({ role: 'system', content: '本轮额外要求' });
});
```

### `ctx.image`（API 5）

生图相关的扩展点，由生图模块实现。

- `registerProvider({ id, label, maxSteps, costHint, generate })`：注册一个生图接口。它会出现在 RPH「设置」→「生图设置」→「生图接口」里；用户选中后，每张新图都由插件生成：
  - `generate({ params, token })` 返回图片 `Blob`（PNG、JPEG、WebP、AVIF 或 GIF）。`params` 是这张图的全部生图参数（`tag`、`model`、`artist`、`size`、`steps`、`scale`、`cfg`、`sampler`、`negative`、`noise_schedule`、`seed` 等），`token` 是用户的生图密钥。
  - 生成好的图由外壳上传到站点 R2，存放位置按参数计算，和直链生图相同；插件不能指定位置。
  - `maxSteps`（1–50）决定设置页步数滑条的上限；`costHint({ steps, model, size })` 可返回一句计费提示，显示在滑条下面；`size` 已含分辨率，如 `2K竖图`。按 Nai2API 价格估算点数可直接用 `RPHubImageModule.estimateImagePoints(model, size, steps)`。
  - `id` 用 3～32 位小写字母、数字或短横线；用户选了某个接口但对应插件没加载时，生图会报错提示，不会悄悄改走直链。
- `onParams(handler)`：每张新图生成参数前调用，可以直接修改传入的参数对象（如按角色换画师、追加负面词），只能改 `tag`、`artist`、`negative`、`size`、`steps`、`scale`、`cfg`、`sampler`、`noise_schedule`。已经生成的图锁住生成时的参数，不受影响。返回取消订阅的函数。

完整例子见 `DB/modules/nai2api-web.js`（Nai2API 网页任务，支持 1–50 步）。

### `ctx.log`、版本与上游信息

`ctx.log(...)` 会以 `[RPH-mod:<id>]` 前缀写入控制台。`ctx.version` 是
`{ api: 4, loader: 'r2-workshop-4' }`。`ctx.upstream.updateInfo` 是页面提供的
`RPH_R2_UPDATE_INFO` 原值，也可能是 `null`；请判空读取。

## 5. 生命周期与状态徽记

流程是：保存安装文件 -> 刷新 -> 等应用启动约 1 秒 -> 从本地执行脚本并同步 `register` -> 调用
`init(ctx)`。模块管理面板会为每个 URL 显示状态徽记：

- `load-error`（加载失败）：URL 请求失败、manifest 缺字段/坏 id、重复 id，或 3 秒内没有同步注册。
- `init-error`（初始化失败）：`init(ctx)` 抛出异常或返回被拒绝的 Promise。
- `api-mismatch`（API 不符）：`requiresApi` 大于当前 API 版本。
- `ok`（正常）：注册和初始化都成功。

没有热加载。改代码、安装、启停或卸载后都必须刷新页面。装到坏 Mod 时可在 URL 后加
`?rph_safe_mode=1` 刷新：loader 仍显示模块管理面板，但跳过所有第三方脚本，以便禁用或
卸载问题模块。卸载会清理该安装的文件、`rph_mod_<id>::*` 和该模块的 `ctx.data`。
插件自行保存的旧键和旧数据库不会被加载器自动删除。

## 6. 纪律与最佳实践

- 加载器在无启用模块时不扫描主库。模块初始化只读取必要的自身数据，重活放到明确的用户动作之后。
- 聊天变化订阅 `chat-mutation`，不要自己建立全页 `MutationObserver`。
- 不碰 `rp_hub_settings` 和任何同步协议数据，不依赖 app 内部 DOM 或 Vue 实例的稳定结构。
- 每个事件回调都捕获自己的异常，日志清楚但不阻塞主应用；失败要 fail-soft。
- `appDb` 只读，`keys` 只扫键；不要把内部键名当作稳定 API。

## 7. 发布与更新

### 发布到工坊

在 [分发端投稿页](https://update.rph.mornye.uk/workshop/submit) 上传插件文件、填写名称、作者和说明。投稿先进入待审核区，
维护者看过代码后上架，各站点在「模块管理 → 工坊」一键安装和更新（更新写回原安装，设置和数据保留）。更新插件同样在投稿页提交，
版本号要改。`register` 里的 `id`、`version`、`requiresApi` 要直接写成固定值，投稿页靠它们识别插件。

[`examples/api-demo-module.js`](examples/api-demo-module.js) 把每个接口各用一次，可以直接照着改。

### 自行分发

URL 安装要求 HTTPS 和 CORS；不满足时使用文件导入。插件文件保存在 `RPHubWorkshop/scripts`，
以后加载本地副本，不自动获取远端更新。

升级已有插件时点该行的“更新文件”，选择新版 JS，保持 manifest 的 `id` 不变，再刷新和推送。
这样安装身份、启用状态和数据会保留。不要把更新文件当成第二个新模块导入，否则相同 `id` 会被拒载。
安全模式可以替换坏文件，无需卸载已有数据。

## 8. 调试清单

1. 用 `?rph_safe_mode=1` 刷新，确认坏 Mod 是否能被禁用。
2. 在控制台筛选 `[RPH-mod:<id>]` 前缀。
3. 查看模块管理面板的状态徽记和 URL，区分加载、注册、API 与初始化问题。
4. 把 `examples/template-module.js` 当 checklist：先复制，改 `id`/`name`，逐个完成 `TODO(你):`，
   再发布到 HTTPS 并刷新页面验证。
