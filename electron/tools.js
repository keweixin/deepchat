const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const MAX_FILE_BYTES = 100 * 1024;
const DEFAULT_FILE_BYTES = 30 * 1024;
const MAX_SEARCH_FILE_BYTES = 64 * 1024;
const MAX_SEARCH_SCAN_FILES = 700;
const MAX_TOOL_OUTPUT = 12000;
const RUN_TIMEOUT_MS = 5000;
const WORKSPACE_INDEX_TTL_MS = 5 * 60 * 1000;
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
          max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum number of results.' },
        },
        required: ['query'],
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
          root: { type: 'string', description: 'Approved workspace root. If omitted, the first configured root is used.' },
          directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to list.' },
          pattern: { type: 'string', description: 'Optional filename substring or simple wildcard pattern.' },
          recent_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Only include files modified within this many days.' },
          sort_by: { type: 'string', enum: ['name', 'modified'], description: 'Sort files by name or modified time.' },
        },
      },
    },
  },
  search_workspace: {
    type: 'function',
    function: {
      name: 'search_workspace',
      description: 'Search text files or an exact code symbol inside a user-approved workspace and return concise line citations.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword or phrase to search for.' },
          symbol: { type: 'string', description: 'Optional exact function/class/variable/component symbol to search for.' },
          root: { type: 'string', description: 'Approved workspace root. If omitted, the first configured root is used.' },
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
      description: 'Build or refresh a lightweight in-memory index of approved workspace text files for faster cited search.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Approved workspace root. If omitted, the first configured root is used.' },
          directory: { type: 'string', description: 'Optional workspace-relative or absolute subdirectory to index.' },
          pattern: { type: 'string', description: 'Optional filename substring or wildcard, such as *.js or README.' },
          force_refresh: { type: 'boolean', description: 'Rebuild the index even when a fresh cached index exists.' },
          max_files: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_SCAN_FILES, description: 'Maximum files to scan.' },
        },
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file inside a user-approved workspace directory. Supports focused line ranges via start_line/end_line or path citations like src/file.js:10-20.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
          max_bytes: { type: 'integer', minimum: 1024, maximum: MAX_FILE_BYTES, description: 'Maximum bytes to read.' },
          start_line: { type: 'integer', minimum: 1, description: 'Optional 1-based line number to start reading from.' },
          end_line: { type: 'integer', minimum: 1, description: 'Optional 1-based line number to stop reading at.' },
        },
        required: ['path'],
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
  file_reader: ['index_workspace', 'list_files', 'search_workspace', 'read_file'],
  code_runner: ['run_code'],
  multi_tool: ['web_search', 'index_workspace', 'list_files', 'search_workspace', 'read_file', 'run_code'],
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
    return `将使用 Tavily 搜索网络：${String(args.query || '').slice(0, 120)}`;
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

async function executeTool(name, args, settings) {
  let output;
  if (name === 'web_search') output = await webSearch(args, settings);
  else if (name === 'list_files') output = await listFiles(args, settings);
  else if (name === 'index_workspace') output = await indexWorkspace(args, settings);
  else if (name === 'search_workspace') output = await searchWorkspace(args, settings);
  else if (name === 'read_file') output = await readFile(args, settings);
  else if (name === 'run_code') output = await runCode(args, settings);
  else throw new Error(`不支持的工具：${name}`);
  return redactSensitiveText(output);
}

async function webSearch(args, settings) {
  const apiKey = String(settings.tavilyApiKey || '').trim();
  if (!apiKey) throw new Error('请先在设置中配置 Tavily API Key。');

  const query = String(args.query || '').trim();
  if (!query) throw new Error('搜索关键词不能为空。');
  const request = buildTavilySearchRequest(query, settings, args.max_results);

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
  return formatTavilyResults(request, normalizeTavilyResults(json, request.payload.max_results));
}

function buildTavilySearchRequest(rawQuery, settings = {}, explicitMaxResults) {
  const originalQuery = String(rawQuery || '').trim();
  const cleanedQuery = normalizeSearchQuery(originalQuery);
  const maxResults = deriveSearchMaxResults(originalQuery, explicitMaxResults ?? settings.tavilyMaxResults);
  const freshness = getFreshnessWindow(originalQuery);
  const payload = {
    query: cleanedQuery,
    max_results: maxResults,
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
  };

  if (freshness) {
    payload.topic = 'news';
    payload.time_range = freshness.timeRange;
    payload.days = freshness.days;
  }

  return {
    originalQuery,
    payload,
    freshness,
    requestedAt: new Date().toISOString().slice(0, 10),
  };
}

