const { z } = require('zod');

const MAX_MESSAGE_CONTENT = 200000;
const MAX_ATTACHMENT_DATA_URL = 8 * 1024 * 1024;

const stringId = z.string().trim().min(1).max(160);
const optionalText = (max) => z.string().max(max).optional().default('');

const AttachmentSchema = z
  .object({
    id: z.string().max(160).optional(),
    name: z.string().max(260).optional(),
    type: z.string().max(120).optional(),
    mimeType: z.string().max(120).optional(),
    dataUrl: z.string().max(MAX_ATTACHMENT_DATA_URL).optional(),
    url: z.string().max(MAX_ATTACHMENT_DATA_URL).optional(),
    size: z.number().int().nonnegative().max(MAX_ATTACHMENT_DATA_URL).optional(),
  })
  .strip();

const TokenUsageSchema = z
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
    cost: z
      .object({
        model: z.string().max(200).optional(),
        estimatedCostUsd: z.number().nonnegative().optional(),
        estimatedSavingsUsd: z.number().nonnegative().optional(),
        inputCacheHitCostUsd: z.number().nonnegative().optional(),
        inputCacheMissCostUsd: z.number().nonnegative().optional(),
        outputCostUsd: z.number().nonnegative().optional(),
      })
      .strip()
      .optional(),
  })
  .strip();

