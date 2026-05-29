// @ts-nocheck
import { describe, it, expect, beforeEach } from 'vitest';
import { TraceRecorder, RUN_STATUS, ACTOR_STATUS } from '../src/modules/agent-trace.js';
import {
  ACTOR_DISPLAY_META,
  ACTOR_ROLE_IDS,
  STATUS_DISPLAY,
  buildActorState,
  buildCrewHeaderState,
  buildToolCallTimeline,
  buildEventTimeline,
  buildContextSnapshots,
  toLegacyCrewFormat,
  shouldShowCrew,
  buildHumanReadableSummary,
} from '../src/modules/agent-actor-system.js';

describe('ACTOR_DISPLAY_META', () => {
  it('has all six roles', () => {
    expect(ACTOR_ROLE_IDS).toHaveLength(6);
    expect(ACTOR_ROLE_IDS).toContain('planner');
    expect(ACTOR_ROLE_IDS).toContain('reader');
    expect(ACTOR_ROLE_IDS).toContain('researcher');
    expect(ACTOR_ROLE_IDS).toContain('coder');
    expect(ACTOR_ROLE_IDS).toContain('reviewer');
    expect(ACTOR_ROLE_IDS).toContain('writer');
  });

  it('each role has required fields', () => {
    for (const roleId of ACTOR_ROLE_IDS) {
      const meta = ACTOR_DISPLAY_META[roleId];
      expect(meta).toBeDefined();
      expect(meta.id).toBe(roleId);
      expect(meta.label).toBeTruthy();
      expect(meta.title).toBeTruthy();
      expect(meta.icon).toBeTruthy();
      expect(meta.svgIcon).toBeTruthy();
      expect(meta.color).toMatch(/^#/);
      expect(meta.description).toBeTruthy();
    }
  });
});

describe('STATUS_DISPLAY', () => {
  it('covers all actor statuses', () => {
    for (const status of Object.values(ACTOR_STATUS)) {
      expect(STATUS_DISPLAY[status]).toBeDefined();
      expect(STATUS_DISPLAY[status].label).toBeTruthy();
      expect(STATUS_DISPLAY[status].cssClass).toBeTruthy();
    }
  });
});

describe('buildActorState', () => {
  let recorder;

  beforeEach(() => {
    recorder = new TraceRecorder({ runId: 'run_1', mode: 'agent_auto' });
  });

  it('returns all 6 actors for empty recorder', () => {
    const actors = buildActorState(recorder);
    expect(actors).toHaveLength(6);
    for (const actor of actors) {
      expect(actor.status).toBe(ACTOR_STATUS.IDLE);
      expect(actor.currentAction).toBe('等待中');
      expect(actor.isActive).toBe(false);
    }
  });

  it('reflects planner thinking during plan stage', () => {
    recorder.recordRunStart();
    recorder.recordStage({ stage: 'plan' });
    const actors = buildActorState(recorder);
    const planner = actors.find((a) => a.id === 'planner');
    expect(planner.status).toBe(ACTOR_STATUS.THINKING);
    expect(planner.currentAction).toBe('正在分析规划任务');
    expect(planner.isActive).toBe(true);
  });

  it('reflects researcher running tool', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    const actors = buildActorState(recorder);
    const researcher = actors.find((a) => a.id === 'researcher');
    expect(researcher.status).toBe(ACTOR_STATUS.RUNNING_TOOL);
    expect(researcher.currentTool).toBe('web_search');
    expect(researcher.isActive).toBe(true);
  });

  it('reflects done state after tool result', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'read_file', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'read_file', ok: true, outputSummary: '读取成功' });
    const actors = buildActorState(recorder);
    const reader = actors.find((a) => a.id === 'reader');
    expect(reader.status).toBe(ACTOR_STATUS.DONE);
    expect(reader.outputSummary).toBe('读取成功');
    expect(reader.isActive).toBe(false);
  });

  it('computes duration for completed actor', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'run_code', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'run_code', ok: true });
    const actors = buildActorState(recorder);
    const coder = actors.find((a) => a.id === 'coder');
    expect(coder.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('carries evidence IDs', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordToolResult({
      toolCallId: 'tc_1',
      toolName: 'web_search',
      ok: true,
      evidenceIds: ['ev_1', 'ev_2'],
    });
    const actors = buildActorState(recorder);
    const researcher = actors.find((a) => a.id === 'researcher');
    expect(researcher.evidenceIds).toContain('ev_1');
    expect(researcher.evidenceIds).toContain('ev_2');
  });
});

