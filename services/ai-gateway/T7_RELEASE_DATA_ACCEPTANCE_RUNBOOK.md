# T7 正常交付配置验收手册

本手册只记录 issue #5 阶段五 T7 的工程准备和可重复命令。测试 Provider 返回的是“测试数据”，不代表真实模型效果；不得使用用户现有草稿或生产数据库。

## 验收边界

- Debug 允许测试数据的前提是客户端显式开启测试开关，并且响应带有 `X-AlgoFlow-Test-Data: true`。
- Release/正常配置只接受普通 Provider 响应；带测试响应头的响应必须变成 `503 AI_NOT_ENABLED`，不得落入正常缓存。
- 测试数据只能由响应头识别，不能由 `model_id`、URL、请求内容或错误文案推断。
- 未配置 Provider 时，`/status` 与 `/requests`、`/reviews`、`/completions` 分别报告 `AI_NOT_ENABLED`；客户端不得回退到测试 Provider。
- 测试结果与正常结果按独立缓存分区保存。Release 不加载测试分区，也不写入测试分区。

## 可重复工程验证

在仓库根目录执行：

```powershell
node --test apps/web/test/*.test.mjs services/ai-gateway/test/*.test.mjs services/sync-api/test/*.test.mjs tests/phone-ai.test.mjs
git diff --check
```

在 `apps/web` 执行，故意设置测试开关以验证生产编译仍关闭测试数据：

```powershell
$env:VITE_AI_ALLOW_TEST_DATA='true'
npm run build
```

构建产物仍由 `import.meta.env.DEV === true` 门禁控制；生产构建的 `DEV` 为 false。发布候选不得复用 `dist` 中的测试缓存，也不得把测试 Provider 作为 `/ai-api` 的后备地址。

手机工程使用锁定的 API 20 工具链构建 Release 和独立 `entry@ohosTest` Debug HAP。Release 构建必须确认 `BuildProfile.DEBUG=false`；未配置签名时只记录“未签名构建”，不能宣称设备验收。

## 结果记录模板

记录命令、Node/DevEco 版本、commit、通过/失败数量和脱敏请求 ID。不要记录完整代码、思路、模型密钥或生产数据。

| 检查项 | 工程证据 | 设备状态 |
| --- | --- | --- |
| Web Release 拒绝测试响应 | `ai-client.test.mjs`，响应头标记时返回 `AI_NOT_ENABLED` | 待设备/静态发布环境 |
| Web 测试/正常缓存隔离 | `ai-result-storage.test.mjs` | 待设备/静态发布环境 |
| 手机 Release 拒绝测试响应 | `tests/phone-ai.test.mjs`，`DEBUG=false` 门禁 | `hdc list targets` 为空时保持待验 |
| 手机测试缓存隔离 | `RdbAIResultRepository` Node 替身测试与 HAP 编译 | 真实 RDB 待验 |
| 无 Provider 不可用 | Gateway 合同测试三端点 | 真实部署待验 |

## 当前阶段结论

工程门禁和替身回归通过后，可标记 T7“工程准备完成”。没有可安装手机、真实 RDB、生产静态托管和真实 Provider 证据时，T7、阶段五和 issue #5 整体仍保持未完成；不修改或合并 `main`，不推送，也不配置正式签名或云服务。
