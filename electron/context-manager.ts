/**
 * Context Manager — Message budgeting, trimming, and context compaction
 *
 * Responsibilities:
 * - Estimate token counts from text / messages
 * - Build context bundles with budget constraints
 * - Trim messages to fit within token and message limits
 * - Format messages for summary generation
 * - Hash messages for cache comparison
 */

import crypto from 'crypto';
import { estimateTokens, estimateMessagesTokens, toTokenNumber, clampNumber } from './usage-meter.js';
import * as mm from './memory-manager.js';

const DEFAULT_MAX_INPUT_TOKENS = 24000;

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool' | string;
  content?: string;
  [key: string]: unknown;
};

type ContextBudgetOptions = {
  maxMessages?: unknown;
  maxInputTokens?: unknown;
  prefixTokens?: unknown;
  prefix?: Record<string, any>;
  [key: string]: unknown;
};

type ContextBudgetMetaInput = {
  maxMessages: number;
  maxInputTokens: number;
  prefixTokens: number;
  budget: number;
  clean: ChatMessage[];
  capped: ChatMessage[];
  retained: ChatMessage[];
  used: number;
  prefix?: Record<string, any>;
};

function findLatestUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

function trimByRecentBudget(messages: ChatMessage[], budget: number): ChatMessage[] {
  const retained: ChatMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    const cost = estimateMessagesTokens([candidate]);
    if (retained.length > 0 && used + cost > budget) continue;
    retained.unshift(candidate);
    used += cost;
  }
  return retained;
}

function dropLeadingAssistant(messages: ChatMessage[]): ChatMessage[] {
  let next = [...messages];
  while (next.length > 0 && next[0]?.role === 'assistant') next = next.slice(1);
  return next;
}

function createContextBudgetMeta({
  maxMessages,
  maxInputTokens,
  prefixTokens,
  budget,
  clean,
  capped,
  retained,
  used,
  prefix = {},
}: ContextBudgetMetaInput) {
  const retainedSet = new Set(retained);
  const droppedMessages = capped.filter((message: ChatMessage) => !retainedSet.has(message));
  const omittedByMessageLimit = Math.max(0, clean.length - capped.length);
  const estimatedInputTokens = used + prefixTokens;
  return {
    maxMessages,
    maxInputTokens,
    prefixTokens,
    availableHistoryTokens: budget,
    estimatedHistoryTokens: used,
    estimatedInputTokens,
    budgetRatio: maxInputTokens > 0 ? estimatedInputTokens / maxInputTokens : 0,
    originalMessages: clean.length,
    consideredMessages: capped.length,
    retainedMessages: retained.length,
    droppedMessages,
    droppedCount: droppedMessages.length + omittedByMessageLimit,
    omittedByMessageLimit,
    trimmed: droppedMessages.length > 0 || omittedByMessageLimit > 0,
    prefixFingerprint: prefix.prefixFingerprint || '',
    prefixBytes: prefix.prefixBytes || 0,
    cacheStabilityWarnings: prefix.cacheStabilityWarnings || [],
    cacheStabilityReasons: prefix.cacheStabilityReasons || [],
    cacheStabilityDetails: prefix.cacheStabilityDetails || {},
  };
}

