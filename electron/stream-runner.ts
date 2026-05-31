// @ts-check
/**
 * SSE streaming and tool-call merging utilities extracted from chat-service.js.
 *
 * Pure functions — no class dependencies. Handles normalisation of messages,
 * merging of incremental SSE tool-call deltas, compaction for context windows,
 * and resolution of auxiliary model / agent-round settings.
 */

import { canonicalStringify } from './system-prompt.ts';
import { inferProviderIdFromBase } from './provider-adapters.js';
import { clampNumber, estimateTokens } from './usage-meter.js';
import { DEFAULT_AGENT_MAX_ROUNDS } from './agent-planner.ts';

// ---------------------------------------------------------------------------
// Constants (mirrored from chat-service.js so this module is self-contained)
// ---------------------------------------------------------------------------

const MAX_TOOL_CONTEXT_TOKENS = 3500;
const TOOL_ARG_LONG_STRING_THRESHOLD = 300;

// ---------------------------------------------------------------------------
// Message normalisation
// ---------------------------------------------------------------------------

/**
 * Check whether an attachment object represents an image.
 * @param {{ mimeType?: string; type?: string; dataUrl?: string; url?: string } | null | undefined} attachment
 * @returns {boolean}
 */
export function isImageAttachment(
  attachment: { mimeType?: string; type?: string; dataUrl?: string; url?: string } | null | undefined
) {
  const mime = String(attachment?.mimeType || attachment?.type || '');
  return Boolean((attachment?.dataUrl || attachment?.url) && mime.startsWith('image/'));
}

/**
 * Normalise a single message: drop empty non-user messages, fold image
 * attachments into multimodal content arrays.
 * @param {{ role: string; content?: string | any[]; attachments?: any[] } | null | undefined} msg
 * @returns {{ role: string; content: string | any[] } | null}
 */
export function normalizeMessage(
  msg: { role: string; content?: string | any[]; attachments?: any[] } | null | undefined
) {
  if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) return null;
  const content = typeof msg.content === 'string' ? msg.content : '';
  const attachments =
    msg.role === 'user' && Array.isArray(msg.attachments) ? msg.attachments.filter(isImageAttachment) : [];
  if (!content.trim() && attachments.length === 0) return null;
  if (msg.role === 'user' && attachments.length > 0) {
    return {
      role: 'user',
      content: [
        { type: 'text', text: content || '请分析这张图片。' },
        ...attachments.map((attachment: any) => ({
          type: 'image_url',
          image_url: { url: attachment.dataUrl || attachment.url },
        })),
      ],
    };
  }
  return { role: msg.role, content };
}

/**
 * Sanitise a message array: normalise each entry and drop nulls.
 * @param {any[]} messages
 * @returns {{ role: string; content: string | any[] }[]}
 */
export function sanitizeMessages(messages: any[]) {
  return messages.map(normalizeMessage).filter(Boolean) as { role: string; content: string | any[] }[];
}

// ---------------------------------------------------------------------------
// SSE tool-call merging
// ---------------------------------------------------------------------------

/**
 * Merge incremental SSE tool-call deltas into a mutable target array.
 * Each incoming chunk may contain partial id/name/argument fragments.
 * @param {any[]} target
 * @param {any[]} incoming
 */
export function mergeToolCalls(target: any[], incoming: any[]) {
  for (const tc of incoming) {
    const index = tc.index ?? 0;
    if (!target[index]) {
      target[index] = {
        id: tc.id || `tool-${index}`,
        type: 'function',
        function: { name: '', arguments: '' },
      };
    }
    if (tc.id) target[index].id = tc.id;
    if (tc.function?.name) target[index].function.name = tc.function.name;
    if (tc.function?.arguments) target[index].function.arguments += tc.function.arguments;
  }
}

/**
 * Compact a raw tool-call array into the standard shape expected by the API.
 * Filters out entries without a function name.
 * @param {any[]} toolCalls
 * @returns {{ id: string; type: string; function: { name: string; arguments: string } }[]}
 */
