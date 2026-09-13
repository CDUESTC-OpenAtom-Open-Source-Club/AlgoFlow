# 本地服务起步框架

- `sync-api`：Node 标准库实现的本地版本控制同步适配器，监听 `127.0.0.1:8787`。
- `ai-gateway`：Node 标准库实现的 AI 契约校验和“AI 未启用”状态，监听 `127.0.0.1:8788`。

两者都不是生产云服务。未来接入华为云或真实模型时，保持 HTTP 契约和端口边界，另行评审认证、限流、审计、密钥和部署配置。

AI Gateway 端点：`/status`（能力状态）、`/requests`（忠实转换）、`/reviews`（解释/风险/复杂度审查）、`/completions`（光标附近局部补全）、`/artifacts/validate`（产物校验）。未配置 provider 时返回 `AI_NOT_ENABLED`，provider 异常返回 `AI_PROVIDER_ERROR`，超时返回 `AI_PROVIDER_TIMEOUT`，产物不符合契约返回 `INVALID_AI_ARTIFACT`，未启用模式返回 `AI_MODE_NOT_AVAILABLE`。审查与补全结果均以独立结构返回，客户端可隐藏、接受或拒绝，不会覆盖用户原文。
