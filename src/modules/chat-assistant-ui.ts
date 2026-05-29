/**
 * Chat Assistant UI — Assistant message rendering components
 *
 * Extracted from chat.ts:
 * - renderAssistantArtifacts + preview/download handlers
 * - renderAssistantAnswerHeader + TOC
 * - renderAssistantEvidence + grounding cards
 * - renderErrorContent
 */

import {
  buildArtifactDownloadName,
  createSandboxedHtmlDocument,
  extractArtifacts,
  getArtifactTypeLabel,
} from './artifacts.js';
import {
  buildToolEvidencePayload,
  buildToolRuns,
  formatToolArgs,
  getLocalFileGrounding,
  getSearchGrounding,
  getToolDurationMs,
  getToolName,
  getToolQuery,
  getToolStatusMeta,
} from './tool-runs.js';
import {
  createUsageMetric,
  createUsageRow,
  createUsageSectionTitle,
  formatCompactTokenCount,
  formatTokenUsageTitle,
  formatUsd,
  formatUsageSourceLabel,
} from './chat-evidence-telemetry.js';
import { normalizeTokenUsage } from './token-budget.js';
import { copyToClipboard, escapeHtml, showToast, truncate } from './utils.js';
import { escapeRegExp, formatBytes } from './shared-utils.js';

export function renderAssistantArtifacts(container: HTMLElement, message: any) {
  if (!container) return [];
  container.replaceChildren();
  const artifacts = extractArtifacts(message?.content || '');
  if (artifacts.length === 0) {
    container.hidden = true;
    return [];
  }

  container.hidden = false;
  const section = document.createElement('div');
  section.className = 'artifact-section';

  const header = document.createElement('div');
  header.className = 'artifact-section-header';
  const title = document.createElement('strong');
  title.textContent = 'Artifacts';
  const meta = document.createElement('span');
  meta.textContent = `${artifacts.length} 个可预览结果`;
  header.append(title, meta);
  section.appendChild(header);

  for (const [index, artifact] of artifacts.entries()) {
    section.appendChild(renderArtifactCard(artifact, index));
  }

  container.appendChild(section);
  return artifacts;
}

function renderArtifactCard(artifact: Record<string, any>, index: number) {
  const card = document.createElement('div');
  card.className = 'artifact-card';
  card.dataset.artifactType = artifact.type;

  const main = document.createElement('div');
  main.className = 'artifact-card-main';

  const title = document.createElement('div');
  title.className = 'artifact-title';
  title.textContent = artifact.title || getArtifactTypeLabel(artifact.type);

  const meta = document.createElement('div');
  meta.className = 'artifact-meta';
  const metaParts = buildArtifactMetaParts(artifact);
  meta.textContent = metaParts.join(' · ');
  main.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'artifact-actions';

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'artifact-action-btn primary';
  previewBtn.textContent = '预览';
  previewBtn.addEventListener('click', () => openArtifactPreview(artifact));

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'artifact-action-btn';
  downloadBtn.textContent = '导出';
  downloadBtn.addEventListener('click', () => downloadArtifact(artifact, index));

  actions.append(previewBtn, downloadBtn);
  card.append(main, actions);
  return card;
}

function buildArtifactMetaParts(artifact: Record<string, any>) {
  const parts = [formatBytes(artifact.size || 0)];
  switch (artifact.type) {
    case 'html-preview': {
      parts.push('脚本禁用');
      if (artifact.externalResourceCount) parts.push(`${artifact.externalResourceCount} 个外链资源受 CSP 限制`);
      break;
    }
    case 'mermaid': {
      parts.push('图表');
      break;
    }
    case 'table': {
      parts.push(artifact.format === 'markdown' ? 'Markdown 表格' : artifact.format?.toUpperCase() || '表格');
      break;
    }
    case 'json-data': {
      parts.push(artifact.parsed ? '有效 JSON' : '原始 JSON');
      break;
    }
    case 'code-file': {
      parts.push(artifact.language || '代码');
      break;
    }
    default:
      break;
  }
  if (artifact.truncated) parts.push('已按预览上限裁剪');
  return parts.filter(Boolean);
}
export function renderAssistantAnswerHeader(container: HTMLElement, message: Record<string, any> = {}) {
  if (!container) return null;
  container.innerHTML = '';
  const items = buildAssistantAnswerHeaderItems(message);
  if (!items.length) {
    container.hidden = true;
    return null;
  }
  container.hidden = false;

  const header = document.createElement('div');
  header.className = 'answer-header';
  header.title = buildAssistantAnswerHeaderTitle(message);

  const title = document.createElement('div');
  title.className = 'answer-header-title';
  title.textContent = '回答概览';
  header.appendChild(title);

  const list = document.createElement('div');
  list.className = 'answer-header-chips';
  for (const item of items) {
    const chip = document.createElement('span');
    chip.className = `answer-header-chip chip-${item.kind}`;
    chip.textContent = item.label;
    list.appendChild(chip);
  }
  header.appendChild(list);
  container.appendChild(header);
  return header;
}

