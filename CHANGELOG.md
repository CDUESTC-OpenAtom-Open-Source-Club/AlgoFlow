# 契约变更说明（Change Log）

本目录是手机端、Web 工作台、同步 API、AI Gateway 的唯一事实来源。任何枚举、错误码、版本语义或 JSON 字段变化都必须先在此记录，并由另一名成员审查。

## 2026-08-25

### 变更概述
- 补齐 `CodeDocument` 实体与 `codeOrigin` 枚举（此前仅在架构文档中定义，未落入 Schema）。
- 在 `ai.schema.json` 中唯一定义 AI 相关错误码 `errorCode`。
- 明确 `request` 输入校验要求（`rule_version`、`language`、稳定 `idea_segment.id`）。
- 扩充契约向量：`ai-requests.json`（请求校验）、`ai-artifacts.json`（产物校验 + 来源交叉引用）。

### 明细

1. **`schemas/domain.schema.json`**
   - 新增 `$defs.codeOrigin`：`["user", "ai_faithful", "user_rewrite", "ai_hint", "ai_solution"]`。
   - 新增 `$defs.codeDocument`：实体含 `draft_id`、`origin`、`content`、`language`、`base_draft_version`。
   - 说明：OpenHarmony 端 `Models.ets#CodeOrigin` 与 Web 端 `storage.mjs` 的结构化 payload 均已对齐此枚举，无第二套含义。

2. **`schemas/ai.schema.json`**
   - 新增 `$defs.errorCode`：`AI_NOT_ENABLED` / `INVALID_REQUEST` / `MODE_VIOLATION` / `SOURCE_REF_MISSING` / `SOURCE_REF_UNKNOWN` / `ARTIFACT_INVALID` / `PROVIDER_ERROR` / `TIMEOUT`。
   - 错误码语义：
     - `MODE_VIOLATION`：忠实转换携带 `added_algorithm_steps`（越界偷加步骤）。
     - `SOURCE_REF_MISSING`：伪代码步骤缺少 `source_refs`。
     - `SOURCE_REF_UNKNOWN`：`source_refs` 引用了请求中不存在的片段。
     - `AI_NOT_ENABLED`：未配置模型或密钥无效。
     - `PROVIDER_ERROR` / `TIMEOUT`：供应商 5xx / 超时。

3. **`vectors/`**
   - 新增 `ai-requests.json`（≥15 条请求校验向量）。
   - 扩充 `ai-artifacts.json`（≥30 条产物校验向量，含来源交叉引用）。

### 双端同步要求
- OpenHarmony：`entry/src/main/ets/domain/AIContractGuard.ets` 的越界语义与 `MODE_VIOLATION` / `SOURCE_REF_MISSING` / `SOURCE_REF_UNKNOWN` 对应；解析器（`AIResult` 等）无需改动。
- Web：AI 区域目前只显示 `AI 未启用`，错误码尚未接入渲染层（待后续接入，见 Workflow B 遗留项）。
