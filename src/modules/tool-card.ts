/**
 * Tool Card — Unified tool call visualization
 */

import { escapeHtml, truncate } from './shared-utils.js';

import { RISK_LEVELS, getToolRiskLevel, getToolIcon } from './tool-registry.js';
import type { RiskLevel } from './tool-registry.js';

export { RISK_LEVELS };

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

function inferRiskLevel(toolName: string): RiskLevel {
  return getToolRiskLevel(toolName);
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
  const risk = inferRiskLevel(String(tool.name || ''));
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

  // Action buttons for product-oriented interactions
  const actions = document.createElement('div');
  actions.className = 'tool-card-actions';

  if (tool.name === 'read_file' || tool.name === 'read_many_files') {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'tool-card-action-btn';
    copyBtn.textContent = '复制结果';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(String(tool.output || ''));
    });
    actions.appendChild(copyBtn);
  }

  if (tool.name === 'run_code') {
    const viewCodeBtn = document.createElement('button');
    viewCodeBtn.type = 'button';
    viewCodeBtn.className = 'tool-card-action-btn';
    viewCodeBtn.textContent = '查看代码';
    viewCodeBtn.addEventListener('click', () => {
      details.classList.add('is-expanded');
      toggleBtn.textContent = '收起详情';
    });
    actions.appendChild(viewCodeBtn);
  }

  if (tool.output) {
    const explainBtn = document.createElement('button');
    explainBtn.type = 'button';
    explainBtn.className = 'tool-card-action-btn';
    explainBtn.textContent = '让 AI 解释';
    explainBtn.addEventListener('click', () => {
      const event = new CustomEvent('deepchat:explain-tool-output', {
        detail: { toolName: tool.name, output: tool.output },
        bubbles: true,
      });
      card.dispatchEvent(event);
    });
    actions.appendChild(explainBtn);
  }

  card.append(header, purpose, meta, actions, toggleBtn, details);
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