export function renderAssistantToc(container: HTMLElement, contentEl: HTMLElement, options: Record<string, any> = {}) {
  if (!container || !contentEl) return [];
  container.innerHTML = '';
  const minHeadings = Number.isFinite(options.minHeadings) ? options.minHeadings : 3;
  const headings = Array.from(contentEl.querySelectorAll('h2, h3'))
    .map((heading: Element, index: number) => {
      const text = String(heading.textContent || '')
        .trim()
        .replace(/\s+/g, ' ');
      if (!text) return null;
      const id = ensureHeadingId(heading, text, index);
      return {
        id,
        text: truncate(text, 48),
        level: heading.tagName.toLowerCase(),
      };
    })
    .filter(Boolean);

  if (headings.length < minHeadings) {
    container.hidden = true;
    return [];
  }

  container.hidden = false;
  const title = document.createElement('div');
  title.className = 'answer-toc-title';
  title.textContent = '目录';
  const list = document.createElement('ol');
  list.className = 'answer-toc-list';
  for (const item of headings.slice(0, 8)) {
    if (!item) continue;
    const row = document.createElement('li');
    row.className = `answer-toc-item level-${item.level}`;
    const link = document.createElement('a');
    link.href = `#${item.id}`;
    link.textContent = item.text;
    row.appendChild(link);
    list.appendChild(row);
  }
  if (headings.length > 8) {
    const more = document.createElement('li');
    more.className = 'answer-toc-more';
    more.textContent = `还有 ${headings.length - 8} 个小节`;
    list.appendChild(more);
  }
  container.append(title, list);
  return headings;
}

function ensureHeadingId(heading: Element, text: string, index: number) {
  const current = String(heading.id || '').trim();
  if (current) return current;
  const slug = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const id = `answer-section-${slug || 'section'}-${index + 1}`;
  heading.id = id;
  return id;
}

function buildAssistantAnswerHeaderItems(message: Record<string, any> = {}) {
  const items = [];
  const type = inferAnswerType(message);
  if (type) items.push({ kind: 'type', label: type });

  const model = String(message.model || message.tokens?.model || message.cacheProfile?.model || '').trim();
  if (model) items.push({ kind: 'model', label: model });

  const runs = getAssistantHeaderToolRuns(message);
  if (runs.length) {
    const failed = runs.filter((run) => isFailedToolStatus(run.status) || run.ok === false).length;
    const completed = runs.filter((run) => run.status === 'completed' || run.ok === true).length;
    const suffix = failed ? ` · ${failed} 失败` : completed ? ` · ${completed} 完成` : '';
    items.push({ kind: failed ? 'tool-warning' : 'tool', label: `工具 ${runs.length}${suffix}` });
  }

  if (Array.isArray(message.agentStages) && message.agentStages.length) {
    const rounds = Math.max(...message.agentStages.map((stage) => Number(stage.round || 0)).filter(Number.isFinite), 0);
    items.push({ kind: 'agent', label: rounds > 0 ? `Agent ${rounds} 轮` : 'Agent 过程' });
  }

  if (message.tokens) {
    const usage = normalizeTokenUsage(message.tokens);
    const source = usage.source === 'provider' ? '实测' : usage.source === 'mixed' ? '混合' : '估算';
    items.push({ kind: 'token', label: `${source} ${formatCompactTokenCount(usage.total)} tok` });
    if (usage.cacheHit > 0 || usage.cacheMiss > 0) {
      items.push({ kind: 'cache', label: `缓存 ${Math.round((usage.cacheHitRate || 0) * 100)}%` });
    }
    if (usage.reasoning > 0)
      items.push({ kind: 'thinking', label: `思考 ${formatCompactTokenCount(usage.reasoning)} tok` });
  }

  if (message.contextBudget?.trimmed) {
    items.push({ kind: 'budget', label: `裁剪 ${message.contextBudget.droppedCount || 0} 条历史` });
  } else if (message.contextBudget?.summaryUsed) {
    items.push({ kind: 'budget', label: '已用长期记忆' });
  }

  return items;
}

