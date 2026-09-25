# 本地服务起步框架

- `sync-api`：Node 标准库实现的本地版本控制同步适配器，监听 `127.0.0.1:8787`。
- `ai-gateway`：Node 标准库实现的 AI 契约校验和“AI 未启用”状态，监听 `127.0.0.1:8788`。

两者都不是生产云服务。未来接入华为云或真实模型时，保持 HTTP 契约和端口边界，另行评审认证、限流、审计、密钥和部署配置。

AI Gateway 端点：`/status`（能力状态）、`/requests`（忠实转换）、`/reviews`（解释/风险/复杂度审查）、`/completions`（光标附近局部补全）、`/artifacts/validate`（产物校验）。未配置 provider 时返回 `AI_NOT_ENABLED`；provider 调用异常、超时或网络失败统一返回 `502 AI_PROVIDER_ERROR`；provider 已返回但产物字段类型、范围或来源映射不符合契约时返回 `422 INVALID_AI_ARTIFACT`；未启用模式返回 `AI_MODE_NOT_AVAILABLE`。审查与补全结果均以独立结构返回，客户端可隐藏、接受或拒绝，不会覆盖用户原文。

IDE 请求和结果必须显式携带输出类型：`/reviews` 为 `output_kind: "review"`，`/completions` 为 `output_kind: "completion"`。每条诊断的 `range` 必填，对象表示具体范围，显式 `null` 表示全局建议。旧请求缺少输出类型时返回 `400 INVALID_REQUEST`；旧 Provider 结果缺少输出类型或诊断范围时返回 `422 INVALID_AI_ARTIFACT`。原 `/requests` 的 `pseudocode` / `code_snippet` 契约不变。

补全的替换范围必须包含光标（含端点），限制在光标所在行上下各 3 行、最多 7 行内，且不能覆盖整文件；建议文本最多 500 字符，只允许普通 C++ 局部片段，禁止宏、其他预处理指令、完整题解和 `main` 入口。越界或非法产物返回 `422 INVALID_AI_ARTIFACT`。

Gateway 在 Schema 类型校验后调用共享 `packages/contracts/cpp-fragment.mjs`，识别续行、注释和字面量后执行词法门禁；只运行 JSON Schema 不足以实现此门禁。注释／字符串中的 `main`、`#include` 不会因这些文本本身被拒绝；代码中的独立 `main` 标识符和不支持的转义写法采取保守拒绝。门禁不修改用户原文件，不是编译器或宏展开器，也不能仅凭来源 ID 判断任意算法是否忠实。详细边界及配套回滚见 [公共契约说明](../packages/contracts/README.md)。

issue #5 阶段 1 仅交付契约与 Gateway 门禁。测试专用联调入口、两端结果展示／本地保留及双端验收仍属后续阶段；真实 Provider 接入与模型行为评测已明确延期。普通入口仍不装配测试 Provider，无模型时合法请求返回 `503 AI_NOT_ENABLED`，不得将契约测试通过描述为真实模型或双端验收完成。
