import { afterEach, describe, expect, it } from 'vitest';
import {
  buildComposerContextPreview,
  buildComposerIntentPreview,
  buildComposerToolEntries,
  getComposerToolApprovalSummary,
  getComposerToolModeLabel,
  getComposerToolRisk,
  getComposerToolUnavailableReason,
  hasAnyToolConfigured,
  resolveActiveSkillForExplicitDirectives,
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
      toolApprovalPolicy: 'confirm_all',
      mcpServers: [],
    });

    expect(entries.find((entry) => entry.id === 'agent_auto')).toMatchObject({ available: true, active: true });
    expect(entries.find((entry) => entry.id === 'web_search')).toMatchObject({
      available: false,
      state: '需 Tavily Key',
    });
    expect(entries.find((entry) => entry.id === 'file_reader')).toMatchObject({ available: false, state: '需桌面版' });
    expect(entries.find((entry) => entry.id === 'multi_tool')).toMatchObject({ available: false, state: '需桌面版' });
    expect(entries.find((entry) => entry.id === 'none')).toMatchObject({ risk: '无工具' });
    expect(entries.find((entry) => entry.id === 'agent_auto')).toMatchObject({ risk: '自动判断' });
    expect(entries.find((entry) => entry.id === 'web_search')).toMatchObject({ risk: '低风险确认' });
    expect(entries.find((entry) => entry.id === 'code_runner')).toMatchObject({ risk: '高风险确认' });
    expect(entries.find((entry) => entry.id === 'multi_tool')).toMatchObject({ risk: '混合风险确认' });
  });

  it('labels tool risk according to the active approval policy', () => {
    const confirmAll = { toolApprovalPolicy: 'confirm_all' };
    const autoReadonly = { toolApprovalPolicy: 'auto_readonly' };

    expect(getComposerToolRisk('web_search', confirmAll)).toBe('低风险确认');
    expect(getComposerToolRisk('file_reader', autoReadonly)).toBe('低风险自动');
    expect(getComposerToolRisk('multi_tool', autoReadonly)).toBe('只读自动 · 高风险确认');
    expect(getComposerToolRisk('code_runner', autoReadonly)).toBe('高风险确认');
    expect(getComposerToolApprovalSummary(confirmAll)).toContain('所有工具调用');
    expect(getComposerToolApprovalSummary(autoReadonly)).toContain('低风险读取/搜索工具可自动通过');
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

  it('reflects auto-readonly approval policy in smart intent preview', () => {
    const readonly = buildComposerIntentPreview('检查当前项目的 package.json', {
      activeSkill: 'agent_auto',
      workspaceRoots: ['E:/repo'],
      tavilyApiKey: '',
      runCodeEnabled: true,
      toolApprovalPolicy: 'auto_readonly',
      mcpServers: [],
    });
    const mixed = buildComposerIntentPreview('@changed 检查项目并 @run 验证', {
      activeSkill: 'agent_auto',
      workspaceRoots: ['E:/repo'],
      tavilyApiKey: '',
      runCodeEnabled: true,
      toolApprovalPolicy: 'auto_readonly',
      mcpServers: [],
    });

    expect(readonly.text).toContain('只读工具可自动通过');
    expect(mixed.text).toContain('只读自动 · 高风险确认');
  });

  it('promotes explicit context directives to runnable tool modes before send', () => {
    window.deepchat = {} as any;
    const settings = {
      activeSkill: 'none',
      tavilyApiKey: 'tvly-test',
      workspaceRoots: ['E:/repo'],
      runCodeEnabled: true,
      mcpServers: [{ command: 'node', enabled: true }],
    };

    expect(resolveActiveSkillForExplicitDirectives('请查 @web 最新资料', settings, 'none')).toBe('web_search');
    expect(resolveActiveSkillForExplicitDirectives('读取 @file:src/main.js', settings, 'none')).toBe('file_reader');
    expect(resolveActiveSkillForExplicitDirectives('@run 验证这段逻辑', settings, 'none')).toBe('code_runner');
    expect(resolveActiveSkillForExplicitDirectives('@mcp 查询 issue', settings, 'none')).toBe('mcp_tool');
    expect(resolveActiveSkillForExplicitDirectives('@web @file:README.md 交叉检查', settings, 'none')).toBe(
      'multi_tool'
    );
  });

  it('keeps the fallback tool mode when explicit directives lack prerequisites', () => {
    const settings = {
      activeSkill: 'none',
      tavilyApiKey: '',
      workspaceRoots: [],
      runCodeEnabled: false,
      mcpServers: [],
    };

    expect(resolveActiveSkillForExplicitDirectives('@web 查资料', settings, 'agent_auto')).toBe('agent_auto');
    expect(resolveActiveSkillForExplicitDirectives('@file:README.md', settings, 'none')).toBe('none');
    expect(resolveActiveSkillForExplicitDirectives('普通问题', settings, 'agent_auto')).toBe('agent_auto');
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

  it('builds a send-time context preview with explicit context and tool policy chips', () => {
    window.deepchat = {} as any;
    const preview = buildComposerContextPreview('请检查 @file:src/main.js @symbol:sendMessage，并 @run 一个小实验', {
      activeSkill: 'agent_auto',
      workspaceRoots: ['E:/repo'],
      tavilyApiKey: 'tvly-test',
      runCodeEnabled: true,
      toolApprovalPolicy: 'auto_readonly',
      maxInputTokens: 24000,
      agentMaxRounds: 4,
      autoContextSummary: true,
      cacheOptimization: true,
      mcpServers: [{ name: 'github', command: 'node', enabled: true }],
    });

    expect(preview.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '工作区 1 个', tone: 'ready' }),
        expect.objectContaining({ label: '文件 src/main.js', kind: 'file' }),
        expect.objectContaining({ label: '符号 sendMessage', kind: 'symbol' }),
        expect.objectContaining({ label: '本地工具 read_file + read_symbol', kind: 'context-route', tone: 'ready' }),
        expect.objectContaining({ label: '工具 全工具' }),
        expect.objectContaining({ label: '代码运行需确认', tone: 'danger' }),
      ])
    );
    expect(preview.title).toContain('显式上下文');
    expect(preview.title).toContain('必要告警');
  });

  it('shows the effective tool mode from explicit directives in the context preview', () => {
    window.deepchat = {} as any;
    const web = buildComposerContextPreview('@web 查资料', {
      activeSkill: 'none',
      workspaceRoots: ['E:/repo'],
      tavilyApiKey: 'tvly-test',
      runCodeEnabled: true,
      mcpServers: [],
    });
    const localAndRun = buildComposerContextPreview('@file:src/main.js @run 验证', {
      activeSkill: 'none',
      workspaceRoots: ['E:/repo'],
      tavilyApiKey: '',
      runCodeEnabled: true,
      mcpServers: [],
    });

    expect(web.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '工具 联网检索', tone: 'ready' }),
        expect.objectContaining({ label: '联网可用', tone: 'ready' }),
      ])
    );
    expect(localAndRun.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '工具 全工具', tone: 'ready' }),
        expect.objectContaining({ label: '文件 src/main.js' }),
        expect.objectContaining({ label: '本地工具 read_file', tone: 'ready' }),
        expect.objectContaining({ label: '代码运行需确认', tone: 'danger' }),
      ])
    );
  });

  it('previews changed-context tool routes before send', () => {
    window.deepchat = {} as any;
    const ready = buildComposerContextPreview('@changed 最近改了什么', {
      activeSkill: 'agent_auto',
      workspaceRoots: ['E:/repo'],
      tavilyApiKey: '',
      runCodeEnabled: true,
      mcpServers: [],
    });
    const missing = buildComposerContextPreview('@changed 最近改了什么', {
      activeSkill: 'agent_auto',
      workspaceRoots: [],
      tavilyApiKey: '',
      runCodeEnabled: true,
      mcpServers: [],
    });

    expect(ready.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '本地工具 index_workspace + list_files + search_workspace + read_symbol + read_file',
          kind: 'context-route',
          tone: 'ready',
        }),
        expect.objectContaining({ label: '工具 文件分析', tone: 'ready' }),
      ])
    );
    expect(missing.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '未选工作区', tone: 'muted' }),
        expect.objectContaining({
          label: '本地工具 index_workspace + list_files + search_workspace + read_symbol + read_file',
          kind: 'context-route',
          tone: 'warning',
        }),
      ])
    );
  });

  it('shows MCP server status lights in the send-time context preview', () => {
    window.deepchat = {} as any;
    const preview = buildComposerContextPreview('请用 @mcp 查一下 issue 状态', {
      activeSkill: 'agent_auto',
      workspaceRoots: [],
      tavilyApiKey: '',
      runCodeEnabled: true,
      mcpServers: [
        { name: 'GitHub', command: 'node', enabled: true },
        { name: 'Notion', command: 'node', enabled: false },
        { name: 'Filesystem', command: '', enabled: true },
      ],
    });

    expect(preview.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'MCP 1 个待测试', tone: 'warning' }),
        expect.objectContaining({ label: 'MCP GitHub ×', tone: 'warning' }),
        expect.objectContaining({ label: 'MCP Notion ×', tone: 'warning' }),
        expect.objectContaining({ label: 'MCP Filesystem ×', tone: 'warning' }),
      ])
    );
    expect(preview.items.find((item) => item.label === 'MCP GitHub ×').title).toContain('尚未刷新');
    expect(preview.items.find((item) => item.label === 'MCP Notion ×').title).toContain('已关闭');
    expect(preview.items.find((item) => item.label === 'MCP Filesystem ×').title).toContain('缺少启动命令');
  });

  it('uses refreshed MCP status and tool counts in the context preview', () => {
    window.deepchat = {} as any;
    const preview = buildComposerContextPreview('帮我查外部系统记录', {
      activeSkill: 'multi_tool',
      workspaceRoots: [],
      tavilyApiKey: '',
      runCodeEnabled: true,
      mcpServers: [
        { id: 'mcp_github', name: 'GitHub', command: 'node', enabled: true },
        { id: 'mcp_notion', name: 'Notion', command: 'node', enabled: true },
      ],
      mcpStatuses: [
        {
          id: 'mcp_github',
          ok: true,
          toolCount: 7,
          schemaHash: 'abcdef123456',
          cacheExpiresAt: '2026-05-27T12:30:00.000Z',
        },
        {
          id: 'mcp_notion',
          ok: false,
          error: 'spawn failed',
        },
      ],
    });

    expect(preview.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'MCP 1/2 可用 · 7 工具', tone: 'ready' }),
        expect.objectContaining({ label: 'MCP GitHub ✓ 7', tone: 'ready' }),
        expect.objectContaining({ label: 'MCP Notion ×', tone: 'warning' }),
      ])
    );
    expect(preview.items.find((item) => item.label === 'MCP GitHub ✓ 7').title).toContain('schema abcdef12');
    expect(preview.items.find((item) => item.label === 'MCP Notion ×').title).toContain('spawn failed');
  });

  it('keeps hidden context preview items discoverable with an overflow chip', () => {
    window.deepchat = {} as any;
    const preview = buildComposerContextPreview(
      '@file:a.md @file:b.md @file:c.md @file:d.md @file:e.md @file:f.md @symbol:main 请用 @mcp @run @web 检查外部系统',
      {
        activeSkill: 'multi_tool',
        workspaceRoots: ['E:/repo'],
        tavilyApiKey: 'tvly-test',
        runCodeEnabled: true,
        maxInputTokens: 24000,
        agentMaxRounds: 5,
        autoContextSummary: true,
        cacheOptimization: true,
        mcpServers: [
          { name: 'GitHub', command: 'node', enabled: true },
          { name: 'Notion', command: 'node', enabled: false },
          { name: 'Filesystem', command: '', enabled: true },
          { name: 'Linear', command: 'node', enabled: true },
          { name: 'Docs', command: 'node', enabled: true },
        ],
      }
    );

    expect(preview.items).toHaveLength(12);
    const more = preview.items.at(-1);
    expect(more).toMatchObject({ kind: 'more' });
    expect(more.label).toMatch(/^另有 \d+ 项$/);
    expect(more.title).toContain('MCP');
  });

  it('warns in the context preview when explicit local context lacks a workspace', () => {
    const preview = buildComposerContextPreview('读取 @file:README.md', {
      activeSkill: 'agent_auto',
      workspaceRoots: [],
      tavilyApiKey: '',
      runCodeEnabled: true,
      mcpServers: [],
    });

    expect(preview.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '未选工作区', tone: 'muted' }),
        expect.objectContaining({ label: '文件 README.md', tone: 'warning' }),
        expect.objectContaining({ label: '本地工具 read_file', kind: 'context-route', tone: 'warning' }),
      ])
    );
  });

  it('does not show missing workspace noise for ordinary chat', () => {
    const preview = buildComposerContextPreview('帮我解释一下 token cache', {
      activeSkill: 'agent_auto',
      workspaceRoots: [],
      tavilyApiKey: '',
      runCodeEnabled: true,
      mcpServers: [],
    });

    expect(preview.items.some((item) => item.label === '未选工作区')).toBe(false);
    expect(preview.items).toHaveLength(0);
  });

  it('shows disabled summary and cache warnings before send', () => {
    const preview = buildComposerContextPreview('帮我整理这段内容', {
      activeSkill: 'none',
      workspaceRoots: [],
      tavilyApiKey: '',
      runCodeEnabled: true,
      maxInputTokens: 4096,
      autoContextSummary: false,
      cacheOptimization: false,
      mcpServers: [],
    });

    expect(preview.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '输入预算偏低 4.1k', tone: 'warning' }),
        expect.objectContaining({ label: '自动摘要关闭', tone: 'muted' }),
        expect.objectContaining({ label: '缓存优化关闭', tone: 'warning' }),
      ])
    );
    expect(preview.items.some((item) => /^Agent /.test(item.label))).toBe(false);
  });

  it('keeps composer intent preview quiet outside smart agent mode', () => {
    const preview = buildComposerIntentPreview('最新新闻', {
      activeSkill: 'none',
      tavilyApiKey: 'tvly-test',
    });

    expect(preview).toMatchObject({ state: 'idle', text: '' });
  });

  it('enables desktop workspace, code, mcp, and multi-tool entries when configured', () => {
    window.deepchat = {} as any;
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
    window.deepchat = {} as any;

    expect(getComposerToolModeLabel('multi_tool')).toBe('全工具');
    expect(getComposerToolModeLabel('unknown')).toBe('标准');
    expect(getComposerToolUnavailableReason('code_runner', { runCodeEnabled: false })).toBe('代码运行已关闭');
  });
});
