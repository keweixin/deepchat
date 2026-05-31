import {
  resolveToolApprovalDecision,
  resolveToolApprovalTimeout,
  DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
  isParallelSafeToolCall,
  markToolConfirmed,
} from './approval-manager.js';
import { normalizeError } from './provider-adapters.js';
import { toolCallSignature } from './stream-runner.js';
import { parseToolArgsDetailed } from './tool-executor.js';
import type { ToolRepairReport } from './agent-contracts.js';
import {
  buildScopedToolSecurity,
  createTrackedToolJob,
  emitPolicyDeniedTool,
  emitToolParseError,
  emitUnapprovedToolDecision,
  executeApprovedToolCall,
  handleControllerPreflight,
  prepareEditPreviewOrEmitFailure,
  serializeToolJob,
} from './tool-call-lifecycle.js';

type ToolFunctionCall = {
  name?: string;
  arguments?: string;
};

type ToolCall = {
  id: string;
  function?: ToolFunctionCall;
};

type ToolResult = {
  toolCall: ToolCall;
  output: unknown;
};

type ToolRequestPayload = Record<string, any> & {
  repairReport?: ToolRepairReport | null;
};

type ToolController = {
  checkPausePoint?: () => Promise<void>;
  skippedToolCallIds?: Set<string>;
  scopePolicy?: string;
};

type ToolHandlerDeps = {
  emit: (requestId: string, type: string, payload?: Record<string, any>) => void;
  waitForApproval: (requestId: string, toolCallId: string, signal: AbortSignal, timeoutMs: number) => Promise<any>;
  describeRisk: (name: string, args: any, settings: any) => string;
  mcpManager: any;
  controller?: ToolController | null;
};

type ToolRoundDeps = {
  emit: ToolHandlerDeps['emit'];
  handleToolCall: (
    requestId: string,
    toolCall: ToolCall,
    settings: any,
    signal: AbortSignal,
    round?: number,
    maxRounds?: number
  ) => Promise<unknown>;
};

async function handleToolCall(
  requestId: string,
  toolCall: ToolCall,
  settings: any,
  signal: AbortSignal,
  round = 0,
  maxRounds = 0,
  deps: ToolHandlerDeps
) {
  const { emit, waitForApproval, describeRisk, mcpManager, controller } = deps;
  const fn: Required<ToolFunctionCall> = {
    name: toolCall.function?.name || 'unknown_tool',
    arguments: toolCall.function?.arguments || '',
  };
  const parsedArgs = parseToolArgsDetailed(fn.arguments);
  const args = parsedArgs.args;

  const preflightResult = await handleControllerPreflight({
    emit,
    requestId,
    toolCall,
    name: fn.name,
    args,
    controller,
    round,
    maxRounds,
  });
  if (preflightResult) return preflightResult;

  emit(requestId, 'agentStage', { stage: 'tool_pending', round, maxRounds, toolName: fn.name });
  if (parsedArgs.repaired) {
    emit(requestId, 'agentStage', {
      stage: 'tool_repair',
      round,
      maxRounds,
      toolName: fn.name,
      warning: parsedArgs.warning,
      repairReport: parsedArgs.repairReport,
    });
  }

  let security = buildScopedToolSecurity(fn.name, args, settings, controller);

  if (security.sandboxBlocked) {
    return emitPolicyDeniedTool(emit, requestId, toolCall, fn.name, args, security, round, maxRounds);
  }

  const { trackedJob, jobTimeoutMs } = createTrackedToolJob(fn.name, args, requestId, toolCall, parsedArgs.error);
  const preview = await prepareEditPreviewOrEmitFailure({
    emit,
    requestId,
    toolCall,
    name: fn.name,
    args,
    settings,
    security,
    parsedArgsError: parsedArgs.error,
    round,
    maxRounds,
  });
  security = preview.security;
  const editPreview = preview.editPreview;
  if (preview.failedOutput) return preview.failedOutput;

  const approval = resolveToolApprovalDecision(fn.name, args, settings, security, requestId);
  const toolRequestPayload: ToolRequestPayload = {
    toolCallId: toolCall.id,
    name: fn.name,
    args,
    rawArguments: fn.arguments || '',
    parseError: parsedArgs.error,
    parseRepair: parsedArgs.repaired ? parsedArgs.warning : '',
    repairReport: parsedArgs.repairReport || null,
    risk: describeRisk(fn.name, args, settings),
    security,
    editPreview,
    job: trackedJob ? serializeToolJob(trackedJob) : null,
    approvalPolicy: approval.policy,
    autoApproved: approval.autoApproved,
    expiresAt: new Date(Date.now() + resolveToolApprovalTimeout(settings)).toISOString(),
  };
  emit(requestId, 'toolRequest', toolRequestPayload);
  if (parsedArgs.error) {
    return emitToolParseError(
      emit,
      requestId,
      toolCall,
      fn.name,
      args,
      fn.arguments || '',
      parsedArgs.error,
      parsedArgs.repairReport,
      round,
      maxRounds
    );
  }

  const decision = approval.autoApproved
    ? { approved: true, autoApproved: true, reason: approval.reason }
    : await waitForApproval(requestId, toolCall.id, signal, resolveToolApprovalTimeout(settings));

  // Mark tool as confirmed for confirm_once policy
  if (decision.approved && !decision.autoApproved) {
    markToolConfirmed(requestId, fn.name);
  }

  const unapprovedResult = emitUnapprovedToolDecision({
    emit,
    requestId,
    toolCall,
    name: fn.name,
    args,
    settings,
    decision,
    controller,
    trackedJob,
    round,
    maxRounds,
  });
  if (unapprovedResult) return unapprovedResult;

  return executeApprovedToolCall({
    emit,
    requestId,
    toolCall,
    name: fn.name,
    args,
    settings,
    signal,
    mcpManager,
    decision,
    editPreview,
    trackedJob,
    jobTimeoutMs,
    round,
    maxRounds,
  });
}

