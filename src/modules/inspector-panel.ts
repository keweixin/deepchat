/**
 * Right Inspector Panel — Context-aware side panel (3-column layout foundation)
 *
 * Content adapts based on selected message:
 * - Normal response: citations, tokens, model, cache hit
 * - Tool calls: params, output, duration, risk
 * - Agent run: Theatre + Trace Timeline
 * - Artifact: preview + export
 *
 * Integrates with:
 * - agent-trace-inspector.js (Trace view)
 * - agent-theatre.js (Theatre view)
 * - provider-registry.js (Model info)
 * - tool-card.js (Tool cards)
 * - artifacts.js (Artifact extraction)
 */

import {
  extractArtifacts,
  createSandboxedHtmlDocument,
  buildArtifactDownloadName,
  getArtifactTypeLabel,
} from './artifacts.js';
import type { Artifact } from './artifacts.js';
import { diffArtifactVersions } from './artifact-versions.js';
import { downloadZipArchive } from './zip-builder.js';
import { escapeHtml, formatBytes } from './shared-utils.js';
import { renderToolCardList } from './tool-card.js';
import { safeSetHTML, setTrustedTemplateHTML } from './renderer.js';
import { normalizeTokenUsage } from './token-budget.js';

let _panelEl: HTMLElement | null = null;
let _contentEl: HTMLElement | null = null;
let _toolbarEl: HTMLElement | null = null;
let _isOpen = false;
let _currentMode = 'empty'; // empty | overview | message | trace | raw | theatre | artifact
let _currentData: Record<string, any> = {};
let _overviewProvider: (() => Record<string, any> | null) | null = null;

/** Type icons (SVG paths) for each artifact type. */
const ARTIFACT_TYPE_ICONS = {
  'html-preview':
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  mermaid:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
  table:
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>',
  'json-data':
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M18 2v6h-6"/><path d="M3 13l7-7 4 4 7-7"/></svg>',
  'code-file':
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="12" y1="2" x2="12" y2="22"/></svg>',
};

/**
 * Initialize the panel DOM if not already present.
 * Re-queries if the cached element has been removed from the document.
 */
function _ensurePanel() {
  if (_panelEl && _panelEl.isConnected) return;
  _panelEl = document.getElementById('right-inspector-panel');
  _toolbarEl = null;
  if (!_panelEl) return;
  _contentEl = _panelEl.querySelector('.inspector-panel-content');
  // Bind close button once
  const closeBtn = _panelEl.querySelector('.inspector-panel-close');
  if (closeBtn && !(closeBtn as any).__inspectorCloseBound) {
    (closeBtn as any).__inspectorCloseBound = true;
    closeBtn.addEventListener('click', closeInspectorPanel);
  }
}

/**
 * Open the panel with specific content
 * @param {string} mode
 * @param {Object} data
 */
export function openInspectorPanel(mode: string, data: Record<string, any> = {}) {
  _ensurePanel();
  if (!_panelEl) return;
  const resolved = _resolveInspectorRequest(mode, data);
  _isOpen = true;
  _currentMode = resolved.mode;
  _currentData = resolved.data;
  _panelEl.classList.add('is-visible');
  _ensureToolbar();
  _updateToolbar();
  _renderContent(resolved.mode, resolved.data);
}

/**
 * Close the panel
 */
export function closeInspectorPanel() {
  _ensurePanel();
  if (!_panelEl) return;
  _isOpen = false;
  _panelEl.classList.remove('is-visible');
}

/**
 * Toggle the panel
 * @param {string} mode
 * @param {Object} data
 */
export function toggleInspectorPanel(mode: string, data: Record<string, any> = {}) {
  _ensurePanel();
  const resolved = _resolveInspectorRequest(mode, data);
  const isDomOpen = Boolean(_panelEl?.classList.contains('is-visible'));
  if (isDomOpen && _currentMode === resolved.mode) {
    closeInspectorPanel();
  } else {
    openInspectorPanel(resolved.mode, resolved.data);
  }
}

/**
 * Check if panel is open
 * @returns {boolean}
 */
export function isInspectorPanelOpen() {
  return _isOpen;
}

/**
 * Update panel content without changing open state
 * @param {string} mode
 * @param {Object} data
 */
export function updateInspectorPanel(mode: string, data: Record<string, any> = {}) {
  if (!_isOpen) return;
  const resolved = _resolveInspectorRequest(mode, data);
  _currentMode = resolved.mode;
  _currentData = resolved.data;
  _renderContent(resolved.mode, resolved.data);
}

export function setInspectorOverviewProvider(provider: (() => Record<string, any> | null) | null) {
  _overviewProvider = provider;
}

// ─── Content Renderers ──────────────────────────────────────────────────────

function _renderContent(mode: string, data: Record<string, any>) {
  if (!_contentEl) return;
  _contentEl.textContent = '';

  switch (mode) {
    case 'message':
      _renderMessageInfo(data);
      break;
    case 'trace':
      _renderTraceInfo(data);
      break;
    case 'raw':
      _renderRawInfo(data);
      break;
    case 'model':
      _renderModelInfo(data);
      break;
    case 'artifact':
      _renderArtifactInfo(data);
      break;
    case 'overview':
      _renderOverview(data);
      break;
    case 'empty':
    default:
      _renderEmpty();
      break;
  }
}

function _renderEmpty() {
  if (!_contentEl) return;
  _contentEl.innerHTML = /* safeSetHTML-exempt: static template */ `
    <div class="inspector-empty">
      <h3>Inspector 会在有内容时显示细节</h3>
      <p>发送消息后，点击回答下方的“详情”，或按 <kbd>Ctrl+Shift+I</kbd> 查看最近消息。</p>
      <div class="inspector-empty-grid" aria-label="Inspector 可查看内容">
        <span><strong>消息</strong>模型、Token、缓存与来源</span>
        <span><strong>Trace</strong>Agent 阶段、工具调用与失败原因</span>
        <span><strong>Artifact</strong>代码块、图表和可下载文件</span>
      </div>
    </div>
  `;
}

