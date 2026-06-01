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

type ToolDetailLevel = 'normal' | 'advanced' | 'developer';

// ─── Risk Classification ─────────────────────────────────────────────────────

const LOW_RISK_TOOLS = new Set([
  'web_search',
  'read_file',
  'list_files',
  'search_workspace',
  'read_symbol',
  'index_workspace',
]);

const HIGH_RISK_TOOLS = new Set(['run_code', 'edit_file', 'multi_edit']);

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
  container.textContent = '';
  if (!toolCalls || toolCalls.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  const detailLevel = getToolDetailLevel(options);
  for (const tool of toolCalls) {
    const block = document.createElement('div');
    block.className = `tool-call-block status-${tool.status || 'pending'}`;
    block.dataset.detailLevel = detailLevel;

    const header = document.createElement('div');
    header.className = 'tool-call-header';
    const statusMeta = getToolStatusMeta(tool.status);
    block.dataset.statusTone = statusMeta.tone;
    const title = document.createElement('strong');
    title.textContent = getToolDisplayName(tool);
    title.title = getToolName(tool);
    const status = document.createElement('span');
    status.className = 'tool-call-status';
    status.textContent = `${statusMeta.icon} ${statusMeta.label}`;
    const riskBadge = createToolRiskBadge(tool);
    header.append(getToolHeaderPrefix(tool), title, status, riskBadge);

    const risk = document.createElement('p');
    risk.className = 'tool-call-risk';
    risk.textContent = getToolReadablePurpose(tool);

    const args = createToolArgsDetails(tool, detailLevel);

    block.append(header, risk);
    if (args) block.appendChild(args);

    const meta = createToolMeta(tool);
    if (meta) block.appendChild(meta);
    const security = createToolSecurityMeta(tool);
    if (security) block.appendChild(security);
    const editPreview = createEditPreview(tool);
    if (editPreview) block.appendChild(editPreview);
    const nextAction = createToolNextAction(tool);
    if (nextAction) block.appendChild(nextAction);
    const repairAction = createToolRepairAction(tool);
    if (repairAction) block.appendChild(repairAction);
    const repairReport = detailLevel === 'normal' ? null : createToolRepairReport(tool);
    if (repairReport) block.appendChild(repairReport);
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

      const runCard = createRunCodeExperimentCard(tool, detailLevel);
      if (runCard) block.appendChild(runCard);

      if (detailLevel !== 'normal') {
        block.appendChild(
          createPreDetails(tool.ok === false ? '查看完整失败信息' : '查看完整工具结果', String(tool.output || ''), {
            className: 'tool-call-output',
            open: detailLevel === 'developer',
          })
        );
      }
    }
    if (detailLevel === 'developer' && tool.contextOutput && tool.contextOutput !== tool.output) {
      const summaryText = (() => {
        const rawTokens = tool.rawOutputTokens || 0;
        const contextTokens = tool.contextOutputTokens || 0;
        return rawTokens && contextTokens
          ? `查看进入上下文的压缩输出 (${rawTokens}→${contextTokens} tokens)`
          : '查看进入上下文的压缩输出';
      })();
      block.appendChild(
        createPreDetails(summaryText, String(tool.contextOutput || ''), {
          className: 'tool-call-output tool-context-output',
          open: true,
        })
      );
    }

    const copyRow = createToolCopyRow(tool, detailLevel);
    if (copyRow) block.appendChild(copyRow);

    container.appendChild(block);
  }
}

function getToolDetailLevel(options: Record<string, any> = {}): ToolDetailLevel {
  const raw = String(options.detailLevel || options.uiDetailLevel || '').trim();
  if (raw === 'developer' || raw === 'advanced' || raw === 'normal') return raw;
  if (options.showRaw === true) return 'developer';
  return 'normal';
}

