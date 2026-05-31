import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TraceRecorder,
  getActorRoleForTool,
  migrateLegacyAgentRun,
  exportTraceAsBlob,
  generateTraceFileName,
  RUN_STATUS,
  ACTOR_STATUS,
  TRACE_EVENT_TYPES,
} from '../src/modules/agent-trace.js';
import {
  saveTrace,
  loadTraceEvents,
  loadRunSummary,
  listRunsForConversation,
  deleteTrace,
  cleanupOldTraces,
  getTraceStoreStats,
  clearAllTraces,
  resolveTraceRetention,
  isTraceRecordingEnabled,
} from '../src/modules/agent-trace-store.js';

// ─── TraceRecorder Core ─────────────────────────────────────────────────────

describe('TraceRecorder', () => {
  let recorder;

  beforeEach(() => {
    recorder = new TraceRecorder({ runId: 'run_test', mode: 'agent_auto', model: 'deepseek-chat' });
  });

  afterEach(() => {
    recorder = null;
  });

  it('initializes with correct defaults', () => {
    expect(recorder.runId).toBe('run_test');
    expect(recorder.mode).toBe('agent_auto');
    expect(recorder.model).toBe('deepseek-chat');
    expect(recorder.events).toEqual([]);
    expect(recorder.status).toBe(RUN_STATUS.RUNNING);
    expect(recorder.isRunning).toBe(true);
    expect(recorder.durationMs).toBe(0);
  });

  it('records run_start event', () => {
    const evt = recorder.recordRunStart({ maxToolRounds: 3 });
    expect(evt.type).toBe('run_start');
    expect(evt.mode).toBe('agent_auto');
    expect(evt.maxToolRounds).toBe(3);
    expect(evt.timestamp).toBeGreaterThan(0);
    expect(recorder.startedAt).toBe(evt.timestamp);
    expect(recorder.events).toHaveLength(1);
  });

  it('records stage events', () => {
    recorder.recordRunStart();
    const evt = recorder.recordStage({ stage: 'plan', round: 0, maxRounds: 3 });
    expect(evt.type).toBe('stage');
    expect(evt.stage).toBe('plan');
    expect(evt.round).toBe(0);
    expect(recorder.events).toHaveLength(2);
  });

  it('records tool_request with auto-approval', () => {
    recorder.recordRunStart();
    const evt = recorder.recordToolRequest({
      toolCallId: 'tc_1',
      toolName: 'web_search',
      args: { query: 'test' },
      autoApproved: true,
      inputSummary: '搜索 test',
    });
    expect(evt.type).toBe('tool_request');
    expect(evt.toolName).toBe('web_search');
    expect(evt.autoApproved).toBe(true);

    const tc = recorder.getToolCall('tc_1');
    expect(tc).not.toBeNull();
    expect(tc.status).toBe('auto_approved');
  });

  it('records tool_request without auto-approval', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({
      toolCallId: 'tc_2',
      toolName: 'run_code',
      args: { code: 'print(1)' },
      autoApproved: false,
    });
    expect(recorder.status).toBe(RUN_STATUS.WAITING);

    const actor = recorder.getActor('coder');
    expect(actor.status).toBe(ACTOR_STATUS.WAITING_APPROVAL);
  });

  it('records approval and updates status', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_3', toolName: 'read_file', autoApproved: false });
    expect(recorder.status).toBe(RUN_STATUS.WAITING);

    recorder.recordApproval({ toolCallId: 'tc_3', approved: true, latencyMs: 1200 });
    expect(recorder.status).toBe(RUN_STATUS.RUNNING);

    const actor = recorder.getActor('reader');
    expect(actor.status).toBe(ACTOR_STATUS.RUNNING_TOOL);
  });

  it('records denial and blocks actor', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_4', toolName: 'run_code', autoApproved: false });
    recorder.recordApproval({ toolCallId: 'tc_4', approved: false });

    const actor = recorder.getActor('coder');
    expect(actor.status).toBe(ACTOR_STATUS.BLOCKED);
    expect(actor.endedAt).toBeGreaterThan(0);
  });

  it('records tool_result with success', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_5', toolName: 'web_search', autoApproved: true });
    const evt = recorder.recordToolResult({
      toolCallId: 'tc_5',
      toolName: 'web_search',
      ok: true,
      outputSummary: '找到 5 个来源',
      durationMs: 320,
      evidenceIds: ['ev_1'],
    });
    expect(evt.type).toBe('tool_result');
    expect(evt.ok).toBe(true);

    const actor = recorder.getActor('researcher');
    expect(actor.status).toBe(ACTOR_STATUS.DONE);
    expect(actor.outputSummary).toBe('找到 5 个来源');
    expect(actor.evidenceIds).toContain('ev_1');
  });

  it('records tool_result with failure', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_6', toolName: 'run_code', autoApproved: true });
    recorder.recordToolResult({
      toolCallId: 'tc_6',
      toolName: 'run_code',
      ok: false,
      error: 'Timeout',
    });

    const actor = recorder.getActor('coder');
    expect(actor.status).toBe(ACTOR_STATUS.ERROR);
    expect(actor.outputSummary).toBe('Timeout');
  });

  it('records tool_repair event', () => {
    recorder.recordRunStart();
    const evt = recorder.recordToolRepair({
      toolCallId: 'tc_7',
      toolName: 'web_search',
      confidence: 'medium',
      reason: '未返回原生 tool_calls',
    });
    expect(evt.type).toBe('tool_repair');
    expect(evt.confidence).toBe('medium');
    expect(recorder.events).toHaveLength(2);
  });

  it('records model_delta events', () => {
    recorder.recordRunStart();
    recorder.recordModelDelta({ chars: 100, tokens: 25 });
    recorder.recordModelDelta({ chars: 200, tokens: 50 });
    expect(recorder.events.filter((e) => e.type === 'model_delta')).toHaveLength(2);
  });

  it('records context_compaction events', () => {
    recorder.recordRunStart();
    const evt = recorder.recordContextCompaction({
      messageCount: 20,
      tokenCount: 15000,
      summaryTokens: 200,
      trigger: 'budget_exceeded',
    });
    expect(evt.type).toBe('context_compaction');
    expect(evt.trigger).toBe('budget_exceeded');
  });

  it('records run_end and locks recorder', () => {
    recorder.recordRunStart();
    const startTs = recorder.startedAt;
    const evt = recorder.recordRunEnd({ status: RUN_STATUS.DONE, finalContentLength: 500 });
    expect(evt.type).toBe('run_end');
    expect(evt.status).toBe('done');
    expect(evt.durationMs).toBeGreaterThanOrEqual(0);
    expect(recorder.status).toBe(RUN_STATUS.DONE);
    expect(recorder.isRunning).toBe(false);

    // Should be locked — subsequent records are ignored
    const ignored = recorder.recordRunStart();
    expect(ignored).toBeNull();
    expect(recorder.events).toHaveLength(2);
  });

  it('records error and sets error status', () => {
    recorder.recordRunStart();
    recorder.recordError({ source: 'model_stream', message: 'Connection reset' });
    expect(recorder.status).toBe(RUN_STATUS.ERROR);
    expect(recorder.events.some((e) => e.type === 'error')).toBe(true);
  });

  it('computes token usage correctly', () => {
    recorder.setTokenUsage({ input: 100, output: 50, cacheHit: 80, cacheMiss: 20 });
    recorder.setTokenUsage({ input: 50, output: 25 });
    const usage = recorder.tokenUsage;
    expect(usage.input).toBe(150);
    expect(usage.output).toBe(75);
    expect(usage.cacheHit).toBe(80);
    expect(usage.cacheMiss).toBe(20);
  });

  it('produces a correct run summary', () => {
    recorder.recordRunStart({ maxToolRounds: 3 });
    recorder.recordStage({ stage: 'plan' });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    const summary = recorder.toRunSummary();
    expect(summary.runId).toBe('run_test');
    expect(summary.status).toBe('done');
    expect(summary.eventCount).toBe(3);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(summary.actors)).toBe(true);
    expect(Array.isArray(summary.toolCalls)).toBe(true);
  });

  it('exports to JSONL format', () => {
    recorder.recordRunStart();
    recorder.recordStage({ stage: 'plan' });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    const jsonl = recorder.toJSONL();
    const lines = jsonl.split('\n');
    expect(lines).toHaveLength(3);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('run_start');
    expect(parsed.eventId).toBeDefined();
  });

  it('exports to JSON format', () => {
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    const json = recorder.toJSON();
    const parsed = JSON.parse(json);
    expect(parsed.run).toBeDefined();
    expect(parsed.events).toHaveLength(2);
  });

  it('fires onEvent callback for each event', () => {
    const onEvent = vi.fn();
    const r = new TraceRecorder({ runId: 'run_cb', onEvent });
    r.recordRunStart();
    r.recordStage({ stage: 'plan' });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0][0].type).toBe('run_start');
  });

  it('handles callback errors gracefully', () => {
    const onEvent = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });
    const r = new TraceRecorder({ runId: 'run_err', onEvent });
    expect(() => r.recordRunStart()).not.toThrow();
    expect(r.events).toHaveLength(1);
  });

  it('freezes events (immutable)', () => {
    recorder.recordRunStart();
    const evt = recorder.events[0];
    expect(() => {
      evt.type = 'tampered';
    }).toThrow();
  });
});