function buildAssistantAnswerHeaderTitle(message: Record<string, any> = {}) {
  const lines = ['回答头部'];
  const type = inferAnswerType(message);
  if (type) lines.push(`类型: ${type}`);
  const model = String(message.model || message.tokens?.model || message.cacheProfile?.model || '').trim();
  if (model) lines.push(`模型: ${model}`);
  const runs = getAssistantHeaderToolRuns(message);
  if (runs.length) {
    const names = runs.map((run) => `${getToolName(run)}:${run.status || (run.ok === true ? 'completed' : 'unknown')}`);
    lines.push(`工具: ${names.join(', ')}`);
  }
  if (message.tokens) lines.push(formatTokenUsageTitle(message.tokens));
  if (message.contextBudget?.prefixFingerprint) lines.push(`Prefix: ${message.contextBudget.prefixFingerprint}`);
  if (message.contextBudget?.trimmed) lines.push(`上下文裁剪: ${message.contextBudget.droppedCount || 0} 条`);
  if (message.contextBudget?.summaryUsed) lines.push('上下文摘要: 已使用');
  return lines.join('\n');
}

function inferAnswerType(message: Record<string, any> = {}) {
  if (message.error) return '执行错误';
  const content = String(message.content || '');
  const runs = getAssistantHeaderToolRuns(message);
  if (runs.length) return '执行结果';
  if (Array.isArray(message.agentStages) && message.agentStages.length) return 'Agent';
  if (/```|补丁|代码|函数|组件|接口/.test(content)) return '代码';
  if (/审查|风险|漏洞|安全|性能|可维护/.test(content)) return '代码审查';
  if (/调研|来源|引用|官方|文档|资料/.test(content)) return '调研';
  if (/方案|计划|步骤|优先级|P0|P1|P2/.test(content)) return '方案';
  return content ? '解释' : '';
}

function getAssistantHeaderToolRuns(message: Record<string, any> = {}) {
  return [
    ...(Array.isArray(message.toolRuns) ? message.toolRuns : []),
    ...(Array.isArray(message.toolCalls) ? message.toolCalls : []),
  ].filter(Boolean);
}

function isFailedToolStatus(status: Record<string, any>) {
  return ['failed', 'error', 'denied', 'timeout', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase());
}

function openArtifactPreview(artifact: Record<string, any>) {
  switch (artifact.type) {
    case 'html-preview':
      openHtmlArtifactPreview(artifact);
      break;
    case 'mermaid':
      openMermaidArtifactPreview(artifact);
      break;
    case 'json-data':
      openJsonArtifactPreview(artifact);
      break;
    case 'code-file':
      openCodeArtifactPreview(artifact);
      break;
    case 'table':
      openTableArtifactPreview(artifact);
      break;
    default:
      openHtmlArtifactPreview(artifact);
  }
}

function openHtmlArtifactPreview(artifact: Record<string, any>) {
  document.querySelector('.artifact-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'artifact-preview-panel';

  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('h3');
  title.textContent = artifact.title || 'HTML 预览';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'artifact-preview-close';
  closeBtn.setAttribute('aria-label', '关闭预览');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const warning = document.createElement('div');
  warning.className = 'artifact-preview-warning';
  warning.textContent = '沙箱预览：scripts、forms、network connect 和 frame 默认禁用；外链图片仅允许 https/data。';

  const iframe = document.createElement('iframe');
  iframe.className = 'artifact-preview-frame';
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.srcdoc = createSandboxedHtmlDocument(artifact.source, { title: artifact.title });

  panel.append(header, warning, iframe);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function openMermaidArtifactPreview(artifact: Record<string, any>) {
  document.querySelector('.artifact-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'artifact-preview-panel';

  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('h3');
  title.textContent = artifact.title || 'Mermaid 图表';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'artifact-preview-close';
  closeBtn.setAttribute('aria-label', '关闭预览');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const content = document.createElement('div');
  content.className = 'artifact-preview-content';
  const pre = document.createElement('pre');
  pre.className = 'artifact-preview-code language-mermaid';
  pre.textContent = artifact.source;
  content.appendChild(pre);

  panel.append(header, content);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function openJsonArtifactPreview(artifact: Record<string, any>) {
  document.querySelector('.artifact-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'artifact-preview-panel';

  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('h3');
  title.textContent = artifact.title || 'JSON 数据';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'artifact-preview-close';
  closeBtn.setAttribute('aria-label', '关闭预览');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const content = document.createElement('div');
  content.className = 'artifact-preview-content';
  const pre = document.createElement('pre');
  pre.className = 'artifact-preview-code language-json';
  try {
    pre.textContent = JSON.stringify(JSON.parse(artifact.source), null, 2);
  } catch {
    pre.textContent = artifact.source;
  }
  content.appendChild(pre);

  panel.append(header, content);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function openCodeArtifactPreview(artifact: Record<string, any>) {
  document.querySelector('.artifact-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'artifact-preview-panel';

  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('h3');
  title.textContent = artifact.title || '代码文件';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'artifact-preview-close';
  closeBtn.setAttribute('aria-label', '关闭预览');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const content = document.createElement('div');
  content.className = 'artifact-preview-content';
  const pre = document.createElement('pre');
  pre.className = `artifact-preview-code language-${artifact.language || 'text'}`;
  pre.textContent = artifact.source;
  content.appendChild(pre);

  panel.append(header, content);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function openTableArtifactPreview(artifact: Record<string, any>) {
  document.querySelector('.artifact-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'artifact-preview-panel';

  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('h3');
  title.textContent = artifact.title || '表格';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'artifact-preview-close';
  closeBtn.setAttribute('aria-label', '关闭预览');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const content = document.createElement('div');
  content.className = 'artifact-preview-content';
  const pre = document.createElement('pre');
  pre.className = 'artifact-preview-code';
  pre.textContent = artifact.source;
  content.appendChild(pre);

  panel.append(header, content);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function downloadArtifact(artifact: Record<string, any>, index: number) {
  let blob;
  let mimeType = 'text/plain;charset=utf-8';
  switch (artifact.type) {
    case 'html-preview': {
      const html = createSandboxedHtmlDocument(artifact.source, { title: artifact.title });
      blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      mimeType = 'text/html;charset=utf-8';
      break;
    }
    case 'json-data': {
      blob = new Blob([artifact.source], { type: 'application/json;charset=utf-8' });
      mimeType = 'application/json;charset=utf-8';
      break;
    }
    default: {
      blob = new Blob([artifact.source], { type: 'text/plain;charset=utf-8' });
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = buildArtifactDownloadName(artifact as any, index);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // URL revocation delay, not a shared constant
}
export function renderAssistantEvidence(container: HTMLElement, message: any) {
  if (!container) return;
  container
    .querySelectorAll('.source-grounding-warning, .source-grounding-card, .tool-evidence-panel')
    .forEach((item: Record<string, any>) => item.remove());
  const grounding = getSearchGrounding(message, message?.content || '');
  const localGrounding = getLocalFileGrounding(message, message?.content || '');
  appendToolEvidencePanel(container, message, grounding, localGrounding);
  if (grounding.hasSearch) {
    appendGroundingCard(container, {
      warning: grounding.warning,
      title: grounding.warning ? '联网结果未被明确引用' : '已引用联网来源',
      meta: [grounding.queries[0] ? `query: ${grounding.queries[0]}` : '', `${grounding.sources.length} 个来源`]
        .filter(Boolean)
        .join(' · '),
      items: grounding.sources.slice(0, 3).map((source: Record<string, any>) => ({
        label: source.title || source.url,
        href: source.url,
      })),
      warningText: grounding.hasSources
        ? '本轮调用了联网搜索，但最终回答没有引用搜索来源 URL，请谨慎核验。'
        : '本轮调用了联网搜索，但工具没有返回可用来源 URL，请谨慎核验。',
    });
  }
  if (localGrounding.hasLocalFiles) {
    appendGroundingCard(container, {
      warning: localGrounding.warning,
      title: localGrounding.warning ? '本地文件证据未被明确引用' : '已引用本地文件证据',
      meta: `${localGrounding.citations.length} 个文件引用`,
      items: localGrounding.citations.slice(0, 4).map((citation: Record<string, any>) => ({
        label: citation.label,
        href: '',
      })),
      warningText: '本轮读取或搜索了本地工作区文件，但最终回答没有引用文件名或 file:line 证据，请谨慎核验。',
    });
  }
}

function appendToolEvidencePanel(
  container: HTMLElement,
  message: Record<string, any> = {},
  grounding: Record<string, any> = {},
  localGrounding: Record<string, any> = {}
) {
  const runs = Array.isArray(message.toolRuns) ? message.toolRuns.filter(Boolean) : [];
  const completedRuns = runs.filter((run) => run.status === 'completed' || run.ok === true);
  if (runs.length === 0 && !message.tokens && !message.cacheProfile) return;

  const panel = document.createElement('details');
  panel.className = 'tool-evidence-panel';
  panel.open = completedRuns.length > 0;

  const summary = document.createElement('summary');
  summary.className = 'tool-evidence-summary';
  const title = document.createElement('span');
  title.className = 'tool-evidence-title';
  title.textContent = '本轮工具证据';
  const meta = document.createElement('span');
  meta.className = 'tool-evidence-meta';
  meta.textContent = buildToolEvidenceMeta(runs, grounding, localGrounding, message);
  summary.append(title, meta);
  panel.appendChild(summary);

  const grid = document.createElement('div');
  grid.className = 'tool-evidence-grid';

  for (const run of runs) {
    grid.appendChild(createToolEvidenceRunCard(run, message.content || ''));
  }

  const cacheCard = createCacheEvidenceCard(message);
  if (cacheCard) grid.appendChild(cacheCard);

  if (grid.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tool-evidence-empty';
    empty.textContent = '暂无可展示的工具证据。';
    grid.appendChild(empty);
  }

  panel.appendChild(grid);

  const actions = document.createElement('div');
  actions.className = 'tool-evidence-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'tool-copy-btn';
  copy.textContent = '复制本轮证据 JSON';
  copy.addEventListener('click', async () => {
    await copyToClipboard(JSON.stringify(buildMessageEvidencePayload(message), null, 2));
    showToast('本轮工具证据已复制');
  });
  actions.appendChild(copy);
  panel.appendChild(actions);

  container.appendChild(panel);
}

function buildToolEvidenceMeta(
  runs: any[] = [],
  grounding: Record<string, any> = {},
  localGrounding: Record<string, any> = {},
  message: Record<string, any> = {}
) {
  const parts = [];
  if (runs.length) parts.push(`${runs.length} 个工具`);
  if (grounding.sources?.length) parts.push(`${grounding.sources.length} 个来源`);
  if (localGrounding.citations?.length) parts.push(`${localGrounding.citations.length} 个文件引用`);
  const usage = message.tokens ? normalizeTokenUsage(message.tokens) : null;
  if ((usage?.cacheHit || 0) > 0 || (usage?.cacheMiss || 0) > 0) {
    parts.push(`cache ${Math.round((usage?.cacheHitRate || 0) * 100)}%`);
  } else if (message.cacheProfile?.cacheHitRate !== undefined) {
    parts.push(`cache ${Math.round(Number(message.cacheProfile.cacheHitRate || 0) * 100)}%`);
  }
  return parts.length ? parts.join(' · ') : '无工具调用';
}

export function createToolEvidenceRunCard(run: Record<string, any> = {}, answerContent = '') {
  const card = document.createElement('article');
  card.className = `tool-evidence-run status-${run.status || 'unknown'}`;

  const header = document.createElement('div');
  header.className = 'tool-evidence-run-header';
  const name = document.createElement('strong');
  name.textContent = run.name || 'unknown_tool';
  const status = document.createElement('span');
  status.className = 'tool-evidence-status';
  status.textContent = getToolStatusMeta(run.status).label;
  header.append(name, status);
  card.appendChild(header);

  const meta = document.createElement('div');
  meta.className = 'tool-evidence-run-meta';
  meta.textContent = [
    run.durationMs !== null && run.durationMs !== undefined ? `耗时 ${run.durationMs}ms` : '',
    run.query ? `query: ${run.query}` : '',
    run.args?.path ? `path: ${run.args.path}` : '',
    run.args?.symbol ? `symbol: ${run.args.symbol}` : '',
    run.args?.language ? `language: ${run.args.language}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta.textContent) card.appendChild(meta);

  const citationStatus = buildToolCitationStatus(run, answerContent);
  if (citationStatus) appendToolCitationStatus(card, citationStatus);

  appendEvidenceChips(
    card,
    '来源',
    (run.sources || []).slice(0, 3).map((source: Record<string, any>) => source.title || source.url)
  );
  appendEvidenceChips(
    card,
    '文件',
    (run.localCitations || []).slice(0, 6).map((citation: Record<string, any>) => citation.label)
  );
  if (Array.isArray(run.workspaceResults) && run.workspaceResults.length) {
    appendEvidenceChips(
      card,
      '搜索命中',
      run.workspaceResults.slice(0, 4).map((item) => `${item.file}:${item.startLine}-${item.endLine}`)
    );
  }
  if (run.workspaceSymbol?.result) {
    appendEvidenceChips(card, '符号', [
      `${run.workspaceSymbol.symbol} ${run.workspaceSymbol.result.file}:${run.workspaceSymbol.result.startLine}-${run.workspaceSymbol.result.endLine}`,
    ]);
  }
  if (run.runResult) {
    appendEvidenceChips(card, '实验', [
      `${run.runResult.language || run.args?.language || 'unknown'} · exit ${run.runResult.exitCode ?? 'unknown'} · ${run.runResult.durationMs}ms`,
      run.runResult.failureHint,
    ]);
  }
  if (run.contextCompacted) {
    appendEvidenceChips(card, '上下文', [`已压缩 ${run.rawOutputTokens || 0}→${run.contextOutputTokens || 0} tokens`]);
  }
  if (run.parseError) appendEvidenceChips(card, '参数错误', [run.parseError]);
  if (run.outputPreview) appendEvidencePreview(card, run.outputPreview);
  return card;
}

