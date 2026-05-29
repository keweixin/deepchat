// @ts-check
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { parseWorkspaceQuery, matchesFileDirective, matchesChangedDirective } = require('./workspace-query');
const {
  resolveWorkspaceRoot,
  resolveAllowedPath,
  resolveAllowedDirectory,
  isSensitivePath,
  isPathInsideRoot,
  isProbablyBinary,
} = require('./tools-path');
const { gitStatus, gitDiff, gitLog } = require('./tools-git');
const { webSearch, normalizeSearchQueries, normalizeTavilyResults, formatTavilyResults } = require('./tools-search');
const { projectMap } = require('./tools-project');
const { runCode, buildSandboxEnv, redactSensitiveText, redactRunCodeOutput, normalizeLanguage } = require('./tools-run-code');

/** @type {import('./workspace-index')} */
let workspaceIndexModule = null;
function getWorkspaceIndexModule() {
  if (workspaceIndexModule !== null) return workspaceIndexModule;
  try {
    workspaceIndexModule = require('./workspace-index');
  } catch {
    workspaceIndexModule = null;
  }
  return workspaceIndexModule;
}

const MAX_FILE_BYTES = 100 * 1024;
const DEFAULT_FILE_BYTES = 30 * 1024;
const MAX_SEARCH_FILE_BYTES = 64 * 1024;
const MAX_SEARCH_SCAN_FILES = 700;
const MAX_TOOL_OUTPUT = 12000;
const WORKSPACE_INDEX_TTL_MS = 5 * 60 * 1000;
const WORKSPACE_INDEX_DISK_TTL_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_INDEX_DISK_MAX_BYTES = 8 * 1024 * 1024;
const WORKSPACE_INDEX_DISK_VERSION = 1;
const WORKSPACE_INDEX_CACHE_MAX = 8;
const RUN_CODE_SECURITY_LIMITS = {
  maxOutputBytes: 1024 * 1024, // 1MB
  maxMemoryMB: 512,
  maxTimeoutMs: 5000,
  killTreeOnTimeout: true,
};

const MAX_READ_MANY_FILES_BYTES = 500 * 1024;
const PROJECT_MAP_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', 'release']);

const TOOL_SCHEMAS = {
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web through the configured Tavily Search API and return concise sourced results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          queries: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 4,
            description:
              'Optional multiple planned search queries for research mode. Results are merged and de-duplicated by URL.',
          },
          max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum number of results.' },
        },
      },
    },
  },
  list_files: {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List text-oriented files inside a user-approved workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          root: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to list.' },
          pattern: { type: 'string', description: 'Optional filename substring or simple wildcard pattern.' },
          recent_days: {
            type: 'integer',
            minimum: 1,
            maximum: 3650,
            description: 'Only include files modified within this many days.',
          },
          sort_by: { type: 'string', enum: ['name', 'modified'], description: 'Sort files by name or modified time.' },
        },
      },
    },
  },
  search_workspace: {
    type: 'function',
    function: {
      name: 'search_workspace',
      description:
        'Search text files, file names, paths, or an exact code symbol inside a user-approved workspace. Returns IDE-like structured results with file, line range, score, kind, symbol, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword or phrase to search for.' },
          symbol: {
            type: 'string',
            description: 'Optional exact function/class/variable/component symbol to search for.',
          },
          root: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to search.' },
          pattern: { type: 'string', description: 'Optional filename substring or wildcard, such as *.js or README.' },
          max_results: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum number of file hits.' },
        },
      },
    },
  },
  index_workspace: {
    type: 'function',
    function: {
      name: 'index_workspace',
      description:
        'Build or refresh a lightweight cached index of approved workspace text files for faster cited search.',
      parameters: {
        type: 'object',
        properties: {
          root: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to index.' },
          pattern: { type: 'string', description: 'Optional filename substring or wildcard, such as *.js or README.' },
          force_refresh: { type: 'boolean', description: 'Rebuild the index even when a fresh cached index exists.' },
          max_files: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_SEARCH_SCAN_FILES,
            description: 'Maximum files to scan.',
          },
        },
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file inside a user-approved workspace directory. Supports focused line ranges via start_line/end_line or path citations like src/file.js:10-20.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
          max_bytes: { type: 'integer', minimum: 1024, maximum: MAX_FILE_BYTES, description: 'Maximum bytes to read.' },
          start_line: {
            type: 'integer',
            minimum: 1,
            description: 'Optional 1-based line number to start reading from.',
          },
          end_line: { type: 'integer', minimum: 1, description: 'Optional 1-based line number to stop reading at.' },
        },
        required: ['path'],
      },
    },
  },
  read_symbol: {
    type: 'function',
    function: {
      name: 'read_symbol',
      description:
        'Read the definition block for a function, class, variable, or component symbol inside a user-approved workspace. Prefer this before reading broad file ranges when the user names a code symbol.',
      parameters: {
        type: 'object',
        properties: {
          symbol: {
            type: 'string',
            description: 'Exact symbol name to locate, such as renderMarkdown or buildContextBudgetBundle.',
          },
          root: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to search.' },
          pattern: {
            type: 'string',
            description: 'Optional filename substring or wildcard, such as *.js or renderer.',
          },
          context_lines: {
            type: 'integer',
            minimum: 0,
            maximum: 20,
            description: 'Extra lines before and after the symbol definition.',
          },
          max_lines: {
            type: 'integer',
            minimum: 20,
            maximum: 240,
            description: 'Maximum lines returned for the symbol block.',
          },
        },
        required: ['symbol'],
      },
    },
  },
  run_code: {
    type: 'function',
    function: {
      name: 'run_code',
      description:
        'Run a small JavaScript or Python snippet after explicit user approval. Security limits: 5s timeout, process-tree kill on timeout, 1MB output cap, 512MB memory limit, output redaction for secrets.',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['javascript', 'js', 'python', 'py'], description: 'Runtime language.' },
          code: { type: 'string', description: 'Complete code snippet to execute.' },
          stdin: { type: 'string', description: 'Optional stdin.' },
        },
        required: ['language', 'code'],
      },
    },
  },
  git_status: {
    type: 'function',
    function: {
      name: 'git_status',
      description:
        'Show the Git working tree status for an approved workspace directory. Returns a structured list of changed, added, deleted, untracked, and conflicted files. Read-only operation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
        },
      },
    },
  },
  git_diff: {
    type: 'function',
    function: {
      name: 'git_diff',
      description:
        'Show Git diff output for an approved workspace directory, optionally filtered to a single file or the staging area. Returns structured file list with additions, deletions, and full diff text. Read-only operation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          file: { type: 'string', description: 'Optional workspace-relative file path to diff.' },
          staged: { type: 'boolean', description: 'If true, show staged changes instead of unstaged changes.' },
        },
      },
    },
  },
  git_log: {
    type: 'function',
    function: {
      name: 'git_log',
      description:
        'Show Git commit history for an approved workspace directory, optionally filtered to a single file. Returns structured commit list with hash, author, date, and message. Read-only operation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          count: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of recent commits to show.' },
          file: { type: 'string', description: 'Optional workspace-relative file path to filter commits.' },
        },
      },
    },
  },
  project_map: {
    type: 'function',
    function: {
      name: 'project_map',
      description:
        'Generate a tree-like project structure overview with file counts per directory. Excludes .git, node_modules, dist, build, .cache, and release directories. Read-only, low-risk operation.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Approved workspace root. If omitted, the first configured root is used.',
          },
          maxDepth: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description: 'Maximum directory depth to traverse. Defaults to 4.',
          },
        },
      },
    },
  },
  read_many_files: {
    type: 'function',
    function: {
      name: 'read_many_files',
      description:
        'Read multiple text files at once from an approved workspace. Each file is returned with a path header. Total output capped at 500KB. Read-only, medium-risk (bulk read) operation.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 50,
            description: 'List of absolute or workspace-relative file paths to read.',
          },
          maxTotalBytes: {
            type: 'integer',
            minimum: 1024,
            maximum: MAX_READ_MANY_FILES_BYTES,
            description: 'Maximum total bytes to read across all files. Defaults to 500KB.',
          },
        },
        required: ['paths'],
      },
    },
  },
};

