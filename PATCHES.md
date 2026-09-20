# RP-Hub app.js automatic patches

2026-09-16：1.9.5 同步入口与推拉优化合并在同一覆盖层包中，验收原文保存在本机 `archive/docs/ACCEPTANCE-195-COMBINED-20260916.md`，当前状态见 [docs/CURRENT-STATE.md](docs/CURRENT-STATE.md)。新增的 `DB/nav-adapter.js` 依次先于 `char-store.js`、`bootstrap.js`、`image-module.js`、`module-loader.js` 注入，部署资源版本仍按内容 SHA-256 生成。

导航通过 1.9.5 的 `#app-navigation-panel.app-navigation-panel` 最后一组 `.app-navigation-grid` 挂载；旧版通过 `#app .app-sidebar` 设置项定位。同步和工坊等待真实 `.app-navigation-close` 关闭及离场，图片和动态模块保留同步点击回调。旧浮动入口和三个消费者各自的导航守卫已移除。

主动同步使用原生 `navigator.locks` 独占锁；支持时，拉取复用 `RPHubSyncChunkCache`（版本 1、`chunks`），按 `checksum:length` 存原始块。两项下载任务共同受 32 MiB 原始字节预算约束，单区间最多 8 块、16 MiB；写库事务结束才释放额度。空闲缓存保留当前清单内最多 256 MiB 原始块。缓存命中仍需清单鉴权、完整校验和真实恢复。无原生锁或缓存库不可用时采用串行临时存储；配额不足最多重试一次临时模式。

推送复用记录序列化和编码结果，保留两遍扫描及全部提交保护。批次 32、16、8 的大聊天内存对照均未过关，保留批次 4。同步 schema、分块算法、云端接口、app.js 补丁模式及 `r2-character-split-e2b-v3` 均未改变。1.9.5 公告继续按上游倒计时关闭。

`DB/app-patches.mjs` 是唯一的 app.js 补丁模式定义。Worker 的 app-update 流程和 `scripts/rebuild.mjs` 都调用该模块的 `patchRpHubAppJs()`，不得在 `_worker.js`、重建脚本或生成后的 app.js 中复制第二套替换规则。

## 三个补丁模式

### 1. 角色保存

模式：

```regex
/await\s+setStoredValue\(\s*'characters'\s*,\s*([A-Za-z0-9_.$]+(?:\.value)?)\s*\)/g
```

替换：

```js
await window.RPHubCharStore.saveAll($1)
```

### 2. 角色装载

模式：

```regex
/await\s+getStoredValue\(\s*'characters'\s*\)/g
```

替换：

```js
await window.RPHubCharStore.loadAll()
```

### 3. E2b 持久化桥、返回契约与 pull 恢复门禁

锚点是 `manualSave` 的完整定义体，而不是行号。补丁在该定义体之后插入：

```js
const flushPersistenceForRpSync = async () => {
    if (!_initComplete) throw new Error('RP-Hub 数据仍在初始化，请稍后再同步或切换版本');
    if (isConversationBusy?.value) throw new Error('对话仍在生成，请等待生成结束后再同步或切换版本');
    const saved = await saveData();
    const chatSaved = await flushPendingChatHistorySave();
    if (saved === false) throw new Error('RP-Hub 数据保存失败，已取消同步或版本切换');
    if (chatSaved === false) throw new Error('聊天记录保存失败，已取消同步或版本切换');
    return true;
};
globalThis.RPH_R2_FLUSH_PERSISTENCE = flushPersistenceForRpSync;
```

桥本身按规格只把 `false` 视为失败。实际 tag 1.7.5 另有一个必须处理的数据安全差异：`saveData` 的 catch 原本吞掉异常并返回 `undefined`，`flushPendingChatHistorySave` 也丢弃聊天保存的 `false`。若只插入上述桥，失败和成功都会表现为 `undefined`，push 仍可能继续上传旧数据。

因此同一个 persistenceBridge 模式还会自动完成以下返回契约加固，且任一锚点不匹配时拒绝更新：

- `saveChatHistoryNow` 必须把成功/失败传播为 `true`/`false`；1.7.4/1.7.5 已有该契约，1.7.3 会自动补齐。
- `flushPendingChatHistorySave` 使用 `return await` 返回定时任务或 `chatHistorySaveQueue` 的结果。
- `saveData` 检查 `saveChatHistoryNow() === false`，成功末尾返回 `true`，catch 末尾返回 `false`。

这不是第四套独立模式，也不手改生成 app.js；定义、替换和验证仍全部位于共享 `DB/app-patches.mjs`。

