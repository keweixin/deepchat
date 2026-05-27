import { createRequire } from 'module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  ChatService,
  compactToolOutputForContext,
  detectAgentIntent,
  mergeTokenUsage,
  normalizeTokenUsage,
} = require('../electron/chat-service');

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
      new AbortController().signal,
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
      new AbortController(),
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

  it('stops with a clear error when agent tool rounds exceed the configured limit', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.streamOnce = vi.fn(async (_requestId, _messages, _settings, _tools) => ({
      content: '',
      thinking: '',
      usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }),
      toolCalls: [{ id: `tool-${service.streamOnce.mock.calls.length}`, function: { name: 'web_search', arguments: '{}' } }],
    }));
    service.handleToolCall = vi.fn(async () => 'tool output');

    await expect(service.runWithSettings(
      { requestId: 'req-3', messages: [{ role: 'user', content: 'loop' }] },
      baseSettings({ agentMaxRounds: 1 }),
      new AbortController(),
    )).rejects.toThrow('工具调用超过 1 轮');

    const tokenEvent = events.find((event) => event.type === 'tokenCount');
    expect(tokenEvent).toMatchObject({
      input: 20,
      output: 2,
      total: 22,
      rounds: 2,
    });
  });

  it('merges usage through the electron helper too', () => {
    expect(mergeTokenUsage([
      { input: 10, output: 1, total: 11, cacheHit: 5, cacheMiss: 5, source: 'provider' },
      { input: 5, output: 4, total: 9, cacheHit: 0, cacheMiss: 5, source: 'estimated' },
    ])).toMatchObject({
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
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'unsupported parameter stream_options' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: streamFromText([
          sse({ choices: [{ delta: { content: 'ok' } }] }),
          'data: [DONE]\n\n',
        ].join('')),
      });

    const result = await service.streamOnce('req-fallback', [{ role: 'user', content: 'hi' }], baseSettings(), [], new AbortController().signal);
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
      body: streamFromText([
        sse({ choices: [{ delta: { content: '```json\n{"tool":"web_search","arguments":{"query":"DeepSeek cache hit"}}\n```' } }] }),
        'data: [DONE]\n\n',
      ].join('')),
    });

    const result = await service.streamOnce(
      'req-repair-content',
      [{ role: 'user', content: '搜索 DeepSeek cache hit' }],
      baseSettings({ tavilyApiKey: 'tvly-test' }),
      [{ type: 'function', function: { name: 'web_search', parameters: {} } }],
      new AbortController().signal,
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
        body: streamFromText([
          sse({ choices: [{ delta: { reasoning_content: '<tool_call>{"name":"read_file","args":{"path":"README.md"}}</tool_call>' } }] }),
          'data: [DONE]\n\n',
        ].join('')),
      })
      .mockResolvedValueOnce({
        ok: true,
        body: streamFromText([
          sse({ choices: [{ delta: { reasoning_content: '<tool_call>{"name":"read_file","args":{"path":"README.md"}}</tool_call>' } }] }),
          'data: [DONE]\n\n',
        ].join('')),
      });

    const blocked = await service.streamOnce(
      'req-repair-thinking',
      [{ role: 'user', content: '读 README' }],
      baseSettings({ workspaceRoots: ['E:\\demo'] }),
      [{ type: 'function', function: { name: 'web_search', parameters: {} } }],
      new AbortController().signal,
    );
    const repaired = await service.streamOnce(
      'req-repair-thinking-allowed',
      [{ role: 'user', content: '读 README' }],
      baseSettings({ workspaceRoots: ['E:\\demo'] }),
      [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
      new AbortController().signal,
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
    expect(intent.selectedTools).toContain('read_file');
    expect(intent.selectedTools).toContain('search_workspace');
    expect(intent.selectedTools).toContain('run_code');
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
    expect(intent.selectedTools).toEqual(expect.arrayContaining(['web_search', 'list_files', 'search_workspace', 'read_file']));
    expect(intent.reason).toContain('explicit_web');
    expect(intent.reason).toContain('explicit_changed_context');
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
      return { content: 'ok', thinking: '', usage: normalizeTokenUsage(null, { input: 1, output: 1, model: settings.model }), toolCalls: [] };
    });

    await service.runWithSettings({ requestId: 'req-cache-a', messages: [{ role: 'user', content: '搜索今天新闻' }] }, settings, new AbortController());
    await service.runWithSettings({ requestId: 'req-cache-b', messages: [{ role: 'user', content: '检查 E:\\demo\\package.json 并运行测试' }] }, settings, new AbortController());

    expect(seen[0].system).toBe(seen[1].system);
    expect(seen[0].tools).toEqual(seen[1].tools);
    expect(seen[0].tools).toEqual(expect.arrayContaining(['web_search', 'list_files', 'search_workspace', 'read_file', 'run_code']));
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
      new AbortController(),
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
      new AbortController(),
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
      usage: normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 2 }, { model: 'deepseek-v4-flash' }),
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
      new AbortController(),
    );

    const tokenCount = events.find((event) => event.type === 'tokenCount');
    expect(tokenCount.cacheProfile.prefixFingerprint).toBeTruthy();
    expect(tokenCount.cacheProfile.toolNames).toContain('web_search');
    expect(tokenCount.warnings.join('\n')).toContain('prefix');
    expect(events.some((event) => event.type === 'contextBudget' && event.cacheStabilityWarnings?.length > 0)).toBe(true);
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
      new AbortController().signal,
    );
    const second = await service.maybeBuildContextSummary(
      { requestId: 'req-summary', contextSummary: first.summary, contextSummaryMeta: first.meta },
      baseSettings(),
      contextBundle,
      0,
      new AbortController().signal,
    );

    expect(service.summarizeContext).toHaveBeenCalledTimes(1);
    expect(second.generated).toBe(false);
    expect(second.meta.cacheHit).toBe(true);
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
      new AbortController().signal,
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
    expect(events.some((event) => event.type === 'agentStage' && event.stage === 'summary' && event.warning.includes('deepseek-v4-flash'))).toBe(true);
  });

  it('surfaces malformed tool arguments instead of silently running with empty args', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    const result = await service.handleToolCall(
      'req-parse',
      { id: 'tool-bad', function: { name: 'run_code', arguments: '{"language":"javascript",' } },
      baseSettings(),
      new AbortController().signal,
    );

    expect(result).toContain('参数 JSON 解析失败');
    const toolRequest = events.find((event) => event.type === 'toolRequest');
    expect(toolRequest.parseError).toBeTruthy();
    const toolResult = events.find((event) => event.type === 'toolResult');
    expect(toolResult.ok).toBe(false);
  });

  it('auto-denies pending tool approval after the configured timeout', async () => {
    vi.useFakeTimers();
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    const promise = service.handleToolCall(
      'req-timeout',
      { id: 'tool-timeout', function: { name: 'web_search', arguments: '{"query":"DeepChat"}' } },
      baseSettings({ toolApprovalTimeoutMs: 5000, tavilyApiKey: 'tvly-test' }),
      new AbortController().signal,
    );

    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toContain('自动拒绝');
    expect(events.find((event) => event.type === 'toolRequest').expiresAt).toBeTruthy();
  });

  it('suppresses duplicate tool calls in the same agent run', async () => {
    const events = [];
    const service = new ChatService(() => fakeWindow(events));
    service.streamOnce = vi.fn()
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
      new AbortController(),
    );

    expect(service.handleToolCall).toHaveBeenCalledTimes(1);
    expect(events.some((event) => String(event.output || event.warning || '').includes('重复工具调用已抑制'))).toBe(true);
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
      new AbortController(),
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
      new AbortController(),
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
    const output = [
      '文件：E:\\demo\\README.md',
      '大小：20000 bytes',
      '',
      'A'.repeat(9000),
    ].join('\n');

    const compacted = compactToolOutputForContext('read_file', { path: 'README.md' }, output);

    expect(compacted).toContain('文件内容已压缩');
    expect(compacted).toContain('开头片段');
    expect(compacted.length).toBeLessThan(output.length);
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