describe('buildCrewHeaderState', () => {
  let recorder;

  beforeEach(() => {
    recorder = new TraceRecorder({ runId: 'run_1', mode: 'agent_auto' });
  });

  it('returns defaults for null', () => {
    const state = buildCrewHeaderState(null);
    expect(state.status).toBe(RUN_STATUS.DONE);
    expect(state.label).toBe('智能团队');
  });

  it('shows waiting status when tool pending', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'run_code', autoApproved: false });
    const state = buildCrewHeaderState(recorder);
    expect(state.status).toBe(RUN_STATUS.WAITING);
    expect(state.waitingCount).toBe(1);
    expect(state.label).toContain('等待你确认');
  });

  it('shows running status when tool auto-approved', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    const state = buildCrewHeaderState(recorder);
    expect(state.status).toBe(RUN_STATUS.RUNNING);
    expect(state.runningCount).toBe(1);
  });

  it('counts done actors', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'read_file', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'read_file', ok: true });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });
    const state = buildCrewHeaderState(recorder);
    expect(state.status).toBe(RUN_STATUS.DONE);
    expect(state.doneCount).toBeGreaterThanOrEqual(1);
  });

  it('counts errors', () => {
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'run_code', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'run_code', ok: false, error: 'fail' });
    const state = buildCrewHeaderState(recorder);
    expect(state.errorCount).toBe(1);
    expect(state.detail).toContain('错误 1');
  });

  it('includes duration', () => {
    recorder.recordRunStart();
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });
    const state = buildCrewHeaderState(recorder);
    expect(state.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('buildToolCallTimeline', () => {
  it('returns empty for null recorder', () => {
    expect(buildToolCallTimeline(null)).toEqual([]);
  });

  it('orders tool calls chronologically', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordToolRequest({ toolCallId: 'tc_2', toolName: 'read_file', autoApproved: true });
    const timeline = buildToolCallTimeline(recorder);
    expect(timeline).toHaveLength(2);
    expect(timeline[0].toolCallId).toBe('tc_1');
    expect(timeline[1].toolCallId).toBe('tc_2');
    expect(timeline[0].roleId).toBe('researcher');
    expect(timeline[1].roleId).toBe('reader');
  });
});

describe('buildEventTimeline', () => {
  it('returns empty for null recorder', () => {
    expect(buildEventTimeline(null)).toEqual([]);
  });

  it('maps all event types', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart({ maxToolRounds: 3 });
    recorder.recordStage({ stage: 'plan' });
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordApproval({ toolCallId: 'tc_1', approved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'web_search', ok: true });
    recorder.recordToolRepair({ toolCallId: 'tc_1', confidence: 'medium' });
    recorder.recordModelDelta({ chars: 100 });
    recorder.recordContextCompaction({ trigger: 'budget_exceeded' });
    recorder.recordError({ source: 'test', message: 'oops' });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    const timeline = buildEventTimeline(recorder);
    expect(timeline.length).toBe(recorder.events.length);

    const start = timeline.find((t) => t.type === 'run_start');
    expect(start.mode).toBe('agent_auto');

    const stage = timeline.find((t) => t.type === 'stage');
    expect(stage.stage).toBe('plan');

    const req = timeline.find((t) => t.type === 'tool_request');
    expect(req.roleId).toBe('researcher');

    const result = timeline.find((t) => t.type === 'tool_result');
    expect(result.ok).toBe(true);

    const repair = timeline.find((t) => t.type === 'tool_repair');
    expect(repair.confidence).toBe('medium');

    const delta = timeline.find((t) => t.type === 'model_delta');
    expect(delta.chars).toBe(100);

    const compact = timeline.find((t) => t.type === 'context_compaction');
    expect(compact.trigger).toBe('budget_exceeded');

    const err = timeline.find((t) => t.type === 'error');
    expect(err.message).toBe('oops');

    const end = timeline.find((t) => t.type === 'run_end');
    expect(end.status).toBe('done');
  });
});

