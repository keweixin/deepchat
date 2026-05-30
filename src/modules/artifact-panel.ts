/**
 * Artifact Panel — Permanent right-side workspace for viewing artifacts
 *
 * Features:
 * - Scrollable artifact list with type icons
 * - Click to preview selected artifact
 * - Copy and download actions per artifact
 * - Auto-show when new assistant message contains artifacts
 *
 * Integrates with:
 * - artifacts.js (Artifact extraction)
 * - inspector-panel.js (existing artifact rendering in inspector)
 */

import {
  extractArtifacts,
  createSandboxedHtmlDocument,
  buildArtifactDownloadName,
  getArtifactTypeLabel,
} from './artifacts.js';
import type { Artifact } from './artifacts.js';
import { escapeHtml, formatBytes } from './shared-utils.js';
import { safeSetHTML } from './renderer.js';

let _panelEl: HTMLElement | null = null;
let _listEl: HTMLElement | null = null;
let _previewEl: HTMLElement | null = null;
let _isOpen = false;
let _selectedArtifactIndex = -1;
let _currentArtifacts: Artifact[] = [];
let _currentMsgIndex = -1;

/** Type icons (SVG paths) for each artifact type. */
const ARTIFACT_TYPE_ICONS: Record<string, string> = {
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
 */
function _ensurePanel() {
  if (_panelEl && _panelEl.isConnected) return;
  _panelEl = document.getElementById('artifact-panel');
  _listEl = null;
  _previewEl = null;
  if (!_panelEl) return;
  _listEl = _panelEl.querySelector('.artifact-panel-list');
  _previewEl = _panelEl.querySelector('.artifact-panel-preview');

  // Bind close button once
  const closeBtn = _panelEl.querySelector('.artifact-panel-close');
  if (closeBtn && !(closeBtn as any).__artifactPanelCloseBound) {
    (closeBtn as any).__artifactPanelCloseBound = true;
    closeBtn.addEventListener('click', closeArtifactPanel);
  }
}

/**
 * Open the artifact panel with artifacts from a message.
 */
export function openArtifactPanel(msgIndex: number, message: Record<string, any>) {
  _ensurePanel();
  if (!_panelEl) return;

  const content = String(message?.content || '');
  const artifacts = extractArtifacts(content);
  if (artifacts.length === 0) return;

  // Stamp metadata
  for (const art of artifacts) {
    art.messageIndex = msgIndex;
    art.createdAt = message.timestamp || Date.now();
  }

  _currentArtifacts = artifacts;
  _currentMsgIndex = msgIndex;
  _selectedArtifactIndex = 0;
  _isOpen = true;
  _panelEl.classList.add('is-visible');

  _renderList();
  _renderPreview(0);
}

/**
 * Close the artifact panel.
 */
export function closeArtifactPanel() {
  _ensurePanel();
  if (!_panelEl) return;
  _isOpen = false;
  _selectedArtifactIndex = -1;
  _currentArtifacts = [];
  _panelEl.classList.remove('is-visible');
}

/**
 * Toggle the artifact panel.
 */
export function toggleArtifactPanel(msgIndex?: number, message?: Record<string, any>) {
  if (_isOpen) {
    closeArtifactPanel();
  } else if (msgIndex != null && message) {
    openArtifactPanel(msgIndex, message);
  }
}

/**
 * Check if the panel is open.
 */
export function isArtifactPanelOpen() {
  return _isOpen;
}

/**
 * Render the artifact list in the left side of the panel.
 */
function _renderList() {
  if (!_listEl) return;
  _listEl.textContent = '';

  for (const [i, artifact] of _currentArtifacts.entries()) {
    const icon = ARTIFACT_TYPE_ICONS[artifact.type] || ARTIFACT_TYPE_ICONS['code-file'];
    const typeLabel = getArtifactTypeLabel(artifact.type);
    const metaParts = [typeLabel];
    if (artifact.language) metaParts.push(artifact.language);
    if (artifact.format) metaParts.push(artifact.format.toUpperCase());
    if (artifact.size) metaParts.push(formatBytes(artifact.size));

    const card = document.createElement('div');
    card.className = `artifact-workspace-card${i === _selectedArtifactIndex ? ' is-selected' : ''}`;
    card.dataset.index = String(i);

    const iconEl = document.createElement('span');
    iconEl.className = 'artifact-workspace-icon';
    safeSetHTML(iconEl, icon);

    const infoEl = document.createElement('div');
    infoEl.className = 'artifact-workspace-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'artifact-workspace-title';
    titleEl.textContent = artifact.title || typeLabel;

    const metaEl = document.createElement('div');
    metaEl.className = 'artifact-workspace-meta';
    metaEl.textContent = metaParts.join(' · ');

    infoEl.append(titleEl, metaEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'artifact-workspace-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'artifact-workspace-action';
    copyBtn.title = '复制源码';
    // prettier-ignore
    copyBtn.innerHTML = /* trusted-html */ '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _copyArtifactSource(artifact);
    });

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'artifact-workspace-action';
    downloadBtn.title = '下载文件';
    // prettier-ignore
    downloadBtn.innerHTML = /* trusted-html */ '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _downloadArtifact(artifact, i);
    });

    actionsEl.append(copyBtn, downloadBtn);
    card.append(iconEl, infoEl, actionsEl);

    card.addEventListener('click', () => {
      _selectedArtifactIndex = i;
      _updateListSelection();
      _renderPreview(i);
    });

    _listEl.appendChild(card);
  }
}

