// @ts-check
/**
 * Tool execution helpers extracted from chat-service.js.
 *
 * Contains tool output compaction, tool-call repair from model text,
 * JSON argument parsing/repairing, and related utilities.
 */

import { estimateTokens } from './usage-meter.js';
import { canonicalStringify } from './system-prompt.js';
import { McpManager, isMcpToolName } from './mcp-manager.js';
import { toolCallSignature } from './stream-runner.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** @type {number} Max tokens before tool output is compacted for context. */
export const MAX_TOOL_CONTEXT_TOKENS = 3500;

/** @type {number} Max characters scanned when repairing tool calls from text. */
const TOOL_REPAIR_SCAN_LIMIT = 24000;

/** @type {number} Max repaired tool calls extracted from model text. */
const TOOL_REPAIR_MAX_CALLS = 4;

/** @type {number} Max characters accepted for truncated JSON repair. */
const TOOL_ARG_REPAIR_LIMIT = 12000;

// ── Tool Output Compaction ───────────────────────────────────────────────────

/**
 * Compact tool output to fit within context budget.
 *
 * @param {string} toolName
 * @param {any} args
 * @param {string} output
 * @returns {string}
 */
export function compactToolOutputForContext(toolName: string, args: any, output: any) {
  const text = String(output || '');
  if (estimateTokens(text) <= MAX_TOOL_CONTEXT_TOKENS) return text;
  const name = String(toolName || '');
  if (name === 'web_search') return compactSearchOutput(text);
  if (name === 'search_workspace') return compactWorkspaceSearchOutput(text);
  if (name === 'read_symbol') return compactSymbolOutput(text);
  if (name === 'read_file') return compactFileOutput(text);
  if (name === 'run_code') return compactCodeOutput(text);
  if (isMcpToolName(name)) return compactMcpOutput(text);

  const lines = text.split('\n');
  const important = lines.filter((/** @type {string} */ line) =>
    /^\s*(MCP Server|Tool|URL:|Published:|\d+\.|搜索时间|实际搜索 query|文件：|大小：)/.test(line)
  );
  const head = text.slice(0, 3200);
  return [
    '[工具输出已为后续上下文压缩，完整输出已记录在工具运行卡片中。]',
    args && Object.keys(args).length ? `参数：${JSON.stringify(args).slice(0, 800)}` : '',
    important.slice(0, 40).join('\n'),
    '',
    head,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 7000);
}

/**
 * Compact web search output.
 *
 * @param {string} text
 * @returns {string}
 */
function compactSearchOutput(text: string) {
  const lines = text.split('\n');
  const important = lines.filter((/** @type {string} */ line) =>
    /^\s*(搜索时间|用户原始问题|实际搜索 query|Tavily 参数|\d+\.|URL:|Published:|摘要:)/.test(line)
  );
  return ['[联网搜索结果已压缩，完整输出在工具运行卡片中。]', ...important.slice(0, 80)].join('\n').slice(0, 7000);
}

/**
 * Compact workspace search output.
 *
 * @param {string} text
 * @returns {string}
 */
function compactWorkspaceSearchOutput(text: string) {
  const lines = text.split('\n');
  const important = lines.filter((/** @type {string} */ line) =>
    /^\s*(工作区搜索：|符号：|工作区：|目录：|结果数：|\d+\. |   摘录:|   \d+:)/.test(line)
  );
  return ['[工作区搜索结果已压缩，完整输出在工具运行卡片中。]', important.slice(0, 80).join('\n')]
    .join('\n')
    .slice(0, 7000);
}

/**
 * Compact symbol read output.
 *
 * @param {string} text
 * @returns {string}
 */
function compactSymbolOutput(text: string) {
  const lines = text.split('\n');
  const important = lines.filter((/** @type {string} */ line) =>
    /^\s*(符号读取：|工作区：|目录：|结果：|类型：|签名：|代码片段:|\d+:)/.test(line)
  );
  return ['[符号读取结果已压缩，完整输出在工具运行卡片中。]', important.slice(0, 120).join('\n')]
    .join('\n')
    .slice(0, 7000);
}

/**
 * Compact file read output.
 *
 * @param {string} text
 * @returns {string}
 */
function compactFileOutput(text: string) {
  const lines = text.split('\n');
  const meta = lines.filter((/** @type {string} */ line) => /^\s*(文件：|大小：|行范围：)/.test(line));
  const body = lines
    .filter((/** @type {string} */ line) => !/^\s*(文件：|大小：|行范围：)/.test(line))
    .join('\n')
    .trim();
  return [
    '[文件内容已压缩，完整输出在工具运行卡片中。]',
    ...meta,
    '',
    '开头片段：',
    body.slice(0, 2600),
    '',
    '结尾片段：',
    body.slice(-1800),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 7000);
}

/**
 * Compact code execution output.
 *
 * @param {string} text
 * @returns {string}
 */
