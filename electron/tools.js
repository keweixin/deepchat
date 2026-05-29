// @ts-check
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { parseWorkspaceQuery, matchesFileDirective, matchesChangedDirective } = require('./workspace-query');

const MAX_FILE_BYTES = 100 * 1024;
const DEFAULT_FILE_BYTES = 30 * 1024;
const MAX_SEARCH_FILE_BYTES = 64 * 1024;
const MAX_SEARCH_SCAN_FILES = 700;
const MAX_TOOL_OUTPUT = 12000;
const RUN_TIMEOUT_MS = 5000;
const WORKSPACE_INDEX_TTL_MS = 5 * 60 * 1000;
const WORKSPACE_INDEX_DISK_TTL_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_INDEX_DISK_MAX_BYTES = 8 * 1024 * 1024;
const WORKSPACE_INDEX_DISK_VERSION = 1;
const WORKSPACE_INDEX_CACHE_MAX = 8;
const SENSITIVE_PATH_PARTS = new Set(['.ssh', '.aws', '.azure', '.gnupg']);
const SENSITIVE_FILE_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'id_rsa',
  'id_rsa.pub',
  'id_ed25519',
  'id_ed25519.pub',
  'known_hosts',
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.crt']);

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
      description: 'Run a small JavaScript or Python snippet after explicit user approval.',
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
};

const MODE_TOOLS = {
  none: [],
  web_search: ['web_search'],
  file_reader: ['index_workspace', 'list_files', 'search_workspace', 'read_symbol', 'read_file'],
  code_runner: ['run_code'],
  multi_tool: [
    'web_search',
    'index_workspace',
    'list_files',
    'search_workspace',
    'read_symbol',
    'read_file',
    'run_code',
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
      `超时：${RUN_TIMEOUT_MS}ms`,
      '权限：独立临时 cwd/HOME/TEMP，环境变量已清洗；Windows 轻沙箱不承诺硬网络隔离。',
    ].join('\n');
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
  else throw new Error(`不支持的工具：${name}`);
  return redactSensitiveText(output);
}

