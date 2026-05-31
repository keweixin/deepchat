import path from 'path';
import { buildToolContextOutput, buildToolNextAction } from './chat-service-helpers.js';
import { isMcpToolName } from './mcp-manager.js';
import { buildToolSecurity, resolveToolApprovalTimeout } from './approval-manager.js';
import { normalizeError } from './provider-adapters.js';
import { executeTool, previewToolCall } from './tools.js';
import { defaultJobRuntime, resolveToolJobTimeout, shouldTrackToolJob, type ToolJob } from './job-runtime.js';
import type { ToolRepairReport } from './agent-contracts.js';

type ToolCall = {
  id: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type ToolController = {
  skippedToolCallIds?: Set<string>;
  scopePolicy?: string;
};

type EmitFn = (requestId: string, type: string, payload?: Record<string, any>) => void;

export function buildScopedToolSecurity(name: string, args: any, settings: any, controller?: ToolController | null) {
  const security = buildToolSecurity(name, args, settings);
  if (!controller?.scopePolicy) return security;

  if (controller.scopePolicy === 'read_only') {
    const isWrite = ['run_code', 'write_file', 'edit_file', 'multi_edit'].includes(name);
    return isWrite
      ? {
          ...security,
          riskLevel: 'high',
          sandboxBlocked: true,
          restrictionReason: '用户限制读取范围为只读模式。',
        }
      : security;
  }

  if (!controller.scopePolicy.startsWith('dir:')) return security;
  const allowedDir = controller.scopePolicy.slice(4);
  const pathArg = args.path || args.filepath || args.dir || args.directory || '';
  if (!pathArg || typeof pathArg !== 'string') return security;

  const relative = path.relative(allowedDir, pathArg);
  const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
  return isOutside
    ? {
        ...security,
        riskLevel: 'high',
        sandboxBlocked: true,
        restrictionReason: `路径超出用户限制范围：${allowedDir}`,
      }
    : security;
}

export function createTrackedToolJob(
  name: string,
  args: any,
  requestId: string,
  toolCall: ToolCall,
  parsedArgsError?: string
) {
  const jobTimeoutMs = resolveToolJobTimeout(name, args.timeoutMs ?? args.timeout_ms);
  const trackedJob =
    !parsedArgsError && shouldTrackToolJob(name)
      ? defaultJobRuntime.createJob({
          id: `job_${toolCall.id}`,
          requestId,
          toolCallId: toolCall.id,
          toolName: name,
          args,
          timeoutMs: jobTimeoutMs,
        })
      : null;
  return { trackedJob, jobTimeoutMs };
}

export function emitSimpleToolResult(
  emit: EmitFn,
  requestId: string,
  toolCallId: string,
  name: string,
  args: any,
  output: string,
  payload: Record<string, any> = {}
) {
  emit(requestId, 'toolResult', {
    toolCallId,
    name,
    output,
    ...payload,
    ...buildToolContextOutput(name, args, output),
  });
}

export function emitToolParseError(
  emit: EmitFn,
  requestId: string,
  toolCall: ToolCall,
  name: string,
  args: any,
  rawArguments: string,
  parseError: string,
  repairReport: ToolRepairReport | null | undefined,
  round: number,
  maxRounds: number
) {
  const message = `工具 ${name || 'unknown_tool'} 参数 JSON 解析失败：${parseError}`;
  const nextAction = buildToolNextAction(name, args, { parseError, output: message });
  emit(requestId, 'agentStage', {
    stage: 'tool_failed',
    round,
    maxRounds,
    toolName: name,
    warning: message,
  });
  emitSimpleToolResult(emit, requestId, toolCall.id, name, args, message, {
    ok: false,
    nextAction,
    rawArguments,
    parseError,
    repairReport: repairReport || null,
  });
  return message;
}

export function emitPolicyDeniedTool(
  emit: EmitFn,
  requestId: string,
  toolCall: ToolCall,
  name: string,
  args: any,
  security: any,
  round: number,
  maxRounds: number
) {
  const denied = `执行被拒绝：${security.restrictionReason || '受策略限制。'}`;
  const nextAction = buildToolNextAction(name, args, { denied: true, output: denied });
  emit(requestId, 'agentStage', { stage: 'tool_denied', round, maxRounds, toolName: name, stopReason: denied });
  emitSimpleToolResult(emit, requestId, toolCall.id, name, args, denied, { ok: false, nextAction });
  return denied;
}

export async function handleControllerPreflight(options: {
  emit: EmitFn;
  requestId: string;
  toolCall: ToolCall;
  name: string;
  args: any;
  controller?: (ToolController & { checkPausePoint?: () => Promise<void> }) | null;
  round: number;
  maxRounds: number;
}) {
  const { emit, requestId, toolCall, name, args, controller, round, maxRounds } = options;
  if (!controller) return null;
  await controller.checkPausePoint?.();
  if (!controller.skippedToolCallIds?.has(toolCall.id)) return null;

  const skippedMsg = `工具 ${name} 已被用户手动跳过。`;
  emit(requestId, 'agentStage', { stage: 'tool_failed', round, maxRounds, toolName: name, warning: skippedMsg });
  emitSimpleToolResult(emit, requestId, toolCall.id, name, args, skippedMsg, {
    ok: true,
    nextAction: 'continue',
  });
  return skippedMsg;
}

export async function prepareEditPreviewOrEmitFailure(options: {
  emit: EmitFn;
  requestId: string;
  toolCall: ToolCall;
  name: string;
  args: any;
  settings: any;
  security: any;
  parsedArgsError?: string;
  round: number;
  maxRounds: number;
}) {
  const { emit, requestId, toolCall, name, args, settings, parsedArgsError, round, maxRounds } = options;
  let security = options.security;
  if (parsedArgsError || (name !== 'edit_file' && name !== 'multi_edit')) {
    return { security, editPreview: null, failedOutput: null };
  }

  try {
    const editPreview = await previewToolCall(name, args, settings);
    security = {
      ...security,
      editPreview,
    };
    return { security, editPreview, failedOutput: null };
  } catch (error) {
    const message = `写入工具预检失败：${normalizeError(error)}`;
    const nextAction = buildToolNextAction(name, args, { failed: true, output: message, error: message });
    emit(requestId, 'agentStage', {
      stage: 'tool_failed',
      round,
      maxRounds,
      toolName: name,
      warning: message,
    });
    emitSimpleToolResult(emit, requestId, toolCall.id, name, args, message, {
      ok: false,
      nextAction,
      security,
      editPreview: null,
    });
    return { security, editPreview: null, failedOutput: message };
  }
}

export function emitUnapprovedToolDecision(options: {
  emit: EmitFn;
  requestId: string;
  toolCall: ToolCall;
  name: string;
  args: any;
  settings: any;
  decision: any;
  controller?: ToolController | null;
  trackedJob: ToolJob | null;
  round: number;
  maxRounds: number;
}) {
  const { emit, requestId, toolCall, name, args, settings, decision, controller, trackedJob, round, maxRounds } =
    options;
  if (decision.skipped || controller?.skippedToolCallIds?.has(toolCall.id)) {
    const skippedMsg = `工具 ${name} 已被用户手动跳过。`;
    if (trackedJob) defaultJobRuntime.cancelJob(trackedJob.id, skippedMsg);
    emit(requestId, 'agentStage', { stage: 'tool_skipped', round, maxRounds, toolName: name, warning: skippedMsg });
    emitSimpleToolResult(emit, requestId, toolCall.id, name, args, skippedMsg, {
      status: 'skipped',
      ok: false,
      job: trackedJob ? serializeToolJob(defaultJobRuntime.getJob(trackedJob.id)) : null,
      nextAction: 'continue',
    });
    return skippedMsg;
  }

  if (decision.approved) return null;
  const denied = decision.timedOut
    ? `工具 ${name} 等待确认超过 ${Math.round(resolveToolApprovalTimeout(settings) / 1000)} 秒，已自动拒绝。`
    : `用户拒绝执行工具 ${name}。`;
  const nextAction = buildToolNextAction(name, args, {
    denied: true,
    timedOut: decision.timedOut,
    output: denied,
  });
  if (trackedJob) defaultJobRuntime.cancelJob(trackedJob.id, denied);
  emit(requestId, 'agentStage', {
    stage: 'tool_denied',
    round,
    maxRounds,
    toolName: name,
    stopReason: denied,
  });
  emitSimpleToolResult(emit, requestId, toolCall.id, name, args, denied, {
    ok: false,
    nextAction,
    job: trackedJob ? serializeToolJob(defaultJobRuntime.getJob(trackedJob.id)) : null,
  });
  return denied;
}

export async function executeApprovedToolCall(options: {
  emit: EmitFn;
  requestId: string;
  toolCall: ToolCall;
  name: string;
  args: any;
  settings: any;
  signal: AbortSignal;
  mcpManager: any;
  decision: any;
  editPreview: any;
  trackedJob: ToolJob | null;
  jobTimeoutMs: number;
  round: number;
  maxRounds: number;
}) {
  const { emit, requestId, toolCall, name, args, settings, signal, mcpManager, decision, editPreview, trackedJob } =
    options;
  const { jobTimeoutMs, round, maxRounds } = options;
  try {
    emit(requestId, 'agentStage', {
      stage: decision.autoApproved ? 'tool_auto_approved' : 'tool_approved',
      round,
      maxRounds,
      toolName: name,
      warning: decision.autoApproved ? decision.reason : undefined,
    });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const runTool = async (jobSignal?: AbortSignal) => {
      const effectiveSignal = jobSignal || signal;
      return isMcpToolName(name)
        ? await mcpManager.callOpenAiTool(name, args, settings, effectiveSignal)
        : await executeTool(name, args, settings, effectiveSignal);
    };
    const output = trackedJob
      ? await defaultJobRuntime.runJob(trackedJob.id, runTool, { timeoutMs: jobTimeoutMs })
      : await runTool(signal);
    const finishedJob = trackedJob ? defaultJobRuntime.getJob(trackedJob.id) : null;
    emit(requestId, 'agentStage', { stage: 'tool_result', round, maxRounds, toolName: name });
    emit(requestId, 'toolResult', {
      toolCallId: toolCall.id,
      name,
      ok: true,
      output,
      ...buildToolContextOutput(name, args, output),
      security: buildToolSecurity(name, args, settings),
      editPreview,
      job: serializeToolJob(finishedJob),
      ...extractWriteEvidence(output),
      autoApproved: decision.autoApproved === true,
    });
    return output;
  } catch (error) {
    const message = normalizeError(error);
    const returned = `工具 ${name} 执行失败：${message}`;
    const failedJob = trackedJob ? defaultJobRuntime.getJob(trackedJob.id) : null;
    const nextAction = buildToolNextAction(name, args, { failed: true, output: returned, error: message });
    emit(requestId, 'agentStage', {
      stage: 'tool_failed',
      round,
      maxRounds,
      toolName: name,
      warning: message,
      stopReason: failedJob?.status === 'timed_out' || failedJob?.status === 'cancelled' ? failedJob.status : undefined,
    });
    emit(requestId, 'toolResult', {
      toolCallId: toolCall.id,
      name,
      ok: false,
      output: message,
      nextAction,
      ...buildToolContextOutput(name, args, returned),
      security: buildToolSecurity(name, args, settings),
      editPreview,
      job: serializeToolJob(failedJob),
    });
    return returned;
  }
}

export function serializeToolJob(job?: ToolJob | null) {
  if (!job) return null;
  return {
    id: job.id,
    requestId: job.requestId,
    toolCallId: job.toolCallId,
    toolName: job.toolName,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    timeoutMs: job.timeoutMs,
    cancelGraceMs: job.cancelGraceMs,
    durationMs: job.durationMs,
    outputPreview: job.outputPreview,
    error: job.error,
    stale: job.stale,
    staleResult: job.staleResult,
    orphaned: job.orphaned,
    rollbackError: job.rollbackError,
  };
}

function extractWriteEvidence(output: unknown) {
  const text = String(output || '');
  const backup = text.match(/^备份位置：(.+)$/m)?.[1]?.trim() || '';
  const structured = extractStructuredEditEvidence(text);
  return {
    backupPath: backup || structured?.backupPath || '',
    restoreHint: structured?.restoreHint || (backup ? `可用备份文件恢复：${backup}` : ''),
    editEvidence: structured || null,
  };
}

function extractStructuredEditEvidence(text: string) {
  const marker = 'Structured Edit:';
  const start = String(text || '').indexOf(marker);
  if (start < 0) return null;
  const jsonStart = text.indexOf('{', start + marker.length);
  if (jsonStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = jsonStart; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(jsonStart, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
