// ==UserScript==
// @name         RPH 角色语音
// @namespace    https://github.com/ShirahaTobisa/RP-Hub
// @version      1.4.0
// @description  让回复里的人物用各自的声音说出台词，谁说的、用什么语气由 AI 分析。接 Fish Audio（官方或中转）或 OpenAI 格式的语音接口。
// @author       aphrissa
// @license      CC BY-NC 4.0
// @match        https://sta1n156.github.io/RP-Hub/*
// @noframes
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/ShirahaTobisa/RP-Hub/main/userscripts/character-voice.user.js
// @updateURL    https://raw.githubusercontent.com/ShirahaTobisa/RP-Hub/main/userscripts/character-voice.user.js
// ==/UserScript==
// 官方 RPH 用的油猴版「角色语音」，由 npm run build:modules 生成，别直接改：插件在 src/DB/modules/character-voice.js，外壳在 src/userscript/sdk.js。
// 插件或外壳改了，把上面的 @version 跟着插件版本号改，油猴才会推送更新。
