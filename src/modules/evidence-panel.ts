/**
 * Evidence Panel — Displays tool evidence for each assistant message
 * (Product-oriented: shows summaries instead of raw JSON by default)
 */

import {
  summarizeProjectMap,
  summarizeGitDiff,
  summarizeGitStatus,
  summarizeGitLog,
  summarizeReadManyFiles,
} from './tool-runs.js';

const STATUS_META: Record<string, { label: string; tone: string }> = {
  pending: { label: '等待确认', tone: 'pending' },
  approved: { label: '已确认', tone: 'running' },
  running: { label: '运行中', tone: 'running' },
  denied: { label: '已拒绝', tone: 'blocked' },
  completed: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
};

export function renderEvidencePanel(
  container: HTMLElement | null,
  toolCalls: Array<Record<string, unknown>> = []
): void {
  if (!container) return;

  if (!toolCalls || toolCalls.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;

  // Reuse wrapper
  let wrapper = container.querySelector('.evidence-wrapper') as HTMLElement | null;
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.className = 'evidence-wrapper';
    container.appendChild(wrapper);
  }

  const completedTools = toolCalls.filter((t) => t.status === 'completed');
  const failedTools = toolCalls.filter((t) => t.status === 'failed');
  const deniedTools = toolCalls.filter((t) => t.status === 'denied');
  const pendingTools = toolCalls.filter((t) => t.status === 'pending' || t.status === 'approved');
  const totalTokens = toolCalls.reduce((sum, t) => sum + ((t.contextOutputTokens as number) || 0), 0);
  const totalSources = toolCalls.reduce((sum, t) => sum + ((t.sources as any[])?.length || 0), 0);

  // Summary line
  let summary = wrapper.querySelector('.evidence-summary') as HTMLElement | null;
  if (!summary) {
    summary = document.createElement('button');
    summary.className = 'evidence-summary';
    (summary as HTMLButtonElement).type = 'button';
    summary.addEventListener('click', () => {
      wrapper!.classList.toggle('is-expanded');
    });
    wrapper.appendChild(summary);
  }

  const parts: string[] = [];
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
  let list = wrapper.querySelector('.evidence-list') as HTMLElement | null;
  if (!list) {
    list = document.createElement('div');
    list.className = 'evidence-list';
    wrapper.appendChild(list);
  }

  const fingerprint = toolCalls.map((t) => `${t.id}|${t.status}|${(t.output as string)?.length || 0}`).join(';');
  if ((list as any).__evidenceFingerprint === fingerprint) return;
  (list as any).__evidenceFingerprint = fingerprint;

  while (list.firstChild) list.removeChild(list.firstChild);
  for (const tool of toolCalls) {
    const meta = STATUS_META[String(tool.status || '')] || STATUS_META.pending;
    const duration =
      tool.completedAt && tool.requestedAt
        ? Math.round(
            (new Date(tool.completedAt as string).getTime() - new Date(tool.requestedAt as string).getTime()) / 1000
          )
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

    // Result summary (product-oriented)
    const summaryLine = document.createElement('div');
    summaryLine.className = 'evidence-item-summary';
    summaryLine.textContent = buildEvidenceSummary(tool);
    body.appendChild(summaryLine);

    if (tool.output) {
      const outToggle = document.createElement('button');
      outToggle.className = 'evidence-item-toggle';
      outToggle.type = 'button';
      outToggle.textContent = '查看原始输出';
      const outBlock = document.createElement('pre');
      outBlock.className = 'evidence-item-output';
      outBlock.hidden = true;
      outBlock.textContent = String(tool.output).slice(0, 2000);
      outToggle.addEventListener('click', () => {
        outBlock.hidden = !outBlock.hidden;
        outToggle.textContent = outBlock.hidden ? '查看原始输出' : '收起原始输出';
      });
      body.appendChild(outToggle);
      body.appendChild(outBlock);
    }

    if (tool.sources && (tool.sources as any[]).length > 0) {
      const srcBlock = document.createElement('div');
      srcBlock.className = 'evidence-item-sources';
      const srcTitle = document.createElement('div');
      srcTitle.className = 'evidence-item-sources-title';
      srcTitle.textContent = `来源 (${(tool.sources as any[]).length})`;
      srcBlock.appendChild(srcTitle);
      for (const src of (tool.sources as any[]).slice(0, 5)) {
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

function getToolDisplayName(tool: Record<string, unknown>): string {
  const name = String(tool.name || '');
  const map: Record<string, string> = {
    web_search: '联网搜索',
    read_file: '读取文件',
    read_many_files: '批量读取',
    search_workspace: '工作区搜索',
    read_symbol: '读取符号',
    run_code: '运行代码',
    list_directory: '列目录',
    list_files: '列目录',
    index_workspace: '索引工作区',
    project_map: '项目结构',
    git_status: 'Git 状态',
    git_diff: 'Git 差异',
    git_log: 'Git 日志',
  };
  return map[name] || name;
}

function formatArgs(args: unknown): string {
  try {
    const text = JSON.stringify(args || {});
    return text.length > 120 ? text.slice(0, 120) + '...' : text;
  } catch {
    return String(args);
  }
}

function buildEvidenceSummary(tool: Record<string, unknown>): string {
  const name = String(tool.name || '');
  const output = String(tool.output || '');
  const ok = tool.ok === true;

  if (!ok && tool.status === 'denied') return '❌ 用户已拒绝执行';
  if (!ok) return '⚠️ 执行失败或未完成';
  if (!output) return '✅ 执行成功，无输出';

  if (name === 'project_map') {
    const s = summarizeProjectMap(output);
    const parts: string[] = [];
    if (s.fileCount) parts.push(`${s.fileCount} 个文件`);
    if (s.dirCount) parts.push(`${s.dirCount} 个目录`);
    if (s.entryFiles.length) parts.push(`入口：${s.entryFiles.slice(0, 2).join(', ')}`);
    return parts.length ? `✅ ${parts.join(' · ')}` : '✅ 项目结构已生成';
  }

  if (name === 'git_diff') {
    const s = summarizeGitDiff(output);
    const parts: string[] = [];
    if (s.changedFiles) parts.push(`${s.changedFiles} 个文件变更`);
    if (s.insertions) parts.push(`+${s.insertions}`);
    if (s.deletions) parts.push(`-${s.deletions}`);
    if (s.riskyFiles.length) parts.push(`⚠️ 风险文件`);
    return parts.length ? `✅ ${parts.join(' · ')}` : '✅ 无变更';
  }

  if (name === 'git_status') {
    const s = summarizeGitStatus(output);
    const parts: string[] = [`分支：${s.branch}`];
    if (s.staged) parts.push(`${s.staged} 个暂存`);
    if (s.unstaged) parts.push(`${s.unstaged} 个未暂存`);
    if (s.untracked) parts.push(`${s.untracked} 个未跟踪`);
    return parts.join(' · ');
  }

  if (name === 'git_log') {
    const s = summarizeGitLog(output, Number((tool.args as any)?.count) || 10);
    const parts: string[] = [];
    if (s.commitCount) parts.push(`${s.commitCount} 条提交`);
    if (s.latestMessage) parts.push(`最新：${s.latestMessage.slice(0, 30)}${s.latestMessage.length > 30 ? '…' : ''}`);
    return parts.length ? `✅ ${parts.join(' · ')}` : '✅ 提交历史已获取';
  }

  if (name === 'read_many_files') {
    const s = summarizeReadManyFiles(tool);
    return `✅ ${s.successfulFiles}/${s.totalFiles} 个文件成功读取${s.failedFiles ? `（${s.failedFiles} 个失败）` : ''}`;
  }

  if (name === 'web_search') {
    const sources = (tool.sources as any[]) || [];
    return sources.length ? `✅ 找到 ${sources.length} 个来源` : '✅ 搜索完成';
  }

  if (name === 'run_code') {
    const exitMatch = output.match(/退出码[：:]\s*(\d+)/);
    const exitCode = exitMatch ? exitMatch[1] : null;
    if (exitCode === '0' || exitCode === null) return '✅ 代码运行成功';
    return `⚠️ 运行结束（退出码 ${exitCode}）`;
  }

  if (name === 'read_file') {
    const path = String((tool.args as any)?.path || (tool.args as any)?.file || '');
    return path ? `✅ 已读取 ${path.split(/[/\\]/).pop() || path}` : '✅ 文件读取完成';
  }

  if (name === 'search_workspace') {
    const query = String((tool.args as any)?.query || '');
    return query ? `✅ 检索「${query.slice(0, 30)}${query.length > 30 ? '…' : ''}」完成` : '✅ 工作区检索完成';
  }

  return `✅ ${output.slice(0, 80)}${output.length > 80 ? '…' : ''}`;
}
