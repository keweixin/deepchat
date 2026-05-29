// @ts-nocheck
import { describe, expect, it } from 'vitest';

import {
  buildHeaders,
  normalizeBaseUrl,
  parseApiError,
  isUnsupportedParameterError,
  isToolParameterError,
  inferProviderIdFromBase,
  getProviderToolSupport,
  shouldWarnAboutToolSupport,
  filterStableBuiltInTools,
  normalizeError,
} from '../electron/provider-adapters.js';

describe('provider-adapters', () => {
  describe('buildHeaders', () => {
    it('sets Content-Type and Accept', () => {
      const h = buildHeaders();
      expect(h['Content-Type']).toBe('application/json');
      expect(h.Accept).toBe('text/event-stream');
    });
    it('adds Authorization when apiKey provided', () => {
      const h = buildHeaders('sk-test');
      expect(h.Authorization).toBe('Bearer sk-test');
    });
  });

  describe('normalizeBaseUrl', () => {
    it('adds /v1 when missing', () => {
      expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com/v1');
    });
    it('preserves existing /v1', () => {
      expect(normalizeBaseUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    });
    it('uses default when empty', () => {
      expect(normalizeBaseUrl('')).toBe('https://api.deepseek.com/v1');
    });
  });

  describe('parseApiError', () => {
    it('extracts message from JSON error', () => {
      expect(parseApiError(400, JSON.stringify({ error: { message: 'bad request' } }))).toBe('bad request');
    });
    it('falls back to status when JSON invalid', () => {
      expect(parseApiError(500, 'server error')).toContain('500');
    });
  });

  describe('isUnsupportedParameterError', () => {
    it('detects unsupported parameter text', () => {
      expect(isUnsupportedParameterError('unsupported parameter: stream_options', 'stream_options')).toBe(true);
      expect(isUnsupportedParameterError('everything is fine', 'stream_options')).toBe(false);
    });
  });

  describe('isToolParameterError', () => {
    it('detects tool-related unsupported errors', () => {
      expect(isToolParameterError('tools parameter is not supported')).toBe(true);
      expect(isToolParameterError('random error')).toBe(false);
    });
  });

  describe('inferProviderIdFromBase', () => {
    it('recognizes known providers', () => {
      expect(inferProviderIdFromBase('https://api.deepseek.com/v1')).toBe('deepseek');
      expect(inferProviderIdFromBase('https://api.openai.com/v1')).toBe('openai');
      expect(inferProviderIdFromBase('https://openrouter.ai/api/v1')).toBe('openrouter');
      expect(inferProviderIdFromBase('http://localhost:11434/v1')).toBe('ollama');
    });
    it('returns custom for unknown', () => {
      expect(inferProviderIdFromBase('https://example.com')).toBe('custom');
    });
  });

  describe('getProviderToolSupport', () => {
    it('supports deepseek-chat', () => {
      const result = getProviderToolSupport({ model: 'deepseek-chat', apiBase: 'https://api.deepseek.com' });
      expect(result.supported).toBe(true);
    });
    it('blocks deepseek-reasoner', () => {
      const result = getProviderToolSupport({ model: 'deepseek-reasoner', apiBase: 'https://api.deepseek.com' });
      expect(result.supported).toBe(false);
    });
    it('blocks ollama', () => {
      const result = getProviderToolSupport({ model: 'llama', apiBase: 'http://localhost:11434/v1' });
      expect(result.supported).toBe(false);
    });
  });

  describe('shouldWarnAboutToolSupport', () => {
    it('warns when activeSkill is set', () => {
      expect(shouldWarnAboutToolSupport({ activeSkill: 'web_search' }, {})).toBe(true);
    });
    it('warns when tools are selected', () => {
      expect(shouldWarnAboutToolSupport({}, { selectedTools: ['web_search'] })).toBe(true);
    });
    it('does not warn by default', () => {
      expect(shouldWarnAboutToolSupport({}, {})).toBe(false);
    });
  });

  describe('filterStableBuiltInTools', () => {
    const tools = [
      { function: { name: 'web_search' } },
      { function: { name: 'read_file' } },
      { function: { name: 'run_code' } },
      { function: { name: 'unknown_tool' } },
    ];

    it('filters web_search without tavily key', () => {
      const filtered = filterStableBuiltInTools(tools, {});
      expect(filtered.map((t) => t.function.name)).not.toContain('web_search');
    });
    it('keeps web_search with tavily key', () => {
      const filtered = filterStableBuiltInTools(tools, { tavilyApiKey: 'tvly-test' });
      expect(filtered.map((t) => t.function.name)).toContain('web_search');
    });
    it('filters file tools without workspaceRoots', () => {
      const filtered = filterStableBuiltInTools(tools, {});
      expect(filtered.map((t) => t.function.name)).not.toContain('read_file');
    });
    it('keeps unknown tools', () => {
      const filtered = filterStableBuiltInTools(tools, {});
      expect(filtered.map((t) => t.function.name)).toContain('unknown_tool');
    });
  });

  describe('normalizeError', () => {
    it('returns 未知错误 for null', () => {
      expect(normalizeError(null)).toBe('未知错误');
    });
    it('returns 请求已取消 for AbortError', () => {
      const err = new Error('abort');
      err.name = 'AbortError';
      expect(normalizeError(err)).toBe('请求已取消');
    });
    it('truncates very long errors', () => {
      const err = new Error('x'.repeat(2000));
      expect(normalizeError(err).length).toBeLessThanOrEqual(1000);
    });
  });
});