function compactCodeOutput(text: string) {
  const stdout = extractSection(text, 'STDOUT:', 'STDERR:');
  const stderr = extractSection(text, 'STDERR:');
  const header = text.split('\n').filter((/** @type {string} */ line) => /^\s*(语言：|退出码：)/.test(line));
  return [
    '[代码运行结果已压缩，完整输出在工具运行卡片中。]',
    ...header,
    '',
    'STDOUT 首尾：',
    compactHeadTail(stdout, 1800, 1000),
    '',
    'STDERR 首尾：',
    compactHeadTail(stderr, 1400, 800),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 7000);
}

/**
 * Compact MCP tool output.
 *
 * @param {string} text
 * @returns {string}
 */
function compactMcpOutput(text: string) {
  const lines = text.split('\n');
  const meta = lines.filter((/** @type {string} */ line) =>
    /^\s*(MCP Server：|Tool：|MCP 工具返回错误|Structured Content:)/.test(line)
  );
  return [
    '[MCP 工具输出已压缩，完整输出在工具运行卡片中。]',
    ...meta.slice(0, 20),
    '',
    compactHeadTail(text, 2600, 1800),
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 7000);
}

// ── Tool-Call Repair from Model Text ─────────────────────────────────────────

/**
 * Attempt to repair tool calls from model content/thinking text.
 *
 * @param {string} content
 * @param {string} thinking
 * @param {any[]} tools
 * @returns {{ toolCalls: any[], warning: string }}
 */
export function repairToolCallsFromText(content = '', thinking = '', tools: any[] = []) {
  const allowedNames = new Set(
    (Array.isArray(tools) ? tools : []).map((tool: any) => String(tool?.function?.name || '').trim()).filter(Boolean)
  );
  if (allowedNames.size === 0) return { toolCalls: [], warning: '' };
  const text = [thinking, content].filter(Boolean).join('\n\n').slice(0, TOOL_REPAIR_SCAN_LIMIT);
  if (!text) return { toolCalls: [], warning: '' };

  const candidates = extractToolRepairCandidates(text, allowedNames);
  const toolCalls = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const parsed = parseJsonCandidate(candidate);
    if (parsed === undefined) continue;
    for (const call of collectToolCallsFromValue(parsed, allowedNames)) {
      const signature = toolCallSignature(call);
      if (seen.has(signature)) continue;
      seen.add(signature);
      toolCalls.push({
        id: `repair-tool-${toolCalls.length + 1}`,
        type: 'function',
        function: call.function,
      });
      if (toolCalls.length >= TOOL_REPAIR_MAX_CALLS) break;
    }
    if (toolCalls.length >= TOOL_REPAIR_MAX_CALLS) break;
  }
  return {
    toolCalls,
    warning:
      toolCalls.length > 0 ? `已从模型正文/思考中修复 ${toolCalls.length} 个工具调用；仍需用户确认后才会执行。` : '',
  };
}

/**
 * Extract candidate JSON snippets from text that may contain tool calls.
 *
 * @param {string} text
 * @param {Set<string>} allowedNames
 * @returns {string[]}
 */
function extractToolRepairCandidates(text: string, allowedNames: Set<string>) {
  const candidates: string[] = [];
  const add = (value: any) => {
    const candidate = String(value || '').trim();
    if (!candidate || candidate.length > TOOL_REPAIR_SCAN_LIMIT) return;
    if (!containsAllowedToolName(candidate, allowedNames)) return;
    candidates.push(candidate);
  };

  for (const match of text.matchAll(/<tool_calls?>\s*([\s\S]*?)<\/tool_calls?>/gi)) add(match[1]);
  for (const match of text.matchAll(/```(?:json|tool|tool_call|tool_calls)?\s*([\s\S]*?)```/gi)) add(match[1]);
  for (const candidate of extractBalancedJsonSnippets(text, allowedNames)) add(candidate);
  return [...new Set(candidates)];
}

/**
 * Extract balanced JSON snippets from text that reference allowed tool names.
 *
 * @param {string} text
 * @param {Set<string>} allowedNames
 * @returns {string[]}
 */
function extractBalancedJsonSnippets(text: string, allowedNames: Set<string>) {
  const snippets = [];
  const source = String(text || '').slice(0, TOOL_REPAIR_SCAN_LIMIT);
  for (let i = 0; i < source.length; i++) {
    const opener = source[i];
    if (opener !== '{' && opener !== '[') continue;
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < source.length; j++) {
      const char = source[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === opener) {
        depth += 1;
      } else if (char === closer) {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(i, j + 1);
          if (
            containsAllowedToolName(candidate, allowedNames) &&
            /"(tool_calls?|tool_name|tool|name|function)"/i.test(candidate)
          ) {
            snippets.push(candidate);
          }
          i = j;
          break;
        }
      }
    }
  }
  return snippets;
}

// ── JSON Argument Parsing & Repair ───────────────────────────────────────────

/**
 * Parse tool arguments with truncated-JSON repair.
 *
 * @param {string} raw
 * @returns {{ args: Record<string, any>, error: string, repaired?: boolean, warning?: string }}
 */
