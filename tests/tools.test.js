import { createRequire } from 'module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildTavilySearchRequest, executeTool, isPathInsideRoot, normalizeTavilyResults } = require('../electron/tools');

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

  it('removes explicit @web directives before building Tavily queries', () => {
    const request = buildTavilySearchRequest('@web:"DeepSeek cache pricing" 一个就行', { tavilyMaxResults: 5 });

    expect(request.payload.query).toBe('DeepSeek cache pricing');
    expect(request.payload.max_results).toBe(1);
  });

  it('lists files inside a selected workspace subdirectory only', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-list-files-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src', 'nested'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'README.md'), 'root', 'utf8');
      await fs.writeFile(path.join(tmpDir, 'src', 'index.js'), 'console.log(1)', 'utf8');
      await fs.writeFile(path.join(tmpDir, 'src', 'nested', 'note.md'), 'note', 'utf8');

      const output = await executeTool('list_files', { directory: 'src' }, { workspaceRoots: [tmpDir] });

      expect(output).toContain('目录：src');
      expect(output).toContain('- index.js');
      expect(output).toContain('- nested');
      expect(output).not.toContain('README.md');
      await expect(executeTool('list_files', { directory: '..' }, { workspaceRoots: [tmpDir] })).rejects.toThrow('不在已授权工作区');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('can list recently changed files by modified time', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-list-recent-'));
    try {
      const oldFile = path.join(tmpDir, 'old.md');
      const newFile = path.join(tmpDir, 'new.md');
      await fs.writeFile(oldFile, 'old', 'utf8');
      await fs.writeFile(newFile, 'new', 'utf8');
      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await fs.utimes(oldFile, oldDate, oldDate);

      const output = await executeTool('list_files', {
        sort_by: 'modified',
        recent_days: 7,
      }, { workspaceRoots: [tmpDir] });

      expect(output).toContain('筛选：最近 7 天修改');
      expect(output).toContain('排序：修改时间倒序');
      expect(output).toContain('- new.md (mtime');
      expect(output).not.toContain('old.md');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