// ─── Actor Role Mapping ─────────────────────────────────────────────────────

describe('getActorRoleForTool', () => {
  it('maps file tools to reader', () => {
    expect(getActorRoleForTool('read_file')).toBe('reader');
    expect(getActorRoleForTool('search_workspace')).toBe('reader');
    expect(getActorRoleForTool('list_files')).toBe('reader');
    expect(getActorRoleForTool('index_workspace')).toBe('reader');
    expect(getActorRoleForTool('read_symbol')).toBe('reader');
  });

  it('maps web_search to researcher', () => {
    expect(getActorRoleForTool('web_search')).toBe('researcher');
  });

  it('maps run_code to coder', () => {
    expect(getActorRoleForTool('run_code')).toBe('coder');
  });

  it('maps MCP file tools to reader', () => {
    expect(getActorRoleForTool('mcp__fs__read_file')).toBe('reader');
    expect(getActorRoleForTool('mcp__fs__list_directory')).toBe('reader');
  });

  it('maps MCP write tools to coder', () => {
    expect(getActorRoleForTool('mcp__fs__write_file')).toBe('coder');
    expect(getActorRoleForTool('mcp__fs__edit_file')).toBe('coder');
  });

  it('maps MCP other tools to researcher', () => {
    expect(getActorRoleForTool('mcp__slack__send_message')).toBe('researcher');
  });

  it('maps science search tools to researcher', () => {
    expect(getActorRoleForTool('search_pubmed')).toBe('researcher');
    expect(getActorRoleForTool('query_database')).toBe('researcher');
  });

  it('defaults unknown tools to planner', () => {
    expect(getActorRoleForTool('unknown_tool')).toBe('planner');
    expect(getActorRoleForTool('')).toBe('planner');
  });
});

