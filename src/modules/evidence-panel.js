/**
 * Evidence Panel — Displays tool evidence for each assistant message
 */

const STATUS_META = {
  pending: { label: '等待确认', tone: 'pending' },
  approved: { label: '已确认', tone: 'running' },
  running: { label: '运行中', tone: 'running' },
  denied: { label: '已拒绝', tone: 'blocked' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
};

export function renderEvidencePanel(container, toolCalls = []) {
  if (!container) return;

  if (!toolCalls || toolCalls.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;

  // Reuse wrapper
  let wrapper = container.querySelector('.evidence-wrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'evidence-wrapper';
    container.appendChild(wrapper);
  }

  const completedTools = toolCalls.filter((t) => t.status === 'completed');
  const failedTools = toolCalls.filter((t) => t.status === 'failed');
  const deniedTools = toolCalls.filter((t) => t.status === 'denied');
  const pendingTools = toolCalls.filter((t) => t.status === 'pending' || t.status === 'approved');
  const totalTokens = toolCalls.reduce((sum, t) => sum + (t.contextOutputTokens || 0), 0);
  const totalSources = toolCalls.reduce((sum, t) => sum + (t.sources?.length || 0), 0);

  // Summary line
  let summary = wrapper.querySelector('.evidence-summary');
  if (!summary) {
    summary = document.createElement('button');
    summary.className = 'evidence-summary';
    summary.type = 'button';
    summary.addEventListener('click', () => {
      wrapper.classList.toggle('is-expanded');
    });
    wrapper.appendChild(summary);
  }

  const parts = [];
  if (pendingTools.length > 0) parts.push(`${pendingTools.length} 个等待`);
  if (completedTools.length > 0) parts.push(`${completedTools.length} 个完成`);
  if (failedTools.length > 0) parts.push(`${failedTools.length} 个失败`);
  if (deniedTools.length > 0) parts.push(`${deniedTools.length} 个拒绝`);
  if (totalSources > 0) parts.push(`${totalSources} 个来源`);
  if (totalTokens > 0) parts.push(`${totalTokens} token`);

  summary.textContent = '';
  const arrow = document.createElement('span');
  arrow.className = 'evidence-summary-icon';
  arrow.textContent = '\u25B8';
  summary.append(arrow, ` 证据链 · ${parts.join(' · ') || `${toolCalls.length} 个工具`}`);

  // Detail list
  let list = wrapper.querySelector('.evidence-list');
  if (!list) {
    list = document.createElement('div');
    list.className = 'evidence-list';
    wrapper.appendChild(list);
  }

  const fingerprint = toolCalls.map((t) => `${t.id}|${t.status}|${t.output?.length || 0}`).join(';');
  if (list.__evidenceFingerprint === fingerprint) return;
  list.__evidenceFingerprint = fingerprint;

  while (list.firstChild) list.removeChild(list.firstChild);
  for (const tool of toolCalls) {
    const meta = STATUS_META[tool.status] || STATUS_META.pending;
    const duration =
      tool.completedAt && tool.requestedAt
        ? Math.round((new Date(tool.completedAt) - new Date(tool.requestedAt)) / 1000)
        : null;

    const item = document.createElement('div');
    item.className = `evidence-item tone-${meta.tone}`;

    const header = document.createElement('div');
    header.className = 'evidence-item-header';
    const nameEl = document.createElement('strong');
    nameEl.textContent = getToolDisplayName(tool);
    const statusEl = document.createElement('span');
    statusEl.className = `evidence-item-status tone-${meta.tone}`;
    statusEl.textContent = meta.label;
    header.appendChild(nameEl);
    header.appendChild(statusEl);

    const body = document.createElement('div');
    body.className = 'evidence-item-body';

    const argsLine = document.createElement('div');
    argsLine.className = 'evidence-item-args';
    argsLine.textContent = `参数：${formatArgs(tool.args)}`;
    body.appendChild(argsLine);

    if (duration !== null) {
      const timeLine = document.createElement('div');
      timeLine.className = 'evidence-item-meta';
      timeLine.textContent = `耗时：${duration}s`;
      body.appendChild(timeLine);
    }

    if (tool.contextOutputTokens) {
      const ctxLine = document.createElement('div');
      ctxLine.className = 'evidence-item-meta';
      ctxLine.textContent = `进入上下文：${tool.contextOutputTokens} token${tool.contextCompacted ? '（已压缩）' : ''}`;
      body.appendChild(ctxLine);
    }

    if (tool.output) {
      const outToggle = document.createElement('button');
      outToggle.className = 'evidence-item-toggle';
      outToggle.type = 'button';
      outToggle.textContent = '查看输出';
      const outBlock = document.createElement('pre');
      outBlock.className = 'evidence-item-output';
      outBlock.hidden = true;
      outBlock.textContent = String(tool.output).slice(0, 2000);
      outToggle.addEventListener('click', () => {
        outBlock.hidden = !outBlock.hidden;
        outToggle.textContent = outBlock.hidden ? '查看输出' : '收起输出';
      });
      body.appendChild(outToggle);
      body.appendChild(outBlock);
    }

    if (tool.sources && tool.sources.length > 0) {
      const srcBlock = document.createElement('div');
      srcBlock.className = 'evidence-item-sources';
      const srcTitle = document.createElement('div');
      srcTitle.className = 'evidence-item-sources-title';
      srcTitle.textContent = `来源 (${tool.sources.length})`;
      srcBlock.appendChild(srcTitle);
      for (const src of tool.sources.slice(0, 5)) {
        const srcEl = document.createElement('a');
        srcEl.className = 'evidence-item-source';
        srcEl.href = src.url || '#';
        srcEl.target = '_blank';
        srcEl.rel = 'noopener noreferrer';
        srcEl.textContent = src.title || src.url || '来源';
        srcBlock.appendChild(srcEl);
      }
      body.appendChild(srcBlock);
    }

    item.appendChild(header);
    item.appendChild(body);
    list.appendChild(item);
  }
}

function getToolDisplayName(tool) {
  const name = tool.name || '';
  const map = {
    web_search: '联网搜索',
    read_file: '读取文件',
    search_workspace: '工作区搜索',
    read_symbol: '读取符号',
    run_code: '运行代码',
    list_directory: '列目录',
  };
  return map[name] || name;
}

function formatArgs(args) {
  try {
    const text = JSON.stringify(args || {});
    return text.length > 120 ? text.slice(0, 120) + '...' : text;
  } catch {
    return String(args);
  }
}
