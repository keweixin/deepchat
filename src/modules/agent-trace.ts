/**
 * Agent Trace Recorder — Records the complete lifecycle of an Agent run
 *
 * Design principles:
 * - Every event is immutable and timestamped
 * - Events form a complete audit trail
 * - Status can be reconstructed from events alone
 * - No "fake" events — only record what actually happened
 */

import { uid } from './shared-utils.js';
import { getToolRole } from './tool-registry.js';

// ─── Event Type Definitions ────────────────────────────────────────────────

/**
 * @typedef {Object} TraceEvent
 * @property {string} type — Event type
 * @property {string} runId — Parent run ID
 * @property {number} timestamp — Unix timestamp (ms)
 * @property {string} [eventId] — Unique event ID
 */

/** @typedef {'run_start'|'stage'|'tool_request'|'approval'|'tool_result'|'tool_repair'|'model_delta'|'context_compaction'|'run_end'|'error'} TraceEventType */

export const TRACE_EVENT_TYPES = Object.freeze([
  'run_start',
  'stage',
  'tool_request',
  'approval',
  'tool_result',
  'tool_repair',
  'model_delta',
  'context_compaction',
  'run_end',
  'error',
]);

// ─── AgentRun State Machine ─────────────────────────────────────────────────

export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  WAITING: 'waiting',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
});

export const ACTOR_STATUS = Object.freeze({
  IDLE: 'idle',
  THINKING: 'thinking',
  WAITING_APPROVAL: 'waiting_approval',
  RUNNING_TOOL: 'running_tool',
  OBSERVING: 'observing',
  BLOCKED: 'blocked',
  DONE: 'done',
  ERROR: 'error',
});

// ─── Utility ────────────────────────────────────────────────────────────────

let _eventIdCounter = 0;
function generateEventId() {
  return `evt_${Date.now().toString(36)}_${(++_eventIdCounter).toString(36)}`;
}

// ─── TraceRecorder ──────────────────────────────────────────────────────────

export class TraceRecorder {
  runId: string;
  mode: string;
  model: string;
  events: Record<string, any>[];
  startedAt: number;
  endedAt: number;
  _options: Record<string, any>;
  _onEvent: ((event: Record<string, any>) => void) | null;
  _actors: Map<string, any>;
  _toolCalls: Map<string, any>;
  _tokenUsage: Record<string, number>;
  _contextSnapshots: Record<string, any>[];
  _status: string;
  _locked: boolean;

  constructor(options: Record<string, any> = {}) {
    this.runId = options.runId || uid();
    this.mode = options.mode || 'agent_auto';
    this.model = options.model || '';
    this.events = [];
    this.startedAt = 0;
    this.endedAt = 0;
    this._options = options;
    this._onEvent = options.onEvent || null;
    this._actors = new Map(); // roleId -> AgentActor
    this._toolCalls = new Map(); // toolCallId -> ToolCallRecord
    this._tokenUsage = { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };
    this._contextSnapshots = [];
    this._status = RUN_STATUS.RUNNING;
    this._locked = false;
  }

  // ─── Core recording API ─────────────────────────────────────────────────

  /**
   * Record the start of an Agent run
   */
  recordRunStart(payload: Record<string, any> = {}) {
    if (this._locked) return null;
    this.startedAt = Date.now();
    const event = this._push({
      type: 'run_start',
      timestamp: this.startedAt,
      mode: this.mode,
      model: this.model,
      maxToolRounds: payload.maxToolRounds,
      agentExecutionMode: payload.agentExecutionMode,
      intent: payload.intent,
      warnings: payload.warnings || [],
    });
    return event;
  }

  /**
   * Record a stage transition (plan, tool_pending, tool_repair, summary, final, etc.)
   */
  recordStage(payload: Record<string, any> = {}) {
    const { stage, round, maxRounds, toolName, warning } = payload;
    const event = this._push({
      type: 'stage',
      timestamp: Date.now(),
      stage,
      round,
      maxRounds,
      toolName,
      warning,
    });
    this._updateActorFromStage(event);
    return event;
  }

