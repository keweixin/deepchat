// @ts-nocheck
import { isMcpToolName } from './mcp-manager.js';
import path from 'path';
import { executeTool } from './tools.js';
import {
  resolveToolApprovalDecision,
  resolveToolApprovalTimeout,
  DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
  buildToolSecurity,
  isParallelSafeToolCall,
} from './approval-manager.js';
import { normalizeError } from './provider-adapters.js';
import { toolCallSignature } from './stream-runner.js';
import { parseToolArgsDetailed } from './tool-executor.js';
import { buildToolNextAction, buildToolContextOutput } from './chat-service-helpers.js';

async function handleToolCall(requestId, toolCall, settings, signal, round = 0, maxRounds = 0, deps) {
  const { emit, waitForApproval, describeRisk, mcpManager, controller } = deps;
  const fn = toolCall.function || {};
  const parsedArgs = parseToolArgsDetailed(fn.arguments);
  const args = parsedArgs.args;

  if (controller) {
    await controller.checkPausePoint();
    if (controller.skippedToolCallIds.has(toolCall.id)) {
      const skippedMsg = `工具 ${fn.name} 已被用户手动跳过。`;
      emit(requestId, 'agentStage', { stage: 'tool_failed', round, maxRounds, toolName: fn.name, warning: skippedMsg });
      emit(requestId, 'toolResult', {
        toolCallId: toolCall.id,
        name: fn.name,
        ok: true,
        output: skippedMsg,
        nextAction: 'continue',
        ...buildToolContextOutput(fn.name, args, skippedMsg),
      });
      return skippedMsg;
    }
  }

  emit(requestId, 'agentStage', { stage: 'tool_pending', round, maxRounds, toolName: fn.name });
  if (parsedArgs.repaired) {
    emit(requestId, 'agentStage', {
      stage: 'tool_repair',
      round,
      maxRounds,
      toolName: fn.name,
      warning: parsedArgs.warning,
    });
  }

  let security = buildToolSecurity(fn.name, args, settings);
  if (controller && controller.scopePolicy) {
    if (controller.scopePolicy === 'read_only') {
      const isWrite = ['run_code', 'write_file', 'edit_file'].includes(fn.name);
      if (isWrite) {
        security = {
          ...security,
          riskLevel: 'high',
          sandboxBlocked: true,
          restrictionReason: '用户限制读取范围为只读模式。',
        };
      }
    } else if (controller.scopePolicy.startsWith('dir:')) {
      const allowedDir = controller.scopePolicy.slice(4);
      const pathArg = args.path || args.filepath || args.dir || args.directory || '';
      if (pathArg && typeof pathArg === 'string') {
        const relative = path.relative(allowedDir, pathArg);
        const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
        if (isOutside) {
          security = {
            ...security,
            riskLevel: 'high',
            sandboxBlocked: true,
            restrictionReason: `路径超出用户限制范围：${allowedDir}`,
          };
        }
      }
    }
  }

  if (security.sandboxBlocked) {
    const denied = `执行被拒绝：${security.restrictionReason || '受策略限制。'}`;
    const nextAction = buildToolNextAction(fn.name, args, { denied: true, output: denied });
    emit(requestId, 'agentStage', { stage: 'tool_denied', round, maxRounds, toolName: fn.name, stopReason: denied });
    emit(requestId, 'toolResult', {
      toolCallId: toolCall.id,
      name: fn.name,
      ok: false,
      output: denied,
      nextAction,
      ...buildToolContextOutput(fn.name, args, denied),
    });
    return denied;
  }

  const approval = resolveToolApprovalDecision(fn.name, args, settings, security);
  emit(requestId, 'toolRequest', {
    toolCallId: toolCall.id,
    name: fn.name,
    args,
    rawArguments: fn.arguments || '',
    parseError: parsedArgs.error,
    parseRepair: parsedArgs.repaired ? parsedArgs.warning : '',
    risk: describeRisk(fn.name, args, settings),
    security,
    approvalPolicy: approval.policy,
    autoApproved: approval.autoApproved,
    expiresAt: new Date(Date.now() + resolveToolApprovalTimeout(settings)).toISOString(),
  });
  if (parsedArgs.error) {
    const message = `工具 ${fn.name || 'unknown_tool'} 参数 JSON 解析失败：${parsedArgs.error}`;
    const nextAction = buildToolNextAction(fn.name, args, { parseError: parsedArgs.error, output: message });
    emit(requestId, 'agentStage', {
      stage: 'tool_failed',
      round,
      maxRounds,
      toolName: fn.name,
      warning: message,
    });
    const contextMeta = buildToolContextOutput(fn.name, args, message);
    emit(requestId, 'toolResult', {
      toolCallId: toolCall.id,
      name: fn.name,
      ok: false,
      output: message,
      nextAction,
      ...contextMeta,
      rawArguments: fn.arguments || '',
      parseError: parsedArgs.error,
    });
    return message;
  }

  const decision = approval.autoApproved
    ? { approved: true, autoApproved: true, reason: approval.reason }
    : await waitForApproval(requestId, toolCall.id, signal, resolveToolApprovalTimeout(settings));

  if (decision.skipped || (controller && controller.skippedToolCallIds.has(toolCall.id))) {
    const skippedMsg = `工具 ${fn.name} 已被用户手动跳过。`;
    emit(requestId, 'agentStage', { stage: 'tool_failed', round, maxRounds, toolName: fn.name, warning: skippedMsg });
    emit(requestId, 'toolResult', {
      toolCallId: toolCall.id,
      name: fn.name,
      ok: true,
      output: skippedMsg,
      nextAction: 'continue',
      ...buildToolContextOutput(fn.name, args, skippedMsg),
    });
    return skippedMsg;
  }

  if (!decision.approved) {
    const denied = decision.timedOut
      ? `工具 ${fn.name} 等待确认超过 ${Math.round(resolveToolApprovalTimeout(settings) / 1000)} 秒，已自动拒绝。`
      : `用户拒绝执行工具 ${fn.name}。`;
    const nextAction = buildToolNextAction(fn.name, args, {
      denied: true,
      timedOut: decision.timedOut,
      output: denied,
    });
    emit(requestId, 'agentStage', {
      stage: 'tool_denied',
      round,
      maxRounds,
      toolName: fn.name,
      stopReason: denied,
    });
    emit(requestId, 'toolResult', {
      toolCallId: toolCall.id,
      name: fn.name,
      ok: false,
      output: denied,
      nextAction,
      ...buildToolContextOutput(fn.name, args, denied),
    });
    return denied;
  }

  try {
    emit(requestId, 'agentStage', {
      stage: decision.autoApproved ? 'tool_auto_approved' : 'tool_approved',
      round,
      maxRounds,
      toolName: fn.name,
      warning: decision.autoApproved ? decision.reason : undefined,
    });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const output = isMcpToolName(fn.name)
      ? await mcpManager.callOpenAiTool(fn.name, args, settings, signal)
      : await executeTool(fn.name, args, settings, signal);
    emit(requestId, 'agentStage', { stage: 'tool_result', round, maxRounds, toolName: fn.name });
    emit(requestId, 'toolResult', {
      toolCallId: toolCall.id,
      name: fn.name,
      ok: true,
      output,
      ...buildToolContextOutput(fn.name, args, output),
      security: buildToolSecurity(fn.name, args, settings),
      autoApproved: decision.autoApproved === true,
    });
    return output;
  } catch (error) {
    const message = normalizeError(error);
    const returned = `工具 ${fn.name} 执行失败：${message}`;
    const nextAction = buildToolNextAction(fn.name, args, { failed: true, output: returned, error: message });
    emit(requestId, 'agentStage', {
      stage: 'tool_failed',
      round,
      maxRounds,
      toolName: fn.name,
      warning: message,
    });
    emit(requestId, 'toolResult', {
      toolCallId: toolCall.id,
      name: fn.name,
      ok: false,
      output: message,
      nextAction,
      ...buildToolContextOutput(fn.name, args, returned),
      security: buildToolSecurity(fn.name, args, settings),
    });
    return returned;
  }
}

async function handleToolCallsForRound(
  requestId,
  toolCalls,
  settings,
  signal,
  round = 0,
  maxRounds = 0,
  seenToolCalls = new Set(),
  warnings = [],
  deps
) {
  const { emit, handleToolCall } = deps;
  const results = new Array(toolCalls.length);
  let parallelGroup = [];

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
  return results.filter(Boolean);
}

export { handleToolCall, handleToolCallsForRound };
