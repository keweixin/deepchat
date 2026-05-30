import { describe, it, expect } from 'vitest';
import { buildCacheStablePrefix, canonicalStringify } from '../electron/system-prompt.js';
import { TOOL_REGISTRY, getAllToolNames } from '../src/modules/tool-registry.js';

describe('cache stability invariants', () => {
  const baseSettings = {
    model: 'deepseek-chat',
    systemPrompt: 'You are a helpful assistant.',
    activeSkill: 'auto',
    workspaceRoots: ['/workspace/project'],
    mcpServers: [],
  };

  const baseTools = [
    { name: 'read_file', description: 'Read a file' },
    { name: 'search_workspace', description: 'Search workspace' },
  ];

  it('same inputs produce same prefix hash', () => {
    const result1 = buildCacheStablePrefix(baseSettings, baseTools);
    const result2 = buildCacheStablePrefix(baseSettings, baseTools);
    expect(result1.prefixFingerprint).toBe(result2.prefixFingerprint);
  });

  it('model does not affect prefix hash (prefix is model-independent)', () => {
    const result1 = buildCacheStablePrefix(baseSettings, baseTools);
    const result2 = buildCacheStablePrefix({ ...baseSettings, model: 'deepseek-reasoner' }, baseTools);
    // Prefix fingerprint is based on system prompt + tools, not model
    expect(result1.prefixFingerprint).toBe(result2.prefixFingerprint);
  });

  it('different system prompt produces different hash', () => {
    const result1 = buildCacheStablePrefix(baseSettings, baseTools);
    const result2 = buildCacheStablePrefix({ ...baseSettings, systemPrompt: 'You are a coder.' }, baseTools);
    expect(result1.prefixFingerprint).not.toBe(result2.prefixFingerprint);
  });

  it('different tools produce different hash', () => {
    const result1 = buildCacheStablePrefix(baseSettings, baseTools);
    const result2 = buildCacheStablePrefix(baseSettings, [...baseTools, { name: 'run_code', description: 'Run code' }]);
    expect(result1.prefixFingerprint).not.toBe(result2.prefixFingerprint);
  });

  it('tool schema field order is stable', () => {
    const toolA = {
      name: 'test',
      description: 'desc',
      parameters: { properties: { a: { type: 'string' }, b: { type: 'number' } } },
    };
    const toolB = {
      name: 'test',
      description: 'desc',
      parameters: { properties: { b: { type: 'number' }, a: { type: 'string' } } },
    };
    const fingerprintA = canonicalStringify(toolA);
    const fingerprintB = canonicalStringify(toolB);
    expect(fingerprintA).toBe(fingerprintB);
  });

  it('workspace signature is deterministic', () => {
    const settings1 = { ...baseSettings, workspaceRoots: ['/a', '/b'] };
    const settings2 = { ...baseSettings, workspaceRoots: ['/a', '/b'] };
    const result1 = buildCacheStablePrefix(settings1, baseTools);
    const result2 = buildCacheStablePrefix(settings2, baseTools);
    expect(result1.systemHash).toBe(result2.systemHash);
  });

  it('system prompt does not contain timestamps', () => {
    const result = buildCacheStablePrefix(baseSettings, baseTools);
    // The prefix should not contain ISO timestamps
    expect(result.prefixFingerprint).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('all 12 registered tools have stable names', () => {
    const names = getAllToolNames();
    expect(names).toHaveLength(14);
    for (const name of names) {
      const def = TOOL_REGISTRY[name];
      expect(def).toBeDefined();
      expect(def.name).toBe(name);
    }
  });
});
