/**
 * DeepChat Core Type Definitions
 *
 * Zod-derived types are imported from ./zod-derived.ts (single source of truth).
 * This file only holds types that Zod cannot express (discriminated unions,
 * IPC maps, bridge interfaces) or that need frontend-specific extensions.
 */

export type {
  Attachment,
  TokenUsage,
  UsageCost,
  ToolRun,
  ToolSource,
  ToolCitation,
  AgentStage,
  TaskCheckpoint,
  CrewMember,
  AgentRun,
  MessageVersion,
  ChatMessage,
  StorageStatus,
} from './zod-derived.js';

export type {
  AgentStageEvent,
  AgentToolRun,
  NormalizedUsage,
  ToolRepairReport,
} from '../../electron/agent-contracts.js';

// ─── Frontend-specific / Zod-unexpressible types ─────────────────────────────

/** Cache optimization profile */
export interface CacheProfile {
  prefixFingerprint?: string;
  prefixTokens?: number;
  prefixBytes?: number;
  systemHash?: string;
  toolsHash?: string;
  workspaceSignature?: string;
  toolNames?: string[];
  cacheStabilityWarnings?: string[];
  cacheStabilityReasons?: string[];
  cacheStabilityDetails?: Record<string, unknown>;
  cacheHit?: number;
  cacheMiss?: number;
  cacheHitRate?: number;
  estimatedCostUsd?: number;
  estimatedSavingsUsd?: number;
}

/** A conversation with messages */
export interface Conversation {
  id: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  tags?: string[];
  folderId?: string;
  pinned?: boolean;
  archivedAt?: number | null;
  contextSummary?: string;
  contextSummaryUpdatedAt?: string | null;
  contextSummaryMeta?: Record<string, unknown> | null;
  taskCheckpoint?: import('./zod-derived.js').TaskCheckpoint | null;
  taskCheckpointUpdatedAt?: string | null;
  usageTotals?: import('./zod-derived.js').TokenUsage | null;
  cacheProfile?: CacheProfile | null;
  messages: import('./zod-derived.js').ChatMessage[];
}

/** MCP server configuration */
export interface McpServerConfig {
  id?: string;
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  externalConfigSource?: string;
  externalConfigPath?: string;
  externalConfigFingerprint?: string;
  enabled?: boolean;
}

/** External skill definition */
export interface ExternalSkill {
  id?: string;
  name?: string;
  description?: string;
  sourcePath?: string;
  content?: string;
  enabled?: boolean;
  updatedAt?: string;
}

/** Provider IDs */
export type ProviderId =
  | 'deepseek'
  | 'openai'
  | 'openrouter'
  | 'siliconflow'
  | 'dashscope'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

/** Active skill modes */
export type ActiveSkill =
  | 'agent_auto'
  | 'none'
  | 'web_search'
  | 'file_reader'
  | 'code_runner'
  | 'mcp_tool'
  | 'multi_tool';

/** Agent execution mode */
export type AgentExecutionMode = 'execute_all' | 'single_step';

/** Composer overrides for a single message */
export interface ComposerOverrides {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  thinkingBudget?: number;
  activeSkill?: ActiveSkill;
  enhance?: boolean;
  agentMaxRounds?: number;
  maxInputTokens?: number;
  agentExecutionMode?: AgentExecutionMode;
}

/** Settings patch (all fields optional) */
export interface SettingsPatch {
  apiKey?: string;
  providerId?: ProviderId;
  apiBase?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  maxInputTokens?: number;
  systemPrompt?: string;
  maxContextMessages?: number;
  agentMaxRounds?: number;
  thinkingBudget?: number;
  activeSkill?: ActiveSkill;
  autoContextSummary?: boolean;
  cacheOptimization?: boolean;
  contextFoldEconomicsEnabled?: boolean;
  codingEditsEnabled?: boolean;
  agentModelTier?: 'flash' | 'auto' | 'pro';
  toolApprovalTimeoutMs?: number;
  toolApprovalPolicy?: 'confirm_all' | 'auto_readonly';
  runCodeEnabled?: boolean;
  enhance?: boolean;
  tavilyApiKey?: string;
  tavilyMaxResults?: number;
  tavilySearchDepth?: 'ultra-fast' | 'fast' | 'basic' | 'advanced';
  tavilyIncludeAnswer?: boolean;
  tavilyIncludeRawContent?: boolean;
  tavilyExtractTopResults?: number;
  tavilyChunksPerSource?: number;
  tavilyCacheTtlMinutes?: number;
  externalMcpDiscoveryEnabled?: boolean;
  localSearchFallbackMode?: 'missing_key' | 'provider_error' | 'off';
  fallbackOnSearchError?: boolean;
  docsetSearchEnabled?: boolean;
  docsetRoots?: string[];
  workspaceRoots?: string[];
  externalSkills?: ExternalSkill[];
  mcpServers?: McpServerConfig[];
}