export function compactToolCalls(toolCalls: any[]) {
  return toolCalls
    .filter((tc) => tc?.function?.name)
    .map((tc, index) => ({
      id: tc.id || `tool-${index}`,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments || '{}',
      },
    }));
}

/**
 * Shrink long tool arguments so they fit inside the context window budget.
 * @param {string} argsJson
 * @returns {string}
 */
function compactToolArgumentsForContext(argsJson: string) {
  const text = String(argsJson || '{}');
  if (estimateTokens(text) <= MAX_TOOL_CONTEXT_TOKENS) return text;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text.slice(0, 1200);
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > TOOL_ARG_LONG_STRING_THRESHOLD) {
        const newlines = (value.match(/\n/g) || []).length;
        output[key] = `[...shrunk: ${value.length} chars, ${newlines} lines — tool already responded, see result]`;
      } else {
        output[key] = value;
      }
    }
    return JSON.stringify(output);
  } catch {
    return `${text.slice(0, 1200)}...[shrunk: ${text.length} chars, unparsed]`;
  }
}

/**
 * Compact tool calls for inclusion in context messages — argument strings
 * are shrunk to stay within the token budget.
 * @param {any[]} toolCalls
 * @returns {any[]}
 */
export function compactToolCallsForContext(toolCalls: any[] = []) {
  return compactToolCalls(toolCalls).map((call: any) => ({
    ...call,
    function: {
      ...call.function,
      arguments: compactToolArgumentsForContext(call.function.arguments || '{}'),
    },
  }));
}

// ---------------------------------------------------------------------------
// Turn metadata
// ---------------------------------------------------------------------------

/**
 * Format a directive name for display in turn metadata.
 * @param {string} name
 * @returns {string}
 */
function formatDirectiveName(name: string) {
  if (name === 'web') return '@web';
  if (name === 'code') return '@run';
  if (name === 'changed') return '@changed';
  if (name === 'mcp') return '@mcp';
  return `@${name}`;
}

/**
 * Build turn-tail metadata text describing the agent plan, search strategy,
 * explicit directives, and missing prerequisites for the current turn.
 * @param {any} intent
 * @param {any} settings
 * @param {any} planSummary
 * @returns {string}
 */
export function buildTurnTailMetadata(intent: any = {}, settings: any = {}, planSummary: any = null) {
  const lines: string[] = [];
  const missing = Array.isArray(intent.missingPrerequisites) ? intent.missingPrerequisites : [];
  const explicitDirectives = Array.isArray(intent.explicitDirectives) ? intent.explicitDirectives : [];
  const searchPlan = Array.isArray(planSummary?.searchPlan) ? planSummary.searchPlan : [];
  if (settings.activeSkill === 'agent_auto' && searchPlan.length > 0) {
    lines.push('DeepChat 本轮联网搜索计划：');
    searchPlan.forEach((item: any, index: number) => {
      lines.push(`${index + 1}. ${item.purpose || '搜索'}：${item.query}`);
    });
    lines.push('如需要联网，请优先按上述 query 顺序调用 web_search；最终回答要合并去重并引用来源。');
  }
  if (settings.activeSkill === 'agent_auto' && explicitDirectives.length > 0) {
    lines.push('DeepChat 本轮显式工具指令：');
    lines.push(`用户使用了：${explicitDirectives.map(formatDirectiveName).join('、')}`);
    lines.push('显式指令优先于关键词猜测；如果对应工具可用，应优先按该方向规划。');
    if (explicitDirectives.includes('changed')) {
      lines.push(
        '用户要求最近变更上下文时，优先调用 index_workspace 建立或刷新轻量索引，再调用 list_files({ "sort_by": "modified", "recent_days": 7 }) 查看候选文件，并按需 search_workspace/read_file。'
      );
    }
  }
  if (settings.activeSkill === 'agent_auto' && missing.length > 0) {
    lines.push('DeepChat 本轮工具可用性提示：');
    lines.push(`需要的能力：${(intent.candidateTools || []).join(', ') || intent.reason || 'unknown'}`);
    lines.push(`缺少配置：${missing.join('、')}`);
    lines.push('请直接告诉用户需要完成这些配置后才能使用对应工具，不要声称已经调用工具。');
  }
  return lines.join('\n');
}

