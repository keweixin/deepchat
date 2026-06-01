import { clampNumber, findLatestUserIndex } from './shared-utils.js';

interface PricingEntry {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
}

interface NormalizedUsage {
  input: number;
  output: number;
  total: number;
  reasoning: number;
  cacheHit: number;
  cacheMiss: number;
  cacheHitRate: number;
  hasCacheTelemetry: boolean;
  source: string;
  rounds: number | undefined;
  warnings: string[];
  byPurpose: Record<string, number>;
  cost: ReturnType<typeof estimateUsageCost>;
}

interface ContextBudgetMessage {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

interface ContextBudgetMeta {
  maxMessages: number;
  maxInputTokens: number;
  prefixTokens: number;
  availableHistoryTokens: number;
  estimatedHistoryTokens: number;
  estimatedInputTokens: number;
  budgetRatio: number;
  originalMessages: number;
  consideredMessages: number;
  retainedMessages: number;
  droppedMessages: ContextBudgetMessage[];
  droppedCount: number;
  omittedByMessageLimit: number;
  trimmed: boolean;
  prefixFingerprint: string;
  prefixBytes: number;
  cacheStabilityWarnings: string[];
}

const DEFAULT_SETTINGS = {
  maxContextMessages: 20,
  maxInputTokens: 24000,
  maxTokens: 4096,
  model: 'deepseek-v4-flash',
};

const TOOL_MODEL_PATTERNS = [/deepseek/i, /gpt/i, /qwen/i, /claude/i, /gemini/i];

const DEEPSEEK_PRICING: Record<string, PricingEntry> = {
  'deepseek-v4-flash': { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
  'deepseek-v4-pro': { inputCacheHit: 0.003625, inputCacheMiss: 0.435, output: 0.87 },
  'deepseek-chat': { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
  'deepseek-reasoner': { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
};

const MIMO_PRICING: Record<string, PricingEntry> = {
  'mimo-v2.5': { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
  'mimo-v2.5-pro': { inputCacheHit: 0.0036, inputCacheMiss: 0.435, output: 0.87 },
};

export function estimateTokens(text: unknown): number {
  if (!text) return 0;
  if (Array.isArray(text)) {
    return text.reduce((total: number, part: { type?: string; text?: string }) => {
      if (part?.type === 'text') return total + estimateTokens(part.text || '');
      if (part?.type === 'image_url') return total + 300;
      return total;
    }, 0);
  }
  const cjk = (String(text).match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const rest = String(text).length - cjk;
  return Math.ceil(cjk * 1.5 + rest * 0.4);
}

export function estimateMessagesTokens(messages: ContextBudgetMessage[]): number {
  return messages.reduce(
    (total: number, msg: ContextBudgetMessage) => total + estimateTokens(msg.content || '') + 4,
    0
  );
}

export function normalizeTokenUsage(usage: Record<string, unknown>, fallback: Record<string, unknown> = {}) {
  const inputFallback = toTokenNumber(fallback.input ?? fallback.fallbackInput);
  const outputFallback = toTokenNumber(fallback.output ?? fallback.fallbackOutput);

  if (!usage || typeof usage !== 'object') {
    return finalizeTokenUsage({
      input: inputFallback,
      output: outputFallback,
      reasoning: toTokenNumber(fallback.reasoning),
      cacheHit: toTokenNumber(fallback.cacheHit),
      cacheMiss: fallback.cacheMiss === undefined ? inputFallback : toTokenNumber(fallback.cacheMiss),
      hasCacheTelemetry: fallback.hasCacheTelemetry === true,
      source: 'estimated',
      warnings: fallback.warnings || [],
      byPurpose: fallback.byPurpose,
      model: fallback.model,
      rounds: fallback.rounds,
    });
  }

  const input = toTokenNumber(usage.prompt_tokens ?? usage.input_tokens ?? usage.input, inputFallback);
  const output = toTokenNumber(usage.completion_tokens ?? usage.output_tokens ?? usage.output, outputFallback);
  const total = toTokenNumber(usage.total_tokens ?? usage.total, input + output);
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined;
  const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const reasoning = toTokenNumber(completionDetails?.reasoning_tokens ?? usage.reasoning_tokens ?? usage.reasoning);
  const cacheHit = toTokenNumber(
    usage.prompt_cache_hit_tokens ?? promptDetails?.cached_tokens ?? usage.cached_tokens ?? usage.cacheHit
  );
  const hasCacheTelemetry =
    usage.hasCacheTelemetry === true ||
    usage.prompt_cache_hit_tokens !== undefined ||
    usage.prompt_cache_miss_tokens !== undefined ||
    promptDetails?.cached_tokens !== undefined ||
    usage.cached_tokens !== undefined ||
    ((usage.source === 'provider' || usage.source === 'mixed') &&
      (usage.cacheHit !== undefined || usage.cacheMiss !== undefined));
  const cacheMiss =
    usage.prompt_cache_miss_tokens !== undefined
      ? toTokenNumber(usage.prompt_cache_miss_tokens)
      : toTokenNumber(usage.cacheMiss, Math.max(input - cacheHit, 0));
  const hasProviderFields =
    usage.prompt_tokens !== undefined ||
    usage.completion_tokens !== undefined ||
    usage.total_tokens !== undefined ||
    usage.prompt_cache_hit_tokens !== undefined ||
    usage.prompt_cache_miss_tokens !== undefined ||
    usage.prompt_tokens_details !== undefined;
  const source =
    usage.source === 'provider' || usage.source === 'estimated' || usage.source === 'mixed'
      ? usage.source
      : hasProviderFields
        ? 'provider'
        : 'estimated';

  return finalizeTokenUsage({
    input,
    output,
    total,
    reasoning,
    cacheHit,
    cacheMiss,
    hasCacheTelemetry,
    source,
    warnings: usage.warnings || fallback.warnings || [],
    byPurpose: usage.byPurpose || fallback.byPurpose,
    cost: usage.cost || fallback.cost,
    model: usage.model || fallback.model,
    rounds: usage.rounds || fallback.rounds,
  });
}

export function mergeTokenUsage(usages: unknown[] = [], options: Record<string, unknown> = {}) {
  const normalized = (Array.isArray(usages) ? usages : [])
    .filter(Boolean)
    .map((usage) => normalizeTokenUsage(usage as Record<string, unknown>));
  const totals = normalized.reduce(
    (acc, usage) => {
      acc.input += usage.input;
      acc.output += usage.output;
      acc.total += usage.total;
      acc.reasoning += usage.reasoning;
      acc.cacheHit += usage.cacheHit;
      acc.cacheMiss += usage.cacheMiss;
      acc.hasCacheTelemetry = acc.hasCacheTelemetry || usage.hasCacheTelemetry;
      acc.byPurpose = mergePurposeUsage(acc.byPurpose, usage.byPurpose);
      acc.cost = mergeUsageCost(acc.cost, usage.cost);
      return acc;
    },
    {
      input: 0,
      output: 0,
      total: 0,
      reasoning: 0,
      cacheHit: 0,
      cacheMiss: 0,
      hasCacheTelemetry: false,
      byPurpose: {} as Record<string, number>,
      cost: null as NormalizedUsage['cost'],
    }
  );
  const sources = new Set(normalized.map((usage) => usage.source));
  const source = sources.size === 0 ? 'estimated' : sources.size === 1 ? [...sources][0] : 'mixed';
  return finalizeTokenUsage({ ...totals, source, rounds: normalized.length, warnings: options.warnings || [] });
}

export function buildContextWithBudget(messages: unknown[], options: Record<string, unknown> = {}) {
  return buildContextBudgetBundle(messages, options).messages;
}

export function buildContextBudgetBundle(messages: unknown[], options: Record<string, unknown> = {}) {
  const maxMessages = Math.round(clampNumber(options.maxMessages, 1, 100, DEFAULT_SETTINGS.maxContextMessages));
  const maxInputTokens = Math.round(clampNumber(options.maxInputTokens, 1, 262144, DEFAULT_SETTINGS.maxInputTokens));
  const prefixTokens = Math.max(0, toTokenNumber(options.prefixTokens));
  const budget = Math.max(1, maxInputTokens - prefixTokens);
  const clean: ContextBudgetMessage[] = (Array.isArray(messages) ? messages : []).filter(
    (message): message is ContextBudgetMessage =>
      !!message && ['system', 'user', 'assistant', 'tool'].includes((message as Record<string, unknown>).role as string)
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
      }),
    };
  }

  const capped = clean.slice(-maxMessages);
  const anchorIndex = findLatestUserIndex(capped as Array<{ role?: string }>);
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
      }),
    };
  }

  const anchor = capped[anchorIndex];
  const retained: ContextBudgetMessage[] = [anchor];
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
    }),
  };
}

