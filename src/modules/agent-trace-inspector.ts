/**
 * Agent Trace Inspector — Renders a detailed trace inspection panel
 *
 * Usage:
 *   import { openTraceInspector, closeTraceInspector } from './agent-trace-inspector.js';
 *   openTraceInspector(recorder); // opens the panel with trace data
 *   closeTraceInspector();        // closes the panel
 */

import {
  buildActorState,
  buildCrewHeaderState,
  buildToolCallTimeline,
  buildEventTimeline,
  buildContextSnapshots,
  buildHumanReadableSummary,
} from './agent-actor-system.js';
import { exportTraceAsBlob, generateTraceFileName, TraceRecorder } from './agent-trace.js';
import { escapeHtml } from './shared-utils.js';

// ─── Module State ───────────────────────────────────────────────────────────

let _overlay: HTMLElement | null = null;
let _panel: HTMLElement | null = null;
let _currentRecorder: TraceRecorder | null = null;
let _isOpen = false;

// ─── Public API ─────────────────────────────────────────────────────────────

export function openTraceInspector(recorder: TraceRecorder | null, options: { conversationTitle?: string } = {}) {
  if (!recorder) return;
  _currentRecorder = recorder;
  _ensureDOM();
  _render(recorder, options);
  _show();
}

export function closeTraceInspector() {
  _hide();
  _currentRecorder = null;
}

export function isTraceInspectorOpen() {
  return _isOpen;
}

export function toggleTraceInspector(recorder: TraceRecorder | null) {
  if (_isOpen) {
    closeTraceInspector();
  } else if (recorder) {
    openTraceInspector(recorder);
  }
}

// ─── DOM Management ─────────────────────────────────────────────────────────

function _ensureDOM() {
  if (_overlay && _panel && _overlay.isConnected) return;

  // Overlay
  _overlay = document.createElement('div');
  _overlay.className = 'trace-inspector-overlay';
  _overlay.addEventListener('click', (e) => {
    if (e.target === _overlay) closeTraceInspector();
  });

  // Panel
  _panel = document.createElement('div');
  _panel.className = 'trace-inspector-panel';
  _panel.setAttribute('role', 'dialog');
  _panel.setAttribute('aria-label', 'Agent Trace Inspector');

  _overlay.appendChild(_panel);
  document.body.appendChild(_overlay);

  // Keyboard shortcut
  document.addEventListener('keydown', _onKeyDown);
}

function _onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && _isOpen) {
    closeTraceInspector();
  }
}

function _show() {
  if (!_overlay || !_panel) return;
  _overlay.classList.add('is-visible');
  _panel.classList.add('is-visible');
  _isOpen = true;
  document.body.style.overflow = 'hidden';
}

