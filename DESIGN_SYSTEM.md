# DeepChat Design System

## 目标

DeepChat 的界面应优先服务长时间阅读、工具确认和多轮对话管理。视觉风格保持克制、清晰、低噪声，不使用大面积营销式渐变和无意义装饰。

## 字体

- 拉丁字体：优先使用本机 `Söhne/Sohne`，不存在时回退 `Inter`。
- 中文字体：使用系统 UI 字体栈，Windows 为 `Microsoft YaHei`，macOS 为 `PingFang SC`。
- 代码字体：`JetBrains Mono`、`Fira Code`、`Cascadia Code`、`monospace`。

## 布局与间距

- 主要布局使用 `--space-*` token，避免临时像素值。
- 聊天主内容最大宽度使用 `--message-max-width`。
- 控制区应能在 390px、768px、1024px、1440px 宽度下正常换行。

## 内容层级

- 短答：低边框、低背景，避免强行卡片化。
- 教程/排障：突出步骤、风险和下一步。
- 对比/选型：优先表格，并提供 CSV 导出。
- 工具结果：必须可展开查看参数、结果、来源和失败原因。
- 图片/图示：默认轻量展示，点击进入查看器。

## 安全边界

- 模型输出只允许 Markdown、代码块、LaTeX、Mermaid 和安全 widget JSON。
- 不允许 raw HTML/JS 组件，不允许 `onclick`、`style` 注入，不允许 renderer 直接执行代码。
