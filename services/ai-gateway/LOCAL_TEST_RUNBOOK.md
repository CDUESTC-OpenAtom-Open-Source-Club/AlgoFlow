# 本地 AI 联调准备

本手册只用于隔离测试数据和本地服务联调，不接入真实模型、云服务或用户现有草稿。测试响应带有 `X-AlgoFlow-Test-Data: true`，发布配置必须拒绝该响应和测试缓存。

## 启动

在仓库根目录打开两个 PowerShell 窗口。使用未被占用的端口；下面的 `8789` 和 `8787` 是示例。

窗口 A，启动独立测试 Provider：

```powershell
$env:ALGFLOW_TEST_AI_HOST = '127.0.0.1'
$env:ALGFLOW_TEST_AI_PORT = '8789'
$env:ALGFLOW_TEST_AI_SCENARIO = 'delay'
$env:ALGFLOW_TEST_AI_TIMEOUT_MS = '30000'
node services/ai-gateway/test-provider.mjs
```

可选场景为 `success`、`empty`、`invalid`、`delay`、`failure`。`delay` 用于取消竞态；Provider 日志只记录能力、调用代次、隔离草稿 ID 和阶段，不记录代码或思路。

窗口 B，启动本地 sync-api：

```powershell
$env:SYNC_API_HOST = '127.0.0.1'
$env:SYNC_API_PORT = '8787'
node services/sync-api/src/server.mjs
```

Web 端使用 `http://127.0.0.1:8787`，AI 测试入口使用 `http://127.0.0.1:8789`。手机联调不能使用 `127.0.0.1`，必须把两个服务显式绑定到受控局域网地址，并在手机端填入运行服务电脑的局域网 IP；本阶段不宣称已完成手机链路。

## 隔离草稿与取消证据

每次联调使用新的草稿 ID，例如 `t3-isolated-20260927-01`，不要打开或上传用户现有草稿。请求开始、客户端断开和 Provider 中止必须按以下关联证据记录：

1. Gateway 测试日志中的端点和请求阶段。
2. 测试 Provider 的 `request_started` 与 `request_aborted`，两者 `capability`、`call_id` 和 `draft_id` 对应。
3. 客户端显示取消或连接关闭，且没有成功结果写入。

使用 Web 或 `curl` 发起 `delay` 请求后，在响应返回前取消连接；PowerShell 进程退出或浏览器取消均可作为客户端断开。只有 Provider 日志出现 `request_aborted` 才算观察到下游 `AbortSignal`，不能凭 UI 的“请求已取消”单独判定。

## 清理

停止窗口 A/B 的 Node 进程（`Ctrl+C`）。测试 Provider 不写生产数据库；sync-api 只使用进程内存储，停止后测试草稿即丢弃。不要删除或替换用户数据库来清理测试数据。

本准备环境仍不覆盖真实 Provider、手机原生取消、真实 RDB、设备安装、签名或云部署；这些项目保持待验。
