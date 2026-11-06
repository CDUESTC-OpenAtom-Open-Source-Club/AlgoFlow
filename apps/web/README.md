# AlgoFlow Web 工作台

当前 Web 工作台使用 React + Vite + TypeScript，构建结果是可静态托管的浏览器应用。它不会改变 OpenHarmony 手机端的 ArkTS/ArkUI 原生边界。

```powershell
npm install
npm run dev
npm run build
```

UI 方向与 Web/ArkUI 对齐说明见 `docs/WEB_UI_GUIDE.md`。

## 构建开关

开关集中在 `src/site-config.mjs`，只控制界面显示，同步、存储和 AI 逻辑不变。

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `VITE_SYNC_API_BASE` | `http://127.0.0.1:8787` | 本地构建的 sync-api 地址；上线构建忽略它，改用页面自身的 origin |
| `VITE_HOSTED` | 关 | `true` 为上线构建：网页与 `/v1` 同域，隐藏局域网步骤、连接通道切换和端点表单；用户在「手机远程」点「同意并开启」前不发同步请求 |
| `VITE_AI_ENTRY` | 开 | `false` 隐藏 AI 面板、模式标签与切换、复写对比和 AI 检查卡片，对应手机端的 `AI_ENTRY` |
| `VITE_ICP_RECORD` | 空 | 页脚显示的备案号，链接到工信部备案系统 |
| `VITE_PRIVACY_URL` | 空 | 页脚和开启说明里的隐私政策链接 |

上线构建：

```powershell
$env:VITE_ICP_RECORD = '<备案号>'
$env:VITE_PRIVACY_URL = '<隐私政策地址>'
npm run build -- --mode hosted
```

`--mode hosted` 读取 `.env.hosted`（只含 `VITE_HOSTED=true` 和 `VITE_AI_ENTRY=false`）。备案号和隐私政策地址属于部署值，构建时传入，不写进仓库；`.env*.local` 已被忽略。公共同步服务器尚未上线，上线构建目前只在本机用 `node test/acceptance-server.mjs` 做同域验证，不代表已提供云同步。

AI 请求默认使用同源 `/ai-api` 路径。开发时由 Vite 代理到本机 Gateway；可用 `ALGFLOW_AI_GATEWAY_TARGET` 指向受控的本地联调地址。测试 Provider 必须同时显式设置 `VITE_AI_ALLOW_TEST_DATA=true`，响应会以“测试数据”标记并写入独立本地缓存。生产配置不会读取测试分区，也不会回退到测试 Provider；生产反向代理和真实模型接入仍需单独配置。

AI 审查会话按 `explanation`、`risk`、`complexity` 分别保留最近结果，当前会话可追加多条消息。刷新恢复的结果会标记为过期，只能查看；本地缓存损坏或空间不足时显示恢复提示，不清空工作区。局部补全必须在预览后由用户确认，确认生成可撤销的编辑器事务，随后仍需手动保存和同步。

Web IDE 与手机端功能的 CodeMirror 复现边界见 `IDE_CODEMIRROR_MATRIX.md`。

编辑器使用 CodeMirror 6（C++ 语言包、语法高亮、括号匹配、自动补括号、Tab 缩进/补全、撤销/重做、搜索、折叠和诊断）。当前提供关键字、STL 类型、代码片段和基础规则审查；同步和 AI 适配仍应遵守 `packages/contracts/schemas`，未配置 AI 时必须显示“AI 未启用”；当前同步服务是本机/局域网 sync-api，手机端已通过同一契约双向同步，但不代表已接入生产云端。`clangd`、`clang-tidy` 和本地编译尚未接入。
