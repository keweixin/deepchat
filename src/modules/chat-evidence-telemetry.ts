/**
 * Chat Evidence Telemetry — Token usage formatting, cache profiling,
 * and conversation-level usage summary.
 *
 * Pure data-transformation functions extracted from chat.js.
 */

import { normalizeTokenUsage, getConversationUsageSummary } from './token-budget.js';

// ─── Token Usage Formatting ──────────────────────────────────────────────────

export function formatTokenUsageTitle(tokens: Record<string, any>) {
  const usage = normalizeTokenUsage(tokens);
  const profile = tokens?.cacheProfile && typeof tokens.cacheProfile === 'object' ? tokens.cacheProfile : {};
  const lines = [
    `输入: ${usage.input}`,
    `输出: ${usage.output}`,
    `总计: ${usage.total}`,
    `统计来源: ${usage.source === 'provider' ? '服务商真实 usage' : usage.source === 'mixed' ? '真实和估算混合' : '本地估算'}`,
  ];
  if (usage.reasoning > 0) lines.push(`思考: ${usage.reasoning}`);
  if (usage.cacheHit > 0 || usage.cacheMiss > 0) {
    lines.push(`缓存命中: ${usage.cacheHit}`);
    lines.push(`缓存未命中: ${usage.cacheMiss}`);
    lines.push(`命中率: ${Math.round(usage.cacheHitRate * 100)}%`);
  }
  if (usage.cost) {
    lines.push(`估算成本: $${Number(usage.cost.estimatedCostUsd || 0).toFixed(6)}`);
    lines.push(`缓存节省: $${Number(usage.cost.estimatedSavingsUsd || 0).toFixed(6)}`);
  }
  if (tokens.prefixFingerprint) lines.push(`Prefix: ${tokens.prefixFingerprint}`);
  if (profile.systemHash) lines.push(`System hash: ${profile.systemHash}`);
  if (profile.toolsHash) lines.push(`Tools hash: ${profile.toolsHash}`);
  if (profile.workspaceSignature) lines.push(`Workspace hash: ${profile.workspaceSignature}`);
  if (Array.isArray(profile.toolNames) && profile.toolNames.length)
    lines.push(`工具 schema: ${profile.toolNames.join(', ')}`);
  const reasons = normalizeCacheStabilityReasons(tokens.cacheStabilityReasons || profile.cacheStabilityReasons);
  if (reasons.length) lines.push(`Cache miss 可能原因: ${reasons.map(formatCacheStabilityReason).join('、')}`);
  const details = tokens.cacheStabilityDetails || profile.cacheStabilityDetails;
  const detailText = formatCacheStabilityDetails(details);
  if (detailText) lines.push(`变化明细: ${detailText}`);
  if (tokens.byPurpose && Object.keys(tokens.byPurpose).length) {
    lines.push(
      `用途: ${Object.entries(tokens.byPurpose)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`
    );
  }
  if ((usage.rounds || 0) > 1) lines.push(`Agent 轮次: ${usage.rounds}`);
  const warnings = [
    ...(usage.warnings || []),
    ...(tokens.cacheStabilityWarnings || []),
    ...(profile.cacheStabilityWarnings || []),
  ];
  if (warnings.length) lines.push(`提示: ${[...new Set(warnings)].join('；')}`);
  return lines.join('\n');
}

// ─── Conversation Usage Telemetry ────────────────────────────────────────────

export function formatConversationUsageTelemetry(conversation: Record<string, any>) {
  const details = buildConversationUsageTelemetryDetails(conversation);
  if (!details) return null;
  return {
    text: details.text,
    title: details.title,
    hitRate: details.hitRate,
    total: details.usage.total,
  };
}

