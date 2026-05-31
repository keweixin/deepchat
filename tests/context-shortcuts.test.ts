import { afterEach, describe, expect, it } from 'vitest';
import {
  buildContextShortcutEntries,
  formatContextMentionTitle,
  getContextShortcutUnavailableReason,
} from '../src/modules/context-shortcuts.js';

describe('context shortcut helpers', () => {
  afterEach(() => {
    delete window.deepchat;
  });

  it('marks local context shortcuts unavailable in browser fallback', () => {
    const entries = buildContextShortcutEntries({
      workspaceRoots: ['E:/repo'],
      tavilyApiKey: '',
      mcpServers: [],
    });

    expect(entries.find((entry) => entry.id === 'file')).toMatchObject({ available: false, state: '需桌面版' });
    expect(entries.find((entry) => entry.id === 'symbol')).toMatchObject({ available: false, state: '需桌面版' });
    expect(entries.find((entry) => entry.id === 'web')).toMatchObject({ available: false, state: '需 Tavily Key' });
  });

  it('enables context shortcuts when desktop prerequisites exist', () => {
    window.deepchat = {} as any;
    const entries = buildContextShortcutEntries({
      workspaceRoots: ['E:/repo'],
      tavilyApiKey: 'tvly-test',
      runCodeEnabled: true,
      mcpServers: [{ command: 'node', enabled: true }],
    });

    expect(entries.find((entry) => entry.id === 'file')).toMatchObject({
      available: true,
      insertText: '@file:"src/path/to/file"',
    });
    expect(entries.find((entry) => entry.id === 'folder')).toMatchObject({ available: true });
    expect(entries.find((entry) => entry.id === 'symbol')).toMatchObject({ available: true, selectStartOffset: 8 });
    expect(entries.find((entry) => entry.id === 'web')).toMatchObject({ available: true });
    expect(entries.find((entry) => entry.id === 'mcp')).toMatchObject({ available: true });
  });

  it('formats mention titles by type', () => {
    expect(
      formatContextMentionTitle([
        { type: 'file', path: 'src/main.js' },
        { type: 'folder', path: 'src/modules' },
        { type: 'symbol', path: 'detectAgentIntent' },
      ])
    ).toBe(['文件：src/main.js', '目录：src/modules', '符号：detectAgentIntent'].join('\n'));
  });

  it('explains disabled code and MCP shortcuts', () => {
    window.deepchat = {} as any;

    expect(getContextShortcutUnavailableReason('run', { runCodeEnabled: false })).toBe('代码运行已关闭');
    expect(getContextShortcutUnavailableReason('mcp', { mcpServers: [] })).toBe('需 MCP');
  });
});
