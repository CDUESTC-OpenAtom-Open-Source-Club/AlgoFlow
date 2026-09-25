# 本地服务起步框架

- `sync-api`：Node 标准库实现的本地版本控制同步适配器，监听 `127.0.0.1:8787`。
- `ai-gateway`：Node 标准库实现的 AI 契约校验和“AI 未启用”状态，监听 `127.0.0.1:8788`。

两者都不是生产云服务。未来接入华为云或真实模型时，保持 HTTP 契约和端口边界，另行评审认证、限流、审计、密钥和部署配置。

AI Gateway 端点：`/status`（能力状态）、`/requests`（忠实转换）、`/reviews`（解释/风险/复杂度审查）、`/completions`（光标附近局部补全）、`/artifacts/validate`（产物校验）。未配置 provider 时返回 `AI_NOT_ENABLED`；provider 调用异常、超时或网络失败统一返回 `502 AI_PROVIDER_ERROR`；provider 已返回但产物字段类型、范围或来源映射不符合契约时返回 `422 INVALID_AI_ARTIFACT`；未启用模式返回 `AI_MODE_NOT_AVAILABLE`。审查与补全结果均以独立结构返回，客户端可隐藏、接受或拒绝，不会覆盖用户原文。

IDE 请求和结果必须显式携带输出类型：`/reviews` 为 `output_kind: "review"`，`/completions` 为 `output_kind: "completion"`。每条诊断的 `range` 必填，对象表示具体范围，显式 `null` 表示全局建议。旧请求缺少输出类型时返回 `400 INVALID_REQUEST`；旧 Provider 结果缺少输出类型或诊断范围时返回 `422 INVALID_AI_ARTIFACT`。原 `/requests` 的 `pseudocode` / `code_snippet` 契约不变。

补全的替换范围必须包含光标（含端点），限制在光标所在行上下各 3 行、最多 7 行内，且不能覆盖整文件；建议文本最多 500 字符，只允许普通 C++ 局部片段，禁止宏、其他预处理指令、完整题解和 `main` 入口。越界或非法产物返回 `422 INVALID_AI_ARTIFACT`。

Gateway 在 Schema 类型校验后调用共享 `packages/contracts/cpp-fragment.mjs`，识别续行、注释和字面量后执行词法门禁；只运行 JSON Schema 不足以实现此门禁。注释／字符串中的 `main`、`#include` 不会因这些文本本身被拒绝；代码中的独立 `main` 标识符和不支持的转义写法采取保守拒绝。门禁不修改用户原文件，不是编译器或宏展开器，也不能仅凭来源 ID 判断任意算法是否忠实。详细边界及配套回滚见 [公共契约说明](../packages/contracts/README.md)。

issue #5 阶段 1 仅交付契约与 Gateway 门禁。阶段 2 提供独立 `services/ai-gateway/test-provider.mjs` 测试入口，必须通过显式环境变量选择场景／host／port，普通入口不会装配测试 Provider。测试入口响应带 `X-AlgoFlow-Test-Data: true`，客户端应将其识别为“测试数据”并在后续阶段本地保留来源标记；该标识不进入公共结果 Schema。请求断开会触发 Provider `AbortSignal`，断开后不再写响应；服务端主动超时仍返回 `502 AI_PROVIDER_ERROR`。

测试入口只用于本地协议联调，不证明真实模型效果。真实 Provider、两端结果展示／本地保留及双端验收仍属后续阶段；无模型的普通入口返回 `503 AI_NOT_ENABLED`。
