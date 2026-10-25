# AlgoFlow 算法随想

> 手机记思路，电脑接着写；AI 只帮你把自己的想法理清，不替你给答案。

AlgoFlow 是面向算法学习者的思路验证代码工作台：在 OpenHarmony / HarmonyOS 手机上随时记录思路、阅读和修改 C++ 代码，在电脑浏览器里继续编辑同一份草稿。AI 默认只做**忠实转换**——把用户当前的思路整理成伪代码或 C++ 片段，即使思路不完整或有错，也不擅自替换成标准答案。

参赛方向：2026 开源鸿蒙大学生创新大赛 · 赛道三。

## 核心功能

| 功能 | 说明 |
| --- | --- |
| 手机代码编辑器 | 首屏即可编辑的 `main.cpp`，带行号、当前行高亮和等宽字体；思路、短代码、复写在抽屉和底部工具栏中按需展开 |
| 手机与电脑同步 | Web「手机远程」生成一次性配对码 / 二维码，手机扫码或手输后双向同步；版本冲突保留服务器版本和本地副本，由用户选择，不静默覆盖 |
| 思路片段 | 思路按行拆成带稳定编号的片段，AI 输出的每一步都必须引用来源片段 |
| AI 忠实转换 | 输出伪代码或 C++ 局部片段，并列出假设、缺失信息和风险；新增算法步骤会被网关拒绝 |
| 隐藏与复写对比 | 隐藏 AI 结果后独立复写，再按步骤对比 |
| 服务卡片 | 桌面卡片显示最近草稿标题和同步状态，可一键新建思路、点击回到对应草稿 |
| 离线优先 | 草稿和待同步操作保存在本地（手机 RDB / 浏览器 localStorage），联网后再提交 |

四种 AI 模式（忠实转换、可行性分析、渐进提示、完整解题）互相隔离；当前 AI Gateway 只启用忠实转换，其余模式返回 `AI_MODE_NOT_AVAILABLE`。

## 当前状态

如实说明，避免误解：

- **应用市场版本仅本机可用**：不含云端服务，同步和 AI 需要用户自行提供可访问的 sync-api / AI Gateway 端点；上架包（Release）不显示任何 AI 入口。
- **AI 演示**：Debug 包保留 AI 功能，演示使用本地演示 Provider（只回显思路），尚未接入真实模型。
- **验证范围**：手机端在 HarmonyOS 模拟器（Mate 70 Pro，API 20）上完成本地验证，尚未做真机验证。
- **同步**：普通 HTTP push/pull，sync-api 为进程内存存储，适合局域网联调；不是 OpenHarmony 分布式能力，也不是生产云同步。
- **扫码配对**使用 HarmonyOS Scan Kit（系统扫码界面，不申请相机权限），属于 HarmonyOS 专有能力；不支持的设备可手输或粘贴配对码。

## 仓库结构

```text
AppScope/, entry/        DevEco Studio 工程（ArkTS + ArkUI，Stage 模型）：手机端与服务卡片
apps/web/                浏览器桌面工作台（React + Vite + TypeScript + CodeMirror 6）
apps/openharmony/        手机端说明文档
packages/contracts/      API JSON Schema、领域枚举和测试向量（各端唯一契约来源）
services/sync-api/       同步、冲突、版本和配对接口（Node 标准库）
services/ai-gateway/     AI 请求 / 产物契约校验与 Provider 调度（Node 标准库）
tests/                   手机端用例的 Node 测试（真实 ArkTS 源码 + SDK 替身）
docs/                    UI 指南、演示脚本、进度与设计记录
```

## 开发环境

| 项目 | 版本 |
| --- | --- |
| DevEco Studio | 6.0.0 Release（6.0.0.858） |
| SDK | API 20（6.0.0.47），`compatibleSdkVersion` / `targetSdkVersion` 为 `6.0.0(20)` |
| Node.js | 用于 Web、sync-api、AI Gateway 和测试 |

## 本地运行

在仓库根目录启动服务：

```bash
# 同步服务，默认 0.0.0.0:8787（SYNC_API_HOST / SYNC_API_PORT 可改）
node services/sync-api/src/server.mjs

# 可选：AI 联调用的演示 Gateway，监听 :8788，只回显思路，不是真实模型
PROVIDER=ok node run-demo-gateway.mjs
```

Web 工作台：

```bash
cd apps/web
npm install
npm run dev      # http://127.0.0.1:4173，/ai-api 代理到 127.0.0.1:8788
npm run build    # TypeScript 检查 + Vite 构建
```

`VITE_SYNC_API_BASE` 可覆盖同步地址（默认 `http://127.0.0.1:8787`）。

手机端：用 DevEco Studio 打开仓库根目录，构建并运行 `entry`。在「设置 → 连接电脑」中扫码、输入或粘贴 Web「手机远程」给出的配对码。真机不能使用 `127.0.0.1`，需要填写运行 sync-api 的电脑的局域网地址；模拟器可用 `hdc rport tcp:8787 tcp:8787` 转发。

## 测试

```bash
node --test services/ai-gateway/test/*.test.mjs services/sync-api/test/*.test.mjs
node --test tests/*.test.mjs apps/web/test/*.test.mjs
```

Node 手机端测试运行真实 ArkTS 源码加 SDK 替身，不等于设备验证；设备上的 RDB 测试位于 `entry/src/ohosTest`。

## 文档

- [`需求.md`](需求.md)：需求规格与范围
- [`AGENTS.md`](AGENTS.md)：开发规范、架构边界和测试门禁
- [`CONTEXT.md`](CONTEXT.md)：产品术语
- [`packages/contracts/README.md`](packages/contracts/README.md)：数据契约与同步语义
- [`docs/WEB_UI_GUIDE.md`](docs/WEB_UI_GUIDE.md)：Web / ArkUI 视觉规范