function finalizeTokenUsage(usage: Record<string, unknown>): NormalizedUsage {
  const input = toTokenNumber(usage.input);
  const output = toTokenNumber(usage.output);
  const total = toTokenNumber(usage.total, input + output);
  const reasoning = toTokenNumber(usage.reasoning);
  const cacheHit = toTokenNumber(usage.cacheHit);
  const cacheMiss = toTokenNumber(usage.cacheMiss, Math.max(input - cacheHit, 0));
  const hasCacheTelemetry = usage.hasCacheTelemetry === true;
  const byPurpose = normalizePurposeUsage(usage.byPurpose);
  const cost =
    (usage.cost as Record<string, unknown> | null) ||
    estimateUsageCost(usage.model as string | undefined, { input, output, cacheHit, cacheMiss });
  return {
    input,
    output,
    total,
    reasoning,
    cacheHit,
    cacheMiss,
    cacheHitRate: input > 0 ? cacheHit / input : 0,
    hasCacheTelemetry,
    source: String(usage.source || 'estimated'),
    rounds: usage.rounds as number | undefined,
    warnings: Array.isArray(usage.warnings) ? (usage.warnings as string[]) : [],
    byPurpose,
    cost,
  };
}

function normalizePurposeUsage(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
    const safeKey = String(key || '')
      .replace(/[^a-z0-9_-]/gi, '')
      .slice(0, 40);
    if (safeKey) out[safeKey] = toTokenNumber(amount);
  }
  return out;
}

