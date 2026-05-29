/**
 * Tool Card — Unified tool call visualization
 */

import { escapeHtml, truncate } from './shared-utils.js';

export interface RiskLevel {
  id: string;
  label: string;
  color: string;
  icon: string;
}

export const RISK_LEVELS: Readonly<Record<string, RiskLevel>> = Object.freeze({
  read: { id: 'read', label: '读取', color: '#3b82f6', icon: '👁' },
  write: { id: 'write', label: '写入', color: '#f59e0b', icon: '✏' },
  execute: { id: 'execute', label: '执行', color: '#ef4444', icon: '⚡' },
  network: { id: 'network', label: '网络', color: '#8b5cf6', icon: '🌐' },
});

export interface ApprovalStatus {
  id: string;
  label: string;
  color: string;
  icon: string;
}

export const APPROVAL_STATUS: Readonly<Record<string, ApprovalStatus>> = Object.freeze({
  auto_approved: { id: 'auto_approved', label: '自动通过', color: '#10b981', icon: '✓' },
  pending: { id: 'pending', label: '待审批', color: '#f59e0b', icon: '⏳' },
  approved: { id: 'approved', label: '已批准', color: '#10b981', icon: '✓' },
  denied: { id: 'denied', label: '已拒绝', color: '#ef4444', icon: '✕' },
});

const TOOL_ICON_MAP: Record<string, string> = {
  read_file: '📄',
  search_workspace: '🔍',
  read_symbol: '🔣',
  web_search: '🌐',
  run_code: '⚡',
  write_file: '✏',
  edit_file: '✏',
  default: '🛠',
};

function getToolIcon(toolName: string): string {
  for (const key of Object.keys(TOOL_ICON_MAP)) {
    if (toolName?.includes(key)) return TOOL_ICON_MAP[key];
  }
  return TOOL_ICON_MAP.default;
}

function inferRiskLevel(toolName: string, args: Record<string, unknown> = {}): RiskLevel {
  const name = String(toolName || '').toLowerCase();
  if (name.includes('run_code') || name.includes('execute') || name.includes('shell')) return RISK_LEVELS.execute;
  if (name.includes('web_search') || name.includes('fetch') || name.includes('http')) return RISK_LEVELS.network;
  if (name.includes('write') || name.includes('edit') || name.includes('create') || name.includes('delete'))
    return RISK_LEVELS.write;
  return RISK_LEVELS.read;
}

function inferApprovalStatus(tool: Record<string, unknown>): ApprovalStatus {
  if (tool.autoApproved) return APPROVAL_STATUS.auto_approved;
  if (tool.approved === true) return APPROVAL_STATUS.approved;
  if (tool.approved === false) return APPROVAL_STATUS.denied;
  if (tool.status === 'pending') return APPROVAL_STATUS.pending;
  return APPROVAL_STATUS.auto_approved;
}

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderToolCard(
  tool: Record<string, unknown>,
  options: { showRaw?: boolean; onToggleRaw?: (expanded: boolean) => void } = {}
): HTMLElement {
  const { showRaw = false, onToggleRaw } = options;
  const risk = inferRiskLevel(String(tool.name || ''), tool.args as Record<string, unknown>);
  const approval = inferApprovalStatus(tool);
  const duration = formatDuration((tool.durationMs as number) || 0);
  const isRepair = tool.isRepair || tool.repaired;

  const card = document.createElement('div');
  card.className = 'tool-card';
  if (isRepair) card.classList.add('tool-card--repair');

  const header = document.createElement('div');
  header.className = 'tool-card-header';
  header.innerHTML = `
    <span class="tool-card-icon">${getToolIcon(String(tool.name || ''))}</span>
    <span class="tool-card-name">${escapeHtml(tool.name || 'unknown')}</span>
    <span class="tool-card-risk" style="color:${risk.color}" title="风险等级: ${risk.label}">${risk.icon} ${risk.label}</span>
    <span class="tool-card-approval" style="color:${approval.color}">${approval.icon} ${approval.label}</span>
  `;

  // Purpose / summary line
  const purpose = document.createElement('div');
  purpose.className = 'tool-card-purpose';
  purpose.textContent = String(tool.purpose || tool.inputSummary || truncate(JSON.stringify(tool.args || {}), 120));

  // Meta strip
  const meta = document.createElement('div');
  meta.className = 'tool-card-meta';
  const metaItems: string[] = [];
  if (duration) metaItems.push(`⏱ ${duration}`);
  if (tool.tokens != null) metaItems.push(`🔤 ${tool.tokens} tokens`);
  if (tool.inContext === false) metaItems.push('⛔ 未进入上下文');
  if (isRepair) metaItems.push('🔧 修复生成');
  if ((tool.evidenceIds as any[])?.length) metaItems.push(`📎 ${(tool.evidenceIds as any[]).length} 证据`);
  meta.textContent = metaItems.join('  ·  ');

  // Collapsible raw JSON sections
  const details = document.createElement('div');
  details.className = 'tool-card-details';
  if (showRaw || tool.expanded) details.classList.add('is-expanded');

  const inputSection = document.createElement('div');
  inputSection.className = 'tool-card-section';
  inputSection.innerHTML = `<strong>输入参数</strong>`;
  const inputPre = document.createElement('pre');
  inputPre.className = 'tool-card-raw';
  inputPre.textContent = JSON.stringify(tool.args || {}, null, 2);
  inputSection.appendChild(inputPre);

  const outputSection = document.createElement('div');
  outputSection.className = 'tool-card-section';
  outputSection.innerHTML = `<strong>输出结果</strong>`;
  const outputPre = document.createElement('pre');
  outputPre.className = 'tool-card-raw';
  outputPre.textContent = tool.output != null ? String(tool.output) : '(无输出)';
  outputSection.appendChild(outputPre);

  details.append(inputSection, outputSection);

  // Toggle button
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'tool-card-toggle';
  toggleBtn.textContent = showRaw || tool.expanded ? '收起详情' : '展开详情';
  toggleBtn.addEventListener('click', () => {
    details.classList.toggle('is-expanded');
    const expanded = details.classList.contains('is-expanded');
    toggleBtn.textContent = expanded ? '收起详情' : '展开详情';
    if (onToggleRaw) onToggleRaw(expanded);
  });

  card.append(header, purpose, meta, toggleBtn, details);
  return card;
}

export function renderToolCardList(
  container: HTMLElement | null,
  toolCalls: Array<Record<string, unknown>> = [],
  options: { showRaw?: boolean; onToggleRaw?: (expanded: boolean) => void } = {}
): void {
  if (!container) return;
  container.innerHTML = '';
  if (!toolCalls || toolCalls.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const tool of toolCalls) {
    container.appendChild(renderToolCard(tool, options));
  }
}

export function renderToolCallsUnified(
  container: HTMLElement | null,
  toolCalls: Array<Record<string, unknown>> = [],
  options: { showRaw?: boolean; onToggleRaw?: (expanded: boolean) => void } = {}
): void {
  renderToolCardList(container, toolCalls, options);
}
