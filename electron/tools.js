const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const MAX_FILE_BYTES = 100 * 1024;
const DEFAULT_FILE_BYTES = 30 * 1024;
const MAX_TOOL_OUTPUT = 12000;
const RUN_TIMEOUT_MS = 5000;

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
          pattern: { type: 'string', description: 'Optional filename substring or simple wildcard pattern.' },
        },
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file inside a user-approved workspace directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
          max_bytes: { type: 'integer', minimum: 1024, maximum: MAX_FILE_BYTES, description: 'Maximum bytes to read.' },
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
  file_reader: ['list_files', 'read_file'],
  code_runner: ['run_code'],
  multi_tool: ['web_search', 'list_files', 'read_file', 'run_code'],
};

function getToolDefinitions(activeSkill) {
  const ids = MODE_TOOLS[activeSkill] || [];
  return ids.map((id) => TOOL_SCHEMAS[id]).filter(Boolean);
}

function getToolModeStatus(settings) {
  const roots = settings.workspaceRoots || [];
  return {
    web_search: Boolean(settings.tavilyApiKey),
    file_reader: roots.length > 0,
    code_runner: true,
    multi_tool: Boolean(settings.tavilyApiKey) || roots.length > 0,
  };
}

function describeToolRisk(name, args) {
  if (name === 'web_search') {
    return `将使用 Tavily 搜索网络：${String(args.query || '').slice(0, 120)}`;
  }
  if (name === 'list_files') {
    return '将列出已授权工作区内的文件名，不会读取文件内容。';
  }
  if (name === 'read_file') {
    return `将读取已授权工作区内的文本文件：${String(args.path || '').slice(0, 160)}`;
  }
  if (name === 'run_code') {
    return '将以当前系统用户权限运行代码片段；请确认代码可信。';
  }
  return '未知工具调用。';
}

async function executeTool(name, args, settings) {
  if (name === 'web_search') return webSearch(args, settings);
  if (name === 'list_files') return listFiles(args, settings);
  if (name === 'read_file') return readFile(args, settings);
  if (name === 'run_code') return runCode(args);
  throw new Error(`不支持的工具：${name}`);
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
  const compact = trimmed
    .replace(/[，。！？?]/g, ' ')
    .replace(/帮我|请|麻烦|一下|搜索|搜一下|查找|查询|查一下|给我|告诉我/g, ' ')
    .replace(/一个就行|一条就行|一篇就行|就行|即可/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/ai|人工智能/i.test(compact) && /新闻|news|最新|today|recent|latest/i.test(compact)) {
    return `latest AI news ${new Date().toISOString().slice(0, 10)}`;
  }
  return compact || trimmed || 'latest news';
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
  const pattern = String(args.pattern || '').trim();
  const matcher = createMatcher(pattern);
  const files = [];
  await walk(root, root, files, matcher);
  if (files.length === 0) return `工作区 ${root} 中没有找到匹配文件。`;
  return [
    `工作区：${root}`,
    `匹配文件数：${files.length}`,
    '',
    ...files.slice(0, 200).map((file) => `- ${file}`),
    files.length > 200 ? `\n仅显示前 200 个结果。` : '',
  ].join('\n').slice(0, MAX_TOOL_OUTPUT);
}

async function walk(root, current, files, matcher) {
  if (files.length >= 220) return;
  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= 220) return;
    if (shouldSkip(entry.name)) continue;
    const fullPath = path.join(current, entry.name);
    const relative = path.relative(root, fullPath);
    if (entry.isDirectory()) {
      await walk(root, fullPath, files, matcher);
    } else if (entry.isFile() && matcher(relative)) {
      files.push(relative);
    }
  }
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
  const filePath = await resolveAllowedPath(args.path, settings.workspaceRoots || []);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('只能读取文件，不能读取目录。');
  const maxBytes = clampInt(args.max_bytes, 1024, MAX_FILE_BYTES, DEFAULT_FILE_BYTES);
  const bytesToRead = Math.min(stat.size, maxBytes);
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    if (isProbablyBinary(buffer)) throw new Error('该文件看起来是二进制文件，已拒绝读取。');
    const text = buffer.toString('utf8');
    const truncated = stat.size > maxBytes;
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

async function runCode(args) {
  const language = normalizeLanguage(args.language);
  const code = String(args.code || '');
  if (!language) throw new Error('仅支持 JavaScript 和 Python。');
  if (!code.trim()) throw new Error('代码不能为空。');
  if (code.length > 20000) throw new Error('代码过长，已拒绝执行。');

  const tempDir = path.join(os.tmpdir(), 'deepchat-code');
  await fs.mkdir(tempDir, { recursive: true });
  const id = crypto.randomUUID();
  const ext = language === 'python' ? 'py' : 'js';
  const filePath = path.join(tempDir, `${id}.${ext}`);
  await fs.writeFile(filePath, code, 'utf8');

  const command = language === 'python'
    ? (process.env.DEEPCHAT_PYTHON_PATH || 'python')
    : (process.env.DEEPCHAT_NODE_PATH || process.execPath);
  const env = language === 'javascript' && !process.env.DEEPCHAT_NODE_PATH
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : process.env;
  const output = await spawnWithLimits(command, [filePath], String(args.stdin || ''), env);
  await fs.unlink(filePath).catch(() => {});
  return [
    `语言：${language}`,
    `退出码：${output.exitCode ?? 'unknown'}${output.timedOut ? '（超时终止）' : ''}`,
    '',
    'STDOUT:',
    output.stdout || '(empty)',
    '',
    'STDERR:',
    output.stderr || '(empty)',
  ].join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function normalizeLanguage(value) {
  const lang = String(value || '').trim().toLowerCase();
  if (lang === 'python' || lang === 'py') return 'python';
  if (lang === 'javascript' || lang === 'js') return 'javascript';
  return '';
}

function spawnWithLimits(command, args, stdin, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, env });
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
  buildTavilySearchRequest,
  normalizeTavilyResults,
  formatTavilyResults,
  isPathInsideRoot,
  resolveAllowedPath,
};
