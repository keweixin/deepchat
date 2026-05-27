import { describe, expect, it } from 'vitest';
import {
  getCompactMessagePreview,
  hasLocalFilesWithoutCitedSource,
  hasSearchWithoutCitedSource,
  renderAgentTimeline,
  renderAssistantEvidence,
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
