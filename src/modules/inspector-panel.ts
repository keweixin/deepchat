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
import { escapeHtml } from './shared-utils.js';

let _panelEl = null;
let _contentEl = null;
let _toolbarEl = null;
let _isOpen = false;
let _currentMode = 'empty'; // empty | message | trace | theatre | artifact
let _currentData: Record<string, any> = {};

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
}

/**
 * Open the panel with specific content
 * @param {string} mode
 * @param {Object} data
 */
export function openInspectorPanel(mode, data = {}) {
  _ensurePanel();
  if (!_panelEl) return;
  _isOpen = true;
  _currentMode = mode;
  _currentData = data;
  _panelEl.classList.add('is-visible');
  _ensureToolbar();
  _updateToolbar();
  _renderContent(mode, data);
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
export function toggleInspectorPanel(mode, data = {}) {
  if (_isOpen && _currentMode === mode) {
    closeInspectorPanel();
  } else {
    openInspectorPanel(mode, data);
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
export function updateInspectorPanel(mode, data = {}) {
  if (!_isOpen) return;
  _currentMode = mode;
  _renderContent(mode, data);
}

// ─── Content Renderers ──────────────────────────────────────────────────────

function _renderContent(mode, data) {
  if (!_contentEl) return;
  _contentEl.innerHTML = '';

  switch (mode) {
    case 'message':
      _renderMessageInfo(data);
      break;
    case 'trace':
      _renderTraceInfo(data);
      break;
    case 'model':
      _renderModelInfo(data);
      break;
    case 'artifact':
      _renderArtifactInfo(data);
      break;
    case 'empty':
    default:
      _renderEmpty();
      break;
  }
}

function _renderEmpty() {
  _contentEl.innerHTML = `
    <div class="inspector-empty">
      <p>选择一条消息或按 <kbd>Ctrl+Shift+I</kbd> 查看详情</p>
    </div>
  `;
}

function _renderMessageInfo(data) {
  const { msg, index } = data;
  if (!msg) return _renderEmpty();

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
          msg.tokens
            ? `
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">Token</span>
          <span class="inspector-meta-value">${typeof msg.tokens === 'object' ? JSON.stringify(msg.tokens) : msg.tokens}</span>
        </div>
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
      msg.toolCalls?.length
        ? `
    <div class="inspector-section">
      <h3>工具调用 (${msg.toolCalls.length})</h3>
      <div class="inspector-tool-list"></div>
    </div>
    `
        : ''
    }
  `;
  _contentEl.innerHTML = html;
}

function _renderTraceInfo(data) {
  const { recorder } = data;
  if (!recorder) return _renderEmpty();

  const summary = recorder.getRunSummary ? recorder.getRunSummary() : {};
  const html = `
    <div class="inspector-section">
      <h3>Trace 摘要</h3>
      <div class="inspector-meta-grid">
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">Run ID</span>
          <span class="inspector-meta-value" style="font-size:0.75rem;word-break:break-all">${summary.runId || recorder.runId || '—'}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">状态</span>
          <span class="inspector-meta-value">${summary.status || 'running'}</span>
        </div>
        <div class="inspector-meta-item">
          <span class="inspector-meta-label">事件数</span>
          <span class="inspector-meta-value">${summary.eventCount || 0}</span>
        </div>
      </div>
    </div>
  `;
  _contentEl.innerHTML = html;
}

function _renderModelInfo(data) {
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
  _contentEl.innerHTML = html;
}

// ─── Artifact Renderer ──────────────────────────────────────────────────────

function _renderArtifactInfo(data) {
  const { msg } = data;
  if (!msg?.content) return _renderEmpty();

  const artifacts = extractArtifacts(msg.content);
  if (artifacts.length === 0) {
    _contentEl.innerHTML = `
      <div class="inspector-empty">
        <p>此消息中未发现 artifact</p>
      </div>
    `;
    return;
  }

  let html = `
    <div class="inspector-section">
      <h3>Artifacts (${artifacts.length})</h3>
  `;

  for (const [i, artifact] of artifacts.entries()) {
    const icon = ARTIFACT_TYPE_ICONS[artifact.type] || ARTIFACT_TYPE_ICONS['code-file'];
    const typeLabel = getArtifactTypeLabel(artifact.type);
    const metaParts = _buildArtifactMeta(artifact);
    const preview = _buildArtifactPreview(artifact);

    html += `
      <div class="inspector-artifact-card" data-artifact-index="${i}">
        <div class="inspector-artifact-header">
          <span class="inspector-artifact-icon">${icon}</span>
          <span class="inspector-artifact-title">${escapeHtml(artifact.title || typeLabel)}</span>
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
        </div>
      </div>
    `;
  }

  html += '</div>';
  _contentEl.innerHTML = html;

  // Attach event listeners for copy/download buttons
  _contentEl.querySelectorAll('.inspector-artifact-action').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = /** @type {HTMLElement} */ e.currentTarget;
      const action = target.dataset.action;
      const idx = Number(target.dataset.artifactIdx);
      const art = artifacts[idx];
      if (!art) return;
      if (action === 'copy') {
        _copyArtifactSource(art);
      } else if (action === 'download') {
        _downloadArtifact(art, idx);
      }
    });
  });
}