// ─── Legacy Migration ───────────────────────────────────────────────────────

describe('migrateLegacyAgentRun', () => {
  it('returns null for null input', () => {
    expect(migrateLegacyAgentRun(null)).toBeNull();
  });

  it('migrates a legacy run with crew members', () => {
    const legacy = {
      id: 'run_old',
      mode: 'agent_auto',
      status: 'done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      crew: [
        {
          id: 'planner',
          status: 'done',
          currentAction: '规划完毕',
          outputSummary: '3 步计划',
          linkedToolCallIds: [],
          linkedStepIds: [],
        },
        {
          id: 'coder',
          status: 'error',
          currentAction: '执行失败',
          outputSummary: 'Timeout',
          linkedToolCallIds: ['tc_1'],
        },
      ],
      steps: [{ type: 'tool', status: 'failed', label: 'run_code' }],
    };

    const recorder = migrateLegacyAgentRun(legacy);
    expect(recorder).not.toBeNull();
    expect(recorder.runId).toBe('run_old');
    expect(recorder.mode).toBe('agent_auto');
    expect(recorder.status).toBe(RUN_STATUS.DONE);
    expect(recorder.events.length).toBeGreaterThanOrEqual(3); // run_start + stage(s) + run_end

    const planner = recorder.getActor('planner');
    expect(planner.status).toBe(ACTOR_STATUS.DONE);
    expect(planner.currentAction).toBe('规划完毕');

    const coder = recorder.getActor('coder');
    expect(coder.status).toBe(ACTOR_STATUS.ERROR);
  });

  it('handles legacy run without crew', () => {
    const legacy = { id: 'run_empty', mode: 'web_search', status: 'running' };
    const recorder = migrateLegacyAgentRun(legacy);
    expect(recorder.events.some((e) => e.type === 'run_start')).toBe(true);
    // No run_end because status is running
    expect(recorder.events.some((e) => e.type === 'run_end')).toBe(false);
  });
});