function appendEvidenceChips(card: HTMLElement, labelText: string, values: any[] = []) {
  const filtered = values.map((value) => String(value || '').trim()).filter(Boolean);
  if (!filtered.length) return;
  const group = document.createElement('div');
  group.className = 'tool-evidence-chip-group';
  const label = document.createElement('span');
  label.className = 'tool-evidence-chip-label';
  label.textContent = labelText;
  group.appendChild(label);
  for (const value of filtered) {
    const chip = document.createElement('span');
    chip.className = 'tool-evidence-chip';
    chip.textContent = value;
    chip.title = value;
    group.appendChild(chip);
  }
  card.appendChild(group);
}

function appendEvidencePreview(card: HTMLElement, text: string) {
  const preview = document.createElement('p');
  preview.className = 'tool-evidence-preview';
  preview.textContent = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  card.appendChild(preview);
}

function appendToolCitationStatus(card: HTMLElement, status: Record<string, any>) {
  const box = document.createElement('div');
  box.className = `tool-evidence-citation-status ${status.state}`;
  box.textContent = `${status.label} · ${status.cited}/${status.total} 条证据`;
  box.title = '根据最终回答文本中是否出现 URL、文件名或 file:line 判断。';
  card.appendChild(box);
  appendEvidenceRefBreakdown(card, status.refs);
}

