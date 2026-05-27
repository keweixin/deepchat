import { SKILLS, detectAgentIntent, extractContextMentions, hasNativeBridge, isSkillRunnable } from './api.js';

export const COMPOSER_TOOL_IDS = Object.freeze([
  'agent_auto',
  'none',
  'web_search',
  'file_reader',
  'code_runner',
  'mcp_tool',
  'multi_tool',
]);

export function buildComposerToolEntries(settings = {}, activeSkill = settings.activeSkill) {
  const current = activeSkill || settings.activeSkill || 'agent_auto';
  return COMPOSER_TOOL_IDS
    .filter((id) => SKILLS[id])
    .map((id) => {
      const skill = SKILLS[id];
      const available = isSkillRunnable(id, { ...settings, activeSkill: id });
      return {
        id,
        name: skill.name,
        icon: skill.icon,
        description: skill.description,
        active: id === current,
        available,
        state: available ? '可用' : getComposerToolUnavailableReason(id, settings),
        risk: getComposerToolRisk(id),
      };
    });
}

export function getComposerToolModeLabel(id) {
  return SKILLS[id]?.name || '标准';
}

export function getComposerToolUnavailableReason(id, settings = {}) {
  if (!hasNativeBridge() && id !== 'agent_auto' && id !== 'none' && id !== 'web_search') return '需桌面版';
  if (id === 'web_search' && !settings.tavilyApiKey) return '需 Tavily Key';
  if (id === 'file_reader' && !Array.isArray(settings.workspaceRoots)) return '需工作区';
  if (id === 'file_reader' && settings.workspaceRoots.length === 0) return '需工作区';
  if (id === 'code_runner' && settings.runCodeEnabled === false) return '代码运行已关闭';
  if (id === 'mcp_tool' && !hasEnabledMcpServer(settings)) return '需 MCP';
  if (id === 'multi_tool' && !hasAnyToolConfigured(settings)) return '需配置工具';
  return '不可用';
}

export function hasAnyToolConfigured(settings = {}) {
  if (settings.tavilyApiKey) return true;
  if (Array.isArray(settings.workspaceRoots) && settings.workspaceRoots.length > 0) return true;
  if (settings.runCodeEnabled !== false && hasNativeBridge()) return true;
  return hasEnabledMcpServer(settings);
}

