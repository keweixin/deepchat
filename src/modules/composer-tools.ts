import { SKILLS, isSkillRunnable } from './api.js';
import { detectAgentIntent } from './tool-detector.js';
import { extractContextMentions } from './context-mentions.js';
import { hasNativeBridge } from './bridge.js';

export const COMPOSER_TOOL_IDS: readonly string[] = Object.freeze([
  'agent_auto',
  'none',
  'web_search',
  'file_reader',
  'code_runner',
  'mcp_tool',
  'multi_tool',
]);

export function buildComposerToolEntries(
  settings: Record<string, unknown> = {},
  activeSkill = (settings as any).activeSkill
): any[] {
  const current = activeSkill || (settings as any).activeSkill || 'agent_auto';
  return COMPOSER_TOOL_IDS.filter((id) => SKILLS[id]).map((id) => {
    const skill = (SKILLS as any)[id];
    const available = isSkillRunnable(id, { ...settings, activeSkill: id });
    return {
      id,
      name: skill.name,
      icon: skill.icon,
      description: skill.description,
      active: id === current,
      available,
      state: available ? '可用' : getComposerToolUnavailableReason(id, settings),
      risk: getComposerToolRisk(id, settings),
    };
  });
}

export function getComposerToolModeLabel(id: string): string {
  return (SKILLS as any)[id]?.name || '标准';
}

export function getComposerToolUnavailableReason(id: string, settings: Record<string, unknown> = {}): string {
  if (!hasNativeBridge() && id !== 'agent_auto' && id !== 'none' && id !== 'web_search') return '需桌面版';
  if (id === 'web_search' && !hasSearchCapability(settings)) {
    return hasNativeBridge() ? '需 Tavily Key 或搜索兜底' : '需 Tavily Key';
  }
  if (id === 'file_reader' && !Array.isArray((settings as any).workspaceRoots)) return '需工作区';
  if (id === 'file_reader' && (settings as any).workspaceRoots.length === 0) return '需工作区';
  if (id === 'code_runner' && (settings as any).runCodeEnabled === false) return '代码运行已关闭';
  if (id === 'mcp_tool' && !hasEnabledMcpServer(settings)) return '需 MCP';
  if (id === 'multi_tool' && !hasAnyToolConfigured(settings)) return '需配置工具';
  return '不可用';
}

export function hasAnyToolConfigured(settings: Record<string, unknown> = {}): boolean {
  if (hasSearchCapability(settings)) return true;
  if (Array.isArray((settings as any).workspaceRoots) && (settings as any).workspaceRoots.length > 0) return true;
  if ((settings as any).runCodeEnabled !== false && hasNativeBridge()) return true;
  return hasEnabledMcpServer(settings);
}