function appendEvidenceRefBreakdown(card: HTMLElement, refs: any[] = []) {
  const visible = (Array.isArray(refs) ? refs : []).slice(0, 6);
  if (!visible.length) return;
  const group = document.createElement('div');
  group.className = 'tool-evidence-ref-list';
  const label = document.createElement('span');
  label.className = 'tool-evidence-chip-label';
  label.textContent = '引用明细';
  group.appendChild(label);
  for (const ref of visible) {
    const item = document.createElement('span');
    item.className = `tool-evidence-ref ${ref.cited ? 'is-cited' : 'is-missing'}`;
    item.textContent = `${ref.cited ? '已引用' : '未引用'}: ${ref.label || ref.value || ref.file || ref.type}`;
    item.title = ref.value || ref.file || ref.label || '';
    group.appendChild(item);
  }
  card.appendChild(group);
}

export function createCacheEvidenceCard(message: Record<string, any> = {}) {
  const usage = message.tokens ? normalizeTokenUsage(message.tokens) : null;
  const profile = message.cacheProfile || {};
  if (!usage && !profile.prefixFingerprint) return null;

  const card = document.createElement('article');
  card.className = 'tool-evidence-run cache-evidence';
  const header = document.createElement('div');
  header.className = 'tool-evidence-run-header';
  const name = document.createElement('strong');
  name.textContent = 'Token / Cache';
  const status = document.createElement('span');
  status.className = 'tool-evidence-status';
  status.textContent = usage?.source || 'profile';
  header.append(name, status);
  card.appendChild(header);

  appendEvidenceChips(card, '用量', [
    usage ? `输入 ${usage.input}` : '',
    usage ? `输出 ${usage.output}` : '',
    usage?.reasoning ? `思考 ${usage.reasoning}` : '',
  ]);
  appendEvidenceChips(card, '缓存', [
    usage ? `hit ${usage.cacheHit}` : profile.cacheHit ? `hit ${profile.cacheHit}` : '',
    usage ? `miss ${usage.cacheMiss}` : profile.cacheMiss ? `miss ${profile.cacheMiss}` : '',
    usage ? `rate ${Math.round((usage.cacheHitRate || 0) * 100)}%` : '',
    profile.prefixFingerprint ? `prefix ${profile.prefixFingerprint}` : '',
  ]);
  if (Number(usage?.cost?.estimatedSavingsUsd || 0) > 0 || Number(profile.estimatedSavingsUsd || 0) > 0) {
    appendEvidenceChips(card, '成本', [
      `节省约 $${Number(usage?.cost?.estimatedSavingsUsd || profile.estimatedSavingsUsd || 0).toFixed(6)}`,
    ]);
  }
  return card;
}

