# DeepChat

本地优先、可审计、面向 DeepSeek 成本优化的桌面 AI Agent 客户端。

DeepChat 的定位不是大而全 Web 平台，也不是完整 IDE，而是一个适合长期项目会话的桌面工作台：模型对话、工具审批、本地工作区、MCP、长上下文摘要、DeepSeek cache telemetry 和可追溯工具证据都围绕同一个会话持续工作。

## 当前能力

- 多 Provider：DeepSeek、OpenAI、OpenRouter、硅基流动、DashScope、Ollama、LM Studio、自定义 OpenAI-compatible endpoint。
- 智能 Agent：自动判断联网搜索、文件读取、代码运行、MCP 或普通聊天；所有工具调用都需要用户确认。
- Tavily 搜索主线：联网工具固定走 Tavily，支持多 query 计划、搜索深度、新闻 freshness、域名过滤、TTL 缓存、可选 Extract 抽取和 structured citations。
- 可审计工具：工具请求、审批、拒绝、失败、输出摘要、安全提示和来源会写入消息记录。
- 上下文透明：工具卡可查看/复制“进入下一轮模型上下文”的压缩输出，并显示原始/压缩 token 估算。
- 工具调用修复：模型把工具 JSON 写进正文或 reasoning text 时，会保守修复为正常工具调用；截断参数 JSON 会在审批前尝试补齐。
- 只读工具并发：同一轮里的搜索、列目录、工作区搜索和读文件可并行等待确认/执行，结果仍按模型声明顺序进入上下文。
- MCP 可靠调用：复杂 MCP 参数 schema 会压平成 `filters.status` 这类 dot-path 字段，执行前再还原为嵌套 JSON。
- Workspace Knowledge Lite：在授权工作区内搜索文本文件，返回 `file:line-line` 引用，适合先定位资料再精读文件。
- DeepSeek cache-first：稳定 system prompt 和工具 schema 前缀，记录 prefix hash、cache hit/miss、命中率、估算成本和节省金额。
- 长上下文处理：按 token 预算裁剪历史，当前用户消息优先保留，必要时生成短摘要并复用摘要 hash。
- 辅助调用降本：DeepSeek 自动摘要等辅助调用优先使用 `deepseek-v4-flash`，避免主模型为 pro 时把摘要也按 pro 计费。
- 安全桌面端：Electron sandbox、CSP、IPC schema 校验、敏感文件拒读、输出脱敏、代码运行轻量隔离。
- 长任务防卡死：`run_code`、MCP、workspace index 等长任务有 watchdog 超时、取消 grace、stale result 忽略和重启 orphan 标记。
- 内容渲染：Markdown、代码高亮、KaTeX、Mermaid、表格、widget JSON 和导出能力。

## 安全模型

DeepChat 默认不隐藏执行外部操作：

- `read_file` 只能读取用户授权工作区下的文本文件，并拒读 `.env*`、SSH/AWS/npm/pypi 凭证、key/cert 等敏感路径。
- `run_code` 每次都需要确认，采用本地轻隔离执行：独立临时 `cwd/HOME/TEMP`、环境变量清洗、超时终止、输出截断和脱敏；不提供硬网络隔离或硬内存限制。
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
npm run quality:budget
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
- 推送 `v*` tag 会运行 `.github/workflows/release.yml`：校验、production audit、Windows Setup/Portable 构建、CycloneDX SBOM、SHA256 checksums、portable 启动 smoke、GitHub artifact provenance attestation，并创建 draft GitHub Release。
- 手动触发 Release workflow 时只上传构建 artifacts，不会创建正式 Release，适合发布前 smoke test。

## 目录