const MODE_TOOLS = {
  none: [],
  web_search: ['web_search'],
  file_reader: [
    'index_workspace',
    'list_files',
    'search_workspace',
    'read_symbol',
    'read_file',
    'project_map',
    'read_many_files',
    'git_status',
    'git_diff',
    'git_log',
  ],
  code_runner: ['run_code'],
  multi_tool: [
    'web_search',
    'index_workspace',
    'list_files',
    'search_workspace',
    'read_symbol',
    'read_file',
    'project_map',
    'read_many_files',
    'run_code',
    'git_status',
    'git_diff',
    'git_log',
  ],
};

const workspaceIndexCache = new Map();

function getToolDefinitions(activeSkill) {
  const ids = MODE_TOOLS[activeSkill] || [];
  return ids.map((id) => TOOL_SCHEMAS[id]).filter(Boolean);
}

function getToolModeStatus(settings) {
  const roots = settings.workspaceRoots || [];
  return {
    web_search: Boolean(settings.tavilyApiKey),
    file_reader: roots.length > 0,
    code_runner: settings.runCodeEnabled !== false && settings.runCodeEnabled !== 'false',
    multi_tool: Boolean(settings.tavilyApiKey) || roots.length > 0,
  };
}

function describeToolRisk(name, args) {
  if (name === 'web_search') {
    const queries = normalizeSearchQueries(args);
    const preview =
      queries.length > 1 ? `${queries.length} 个 query：${queries.join(' / ')}` : queries[0] || args.query || '';
    return `将使用 Tavily 搜索网络：${String(preview || '').slice(0, 180)}`;
  }
  if (name === 'list_files') {
    const directory = String(args.directory || '').trim();
    return directory
      ? `将列出已授权工作区目录 ${directory.slice(0, 160)} 内的文件名，不会读取文件内容。`
      : '将列出已授权工作区内的文件名，不会读取文件内容。';
  }
  if (name === 'search_workspace') {
    const directory = String(args.directory || '').trim();
    const query = String(args.symbol || args.query || '').slice(0, 120);
    return directory
      ? `将在已授权工作区目录 ${directory.slice(0, 160)} 内搜索文本：${query}，并返回文件行号引用。`
      : `将在已授权工作区内搜索文本：${query}，并返回文件行号引用。`;
  }
  if (name === 'index_workspace') {
    const directory = String(args.directory || '').trim();
    return directory
      ? `将在已授权工作区目录 ${directory.slice(0, 160)} 内建立轻量文本索引，跳过敏感路径和二进制文件。`
      : '将在已授权工作区内建立轻量文本索引，跳过敏感路径和二进制文件。';
  }
  if (name === 'read_file') {
    const citation = parsePathLineCitation(args.path);
    const startLine = args.start_line || citation.startLine;
    const endLine = args.end_line || citation.endLine || startLine;
    const lineRange = startLine ? `（行 ${startLine}${endLine && endLine !== startLine ? `-${endLine}` : ''}）` : '';
    return `将读取已授权工作区内的文本文件：${String(citation.path || args.path || '').slice(0, 160)}${lineRange}`;
  }
  if (name === 'read_symbol') {
    const directory = String(args.directory || '').trim();
    const symbol = String(args.symbol || '')
      .trim()
      .slice(0, 160);
    return directory
      ? `将在已授权工作区目录 ${directory.slice(0, 160)} 内读取代码符号：${symbol}，并返回定义位置和上下文片段。`
      : `将在已授权工作区内读取代码符号：${symbol}，并返回定义位置和上下文片段。`;
  }
  if (name === 'run_code') {
    return [
      '将运行代码片段；请确认代码可信。',
      `语言：${normalizeLanguage(args.language) || '未知'}`,
      `代码长度：${String(args.code || '').length} chars`,
      `超时：${RUN_CODE_SECURITY_LIMITS.maxTimeoutMs}ms · 进程树终止：${RUN_CODE_SECURITY_LIMITS.killTreeOnTimeout ? '是' : '否'}`,
      `输出上限：${RUN_CODE_SECURITY_LIMITS.maxOutputBytes / 1024 / 1024}MB · 内存上限：${RUN_CODE_SECURITY_LIMITS.maxMemoryMB}MB`,
      '权限：独立临时 cwd/HOME/TEMP，环境变量已清洗；Windows 轻沙箱不承诺硬网络隔离。',
      '安全：stdout/stderr 含密钥/token 时自动脱敏。',
    ].join('\n');
  }
  if (name === 'git_status') {
    return '将读取已授权工作区的 Git 工作区状态，显示未提交的更改文件列表。只读操作。';
  }
  if (name === 'git_diff') {
    const file = String(args.file || '').trim();
    const staged = Boolean(args.staged);
    return file
      ? `将读取已授权工作区内文件 ${file.slice(0, 160)} 的 Git 差异（${staged ? '已暂存' : '未暂存'}），显示更改内容。只读操作。`
      : `将读取已授权工作区的 Git 差异（${staged ? '已暂存' : '未暂存'}），显示所有更改文件的内容。只读操作。`;
  }
  if (name === 'git_log') {
    const count = clampInt(args.count, 1, 100, 10);
    const file = String(args.file || '').trim();
    return file
      ? `将读取已授权工作区内文件 ${file.slice(0, 160)} 的最近 ${count} 条 Git 提交历史。只读操作。`
      : `将读取已授权工作区的最近 ${count} 条 Git 提交历史。只读操作。`;
  }
  if (name === 'project_map') {
    const maxDepth = clampInt(args.maxDepth, 1, 10, 4);
    return `将生成已授权工作区的项目结构概览（最大深度 ${maxDepth}），排除 .git、node_modules 等目录。只读操作。`;
  }
  if (name === 'read_many_files') {
    const paths = Array.isArray(args.paths) ? args.paths : [];
    const maxTotalBytes = clampInt(args.maxTotalBytes, 1024, MAX_READ_MANY_FILES_BYTES, MAX_READ_MANY_FILES_BYTES);
    return `将批量读取已授权工作区内的 ${paths.length} 个文本文件（总上限 ${Math.round(maxTotalBytes / 1024)}KB）。只读操作。`;
  }
  return '未知工具调用。';
}

async function executeTool(name, args, settings, signal) {
  let output;
  if (name === 'web_search') output = await webSearch(args, settings);
  else if (name === 'list_files') output = await listFiles(args, settings);
  else if (name === 'index_workspace') output = await indexWorkspace(args, settings);
  else if (name === 'search_workspace') output = await searchWorkspace(args, settings);
  else if (name === 'read_file') output = await readFile(args, settings);
  else if (name === 'read_symbol') output = await readSymbol(args, settings);
  else if (name === 'run_code') output = await runCode(args, settings);
  else if (name === 'git_status') output = await gitStatus(args, settings);
  else if (name === 'git_diff') output = await gitDiff(args, settings);
  else if (name === 'git_log') output = await gitLog(args, settings);
  else if (name === 'project_map') output = await projectMap(args, settings);
  else if (name === 'read_many_files') output = await readManyFiles(args, settings);
  else throw new Error(`不支持的工具：${name}`);
  return redactSensitiveText(output);
}

