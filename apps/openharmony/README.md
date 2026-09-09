# OpenHarmony 工作流边界

当前 DevEco 工程保留在仓库根目录，这是已有 API 20 Stage 工程和成功构建路径的位置，未复制或搬迁到此目录。

手机端起步框架位于：

- `entry/src/main/ets/domain`：领域模型和仓储端口
- `entry/src/main/ets/application`：草稿工作区 ViewModel
- `entry/src/main/ets/platform`：`RdbDraftRepository`、`HttpSyncClient`、`PhoneSyncService` 等平台适配器
- `entry/src/main/ets/pages/Index.ets`：ArkUI IDE 工作区页面、左侧抽屉和工具面板

当前已完成 API 20 环境下的 Debug HAP 构建，RDB 适配器和同步调用链已接入工程；仍未完成真机/设备级视觉验证，不得把 Previewer 或构建结果描述为设备完成。