  /**
   * Record a tool call request (before approval)
   */
  recordToolRequest(payload: Record<string, any> = {}) {
    const { toolCallId, toolName, args, argsHash, risk, approvalPolicy, autoApproved, inputSummary } = payload;

    const event = this._push({
      type: 'tool_request',
      timestamp: Date.now(),
      toolCallId,
      toolName,
      args,
      argsHash,
      risk,
      approvalPolicy,
      autoApproved,
      inputSummary,
    });

    this._toolCalls.set(toolCallId, {
      toolCallId,
      toolName,
      status: autoApproved ? 'auto_approved' : 'pending',
      requestedAt: event.timestamp,
      approvedAt: autoApproved ? event.timestamp : null,
      completedAt: null,
      args,
      output: null,
      error: null,
      durationMs: 0,
    });

    this._updateActorFromToolRequest(event);
    return event;
  }

  /**
   * Record an approval decision
   */
  recordApproval(payload: Record<string, any> = {}) {
    const { toolCallId, approved, decision, reason, latencyMs } = payload;
    const event = this._push({
      type: 'approval',
      timestamp: Date.now(),
      toolCallId,
      approved,
      decision,
      reason,
      latencyMs,
    });

    const tc = this._toolCalls.get(toolCallId);
    if (tc) {
      tc.status = approved ? 'approved' : 'denied';
      tc.approvedAt = event.timestamp;
    }

    this._updateActorFromApproval(event);
    return event;
  }

  /**
   * Record a tool execution result
   */
  recordToolResult(payload: Record<string, any> = {}) {
    const { toolCallId, toolName, ok, output, outputSummary, error, durationMs, outputBytes, sources, evidenceIds } =
      payload;

    const event = this._push({
      type: 'tool_result',
      timestamp: Date.now(),
      toolCallId,
      toolName,
      ok,
      output,
      outputSummary,
      error,
      durationMs,
      outputBytes,
      sources,
      evidenceIds,
    });

    const tc = this._toolCalls.get(toolCallId);
    if (tc) {
      tc.status = ok ? 'completed' : 'failed';
      tc.completedAt = event.timestamp;
      tc.durationMs = durationMs || 0;
      tc.output = output;
      tc.outputSummary = outputSummary || '';
      tc.error = error;
    }

    this._updateActorFromToolResult(event);
    return event;
  }

  /**
   * Record a tool repair event (when system recovers tool call from text)
   */
  recordToolRepair(payload: Record<string, any> = {}) {
    const { toolCallId, toolName, originalText, confidence, reason } = payload;
    return this._push({
      type: 'tool_repair',
      timestamp: Date.now(),
      toolCallId,
      toolName,
      originalText,
      confidence: confidence || 'medium',
      reason: reason || '模型未返回原生 tool_calls，从文本中修复',
    });
  }

  /**
   * Record a model output delta (for streaming telemetry)
   */
  recordModelDelta(payload: Record<string, any> = {}) {
    const { chars, tokens, isThinking } = payload;
    return this._push({
      type: 'model_delta',
      timestamp: Date.now(),
      chars,
      tokens,
      isThinking,
    });
  }

  /**
   * Record context compaction / summary event
   */
  recordContextCompaction(payload: Record<string, any> = {}) {
    const { messageCount, tokenCount, summaryTokens, trigger } = payload;
    const event = this._push({
      type: 'context_compaction',
      timestamp: Date.now(),
      messageCount,
      tokenCount,
      summaryTokens,
      trigger,
    });
    this._contextSnapshots.push({
      at: event.timestamp,
      messageCount,
      tokenCount,
      summaryTokens,
      trigger,
    });
    return event;
  }

