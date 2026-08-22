# AlgoFlow Web 工作台

当前 Web 工作台使用 React + Vite + TypeScript，构建结果是可静态托管的浏览器应用。它不会改变 OpenHarmony 手机端的 ArkTS/ArkUI 原生边界。

```powershell
npm install
npm run dev
npm run build
```

UI 方向与 Web/ArkUI 对齐说明见 `docs/WEB_UI_GUIDE.md`。

目前为 UI 重写阶段：同步和 AI 适配仍应遵守 `packages/contracts/schemas`，未配置 AI 时必须显示“AI 未启用”。