async function listFiles(args, settings) {
  const root = await resolveWorkspaceRoot(args.root, settings.workspaceRoots || []);
  const directory = String(args.directory || '').trim();
  const scanRoot = directory ? await resolveAllowedDirectory(directory, [root]) : root;
  const realRoot = await fs.realpath(root).catch(() => root);
  const pattern = String(args.pattern || '').trim();
  const matcher = createMatcher(pattern);
  const recentDays = clampInt(args.recent_days, 0, 3650, 0);
  const sortBy = String(args.sort_by || '')
    .trim()
    .toLowerCase();
  const sortByModified = sortBy === 'modified' || recentDays > 0;
  const cutoff = recentDays > 0 ? Date.now() - recentDays * 24 * 60 * 60 * 1000 : 0;
  const files = [];
  await walk(scanRoot, scanRoot, files, matcher);
  const matchedFiles = files
    .filter((file) => cutoff <= 0 || file.mtimeMs >= cutoff)
    .sort((a, b) =>
      sortByModified ? b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path) : a.path.localeCompare(b.path)
    );
  const relativeDirectory = path.relative(realRoot, scanRoot) || '.';
  if (matchedFiles.length === 0) return `工作区 ${root} 的目录 ${relativeDirectory} 中没有找到匹配文件。`;
  return [
    `工作区：${root}`,
    `目录：${relativeDirectory}`,
    recentDays > 0 ? `筛选：最近 ${recentDays} 天修改` : '',
    `排序：${sortByModified ? '修改时间倒序' : '文件名'}`,
    `匹配文件数：${matchedFiles.length}`,
    '',
    ...matchedFiles.slice(0, 200).map((file) => formatListedFile(file, sortByModified)),
    matchedFiles.length > 200 ? `\n仅显示前 200 个结果。` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

async function indexWorkspace(args, settings) {
  const index = await getWorkspaceIndex(args, settings, {
    forceRefresh: Boolean(args.force_refresh),
    maxFiles: clampInt(args.max_files, 1, MAX_SEARCH_SCAN_FILES, MAX_SEARCH_SCAN_FILES),
  });
  return formatWorkspaceIndexOutput(index);
}

async function searchWorkspace(args, settings) {
  const rawQuery = String(args.query || args.symbol || '').trim();
  if (!rawQuery) throw new Error('搜索关键词不能为空。');

  const parsed = parseWorkspaceQuery(rawQuery);
  const symbol = normalizeSearchSymbol(args.symbol || parsed.symbol);
  const query = parsed.textQuery || symbol;
  const maxResults = clampInt(args.max_results, 1, 20, 8);

  // --- SQLite FTS5 fast path ---
  const indexMod = getWorkspaceIndexModule();
  if (indexMod) {
    try {
      const root = await resolveWorkspaceRoot(args.root, settings.workspaceRoots || []);
      const directory = String(args.directory || '').trim();
      let resolvedRoot = root;
      if (directory) {
        const resolved = await resolveAllowedDirectory(directory, [root]);
        resolvedRoot = resolved;
      } else {
        resolvedRoot = root;
      }
      const pattern = String(args.pattern || '').trim();
      const directiveSummary = buildDirectiveSummary(parsed);

      const searchQuery = symbol || query;
      const ftsResults = indexMod.searchWorkspace(searchQuery, {
        root: resolvedRoot,
        pattern: pattern || undefined,
        limit: maxResults,
      });

      if (ftsResults.length > 0) {
        const structured = {
          type: 'deepchat.workspaceSearchResults',
          version: 1,
          query,
          symbol: symbol || '',
          root: resolvedRoot,
          directory: directory || '.',
          pattern: pattern || '',
          index: {
            cache: 'sqlite-fts5',
            fileCount: indexMod.getWorkspaceStats().fileCount,
            chunkCount: indexMod.getWorkspaceStats().chunkCount,
            snapshotHash: '',
            hash: '',
          },
          results: ftsResults.map((hit, i) => ({
            index: i + 1,
            file: hit.file.replace(/\\/g, '/'),
            startLine: hit.lineStart,
            endLine: hit.lineEnd,
            score: hit.score,
            scoreBreakdown: { content: hit.score },
            matchReasons: ['content'],
            kind: inferWorkspaceHitKind({ snippet: hit.snippet }, symbol),
            symbol: symbol || inferWorkspaceHitSymbol({ snippet: hit.snippet }),
            truncated: false,
            snippet: hit.snippet,
          })),
        };

        const lines = [
          `工作区搜索：${rawQuery}`,
          directiveSummary,
          symbol ? `符号：${symbol}` : '',
          `工作区：${resolvedRoot}`,
          directory ? `目录：${directory}` : '',
          pattern ? `文件筛选：${pattern}` : '',
          `索引：sqlite-fts5 · files=${structured.index.fileCount} · chunks=${structured.index.chunkCount}`,
          `结果数：${ftsResults.length}`,
          'Structured Results:',
          JSON.stringify(structured, null, 2),
          '',
        ].filter(Boolean);

        ftsResults.forEach((hit, i) => {
          lines.push(`${i + 1}. ${hit.file.replace(/\\/g, '/')}:${hit.lineStart}-${hit.lineEnd}`);
          lines.push(`   score: ${hit.score.toFixed(2)}`);
          lines.push('   摘录:');
          for (const s of hit.snippet) {
            lines.push(`   ${s.line}: ${s.text}`);
          }
          lines.push('');
        });
        return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
      }
    } catch {
      // SQLite FTS5 not available; fall back to legacy path
    }
  }

  // --- Legacy in-memory search path ---
  const index = await getWorkspaceIndex(args, settings);

  // Apply directive filters
  const filteredFiles = index.files.filter((file) => {
    if (!matchesFileDirective(file.path, parsed)) return false;
    if (!matchesChangedDirective(file.mtimeMs, parsed)) return false;
    return true;
  });

  const terms = tokenizeSearchQuery(query);
  const queryLower = query.toLowerCase();
  const hits = [];
  for (const file of filteredFiles) {
    if (hits.length >= maxResults * 4) break;
    const fileRelevance = scoreWorkspaceFileRelevance(file, query, terms, symbol);
    const fileHits = findTextHits(file.text, terms, queryLower, symbol, 2);
    if (fileHits.length === 0 && hasFileIdentityMatch(fileRelevance)) {
      hits.push({
        ...buildFileNameWorkspaceHit(file),
        file: file.path,
        size: file.size || 0,
        truncated: (file.size || 0) > MAX_SEARCH_FILE_BYTES,
        fileRelevance,
      });
      continue;
    }
    for (const hit of fileHits) {
      hits.push({
        ...hit,
        file: file.path,
        size: file.size || 0,
        truncated: (file.size || 0) > MAX_SEARCH_FILE_BYTES,
        fileRelevance,
      });
      if (hits.length >= maxResults * 4) break;
    }
  }

  const rankedHits = hits.map((hit) => scoreWorkspaceHit(hit));
  rankedHits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.lineStart - b.lineStart);
  const selected = rankedHits.slice(0, maxResults);

  const directiveSummary = buildDirectiveSummary(parsed);
  if (selected.length === 0) {
    const structured = buildWorkspaceSearchStructuredResults({ query, symbol, index, selected });
    return [
      `工作区搜索：${rawQuery}`,
      directiveSummary,
      `工作区：${index.root}`,
      `目录：${index.relativeDirectory}`,
      index.pattern ? `文件筛选：${index.pattern}` : '',
      `索引：${formatWorkspaceIndexCacheLabel(index)} · files=${index.fileCount} · chunks=${index.chunkCount} · snapshot=${index.snapshotHash || 'none'} · hash=${index.hash}`,
      'Structured Results:',
      JSON.stringify(structured, null, 2),
      '没有找到匹配的文本结果。',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const structured = buildWorkspaceSearchStructuredResults({ query, symbol, index, selected });
  const lines = [
    `工作区搜索：${rawQuery}`,
    directiveSummary,
    symbol ? `符号：${symbol}` : '',
    `工作区：${index.root}`,
    `目录：${index.relativeDirectory}`,
    index.pattern ? `文件筛选：${index.pattern}` : '',
    `索引：${formatWorkspaceIndexCacheLabel(index)} · files=${index.fileCount} · chunks=${index.chunkCount} · snapshot=${index.snapshotHash || 'none'} · hash=${index.hash}`,
    `结果数：${selected.length}`,
    'Structured Results:',
    JSON.stringify(structured, null, 2),
    '',
  ].filter(Boolean);
  selected.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.file}:${hit.lineStart}-${hit.lineEnd}`);
    lines.push(`   score: ${hit.score}`);
    if (hit.truncated) lines.push(`   说明：文件超过 ${MAX_SEARCH_FILE_BYTES} bytes，仅搜索开头片段。`);
    lines.push('   摘录:');
    for (const item of hit.snippet) {
      lines.push(`   ${item.line}: ${item.text}`);
    }
    lines.push('');
  });
  return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function buildDirectiveSummary(parsed) {
  const parts = [];
  if (parsed.file.length) parts.push(`文件过滤：${parsed.file.join(', ')}`);
  if (parsed.folder.length) parts.push(`目录过滤：${parsed.folder.join(', ')}`);
  if (parsed.symbol) parts.push(`符号：${parsed.symbol}`);
  if (parsed.changedDays !== null) parts.push(`最近 ${parsed.changedDays} 天修改`);
  if (parsed.recentOnly) parts.push('最近修改');
  return parts.length ? `筛选：${parts.join(' · ')}` : '';
}

function buildWorkspaceSearchStructuredResults({ query, symbol, index, selected }) {
  return {
    type: 'deepchat.workspaceSearchResults',
    version: 1,
    query,
    symbol: symbol || '',
    root: index.root,
    directory: index.relativeDirectory,
    pattern: index.pattern || '',
    index: {
      cache: formatWorkspaceIndexCacheLabel(index),
      fileCount: index.fileCount,
      chunkCount: index.chunkCount,
      snapshotHash: index.snapshotHash || '',
      hash: index.hash,
    },
    results: selected.map((hit, resultIndex) => ({
      index: resultIndex + 1,
      file: normalizeWorkspaceResultPath(hit.file),
      startLine: hit.lineStart,
      endLine: hit.lineEnd,
      score: hit.score,
      scoreBreakdown: hit.scoreBreakdown || {},
      matchReasons: hit.matchReasons || [],
      kind: inferWorkspaceHitKind(hit, symbol),
      symbol: symbol || inferWorkspaceHitSymbol(hit),
      truncated: Boolean(hit.truncated),
      snippet: hit.snippet.map((item) => ({
        line: item.line,
        text: item.text,
      })),
    })),
  };
}

async function readSymbol(args, settings) {
  const symbol = normalizeSearchSymbol(args.symbol);
  if (!symbol) throw new Error('符号名称不能为空，且只能包含字母、数字、_、$、. 或 -。');
  const contextLines = clampInt(args.context_lines, 0, 20, 3);
  const maxLines = clampInt(args.max_lines, 20, 240, 120);

  let matches = [];

  // --- SQLite FTS5 fast path ---
  const indexMod = getWorkspaceIndexModule();
  if (indexMod) {
    try {
      const root = await resolveWorkspaceRoot(args.root, settings.workspaceRoots || []);
      const directory = String(args.directory || '').trim();
      let resolvedRoot = root;
      if (directory) resolvedRoot = await resolveAllowedDirectory(directory, [root]);
      const pattern = String(args.pattern || '').trim();

      const dbSymbols = indexMod.findSymbol(symbol, { root: resolvedRoot });
      const filtered = pattern ? dbSymbols.filter((s) => s.file.replace(/\\/g, '/').includes(pattern)) : dbSymbols;

      if (filtered.length > 0) {
        for (const sym of filtered) {
          const contentLines = [];
          for (const ctx of sym.context) {
            const lines = ctx.content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              contentLines.push({ line: ctx.lineStart + i, text: lines[i] });
            }
          }
          const symLine = contentLines.findIndex((l) => l.line === sym.line);
          const startIdx = Math.max(0, symLine - contextLines);
          const uncappedEndIdx = Math.min(contentLines.length - 1, symLine + 1 + contextLines);
          const endIdx = Math.min(uncappedEndIdx, startIdx + maxLines - 1);
          const snippet = contentLines.slice(startIdx, endIdx + 1);

          matches.push({
            file: sym.file,
            startLine: startIdx + 1,
            endLine: endIdx + 1,
            definitionLine: sym.line,
            score: 20,
            kind: sym.kind === 'export' ? 'function' : sym.kind,
            signature: (contentLines[symLine]?.text || '').trim().slice(0, 240),
            truncated: uncappedEndIdx > endIdx,
            snippet,
          });
        }
      }
    } catch {
      // SQLite not available; fall back to legacy path
    }
  }

  // --- Legacy fallback ---
  if (matches.length === 0) {
    const index = await getWorkspaceIndex({ ...args, symbol, query: symbol }, settings);
    for (const file of index.files) {
      const symbolHits = findSymbolDefinitionHits(file, symbol, { contextLines, maxLines });
      for (const hit of symbolHits) matches.push(hit);
    }
  }

  const index =
    matches.length > 0
      ? {
          root: settings.workspaceRoots?.[0] || '',
          relativeDirectory: String(args.directory || '.'),
          pattern: String(args.pattern || ''),
          fileCount: 0,
          chunkCount: 0,
          snapshotHash: '',
          hash: '',
          fromCache: false,
          cacheLayer: '',
          builtAtMs: 0,
        }
      : await getWorkspaceIndex({ ...args, symbol, query: symbol }, settings);

  matches.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.startLine - b.startLine);
  const selected = matches[0] || null;
  const structured = buildWorkspaceSymbolStructuredResult({
    symbol,
    index,
    selected,
    alternatives: matches.slice(1, 6),
  });

  if (!selected) {
    return [
      `符号读取：${symbol}`,
      `工作区：${index.root}`,
      `目录：${index.relativeDirectory}`,
      index.pattern ? `文件筛选：${index.pattern}` : '',
      `索引：${formatWorkspaceIndexCacheLabel(index)} · files=${index.fileCount} · chunks=${index.chunkCount} · snapshot=${index.snapshotHash || 'none'} · hash=${index.hash}`,
      'Structured Symbol:',
      JSON.stringify(structured, null, 2),
      `没有找到 ${symbol} 的明确符号定义。可先调用 search_workspace({ "symbol": "${symbol}" }) 查看引用。`,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_TOOL_OUTPUT);
  }

  const lines = [
    `符号读取：${symbol}`,
    `工作区：${index.root}`,
    `目录：${index.relativeDirectory}`,
    index.pattern ? `文件筛选：${index.pattern}` : '',
    `索引：${formatWorkspaceIndexCacheLabel(index)} · files=${index.fileCount} · chunks=${index.chunkCount} · snapshot=${index.snapshotHash || 'none'} · hash=${index.hash}`,
    `结果：${selected.file}:${selected.startLine}-${selected.endLine}`,
    `类型：${selected.kind}`,
    selected.signature ? `签名：${selected.signature}` : '',
    'Structured Symbol:',
    JSON.stringify(structured, null, 2),
    '',
    '代码片段:',
    ...selected.snippet.map((item) => `${item.line}: ${item.text}`),
  ].filter(Boolean);
  return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function findSymbolDefinitionHits(file, symbol, options = {}) {
  const lines = String(file.text || '').split(/\r?\n/);
  const hits = [];
  const symbolPattern = createSymbolPattern(symbol);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] || '';
    if (!symbolPattern.test(line) || !looksLikeSymbolDefinition(line, symbol)) continue;
    const definitionEnd = inferSymbolDefinitionEnd(lines, index);
    const contextLines = clampInt(options.contextLines, 0, 20, 3);
    const maxLines = clampInt(options.maxLines, 20, 240, 120);
    const startIndex = Math.max(0, index - contextLines);
    const uncappedEndIndex = Math.min(lines.length - 1, definitionEnd + contextLines);
    const endIndex = Math.min(uncappedEndIndex, startIndex + maxLines - 1);
    const snippet = [];
    for (let lineIndex = startIndex; lineIndex <= endIndex; lineIndex += 1) {
      snippet.push({ line: lineIndex + 1, text: truncateCodeLine(lines[lineIndex] || '') });
    }
    hits.push({
      file: file.path,
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      definitionLine: index + 1,
      score: scoreSymbolDefinitionHit(file.path, line, symbol),
      kind: inferSymbolKind(line, symbol),
      signature: truncateLine(line),
      truncated: uncappedEndIndex > endIndex || Boolean(file.truncated),
      snippet,
    });
  }
  return hits;
}

function inferSymbolDefinitionEnd(lines, startIndex) {
  let braceDepth = 0;
  let sawBrace = false;
  for (let index = startIndex; index < lines.length; index++) {
    const line = stripLineComments(lines[index] || '');
    for (const char of line) {
      if (char === '{') {
        braceDepth += 1;
        sawBrace = true;
      } else if (char === '}') {
        braceDepth -= 1;
      }
    }
    if (sawBrace && braceDepth <= 0 && index > startIndex) return index;
    if (!sawBrace && index > startIndex && !String(lines[index] || '').trim()) return Math.max(startIndex, index - 1);
  }
  return Math.min(lines.length - 1, startIndex + 40);
}

function stripLineComments(line) {
  return String(line || '').replace(/\/\/.*$/, '');
}

function scoreSymbolDefinitionHit(filePath, line, symbol) {
  let score = 20;
  const fileName = path.basename(String(filePath || '')).toLowerCase();
  const symbolLower = String(symbol || '').toLowerCase();
  if (fileName.includes(symbolLower)) score += 3;
  if (/^\s*export\b/.test(line)) score += 2;
  if (/^\s*(export\s+)?(async\s+)?function\s+/u.test(line)) score += 2;
  if (/^\s*(export\s+)?class\s+/u.test(line)) score += 2;
  return score;
}

function inferSymbolKind(line, symbol) {
  const text = String(line || '');
  if (/^\s*(export\s+)?(async\s+)?function\s+/u.test(text)) return 'function';
  if (/^\s*(export\s+)?class\s+/u.test(text)) return 'class';
  if (/^\s*(export\s+)?(?:const|let|var)\s+/u.test(text)) return 'variable';
  if (new RegExp(`<${symbol}(?:\\s|>|/)`, 'u').test(text)) return 'component';
  if (new RegExp(`(?:async\\s+)?${symbol}\\s*\\(`, 'u').test(text)) return 'method';
  return 'symbol';
}

function buildWorkspaceSymbolStructuredResult({ symbol, index, selected, alternatives = [] }) {
  return {
    type: 'deepchat.workspaceSymbolResult',
    version: 1,
    symbol,
    root: index.root,
    directory: index.relativeDirectory,
    pattern: index.pattern || '',
    index: {
      cache: formatWorkspaceIndexCacheLabel(index),
      fileCount: index.fileCount,
      chunkCount: index.chunkCount,
      snapshotHash: index.snapshotHash || '',
      hash: index.hash,
    },
    result: selected ? formatWorkspaceSymbolHit(selected) : null,
    alternatives: alternatives.map(formatWorkspaceSymbolHit),
  };
}

function formatWorkspaceSymbolHit(hit) {
  return {
    file: normalizeWorkspaceResultPath(hit.file),
    startLine: hit.startLine,
    endLine: hit.endLine,
    definitionLine: hit.definitionLine,
    score: hit.score,
    kind: hit.kind,
    signature: hit.signature || '',
    truncated: Boolean(hit.truncated),
    snippet: hit.snippet.map((item) => ({
      line: item.line,
      text: item.text,
    })),
  };
}

function normalizeWorkspaceResultPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function inferWorkspaceHitKind(hit, symbol = '') {
  const text = (hit?.snippet || []).map((item) => item.text).join('\n');
  if (symbol && text.split(/\r?\n/).some((line) => looksLikeSymbolDefinition(line, symbol))) return 'symbol';
  if (/^\s*(export\s+)?(async\s+)?function\s+/m.test(text)) return 'function';
  if (/^\s*(export\s+)?class\s+/m.test(text)) return 'class';
  if (/^\s*(export\s+)?(?:const|let|var)\s+/m.test(text)) return 'variable';
  if (/^\s*#{1,6}\s+/m.test(text)) return 'markdown-section';
  return 'text';
}

function inferWorkspaceHitSymbol(hit) {
  const text = (hit?.snippet || []).map((item) => item.text).join('\n');
  const match =
    text.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([\p{L}_$][\p{L}\p{N}_$]*)\b/mu) ||
    text.match(/^\s*(?:export\s+)?class\s+([\p{L}_$][\p{L}\p{N}_$]*)\b/mu) ||
    text.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)\b/mu);
  return match?.[1] || '';
}

async function getWorkspaceIndex(args, settings, options = {}) {
  const root = await resolveWorkspaceRoot(args.root, settings.workspaceRoots || []);
  const directory = String(args.directory || '').trim();
  const scanRoot = directory ? await resolveAllowedDirectory(directory, [root]) : root;
  const realRoot = await fs.realpath(root).catch(() => root);
  const realScanRoot = await fs.realpath(scanRoot).catch(() => scanRoot);
  const pattern = String(args.pattern || '').trim();
  const maxFiles = clampInt(options.maxFiles ?? args.max_files, 1, MAX_SEARCH_SCAN_FILES, MAX_SEARCH_SCAN_FILES);
  const cacheKey = buildWorkspaceIndexCacheKey(realRoot, realScanRoot, pattern, maxFiles);
  const cached = workspaceIndexCache.get(cacheKey);
  const now = Date.now();
  if (!options.forceRefresh && cached && now - cached.builtAtMs < WORKSPACE_INDEX_TTL_MS) {
    return {
      ...cached,
      fromCache: true,
      cacheLayer: 'memory',
      ageMs: now - cached.builtAtMs,
    };
  }

  const matcher = createMatcher(pattern);
  const rawFiles = [];
  await walk(realScanRoot, realScanRoot, rawFiles, matcher, maxFiles);
  const snapshot = buildWorkspaceSnapshot(rawFiles, realRoot);
  if (
    !options.forceRefresh &&
    cached &&
    cached.snapshotHash === snapshot.hash &&
    now - cached.builtAtMs < WORKSPACE_INDEX_DISK_TTL_MS
  ) {
    return {
      ...cached,
      rawFileCount: rawFiles.length,
      snapshotFileCount: snapshot.fileCount,
      fromCache: true,
      cacheLayer: 'memory',
      ageMs: now - cached.builtAtMs,
    };
  }

  let incrementalCache = null;
  if (!options.forceRefresh) {
    const diskIndex = await readWorkspaceIndexDiskCache(cacheKey, snapshot.hash, settings, now);
    if (diskIndex) {
      const restored = {
        ...diskIndex,
        rawFileCount: rawFiles.length,
        snapshotFileCount: snapshot.fileCount,
        fromCache: true,
        cacheLayer: 'disk',
        ageMs: now - diskIndex.builtAtMs,
      };
      rememberWorkspaceIndex(cacheKey, restored);
      return restored;
    }
    // Try incremental: load old cache even if snapshot changed
    incrementalCache = await readWorkspaceIndexDiskCacheRaw(cacheKey, settings);
  }

  const files = [];
  let skippedSensitive = 0;
  let skippedBinary = 0;
  let scannedBytes = 0;
  let chunkCount = 0;
  let reusedCount = 0;

  const oldFileMap = incrementalCache?.files ? new Map(incrementalCache.files.map((f) => [f.path, f])) : new Map();

  for (const file of rawFiles) {
    if (!file.fullPath) continue;
    if (isSensitivePath(file.fullPath)) {
      skippedSensitive += 1;
      continue;
    }
    const relPath = path.relative(realRoot, file.fullPath) || file.path;
    const oldFile = oldFileMap.get(relPath);
    // Attempt incremental reuse if path, size, and mtime match exactly
    if (
      oldFile &&
      oldFile.size === (file.size || 0) &&
      oldFile.mtimeMs === (file.mtimeMs || 0) &&
      oldFile.text &&
      oldFile.sha256
    ) {
      files.push({
        path: relPath,
        fullPath: file.fullPath,
        size: file.size || 0,
        mtimeMs: file.mtimeMs || 0,
        sha256: oldFile.sha256,
        lineCount: oldFile.lineCount,
        chunks: oldFile.chunks,
        text: oldFile.text,
      });
      chunkCount += oldFile.chunks;
      scannedBytes += Math.min(file.size || MAX_SEARCH_FILE_BYTES, MAX_SEARCH_FILE_BYTES);
      reusedCount += 1;
      continue;
    }
    const readResult = await readSearchableFile(
      file.fullPath,
      Math.min(file.size || MAX_SEARCH_FILE_BYTES, MAX_SEARCH_FILE_BYTES)
    );
    if (!readResult.text) {
      skippedBinary += 1;
      continue;
    }
    const lineCount = readResult.text.split(/\r?\n/).length;
    const chunks = Math.max(1, Math.ceil(lineCount / 80));
    chunkCount += chunks;
    scannedBytes += Math.min(file.size || Buffer.byteLength(readResult.text, 'utf8'), MAX_SEARCH_FILE_BYTES);
    files.push({
      path: relPath,
      fullPath: file.fullPath,
      size: file.size || 0,
      mtimeMs: file.mtimeMs || 0,
      sha256: readResult.sha256,
      lineCount,
      chunks,
      text: redactSensitiveText(readResult.text),
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const index = {
    cacheKey,
    root: realRoot,
    scanRoot: realScanRoot,
    relativeDirectory: path.relative(realRoot, realScanRoot) || '.',
    pattern,
    fileCount: files.length,
    rawFileCount: rawFiles.length,
    snapshotHash: snapshot.hash,
    snapshotFileCount: snapshot.fileCount,
    skippedSensitive,
    skippedBinary,
    scannedBytes,
    chunkCount,
    reusedCount,
    files,
    hash: buildWorkspaceIndexHash(files),
    builtAt: new Date(now).toISOString(),
    builtAtMs: now,
    ttlMs: WORKSPACE_INDEX_TTL_MS,
    fromCache: false,
    cacheLayer: reusedCount > 0 ? 'incremental' : 'new',
    ageMs: 0,
    diskCache: {
      enabled: Boolean(getWorkspaceIndexDiskDir(settings)),
      written: false,
    },
  };
  index.diskCache = await writeWorkspaceIndexDiskCache(cacheKey, index, settings);
  rememberWorkspaceIndex(cacheKey, index);
  return index;
}

function rememberWorkspaceIndex(cacheKey, index) {
  // Delete then re-insert to update LRU order
  if (workspaceIndexCache.has(cacheKey)) workspaceIndexCache.delete(cacheKey);
  workspaceIndexCache.set(cacheKey, index);
  while (workspaceIndexCache.size > WORKSPACE_INDEX_CACHE_MAX) {
    const firstKey = workspaceIndexCache.keys().next().value;
    if (firstKey === undefined) break;
    workspaceIndexCache.delete(firstKey);
  }
}

function clearWorkspaceIndexCache() {
  workspaceIndexCache.clear();
}

function buildWorkspaceIndexCacheKey(root, scanRoot, pattern, maxFiles) {
  return [root, scanRoot, pattern || '*', maxFiles].map((item) => String(item || '').toLowerCase()).join('\0');
}

function buildWorkspaceIndexHash(files = []) {
  const payload = files
    .map((file) => `${file.path}:${file.size}:${Math.round(file.mtimeMs || 0)}:${file.lineCount}`)
    .join('\n');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function buildWorkspaceSnapshot(rawFiles = [], realRoot = '') {
  const entries = rawFiles
    .filter((file) => file.fullPath && !isSensitivePath(file.fullPath))
    .map((file) =>
      [path.relative(realRoot, file.fullPath) || file.path, file.size || 0, Math.round(file.mtimeMs || 0)].join(':')
    )
    .sort();
  const payload = entries.join('\n');
  return {
    hash: crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16),
    fileCount: entries.length,
  };
}

function getWorkspaceIndexDiskDir(settings = {}) {
  const explicit = String(
    settings.workspaceIndexCacheDir || process.env.DEEPCHAT_WORKSPACE_INDEX_CACHE_DIR || ''
  ).trim();
  if (explicit) return explicit;
  const dataDir = String(settings.storageStatus?.dataDir || '').trim();
  return dataDir ? path.join(dataDir, 'workspace-indexes') : '';
}

function getWorkspaceIndexDiskPath(cacheKey, settings = {}) {
  const dir = getWorkspaceIndexDiskDir(settings);
  if (!dir) return '';
  const id = crypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 32);
  return path.join(dir, `${id}.json`);
}

async function readWorkspaceIndexDiskCache(cacheKey, snapshotHash, settings = {}, now = Date.now()) {
  const filePath = getWorkspaceIndexDiskPath(cacheKey, settings);
  if (!filePath) return null;
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.version !== WORKSPACE_INDEX_DISK_VERSION) return null;
  if (payload.cacheKeyHash !== buildWorkspaceIndexCacheFileId(cacheKey)) return null;
  if (payload.snapshotHash !== snapshotHash) return null;
  const index = payload.index;
  if (!index || !Array.isArray(index.files) || !Number.isFinite(index.builtAtMs)) return null;
  if (now - index.builtAtMs > WORKSPACE_INDEX_DISK_TTL_MS) return null;
  return {
    ...index,
    cacheKey,
    snapshotHash,
    diskCache: {
      enabled: true,
      hit: true,
      path: filePath,
    },
  };
}

async function readWorkspaceIndexDiskCacheRaw(cacheKey, settings = {}) {
  const filePath = getWorkspaceIndexDiskPath(cacheKey, settings);
  if (!filePath) return null;
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.version !== WORKSPACE_INDEX_DISK_VERSION) return null;
  if (payload.cacheKeyHash !== buildWorkspaceIndexCacheFileId(cacheKey)) return null;
  const index = payload.index;
  if (!index || !Array.isArray(index.files) || !Number.isFinite(index.builtAtMs)) return null;
  return index;
}

async function writeWorkspaceIndexDiskCache(cacheKey, index, settings = {}) {
  const filePath = getWorkspaceIndexDiskPath(cacheKey, settings);
  if (!filePath) {
    return {
      enabled: false,
      written: false,
      reason: 'missing-data-dir',
    };
  }
  const payload = {
    version: WORKSPACE_INDEX_DISK_VERSION,
    cacheKeyHash: buildWorkspaceIndexCacheFileId(cacheKey),
    snapshotHash: index.snapshotHash,
    savedAt: new Date().toISOString(),
    index: serializeWorkspaceIndex(index),
  };
  const text = JSON.stringify(payload);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > WORKSPACE_INDEX_DISK_MAX_BYTES) {
    return {
      enabled: true,
      written: false,
      reason: 'too-large',
      bytes,
      maxBytes: WORKSPACE_INDEX_DISK_MAX_BYTES,
      path: filePath,
    };
  }
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, text, 'utf8');
    await fs.rename(tmpPath, filePath);
    return {
      enabled: true,
      written: true,
      bytes,
      path: filePath,
    };
  } catch (error) {
    return {
      enabled: true,
      written: false,
      reason: 'write-failed',
      error: error?.message || String(error),
      path: filePath,
    };
  }
}

async function clearWorkspaceIndexDiskCache(settings = {}) {
  clearWorkspaceIndexCache();
  // Also clear the SQLite FTS5 index
  const indexMod = getWorkspaceIndexModule();
  if (indexMod) {
    try {
      await indexMod.clearWorkspaceIndex();
    } catch {
      // best-effort
    }
  }
  const dir = getWorkspaceIndexDiskDir(settings);
  if (!dir) {
    return {
      ok: true,
      memoryCleared: true,
      diskEnabled: false,
      deletedFiles: 0,
      deletedBytes: 0,
    };
  }
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return {
      ok: true,
      memoryCleared: true,
      diskEnabled: true,
      deletedFiles: 0,
      deletedBytes: 0,
      cacheDir: dir,
    };
  }
  let deletedFiles = 0;
  let deletedBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(dir, entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    await fs.rm(filePath, { force: true }).catch((err) => console.warn('[Tools] cache cleanup failed:', err.message));
    deletedFiles += 1;
    deletedBytes += stat?.size || 0;
  }
  return {
    ok: true,
    memoryCleared: true,
    diskEnabled: true,
    deletedFiles,
    deletedBytes,
    cacheDir: dir,
  };
}

function buildWorkspaceIndexCacheFileId(cacheKey) {
  return crypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 32);
}

function serializeWorkspaceIndex(index) {
  const { fromCache, ageMs, cacheLayer, diskCache, ...rest } = index;
  return {
    ...rest,
    files: (index.files || []).map((file) => {
      const { fullPath, ...safeFile } = file;
      return safeFile;
    }),
  };
}

function formatWorkspaceIndexOutput(index) {
  const files = index.files
    .slice(0, 80)
    .map((file) => `- ${file.path} (${file.lineCount} lines, ${file.size} bytes, chunks ${file.chunks})`);
  return [
    `工作区索引：${formatWorkspaceIndexCacheLabel(index)}`,
    `工作区：${index.root}`,
    `目录：${index.relativeDirectory}`,
    index.pattern ? `文件筛选：${index.pattern}` : '',
    `索引 hash：${index.hash}`,
    index.snapshotHash ? `快照 hash：${index.snapshotHash}` : '',
    `缓存策略：内存 ${formatDuration(WORKSPACE_INDEX_TTL_MS)} · 磁盘 ${formatDuration(WORKSPACE_INDEX_DISK_TTL_MS)}${index.fromCache ? ` · age ${formatDuration(index.ageMs)}` : ''}`,
    formatWorkspaceIndexDiskStatus(index.diskCache),
    `文件数：${index.fileCount}/${index.rawFileCount}`,
    `文本块：${index.chunkCount}`,
    `扫描字节：${index.scannedBytes}`,
    index.skippedSensitive ? `跳过敏感路径：${index.skippedSensitive}` : '',
    index.skippedBinary ? `跳过二进制/不可读：${index.skippedBinary}` : '',
    '',
    '索引文件：',
    ...files,
    index.files.length > files.length ? `... 仅显示前 ${files.length} 个文件` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

function formatWorkspaceIndexCacheLabel(index) {
  if (!index?.fromCache) return '新建';
  if (index.cacheLayer === 'disk') return '命中缓存（磁盘）';
  if (index.cacheLayer === 'memory') return '命中缓存（内存）';
  return '命中缓存';
}

function formatWorkspaceIndexDiskStatus(diskCache = {}) {
  if (!diskCache.enabled) return '磁盘缓存：未启用（缺少应用数据目录）';
  if (diskCache.hit) return '磁盘缓存：已命中';
  if (diskCache.written) return `磁盘缓存：已写入${diskCache.bytes ? `（${diskCache.bytes} bytes）` : ''}`;
  if (diskCache.reason === 'too-large') return `磁盘缓存：跳过写入（超过 ${diskCache.maxBytes} bytes）`;
  if (diskCache.reason === 'write-failed') return '磁盘缓存：写入失败';
  return '磁盘缓存：未写入';
}

async function readSearchableFile(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r').catch(() => null);
  if (!handle) return { text: '', sha256: '' };
  try {
    const bytesToRead = Math.max(1, Math.min(maxBytes, MAX_SEARCH_FILE_BYTES));
    const buffer = Buffer.alloc(bytesToRead);
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    const slice = buffer.subarray(0, result.bytesRead);
    if (isProbablyBinary(slice)) return { text: '', sha256: '' };
    const sha256 = crypto.createHash('sha256').update(slice).digest('hex').slice(0, 16);
    return { text: slice.toString('utf8'), sha256 };
  } finally {
    await handle.close().catch((err) => console.warn('[Tools] handle.close failed:', err.message));
  }
}

function tokenizeSearchQuery(query) {
  return [
    ...new Set(
      String(query || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}_.$/-]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2)
        .slice(0, 8)
    ),
  ];
}

function normalizeSearchSymbol(value) {
  const symbol = String(value || '').trim();
  if (!symbol || symbol.length > 160) return '';
  return /^[\p{L}_$][\p{L}\p{N}_$.-]*$/u.test(symbol) ? symbol : '';
}

function findTextHits(text, terms, queryLower, symbol = '', maxHits = 2) {
  const lines = String(text || '').split(/\r?\n/);
  const candidates = [];
  const symbolPattern = symbol ? createSymbolPattern(symbol) : null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] || '';
    const lower = line.toLowerCase();
    let score = 0;
    if (symbolPattern && symbolPattern.test(line)) {
      score += 10;
      if (looksLikeSymbolDefinition(line, symbol)) score += 8;
    }
    if (queryLower && lower.includes(queryLower)) score += 5;
    for (const term of terms) {
      if (lower.includes(term)) score += 1;
    }
    if (score <= 0) continue;
    const lineStart = index + 1;
    const lineEnd = Math.min(lines.length, index + 2);
    const snippet = [];
    for (let i = lineStart - 1; i < lineEnd; i++) {
      snippet.push({ line: i + 1, text: truncateLine(lines[i] || '') });
    }
    candidates.push({ contentScore: score, score, lineStart, lineEnd, snippet });
  }
  candidates.sort((a, b) => b.score - a.score || a.lineStart - b.lineStart);
  const selected = [];
  for (const candidate of candidates) {
    const overlaps = selected.some((hit) => candidate.lineStart <= hit.lineEnd && candidate.lineEnd >= hit.lineStart);
    if (overlaps) continue;
    selected.push(candidate);
    if (selected.length >= maxHits) break;
  }
  return selected;
}

function buildFileNameWorkspaceHit(file) {
  const lines = String(file.text || '').split(/\r?\n/);
  const lineEnd = Math.min(lines.length || 1, 3);
  const snippet = [];
  for (let index = 0; index < lineEnd; index += 1) {
    snippet.push({ line: index + 1, text: truncateLine(lines[index] || '') });
  }
  return {
    contentScore: 0,
    score: 0,
    lineStart: 1,
    lineEnd,
    snippet,
  };
}

function scoreWorkspaceFileRelevance(file, query, terms = [], symbol = '') {
  const filePath = String(file?.path || '').replace(/\\/g, '/');
  const fileName = path.basename(filePath).toLowerCase();
  const pathLower = filePath.toLowerCase();
  const queryLower = String(query || '').toLowerCase();
  const symbolLower = String(symbol || '').toLowerCase();
  const reasons = [];
  let score = 0;

  if (queryLower && fileName.includes(queryLower)) {
    score += 80;
    reasons.push('file_name');
  }
  for (const term of terms) {
    if (!term) continue;
    if (fileName.includes(term)) {
      score += 25;
      if (!reasons.includes('file_name')) reasons.push('file_name');
    } else if (pathLower.includes(term)) {
      score += 8;
      if (!reasons.includes('path')) reasons.push('path');
    }
  }
  if (symbolLower && fileName.includes(symbolLower)) {
    score += 35;
    if (!reasons.includes('file_name')) reasons.push('file_name');
  }

  const ageDays = (Date.now() - Number(file?.mtimeMs || 0)) / (24 * 60 * 60 * 1000);
  let recency = 0;
  if (Number.isFinite(ageDays) && ageDays >= 0) {
    if (ageDays <= 7) recency = 6;
    else if (ageDays <= 30) recency = 3;
    else if (ageDays <= 180) recency = 1;
  }
  if (recency > 0) {
    score += recency;
    reasons.push('recent_modified');
  }

  return { score, recency, reasons };
}

function scoreWorkspaceHit(hit) {
  const contentScore = Number(hit.contentScore ?? hit.score ?? 0);
  const fileScore = Number(hit.fileRelevance?.score || 0);
  const symbolScore = inferWorkspaceHitKind(hit) === 'symbol' ? 50 : 0;
  const score = fileScore + symbolScore + contentScore;
  const matchReasons = [
    ...(hit.fileRelevance?.reasons || []),
    ...(symbolScore > 0 ? ['symbol_definition'] : []),
    ...(contentScore > 0 ? ['content'] : []),
  ];
  return {
    ...hit,
    score,
    scoreBreakdown: {
      file: fileScore,
      symbol: symbolScore,
      content: contentScore,
      recency: Number(hit.fileRelevance?.recency || 0),
    },
    matchReasons: [...new Set(matchReasons)],
  };
}

function hasFileIdentityMatch(fileRelevance = {}) {
  return (fileRelevance.reasons || []).some((reason) => reason === 'file_name' || reason === 'path');
}

function createSymbolPattern(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '[^\\p{L}\\p{N}_$.-]';
  return new RegExp(`(^|${boundary})${escaped}(?=$|${boundary})`, 'u');
}

function looksLikeSymbolDefinition(line, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    `\\bfunction\\s+${escaped}\\b`,
    `\\bclass\\s+${escaped}\\b`,
    `\\b(?:const|let|var)\\s+${escaped}\\b`,
    `\\bexport\\s+(?:async\\s+)?function\\s+${escaped}\\b`,
    `\\b(?:async\\s+)?${escaped}\\s*\\(`,
    `<${escaped}(?:\\s|>|/)`,
  ];
  return patterns.some((pattern) => new RegExp(pattern, 'u').test(line));
}

function truncateLine(value) {
  const text = String(value || '').trim();
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function truncateCodeLine(value) {
  const text = String(value || '').replace(/\s+$/g, '');
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

async function walk(root, current, files, matcher, maxFiles = 220) {
  if (files.length >= maxFiles) return;
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) return;
    if (shouldSkip(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    const relative = path.relative(root, fullPath);
    if (entry.isDirectory()) {
      await walk(root, fullPath, files, matcher, maxFiles);
    } else if (entry.isFile() && matcher(relative)) {
      const stat = await fs.stat(fullPath).catch(() => null);
      files.push({
        path: relative,
        fullPath,
        size: stat?.size || 0,
        mtimeMs: stat?.mtimeMs || 0,
      });
    }
  }
}

function formatListedFile(file, includeMeta = false) {
  if (!includeMeta) return `- ${file.path}`;
  return `- ${file.path} (mtime ${formatMtime(file.mtimeMs)}, ${file.size} bytes)`;
}

function formatMtime(ms) {
  const date = new Date(Number(ms) || 0);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60 * 1000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60000)}m`;
}

function shouldSkip(name) {
  return ['.git', 'node_modules', 'dist', 'release', 'build', '.cache'].includes(name);
}

function createMatcher(pattern) {
  if (!pattern) return () => true;
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(escaped, 'i');
    return (value) => regex.test(value);
  }
  const lower = pattern.toLowerCase();
  return (value) => value.toLowerCase().includes(lower);
}

async function readFile(args, settings) {
  const citation = parsePathLineCitation(args.path);
  const requestedPath = citation.path || args.path;
  const filePath = await resolveAllowedPath(requestedPath, settings.workspaceRoots || []);
  if (isSensitivePath(filePath)) throw new Error('该文件路径看起来包含密钥、凭证或敏感配置，已拒绝读取。');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('只能读取文件，不能读取目录。');
  const maxBytes = clampInt(args.max_bytes, 1024, MAX_FILE_BYTES, DEFAULT_FILE_BYTES);
  const explicitStart = clampInt(args.start_line, 1, Number.MAX_SAFE_INTEGER, 0);
  const explicitEnd = clampInt(args.end_line, 1, Number.MAX_SAFE_INTEGER, 0);
  const lineRange = normalizeLineRange(explicitStart || citation.startLine, explicitEnd || citation.endLine);
  const bytesToRead = Math.min(stat.size, maxBytes);
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    if (isProbablyBinary(buffer)) throw new Error('该文件看起来是二进制文件，已拒绝读取。');
    const text = redactSensitiveText(buffer.toString('utf8'));
    const truncated = stat.size > maxBytes;
    if (lineRange) return formatLineRangeFileOutput(filePath, stat.size, maxBytes, text, truncated, lineRange);
    return [
      `文件：${filePath}`,
      `大小：${stat.size} bytes${truncated ? `（仅读取前 ${maxBytes} bytes）` : ''}`,
      '',
      text,
    ]
      .join('\n')
      .slice(0, MAX_TOOL_OUTPUT);
  } finally {
    await handle.close();
  }
}

function parsePathLineCitation(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.*):(\d+)(?:-(\d+))?$/);
  if (!match) return { path: raw, startLine: 0, endLine: 0 };
  return {
    path: match[1],
    startLine: Number.parseInt(match[2], 10) || 0,
    endLine: Number.parseInt(match[3] || match[2], 10) || 0,
  };
}