function _createEmptyStateItem(label: string, description: string) {
  const item = document.createElement('span');
  const title = document.createElement('strong');
  title.textContent = label;
  item.append(title, document.createTextNode(description));
  return item;
}

function _resolveInspectorRequest(mode: string, data: Record<string, any>) {
  if (mode !== 'empty') return { mode, data };
  const overview = _overviewProvider?.();
  if (overview) return { mode: 'overview', data: overview };
  return { mode, data };
}

function _createMetaItem(label: string, value: unknown, title = '') {
  const item = document.createElement('div');
  item.className = 'inspector-meta-item';
  const labelEl = document.createElement('span');
  labelEl.className = 'inspector-meta-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'inspector-meta-value';
  valueEl.textContent = String(value ?? '');
  if (title) valueEl.title = title;
  item.append(labelEl, valueEl);
  return item;
}

function _createOverviewAction(label: string, enabled: boolean, onClick: () => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'inspector-overview-action';
  button.textContent = label;
  button.disabled = !enabled;
  if (enabled) button.addEventListener('click', onClick);
  return button;
}

function _dispatchInspectorOpen(mode: string, msgIndex: unknown) {
  document.dispatchEvent(new CustomEvent('deepchat:open-inspector', { detail: { mode, msgIndex } }));
}

function _renderOverview(data: Record<string, any>) {
  if (!_contentEl) return;
  if (!data?.conversationTitle && !data?.messageCount) return _renderEmpty();

  const fragment = document.createDocumentFragment();
  const summary = document.createElement('div');
  summary.className = 'inspector-section inspector-overview';

  const messageCount = Number(data.messageCount || 0);
  const title = document.createElement('h3');
  title.textContent = messageCount > 0 ? '当前会话概览' : 'Inspector 会在有内容时显示细节';
  summary.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'inspector-meta-grid';
  grid.append(
    _createMetaItem('会话', data.conversationTitle || '新的对话'),
    _createMetaItem('消息', `${Number(data.messageCount || 0)} 条`),
    _createMetaItem('工具证据', data.latestToolRunCount ? `${data.latestToolRunCount} 个` : '暂无'),
    _createMetaItem('Artifact', data.latestArtifactCount ? `${data.latestArtifactCount} 个` : '暂无')
  );
  if (data.usageText) grid.appendChild(_createMetaItem('Token / Cache', data.usageText, data.usageTitle));
  summary.appendChild(grid);

  if (messageCount === 0) {
    const empty = document.createElement('div');
    empty.className = 'inspector-empty-grid';
    empty.append(
      _createEmptyStateItem('消息', '模型、Token、缓存与来源'),
      _createEmptyStateItem('Trace', 'Agent 阶段、工具调用与失败原因'),
      _createEmptyStateItem('Artifact', '代码块、图表和可下载文件')
    );
    summary.appendChild(empty);
  }

  const actions = document.createElement('div');
  actions.className = 'inspector-overview-actions';
  actions.append(
    _createOverviewAction('最近消息', data.latestMessageIndex !== undefined, () => {
      _dispatchInspectorOpen('message', data.latestMessageIndex);
    }),
    _createOverviewAction('Trace', data.latestTraceIndex !== undefined, () => {
      _dispatchInspectorOpen('trace', data.latestTraceIndex);
    }),
    _createOverviewAction('Artifact', data.latestArtifactIndex !== undefined, () => {
      document.dispatchEvent(
        new CustomEvent('deepchat:open-artifact-inspector', { detail: { msgIndex: data.latestArtifactIndex } })
      );
    })
  );
  summary.appendChild(actions);
  fragment.appendChild(summary);

  if (data.lastStage || data.latestStopReason) {
    const trace = document.createElement('div');
    trace.className = 'inspector-section';
    const h3 = document.createElement('h3');
    h3.textContent = '最近 Agent 状态';
    trace.appendChild(h3);
    trace.appendChild(_createMetaItem('阶段', data.lastStage || '无'));
    if (data.latestStopReason) trace.appendChild(_createMetaItem('停止原因', data.latestStopReason));
    fragment.appendChild(trace);
  }

  if (data.hint) {
    const hint = document.createElement('p');
    hint.className = 'inspector-overview-hint';
    hint.textContent = data.hint;
    fragment.appendChild(hint);
  }

  _contentEl.appendChild(fragment);
}

