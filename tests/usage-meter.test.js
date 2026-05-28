import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  toTokenNumber,
  estimateTokens,
  estimateMessagesTokens,
  clampNumber,
  pricingForModel,
  estimateUsageCost,
  roundCost,
  normalizeTokenUsage,
  mergeTokenUsage,
  finalizeTokenUsage,
  normalizePurposeUsage,
  mergePurposeUsage,
  mergeUsageCost,
} = require('../electron/usage-meter');

describe('usage-meter', () => {
  describe('toTokenNumber', () => {
    it('returns rounded positive numbers', () => {
      expect(toTokenNumber(5)).toBe(5);
      expect(toTokenNumber(5.7)).toBe(6);
    });
    it('returns fallback for negative or NaN', () => {
      expect(toTokenNumber(-1)).toBe(0);
      expect(toTokenNumber(NaN, 3)).toBe(3);
      expect(toTokenNumber('abc', 2)).toBe(2);
    });
  });

  describe('estimateTokens', () => {
    it('estimates CJK text higher', () => {
      expect(estimateTokens('你好')).toBeGreaterThan(estimateTokens('ab'));
    });
    it('counts image parts as 300', () => {
      expect(estimateTokens([{ type: 'image_url' }])).toBe(300);
    });
    it('handles empty/null', () => {
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens(null)).toBe(0);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('adds per-message overhead', () => {
      expect(estimateMessagesTokens([{ role: 'user', content: 'hi' }])).toBe(estimateTokens('hi') + 4);
    });
  });

  describe('clampNumber', () => {
    it('clamps to range', () => {
      expect(clampNumber(5, 1, 10, 0)).toBe(5);
      expect(clampNumber(0, 1, 10, 0)).toBe(1);
      expect(clampNumber(15, 1, 10, 0)).toBe(10);
    });
    it('returns fallback for NaN', () => {
      expect(clampNumber(NaN, 1, 10, 7)).toBe(7);
    });
  });

  describe('pricingForModel', () => {
    it('finds DeepSeek pricing', () => {
      expect(pricingForModel('deepseek-chat')).toBeTruthy();
      expect(pricingForModel('deepseek-v4-pro')).toBeTruthy();
    });
    it('finds MIMO pricing', () => {
      expect(pricingForModel('mimo-v2.5')).toBeTruthy();
    });
    it('returns null for unknown', () => {
      expect(pricingForModel('unknown-model')).toBeNull();
    });
  });

  describe('estimateUsageCost', () => {
    it('computes cost from pricing', () => {
      const cost = estimateUsageCost('deepseek-chat', { cacheHit: 1000, cacheMiss: 1000, output: 500 });
      expect(cost).toBeTruthy();
      expect(cost.estimatedCostUsd).toBeGreaterThan(0);
    });
    it('returns null when no pricing', () => {
      expect(estimateUsageCost('unknown', { cacheHit: 1, cacheMiss: 1, output: 1 })).toBeNull();
    });
  });

  describe('roundCost', () => {
    it('rounds to 9 decimals', () => {
      expect(roundCost(0.1234567891)).toBe(0.123456789);
    });
  });

  describe('normalizeTokenUsage', () => {
    it('normalizes provider fields', () => {
      const u = normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 5 });
      expect(u.input).toBe(10);
      expect(u.output).toBe(5);
      expect(u.source).toBe('provider');
    });
    it('uses fallback when no usage', () => {
      const u = normalizeTokenUsage(null, { input: 3, output: 2 });
      expect(u.input).toBe(3);
      expect(u.output).toBe(2);
      expect(u.source).toBe('estimated');
    });
  });

  describe('mergeTokenUsage', () => {
    it('sums fields across usages', () => {
      const merged = mergeTokenUsage([
        { input: 10, output: 5 },
        { input: 20, output: 15 },
      ]);
      expect(merged.input).toBe(30);
      expect(merged.output).toBe(20);
      expect(merged.rounds).toBe(2);
    });
  });

  describe('finalizeTokenUsage', () => {
    it('fills defaults', () => {
      const u = finalizeTokenUsage({ input: 10, output: 5 });
      expect(u.total).toBe(15);
      expect(u.cacheHitRate).toBe(0);
      expect(Array.isArray(u.warnings)).toBe(true);
    });
  });

  describe('normalizePurposeUsage', () => {
    it('sanitizes keys', () => {
      const p = normalizePurposeUsage({ 'hello world': 5, 'abc!': 3 });
      expect(p).toHaveProperty('helloworld', 5);
      expect(p).toHaveProperty('abc', 3);
    });
  });

  describe('mergePurposeUsage', () => {
    it('sums by key', () => {
      const m = mergePurposeUsage({ a: 1 }, { a: 2, b: 3 });
      expect(m.a).toBe(3);
      expect(m.b).toBe(3);
    });
  });

  describe('mergeUsageCost', () => {
    it('adds cost fields', () => {
      const a = {
        estimatedCostUsd: 1,
        estimatedSavingsUsd: 0,
        inputCacheHitCostUsd: 0,
        inputCacheMissCostUsd: 0,
        outputCostUsd: 0,
      };
      const b = {
        estimatedCostUsd: 2,
        estimatedSavingsUsd: 0,
        inputCacheHitCostUsd: 0,
        inputCacheMissCostUsd: 0,
        outputCostUsd: 0,
      };
      const m = mergeUsageCost(a, b);
      expect(m.estimatedCostUsd).toBe(3);
    });
    it('returns null when both empty', () => {
      expect(mergeUsageCost(null, null)).toBeNull();
    });
  });
});