export function buildSendPreflightBlocker(
  inputText = '',
  settings: Record<string, unknown> = {},
  providerReport: Record<string, any> = {}
): { code: string; message: string; openSettings?: boolean } | null {
  const activeSkill = String((settings as any).activeSkill || 'agent_auto');
  const toolMode = resolveActiveSkillForExplicitDirectives(inputText, settings, activeSkill);
  const explicitMcp = /(?:^|[\s([，,;；])@mcp\b/i.test(String(inputText || ''));
  const wantsTools = toolMode && !['none', 'agent_auto'].includes(toolMode);
  const providerTools = providerReport?.capabilities?.tools;

  if ((wantsTools || explicitMcp) && providerTools === false) {
    return {
      code: 'provider_tools_unsupported',
      message: '当前模型不支持工具调用。请切换到支持 tool_calls 的模型，或改用“日常/标准聊天”只回答文字。',
      openSettings: true,
    };
  }

  if (toolMode === 'mcp_tool' || explicitMcp) {
    return buildMcpSendBlocker(settings);
  }

  if (toolMode === 'multi_tool' && !hasAnyToolConfigured(settings)) {
    return {
      code: 'no_tool_configured',
      message: '当前没有可用工具。请先配置搜索、工作区、代码运行或 MCP，再发送工具型任务。',
      openSettings: true,
    };
  }

  return null;
}

export function resolveActiveSkillForExplicitDirectives(
  inputText = '',
  settings: Record<string, unknown> = {},
  fallbackActiveSkill = (settings as any).activeSkill || 'agent_auto'
): string {
  const text = String(inputText || '');
  const requested = new Set<string>();
  if (/(?:^|[\s([，,;；])@(?:file|folder|symbol|changed)\b/i.test(text)) requested.add('file_reader');
  if (/(?:^|[\s([，,;；])@(?:web|search)\b/i.test(text)) requested.add('web_search');
  if (/(?:^|[\s([，,;；])@(?:run|code)\b/i.test(text)) requested.add('code_runner');
  if (/(?:^|[\s([，,;；])@mcp\b/i.test(text)) requested.add('mcp_tool');
  if (!requested.size) return fallbackActiveSkill || 'agent_auto';

  const available = [...requested].filter((skill) => isSkillRunnable(skill, { ...settings, activeSkill: skill }));
  if (!available.length) return fallbackActiveSkill || 'agent_auto';
  if (available.length === 1) return available[0];
  if (isSkillRunnable('multi_tool', { ...settings, activeSkill: 'multi_tool' })) return 'multi_tool';
  return available[0];
}

export function buildComposerIntentPreview(inputText = '', settings: Record<string, unknown> = {}): any {
  const text = String(inputText || '').trim();
  if (!text || (settings as any).activeSkill !== 'agent_auto') {
    return { text: '', title: '', state: 'idle', intent: null };
  }
  const intent = detectAgentIntent(text, settings);
  const selectedLabels = formatToolLabels(intent.selectedTools || []);
  const candidateLabels = formatToolLabels(intent.candidateTools || []);
  const missing = Array.isArray(intent.missingPrerequisites) ? intent.missingPrerequisites : [];

  if (missing.length > 0) {
    return {
      text: `预判：需要 ${candidateLabels || intent.reason || '工具'} · 缺 ${missing.join('、')}`,
      title: buildIntentPreviewTitle(intent, missing),
      state: 'warning',
      intent,
    };
  }
  if (selectedLabels) {
    return {
      text: `预判：${selectedLabels} · ${getIntentApprovalPreview(intent.selectedTools, settings)}`,
      title: buildIntentPreviewTitle(intent, missing),
      state: 'tool',
      intent,
    };
  }
  return {
    text: '预判：普通聊天',
    title: buildIntentPreviewTitle(intent, missing),
    state: 'chat',
    intent,
  };
}

export function buildComposerContextPreview(inputText = '', settings: Record<string, unknown> = {}): any {
  const items: any[] = [];
  const rawInput = String(inputText || '');
  const hasInputText = Boolean(rawInput.trim());
  const mentions = extractContextMentions(inputText);
  const roots = Array.isArray((settings as any).workspaceRoots) ? (settings as any).workspaceRoots : [];
  const configuredActiveSkill = (settings as any).activeSkill || 'agent_auto';
  const activeSkill = resolveActiveSkillForExplicitDirectives(inputText, settings, configuredActiveSkill);
  const effectiveSettings = { ...settings, activeSkill };
  const hasWebDirective = /(?:^|[\s([，,;；])@(?:web|search)\b/i.test(String(inputText || ''));
  const hasRunDirective = /(?:^|[\s([，,;；])@(?:run|code)\b/i.test(String(inputText || ''));
  const hasMcpDirective = /(?:^|[\s([，,;；])@mcp\b/i.test(String(inputText || ''));
  const hasChangedDirective = /(?:^|[\s([，,;；])@(?:changed|recent)\b/i.test(String(inputText || ''));
  const intent = buildComposerIntentPreview(inputText, effectiveSettings);
  const needsWorkspace =
    roots.length ||
    mentions.length > 0 ||
    activeSkill === 'file_reader' ||
    activeSkill === 'multi_tool' ||
    (intent.state === 'warning' && /工作区/.test(intent.text || intent.title || ''));

  if (roots.length && (mentions.length > 0 || hasChangedDirective)) {
    items.push({
      kind: 'workspace',
      label: roots.length === 1 ? '工作区 1 个' : `工作区 ${roots.length} 个`,
      tone: 'ready',
    });
  } else if (!roots.length && needsWorkspace) {
    items.push({
      kind: 'workspace',
      label: '未选工作区',
      tone: 'muted',
      title: '需要本地文件工具时，请先在设置中添加工作区。',
    });
  }

  for (const mention of mentions.slice(0, 6)) {
    items.push({
      kind: mention.type,
      label: mention.label,
      tone: roots.length ? 'ready' : 'warning',
      title: roots.length ? '将作为显式上下文提示，工具执行前仍会确认。' : '缺少工作区，模型会被提示先让你配置。',
    });
  }

  const localRoute = buildExplicitContextToolRoute(mentions, { includeChanged: hasChangedDirective });
  if (localRoute) {
    items.push({
      kind: 'context-route',
      label: localRoute.label,
      tone: roots.length ? 'ready' : 'warning',
      title: roots.length
        ? `${localRoute.title}。工具执行仍遵循当前审批策略。`
        : `${localRoute.title}；但当前缺少工作区，发送后会提示先完成配置。`,
    });
  }

  const shouldShowToolMode =
    hasInputText &&
    (activeSkill !== 'agent_auto' ||
      configuredActiveSkill !== 'agent_auto' ||
      mentions.length > 0 ||
      hasChangedDirective);
  if (shouldShowToolMode) {
    const toolLabel = getComposerToolModeLabel(activeSkill);
    items.push({
      kind: 'tool',
      label: `工具 ${toolLabel}`,
      tone: activeSkill === 'none' ? 'muted' : 'ready',
    });
  }

  if (intent.text && intent.state !== 'chat') {
    items.push({
      kind: 'intent',
      label: intent.text.replace(/^预判：/, ''),
      tone: intent.state === 'warning' ? 'warning' : intent.state === 'tool' ? 'ready' : 'muted',
      title: intent.title,
    });
  }

  if (
    hasWebDirective ||
    (hasInputText && (configuredActiveSkill === 'web_search' || configuredActiveSkill === 'multi_tool'))
  ) {
    const hasSearch = hasSearchCapability(settings);
    items.push({
      kind: 'web',
      label: hasSearch ? ((settings as any).tavilyApiKey ? '联网可用' : '搜索兜底可用') : '联网缺 Tavily Key',
      tone: hasSearch ? 'ready' : 'warning',
    });
  }

  if (
    hasRunDirective ||
    (hasInputText && (configuredActiveSkill === 'code_runner' || configuredActiveSkill === 'multi_tool'))
  ) {
    items.push({
      kind: 'run',
      label: (settings as any).runCodeEnabled === false ? '代码运行关闭' : '代码运行需确认',
      tone: (settings as any).runCodeEnabled === false ? 'warning' : 'danger',
      title: '运行代码、写入和外部操作不会隐藏执行。',
    });
  }

  if (
    hasMcpDirective ||
    (hasInputText && (configuredActiveSkill === 'mcp_tool' || configuredActiveSkill === 'multi_tool'))
  ) {
    const servers = getMcpServerPreviewItems(settings);
    const configuredCount = servers.filter((server: any) => server.configured).length;
    const readyCount = servers.filter((server: any) => server.ready).length;
    const toolCount = servers.reduce((sum: number, server: any) => sum + (server.toolCount || 0), 0);
    items.push({
      kind: 'mcp',
      label: readyCount
        ? `MCP ${readyCount}/${servers.length} 可用${toolCount ? ` · ${toolCount} 工具` : ''}`
        : configuredCount
          ? `MCP ${configuredCount} 个待测试`
          : 'MCP 未配置',
      tone: readyCount ? 'ready' : configuredCount ? 'warning' : 'warning',
      title: servers.length ? '来自 MCP 配置和最近一次状态刷新；MCP 调用仍需确认。' : '请先在设置中添加 MCP Server。',
    });
    for (const server of servers.slice(0, 4)) {
      items.push({
        kind: 'mcp-server',
        label: `MCP ${server.name} ${server.ready ? '✓' : '×'}${server.toolCount ? ` ${server.toolCount}` : ''}`,
        tone: server.ready ? 'ready' : 'warning',
        title: server.reason,
      });
    }
  }

  const hasActionablePreview = items.some((item) =>
    [
      'workspace',
      'file',
      'folder',
      'symbol',
      'changed',
      'context-route',
      'tool',
      'intent',
      'web',
      'run',
      'mcp',
      'mcp-server',
    ].includes(item.kind)
  );
  const maxInputTokens = Number.parseInt((settings as any).maxInputTokens, 10);
  if (hasActionablePreview && Number.isFinite(maxInputTokens) && maxInputTokens > 0 && maxInputTokens < 8000) {
    items.push({
      kind: 'budget',
      label: `输入预算偏低 ${formatCompactTokenCount(maxInputTokens)}`,
      tone: 'warning',
      title: '历史消息会按输入 token 预算裁剪，当前用户消息会优先保留。',
    });
  }
  if (hasActionablePreview && (settings as any).autoContextSummary === false) {
    items.push({
      kind: 'summary',
      label: '自动摘要关闭',
      tone: 'muted',
      title: '长上下文只会按预算裁剪，不会额外生成长期摘要。',
    });
  }
  if (hasActionablePreview && (settings as any).cacheOptimization === false) {
    items.push({
      kind: 'cache',
      label: '缓存优化关闭',
      tone: 'warning',
      title: '本轮不会主动保持缓存友好的固定前缀。',
    });
  }

  const visibleItems = limitPreviewItems(dedupePreviewItems(items), 12);
  return {
    items: visibleItems,
    title: visibleItems.length
      ? '本轮将使用的显式上下文、工具和必要告警。'
      : '普通聊天不展示上下文预览，避免占用输入区。',
  };
}

function hasSearchCapability(settings: Record<string, unknown>): boolean {
  const values = settings as any;
  if (values.tavilyApiKey) return true;
  if (!hasNativeBridge()) return false;
  if (values.docsetSearchEnabled === true && Array.isArray(values.docsetRoots) && values.docsetRoots.length > 0) {
    return true;
  }
  return String(values.localSearchFallbackMode || '') === 'missing_key';
}

function hasEnabledMcpServer(settings: Record<string, unknown> = {}): boolean {
  return ((settings as any).mcpServers || []).some((server: any) => server?.enabled !== false && server?.command);
}

function buildMcpSendBlocker(settings: Record<string, unknown> = {}) {
  const servers = (Array.isArray((settings as any).mcpServers) ? (settings as any).mcpServers : []).filter(
    (server: any) => server?.enabled !== false
  );
  const configuredServers = servers.filter((server: any) => String(server?.command || '').trim());
  if (configuredServers.length === 0) {
    return {
      code: 'mcp_not_configured',
      message: 'MCP 还没有可启动的 server。请在 MCP 设置里填写 server name、command、args 和 cwd 后再试。',
      openSettings: true,
    };
  }

  const statuses = Array.isArray((settings as any).mcpStatuses) ? (settings as any).mcpStatuses : [];
  if (statuses.length === 0) {
    return {
      code: 'mcp_not_tested',
      message: 'MCP 已配置，但还没有最新测试结果。请打开 MCP 设置，先刷新/测试 server，确认有工具后再发送。',
      openSettings: true,
    };
  }

  const statusById = new Map(
    statuses.filter(Boolean).map((status: any) => [String(status.id || status.name || ''), status])
  );
  const relatedStatuses = configuredServers
    .map((server: any) => statusById.get(String(server?.id || server?.name || '')))
    .filter(Boolean);
  const sourceStatuses = relatedStatuses.length > 0 ? relatedStatuses : statuses;
  const usable = sourceStatuses.some((status: any) => {
    const toolCount = Number(status?.toolCount ?? status?.tools?.length ?? 0) || 0;
    return Boolean(status?.ok) && toolCount > 0;
  });
  if (usable) return null;

  const zeroTool = sourceStatuses.find((status: any) => status?.ok);
  if (zeroTool) {
    return {
      code: 'mcp_zero_tools',
      message:
        'MCP server 能连接，但没有返回可用工具。请检查该 server 的 listTools 输出，或在 Tool Lab 里查看工具数量。',
      openSettings: true,
    };
  }

  const failed = sourceStatuses.find((status: any) => status?.error) || {};
  const reason = formatMcpSendFailureReason(String(failed.error || ''));
  return {
    code: 'mcp_unavailable',
    message: `MCP 暂不可用：${reason}。请打开 MCP 设置或 Tool Lab 查看 server 日志后再发送。`,
    openSettings: true,
  };
}

function formatMcpSendFailureReason(error: string): string {
  const text = String(error || '').trim();
  if (!text) return '最近一次测试失败';
  if (/ENOENT|not found|找不到|无法识别/i.test(text)) return '启动命令不存在或不在 PATH 中';
  if (/cwd|working directory|目录不存在|no such file or directory/i.test(text)) return '工作目录不存在或无法访问';
  if (/env|environment|missing.*key|缺少.*环境变量/i.test(text)) return '缺少必要环境变量';
  if (/timeout|timed out|超时/i.test(text)) return '初始化或 listTools 超时';
  return text.slice(0, 160);
}

function getMcpServerPreviewItems(settings: Record<string, unknown> = {}): any[] {
  const statuses = Array.isArray((settings as any).mcpStatuses) ? (settings as any).mcpStatuses : [];
  const byId = new Map(statuses.filter(Boolean).map((status: any) => [String(status.id || ''), status]));
  return (Array.isArray((settings as any).mcpServers) ? (settings as any).mcpServers : [])
    .map((server: any, index: number) => {
      const id = String(server?.id || '').trim();
      const name = String(server?.name || server?.id || `server-${index + 1}`).trim();
      const command = String(server?.command || '').trim();
      const disabled = server?.enabled === false;
      const status = byId.get(id) as any;
      const toolCount = Number(status?.toolCount ?? status?.tools?.length ?? 0) || 0;
      const configured = Boolean(!disabled && command);
      const ready = configured && Boolean(status?.ok);
      const reason = buildMcpServerPreviewReason({ disabled, command, status, toolCount });
      return {
        name,
        configured,
        ready,
        toolCount,
        reason,
      };
    })
    .filter((server: any) => server.name);
}

function buildMcpServerPreviewReason({ disabled, command, status, toolCount }: any): string {
  if (disabled) return '该 MCP Server 已关闭。';
  if (!command) return '该 MCP Server 缺少启动命令。';
  if (!status) return '已配置启动命令，尚未刷新 MCP 状态。';
  if (status.ok) {
    return [
      `最近测试可用，工具 ${toolCount} 个。`,
      status.schemaHash ? `schema ${String(status.schemaHash).slice(0, 8)}` : '',
      status.cacheExpiresAt ? `缓存到 ${status.cacheExpiresAt}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return status.error ? `最近测试失败：${status.error}` : '最近测试失败。';
}

function formatToolLabels(tools: string[] = []): string {
  const labels: string[] = [];
  const add = (label: string) => {
    if (label && !labels.includes(label)) labels.push(label);
  };
  for (const tool of tools) {
    if (tool === 'web_search') add('联网搜索');
    else if (tool === 'run_code') add('代码运行');
    else if (tool === 'mcp') add('MCP');
    else if (tool === 'list_files' || tool === 'search_workspace' || tool === 'read_symbol' || tool === 'read_file')
      add('工作区文件');
    else add(tool);
  }
  return labels.join('、');
}

function buildIntentPreviewTitle(intent: any = {}, missing: string[] = []): string {
  return [
    `模式：${intent.toolMode || 'none'}`,
    `置信度：${Math.round(Number(intent.confidence || 0) * 100)}%`,
    intent.reason ? `原因：${intent.reason}` : '',
    intent.selectedTools?.length ? `可用工具：${formatToolLabels(intent.selectedTools)}` : '',
    intent.candidateTools?.length ? `候选工具：${formatToolLabels(intent.candidateTools)}` : '',
    missing.length ? `缺少配置：${missing.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function getIntentApprovalPreview(selectedTools: string[] = [], settings: Record<string, unknown> = {}): string {
  const tools = Array.isArray(selectedTools) ? selectedTools : [];
  const autoReadonly = (settings as any).toolApprovalPolicy === 'auto_readonly';
  if (!autoReadonly) return '执行前会确认';
  const hasHighRisk = tools.some((tool) => !isReadOnlyToolName(tool));
  const hasReadonly = tools.some((tool) => isReadOnlyToolName(tool));
  if (hasReadonly && hasHighRisk) return '只读自动 · 高风险确认';
  if (hasReadonly) return '只读工具可自动通过';
  return '执行前会确认';
}

function isReadOnlyToolName(toolName = ''): boolean {
  return ['web_search', 'index_workspace', 'list_files', 'search_workspace', 'read_symbol', 'read_file'].includes(
    String(toolName || '')
  );
}

function buildExplicitContextToolRoute(mentions: any[] = [], options: { includeChanged?: boolean } = {}): any | null {
  if ((!Array.isArray(mentions) || mentions.length === 0) && !options.includeChanged) return null;
  const tools: string[] = [];
  const add = (tool: string) => {
    if (tool && !tools.includes(tool)) tools.push(tool);
  };
  if (options.includeChanged) {
    add('index_workspace');
    add('list_files');
    add('search_workspace');
    add('read_symbol');
    add('read_file');
  }
  for (const mention of mentions) {
    if (mention?.type === 'file') add('read_file');
    else if (mention?.type === 'symbol') add('read_symbol');
    else if (mention?.type === 'folder') {
      add('list_files');
      add('search_workspace');
    }
  }
  if (!tools.length) return null;
  return {
    label: `本地工具 ${tools.join(' + ')}`,
    title: `显式上下文会优先映射到 ${tools.join('、')}`,
  };
}

export function getComposerToolRisk(id: string, settings: Record<string, unknown> = {}): string {
  const autoReadonly = (settings as any).toolApprovalPolicy === 'auto_readonly';
  if (id === 'none') return '无工具';
  if (id === 'agent_auto') return '自动判断';
  if (id === 'web_search' || id === 'file_reader') return autoReadonly ? '低风险自动' : '低风险确认';
  if (id === 'code_runner' || id === 'mcp_tool') return '高风险确认';
  if (id === 'multi_tool') return autoReadonly ? '只读自动 · 高风险确认' : '混合风险确认';
  return '需确认';
}

export function getComposerToolApprovalSummary(settings: Record<string, unknown> = {}): string {
  return (settings as any).toolApprovalPolicy === 'auto_readonly'
    ? '低风险读取/搜索工具可自动通过；运行代码、MCP 外部操作和写入类动作仍需确认。'
    : '所有工具调用都会等待你确认后才会执行。';
}

function limitPreviewItems(items: any[] = [], limit = 12): any[] {
  if (!Array.isArray(items) || items.length <= limit) return items;
  const visibleLimit = Math.max(1, limit - 1);
  const visible = items.slice(0, visibleLimit);
  const hidden = items.slice(visibleLimit);
  visible.push({
    kind: 'more',
    label: `另有 ${hidden.length} 项`,
    tone: hidden.some((item: any) => item.tone === 'warning' || item.tone === 'danger') ? 'warning' : 'muted',
    title: hidden
      .map((item: any) => item.label)
      .filter(Boolean)
      .join('\n'),
  });
  return visible;
}

function dedupePreviewItems(items: any[] = []): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const item of items) {
    const label = String(item?.label || '').trim();
    if (!label) continue;
    const key = `${item.kind}:${label}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, label });
  }
  return out;
}

function formatCompactTokenCount(value: unknown): string {
  const count = Number(value) || 0;
  if (count >= 1000) {
    const rounded = Math.round(count / 100) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded}k`;
  }
  return String(count);
}
