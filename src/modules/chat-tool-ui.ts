/**
 * Chat Tool UI — Tool call rendering and prompt builders
 *
 * Extracted from chat.ts. Contains:
 * - Pure data-transformation functions (risk assessment, repair prompts, run-code builders)
 * - DOM rendering functions (renderToolCalls, experiment cards)
 */

import {
  buildToolEvidencePayload,
  extractLocalCitations,
  extractRunCodeResult,
  extractToolSources,
  extractWorkspaceSymbolResult,
  formatToolArgs,
  getToolDurationMs,
  getToolName,
  getToolQuery,
  getToolStatusMeta,
} from './tool-runs.js';
import { copyToClipboard, downloadTextFile, fillComposerPrompt, showToast, truncate } from './utils.js';

// ─── Risk Classification ─────────────────────────────────────────────────────

const LOW_RISK_TOOLS = new Set([
  'web_search',
  'read_file',
  'list_files',
  'search_workspace',
  'read_symbol',
  'index_workspace',
]);

const HIGH_RISK_TOOLS = new Set(['run_code']);

export function getToolRiskMeta(tool: Record<string, unknown> = {}) {
  const security = tool.security as Record<string, unknown> | undefined;
  const rawRisk = String(security?.riskLevel || '')
    .trim()
    .toLowerCase();
  const toolName = String(getToolName(tool) || '')
    .trim()
    .toLowerCase();
  const normalizedRisk = rawRisk.replace('低', 'low').replace('中', 'medium').replace('高', 'high');

  if (tool.autoApproved && (normalizedRisk === 'low' || LOW_RISK_TOOLS.has(toolName))) {
    return {
      tone: 'low',
      label: '只读自动通过',
      title: '该工具按只读策略自动通过，仍会记录完整证据。',
    };
  }
  if (normalizedRisk === 'low' || LOW_RISK_TOOLS.has(toolName)) {
    return {
      tone: 'low',
      label: '低风险',
      title: '只读或检索类工具，执行结果会进入工具证据。',
    };
  }
  if (normalizedRisk === 'high' || HIGH_RISK_TOOLS.has(toolName) || toolName.startsWith('mcp__')) {
    return {
      tone: 'high',
      label: toolName.startsWith('mcp__') ? '外部工具确认' : '高风险确认',
      title: '涉及代码执行、外部 MCP 或更高权限操作，执行前需要确认。',
    };
  }
  if (normalizedRisk === 'medium') {
    return {
      tone: 'medium',
      label: '中风险确认',
      title: '该工具会读取或处理更多上下文，执行前需要确认。',
    };
  }
  return {
    tone: 'medium',
    label: '需确认',
    title: '未知或未分类工具，执行前需要确认。',
  };
}

// ─── Tool Repair ─────────────────────────────────────────────────────────────

export function shouldOfferToolRepair(tool: Record<string, unknown> = {}) {
  return Boolean(tool.parseError || tool.status === 'failed' || tool.status === 'denied' || tool.ok === false);
}

export function buildToolRepairPrompt(tool: Record<string, unknown> = {}) {
  const name = getToolName(tool);
  const status = tool.status || (tool.ok === false ? 'failed' : 'unknown');
  const args = truncate(formatToolArgs(tool), 1600);
  const output = truncate(String(tool.output || tool.error || tool.outputPreview || ''), 1600);
  const next = String(tool.nextAction || '').trim();
  return [
    '请基于下面这次工具调用失败信息，先判断失败原因，再给出最小修复方案。',
    '不要直接重新调用高风险工具；如果需要重试，请先说明将使用的工具、参数变化和风险边界，等待我确认。',
    '',
    '<failed_tool>',
    `工具：${name}`,
    `状态：${status}`,
    tool.parseError ? `参数解析错误：${tool.parseError}` : '',
    next ? `已有下一步建议：${next}` : '',
    '参数：',
    args,
    output ? ['输出/错误：', output].join('\n') : '',
    '</failed_tool>',
  ]
    .filter(Boolean)
    .join('\n');
}