同一个 `persistenceBridge` 模式还会在上游两个直接 `readwrite` 入口 `dbSetTo` 与 `dbDeleteFrom` 的定义体开头插入恢复门禁。`globalThis.RPH_R2_PULL_RESTORE_IN_PROGRESS === true` 时，写入不会立即触碰 IndexedDB，而是交给 bootstrap 的 `RPH_R2_DEFER_PERSISTENCE_WRITE` 队列：

- pull 成功时标志保持到 `location.reload()`，旧内存产生的 set/delete 永远不能覆盖刚恢复的远端值；
- pull 失败时 bootstrap 先清除标志，再按调用顺序释放并等待延迟写入，避免吞掉失败期间仍待保存的本地聊天；
- `dbSetTo` 在入队时按原 `clone` 语义捕获值，失败释放时不会改写成稍后发生变动的对象；
- 队列协调器缺失时返回 rejected Promise，按 E2b 的 fail-closed 语义阻止静默写入。

`RPHubCharStore.migrate()` / `saveAll()` 在 mutationQueue 任务真正执行时以及等待数据库打开后都会检查同一标志，并把实际操作加入同一延迟队列。失败释放后 bootstrap 还会等待角色 mutationQueue 清空，保证排在首个 deferred 操作之后的角色保存也完成。字面 E2b 只要求 pull 不过桥并在成功后重载；上述恢复期延迟队列是为消除已经复现的“restore put 后旧内存反写”竞态而增加的必要 fail-safe 加固，pull 仍然从不调用 `RPH_R2_FLUSH_PERSISTENCE`。

## 同步 wire format：jsonl-v4 + CDC

同步传输固定使用 `snapshotFormat: 'rp-sync-jsonl-v1'`、`schemaVersion: 4` 和 `mode: 'r2-chunk-manifest-v1'`。快照按 JSONL 事件流生成：snapshot header、localStorage、database/store、record 或 record-array，以及带 `recordCount` 的 `snapshotEnd`。CDC 只在完整 JSONL 记录末尾选择普通边界；超大行由 hard max 路径切分，下载后通过 staging 两遍扫描先完整验证、再写本地数据库。

切块器 profile 为 `rph-jsonl-cdc-fnv1a-v1`（manifest 的可选 `chunkerProfile` 字符串），target 2 MiB、hard max 8 MiB。该字段只描述切块器，明确不进入 checksum。manifest checksum 必须严格使用以下字节序列：

```js
sha256Text(JSON.stringify([
  'rp-sync-jsonl-v1', 4,
  Number(recordCount || 0), Number(totalBytes || 0),
  chunkManifest.map((c) => [String(c.checksum).toLowerCase(), Number(c.length)])
]))
```

客户端对缺失 `snapshotFormat` 或 `rp-sync-json-v3` / schemaVersion 3 保留只读兼容路径，推送一律为 v4；`rp-sync-jsonl-v2` / schemaVersion 5 明确拒绝。主线客户端下载只发送 `pull-json-part`，不增加其他分支的兼容别名。离线转换器默认保留 schema3 JSON 输出，并通过 `--format jsonl-v4` 增加同构的 v4 JSONL 输出。

切换窗口的 fail-safe 行为是协议的一部分：首次 v4 推送后，未刷新的旧缓存页面会以旧全量 sha256 校验新的 Merkle checksum，因而在任何本地写入前失败；刷新页面即可读取 v4。不做服务端兼容垫片。远端一旦为 v4，回滚旧 Worker/客户端同样只能干净失败，恢复需使用 manifest 历史或由新客户端重新推送。

本次传输升级不改 `RPHubCharStore` 分键/index、E2b 持久化桥、pull 写闸门或 `RPHubDB`/`AICharGen` 本地结构，也不改 `app-update-*` 在线更新、更新槽 CAS、同步 manifest 历史与宽限 GC。

## 提交前不变量

一次更新只有同时满足以下条件才允许写入 app-update 槽：

- 角色保存模式替换至少 1 次。
- 角色装载模式替换至少 1 次。
- 持久化桥锚点命中并插入恰好 1 次。
- 全文不再含 `setStoredValue('characters', ...)`。
- 全文不再含 `getStoredValue('characters')`。
- 生成代码中至少各有一行非注释、可执行的 `await window.RPHubCharStore.saveAll(...)` 与 `loadAll()`；只在注释中命中不算适配成功。
- `RPH_R2_FLUSH_PERSISTENCE` 在生成代码中恰好出现 1 次。
- `saveData`、`saveChatHistoryNow` 和 `flushPendingChatHistorySave` 的失败结果能够传播到桥，`persistenceReturnSemantics` 必须为 1。
- `dbSetTo` 与 `dbDeleteFrom` 的 pull 延迟门禁各恰好 1 次；缺失或重复均拒绝更新。

