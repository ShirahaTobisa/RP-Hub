# 更新分发端已迁出

分发端现在由独立公开仓库 [ShirahaTobisa/RP-Hub-Update-Mirror](https://github.com/ShirahaTobisa/RP-Hub-Update-Mirror) 维护。

本地项目位于 `project/RP-Hub-Update-Mirror/`，与 `project/RP-Hub/` 并列。主站继续使用 `https://update.rph.mornye.uk`，接口和数据格式保持原样。

分发端源码、配置、测试和打包脚本均已迁出。主站中的镜像客户端与其回归测试仍保留；分发端的新功能请在独立仓库修改。

迁出前的源码可在本仓库提交 `3257d7c1d7bf5f032700bedba9fffb89f1eeccac` 中查到，本机也留有 `archive/mirror-split-20260921/` 备份。