export function buildComposerIntentPreview(inputText = '', settings = {}) {
  const text = String(inputText || '').trim();
  if (!text || settings.activeSkill !== 'agent_auto') {
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
      text: `预判：${selectedLabels} · 执行前会确认`,
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

export function buildComposerContextPreview(inputText = '', settings = {}) {
  const items = [];
  const mentions = extractContextMentions(inputText);
  const roots = Array.isArray(settings.workspaceRoots) ? settings.workspaceRoots : [];
  const activeSkill = settings.activeSkill || 'agent_auto';
  const hasWebDirective = /(?:^|[\s([，,;；])@(?:web|search)\b/i.test(String(inputText || ''));
  const hasRunDirective = /(?:^|[\s([，,;；])@(?:run|code)\b/i.test(String(inputText || ''));
  const hasMcpDirective = /(?:^|[\s([，,;；])@mcp\b/i.test(String(inputText || ''));
  const intent = buildComposerIntentPreview(inputText, settings);
  const needsWorkspace = roots.length
    || mentions.length > 0
    || activeSkill === 'file_reader'
    || activeSkill === 'multi_tool'
    || (intent.state === 'warning' && /工作区/.test(intent.text || intent.title || ''));

  if (roots.length) {
    items.push({ kind: 'workspace', label: roots.length === 1 ? '工作区 1 个' : `工作区 ${roots.length} 个`, tone: 'ready' });
  } else if (needsWorkspace) {
    items.push({ kind: 'workspace', label: '未选工作区', tone: 'muted', title: '需要本地文件工具时，请先在设置中添加工作区。' });
  }

  for (const mention of mentions.slice(0, 6)) {
    items.push({
      kind: mention.type,
      label: mention.label,
      tone: roots.length ? 'ready' : 'warning',
      title: roots.length ? '将作为显式上下文提示，工具执行前仍会确认。' : '缺少工作区，模型会被提示先让你配置。',
    });
  }

  const toolLabel = getComposerToolModeLabel(activeSkill);
  items.push({
    kind: 'tool',
    label: `工具 ${toolLabel}`,
    tone: activeSkill === 'none' ? 'muted' : 'ready',
  });

  if (intent.text) {
    items.push({
      kind: 'intent',
      label: intent.text.replace(/^预判：/, ''),
      tone: intent.state === 'warning' ? 'warning' : (intent.state === 'tool' ? 'ready' : 'muted'),
      title: intent.title,
    });
  }

  if (activeSkill === 'web_search' || activeSkill === 'multi_tool' || hasWebDirective) {
    items.push({
      kind: 'web',
      label: settings.tavilyApiKey ? '联网可用' : '联网缺 Tavily Key',
      tone: settings.tavilyApiKey ? 'ready' : 'warning',
    });
  }

  if (activeSkill === 'code_runner' || activeSkill === 'multi_tool' || hasRunDirective) {
    items.push({
      kind: 'run',
      label: settings.runCodeEnabled === false ? '代码运行关闭' : '代码运行需确认',
      tone: settings.runCodeEnabled === false ? 'warning' : 'danger',
      title: '运行代码、写入和外部操作不会隐藏执行。',
    });
  }

  if (activeSkill === 'mcp_tool' || hasMcpDirective) {
    const servers = getMcpServerPreviewItems(settings);
    const count = servers.filter((server) => server.enabled).length;
    items.push({
      kind: 'mcp',
      label: count ? `MCP ${count} 个` : 'MCP 未配置',
      tone: count ? 'ready' : 'warning',
    });
    for (const server of servers.slice(0, 4)) {
      items.push({
        kind: 'mcp-server',
        label: `MCP ${server.name} ${server.enabled ? '✓' : '×'}`,
        tone: server.enabled ? 'ready' : 'warning',
        title: server.enabled ? '该 MCP Server 已启用并配置命令。' : server.reason,
      });
    }
  }

  items.push({
    kind: 'approval',
    label: settings.toolApprovalPolicy === 'auto_readonly' ? '只读工具可自动通过' : '工具调用需确认',
    tone: settings.toolApprovalPolicy === 'auto_readonly' ? 'ready' : 'muted',
  });

  return {
    items: dedupePreviewItems(items).slice(0, 10),
    title: '本轮将使用的上下文和工具。显式 @file/@folder/@symbol 会优先影响工具选择。',
  };
}

function hasEnabledMcpServer(settings = {}) {
  return (settings.mcpServers || []).some((server) => server?.enabled !== false && server?.command);
}

function getMcpServerPreviewItems(settings = {}) {
  return (Array.isArray(settings.mcpServers) ? settings.mcpServers : [])
    .map((server, index) => {
      const name = String(server?.name || server?.id || `server-${index + 1}`).trim();
      const command = String(server?.command || '').trim();
      const disabled = server?.enabled === false;
      return {
        name,
        enabled: Boolean(!disabled && command),
        reason: disabled ? '该 MCP Server 已关闭。' : '该 MCP Server 缺少启动命令。',
      };
    })
    .filter((server) => server.name);
}

function formatToolLabels(tools = []) {
  const labels = [];
  const add = (label) => {
    if (label && !labels.includes(label)) labels.push(label);
  };
  for (const tool of tools) {
    if (tool === 'web_search') add('联网搜索');
    else if (tool === 'run_code') add('代码运行');
    else if (tool === 'mcp') add('MCP');
    else if (tool === 'list_files' || tool === 'search_workspace' || tool === 'read_symbol' || tool === 'read_file') add('工作区文件');
    else add(tool);
  }
  return labels.join('、');
}

function buildIntentPreviewTitle(intent = {}, missing = []) {
  return [
    `模式：${intent.toolMode || 'none'}`,
    `置信度：${Math.round(Number(intent.confidence || 0) * 100)}%`,
    intent.reason ? `原因：${intent.reason}` : '',
    intent.selectedTools?.length ? `可用工具：${formatToolLabels(intent.selectedTools)}` : '',
    intent.candidateTools?.length ? `候选工具：${formatToolLabels(intent.candidateTools)}` : '',
    missing.length ? `缺少配置：${missing.join('、')}` : '',
  ].filter(Boolean).join('\n');
}

function getComposerToolRisk(id) {
  if (id === 'none' || id === 'agent_auto') return '低风险';
  if (id === 'web_search' || id === 'file_reader') return '需确认';
  if (id === 'code_runner' || id === 'mcp_tool' || id === 'multi_tool') return '高风险确认';
  return '需确认';
}

function dedupePreviewItems(items = []) {
  const seen = new Set();
  const out = [];
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
