// @ts-nocheck
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildTavilySearchRequest } from '../electron/search-utils.mjs';

import {
  clearWorkspaceIndexCache,
  clearWorkspaceIndexDiskCache,
  executeTool,
  isPathInsideRoot,
  normalizeTavilyResults,
} from '../electron/tools.js';

describe('electron tools helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps file paths inside the approved workspace root', () => {
    const root = path.resolve('E:/workspace/project');

    expect(isPathInsideRoot(path.join(root, 'src/index.js'), root)).toBe(true);
    expect(isPathInsideRoot(root, root)).toBe(true);
    expect(isPathInsideRoot(path.resolve('E:/workspace/other/file.txt'), root)).toBe(false);
  });

  it('normalizes Tavily results to a compact sourced shape', () => {
    const results = normalizeTavilyResults(
      {
        results: [
          { title: 'First', url: 'https://example.com/1', content: 'Alpha', score: 0.9 },
          { url: 'https://example.com/2', snippet: 'Beta', published_date: '2026-05-18' },
        ],
      },
      5
    );

    expect(results).toEqual([
      { index: 1, title: 'First', url: 'https://example.com/1', content: 'Alpha', publishedDate: '', score: 0.9 },
      {
        index: 2,
        title: 'https://example.com/2',
        url: 'https://example.com/2',
        content: 'Beta',
        publishedDate: '2026-05-18',
        score: null,
      },
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

  it('executes a multi-query Tavily search plan with de-duplicated structured results', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            { title: 'Official Docs', url: 'https://example.com/docs', content: 'Official context cache docs.' },
            { title: 'Shared Result', url: 'https://example.com/shared', content: 'Shared result from docs query.' },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              title: 'Shared Result Duplicate',
              url: 'https://example.com/shared',
              content: 'Duplicate should be removed.',
            },
            { title: 'GitHub Issue', url: 'https://github.com/example/issue', content: 'Implementation issue.' },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const output = await executeTool(
      'web_search',
      {
        queries: ['DeepSeek context cache official docs', 'DeepSeek cache GitHub issue'],
        max_results: 4,
      },
      { tavilyApiKey: 'tvly-test', tavilyMaxResults: 4 }
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(output).toContain('搜索计划：2 个 query');
    expect(output).toContain('Structured Search Plan:');
    expect(output).toContain('Tavily 返回来源（已按 URL 去重）');
    expect(output).toContain('Official Docs');
    expect(output).toContain('GitHub Issue');
    expect(output.match(/https:\/\/example\.com\/shared/g)).toHaveLength(2);

    const structured = extractStructuredResults(output, 'Structured Search Plan:');
    expect(structured).toMatchObject({
      type: 'deepchat.webSearchPlanResults',
      queries: [
        expect.objectContaining({ originalQuery: 'DeepSeek context cache official docs' }),
        expect.objectContaining({ originalQuery: 'DeepSeek cache GitHub issue' }),
      ],
    });
    expect(structured.results.map((item) => item.url)).toEqual([
      'https://example.com/docs',
      'https://example.com/shared',
      'https://github.com/example/issue',
    ]);
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
      await expect(executeTool('list_files', { directory: '..' }, { workspaceRoots: [tmpDir] })).rejects.toThrow(
        '不在已授权工作区'
      );
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

      const output = await executeTool(
        'list_files',
        {
          sort_by: 'modified',
          recent_days: 7,
        },
        { workspaceRoots: [tmpDir] }
      );

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
      await fs.writeFile(
        path.join(tmpDir, 'src', 'agent.md'),
        [
          '# Agent Notes',
          'DeepSeek cache telemetry should explain hit and miss tokens.',
          'The answer must cite local files.',
        ].join('\n'),
        'utf8'
      );
      await fs.writeFile(path.join(tmpDir, '.env'), 'DEEPSEEK_CACHE_SECRET=hit miss tokens', 'utf8');

      const output = await executeTool(
        'search_workspace',
        {
          query: 'cache telemetry',
          directory: 'src',
          max_results: 5,
        },
        { workspaceRoots: [tmpDir] }
      );

      expect(output).toContain('工作区搜索：cache telemetry');
      expect(output).toContain('目录：src');
      expect(output).toContain('src');
      expect(output).toContain('agent.md:2-3');
      expect(output).toContain('2: DeepSeek cache telemetry');
      expect(output).toContain('Structured Results:');
      const structured = extractStructuredResults(output);
      expect(structured).toMatchObject({
        type: 'deepchat.workspaceSearchResults',
        query: 'cache telemetry',
        directory: 'src',
        results: [
          {
            file: 'src/agent.md',
            startLine: 2,
            endLine: 3,
            kind: 'text',
          },
        ],
      });
      expect(structured.results[0].score).toBeGreaterThan(0);
      expect(structured.results[0].scoreBreakdown.content).toBeGreaterThan(0);
      expect(structured.results[0].matchReasons).toContain('content');
      expect(structured.results[0].snippet[0]).toMatchObject({ line: 2 });
      expect(output).not.toContain('.env');
      expect(output).not.toContain('DEEPSEEK_CACHE_SECRET');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('prioritizes file-name matches and returns structured file-only hits', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-search-ranked-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'src', 'cache-helper.md'),
        ['# Helper Notes', 'This file documents local indexing behavior.'].join('\n'),
        'utf8'
      );
      await fs.writeFile(
        path.join(tmpDir, 'src', 'notes.md'),
        ['# Notes', 'The cache helper query appears only in this content line.'].join('\n'),
        'utf8'
      );

      const output = await executeTool(
        'search_workspace',
        {
          query: 'cache helper',
          directory: 'src',
          max_results: 2,
        },
        { workspaceRoots: [tmpDir] }
      );

      const structured = extractStructuredResults(output);
      expect(structured.results[0]).toMatchObject({
        file: 'src/cache-helper.md',
        startLine: 1,
        kind: 'markdown-section',
      });
      expect(structured.results[0].matchReasons).toContain('file_name');
      expect(structured.results[0].scoreBreakdown.file).toBeGreaterThan(structured.results[0].scoreBreakdown.content);
      expect(structured.results[1].file).toBe('src/notes.md');
      expect(structured.results[1].matchReasons).toContain('content');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('builds and reuses a lightweight workspace index for cited search', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-index-workspace-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'src', 'agent.md'),
        ['# Agent Notes', 'Workspace index should speed up local search.', 'Every answer should cite file lines.'].join(
          '\n'
        ),
        'utf8'
      );
      await fs.writeFile(path.join(tmpDir, '.env'), 'API_KEY=should_not_be_indexed', 'utf8');

      const first = await executeTool(
        'index_workspace',
        {
          directory: 'src',
        },
        { workspaceRoots: [tmpDir] }
      );
      const second = await executeTool(
        'index_workspace',
        {
          directory: 'src',
        },
        { workspaceRoots: [tmpDir] }
      );
      const search = await executeTool(
        'search_workspace',
        {
          query: 'workspace index',
          directory: 'src',
          max_results: 3,
        },
        { workspaceRoots: [tmpDir] }
      );

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
      await fs.writeFile(
        filePath,
        ['# Agent Notes', 'Persistent workspace index should survive a process cache clear.'].join('\n'),
        'utf8'
      );

      const settings = { workspaceRoots: [tmpDir], workspaceIndexCacheDir: cacheDir };
      const first = await executeTool('index_workspace', { directory: 'src' }, settings);
      clearWorkspaceIndexCache();
      const second = await executeTool('index_workspace', { directory: 'src' }, settings);

      await fs.writeFile(
        filePath,
        [
          '# Agent Notes',
          'Persistent workspace index changed after file update.',
          'The snapshot should force a rebuild.',
        ].join('\n'),
        'utf8'
      );
      const future = new Date(Date.now() + 2000);
      await fs.utimes(filePath, future, future);
      clearWorkspaceIndexCache();
      const third = await executeTool('index_workspace', { directory: 'src' }, settings);
      const search = await executeTool(
        'search_workspace',
        {
          query: 'force a rebuild',
          directory: 'src',
        },
        settings
      );

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
      await fs.writeFile(
        path.join(tmpDir, 'src', 'agent.md'),
        [
          '# Agent Notes',
          'DeepSeek cache telemetry should explain hit and miss tokens.',
          'The answer must cite local files.',
          'Unrelated bridge content keeps the snippets separated.',
          'Cache telemetry appears again after another tool run.',
          'The second citation helps the agent inspect the later context.',
        ].join('\n'),
        'utf8'
      );

      const output = await executeTool(
        'search_workspace',
        {
          query: 'cache telemetry',
          directory: 'src',
          max_results: 5,
        },
        { workspaceRoots: [tmpDir] }
      );

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
      await fs.writeFile(
        path.join(tmpDir, 'src', 'agent.js'),
        [
          'const unrelated = "buildContextBudgetBundle appears in docs";',
          'export function buildContextBudgetBundle(messages, options = {}) {',
          '  return { messages, meta: options };',
          '}',
        ].join('\n'),
        'utf8'
      );

      const output = await executeTool(
        'search_workspace',
        {
          symbol: 'buildContextBudgetBundle',
          directory: 'src',
          max_results: 3,
        },
        { workspaceRoots: [tmpDir] }
      );

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
      await fs.writeFile(
        path.join(tmpDir, 'src', 'agent.md'),
        [
          '# Agent Notes',
          'DeepSeek cache telemetry should explain hit and miss tokens.',
          'The answer must cite local files.',
          'Unrelated footer',
        ].join('\n'),
        'utf8'
      );

      const fromCitation = await executeTool(
        'read_file',
        {
          path: 'src/agent.md:2-3',
        },
        { workspaceRoots: [tmpDir] }
      );

      expect(fromCitation).toContain('行范围：2-3');
      expect(fromCitation).toContain('2: DeepSeek cache telemetry');
      expect(fromCitation).toContain('3: The answer must cite local files.');
      expect(fromCitation).not.toContain('1: # Agent Notes');
      expect(fromCitation).not.toContain('4: Unrelated footer');

      const fromArgs = await executeTool(
        'read_file',
        {
          path: 'src/agent.md',
          start_line: 3,
          end_line: 3,
        },
        { workspaceRoots: [tmpDir] }
      );

      expect(fromArgs).toContain('行范围：3');
      expect(fromArgs).toContain('3: The answer must cite local files.');
      expect(fromArgs).not.toContain('2: DeepSeek cache telemetry');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reads a code symbol definition with structured evidence', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-read-symbol-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, 'src', 'budget.js'),
        [
          'const unrelated = 1;',
          '',
          'export function buildContextBudgetBundle(messages, options = {}) {',
          '  const maxInputTokens = options.maxInputTokens || 24000;',
          '  return { messages, maxInputTokens };',
          '}',
          '',
          'export function otherHelper() {',
          '  return unrelated;',
          '}',
        ].join('\n'),
        'utf8'
      );

      const output = await executeTool(
        'read_symbol',
        {
          symbol: 'buildContextBudgetBundle',
          directory: 'src',
          max_lines: 40,
        },
        { workspaceRoots: [tmpDir] }
      );

      expect(output).toContain('符号读取：buildContextBudgetBundle');
      expect(output).toContain('结果：src');
      expect(output).toContain('budget.js:');
      expect(output).toContain('类型：function');
      expect(output).toContain('Structured Symbol:');
      expect(output).toContain('3: export function buildContextBudgetBundle');
      expect(output).toContain('5:   return { messages, maxInputTokens };');

      const structured = extractStructuredPayload(output, 'Structured Symbol:');
      expect(structured).toMatchObject({
        type: 'deepchat.workspaceSymbolResult',
        symbol: 'buildContextBudgetBundle',
        result: {
          file: 'src/budget.js',
          definitionLine: 3,
          kind: 'function',
        },
      });
      expect(structured.result.snippet.some((line) => line.text.includes('maxInputTokens'))).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('shows git status for a workspace with uncommitted changes', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-git-status-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir, stdio: 'ignore' });
      await fs.writeFile(path.join(tmpDir, 'README.md'), 'initial content', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpDir, stdio: 'ignore' });

      await fs.writeFile(path.join(tmpDir, 'README.md'), 'modified content', 'utf8');
      await fs.writeFile(path.join(tmpDir, 'new-file.txt'), 'new', 'utf8');

      const output = await executeTool('git_status', {}, { workspaceRoots: [tmpDir] });

      expect(output).toContain('Git 工作区状态');
      expect(output).toContain('Structured Status:');
      expect(output).toContain('README.md');
      expect(output).toContain('modified');
      expect(output).toContain('new-file.txt');
      expect(output).toContain('untracked');

      const structured = extractStructuredPayload(output, 'Structured Status:');
      expect(structured).toMatchObject({
        type: 'deepchat.gitStatus',
        version: 1,
        branch: 'master',
      });
      expect(structured.files.length).toBeGreaterThanOrEqual(2);
      expect(structured.summary.modified).toBeGreaterThanOrEqual(1);
      expect(structured.summary.untracked).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('shows git diff for modified files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-git-diff-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir, stdio: 'ignore' });
      await fs.writeFile(path.join(tmpDir, 'README.md'), 'line1\nline2\nline3\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: tmpDir, stdio: 'ignore' });

      await fs.writeFile(path.join(tmpDir, 'README.md'), 'line1\nmodified line2\nline3\nnew line4\n', 'utf8');

      const output = await executeTool('git_diff', {}, { workspaceRoots: [tmpDir] });

      expect(output).toContain('Git 差异');
      expect(output).toContain('Structured Diff:');
      expect(output).toContain('README.md');
      expect(output).toContain('modified line2');
      expect(output).toContain('未暂存');

      const structured = extractStructuredPayload(output, 'Structured Diff:');
      expect(structured).toMatchObject({
        type: 'deepchat.gitDiff',
        version: 1,
        staged: false,
      });
      expect(structured.files).toContain('README.md');
      expect(structured.additions).toBeGreaterThan(0);

      // Test staged diff
      execFileSync('git', ['add', 'README.md'], { cwd: tmpDir, stdio: 'ignore' });
      const stagedOutput = await executeTool('git_diff', { staged: true }, { workspaceRoots: [tmpDir] });
      expect(stagedOutput).toContain('已暂存');
      expect(stagedOutput).toContain('modified line2');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('shows git log with commit history', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-git-log-'));
    try {
      execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpDir, stdio: 'ignore' });

      await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'first commit'], { cwd: tmpDir, stdio: 'ignore' });

      await fs.writeFile(path.join(tmpDir, 'b.txt'), 'b', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'second commit'], { cwd: tmpDir, stdio: 'ignore' });

      const output = await executeTool('git_log', { count: 5 }, { workspaceRoots: [tmpDir] });

      expect(output).toContain('Git 提交历史');
      expect(output).toContain('Structured Log:');
      expect(output).toContain('second commit');
      expect(output).toContain('first commit');
      expect(output).toContain('Test User');

      const structured = extractStructuredPayload(output, 'Structured Log:');
      expect(structured).toMatchObject({
        type: 'deepchat.gitLog',
        version: 1,
        count: 5,
      });
      expect(structured.commits).toHaveLength(2);
      expect(structured.commits[0].message).toBe('second commit');
      expect(structured.commits[1].message).toBe('first commit');

      // Test with file filter
      const fileOutput = await executeTool('git_log', { file: 'a.txt' }, { workspaceRoots: [tmpDir] });
      expect(fileOutput).toContain('first commit');
      expect(fileOutput).not.toContain('second commit');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

function extractStructuredResults(output, marker = 'Structured Results:') {
  return extractStructuredPayload(output, marker);
}

function extractStructuredPayload(output, marker) {
  const start = output.indexOf(marker);
  const jsonStart = output.indexOf('{', start);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = jsonStart; index < output.length; index++) {
    const char = output[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(output.slice(jsonStart, index + 1));
    }
  }
  throw new Error(`${marker} JSON not found`);
}
