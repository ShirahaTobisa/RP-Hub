# 开发与测试

使用 Node.js 22.22.2 和 Windows PowerShell。先执行 `npm ci` 安装锁定的开发依赖。

## 日常命令

| 命令 | 范围 |
| --- | --- |
| `npm test` | 当前主线的 13 个独立测试脚本：图片编辑与归属、权限、同步约束、离线转换、测试版自更新、公告可跳过、静态文件缓存、生图设置与存储清理 |
| `npm run test:package` | 主站打包内容、资源版本、ZIP 完整性 |
| `npm run test:browser` | 工坊 API、插件云同步、图片编辑的浏览器测试 |
| `npm run build` | 生成主站 dist 和 ZIP |
| `npm run test:history` | 旧综合入口，依赖本机历史资料，供历史版本复核 |

首次运行浏览器测试前：

```powershell
npx playwright install chromium
npm run test:browser
```

浏览器默认使用 Playwright 下载的 Chromium，可用 `CHROME_PATH` 指定浏览器路径。插件 API、插件云同步和图片编辑测试默认使用分发端已收录的最新上游页面，上游发新版本、分发端收录后自动跟上，不用改代码；设置 `RPH_UPSTREAM_DIR` 指向其他上游版本的源码目录（如准备好的 1.9.5，或本地上游仓库），可检查测试版在其他版本上的兼容性。测试在临时浏览器环境中使用模拟数据，不连接生产站点。

浏览器测试准备脚本从分发端下载最新正式版本的页面，按分发端清单逐个核对 SHA-256，放在 `evidence/sync-195/upstream/latest/`（版本记在 `.fixture.json`，没变就跳过，分发端连不上时沿用上次的版本）；另从上游下载固定 commit 的 1.9.5 作旧版对照。`RPH_MIRROR_BASE` 可改分发端地址。页面依赖上游的公开 CDN 脚本，运行时需联网。旧图片匹配记录使用 `tests/fixtures/image-edit-legacy.json`，来自隔离测试的模拟数据。

## 性能基准

`node tests/perf-streaming.runner.mjs [--tokens 400] [--interval 25] [--runs 3]` 在真实页面上模拟 AI 逐字输出，分三组比较：只有角色分键存储的原版页面、加载全部覆盖层、再装上「输入转 advice」插件。输出页面打开到聊天记录显示的时间、脚本和主线程耗时、长任务、生图扫描次数、各 MutationObserver 回调的调用次数和耗时，以及按脚本文件汇总的 CPU 采样。它不是通过/失败测试，改动可能影响性能时前后各跑一次对比。

## 历史资料

旧综合测试入口保留用于追溯，并不等同于当前默认验收。其中部分脚本依赖兄弟目录的 `R2`、`R2-rebuild-pics`、上游 Git 历史、旧发布 ZIP、对照证据或本地浏览器。个别测试还锁定了历史版本源码的哈希，不能直接套用到当前主线。新的检出目录不具备这些资料。

`scripts/rebuild.mjs` 同样是历史重建工具，会读取兄弟目录；它不是当前主线的常规构建命令。日常使用 `npm run build` 即可。

## 维护约定

- 主站运行代码主要在 `DB/`、`_worker.js`。共享 app.js 补丁统一写在 `DB/app-patches.mjs`；分发端在 [独立仓库](https://github.com/ShirahaTobisa/RP-Hub-Update-Mirror) 维护同版本的副本。
- `dist/` 为生成目录，修改源码后重新打包。
- 不提交生产数据、密钥、浏览器 profile、发布 ZIP 或测试证据。
- `.gitattributes` 保留文件原始字节，避免 Git 换行转换改变既有发布校验值。
- CI 使用 Windows，只运行核心测试及主站打包检查。浏览器与历史复核单独运行；CI 不持有部署密钥。
