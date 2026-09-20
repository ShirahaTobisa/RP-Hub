# RP-Hub · R2 主线

本仓库保存 `R2-rebuild-v4-img` 当前主线：R2 云同步、图片生成与管理、工坊插件，以及独立的更新镜像服务。

上游项目：[STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub)。静态页面以 **1.7.5** 为底稿；站点在线更新后，由 R2 中的新页面覆盖静态底稿。当前覆盖层已对 **1.9.5** 验收，不能把仓库中的静态页面当成 1.9.5 源码。

当前代码包含 2026-09-20 的图片正文编辑修复：修改普通文字时保留原图和重生成后的选择，恢复能够唯一确认的旧空框，处理聊天分支中的图片归属。详见 [当前状态](docs/CURRENT-STATE.md)。

## 目录

| 路径 | 用途 |
| --- | --- |
| `_worker.js`、`DB/` | 同步、图片、工坊、导航适配、在线更新 |
| `index.html`、`assets/`、`character/` | 静态页面底稿 |
| `mirror/` | 独立部署的上游更新镜像服务 |
| `scripts/`、`tests/` | 打包、辅助工具与测试 |
| `examples/` | 工坊插件示例 |
| `docs/` | 当前状态与开发说明 |

## 本地检查与打包

已验证环境：Windows、PowerShell、Node.js 22.22.2。ZIP 打包脚本使用 Windows PowerShell。

```powershell
npm ci
npm test
npm run test:package
npm run build
npm run build:mirror
```

主站生成 `dist/`，镜像服务生成 `dist-mirror/`，两者的 ZIP 都输出到 `release/`。发布主站时使用 `dist/` 或主站 ZIP；不要上传整个源码目录。

浏览器测试和历史测试的依赖见 [开发与测试](docs/DEVELOPMENT.md)。GitHub Actions 运行核心检查和两份打包检查，不包含自动部署。

## 部署与数据

主站沿用 `wrangler.toml` 中的 Pages/R2 配置。新建站点时替换其中的项目名和 bucket 名，R2 binding 保持 `RP_SYNC_R2`；同步密码通过 Cloudflare 的 secret `RP_SYNC_PASSWORD` 设置。镜像服务的独立配置见 [mirror/README.md](mirror/README.md)。

已有云端快照可以直接拉取，**无需先上传**。拉取会用云端内容恢复当前浏览器数据；升级站点包时应继续使用原来的 R2 bucket 和同步设置。

本仓库包含 v4 分块同步，并保留旧 v3 快照读取。插件文件、启用状态及插件数据可以随快照恢复，插件说明见 [工坊开发指南](WORKSHOP-MOD-GUIDE.md)。

## 本地资料与来源

旧规格、审阅记录保存在本机 `archive/docs/`；历史发布包、浏览器证据、生成目录及本地密钥均不提交。父目录中的旧版本保留为历史测试基线，完整位置见本机父目录的 `PROJECT-INDEX.md`。

共享页面补丁说明见 [PATCHES.md](PATCHES.md)，模块职责见 [DB/README.md](DB/README.md)。旧重建工具依赖本机历史目录，日常打包请使用 `npm run build`。

保留上游 [CC BY-NC 4.0 许可证](LICENSE) 及原有署名。仓库内柳贯一插件为用户提供版本的适配代码，保留原来源信息；本仓库未另行确认第三方插件的再分发授权。
