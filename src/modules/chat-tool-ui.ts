/**
 * Chat Tool UI — Pure data-transformation functions for tool call
 * risk assessment, repair prompts, and run-code prompt builders.
 *
 * Extracted from chat.js. All functions here are pure (no DOM, no chat state).
 */

import { getToolName, formatToolArgs } from './tool-runs.js';
import { truncate } from './utils.js';

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