/**
 * Build meta info line for an artifact card.
 * @param {import('./artifacts.js').Artifact} artifact
 * @returns {string[]}
 */
function _buildArtifactMeta(artifact) {
  const parts = [getArtifactTypeLabel(artifact.type)];
  if (artifact.language) parts.push(artifact.language);
  if (artifact.format) parts.push(artifact.format.toUpperCase());
  if (artifact.size) parts.push(_formatBytes(artifact.size));
  if (artifact.truncated) parts.push('已裁剪');
  return parts;
}

/**
 * Build a type-specific preview snippet for the inspector.
 * @param {import('./artifacts.js').Artifact} artifact
 * @returns {string}
 */
function _buildArtifactPreview(artifact) {
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

function _buildHtmlPreview(artifact) {
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

function _buildMermaidPreview(artifact) {
  const lines = artifact.source.split('\n').slice(0, 12);
  const preview = lines.join('\n');
  const truncated = artifact.source.split('\n').length > 12;
  return `
    <div class="inspector-artifact-preview inspector-artifact-preview--mermaid">
      <pre class="inspector-artifact-code"><code>${escapeHtml(preview)}${truncated ? '\n…' : ''}</code></pre>
    </div>
  `;
}

function _buildJsonPreview(artifact) {
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

function _buildTablePreview(artifact) {
  const rows = parseTableRows(artifact.source, artifact.format);
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

function _buildCodePreview(artifact) {
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
function parseTableRows(source, format) {
  const lines = String(source || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  if (format === 'markdown') {
    // Skip separator row (---|---)
    const dataLines = lines.filter((l) => !/^\|?\s*[-:]+[-|:\s]+\s*\|?\s*$/.test(l));
    return dataLines.map((line) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim())
    );
  }

  const sep = format === 'tsv' ? '\t' : ',';
  return lines.map((line) => line.split(sep).map((c) => c.trim()));
}

/**
 * Copy artifact source to clipboard.
 * @param {import('./artifacts.js').Artifact} artifact
 */
function _copyArtifactSource(artifact) {
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
function _downloadArtifact(artifact, index) {
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
function _showInspectorToast(message) {
  if (!_contentEl) return;
  const toast = document.createElement('div');
  toast.className = 'inspector-toast';
  toast.textContent = message;
  _contentEl.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
}

/**
 * Format byte size to human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function _formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Toolbar ────────────────────────────────────────────────────────────────

const TOOLBAR_MODES = [
  {
    mode: 'message',
    label: '消息',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  },
  {
    mode: 'trace',
    label: 'Trace',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  },
  {
    mode: 'artifact',
    label: 'Artifact',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  },
];

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
    btn.innerHTML = `${m.icon}<span>${m.label}</span>`;
    btn.addEventListener('click', () => {
      if (!_currentData || !_currentData.msg) return;
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

function _updateToolbar() {
  if (!_toolbarEl) return;
  _toolbarEl.querySelectorAll('.inspector-toolbar-btn').forEach((btn) => {
    const isActive = btn.dataset.mode === _currentMode;
    btn.classList.toggle('is-active', isActive);
  });
}

// ─── Global Shortcut ────────────────────────────────────────────────────────

export function bindInspectorPanelShortcut() {
  const handler = (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      toggleInspectorPanel('empty');
    }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
