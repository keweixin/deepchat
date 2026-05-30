/**
 * Usage Meter — Token usage normalization, cost estimation, and pricing
 *
 * Responsibilities:
 * - Normalize provider usage responses into a stable format
 * - Merge multiple usage rounds
 * - Estimate cost from model pricing tables
 */

const DEEPSEEK_PRICING = {
  'deepseek-v4-flash': { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
  'deepseek-v4-pro': { inputCacheHit: 0.003625, inputCacheMiss: 0.435, output: 0.87 },
  'deepseek-chat': { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
  'deepseek-reasoner': { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
};

const MIMO_PRICING = {
  'mimo-v2.5': { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
  'mimo-v2.5-pro': { inputCacheHit: 0.0036, inputCacheMiss: 0.435, output: 0.87 },
};

function toTokenNumber(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return Math.max(0, Math.round(Number(fallback) || 0));
  return Math.round(number);
}

function estimateTokens(text) {
  if (!text) return 0;
  if (Array.isArray(text)) {
    return text.reduce((total, part) => {
      if (part?.type === 'text') return total + estimateTokens(part.text || '');
      if (part?.type === 'image_url') return total + 300;
      return total;
    }, 0);
  }
  const cjk = (String(text).match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const rest = String(text).length - cjk;
  return Math.ceil(cjk * 1.5 + rest * 0.4);
}

function estimateMessagesTokens(messages) {
  return messages.reduce((total, msg) => total + estimateTokens(msg.content || '') + 4, 0);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function roundCost(value) {
  return Math.round(Number(value || 0) * 1000000000) / 1000000000;
}

function pricingForModel(model) {
  const id = String(model || '').trim();
  if (DEEPSEEK_PRICING[id]) return DEEPSEEK_PRICING[id];
  if (/deepseek-v4-flash|deepseek-chat|deepseek-reasoner/i.test(id)) return DEEPSEEK_PRICING['deepseek-v4-flash'];
  if (/deepseek-v4-pro/i.test(id)) return DEEPSEEK_PRICING['deepseek-v4-pro'];
  if (MIMO_PRICING[id]) return MIMO_PRICING[id];
  if (/mimo-v2\.5-pro/i.test(id)) return MIMO_PRICING['mimo-v2.5-pro'];
  if (/mimo-v2\.5/i.test(id)) return MIMO_PRICING['mimo-v2.5'];
  return null;
}

function estimateUsageCost(model, usage) {
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

function mergeUsageCost(left, right) {
  if (!left && !right) return null;
  const out = {
    model: right?.model || left?.model || '',
    estimatedCostUsd: 0,
    estimatedSavingsUsd: 0,
    inputCacheHitCostUsd: 0,
    inputCacheMissCostUsd: 0,
    outputCostUsd: 0,
  };
  for (const source of [left, right]) {
    if (!source) continue;
    out.estimatedCostUsd += Number(source.estimatedCostUsd || 0);
    out.estimatedSavingsUsd += Number(source.estimatedSavingsUsd || 0);
    out.inputCacheHitCostUsd += Number(source.inputCacheHitCostUsd || 0);
    out.inputCacheMissCostUsd += Number(source.inputCacheMissCostUsd || 0);
    out.outputCostUsd += Number(source.outputCostUsd || 0);
  }
  return out;
}

function normalizePurposeUsage(value) {
  if (!value || typeof value !== 'object') return {};
  const out = {};
  for (const [key, amount] of Object.entries(value)) {
    const safeKey = String(key || '')
      .replace(/[^a-z0-9_-]/gi, '')
      .slice(0, 40);
    if (safeKey) out[safeKey] = toTokenNumber(amount);
  }
  return out;
}

function mergePurposeUsage(left = {}, right = {}) {
  const out = { ...(left || {}) };
  for (const [key, amount] of Object.entries(right || {})) {
    out[key] = toTokenNumber(out[key]) + toTokenNumber(amount);
  }
  return out;
}

function finalizeTokenUsage(usage) {
  const input = toTokenNumber(usage.input);
  const output = toTokenNumber(usage.output);
  const total = toTokenNumber(usage.total, input + output);
  const reasoning = toTokenNumber(usage.reasoning);
  const cacheHit = toTokenNumber(usage.cacheHit);
  const cacheMiss = toTokenNumber(usage.cacheMiss, Math.max(input - cacheHit, 0));
  const byPurpose = normalizePurposeUsage(usage.byPurpose);
  const cost = usage.cost || estimateUsageCost(usage.model, { input, output, cacheHit, cacheMiss });
  return {
    input,
    output,
    total,
    reasoning,
    cacheHit,
    cacheMiss,
    cacheHitRate: input > 0 ? cacheHit / input : 0,
    source: usage.source || 'estimated',
    rounds: usage.rounds,
    warnings: Array.isArray(usage.warnings) ? usage.warnings : [],
    byPurpose,
    cost,
  };
}

function normalizeTokenUsage(usage, fallback = {}) {
  const inputFallback = toTokenNumber(fallback.input ?? fallback.fallbackInput);
  const outputFallback = toTokenNumber(fallback.output ?? fallback.fallbackOutput);

  if (!usage || typeof usage !== 'object') {
    return finalizeTokenUsage({
      input: inputFallback,
      output: outputFallback,
      reasoning: toTokenNumber(fallback.reasoning),
      cacheHit: toTokenNumber(fallback.cacheHit),
      cacheMiss: fallback.cacheMiss === undefined ? inputFallback : toTokenNumber(fallback.cacheMiss),
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
  const reasoning = toTokenNumber(
    usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? usage.reasoning
  );
  const cacheHit = toTokenNumber(
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? usage.cacheHit
  );
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
    source,
    warnings: usage.warnings || fallback.warnings || [],
    byPurpose: usage.byPurpose || fallback.byPurpose,
    cost: usage.cost || fallback.cost,
    model: usage.model || fallback.model,
    rounds: usage.rounds || fallback.rounds,
  });
}

function mergeTokenUsage(usages = [], options = {}) {
  const normalized = (Array.isArray(usages) ? usages : []).filter(Boolean).map((usage) => normalizeTokenUsage(usage));
  const totals = normalized.reduce(
    (acc, usage) => {
      acc.input += usage.input;
      acc.output += usage.output;
      acc.total += usage.total;
      acc.reasoning += usage.reasoning;
      acc.cacheHit += usage.cacheHit;
      acc.cacheMiss += usage.cacheMiss;
      acc.byPurpose = mergePurposeUsage(acc.byPurpose, usage.byPurpose);
      acc.cost = mergeUsageCost(acc.cost, usage.cost);
      return acc;
    },
    { input: 0, output: 0, total: 0, reasoning: 0, cacheHit: 0, cacheMiss: 0, byPurpose: {}, cost: null }
  );
  const sources = new Set(normalized.map((usage) => usage.source));
  const source = sources.size === 0 ? 'estimated' : sources.size === 1 ? [...sources][0] : 'mixed';
  return finalizeTokenUsage({ ...totals, source, rounds: normalized.length, warnings: options.warnings || [] });
}

module.exports = {
  DEEPSEEK_PRICING,
  MIMO_PRICING,
  pricingForModel,
  estimateUsageCost,
  roundCost,
  mergeUsageCost,
  normalizePurposeUsage,
  mergePurposeUsage,
  finalizeTokenUsage,
  normalizeTokenUsage,
  mergeTokenUsage,
  toTokenNumber,
  estimateTokens,
  estimateMessagesTokens,
  clampNumber,
};

