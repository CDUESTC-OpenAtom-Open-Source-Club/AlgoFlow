# AlgoFlow Web 工作台

当前 Web 工作台使用 React + Vite + TypeScript，构建结果是可静态托管的浏览器应用。它不会改变 OpenHarmony 手机端的 ArkTS/ArkUI 原生边界。

```powershell
npm install
npm run dev
npm run build
```

UI 方向与 Web/ArkUI 对齐说明见 `docs/WEB_UI_GUIDE.md`。

Web IDE 与手机端功能的 CodeMirror 复现边界见 `IDE_CODEMIRROR_MATRIX.md`。

编辑器使用 CodeMirror 6（C++ 语言包、语法高亮、括号匹配、自动补括号、Tab 缩进/补全、撤销/重做、搜索、折叠和诊断）。当前提供关键字、STL 类型、代码片段和基础规则审查；同步和 AI 适配仍应遵守 `packages/contracts/schemas`，未配置 AI 时必须显示“AI 未启用”；当前同步服务仍是本地替换适配器，不代表已接入 OpenHarmony 或生产云端。`clangd`、`clang-tidy` 和本地编译尚未接入。
