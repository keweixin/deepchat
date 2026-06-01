# DeepChat Agent Runtime 分阶段收网计划

## 目标

把 DeepChat 从“功能很多但用户不知道发生了什么”的聊天工具，收敛成一个本地优先、可审计、能解释工具状态的桌面 Agent Runtime。

本计划不把所有问题一次塞进一个巨大改动。每个阶段都必须留下可运行状态、测试证据和清晰回滚点。

## Phase 0: 纠正当前误导和断点

**要解决的问题**

- 当前“Skill”实际是工具模式，容易让用户以为已经具备 Codex/Claude Code 那种 Skill Runtime。
- MCP/外部 Skill 发现失败时提示太弱，用户看不到为什么没有工具。
- Inspector 空态像摆设。
- AI 小队虽然已接入，但文案偏工程化，用户不容易理解每个角色在做什么。
- 聊天区里过多参数信息会拉长记录，需要后续挪到 Inspector/详情里。

**改动**

- 把设置中的“Skill Grid”改成“Agent 模式”，保留内部 `activeSkill` 字段兼容历史数据。
- 把外部 `SKILL.md` 管理单独称为“外部技能”，说明它现在是提示词/资料，不等同于 Agent 模式。
- 外部 Skill/MCP 扫描无结果时显示警告正文，例如“仅桌面版可扫描本机配置”，而不是只显示 0 个。
- Inspector 空态说明“消息 / Trace / Artifact”分别看什么，并告诉用户从哪里打开详情。
- AI 小队角色用“拆任务、读文件、查资料、运行/编辑、核对结果、写回答”表达，不用抽象地点词。

**验收**

- 设置页不会再出现一个叫 Skill 的工具模式入口。
- 浏览器预览扫描本机配置时，用户能看到“仅桌面版可用”的明确原因。
- Inspector 空态不是空白面板。
- Agent 小队显示时，用户能理解当前角色的职责。

## Phase 1: 工具可用性和 MCP Tool Lab

**要解决的问题**

- 工具是否进入模型上下文由 provider、Agent 模式、MCP 状态、工作区、Tavily Key 等多处共同决定，用户看不到原因。
- MCP server list tools 失败时不能只写 console。

**改动**

- 输入框附近只保留一条 Runtime 状态：项目、模式、模型工具支持、可用工具数量、MCP 状态、权限策略。
- 增加“为什么工具不可用”面板：provider 不支持 tool calls、缺 Tavily Key、无工作区、MCP failed/zero tools/timeout 都能直接看到。
- MCP Drawer 升级为 Tool Lab：server 状态、command/args/cwd/env keys、stderr、tool schema、手动测试、复制诊断包。
- MCP 模式下如果 enabled servers > 0 但 tools = 0，发送前阻止并提示打开 Tool Lab。

**验收**

- 不问模型也能手动测试 MCP listTools/callTool。
- MCP 出错时能区分 command、cwd、env、zero tools、provider 不支持、timeout。

## Phase 2: Coding Agent 主链

**要解决的问题**

- DeepChat 仍像聊天流，不像任务流。
- 写文件、运行验证、diff review、回滚还没有成为主界面流程。

**改动**

- 新增任务流：理解需求 -> 读上下文 -> 计划 -> 确认 -> 编辑 -> 验证 -> 修复 -> diff -> 总结。
- 增加 Project Init：扫描 package/pyproject/cargo/go，生成 AGENTS.md 草稿、默认权限、推荐验证命令。
- 引入 workspace shell，区分 snippet runner、workspace command、sandboxed command、danger command。
- 写入前 checkpoint；写入后 diff evidence；支持本轮 revert。

**验收**

- 用户输入“修复这个 bug”后，能看到计划、读过的文件、改过的文件、运行过的命令、失败原因和最终 diff。

## Phase 3: 真 Skill Runtime、Commands、Hooks、Subagents

**要解决的问题**

- 现在外部 Skill 只是注入提示词，还不是可加载能力包。
- 缺少 `/init`、`/mcp`、`/permissions`、`/context`、`/diff` 等显式命令。
- 小人只是可视化，不是真正 delegation。

**改动**

- 支持 `.deepchat/skills/<name>/SKILL.md`，按 name/description 轻量索引，使用时再加载完整内容。
- 支持 skill 的 scripts/references/assets/allowedTools。
- 支持 `/skill-name` 显式调用和隐式匹配。
- 支持项目级 `.deepchat/commands`。
- 支持简化 hooks：SessionStart、PreToolUse、PostFileEdit、PostToolUseFailure。
- Subagents 先做真实分工：Explore、Plan、Implement、Test、Review，再做视觉增强。

**验收**

- 一个 repo 自带 `.deepchat/skills`、`.deepchat/permissions.json`、`.deepchat/mcp.json`、AGENTS.md 后，换机器打开可恢复项目 Agent 能力。

## Phase 4: 视觉体验和发布质量

**要解决的问题**

- UI 中仍有高级功能干扰主链。
- 发布前需要证明功能真实可用。

**改动**

- 把像素小人、Agent Theatre、复杂 cache 图表、Docset 高级搜索放到 Labs，默认不打扰主流程。
- 右侧 Inspector 围绕当前任务组织：Plan、Files、Diff、Tools、MCP、Context、Permissions、Logs。
- 增加 agent eval：工具证据、文件声明、取消/超时不能被最终回答描述成成功。
- 发布前固定跑 verify、prod/release smoke、GitNexus detect_changes。

**验收**

- 默认界面少按钮、清晰可点；高级诊断仍可展开。
- 每次发布有可复现验证记录。