function buildContextBudgetBundle(messages: ChatMessage[], options: ContextBudgetOptions = {}) {
  const maxMessages = Math.round(clampNumber(options.maxMessages, 1, 100, 20));
  const maxInputTokens = Math.round(clampNumber(options.maxInputTokens, 1, 262144, DEFAULT_MAX_INPUT_TOKENS));
  const prefixTokens = Math.max(0, toTokenNumber(options.prefixTokens));
  const budget = Math.max(1, maxInputTokens - prefixTokens);
  const clean = (Array.isArray(messages) ? messages : []).filter(
    (message: ChatMessage) => message && ['system', 'user', 'assistant', 'tool'].includes(message.role)
  );
  if (clean.length === 0) {
    return {
      messages: [],
      meta: createContextBudgetMeta({
        maxMessages,
        maxInputTokens,
        prefixTokens,
        budget,
        clean,
        capped: [],
        retained: [],
        used: 0,
        prefix: options.prefix,
      }),
    };
  }

  const capped = clean.slice(-maxMessages);
  const anchorIndex = findLatestUserIndex(capped);
  if (anchorIndex < 0) {
    const retained = dropLeadingAssistant(trimByRecentBudget(capped, budget));
    return {
      messages: retained,
      meta: createContextBudgetMeta({
        maxMessages,
        maxInputTokens,
        prefixTokens,
        budget,
        clean,
        capped,
        retained,
        used: estimateMessagesTokens(retained),
        prefix: options.prefix,
      }),
    };
  }

  const anchor = capped[anchorIndex];
  const retained = [anchor];
  let used = estimateMessagesTokens([anchor]);

  for (let i = anchorIndex - 1; i >= 0; i--) {
    const candidate = capped[i];
    const cost = estimateMessagesTokens([candidate]);
    if (used + cost > budget) continue;
    retained.unshift(candidate);
    used += cost;
  }

  const messagesOut = dropLeadingAssistant(retained);
  return {
    messages: messagesOut,
    meta: createContextBudgetMeta({
      maxMessages,
      maxInputTokens,
      prefixTokens,
      budget,
      clean,
      capped,
      retained: messagesOut,
      used: estimateMessagesTokens(messagesOut),
      prefix: options.prefix,
    }),
  };
}

function buildContextWithBudget(messages: ChatMessage[], options: ContextBudgetOptions = {}): ChatMessage[] {
  return buildContextBudgetBundle(messages, options).messages;
}

function trimContext(messages: ChatMessage[], maxMessages = 20): ChatMessage[] {
  return buildContextWithBudget(messages, {
    maxMessages,
    maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
  });
}

function formatMessagesForSummary(messages: ChatMessage[] = []): string {
  return messages
    .map((message: ChatMessage) => {
      const role = message.role === 'assistant' ? '助手' : '用户';
      return `${role}: ${String(message.content || '').slice(0, 1200)}`;
    })
    .join('\n\n---\n\n')
    .slice(0, 10000);
}

function hashMessages(messages: ChatMessage[] = []): string {
  const stable = messages.map((message: ChatMessage, index: number) => ({
    index,
    role: message.role,
    content: String(message.content || ''),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Memory-aware context building
// ---------------------------------------------------------------------------

/**
 * Build a context bundle that includes three-layer memory context.
 *
 * Loads the memory-manager lazily to avoid circular dependencies.  If the
 * memory manager has not been initialised the extra block is silently omitted.
 *
 * @param {Array} messages - Raw conversation messages
 * @param {object} options - Same options accepted by `buildContextBudgetBundle`
 * @param {string} query  - Latest user content used to search memory
 * @returns {{ messages: Array, meta: object, memoryContext: object|null }}
 */
function buildMemoryAwareContext(messages: ChatMessage[], options: ContextBudgetOptions = {}, query = '') {
  const bundle = buildContextBudgetBundle(messages, options);
  let memoryContext: unknown = null;

  if (query) {
    try {
      if (mm.isMemoryManagerInitialized()) {
        memoryContext = mm.formatMemoryForContext(query);
      }
    } catch {
      // memory-manager not available — graceful degradation
    }
  }

  return { ...bundle, memoryContext };
}

export {
  DEFAULT_MAX_INPUT_TOKENS,
  estimateTokens,
  estimateMessagesTokens,
  clampNumber,
  findLatestUserIndex,
  trimByRecentBudget,
  dropLeadingAssistant,
  createContextBudgetMeta,
  buildContextBudgetBundle,
  buildContextWithBudget,
  trimContext,
  formatMessagesForSummary,
  hashMessages,
  buildMemoryAwareContext,
};