/**
 * Append turn-tail metadata to the last user message in the array.
 * Returns a new array (immutable).
 * @param {any[]} messages
 * @param {string} metadata
 * @returns {any[]}
 */
export function appendTurnTailMetadata(messages: any[] = [], metadata = '') {
  const text = String(metadata || '').trim();
  if (!text) return messages;
  const next = messages.map((message) => ({ ...message }));
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]?.role !== 'user') continue;
    const note = `\n\n[DeepChat volatile turn metadata]\n${text}`;
    if (typeof next[i].content === 'string') {
      next[i] = { ...next[i], content: `${next[i].content}${note}` };
    } else if (Array.isArray(next[i].content)) {
      next[i] = {
        ...next[i],
        content: next[i].content.map((part: any, index: number) =>
          index === 0 && part?.type === 'text' ? { ...part, text: `${part.text || ''}${note}` } : part
        ),
      };
    }
    return next;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Reasoning round-trip
// ---------------------------------------------------------------------------

/**
 * Build a reasoning_content field for models that support chain-of-thought
 * round-tripping (e.g. DeepSeek). Returns an empty object when not applicable.
 * @param {any} result
 * @param {any} settings
 * @returns {{ reasoning_content?: string }}
 */
export function buildReasoningRoundTrip(result: any, settings: any = {}) {
  if (!result?.toolCalls?.length) return {};
  const model = String(settings.model || '').toLowerCase();
  if (!model.includes('deepseek') && !String(result.thinking || '').trim()) return {};
  return { reasoning_content: result.thinking || '' };
}

// ---------------------------------------------------------------------------
// Tool-call signature / canonical JSON
// ---------------------------------------------------------------------------

/**
 * Canonical JSON stringification (parse then stringify with sorted keys).
 * Falls back to a plain string on parse failure.
 * @param {any} value
 * @returns {string}
 */
function canonicalJson(value: any) {
  try {
    return canonicalStringify(JSON.parse(value));
  } catch {
    return String(value || '');
  }
}

/**
 * Produce a deterministic signature string for a tool call
 * (function name + canonical arguments).
 * @param {any} toolCall
 * @returns {string}
 */
export function toolCallSignature(toolCall: any = {}) {
  const fn = (toolCall as any).function || {};
  return `${fn.name || 'unknown'}:${canonicalJson(fn.arguments || '{}')}`;
}

// ---------------------------------------------------------------------------
// Settings resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the auxiliary (summary) model for the current provider.
 * @param {any} settings
 * @returns {string}
 */
export function resolveAuxiliaryModel(settings: any = {}) {
  const model = String(settings.model || '').trim();
  const tier = String(settings.agentModelTier || 'auto');
  if (tier === 'pro') return model;
  const provider = String(settings.providerId || inferProviderIdFromBase(settings.apiBase)).toLowerCase();
  if (provider === 'deepseek' || /^deepseek-/i.test(model)) return 'deepseek-v4-flash';
  if (provider === 'xiaomimimo' || /^mimo-/i.test(model)) return 'mimo-v2.5';
  return model;
}

/**
 * Resolve the maximum number of agent tool-call rounds from settings,
 * clamped to [1, 10].
 * @param {any} settings
 * @returns {number}
 */
export function resolveAgentMaxRounds(settings: any = {}) {
  return Math.round(clampNumber(settings.agentMaxRounds, 1, 10, DEFAULT_AGENT_MAX_ROUNDS));
}