function getToolHeaderPrefix(tool: Record<string, any>) {
  if (tool.status === 'pending') return '需要确认：';
  if (tool.status === 'failed' || tool.ok === false) return '执行失败：';
  if (tool.status === 'denied') return '已拒绝：';
  return '已执行：';
}

function getToolDisplayName(tool: Record<string, any>) {
  const name = getToolName(tool);
  const labels: Record<string, string> = {
    web_search: '联网搜索',
    read_file: '读取文件',
    read_many_files: '批量读取文件',
    list_files: '查看目录',
    search_workspace: '搜索工作区',
    read_symbol: '读取符号',
    run_code: '运行代码',
    edit_file: '修改文件',
    multi_edit: '批量修改文件',
    index_workspace: '索引工作区',
  };
  if (labels[name]) return labels[name];
  if (name.startsWith('mcp__')) return '外部 MCP 工具';
  return name || '工具';
}

function getToolReadablePurpose(tool: Record<string, any>) {
  const explicit = String(tool.risk || '').trim();
  if (explicit) return explicit;
  const name = getToolName(tool);
  const args = tool.args || {};
  if (name === 'web_search') return `将联网搜索：${getToolQuery(tool) || args.query || '当前问题'}`;
  if (name === 'read_file') return `将读取文件：${args.path || args.file || '未指定路径'}`;
  if (name === 'read_many_files') return `将读取 ${Array.isArray(args.paths) ? args.paths.length : 0} 个文件`;
  if (name === 'search_workspace') return `将在工作区搜索：${args.query || '未指定关键词'}`;
  if (name === 'run_code') return '将在本地轻隔离环境运行代码；不提供硬网络隔离或硬内存限制。';
  if (name === 'edit_file' || name === 'multi_edit') return '将修改工作区文件；执行前会检查路径、匹配内容并保留备份。';
  if (name.startsWith('mcp__')) return '将调用外部 MCP 工具；请确认来源、参数和风险后再执行。';
  return '将执行一个工具动作；可展开参数确认具体范围。';
}

function createToolArgsDetails(tool: Record<string, any>, detailLevel: ToolDetailLevel) {
  if (detailLevel === 'normal') return null;
  const formatted = formatToolArgs(tool);
  if (!formatted || formatted === '{}') return null;
  return createPreDetails('工具参数', formatted, {
    className: 'tool-call-args-details',
    preClassName: 'tool-call-args',
    open: true,
  });
}

function createPreDetails(
  summaryText: string,
  text: string,
  {
    className = '',
    preClassName = '',
    open = false,
  }: {
    className?: string;
    preClassName?: string;
    open?: boolean;
  } = {}
) {
  const details = document.createElement('details');
  details.className = className;
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = summaryText;
  const pre = document.createElement('pre');
  if (preClassName) pre.className = preClassName;
  pre.textContent = text;
  details.append(summary, pre);
  return details;
}

