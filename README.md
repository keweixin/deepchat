# DeepChat

本地优先、可审计、面向 DeepSeek 成本优化的桌面 AI Agent 客户端。

DeepChat 的定位不是大而全 Web 平台，也不是完整 IDE，而是一个适合长期项目会话的桌面工作台：模型对话、工具审批、本地工作区、MCP、长上下文摘要、DeepSeek cache telemetry 和可追溯工具证据都围绕同一个会话持续工作。

## 当前能力

- 多 Provider：DeepSeek、OpenAI、OpenRouter、硅基流动、DashScope、Ollama、LM Studio、自定义 OpenAI-compatible endpoint。
- 智能 Agent：自动判断联网搜索、文件读取、代码运行、MCP 或普通聊天；所有工具调用都需要用户确认。
- 可审计工具：工具请求、审批、拒绝、失败、输出摘要、安全提示和来源会写入消息记录。
- 工具调用修复：模型把工具 JSON 写进正文或 reasoning text 时，会保守修复为正常工具调用；截断参数 JSON 会在审批前尝试补齐。
- 只读工具并发：同一轮里的搜索、列目录、工作区搜索和读文件可并行等待确认/执行，结果仍按模型声明顺序进入上下文。
- MCP 可靠调用：复杂 MCP 参数 schema 会压平成 `filters.status` 这类 dot-path 字段，执行前再还原为嵌套 JSON。
- Workspace Knowledge Lite：在授权工作区内搜索文本文件，返回 `file:line-line` 引用，适合先定位资料再精读文件。
- DeepSeek cache-first：稳定 system prompt 和工具 schema 前缀，记录 prefix hash、cache hit/miss、命中率、估算成本和节省金额。
- 长上下文处理：按 token 预算裁剪历史，当前用户消息优先保留，必要时生成短摘要并复用摘要 hash。
- 辅助调用降本：DeepSeek 自动摘要等辅助调用优先使用 `deepseek-v4-flash`，避免主模型为 pro 时把摘要也按 pro 计费。
- 安全桌面端：Electron sandbox、CSP、IPC schema 校验、敏感文件拒读、输出脱敏、代码运行轻量隔离。
- 内容渲染：Markdown、代码高亮、KaTeX、Mermaid、表格、widget JSON 和导出能力。

## 安全模型

DeepChat 默认不隐藏执行外部操作：

- `read_file` 只能读取用户授权工作区下的文本文件，并拒读 `.env*`、SSH/AWS/npm/pypi 凭证、key/cert 等敏感路径。
- `run_code` 每次都需要确认，使用独立临时 `cwd/HOME/TEMP` 和最小环境变量白名单；Windows 轻沙箱不承诺硬网络隔离。
- MCP 工具作为外部系统能力处理，调用前必须确认，配置和工具状态在设置页可见。
- API Key、Tavily Key、MCP env 在桌面端通过 Electron `safeStorage` 加密存储；备份导出默认不包含 secrets。

## DeepSeek 缓存优化

DeepChat 将 DeepSeek prefix cache 当成请求构造约束：

- system prompt、Agent 规则和工具 schema 排序稳定；
- 当前轮 intent、缺配置提示等动态信息放在 turn tail，避免污染 cache-stable prefix；
- 会话保存 `cacheProfile`，跨轮检测 model、workspace/MCP、tool schema、prefix fingerprint 漂移；
- usage 解析 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，并按本地价格表估算成本和节省。

Provider 不返回真实 usage 时，界面会标记为估算，不伪装成真实缓存命中。

## 开发命令

```powershell
npm ci
npm run lint
npm test
npm run build
npm run verify
```

桌面调试：

```powershell
npm run electron:dev
```

Windows 构建：

```powershell
npm run electron:build
npm run electron:build:portable
```

## CI 与发布

- Pull Request、`main`、`master` 和 `codex/**` 分支会运行 `.github/workflows/verify.yml`：`npm ci` + `npm run verify`。
- 推送 `v*` tag 会运行 `.github/workflows/release.yml`：校验、production audit、Windows Setup/Portable 构建、SHA256 checksums，并创建 draft GitHub Release。
- 手动触发 Release workflow 时只上传构建 artifacts，不会创建正式 Release，适合发布前 smoke test。

## 目录

- [electron.js](./electron.js)：Electron 主进程、安全默认值和 IPC 边界。
- [electron/chat-service.js](./electron/chat-service.js)：Agent loop、provider streaming、usage/cache 统计、工具审批。
- [electron/tools.js](./electron/tools.js)：内置工具、工作区搜索、文件安全边界、代码运行轻沙箱。
- [src/modules/api.js](./src/modules/api.js)：Provider registry、浏览器 fallback、usage/context helpers。
- [src/modules/chat.js](./src/modules/chat.js)：聊天 UI、Agent timeline、工具卡、token/cache 展示。
- [tests](./tests)：Vitest 单元和 UI helper 测试。

## 路线

1. Provider registry 和 cache telemetry 继续产品化。
2. 工具证据卡片统一结构，支持复制 JSON 和原始输出引用。
3. Workspace Knowledge：从当前 lightweight line citation 搜索演进到 SQLite FTS5、文件 chunk、增量索引。
4. `@file` / `@folder` / `@symbol` 显式上下文选择。
5. Artifact panel：Markdown、Mermaid、Table、JSON、HTML sandbox preview。
6. MCP 工具抽屉、server status 和 per-workspace tool policy。
