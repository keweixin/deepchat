// @ts-check
/**
 * Agent planning functions extracted from chat-service.js.
 *
 * Pure functions with no class dependencies — analyse user messages,
 * detect tool intent, and build agent execution plans.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentSettings {
  tavilyApiKey?: string;
  runCodeEnabled?: boolean | string;
  workspaceRoots?: string[];
  mcpServers?: Array<{ enabled?: boolean; command?: string } | undefined>;
  activeSkill?: string;
  toolApprovalPolicy?: string;
  agentMaxRounds?: number;
  systemPrompt?: string;
  externalSkills?: Array<{ name: string; description: string }>;
  cacheOptimization?: boolean;
  [key: string]: unknown;
}

export interface AgentIntent {
  kind: 'chat' | 'tool';
  toolMode: string;
  selectedTools: string[];
  candidateTools: string[];
  missingPrerequisites: string[];
  confidence: number;
  explicitDirectives: string[];
  reason: string;
}

export interface SearchPlanItem {
  purpose: string;
  query: string;
  reason: string;
}

export interface ToolDirectives {
  web: boolean;
  code: boolean;
  changed: boolean;
  mcp: boolean;
}

export interface AgentPlanSummary {
  type: 'deepchat.agentPlan';
  version: number;
  mode: string;
  confidence: number;
  maxRounds: number;
  reason: string;
  steps: string[];
  selectedTools: string[];
  candidateTools: string[];
  availableToolNames: string[];
  searchPlan: SearchPlanItem[];
  missingPrerequisites: string[];
  approvalPolicy: string[];
  warnings: string[];
}

export interface ChatMessage {
  role: string;
  content: string;
  [key: string]: unknown;
}

export interface ToolDef {
  function?: { name?: string };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_AGENT_MAX_ROUNDS = 3;
const DIRECTIVE_TEXT_PATTERN = /```[\s\S]*?```/g;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stripVolatileContextBlocks(content: string): string {
  return String(content || '')
    .replace(/<related_memory>[\s\S]*?<\/related_memory>/gi, ' ')
    .replace(/<selected_context>[\s\S]*?<\/selected_context>/gi, ' ')
    .replace(/<task_checkpoint>[\s\S]*?<\/task_checkpoint>/gi, ' ');
}

function needsYearScopedExternalLookup(text: string): boolean {
  return /价格|版本|政策|法规|官网|资料|数据|统计|趋势|报告|来源|引用|发布|名单|榜单|排名|current|latest|news|price|version|release|source|data|report|trend|ranking|schedule|score/i.test(
    text
  );
}

function normalizeResearchTopic(text: string): string {
  const stripped = stripVolatileContextBlocks(String(text || ''))
    .replace(DIRECTIVE_TEXT_PATTERN, ' ')
    .replace(/@[a-zA-Z_:-]+/g, ' ')
    .replace(/[，。！？?]/g, ' ')
    .replace(/请|帮我|麻烦|一下|搜索|查询|查找|研究|调研|看看|给我|根据|优化|分析|总结/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  return stripped.slice(0, 96);
}

function dedupeSearchPlan(plan: SearchPlanItem[]): SearchPlanItem[] {
  const seen = new Set<string>();
  const next: SearchPlanItem[] = [];
  for (const item of plan) {
    const query = String(item.query || '').trim();
    if (!query || seen.has(query.toLowerCase())) continue;
    seen.add(query.toLowerCase());
    next.push({ ...item, query });
  }
  return next;
}

// ---------------------------------------------------------------------------
// Exported helpers (needed by chat-service.js)
// ---------------------------------------------------------------------------

export function getLastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i].content || '');
  }
  return '';
}

export function normalizeToolApprovalPolicy(value: string | undefined): string {
  return String(value || 'confirm_all') === 'auto_readonly' ? 'auto_readonly' : 'confirm_all';
}

// ---------------------------------------------------------------------------
// Directive detection
// ---------------------------------------------------------------------------

export function hasAtDirective(text: string, names: string[]): boolean {
  const group = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?:^|[\\s([，,;；])@(?:${group})(?:\\b|\\s*:|$)`, 'i').test(String(text || ''));
}

export function detectExplicitToolDirectives(content: string = ''): ToolDirectives {
  const text = stripVolatileContextBlocks(content).replace(DIRECTIVE_TEXT_PATTERN, ' ');
  return {
    web: hasAtDirective(text, ['web', 'search']),
    code: hasAtDirective(text, ['run', 'code']),
    changed: hasAtDirective(text, ['changed', 'recent']),
    mcp: hasAtDirective(text, ['mcp']),
  };
}

// ---------------------------------------------------------------------------
// Tool need detectors
// ---------------------------------------------------------------------------

export function needsSearch(text: string, lower: string): boolean {
  return (
    /最新|新闻|今日|今天|今年|实时|刚刚|本周|价格|版本|政策|法规|官网|资料|搜索|查询|查一下|联网|来源|引用|current|latest|today|news|price|version|release|search|source/i.test(
      text
    ) ||
    (/20\d{2}/.test(lower) && needsYearScopedExternalLookup(text))
  );
}

export function needsFiles(text: string, lower: string): boolean {
  const value = String(text || '');
  return (
    /@(file|folder|symbol)\s*:/i.test(value) ||
    /[a-z]:[\\/]/i.test(value) ||
    /\b(readme|package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig\.json|vite\.config|webpack\.config)\b/i.test(
      value
    ) ||
    /\.(js|jsx|ts|tsx|vue|md|py|json|yaml|yml|toml|css|html|java|go|rs)\b/i.test(value) ||
    /文件|目录|代码库|仓库|路径|工作区|本地|源码|源代码|报错日志/i.test(value) ||
    /(当前|这个|本地|我的).{0,6}(项目|工程|仓库|代码库)/i.test(value) ||
    /(读取|打开|查看|列出|搜索|扫描|定位|修改|检查|分析).{0,16}(项目|工程|仓库|代码库|workspace|repo|repository)/i.test(
      value
    ) ||
    /(项目|工程|仓库|代码库|workspace|repo|repository).{0,16}(文件|目录|代码|源码|结构|依赖|配置|package|readme|报错|日志)/i.test(
      value
    ) ||
    lower.includes('workspace')
  );
}

export function needsCode(text: string, lower: string): boolean {
  return (
    /运行|执行|调试|复现|验证.*代码|算一下|计算|单元测试|测试一下|run code|debug|reproduce|calculate|execute/i.test(
      text
    ) || /```/.test(lower)
  );
}

export function needsGit(text: string, lower: string): boolean {
  const value = String(text || '');
  return (
    /\b(git|github|gitlab|commit|提交|暂存|分支|merge|合并|rebase|checkout|diff|变更|修改记录|changelog|版本历史|回滚|还原|blame|tag|标签|pr|pull request|mr|merge request)\b/i.test(
      value
    ) ||
    /(查看|比较|分析|检查|显示|列出|最近|最新).{0,10}(变更|修改|diff|提交|commit|历史|history|状态|status)/i.test(
      value
    ) ||
    /(变更|修改|diff|提交|commit|历史|history|状态|status).{0,10}(查看|比较|分析|检查|显示|列出)/i.test(value)
  );
}

export function needsMcp(text: string, lower: string): boolean {
  const value = String(text || '');
  const normalized = String(lower || value.toLowerCase());
  if (
    /(调用|使用|连接|测试|通过|启用|配置)\s*(mcp|外部系统|server 工具)|\b(mcp)\b\s*(server|tool|工具|服务器|调用|连接)/i.test(
      value
    )
  )
    return true;
  const target = /(notion|github|gitlab|jira|linear|slack|数据库|database)/i.test(normalized);
  if (!target) return false;
  const action =
    /(创建|新建|更新|修改|删除|发送|发布|提交|推送|同步|写入|拉取|获取|查询|列出|打开|关闭|指派|评论|回复|上传|下载|create|update|delete|send|post|publish|submit|sync|fetch|query|list|open|close|assign|comment|upload|download|push|pull)/i.test(
      value
    );
  if (!action) return false;
  return /(issue|pull request|pr\b|merge request|ticket|任务|工单|页面|数据库|database|record|评论|comment|频道|channel|消息|message|仓库|repo|repository|release|项目|project)/i.test(
    normalized
  );
}

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

export function detectAgentIntent(messagesOrText: ChatMessage[] | string, settings: AgentSettings = {}): AgentIntent {
  const text = stripVolatileContextBlocks(
    Array.isArray(messagesOrText) ? getLastUserText(messagesOrText) : String(messagesOrText || '')
  );
  const lower = text.toLowerCase();
  const directives = detectExplicitToolDirectives(text);
  const selected = new Set<string>();
  const candidates = new Set<string>();
  const missing = new Set<string>();
  const reasons: string[] = [];
  let score = 0;

  if (directives.web) {
    candidates.add('web_search');
    reasons.push('explicit_web');
    score += 0.75;
    if (settings.tavilyApiKey) selected.add('web_search');
    else missing.add('Tavily API Key');
  }
  if (directives.code) {
    candidates.add('run_code');
    reasons.push('explicit_run');
    score += 0.75;
    if (settings.runCodeEnabled === false || settings.runCodeEnabled === 'false') missing.add('代码运行工具');
    else selected.add('run_code');
  }
  if (directives.changed) {
    candidates.add('git_status');
    candidates.add('git_diff');
    candidates.add('index_workspace');
    candidates.add('list_files');
    candidates.add('search_workspace');
    candidates.add('read_symbol');
    candidates.add('read_file');
    reasons.push('explicit_changed_context');
    score += 0.65;
    if (Array.isArray(settings.workspaceRoots) && settings.workspaceRoots.length > 0) {
      selected.add('git_status');
      selected.add('git_diff');
      selected.add('index_workspace');
      selected.add('list_files');
      selected.add('search_workspace');
      selected.add('read_symbol');
      selected.add('read_file');
    } else {
      missing.add('工作区目录');
    }
  }
  if (directives.mcp) {
    candidates.add('mcp');
    reasons.push('explicit_mcp');
    score += 0.65;
    if ((settings.mcpServers || []).some((server) => server?.enabled !== false && server?.command)) {
      selected.add('mcp');
    } else {
      missing.add('MCP Server');
    }
  }

  if (!candidates.has('web_search') && needsSearch(text, lower)) {
    candidates.add('web_search');
    reasons.push('fresh_or_external_facts');
    score += 0.35;
    if (settings.tavilyApiKey) selected.add('web_search');
    else missing.add('Tavily API Key');
  }
  if (!candidates.has('list_files') && needsFiles(text, lower)) {
    candidates.add('project_map');
    candidates.add('index_workspace');
    candidates.add('list_files');
    candidates.add('search_workspace');
    candidates.add('read_symbol');
    candidates.add('read_file');
    reasons.push('local_files');
    score += 0.35;
    if (Array.isArray(settings.workspaceRoots) && settings.workspaceRoots.length > 0) {
      selected.add('project_map');
      selected.add('index_workspace');
      selected.add('list_files');
      selected.add('search_workspace');
      selected.add('read_symbol');
      selected.add('read_file');
    } else {
      missing.add('工作区目录');
    }
  }
  if (!candidates.has('git_status') && needsGit(text, lower)) {
    candidates.add('git_status');
    candidates.add('git_diff');
    candidates.add('git_log');
    reasons.push('git_context');
    score += 0.35;
    if (Array.isArray(settings.workspaceRoots) && settings.workspaceRoots.length > 0) {
      selected.add('git_status');
      selected.add('git_diff');
      selected.add('git_log');
    } else {
      missing.add('工作区目录');
    }
  }
  if (!candidates.has('run_code') && needsCode(text, lower)) {
    candidates.add('run_code');
    reasons.push('code_or_calculation');
    score += 0.3;
    if (settings.runCodeEnabled === false || settings.runCodeEnabled === 'false') missing.add('代码运行工具');
    else selected.add('run_code');
  }
  if (!candidates.has('mcp') && needsMcp(text, lower)) {
    candidates.add('mcp');
    reasons.push('external_mcp');
    score += 0.25;
    if ((settings.mcpServers || []).some((server) => server?.enabled !== false && server?.command)) {
      selected.add('mcp');
    } else {
      missing.add('MCP Server');
    }
  }

  let toolMode = 'none';
  const hasBuiltin = [...selected].some((name) => name !== 'mcp');
  const hasMcp = selected.has('mcp');
  if (hasBuiltin && hasMcp) toolMode = 'multi_tool';
  else if (hasMcp) toolMode = 'mcp_tool';
  else if (selected.has('web_search') && selected.size === 1) toolMode = 'web_search';
  else if (
    (selected.has('index_workspace') ||
      selected.has('list_files') ||
      selected.has('search_workspace') ||
      selected.has('read_symbol') ||
      selected.has('read_file') ||
      selected.has('project_map') ||
      selected.has('git_status') ||
      selected.has('git_diff') ||
      selected.has('git_log')) &&
    !selected.has('web_search') &&
    !selected.has('run_code')
  )
    toolMode = 'file_reader';
  else if (selected.has('run_code') && selected.size === 1) toolMode = 'code_runner';
  else if (hasBuiltin) toolMode = 'multi_tool';

  return {
    kind: toolMode === 'none' ? 'chat' : 'tool',
    toolMode,
    selectedTools: [...selected],
    candidateTools: [...candidates],
    missingPrerequisites: [...missing],
    confidence: Math.min(1, score),
    explicitDirectives: Object.entries(directives)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name),
    reason: reasons.join(',') || 'plain_chat',
  };
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

export function buildPlanApprovalPolicy(selectedTools: string[], settings: AgentSettings = {}): string[] {
  const policy: string[] = [];
  const hasReadOnly = selectedTools.some((name) =>
    [
      'web_search',
      'index_workspace',
      'list_files',
      'search_workspace',
      'read_symbol',
      'read_file',
      'project_map',
      'git_status',
      'git_diff',
      'git_log',
    ].includes(name)
  );
  if (hasReadOnly) {
    policy.push(
      normalizeToolApprovalPolicy(settings.toolApprovalPolicy) === 'auto_readonly'
        ? '低风险读取/搜索类工具会自动执行并保留证据；运行代码、MCP 和写入类操作仍必须确认。'
        : '读取/搜索类工具会先展示审批卡，确认后执行并保留证据。'
    );
  }
  if (selectedTools.includes('run_code')) {
    policy.push('代码运行必须确认；结果会以实验卡片展示退出码、耗时和 stdout/stderr。');
  }
  if (selectedTools.includes('mcp')) {
    policy.push('MCP 工具调用必须确认；写入或外部系统操作需要按工具风险提示判断。');
  }
  if (policy.length === 0) {
    policy.push('本轮预计不调用工具。');
  }
  return policy;
}

export function buildResearchSearchPlan(
  userText: string = '',
  intent: Partial<AgentIntent> = {},
  settings: AgentSettings = {}
): SearchPlanItem[] {
  const selectedTools = Array.isArray(intent.selectedTools) ? intent.selectedTools : [];
  const candidateTools = Array.isArray(intent.candidateTools) ? intent.candidateTools : [];
  const needsWeb = selectedTools.includes('web_search') || candidateTools.includes('web_search');
  if (!needsWeb) return [];
  const topic = normalizeResearchTopic(userText);
  if (!topic) return [];
  const wantsLatest =
    /最新|最近|今日|今天|本周|新闻|发布|版本|价格|current|latest|recent|today|news|release|pricing/i.test(userText);
  const wantsCode = /github|issue|源码|开源|库|框架|实现|bug|报错|兼容|sdk|api|mcp|agent|cache|缓存/i.test(userText);
  const wantsCompare = /对比|比较|方案|竞品|替代|差异|优劣|benchmark|compare|versus|vs/i.test(userText);
  const plan: SearchPlanItem[] = [
    {
      purpose: '官方资料',
      query: `${topic} official documentation`,
      reason: '先确认官方定义、参数、限制和推荐用法。',
    },
  ];
  if (wantsCode) {
    plan.push({
      purpose: 'GitHub / Issue',
      query: `${topic} GitHub issues implementation`,
      reason: '查找真实实现、已知问题和社区修复记录。',
    });
  }
  if (wantsLatest) {
    plan.push({
      purpose: '近期资料',
      query: `${topic} latest 2026 release news`,
      reason: '确认最近变化，避免依赖过期信息。',
    });
  }
  if (wantsCompare || plan.length < 3) {
    plan.push({
      purpose: '对比资料',
      query: `${topic} comparison best practices`,
      reason: '找可借鉴方案并对比取舍。',
    });
  }
  return dedupeSearchPlan(plan).slice(0, 4);
}

export function buildAgentPlanSummary(
  intent: Partial<AgentIntent> = {},
  tools: ToolDef[] = [],
  settings: AgentSettings = {},
  maxRounds: number = DEFAULT_AGENT_MAX_ROUNDS,
  userText: string = ''
): AgentPlanSummary {
  const selectedTools = Array.isArray(intent.selectedTools) ? intent.selectedTools : [];
  const candidateTools = Array.isArray(intent.candidateTools) ? intent.candidateTools : [];
  const missingPrerequisites = Array.isArray(intent.missingPrerequisites) ? intent.missingPrerequisites : [];
  const availableToolNames = (tools || [])
    .map((tool) => tool?.function?.name)
    .filter(Boolean)
    .sort((a: string, b: string) => a.localeCompare(b)) as string[];
  const toolMode = intent.toolMode || 'none';
  const explicitDirectives = Array.isArray(intent.explicitDirectives) ? intent.explicitDirectives : [];
  const wantsChangedContext = explicitDirectives.includes('changed');
  const steps: string[] = [];

  steps.push('理解用户目标并确认本轮需要的上下文。');
  if (selectedTools.includes('web_search')) {
    steps.push('检索外部资料，优先保留可引用来源。');
  }
  if (selectedTools.includes('project_map')) {
    steps.push('生成项目结构地图，快速了解整体目录布局和关键入口文件。');
  }
  if (selectedTools.includes('git_status') || selectedTools.includes('git_diff')) {
    steps.push(
      wantsChangedContext
        ? '查看 Git 状态和变更差异，聚焦最近修改的文件和代码。'
        : '查看 Git 状态和变更差异，确认当前工作区的版本控制情况。'
    );
  }
  if (selectedTools.includes('git_log')) {
    steps.push('查看最近提交历史，了解代码演进和作者变更脉络。');
  }
  if (selectedTools.includes('index_workspace')) {
    steps.push(
      wantsChangedContext
        ? '建立或刷新工作区轻量索引，后续变更搜索可复用稳定 file:line 证据。'
        : '建立或刷新工作区轻量索引，保证后续搜索能返回稳定 file:line 证据。'
    );
  }
  if (wantsChangedContext && selectedTools.includes('list_files')) {
    steps.push('先列出最近 7 天修改的工作区文件，按修改时间筛出候选变更。');
  }
  if (
    selectedTools.some((name) =>
      ['list_files', 'search_workspace', 'read_symbol', 'read_file', 'read_many_files'].includes(name)
    )
  ) {
    steps.push(
      wantsChangedContext
        ? '读取关键变更文件或相关符号，收集 file:line 证据并区分已验证与待确认。'
        : '搜索或读取工作区文件，收集 file:line 证据。'
    );
  }
  if (selectedTools.includes('run_code')) {
    steps.push('在用户确认后运行小段代码或实验，并记录退出码与输出。');
  }
  if (selectedTools.includes('mcp')) {
    steps.push('按需调用已启用 MCP 工具，并记录 server/tool 证据。');
  }
  if (steps.length === 1) {
    steps.push('无需工具时直接回答，并标注不确定信息。');
  }
  steps.push('整理回答并说明使用过的工具、来源和限制。');

  const approvalPolicy = buildPlanApprovalPolicy(selectedTools, settings);
  const searchPlan = buildResearchSearchPlan(userText, intent as AgentIntent, settings);
  const warnings: string[] = [];
  if (missingPrerequisites.length) {
    warnings.push(`缺少配置：${missingPrerequisites.join('、')}`);
  }
  if (settings.activeSkill === 'agent_auto' && toolMode === 'none' && candidateTools.length > 0) {
    warnings.push('检测到可能需要工具，但当前可用工具不足，本轮会先提示配置。');
  }
  if (wantsChangedContext && selectedTools.includes('list_files')) {
    warnings.push('变更分析会优先查看最近修改文件；如工作区未启用 Git，只按文件修改时间判断。');
  }

  return {
    type: 'deepchat.agentPlan',
    version: 1,
    mode: toolMode,
    confidence: Number(intent.confidence || 0),
    maxRounds,
    reason: intent.reason || 'plain_chat',
    steps,
    selectedTools,
    candidateTools,
    availableToolNames,
    searchPlan,
    missingPrerequisites,
    approvalPolicy,
    warnings,
  };
}