export function buildMessageEvidencePayload(message: Record<string, any> = {}) {
  const content = message.content || '';
  return {
    type: 'deepchat.messageEvidence',
    version: 1,
    toolRuns: (message.toolRuns || []).map((run: Record<string, any>) => ({
      ...buildToolEvidencePayload(run),
      citationStatus: buildToolCitationStatus(run, content),
    })),
    tokens: message.tokens ? normalizeTokenUsage(message.tokens) : null,
    cacheProfile: message.cacheProfile || null,
    contextBudget: message.contextBudget || null,
  };
}

function buildToolCitationStatus(run: Record<string, any> = {}, answerContent = '') {
  const refs = collectToolEvidenceRefs(run);
  if (!refs.length) return null;
  const content = String(answerContent || '');
  const checkedRefs = refs.map((ref) => ({
    ...ref,
    cited: isEvidenceRefMentioned(content, ref),
  }));
  const cited = checkedRefs.filter((ref) => ref.cited).length;
  const state = cited === checkedRefs.length ? 'is-cited' : cited > 0 ? 'is-partial' : 'is-missing';
  return {
    state,
    label: state === 'is-cited' ? '已被回答引用' : state === 'is-partial' ? '部分证据已引用' : '未被回答引用',
    cited,
    total: checkedRefs.length,
    refs: checkedRefs.slice(0, 8),
  };
}

