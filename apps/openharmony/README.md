# OpenHarmony 工作流边界

当前 DevEco 工程保留在仓库根目录，这是已有 API 20 Stage 工程和成功构建路径的位置，未复制或搬迁到此目录。

手机端起步框架位于：

- `entry/src/main/ets/domain`：领域模型和仓储端口
- `entry/src/main/ets/application`：草稿工作区 ViewModel
- `entry/src/main/ets/platform`：当前内存适配器，占位待替换为已验证的 RDB 适配器
- `entry/src/main/ets/pages/Index.ets`：ArkUI 工作区页面

在没有 API 文档、迁移测试和设备证据前，不得把内存适配器或 Previewer 结果描述为持久化/设备完成。