const ToolJobSchema = z
  .object({
    id: z.string().max(160),
    requestId: z.string().max(160).optional(),
    toolCallId: z.string().max(160).optional(),
    toolName: z.string().max(160).optional(),
    status: z.enum(['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'timed_out', 'orphaned']),
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

const ToolRunSchema = z
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
    output: z.string().max(200000).optional(),
    outputPreview: z.string().max(12000).optional(),
    sources: z
      .array(
        z
          .object({
            title: z.string().max(300).optional(),
            url: z.string().max(2000).optional(),
            publishedDate: z.string().max(80).optional(),
          })
          .strip()
      )
      .max(50)
      .optional(),
    query: z.string().max(1000).optional(),
    security: z.record(z.string(), z.unknown()).optional(),
    approvalPolicy: z.string().max(80).optional(),
    autoApproved: z.boolean().optional(),
    nextAction: z.string().max(2000).optional(),
    parseError: z.string().max(2000).optional(),
    editPreview: z.record(z.string(), z.unknown()).nullable().optional(),
    backupPath: z.string().max(2000).optional(),
    restoreHint: z.string().max(2000).optional(),
    repairReport: z.record(z.string(), z.unknown()).nullable().optional(),
    editEvidence: z.record(z.string(), z.unknown()).nullable().optional(),
    foldDecision: z.record(z.string(), z.unknown()).nullable().optional(),
    contextOutput: z.string().max(20000).optional(),
    contextOutputTokens: z.number().nonnegative().optional(),
    rawOutputTokens: z.number().nonnegative().optional(),
    contextCompacted: z.boolean().optional(),
    contextCompactionRatio: z.number().nonnegative().optional(),
    contextCompactionReason: z.string().max(300).optional(),
    contextCompactionType: z.string().max(80).optional(),
    expiresAt: z.string().max(80).optional(),
    job: ToolJobSchema.nullable().optional(),
    searchProvider: z.string().max(80).optional(),
    fallbackReason: z.string().max(1000).optional(),
    externalConfigSource: z.string().max(200).optional(),
    warnings: z.array(z.string().max(1000)).max(20).optional(),
  })
  .strip();

const AgentStageSchema = z
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
    repairReport: z.record(z.string(), z.unknown()).nullable().optional(),
    foldDecision: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strip();

const TaskCheckpointSchema = z
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

const CrewMemberSchema = z
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

const AgentRunSchema = z
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

const MessageSchema = z.lazy(() =>
  z
    .object({
      role: z.enum(['user', 'assistant']),
      content: z.string().max(MAX_MESSAGE_CONTENT).default(''),
      modelContent: z.string().max(MAX_MESSAGE_CONTENT).optional(),
      timestamp: z.number().nonnegative().optional(),
      attachments: z.array(AttachmentSchema).max(8).optional(),
      thinking: z.string().max(200000).optional(),
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
    })
    .strip()
);

const MessageVersionSchema = z
  .object({
    content: z.string().max(MAX_MESSAGE_CONTENT).default(''),
    thinking: z.string().max(200000).optional(),
    tokens: TokenUsageSchema.nullable().optional(),
    speed: z.number().nonnegative().nullable().optional(),
    timestamp: z.number().nonnegative().optional(),
  })
  .strip();

const ConversationSchema = z
  .object({
    id: z.string().max(160),
    title: z.string().max(300).optional(),
    createdAt: z.number().nonnegative().optional(),
    updatedAt: z.number().nonnegative().optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    folderId: z.string().max(80).optional(),
    pinned: z.boolean().optional(),
    archivedAt: z.union([z.number().nonnegative(), z.null()]).optional(),
    contextSummary: z.string().max(12000).optional(),
    contextSummaryUpdatedAt: z.union([z.string().max(80), z.null()]).optional(),
    contextSummaryMeta: z.record(z.string(), z.unknown()).nullable().optional(),
    taskCheckpoint: TaskCheckpointSchema.nullable().optional(),
    taskCheckpointUpdatedAt: z.union([z.string().max(80), z.null()]).optional(),
    usageTotals: TokenUsageSchema.nullable().optional(),
    cacheProfile: z.record(z.string(), z.unknown()).nullable().optional(),
    messages: z.array(MessageSchema).max(1000).default([]),
  })
  .strip();

const MigrateLegacySchema = z
  .object({
    settings: z.record(z.string(), z.unknown()).optional(),
    conversations: z.array(ConversationSchema).max(500).optional(),
  })
  .strip();

const MpcEnvSchema = z.record(z.string(), z.string().max(4000));

const McpServerSchema = z
  .object({
    id: z.string().max(160).optional(),
    name: z.string().max(100).optional(),
    command: z.string().max(1000),
    args: z.array(z.string().max(2000)).max(80).optional(),
    env: MpcEnvSchema.optional(),
    cwd: z.string().max(2000).optional(),
    externalConfigSource: z.string().max(80).optional(),
    externalConfigPath: z.string().max(2000).optional(),
    externalConfigFingerprint: z.string().max(120).optional(),
    enabled: z.boolean().optional(),
  })
  .strip();

const ExternalSkillSchema = z
  .object({
    id: z.string().max(160).optional(),
    name: z.string().max(100).optional(),
    description: z.string().max(600).optional(),
    sourcePath: z.string().max(2000).optional(),
    content: z.string().max(60000).optional(),
    enabled: z.boolean().optional(),
    updatedAt: z.string().max(80).optional(),
  })
  .strip();

const SettingsPatchSchema = z
  .object({
    apiKey: z.string().max(8000).optional(),
    providerId: z
      .enum(['deepseek', 'openai', 'openrouter', 'siliconflow', 'dashscope', 'ollama', 'lmstudio', 'custom'])
      .optional(),
    apiBase: z.string().trim().min(1).max(600).optional(),
    model: z.string().trim().min(1).max(240).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(256).max(65536).optional(),
    maxInputTokens: z.number().int().min(1024).max(262144).optional(),
    systemPrompt: z.string().max(60000).optional(),
    maxContextMessages: z.number().int().min(2).max(100).optional(),
    agentMaxRounds: z.number().int().min(1).max(10).optional(),
    thinkingBudget: z.number().int().min(0).max(65536).optional(),
    activeSkill: z
      .enum(['agent_auto', 'none', 'web_search', 'file_reader', 'code_runner', 'mcp_tool', 'multi_tool'])
      .optional(),
    autoContextSummary: z.boolean().optional(),
    cacheOptimization: z.boolean().optional(),
    contextFoldEconomicsEnabled: z.boolean().optional(),
    codingEditsEnabled: z.boolean().optional(),
    agentModelTier: z.enum(['flash', 'auto', 'pro']).optional(),
    toolApprovalTimeoutMs: z.number().int().min(5000).max(300000).optional(),
    toolApprovalPolicy: z.enum(['confirm_all', 'auto_readonly']).optional(),
    runCodeEnabled: z.boolean().optional(),
    enhance: z.boolean().optional(),
    tavilyApiKey: z.string().max(8000).optional(),
    tavilyMaxResults: z.number().int().min(1).max(10).optional(),
    tavilySearchDepth: z.enum(['ultra-fast', 'fast', 'basic', 'advanced']).optional(),
    tavilyIncludeAnswer: z.boolean().optional(),
    tavilyIncludeRawContent: z.boolean().optional(),
    tavilyExtractTopResults: z.number().int().min(0).max(5).optional(),
    tavilyChunksPerSource: z.number().int().min(1).max(5).optional(),
    tavilyCacheTtlMinutes: z.number().int().min(0).max(1440).optional(),
    externalMcpDiscoveryEnabled: z.boolean().optional(),
    localSearchFallbackMode: z.enum(['missing_key', 'provider_error', 'off']).optional(),
    fallbackOnSearchError: z.boolean().optional(),
    docsetSearchEnabled: z.boolean().optional(),
    docsetRoots: z.array(z.string().max(2000)).max(20).optional(),
    workspaceRoots: z.array(z.string().max(2000)).max(20).optional(),
    externalSkills: z.array(ExternalSkillSchema).max(20).optional(),
    mcpServers: z.array(McpServerSchema).max(20).optional(),
  })
  .strict();

const ComposerOverridesSchema = z
  .object({
    thinkingBudget: z.number().int().min(0).max(65536).optional(),
    activeSkill: z
      .enum(['agent_auto', 'none', 'web_search', 'file_reader', 'code_runner', 'mcp_tool', 'multi_tool'])
      .optional(),
    enhance: z.boolean().optional(),
    agentMaxRounds: z.number().int().min(1).max(10).optional(),
    maxInputTokens: z.number().int().min(1024).max(262144).optional(),
    agentExecutionMode: z.enum(['execute_all', 'single_step']).optional(),
  })
  .strict();

const ChatStartSchema = z
  .object({
    requestId: stringId,
    messages: z.array(MessageSchema).max(200),
    overrides: ComposerOverridesSchema.optional().default({}),
    contextSummary: z.string().max(12000).optional().default(''),
    contextSummaryMeta: z.record(z.string(), z.unknown()).nullable().optional(),
    cacheProfile: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (bytes > 8 * 1024 * 1024) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'chat:start payload too large' });
    }
  });