export function buildConversationUsageTelemetryDetails(conversation: Record<string, any>) {
  const usage = getConversationUsageSummary(conversation);
  if (!usage || usage.total <= 0) return null;
  const profile = getConversationCacheProfile(conversation) || {};
  const hitRate = usage.cacheHit > 0 || usage.cacheMiss > 0 ? Math.round(usage.cacheHitRate * 100) : null;
  const reasons = normalizeCacheStabilityReasons(profile.cacheStabilityReasons);
  const warnings = [...new Set([...(usage.warnings || []), ...(profile.cacheStabilityWarnings || [])])];
  const textParts = [`${formatCompactTokenCount(usage.total)} tok`];
  if (hitRate !== null) textParts.push(`缓存 ${hitRate}%`);
  if (Number(usage.cost?.estimatedSavingsUsd || 0) > 0)
    textParts.push(`省 ${formatUsd(usage.cost?.estimatedSavingsUsd || 0)}`);
  if ((usage.rounds || 0) > 1) textParts.push(`${usage.rounds} 轮`);

  const titleLines = [
    '本会话 Token / Cache 汇总',
    `输入: ${usage.input}`,
    `输出: ${usage.output}`,
    `总计: ${usage.total}`,
    `统计来源: ${usage.source === 'provider' ? '服务商真实 usage' : usage.source === 'mixed' ? '真实和估算混合' : '本地估算'}`,
  ];
  if (usage.reasoning > 0) titleLines.push(`思考: ${usage.reasoning}`);
  if (usage.cacheHit > 0 || usage.cacheMiss > 0) {
    titleLines.push(`缓存命中: ${usage.cacheHit}`);
    titleLines.push(`缓存未命中: ${usage.cacheMiss}`);
    titleLines.push(`命中率: ${hitRate}%`);
  }
  if (usage.cost) {
    titleLines.push(`估算成本: ${formatUsd(usage.cost.estimatedCostUsd || 0)}`);
    titleLines.push(`缓存节省: ${formatUsd(usage.cost.estimatedSavingsUsd || 0)}`);
  }
  if ((usage.rounds || 0) > 1) titleLines.push(`Agent 轮次: ${usage.rounds}`);
  if (profile.prefixFingerprint) titleLines.push(`Prefix: ${profile.prefixFingerprint}`);
  if (profile.prefixTokens) titleLines.push(`Prefix tokens: ${profile.prefixTokens}`);
  if (reasons.length) titleLines.push(`Cache miss 可能原因: ${reasons.map(formatCacheStabilityReason).join('、')}`);
  const detailText = formatCacheStabilityDetails(profile.cacheStabilityDetails);
  if (detailText) titleLines.push(`变化明细: ${detailText}`);
  if (warnings.length) titleLines.push(`提示: ${warnings.join('；')}`);

  return {
    text: textParts.join(' · '),
    title: titleLines.join('\n'),
    sourceLabel: formatUsageSourceLabel(usage.source),
    hitRate,
    hitRateLabel: hitRate === null ? '无缓存 usage' : `${hitRate}%`,
    usage,
    profile,
    reasons,
    warnings,
    detailText,
  };
}

// ─── Cache Profile ───────────────────────────────────────────────────────────

export function buildCacheProfile(tokens: Record<string, any>, contextBudget: Record<string, any>) {
  const usage = normalizeTokenUsage(tokens);
  const profile = tokens?.cacheProfile && typeof tokens.cacheProfile === 'object' ? tokens.cacheProfile : {};
  return {
    ...profile,
    prefixFingerprint: contextBudget?.prefixFingerprint || tokens?.prefixFingerprint || profile.prefixFingerprint || '',
    prefixTokens: contextBudget?.prefixTokens || tokens?.prefixTokens || profile.prefixTokens || 0,
    prefixBytes: contextBudget?.prefixBytes || tokens?.prefixBytes || profile.prefixBytes || 0,
    cacheStabilityWarnings:
      tokens?.cacheStabilityWarnings || contextBudget?.cacheStabilityWarnings || profile.cacheStabilityWarnings || [],
    cacheStabilityReasons:
      tokens?.cacheStabilityReasons || contextBudget?.cacheStabilityReasons || profile.cacheStabilityReasons || [],
    cacheStabilityDetails:
      tokens?.cacheStabilityDetails || contextBudget?.cacheStabilityDetails || profile.cacheStabilityDetails || {},
    cacheHit: usage.cacheHit,
    cacheMiss: usage.cacheMiss,
    cacheHitRate: usage.cacheHitRate,
    estimatedCostUsd: usage.cost?.estimatedCostUsd || 0,
    estimatedSavingsUsd: usage.cost?.estimatedSavingsUsd || 0,
  };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

export function getConversationCacheProfile(conversation: Record<string, any>) {
  if (conversation?.cacheProfile && typeof conversation.cacheProfile === 'object') return conversation.cacheProfile;
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.cacheProfile && typeof message.cacheProfile === 'object') return message.cacheProfile;
    if (message?.tokens?.cacheProfile && typeof message.tokens.cacheProfile === 'object')
      return message.tokens.cacheProfile;
  }
  return null;
}

