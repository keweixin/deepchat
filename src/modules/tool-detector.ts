import { getSettings } from './settings-core.js';
import { stripVolatileContextBlocks } from './context-mentions.ts';
import { getLastUserContent } from './shared-utils.js';

const DIRECTIVE_TEXT_PATTERN = /`[\s\S]*?`/g;

export interface AgentIntent {
  kind: string;
  toolMode: string;
  selectedTools: string[];
  candidateTools: string[];
  missingPrerequisites: string[];
  confidence: number;
  explicitDirectives: string[];
  reason: string;
}

export function detectAgentIntent(
  messagesOrText: string | Array<Record<string, unknown>>,
  settings: Record<string, unknown> = getSettings()
): AgentIntent {
  const text = stripVolatileContextBlocks(
    Array.isArray(messagesOrText)
      ? getLastUserContent(messagesOrText as Array<Record<string, unknown>>)
      : String(messagesOrText || '')
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
    if (settings.runCodeEnabled === false) missing.add('代码运行工具');
    else selected.add('run_code');
  }
  if (directives.changed) {
    candidates.add('index_workspace');
    candidates.add('list_files');
    candidates.add('search_workspace');
    candidates.add('read_symbol');
    candidates.add('read_file');
    reasons.push('explicit_changed_context');
    score += 0.65;
    if (Array.isArray(settings.workspaceRoots) && (settings.workspaceRoots as unknown[]).length > 0) {
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
    if (((settings.mcpServers as any[]) || []).some((server) => server?.enabled !== false && server?.command))
      selected.add('mcp');
    else missing.add('MCP Server');
  }

  if (!candidates.has('web_search') && needsSearch(text, lower)) {
    candidates.add('web_search');
    reasons.push('fresh_or_external_facts');
    score += 0.35;
    if (settings.tavilyApiKey) selected.add('web_search');
    else missing.add('Tavily API Key');
  }
  if (!candidates.has('list_files') && needsFiles(text, lower)) {
    candidates.add('index_workspace');
    candidates.add('list_files');
    candidates.add('search_workspace');
    candidates.add('read_symbol');
    candidates.add('read_file');
    reasons.push('local_files');
    score += 0.35;
    if (Array.isArray(settings.workspaceRoots) && (settings.workspaceRoots as unknown[]).length > 0) {
      selected.add('index_workspace');
      selected.add('list_files');
      selected.add('search_workspace');
      selected.add('read_symbol');
      selected.add('read_file');
    } else {
      missing.add('工作区目录');
    }
  }
  if (!candidates.has('run_code') && needsCode(text, lower)) {
    candidates.add('run_code');
    reasons.push('code_or_calculation');
    score += 0.3;
    if (settings.runCodeEnabled === false) missing.add('代码运行工具');
    else selected.add('run_code');
  }
  if (!candidates.has('mcp') && needsMcp(text, lower)) {
    candidates.add('mcp');
    reasons.push('external_mcp');
    score += 0.25;
    if (((settings.mcpServers as any[]) || []).some((server) => server?.enabled !== false && server?.command))
      selected.add('mcp');
    else missing.add('MCP Server');
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
      selected.has('read_file')) &&
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

function detectExplicitToolDirectives(content = ''): Record<string, boolean> {
  const text = stripVolatileContextBlocks(content).replace(DIRECTIVE_TEXT_PATTERN, ' ');
  return {
    web: hasAtDirective(text, ['web', 'search']),
    code: hasAtDirective(text, ['run', 'code']),
    changed: hasAtDirective(text, ['changed', 'recent']),
    mcp: hasAtDirective(text, ['mcp']),
  };
}

function hasAtDirective(text: string, names: string[]): boolean {
  const group = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?:^|[\\s([，,;；])@(?:${group})(?:\\b|\\s*:|$)`, 'i').test(String(text || ''));
}

function needsSearch(text: string, lower: string): boolean {
  return (
    /最新|新闻|今日|今天|今年|实时|刚刚|本周|价格|版本|政策|法规|官网|资料|搜索|查询|查一下|联网|来源|引用|current|latest|today|news|price|version|release|search|source/i.test(
      text
    ) ||
    (/20\d{2}/.test(lower) && needsYearScopedExternalLookup(text))
  );
}

function needsYearScopedExternalLookup(text: string): boolean {
  return /价格|版本|政策|法规|官网|资料|数据|统计|趋势|报告|来源|引用|发布|名单|榜单|排名|current|latest|news|price|version|release|source|data|report|trend|ranking|schedule|score/i.test(
    text
  );
}

function needsFiles(text: string, lower: string): boolean {
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

function needsCode(text: string, lower: string): boolean {
  return (
    /运行|执行|调试|复现|验证.*代码|算一下|计算|单元测试|测试一下|run code|debug|reproduce|calculate|execute/i.test(
      text
    ) || /```/.test(lower)
  );
}

function needsMcp(text: string, lower: string): boolean {
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
