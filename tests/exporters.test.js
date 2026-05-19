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

  it('builds auditable tool evidence with message indexes', () => {
    const evidence = buildToolEvidence({
      id: 'c1',
      title: '联网验证',
      tags: ['搜索'],
      folderId: '工具',
      messages: [
        { role: 'assistant', timestamp: 100, toolRuns: [{ name: 'web_search', status: 'completed', args: { query: 'AI' } }] },
        { role: 'assistant', timestamp: 200, toolRuns: [{ name: 'run_code', status: 'failed', durationMs: 1000 }] },
      ],
    });

    expect(evidence.version).toBe(1);
    expect(evidence.conversation).toMatchObject({ id: 'c1', title: '联网验证', folderId: '工具' });
    expect(evidence.toolRuns).toHaveLength(2);
    expect(evidence.toolRuns[0]).toMatchObject({ messageIndex: 0, name: 'web_search', status: 'completed' });
    expect(evidence.toolRuns[1]).toMatchObject({ messageIndex: 1, name: 'run_code', status: 'failed' });
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
