/**
 * Tool Registry — Single source of truth for tool names, skill IDs, role mappings,
 * risk classification, and result summarization.
 *
 * Any new tool or skill should be registered here first before being referenced
 * in UI, trace, or execution modules.
 */

type SharedToolDefinition = {
  name: string;
  category: 'search' | 'file' | 'code' | 'git' | 'workspace' | 'mcp';
  riskLevel: 'low' | 'medium' | 'high';
  approvalPolicy: 'always_allow' | 'confirm_once' | 'confirm_always';
  parallelSafe: boolean;
  role: 'reader' | 'researcher' | 'coder' | 'reviewer' | 'planner';
  productCopy: {
    purpose: string;
    scope: string;
    riskReason: string;
    icon: string;
  };
};

// ─── Tool Names (backend / OpenAI function names) ───────────────────────────

export const TOOL_NAMES = Object.freeze({
  readFile: 'read_file',
  readManyFiles: 'read_many_files',
  writeFile: 'write_file',
  editFile: 'edit_file',
  runCode: 'run_code',
  webSearch: 'web_search',
  listFiles: 'list_files',
  indexWorkspace: 'index_workspace',
  searchWorkspace: 'search_workspace',
  readSymbol: 'read_symbol',
  generateTree: 'generate_tree',
  projectMap: 'project_map',
  gitStatus: 'git_status',
  gitDiff: 'git_diff',
  gitLog: 'git_log',
  mcpPrefix: 'mcp__',
} as const);

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

// ─── Skill IDs (frontend / composer active-skill identifiers) ───────────────

export const SKILL_IDS = Object.freeze({
  webSearch: 'web_search',
  fileReader: 'file_reader',
  codeRunner: 'code_runner',
  mcpTool: 'mcp_tool',
  multiTool: 'multi_tool',
  auto: 'auto',
} as const);

export type SkillId = (typeof SKILL_IDS)[keyof typeof SKILL_IDS];

export const AGENT_SKILLS: readonly string[] = Object.freeze([
  SKILL_IDS.webSearch,
  SKILL_IDS.fileReader,
  SKILL_IDS.codeRunner,
  SKILL_IDS.mcpTool,
  SKILL_IDS.multiTool,
]);

export function isAgentSkill(skill: string | undefined): boolean {
  if (!skill || skill === SKILL_IDS.auto) return false;
  return AGENT_SKILLS.includes(skill);
}

// ─── Role Mapping (tool name → crew / trace actor role) ─────────────────────

const READER_TOOLS: readonly string[] = Object.freeze([
  TOOL_NAMES.indexWorkspace,
  TOOL_NAMES.listFiles,
  TOOL_NAMES.searchWorkspace,
  TOOL_NAMES.readSymbol,
  TOOL_NAMES.readFile,
  TOOL_NAMES.readManyFiles,
  TOOL_NAMES.generateTree,
  TOOL_NAMES.projectMap,
]);

const REVIEWER_TOOLS: readonly string[] = Object.freeze([TOOL_NAMES.gitStatus, TOOL_NAMES.gitDiff, TOOL_NAMES.gitLog]);

const RESEARCHER_KEYWORDS: readonly string[] = Object.freeze([
  'search',
  'fetch',
  'query',
  'database',
  'literature',
  'pubmed',
  'arxiv',
  'biorxiv',
  'europepmc',
  'openalex',
]);

const READER_KEYWORDS: readonly string[] = Object.freeze(['read', 'file', 'sequence', 'align', 'msa', 'pymol']);

function parseMcpOriginalName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    if (parts.length >= 3) {
      return parts[2].replace(/_[a-z0-9]+$/, '');
    }
  }
  return name;
}

/**
 * Determine the actor / crew role for a given tool name.
 * Returns: 'reader' | 'researcher' | 'coder' | 'planner'
 */