/** Full settings (extends patch with runtime fields) */
export interface Settings extends SettingsPatch {
  crewDisplayMode?: 'auto' | 'compact' | 'theatre' | 'off' | 'always' | 'tools_only';
  defaultComposerMode?: string;
  theme?: 'light' | 'dark';
  storageStatus?: unknown;
}

/** Chat start request */
export interface ChatStartRequest {
  requestId: string;
  messages: import('./zod-derived.js').ChatMessage[];
  overrides?: ComposerOverrides;
  contextSummary?: string;
  contextSummaryMeta?: Record<string, unknown>;
  cacheProfile?: CacheProfile | null;
}

/** Tool approval request */
export interface ToolApprovalRequest {
  requestId: string;
  toolCallId: string;
  approved: boolean;
}

/** Run code args */
export interface RunCodeArgs {
  language: 'javascript' | 'js' | 'python' | 'py';
  code: string;
  stdin?: string;
}

/** Chat event types from the main process */
export type ChatEvent =
  | { type: 'token'; data: string }
  | { type: 'thinking'; data: string }
  | { type: 'token_count'; data: import('./zod-derived.js').TokenUsage }
  | { type: 'tool_request'; data: ToolRequestEvent }
  | { type: 'tool_result'; data: ToolResultEvent }
  | { type: 'agent_stage'; data: import('./zod-derived.js').AgentStage }
  | { type: 'context_budget'; data: Record<string, unknown> }
  | { type: 'context_summary'; data: ContextSummaryEvent }
  | { type: 'done'; data: DoneEvent }
  | { type: 'error'; data: ErrorEvent };

export interface ToolRequestEvent {
  requestId: string;
  toolCallId: string;
  toolName: string;
  args?: unknown;
  risk?: string;
  approvalPolicy?: string;
  autoApproved?: boolean;
}

export interface ToolResultEvent {
  toolCallId: string;
  toolName?: string;
  ok?: boolean;
  output?: string;
  outputSummary?: string;
  error?: string;
  durationMs?: number;
  sources?: import('./zod-derived.js').ToolSource[];
  localCitations?: import('./zod-derived.js').ToolCitation[];
}

export interface ContextSummaryEvent {
  requestId: string;
  summary?: string;
  meta?: Record<string, unknown>;
  checkpoint?: import('./zod-derived.js').TaskCheckpoint | null;
}

export interface DoneEvent {
  requestId: string;
  usage?: import('./zod-derived.js').TokenUsage;
  cacheProfile?: CacheProfile;
}

export interface ErrorEvent {
  requestId: string;
  error: string;
  recoverable?: boolean;
}

// ─── Bridge / Window types (Zod cannot express global augmentations) ─────────

/** Electron preload bridge exposed on window.deepchat */
export interface DeepChatBridge {
  settings: {
    get: () => Promise<Settings>;
    set: (patch: SettingsPatch) => Promise<Settings>;
    testApi: () => Promise<{ ok: boolean; error?: string }>;
    testSearch: (query: string) => Promise<{ ok: boolean; error?: string }>;
    migrateLegacy: (data: { settings: Settings; conversations: Conversation[] }) => Promise<void>;
  };
  chat: {
    stream: (request: ChatStartRequest) => Promise<string>;
    onEvent: (cb: (event: ChatEvent) => void) => () => void;
    abort: (requestId: string) => void;
    approve: (requestId: string, toolCallId: string, approved: boolean) => void;
  };
  tools: {
    run: (name: string, args: unknown) => Promise<unknown>;
    list: () => Promise<string[]>;
  };
  mcp?: {
    listStatus: () => Promise<unknown[]>;
    scanExternalConfigs: () => Promise<unknown>;
    importExternalConfigs: (payload: { servers: McpServerConfig[] }) => Promise<Settings>;
    probeExternalConfig: (payload: { server: McpServerConfig }) => Promise<unknown>;
  };
  docset?: {
    list: () => Promise<unknown>;
    add: (root?: string) => Promise<Settings>;
    remove: (root: string) => Promise<Settings>;
    search: (payload: { query: string; maxResults?: number }) => Promise<unknown>;
  };
  workspace: {
    listRoots: () => Promise<string[]>;
    addRoot: (path: string) => Promise<void>;
    removeRoot: (path: string) => Promise<void>;
    indexWorkspace: () => Promise<{ ok: boolean }>;
    searchWorkspace: (query: string, maxResults?: number) => Promise<unknown[]>;
    readSymbol: (symbol: string) => Promise<unknown>;
    readFile: (path: string) => Promise<string>;
    listFiles: (directory: string) => Promise<string[]>;
  };
  memory: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
  };
}

declare global {
  interface Window {
    deepchat?: DeepChatBridge;
  }
}
