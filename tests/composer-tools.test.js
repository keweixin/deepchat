import { afterEach, describe, expect, it } from 'vitest';
import {
  buildComposerIntentPreview,
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

  it('previews agent_auto tool intent and missing prerequisites before send', () => {
    const missing = buildComposerIntentPreview('帮我读取 README 并检查 package.json', {
      activeSkill: 'agent_auto',
      workspaceRoots: [],
      tavilyApiKey: '',
      runCodeEnabled: true,
      mcpServers: [],
    });
    const ready = buildComposerIntentPreview('最新 DeepSeek cache pricing 查一下', {
      activeSkill: 'agent_auto',
      workspaceRoots: [],
      tavilyApiKey: 'tvly-test',
      runCodeEnabled: true,
      mcpServers: [],
    });

    expect(missing.state).toBe('warning');
    expect(missing.text).toContain('工作区文件');
    expect(missing.text).toContain('缺 工作区目录');
    expect(ready.state).toBe('tool');
    expect(ready.text).toContain('联网搜索');
    expect(ready.text).toContain('执行前会确认');
  });

  it('previews generic project advice as chat but local project checks as file work', () => {
    const settings = {
      activeSkill: 'agent_auto',
      workspaceRoots: ['E:/repo'],
      tavilyApiKey: '',
      runCodeEnabled: true,
      mcpServers: [],
    };

    const generic = buildComposerIntentPreview('帮我设计一个项目学习计划', settings);
    const localProject = buildComposerIntentPreview('检查当前项目的 package.json', settings);

    expect(generic).toMatchObject({ state: 'chat', text: '预判：普通聊天' });
    expect(localProject.state).toBe('tool');
    expect(localProject.text).toContain('工作区文件');
  });

  it('keeps composer intent preview quiet outside smart agent mode', () => {
    const preview = buildComposerIntentPreview('最新新闻', {
      activeSkill: 'none',
      tavilyApiKey: 'tvly-test',
    });

    expect(preview).toMatchObject({ state: 'idle', text: '' });
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