export function getToolRole(toolName = ''): 'reader' | 'researcher' | 'coder' | 'reviewer' | 'planner' {
  const name = String(toolName).toLowerCase();

  if (READER_TOOLS.includes(name)) return 'reader';
  if (REVIEWER_TOOLS.includes(name)) return 'reviewer';
  if (name === TOOL_NAMES.webSearch) return 'researcher';
  if (name === TOOL_NAMES.runCode) return 'coder';

  const originalName = parseMcpOriginalName(name);

  // MCP tools
  if (name === 'mcp' || name.startsWith('mcp_') || name.startsWith('mcp__')) {
    if (
      originalName.includes('read') ||
      originalName.includes('file') ||
      originalName.includes('directory') ||
      originalName.includes('folder') ||
      originalName.includes('list')
    )
      return 'reader';
    if (originalName.includes('write') || originalName.includes('edit') || originalName.includes('create'))
      return 'coder';
    return 'researcher';
  }

  // Fallback heuristics for science / bioinformatics tools
  if (RESEARCHER_KEYWORDS.some((k) => name.includes(k))) return 'researcher';
  if (READER_KEYWORDS.some((k) => name.includes(k))) return 'reader';

  return 'planner';
}

// ─── Tool Result Summarization ──────────────────────────────────────────────

export interface ToolSummaryInput {
  toolName: string;
  args?: Record<string, unknown>;
  sources?: unknown[];
  durationMs?: number;
}

export interface ToolSummaryOutput {
  label: string;
  detail?: string;
}

export function getToolSummary(event: ToolSummaryInput): ToolSummaryOutput {
  const { toolName, args = {}, sources = [], durationMs } = event;
  const name = String(toolName).toLowerCase();

  if (name === TOOL_NAMES.webSearch) {
    const query = String(args.query || '');
    if (query) {
      return { label: `在互联网检索「${query}」` };
    }
    const count = sources.length;
    return { label: count > 0 ? `已找到 ${count} 个联网来源` : '搜索完毕' };
  }

  if (name === TOOL_NAMES.readFile || name === TOOL_NAMES.readManyFiles) {
    const file = String(args.path || args.file || args.files || '');
    const basename = file.split(/[/\\]/).pop() || file;
    return { label: basename ? `成功读取文件 ${basename}` : '读取文件完毕' };
  }

  if (name === TOOL_NAMES.searchWorkspace) {
    const query = String(args.query || '');
    return { label: `在工作区检索「${query}」` };
  }

  if (name === TOOL_NAMES.runCode) {
    return { label: durationMs ? `代码运行成功 (${durationMs}ms)` : '代码运行成功' };
  }

  if (name === TOOL_NAMES.listFiles) {
    return { label: '已列出文件结构' };
  }

  if (name === TOOL_NAMES.indexWorkspace) {
    return { label: '已索引工作区' };
  }

  if (name === TOOL_NAMES.gitStatus) {
    return { label: '已获取 Git 状态' };
  }

  if (name === TOOL_NAMES.gitDiff) {
    return { label: args.file ? `已比较 ${String(args.file)}` : '已获取 Git Diff' };
  }

  if (name === TOOL_NAMES.gitLog) {
    return { label: `已获取 ${String(args.count || 10)} 条提交记录` };
  }

  if (name === TOOL_NAMES.projectMap) {
    return { label: '已生成项目结构' };
  }

  return { label: `工具 ${toolName} 执行成功` };
}

// ─── Risk Classification (shared between frontend cards and backend security) ─

export const RISK_LEVELS = Object.freeze({
  read: { id: 'read', label: '读取', color: '#3b82f6', icon: '👁' },
  write: { id: 'write', label: '写入', color: '#f59e0b', icon: '✏' },
  execute: { id: 'execute', label: '执行', color: '#ef4444', icon: '⚡' },
  network: { id: 'network', label: '网络', color: '#8b5cf6', icon: '🌐' },
} as const);

export type RiskLevel = (typeof RISK_LEVELS)[keyof typeof RISK_LEVELS];

// ─── Product-oriented Risk Level (low / medium / high) ──────────────────────

export const RISK_LEVEL_PRODUCT = Object.freeze({
  low: { label: '低风险', color: '#22c55e', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.25)' },
  medium: { label: '中风险', color: '#eab308', bg: 'rgba(234,179,8,0.12)', border: 'rgba(234,179,8,0.25)' },
  high: { label: '高风险', color: '#ef4444', bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.25)' },
} as const);

export type ProductRiskLevel = keyof typeof RISK_LEVEL_PRODUCT;

