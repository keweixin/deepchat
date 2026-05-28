/**
 * Agent Actor System — Derives actor/crew state from real trace events only.
 *
 * Core principle: No fake acting. Every actor status must be grounded in
 * actual events from the trace recorder.
 *
 * This module serves as the bridge between TraceRecorder (raw events) and
 * the UI layers (agent-crew.js compact cards, agent-theatre.js visual stage).
 */

import { ACTOR_STATUS, RUN_STATUS, getActorRoleForTool } from './agent-trace.js';

// ─── Actor Display Metadata ─────────────────────────────────────────────────

export const ACTOR_DISPLAY_META = Object.freeze({
  planner: {
    id: 'planner',
    label: 'Planner',
    title: '计划员',
    icon: '\u25CE',
    svgIcon: 'compass',
    color: '#f59e0b',
    description: '分析意图、拆解任务、规划执行路径',
  },
  reader: {
    id: 'reader',
    label: 'Reader',
    title: '文档员',
    icon: '\u2261',
    svgIcon: 'book-open',
    color: '#3b82f6',
    description: '读取文件、检索工作区、解析符号',
  },
  researcher: {
    id: 'researcher',
    label: 'Researcher',
    title: '搜索员',
    icon: '\u2299',
    svgIcon: 'search',
    color: '#8b5cf6',
    description: '联网搜索、查询外部数据库',
  },
  coder: {
    id: 'coder',
    label: 'Coder',
    title: '实验员',
    icon: '\u2699',
    svgIcon: 'settings',
    color: '#10b981',
    description: '运行代码、验证计算',
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    title: '审核员',
    icon: '\u2713',
    svgIcon: 'check-circle',
    color: '#06b6d4',
    description: '审查证据、压缩上下文',
  },
  writer: {
    id: 'writer',
    label: 'Writer',
    title: '写手',
    icon: '\u270E',
    svgIcon: 'edit-3',
    color: '#ec4899',
    description: '整理最终回答',
  },
});

export const ACTOR_ROLE_IDS = Object.freeze(Object.keys(ACTOR_DISPLAY_META));

// ─── Status Display Mapping ─────────────────────────────────────────────────

export const STATUS_DISPLAY = Object.freeze({
  [ACTOR_STATUS.IDLE]: { label: '空闲', cssClass: 'status-idle', animation: 'none' },
  [ACTOR_STATUS.THINKING]: { label: '思考中', cssClass: 'status-thinking', animation: 'pulse' },
  [ACTOR_STATUS.WAITING_APPROVAL]: { label: '等待审批', cssClass: 'status-waiting', animation: 'blink' },
  [ACTOR_STATUS.RUNNING_TOOL]: { label: '执行中', cssClass: 'status-running', animation: 'spin' },
  [ACTOR_STATUS.OBSERVING]: { label: '观察中', cssClass: 'status-observing', animation: 'pulse-slow' },
  [ACTOR_STATUS.BLOCKED]: { label: '已阻塞', cssClass: 'status-blocked', animation: 'shake' },
  [ACTOR_STATUS.DONE]: { label: '已完成', cssClass: 'status-done', animation: 'fade-in' },
  [ACTOR_STATUS.ERROR]: { label: '出错', cssClass: 'status-error', animation: 'shake' },
});

// ─── ActorStateBuilder ──────────────────────────────────────────────────────

/**
 * Build a complete actor state snapshot from a TraceRecorder.
 * Returns actors in display order (planner → reader → researcher → coder → reviewer → writer).
 */
export function buildActorState(recorder) {
  if (!recorder) return [];

  return ACTOR_ROLE_IDS.map((roleId) => {
    const actor = recorder.getActor(roleId);
    const meta = ACTOR_DISPLAY_META[roleId];

    if (!actor) {
      // Actor never activated — show as idle
      return {
        ...meta,
        status: ACTOR_STATUS.IDLE,
        currentAction: '等待中',
        currentTool: '',
        toolCallId: '',
        startedAt: 0,
        endedAt: 0,
        durationMs: 0,
        inputSummary: '',
        outputSummary: '',
        evidenceIds: [],
        eventCount: 0,
        isActive: false,
      };
    }

    const durationMs = actor.endedAt
      ? actor.endedAt - actor.startedAt
      : actor.startedAt
        ? Date.now() - actor.startedAt
        : 0;

    return {
      ...meta,
      status: actor.status,
      currentAction: actor.currentAction || '等待中',
      currentTool: actor.currentTool || '',
      toolCallId: actor.toolCallId || '',
      startedAt: actor.startedAt,
      endedAt: actor.endedAt,
      durationMs,
      inputSummary: actor.inputSummary || '',
      outputSummary: actor.outputSummary || '',
      evidenceIds: actor.evidenceIds || [],
      eventCount: actor.events?.length || 0,
      isActive: actor.status !== ACTOR_STATUS.IDLE && actor.status !== ACTOR_STATUS.DONE,
    };
  });
}

