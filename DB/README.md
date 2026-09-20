# 主站覆盖层

这些文件由 `_worker.js` 注入页面，供静态底稿和经过共享补丁处理的在线更新页面共同使用。

| 文件 | 职责 |
| --- | --- |
| `nav-adapter.js` | 适配旧侧栏及 1.9.5 导航菜单，提供公共入口 |
| `char-store.js` | 角色分键保存与旧角色记录迁移 |
| `bootstrap.js` | 云端推拉、快照校验、恢复保护及程序更新 |
| `image-module.js` | 图片框、记录归属、生成与图片管理 |
| `module-loader.js` | 工坊安装文件、启用状态、插件 API 与数据持久化 |
| `modules/` | 随主线提供的插件文件 |
| `app-patches.mjs` | 上游 app.js 补丁的统一定义 |
| `styles.css` | 覆盖层样式 |

导航适配先于其他浏览器脚本加载。打包时会把共享补丁内联进 Worker，并根据资源内容生成缓存版本号；不要手动维护第二份补丁或修改生成后的 Worker。

主站通过 `RP_SYNC_R2` 访问 R2，`RP_SYNC_PASSWORD` 由部署环境设置。现有云端数据可以直接拉取，无需先上传；拉取按快照内容恢复浏览器中的同步数据。

部署使用根目录 `npm run build` 生成的 `dist/`，具体操作见 [项目说明](../README.md)。插件接口见 [工坊开发指南](../WORKSHOP-MOD-GUIDE.md)。
