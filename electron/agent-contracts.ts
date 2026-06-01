import { z } from 'zod';

export const AgentStageNameSchema = z.enum([
  'plan',
  'model',
  'summary',
  'tool',
  'tool_pending',
  'tool_parallel',
  'tool_approved',
  'tool_auto_approved',
  'tool_denied',
  'tool_result',
  'tool_failed',
  'tool_skipped',
  'tool_repair',
  'warning',
  'paused',
  'running',
  'model_upgrade',
  'stop',
  'final',
]);

export const UsageSourceSchema = z.enum(['provider', 'estimated', 'mixed']);
export const ToolRunStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'running',
  'completed',
  'failed',
  'skipped',
]);
export const ToolJobStatusSchema = z.enum([
  'queued',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'orphaned',
]);

export const ToolRepairReportSchema = z
  .object({
    scavenge: z.boolean().optional(),
    truncation: z.boolean().optional(),
    storm: z.boolean().optional(),
    result: z.string().max(80).optional(),
    warnings: z.array(z.string().max(1000)).max(20).optional(),
  })
  .strip();

export const ToolJobSnapshotSchema = z
  .object({
    id: z.string().max(160),
    requestId: z.string().max(160).optional(),
    toolCallId: z.string().max(160).optional(),
    toolName: z.string().max(160).optional(),
    status: ToolJobStatusSchema,
    createdAt: z.string().max(80).optional(),
    updatedAt: z.string().max(80).optional(),
    startedAt: z.string().max(80).optional(),
    finishedAt: z.string().max(80).optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    cancelGraceMs: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    outputPreview: z.string().max(12000).optional(),
    error: z.string().max(4000).optional(),
    stale: z.boolean().optional(),
    staleResult: z.string().max(4000).optional(),
    orphaned: z.boolean().optional(),
    rollbackError: z.string().max(4000).optional(),
  })
  .strip();

export const NormalizedUsageSchema = z
  .object({
    input: z.number().nonnegative().default(0),
    output: z.number().nonnegative().default(0),
    total: z.number().nonnegative().default(0),
    reasoning: z.number().nonnegative().default(0),
    cacheHit: z.number().nonnegative().default(0),
    cacheMiss: z.number().nonnegative().default(0),
    cacheHitRate: z.number().nonnegative().default(0),
    source: UsageSourceSchema.default('estimated'),
    rounds: z.number().int().nonnegative().optional(),
    warnings: z.array(z.string().max(1000)).max(50).optional(),
    byPurpose: z.record(z.string(), z.number().nonnegative()).optional(),
    cost: z.record(z.string(), z.unknown()).optional(),
    prefixFingerprint: z.string().max(160).optional(),
  })
  .strip();

export const AgentStageEventSchema = z
  .object({
    stage: AgentStageNameSchema.or(z.string().max(80)),
    round: z.number().int().nonnegative().optional(),
    maxRounds: z.number().int().nonnegative().optional(),
    toolName: z.string().max(160).optional(),
    warning: z.string().max(3000).optional(),
    stopReason: z.string().max(3000).optional(),
    intent: z.unknown().optional(),
    selectedTools: z.array(z.string().max(160)).max(100).optional(),
    missingPrerequisites: z.array(z.string().max(200)).max(20).optional(),
    repairReport: ToolRepairReportSchema.nullable().optional(),
  })
  .strip();

export const AgentToolRunSchema = z
  .object({
    id: z.string().max(160),
    name: z.string().max(160),
    args: z.record(z.string(), z.unknown()).default({}),
    status: ToolRunStatusSchema,
    ok: z.boolean().nullable(),
    requestedAt: z.string().max(80).optional(),
    completedAt: z.string().max(80).optional(),
    outputPreview: z.string().max(12000).optional(),
    contextOutput: z.string().max(20000).optional(),
    parseError: z.string().max(2000).optional(),
    repairReport: ToolRepairReportSchema.nullable().optional(),
    editPreview: z.record(z.string(), z.unknown()).nullable().optional(),
    backupPath: z.string().max(2000).optional(),
    job: ToolJobSnapshotSchema.nullable().optional(),
    searchProvider: z.string().max(80).optional(),
    fallbackReason: z.string().max(1000).optional(),
    externalConfigSource: z.string().max(200).optional(),
    warnings: z.array(z.string().max(1000)).max(20).optional(),
  })
  .strip();

export const ChatRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(160),
    messages: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
    overrides: z.record(z.string(), z.unknown()).optional(),
    cacheProfile: z.record(z.string(), z.unknown()).nullable().optional(),
    contextSummary: z.string().max(12000).optional(),
    contextSummaryMeta: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export type AgentStageName = z.infer<typeof AgentStageNameSchema>;
export type UsageSource = z.infer<typeof UsageSourceSchema>;
export type ToolRunStatus = z.infer<typeof ToolRunStatusSchema>;
export type ToolJobStatus = z.infer<typeof ToolJobStatusSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ToolRepairReport = z.infer<typeof ToolRepairReportSchema>;
export type ToolJobSnapshot = z.infer<typeof ToolJobSnapshotSchema>;
export type NormalizedUsage = z.infer<typeof NormalizedUsageSchema>;
export type AgentStageEvent = z.infer<typeof AgentStageEventSchema>;
export type AgentToolRun = z.infer<typeof AgentToolRunSchema>;