- [electron.js](./electron.js)：Electron 启动入口，加载生产编译后的主进程。
- [electron/main.ts](./electron/main.ts)：Electron 主进程、安全默认值、窗口策略和 IPC 注册。
- [electron/chat-service.ts](./electron/chat-service.ts)：Agent loop 编排、usage/cache 聚合和会话级上下文处理。
- [electron/agent-contracts.ts](./electron/agent-contracts.ts)：Zod 推导的 Agent 事件、工具运行、job snapshot 和 usage 合同。
- [electron/agent-eval.ts](./electron/agent-eval.ts)：确定性 Agent 场景评估 harness，基于工具证据判断文件声明真实性。
- [electron/stream-runner.ts](./electron/stream-runner.ts)：Provider streaming、SSE 解析、工具调用轮次和降级重试。
- [electron/tool-executor.ts](./electron/tool-executor.ts)：工具参数解析、正文工具调用修复、重复调用抑制。
- [electron/tool-call-handler.ts](./electron/tool-call-handler.ts)：工具预览、审批、执行、结果证据和上下文输出。
- [electron/approval-manager.ts](./electron/approval-manager.ts)：审批策略、超时、风险摘要和写入/执行安全元数据。
- [electron/job-runtime.ts](./electron/job-runtime.ts)：长任务 job 状态机、watchdog、取消、持久化、orphan 恢复和 stale result 防护。
- [electron/tools.ts](./electron/tools.ts) / [electron/tools-git.js](./electron/tools-git.js)：内置工具统一入口、风险描述和只读 Git 证据工具。
- [electron/tools-search.js](./electron/tools-search.js) / [electron/search-utils.mjs](./electron/search-utils.mjs)：Tavily-only 联网搜索、请求构建、缓存、去重、Extract 抽取和结构化来源证据。
- [electron/tools-file.js](./electron/tools-file.js)：工作区文件读写、写入预览、敏感路径拒绝、备份与临时文件重命名。
- [electron/tools-run-code.js](./electron/tools-run-code.js)：代码运行轻隔离、环境变量清洗、超时终止和输出脱敏。
- [electron/tools-workspace.ts](./electron/tools-workspace.ts) / [electron/workspace-index.ts](./electron/workspace-index.ts)：Workspace Knowledge Lite 索引、搜索和符号读取。
- [electron/shared/tool-definitions.js](./electron/shared/tool-definitions.js)：工具 schema、风险级别、角色和产品文案的共享定义。
- [src/modules/api.ts](./src/modules/api.ts)：Provider registry、浏览器 fallback、usage/context helpers。
- [src/modules/chat.ts](./src/modules/chat.ts)：聊天 UI、Agent timeline、工具卡、token/cache 展示。
- [src/modules/agent-run-store.ts](./src/modules/agent-run-store.ts) / [src/modules/agent-crew.ts](./src/modules/agent-crew.ts)：Agent Crew 状态与消息内协作视图。
- [src/modules/context-assets.ts](./src/modules/context-assets.ts)：文本附件 context asset 与 bounded prompt block。
- [scripts/check-quality-budget.mjs](./scripts/check-quality-budget.mjs)：AST 复杂度、函数长度、嵌套、import/export 质量预算门禁。
- [docs/adr/0001-agent-runtime-boundaries.md](./docs/adr/0001-agent-runtime-boundaries.md)：Agent Runtime Boundaries ADR。
- [tests](./tests)：Vitest 单元和 UI helper 测试。

## 路线

**已交付 (Shipped)**

1. ✅ Provider Registry：模型/Provider 能力矩阵、兼容性报告、预设配置。
2. ✅ Tool Cards：统一工具卡组件，风险范围推断（读/写/执行/网络），审批状态，证据摘要。
3. ✅ Agent Trace & Actor System：TraceRecorder、Agent Theatre、Trace Inspector、Legacy Migration。
4. ✅ Virtual Message List：30+ 消息自动虚拟滚动，placeholder 高度保留。
5. ✅ Streaming Render 优化：streaming 阶段仅使用轻量 inline markdown，禁止调用 `renderMarkdown`。
6. ✅ Workspace Knowledge：SQLite FTS5 全文索引、文件 chunk、增量索引、三层记忆系统（工作记忆 → 短期记忆 → 长期记忆）。
7. ✅ Inspector Panel：右侧核心工作区，支持模型信息、Trace 时间线、工具详情、Artifact 模式。
8. ✅ Artifact Panel：Markdown、Mermaid、Table、JSON、HTML sandbox preview，支持版本管理和 diff。
9. ✅ MCP Drawer：server status、tool scopes、call logs、usage statistics。
10. ✅ 三层记忆系统：workspace-index（工作记忆）、memory-manager（短期记忆）、长期记忆检索。
11. ✅ Context Shortcuts：`@file`、`@folder`、`@symbol`、`@changed`、`@web`、`@run`、`@mcp` 会在前端提示 prerequisites，并把 Agent 路由到明确工具。
12. ✅ Git 只读证据工具：`git_status`、`git_diff`、`git_log`、`git_blame`、`git_compare`、`git_show`。

**进行中 (In Progress)**

13. 🔄 ChatService 拆分：已将部分职责拆出为 `agent-planner.ts`、`approval-manager.ts`、`tool-executor.ts`、`stream-runner.ts`、`memory-manager.ts`、`workspace-index.ts`，剩余 `chat-service.ts` 继续瘦身中。
14. 🔄 Tool Repair 透明化：区分原生调用 / 文本修复 / 手动触发，修复出的 tool call 默认不自动执行。
15. 🔄 TypeScript 严格模式：分批启用 `strict: true`，核心路径逐步消除 `@ts-nocheck`。
16. 🔄 Electron 生产编译：从 tsx 运行时加载迁移为 `tsc` 预编译 `dist-electron/`。

**计划 (Planned)**

17. 多模态输入扩展：语音输入、截图标注、PDF 解析。
18. 跨会话知识图谱：基于工具证据的关系抽取和可视化。
