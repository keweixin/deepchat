import { describe, expect, it } from 'vitest';
import {
  buildAssetManifestHtml,
  buildConversationMarkdown,
  buildToolEvidence,
} from '../src/modules/exporters.js';

describe('conversation exporters', () => {
  it('exports only favorite assistant answers when requested', () => {
    const markdown = buildConversationMarkdown({
      title: '收藏测试',
      messages: [
        { role: 'user', content: '问题', timestamp: Date.now() },
        { role: 'assistant', content: '普通回答', timestamp: Date.now() },
        { role: 'assistant', content: '收藏回答', favorite: true, timestamp: Date.now() },
      ],
    }, { onlyFavorites: true });

    expect(markdown).toContain('收藏回答');
    expect(markdown).not.toContain('普通回答');
    expect(markdown).not.toContain('问题');
  });

  it('adds evidence citation and cache audit details to markdown exports', () => {
    const markdown = buildConversationMarkdown({
      title: '审计导出',
      messages: [{
        role: 'assistant',
        timestamp: 100,
        content: '结论来自 https://example.com/used，并参考 src/modules/api.js:10-20。',
        tokens: {
          input: 100,
          output: 20,
          total: 120,
          cacheHit: 50,
          cacheMiss: 50,
          source: 'provider',
        },
        contextBudget: {
          prefixFingerprint: 'abc123',
          trimmed: true,
          droppedCount: 2,
          summaryUsed: true,
        },
        toolRuns: [{
          name: 'web_search',
          status: 'completed',
          output: [
            '1. Used Source',
            'URL: https://example.com/used',
            '2. Missed Source',
            'URL: https://example.com/missed',
          ].join('\n'),
        }, {
          name: 'read_file',
          status: 'completed',
          contextCompacted: true,
          rawOutputTokens: 900,
          contextOutputTokens: 120,
          output: '文件：src/modules/api.js\n行范围：10-20\n内容...',
        }],
      }],
    });

    expect(markdown).toContain('#### 工具调用');
    expect(markdown).toContain('web_search：已完成 · 证据部分引用 (1/2)');
    expect(markdown).toContain('已引用: Used Source');
    expect(markdown).toContain('未引用: Missed Source');
    expect(markdown).toContain('read_file：已完成 · 证据已全部引用 (1/1)');
    expect(markdown).toContain('上下文压缩: 900 → 120 tokens');
    expect(markdown).toContain('#### Token / Cache');
    expect(markdown).toContain('输入 100 · 输出 20 · 总计 120');
    expect(markdown).toContain('cache 50%');
    expect(markdown).toContain('prefix abc123');
    expect(markdown).toContain('裁剪 2 条历史');
    expect(markdown).toContain('已使用长期摘要');
  });

  it('builds auditable tool evidence with message indexes', () => {
    const evidence = buildToolEvidence({
      id: 'c1',
      title: '联网验证',
      tags: ['搜索'],
      folderId: '工具',
      messages: [
        {
          role: 'assistant',
          timestamp: 100,
          content: '来源：https://example.com/ai',
          toolRuns: [{
            id: 'web1',
            name: 'web_search',
            status: 'completed',
            args: { query: 'AI' },
            output: '1. AI Source\nURL: https://example.com/ai',
          }],
        },
        {
          role: 'assistant',
          timestamp: 200,
          content: '运行失败，见 stderr。',
          toolRuns: [{ id: 'run1', name: 'run_code', status: 'failed', durationMs: 1000 }],
        },
      ],
    });

    expect(evidence.version).toBe(1);
    expect(evidence.conversation).toMatchObject({ id: 'c1', title: '联网验证', folderId: '工具' });
    expect(evidence.toolRuns).toHaveLength(2);
    expect(evidence.toolRuns[0]).toMatchObject({
      type: 'deepchat.toolEvidence',
      messageIndex: 0,
      messageRole: 'assistant',
      name: 'web_search',
      status: 'completed',
      citationStatus: { state: 'is-cited', cited: 1, total: 1 },
    });
    expect(evidence.toolRuns[0].citationStatus.refs[0]).toMatchObject({
      type: 'url',
      value: 'https://example.com/ai',
      cited: true,
    });
    expect(evidence.toolRuns[1]).toMatchObject({
      messageIndex: 1,
      name: 'run_code',
      status: 'failed',
      citationStatus: { state: 'no-evidence', cited: 0, total: 0 },
    });
  });

  it('marks uncited local evidence in exported tool evidence', () => {
    const evidence = buildToolEvidence({
      id: 'c2',
      title: '本地证据',
      messages: [{
        role: 'assistant',
        content: '根据本地文件可以优化缓存。',
        toolRuns: [{
          name: 'read_file',
          status: 'completed',
          output: '文件：src/modules/api.js\n行范围：10-20\n\n内容...',
        }],
      }],
    });

    expect(evidence.toolRuns[0]).toMatchObject({
      name: 'read_file',
      citationStatus: { state: 'uncited', cited: 0, total: 1 },
    });
    expect(evidence.toolRuns[0].citationStatus.refs[0]).toMatchObject({
      type: 'file',
      label: 'src/modules/api.js:10-20',
      cited: false,
    });
  });

  it('exports legacy toolCalls and cache evidence for audit', () => {
    const evidence = buildToolEvidence({
      id: 'c3',
      title: '旧会话证据',
      usageTotals: { input: 100, output: 20, total: 120, cacheHit: 50, cacheMiss: 50, source: 'provider' },
      messages: [{
        role: 'assistant',
        timestamp: 300,
        content: '已参考 https://example.com/legacy，prefix abc123。',
        tokens: {
          input: 100,
          output: 20,
          total: 120,
          cacheHit: 50,
          cacheMiss: 50,
          source: 'provider',
          prefixFingerprint: 'abc123',
        },
        contextBudget: {
          prefixFingerprint: 'abc123',
          prefixTokens: 42,
          prefixBytes: 2048,
          trimmed: true,
          droppedCount: 3,
        },
        toolCalls: [{
          id: 'legacy-web',
          name: 'web_search',
          status: 'completed',
          ok: true,
          args: { query: 'legacy' },
          output: '1. Legacy Source\nURL: https://example.com/legacy',
        }],
      }],
    });

    expect(evidence.usageTotals).toMatchObject({
      input: 100,
      output: 20,
      total: 120,
      cacheHit: 50,
      cacheMiss: 50,
      source: 'provider',
    });
    expect(evidence.toolRuns).toHaveLength(1);
    expect(evidence.toolRuns[0]).toMatchObject({
      id: 'legacy-web',
      name: 'web_search',
      citationStatus: { state: 'is-cited', cited: 1, total: 1 },
    });
    expect(evidence.cacheEvidence[0]).toMatchObject({
      messageIndex: 0,
      tokens: { total: 120, cacheHit: 50, source: 'provider' },
      cacheProfile: { prefixFingerprint: 'abc123', prefixTokens: 42, prefixBytes: 2048 },
      contextBudget: { trimmed: true, droppedCount: 3 },
    });
  });

  it('includes image attachments and Mermaid code in the asset manifest', () => {
    const html = buildAssetManifestHtml({
      title: '资源',
      messages: [{
        role: 'assistant',
        attachments: [{ name: '图.png', mimeType: 'image/png', size: 128, dataUrl: 'data:image/png;base64,abc' }],
        content: '```mermaid\ngraph TD\nA-->B\n```',
      }],
    });

    expect(html).toContain('图.png');
    expect(html).toContain('data:image/png;base64,abc');
    expect(html).toContain('Mermaid 图示');
    expect(html).toContain('graph TD');
  });
});
