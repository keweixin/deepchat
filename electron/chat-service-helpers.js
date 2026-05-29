// @ts-nocheck
const { DEFAULT_AGENT_MAX_ROUNDS } = require('./agent-planner.ts');
const { isMcpToolName } = require('./mcp-manager');
const { parseToolArgsDetailed, compactToolOutputForContext } = require('./tool-executor.ts');
const { estimateTokens } = require('./usage-meter');

const DEFAULT_MAX_INPUT_TOKENS = 24000;
const AGENT_EXECUTION_MODES = new Set(['execute_all', 'single_step']);

function attachPrefixProfile(usage, prefix, settings = {}) {
  usage.prefixFingerprint = prefix.prefixFingerprint;
  usage.prefixBytes = prefix.prefixBytes;
  usage.prefixTokens = prefix.prefixTokens;
  usage.cacheStabilityWarnings = prefix.cacheStabilityWarnings || [];
  usage.cacheStabilityReasons = prefix.cacheStabilityReasons || [];
  usage.cacheStabilityDetails = prefix.cacheStabilityDetails || {};
  usage.cacheProfile = {
    ...(prefix.profile || {}),
    model: String(settings.model || prefix.profile?.model || ''),
    cacheHit: usage.cacheHit,
    cacheMiss: usage.cacheMiss,
    cacheHitRate: usage.cacheHitRate,
    estimatedCostUsd: usage.cost?.estimatedCostUsd || 0,
    estimatedSavingsUsd: usage.cost?.estimatedSavingsUsd || 0,
    cacheStabilityWarnings: prefix.cacheStabilityWarnings || [],
    cacheStabilityReasons: prefix.cacheStabilityReasons || [],
    cacheStabilityDetails: prefix.cacheStabilityDetails || {},
  };
  return usage;
}

function applyRequestOverrides(settings, overrides = {}) {
  const next = { ...settings };
  if (overrides.thinkingBudget !== undefined) next.thinkingBudget = Number.parseInt(overrides.thinkingBudget, 10) || 0;
  if (overrides.activeSkill !== undefined) next.activeSkill = String(overrides.activeSkill || 'none');
  if (overrides.enhance !== undefined) next.enhance = overrides.enhance !== false;
  if (overrides.agentMaxRounds !== undefined)
    next.agentMaxRounds = Number.parseInt(overrides.agentMaxRounds, 10) || DEFAULT_AGENT_MAX_ROUNDS;
  if (overrides.maxInputTokens !== undefined)
    next.maxInputTokens = Number.parseInt(overrides.maxInputTokens, 10) || DEFAULT_MAX_INPUT_TOKENS;
  if (overrides.agentExecutionMode !== undefined)
    next.agentExecutionMode = normalizeAgentExecutionMode(overrides.agentExecutionMode);
  return next;
}

function normalizeAgentExecutionMode(value) {
  const mode = String(value || 'execute_all');
  return AGENT_EXECUTION_MODES.has(mode) ? mode : 'execute_all';
}

function buildSingleStepStopReason(toolResults = []) {
  const names = (Array.isArray(toolResults) ? toolResults : [])
    .map(({ toolCall }) => toolCall?.function?.name || 'unknown_tool')
    .filter(Boolean);
  const summary = names.length ? `已完成单步执行：${names.join(', ')}。` : '已完成单步执行。';
  return `${summary}已暂停后续工具轮次；可继续点击"单步执行"推进下一步，或点击"执行全部"让 Agent 按计划继续。`;
}

function buildToolNextAction(name, args = {}, outcome = {}) {
  const toolName = String(name || 'unknown_tool');
  if (outcome.parseError) {
    return '让模型重新发送合法 JSON 参数；不要执行空参数工具调用。';
  }
  if (outcome.denied) {
    if (outcome.timedOut) {
      return '确认超时后已停止该工具；可以重新点击执行，或改用"修改计划"减少本步工具调用。';
    }
    return '已按用户选择停止该工具；可以修改计划、换用低风险读取/搜索工具，或重新确认后继续。';
  }
  if (toolName === 'web_search') {
    return '检查 Tavily Key、网络连接和 query；必要时缩小关键词或降低 max_results 后重试。';
  }
  if (['index_workspace', 'list_files', 'search_workspace', 'read_symbol', 'read_file'].includes(toolName)) {
    const target = String(args.path || args.directory || args.root || args.symbol || args.query || '').trim();
    return target
      ? `确认工作区授权、路径/符号是否存在：${target.slice(0, 160)}；必要时先 list_files 或 search_workspace 定位。`
      : '确认工作区已授权；必要时先 list_files 或 search_workspace 定位目标文件。';
  }
  if (toolName === 'run_code') {
    return '查看 stderr/stdout 和退出码；必要时缩小代码片段、补充依赖前置条件，或改为只生成代码不运行。';
  }
  if (isMcpToolName(toolName)) {
    return '检查 MCP Server 是否在线、工具参数 schema 是否变化；可在设置中刷新 MCP 状态后重试。';
  }
  return '检查工具名称、参数和可用配置；必要时修改计划后重试。';
}

function parseToolArgs(raw) {
  return parseToolArgsDetailed(raw).args;
}

function buildToolContextOutput(toolName, args, output) {
  const raw = String(output || '');
  const contextOutput = compactToolOutputForContext(toolName, args, raw);
  return {
    contextOutput,
    rawOutputTokens: estimateTokens(raw),
    contextOutputTokens: estimateTokens(contextOutput),
    contextCompacted: contextOutput !== raw,
  };
}

module.exports = {
  DEFAULT_MAX_INPUT_TOKENS,
  AGENT_EXECUTION_MODES,
  attachPrefixProfile,
  applyRequestOverrides,
  normalizeAgentExecutionMode,
  buildSingleStepStopReason,
  buildToolNextAction,
  parseToolArgs,
  buildToolContextOutput,
};