function _hide() {
  if (!_overlay || !_panel) return;
  _overlay.classList.remove('is-visible');
  _panel.classList.remove('is-visible');
  _isOpen = false;
  document.body.style.overflow = '';
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function _render(recorder: TraceRecorder, options: { conversationTitle?: string } = {}) {
  const { conversationTitle = '' } = options;
  const summary = buildCrewHeaderState(recorder);
  const actors = buildActorState(recorder) as ActorState[];
  const tools = buildToolCallTimeline(recorder) as unknown as ToolCallRecord[];
  const events = buildEventTimeline(recorder) as TimelineEvent[];
  const snapshots = buildContextSnapshots(recorder) as ContextSnapshot[];

  if (!_panel) return;
  _panel.innerHTML = '';

  // Header
  _panel.appendChild(_renderHeader(conversationTitle));

  // Run summary bar
  _panel.appendChild(_renderRunSummary(summary));

  // Body
  const body = document.createElement('div');
  body.className = 'trace-inspector-body';

  // Actor grid
  body.appendChild(_renderSection('Actors', _renderActorGrid(actors), { badge: actors.length }));

  // Tool calls
  if (tools.length > 0) {
    body.appendChild(_renderSection('Tool Calls', _renderToolCards(tools), { badge: tools.length }));
  }

  // Event timeline
  if (events.length > 0) {
    body.appendChild(_renderSection('Event Timeline', _renderEventTimeline(events), { badge: events.length }));
  }

  // Context snapshots
  if (snapshots.length > 0) {
    body.appendChild(_renderSection('Context Compactions', _renderSnapshots(snapshots), { badge: snapshots.length }));
  }

  // Export actions
  body.appendChild(_renderExportActions(recorder));

  _panel.appendChild(body);
}

function _renderHeader(title: string) {
  const header = document.createElement('div');
  header.className = 'trace-inspector-header';

  const titleEl = document.createElement('div');
  titleEl.className = 'trace-inspector-title';
  titleEl.innerHTML = `
    <svg class="trace-inspector-title-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
    <span>Trace Inspector${title ? ` — ${escapeHtml(title)}` : ''}</span>
  `;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'trace-inspector-close';
  closeBtn.setAttribute('aria-label', 'Close inspector');
  closeBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  `;
  closeBtn.addEventListener('click', closeTraceInspector);

  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  return header;
}

interface RunSummaryInput {
  status: string;
  label: string;
  durationMs?: number;
  activeActors?: number;
  totalActors?: number;
  waitingCount?: number;
  errorCount?: number;
}

function _renderRunSummary(summary: RunSummaryInput) {
  const bar = document.createElement('div');
  bar.className = 'trace-run-summary';

  const items: { label: string; value: string }[] = [
    { label: 'Status', value: _renderStatusDot(summary.status as string) + (summary.label as string) },
    { label: 'Duration', value: formatDuration(summary.durationMs as number) },
    { label: 'Actors', value: `${summary.activeActors}/${summary.totalActors} active` },
  ];

  if ((summary.waitingCount as number) > 0) {
    items.push({ label: 'Waiting', value: `${summary.waitingCount} tool(s)` });
  }
  if ((summary.errorCount as number) > 0) {
    items.push({ label: 'Errors', value: String(summary.errorCount) });
  }

  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'trace-summary-item';
    div.innerHTML = `
      <span class="trace-summary-label">${escapeHtml(item.label)}</span>
      <span class="trace-summary-value">${item.value}</span>
    `;
    bar.appendChild(div);
  }

  return bar;
}

function _renderStatusDot(status: string) {
  const map: Record<string, string> = {
    running: 'trace-status-dot--running',
    waiting: 'trace-status-dot--waiting',
    done: 'trace-status-dot--done',
    error: 'trace-status-dot--error',
    cancelled: 'trace-status-dot--cancelled',
  };
  const cls = map[status] || '';
  return `<span class="trace-status-dot ${cls}"></span> `;
}

function _renderSection(
  title: string,
  content: HTMLElement | string,
  { badge, defaultOpen = true }: { badge?: number; defaultOpen?: boolean } = {}
) {
  const section = document.createElement('div');
  section.className = 'trace-section';
  if (!defaultOpen) section.classList.add('is-collapsed');

  const header = document.createElement('div');
  header.className = 'trace-section-header';
  header.innerHTML = `
    <svg class="trace-section-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
    <span>${escapeHtml(title)}</span>
    ${badge !== undefined ? `<span class="trace-section-badge">${badge}</span>` : ''}
  `;

  const contentWrap = document.createElement('div');
  contentWrap.className = 'trace-section-content';
  if (typeof content === 'string') {
    contentWrap.innerHTML = content;
  } else {
    contentWrap.appendChild(content);
  }

  header.addEventListener('click', () => {
    section.classList.toggle('is-collapsed');
  });

  section.appendChild(header);
  section.appendChild(contentWrap);
  return section;
}

interface ActorState {
  isActive: boolean;
  color: string;
  icon: string;
  label: string;
  status: string;
  currentAction?: string;
}

function _renderActorGrid(actors: ActorState[]) {
  const grid = document.createElement('div');
  grid.className = 'trace-actor-grid';

  for (const actor of actors) {
    const card = document.createElement('div');
    card.className = 'trace-actor-card';
    if (actor.isActive) card.classList.add('trace-actor-card--active');

    card.innerHTML = `
      <div class="trace-actor-icon" style="background:${actor.color}20;color:${actor.color}">
        ${actor.icon}
      </div>
      <div class="trace-actor-name">${escapeHtml(actor.label)}</div>
      <div class="trace-actor-status">${escapeHtml(actor.status)}</div>
      ${
        actor.currentAction && actor.currentAction !== '等待中'
          ? `<div class="trace-actor-action">${escapeHtml(actor.currentAction)}</div>`
          : ''
      }
    `;
    grid.appendChild(card);
  }

  return grid;
}

interface ToolRoleMeta {
  color?: string;
  label?: string;
}

interface ToolCallRecord {
  status: string;
  roleMeta?: ToolRoleMeta;
  roleId: string;
  toolName: string;
  durationMs: number;
  outputBytes: number;
  approvedAt?: number;
  outputSummary?: string;
  error?: string;
  args?: unknown;
  output?: unknown;
}

function _renderToolCards(tools: ToolCallRecord[]) {
  const container = document.createElement('div');

  for (const tc of tools) {
    const card = document.createElement('div');
    card.className = 'trace-tool-card';

    const statusClass = `trace-tool-status--${tc.status}`;
    const statusLabel = tc.status.replace(/_/g, ' ');

    card.innerHTML = `
      <div class="trace-tool-header">
        <div class="trace-tool-name">
          <span class="trace-tool-role-badge" style="background:${tc.roleMeta?.color || '#64748b'}20;color:${tc.roleMeta?.color || '#94a3b8'}">
            ${tc.roleMeta?.label || tc.roleId}
          </span>
          ${escapeHtml(tc.toolName)}
        </div>
        <span class="trace-tool-status ${statusClass}">${escapeHtml(statusLabel)}</span>
      </div>
      <div class="trace-tool-meta">
        ${tc.durationMs > 0 ? `<span class="trace-tool-meta-item">⏱ ${tc.durationMs}ms</span>` : ''}
        ${tc.outputBytes > 0 ? `<span class="trace-tool-meta-item">📄 ${tc.outputBytes} bytes</span>` : ''}
        ${tc.approvedAt ? `<span class="trace-tool-meta-item">✓ approved</span>` : ''}
      </div>
      ${tc.outputSummary ? `<div class="trace-tool-summary">${escapeHtml(tc.outputSummary)}</div>` : ''}
      ${tc.error ? `<div class="trace-tool-summary" style="color:#f87171">${escapeHtml(tc.error)}</div>` : ''}
    `;

    // Expandable raw data
    if (tc.args || tc.output) {
      const rawBtn = document.createElement('button');
      rawBtn.className = 'composer-settings-shortcut';
      rawBtn.style.cssText = 'margin-top:8px;font-size:11px;';
      rawBtn.textContent = 'Show raw data';
      let expanded = false;
      let rawEl: HTMLElement | null = null;

      rawBtn.addEventListener('click', () => {
        if (expanded) {
          rawEl?.remove();
          rawBtn.textContent = 'Show raw data';
          expanded = false;
        } else {
          rawEl = document.createElement('pre');
          rawEl.className = 'trace-tool-raw';
          const data = { args: tc.args, output: tc.output, error: tc.error };
          rawEl.textContent = JSON.stringify(data, null, 2);
          card.appendChild(rawEl);
          rawBtn.textContent = 'Hide raw data';
          expanded = true;
        }
      });

      card.appendChild(rawBtn);
    }

    container.appendChild(card);
  }

  return container;
}

interface TimelineEvent {
  type: string;
  timestamp: number;
  relativeMs: number;
  mode?: string;
  model?: string;
  stage?: string;
  toolName?: string;
  autoApproved?: boolean;
  approved?: boolean;
  latencyMs?: number;
  ok?: boolean;
  durationMs?: number;
  confidence?: number;
  chars?: number;
  tokens?: number;
  messageCount?: number;
  tokenCount?: number;
  status?: string;
  source?: string;
  message?: string;
}

function _renderEventTimeline(events: TimelineEvent[]) {
  const timeline = document.createElement('div');
  timeline.className = 'trace-timeline';

  for (const evt of events) {
    const item = document.createElement('div');
    item.className = `trace-timeline-item trace-timeline-item--${evt.type}`;

    const time = new Date(evt.timestamp).toLocaleTimeString();
    const relative = evt.relativeMs >= 0 ? `+${evt.relativeMs}ms` : '';

    let detail = '';
    switch (evt.type) {
      case 'run_start':
        detail = `Mode: ${evt.mode}${evt.model ? ` · Model: ${evt.model}` : ''}`;
        break;
      case 'stage':
        detail = `Stage: ${evt.stage}${evt.toolName ? ` · ${evt.toolName}` : ''}`;
        break;
      case 'tool_request':
        detail = `${evt.toolName}${evt.autoApproved ? ' (auto-approved)' : ''}`;
        break;
      case 'approval':
        detail = `${evt.approved ? 'Approved' : 'Denied'}${evt.latencyMs ? ` · ${evt.latencyMs}ms` : ''}`;
        break;
      case 'tool_result':
        detail = `${evt.ok ? 'Success' : 'Failed'}${evt.durationMs ? ` · ${evt.durationMs}ms` : ''}`;
        break;
      case 'tool_repair':
        detail = `Confidence: ${evt.confidence}`;
        break;
      case 'model_delta':
        detail = `${evt.chars || 0} chars${evt.tokens ? ` · ${evt.tokens} tokens` : ''}`;
        break;
      case 'context_compaction':
        detail = `${evt.messageCount} msgs · ${evt.tokenCount} tokens`;
        break;
      case 'run_end':
        detail = `Status: ${evt.status}${evt.durationMs ? ` · ${evt.durationMs}ms` : ''}`;
        break;
      case 'error':
        detail = `${evt.source}: ${evt.message}`;
        break;
    }

    item.innerHTML = `
      <div class="trace-timeline-time">${escapeHtml(time)} ${relative ? `<span style="opacity:0.6">${relative}</span>` : ''}</div>
      <div class="trace-timeline-type">${escapeHtml(evt.type)}</div>
      ${detail ? `<div class="trace-timeline-detail">${escapeHtml(detail)}</div>` : ''}
    `;

    timeline.appendChild(item);
  }

  return timeline;
}

interface ContextSnapshot {
  description: string;
  atFormatted: string;
  messageCount: number;
  tokenCount: number;
  summaryTokens?: number;
}

function _renderSnapshots(snapshots: ContextSnapshot[]) {
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

  for (const snap of snapshots) {
    const item = document.createElement('div');
    item.style.cssText = `
      background: var(--bg-secondary, rgba(30,41,59,0.5));
      border: 1px solid var(--border-color, rgba(148,163,184,0.1));
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 12px;
    `;
    item.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="font-weight:500;color:var(--text-primary)">${escapeHtml(snap.description)}</span>
        <span style="color:var(--text-tertiary);font-size:11px">${escapeHtml(snap.atFormatted)}</span>
      </div>
      <div style="color:var(--text-secondary)">
        ${snap.messageCount} messages · ${snap.tokenCount} tokens
        ${snap.summaryTokens ? ` · summary: ${snap.summaryTokens} tokens` : ''}
      </div>
    `;
    list.appendChild(item);
  }

  return list;
}

