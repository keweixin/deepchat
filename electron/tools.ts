// @ts-nocheck
import { resolveAllowedPath, isSensitivePath, isPathInsideRoot } from './tools-path.js';
import { gitStatus, gitDiff, gitLog } from './tools-git.js';
import { webSearch, normalizeSearchQueries, normalizeTavilyResults, formatTavilyResults } from './tools-search.js';
import { projectMap } from './tools-project.js';
import {
  runCode,
  buildSandboxEnv,
  redactSensitiveText,
  redactRunCodeOutput,
  normalizeLanguage,
} from './tools-run-code.js';
import { listFiles, readFile, readManyFiles, parsePathLineCitation } from './tools-file.js';
import {
  indexWorkspace,
  searchWorkspace,
  readSymbol,
  clearWorkspaceIndexCache,
  clearWorkspaceIndexDiskCache,
  getWorkspaceIndexModule,
} from './tools-workspace.js';
import { TOOL_SCHEMAS, MODE_TOOLS, getToolDefinitions, MAX_READ_MANY_FILES_BYTES } from './tools-schemas.js';

const RUN_CODE_SECURITY_LIMITS = {
  maxOutputBytes: 1024 * 1024, // 1MB
  maxMemoryMB: 512,
  maxTimeoutMs: 5000,
  killTreeOnTimeout: true,
};

const PROJECT_MAP_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', 'release']);

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

async function executeTool(name, args, settings, signal?) {
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

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

export {
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
