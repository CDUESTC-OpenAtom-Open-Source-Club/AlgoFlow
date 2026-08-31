# Web IDE 与 CodeMirror 能力记录

核对范围：`entry/src/main/ets/pages/Index.ets` 的手机端编辑体验、`apps/web/src/components/CodeEditor.tsx` 的浏览器 IDE，以及本地安装的 CodeMirror 6 MIT 包（`@codemirror/*`）。

| 现有功能 | CodeMirror 6 能否复现 | Web 端实现/结论 |
| --- | --- | --- |
| 文本编辑、选择、粘贴、输入法 | 可以 | `EditorView` 原生 DOM 编辑器；由浏览器负责输入法和选择。 |
| 固定行高、滚动、行号、当前行高亮 | 可以 | `lineNumbers`、`highlightActiveLine`、主题中的固定 `line-height`。 |
| 当前光标行列、跳转到行 | 可以 | `EditorView.updateListener` 回传行列；`scrollIntoView` 实现跳转。 |
| 撤销/重做 | 可以 | `history`、`defaultKeymap`、`historyKeymap`。 |
| 括号匹配、自动补括号、输入缩进 | 可以 | `bracketMatching`、`closeBrackets`、`indentOnInput`。 |
| C++ 语法高亮 | 可以 | `@codemirror/lang-cpp` + `syntaxHighlighting`，仅 `.cpp` 文件启用。 |
| 关键字/STL/片段补全与 Tab 接受 | 可以 | `autocompletion` 自定义 provider；不等同 clangd 语义补全。 |
| 搜索与匹配高亮 | 可以 | `@codemirror/search` 扩展；工作区搜索仍由 React 面板负责。 |
| 折叠、矩形选择、多光标、行复制/删除/移动 | 可以 | CodeMirror commands 与本项目快捷键。 |
| 基础括号/入口/include 规则审查 | 可以 | `@codemirror/lint` 调用本项目 `reviewCpp`；不是编译器诊断。 |
| ArkUI 底部工具菜单、草稿仓储、AI 模式、同步队列 | 不可以直接复现 | 属于 React/领域/平台能力，继续由应用层实现。 |
| OpenHarmony 服务卡片、生命周期、权限、RDB | 不可以 | 必须保留 ArkTS/ArkUI 和 OpenHarmony 平台适配。 |

## 边界

CodeMirror 的核心视图依赖浏览器 DOM、键盘事件和 CSS。它不能直接复制到 ArkTS 页面，也不能替代 OpenHarmony 原生 `TextArea`、服务卡片或平台能力。Web IDE 使用 CodeMirror 作为唯一编辑行为来源；手机端继续使用 ArkUI 原生编辑器，两端通过领域模型和同步契约共享数据语义。

当前未接入 `clangd`、`clang-tidy`、本地编译或云端执行，因此 CodeMirror 的 lint 结果只代表 AlgoFlow 的基础规则审查。