export function parseToolArgsDetailed(raw: string) {
  const text = String(raw || '{}');
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { args: {}, error: '工具参数必须是 JSON object。' };
    }
    return { args: parsed, error: '' };
  } catch (error: any) {
    const repaired = repairTruncatedJsonObject(text);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return {
            args: parsed,
            error: '',
            repaired: true,
            warning: '工具参数 JSON 看起来被截断，已自动补齐结尾引号/括号；请确认参数后再批准执行。',
          };
        }
      } catch {
        // Fall through to the original parse error.
      }
    }
    return { args: {}, error: error.message || 'JSON parse error' };
  }
}

/**
 * Attempt to repair a truncated JSON object string by closing open brackets
 * and unterminated strings.
 *
 * @param {string} raw
 * @returns {string} Repaired JSON string, or empty if irreparable.
 */
function repairTruncatedJsonObject(raw: string) {
  const text = String(raw || '').trim();
  if (!text || text.length > TOOL_ARG_REPAIR_LIMIT || !text.startsWith('{')) return '';
  if (/[,:\[]\s*$/.test(text)) return '';
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      stack.push('}');
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return '';
    }
  }
  if (escaped) return '';
  let repaired = text;
  if (inString) repaired += '"';
  if (stack.length === 0 && !inString) return '';
  for (let i = stack.length - 1; i >= 0; i--) repaired += stack[i];
  return repaired;
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Check whether text contains any of the allowed tool names.
 *
 * @param {string} text
 * @param {Set<string>} allowedNames
 * @returns {boolean}
 */
function containsAllowedToolName(text: string, allowedNames: Set<string>) {
  const value = String(text || '');
  for (const name of allowedNames) {
    if (value.includes(name)) return true;
  }
  return false;
}

/**
 * Try to parse a JSON candidate string.
 *
 * @param {string} candidate
 * @returns {any|undefined}
 */
function parseJsonCandidate(candidate: string) {
  try {
    return JSON.parse(String(candidate || '').trim());
  } catch {
    return undefined;
  }
}

/**
 * Recursively collect tool-call objects from a parsed value tree.
 *
 * @param {any} value
 * @param {Set<string>} allowedNames
 * @returns {Array<{ type: string, function: { name: string, arguments: string } }>}
 */
function collectToolCallsFromValue(value: any, allowedNames: Set<string>) {
  const calls: any[] = [];
  const visit = (item: any) => {
    if (!item) return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item !== 'object') return;
    if (Array.isArray(item.tool_calls)) visit(item.tool_calls);
    if (Array.isArray(item.tools)) visit(item.tools);

    const fn = item.function && typeof item.function === 'object' ? item.function : null;
    const name = String(fn?.name || item.name || item.tool || item.tool_name || item.function_name || '').trim();
    if (!allowedNames.has(name)) return;
    const rawArgs = fn?.arguments ?? item.arguments ?? item.args ?? item.parameters ?? item.input ?? {};
    const argsJson = normalizeScavengedArguments(rawArgs);
    if (!argsJson) return;
    calls.push({
      type: 'function',
      function: { name, arguments: argsJson },
    });
  };
  visit(value);
  return calls;
}

/**
 * Normalize scavenged arguments to a canonical JSON string.
 *
 * @param {any} value
 * @returns {string}
 */
function normalizeScavengedArguments(value: any) {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? canonicalStringify(parsed) : '';
    } catch {
      return '';
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) return canonicalStringify(value);
  return '';
}

/**
 * Extract a section of text between markers.
 *
 * @param {string} text
 * @param {string} startMarker
 * @param {string} [endMarker]
 * @returns {string}
 */
function extractSection(text: string, startMarker: string, endMarker?: string) {
  const start = text.indexOf(startMarker);
  if (start < 0) return '';
  const from = start + startMarker.length;
  const end = endMarker ? text.indexOf(endMarker, from) : -1;
  return text.slice(from, end >= 0 ? end : undefined).trim();
}

/**
 * Return head + tail of text with an ellipsis in between.
 *
 * @param {string} text
 * @param {number} headLength
 * @param {number} tailLength
 * @returns {string}
 */
function compactHeadTail(text: string, headLength: number, tailLength: number) {
  const value = String(text || '').trim();
  if (value.length <= headLength + tailLength + 100) return value || '(empty)';
  return `${value.slice(0, headLength)}\n...\n${value.slice(-tailLength)}`;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Constants (exported for testability)
  MAX_TOOL_CONTEXT_TOKENS,
  TOOL_REPAIR_SCAN_LIMIT,
  TOOL_REPAIR_MAX_CALLS,
  TOOL_ARG_REPAIR_LIMIT,
  // Tool output compaction
  compactToolOutputForContext,
  compactSearchOutput,
  compactWorkspaceSearchOutput,
  compactSymbolOutput,
  compactFileOutput,
  compactCodeOutput,
  compactMcpOutput,
  // Tool-call repair
  repairToolCallsFromText,
  extractToolRepairCandidates,
  extractBalancedJsonSnippets,
  // Argument parsing & repair
  parseToolArgsDetailed,
  repairTruncatedJsonObject,
};
