/**
 * Tool Card — Product-oriented tool call visualization
 *
 * Default view shows: purpose, scope, risk, result summary, next action.
 * Advanced details (collapsed): raw JSON, tokens, duration, trace id,
 * full input, full output.
 */

import { escapeHtml, truncate } from './shared-utils.js';
import {
  RISK_LEVELS,
  getToolRiskLevel,
  getToolIcon,
  getToolPurpose,
  getToolScope,
  getToolRiskReason,
  getToolProductRiskLevel,
  hasToolProductMetadata,
} from './tool-registry.js';
import type { RiskLevel } from './tool-registry.js';
import {
  summarizeProjectMap,
  summarizeGitDiff,
  summarizeGitStatus,
  summarizeGitLog,
  summarizeReadManyFiles,
} from './tool-runs.js';

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

function inferProductRiskLevel(toolName: string): {
  level: 'low' | 'medium' | 'high';
  label: string;
  color: string;
  bg: string;
  border: string;
} {
  return getToolProductRiskLevel(toolName);
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

function inferScope(tool: Record<string, unknown>): string {
  const name = String(tool.name || '');
  const args = (tool.args || {}) as Record<string, unknown>;

  if (name === 'read_file' || name === 'read_symbol') {
    const path = String(args.path || args.file || args.symbol || '');
    return path ? `1 个文件` : '单个文件';
  }
  if (name === 'read_many_files') {
    const paths = Array.isArray(args.paths) ? args.paths : [];
    return `${paths.length} 个文件`;
  }
  if (name === 'project_map' || name === 'index_workspace' || name === 'search_workspace') {
    return '整个项目';
  }
  if (name === 'list_files') {
    const path = String(args.path || '.');
    return `目录 ${path}`;
  }
  if (name === 'git_status' || name === 'git_diff' || name === 'git_log') {
    return '当前仓库';
  }
  if (name === 'run_code') {
    return '隔离环境';
  }
  if (name === 'web_search') {
    return '互联网';
  }
  return getToolScope(name);
}

function inferResultSummary(tool: Record<string, unknown>): string {
  const name = String(tool.name || '');
  const output = String(tool.output || '');
  const ok = tool.ok === true;

  if (!ok && tool.status === 'denied') return '用户已拒绝执行此工具';
  if (!ok) return tool.parseError ? `解析失败：${truncate(tool.parseError, 80)}` : '执行失败或未完成';
  if (!output) return '执行成功，无输出内容';

  if (name === 'project_map') {
    const s = summarizeProjectMap(output);
    const parts: string[] = [];
    if (s.fileCount) parts.push(`${s.fileCount} 个文件`);
    if (s.dirCount) parts.push(`${s.dirCount} 个目录`);
    if (s.entryFiles.length) parts.push(`入口：${s.entryFiles.slice(0, 3).join(', ')}`);
    return parts.length ? parts.join(' · ') : '项目结构已生成';
  }

  if (name === 'git_diff') {
    const s = summarizeGitDiff(output);
    const parts: string[] = [];
    if (s.changedFiles) parts.push(`${s.changedFiles} 个文件变更`);
    if (s.insertions) parts.push(`+${s.insertions} 行`);
    if (s.deletions) parts.push(`-${s.deletions} 行`);
    if (s.riskyFiles.length) parts.push(`⚠️ 风险文件：${s.riskyFiles[0]}`);
    return parts.length ? parts.join(' · ') : '无未提交的变更';
  }

  if (name === 'git_status') {
    const s = summarizeGitStatus(output);
    const parts: string[] = [];
    parts.push(`分支：${s.branch}`);
    if (s.staged) parts.push(`${s.staged} 个暂存`);
    if (s.unstaged) parts.push(`${s.unstaged} 个未暂存`);
    if (s.untracked) parts.push(`${s.untracked} 个未跟踪`);
    return parts.join(' · ') || '工作区干净';
  }

  if (name === 'git_log') {
    const s = summarizeGitLog(output, Number((tool.args as any)?.count) || 10);
    const parts: string[] = [];
    if (s.commitCount) parts.push(`${s.commitCount} 条提交`);
    if (s.latestMessage) parts.push(`最新：${truncate(s.latestMessage, 40)}`);
    if (s.authors.length) parts.push(`作者：${s.authors.slice(0, 2).join(', ')}`);
    return parts.join(' · ') || '提交历史已获取';
  }

  if (name === 'read_many_files') {
    const s = summarizeReadManyFiles(tool);
    const parts: string[] = [];
    if (s.totalFiles) parts.push(`${s.successfulFiles}/${s.totalFiles} 个文件成功读取`);
    if (s.failedFiles) parts.push(`${s.failedFiles} 个失败`);
    if (s.hitSummaries.length) parts.push(`命中：${truncate(s.hitSummaries[0], 30)}`);
    return parts.join(' · ') || '批量读取完成';
  }

  if (name === 'web_search') {
    const sources = (tool.sources as any[]) || [];
    return sources.length ? `找到 ${sources.length} 个来源` : '搜索完成';
  }

  if (name === 'run_code') {
    const exitMatch = output.match(/退出码[：:]\s*(\d+)/);
    const exitCode = exitMatch ? exitMatch[1] : null;
    if (exitCode === '0' || exitCode === null) return '代码运行成功';
    return `运行结束（退出码 ${exitCode}）`;
  }

  if (name === 'search_workspace') {
    const query = String((tool.args as any)?.query || '');
    return query ? `检索「${truncate(query, 40)}」完成` : '工作区检索完成';
  }

  if (name === 'read_file') {
    const path = String((tool.args as any)?.path || (tool.args as any)?.file || '');
    const size = output.length;
    return path ? `已读取 ${path.split(/[/\\]/).pop() || path}（${size} 字符）` : '文件读取完成';
  }

  return truncate(output, 100);
}

function inferNextAction(tool: Record<string, unknown>): string {
  const name = String(tool.name || '');
  const nextAction = String(tool.nextAction || '');
  if (nextAction) return nextAction;

  if (name === 'project_map') return '可基于项目结构进行代码分析或重构';
  if (name === 'git_diff') return '可审查变更、提交代码或回滚修改';
  if (name === 'git_status') return '可选择提交暂存文件或清理未跟踪文件';
  if (name === 'git_log') return '可查看特定提交的详细变更';
  if (name === 'read_many_files') return '可基于读取内容进行分析或修改';
  if (name === 'read_file') return '可编辑文件或基于内容继续分析';
  if (name === 'search_workspace') return '可打开匹配文件查看详细内容';
  if (name === 'web_search') return '可深入查看来源网页获取更多信息';
  if (name === 'run_code') return '可根据运行结果调试或优化代码';
  return '可继续追问或执行后续操作';
}

function formatCompactionSummary(tool: Record<string, unknown>): string {
  if (!tool.contextCompacted) return '';
  const raw = Number(tool.rawOutputTokens || 0);
  const context = Number(tool.contextOutputTokens || 0);
  const ratio = Number(tool.contextCompactionRatio || 0);
  const percent = ratio > 0 ? `${Math.round(ratio * 100)}%` : raw > 0 ? `${Math.round((context / raw) * 100)}%` : '';
  const reason = String(tool.contextCompactionReason || '').replace(/^tool_type:/, '');
  return [percent ? `保留 ${percent}` : '', reason ? `原因 ${reason}` : ''].filter(Boolean).join(' · ');
}

export function renderToolCard(
  tool: Record<string, unknown>,
  options: { showRaw?: boolean; onToggleRaw?: (expanded: boolean) => void } = {}
): HTMLElement {
  const { showRaw = false, onToggleRaw } = options;
  const approval = inferApprovalStatus(tool);
  const duration = formatDuration((tool.durationMs as number) || 0);
  const isRepair = tool.isRepair || tool.repaired;
  const toolName = String(tool.name || 'unknown');
  const hasMetadata = hasToolProductMetadata(toolName);

  // Prefer product-oriented risk level (low/medium/high) when metadata exists
  const productRisk = inferProductRiskLevel(toolName);
  const legacyRisk = inferRiskLevel(toolName);
  const risk = hasMetadata ? { ...productRisk, icon: legacyRisk.icon } : { ...legacyRisk, level: 'unknown' as const };

  const purpose = hasMetadata ? getToolPurpose(toolName) : `执行 ${toolName}`;
  const scope = hasMetadata ? getToolScope(toolName) : inferScope(tool);
  const riskReason = hasMetadata ? getToolRiskReason(toolName) : `基于工具名称推断的风险等级：${legacyRisk.label}`;
  const resultSummary = inferResultSummary(tool);
  const nextAction = inferNextAction(tool);
  const traceId = String(tool.id || '');
  const tokens = tool.tokens != null ? String(tool.tokens) : '';
  const rawOutputTokens = tool.rawOutputTokens != null ? String(tool.rawOutputTokens) : '';
  const contextOutputTokens = tool.contextOutputTokens != null ? String(tool.contextOutputTokens) : '';
  const compactionSummary = formatCompactionSummary(tool);

  const card = document.createElement('div');
  card.className = 'tool-card';
  if (isRepair) card.classList.add('tool-card--repair');

  // ─── Header ───────────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'tool-card-header';

  const riskBadgeClass = hasMetadata
    ? `tool-card-risk tool-card-risk--${(risk as any).level || 'unknown'}`
    : 'tool-card-risk';
  const riskBadgeStyle = hasMetadata
    ? `color:${productRisk.color};background:${productRisk.bg};border-color:${productRisk.border}`
    : `color:${legacyRisk.color}`;

  header.innerHTML = ` /* safeSetHTML-exempt: static template */
    <span class="tool-card-icon">${getToolIcon(toolName)}</span>
    <span class="tool-card-name">${escapeHtml(toolName)}</span>
    <span class="tool-card-status tool-card-status--${approval.id}" style="color:${approval.color}">${approval.icon} ${approval.label}</span>
    <span class="${riskBadgeClass}" style="${riskBadgeStyle}" title="风险等级: ${hasMetadata ? productRisk.label : legacyRisk.label}">${legacyRisk.icon} ${hasMetadata ? productRisk.label : legacyRisk.label}</span>
  `;

  // ─── Body (product-oriented) ──────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'tool-card-body';

  // Purpose row
  const purposeEl = document.createElement('div');
  purposeEl.className = 'tool-card-purpose';
  purposeEl.innerHTML = `<span class="tool-card-label">目的</span><span class="tool-card-value">${escapeHtml(purpose)}</span>`; /* safeSetHTML-exempt: static template */

  // Scope row
  const scopeEl = document.createElement('div');
  scopeEl.className = 'tool-card-scope';
  scopeEl.innerHTML = `<span class="tool-card-label">范围</span><span class="tool-card-value">${escapeHtml(scope)}</span>`; /* safeSetHTML-exempt: static template */

  // Risk row
  const riskEl = document.createElement('div');
  riskEl.className = 'tool-card-risk-row';
  const riskValueStyle = hasMetadata ? `color:${productRisk.color}` : `color:${legacyRisk.color}`;
  const riskLabel = hasMetadata ? productRisk.label : legacyRisk.label;
  riskEl.innerHTML = `<span class="tool-card-label">风险</span><span class="tool-card-value" style="${riskValueStyle}">${legacyRisk.icon} ${riskLabel} — ${escapeHtml(riskReason)}</span>`; /* safeSetHTML-exempt: static template */

  // Result summary row
  const resultEl = document.createElement('div');
  resultEl.className = 'tool-card-result';
  resultEl.innerHTML = `<span class="tool-card-label">结果</span><span class="tool-card-value">${escapeHtml(resultSummary)}</span>`; /* safeSetHTML-exempt: static template */

  // Next action row
  const nextEl = document.createElement('div');
  nextEl.className = 'tool-card-next';
  nextEl.innerHTML = `<span class="tool-card-label">下一步</span><span class="tool-card-value">${escapeHtml(nextAction)}</span>`; /* safeSetHTML-exempt: static template */

  body.append(purposeEl, scopeEl, riskEl, resultEl, nextEl);

  // ─── Meta strip (legacy, kept for tests) ──────────────────────────────────
  const meta = document.createElement('div');
  meta.className = 'tool-card-meta';
  const metaItems: string[] = [];
  const job = (tool.job || {}) as Record<string, unknown>;
  if (duration) metaItems.push(`⏱ ${duration}`);
  if (job.id) metaItems.push(`Job ${String(job.status || 'queued')}`);
  if (tokens) metaItems.push(`🔤 ${tokens} tokens`);
  if (rawOutputTokens) metaItems.push(`原始输出 ${rawOutputTokens} tokens`);
  if (contextOutputTokens) metaItems.push(`上下文 ${contextOutputTokens} tokens`);
  if (compactionSummary) metaItems.push(`压缩 ${compactionSummary}`);
  if (tool.inContext === false) metaItems.push('⛔ 未进入上下文');
  if (isRepair) metaItems.push('🔧 修复生成');
  if ((tool.evidenceIds as any[])?.length) metaItems.push(`📎 ${(tool.evidenceIds as any[]).length} 证据`);
  meta.textContent = metaItems.join('  ·  ');

  // ─── Actions ──────────────────────────────────────────────────────────────
  const actions = document.createElement('div');
  actions.className = 'tool-card-actions';

  // Copy result
  if (tool.output) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'tool-card-action-btn';
    copyBtn.textContent = '📋 复制结果';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(String(tool.output || ''));
    });
    actions.appendChild(copyBtn);
  }

  // View evidence
  if ((tool.evidenceIds as any[])?.length || tool.sources) {
    const evidenceBtn = document.createElement('button');
    evidenceBtn.type = 'button';
    evidenceBtn.className = 'tool-card-action-btn';
    evidenceBtn.textContent = '📎 查看证据';
    evidenceBtn.addEventListener('click', () => {
      const event = new CustomEvent('deepchat:view-tool-evidence', {
        detail: { toolName: tool.name, toolId: tool.id, sources: tool.sources },
        bubbles: true,
      });
      card.dispatchEvent(event);
    });
    actions.appendChild(evidenceBtn);
  }

  // Ask follow-up
  const askBtn = document.createElement('button');
  askBtn.type = 'button';
  askBtn.className = 'tool-card-action-btn';
  askBtn.textContent = '💬 继续追问';
  askBtn.addEventListener('click', () => {
    const event = new CustomEvent('deepchat:ask-tool-followup', {
      detail: { toolName: tool.name, args: tool.args, output: tool.output },
      bubbles: true,
    });
    card.dispatchEvent(event);
  });
  actions.appendChild(askBtn);

  // ─── Toggle ───────────────────────────────────────────────────────────────
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'tool-card-toggle';
  toggleBtn.textContent = showRaw || tool.expanded ? '🔽 收起高级详情' : '▶️ 展开高级详情';

  // ─── Advanced Details (collapsible) ───────────────────────────────────────
  const details = document.createElement('div');
  details.className = 'tool-card-details';
  const isExpert = document.documentElement.classList.contains('expert-mode');
  if (showRaw || tool.expanded || isExpert) details.classList.add('is-expanded');

  // Trace info
  if (traceId) {
    const traceEl = document.createElement('div');
    traceEl.className = 'tool-card-section';
    traceEl.innerHTML = `<strong>Trace ID</strong>`; /* safeSetHTML-exempt: static template */
    const tracePre = document.createElement('pre');
    tracePre.className = 'tool-card-raw';
    tracePre.textContent = traceId;
    traceEl.appendChild(tracePre);
    details.appendChild(traceEl);
  }

  // Token & timing
  const perfEl = document.createElement('div');
  perfEl.className = 'tool-card-section';
  const perfParts: string[] = [];
  if (duration) perfParts.push(`耗时：${duration}`);
  if (tokens) perfParts.push(`Tokens：${tokens}`);
  if (rawOutputTokens) perfParts.push(`原始输出 Tokens：${rawOutputTokens}`);
  if (contextOutputTokens) perfParts.push(`上下文 Tokens：${contextOutputTokens}`);
  if (tool.contextCompacted) {
    perfParts.push('上下文压缩：已压缩');
    if (tool.contextCompactionRatio !== undefined)
      perfParts.push(`压缩比例：${Math.round(Number(tool.contextCompactionRatio || 0) * 100)}%`);
    if (tool.contextCompactionReason) perfParts.push(`压缩原因：${String(tool.contextCompactionReason)}`);
    if (tool.contextCompactionType) perfParts.push(`压缩类型：${String(tool.contextCompactionType)}`);
  }
  if (perfParts.length) {
    perfEl.innerHTML = `<strong>性能指标</strong>`; /* safeSetHTML-exempt: static template */
    const perfPre = document.createElement('pre');
    perfPre.className = 'tool-card-raw';
    perfPre.textContent = perfParts.join('\n');
    perfEl.appendChild(perfPre);
    details.appendChild(perfEl);
  }

  if (job.id) {
    const jobEl = document.createElement('div');
    jobEl.className = 'tool-card-section';
    jobEl.innerHTML = `<strong>Job 状态</strong>`; /* safeSetHTML-exempt: static template */
    const jobPre = document.createElement('pre');
    jobPre.className = 'tool-card-raw';
    jobPre.textContent = JSON.stringify(job, null, 2);
    jobEl.appendChild(jobPre);
    details.appendChild(jobEl);
  }

  // Full input
  const inputSection = document.createElement('div');
  inputSection.className = 'tool-card-section';
  inputSection.innerHTML = `<strong>完整输入参数</strong>`; /* safeSetHTML-exempt: static template */
  const inputPre = document.createElement('pre');
  inputPre.className = 'tool-card-raw';
  inputPre.textContent = JSON.stringify(tool.args || {}, null, 2);
  inputSection.appendChild(inputPre);
  details.appendChild(inputSection);

  // Full output
  const outputSection = document.createElement('div');
  outputSection.className = 'tool-card-section';
  outputSection.innerHTML = `<strong>完整输出结果</strong>`; /* safeSetHTML-exempt: static template */
  const outputPre = document.createElement('pre');
  outputPre.className = 'tool-card-raw';
  outputPre.textContent = tool.output != null ? String(tool.output) : '(无输出)';
  outputSection.appendChild(outputPre);
  details.appendChild(outputSection);

  toggleBtn.addEventListener('click', () => {
    details.classList.toggle('is-expanded');
    const expanded = details.classList.contains('is-expanded');
    toggleBtn.textContent = expanded ? '🔽 收起高级详情' : '▶️ 展开高级详情';
    if (onToggleRaw) onToggleRaw(expanded);
  });

  // Legacy approval badge (kept for tests)
  const approvalLegacy = document.createElement('span');
  approvalLegacy.className = 'tool-card-approval';
  approvalLegacy.style.color = approval.color;
  approvalLegacy.textContent = `${approval.icon} ${approval.label}`;
  approvalLegacy.style.display = 'none';

  card.append(header, body, meta, actions, toggleBtn, details, approvalLegacy);
  return card;
}

export function renderToolCardList(
  container: HTMLElement | null,
  toolCalls: Array<Record<string, unknown>> = [],
  options: { showRaw?: boolean; onToggleRaw?: (expanded: boolean) => void } = {}
): void {
  if (!container) return;
  container.textContent = '';
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
