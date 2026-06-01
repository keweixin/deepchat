import { resolveAllowedPath, isSensitivePath, isPathInsideRoot } from './tools-path.js';
import { gitStatus, gitDiff, gitLog, gitBlame, gitCompare, gitShow } from './tools-git.js';
import { webSearch, normalizeSearchQueries, normalizeTavilyResults, formatTavilyResults } from './tools-search.js';
import { projectMap } from './tools-project.js';
import {
  runCode,
  buildSandboxEnv,
  redactSensitiveText,
  redactRunCodeOutput,
  normalizeLanguage,
} from './tools-run-code.js';
import {
  listFiles,
  readFile,
  readManyFiles,
  editFile,
  multiEdit,
  previewEditFile,
  previewMultiEdit,
  parsePathLineCitation,
} from './tools-file.js';
import { TOOL_SCHEMAS, MODE_TOOLS, getToolDefinitions, MAX_READ_MANY_FILES_BYTES } from './tools-schemas.js';

type WorkspaceToolModule = {
  indexWorkspace: (args: any, settings: any) => Promise<string>;
  searchWorkspace: (args: any, settings: any) => Promise<string>;
  readSymbol: (args: any, settings: any) => Promise<string>;
  clearWorkspaceIndexCache: () => void;
  clearWorkspaceIndexDiskCache: (settings: any) => Promise<any>;
  getWorkspaceIndexModule: () => any;
};

const {
  indexWorkspace,
  searchWorkspace,
  readSymbol,
  clearWorkspaceIndexCache,
  clearWorkspaceIndexDiskCache,
  getWorkspaceIndexModule,
} = require('./tools-workspace.ts') as WorkspaceToolModule;

const RUN_CODE_SECURITY_LIMITS = {
  maxOutputBytes: 1024 * 1024, // 1MB
  maxTimeoutMs: 5000,
  killTreeOnTimeout: true,
};

const PROJECT_MAP_EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.cache', 'release']);

/**
 * @param {{ workspaceRoots?: string[]; tavilyApiKey?: string; runCodeEnabled?: boolean | string }} settings
 */
function getToolModeStatus(settings: {
  workspaceRoots?: string[];
  tavilyApiKey?: string;
  localSearchFallbackMode?: string;
  docsetSearchEnabled?: boolean | string;
  docsetRoots?: string[];
  runCodeEnabled?: boolean | string;
  codingEditsEnabled?: boolean | string;
}) {
  const roots = settings.workspaceRoots || [];
  const hasWeb = hasSearchCapability(settings);
  const editEnabled =
    settings.codingEditsEnabled !== false && settings.codingEditsEnabled !== 'false' && roots.length > 0;
  return {
    web_search: hasWeb,
    file_reader: roots.length > 0,
    code_runner: settings.runCodeEnabled !== false && settings.runCodeEnabled !== 'false',
    coding_edits: editEnabled,
    multi_tool: hasWeb || roots.length > 0,
  };
}

function hasSearchCapability(settings: {
  tavilyApiKey?: string;
  localSearchFallbackMode?: string;
  docsetSearchEnabled?: boolean | string;
  docsetRoots?: string[];
}) {
  if (settings.tavilyApiKey) return true;
  if (settings.docsetSearchEnabled === true && Array.isArray(settings.docsetRoots) && settings.docsetRoots.length > 0)
    return true;
  return String(settings.localSearchFallbackMode || '') === 'missing_key';
}

/**
 * @param {string} name
 * @param {any} args
 */
