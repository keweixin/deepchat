export type AgentStageName =
  | 'plan'
  | 'model'
  | 'summary'
  | 'tool'
  | 'tool_pending'
  | 'tool_parallel'
  | 'tool_approved'
  | 'tool_auto_approved'
  | 'tool_denied'
  | 'tool_result'
  | 'tool_failed'
  | 'tool_skipped'
  | 'tool_repair'
  | 'warning'
  | 'final';

export type UsageSource = 'provider' | 'estimated' | 'mixed';
export type ToolRunStatus = 'pending' | 'approved' | 'denied' | 'running' | 'completed' | 'failed' | 'skipped';

export type ChatRequest = Record<string, unknown> & {
  requestId: string;
  messages?: Array<Record<string, unknown>>;
  overrides?: Record<string, unknown>;
  cacheProfile?: Record<string, unknown> | null;
  contextSummary?: string;
  contextSummaryMeta?: Record<string, unknown> | null;
};

export interface ToolRepairReport {
  scavenge?: boolean;
  truncation?: boolean;
  storm?: boolean;
  result?: string;
  warnings?: string[];
}

export interface NormalizedUsage {
  input: number;
  output: number;
  total: number;
  reasoning: number;
  cacheHit: number;
  cacheMiss: number;
  cacheHitRate: number;
  source: UsageSource;
  rounds?: number;
  warnings?: string[];
  byPurpose?: Record<string, number>;
  cost?: Record<string, unknown>;
  prefixFingerprint?: string;
}

export interface AgentStageEvent {
  stage: AgentStageName;
  round?: number;
  maxRounds?: number;
  toolName?: string;
  warning?: string;
  stopReason?: string;
  intent?: string;
  selectedTools?: string[];
  missingPrerequisites?: string[];
  repairReport?: ToolRepairReport | null;
}

export interface AgentToolRun {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolRunStatus;
  ok: boolean | null;
  requestedAt?: string;
  completedAt?: string;
  outputPreview?: string;
  contextOutput?: string;
  parseError?: string;
  repairReport?: ToolRepairReport | null;
  editPreview?: Record<string, unknown> | null;
  backupPath?: string;
}
