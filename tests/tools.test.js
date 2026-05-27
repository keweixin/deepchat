import { createRequire } from 'module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildTavilySearchRequest,
  clearWorkspaceIndexCache,
  clearWorkspaceIndexDiskCache,
  executeTool,
  isPathInsideRoot,
  normalizeTavilyResults,
} = require('../electron/tools');

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

  it('searches workspace text files with line citations and skips secrets', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-search-workspace-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src', 'agent.md'), [
        '# Agent Notes',
        'DeepSeek cache telemetry should explain hit and miss tokens.',
        'The answer must cite local files.',
      ].join('\n'), 'utf8');
      await fs.writeFile(path.join(tmpDir, '.env'), 'DEEPSEEK_CACHE_SECRET=hit miss tokens', 'utf8');

      const output = await executeTool('search_workspace', {
        query: 'cache telemetry',
        directory: 'src',
        max_results: 5,
      }, { workspaceRoots: [tmpDir] });

      expect(output).toContain('工作区搜索：cache telemetry');
      expect(output).toContain('目录：src');
      expect(output).toContain('src');
      expect(output).toContain('agent.md:2-3');
      expect(output).toContain('2: DeepSeek cache telemetry');
      expect(output).not.toContain('.env');
      expect(output).not.toContain('DEEPSEEK_CACHE_SECRET');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('builds and reuses a lightweight workspace index for cited search', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-index-workspace-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src', 'agent.md'), [
        '# Agent Notes',
        'Workspace index should speed up local search.',
        'Every answer should cite file lines.',
      ].join('\n'), 'utf8');
      await fs.writeFile(path.join(tmpDir, '.env'), 'API_KEY=should_not_be_indexed', 'utf8');

      const first = await executeTool('index_workspace', {
        directory: 'src',
      }, { workspaceRoots: [tmpDir] });
      const second = await executeTool('index_workspace', {
        directory: 'src',
      }, { workspaceRoots: [tmpDir] });
      const search = await executeTool('search_workspace', {
        query: 'workspace index',
        directory: 'src',
        max_results: 3,
      }, { workspaceRoots: [tmpDir] });

      expect(first).toContain('工作区索引：新建');
      expect(first).toContain('索引 hash：');
      expect(first).toContain('文件数：1/1');
      expect(first).toContain('文本块：1');
      expect(first).toContain('agent.md');
      expect(first).not.toContain('should_not_be_indexed');
      expect(second).toContain('工作区索引：命中缓存（内存）');
      expect(search).toContain('索引：命中缓存（内存）');
      expect(search).toContain('agent.md:2-3');
      expect(search).toContain('2: Workspace index should speed up local search.');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists workspace index cache to disk and invalidates it by snapshot', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-index-disk-workspace-'));
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-index-disk-cache-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      const filePath = path.join(tmpDir, 'src', 'agent.md');
      await fs.writeFile(filePath, [
        '# Agent Notes',
        'Persistent workspace index should survive a process cache clear.',
      ].join('\n'), 'utf8');

      const settings = { workspaceRoots: [tmpDir], workspaceIndexCacheDir: cacheDir };
      const first = await executeTool('index_workspace', { directory: 'src' }, settings);
      clearWorkspaceIndexCache();
      const second = await executeTool('index_workspace', { directory: 'src' }, settings);

      await fs.writeFile(filePath, [
        '# Agent Notes',
        'Persistent workspace index changed after file update.',
        'The snapshot should force a rebuild.',
      ].join('\n'), 'utf8');
      const future = new Date(Date.now() + 2000);
      await fs.utimes(filePath, future, future);
      clearWorkspaceIndexCache();
      const third = await executeTool('index_workspace', { directory: 'src' }, settings);
      const search = await executeTool('search_workspace', {
        query: 'force a rebuild',
        directory: 'src',
      }, settings);

      expect(first).toContain('磁盘缓存：已写入');
      expect(second).toContain('工作区索引：命中缓存（磁盘）');
      expect(second).toContain('磁盘缓存：已命中');
      expect(third).toContain('工作区索引：新建');
      expect(search).toContain('The snapshot should force a rebuild.');
    } finally {
      clearWorkspaceIndexCache();
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('clears workspace index memory and disk cache on demand', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-index-clear-workspace-'));
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-index-clear-cache-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src', 'agent.md'), 'Clearable workspace index cache.', 'utf8');
      const settings = { workspaceRoots: [tmpDir], workspaceIndexCacheDir: cacheDir };

      await executeTool('index_workspace', { directory: 'src' }, settings);
      const before = await fs.readdir(cacheDir);
      const result = await clearWorkspaceIndexDiskCache(settings);
      const after = await fs.readdir(cacheDir);
      const rebuilt = await executeTool('index_workspace', { directory: 'src' }, settings);

      expect(before.some((name) => name.endsWith('.json'))).toBe(true);
      expect(result).toMatchObject({ ok: true, memoryCleared: true, diskEnabled: true, deletedFiles: 1 });
      expect(result.deletedBytes).toBeGreaterThan(0);
      expect(after.filter((name) => name.endsWith('.json'))).toEqual([]);
      expect(rebuilt).toContain('工作区索引：新建');
    } finally {
      clearWorkspaceIndexCache();
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('returns multiple bounded hits from the same workspace file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-search-multi-hit-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src', 'agent.md'), [
        '# Agent Notes',
        'DeepSeek cache telemetry should explain hit and miss tokens.',
        'The answer must cite local files.',
        'Unrelated bridge content keeps the snippets separated.',
        'Cache telemetry appears again after another tool run.',
        'The second citation helps the agent inspect the later context.',
      ].join('\n'), 'utf8');

      const output = await executeTool('search_workspace', {
        query: 'cache telemetry',
        directory: 'src',
        max_results: 5,
      }, { workspaceRoots: [tmpDir] });

      expect(output).toContain('agent.md:2-3');
      expect(output).toContain('agent.md:5-6');
      expect(output).toContain('5: Cache telemetry appears again');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('prioritizes exact symbol definitions in workspace search', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-search-symbol-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src', 'agent.js'), [
        'const unrelated = "buildContextBudgetBundle appears in docs";',
        'export function buildContextBudgetBundle(messages, options = {}) {',
        '  return { messages, meta: options };',
        '}',
      ].join('\n'), 'utf8');

      const output = await executeTool('search_workspace', {
        symbol: 'buildContextBudgetBundle',
        directory: 'src',
        max_results: 3,
      }, { workspaceRoots: [tmpDir] });

      expect(output).toContain('工作区搜索：buildContextBudgetBundle');
      expect(output).toContain('符号：buildContextBudgetBundle');
      expect(output).toContain('agent.js:2-3');
      expect(output).toContain('2: export function buildContextBudgetBundle');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reads focused line ranges from workspace citation paths', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-read-lines-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'src', 'agent.md'), [
        '# Agent Notes',
        'DeepSeek cache telemetry should explain hit and miss tokens.',
        'The answer must cite local files.',
        'Unrelated footer',
      ].join('\n'), 'utf8');

      const fromCitation = await executeTool('read_file', {
        path: 'src/agent.md:2-3',
      }, { workspaceRoots: [tmpDir] });

      expect(fromCitation).toContain('行范围：2-3');
      expect(fromCitation).toContain('2: DeepSeek cache telemetry');
      expect(fromCitation).toContain('3: The answer must cite local files.');
      expect(fromCitation).not.toContain('1: # Agent Notes');
      expect(fromCitation).not.toContain('4: Unrelated footer');

      const fromArgs = await executeTool('read_file', {
        path: 'src/agent.md',
        start_line: 3,
        end_line: 3,
      }, { workspaceRoots: [tmpDir] });

      expect(fromArgs).toContain('行范围：3');
      expect(fromArgs).toContain('3: The answer must cite local files.');
      expect(fromArgs).not.toContain('2: DeepSeek cache telemetry');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