function describeToolRisk(name: string, args: any, settings: any = {}) {
  if (name === 'web_search') {
    const queries = normalizeSearchQueries(args);
    const preview =
      queries.length > 1 ? `${queries.length} 个 query：${queries.join(' / ')}` : queries[0] || args.query || '';
    const extractTop = clampInt(args.extract_top_results ?? settings.tavilyExtractTopResults, 0, 5, 0);
    const depth = String(args.search_depth || settings.tavilySearchDepth || 'basic');
    return [
      `将使用联网搜索：${String(preview || '').slice(0, 180)}`,
      `搜索深度：${depth} · 结果数：${clampInt(args.max_results ?? settings.tavilyMaxResults, 1, 10, 5)}`,
      `Provider：Tavily 优先，必要时按设置降级 · 缓存 TTL：${clampInt(settings.tavilyCacheTtlMinutes, 0, 1440, 10)} 分钟 · 深度抽取 Top N：${extractTop}`,
      '结果会被结构化、去重、压缩后进入上下文，回答需要引用来源 URL。',
    ].join('\n');
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
      `输出上限：${RUN_CODE_SECURITY_LIMITS.maxOutputBytes / 1024 / 1024}MB · 本地轻隔离执行`,
      '权限：独立临时 cwd/HOME/TEMP，环境变量清洗，超时终止，输出截断和脱敏。',
      '限制：不提供硬网络隔离和硬内存限制。',
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
  if (name === 'git_blame') {
    return `将读取已授权工作区内文件 ${String(args.file || '').slice(0, 160)} 的 Git blame 行级历史。只读操作。`;
  }
  if (name === 'git_compare') {
    return `将比较 Git ref ${String(args.base || 'HEAD~1').slice(0, 80)}..${String(args.head || 'HEAD').slice(0, 80)} 的文件差异摘要。只读操作。`;
  }
  if (name === 'git_show') {
    return `将读取 Git ref ${String(args.ref || 'HEAD').slice(0, 80)} 的提交/对象详情。只读操作。`;
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
  if (name === 'edit_file') {
    const searchLines = String(args.search || '').split('\n').length;
    const replaceLines = String(args.replace || '').split('\n').length;
    return [
      `将修改已授权工作区内的文件：${String(args.path || '').slice(0, 160)}`,
      `SEARCH/REPLACE：${searchLines} 行 -> ${replaceLines} 行，SEARCH 必须唯一匹配。`,
      '执行前会只读预检路径、敏感文件、唯一匹配和差异摘要；确认后通过临时文件重命名写入，并在 DeepChat 数据目录生成备份。',
    ].join('\n');
  }
  if (name === 'multi_edit') {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    return [
      `将对已授权工作区内的文件应用 ${edits.length} 个 SEARCH/REPLACE 修改：${String(args.path || '').slice(0, 160)}`,
      '所有编辑必须先全部通过唯一匹配预检；确认后才会通过临时文件重命名一次性写入，并在 DeepChat 数据目录生成备份。',
    ].join('\n');
  }
  return '未知工具调用。';
}

/**
 * @param {string} name
 * @param {any} args
 * @param {any} settings
 * @param {AbortSignal} [signal]
 */
async function executeTool(name: string, args: any, settings: any, signal?: AbortSignal) {
  let output;
  if (name === 'web_search') output = await webSearch(args, settings, signal);
  else if (name === 'list_files') output = await listFiles(args, settings);
  else if (name === 'index_workspace') output = await indexWorkspace(args, settings);
  else if (name === 'search_workspace') output = await searchWorkspace(args, settings);
  else if (name === 'read_file') output = await readFile(args, settings);
  else if (name === 'read_symbol') output = await readSymbol(args, settings);
  else if (name === 'run_code') output = await runCode(args, settings);
  else if (name === 'git_status') output = await gitStatus(args, settings);
  else if (name === 'git_diff') output = await gitDiff(args, settings);
  else if (name === 'git_log') output = await gitLog(args, settings);
  else if (name === 'git_blame') output = await gitBlame(args, settings);
  else if (name === 'git_compare') output = await gitCompare(args, settings);
  else if (name === 'git_show') output = await gitShow(args, settings);
  else if (name === 'project_map') output = await projectMap(args, settings);
  else if (name === 'read_many_files') output = await readManyFiles(args, settings);
  else if (name === 'edit_file') output = await editFile(args, settings);
  else if (name === 'multi_edit') output = await multiEdit(args, settings);
  else throw new Error(`不支持的工具：${name}`);
  return redactSensitiveText(output);
}

/**
 * Build a write-tool preview without mutating files.
 *
 * @param {string} name
 * @param {any} args
 * @param {any} settings
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function previewToolCall(name: string, args: any, settings: any) {
  if (name === 'edit_file') return previewEditFile(args, settings);
  if (name === 'multi_edit') return previewMultiEdit(args, settings);
  return null;
}

/**
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value: any, min: number, max: number, fallback: number): number {
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
  previewToolCall,
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