/** Get product-oriented risk level (low/medium/high) with color coding */
export function getToolProductRiskLevel(name: string): {
  level: ProductRiskLevel;
  label: string;
  color: string;
  bg: string;
  border: string;
} {
  const def = getToolDefinition(name);
  const level = (def?.riskLevel || 'medium') as ProductRiskLevel;
  const meta = RISK_LEVEL_PRODUCT[level] || RISK_LEVEL_PRODUCT.medium;
  return { level, ...meta };
}

/** Check if a tool has product metadata in registry */
export function hasToolProductMetadata(name: string): boolean {
  const def = getToolDefinition(name);
  return !!def && !!def.purpose && !!def.scope && !!def.riskReason;
}

export function getToolRiskLevel(toolName: string): RiskLevel {
  const name = String(toolName || '').toLowerCase();
  if (name.includes('run_code') || name.includes('execute') || name.includes('shell')) return RISK_LEVELS.execute;
  if (name.includes('web_search') || name.includes('fetch') || name.includes('http')) return RISK_LEVELS.network;
  if (name.includes('write') || name.includes('edit') || name.includes('create') || name.includes('delete'))
    return RISK_LEVELS.write;
  return RISK_LEVELS.read;
}

// ─── Icon Map ───────────────────────────────────────────────────────────────

const TOOL_ICON_MAP: Record<string, string> = Object.freeze({
  [TOOL_NAMES.readFile]: '📄',
  [TOOL_NAMES.readManyFiles]: '📄',
  [TOOL_NAMES.searchWorkspace]: '🔍',
  [TOOL_NAMES.readSymbol]: '🔣',
  [TOOL_NAMES.webSearch]: '🌐',
  [TOOL_NAMES.runCode]: '⚡',
  [TOOL_NAMES.writeFile]: '✏',
  [TOOL_NAMES.editFile]: '✏',
  [TOOL_NAMES.listFiles]: '📂',
  [TOOL_NAMES.indexWorkspace]: '🗂',
  [TOOL_NAMES.generateTree]: '🌳',
  [TOOL_NAMES.projectMap]: '🌳',
  [TOOL_NAMES.gitStatus]: '📋',
  [TOOL_NAMES.gitDiff]: '📝',
  [TOOL_NAMES.gitLog]: '📜',
  default: '🛠',
});

export function getToolIcon(toolName: string): string {
  for (const key of Object.keys(TOOL_ICON_MAP)) {
    if (toolName?.includes(key)) return TOOL_ICON_MAP[key];
  }
  return TOOL_ICON_MAP.default;
}

// ─── Tool-to-Role lookup table (for UI scroll / highlight) ──────────────────

export const ROLE_TOOL_MAP = Object.freeze({
  reader: Object.freeze([
    TOOL_NAMES.readFile,
    TOOL_NAMES.searchWorkspace,
    TOOL_NAMES.readSymbol,
    TOOL_NAMES.readManyFiles,
    TOOL_NAMES.listFiles,
    TOOL_NAMES.indexWorkspace,
    TOOL_NAMES.projectMap,
  ]),
  researcher: Object.freeze([TOOL_NAMES.webSearch]),
  coder: Object.freeze([TOOL_NAMES.runCode, TOOL_NAMES.writeFile, TOOL_NAMES.editFile]),
  reviewer: Object.freeze([TOOL_NAMES.gitStatus, TOOL_NAMES.gitDiff, TOOL_NAMES.gitLog]),
} as const);

// ─── Unified Tool Registry ──────────────────────────────────────────────────