function _renderMessageInfo(data: Record<string, any>) {
  if (!_contentEl) return;
  const { msg, index } = data;
  if (!msg) return _renderEmpty();
  const tokenInfo = _formatTokenUsageForInspector(msg.tokens);

  const html = `
    <div class="inspector-section">
      <h3>消息 #${index + 1}</h3>
      <div class="inspector-meta-grid">
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">角色</span>
          <span class="inspector-meta-value">${msg.role === 'assistant' ? 'AI' : '用户'}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">时间</span>
          <span class="inspector-meta-value">${new Date(msg.timestamp).toLocaleString()}</span>
        </div>
        ${
          tokenInfo
            ? `
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">Token 用量</span>
          <span class="inspector-meta-value">${escapeHtml(tokenInfo.summary)}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">缓存</span>
          <span class="inspector-meta-value">${escapeHtml(tokenInfo.cache)}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">统计来源</span>
          <span class="inspector-meta-value">${escapeHtml(tokenInfo.source)}</span>
        </div>
        ${
          tokenInfo.cost
            ? `
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">预估费用</span>
          <span class="inspector-meta-value">${escapeHtml(tokenInfo.cost)}</span>
        </div>
        `
            : ''
        }
        `
            : ''
        }
        ${
          msg.model
            ? `
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">模型</span>
          <span class="inspector-meta-value">${msg.model}</span>
        </div>
        `
            : ''
        }
        ${
          msg.speed
            ? `
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">速度</span>
          <span class="inspector-meta-value">${msg.speed} tok/s</span>
        </div>
        `
            : ''
        }
      </div>
    </div>
    ${
      msg.memoryDiagnostics
        ? `
    <div class="inspector-section">
      <h3>记忆命中</h3>
      <div class="inspector-meta-grid">
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">选中</span>
          <span class="inspector-meta-value">${Number(msg.memoryDiagnostics.selectedCount || 0)}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">跳过</span>
          <span class="inspector-meta-value">${Number(msg.memoryDiagnostics.skippedCount || 0)}</span>
        </div>
      </div>
      <pre class="inspector-memory-diagnostics">${escapeHtml(
        (msg.memoryDiagnostics.reasons || [])
          .slice(0, 5)
          .map((item: any) => `${item.memoryId || 'memory'} · score ${item.score ?? 0} · ${item.reason || ''}`)
          .join('\n') || '暂无命中原因'
      )}</pre>
    </div>
    `
        : ''
    }
    ${
      msg.toolCalls?.length
        ? `
    <div class="inspector-section">
      <h3>工具调用 (${msg.toolCalls.length})</h3>
      <div class="inspector-evidence-summary"></div>
      <div class="inspector-tool-list"></div>
    </div>
    `
        : ''
    }
  `;
  safeSetHTML(_contentEl, html);

  const toolListEl = _contentEl.querySelector('.inspector-tool-list') as HTMLElement | null;
  const evidenceSummaryEl = _contentEl.querySelector('.inspector-evidence-summary') as HTMLElement | null;
  if (evidenceSummaryEl && Array.isArray(msg.toolCalls)) {
    evidenceSummaryEl.replaceChildren(_createTaskEvidenceSummary(msg.toolCalls));
  }
  if (toolListEl && Array.isArray(msg.toolCalls)) {
    renderToolCardList(toolListEl, msg.toolCalls, { showRaw: false, detailLevel: _getInspectorDetailLevel() });
  }
}

function _createTaskEvidenceSummary(toolCalls: Array<Record<string, any>> = []) {
  const summary = document.createElement('div');
  summary.className = 'inspector-task-evidence';

  const counts = _summarizeToolEvidence(toolCalls);
  const rows = [
    ['读取', counts.read ? `${counts.read} 个文件/上下文` : '暂无'],
    ['修改', counts.write ? `${counts.write} 个文件` : '暂无'],
    ['执行', counts.execute ? `${counts.execute} 次命令/代码` : '暂无'],
    ['失败', counts.failed ? `${counts.failed} 项` : '暂无'],
  ];

  for (const [label, value] of rows) {
    const item = document.createElement('span');
    item.className = 'inspector-task-evidence-item';
    item.append(_createInlineStrong(label), document.createTextNode(value));
    summary.appendChild(item);
  }

  if (counts.backups.length) {
    const backup = document.createElement('div');
    backup.className = 'inspector-task-evidence-note';
    backup.textContent = `备份：${counts.backups.slice(0, 2).join('；')}`;
    summary.appendChild(backup);
  }
  if (counts.nextAction) {
    const next = document.createElement('div');
    next.className = 'inspector-task-evidence-note';
    next.textContent = `下一步：${counts.nextAction}`;
    summary.appendChild(next);
  }
  return summary;
}

function _createInlineStrong(text: string) {
  const strong = document.createElement('strong');
  strong.textContent = `${text}：`;
  return strong;
}

function _summarizeToolEvidence(toolCalls: Array<Record<string, any>> = []) {
  const result = { read: 0, write: 0, execute: 0, failed: 0, backups: [] as string[], nextAction: '' };
  for (const tool of toolCalls) {
    const name = String(tool.name || '').toLowerCase();
    const ok = tool.ok !== false && tool.status !== 'failed' && tool.status !== 'denied';
    if (!ok) result.failed += 1;
    if (name.includes('read') || name === 'search_workspace' || name === 'web_search') result.read += 1;
    if (name === 'edit_file' || name === 'multi_edit') result.write += Number(tool.security?.editCount || 1);
    if (name === 'run_code' || name.includes('command')) result.execute += 1;
    if (tool.backupPath) result.backups.push(String(tool.backupPath));
    if (!result.nextAction && tool.nextAction) result.nextAction = String(tool.nextAction);
  }
  return result;
}

function _renderRawInfo(data: Record<string, any>) {
  if (!_contentEl) return;
  const { msg, index } = data;
  if (!msg) return _renderEmpty();

  const detailLevel = _getInspectorDetailLevel();
  if (detailLevel !== 'developer') {
    safeSetHTML(
      _contentEl,
      `
      <div class="inspector-section">
        <h3>原始数据</h3>
        <p class="inspector-overview-hint">原始参数、完整工具输出、cache profile 和 schema/hash 只在“开发者模式”显示，避免普通使用时被调试信息打断。</p>
      </div>
      `
    );
    return;
  }

  const raw = {
    messageIndex: Number(index ?? -1) + 1,
    role: msg.role,
    tokens: msg.tokens || null,
    cacheProfile: msg.cacheProfile || null,
    contextBudget: msg.contextBudget || null,
    agentStages: Array.isArray(msg.agentStages) ? msg.agentStages : [],
    toolCalls: Array.isArray(msg.toolCalls) ? msg.toolCalls : [],
    toolRuns: Array.isArray(msg.toolRuns) ? msg.toolRuns : [],
  };
  safeSetHTML(
    _contentEl,
    `
    <div class="inspector-section">
      <h3>原始数据</h3>
      <p class="inspector-overview-hint">用于排查工具参数、Provider usage、cache profile、trace 和 job 证据。普通模式不会显示这些内容。</p>
      <pre class="inspector-raw-data">${escapeHtml(JSON.stringify(raw, null, 2))}</pre>
    </div>
    `
  );
}