export function compactToolOutputSummaryText(outputText: string) {
  const lines = String(outputText || '')
    .replace(/```[\s\S]*?```/g, '[代码片段]')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  const joined = lines.slice(0, 6).join(' · ');
  return joined.length > 420 ? `${joined.slice(0, 420).trim()}...` : joined;
}

// ─── Run Code Prompt Builders ────────────────────────────────────────────────

export function getRunCodeSourceCode(tool: Record<string, unknown> = {}) {
  const args = tool.args as Record<string, unknown> | undefined;
  const code = args?.code ?? args?.source ?? '';
  return String(code || '').trim();
}

export function formatCodeFenceLanguage(language: string) {
  return (
    String(language || 'text')
      .replace(/[^\w#+.-]/g, '')
      .slice(0, 32) || 'text'
  );
}

export function getBoundedRunCodeForPrompt(tool: Record<string, unknown> = {}) {
  const code = getRunCodeSourceCode(tool);
  return truncate(code, 6000);
}

export function buildRunCodeRerunPrompt(tool: Record<string, unknown> = {}, result: Record<string, unknown> = {}) {
  const language = String((result.language as string) || (tool.args as Record<string, unknown>)?.language || 'text');
  const code = getBoundedRunCodeForPrompt(tool);
  const lines = [
    '请重新运行下面这段代码，并解释运行结果。运行前仍需我确认 run_code 工具调用。',
    '',
    `语言：${language}`,
  ];
  if (code) {
    lines.push('', `\`\`\`${formatCodeFenceLanguage(language)}`, code, '```');
  } else {
    lines.push('', '原始工具记录里没有可复用的代码，请先说明无法直接重新运行的原因，并让我补充代码。');
  }
  return lines.join('\n').trim();
}

export function buildRunCodeExplainPrompt(tool: Record<string, unknown> = {}, result: Record<string, unknown> = {}) {
  const language = String((result.language as string) || (tool.args as Record<string, unknown>)?.language || 'text');
  const code = getBoundedRunCodeForPrompt(tool);
  const lines = [
    '请解释这次 run_code 代码实验为什么失败，指出最可能的根因，并给出可确认后重试的修复版本。',
    '',
    `语言：${language}`,
    `退出码：${result.exitCode ?? 'unknown'}`,
    `耗时：${result.durationMs ?? 'unknown'}ms`,
  ];
  if (result.failureHint) lines.push(`失败提示：${result.failureHint}`);
  if (result.stderrPreview) lines.push('', 'STDERR：', truncate(result.stderrPreview, 2000));
  if (result.stdoutPreview) lines.push('', 'STDOUT：', truncate(result.stdoutPreview, 1200));
  if (code) lines.push('', '原始代码：', `\`\`\`${formatCodeFenceLanguage(language)}`, code, '```');
  lines.push('', '不要自动执行工具；如果需要重试，请先给出将要运行的代码和理由，等待我确认。');
  return lines.join('\n').trim();
}

export function buildRunCodeArtifactMarkdown(tool: Record<string, unknown> = {}, result: Record<string, unknown> = {}) {
  const language = String((result.language as string) || (tool.args as Record<string, unknown>)?.language || 'text');
  const code = getRunCodeSourceCode(tool);
  const status = result.ok ? '成功' : result.timedOut ? '超时' : '失败';
  const lines = [
    '# DeepChat 代码实验',
    '',
    '## 运行摘要',
    '',
    `- 状态：${status}`,
    `- 语言：${language}`,
    `- 退出码：${result.exitCode ?? 'unknown'}`,
    `- 耗时：${result.durationMs ?? 'unknown'}ms`,
    `- 代码长度：${result.codeLength ?? code.length} chars`,
    `- stdin：${result.stdinBytes || 0} bytes`,
  ];
  if (result.failureHint) lines.push(`- 失败提示：${result.failureHint}`);
  if (tool.id) lines.push(`- Tool ID：${tool.id}`);
  lines.push(
    '',
    '## 代码',
    '',
    `\`\`\`${formatCodeFenceLanguage(language)}`,
    code || '// 原始工具记录没有保存代码',
    '```'
  );
  if (result.stdoutPreview) {
    lines.push('', `## STDOUT (${result.stdoutBytes ?? 0} bytes)`, '', '```text', String(result.stdoutPreview), '```');
  }
  if (result.stderrPreview) {
    lines.push('', `## STDERR (${result.stderrBytes ?? 0} bytes)`, '', '```text', String(result.stderrPreview), '```');
  }
  lines.push('', '## 原始工具输出', '', '```text', truncate(String(tool.output || ''), 12000), '```');
  return lines.join('\n').trimEnd() + '\n';
}
export function renderToolCalls(container: HTMLElement, toolCalls: any[] = [], options: Record<string, any> = {}) {
  if (!container) return;
  container.innerHTML = '';
  if (!toolCalls || toolCalls.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  for (const tool of toolCalls) {
    const block = document.createElement('div');
    block.className = `tool-call-block status-${tool.status || 'pending'}`;

    const header = document.createElement('div');
    header.className = 'tool-call-header';
    const statusMeta = getToolStatusMeta(tool.status);
    block.dataset.statusTone = statusMeta.tone;
    const title = document.createElement('strong');
    title.textContent = getToolName(tool);
    const status = document.createElement('span');
    status.className = 'tool-call-status';
    status.textContent = `${statusMeta.icon} ${statusMeta.label}`;
    const riskBadge = createToolRiskBadge(tool);
    header.append('工具调用：', title, status, riskBadge);

    const risk = document.createElement('p');
    risk.className = 'tool-call-risk';
    risk.textContent = tool.risk || '将执行一个工具调用。';

    const args = document.createElement('pre');
    args.className = 'tool-call-args';
    const code = document.createElement('code');
    code.textContent = formatToolArgs(tool);
    args.appendChild(code);

    block.append(header, risk, args);

    const meta = createToolMeta(tool);
    if (meta) block.appendChild(meta);
    const security = createToolSecurityMeta(tool);
    if (security) block.appendChild(security);
    const nextAction = createToolNextAction(tool);
    if (nextAction) block.appendChild(nextAction);
    const repairAction = createToolRepairAction(tool);
    if (repairAction) block.appendChild(repairAction);
    if (tool.parseError) {
      const parse = document.createElement('div');
      parse.className = 'tool-parse-error';
      parse.textContent = `参数解析失败：${tool.parseError}`;
      block.appendChild(parse);
    }
    const query = getToolQuery(tool);
    if (getToolName(tool) === 'web_search' && query) {
      const queryLine = document.createElement('div');
      queryLine.className = 'tool-call-query';
      queryLine.textContent = `实际搜索 query：${query}`;
      block.appendChild(queryLine);
    }

    if (tool.status === 'pending' && options.onDecision) {
      const actions = document.createElement('div');
      actions.className = 'tool-call-actions';
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'tool-approve-btn';
      approveBtn.textContent = '确认执行';
      approveBtn.addEventListener('click', () => options.onDecision(tool.id, true));
      const denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.className = 'tool-deny-btn';
      denyBtn.textContent = '拒绝';
      denyBtn.addEventListener('click', () => options.onDecision(tool.id, false));
      actions.append(denyBtn, approveBtn);
      block.appendChild(actions);
    }

    if (tool.output) {
      const outputSummary = createToolOutputSummary(tool.output, tool);
      if (outputSummary) block.appendChild(outputSummary);

      const preview = createToolOutputPreview(tool.output, getToolName(tool));
      if (preview) block.appendChild(preview);

      const runCard = createRunCodeExperimentCard(tool);
      if (runCard) block.appendChild(runCard);

      const output = document.createElement('details');
      output.className = 'tool-call-output';
      const summary = document.createElement('summary');
      summary.textContent = tool.ok === false ? '查看失败信息' : '查看工具结果';
      const pre = document.createElement('pre');
      pre.textContent = tool.output;
      output.append(summary, pre);
      block.appendChild(output);
    }
    if (tool.contextOutput && tool.contextOutput !== tool.output) {
      const contextOutput = document.createElement('details');
      contextOutput.className = 'tool-call-output tool-context-output';
      const summary = document.createElement('summary');
      const rawTokens = tool.rawOutputTokens || 0;
      const contextTokens = tool.contextOutputTokens || 0;
      summary.textContent =
        rawTokens && contextTokens
          ? `查看进入上下文的压缩输出 (${rawTokens}→${contextTokens} tokens)`
          : '查看进入上下文的压缩输出';
      const pre = document.createElement('pre');
      pre.textContent = tool.contextOutput;
      contextOutput.append(summary, pre);
      block.appendChild(contextOutput);
    }

    const copyRow = document.createElement('div');
    copyRow.className = 'tool-copy-row';
    const copyEvidence = document.createElement('button');
    copyEvidence.type = 'button';
    copyEvidence.className = 'tool-copy-btn';
    copyEvidence.textContent = '复制证据 JSON';
    copyEvidence.addEventListener('click', async () => {
      await copyToClipboard(JSON.stringify(buildToolEvidencePayload(tool), null, 2));
      showToast('工具证据已复制');
    });
    copyRow.appendChild(copyEvidence);
    if (tool.output) {
      const copyOutput = document.createElement('button');
      copyOutput.type = 'button';
      copyOutput.className = 'tool-copy-btn';
      copyOutput.textContent = '复制原始输出';
      copyOutput.addEventListener('click', async () => {
        await copyToClipboard(tool.output);
        showToast('工具输出已复制');
      });
      copyRow.appendChild(copyOutput);
    }
    if (tool.contextOutput && tool.contextOutput !== tool.output) {
      const copyContext = document.createElement('button');
      copyContext.type = 'button';
      copyContext.className = 'tool-copy-btn';
      copyContext.textContent = '复制上下文输出';
      copyContext.addEventListener('click', async () => {
        await copyToClipboard(tool.contextOutput);
        showToast('上下文输出已复制');
      });
      copyRow.appendChild(copyContext);
    }
    block.appendChild(copyRow);

    container.appendChild(block);
  }
}

function createToolRiskBadge(tool: Record<string, any>) {
  const riskMeta = getToolRiskMeta(tool);
  const badge = document.createElement('span');
  badge.className = `tool-risk-badge tone-${riskMeta.tone}`;
  badge.textContent = riskMeta.label;
  badge.title = riskMeta.title;
  return badge;
}

function createToolMeta(tool: Record<string, any>) {
  const items = [];
  if (tool.requestedAt) items.push(`请求：${formatToolTime(tool.requestedAt)}`);
  if (tool.autoApproved) items.push('审批：自动通过');
  if (tool.expiresAt && tool.status === 'pending') {
    const seconds = Math.max(0, Math.ceil((Date.parse(tool.expiresAt) - Date.now()) / 1000));
    items.push(`确认倒计时：${seconds}s`);
  }
  if (tool.completedAt) items.push(`完成：${formatToolTime(tool.completedAt)}`);
  const duration = getToolDurationMs(tool);
  if (duration !== null) items.push(`耗时：${duration}ms`);
  if (items.length === 0) return null;
  const meta = document.createElement('div');
  meta.className = 'tool-call-meta';
  meta.textContent = items.join(' · ');
  return meta;
}

function createToolSecurityMeta(tool: Record<string, any>) {
  if (!tool.security) return null;
  const items = [];
  if (tool.security.riskLevel) items.push(`风险：${tool.security.riskLevel}`);
  if (tool.security.sandbox) items.push(`沙箱：${tool.security.sandbox}`);
  if (tool.security.envPolicy) items.push(`环境：${tool.security.envPolicy}`);
  if (tool.security.network) items.push(`网络：${tool.security.network}`);
  if (tool.security.redaction) items.push('输出脱敏');
  if (!items.length) return null;
  const meta = document.createElement('div');
  meta.className = 'tool-security-meta';
  meta.textContent = items.join(' · ');
  return meta;
}

function createToolNextAction(tool: Record<string, any>) {
  if (!tool.nextAction) return null;
  const next = document.createElement('div');
  next.className = 'tool-next-action';
  const label = document.createElement('span');
  label.className = 'tool-next-action-label';
  label.textContent = '下一步';
  const text = document.createElement('span');
  text.className = 'tool-next-action-text';
  text.textContent = tool.nextAction;
  next.append(label, text);
  return next;
}

function createToolRepairAction(tool: Record<string, any>) {
  if (!shouldOfferToolRepair(tool)) return null;
  const row = document.createElement('div');
  row.className = 'tool-repair-action';
  const hint = document.createElement('span');
  hint.className = 'tool-repair-hint';
  hint.textContent = '可让 Agent 基于失败信息生成修复方案，再由你确认是否重试工具。';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tool-copy-btn tool-repair-btn';
  button.textContent = '生成修复提示';
  button.addEventListener('click', () => {
    fillComposerPrompt(buildToolRepairPrompt(tool));
    showToast('已填入工具修复提示');
  });
  row.append(hint, button);
  return row;
}

function createToolOutputSummary(outputText: string, tool: Record<string, any> = {}) {
  const text = compactToolOutputSummaryText(outputText);
  if (!text) return null;
  const summary = document.createElement('div');
  summary.className = `tool-output-summary${tool.ok === false ? ' is-error' : ''}`;
  const label = document.createElement('span');
  label.className = 'tool-output-summary-label';
  label.textContent = tool.ok === false ? '失败摘要' : '输出摘要';
  const body = document.createElement('span');
  body.className = 'tool-output-summary-text';
  body.textContent = text;
  summary.append(label, body);
  return summary;
}

function createToolOutputPreview(outputText: string, toolName = '') {
  const sources = extractToolSources(outputText);
  const localCitations = extractLocalCitations(outputText, toolName);
  const workspaceSymbol = extractWorkspaceSymbolResult(outputText, toolName);
  if (sources.length === 0 && localCitations.length === 0 && !workspaceSymbol?.result) return null;

  const preview = document.createElement('div');
  preview.className = 'tool-source-preview';

  if (sources.length > 0) {
    const label = document.createElement('div');
    label.className = 'tool-source-label';
    label.textContent = `真实来源 (${sources.length})`;
    preview.appendChild(label);

    for (const source of sources.slice(0, 3)) {
      const item = document.createElement('div');
      item.className = 'tool-source-item';
      const title = document.createElement('span');
      title.className = 'tool-source-title';
      title.textContent = source.title;
      item.appendChild(title);
      if (source.url) {
        const url = document.createElement('a');
        url.className = 'tool-source-url';
        url.href = source.url;
        url.target = '_blank';
        url.rel = 'noreferrer';
        url.textContent = source.url;
        item.appendChild(url);
      }
      if (source.publishedDate) {
        const date = document.createElement('span');
        date.className = 'tool-source-date';
        date.textContent = source.publishedDate;
        item.appendChild(date);
      }
      preview.appendChild(item);
    }
  }

  if (localCitations.length > 0) {
    const label = document.createElement('div');
    label.className = 'tool-source-label';
    label.textContent = `本地引用 (${localCitations.length})`;
    preview.appendChild(label);

    const list = document.createElement('div');
    list.className = 'tool-local-citation-list';
    for (const citation of localCitations.slice(0, 6)) {
      const chip = document.createElement('span');
      chip.className = 'tool-local-citation';
      chip.textContent = citation.label;
      chip.title = citation.file;
      list.appendChild(chip);
    }
    preview.appendChild(list);
  }

  if (workspaceSymbol?.result) {
    const label = document.createElement('div');
    label.className = 'tool-source-label';
    label.textContent = '符号定义';
    preview.appendChild(label);

    const item = document.createElement('div');
    item.className = 'tool-source-item';
    const title = document.createElement('span');
    title.className = 'tool-source-title';
    title.textContent = `${workspaceSymbol.symbol} · ${workspaceSymbol.result.file}:${workspaceSymbol.result.startLine}-${workspaceSymbol.result.endLine}`;
    item.appendChild(title);
    if (workspaceSymbol.result.signature) {
      const signature = document.createElement('span');
      signature.className = 'tool-source-date';
      signature.textContent = workspaceSymbol.result.signature;
      item.appendChild(signature);
    }
    preview.appendChild(item);
  }

  return preview;
}

function createRunCodeExperimentCard(tool: Record<string, any> = {}) {
  if (getToolName(tool) !== 'run_code' || !tool.output) return null;
  const result = tool.runResult || extractRunCodeResult(tool.output, 'run_code');
  if (!result) return null;
  const card = document.createElement('div');
  card.className = `run-experiment-card${result.ok ? ' is-success' : ' is-failed'}`;

  const header = document.createElement('div');
  header.className = 'run-experiment-header';
  const title = document.createElement('strong');
  title.textContent = '代码实验';
  const status = document.createElement('span');
  status.className = 'run-experiment-status';
  status.textContent = result.ok ? '成功' : result.timedOut ? '超时' : '失败';
  header.append(title, status);
  card.appendChild(header);

  const meta = document.createElement('div');
  meta.className = 'run-experiment-meta';
  meta.textContent = [
    `语言 ${result.language || tool.args?.language || 'unknown'}`,
    `退出码 ${result.exitCode ?? 'unknown'}`,
    `耗时 ${result.durationMs}ms`,
    `代码 ${result.codeLength} chars`,
    result.stdinBytes ? `stdin ${result.stdinBytes} bytes` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  card.appendChild(meta);

  if (result.failureHint) {
    const hint = document.createElement('div');
    hint.className = 'run-experiment-hint';
    hint.textContent = result.failureHint;
    card.appendChild(hint);
  }

  const outputs = document.createElement('div');
  outputs.className = 'run-experiment-outputs';
  if (result.stdoutPreview)
    outputs.appendChild(createRunOutputBlock('STDOUT', result.stdoutPreview, result.stdoutBytes));
  if (result.stderrPreview)
    outputs.appendChild(createRunOutputBlock('STDERR', result.stderrPreview, result.stderrBytes));
  if (outputs.children.length) card.appendChild(outputs);
  appendRunExperimentActions(card, tool, result);
  return card;
}

function appendRunExperimentActions(card: HTMLElement, tool: Record<string, any>, result: Record<string, any>) {
  const code = getRunCodeSourceCode(tool);
  const row = document.createElement('div');
  row.className = 'run-experiment-actions';

  if (code) {
    const copy = createRunExperimentActionButton('复制代码', 'copy-code');
    copy.addEventListener('click', async () => {
      await copyToClipboard(code);
      showToast('代码已复制');
    });
    row.appendChild(copy);
  }

  const save = createRunExperimentActionButton('保存 artifact', 'save-artifact');
  save.addEventListener('click', () => {
    downloadRunCodeArtifact(tool, result);
    showToast('已保存代码实验 artifact');
  });
  row.appendChild(save);

  const rerun = createRunExperimentActionButton('重新运行', 'rerun');
  rerun.addEventListener('click', () => {
    fillComposerPrompt(buildRunCodeRerunPrompt(tool, result));
    showToast('已填入重新运行提示');
  });
  row.appendChild(rerun);

  if (!result.ok || result.stderrPreview || result.failureHint) {
    const explain = createRunExperimentActionButton('解释错误', 'explain-error');
    explain.addEventListener('click', () => {
      fillComposerPrompt(buildRunCodeExplainPrompt(tool, result));
      showToast('已填入错误解释提示');
    });
    row.appendChild(explain);
  }

  if (row.children.length) card.appendChild(row);
}

function createRunExperimentActionButton(label: string, action: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `run-experiment-action-btn action-${action}`;
  button.textContent = label;
  return button;
}

function downloadRunCodeArtifact(tool: Record<string, any> = {}, result: Record<string, any> = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const language = result.language || tool.args?.language || 'code';
  const fileName = `deepchat-run-code-${formatCodeFenceLanguage(language)}-${stamp}.md`;
  downloadTextFile(buildRunCodeArtifactMarkdown(tool, result), fileName, 'text/markdown;charset=utf-8');
}

function createRunOutputBlock(label: string, text: string, bytes: number) {
  const block = document.createElement('details');
  block.className = 'run-output-block';
  const summary = document.createElement('summary');
  summary.textContent = `${label}${bytes ? ` · ${bytes} bytes` : ''}`;
  const pre = document.createElement('pre');
  pre.textContent = text;
  block.append(summary, pre);
  return block;
}

function formatToolTime(value: unknown): string {
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('zh-CN', { hour12: false });
}
