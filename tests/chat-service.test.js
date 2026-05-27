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

  it('detects file and code intent for smart agent mode', () => {
    const intent = detectAgentIntent('检查 E:\\demo\\package.json 并运行测试', {
      workspaceRoots: ['E:\\demo'],
      mcpServers: [],
    });

    expect(intent.toolMode).toBe('multi_tool');
    expect(intent.selectedTools).toContain('read_file');
    expect(intent.selectedTools).toContain('run_code');
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