/**
 * Build a summary of the overall run state for the crew header.
 */
export function buildCrewHeaderState(recorder) {
  if (!recorder) {
    return { status: RUN_STATUS.DONE, label: '智能团队', detail: '', waitingCount: 0 };
  }

  const actors = buildActorState(recorder);
  const runStatus = recorder.status;
  const waitingCount = actors.filter((a) => a.status === ACTOR_STATUS.WAITING_APPROVAL).length;
  const runningCount = actors.filter(
    (a) => a.status === ACTOR_STATUS.RUNNING_TOOL || a.status === ACTOR_STATUS.THINKING
  ).length;
  const doneCount = actors.filter((a) => a.status === ACTOR_STATUS.DONE).length;
  const errorCount = actors.filter((a) => a.status === ACTOR_STATUS.ERROR).length;
  const blockedCount = actors.filter((a) => a.status === ACTOR_STATUS.BLOCKED).length;

  const statusLabels = {
    [RUN_STATUS.RUNNING]: '智能团队协作中',
    [RUN_STATUS.WAITING]: waitingCount > 0 ? `等待你确认 · ${waitingCount} 个工具` : '等待确认',
    [RUN_STATUS.DONE]: '任务协作已完成',
    [RUN_STATUS.ERROR]: '协作遇到错误',
    [RUN_STATUS.CANCELLED]: '协作已被终止',
  };

  const detailParts = [];
  if (runningCount > 0) detailParts.push(`运行 ${runningCount}`);
  if (waitingCount > 0) detailParts.push(`等待 ${waitingCount}`);
  if (doneCount > 0) detailParts.push(`完成 ${doneCount}`);
  if (errorCount > 0) detailParts.push(`错误 ${errorCount}`);
  if (blockedCount > 0) detailParts.push(`阻塞 ${blockedCount}`);

  return {
    status: runStatus,
    label: statusLabels[runStatus] || '智能团队',
    detail: detailParts.join(' · ') || '智能团队状态',
    waitingCount,
    runningCount,
    doneCount,
    errorCount,
    blockedCount,
    totalActors: actors.length,
    activeActors: runningCount + waitingCount,
    durationMs: recorder.durationMs,
  };
}

// ─── Tool Call Timeline ─────────────────────────────────────────────────────

/**
 * Build a chronological timeline of tool calls for the Inspector.
 */
export function buildToolCallTimeline(recorder) {
  if (!recorder) return [];
  const toolCalls = recorder.getAllToolCalls();
  return toolCalls
    .map((tc) => ({
      ...tc,
      roleId: getActorRoleForTool(tc.toolName),
      roleMeta: ACTOR_DISPLAY_META[getActorRoleForTool(tc.toolName)],
    }))
    .sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
}

// ─── Event Timeline ─────────────────────────────────────────────────────────

/**
 * Build a flat event timeline for the Trace Inspector.
 */
export function buildEventTimeline(recorder) {
  if (!recorder) return [];
  return recorder.events.map((evt) => {
    const base = {
      eventId: evt.eventId,
      type: evt.type,
      timestamp: evt.timestamp,
      relativeMs: evt.timestamp - (recorder.startedAt || evt.timestamp),
    };

    switch (evt.type) {
      case 'run_start':
        return { ...base, mode: evt.mode, model: evt.model, maxToolRounds: evt.maxToolRounds };
      case 'stage':
        return { ...base, stage: evt.stage, round: evt.round, toolName: evt.toolName, warning: evt.warning };
      case 'tool_request':
        return {
          ...base,
          toolCallId: evt.toolCallId,
          toolName: evt.toolName,
          risk: evt.risk,
          autoApproved: evt.autoApproved,
          inputSummary: evt.inputSummary,
          roleId: getActorRoleForTool(evt.toolName),
        };
      case 'approval':
        return { ...base, toolCallId: evt.toolCallId, approved: evt.approved, latencyMs: evt.latencyMs };
      case 'tool_result':
        return {
          ...base,
          toolCallId: evt.toolCallId,
          toolName: evt.toolName,
          ok: evt.ok,
          outputSummary: evt.outputSummary,
          error: evt.error,
          durationMs: evt.durationMs,
          roleId: getActorRoleForTool(evt.toolName),
        };
      case 'tool_repair':
        return { ...base, toolCallId: evt.toolCallId, confidence: evt.confidence, reason: evt.reason };
      case 'model_delta':
        return { ...base, chars: evt.chars, tokens: evt.tokens, isThinking: evt.isThinking };
      case 'context_compaction':
        return { ...base, messageCount: evt.messageCount, tokenCount: evt.tokenCount, trigger: evt.trigger };
      case 'run_end':
        return { ...base, status: evt.status, durationMs: evt.durationMs, errorMessage: evt.errorMessage };
      case 'error':
        return { ...base, source: evt.source, message: evt.message };
      default:
        return base;
    }
  });
}