function _formatTokenUsageForInspector(tokens: unknown) {
  if (!tokens) return null;
  if (typeof tokens !== 'object') {
    const text = String(tokens || '').trim();
    return text ? { summary: text, cache: '未提供缓存命中数据', source: '旧格式记录', cost: '' } : null;
  }

  const usage = normalizeTokenUsage(tokens as Record<string, unknown>);
  const parts = [
    `输入 ${_formatCount(usage.input)}`,
    `输出 ${_formatCount(usage.output)}`,
    `总计 ${_formatCount(usage.total)}`,
  ];
  if (usage.reasoning > 0) parts.push(`思考 ${_formatCount(usage.reasoning)}`);

  const hasCacheTelemetry = _hasReliableCacheTelemetry(tokens as Record<string, any>);
  const cache = hasCacheTelemetry
    ? `命中 ${Math.round(usage.cacheHitRate * 100)}%（命中 ${_formatCount(usage.cacheHit)} / 未命中 ${_formatCount(usage.cacheMiss)}）`
    : '服务商未返回命中数据，本地不会把未知伪装成 0%';

  const cost = usage.cost
    ? `成本 ${_formatUsd(usage.cost.estimatedCostUsd)} · 缓存节省 ${_formatUsd(usage.cost.estimatedSavingsUsd)}`
    : '';

  return {
    summary: parts.join(' · '),
    cache,
    source: _formatUsageSourceForInspector(usage.source),
    cost,
  };
}

function _hasReliableCacheTelemetry(tokens: Record<string, any>) {
  if (!tokens || typeof tokens !== 'object') return false;
  if (tokens.hasCacheTelemetry === true) return true;
  if (tokens.hasCacheTelemetry === false) return false;
  if (
    tokens.prompt_cache_hit_tokens !== undefined ||
    tokens.prompt_cache_miss_tokens !== undefined ||
    tokens.prompt_tokens_details !== undefined ||
    tokens.cached_tokens !== undefined
  ) {
    return true;
  }
  const source = String(tokens.source || '');
  if (
    (source === 'provider' || source === 'mixed') &&
    (tokens.cacheHit !== undefined || tokens.cacheMiss !== undefined)
  ) {
    return true;
  }
  const profile = tokens.cacheProfile && typeof tokens.cacheProfile === 'object' ? tokens.cacheProfile : null;
  return Boolean((source === 'provider' || source === 'mixed') && profile && profile.hasCacheTelemetry === true);
}

function _formatUsageSourceForInspector(source: string) {
  if (source === 'provider') return 'Provider 实测';
  if (source === 'mixed') return 'Provider 实测 + 本地估算';
  return '本地估算';
}

function _formatCount(value: unknown) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.round(number).toLocaleString('en-US') : '0';
}

function _formatUsd(value: unknown) {
  const number = Number(value || 0);
  return `$${Number.isFinite(number) ? number.toFixed(6) : '0.000000'}`;
}

function _renderTraceInfo(data: Record<string, any>) {
  if (!_contentEl) return;
  const { recorder, msg } = data;
  if (!recorder && !msg) return _renderEmpty();

  const summary = recorder?.getRunSummary ? recorder.getRunSummary() : {};
  const stages = Array.isArray(msg?.agentStages) ? msg.agentStages : [];
  const toolCalls = recorder?.getAllToolCalls
    ? recorder.getAllToolCalls()
    : Array.isArray(msg?.toolCalls)
      ? msg.toolCalls
      : [];
  const lastStage = stages.length ? stages[stages.length - 1] : null;
  const lastFailure = [...toolCalls].reverse().find((tool: any) => tool?.status === 'failed' || tool?.ok === false);
  const html = `
    <div class="inspector-section">
      <h3>Trace 摘要</h3>
      <div class="inspector-meta-grid">
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">Run ID</span>
          <span class="inspector-meta-value" style="font-size:0.75rem;word-break:break-all">${summary.runId || recorder?.runId || msg?.agentRun?.id || '—'}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">状态</span>
          <span class="inspector-meta-value">${summary.status || 'running'}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">事件数</span>
          <span class="inspector-meta-value">${summary.eventCount || stages.length + toolCalls.length || 0}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">最近阶段</span>
          <span class="inspector-meta-value">${escapeHtml(_formatTraceStage(lastStage))}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">最近失败</span>
          <span class="inspector-meta-value">${escapeHtml(_formatTraceFailure(lastFailure))}</span>
        </div>
      </div>
    </div>
    ${
      stages.length
        ? `
    <div class="inspector-section">
      <h3>Agent 阶段</h3>
      <ol class="inspector-trace-list">
        ${stages
          .slice(-8)
          .map((stage: any) => `<li>${escapeHtml(_formatTraceStage(stage))}</li>`)
          .join('')}
      </ol>
    </div>
    `
        : ''
    }
    ${
      toolCalls.length
        ? `
    <div class="inspector-section">
      <h3>工具调用 (${toolCalls.length})</h3>
      <div class="inspector-trace-tools"></div>
    </div>
    `
        : ''
    }
  `;
  safeSetHTML(_contentEl, html);
  const toolsEl = _contentEl.querySelector('.inspector-trace-tools') as HTMLElement | null;
  if (toolsEl && toolCalls.length) renderToolCardList(toolsEl, toolCalls, { showRaw: false });
}

function _formatTraceStage(stage: any) {
  if (!stage) return '暂无';
  const name = String(stage.stage || stage.type || '阶段');
  const round = stage.round ? `第 ${stage.round} 轮` : '';
  const warning = stage.warning || stage.stopReason || stage.currentAction || '';
  return [name, round, warning].filter(Boolean).join(' · ');
}

function _formatTraceFailure(tool: any) {
  if (!tool) return '暂无';
  return String(tool.error || tool.outputSummary || tool.output || tool.name || tool.toolName || '工具失败').slice(
    0,
    160
  );
}

