# T5 取消与迟到响应验收准备

本手册对应需求单中的 T5：设备取消及迟到响应不能恢复写入权限。当前只交付工程准备和可重复的 Node 回归；`hdc list targets` 无设备，因此不标记设备验收通过。

## 验收边界

- 客户端取消、代码/思路编辑、切换草稿/文件/模式、离开页面和新请求都会使旧代次失效。
- 每个用户操作只发起一次 Provider 请求；失败不会隐式重试，用户必须主动重新请求。
- 迟到成功或失败只能结束旧请求，不能恢复局部补全的接受权限，也不能覆盖较新的结果。
- 客户端主动取消与 Gateway 服务端超时分开记录：前者不写响应，后者返回 `502 AI_PROVIDER_ERROR`；Provider 产物字段、来源或范围不符合契约时返回 `422 INVALID_AI_ARTIFACT`。

## 可执行准备验证

在仓库根目录执行：

```powershell
node --test apps/web/test/*.test.mjs services/ai-gateway/test/*.test.mjs services/sync-api/test/*.test.mjs tests/phone-ai.test.mjs
git diff --check
```

覆盖证据包括：手机会话的取消/切换/新请求竞态、单次底层请求、迟到成功/失败不可接受；Gateway 三类能力的客户端断开 `AbortSignal`、超时中止 Provider 并返回 502、非法产物返回 422。

## 设备执行前置与记录格式

设备执行需要 API 20 可安装 HAP、授权的调试安装条件、手机与本地 Gateway 的局域网地址，以及独立测试草稿。每条用例记录请求代次、Provider `request_started`/`request_aborted`、页面状态和接受按钮状态；不得记录完整代码、思路或凭据。

必须逐项执行取消、编辑、切稿、切文件、切模式、离开页面和新请求，并在每项之后发送迟到成功与迟到失败回调，确认结果保持过期且不可接受。没有设备或原生 HTTP 日志时，只能写“工程准备完成、设备待验”。

## 当前状态

- Gateway 到 Provider 的本地取消与超时中止由 Node 回归覆盖。
- ArkTS 会话和原生 HTTP 取消由 Node 类型转换测试覆盖；这不是设备或真实 RDB 验证。
- 当前无设备、无签名安装、未接入真实 Provider；手机端到 Provider 的端到端取消证据待设备条件满足后补录。
