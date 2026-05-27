import { afterEach, describe, expect, it } from 'vitest';
import {
  buildComposerToolEntries,
  getComposerToolModeLabel,
  getComposerToolUnavailableReason,
  hasAnyToolConfigured,
} from '../src/modules/composer-tools.js';

describe('composer tool drawer helpers', () => {
  afterEach(() => {
    delete window.deepchat;
  });

  it('shows browser-safe tool availability and missing configuration reasons', () => {
    const entries = buildComposerToolEntries({
      activeSkill: 'agent_auto',
      tavilyApiKey: '',
      workspaceRoots: [],
      runCodeEnabled: true,
      mcpServers: [],
    });

    expect(entries.find((entry) => entry.id === 'agent_auto')).toMatchObject({ available: true, active: true });
    expect(entries.find((entry) => entry.id === 'web_search')).toMatchObject({ available: false, state: '需 Tavily Key' });
    expect(entries.find((entry) => entry.id === 'file_reader')).toMatchObject({ available: false, state: '需桌面版' });
    expect(entries.find((entry) => entry.id === 'multi_tool')).toMatchObject({ available: false, state: '需桌面版' });
  });

  it('enables desktop workspace, code, mcp, and multi-tool entries when configured', () => {
    window.deepchat = {};
    const settings = {
      activeSkill: 'file_reader',
      tavilyApiKey: '',
      workspaceRoots: ['E:/repo'],
      runCodeEnabled: true,
      mcpServers: [{ name: 'github', command: 'node', enabled: true }],
    };

    const entries = buildComposerToolEntries(settings, 'file_reader');

    expect(entries.find((entry) => entry.id === 'file_reader')).toMatchObject({ available: true, active: true });
    expect(entries.find((entry) => entry.id === 'code_runner')).toMatchObject({ available: true });
    expect(entries.find((entry) => entry.id === 'mcp_tool')).toMatchObject({ available: true });
    expect(entries.find((entry) => entry.id === 'multi_tool')).toMatchObject({ available: true });
    expect(hasAnyToolConfigured(settings)).toBe(true);
  });

  it('labels tool modes and explains disabled code execution', () => {
    window.deepchat = {};

    expect(getComposerToolModeLabel('multi_tool')).toBe('全工具');
    expect(getComposerToolModeLabel('unknown')).toBe('标准');
    expect(getComposerToolUnavailableReason('code_runner', { runCodeEnabled: false })).toBe('代码运行已关闭');
  });
});