// ─── Context Snapshot Display ───────────────────────────────────────────────

/**
 * Build display-friendly context snapshots.
 */
export function buildContextSnapshots(recorder) {
  if (!recorder) return [];
  const summary = recorder.toRunSummary();
  return (summary.contextSnapshots || []).map((snap) => ({
    ...snap,
    atFormatted: new Date(snap.at).toLocaleTimeString(),
    description: describeCompactionTrigger(snap.trigger),
  }));
}

function describeCompactionTrigger(trigger) {
  const map = {
    budget_exceeded: 'Token 预算超出',
    message_limit: '消息数限制',
    manual: '手动压缩',
    auto: '自动压缩',
  };
  return map[trigger] || trigger || '上下文压缩';
}

// ─── Crew Data for Backward Compatibility ───────────────────────────────────

/**
 * Convert actor state to the old crew format expected by agent-crew.js.
 * This allows gradual migration without breaking the existing UI.
 */
export function toLegacyCrewFormat(actors) {
  return actors.map((actor) => ({
    id: actor.id,
    label: actor.label,
    icon: actor.icon,
    title: actor.title,
    status: legacyStatusFromActor(actor.status),
    currentAction: actor.currentAction,
    outputSummary: actor.outputSummary,
    linkedToolCallIds: actor.toolCallId ? [actor.toolCallId] : [],
    linkedStepIds: [],
  }));
}

function legacyStatusFromActor(status) {
  const map = {
    [ACTOR_STATUS.IDLE]: 'idle',
    [ACTOR_STATUS.THINKING]: 'running',
    [ACTOR_STATUS.WAITING_APPROVAL]: 'waiting',
    [ACTOR_STATUS.RUNNING_TOOL]: 'running',
    [ACTOR_STATUS.OBSERVING]: 'running',
    [ACTOR_STATUS.BLOCKED]: 'skipped',
    [ACTOR_STATUS.DONE]: 'done',
    [ACTOR_STATUS.ERROR]: 'error',
  };
  return map[status] || 'idle';
}

// ─── Decision: whether to show crew at all ──────────────────────────────────

/**
 * Determine if crew/theatre should be visible for a given run.
 */
export function shouldShowCrew(recorder, displayMode = 'auto') {
  if (!recorder || displayMode === 'off') return false;
  if (displayMode === 'always') return true;
  if (displayMode === 'tools_only') {
    const toolCalls = recorder.getAllToolCalls();
    return toolCalls.length > 0;
  }
  // 'auto' mode
  const hasTools = recorder.getAllToolCalls().length > 0;
  const hasStages = recorder.events.some((e) => e.type === 'stage');
  const isLong = recorder.durationMs > 3000;
  return hasTools || hasStages || isLong;
}

// ─── Run Summary for Export ─────────────────────────────────────────────────

/**
 * Build a human-readable run summary for display/export.
 */
export function buildHumanReadableSummary(recorder) {
  if (!recorder) return '';
  const actors = buildActorState(recorder);
  const tools = recorder.getAllToolCalls();
  const summary = recorder.toRunSummary();

  const lines = [
    `Run: ${recorder.runId}`,
    `Mode: ${recorder.mode}`,
    `Model: ${recorder.model || 'unknown'}`,
    `Status: ${recorder.status}`,
    `Duration: ${formatDuration(recorder.durationMs)}`,
    `Events: ${summary.eventCount}`,
    `Tool calls: ${tools.length}`,
    '',
    'Actors:',
  ];

  for (const actor of actors) {
    const duration = actor.durationMs > 0 ? ` (${formatDuration(actor.durationMs)})` : '';
    lines.push(`  ${actor.label}: ${actor.currentAction}${duration}`);
  }

  if (tools.length > 0) {
    lines.push('', 'Tools:');
    for (const tc of tools) {
      const status = tc.status;
      const dur = tc.durationMs > 0 ? ` [${tc.durationMs}ms]` : '';
      lines.push(`  ${tc.toolName}: ${status}${dur}`);
    }
  }

  return lines.join('\n');
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = ((ms % 60000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}