任一条件失败，`patchRpHubAppJs()` 抛出 `RpHubAppPatchError`，错误码为 `RP_HUB_APP_PATCH_REJECTED`。Worker 返回“上游 <版本> 改动了角色卡存储接口，需人工适配后再更新”，并保持当前槽继续服务。

新 app-update manifest 会记录 `patchRevision`。缺少当前 revision 的旧槽不得覆盖 bundled 文件；同 tag/sha 但 revision 过期时不能返回 `alreadyUpToDate`，必须重新下载和打补丁。rollback 也只能启用 revision 匹配的历史槽。

app-update 的提交边界同样 fail closed：每次更新写入一个新的不可变版本槽，所有文件完成补丁和校验后才用 manifest ETag CAS 原子切换 current/previous 指针。提交前不删除旧槽；CAS 冲突或任意下载、补丁、R2 写入失败时清理新槽并继续服务旧 manifest。rollback 只交换已验证槽的指针。GitHub 完整文件列表读取失败时拒绝更新，不允许退回固定文件表；更新文件数上限为 32，所有 release/list/download 外部请求共享同一个每请求 50 次预算。

## RPHubCharStore 接口

`DB/char-store.js` 暴露冻结对象 `globalThis.RPHubCharStore`：

- `loadAll()`：按 index 顺序加载逐卡记录；index 不存在但旧数组存在时先原子迁移；两者均不存在返回 `null`。
- `saveAll(list)`：用“JSON 长度 + FNV-1a”内存哈希只重写变化的卡；成员或顺序变化时重写 index；删除角色只删除该角色记录，不动聊天和记忆键。
- `migrate()`：单个 readwrite 事务中写逐卡记录和 index，最后删除旧键；失败整体回滚。
- `waitForPendingMutations()`：仅供 bootstrap 在失败 pull 释放 deferred 写入后等待角色 mutationQueue 清空。
- `assertPushAllowed()`：等待当前 app.js 自检；发现未补丁角色保存调用时显示告警并阻止 push；fetch 失败按规格静默跳过。

缺 UUID 时使用 `crypto.randomUUID()` 并写回卡对象。重复 UUID 或无效卡会拒绝整个保存/迁移，不合并、不改写为另一份存档。单卡 JSON 长度超过 100MiB 时记录键名和大小后仍尝试 IndexedDB 写入，底层错误不吞掉。

## 人工适配流程

上游更新被拒时按以下顺序处理：

1. 用 `git show <tag>:assets/js/app.js` 取得原始上游文件，不在生成后的 app.js 上继续手改。
2. 查明新的角色保存、角色装载和 `manualSave`/持久化符号位置，确认语义仍可映射到 `RPHubCharStore` 与 E2b 桥。
3. 只修改 `DB/app-patches.mjs` 中对应模式、桥生成逻辑或返回契约加固锚点，并递增 `RP_HUB_APP_PATCH_REVISION`。
4. 更新 `tests/app-patches.test.mjs`，至少覆盖当前线上 tag、目标 tag、改名接口拒绝和锚点失效拒绝。
5. 运行 `node tests/run-all.mjs`。补丁数量不能作为唯一判断，必须同时通过不变量、生成 JS 语法、角色迁移、同步、Worker 更新拒绝和旧槽 revision 测试。
6. 更新 `_worker.js` 的 bundled 上游版本/commit 后运行 `node scripts/rebuild.mjs`，再执行一次全量测试。

不得通过放宽不变量、跳过验证或直接编辑生成 app.js 来解除更新拒绝。

## 明确不做

- 不引用任何废弃实验分支代码或其分片算法。
- 不改变 `rp-sync-jsonl-v1` / `schemaVersion: 4`，不引入 `rp-sync-jsonl-v2` / schemaVersion 5，不修改上述 checksum，且不把 `chunkerProfile` 纳入 checksum。
- 不删除 legacy `rp-sync-json-v3` 拉取路径；不把 schema3 恢复为新推送格式，也不做服务端 v3→v4 转换或 R2 对象迁移。
- 不改本地存储布局、`DB/char-store.js`、E2b 桥、pull 写闸门、`RPHubDB`/`AICharGen`。
- 不动 `app-update-*` 在线更新逻辑、CAS、manifest 历史、GC 或既有限额。
- 不引入图片 fork、图片端点、名字键/by-id 命名空间或图库逻辑。
- 不删除、合并或去重角色、聊天、记忆。
- 不引入 Durable Objects 或 Worker 逐记录解析。
- 不定制 `AICharGen`；`character/` 只随上游 tag 更新。