function normalizeLineRange(startLine, endLine) {
  const start = Number.parseInt(startLine, 10);
  const end = Number.parseInt(endLine || startLine, 10);
  if (!Number.isFinite(start) || start <= 0) return null;
  const safeEnd = Number.isFinite(end) && end > 0 ? end : start;
  return {
    start: Math.min(start, safeEnd),
    end: Math.max(start, safeEnd),
  };
}

function formatLineRangeFileOutput(filePath, fileSize, maxBytes, text, truncated, range) {
  const lines = text.split(/\r?\n/);
  const cappedEnd = Math.min(lines.length, Math.min(range.end, range.start + 399));
  const selected = [];
  for (let lineNumber = range.start; lineNumber <= cappedEnd; lineNumber += 1) {
    selected.push(`${lineNumber}: ${lines[lineNumber - 1] ?? ''}`);
  }
  if (selected.length === 0) {
    selected.push(`请求的行范围 ${range.start}-${range.end} 不在已读取内容内。`);
  }
  const rangeText = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
  const cappedText =
    selected.length > 0 && cappedEnd < range.end
      ? `（范围已限制到 ${range.start}-${cappedEnd}，单次最多读取 400 行）`
      : '';
  return [
    `文件：${filePath}`,
    `大小：${fileSize} bytes${truncated ? `（仅读取前 ${maxBytes} bytes）` : ''}`,
    `行范围：${rangeText}${cappedText}`,
    '',
    ...selected,
  ]
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

// --- Git tools ---

// --- project_map tool ---

// --- read_many_files tool ---

async function readManyFiles(args, settings) {
  const paths_ = Array.isArray(args.paths) ? args.paths : [];
  if (paths_.length === 0) throw new Error('文件路径列表不能为空。');
  if (paths_.length > 50) throw new Error('单次最多读取 50 个文件。');
  const maxTotalBytes = clampInt(args.maxTotalBytes, 1024, MAX_READ_MANY_FILES_BYTES, MAX_READ_MANY_FILES_BYTES);
  const results = [];
  let totalBytesRead = 0;

  for (const rawPath of paths_) {
    const label = String(rawPath || '').trim();
    if (!label) continue;
    try {
      const filePath = await resolveAllowedPath(label, settings.workspaceRoots || []);
      if (isSensitivePath(filePath)) {
        results.push({ path: label, error: '该文件路径看起来包含敏感信息，已拒绝读取。' });
        continue;
      }
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        results.push({ path: label, error: '不是文件，已跳过。' });
        continue;
      }
      const remainingBytes = maxTotalBytes - totalBytesRead;
      if (remainingBytes <= 0) {
        results.push({ path: label, error: '已达到总字节数上限，跳过剩余文件。' });
        continue;
      }
      const bytesToRead = Math.min(stat.size, remainingBytes);
      const handle = await fs.open(filePath, 'r');
      try {
        const buffer = Buffer.alloc(bytesToRead);
        await handle.read(buffer, 0, bytesToRead, 0);
        if (isProbablyBinary(buffer)) {
          results.push({ path: label, error: '该文件看起来是二进制文件，已跳过。' });
          continue;
        }
        const text = redactSensitiveText(buffer.toString('utf8'));
        totalBytesRead += Buffer.byteLength(text, 'utf8');
        results.push({
          path: label,
          size: stat.size,
          bytesRead: bytesToRead,
          truncated: stat.size > bytesToRead,
          content: text,
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      results.push({ path: label, error: error?.message || String(error) });
    }
  }

  const outputLines = [
    `批量文件读取`,
    `文件数：${results.length}/${paths_.length}`,
    `总读取字节：${totalBytesRead}/${maxTotalBytes}`,
    '',
  ];
  for (const result of results) {
    outputLines.push(`${'='.repeat(60)}`);
    outputLines.push(`文件：${result.path}`);
    if (result.error) {
      outputLines.push(`错误：${result.error}`);
    } else {
      outputLines.push(`大小：${result.size} bytes${result.truncated ? `（仅读取前 ${result.bytesRead} bytes）` : ''}`);
      outputLines.push('');
      outputLines.push(result.content);
    }
    outputLines.push('');
  }
  return outputLines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

module.exports = {
  TOOL_SCHEMAS,
  getToolDefinitions,
  getToolModeStatus,
  describeToolRisk,
  executeTool,
  redactSensitiveText,
  redactRunCodeOutput,
  isSensitivePath,
  buildSandboxEnv,
  normalizeTavilyResults,
  formatTavilyResults,
  isPathInsideRoot,
  resolveAllowedPath,
  clearWorkspaceIndexCache,
  clearWorkspaceIndexDiskCache,
  RUN_CODE_SECURITY_LIMITS,
  getWorkspaceIndexModule,
};