  /**
   * Record the end of a run
   */
  recordRunEnd(payload: Record<string, any> = {}) {
    if (this._locked) return null;
    this._locked = true;
    this.endedAt = Date.now();
    const { status, errorMessage, finalContentLength } = payload;
    this._status = status || RUN_STATUS.DONE;

    const event = this._push({
      type: 'run_end',
      timestamp: this.endedAt,
      status: this._status,
      durationMs: this.endedAt - this.startedAt,
      errorMessage,
      finalContentLength,
      totalEvents: this.events.length,
    });

    // Mark all unfinished actors
    for (const actor of this._actors.values()) {
      if (actor.status !== ACTOR_STATUS.DONE && actor.status !== ACTOR_STATUS.ERROR) {
        if (this._status === RUN_STATUS.ERROR) {
          actor.status = ACTOR_STATUS.ERROR;
          actor.currentAction = '运行异常中断';
        } else if (this._status === RUN_STATUS.CANCELLED) {
          actor.status = ACTOR_STATUS.BLOCKED;
          actor.currentAction = '用户取消';
        } else {
          actor.status = ACTOR_STATUS.DONE;
          actor.currentAction = '完成';
        }
        if (!actor.endedAt) actor.endedAt = this.endedAt;
      }
    }

    return event;
  }

  /**
   * Record an error
   */
  recordError(payload: Record<string, any> = {}) {
    const { source, message, stack } = payload;
    this._status = RUN_STATUS.ERROR;
    return this._push({
      type: 'error',
      timestamp: Date.now(),
      source,
      message,
      stack,
    });
  }

  // ─── Actor Management ───────────────────────────────────────────────────

  getOrCreateActor(roleId: string, defaults: Record<string, any> = {}) {
    if (this._actors.has(roleId)) return this._actors.get(roleId);
    const actor = {
      id: roleId,
      status: ACTOR_STATUS.IDLE,
      currentAction: '',
      currentTool: '',
      toolCallId: '',
      startedAt: 0,
      endedAt: 0,
      inputSummary: '',
      outputSummary: '',
      evidenceIds: [],
      events: [],
      ...defaults,
    };
    this._actors.set(roleId, actor);
    return actor;
  }

  getActor(roleId: string) {
    return this._actors.get(roleId) || null;
  }

  getAllActors() {
    return Array.from(this._actors.values());
  }

  // ─── Tool Call Access ───────────────────────────────────────────────────

  getToolCall(toolCallId: string) {
    return this._toolCalls.get(toolCallId) || null;
  }

  getAllToolCalls() {
    return Array.from(this._toolCalls.values());
  }

  // ─── Derived State ──────────────────────────────────────────────────────

  get status() {
    return this._status;
  }

  get durationMs() {
    if (!this.startedAt) return 0;
    return (this.endedAt || Date.now()) - this.startedAt;
  }

  get isRunning() {
    return this._status === RUN_STATUS.RUNNING;
  }

  get isWaiting() {
    return this._status === RUN_STATUS.WAITING;
  }

  get tokenUsage() {
    return { ...this._tokenUsage };
  }

  setTokenUsage(usage: Record<string, number>) {
    if (usage) {
      this._tokenUsage.input += usage.input || 0;
      this._tokenUsage.output += usage.output || 0;
      this._tokenUsage.cacheHit += usage.cacheHit || 0;
      this._tokenUsage.cacheMiss += usage.cacheMiss || 0;
    }
  }

  /**
   * Build a serializable run summary from recorded events.
   */
  toRunSummary() {
    return {
      runId: this.runId,
      mode: this.mode,
      model: this.model,
      status: this._status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.durationMs,
      eventCount: this.events.length,
      tokenUsage: this.tokenUsage,
      actors: this.getAllActors(),
      toolCalls: this.getAllToolCalls(),
      contextSnapshots: this._contextSnapshots,
    };
  }

  /**
   * Serialize to JSONL format (one JSON object per line).
   */
  toJSONL() {
    return this.events.map((e) => JSON.stringify(e)).join('\n');
  }