function _renderExportActions(recorder: TraceRecorder) {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'display:flex;gap:8px;padding-top:12px;border-top:1px solid var(--border-color);margin-top:16px;';

  const exportJsonl = document.createElement('button');
  exportJsonl.className = 'composer-settings-shortcut';
  exportJsonl.textContent = 'Export JSONL';
  exportJsonl.addEventListener('click', () => {
    const blob = exportTraceAsBlob(recorder, 'jsonl');
    if (blob) _downloadBlob(blob, generateTraceFileName(recorder));
  });

  const exportJson = document.createElement('button');
  exportJson.className = 'composer-settings-shortcut';
  exportJson.textContent = 'Export JSON';
  exportJson.addEventListener('click', () => {
    const blob = exportTraceAsBlob(recorder, 'json');
    if (blob) _downloadBlob(blob, generateTraceFileName(recorder).replace('.jsonl', '.json'));
  });

  const copySummary = document.createElement('button');
  copySummary.className = 'composer-settings-shortcut';
  copySummary.textContent = 'Copy Summary';
  copySummary.addEventListener('click', async () => {
    const text = buildHumanReadableSummary(recorder);
    try {
      await navigator.clipboard.writeText(text);
      copySummary.textContent = 'Copied!';
      setTimeout(() => (copySummary.textContent = 'Copy Summary'), 1500);
    } catch {
      copySummary.textContent = 'Failed';
      setTimeout(() => (copySummary.textContent = 'Copy Summary'), 1500);
    }
  });

  wrap.appendChild(exportJsonl);
  wrap.appendChild(exportJson);
  wrap.appendChild(copySummary);
  return wrap;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDuration(ms: number) {
  if (!ms || ms < 0) return '0ms';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
}

function _downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}