function _renderModelInfo(data: Record<string, any>) {
  if (!_contentEl) return;
  const { settings, matrix, badge } = data;
  if (!settings) return _renderEmpty();

  const safeMatrix = Array.isArray(matrix) ? matrix : [];
  const safeBadge = badge || String(settings.model || '未配置');

  const html = `
    <div class="inspector-section">
      <h3>模型信息</h3>
      <div class="inspector-model-badge">${safeBadge}</div>
      <div class="inspector-meta-grid">
        ${safeMatrix
          .map(
            (m) => `
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">${m.label}</span>
          <span class="inspector-meta-value ${m.ok ? 'is-ok' : 'is-warn'}">${m.value}</span>
        </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
  safeSetHTML(_contentEl, html);
}

// ─── Artifact Renderer ──────────────────────────────────────────────────────

function _renderArtifactInfo(data: Record<string, any>) {
  if (!_contentEl) return;
  const { msg, messages, index: msgIndex } = data;
  if (!msg?.content) return _renderEmpty();

  const artifacts = extractArtifacts(msg.content);
  // Stamp metadata onto artifacts
  for (const art of artifacts) {
    art.messageIndex = msgIndex;
    art.createdAt = msg.timestamp || Date.now();
  }

  if (artifacts.length === 0) {
    _contentEl.innerHTML = /* safeSetHTML-exempt: static template */ `
      <div class="inspector-empty">
        <p>此消息中未发现 artifact</p>
      </div>
    `;
    return;
  }

  // Collect version groups across all messages for diff view
  const versionGroups = _collectArtifactVersions(messages, msgIndex);

  let html = `
    <div class="inspector-section">
      <div class="inspector-artifact-toolbar">
        <h3>Artifacts (${artifacts.length})</h3>
        <div class="inspector-artifact-toolbar-actions">
          <button type="button" class="inspector-artifact-action" data-action="download-all" title="打包下载全部">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            下载全部
          </button>
        </div>
      </div>
      <div class="inspector-artifact-search">
        <input type="text" class="inspector-artifact-search-input" placeholder="搜索 artifact..." />
      </div>
  `;

  for (const [i, artifact] of artifacts.entries()) {
    const icon =
      ARTIFACT_TYPE_ICONS[artifact.type as keyof typeof ARTIFACT_TYPE_ICONS] || ARTIFACT_TYPE_ICONS['code-file'];
    const typeLabel = getArtifactTypeLabel(artifact.type);
    const metaParts = _buildArtifactMeta(artifact);
    const preview = _buildArtifactPreview(artifact);

    // Check if this artifact has versions in other messages
    const versionKey = _artifactVersionKey(artifact);
    const versions = versionGroups.get(versionKey) || [];
    const hasVersions = versions.length > 1;

    html += `
      <div class="inspector-artifact-card" data-artifact-index="${i}" data-artifact-search="${escapeHtml((artifact.title + ' ' + typeLabel + ' ' + (artifact.language || '')).toLowerCase())}">
        <div class="inspector-artifact-header">
          <span class="inspector-artifact-icon">${icon}</span>
          <span class="inspector-artifact-title">${escapeHtml(artifact.title || typeLabel)}</span>
          ${hasVersions ? `<span class="inspector-artifact-version-badge" title="存在 ${versions.length} 个版本">${versions.length} 版本</span>` : ''}
        </div>
        <div class="inspector-artifact-meta">${escapeHtml(metaParts.join(' · '))}</div>
        ${preview}
        <div class="inspector-artifact-actions">
          <button type="button" class="inspector-artifact-action" data-action="copy" data-artifact-idx="${i}" title="复制源码">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            复制
          </button>
          <button type="button" class="inspector-artifact-action" data-action="download" data-artifact-idx="${i}" title="下载文件">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            下载
          </button>
          ${
            hasVersions
              ? `
          <button type="button" class="inspector-artifact-action" data-action="diff" data-artifact-idx="${i}" data-version-key="${escapeHtml(versionKey)}" title="版本对比">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18"/><path d="M5 12h14"/><rect x="2" y="3" width="8" height="6" rx="1"/><rect x="14" y="15" width="8" height="6" rx="1"/></svg>
            对比
          </button>`
              : ''
          }
        </div>
      </div>
    `;
  }

  // Version diff container (hidden by default)
  html += '<div class="inspector-artifact-diff-container" hidden></div>';
  html += '</div>';
  // Use setTrustedTemplateHTML for artifact preview since it contains sandboxed iframe
  setTrustedTemplateHTML(_contentEl, html); /* safeSetHTML-exempt: artifact preview with sandboxed iframe */

  // Attach event listeners
  Array.from(_contentEl.querySelectorAll('.inspector-artifact-action')).forEach((btn) => {
    btn.addEventListener('click', (e: Event) => {
      const target = e.currentTarget as HTMLElement | null;
      if (!target) return;
      const action = target.dataset.action;
      const idx = Number(target.dataset.artifactIdx);
      const art = artifacts[idx];
      if (action === 'download-all') {
        _downloadAllArtifacts(artifacts);
        return;
      }
      if (!art) return;
      if (action === 'copy') {
        _copyArtifactSource(art);
      } else if (action === 'download') {
        _downloadArtifact(art, idx);
      } else if (action === 'diff') {
        const vkey = target.dataset.versionKey || '';
        _showVersionDiff(vkey, versionGroups, artifacts, idx);
      }
    });
  });

  // Search/filter handler
  const searchInput = _contentEl.querySelector('.inspector-artifact-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e: Event) => {
      const query = (e.target as HTMLInputElement | null)?.value.toLowerCase().trim() || '';
      if (!_contentEl) return;
      Array.from(_contentEl.querySelectorAll('.inspector-artifact-card')).forEach((card) => {
        const el = card as HTMLElement;
        const searchText = el.dataset.artifactSearch || '';
        el.style.display = !query || searchText.includes(query) ? '' : 'none';
      });
    });
  }
}

/**
 * Normalize an artifact title into a stable key for version grouping.
 * Strips trailing version numbers like " 2", " 3" etc.
 */
function _artifactVersionKey(artifact: Artifact) {
  return (artifact.title || '').replace(/\s+\d+$/, '').toLowerCase();
}

/**
 * Collect all artifact versions across messages, grouped by normalized title.
 */