function normalizeSearchQuery(query) {
  const trimmed = String(query || '').trim();
  const compact = stripExplicitToolDirectives(trimmed)
    .replace(/[，。！？?]/g, ' ')
    .replace(/帮我|请|麻烦|一下|搜索|搜一下|查找|查询|查一下|给我|告诉我/g, ' ')
    .replace(/一个就行|一条就行|一篇就行|就行|即可/g, ' ')
    .replace(/["'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/ai|人工智能/i.test(compact) && /新闻|news|最新|today|recent|latest/i.test(compact)) {
    return `latest AI news ${new Date().toISOString().slice(0, 10)}`;
  }
  return compact || trimmed || 'latest news';
}

function stripExplicitToolDirectives(text) {
  return String(text || '').replace(/(^|[\s([，,;；])@(web|search|run|code|changed|recent|mcp)\s*:?\s*/gi, '$1');
}

function deriveSearchMaxResults(query, requested) {
  if (/一个|一条|一篇|\b1\b|one/i.test(String(query || ''))) return 1;
  return clampInt(requested, 1, 10, 5);
}

function getFreshnessWindow(query) {
  const text = String(query || '');
  if (!/最新|新闻|今日|今天|实时|刚刚|本周|recent|latest|news|today|current/i.test(text)) return null;
  if (/今日|今天|today|刚刚/i.test(text)) return { timeRange: 'day', days: 1 };
  return { timeRange: 'week', days: 7 };
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
  if (results.length === 0) return `没有找到与「${request.originalQuery}」相关的搜索结果。\n实际搜索 query：${request.payload.query}`;
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

async function listFiles(args, settings) {
  const root = await resolveWorkspaceRoot(args.root, settings.workspaceRoots || []);
  const directory = String(args.directory || '').trim();
  const scanRoot = directory ? await resolveAllowedDirectory(directory, [root]) : root;
  const realRoot = await fs.realpath(root).catch(() => root);
  const pattern = String(args.pattern || '').trim();
  const matcher = createMatcher(pattern);
  const recentDays = clampInt(args.recent_days, 0, 3650, 0);
  const sortBy = String(args.sort_by || '').trim().toLowerCase();
  const sortByModified = sortBy === 'modified' || recentDays > 0;
  const cutoff = recentDays > 0 ? Date.now() - recentDays * 24 * 60 * 60 * 1000 : 0;
  const files = [];
  await walk(scanRoot, scanRoot, files, matcher);
  const matchedFiles = files
    .filter((file) => cutoff <= 0 || file.mtimeMs >= cutoff)
    .sort((a, b) => sortByModified
      ? (b.mtimeMs - a.mtimeMs) || a.path.localeCompare(b.path)
      : a.path.localeCompare(b.path));
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
  ].filter(Boolean).join('\n').slice(0, MAX_TOOL_OUTPUT);
}

async function indexWorkspace(args, settings) {
  const index = await getWorkspaceIndex(args, settings, {
    forceRefresh: Boolean(args.force_refresh),
    maxFiles: clampInt(args.max_files, 1, MAX_SEARCH_SCAN_FILES, MAX_SEARCH_SCAN_FILES),
  });
  return formatWorkspaceIndexOutput(index);
}

async function searchWorkspace(args, settings) {
  const symbol = normalizeSearchSymbol(args.symbol);
  const query = String(args.query || symbol).trim();
  if (!query) throw new Error('搜索关键词不能为空。');
  const index = await getWorkspaceIndex(args, settings);
  const maxResults = clampInt(args.max_results, 1, 20, 8);

  const terms = tokenizeSearchQuery(query);
  const queryLower = query.toLowerCase();
  const hits = [];
  for (const file of index.files) {
    if (hits.length >= maxResults * 4) break;
    const fileHits = findTextHits(file.text, terms, queryLower, symbol, 2);
    for (const hit of fileHits) {
      hits.push({
        ...hit,
        file: file.path,
        size: file.size || 0,
        truncated: (file.size || 0) > MAX_SEARCH_FILE_BYTES,
      });
      if (hits.length >= maxResults * 4) break;
    }
  }

  hits.sort((a, b) => (b.score - a.score) || a.file.localeCompare(b.file) || a.lineStart - b.lineStart);
  const selected = hits.slice(0, maxResults);
  if (selected.length === 0) {
    return [
      `工作区搜索：${query}`,
      `工作区：${index.root}`,
      `目录：${index.relativeDirectory}`,
      index.pattern ? `文件筛选：${index.pattern}` : '',
      `索引：${index.fromCache ? '命中缓存' : '新建'} · files=${index.fileCount} · chunks=${index.chunkCount} · hash=${index.hash}`,
      '没有找到匹配的文本结果。',
    ].filter(Boolean).join('\n');
  }

  const lines = [
    `工作区搜索：${query}`,
    symbol ? `符号：${symbol}` : '',
    `工作区：${index.root}`,
    `目录：${index.relativeDirectory}`,
    index.pattern ? `文件筛选：${index.pattern}` : '',
    `索引：${index.fromCache ? '命中缓存' : '新建'} · files=${index.fileCount} · chunks=${index.chunkCount} · hash=${index.hash}`,
    `结果数：${selected.length}`,
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
      ageMs: now - cached.builtAtMs,
    };
  }

  const matcher = createMatcher(pattern);
  const rawFiles = [];
  await walk(realScanRoot, realScanRoot, rawFiles, matcher, maxFiles);
  const files = [];
  let skippedSensitive = 0;
  let skippedBinary = 0;
  let scannedBytes = 0;
  let chunkCount = 0;

  for (const file of rawFiles) {
    if (!file.fullPath) continue;
    if (isSensitivePath(file.fullPath)) {
      skippedSensitive += 1;
      continue;
    }
    const text = await readSearchableFile(file.fullPath, Math.min(file.size || MAX_SEARCH_FILE_BYTES, MAX_SEARCH_FILE_BYTES));
    if (!text) {
      skippedBinary += 1;
      continue;
    }
    const lineCount = text.split(/\r?\n/).length;
    const chunks = Math.max(1, Math.ceil(lineCount / 80));
    chunkCount += chunks;
    scannedBytes += Math.min(file.size || Buffer.byteLength(text, 'utf8'), MAX_SEARCH_FILE_BYTES);
    files.push({
      path: path.relative(realRoot, file.fullPath) || file.path,
      fullPath: file.fullPath,
      size: file.size || 0,
      mtimeMs: file.mtimeMs || 0,
      lineCount,
      chunks,
      text: redactSensitiveText(text),
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
    skippedSensitive,
    skippedBinary,
    scannedBytes,
    chunkCount,
    files,
    hash: buildWorkspaceIndexHash(files),
    builtAt: new Date(now).toISOString(),
    builtAtMs: now,
    ttlMs: WORKSPACE_INDEX_TTL_MS,
    fromCache: false,
    ageMs: 0,
  };
  rememberWorkspaceIndex(cacheKey, index);
  return index;
}

function rememberWorkspaceIndex(cacheKey, index) {
  workspaceIndexCache.set(cacheKey, index);
  while (workspaceIndexCache.size > WORKSPACE_INDEX_CACHE_MAX) {
    const oldest = [...workspaceIndexCache.entries()]
      .sort((a, b) => a[1].builtAtMs - b[1].builtAtMs)[0];
    if (!oldest) break;
    workspaceIndexCache.delete(oldest[0]);
  }
}

function buildWorkspaceIndexCacheKey(root, scanRoot, pattern, maxFiles) {
  return [root, scanRoot, pattern || '*', maxFiles].map((item) => String(item || '').toLowerCase()).join('\0');
}

function buildWorkspaceIndexHash(files = []) {
  const payload = files.map((file) => `${file.path}:${file.size}:${Math.round(file.mtimeMs || 0)}:${file.lineCount}`).join('\n');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function formatWorkspaceIndexOutput(index) {
  const files = index.files.slice(0, 80).map((file) => `- ${file.path} (${file.lineCount} lines, ${file.size} bytes, chunks ${file.chunks})`);
  return [
    `工作区索引：${index.fromCache ? '命中缓存' : '新建'}`,
    `工作区：${index.root}`,
    `目录：${index.relativeDirectory}`,
    index.pattern ? `文件筛选：${index.pattern}` : '',
    `索引 hash：${index.hash}`,
    `有效期：${formatDuration(index.ttlMs)}${index.fromCache ? ` · age ${formatDuration(index.ageMs)}` : ''}`,
    `文件数：${index.fileCount}/${index.rawFileCount}`,
    `文本块：${index.chunkCount}`,
    `扫描字节：${index.scannedBytes}`,
    index.skippedSensitive ? `跳过敏感路径：${index.skippedSensitive}` : '',
    index.skippedBinary ? `跳过二进制/不可读：${index.skippedBinary}` : '',
    '',
    '索引文件：',
    ...files,
    index.files.length > files.length ? `... 仅显示前 ${files.length} 个文件` : '',
  ].filter(Boolean).join('\n').slice(0, MAX_TOOL_OUTPUT);
}

async function readSearchableFile(filePath, maxBytes) {
  const handle = await fs.open(filePath, 'r').catch(() => null);
  if (!handle) return '';
  try {
    const bytesToRead = Math.max(1, Math.min(maxBytes, MAX_SEARCH_FILE_BYTES));
    const buffer = Buffer.alloc(bytesToRead);
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    const slice = buffer.subarray(0, result.bytesRead);
    if (isProbablyBinary(slice)) return '';
    return slice.toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

function tokenizeSearchQuery(query) {
  return [...new Set(String(query || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.$/-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 8))];
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
    candidates.push({ score, lineStart, lineEnd, snippet });
  }
  candidates.sort((a, b) => (b.score - a.score) || a.lineStart - b.lineStart);
  const selected = [];
  for (const candidate of candidates) {
    const overlaps = selected.some((hit) => candidate.lineStart <= hit.lineEnd && candidate.lineEnd >= hit.lineStart);
    if (overlaps) continue;
    selected.push(candidate);
    if (selected.length >= maxHits) break;
  }
  return selected;
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
  const lineRange = normalizeLineRange(
    explicitStart || citation.startLine,
    explicitEnd || citation.endLine,
  );
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
    ].join('\n').slice(0, MAX_TOOL_OUTPUT);
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
  const cappedText = selected.length > 0 && cappedEnd < range.end
    ? `（范围已限制到 ${range.start}-${cappedEnd}，单次最多读取 400 行）`
    : '';
  return [
    `文件：${filePath}`,
    `大小：${fileSize} bytes${truncated ? `（仅读取前 ${maxBytes} bytes）` : ''}`,
    `行范围：${rangeText}${cappedText}`,
    '',
    ...selected,
  ].join('\n').slice(0, MAX_TOOL_OUTPUT);
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

  const candidates = path.isAbsolute(raw)
    ? [path.resolve(raw)]
    : roots.map((root) => path.resolve(root, raw));

  for (const candidate of candidates) {
    const realCandidate = await fs.realpath(candidate).catch(() => candidate);
    for (const root of roots) {
      const realRoot = await fs.realpath(root).catch(() => root);
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
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
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

async function runCode(args, settings = {}) {
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

  const command = language === 'python'
    ? (process.env.DEEPCHAT_PYTHON_PATH || 'python')
    : (process.env.DEEPCHAT_NODE_PATH || process.execPath);
  const env = buildSandboxEnv(language, tempDir);
  const output = await spawnWithLimits(command, [filePath], String(args.stdin || ''), env, tempDir);
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  return [
    `语言：${language}`,
    `退出码：${output.exitCode ?? 'unknown'}${output.timedOut ? '（超时终止）' : ''}`,
    `沙箱目录：${tempDir}`,
    '环境变量：仅传递 PATH/SystemRoot/TEMP/HOME 等最小集合，已移除 token/key/secret/password 类变量。',
    '网络：Windows 轻沙箱未做硬阻断，请只运行可信代码。',
    '',
    'STDOUT:',
    output.stdout || '(empty)',
    '',
    'STDERR:',
    output.stderr || '(empty)',
  ].join('\n').slice(0, MAX_TOOL_OUTPUT);
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
  const lang = String(value || '').trim().toLowerCase();
  if (lang === 'python' || lang === 'py') return 'python';
  if (lang === 'javascript' || lang === 'js') return 'javascript';
  return '';
}

function spawnWithLimits(command, args, stdin, env = process.env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, env, cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

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
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: error.message, exitCode: null, timedOut });
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });

    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
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
  buildTavilySearchRequest,
  normalizeTavilyResults,
  formatTavilyResults,
  isPathInsideRoot,
  resolveAllowedPath,
};