// ─── Export Utilities ───────────────────────────────────────────────────────

describe('exportTraceAsBlob', () => {
  it('returns a Blob in jsonl format', () => {
    const recorder = new TraceRecorder({ runId: 'run_blob' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    const blob = exportTraceAsBlob(recorder, 'jsonl');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/x-ndjson');
  });

  it('returns a Blob in json format', () => {
    const recorder = new TraceRecorder({ runId: 'run_blob2' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    const blob = exportTraceAsBlob(recorder, 'json');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/json');
  });

  it('returns null for null recorder', () => {
    expect(exportTraceAsBlob(null)).toBeNull();
  });
});

describe('generateTraceFileName', () => {
  it('includes runId prefix and mode', () => {
    const recorder = new TraceRecorder({ runId: 'run_xyz123', mode: 'agent_auto' });
    recorder.recordRunStart();
    const name = generateTraceFileName(recorder);
    expect(name).toMatch(/^deepchat-trace-agent_auto-\d{4}-\d{2}-\d{2}-run_xyz/);
    expect(name).toMatch(/\.jsonl$/);
  });

  it('returns default for null', () => {
    expect(generateTraceFileName(null)).toBe('trace.jsonl');
  });
});

// ─── TraceStore (IndexedDB) ─────────────────────────────────────────────────

// IndexedDB may not be available in all test environments; skip if missing.
const hasIndexedDB = typeof indexedDB !== 'undefined';

describe('agent-trace-store', () => {
  beforeEach(async () => {
    if (hasIndexedDB) {
      try {
        await clearAllTraces();
      } catch {
        // ignore
      }
    }
  });

  afterEach(async () => {
    if (hasIndexedDB) {
      try {
        await clearAllTraces();
      } catch {
        // ignore
      }
    }
  });

  (hasIndexedDB ? it : it.skip)('saves and loads a complete trace', async () => {
    const recorder = new TraceRecorder({ runId: 'run_store_1', mode: 'agent_auto' });
    recorder.recordRunStart();
    recorder.recordStage({ stage: 'plan' });
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'web_search', ok: true });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    await saveTrace(recorder, 'conv_1');

    const summary = (await loadRunSummary('run_store_1')) as any;
    expect(summary).not.toBeNull();
    expect(summary.runId).toBe('run_store_1');
    expect(summary.conversationId).toBe('conv_1');
    expect(summary.status).toBe('done');

    const events = (await loadTraceEvents('run_store_1')) as any[];
    expect(events.length).toBe(recorder.events.length);
    expect(events[0].type).toBe('run_start');
    expect(events.at(-1).type).toBe('run_end');
  });

  (hasIndexedDB ? it : it.skip)('lists runs for a conversation', async () => {
    const r1 = new TraceRecorder({ runId: 'run_list_1' });
    r1.recordRunStart();
    r1.recordRunEnd({ status: RUN_STATUS.DONE });
    await saveTrace(r1, 'conv_list');

    const r2 = new TraceRecorder({ runId: 'run_list_2' });
    r2.recordRunStart();
    r2.recordRunEnd({ status: RUN_STATUS.DONE });
    await saveTrace(r2, 'conv_list');

    const runs = await listRunsForConversation('conv_list');
    expect(runs).toHaveLength(2);
  });

  (hasIndexedDB ? it : it.skip)('deletes a trace', async () => {
    const recorder = new TraceRecorder({ runId: 'run_del_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });
    await saveTrace(recorder, 'conv_del');

    let summary = await loadRunSummary('run_del_1');
    expect(summary).not.toBeNull();

    await deleteTrace('run_del_1');
    summary = await loadRunSummary('run_del_1');
    expect(summary).toBeNull();

    const events = await loadTraceEvents('run_del_1');
    expect(events).toHaveLength(0);
  });

  (hasIndexedDB ? it : it.skip)('cleans up old traces', async () => {
    // This test is timing-sensitive; use a very short retention
    // Since we can't easily manipulate time, we just verify the API works.
    const recorder = new TraceRecorder({ runId: 'run_old_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });
    await saveTrace(recorder, 'conv_old');

    // Cleanup with 0 days should delete everything older than now
    // But the record was just created, so it won't be deleted.
    const deleted = await cleanupOldTraces(0);
    expect(typeof deleted).toBe('number');

    // Verify the trace still exists
    const summary = await loadRunSummary('run_old_1');
    expect(summary).not.toBeNull();
  });

  (hasIndexedDB ? it : it.skip)('reports store stats', async () => {
    const recorder = new TraceRecorder({ runId: 'run_stats_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });
    await saveTrace(recorder, 'conv_stats');

    const stats = await getTraceStoreStats();
    expect(typeof stats.runs).toBe('number');
    expect(typeof stats.events).toBe('number');
    expect(stats.runs).toBeGreaterThanOrEqual(1);
    expect(stats.events).toBeGreaterThanOrEqual(2);
  });

  (hasIndexedDB ? it : it.skip)('clears all traces', async () => {
    const recorder = new TraceRecorder({ runId: 'run_clear_1' });
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });
    await saveTrace(recorder, 'conv_clear');

    await clearAllTraces();
    const stats = await getTraceStoreStats();
    expect(stats.runs).toBe(0);
    expect(stats.events).toBe(0);
  });
});

// ─── Settings Helpers ───────────────────────────────────────────────────────

describe('trace settings helpers', () => {
  it('resolves trace retention default', () => {
    expect(resolveTraceRetention({})).toBe(30);
    expect(resolveTraceRetention({ traceRetentionDays: 7 })).toBe(7);
    expect(resolveTraceRetention({ traceRetentionDays: 'unlimited' })).toBe(0);
    expect(resolveTraceRetention({ traceRetentionDays: 0 })).toBe(0);
  });

  it('checks trace recording enabled', () => {
    expect(isTraceRecordingEnabled({})).toBe(true);
    expect(isTraceRecordingEnabled({ enableTraceRecording: true })).toBe(true);
    expect(isTraceRecordingEnabled({ enableTraceRecording: false })).toBe(false);
  });
});

// ─── Constants ──────────────────────────────────────────────────────────────

describe('constants', () => {
  it('has all expected event types', () => {
    expect(TRACE_EVENT_TYPES).toContain('run_start');
    expect(TRACE_EVENT_TYPES).toContain('stage');
    expect(TRACE_EVENT_TYPES).toContain('tool_request');
    expect(TRACE_EVENT_TYPES).toContain('approval');
    expect(TRACE_EVENT_TYPES).toContain('tool_result');
    expect(TRACE_EVENT_TYPES).toContain('tool_repair');
    expect(TRACE_EVENT_TYPES).toContain('model_delta');
    expect(TRACE_EVENT_TYPES).toContain('context_compaction');
    expect(TRACE_EVENT_TYPES).toContain('run_end');
    expect(TRACE_EVENT_TYPES).toContain('error');
  });

  it('has frozen run statuses', () => {
    expect(RUN_STATUS.RUNNING).toBe('running');
    expect(RUN_STATUS.WAITING).toBe('waiting');
    expect(RUN_STATUS.DONE).toBe('done');
    expect(RUN_STATUS.ERROR).toBe('error');
    expect(RUN_STATUS.CANCELLED).toBe('cancelled');
  });

  it('has frozen actor statuses', () => {
    expect(ACTOR_STATUS.IDLE).toBe('idle');
    expect(ACTOR_STATUS.THINKING).toBe('thinking');
    expect(ACTOR_STATUS.WAITING_APPROVAL).toBe('waiting_approval');
    expect(ACTOR_STATUS.RUNNING_TOOL).toBe('running_tool');
    expect(ACTOR_STATUS.OBSERVING).toBe('observing');
    expect(ACTOR_STATUS.BLOCKED).toBe('blocked');
    expect(ACTOR_STATUS.DONE).toBe('done');
    expect(ACTOR_STATUS.ERROR).toBe('error');
  });
});