function mergePurposeUsage(
  left: Record<string, number> = {},
  right: Record<string, number> = {}
): Record<string, number> {
  const out: Record<string, number> = { ...(left || {}) };
  for (const [key, amount] of Object.entries(right || {})) {
    out[key] = toTokenNumber(out[key]) + toTokenNumber(amount);
  }
  return out;
}

function mergeUsageCost(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!left && !right) return null;
  const out: Record<string, unknown> = {
    model: String((right as Record<string, unknown>)?.model || (left as Record<string, unknown>)?.model || ''),
    estimatedCostUsd: 0,
    estimatedSavingsUsd: 0,
    inputCacheHitCostUsd: 0,
    inputCacheMissCostUsd: 0,
    outputCostUsd: 0,
  };
  for (const source of [left, right]) {
    if (!source) continue;
    out.estimatedCostUsd = Number(out.estimatedCostUsd) + Number(source.estimatedCostUsd || 0);
    out.estimatedSavingsUsd = Number(out.estimatedSavingsUsd) + Number(source.estimatedSavingsUsd || 0);
    out.inputCacheHitCostUsd = Number(out.inputCacheHitCostUsd) + Number(source.inputCacheHitCostUsd || 0);
    out.inputCacheMissCostUsd = Number(out.inputCacheMissCostUsd) + Number(source.inputCacheMissCostUsd || 0);
    out.outputCostUsd = Number(out.outputCostUsd) + Number(source.outputCostUsd || 0);
  }
  return out;
}

function estimateUsageCost(
  model: string | undefined,
  usage: { input: number; output: number; cacheHit: number; cacheMiss: number }
): Record<string, unknown> | null {
  const pricing = pricingForModel(model);
  if (!pricing) return null;
  const inputCacheHitCostUsd = (usage.cacheHit * pricing.inputCacheHit) / 1000000;
  const inputCacheMissCostUsd = (usage.cacheMiss * pricing.inputCacheMiss) / 1000000;
  const outputCostUsd = (usage.output * pricing.output) / 1000000;
  return {
    model,
    estimatedCostUsd: roundCost(inputCacheHitCostUsd + inputCacheMissCostUsd + outputCostUsd),
    estimatedSavingsUsd: roundCost(
      (usage.cacheHit * Math.max(0, pricing.inputCacheMiss - pricing.inputCacheHit)) / 1000000
    ),
    inputCacheHitCostUsd: roundCost(inputCacheHitCostUsd),
    inputCacheMissCostUsd: roundCost(inputCacheMissCostUsd),
    outputCostUsd: roundCost(outputCostUsd),
  };
}