function collectToolEvidenceRefs(run: Record<string, any> = {}) {
  const refs = [];
  for (const source of Array.isArray(run.sources) ? run.sources : []) {
    const url = String(source?.url || '').trim();
    if (url) refs.push({ type: 'url', label: source.title || url, value: url });
  }
  for (const citation of Array.isArray(run.localCitations) ? run.localCitations : []) {
    const file = String(citation?.file || '').trim();
    const label = String(citation?.label || '').trim();
    if (file || label)
      refs.push({
        type: 'file',
        label: label || file,
        value: label || file,
        file,
        lineStart: Number(citation?.lineStart || 0),
        lineEnd: Number(citation?.lineEnd || citation?.lineStart || 0),
      });
  }
  if (run.workspaceSymbol?.result) {
    const result = run.workspaceSymbol.result;
    const file = String(result.file || '').trim();
    if (file) {
      const range = result.startLine
        ? `${result.startLine}${result.endLine && result.endLine !== result.startLine ? `-${result.endLine}` : ''}`
        : '';
      refs.push({
        type: 'file',
        label: `${run.workspaceSymbol.symbol || 'symbol'} ${file}${range ? `:${range}` : ''}`,
        value: `${file}${range ? `:${range}` : ''}`,
        file,
        lineStart: Number(result.startLine || 0),
        lineEnd: Number(result.endLine || result.startLine || 0),
      });
    }
  }
  return dedupeEvidenceRefs(refs);
}