function _collectArtifactVersions(messages: any[], _currentMsgIndex: number) {
  const groups = new Map();
  if (!Array.isArray(messages)) return groups;

  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m?.role !== 'assistant' || !m.content) continue;
    const arts = extractArtifacts(m.content);
    for (const art of arts) {
      const key = _artifactVersionKey(art);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        ...art,
        messageIndex: mi,
        createdAt: m.timestamp || Date.now(),
      });
    }
  }
  return groups;
}

/**
 * Show inline diff view comparing two artifact versions.
 */
function _showVersionDiff(
  versionKey: string,
  versionGroups: Map<string, any[]>,
  currentArtifacts: any[],
  currentIndex: number
) {
  if (!_contentEl) return;
  const container = _contentEl.querySelector('.inspector-artifact-diff-container') as HTMLElement | null;
  if (!container) return;

  const versions = versionGroups.get(versionKey) || [];
  if (versions.length < 2) return;

  // Build selector for two versions
  const buildOptions = (selectedIdx: number) =>
    versions
      .map(
        (v: Record<string, any>, i: number) =>
          `<option value="${i}" ${i === selectedIdx ? 'selected' : ''}>消息 #${(v.messageIndex ?? 0) + 1} — ${new Date(v.createdAt || Date.now()).toLocaleString()}</option>`
      )
      .join('');

  const diffHtml = `
    <div class="inspector-artifact-diff">
      <div class="inspector-artifact-diff-header">
        <h4>版本对比</h4>
        <button type="button" class="inspector-artifact-diff-close" title="关闭对比">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="inspector-artifact-diff-selectors">
        <label>旧版本: <select class="inspector-artifact-diff-select" data-side="old">${buildOptions(0)}</select></label>
        <label>新版本: <select class="inspector-artifact-diff-select" data-side="new">${buildOptions(versions.length - 1)}</select></label>
      </div>
      <div class="inspector-artifact-diff-stats"></div>
      <div class="inspector-artifact-diff-view"></div>
    </div>
  `;

  safeSetHTML(container, diffHtml);
  container.hidden = false;

  // Initial diff render
  _renderDiffContent(container, versions, 0, versions.length - 1);

  // Selector change handlers
  Array.from(container.querySelectorAll('.inspector-artifact-diff-select')).forEach((sel) => {
    sel.addEventListener('change', () => {
      const oldSelect = container.querySelector('[data-side="old"]') as HTMLSelectElement | null;
      const newSelect = container.querySelector('[data-side="new"]') as HTMLSelectElement | null;
      const oldIdx = Number(oldSelect?.value ?? 0);
      const newIdx = Number(newSelect?.value ?? 0);
      _renderDiffContent(container, versions, oldIdx, newIdx);
    });
  });

  // Close button
  const closeBtn = container.querySelector('.inspector-artifact-diff-close') as HTMLElement | null;
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      container.hidden = true;
      container.textContent = '';
    });
  }

  // Scroll into view (not available in all environments like jsdom)
  if (typeof container.scrollIntoView === 'function') {
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/**
 * Render diff lines into the diff view container.
 */
function _renderDiffContent(container: HTMLElement, versions: any[], oldIdx: number, newIdx: number) {
  const statsEl = container.querySelector('.inspector-artifact-diff-stats') as HTMLElement | null;
  const viewEl = container.querySelector('.inspector-artifact-diff-view') as HTMLElement | null;
  if (!statsEl || !viewEl) return;

  const oldVersion = versions[oldIdx];
  const newVersion = versions[newIdx];
  if (!oldVersion || !newVersion) return;

  const diff = diffArtifactVersions(oldVersion.source, newVersion.source);
  safeSetHTML(
    statsEl,
    `
    <span class="diff-stat-add">+${diff.added} 行</span>
    <span class="diff-stat-remove">-${diff.removed} 行</span>
    <span class="diff-stat-total">共 ${diff.newLineCount} 行</span>
  `
  );

  // Compute line-level diff
  const oldLines = String(oldVersion.source || '').split('\n');
  const newLines = String(newVersion.source || '').split('\n');
  const diffLines = _computeLineDiff(oldLines, newLines);

  let linesHtml = '';
  for (const line of diffLines) {
    const escapedContent = escapeHtml(line.text);
    if (line.type === 'add') {
      linesHtml += `<div class="diff-line diff-line-add"><span class="diff-line-sign">+</span>${escapedContent}</div>`;
    } else if (line.type === 'remove') {
      linesHtml += `<div class="diff-line diff-line-remove"><span class="diff-line-sign">-</span>${escapedContent}</div>`;
    } else {
      linesHtml += `<div class="diff-line diff-line-ctx"><span class="diff-line-sign"> </span>${escapedContent}</div>`;
    }
  }

  safeSetHTML(
    viewEl,
    `<pre class="diff-pre">${linesHtml || '<div class="diff-line diff-line-ctx">无差异</div>'}</pre>`
  );
}

/**
 * Simple LCS-based line diff algorithm.
 */
function _computeLineDiff(oldLines: string[], newLines: string[]) {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce diff
  const result = [];
  let i = m,
    j = n;
  const temp = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      temp.push({ type: 'ctx', text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      temp.push({ type: 'add', text: newLines[j - 1] });
      j--;
    } else {
      temp.push({ type: 'remove', text: oldLines[i - 1] });
      i--;
    }
  }
  temp.reverse();

  // Collapse long context sections (show max 3 context lines around changes)
  const MAX_CONTEXT = 3;
  let lastChangeIdx = -MAX_CONTEXT - 1;
  for (let k = 0; k < temp.length; k++) {
    if (temp[k].type !== 'ctx') {
      lastChangeIdx = k;
    }
    if (temp[k].type === 'ctx') {
      const distFromLastChange = k - lastChangeIdx;
      const distToNextChange = _distToNextChange(temp, k);
      if (distFromLastChange > MAX_CONTEXT && distToNextChange > MAX_CONTEXT) {
        continue; // skip far-away context lines
      }
    }
    result.push(temp[k]);
  }

  return result;
}

function _distToNextChange(lines: Array<{ type: string; text: string }>, fromIdx: number) {
  for (let k = fromIdx + 1; k < lines.length; k++) {
    if (lines[k].type !== 'ctx') return k - fromIdx;
  }
  return lines.length - fromIdx;
}

/**
 * Download all artifacts as a ZIP file.
 */
function _downloadAllArtifacts(artifacts: Artifact[]) {
  if (artifacts.length === 0) return;
  const files = artifacts.map((art: Artifact, i: number) => ({
    name: buildArtifactDownloadName(art, i),
    content: art.source,
  }));
  downloadZipArchive(files, `artifacts-${Date.now()}.zip`);
  _showInspectorToast(`已打包 ${artifacts.length} 个 artifact`);
}

/**
 * Build meta info line for an artifact card.
 * @param {import('./artifacts.js').Artifact} artifact
 * @returns {string[]}
 */
function _buildArtifactMeta(artifact: Artifact) {
  const parts = [getArtifactTypeLabel(artifact.type)];
  if (artifact.language) parts.push(artifact.language);
  if (artifact.format) parts.push(artifact.format.toUpperCase());
  if (artifact.size) parts.push(formatBytes(artifact.size));
  if (artifact.messageIndex != null) parts.push(`消息 #${artifact.messageIndex + 1}`);
  if (artifact.createdAt) parts.push(new Date(artifact.createdAt).toLocaleString());
  if (artifact.truncated) parts.push('已裁剪');
  return parts;
}

/**
 * Build a type-specific preview snippet for the inspector.
 * @param {import('./artifacts.js').Artifact} artifact
 * @returns {string}
 */
function _buildArtifactPreview(artifact: Artifact) {
  switch (artifact.type) {
    case 'html-preview':
      return _buildHtmlPreview(artifact);
    case 'mermaid':
      return _buildMermaidPreview(artifact);
    case 'json-data':
      return _buildJsonPreview(artifact);
    case 'table':
      return _buildTablePreview(artifact);
    case 'code-file':
    default:
      return _buildCodePreview(artifact);
  }
}

function _buildHtmlPreview(artifact: Artifact) {
  const srcdoc = createSandboxedHtmlDocument(artifact.source, { title: artifact.title });
  const safeSrcdoc = srcdoc.replace(/"/g, '&quot;');
  return `
    <div class="inspector-artifact-preview inspector-artifact-preview--html">
      <iframe
        class="inspector-artifact-iframe"
        sandbox=""
        referrerpolicy="no-referrer"
        srcdoc="${safeSrcdoc}"
        title="${escapeHtml(artifact.title || 'HTML 预览')}"></iframe>
    </div>
  `;
}

function _buildMermaidPreview(artifact: Artifact) {
  const lines = artifact.source.split('\n').slice(0, 12);
  const preview = lines.join('\n');
  const truncated = artifact.source.split('\n').length > 12;
  return `
    <div class="inspector-artifact-preview inspector-artifact-preview--mermaid">
      <pre class="inspector-artifact-code"><code>${escapeHtml(preview)}${truncated ? '\n…' : ''}</code></pre>
    </div>
  `;
}

function _buildJsonPreview(artifact: Artifact) {
  let display = artifact.source;
  if (artifact.parsed) {
    try {
      display = JSON.stringify(artifact.parsed, null, 2);
    } catch {
      // keep original
    }
  }
  const lines = display.split('\n').slice(0, 20);
  const truncated = display.split('\n').length > 20;
  return `
    <div class="inspector-artifact-preview inspector-artifact-preview--json">
      <pre class="inspector-artifact-code"><code>${escapeHtml(lines.join('\n'))}${truncated ? '\n…' : ''}</code></pre>
    </div>
  `;
}

function _buildTablePreview(artifact: Artifact) {
  const rows = parseTableRows(artifact.source, artifact.format || '');
  if (rows.length === 0) {
    return `
      <div class="inspector-artifact-preview inspector-artifact-preview--table">
        <pre class="inspector-artifact-code"><code>${escapeHtml(artifact.source.slice(0, 500))}</code></pre>
      </div>
    `;
  }

  const displayRows = rows.slice(0, 10);
  const hasMore = rows.length > 10;
  let tableHtml =
    '<div class="inspector-artifact-preview inspector-artifact-preview--table"><table class="inspector-artifact-table">';

  // Header row
  if (displayRows.length > 0) {
    tableHtml += '<thead><tr>';
    for (const cell of displayRows[0]) {
      tableHtml += `<th>${escapeHtml(cell)}</th>`;
    }
    tableHtml += '</tr></thead>';
  }

  // Body rows
  tableHtml += '<tbody>';
  for (let r = 1; r < displayRows.length; r++) {
    tableHtml += '<tr>';
    for (const cell of displayRows[r]) {
      tableHtml += `<td>${escapeHtml(cell)}</td>`;
    }
    tableHtml += '</tr>';
  }
  tableHtml += '</tbody></table>';
  if (hasMore) {
    tableHtml += `<div class="inspector-artifact-table-more">… 共 ${rows.length} 行</div>`;
  }
  tableHtml += '</div>';
  return tableHtml;
}

function _buildCodePreview(artifact: Artifact) {
  const lines = artifact.source.split('\n').slice(0, 30);
  const truncated = artifact.source.split('\n').length > 30;
  const langClass = artifact.language ? ` language-${escapeHtml(artifact.language)}` : '';
  return `
    <div class="inspector-artifact-preview inspector-artifact-preview--code">
      <pre class="inspector-artifact-code"><code class="${langClass}">${escapeHtml(lines.join('\n'))}${truncated ? '\n…' : ''}</code></pre>
    </div>
  `;
}

/**
 * Parse CSV/TSV/markdown table source into rows of cell strings.
 * @param {string} source
 * @param {string} [format]
 * @returns {string[][]}
 */
function parseTableRows(source: string, format: string) {
  const lines = String(source || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  if (format === 'markdown') {
    // Skip separator row (---|---)
    const dataLines = lines.filter((l: string) => !/^\|?\s*[-:]+[-|:\s]+\s*\|?\s*$/.test(l));
    return dataLines.map((line: string) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c: string) => c.trim())
    );
  }

  const sep = format === 'tsv' ? '\t' : ',';
  return lines.map((line: string) => line.split(sep).map((c: string) => c.trim()));
}

/**
 * Copy artifact source to clipboard.
 * @param {import('./artifacts.js').Artifact} artifact
 */
function _copyArtifactSource(artifact: Artifact) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(artifact.source).then(() => {
      _showInspectorToast('已复制到剪贴板');
    });
  }
}