function pricingForModel(model: string | undefined): PricingEntry | null {
  const id = String(model || '').trim();
  if (DEEPSEEK_PRICING[id]) return DEEPSEEK_PRICING[id];
  if (/deepseek-v4-flash|deepseek-chat|deepseek-reasoner/i.test(id)) return DEEPSEEK_PRICING['deepseek-v4-flash'];
  if (/deepseek-v4-pro/i.test(id)) return DEEPSEEK_PRICING['deepseek-v4-pro'];
  if (MIMO_PRICING[id]) return MIMO_PRICING[id];
  if (/mimo-v2\.5-pro/i.test(id)) return MIMO_PRICING['mimo-v2.5-pro'];
  if (/mimo-v2\.5/i.test(id)) return MIMO_PRICING['mimo-v2.5'];
  return null;
}

function roundCost(value: unknown): number {
  return Math.round(Number(value || 0) * 1000000000) / 1000000000;
}

export function getConversationUsageSummary(conversation: { messages?: ContextBudgetMessage[] }): NormalizedUsage {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const sources = new Set<string>();
  const summary = messages.reduce(
    (
      acc: {
        input: number;
        output: number;
        total: number;
        reasoning: number;
        cacheHit: number;
        cacheMiss: number;
        hasCacheTelemetry: boolean;
        rounds: number;
        byPurpose: Record<string, number>;
        cost: NormalizedUsage['cost'];
      },
      message: ContextBudgetMessage
    ) => {
      if (!message?.tokens) return acc;
      const usage = normalizeTokenUsage(message.tokens as Record<string, unknown>);
      sources.add(usage.source || 'estimated');
      acc.input += usage.input;
      acc.output += usage.output;
      acc.total += usage.total;
      acc.reasoning += usage.reasoning;
      acc.cacheHit += usage.cacheHit;
      acc.cacheMiss += usage.cacheMiss;
      acc.hasCacheTelemetry = acc.hasCacheTelemetry || usage.hasCacheTelemetry;
      acc.rounds += usage.rounds || 1;
      acc.byPurpose = mergePurposeUsage(acc.byPurpose, usage.byPurpose);
      acc.cost = mergeUsageCost(acc.cost, usage.cost);
      return acc;
    },
    {
      input: 0,
      output: 0,
      total: 0,
      reasoning: 0,
      cacheHit: 0,
      cacheMiss: 0,
      hasCacheTelemetry: false,
      rounds: 0,
      byPurpose: {} as Record<string, number>,
      cost: null as Record<string, unknown> | null,
    }
  );
  const source = sources.size === 0 ? 'estimated' : sources.size === 1 ? [...sources][0] : 'mixed';
  return finalizeTokenUsage({ ...summary, source });
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
}: {
  maxMessages: number;
  maxInputTokens: number;
  prefixTokens: number;
  budget: number;
  clean: ContextBudgetMessage[];
  capped: ContextBudgetMessage[];
  retained: ContextBudgetMessage[];
  used: number;
}): ContextBudgetMeta {
  const retainedSet = new Set(retained);
  const droppedMessages = capped.filter((message: ContextBudgetMessage) => !retainedSet.has(message));
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
    prefixFingerprint: '',
    prefixBytes: 0,
    cacheStabilityWarnings: [],
  };
}

function toTokenNumber(value: unknown, fallback: unknown = 0): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return Math.max(0, Math.round(Number(fallback) || 0));
  return Math.round(number);
}

function trimByRecentBudget(messages: ContextBudgetMessage[], budget: number): ContextBudgetMessage[] {
  const retained: ContextBudgetMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i] as ContextBudgetMessage;
    const cost = estimateMessagesTokens([candidate]);
    if (retained.length > 0 && used + cost > budget) continue;
    retained.unshift(candidate);
    used += cost;
  }
  return retained;
}

function dropLeadingAssistant(messages: ContextBudgetMessage[]): ContextBudgetMessage[] {
  let next = [...messages];
  while (next.length > 0 && next[0]?.role === 'assistant') next = next.slice(1);
  return next;
}