describe('buildContextSnapshots', () => {
  it('returns empty for null', () => {
    expect(buildContextSnapshots(null)).toEqual([]);
  });

  it('formats compaction events', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordContextCompaction({ messageCount: 20, tokenCount: 15000, trigger: 'budget_exceeded' });
    const snaps = buildContextSnapshots(recorder);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].messageCount).toBe(20);
    expect(snaps[0].description).toBe('Token 预算超出');
    expect(snaps[0].atFormatted).toBeTruthy();
  });
});

describe('toLegacyCrewFormat', () => {
  it('maps actor statuses to legacy strings', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordStage({ stage: 'plan' });
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'web_search', ok: true });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    const actors = buildActorState(recorder);
    const legacy = toLegacyCrewFormat(actors);

    expect(legacy).toHaveLength(6);
    const planner = legacy.find((c) => c.id === 'planner');
    expect(planner.status).toBe('done'); // THINKING → done (run completed)

    const researcher = legacy.find((c) => c.id === 'researcher');
    expect(researcher.status).toBe('done');
    expect(researcher.linkedToolCallIds).toContain('tc_1');

    const writer = legacy.find((c) => c.id === 'writer');
    expect(writer.status).toBe('idle');
  });
});

describe('shouldShowCrew', () => {
  it('returns false for off mode', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    expect(shouldShowCrew(recorder, 'off')).toBe(false);
  });

  it('returns true for always mode', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    expect(shouldShowCrew(recorder, 'always')).toBe(true);
  });

  it('returns false for empty run in auto mode', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    expect(shouldShowCrew(recorder, 'auto')).toBe(false);
  });

  it('returns true when tools exist in auto mode', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    expect(shouldShowCrew(recorder, 'auto')).toBe(true);
  });

  it('returns true for long run in auto mode', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    // Simulate a long run by setting startedAt far in the past
    recorder.startedAt = Date.now() - 5000;
    expect(shouldShowCrew(recorder, 'auto')).toBe(true);
  });

  it('returns false for tools_only when no tools', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    expect(shouldShowCrew(recorder, 'tools_only')).toBe(false);
  });

  it('returns true for tools_only when tools exist', () => {
    const recorder = new TraceRecorder({ runId: 'run_1' });
    recorder.recordRunStart();
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    expect(shouldShowCrew(recorder, 'tools_only')).toBe(true);
  });
});

describe('buildHumanReadableSummary', () => {
  it('returns empty for null', () => {
    expect(buildHumanReadableSummary(null)).toBe('');
  });

  it('includes run info and actors', () => {
    const recorder = new TraceRecorder({ runId: 'run_1', mode: 'agent_auto', model: 'deepseek-chat' });
    recorder.recordRunStart();
    recorder.recordStage({ stage: 'plan' });
    recorder.recordToolRequest({ toolCallId: 'tc_1', toolName: 'web_search', autoApproved: true });
    recorder.recordToolResult({ toolCallId: 'tc_1', toolName: 'web_search', ok: true });
    recorder.recordRunEnd({ status: RUN_STATUS.DONE });

    const summary = buildHumanReadableSummary(recorder);
    expect(summary).toContain('Run: run_1');
    expect(summary).toContain('Mode: agent_auto');
    expect(summary).toContain('Model: deepseek-chat');
    expect(summary).toContain('Status: done');
    expect(summary).toContain('Planner');
    expect(summary).toContain('Researcher');
    expect(summary).toContain('web_search');
  });
});