  /**
   * Serialize to a single JSON object (not JSONL).
   */
  toJSON() {
    return JSON.stringify({
      run: this.toRunSummary(),
      events: this.events,
    });
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  _push(baseEvent: Record<string, any>): Record<string, any> {
    const event = Object.freeze({
      eventId: generateEventId(),
      ...baseEvent,
    });
    this.events.push(event as Record<string, any>);
    if (this._onEvent) {
      try {
        this._onEvent(event as Record<string, any>);
      } catch {
        // onEvent callback errors should not break recording
      }
    }
    return event as Record<string, any>;
  }

  _updateActorFromStage(event: Record<string, any>) {
    const { stage } = event;
    if (stage === 'plan') {
      const actor = this.getOrCreateActor('planner');
      actor.status = ACTOR_STATUS.THINKING;
      actor.currentAction = '正在分析规划任务';
      if (!actor.startedAt) actor.startedAt = event.timestamp;
    } else if (stage === 'summary') {
      const actor = this.getOrCreateActor('reviewer');
      actor.status = ACTOR_STATUS.THINKING;
      actor.currentAction = '正在整理/压缩长上下文';
      if (!actor.startedAt) actor.startedAt = event.timestamp;
    } else if (stage === 'final') {
      const actor = this.getOrCreateActor('writer');
      actor.status = ACTOR_STATUS.THINKING;
      actor.currentAction = '正在整理最终回答';
      if (!actor.startedAt) actor.startedAt = event.timestamp;
    } else if (stage === 'tool_result') {
      // Tool result stage is handled by recordToolResult
    }
  }

  _updateActorFromToolRequest(event: Record<string, any>) {
    const roleId = getActorRoleForTool(event.toolName);
    const actor = this.getOrCreateActor(roleId);
    actor.currentTool = event.toolName;
    actor.toolCallId = event.toolCallId;
    actor.inputSummary = event.inputSummary || '';
    if (!actor.startedAt) actor.startedAt = event.timestamp;

    if (event.autoApproved) {
      actor.status = ACTOR_STATUS.RUNNING_TOOL;
      actor.currentAction = `自动执行：${event.toolName}`;
    } else {
      actor.status = ACTOR_STATUS.WAITING_APPROVAL;
      actor.currentAction = `等待审批：${event.toolName}`;
      this._status = RUN_STATUS.WAITING;
    }
  }

  _updateActorFromApproval(event: Record<string, any>) {
    const tc = this._toolCalls.get(event.toolCallId);
    if (!tc) return;
    const roleId = getActorRoleForTool(tc.toolName);
    const actor = this.getOrCreateActor(roleId);

    if (event.approved) {
      actor.status = ACTOR_STATUS.RUNNING_TOOL;
      actor.currentAction = `正在执行：${tc.toolName}`;
      // Check if any tools still pending
      const hasPending = Array.from(this._toolCalls.values()).some((t) => t.status === 'pending');
      if (!hasPending) this._status = RUN_STATUS.RUNNING;
    } else {
      actor.status = ACTOR_STATUS.BLOCKED;
      actor.currentAction = `已拒绝：${tc.toolName}`;
      actor.endedAt = event.timestamp;
    }
  }

  _updateActorFromToolResult(event: Record<string, any>) {
    const roleId = getActorRoleForTool(event.toolName);
    const actor = this.getOrCreateActor(roleId);

    if (event.ok) {
      actor.status = ACTOR_STATUS.DONE;
      actor.currentAction = `${event.toolName} 执行完毕`;
      actor.outputSummary = event.outputSummary || '执行成功';
      if (event.evidenceIds) actor.evidenceIds.push(...event.evidenceIds);
    } else {
      actor.status = ACTOR_STATUS.ERROR;
      actor.currentAction = `${event.toolName} 执行失败`;
      actor.outputSummary = event.error || '执行出错';
    }
    actor.endedAt = event.timestamp;
  }
}

// ─── Tool-to-Actor Mapping ──────────────────────────────────────────────────

export function getActorRoleForTool(toolName = '') {
  return getToolRole(toolName);
}

// ─── Compatibility Layer ────────────────────────────────────────────────────

/**
 * Convert the old agentRun object (from agent-run-store.js) into a TraceRecorder.
 * Used for backward compatibility when loading historical conversations.
 */
export function migrateLegacyAgentRun(legacyRun: Record<string, any>) {
  if (!legacyRun) return null;
  const recorder = new TraceRecorder({
    runId: legacyRun.id || uid(),
    mode: legacyRun.mode || 'auto',
  });

  // Record run start
  recorder.recordRunStart({
    mode: legacyRun.mode,
    maxToolRounds: legacyRun.maxToolRounds,
  });

  // Migrate crew members as actors
  if (legacyRun.crew && legacyRun.crew.length > 0) {
    for (const member of legacyRun.crew) {
      const actor = recorder.getOrCreateActor(member.id, {
        status: member.status || ACTOR_STATUS.IDLE,
        currentAction: member.currentAction || '',
        currentTool: member.currentTool || '',
        toolCallId: member.toolCallId || '',
        startedAt: member.startedAt ? new Date(member.startedAt).getTime() : 0,
        endedAt: member.finishedAt ? new Date(member.finishedAt).getTime() : 0,
        inputSummary: member.inputSummary || '',
        outputSummary: member.outputSummary || '',
        evidenceIds: member.evidenceIds || [],
      });
      // Ensure status maps to new enum
      actor.status = normalizeActorStatus(actor.status);
    }
  }

  // Migrate steps as stage events
  if (legacyRun.steps && legacyRun.steps.length > 0) {
    for (const step of legacyRun.steps) {
      recorder.recordStage({
        stage: step.type || 'unknown',
        toolName: step.label || '',
      });
    }
  }

  // Record run end
  if (legacyRun.status && legacyRun.status !== 'running') {
    recorder.recordRunEnd({
      status: normalizeRunStatus(legacyRun.status),
    });
  }

  return recorder;
}

function normalizeRunStatus(status: string) {
  const map: Record<string, string> = {
    running: RUN_STATUS.RUNNING,
    waiting: RUN_STATUS.WAITING,
    done: RUN_STATUS.DONE,
    error: RUN_STATUS.ERROR,
    cancelled: RUN_STATUS.CANCELLED,
  };
  return map[status] || RUN_STATUS.DONE;
}

function normalizeActorStatus(status: string) {
  const map: Record<string, string> = {
    idle: ACTOR_STATUS.IDLE,
    thinking: ACTOR_STATUS.THINKING,
    waiting: ACTOR_STATUS.WAITING_APPROVAL,
    running: ACTOR_STATUS.RUNNING_TOOL,
    observing: ACTOR_STATUS.OBSERVING,
    blocked: ACTOR_STATUS.BLOCKED,
    done: ACTOR_STATUS.DONE,
    error: ACTOR_STATUS.ERROR,
    skipped: ACTOR_STATUS.BLOCKED,
  };
  return map[status] || ACTOR_STATUS.IDLE;
}

// ─── Trace Export ───────────────────────────────────────────────────────────

/**
 * Export a trace to a downloadable blob.
 */
export function exportTraceAsBlob(recorder: TraceRecorder | null | undefined, format = 'jsonl') {
  if (!recorder) return null;
  const content = format === 'jsonl' ? recorder.toJSONL() : recorder.toJSON();
  const mime = format === 'jsonl' ? 'application/x-ndjson' : 'application/json';
  return new Blob([content], { type: mime });
}

/**
 * Generate a filename for trace export.
 */
export function generateTraceFileName(recorder: TraceRecorder | null | undefined) {
  if (!recorder) return 'trace.jsonl';
  const date = new Date(recorder.startedAt).toISOString().slice(0, 10);
  const mode = recorder.mode || 'unknown';
  return `deepchat-trace-${mode}-${date}-${recorder.runId.slice(0, 8)}.jsonl`;
}