function createToolCopyRow(tool: Record<string, any>, detailLevel: ToolDetailLevel) {
  if (detailLevel === 'normal') return null;
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
  if (detailLevel === 'developer' && tool.contextOutput && tool.contextOutput !== tool.output) {
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
  return copyRow;
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
  const toolName = String(tool.name || '')
    .trim()
    .toLowerCase();

  if (toolName === 'run_code') {
    items.push('沙箱：轻量目录隔离');
    items.push('限制：超时终止、输出截断、环境变量清洗');
    items.push('网络/内存：不提供硬隔离');
    items.push('输出：已脱敏');
  } else if (toolName === 'edit_file' || toolName === 'multi_edit') {
    items.push('写入：需要逐次确认');
    items.push('预检：工作区路径、敏感路径、唯一匹配');
    items.push('写入：临时文件重命名');
    items.push('备份：DeepChat 数据目录');
    if (tool.security?.editCount) items.push(`编辑数：${tool.security.editCount}`);
    if (tool.backupPath) items.push(`备份：${tool.backupPath}`);
  } else {
    if (tool.security.riskLevel) items.push(`风险：${tool.security.riskLevel}`);
    if (tool.security.sandbox) items.push(`沙箱：${tool.security.sandbox}`);
    if (tool.security.envPolicy) items.push(`环境：${tool.security.envPolicy}`);
    if (tool.security.network) items.push(`网络：${tool.security.network}`);
    if (tool.security.redaction) items.push('输出脱敏');
  }

  if (!items.length) return null;
  const meta = document.createElement('div');
  meta.className = 'tool-security-meta';
  meta.textContent = items.join(' · ');
  return meta;
}

function createEditPreview(tool: Record<string, any>) {
  const preview = tool.editPreview || tool.security?.editPreview;
  const toolName = String(tool.name || '').toLowerCase();
  if (!preview && toolName !== 'edit_file' && toolName !== 'multi_edit' && !tool.backupPath) return null;
  const box = document.createElement('div');
  box.className = 'tool-edit-preview';

  const title = document.createElement('div');
  title.className = 'tool-edit-preview-title';
  title.textContent = tool.status === 'pending' ? '写入预览' : '写入证据';
  box.appendChild(title);

  const rows = [
    preview?.path ? ['路径', preview.path] : null,
    preview?.diffSummary ? ['差异摘要', preview.diffSummary] : null,
    preview?.matchLine ? ['匹配行', preview.matchLine] : null,
    preview?.editCount ? ['编辑数', preview.editCount] : null,
    preview?.lineDelta !== undefined ? ['行数变化', preview.lineDelta] : null,
    tool.backupPath ? ['备份位置', tool.backupPath] : null,
    tool.restoreHint || preview?.restoreHint ? ['恢复建议', tool.restoreHint || preview.restoreHint] : null,
  ].filter(Boolean) as Array<[string, unknown]>;

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'tool-edit-preview-row';
    const name = document.createElement('span');
    name.textContent = label;
    const content = document.createElement('code');
    content.textContent = String(value);
    row.append(name, content);
    box.appendChild(row);
  }

  if (preview?.searchPreview || preview?.replacePreview) {
    const details = document.createElement('details');
    details.className = 'tool-edit-preview-details';
    const summary = document.createElement('summary');
    summary.textContent = '查看 SEARCH/REPLACE 片段';
    const pre = document.createElement('pre');
    pre.textContent = [`SEARCH:\n${preview.searchPreview || ''}`, `REPLACE:\n${preview.replacePreview || ''}`].join(
      '\n\n'
    );
    details.append(summary, pre);
    box.appendChild(details);
  }

  return box;
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

function createToolRepairReport(tool: Record<string, any>) {
  if (!tool.repairReport || typeof tool.repairReport !== 'object') return null;
  const report = tool.repairReport as Record<string, any>;
  const parts = [];
  if (report.scavenge) parts.push('正文补救');
  if (report.truncation) parts.push('参数补齐');
  if (report.storm) parts.push('重复抑制');
  if (report.result) parts.push(`结果：${report.result}`);
  const box = document.createElement('div');
  box.className = 'tool-repair-report';
  box.textContent = `修复报告：${parts.join(' · ') || '已记录'}`;
  if (Array.isArray(report.warnings) && report.warnings.length) {
    box.title = report.warnings.join('\n');
  }
  return box;
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

function createRunCodeExperimentCard(tool: Record<string, any> = {}, detailLevel: ToolDetailLevel = 'normal') {
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

  if (detailLevel !== 'normal') {
    const outputs = document.createElement('div');
    outputs.className = 'run-experiment-outputs';
    if (result.stdoutPreview)
      outputs.appendChild(createRunOutputBlock('STDOUT', result.stdoutPreview, result.stdoutBytes));
    if (result.stderrPreview)
      outputs.appendChild(createRunOutputBlock('STDERR', result.stderrPreview, result.stderrBytes));
    if (outputs.children.length) card.appendChild(outputs);
  }
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
