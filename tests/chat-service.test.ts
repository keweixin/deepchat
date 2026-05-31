// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChatService,
  buildAgentPlanSummary,
  buildResearchSearchPlan,
  compactToolOutputForContext,
  compactToolOutputWithMetadata,
  buildCacheStabilityDiagnostics,
  detectAgentIntent,
  mergeTokenUsage,
  normalizeTokenUsage,
} from '../electron/chat-service.js';

describe('electron chat service token usage and agent loop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('requests streamed usage and parses provider usage chunks', async () => {
    const service = new ChatService(() => fakeWindow());
    const response = [
      sse({ choices: [{ delta: { content: 'Hello' } }], usage: null }),
      sse({
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          prompt_cache_hit_tokens: 8,
          prompt_cache_miss_tokens: 4,
        },
      }),
      'data: [DONE]\n\n',
    ].join('');

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: streamFromText(response),
    });

    const result = await service.streamOnce(
      'req-1',
      [{ role: 'user', content: 'hi' }],
      baseSettings(),
      [],
      new AbortController().signal
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(result.content).toBe('Hello');
    expect(result.usage).toMatchObject({
      input: 12,
      output: 3,
      total: 15,
      cacheHit: 8,
      cacheMiss: 4,
      cacheHitRate: 8 / 12,
      source: 'provider',
    });
  });

  it('suppresses NEEDS_PRO from streamed text while preserving the upgrade signal', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    const response = [
      sse({ choices: [{ delta: { content: 'NE' } }] }),
      sse({ choices: [{ delta: { content: 'EDS_PRO' } }] }),
      sse({ choices: [{ delta: { content: 'Use the pro path.' } }] }),
      'data: [DONE]\n\n',
    ].join('');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: streamFromText(response),
    });

    const result = await service.streamOnce(
      'req-needs-pro-stream',
      [{ role: 'user', content: 'hard task' }],
      baseSettings({ agentModelTier: 'auto' }),
      [],
      new AbortController().signal
    );

    expect(result).toMatchObject({ content: 'Use the pro path.', needsPro: true });
    expect(
      events
        .filter((event) => event.type === 'token')
        .map((event) => event.token)
        .join('')
    ).toBe('Use the pro path.');
  });

  it('aggregates usage across agent tool rounds and emits the total usage', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    let round = 0;
    service.streamOnce = vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return {
          content: '',
          thinking: '',
          usage: normalizeTokenUsage({ prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 }),
          toolCalls: [{ id: 'tool-1', function: { name: 'web_search', arguments: '{}' } }],
        };
      }
      return {
        content: 'done',
        thinking: '',
        usage: normalizeTokenUsage({ prompt_tokens: 25, completion_tokens: 5, total_tokens: 30 }),
        toolCalls: [],
      };
    });
    service.handleToolCall = vi.fn(async () => 'tool output');

    await service.runWithSettings(
      { requestId: 'req-2', messages: [{ role: 'user', content: 'search' }] },
      baseSettings({ agentMaxRounds: 1 }),
      new AbortController()
    );

    const tokenEvent = events.find((event) => event.type === 'tokenCount');
    expect(tokenEvent).toMatchObject({
      input: 45,
      output: 7,
      total: 52,
      rounds: 2,
      source: 'provider',
    });
  });

  it('upgrades to the inferred pro model only when auto tier sees NEEDS_PRO', async () => {
    const events = [];
    const models = [];
    const service = new ChatService(() => fakeWindow(events));
    service.streamOnce = vi.fn(async (_requestId, _messages, settings) => {
      models.push(settings.model);
      if (models.length === 1) {
        return {
          content: 'NEEDS_PRO',
          thinking: '',
          needsPro: true,
          usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
          toolCalls: [],
        };
      }
      return {
        content: 'done',
        thinking: '',
        usage: normalizeTokenUsage({ prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 }),
        toolCalls: [],
      };
    });

    await service.runWithSettings(
      { requestId: 'req-needs-pro-upgrade', messages: [{ role: 'user', content: '复杂任务' }] },
      baseSettings({ agentModelTier: 'auto', model: 'deepseek-v4-flash', agentMaxRounds: 2 }),
      new AbortController()
    );

    expect(models).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro']);
    expect(events.find((event) => event.type === 'agentStage' && event.stage === 'model_upgrade')).toMatchObject({
      fromModel: 'deepseek-v4-flash',
      toModel: 'deepseek-v4-pro',
      stopReason: 'needs_pro',
    });
  });

  it('does not override fixed model tiers when NEEDS_PRO appears', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.streamOnce = vi.fn(async () => ({
      content: 'NEEDS_PRO',
      thinking: '',
      needsPro: true,
      usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
      toolCalls: [],
    }));

    await service.runWithSettings(
      { requestId: 'req-needs-pro-fixed', messages: [{ role: 'user', content: '复杂任务' }] },
      baseSettings({ agentModelTier: 'flash', model: 'deepseek-v4-flash', agentMaxRounds: 2 }),
      new AbortController()
    );

    expect(service.streamOnce).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'agentStage' && event.stage === 'warning')).toMatchObject({
      stopReason: 'needs_pro_not_upgraded',
    });
  });

  it('stops with a clear error when agent tool rounds exceed the configured limit', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.streamOnce = vi.fn(async (_requestId, _messages, _settings, _tools) => ({
      content: '',
      thinking: '',
      usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
      toolCalls: [
        { id: `tool-${service.streamOnce.mock.calls.length}`, function: { name: 'web_search', arguments: '{}' } },
      ],
    }));
    service.handleToolCall = vi.fn(async () => 'tool output');

    await service.runWithSettings(
      { requestId: 'req-3', messages: [{ role: 'user', content: 'loop' }] },
      baseSettings({ agentMaxRounds: 1 }),
      new AbortController()
    );

    const doneEvent = events.find((event) => event.type === 'done');
    expect(doneEvent).toMatchObject({ aborted: false, stopReason: expect.stringContaining('工具调用超过 1 轮') });

    const tokenEvent = events.find((event) => event.type === 'tokenCount');
    expect(tokenEvent).toMatchObject({
      input: 20,
      output: 2,
      total: 22,
      rounds: 2,
    });
  });

  it('hard-stops after one tool round in single-step agent execution mode', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.streamOnce = vi.fn(async () => ({
      content: '',
      thinking: '',
      usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
      toolCalls: [{ id: 'tool-single', function: { name: 'web_search', arguments: '{"query":"DeepChat"}' } }],
    }));
    service.handleToolCall = vi.fn(async () => 'tool output');

    await service.runWithSettings(
      { requestId: 'req-single-step', messages: [{ role: 'user', content: '先查一步' }] },
      baseSettings({ agentMaxRounds: 3, agentExecutionMode: 'single_step', tavilyApiKey: 'tvly-test' }),
      new AbortController()
    );

    expect(service.streamOnce).toHaveBeenCalledTimes(1);
    expect(service.handleToolCall).toHaveBeenCalledTimes(1);
    expect(
      events.some((event) => event.type === 'token' && String(event.token).includes('已完成单步执行：web_search'))
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'agentStage' &&
          event.stage === 'stop' &&
          String(event.stopReason).includes('已暂停后续工具轮次')
      )
    ).toBe(true);
    expect(events.find((event) => event.type === 'done')).toMatchObject({ stopReason: 'single_step' });
  });

  it('merges usage through the electron helper too', () => {
    expect(
      mergeTokenUsage([
        { input: 10, output: 1, total: 11, cacheHit: 5, cacheMiss: 5, source: 'provider' },
        { input: 5, output: 4, total: 9, cacheHit: 0, cacheMiss: 5, source: 'estimated' },
      ])
    ).toMatchObject({
      input: 15,
      output: 5,
      total: 20,
      cacheHit: 5,
      cacheMiss: 10,
      source: 'mixed',
      rounds: 2,
    });
  });

  it('retries once without stream_options when a compatible provider rejects usage streaming', async () => {
    const service = new ChatService(() => fakeWindow());
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'unsupported parameter stream_options' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: streamFromText([sse({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n'].join('')),
      });

    const result = await service.streamOnce(
      'req-fallback',
      [{ role: 'user', content: 'hi' }],
      baseSettings(),
      [],
      new AbortController().signal
    );
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);

    expect(firstBody.stream_options).toEqual({ include_usage: true });
    expect(secondBody.stream_options).toBeUndefined();
    expect(result.content).toBe('ok');
    expect(result.warnings[0]).toContain('stream_options');
  });

  it('repairs tool calls emitted as JSON in assistant content', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      body: streamFromText(
        [
          sse({
            choices: [
              { delta: { content: '```json\n{"tool":"web_search","arguments":{"query":"DeepSeek cache hit"}}\n```' } },
            ],
          }),
          'data: [DONE]\n\n',
        ].join('')
      ),
    });

    const result = await service.streamOnce(
      'req-repair-content',
      [{ role: 'user', content: '搜索 DeepSeek cache hit' }],
      baseSettings({ tavilyApiKey: 'tvly-test' }),
      [{ type: 'function', function: { name: 'web_search', parameters: {} } }],
      new AbortController().signal
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"DeepSeek cache hit"}' },
    });
    expect(result.warnings.join('\n')).toContain('修复 1 个工具调用');
    expect(events.some((event) => event.type === 'agentStage' && event.stage === 'tool_repair')).toBe(true);
  });

  it('repairs tool calls emitted in reasoning content only when the tool is allowed', async () => {
    const service = new ChatService(() => fakeWindow());
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          [
            sse({
              choices: [
                {
                  delta: {
                    reasoning_content: '<tool_call>{"name":"read_file","args":{"path":"README.md"}}</tool_call>',
                  },
                },
              ],
            }),
            'data: [DONE]\n\n',
          ].join('')
        ),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: streamFromText(
          [
            sse({
              choices: [
                {
                  delta: {
                    reasoning_content: '<tool_call>{"name":"read_file","args":{"path":"README.md"}}</tool_call>',
                  },
                },
              ],
            }),
            'data: [DONE]\n\n',
          ].join('')
        ),
      });

    const blocked = await service.streamOnce(
      'req-repair-thinking',
      [{ role: 'user', content: '读 README' }],
      baseSettings({ workspaceRoots: ['E:\\demo'] }),
      [{ type: 'function', function: { name: 'web_search', parameters: {} } }],
      new AbortController().signal
    );
    const repaired = await service.streamOnce(
      'req-repair-thinking-allowed',
      [{ role: 'user', content: '读 README' }],
      baseSettings({ workspaceRoots: ['E:\\demo'] }),
      [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
      new AbortController().signal
    );

    expect(blocked.toolCalls).toEqual([]);
    expect(blocked.warnings.join('\n')).not.toContain('修复');
    expect(repaired.toolCalls[0]).toMatchObject({
      function: { name: 'read_file', arguments: '{"path":"README.md"}' },
    });
  });

  it('detects file and code intent for smart agent mode', () => {
    const intent = detectAgentIntent('检查 E:\\demo\\package.json 并运行测试', {
      workspaceRoots: ['E:\\demo'],
      mcpServers: [],
    });

    expect(intent.toolMode).toBe('multi_tool');
    expect(intent.selectedTools).toContain('index_workspace');
    expect(intent.selectedTools).toContain('read_file');
    expect(intent.selectedTools).toContain('read_symbol');
    expect(intent.selectedTools).toContain('search_workspace');
    expect(intent.selectedTools).toContain('run_code');
  });

  it('detects coding edit intent and exposes edit tools only with workspace permission', async () => {
    const service = new ChatService(() => fakeWindow());
    const settings = baseSettings({
      activeSkill: 'agent_auto',
      workspaceRoots: ['E:\\demo'],
      codingEditsEnabled: true,
    });
    const intent = detectAgentIntent('请修改 src/main.ts 修复这个问题', settings);
    const tools = await service.getAvailableTools(settings, intent);
    const names = tools.map((tool) => tool.function.name);

    expect(intent.selectedTools).toEqual(expect.arrayContaining(['edit_file', 'multi_edit', 'read_file']));
    expect(names).toEqual(expect.arrayContaining(['edit_file', 'multi_edit']));

    const disabled = await service.getAvailableTools({ ...settings, codingEditsEnabled: false }, intent);
    expect(disabled.map((tool) => tool.function.name)).not.toContain('edit_file');
  });

  it('keeps year-only explanation prompts in plain chat while searching year-scoped facts', () => {
    const plain = detectAgentIntent('解释 2024 年 JavaScript 闭包这个概念', {
      tavilyApiKey: 'tvly-test',
      workspaceRoots: [],
      mcpServers: [],
    });
    const externalFacts = detectAgentIntent('查询 2024 年 DeepSeek 版本发布资料和来源', {
      tavilyApiKey: 'tvly-test',
      workspaceRoots: [],
      mcpServers: [],
    });

    expect(plain.toolMode).toBe('none');
    expect(plain.selectedTools).not.toContain('web_search');
    expect(externalFacts.toolMode).toBe('web_search');
    expect(externalFacts.selectedTools).toContain('web_search');
  });

  it('does not route generic project advice through workspace tools', () => {
    const settings = baseSettings({
      tavilyApiKey: '',
      workspaceRoots: ['E:/repo'],
      mcpServers: [],
    });

    const generic = detectAgentIntent('帮我设计一个 6 周项目学习计划', settings);
    const localProject = detectAgentIntent('检查当前项目的 package.json 和依赖配置', settings);
    const pathTarget = detectAgentIntent('读取 E:\\demo\\README.md 并总结', settings);

    expect(generic.toolMode).toBe('none');
    expect(generic.selectedTools).not.toContain('read_file');
    expect(localProject.toolMode).toBe('file_reader');
    expect(localProject.selectedTools).toEqual(
      expect.arrayContaining(['index_workspace', 'list_files', 'search_workspace', 'read_file'])
    );
    expect(pathTarget.toolMode).toBe('file_reader');
    expect(pathTarget.selectedTools).toContain('read_file');
  });

  it('honors explicit tool directives in native agent intent', () => {
    const intent = detectAgentIntent('@changed 看最近修改并 @web 查最新资料', {
      activeSkill: 'agent_auto',
      tavilyApiKey: 'tvly-test',
      workspaceRoots: ['E:/repo'],
      runCodeEnabled: true,
      mcpServers: [],
    });

    expect(intent.toolMode).toBe('multi_tool');
    expect(intent.explicitDirectives).toEqual(expect.arrayContaining(['web', 'changed']));
    expect(intent.selectedTools).toEqual(
      expect.arrayContaining(['web_search', 'index_workspace', 'list_files', 'search_workspace', 'read_file'])
    );
    expect(intent.reason).toContain('explicit_web');
    expect(intent.reason).toContain('explicit_changed_context');
  });

  it('builds a readable agent plan summary from detected intent and tools', () => {
    const settings = baseSettings({
      activeSkill: 'agent_auto',
      tavilyApiKey: 'tvly-test',
      workspaceRoots: ['E:/repo'],
      runCodeEnabled: true,
    });
    const intent = detectAgentIntent('@web @changed 检查项目并运行验证', settings);
    const plan = buildAgentPlanSummary(
      intent,
      [
        { type: 'function', function: { name: 'web_search' } },
        { type: 'function', function: { name: 'index_workspace' } },
        { type: 'function', function: { name: 'read_file' } },
        { type: 'function', function: { name: 'run_code' } },
      ],
      settings,
      4,
      '@web @changed 检查项目并运行验证'
    );

    expect(plan).toMatchObject({
      type: 'deepchat.agentPlan',
      version: 1,
      mode: 'multi_tool',
      maxRounds: 4,
    });
    expect(plan.steps.join('\n')).toContain('检索外部资料');
    expect(plan.steps.join('\n')).toContain('轻量索引');
    expect(plan.steps.join('\n')).toContain('最近 7 天修改');
    expect(plan.steps.join('\n')).toContain('关键变更文件');
    expect(plan.steps.join('\n')).toContain('运行小段代码');
    expect(plan.selectedTools).toEqual(
      expect.arrayContaining(['web_search', 'index_workspace', 'read_file', 'run_code'])
    );
    expect(plan.availableToolNames).toEqual(['index_workspace', 'read_file', 'run_code', 'web_search']);
    expect(plan.searchPlan.map((item) => item.purpose)).toContain('官方资料');
    expect(plan.approvalPolicy.join('\n')).toContain('代码运行必须确认');
    expect(plan.warnings.join('\n')).toContain('只按文件修改时间判断');
  });

  it('builds multi-query research search plans for web agent tasks', () => {
    const plan = buildResearchSearchPlan(
      '请联网研究 DeepSeek Reasonix cache 命中优化方案和 GitHub 实现',
      {
        selectedTools: ['web_search'],
        candidateTools: ['web_search'],
      },
      baseSettings({ tavilyApiKey: 'tvly-test' })
    );

    expect(plan.length).toBeGreaterThanOrEqual(3);
    expect(plan.map((item) => item.purpose)).toEqual(
      expect.arrayContaining(['官方资料', 'GitHub / Issue', '对比资料'])
    );
    expect(plan[0].query).toContain('official documentation');
    expect(plan.some((item) => item.query.includes('GitHub issues'))).toBe(true);
  });

  it('emits agent plan summaries before model streaming', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.streamOnce = vi.fn(async () => ({
      content: 'done',
      thinking: '',
      usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 2 }),
      toolCalls: [],
    }));

    await service.runWithSettings(
      { requestId: 'req-plan-summary', messages: [{ role: 'user', content: '@changed 检查当前项目' }] },
      baseSettings({ activeSkill: 'agent_auto', workspaceRoots: ['E:\\demo'] }),
      new AbortController()
    );

    const planEvent = events.find((event) => event.type === 'agentStage' && event.stage === 'plan');
    expect(planEvent.planSummary).toMatchObject({
      type: 'deepchat.agentPlan',
      mode: 'file_reader',
      selectedTools: expect.arrayContaining(['index_workspace', 'list_files', 'search_workspace', 'read_file']),
    });
    expect(planEvent.planSummary.steps.join('\n')).toContain('轻量索引');
    expect(planEvent.planSummary.steps.join('\n')).toContain('最近 7 天修改');
    expect(planEvent.planSummary.steps.join('\n')).toContain('关键变更文件');
    expect(planEvent.planSummary.approvalPolicy.join('\n')).toContain('读取/搜索类工具');
    expect(planEvent.planSummary.warnings.join('\n')).toContain('只按文件修改时间判断');
  });

  it('injects smart-agent search plans into volatile turn metadata', async () => {
    const service = new ChatService(() => fakeWindow());
    let sentMessages = [];
    service.streamOnce = vi.fn(async (_requestId, messages) => {
      sentMessages = messages;
      return {
        content: 'done',
        thinking: '',
        usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 2 }),
        toolCalls: [],
      };
    });

    await service.runWithSettings(
      {
        requestId: 'req-search-plan-tail',
        messages: [{ role: 'user', content: '@web 研究 DeepSeek Reasonix cache 命中优化' }],
      },
      baseSettings({ activeSkill: 'agent_auto', tavilyApiKey: 'tvly-test' }),
      new AbortController()
    );

    expect(sentMessages.at(-1).content).toContain('DeepChat 本轮联网搜索计划');
    expect(sentMessages.at(-1).content).toContain('official documentation');
    expect(sentMessages.at(-1).content).toContain('web_search');
  });

  it('requires MCP task intent instead of routing bare product mentions', () => {
    const settings = baseSettings({
      workspaceRoots: [],
      tavilyApiKey: '',
      mcpServers: [{ name: 'github', command: 'node', enabled: true }],
    });

    const plain = detectAgentIntent('解释 GitHub Actions 的常见用法', settings);
    const createIssue = detectAgentIntent('在 GitHub 创建 issue 记录登录失败', settings);
    const explicit = detectAgentIntent('@mcp 查询 GitHub issue', settings);

    expect(plain.selectedTools).not.toContain('mcp');
    expect(plain.candidateTools).not.toContain('mcp');
    expect(createIssue.toolMode).toBe('mcp_tool');
    expect(createIssue.selectedTools).toContain('mcp');
    expect(explicit.toolMode).toBe('mcp_tool');
    expect(explicit.reason).toContain('explicit_mcp');
  });

  it('keeps the cache prefix stable across different smart-agent intents when tools are available', async () => {
    const service = new ChatService(() => fakeWindow());
    const settings = baseSettings({
      activeSkill: 'agent_auto',
      cacheOptimization: true,
      tavilyApiKey: 'tvly-test',
      workspaceRoots: ['E:\\demo'],
    });
    const seen = [];
    service.streamOnce = vi.fn(async (_requestId, messages, _settings, tools) => {
      seen.push({
        system: messages[0].content,
        tools: tools.map((tool) => tool.function.name),
      });
      return {
        content: 'ok',
        thinking: '',
        usage: normalizeTokenUsage(null, { input: 1, output: 1, model: settings.model }),
        toolCalls: [],
      };
    });

    await service.runWithSettings(
      { requestId: 'req-cache-a', messages: [{ role: 'user', content: '搜索今天新闻' }] },
      settings,
      new AbortController()
    );
    await service.runWithSettings(
      { requestId: 'req-cache-b', messages: [{ role: 'user', content: '检查 E:\\demo\\package.json 并运行测试' }] },
      settings,
      new AbortController()
    );

    expect(seen[0].system).toBe(seen[1].system);
    expect(seen[0].tools).toEqual(seen[1].tools);
    expect(seen[0].tools).toEqual(
      expect.arrayContaining(['web_search', 'list_files', 'search_workspace', 'read_file', 'run_code'])
    );
  });

  it('disables tool schemas up front for providers that do not support tool calls', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    let sentTools = null;
    let sentSystem = '';
    service.streamOnce = vi.fn(async (_requestId, messages, _settings, tools) => {
      sentTools = tools;
      sentSystem = messages[0].content;
      return { content: 'ok', thinking: '', usage: normalizeTokenUsage(null, { input: 1, output: 1 }), toolCalls: [] };
    });

    await service.runWithSettings(
      { requestId: 'req-provider-no-tools', messages: [{ role: 'user', content: '运行 1+1 验证结果' }] },
      baseSettings({
        providerId: 'ollama',
        apiBase: 'http://localhost:11434/v1',
        model: 'llama3',
        activeSkill: 'agent_auto',
        runCodeEnabled: true,
      }),
      new AbortController()
    );

    expect(sentTools).toEqual([]);
    expect(sentSystem).not.toContain('代码运行工具');
    expect(
      events.some(
        (event) =>
          event.type === 'agentStage' && event.stage === 'warning' && event.stopReason === 'provider_tools_unsupported'
      )
    ).toBe(true);
    expect(events.find((event) => event.type === 'tokenCount').warnings.join('\n')).toContain('tool_calls');
  });

  it('keeps smart-agent scratch out of the cache-stable prefix and retained history', async () => {
    const service = new ChatService(() => fakeWindow());
    let sentMessages = [];
    service.streamOnce = vi.fn(async (_requestId, messages) => {
      sentMessages = messages;
      return { content: 'ok', thinking: '', usage: normalizeTokenUsage(null, { input: 1, output: 1 }), toolCalls: [] };
    });

    await service.runWithSettings(
      { requestId: 'req-scratch', messages: [{ role: 'user', content: '搜索今天新闻' }] },
      baseSettings({ activeSkill: 'agent_auto', tavilyApiKey: 'tvly-test' }),
      new AbortController()
    );

    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages.slice(1).some((message) => message.role === 'system')).toBe(false);
    expect(JSON.stringify(sentMessages)).not.toContain('本轮动态 Agent 规划元信息');
  });

  it('puts missing tool prerequisites at the current turn tail instead of before history', async () => {
    const service = new ChatService(() => fakeWindow());
    let sentMessages = [];
    service.streamOnce = vi.fn(async (_requestId, messages) => {
      sentMessages = messages;
      return { content: 'ok', thinking: '', usage: normalizeTokenUsage(null, { input: 1, output: 1 }), toolCalls: [] };
    });

    await service.runWithSettings(
      { requestId: 'req-missing-tail', messages: [{ role: 'user', content: '搜索今天新闻' }] },
      baseSettings({ activeSkill: 'agent_auto', tavilyApiKey: '' }),
      new AbortController()
    );

    expect(sentMessages[0].role).toBe('system');
    expect(sentMessages.slice(1).some((message) => message.role === 'system')).toBe(false);
    expect(sentMessages.at(-1).role).toBe('user');
    expect(sentMessages.at(-1).content).toContain('[DeepChat volatile turn metadata]');
    expect(sentMessages.at(-1).content).toContain('缺少配置：Tavily API Key');
  });

  it('warns when a conversation cache prefix profile drifts between turns', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.streamOnce = vi.fn(async () => ({
      content: 'ok',
      thinking: '',
      usage: normalizeTokenUsage(
        { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 2 },
        { model: 'deepseek-v4-flash' }
      ),
      toolCalls: [],
    }));

    await service.runWithSettings(
      {
        requestId: 'req-prefix-drift',
        messages: [{ role: 'user', content: '继续' }],
        cacheProfile: {
          prefixFingerprint: 'old-prefix',
          model: 'deepseek-chat',
          workspaceSignature: 'old-workspace',
          toolsHash: 'old-tools',
        },
      },
      baseSettings({ activeSkill: 'agent_auto', tavilyApiKey: 'tvly-test', workspaceRoots: ['E:\\demo'] }),
      new AbortController()
    );

    const tokenCount = events.find((event) => event.type === 'tokenCount');
    expect(tokenCount.cacheProfile.prefixFingerprint).toBeTruthy();
    expect(tokenCount.cacheProfile.toolNames).toContain('web_search');
    expect(tokenCount.cacheProfile.cacheStabilityReasons).toEqual(
      expect.arrayContaining(['model_changed', 'tool_schema_changed', 'workspace_or_mcp_changed'])
    );
    expect(tokenCount.cacheProfile.cacheStabilityDetails.prefixFingerprint.current).toBeTruthy();
    expect(tokenCount.warnings.join('\n')).toContain('prefix');
    expect(
      events.some(
        (event) => event.type === 'contextBudget' && event.cacheStabilityReasons?.includes('tool_schema_changed')
      )
    ).toBe(true);
  });

  it('attributes cache prefix drift to concrete change reasons', () => {
    const diagnostics = buildCacheStabilityDiagnostics(
      {
        prefixFingerprint: 'p1',
        systemHash: 's1',
        toolsHash: 't1',
        workspaceSignature: 'w1',
        model: 'deepseek-chat',
      },
      {
        prefixFingerprint: 'p2',
        systemHash: 's2',
        toolsHash: 't2',
        workspaceSignature: 'w2',
        model: 'deepseek-v4-flash',
      }
    );

    expect(diagnostics.cacheStabilityReasons).toEqual([
      'model_changed',
      'system_prompt_changed',
      'tool_schema_changed',
      'workspace_or_mcp_changed',
    ]);
    expect(diagnostics.cacheStabilityDetails).toMatchObject({
      model: { previous: 'deepseek-chat', current: 'deepseek-v4-flash' },
      systemHash: { previous: 's1', current: 's2' },
      toolsHash: { previous: 't1', current: 't2' },
      workspaceSignature: { previous: 'w1', current: 'w2' },
      prefixFingerprint: { previous: 'p1', current: 'p2' },
    });
  });

  it('reuses a matching summary hash without calling the model again', async () => {
    const service = new ChatService(() => fakeWindow());
    service.summarizeContext = vi.fn(async () => 'new summary');
    const contextBundle = {
      messages: [{ role: 'user', content: 'latest' }],
      meta: {
        droppedMessages: [{ role: 'user', content: 'old' }],
        budgetRatio: 0.2,
      },
    };
    const first = await service.maybeBuildContextSummary(
      { requestId: 'req-summary', contextSummary: '', contextSummaryMeta: null },
      baseSettings(),
      contextBundle,
      0,
      new AbortController().signal
    );
    const second = await service.maybeBuildContextSummary(
      { requestId: 'req-summary', contextSummary: first.summary, contextSummaryMeta: first.meta },
      baseSettings(),
      contextBundle,
      0,
      new AbortController().signal
    );

    expect(service.summarizeContext).toHaveBeenCalledTimes(1);
    expect(second.generated).toBe(false);
    expect(second.meta.cacheHit).toBe(true);
  });

  it('records a fold economics decision when generating summaries', async () => {
    const service = new ChatService(() => fakeWindow());
    service.summarizeContext = vi.fn(async () => 'folded summary');
    const contextBundle = {
      messages: [{ role: 'user', content: 'latest' }],
      meta: {
        droppedMessages: [{ role: 'user', content: 'old context '.repeat(500) }],
        budgetRatio: 0.88,
      },
    };

    const result = await service.maybeBuildContextSummary(
      { requestId: 'req-fold-economics', contextSummary: '', contextSummaryMeta: null },
      baseSettings({ contextFoldEconomicsEnabled: true }),
      contextBundle,
      0,
      new AbortController().signal
    );

    expect(result.summary).toBe('folded summary');
    expect(result.meta.foldDecision).toMatchObject({
      action: expect.stringMatching(/generate|emergency/),
      reason: expect.any(String),
    });
    expect(result.meta.foldDecision.estimatedSavingsUsd).toBeGreaterThanOrEqual(0);
  });

  it('uses the flash model for DeepSeek summary auxiliary calls and records summary cost separately', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '旧上下文摘要' } }] }),
    });
    const contextBundle = {
      messages: [{ role: 'user', content: 'latest' }],
      meta: {
        droppedMessages: [{ role: 'user', content: 'old context that should be summarized' }],
        budgetRatio: 0.2,
      },
    };

    const result = await service.maybeBuildContextSummary(
      { requestId: 'req-summary-flash', contextSummary: '', contextSummaryMeta: null },
      baseSettings({ providerId: 'deepseek', model: 'deepseek-v4-pro' }),
      contextBundle,
      0,
      new AbortController().signal
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('deepseek-v4-flash');
    expect(result.summary).toBe('旧上下文摘要');
    expect(result.meta).toMatchObject({
      auxiliaryModel: 'deepseek-v4-flash',
      requestedModel: 'deepseek-v4-pro',
    });
    expect(result.usage.byPurpose.summary).toBeGreaterThan(0);
    expect(result.usage.cost.model).toBe('deepseek-v4-flash');
    expect(
      events.some(
        (event) =>
          event.type === 'agentStage' && event.stage === 'summary' && event.warning.includes('deepseek-v4-flash')
      )
    ).toBe(true);
  });

  it('surfaces malformed tool arguments instead of silently running with empty args', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    const result = await service.handleToolCall(
      'req-parse',
      { id: 'tool-bad', function: { name: 'run_code', arguments: '{"language":"javascript",' } },
      baseSettings(),
      new AbortController().signal
    );

    expect(result).toContain('参数 JSON 解析失败');
    const toolRequest = events.find((event) => event.type === 'toolRequest');
    expect(toolRequest.parseError).toBeTruthy();
    const toolResult = events.find((event) => event.type === 'toolResult');
    expect(toolResult.ok).toBe(false);
    expect(toolResult.nextAction).toContain('重新发送合法 JSON');
  });

  it('repairs clearly truncated tool argument JSON before approval', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.waitForApproval = vi.fn(async () => ({ approved: false }));
    const result = await service.handleToolCall(
      'req-arg-repair',
      { id: 'tool-repair-args', function: { name: 'web_search', arguments: '{"query":"DeepSeek cache hit' } },
      baseSettings({ tavilyApiKey: 'tvly-test' }),
      new AbortController().signal
    );

    const toolRequest = events.find((event) => event.type === 'toolRequest');
    expect(toolRequest.parseError).toBe('');
    expect(toolRequest.parseRepair).toContain('已自动补齐');
    expect(toolRequest.args).toEqual({ query: 'DeepSeek cache hit' });
    expect(events.some((event) => event.type === 'agentStage' && event.stage === 'tool_repair')).toBe(true);
    expect(result).toContain('用户拒绝执行工具');
  });

  it('auto-denies pending tool approval after the configured timeout', async () => {
    vi.useFakeTimers();
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    const promise = service.handleToolCall(
      'req-timeout',
      { id: 'tool-timeout', function: { name: 'web_search', arguments: '{"query":"DeepChat"}' } },
      baseSettings({ toolApprovalTimeoutMs: 5000, tavilyApiKey: 'tvly-test' }),
      new AbortController().signal
    );

    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toContain('自动拒绝');
    expect(events.find((event) => event.type === 'toolRequest').expiresAt).toBeTruthy();
    expect(events.find((event) => event.type === 'toolResult').nextAction).toContain('重新点击执行');
  });

  it('suppresses duplicate tool calls in the same agent run', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.streamOnce = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        thinking: '',
        usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 1 }),
        toolCalls: [
          { id: 'tool-1', function: { name: 'web_search', arguments: '{"query":"same"}' } },
          { id: 'tool-2', function: { name: 'web_search', arguments: '{"query":"same"}' } },
        ],
      })
      .mockResolvedValueOnce({
        content: 'done',
        thinking: '',
        usage: normalizeTokenUsage({ prompt_tokens: 12, completion_tokens: 2 }),
        toolCalls: [],
      });
    service.handleToolCall = vi.fn(async () => 'first output');

    await service.runWithSettings(
      { requestId: 'req-dupe', messages: [{ role: 'user', content: '搜索 same' }] },
      baseSettings({ agentMaxRounds: 2, tavilyApiKey: 'tvly-test' }),
      new AbortController()
    );

    expect(service.handleToolCall).toHaveBeenCalledTimes(1);
    expect(events.some((event) => String(event.output || event.warning || '').includes('重复工具调用已抑制'))).toBe(
      true
    );
  });

  it('runs parallel-safe read-only tool calls together and appends results in declared order', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    const starts = [];
    const resolvers = new Map();
    let secondRoundMessages = [];
    service.streamOnce = vi.fn(async (_requestId, messages) => {
      if (service.streamOnce.mock.calls.length === 1) {
        return {
          content: '',
          thinking: '',
          usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 1 }),
          toolCalls: [
            { id: 'tool-list', function: { name: 'list_files', arguments: '{"directory":"src"}' } },
            { id: 'tool-search', function: { name: 'search_workspace', arguments: '{"query":"cache"}' } },
          ],
        };
      }
      secondRoundMessages = messages;
      return {
        content: 'done',
        thinking: '',
        usage: normalizeTokenUsage({ prompt_tokens: 12, completion_tokens: 2 }),
        toolCalls: [],
      };
    });
    service.handleToolCall = vi.fn(async (_requestId, toolCall) => {
      starts.push(toolCall.id);
      await new Promise((resolve) => resolvers.set(toolCall.id, resolve));
      return `${toolCall.id} output`;
    });

    const runPromise = service.runWithSettings(
      { requestId: 'req-parallel-tools', messages: [{ role: 'user', content: '检查 src 并搜索 cache' }] },
      baseSettings({ activeSkill: 'agent_auto', workspaceRoots: ['E:\\demo'] }),
      new AbortController()
    );

    await waitForCondition(() => starts.length === 2);
    expect(starts).toEqual(['tool-list', 'tool-search']);
    resolvers.get('tool-search')();
    resolvers.get('tool-list')();
    await runPromise;

    const toolMessages = secondRoundMessages.filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(['tool-list', 'tool-search']);
    expect(toolMessages.map((message) => message.content)).toEqual(['tool-list output', 'tool-search output']);
    expect(events.some((event) => event.type === 'agentStage' && event.stage === 'tool_parallel')).toBe(true);
  });

  it('keeps run_code as a serial barrier between read-only tool groups', async () => {
    const service = new ChatService(() => fakeWindow());
    const starts = [];
    const resolvers = new Map();
    service.streamOnce = vi.fn(async () => {
      if (service.streamOnce.mock.calls.length === 1) {
        return {
          content: '',
          thinking: '',
          usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 1 }),
          toolCalls: [
            { id: 'tool-list', function: { name: 'list_files', arguments: '{}' } },
            { id: 'tool-code', function: { name: 'run_code', arguments: '{"language":"javascript","code":"1+1"}' } },
            { id: 'tool-search', function: { name: 'search_workspace', arguments: '{"query":"cache"}' } },
          ],
        };
      }
      return {
        content: 'done',
        thinking: '',
        usage: normalizeTokenUsage({ prompt_tokens: 12, completion_tokens: 2 }),
        toolCalls: [],
      };
    });
    service.handleToolCall = vi.fn(async (_requestId, toolCall) => {
      starts.push(toolCall.id);
      await new Promise((resolve) => resolvers.set(toolCall.id, resolve));
      return `${toolCall.id} output`;
    });

    const runPromise = service.runWithSettings(
      { requestId: 'req-serial-barrier', messages: [{ role: 'user', content: '列文件、运行代码、再搜索' }] },
      baseSettings({ activeSkill: 'agent_auto', workspaceRoots: ['E:\\demo'] }),
      new AbortController()
    );

    await waitForCondition(() => starts.length === 1);
    expect(starts).toEqual(['tool-list']);
    resolvers.get('tool-list')();
    await waitForCondition(() => starts.length === 2);
    expect(starts).toEqual(['tool-list', 'tool-code']);
    resolvers.get('tool-code')();
    await waitForCondition(() => starts.length === 3);
    expect(starts).toEqual(['tool-list', 'tool-code', 'tool-search']);
    resolvers.get('tool-search')();
    await runPromise;
  });

  it('compacts tool output by tool type', () => {
    const output = ['文件：E:\\demo\\README.md', '大小：20000 bytes', '行范围：20-40', '', 'A'.repeat(9000)].join('\n');

    const compacted = compactToolOutputForContext('read_file', { path: 'README.md' }, output);

    expect(compacted).toContain('文件内容已压缩');
    expect(compacted).toContain('行范围：20-40');
    expect(compacted).toContain('开头片段');
    expect(compacted.length).toBeLessThan(output.length);

    const workspaceOutput = compactToolOutputForContext(
      'search_workspace',
      { symbol: 'buildContextBudgetBundle' },
      [
        '工作区搜索：buildContextBudgetBundle',
        '符号：buildContextBudgetBundle',
        '工作区：E:\\repo',
        '目录：src',
        '结果数：1',
        '',
        '1. src/modules/api.js:811-812',
        '   摘录:',
        '   811: export function buildContextBudgetBundle(messages, options = {}) {',
      ].join('\n')
    );
    expect(workspaceOutput).toContain('符号：buildContextBudgetBundle');
    expect(workspaceOutput).toContain('src/modules/api.js:811-812');
  });

  it('reports tool output compaction metadata for token diagnostics', () => {
    const output = ['文件：E:\\demo\\README.md', '大小：20000 bytes', '行范围：20-40', '', 'A'.repeat(9000)].join('\n');

    const result = compactToolOutputWithMetadata('read_file', { path: 'README.md' }, output);

    expect(result.contextOutput).toContain('文件内容已压缩');
    expect(result.contextCompacted).toBe(true);
    expect(result.rawOutputTokens).toBeGreaterThan(result.contextOutputTokens);
    expect(result.contextCompactionRatio).toBeGreaterThan(0);
    expect(result.contextCompactionRatio).toBeLessThan(1);
    expect(result.contextCompactionReason).toBe('tool_type:read_file');
    expect(result.contextCompactionType).toBe('file');
  });

  it('emits compacted context output metadata with successful tool results', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.waitForApproval = vi.fn(async () => ({ approved: true }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'DeepSeek Cache', url: 'https://example.com/cache', content: 'cache details' }],
      }),
    });
    const output = await service.handleToolCall(
      'req-context-output',
      { id: 'tool-context', function: { name: 'web_search', arguments: '{"query":"DeepSeek cache"}' } },
      baseSettings({ tavilyApiKey: 'tvly-test' }),
      new AbortController().signal
    );

    expect(output).toContain('DeepSeek Cache');
    const result = events.find((event) => event.type === 'toolResult');
    expect(result.ok).toBe(true);
    expect(result.contextOutput).toContain('DeepSeek Cache');
    expect(result.rawOutputTokens).toBeGreaterThan(0);
    expect(result.contextOutputTokens).toBeGreaterThan(0);
    expect(result.contextCompacted).toBe(false);
    expect(result.contextCompactionRatio).toBe(1);
    expect(result.contextCompactionReason).toBe('within_budget');
  });

  it('auto-approves read-only tools only when the user selects that approval policy', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.waitForApproval = vi.fn(async () => ({ approved: false }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ title: 'DeepChat', url: 'https://example.com', content: 'agent notes' }] }),
    });

    const output = await service.handleToolCall(
      'req-auto-approve',
      { id: 'tool-auto', function: { name: 'web_search', arguments: '{"query":"DeepChat agent"}' } },
      baseSettings({ tavilyApiKey: 'tvly-test', toolApprovalPolicy: 'auto_readonly' }),
      new AbortController().signal
    );

    expect(output).toContain('DeepChat');
    expect(service.waitForApproval).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'toolRequest')).toMatchObject({
      autoApproved: true,
      approvalPolicy: 'auto_readonly',
    });
    expect(events.some((event) => event.type === 'agentStage' && event.stage === 'tool_auto_approved')).toBe(true);
    expect(events.find((event) => event.type === 'toolResult')).toMatchObject({ ok: true, autoApproved: true });
  });

  it('still requires approval for run_code under the read-only auto approval policy', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.waitForApproval = vi.fn(async () => ({ approved: false }));

    const output = await service.handleToolCall(
      'req-auto-deny-run',
      {
        id: 'tool-run',
        function: { name: 'run_code', arguments: '{"language":"javascript","code":"console.log(1)"}' },
      },
      baseSettings({ toolApprovalPolicy: 'auto_readonly', runCodeEnabled: true }),
      new AbortController().signal
    );

    expect(output).toContain('用户拒绝执行工具 run_code');
    expect(service.waitForApproval).toHaveBeenCalledTimes(1);
    expect(events.find((event) => event.type === 'toolRequest')).toMatchObject({
      autoApproved: false,
      approvalPolicy: 'tool_policy:confirm_always',
    });
  });

  it('runs the edit_file approval path with preview, write evidence, and restorable backup', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-chat-edit-'));
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-chat-edit-data-'));
    try {
      const file = path.join(tmpDir, 'README.md');
      await fs.writeFile(file, 'hello\nworld\n', 'utf8');
      const events = [];
      const service = new ChatService(() => fakeWindow(events));
      service.waitForApproval = vi.fn(async () => ({ approved: true }));

      const output = await service.handleToolCall(
        'req-edit',
        {
          id: 'tool-edit',
          function: {
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'README.md', search: 'world', replace: 'DeepChat' }),
          },
        },
        baseSettings({
          workspaceRoots: [tmpDir],
          codingEditsEnabled: true,
          storageStatus: { dataDir },
        }),
        new AbortController().signal
      );

      const toolRequest = events.find((event) => event.type === 'toolRequest');
      expect(toolRequest).toMatchObject({
        name: 'edit_file',
        autoApproved: false,
        approvalPolicy: 'tool_policy:confirm_always',
      });
      expect(toolRequest.editPreview).toMatchObject({
        tool: 'edit_file',
        editCount: 1,
      });
      expect(await fs.readFile(file, 'utf8')).toBe('hello\nDeepChat\n');
      const backupPath = getBackupPathFromToolOutput(output);
      expect(await fs.readFile(backupPath, 'utf8')).toBe('hello\nworld\n');

      await fs.copyFile(backupPath, file);
      expect(await fs.readFile(file, 'utf8')).toBe('hello\nworld\n');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('blocks edit_file before approval or mutation when the agent scope is read_only', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-chat-edit-readonly-'));
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-chat-edit-readonly-data-'));
    try {
      const file = path.join(tmpDir, 'README.md');
      await fs.writeFile(file, 'hello\nworld\n', 'utf8');
      const events = [];
      const service = new ChatService(() => fakeWindow(events));
      service.waitForApproval = vi.fn(async () => ({ approved: true }));
      service.controllers.set('req-readonly-edit', {
        checkPausePoint: async () => {},
        skippedToolCallIds: new Set(),
        scopePolicy: 'read_only',
      });

      const output = await service.handleToolCall(
        'req-readonly-edit',
        {
          id: 'tool-edit-readonly',
          function: {
            name: 'edit_file',
            arguments: JSON.stringify({ path: 'README.md', search: 'world', replace: 'DeepChat' }),
          },
        },
        baseSettings({
          workspaceRoots: [tmpDir],
          codingEditsEnabled: true,
          storageStatus: { dataDir },
        }),
        new AbortController().signal
      );

      expect(output).toContain('执行被拒绝');
      expect(output).toContain('只读模式');
      expect(service.waitForApproval).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === 'toolRequest')).toBe(false);
      expect(events.find((event) => event.type === 'toolResult')).toMatchObject({ ok: false });
      expect(await fs.readFile(file, 'utf8')).toBe('hello\nworld\n');
      await expect(fs.readdir(path.join(dataDir, 'file-backups'))).rejects.toThrow();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});

function baseSettings(overrides = {}) {
  return {
    apiBase: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: 'deepseek-v4-flash',
    temperature: 0.7,
    maxTokens: 1024,
    maxInputTokens: 24000,
    maxContextMessages: 20,
    thinkingBudget: 0,
    activeSkill: 'none',
    cacheOptimization: true,
    toolApprovalTimeoutMs: 60000,
    runCodeEnabled: true,
    systemPrompt: 'You are helpful.',
    externalSkills: [],
    mcpServers: [],
    ...overrides,
  };
}

function fakeWindow(events = []) {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (_channel, payload) => events.push(payload),
    },
  };
}

function sse(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function streamFromText(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function waitForCondition(predicate) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for condition');
}

function getBackupPathFromToolOutput(output) {
  const line = String(output)
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('备份位置：'));
  if (!line) throw new Error(`Backup path not found in output:\n${output}`);
  return line.slice('备份位置：'.length);
}