/**
 * Update the selection state of list cards without re-rendering.
 */
function _updateListSelection() {
  if (!_listEl) return;
  Array.from(_listEl.querySelectorAll('.artifact-workspace-card')).forEach((card, i) => {
    (card as HTMLElement).classList.toggle('is-selected', i === _selectedArtifactIndex);
  });
}

/**
 * Render the preview area for a selected artifact.
 */
function _renderPreview(index: number) {
  if (!_previewEl) return;
  _previewEl.textContent = '';

  const artifact = _currentArtifacts[index];
  if (!artifact) {
    // prettier-ignore
    _previewEl.innerHTML = /* trusted-html */ '<div class="artifact-panel-preview-empty">点击左侧 artifact 查看预览</div>';
    return;
  }

  // Action buttons
  const actionsEl = document.createElement('div');
  actionsEl.className = 'artifact-preview-actions';

  const copyBtn = _createPreviewAction(
    '复制源码',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
  );
  copyBtn.addEventListener('click', () => _copyArtifactSource(artifact));

  const downloadBtn = _createPreviewAction(
    '下载',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
  );
  downloadBtn.addEventListener('click', () => _downloadArtifact(artifact, index));

  actionsEl.append(copyBtn, downloadBtn);

  // Preview content
  const container = document.createElement('div');
  container.className = 'artifact-preview-container';

  switch (artifact.type) {
    case 'html-preview':
      _renderHtmlPreview(container, artifact);
      break;
    case 'mermaid':
      _renderCodePreview(container, artifact);
      break;
    case 'json-data':
      _renderJsonPreview(container, artifact);
      break;
    case 'table':
      _renderTablePreview(container, artifact);
      break;
    case 'code-file':
    default:
      _renderCodePreview(container, artifact);
      break;
  }

  _previewEl.append(actionsEl, container);
}

function _createPreviewAction(label: string, iconSvg: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'artifact-preview-action';
  safeSetHTML(btn, `${iconSvg} ${escapeHtml(label)}`, { sanitize: false });
  return btn;
}

function _renderHtmlPreview(container: HTMLElement, artifact: Artifact) {
  const srcdoc = createSandboxedHtmlDocument(artifact.source, { title: artifact.title });
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.srcdoc = srcdoc;
  iframe.title = artifact.title || 'HTML 预览';
  container.appendChild(iframe);
}

function _renderCodePreview(container: HTMLElement, artifact: Artifact) {
  const lines = artifact.source.split('\n').slice(0, 80);
  const truncated = artifact.source.split('\n').length > 80;
  const pre = document.createElement('pre');
  pre.textContent = lines.join('\n') + (truncated ? '\n...' : '');
  container.appendChild(pre);
}

function _renderJsonPreview(container: HTMLElement, artifact: Artifact) {
  let display = artifact.source;
  if (artifact.parsed) {
    try {
      display = JSON.stringify(artifact.parsed, null, 2);
    } catch {
      // keep original
    }
  }
  const lines = display.split('\n').slice(0, 80);
  const truncated = display.split('\n').length > 80;
  const pre = document.createElement('pre');
  pre.textContent = lines.join('\n') + (truncated ? '\n...' : '');
  container.appendChild(pre);
}

function _renderTablePreview(container: HTMLElement, artifact: Artifact) {
  const rows = _parseTableRows(artifact.source, artifact.format || '');
  if (rows.length === 0) {
    const pre = document.createElement('pre');
    pre.textContent = artifact.source.slice(0, 1000);
    container.appendChild(pre);
    return;
  }

  const table = document.createElement('table');
  const displayRows = rows.slice(0, 20);
  const hasMore = rows.length > 20;

  // Header
  if (displayRows.length > 0) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const cell of displayRows[0]) {
      const th = document.createElement('th');
      th.textContent = cell;
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
  }

  // Body
  const tbody = document.createElement('tbody');
  for (let r = 1; r < displayRows.length; r++) {
    const tr = document.createElement('tr');
    for (const cell of displayRows[r]) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);

  if (hasMore) {
    const more = document.createElement('div');
    more.style.cssText =
      'padding:0.375rem 0.5rem;font-size:0.75rem;color:var(--text-tertiary,#9ca3af);text-align:center;';
    more.textContent = `... 共 ${rows.length} 行`;
    container.appendChild(more);
  }
}

function _parseTableRows(source: string, format: string): string[][] {
  const lines = String(source || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  if (format === 'markdown') {
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
 */
function _copyArtifactSource(artifact: Artifact) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(artifact.source).then(() => {
      _showToast('已复制到剪贴板');
    });
  }
}

/**
 * Download artifact as file.
 */
function _downloadArtifact(artifact: Artifact, index: number) {
  let blob: Blob;
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
 * Show a brief toast message inside the artifact panel.
 */
function _showToast(message: string) {
  if (!_previewEl) return;
  const toast = document.createElement('div');
  toast.className = 'artifact-panel-toast';
  toast.textContent = message;
  _previewEl.appendChild(toast);
  setTimeout(() => toast.remove(), 1500);
}

/**
 * Initialize Artifact Panel — bind close button. Call once during app startup.
 */
export function initArtifactPanel() {
  _ensurePanel();
}