function dedupeEvidenceRefs(refs: any[] = []) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.value || ref.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isEvidenceRefMentioned(content = '', ref: Record<string, any> = {}) {
  const text = String(content || '');
  if (!text) return false;
  if (ref.type === 'url') return Boolean(ref.value && text.includes(ref.value));
  const file = String(ref.file || ref.value || '').trim();
  const label = String(ref.value || ref.label || '').trim();
  if (label && text.includes(label)) return true;
  if (file && text.includes(file)) return true;
  if (file && ref.lineStart > 0) {
    const escapedFile = escapeRegExp(file);
    const start = Number(ref.lineStart || 0);
    const end = Number(ref.lineEnd || start);
    const rangePattern = end && end !== start ? `${start}\\s*-\\s*${end}` : String(start);
    return new RegExp(`${escapedFile}\\s*[:：]\\s*${rangePattern}`).test(text);
  }
  return false;
}

function appendGroundingCard(
  container: HTMLElement,
  { warning, title: titleText, meta: metaText, items = [], warningText }: Record<string, any>
) {
  const card = document.createElement('div');
  card.className = `source-grounding-card${warning ? ' is-warning' : ' is-grounded'}`;
  const title = document.createElement('div');
  title.className = 'source-grounding-title';
  title.textContent = titleText;
  const meta = document.createElement('div');
  meta.className = 'source-grounding-meta';
  meta.textContent = metaText;
  card.append(title, meta);
  if (items.length) {
    const list = document.createElement('div');
    list.className = 'source-grounding-list';
    for (const item of items) {
      if (item.href) {
        const link = document.createElement('a');
        link.href = item.href;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = item.label;
        list.appendChild(link);
      } else {
        const span = document.createElement('span');
        span.textContent = item.label;
        list.appendChild(span);
      }
    }
    card.appendChild(list);
  }
  container.appendChild(card);
  if (warning) {
    const warning = document.createElement('div');
    warning.className = 'source-grounding-warning';
    warning.textContent = warningText;
    container.appendChild(warning);
  }
}
export function renderErrorContent(container: HTMLElement, message: string, onClose?: any, onRetry?: any) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'message-error';
  const text = document.createElement('span');
  text.textContent = `生成失败：${message}`;
  wrap.appendChild(text);
  const btnGroup = document.createElement('div');
  btnGroup.className = 'error-btn-group';
  if (onRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'retry-btn retry-action';
    retryBtn.textContent = '重试';
    retryBtn.addEventListener('click', onRetry);
    btnGroup.appendChild(retryBtn);
  }
  if (onClose) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'retry-btn close-action';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', onClose);
    btnGroup.appendChild(closeBtn);
  }
  wrap.appendChild(btnGroup);
  container.appendChild(wrap);
}
