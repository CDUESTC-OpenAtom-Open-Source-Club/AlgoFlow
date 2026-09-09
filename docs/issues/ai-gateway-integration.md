# [AI] 接入 OpenHarmony 端 AI Gateway 与模式隔离工作流

## 背景

OpenHarmony 端已经展示 AI 模式选择，但 AI Gateway 尚未接入，当前不能生成 Mock 结果，也不能把占位页面描述为可用的 AI 功能。项目要求默认忠实转换，并保留思路片段来源映射和不同模式之间的结果隔离。

## 目标

- 接入与 Web 共用的 AI Gateway 请求和响应契约。
- 支持 `faithful_transform` 的思路片段、来源映射、版本和可见性字段。
- 对未配置模型、供应商异常、超时、契约校验失败和模式不可用返回可操作错误。
- 将 `progressive_hint`、`full_solution` 等未配置模式保持为显式不可用，不自动升级模式。

## 当前实现

- OH 端 AI 入口保留为占位页面，显示“AI Gateway 尚未接入”。
- `Index.ets` 中已有模式状态和结果隐藏状态，但没有发起 AI 请求的客户端用例。
- 不使用 Mock 结果，不在客户端保存团队模型密钥。

## 验收标准

- [ ] 请求包含 `problem_context`、`mode`、`draft_id`、`draft_version`、`language`、`rule_version`、`idea_segments`、`output_kind` 和 `visibility`。
- [ ] 每个忠实转换伪代码步骤都有合法 `source_refs`，越权新增步骤被拒绝。
- [ ] AI 结果与用户思路、独立复写和其他模式结果分开保存。
- [ ] 未配置 Provider 返回 `AI_NOT_ENABLED`，Provider 异常返回 `AI_PROVIDER_ERROR`，非法产物返回 `INVALID_AI_ARTIFACT`。
- [ ] 支持取消、超时、重试上限、离线恢复和失败提示。
- [ ] 完成至少 40 条 AI 契约测试，并在 OH 与 Web 端验证模式隔离。

## 非目标

- 不在手机本地执行任意 C++ 代码。
- 不在客户端携带供应商密钥或模板实现。
- 不把 AI 结果回写为用户原思路，也不默认生成完整题解。