const FRONTEND_TOOL_DEFINITIONS: Readonly<Record<string, SharedToolDefinition>> = Object.freeze({
  web_search: {
    name: 'web_search',
    category: 'search',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'researcher',
    productCopy: {
      purpose: '从互联网获取最新信息和参考来源',
      scope: '外部网络资源',
      riskReason: '仅读取公开信息，不修改本地数据',
      icon: '🌐',
    },
  },
  list_files: {
    name: 'list_files',
    category: 'file',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reader',
    productCopy: {
      purpose: '查看指定目录的文件列表',
      scope: '单个目录',
      riskReason: '仅列出文件名，不读取内容',
      icon: '📂',
    },
  },
  search_workspace: {
    name: 'search_workspace',
    category: 'search',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reader',
    productCopy: {
      purpose: '在工作区代码中搜索匹配内容',
      scope: '整个项目工作区',
      riskReason: '只读搜索，不修改代码',
      icon: '🔍',
    },
  },
  index_workspace: {
    name: 'index_workspace',
    category: 'workspace',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reader',
    productCopy: {
      purpose: '为工作区建立搜索索引以加速后续查询',
      scope: '整个项目工作区',
      riskReason: '仅构建索引，不修改源文件',
      icon: '🗂',
    },
  },
  read_file: {
    name: 'read_file',
    category: 'file',
    riskLevel: 'medium',
    approvalPolicy: 'confirm_once',
    parallelSafe: true,
    role: 'reader',
    productCopy: {
      purpose: '读取单个文件的内容',
      scope: '单个文件',
      riskReason: '可能访问敏感配置文件',
      icon: '📄',
    },
  },
  read_symbol: {
    name: 'read_symbol',
    category: 'file',
    riskLevel: 'medium',
    approvalPolicy: 'confirm_once',
    parallelSafe: true,
    role: 'reader',
    productCopy: {
      purpose: '查找并读取指定符号（函数/类/变量）的 definition',
      scope: '工作区中匹配的文件',
      riskReason: '可能暴露内部实现细节',
      icon: '🔣',
    },
  },
  run_code: {
    name: 'run_code',
    category: 'code',
    riskLevel: 'high',
    approvalPolicy: 'confirm_always',
    parallelSafe: false,
    role: 'coder',
    productCopy: {
      purpose: '执行代码片段并返回运行结果',
      scope: '隔离执行 environment',
      riskReason: '执行任意代码存在安全风险',
      icon: '⚡',
    },
  },
  git_status: {
    name: 'git_status',
    category: 'git',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reviewer',
    productCopy: {
      purpose: '查看当前仓库的 Git 状态',
      scope: '当前 Git 仓库',
      riskReason: '只读查询版本控制状态',
      icon: '📋',
    },
  },
  git_diff: {
    name: 'git_diff',
    category: 'git',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reviewer',
    productCopy: {
      purpose: '查看文件的变更差异',
      scope: '指定文件或整个仓库',
      riskReason: '只读查询变更内容',
      icon: '📝',
    },
  },
  git_log: {
    name: 'git_log',
    category: 'git',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reviewer',
    productCopy: {
      purpose: '查看最近的提交历史',
      scope: '当前分支提交记录',
      riskReason: '只读查询提交历史',
      icon: '📜',
    },
  },
  project_map: {
    name: 'project_map',
    category: 'workspace',
    riskLevel: 'low',
    approvalPolicy: 'always_allow',
    parallelSafe: true,
    role: 'reader',
    productCopy: {
      purpose: '生成项目整体结构地图',
      scope: '整个项目工作区',
      riskReason: '仅扫描文件结构，不读取内容',
      icon: '🌳',
    },
  },
  read_many_files: {
    name: 'read_many_files',
    category: 'file',
    riskLevel: 'medium',
    approvalPolicy: 'confirm_once',
    parallelSafe: true,
    role: 'reader',
    productCopy: {
      purpose: '批量读取多个文件的内容',
      scope: '多个文件',
      riskReason: '可能一次性访问大量敏感文件',
      icon: '📄',
    },
  },
  edit_file: {
    name: 'edit_file',
    category: 'file',
    riskLevel: 'high',
    approvalPolicy: 'confirm_always',
    parallelSafe: false,
    role: 'coder',
    productCopy: {
      purpose: '通过精确搜索替换编辑文件内容',
      scope: '单个文件的指定位置',
      riskReason: '会直接修改文件内容，必须先确认修改内容',
      icon: '✏️',
    },
  },
  multi_edit: {
    name: 'multi_edit',
    category: 'file',
    riskLevel: 'high',
    approvalPolicy: 'confirm_always',
    parallelSafe: false,
    role: 'coder',
    productCopy: {
      purpose: '对单个文件应用多处精确修改',
      scope: '单个文件的多个位置',
      riskReason: '会直接修改文件内容，所有修改必须先确认',
      icon: '✏️',
    },
  },
});

