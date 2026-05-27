import { describe, expect, it, vi } from 'vitest';
import {
  getCompactMessagePreview,
  buildConversationUsageTelemetryDetails,
  formatConversationUsageTelemetry,
  hasLocalFilesWithoutCitedSource,
  hasSearchWithoutCitedSource,
  renderAgentTimeline,
  renderAssistantEvidence,
  renderContextMentionStrip,
  renderConversationUsageTelemetryPanel,
  renderToolCalls,
  shouldCompactHistoricalMessage,
  trimMessagesForRegeneration,
} from '../src/modules/chat.js';

describe('chat regeneration', () => {
  it('truncates from the selected assistant message instead of the last message', () => {
    const messages = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'second answer' },
    ];

    expect(trimMessagesForRegeneration(messages, 1)).toEqual([
      { role: 'user', content: 'one' },
    ]);
  });

  it('does not truncate when the selected message is not an assistant response', () => {
    const messages = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first answer' },
    ];

    expect(trimMessagesForRegeneration(messages, 0)).toBe(messages);
  });

  it('flags searched answers that do not cite returned source urls', () => {
    const message = {
      toolRuns: [{
        name: 'web_search',
        status: 'completed',
        sources: [{ title: 'Source', url: 'https://example.com/news' }],
      }],
    };

    expect(hasSearchWithoutCitedSource(message, '根据搜索结果，新闻如下。')).toBe(true);
    expect(hasSearchWithoutCitedSource(message, '来源：https://example.com/news')).toBe(false);
  });

  it('flags local file answers that do not cite file line evidence', () => {
    const message = {
      toolRuns: [{
        name: 'search_workspace',
        status: 'completed',
        localCitations: [{ file: 'src/agent.md', lineStart: 2, lineEnd: 3, label: 'src/agent.md:2-3' }],
      }],
    };

    expect(hasLocalFilesWithoutCitedSource(message, '根据本地文件，缓存命中需要固定前缀。')).toBe(true);
    expect(hasLocalFilesWithoutCitedSource(message, '根据 src/agent.md:2-3，缓存命中需要固定前缀。')).toBe(false);
  });

  it('renders local file grounding evidence next to assistant messages', () => {
    const container = document.createElement('div');
    const message = {
      content: '根据本地文件，缓存命中需要固定前缀。',
      toolRuns: [{
        name: 'search_workspace',
        status: 'completed',
        localCitations: [{ file: 'src/agent.md', lineStart: 2, lineEnd: 3, label: 'src/agent.md:2-3' }],
      }],
    };

    renderAssistantEvidence(container, message);

    expect(container.textContent).toContain('本地文件证据未被明确引用');
    expect(container.textContent).toContain('src/agent.md:2-3');
  });

  it('renders local workspace citations in tool result cards', () => {
    const container = document.createElement('div');
    renderToolCalls(container, [{
      id: 'tool-search',
      name: 'search_workspace',
      status: 'completed',
      ok: true,
      args: { query: 'cache telemetry' },
      output: [
        '工作区搜索：cache telemetry',
        '结果数：1',
        '',
        '1. src/agent.md:2-3',
        '   摘录:',
        '   2: DeepSeek cache telemetry should explain hit and miss tokens.',
      ].join('\n'),
    }]);

    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain('本地引用 (1)');
    expect(container.textContent).toContain('src/agent.md:2-3');
    expect(container.textContent).toContain('输出摘要');
  });

  it('renders bounded tool output summaries and copies evidence JSON', async () => {
    const container = document.createElement('div');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderToolCalls(container, [{
      id: 'tool-code',
      name: 'run_code',
      status: 'completed',
      ok: true,
      args: { language: 'javascript' },
      requestedAt: '2026-05-27T12:00:00.000Z',
      completedAt: '2026-05-27T12:00:01.000Z',
      output: [
        '退出码：0',
        'stdout:',
        '测试完成',
        '```js',
        'const secret = "long code";',
        '```',
      ].join('\n'),
    }]);

    expect(container.textContent).toContain('输出摘要');
    expect(container.textContent).toContain('退出码：0');
    expect(container.textContent).toContain('[代码片段]');

    container.querySelector('.tool-copy-btn').click();
    await Promise.resolve();

    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload).toMatchObject({
      type: 'deepchat.toolEvidence',
      id: 'tool-code',
      name: 'run_code',
      status: 'completed',
      ok: true,
      durationMs: 1000,
      rawOutputRef: 'tool-output:tool-code',
    });
    expect(payload.outputPreview).toContain('测试完成');
  });

  it('labels selected symbol context as a symbol chip', () => {
    const strip = renderContextMentionStrip('解释 @symbol:buildContextBudgetBundle 和 @file:src/modules/api.js');

    expect(strip.textContent).toContain('符号 buildContextBudgetBundle');
    expect(strip.textContent).toContain('文件 src/modules/api.js');
  });

  it('renders agent stages and context budget metadata', () => {
    const container = document.createElement('div');
    renderAgentTimeline(container, {
      contextBudget: {
        maxInputTokens: 24000,
        estimatedInputTokens: 12000,
        prefixFingerprint: 'abc123',
        trimmed: true,
        droppedCount: 3,
        summaryUsed: true,
      },
      agentStages: [
        { stage: 'plan', intent: { toolMode: 'web_search' }, round: 0 },
        { stage: 'memory', warning: '检索到 2 条相关历史', round: 0 },
        { stage: 'tool_pending', toolName: 'web_search', round: 1 },
        { stage: 'final', round: 2 },
      ],
    });

    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain('规划工具：web_search');
    expect(container.textContent).toContain('prefix abc123');
    expect(container.textContent).toContain('裁剪 3 条');
    expect(container.textContent).toContain('检索历史');
    expect(container.textContent).toContain('等待确认');
  });

  it('formats compact conversation usage telemetry for the chat header', () => {
    const telemetry = formatConversationUsageTelemetry({
      cacheProfile: {
        prefixFingerprint: 'abc123',
        prefixTokens: 480,
        cacheStabilityReasons: ['tool_schema_changed'],
      },
      messages: [
        {
          role: 'assistant',
          tokens: {
            input: 1200,
            output: 300,
            total: 1500,
            reasoning: 40,
            cacheHit: 900,
            cacheMiss: 300,
            rounds: 2,
            cost: {
              estimatedCostUsd: 0.0002,
              estimatedSavingsUsd: 0.0001,
            },
          },
        },
      ],
    });

    expect(telemetry.text).toContain('1.5k tok');
    expect(telemetry.text).toContain('缓存 75%');
    expect(telemetry.text).toContain('2 轮');
    expect(telemetry.title).toContain('本会话 Token / Cache 汇总');
    expect(telemetry.title).toContain('Prefix: abc123');
    expect(telemetry.title).toContain('工具 schema 变化');
  });

  it('builds detailed cache telemetry for the conversation panel', () => {
    const details = buildConversationUsageTelemetryDetails({
      cacheProfile: {
        prefixFingerprint: 'abc123',
        prefixTokens: 480,
        prefixBytes: 2048,
        systemHash: 'sys1',
        toolsHash: 'tools1',
        workspaceSignature: 'workspace1',
        cacheStabilityReasons: ['system_prompt_changed'],
        cacheStabilityDetails: {
          systemHash: { previous: 'old', current: 'sys1' },
        },
        cacheStabilityWarnings: ['下一轮缓存可能下降'],
      },
      messages: [{
        role: 'assistant',
        tokens: {
          input: 1000,
          output: 250,
          total: 1250,
          cacheHit: 700,
          cacheMiss: 300,
          source: 'provider',
          byPurpose: { main: 1250 },
          cost: {
            estimatedCostUsd: 0.0002,
            estimatedSavingsUsd: 0.00009,
            inputCacheHitCostUsd: 0.00001,
            inputCacheMissCostUsd: 0.00004,
            outputCostUsd: 0.00007,
          },
        },
      }],
    });

    expect(details.sourceLabel).toBe('服务商真实 usage');
    expect(details.hitRateLabel).toBe('70%');
    expect(details.profile.systemHash).toBe('sys1');
    expect(details.reasons).toEqual(['system_prompt_changed']);
    expect(details.detailText).toContain('systemHash');
    expect(details.warnings).toContain('下一轮缓存可能下降');
  });

  it('renders a readable cache telemetry panel', () => {
    const container = document.createElement('div');

    renderConversationUsageTelemetryPanel(container, {
      cacheProfile: {
        prefixFingerprint: 'abc123',
        prefixTokens: 480,
        systemHash: 'sys1',
        toolsHash: 'tools1',
        cacheStabilityReasons: ['workspace_or_mcp_changed'],
      },
      messages: [{
        role: 'assistant',
        tokens: {
          input: 1000,
          output: 200,
          total: 1200,
          cacheHit: 800,
          cacheMiss: 200,
          cost: {
            estimatedCostUsd: 0.0002,
            estimatedSavingsUsd: 0.0001,
          },
        },
      }],
    });

    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain('本会话 Token / Cache');
    expect(container.textContent).toContain('Cache hit');
    expect(container.textContent).toContain('800');
    expect(container.textContent).toContain('Prefix hash');
    expect(container.textContent).toContain('abc123');
    expect(container.textContent).toContain('工作区/MCP 变化');
  });

  it('hides conversation usage telemetry when there is no token usage', () => {
    expect(formatConversationUsageTelemetry({ messages: [] })).toBeNull();
    const container = document.createElement('div');
    expect(renderConversationUsageTelemetryPanel(container, { messages: [] })).toBeNull();
    expect(container.hidden).toBe(true);
  });

  it('compacts only old long assistant messages without execution evidence', () => {
    const longMessage = { role: 'assistant', content: 'x'.repeat(900) };

    expect(shouldCompactHistoricalMessage(100, 20, longMessage, 60)).toBe(true);
    expect(shouldCompactHistoricalMessage(100, 50, longMessage, 60)).toBe(false);
    expect(shouldCompactHistoricalMessage(100, 20, { role: 'user', content: longMessage.content }, 60)).toBe(false);
    expect(shouldCompactHistoricalMessage(100, 20, { ...longMessage, toolRuns: [{ name: 'web_search' }] }, 60)).toBe(false);
    expect(shouldCompactHistoricalMessage(100, 20, { ...longMessage, agentStages: [{ stage: 'plan' }] }, 60)).toBe(false);
  });

  it('normalizes compact previews without exposing full code blocks', () => {
    const preview = getCompactMessagePreview([
      '# 标题',
      '',
      '正文内容',
      '```js',
      'const secret = "long code";',
      '```',
      '结尾',
    ].join('\n'), 80);

    expect(preview).toContain('标题');
    expect(preview).toContain('[代码片段]');
    expect(preview).not.toContain('const secret');
  });
});
