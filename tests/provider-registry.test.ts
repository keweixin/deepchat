/**
 * Provider Registry Tests
 */

import { describe, it, expect } from 'vitest';
import {
  PROVIDER_REGISTRY,
  getProviderById,
  getProviderByModel,
  getModelInfo,
  getToolUnavailableReason,
  getCapabilityMatrix,
  getModelBadge,
} from '../src/modules/provider-registry.js';

describe('PROVIDER_REGISTRY', () => {
  it('contains known providers', () => {
    const ids = PROVIDER_REGISTRY.map((p) => p.id);
    expect(ids).toContain('deepseek');
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('gemini');
    expect(ids).toContain('custom');
  });

  it('all providers have required fields', () => {
    for (const p of PROVIDER_REGISTRY) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(typeof p.supportsNativeTools).toBe('boolean');
      expect(typeof p.maxContextTokens).toBe('number');
    }
  });
});

describe('getProviderById', () => {
  it('finds deepseek', () => {
    const p = getProviderById('deepseek');
    expect(p).toBeTruthy();
    expect(p.name).toBe('DeepSeek');
  });

  it('returns null for unknown id', () => {
    expect(getProviderById('nonexistent')).toBeNull();
  });
});

describe('getProviderByModel', () => {
  it('matches deepseek-chat', () => {
    const p = getProviderByModel('deepseek-chat');
    expect(p).toBeTruthy();
    expect(p.id).toBe('deepseek');
  });

  it('matches gpt-4o', () => {
    const p = getProviderByModel('gpt-4o');
    expect(p).toBeTruthy();
    expect(p.id).toBe('openai');
  });

  it('matches claude-3-5-sonnet', () => {
    const p = getProviderByModel('claude-3-5-sonnet');
    expect(p).toBeTruthy();
    expect(p.id).toBe('anthropic');
  });

  it('returns null for empty model', () => {
    expect(getProviderByModel('')).toBeNull();
    expect(getProviderByModel(null)).toBeNull();
  });
});

describe('getModelInfo', () => {
  it('returns info for deepseek-chat', () => {
    const info = getModelInfo('deepseek-chat');
    expect(info).toBeTruthy();
    expect(info.name).toBe('DeepSeek Chat');
    expect(info.providerId).toBe('deepseek');
  });

  it('returns info for unknown model in known provider', () => {
    const info = getModelInfo('deepseek-unknown');
    expect(info).toBeTruthy();
    expect(info.providerId).toBe('deepseek');
  });

  it('returns null for empty model', () => {
    expect(getModelInfo('')).toBeNull();
  });
});

describe('getToolUnavailableReason', () => {
  it('returns reason for missing model', () => {
    expect(getToolUnavailableReason({})).toBe('未选择模型');
  });

  it('returns null for tool-capable model', () => {
    expect(getToolUnavailableReason({ model: 'deepseek-chat' })).toBeNull();
  });

  it('returns known issue for reasoner+tools conflict', () => {
    const reason = getToolUnavailableReason({ model: 'deepseek-reasoner' });
    expect(reason).toContain('reasoner');
  });
});

describe('getCapabilityMatrix', () => {
  it('returns matrix for deepseek-chat', () => {
    const matrix = getCapabilityMatrix({ model: 'deepseek-chat' });
    expect(matrix.length).toBeGreaterThan(0);
    const tools = matrix.find((m) => m.label === '原生工具');
    expect(tools).toBeTruthy();
    expect(tools.value).toBe('支持');
  });

  it('returns fallback for unknown model', () => {
    const matrix = getCapabilityMatrix({ model: 'unknown-model-xyz' });
    expect(matrix.length).toBeGreaterThan(0);
  });
});

describe('getModelBadge', () => {
  it('returns model name for deepseek', () => {
    const badge = getModelBadge({ model: 'deepseek-chat' });
    expect(badge).toContain('DeepSeek Chat');
    expect(badge).toContain('🛠');
  });

  it('returns raw model for unknown', () => {
    const badge = getModelBadge({ model: 'unknown' });
    expect(badge).toBe('unknown');
  });

  it('returns default for empty', () => {
    expect(getModelBadge({})).toBe('未配置');
  });
});
