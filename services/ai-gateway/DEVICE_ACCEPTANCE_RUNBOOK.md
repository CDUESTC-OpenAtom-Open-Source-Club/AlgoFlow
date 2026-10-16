# OpenHarmony T4 设备验收准备

本文是阶段五 T4 的执行准备，不是设备验收结果。当前环境没有连接设备，`hdc list targets` 返回空列表；以下步骤只有在 API 20、开发安装授权和受控局域网服务准备好后才能执行。

## 固定环境

- DevEco Studio `6.0.0`，OpenHarmony SDK/API `20`，工程分支 `pr18`。
- 使用隔离测试数据库名 `algoflow_t4_<timestamp>.db`，禁止使用用户工作区数据库。
- 测试响应只来自本地 `test-provider.mjs`，响应带 `X-AlgoFlow-Test-Data: true`；正式配置不得加载测试缓存。
- 手机不能把 `127.0.0.1` 当作电脑地址。Gateway 和 sync-api 绑定到受控局域网地址后，在手机端填写电脑局域网 IP。

## 构建与安装前检查

在仓库根目录执行：

```powershell
$env:DEVECO_SDK_HOME = 'C:\Program Files\Huawei\DevEco Studio\sdk'
$env:JAVA_HOME = 'C:\Program Files\Huawei\DevEco Studio\jbr'
& 'C:\Program Files\Huawei\DevEco Studio\tools\node\node.exe' 'C:\Program Files\Huawei\DevEco Studio\tools\hvigor\bin\hvigorw.js' --mode module -p product=default -p module=entry@ohosTest -p buildMode=debug assembleHap --no-daemon
hdc list targets
```

记录 API 版本、runtimeOS、设备型号、系统版本、`hdc` 目标序列号、安装结果和是否使用开发签名。没有设备或签名时只记录构建成功，不能填写安装或设备通过。

## 执行矩阵

每项填写“通过 / 失败 / 未执行”、时间、设备序列号和证据路径：

| 编号 | 场景 | 通过条件 |
| --- | --- | --- |
| T4-01 | 首次建库 | 独立库创建为 v3，草稿和同步表存在 |
| T4-02 | v1→v3 | 草稿、`short_code`、思路片段、待同步 operation、游标和冲突副本内容不变；创建 `ai_results` 并完成 v3 结果结构 |
| T4-02a | PR #23 v2→v3 | `ai_artifacts_json` 保留并导入独立 `ai_results`，重复启动不重复导入 |
| T4-03 | 升级失败重试 | v1→v2 或 v2→v3 失败后，版本号保持升级前版本（v1 或 v2），普通表和旧 AI 结果数据保留；修复原因后重试成功 |
| T4-04 | 进程重启恢复 | 最近结果、隐藏状态和测试标记恢复；loading 结果变为取消且只读过期 |
| T4-05 | 三类审查 | explanation/risk/complexity 可追加显示；仅保留每类最近持久化结果 |
| T4-06 | 补全接受 | 只修改 `main.cpp`，明确接受前有预览；拒绝/隐藏/过期结果不写文件 |
| T4-07 | 短代码隔离 | 接受补全前后的独立短代码内容完全一致 |
| T4-08 | 撤回保护 | 未继续编辑、未切换草稿/文件、未重启且内容仍匹配时可撤回；任一变化后撤回按钮禁用 |
| T4-09 | 删除清理 | 草稿删除或远端墓碑应用后，关联 `ai_results` 清理，普通同步载荷不包含 AI 结果 |
| T4-10 | 损坏/写入失败 | 错误可见并可重试，原草稿和数据库不被删除 |

## 证据要求

Hypium 结果、应用日志和 Gateway 取消日志分别保存。Node 替身测试、HAP 构建和 Previewer 只能作为准备证据，不能代替真实 RDB 或手机输入/滚动/接受/撤回/进程重启结果。完成 T4 前不得将阶段五或 issue #5 标为整体完成。

## 2026-10-16 自动化执行记录

- Node.js `v24.14.1` / Windows PowerShell：执行 `node --test --test-reporter=tap apps/web/test/*.test.mjs services/ai-gateway/test/*.test.mjs services/sync-api/test/*.test.mjs tests/phone-ai.test.mjs`，**636/636 通过**。覆盖迁移、回滚、重复导入、损坏记录、契约向量、同步游标失败不推进和冲突副本。
- PR #23 兼容迁移的重复结果回归：同一草稿/模式的多个 legacy artifact 全部保留在 `ai_result_history`，当前槽位只在为空时写入按旧数组顺序的最后一条；重复迁移不覆盖已有隐藏/编辑状态。
- Web：在 `apps/web` 执行 `npm run build`，TypeScript 检查和 Vite 构建通过；保留既有大于 500 kB chunk 提示。
- OpenHarmony：使用 DevEco Studio `6.0.0` / API `20` 工具链执行 `entry@ohosTest` Debug HAP 构建，`BUILD SUCCESSFUL`；工程没有 `signingConfigs`，因此产物未签名。
- 模拟器：本机存在 `Mate 70 Pro`、HarmonyOS `6.0.0(20)`、x86 镜像，已执行 `Emulator.exe -hvd "Mate 70 Pro"`。启动日志报告 `HYPER_V_ERROR` / `can not read sn`，随后进程退出；`hdc list targets -v` 未出现 HarmonyOS 目标（仅有 `COM1 UART Ready unknown... hdc`）。因此未安装 HAP、未运行 Hypium/真实 RDB，模拟器部分自动化测试待具备 Hyper-V 或云手机后补做。
- 额外静态检查：`node --check services/ai-gateway/src/server.mjs` 和 `git diff --check` 通过。

## 当前状态

迁移、回滚、幂等、损坏数据、契约向量、同步游标/冲突逻辑、Node/Web/ArkTS 编译和 HAP 构建已完成并有本地证据。OpenHarmony 模拟器已尝试但受主机 Hyper-V 阻断；真实 RDB、HAP 安装、Hypium、输入/滚动、进程重启和原生交互仍未执行。不配置正式签名，不部署云服务。
