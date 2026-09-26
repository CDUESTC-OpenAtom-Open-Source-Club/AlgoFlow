# AlgoFlow Web 工作台

当前 Web 工作台使用 React + Vite + TypeScript，构建结果是可静态托管的浏览器应用。它不会改变 OpenHarmony 手机端的 ArkTS/ArkUI 原生边界。

```powershell
npm install
npm run dev
npm run build
```

UI 方向与 Web/ArkUI 对齐说明见 `docs/WEB_UI_GUIDE.md`。

AI 请求默认使用同源 `/ai-api` 路径。开发时由 Vite 代理到本机 Gateway；可用 `ALGFLOW_AI_GATEWAY_TARGET` 指向受控的本地联调地址。测试 Provider 必须同时显式设置 `VITE_AI_ALLOW_TEST_DATA=true`，响应会以“测试数据”标记并写入独立本地缓存。生产配置不会读取测试分区，也不会回退到测试 Provider；生产反向代理和真实模型接入仍需单独配置。

AI 审查会话按 `explanation`、`risk`、`complexity` 分别保留最近结果，当前会话可追加多条消息。刷新恢复的结果会标记为过期，只能查看；本地缓存损坏或空间不足时显示恢复提示，不清空工作区。局部补全必须在预览后由用户确认，确认生成可撤销的编辑器事务，随后仍需手动保存和同步。

Web IDE 与手机端功能的 CodeMirror 复现边界见 `IDE_CODEMIRROR_MATRIX.md`。

编辑器使用 CodeMirror 6（C++ 语言包、语法高亮、括号匹配、自动补括号、Tab 缩进/补全、撤销/重做、搜索、折叠和诊断）。当前提供关键字、STL 类型、代码片段和基础规则审查；同步和 AI 适配仍应遵守 `packages/contracts/schemas`，未配置 AI 时必须显示“AI 未启用”；当前同步服务仍是本地替换适配器，不代表已接入 OpenHarmony 或生产云端。`clangd`、`clang-tidy` 和本地编译尚未接入。
