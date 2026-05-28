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
 */

let _panelEl = null;
let _contentEl = null;
let _isOpen = false;
let _currentMode = 'empty'; // empty | message | trace | theatre | artifact

/**
 * Initialize the panel DOM if not already present
 */
function _ensurePanel() {
  if (_panelEl) return;
  _panelEl = document.getElementById('right-inspector-panel');
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
  _panelEl.classList.add('is-visible');
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