export function formatCompactTokenCount(value: string | number) {
  const number = Number(value) || 0;
  if (number < 1000) return String(Math.round(number));
  if (number < 1000000) {
    const compact = number < 10000 ? (number / 1000).toFixed(1) : Math.round(number / 1000).toString();
    return `${compact.replace(/\.0$/, '')}k`;
  }
  return `${(number / 1000000).toFixed(1).replace(/\.0$/, '')}m`;
}

export function formatUsd(value: unknown) {
  return `$${Number(value || 0).toFixed(6)}`;
}

export function formatUsageSourceLabel(source: string) {
  if (source === 'provider') return '服务商真实 usage';
  if (source === 'mixed') return '真实和估算混合';
  return '本地估算';
}

export function normalizeCacheStabilityReasons(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

export function formatCacheStabilityReason(reason: string) {
  const labels: Record<string, string> = {
    model_changed: '模型切换',
    system_prompt_changed: '系统提示词变化',
    tool_schema_changed: '工具 schema 变化',
    workspace_or_mcp_changed: '工作区/MCP 变化',
    prefix_fingerprint_changed: 'prefix 指纹变化',
  };
  return labels[reason] || reason;
}

export function formatCacheStabilityDetails(details: Record<string, any>) {
  if (!details || typeof details !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(details)) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const previous = String(record.previous || '').slice(0, 24);
    const current = String(record.current || '').slice(0, 24);
    if (previous || current) parts.push(`${key}: ${previous || '-'} -> ${current || '-'}`);
  }
  return parts.join('；');
}

// ─── DOM Helpers (for renderConversationUsageTelemetryPanel) ─────────────────

export function createUsageMetric(label: string, value: unknown) {
  const item = document.createElement('div');
  item.className = 'usage-panel-metric';
  const name = document.createElement('span');
  name.className = 'usage-panel-metric-label';
  name.textContent = label;
  const number = document.createElement('strong');
  number.className = 'usage-panel-metric-value';
  number.textContent = String(value ?? 0);
  item.append(name, number);
  return item;
}

export function createUsageSectionTitle(text: string) {
  const title = document.createElement('div');
  title.className = 'usage-panel-section-title';
  title.textContent = text;
  return title;
}

export function createUsageRow(label: string, value: unknown) {
  const row = document.createElement('div');
  row.className = 'usage-panel-row';
  const name = document.createElement('span');
  name.className = 'usage-panel-row-label';
  name.textContent = label;
  const content = document.createElement('code');
  content.className = 'usage-panel-row-value';
  content.textContent = String(value ?? '');
  row.append(name, content);
  return row;
}

// ─── Cost Explanation ────────────────────────────────────────────────────────

/**
 * Generate a human-readable explanation of why a round was expensive or cheap.
 * Helps users understand cost drivers and optimize their usage.
 */
export function explainRoundCost(conversation: Record<string, any>): string[] {
  const usage = getConversationUsageSummary(conversation);
  if (!usage || usage.total <= 0) return ['暂无 Token 使用数据。'];

  const explanations: string[] = [];

  // Cache efficiency
  if (usage.cacheHit > 0 || usage.cacheMiss > 0) {
    const hitRate = usage.cacheHitRate;
    if (hitRate > 0.8) {
      explanations.push('🟢 缓存命中率高（>80%），前缀稳定，成本较低。');
    } else if (hitRate > 0.5) {
      explanations.push('🟡 缓存命中率中等（50-80%），部分上下文发生变化导致缓存失效。');
    } else {
      explanations.push('🔴 缓存命中率低（<50%），大量上下文变化导致缓存失效，成本较高。');
    }
  }

  // Token volume
  if (usage.total > 100000) {
    explanations.push('🔴 本轮 Token 用量超过 100K，可能包含大量工具输出或长上下文。');
  } else if (usage.total > 50000) {
    explanations.push('🟡 本轮 Token 用量较高（50K+），建议检查是否有不必要的工具调用。');
  }

  // Reasoning tokens
  if (usage.reasoning > 10000) {
    explanations.push('🟡 思考 Token 较多（10K+），可能因为复杂推理或多轮 Agent 规划。');
  }

  // Multiple rounds
  if ((usage.rounds || 0) > 3) {
    explanations.push('🟡 Agent 轮次较多（3+），每轮都会增加上下文长度和成本。');
  }

  // Cost savings
  if (Number(usage.cost?.estimatedSavingsUsd || 0) > 0.001) {
    explanations.push(`🟢 缓存节省约 ${formatUsd(usage.cost.estimatedSavingsUsd)}，前缀复用有效。`);
  }

  if (explanations.length === 0) {
    explanations.push('本轮 Token 使用正常，无异常成本驱动因素。');
  }

  return explanations;
}
