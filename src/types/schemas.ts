/**
 * Core Zod schemas — single source of truth for runtime validation and TS types.
 *
 * Derived from electron/ipc-validation.js and settings-core.js.
 * IPC layer should eventually import from here (Phase 4) instead of duplicating.
 */

import { z } from 'zod';

const MAX_MESSAGE_CONTENT = 200_000;

// ─── Attachment ──────────────────────────────────────────────────────────────

export const AttachmentSchema = z
  .object({
    id: z.string().max(160).optional(),
    name: z.string().max(260).optional(),
    type: z.string().max(120).optional(),
    mimeType: z.string().max(120).optional(),
    dataUrl: z.string().optional(),
    url: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strip();

// ─── Token Usage ─────────────────────────────────────────────────────────────

export const UsageCostSchema = z
  .object({
    model: z.string().max(200).optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
    estimatedSavingsUsd: z.number().nonnegative().optional(),
    inputCacheHitCostUsd: z.number().nonnegative().optional(),
    inputCacheMissCostUsd: z.number().nonnegative().optional(),
    outputCostUsd: z.number().nonnegative().optional(),
  })
  .strip()
  .optional();

export const TokenUsageSchema = z
  .object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    total: z.number().nonnegative().optional(),
    reasoning: z.number().nonnegative().optional(),
    cacheHit: z.number().nonnegative().optional(),
    cacheMiss: z.number().nonnegative().optional(),
    cacheHitRate: z.number().nonnegative().optional(),
    source: z.string().max(40).optional(),
    rounds: z.number().int().nonnegative().optional(),
    warnings: z.array(z.string().max(1000)).max(20).optional(),
    cacheStabilityWarnings: z.array(z.string().max(1000)).max(20).optional(),
    cacheStabilityReasons: z.array(z.string().max(80)).max(20).optional(),
    cacheStabilityDetails: z.record(z.string(), z.unknown()).optional(),
    byPurpose: z.record(z.string(), z.number().nonnegative()).optional(),
    cost: UsageCostSchema,
  })
  .strip();

// ─── Tool Run ────────────────────────────────────────────────────────────────

export const ToolSourceSchema = z
  .object({
    title: z.string().max(300).optional(),
    url: z.string().max(2000).optional(),
    publishedDate: z.string().max(80).optional(),
  })
  .strip();

export const ToolCitationSchema = z
  .object({
    label: z.string().max(300).optional(),
    file: z.string().max(2000).optional(),
    lineStart: z.number().int().nonnegative().optional(),
    lineEnd: z.number().int().nonnegative().optional(),
  })
  .strip();

export const ToolRunSchema = z
  .object({
    id: z.string().max(160).optional(),
    name: z.string().max(160).optional(),
    args: z.unknown().optional(),
    risk: z.string().max(3000).optional(),
    status: z.string().max(40).optional(),
    ok: z.boolean().optional(),
    requestedAt: z.string().max(80).optional(),
    completedAt: z.string().max(80).optional(),
    durationMs: z.number().nonnegative().nullable().optional(),
    output: z.string().max(MAX_MESSAGE_CONTENT).optional(),
    outputPreview: z.string().max(12000).optional(),
    sources: z.array(ToolSourceSchema).max(50).optional(),
    query: z.string().max(1000).optional(),
    security: z.record(z.string(), z.unknown()).optional(),
    parseError: z.string().max(2000).optional(),
    contextOutput: z.string().max(20000).optional(),
    contextOutputTokens: z.number().nonnegative().optional(),
    rawOutputTokens: z.number().nonnegative().optional(),
    contextCompacted: z.boolean().optional(),
    contextCompactionRatio: z.number().nonnegative().optional(),
    contextCompactionReason: z.string().max(300).optional(),
    contextCompactionType: z.string().max(80).optional(),
    expiresAt: z.string().max(80).optional(),
    autoApproved: z.boolean().optional(),
    nextAction: z.string().max(200).optional(),
    localCitations: z.array(ToolCitationSchema).max(50).optional(),
    error: z.string().max(4000).optional(),
  })
  .strip();

// ─── Agent Stage ─────────────────────────────────────────────────────────────

export const AgentStageSchema = z
  .object({
    stage: z.string().max(80).optional(),
    round: z.number().int().nonnegative().optional(),
    maxRounds: z.number().int().nonnegative().optional(),
    intent: z.unknown().optional(),
    selectedTools: z.array(z.string().max(160)).max(100).optional(),
    candidateTools: z.array(z.string().max(160)).max(100).optional(),
    missingPrerequisites: z.array(z.string().max(200)).max(20).optional(),
    warning: z.string().max(3000).optional(),
    stopReason: z.string().max(3000).optional(),
    toolName: z.string().max(160).optional(),
    at: z.string().max(80).optional(),
  })
  .strip();

// ─── Task Checkpoint ─────────────────────────────────────────────────────────

