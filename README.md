# RP-Hub 测试版

基于 [STA1N156/RP-Hub](https://github.com/STA1N156/RP-Hub) 的衍生版本。本仓库独立建立，不是 GitHub fork，提交历史与上游无关；上游页面以“底稿 + 在线更新”的方式使用，本仓库的代码集中在外壳 `_worker.js` 和覆盖层 `DB/`：R2 云同步、图片生成与管理、插件工坊、测试版自更新。更新分发端在独立仓库 [RP-Hub-Update-Mirror](https://github.com/ShirahaTobisa/RP-Hub-Update-Mirror)。

部署包自带打过补丁的上游 **1.9.8** 页面作为底稿；站点在「云同步 → 程序更新」拉取上游新版本后，由 R2 中的页面覆盖底稿。测试版本身按日期发版，见下方[测试版发版与一键更新](#测试版发版与一键更新)。当前状态见 [docs/CURRENT-STATE.md](docs/CURRENT-STATE.md)。

## 目录

| 路径 | 用途 |
| --- | --- |
| `_worker.js`、`DB/` | 同步、图片、工坊、导航适配、在线更新 |
| `index.html`、`assets/`、`character/`、`novel/` | 上游 1.9.8 页面底稿（`assets/js/app.js` 已打补丁） |
| `mirror/README.md` | 更新分发端独立仓库指引 |
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
```

主站生成 `dist/`，ZIP 输出到 `release/`。发布主站时使用 `dist/` 或主站 ZIP；不要上传整个源码目录。分发端在其独立仓库中测试和打包。

浏览器测试和历史测试的依赖见 [开发与测试](docs/DEVELOPMENT.md)。GitHub Actions 运行核心检查和主站打包检查，不包含自动部署。

## 测试版发版与一键更新

1. 推送日期标签（同一天第二版起加序号），标签说明就是更新说明：
   ```powershell
   git tag -a 2026.10.10 -m "更新说明"
   git push origin 2026.10.10
   ```
2. GitHub Actions 运行测试、打包，创建带部署包 `RP-Hub-<版本>.zip` 和发布包 `rph-bundle-<版本>.json` 的 Release。
3. 分发端每小时 7 分、37 分同步（也可在分发端后台「立即同步」）。
4. 站点在「云同步 → 测试版更新」选择版本：
   - 设置了 `CF_API_TOKEN` 的站点点「一键更新」，Worker 把发布包部署到自己所在的 Pages 项目，约半分钟生效，可「回退上一次部署」。
   - 其他站点点「下载部署包」，手动上传到 Cloudflare Pages。

一键更新需要的站点设置：

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `CF_API_TOKEN` | 密钥 | Cloudflare API 令牌，权限“帐户 → Cloudflare Pages → 编辑”，帐户资源只选站点所在帐户 |
| `CF_ACCOUNT_ID` | 变量 | 站点所在帐户的 ID；或者给令牌加“帐户设置 → 读取”权限，由 Worker 自己查 |

## 部署与数据

主站沿用 `wrangler.toml` 中的 Pages/R2 配置。新建站点时替换其中的项目名和 bucket 名，R2 binding 保持 `RP_SYNC_R2`；同步密码通过 Cloudflare 的 secret `RP_SYNC_PASSWORD` 设置。镜像服务的独立配置见 [mirror/README.md](mirror/README.md)。

已有云端快照可以直接拉取，**无需先上传**。拉取会用云端内容恢复当前浏览器数据；升级站点包时应继续使用原来的 R2 bucket 和同步设置。

本仓库包含 v4 分块同步，并保留旧 v3 快照读取。插件文件、启用状态及插件数据可以随快照恢复。插件可在[分发端投稿页](https://update.rph.mornye.uk/workshop/submit)投稿，审核上架后各站点在「模块管理 → 工坊」安装；接口说明见 [工坊开发指南](WORKSHOP-MOD-GUIDE.md)。

## 本地资料与来源

旧规格、审阅记录保存在本机 `archive/docs/`；历史发布包、浏览器证据、生成目录及本地密钥均不提交。父目录中的旧版本保留为历史测试基线，完整位置见本机父目录的 `PROJECT-INDEX.md`。

共享页面补丁说明见 [PATCHES.md](PATCHES.md)，模块职责见 [DB/README.md](DB/README.md)。旧重建工具依赖本机历史目录，日常打包请使用 `npm run build`。

保留上游 [CC BY-NC 4.0 许可证](LICENSE) 及原有署名。`DB/modules/` 中的插件源文件不进部署包；其中柳贯一插件是用户提供版本的适配代码，保留原来源信息，本仓库未另行确认其再分发授权。
