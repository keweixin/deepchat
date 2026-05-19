import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildTavilySearchRequest, isPathInsideRoot, normalizeTavilyResults } = require('../electron/tools');

describe('electron tools helpers', () => {
  it('keeps file paths inside the approved workspace root', () => {
    const root = path.resolve('E:/workspace/project');

    expect(isPathInsideRoot(path.join(root, 'src/index.js'), root)).toBe(true);
    expect(isPathInsideRoot(root, root)).toBe(true);
    expect(isPathInsideRoot(path.resolve('E:/workspace/other/file.txt'), root)).toBe(false);
  });

  it('normalizes Tavily results to a compact sourced shape', () => {
    const results = normalizeTavilyResults({
      results: [
        { title: 'First', url: 'https://example.com/1', content: 'Alpha', score: 0.9 },
        { url: 'https://example.com/2', snippet: 'Beta', published_date: '2026-05-18' },
      ],
    }, 5);

    expect(results).toEqual([
      { index: 1, title: 'First', url: 'https://example.com/1', content: 'Alpha', publishedDate: '', score: 0.9 },
      { index: 2, title: 'https://example.com/2', url: 'https://example.com/2', content: 'Beta', publishedDate: '2026-05-18', score: null },
    ]);
  });

  it('turns latest AI news requests into recent Tavily news searches', () => {
    const request = buildTavilySearchRequest('帮我搜索一下最新的ai新闻一个就行', { tavilyMaxResults: 5 });

    expect(request.payload.query).toMatch(/latest AI news/);
    expect(request.payload.topic).toBe('news');
    expect(request.payload.time_range).toBe('week');
    expect(request.payload.days).toBe(7);
    expect(request.payload.max_results).toBe(1);
  });
});
