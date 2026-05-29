// @ts-nocheck
import { describe, expect, it } from 'vitest';

import {
  trimContext,
  buildContextWithBudget,
  buildContextBudgetBundle,
  createContextBudgetMeta,
  findLatestUserIndex,
  trimByRecentBudget,
  dropLeadingAssistant,
  formatMessagesForSummary,
  hashMessages,
} from '../electron/context-manager.js';

describe('context-manager', () => {
  const makeMessages = (n) =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg${i}`,
    }));

  describe('trimContext', () => {
    it('trims to maxMessages', () => {
      const msgs = makeMessages(30);
      const trimmed = trimContext(msgs, 10);
      expect(trimmed.length).toBeLessThanOrEqual(10);
    });
  });

  describe('buildContextWithBudget', () => {
    it('returns only messages', () => {
      const msgs = makeMessages(10);
      const result = buildContextWithBudget(msgs, { maxMessages: 5 });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeLessThanOrEqual(5);
    });
  });

  describe('buildContextBudgetBundle', () => {
    it('returns messages and meta', () => {
      const msgs = makeMessages(10);
      const bundle = buildContextBudgetBundle(msgs, { maxMessages: 5 });
      expect(Array.isArray(bundle.messages)).toBe(true);
      expect(bundle.meta).toBeTruthy();
      expect(bundle.meta.retainedMessages).toBe(bundle.messages.length);
    });
    it('retains latest user message as anchor', () => {
      const msgs = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'last' },
      ];
      const bundle = buildContextBudgetBundle(msgs, { maxMessages: 10 });
      expect(bundle.messages.some((m) => m.content === 'last')).toBe(true);
    });
    it('returns empty for empty input', () => {
      const bundle = buildContextBudgetBundle([], { maxMessages: 5 });
      expect(bundle.messages).toEqual([]);
      expect(bundle.meta.originalMessages).toBe(0);
    });
  });

  describe('createContextBudgetMeta', () => {
    it('computes metadata', () => {
      const msg = { role: 'user' };
      const meta = createContextBudgetMeta({
        maxMessages: 10,
        maxInputTokens: 1000,
        prefixTokens: 100,
        budget: 900,
        clean: [msg],
        capped: [msg],
        retained: [msg],
        used: 50,
      });
      expect(meta.estimatedInputTokens).toBe(150);
      expect(meta.budgetRatio).toBe(0.15);
      expect(meta.trimmed).toBe(false);
    });
    it('marks trimmed when messages are dropped', () => {
      const msg1 = { role: 'user' };
      const msg2 = { role: 'assistant' };
      const meta = createContextBudgetMeta({
        maxMessages: 10,
        maxInputTokens: 1000,
        prefixTokens: 100,
        budget: 900,
        clean: [msg1, msg2],
        capped: [msg1, msg2],
        retained: [msg1],
        used: 50,
      });
      expect(meta.trimmed).toBe(true);
      expect(meta.droppedCount).toBe(1);
    });
  });

  describe('findLatestUserIndex', () => {
    it('finds the last user message', () => {
      expect(findLatestUserIndex([{ role: 'assistant' }, { role: 'user' }])).toBe(1);
      expect(findLatestUserIndex([{ role: 'assistant' }])).toBe(-1);
    });
  });

  describe('trimByRecentBudget', () => {
    it('keeps recent messages within budget', () => {
      const msgs = makeMessages(10);
      const kept = trimByRecentBudget(msgs, 100000);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThanOrEqual(msgs.length);
    });
  });

  describe('dropLeadingAssistant', () => {
    it('removes leading assistant messages', () => {
      const dropped = dropLeadingAssistant([
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'b' },
      ]);
      expect(dropped.length).toBe(1);
      expect(dropped[0].role).toBe('user');
    });
    it('preserves when first is user', () => {
      const kept = dropLeadingAssistant([{ role: 'user', content: 'b' }]);
      expect(kept.length).toBe(1);
    });
  });

  describe('formatMessagesForSummary', () => {
    it('formats with role labels', () => {
      const text = formatMessagesForSummary([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]);
      expect(text).toContain('用户:');
      expect(text).toContain('助手:');
    });
    it('truncates to 10000 chars', () => {
      const text = formatMessagesForSummary([{ role: 'user', content: 'x'.repeat(20000) }]);
      expect(text.length).toBeLessThanOrEqual(10000);
    });
  });

  describe('hashMessages', () => {
    it('returns stable hex hash', () => {
      const h1 = hashMessages([{ role: 'user', content: 'hi' }]);
      const h2 = hashMessages([{ role: 'user', content: 'hi' }]);
      expect(h1).toBe(h2);
      expect(h1.length).toBe(16);
    });
    it('differs when content differs', () => {
      const h1 = hashMessages([{ role: 'user', content: 'a' }]);
      const h2 = hashMessages([{ role: 'user', content: 'b' }]);
      expect(h1).not.toBe(h2);
    });
  });
});