async function handleToolCallsForRound(
  requestId: string,
  toolCalls: ToolCall[],
  settings: any,
  signal: AbortSignal,
  round = 0,
  maxRounds = 0,
  seenToolCalls: Set<string> = new Set(),
  warnings: string[] = [],
  deps: ToolRoundDeps
) {
  const { emit, handleToolCall } = deps;
  const results: Array<ToolResult | undefined> = new Array(toolCalls.length);
  let parallelGroup: Array<{ index: number; toolCall: ToolCall }> = [];

  const flushParallelGroup = async () => {
    if (parallelGroup.length === 0) return;
    const group = parallelGroup;
    parallelGroup = [];
    emit(requestId, 'agentStage', {
      stage: 'tool_parallel',
      round,
      maxRounds,
      selectedTools: group.map((item) => item.toolCall.function?.name || 'unknown_tool'),
    });
    const settled = await Promise.allSettled(
      group.map((item) => handleToolCall(requestId, item.toolCall, settings, signal, round, maxRounds))
    );
    settled.forEach((result, offset) => {
      const { index, toolCall } = group[offset];
      results[index] = {
        toolCall,
        output:
          result.status === 'fulfilled'
            ? result.value
            : `工具 ${toolCall.function?.name || 'unknown_tool'} 执行失败：${normalizeError(result.reason)}`,
      };
    });
  };

  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index];
    const signature = toolCallSignature(toolCall);
    if (seenToolCalls.has(signature)) {
      await flushParallelGroup();
      const blocked = `重复工具调用已抑制：${toolCall.function?.name || 'unknown_tool'}。请基于已有工具结果继续推理，或换用不同参数。`;
      warnings.push(blocked);
      emit(requestId, 'agentStage', {
        stage: 'tool_failed',
        round,
        maxRounds,
        toolName: toolCall.function?.name,
        warning: blocked,
      });
      emit(requestId, 'toolResult', {
        toolCallId: toolCall.id,
        name: toolCall.function?.name,
        ok: false,
        output: blocked,
        repairReport: {
          scavenge: false,
          truncation: false,
          storm: true,
          result: 'blocked',
          warnings: [blocked],
        },
      });
      results[index] = { toolCall, output: blocked };
      continue;
    }
    seenToolCalls.add(signature);
    emit(requestId, 'agentStage', { stage: 'tool', round, maxRounds, toolName: toolCall.function?.name });
    if (isParallelSafeToolCall(toolCall)) {
      parallelGroup.push({ index, toolCall });
      continue;
    }
    await flushParallelGroup();
    const output = await handleToolCall(requestId, toolCall, settings, signal, round, maxRounds);
    results[index] = { toolCall, output };
  }

  await flushParallelGroup();
  return results.filter((result): result is ToolResult => Boolean(result));
}

export { handleToolCall, handleToolCallsForRound };
