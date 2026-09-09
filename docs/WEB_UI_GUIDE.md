# AlgoFlow Web / ArkUI UI 对齐指南

版本：0.2（Web IDE / ArkUI IDE 对齐基线）
状态：Web UI 原型；ArkUI IDE 参考布局已确认，主页面映射待设计

## 1. 目标

Web 是电脑端工作流：键盘优先、代码编辑区占据绝大部分、AI 与来源检查通过侧栏触发。ArkUI 手机端不复制 Web 布局，而是复用信息层级、状态语义和视觉 Token。

## 2. 视觉方向

主题参考 Mizuki 博客的纸张、植物和安静阅读感，避免蓝紫渐变、霓虹发光和营销 Hero。签名元素是“代码行号轨道 + idea segment 来源轨道”，帮助用户理解代码如何对应原始思路。

### MD3 令牌

| 角色 | 值 | 用途 |
| --- | --- | --- |
| `primary` | `#55745F` | 主操作、选中状态、同步成功 |
| `onPrimary` | `#FFFFFF` | 主色上的文字 |
| `primaryContainer` | `#DBE8DC` | 选中标签、来源提示 |
| `surface` | `#FBF9F4` | 主界面纸张面 |
| `surfaceContainer` | `#EEEAE1` | 工具栏、边栏分区 |
| `surfaceVariant` | `#E5E2D9` | 次级信息背景 |
| `outline` | `#777C73` | 次级边框、焦点邻近色 |
| `outlineVariant` | `#C8C9BF` | 分隔线 |
| `onSurface` | `#252A26` | 主文字 |
| `onSurfaceVariant` | `#5E645D` | 说明文字、元信息 |
| `error` | `#B5674D` | 风险、冲突、未解决项 |
| `codeSurface` | `#202522` | 代码编辑区 |

这些颜色是 MD3 角色的项目映射，不代表引入 Material UI 组件库。

### ArkUI IDE 深色映射

ArkUI IDE 根据已确认的参考 HTML 使用独立的深色表面映射；Web 端现有浅色令牌不因此改为深色主题。

| 角色 | 值 | 用途 |
| --- | --- | --- |
| `ideBackground` | `#0A0A0C` | IDE 与主代码编辑区背景 |
| `ideSurface` | `#161618` | 顶部导航、工具面板和工作区抽屉 |
| `ideSurfaceRaised` | `#1E1E20` | 状态胶囊、浮动工具胶囊和次级控件 |
| `ideOutline` | `#3A3A3D` | 胶囊、输入框和活动区域边界 |
| `ideDrawerSelectionOutline` | `#5A5A5F` | 抽屉选中项的灰色边框，不使用绿色选中边框 |
| `ideScrim` | `#99000000` | 左侧抽屉打开时的灰黑遮罩 |
| `ideOnSurface` | `#ECECED` | 深色表面主文字 |
| `ideOnSurfaceMuted` | `#8E8E93` | 行号、说明和状态元信息 |
| `ideSuccess` | `#30D158` | 已同步、选中模式和主要操作 |
| `ideWarning` | `#FF9F0A` | 未保存、冲突和思路片段强调 |
| `ideError` | `#FF453A` | 同步失败和错误状态 |

深色映射只改变 ArkUI IDE 的视觉表现，不改变公共同步状态、AI 模式枚举或 Web/OH 数据契约。

## 3. 字体与图标资产