const ToolApprovalSchema = z
  .object({
    requestId: stringId,
    toolCallId: stringId,
    approved: z.boolean(),
  })
  .strict();

const ToolSkipSchema = z
  .object({
    requestId: stringId,
    toolCallId: stringId.or(z.literal('current')).optional(),
  })
  .strict();

const LimitScopeSchema = z
  .object({
    requestId: stringId,
    scopePolicy: z.string().max(200),
  })
  .strict();

const RunCodeArgsSchema = z
  .object({
    language: z.enum(['javascript', 'js', 'python', 'py']),
    code: z.string().min(1).max(20000),
    stdin: z.string().max(20000).optional(),
  })
  .strict();

const RunManualToolSchema = z
  .object({
    name: z.literal('run_code'),
    args: RunCodeArgsSchema,
  })
  .strict();

const TestSearchSchema = z.string().max(500).optional();
const WorkspaceRemoveSchema = z.string().min(1).max(2000);
const RequestIdSchema = stringId;
const ExternalMcpImportSchema = z
  .object({
    servers: z.array(McpServerSchema).min(1).max(20),
  })
  .strict();
const ExternalMcpProbeSchema = z
  .object({
    server: McpServerSchema,
  })
  .strict();
const ExternalSkillImportSchema = z
  .object({
    skills: z.array(ExternalSkillSchema).min(1).max(80),
  })
  .strict();
const DocsetRootSchema = z.string().trim().min(1).max(2000);
const DocsetSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    maxResults: z.number().int().min(1).max(20).optional(),
  })
  .strict();

function validate(schema, value, label) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path?.length ? ` (${issue.path.join('.')})` : '';
  throw new Error(`${label} 入参无效${path}: ${issue?.message || 'invalid payload'}`);
}

function summarizeChatStartForLog(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const overrides =
    request?.overrides && typeof request.overrides === 'object' && !Array.isArray(request.overrides)
      ? request.overrides
      : {};
  return {
    requestId: typeof request?.requestId === 'string' ? request.requestId.slice(0, 160) : undefined,
    messageCount: messages.length,
    roles: messages.map((message) => (typeof message?.role === 'string' ? message.role.slice(0, 20) : 'unknown')),
    attachmentCount: messages.reduce(
      (total, message) => total + (Array.isArray(message?.attachments) ? message.attachments.length : 0),
      0
    ),
    contentBytes: messages.reduce(
      (total, message) =>
        total + Buffer.byteLength(typeof message?.content === 'string' ? message.content : '', 'utf8'),
      0
    ),
    hasContextSummary: Boolean(request?.contextSummary),
    contextSummaryBytes: Buffer.byteLength(
      typeof request?.contextSummary === 'string' ? request.contextSummary : '',
      'utf8'
    ),
    hasCacheProfile: Boolean(request?.cacheProfile),
    overrides: {
      activeSkill: typeof overrides.activeSkill === 'string' ? overrides.activeSkill.slice(0, 80) : undefined,
      agentExecutionMode:
        typeof overrides.agentExecutionMode === 'string' ? overrides.agentExecutionMode.slice(0, 80) : undefined,
      enhance: typeof overrides.enhance === 'boolean' ? overrides.enhance : undefined,
      thinkingBudget: Number.isFinite(overrides.thinkingBudget) ? overrides.thinkingBudget : undefined,
    },
  };
}

module.exports = {
  validate,
  summarizeChatStartForLog,
  schemas: {
    SettingsPatchSchema,
    MigrateLegacySchema,
    ConversationsSaveSchema: z.array(ConversationSchema).max(500),
    ChatStartSchema,
    ToolApprovalSchema,
    ToolSkipSchema,
    LimitScopeSchema,
    RunManualToolSchema,
    TestSearchSchema,
    WorkspaceRemoveSchema,
    RequestIdSchema,
    ExternalMcpImportSchema,
    ExternalMcpProbeSchema,
    ExternalSkillImportSchema,
    DocsetRootSchema,
    DocsetSearchSchema,
  },
};