/**
 * Download artifact as file.
 * @param {import('./artifacts.js').Artifact} artifact
 * @param {number} index
 */
function _downloadArtifact(artifact: Artifact, index: number) {
  let blob;
  switch (artifact.type) {
    case 'html-preview': {
      const html = createSandboxedHtmlDocument(artifact.source, { title: artifact.title });
      blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      break;
    }
    case 'json-data':
      blob = new Blob([artifact.source], { type: 'application/json;charset=utf-8' });
      break;
    default:
      blob = new Blob([artifact.source], { type: 'text/plain;charset=utf-8' });
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = buildArtifactDownloadName(artifact, index);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Show a brief toast message inside the inspector panel.
 * @param {string} message
 */
function _showInspectorToast(message: string) {
  if (!_contentEl) return;
  const toast = document.createElement('div');
  toast.className = 'inspector-toast';
  toast.textContent = message;
  _contentEl.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
}

// ─── Toolbar ────────────────────────────────────────────────────────────────

const TOOLBAR_MODES = [
  {
    mode: 'message',
    label: '概览',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  },
  {
    mode: 'trace',
    label: 'Trace',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  },
  {
    mode: 'raw',
    label: '原始数据',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="12" y1="2" x2="12" y2="22"/></svg>',
  },
  {
    mode: 'artifact',
    label: 'Artifact',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  },
];

function _getInspectorDetailLevel() {
  try {
    const raw = window.localStorage?.getItem('dc_interfaceDetailLevel') || 'normal';
    return raw === 'developer' || raw === 'advanced' || raw === 'normal' ? raw : 'normal';
  } catch {
    return 'normal';
  }
}

/**
 * Render the mode toolbar inside the panel header.
 * Creates the toolbar DOM if it doesn't exist, then updates active state.
 */
function _ensureToolbar() {
  if (_toolbarEl) return;
  _panelEl = _panelEl || document.getElementById('right-inspector-panel');
  if (!_panelEl) return;
  const header = _panelEl.querySelector('.inspector-panel-header');
  if (!header) return;

  _toolbarEl = document.createElement('div');
  _toolbarEl.className = 'inspector-toolbar';

  for (const m of TOOLBAR_MODES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inspector-toolbar-btn';
    btn.dataset.mode = m.mode;
    btn.title = m.label;
    btn.innerHTML = `${m.icon}<span>${m.label}</span>`; /* safeSetHTML-exempt: static template */
    btn.addEventListener('click', () => {
      if (!_currentData || !_currentData.msg) {
        const targetIndex = _getOverviewToolbarTargetIndex(m.mode, _currentData);
        if (targetIndex === undefined) return;
        if (m.mode === 'artifact') {
          document.dispatchEvent(
            new CustomEvent('deepchat:open-artifact-inspector', { detail: { msgIndex: targetIndex } })
          );
        } else {
          _dispatchInspectorOpen(m.mode, targetIndex);
        }
        return;
      }
      openInspectorPanel(m.mode, _currentData);
    });
    _toolbarEl.appendChild(btn);
  }

  // Insert toolbar before the close button
  const closeBtn = header.querySelector('.inspector-panel-close');
  if (closeBtn) {
    header.insertBefore(_toolbarEl, closeBtn);
  } else {
    header.appendChild(_toolbarEl);
  }
}

function _getOverviewToolbarTargetIndex(mode: string, data: Record<string, any> = {}) {
  if (mode === 'trace') return data.latestTraceIndex;
  if (mode === 'artifact') return data.latestArtifactIndex;
  return data.latestMessageIndex;
}

function _updateToolbar() {
  if (!_toolbarEl) return;
  Array.from(_toolbarEl.querySelectorAll('.inspector-toolbar-btn')).forEach((btn) => {
    const el = btn as HTMLElement;
    const isActive = el.dataset.mode === _currentMode;
    el.classList.toggle('is-active', isActive);
  });
}

// ─── Global Shortcut ────────────────────────────────────────────────────────

export function bindInspectorPanelShortcut() {
  const handler = (e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      toggleInspectorPanel('empty');
    }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

/**
 * Initialize Inspector Panel — bind toggle button and keyboard shortcut.
 * Call once during app startup.
 */
export function initInspectorPanel(options: { getOverviewData?: () => Record<string, any> | null } = {}) {
  if (options.getOverviewData) setInspectorOverviewProvider(options.getOverviewData);
  const toggleBtn = document.getElementById('inspector-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      toggleInspectorPanel('empty');
      toggleBtn.setAttribute('aria-expanded', String(_isOpen));
      // Clear badge on open
      toggleBtn.classList.remove('has-badge');
    });
  }
  if (window.matchMedia?.('(min-width: 1180px)').matches) {
    openInspectorPanel('empty');
    toggleBtn?.setAttribute('aria-expanded', 'true');
  }
  bindInspectorPanelShortcut();
}

/**
 * Highlight the Inspector toggle button to indicate new content (e.g. artifacts).
 */
export function setInspectorToggleBadge(hasBadge: boolean) {
  const toggleBtn = document.getElementById('inspector-toggle-btn');
  if (toggleBtn) {
    toggleBtn.classList.toggle('has-badge', hasBadge);
  }
}
