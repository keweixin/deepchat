import { SKILLS, hasNativeBridge, isSkillRunnable } from './api.js';

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

function hasEnabledMcpServer(settings = {}) {
  return (settings.mcpServers || []).some((server) => server?.enabled !== false && server?.command);
}

function getComposerToolRisk(id) {
  if (id === 'none' || id === 'agent_auto') return '低风险';
  if (id === 'web_search' || id === 'file_reader') return '需确认';
  if (id === 'code_runner' || id === 'mcp_tool' || id === 'multi_tool') return '高风险确认';
  return '需确认';
}