export const TaskCheckpointSchema = z
  .object({
    objective: z.string().max(600).optional(),
    latestUserGoal: z.string().max(700).optional(),
    lastAssistantSummary: z.string().max(900).optional(),
    contextSummary: z.string().max(900).optional(),
    openItems: z.array(z.string().max(600)).max(8).optional(),
    lastTools: z.array(z.string().max(200)).max(12).optional(),
    completedSteps: z.array(z.string().max(500)).max(8).optional(),
    failedSteps: z.array(z.string().max(600)).max(8).optional(),
    pendingApprovals: z.array(z.string().max(500)).max(6).optional(),
    recoveryActions: z.array(z.string().max(600)).max(8).optional(),
    agentStatus: z.enum(['ready', 'needs_attention', 'waiting_for_approval', 'failed', 'completed']).optional(),
    sourceMessageCount: z.number().int().nonnegative().optional(),
    updatedAt: z.string().max(80).optional(),
    prefixFingerprint: z.string().max(80).optional(),
  })
  .strip();

// ─── Crew / Agent Run ────────────────────────────────────────────────────────

export const CrewMemberSchema = z
  .object({
    id: z.string().max(80),
    label: z.string().max(80).optional(),
    icon: z.string().max(20).optional(),
    title: z.string().max(80).optional(),
    status: z.enum(['idle', 'running', 'done', 'error', 'waiting', 'skipped']),
    currentAction: z.string().max(600).optional(),
    outputSummary: z.string().max(2000).optional(),
    linkedToolCallIds: z.array(z.string().max(160)).max(100).optional(),
    linkedStepIds: z.array(z.string().max(160)).max(100).optional(),
    startedAt: z.string().max(80).nullable().optional(),
    finishedAt: z.string().max(80).nullable().optional(),
  })
  .strip();

export const AgentRunSchema = z
  .object({
    id: z.string().max(160),
    mode: z.string().max(80).optional(),
    status: z.enum(['running', 'done', 'error', 'cancelled']),
    startedAt: z.string().max(80).optional(),
    finishedAt: z.string().max(80).nullable().optional(),
    crew: z.array(CrewMemberSchema).max(12),
    steps: z
      .array(z.union([z.string().max(1000), z.record(z.string(), z.unknown())]))
      .max(100)
      .optional(),
  })
  .strip();

// ─── Message ─────────────────────────────────────────────────────────────────

export const MessageVersionSchema = z
  .object({
    content: z.string().max(MAX_MESSAGE_CONTENT).default(''),
    thinking: z.string().max(MAX_MESSAGE_CONTENT).optional(),
    tokens: TokenUsageSchema.nullable().optional(),
    speed: z.number().nonnegative().nullable().optional(),
    timestamp: z.number().nonnegative().optional(),
  })
  .strip();

export const ChatMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(MAX_MESSAGE_CONTENT).default(''),
    modelContent: z.string().max(MAX_MESSAGE_CONTENT).optional(),
    timestamp: z.number().nonnegative().optional(),
    attachments: z.array(AttachmentSchema).max(8).optional(),
    thinking: z.string().max(MAX_MESSAGE_CONTENT).optional(),
    tokens: TokenUsageSchema.nullable().optional(),
    speed: z.number().nonnegative().nullable().optional(),
    versions: z.array(MessageVersionSchema).max(20).optional(),
    toolCalls: z.array(ToolRunSchema).max(100).optional(),
    toolRuns: z.array(ToolRunSchema).max(100).optional(),
    agentStages: z.array(AgentStageSchema).max(200).optional(),
    agentRun: AgentRunSchema.optional(),
    contextBudget: z.record(z.string(), z.unknown()).nullable().optional(),
    cacheProfile: z.record(z.string(), z.unknown()).nullable().optional(),
    composerOverrides: z.record(z.string(), z.unknown()).nullable().optional(),
    error: z.string().max(4000).optional(),
    favorite: z.boolean().optional(),
    _versionIdx: z.number().int().nonnegative().optional(),
    _liveSnapshot: z.unknown().optional(),
    contextCompacted: z.boolean().optional(),
  })
  .strip();

// ─── Settings ────────────────────────────────────────────────────────────────

export const StorageStatusSchema = z
  .object({
    mode: z.enum(['browser', 'native']).optional(),
    encryptionAvailable: z.boolean().optional(),
    dataDir: z.string().optional(),
  })
  .strip();

export const SettingsSchema = z
  .object({
    apiKey: z.string().optional(),
    providerId: z.string().max(80).optional(),
    apiBase: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    maxInputTokens: z.number().int().positive().optional(),
    systemPrompt: z.string().max(MAX_MESSAGE_CONTENT).optional(),
    maxContextMessages: z.number().int().positive().optional(),
    agentMaxRounds: z.number().int().nonnegative().optional(),
    thinkingBudget: z.number().int().nonnegative().optional(),
    activeSkill: z.string().max(80).optional(),
    crewDisplayMode: z.enum(['auto', 'compact', 'verbose']).optional(),
    defaultComposerMode: z.string().max(80).optional(),
    autoContextSummary: z.boolean().optional(),
    cacheOptimization: z.boolean().optional(),
    toolApprovalTimeoutMs: z.number().int().positive().optional(),
    toolApprovalPolicy: z.enum(['confirm_all', 'confirm_risky', 'auto_approve']).optional(),
    runCodeEnabled: z.boolean().optional(),
    enhance: z.boolean().optional(),
    tavilyApiKey: z.string().optional(),
    tavilyMaxResults: z.number().int().positive().optional(),
    workspaceRoots: z.array(z.string().max(500)).optional(),
    externalSkills: z.array(z.record(z.string(), z.unknown())).optional(),
    mcpServers: z.array(z.record(z.string(), z.unknown())).optional(),
    storageStatus: StorageStatusSchema.optional(),
  })
  .strip();