export interface ToolDefinition {
  name: string;
  icon: string;
  role: 'reader' | 'researcher' | 'coder' | 'reviewer' | 'planner';
  riskLevel: 'low' | 'medium' | 'high';
  approvalPolicy: 'always_allow' | 'confirm_once' | 'confirm_always';
  parallelSafe: boolean;
  summary: (args: Record<string, unknown>) => string;
  category: 'search' | 'file' | 'code' | 'git' | 'workspace' | 'mcp';
  purpose: string;
  scope: string;
  riskReason: string;
  readOnly: boolean;
  sideEffect: 'none' | 'filesystem-write' | 'process' | 'network' | 'external-mcp';
  contextPolicy: 'keep-full' | 'summarize' | 'truncate' | 'evidence-only';
}

export const TOOL_REGISTRY: Readonly<Record<string, ToolDefinition>> = Object.freeze(
  Object.entries(FRONTEND_TOOL_DEFINITIONS).reduce(
    (acc, [key, def]) => {
      const isReadOnly = def.riskLevel === 'low' && !['run_code', 'write_file', 'edit_file'].includes(def.name);
      const sideEffect =
        def.name === 'run_code'
          ? 'process'
          : ['write_file', 'edit_file'].includes(def.name)
            ? 'filesystem-write'
            : def.name.startsWith('mcp__')
              ? 'external-mcp'
              : def.name === 'web_search'
                ? 'network'
                : 'none';
      const contextPolicy =
        def.name === 'run_code'
          ? 'summarize'
          : ['read_file', 'read_many_files'].includes(def.name)
            ? 'evidence-only'
            : ['web_search', 'search_workspace'].includes(def.name)
              ? 'truncate'
              : 'keep-full';
      acc[key] = {
        name: def.name,
        icon: def.productCopy.icon,
        role: def.role,
        riskLevel: def.riskLevel,
        approvalPolicy: def.approvalPolicy,
        parallelSafe: def.parallelSafe,
        summary: (args: Record<string, unknown>) => getToolSummary({ toolName: def.name, args }).label,
        category: def.category,
        purpose: def.productCopy.purpose,
        scope: def.productCopy.scope,
        riskReason: def.productCopy.riskReason,
        readOnly: isReadOnly,
        sideEffect,
        contextPolicy,
      };
      return acc;
    },
    {} as Record<string, ToolDefinition>
  )
);

/** Get tool definition from registry, null if not found */
export function getToolDefinition(name: string): ToolDefinition | null {
  return TOOL_REGISTRY[String(name || '').toLowerCase()] || null;
}

/** Get approval policy for a tool from registry */
export function getToolApprovalPolicy(name: string): string {
  return getToolDefinition(name)?.approvalPolicy || 'confirm_always';
}

/** Check if a tool is safe to run in parallel */
export function isToolParallelSafe(name: string): boolean {
  return getToolDefinition(name)?.parallelSafe ?? false;
}

/** Get all registered tool names */
export function getAllToolNames(): string[] {
  return Object.keys(TOOL_REGISTRY);
}

/** Get a short summary for tool card display */
export function getToolCardSummary(name: string, args: Record<string, unknown> = {}): string {
  const def = getToolDefinition(name);
  if (def) return def.summary(args);
  return `工具 ${name}`;
}

/** Get the one-sentence purpose for a tool */
export function getToolPurpose(name: string): string {
  return getToolDefinition(name)?.purpose || '执行工具操作';
}

/** Get the scope description for a tool */
export function getToolScope(name: string): string {
  return getToolDefinition(name)?.scope || '工作区';
}

/** Get the risk reason for a tool */
export function getToolRiskReason(name: string): string {
  return getToolDefinition(name)?.riskReason || '标准风险等级';
}

/** Check if a tool is read-only (no side effects) */
export function isToolReadOnly(name: string): boolean {
  return getToolDefinition(name)?.readOnly ?? false;
}

/** Get the side effect type of a tool */
export function getToolSideEffect(name: string): string {
  return getToolDefinition(name)?.sideEffect || 'none';
}

/** Get the context policy for a tool */
export function getToolContextPolicy(name: string): string {
  return getToolDefinition(name)?.contextPolicy || 'keep-full';
}
