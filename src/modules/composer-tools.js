import { SKILLS, detectAgentIntent, hasNativeBridge, isSkillRunnable } from './api.js';

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

function hasEnabledMcpServer(settings = {}) {
  return (settings.mcpServers || []).some((server) => server?.enabled !== false && server?.command);
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
