# Web 工作台起步框架

这是无构建工具、无第三方依赖的浏览器工作台。它使用 `localStorage` 保存草稿和待同步操作，并通过本地同步服务连接 `services/sync-api`。

```powershell
python -m http.server 4173 --directory apps/web
node services/sync-api/src/server.mjs
```

浏览器打开 `http://127.0.0.1:4173`。没有启动同步服务时，编辑、离线队列和复写仍可工作；“同步”会明确提示服务不可用。