async function webSearch(args, settings) {
  const apiKey = String(settings.tavilyApiKey || '').trim();
  if (!apiKey) throw new Error('请先在设置中配置 Tavily API Key。');

  const queries = normalizeSearchQueries(args);
  if (queries.length === 0) throw new Error('搜索关键词不能为空。');
  const maxPerQuery =
    queries.length > 1
      ? Math.max(1, Math.ceil(clampInt(args.max_results ?? settings.tavilyMaxResults, 1, 10, 5) / queries.length))
      : args.max_results;
  const { buildTavilySearchRequest } = await import('./search-utils.mjs');
  const requests = queries.map((query) => buildTavilySearchRequest(query, settings, maxPerQuery));
  const allResults = [];

  for (const request of requests) {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request.payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Tavily 搜索失败 (${response.status})：${truncate(text || response.statusText, 300)}`);
    }

    const json = await response.json();
    const results = normalizeTavilyResults(json, request.payload.max_results).map((item) => ({
      ...item,
      query: request.originalQuery,
      normalizedQuery: request.payload.query,
    }));
    allResults.push(...results);
  }

  if (requests.length === 1) return formatTavilyResults(requests[0], allResults);
  return formatTavilySearchPlanResults(
    requests,
    dedupeTavilyResults(allResults, clampInt(args.max_results ?? settings.tavilyMaxResults, 1, 10, 5))
  );
}

function normalizeSearchQueries(args = {}) {
  const values = [];
  if (Array.isArray(args.queries)) values.push(...args.queries);
  if (args.query !== undefined) values.unshift(args.query);
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeTavilyResults(payload, maxResults = 5) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.slice(0, maxResults).map((item, index) => ({
    index: index + 1,
    title: String(item.title || item.url || `Result ${index + 1}`).slice(0, 200),
    url: String(item.url || ''),
    content: String(item.content || item.snippet || '').slice(0, 1000),
    publishedDate: String(item.published_date || item.publishedDate || item.date || '').slice(0, 40),
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
  }));
}

function formatTavilyResults(request, results) {
  if (typeof request === 'string') {
    request = {
      originalQuery: request,
      payload: { query: request, topic: 'general', max_results: results.length || 5 },
      requestedAt: new Date().toISOString().slice(0, 10),
    };
  }
  if (results.length === 0)
    return `没有找到与「${request.originalQuery}」相关的搜索结果。\n实际搜索 query：${request.payload.query}`;
  const lines = [
    `搜索时间：${request.requestedAt}`,
    `用户原始问题：${request.originalQuery}`,
    `实际搜索 query：${request.payload.query}`,
    `Tavily 参数：topic=${request.payload.topic || 'general'}，time_range=${request.payload.time_range || '未限定'}，days=${request.payload.days || '未限定'}，max_results=${request.payload.max_results}`,
    '',
    'Tavily 返回来源：',
  ];
  for (const item of results) {
    lines.push(`${item.index}. ${item.title}`);
    if (item.url) lines.push(`   URL: ${item.url}`);
    if (item.publishedDate) lines.push(`   Published: ${item.publishedDate}`);
    if (item.content) lines.push(`   摘要: ${item.content}`);
    lines.push('');
  }
  return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function dedupeTavilyResults(results = [], maxResults = 5) {
  const seen = new Set();
  const out = [];
  for (const item of results) {
    const key = String(item.url || item.title || '')
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, index: out.length + 1 });
    if (out.length >= maxResults) break;
  }
  return out;
}

function formatTavilySearchPlanResults(requests, results) {
  const structured = {
    type: 'deepchat.webSearchPlanResults',
    version: 1,
    requestedAt: requests[0]?.requestedAt || new Date().toISOString().slice(0, 10),
    queries: requests.map((request, index) => ({
      index: index + 1,
      originalQuery: request.originalQuery,
      query: request.payload.query,
      topic: request.payload.topic || 'general',
      timeRange: request.payload.time_range || '',
      days: request.payload.days || 0,
      maxResults: request.payload.max_results,
    })),
    results: results.map((item) => ({
      index: item.index,
      query: item.query || '',
      normalizedQuery: item.normalizedQuery || '',
      title: item.title,
      url: item.url,
      content: item.content,
      publishedDate: item.publishedDate,
      score: item.score,
    })),
  };
  if (results.length === 0) {
    return [
      `搜索时间：${structured.requestedAt}`,
      `搜索计划：${requests.length} 个 query`,
      'Structured Search Plan:',
      JSON.stringify(structured, null, 2),
      '没有找到与搜索计划相关的结果。',
    ].join('\n');
  }
  const lines = [
    `搜索时间：${structured.requestedAt}`,
    `搜索计划：${requests.length} 个 query`,
    '',
    '计划 query：',
    ...structured.queries.map((item) => `${item.index}. ${item.originalQuery} -> ${item.query}`),
    '',
    'Structured Search Plan:',
    JSON.stringify(structured, null, 2),
    '',
    'Tavily 返回来源（已按 URL 去重）：',
  ];
  for (const item of results) {
    lines.push(`${item.index}. ${item.title}`);
    if (item.query) lines.push(`   Query: ${item.query}`);
    if (item.url) lines.push(`   URL: ${item.url}`);
    if (item.publishedDate) lines.push(`   Published: ${item.publishedDate}`);
    if (item.content) lines.push(`   摘要: ${item.content}`);
    lines.push('');
  }
  return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
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
  const index = await getWorkspaceIndex(args, settings);
  const maxResults = clampInt(args.max_results, 1, 20, 8);

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
  const index = await getWorkspaceIndex({ ...args, symbol, query: symbol }, settings);
  const contextLines = clampInt(args.context_lines, 0, 20, 3);
  const maxLines = clampInt(args.max_lines, 20, 240, 120);
  const matches = [];

  for (const file of index.files) {
    const symbolHits = findSymbolDefinitionHits(file, symbol, { contextLines, maxLines });
    for (const hit of symbolHits) matches.push(hit);
  }

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
    await fs.rm(filePath, { force: true }).catch(() => {});
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
    await handle.close().catch(() => {});
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

async function resolveWorkspaceRoot(inputRoot, workspaceRoots) {
  const roots = normalizeRoots(workspaceRoots);
  if (roots.length === 0) throw new Error('请先在设置中添加允许读取的工作区目录。');
  if (!inputRoot) return roots[0];
  const requested = path.resolve(String(inputRoot));
  const matched = roots.find((root) => pathEquals(root, requested));
  if (!matched) throw new Error('请求的 root 不在已授权工作区中。');
  return matched;
}

async function resolveAllowedPath(inputPath, workspaceRoots) {
  const roots = normalizeRoots(workspaceRoots);
  if (roots.length === 0) throw new Error('请先在设置中添加允许读取的工作区目录。');
  const raw = String(inputPath || '').trim();
  if (!raw) throw new Error('文件路径不能为空。');

  const candidates = path.isAbsolute(raw) ? [path.resolve(raw)] : roots.map((root) => path.resolve(root, raw));

  for (const candidate of candidates) {
    let realCandidate;
    try {
      realCandidate = await fs.realpath(candidate);
    } catch {
      continue;
    }
    for (const root of roots) {
      let realRoot;
      try {
        realRoot = await fs.realpath(root);
      } catch {
        continue;
      }
      if (isPathInsideRoot(realCandidate, realRoot)) return realCandidate;
    }
  }
  throw new Error('文件路径不在已授权工作区中。');
}

async function resolveAllowedDirectory(inputPath, workspaceRoots) {
  const directoryPath = await resolveAllowedPath(inputPath || '.', workspaceRoots);
  const stat = await fs.stat(directoryPath);
  if (!stat.isDirectory()) throw new Error('只能列出目录，不能把文件作为 list_files 的 directory。');
  return directoryPath;
}

function isSensitivePath(filePath) {
  const normalized = path.resolve(String(filePath || ''));
  const parts = normalized.split(/[\\/]+/).map((part) => part.toLowerCase());
  const base = parts[parts.length - 1] || '';
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (SENSITIVE_FILE_NAMES.has(base)) return true;
  if (SENSITIVE_EXTENSIONS.has(path.extname(base).toLowerCase())) return true;
  if (parts.some((part) => SENSITIVE_PATH_PARTS.has(part))) return true;
  return /(token|secret|password|api[_-]?key|credential|private[_-]?key)/i.test(base);
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) return [];
  return roots.map((root) => path.resolve(String(root))).filter(Boolean);
}

function pathEquals(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isPathInsideRoot(candidate, root) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function isProbablyBinary(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const scanLength = Math.min(buffer.length, 4096);
  for (let i = 0; i < scanLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function runCode(args, settings = {}, signal) {
  if (settings.runCodeEnabled === false || settings.runCodeEnabled === 'false') {
    throw new Error('代码运行工具已在设置中关闭。');
  }
  const language = normalizeLanguage(args.language);
  const code = String(args.code || '');
  if (!language) throw new Error('仅支持 JavaScript 和 Python。');
  if (!code.trim()) throw new Error('代码不能为空。');
  if (code.length > 20000) throw new Error('代码过长，已拒绝执行。');

  const tempDir = path.join(os.tmpdir(), 'deepchat-code', crypto.randomUUID());
  await fs.mkdir(tempDir, { recursive: true });
  const id = crypto.randomUUID();
  const ext = language === 'python' ? 'py' : 'js';
  const filePath = path.join(tempDir, `${id}.${ext}`);
  await fs.writeFile(filePath, code, 'utf8');

  const command =
    language === 'python'
      ? process.env.DEEPCHAT_PYTHON_PATH || 'python'
      : process.env.DEEPCHAT_NODE_PATH || process.execPath;
  const env = buildSandboxEnv(language, tempDir);
  const startedAt = Date.now();
  const output = await spawnWithLimits(command, [filePath], String(args.stdin || ''), env, tempDir, signal);
  const durationMs = Date.now() - startedAt;
  const structured = buildRunCodeStructuredResult({
    language,
    codeLength: code.length,
    stdinBytes: Buffer.byteLength(String(args.stdin || ''), 'utf8'),
    durationMs,
    exitCode: output.exitCode,
    timedOut: output.timedOut,
    stdout: output.stdout,
    stderr: output.stderr,
  });
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (err) {
    console.error('[runCode] Failed to clean up temp dir:', tempDir, err.message);
  }
  return [
    `语言：${language}`,
    `退出码：${output.exitCode ?? 'unknown'}${output.timedOut ? '（超时终止）' : ''}`,
    `耗时：${durationMs}ms`,
    `代码长度：${code.length} chars`,
    `stdin：${structured.stdinBytes} bytes`,
    '沙箱目录：已创建临时隔离目录，任务结束后清理',
    '权限：本地轻沙箱（临时目录隔离）',
    '环境：最小变量白名单（已过滤 token/key/secret/password）',
    '网络：未硬阻断',
    '风险：仅运行可信代码',
    'Structured Run:',
    JSON.stringify(structured, null, 2),
    '',
    'STDOUT:',
    output.stdout || '(empty)',
    '',
    'STDERR:',
    output.stderr || '(empty)',
  ]
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

function buildRunCodeStructuredResult(result) {
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  return {
    type: 'deepchat.runCodeResult',
    version: 1,
    language: result.language,
    codeLength: result.codeLength || 0,
    stdinBytes: result.stdinBytes || 0,
    durationMs: result.durationMs || 0,
    exitCode: result.exitCode ?? null,
    timedOut: Boolean(result.timedOut),
    ok: result.exitCode === 0 && !result.timedOut,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stdoutPreview: compactHeadTailText(stdout, 1600, 800),
    stderrPreview: compactHeadTailText(stderr, 1200, 600),
    failureHint: buildRunFailureHint(result.exitCode, result.timedOut, stderr),
  };
}

function compactHeadTailText(text, headLength, tailLength) {
  const value = String(text || '');
  if (value.length <= headLength + tailLength + 80) return value;
  return `${value.slice(0, headLength)}\n\n[中间输出已省略]\n\n${value.slice(-tailLength)}`;
}

function buildRunFailureHint(exitCode, timedOut, stderr) {
  if (timedOut) return '代码运行超时，可减少输入、拆分任务或检查是否存在死循环。';
  if (exitCode === 0) return '';
  const text = String(stderr || '');
  if (/SyntaxError/i.test(text)) return '语法错误：请检查括号、引号、缩进或语言模式。';
  if (/ModuleNotFoundError|Cannot find module/i.test(text)) return '依赖缺失：当前轻沙箱不会自动安装依赖。';
  if (/NameError|ReferenceError/i.test(text)) return '变量或函数未定义：请检查上下文是否完整。';
  if (/PermissionError|EACCES/i.test(text)) return '权限错误：轻沙箱目录隔离，无法访问未授权路径。';
  return exitCode === null
    ? '运行进程启动失败，请检查本机运行时配置。'
    : '代码运行失败，请查看 stderr 首尾输出定位原因。';
}

function buildSandboxEnv(language, tempDir) {
  const env = {};
  const pathValue = process.env.PATH || process.env.Path || '';
  if (pathValue) {
    env.PATH = pathValue;
    env.Path = pathValue;
  }
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HOME = tempDir;
  env.USERPROFILE = tempDir;
  env.TMP = tempDir;
  env.TEMP = tempDir;
  env.TMPDIR = tempDir;
  env.NO_COLOR = '1';
  env.PYTHONIOENCODING = 'utf-8';
  if (language === 'javascript' && !process.env.DEEPCHAT_NODE_PATH) env.ELECTRON_RUN_AS_NODE = '1';
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isSensitiveEnvKey(key)));
}

function isSensitiveEnvKey(key) {
  return /(key|token|secret|password|credential|cookie|session|auth|bearer)/i.test(String(key || ''));
}

function normalizeLanguage(value) {
  const lang = String(value || '')
    .trim()
    .toLowerCase();
  if (lang === 'python' || lang === 'py') return 'python';
  if (lang === 'javascript' || lang === 'js') return 'javascript';
  return '';
}

function spawnWithLimits(command, args, stdin, env = process.env, cwd, signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, env, cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const onAbort = () => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout = truncate(stdout + chunk.toString('utf8'), MAX_TOOL_OUTPUT);
    });
    child.stderr.on('data', (chunk) => {
      stderr = truncate(stderr + chunk.toString('utf8'), MAX_TOOL_OUTPUT);
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error) => {
      cleanup();
      resolve({ stdout, stderr: error.message, exitCode: null, timedOut });
    });
    child.on('close', (exitCode) => {
      cleanup();
      resolve({ stdout, stderr, exitCode, timedOut });
    });

    try {
      if (stdin) child.stdin.write(stdin);
      child.stdin.end();
    } catch {
      // Child may have exited before reading stdin; error is surfaced via exitCode.
    }
  });
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, 'ghp_[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, 'xoxb-[REDACTED]')
    .replace(/\btvly-[A-Za-z0-9_-]{8,}\b/g, 'tvly-[REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^'"\s]{8,}/gi, '$1=[REDACTED]');
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
  isSensitivePath,
  buildSandboxEnv,
  normalizeTavilyResults,
  formatTavilyResults,
  isPathInsideRoot,
  resolveAllowedPath,
  clearWorkspaceIndexCache,
  clearWorkspaceIndexDiskCache,
};