- 界面字体目标：[`max32002/maruko-gothic`](https://github.com/max32002/maruko-gothic)，接入前需确认许可证、字体文件和 Web 字体加载方式。
- 图标目标：[`Nieobie/Game-Icon-Pack`](https://github.com/Nieobie/Game-Icon-Pack)，接入前需确认具体图标文件名、许可证和是否允许 Web 发布。
- 图标接入边界位于 `apps/web/src/icon-assets.ts`。必须先核验 `Nieobie/Game-Icon-Pack` 的实际文件名、许可证和发布方式，再将本地资源映射到语义名：`files`、`search`、`source`、`spark`、`history`、`code`、`note`、`panel`、`more`、`cpp`、`md`、`test`。在资源未核验前不使用字母或仿制图形冒充指定图标库。
- OH 端复用已核验的 Game Icon Pack SVG，并复制到 `entry/src/main/resources/base/media`，由 `Index.ets` 的 `WorkspaceIcon` 映射用于文件标签、草稿、思路来源、AI 模式、搜索、保存和同步操作。图标包当前没有 `eye`、`settings` 资源，这两处保留文字标签，不使用错误语义的替代图形。
- 代码区必须使用等宽字体，不能使用圆体，以保证缩进、括号和行号可读。

## 4. Web 信息架构

```text
顶部：品牌 / 文件标签 / 保存与同步状态
左侧工具栏：文件、搜索、来源、AI、版本
左侧面板：当前工具的内容
中心：main.cpp 主编辑区
右侧：思路检查、来源、待补信息、独立复写入口
底部：问题、同步日志、终端（默认收起）
```

核心比例是“中心编辑区最大化”。AI 不覆盖代码区，不使用浮动大卡片遮挡编辑内容。

## 5. ArkUI 映射规则

| Web | ArkUI 手机端 |
| --- | --- |
| 顶部品牌/文件标签 | 顶部导航栏：菜单入口、当前文件名/草稿标题和同步状态胶囊 |
| 左侧工具栏 | 底部浮动工具胶囊；保持单手可达，工具仍通过 `WorkspaceTool` 切换 |
| 左侧文件面板 | 左侧滑动抽屉 + 遮罩；承载草稿、文件入口、AI 模式和同步摘要 |
| 中心代码编辑区 | `TextArea` 原生编辑器 + 独立行号栏；代码区优先占据可用高度 |
| 当前行/代码滚动 | 保留选区、光标、当前行描边和 `onContentScroll` 行号同步，不拆分为逐行输入框 |
| 右侧检查栏 | 手机端改为工具抽屉/底部面板，不覆盖主代码编辑区 |
| 底部同步日志 | 同步状态工具面板或弹层；状态使用公共契约枚举 |
| 来源轨道 | 思路片段列表与代码行来源标识 |

### 5.1 IDE 参考布局边界

- ArkUI IDE 使用参考 HTML 的顶部导航、深色代码区、底部浮动工具胶囊和左侧抽屉；HTML/Tailwind 实现不直接移植到 ArkUI。
- 抽屉打开时使用灰黑遮罩；抽屉选中项使用 `#5A5A5F` 灰色边框和 `#ECECED` 高亮字体，绿色只用于同步成功、选中模式和主要操作。
- 主代码区继续使用原生 `TextArea`，保留复制、粘贴、撤销/重做、输入法、选区、光标跳转和长文本滚动能力。
- 抽屉、工具胶囊和面板只是 UI 入口变化，不改变 `DraftWorkspaceViewModel`、RDB 离线副本、操作队列或 `PhoneSyncService` 的调用语义。

### 5.2 ArkUI 工作区首页

OH 端首页使用独立的 `pages/Home` 路由，入口页不重构现有 `pages/Index` IDE。首页只负责工作区概览和导航：统计当前本地草稿状态、创建草稿、打开最近草稿，以及进入尚未完成能力的预留页面。打开草稿时通过 `routeDraftId` 交给现有 IDE 页面，保持 `main.cpp` 编辑、选择、滚动和工具面板逻辑不变。

首页的历史版本统计、归档/恢复、通知、AI 转换和设置目前只显示待接入或预留状态，不生成模拟数据。删除沿用手机端 RDB 的墓碑同步语义。

OH 端首页图标资源来自项目已核验的 `apps/web/src/assets/game-icons` 集合，当前适配到 `entry/src/main/resources/base/media`，通过 `components/ResourceIcon.ets` 统一映射。首页不使用 emoji 或未确认来源的图标库。

手机端必须优先保证单手操作、输入法适配、后台恢复和错误恢复，不追求三栏同时显示。

## 6. 共享状态文案

同步状态严格对应公共契约：`local_only`（仅本地）、`syncing`（同步中）、`synced`（已同步）、`conflict`（有冲突）、`failed`（同步失败）。AI 模式严格对应：`faithful_transform`、`feasibility_analysis`、`progressive_hint`、`full_solution`。

AI 未配置模型时显示“AI 未启用”，不得使用假结果填充 UI。忠实转换结果的每个步骤必须能回到稳定的 `idea_segment`，无来源步骤不得混入正式结果。

## 7. 交互与无障碍

- 所有图标按钮必须有 `aria-label` 或可见文字。
- 键盘焦点使用清晰的绿色焦点环；代码区支持滚动、复制和撤销/重做。
- 任何未保存状态都在文件标签和顶部状态中可见。
- 离线、同步失败和冲突提供可操作说明，不只显示颜色。
- `prefers-reduced-motion` 下不依赖动画表达状态。

## 8. 变更门禁

新增颜色、字体、图标、布局断点或状态文案时，同时更新本文档，并说明 Web 与 ArkUI 的映射影响。任何新增 npm 包都要先核验包名、官方仓库、许可证和包体积；小功能优先使用浏览器/React 原生能力。
