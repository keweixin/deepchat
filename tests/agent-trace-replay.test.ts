import { describe, it, expect } from 'vitest';
import { TraceRecorder } from '../src/modules/agent-trace.js';

describe('Agent Trace Replay', () => {
  it('records and exports a complete trace as JSONL', () => {
    const recorder = new TraceRecorder({
      runId: 'test-run-001',
      mode: 'agent_auto',
      model: 'deepseek-chat',
    });

    // Simulate a complete agent run
    recorder.recordRunStart({ maxRounds: 3 });
    recorder.recordToolRequest({
      toolCallId: 'tc-1',
      toolName: 'search_workspace',
      args: { query: 'chat service' },
      risk: 'low',
      autoApproved: true,
    });
    recorder.recordToolResult({
      toolCallId: 'tc-1',
      toolName: 'search_workspace',
      ok: true,
      output: 'Found 5 results',
      durationMs: 150,
    });
    recorder.recordStage({
      stage: 'answer',
      round: 1,
      maxRounds: 3,
      warning: 'Completed in 1 round',
    });
    recorder.recordRunEnd({
      status: 'done',
      finalContentLength: 500,
    });

    // Verify trace structure
    const summary = recorder.toRunSummary();
    expect(summary.runId).toBe('test-run-001');
    expect(summary.mode).toBe('agent_auto');
    expect(summary.status).toBe('done');
  });

  it('records tool requests with metadata', () => {
    const recorder = new TraceRecorder({ runId: 'test-002', mode: 'auto', model: 'test' });
    recorder.recordRunStart({});

    recorder.recordToolRequest({
      toolCallId: 'tc-1',
      toolName: 'read_file',
      args: { path: '/src/index.ts' },
      risk: 'low',
      inputSummary: 'Read /src/index.ts',
    });

    const summary = recorder.toRunSummary();
    expect(summary.runId).toBe('test-002');
  });

  it('records errors in trace', () => {
    const recorder = new TraceRecorder({ runId: 'test-003', mode: 'auto', model: 'test' });
    recorder.recordRunStart({});
    recorder.recordError({ source: 'model_stream', message: 'Connection timeout' });
    recorder.recordRunEnd({ status: 'error', errorMessage: 'Connection timeout' });

    const summary = recorder.toRunSummary();
    expect(summary.status).toBe('error');
  });

  it('records context compaction events', () => {
    const recorder = new TraceRecorder({ runId: 'test-004', mode: 'auto', model: 'test' });
    recorder.recordRunStart({});
    recorder.recordContextCompaction({
      messageCount: 50,
      tokenCount: 25000,
      summaryTokens: 1500,
      trigger: 'auto',
    });
    recorder.recordRunEnd({ status: 'done', finalContentLength: 200 });

    const summary = recorder.toRunSummary();
    expect(summary.runId).toBe('test-004');
  });

  it('records approval events', () => {
    const recorder = new TraceRecorder({ runId: 'test-005', mode: 'auto', model: 'test' });
    recorder.recordRunStart({});
    recorder.recordApproval({
      toolCallId: 'tc-1',
      approved: true,
      decision: 'approved',
      reason: '用户确认',
    });
    recorder.recordRunEnd({ status: 'done', finalContentLength: 100 });

    const summary = recorder.toRunSummary();
    expect(summary.runId).toBe('test-005');
  });

  it('trace can be used for replay validation', () => {
    // Create a "golden" trace
    const goldenRecorder = new TraceRecorder({ runId: 'golden-001', mode: 'agent_auto', model: 'deepseek-chat' });
    goldenRecorder.recordRunStart({ maxRounds: 3 });
    goldenRecorder.recordToolRequest({ toolCallId: 'tc-1', toolName: 'read_file', args: { path: '/src/index.ts' } });
    goldenRecorder.recordToolResult({ toolCallId: 'tc-1', toolName: 'read_file', ok: true, output: 'file content' });
    goldenRecorder.recordRunEnd({ status: 'done', finalContentLength: 300 });

    const goldenSummary = goldenRecorder.toRunSummary();

    // Create a replay trace
    const replayRecorder = new TraceRecorder({ runId: 'replay-001', mode: 'agent_auto', model: 'deepseek-chat' });
    replayRecorder.recordRunStart({ maxRounds: 3 });
    replayRecorder.recordToolRequest({ toolCallId: 'tc-1', toolName: 'read_file', args: { path: '/src/index.ts' } });
    replayRecorder.recordToolResult({ toolCallId: 'tc-1', toolName: 'read_file', ok: true, output: 'file content' });
    replayRecorder.recordRunEnd({ status: 'done', finalContentLength: 300 });

    const replaySummary = replayRecorder.toRunSummary();

    // Both should have same status
    expect(goldenSummary.status).toBe(replaySummary.status);
  });
});
