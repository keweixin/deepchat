import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/modules/api.js', () => ({
  hasNativeBridge: () => false,
  getSettings: () => ({}),
  saveSettings: vi.fn(),
}));

import { sanitizeSettingsForBackup, loadConversations, saveConversations } from '../src/modules/client-store.ts';

describe('sanitizeSettingsForBackup', () => {
  it('removes apiKey from settings', () => {
    const result = sanitizeSettingsForBackup({ apiKey: 'sk-secret', theme: 'dark' });
    expect(result.apiKey).toBeUndefined();
    expect(result.theme).toBe('dark');
  });

  it('removes tavilyApiKey from settings', () => {
    const result = sanitizeSettingsForBackup({ tavilyApiKey: 'tvly-abc123' });
    expect(result.tavilyApiKey).toBeUndefined();
  });

  it('removes storageStatus from settings', () => {
    const result = sanitizeSettingsForBackup({ storageStatus: { ok: true } });
    expect(result.storageStatus).toBeUndefined();
  });

  it('sanitizes mcpServers args with secret-like values', () => {
    const result = sanitizeSettingsForBackup({
      mcpServers: [
        {
          id: 's1',
          name: 'test',
          command: 'node',
          args: ['--api-key', 'sk-abcdef1234567890'],
          enabled: true,
        },
      ],
    });
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0].args[1]).toBe('[REDACTED]');
  });

  it('preserves non-secret mcpServer args', () => {
    const result = sanitizeSettingsForBackup({
      mcpServers: [
        {
          id: 's1',
          name: 'test',
          command: 'node',
          args: ['server.js', '--port', '3000'],
          enabled: true,
        },
      ],
    });
    expect(result.mcpServers[0].args).toEqual(['server.js', '--port', '3000']);
  });

  it('filters out mcpServers without command', () => {
    const result = sanitizeSettingsForBackup({
      mcpServers: [{ id: 's1', name: 'test', command: '', args: [] }],
    });
    expect(result.mcpServers).toHaveLength(0);
  });

  it('handles null/undefined settings', () => {
    expect(sanitizeSettingsForBackup(null)).toEqual({});
    expect(sanitizeSettingsForBackup(undefined)).toEqual({});
  });

  it('redacts --token=secret format', () => {
    const result = sanitizeSettingsForBackup({
      mcpServers: [{ id: 's1', name: 'test', command: 'node', args: ['--token=ghp_abc123def456'], enabled: true }],
    });
    expect(result.mcpServers[0].args[0]).toBe('--token=[REDACTED]');
  });

  it('detects Bearer token patterns', () => {
    const result = sanitizeSettingsForBackup({
      mcpServers: [
        { id: 's1', name: 'test', command: 'node', args: ['Bearer eyJhbGciOiJIUzI1NiJ9.abc'], enabled: true },
      ],
    });
    expect(result.mcpServers[0].args[0]).toBe('[REDACTED]');
  });
});

describe('loadConversations', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty array when no data', async () => {
    const result = await loadConversations();
    expect(result).toEqual([]);
  });

  it('parses stored conversations', async () => {
    const convs = [{ id: '1', title: 'test' }];
    localStorage.setItem('dc_conversations', JSON.stringify(convs));
    const result = await loadConversations();
    // IndexedDB is unavailable in jsdom, so messages default to []
    expect(result).toEqual([{ id: '1', title: 'test', messages: [] }]);
  });

  it('returns empty array for invalid JSON', async () => {
    localStorage.setItem('dc_conversations', 'not-json');
    const result = await loadConversations();
    expect(result).toEqual([]);
  });

  it('returns empty array for non-array JSON', async () => {
    localStorage.setItem('dc_conversations', '{"foo": "bar"}');
    const result = await loadConversations();
    expect(result).toEqual([]);
  });
});

describe('saveConversations', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves conversations to localStorage', async () => {
    const convs = [{ id: '1', title: 'test' }];
    await saveConversations(convs);
    expect(JSON.parse(localStorage.getItem('dc_conversations'))).toEqual(convs);
  });

  it('saves empty array for non-array input', async () => {
    await saveConversations(null);
    expect(JSON.parse(localStorage.getItem('dc_conversations'))).toEqual([]);
  });
});
