import { describe, expect, it } from 'vitest';
import {
  createAgentRun,
  getCrewRoleForTool,
  applyCrewToolRequest,
  applyCrewToolResult,
  handleCrewAgentStage,
  markCrewMemberDone,
  finalizeCrewRun
} from '../src/modules/agent-run-store.js';

describe('agent crew state engine', () => {
  it('initializes agentRun with Planner running and other roles idle', () => {
    const run = createAgentRun('auto');
    expect(run.status).toBe('running');
    expect(run.mode).toBe('auto');
    expect(run.crew).toHaveLength(6);

    const planner = run.crew.find(c => c.id === 'planner');
    expect(planner.status).toBe('running');
    expect(planner.currentAction).toBe('正在拆解任务');

    const coder = run.crew.find(c => c.id === 'coder');
    expect(coder.status).toBe('idle');
    expect(coder.currentAction).toBe('等待中');
  });

  it('correctly maps tool names to crew roles', () => {
    expect(getCrewRoleForTool('read_file')).toBe('reader');
    expect(getCrewRoleForTool('search_workspace')).toBe('reader');
    expect(getCrewRoleForTool('list_files')).toBe('reader');
    
    expect(getCrewRoleForTool('web_search')).toBe('researcher');
    expect(getCrewRoleForTool('mcp_my_custom_tool')).toBe('researcher');

    expect(getCrewRoleForTool('run_code')).toBe('coder');
    
    // Fallbacks
    expect(getCrewRoleForTool('ncbi_sequence_fetch')).toBe('researcher');
    expect(getCrewRoleForTool('protein_sequence_msa')).toBe('reader');
    expect(getCrewRoleForTool('unknown_custom_agent_tool')).toBe('planner');
  });

  it('handles tool requests and marks the mapped role appropriately', () => {
    const run = createAgentRun('auto');
    
    // Test approved tool request
    const readerTool = { id: 't1', name: 'read_file', status: 'approved' };
    applyCrewToolRequest(run, readerTool);
    
    const reader = run.crew.find(c => c.id === 'reader');
    expect(reader.status).toBe('running');
    expect(reader.currentAction).toContain('read_file');
    expect(reader.linkedToolCallIds).toContain('t1');

    // Test pending approval tool request
    const coderTool = { id: 't2', name: 'run_code', status: 'pending' };
    applyCrewToolRequest(run, coderTool);
    
    const coder = run.crew.find(c => c.id === 'coder');
    expect(coder.status).toBe('waiting');
    expect(coder.currentAction).toContain('等待审批');
    expect(coder.linkedToolCallIds).toContain('t2');
  });

  it('handles tool result event and transition state to done/error/skipped', () => {
    const run = createAgentRun('auto');
    const toolCalls = [
      { id: 't1', name: 'read_file', status: 'approved', args: { path: 'README.md' } },
      { id: 't2', name: 'run_code', status: 'approved' }
    ];

    applyCrewToolRequest(run, toolCalls[0]);
    applyCrewToolRequest(run, toolCalls[1]);

    // Success tool result
    applyCrewToolResult(run, { toolCallId: 't1', ok: true, status: 'completed' }, toolCalls);
    const reader = run.crew.find(c => c.id === 'reader');
    expect(reader.status).toBe('done');
    expect(reader.outputSummary).toContain('README.md');

    // Denied tool result
    applyCrewToolResult(run, { toolCallId: 't2', status: 'denied' }, toolCalls);
    const coder = run.crew.find(c => c.id === 'coder');
    expect(coder.status).toBe('skipped');
    expect(coder.outputSummary).toBe('审批拒绝');
  });

  it('handles crew agent stage events', () => {
    const run = createAgentRun('auto');

    // stage: plan with steps
    handleCrewAgentStage(run, {
      stage: 'plan',
      planSummary: { steps: ['Step 1', 'Step 2'] }
    });
    const planner = run.crew.find(c => c.id === 'planner');
    expect(planner.status).toBe('done');
    expect(planner.outputSummary).toContain('2 步');
    expect(run.steps).toEqual(['Step 1', 'Step 2']);

    // stage: summary (Reviewer running)
    handleCrewAgentStage(run, { stage: 'summary' });
    const reviewer = run.crew.find(c => c.id === 'reviewer');
    expect(reviewer.status).toBe('running');
    expect(reviewer.currentAction).toContain('整理/压缩');

    // stage: final (Writer running, Reviewer completed)
    handleCrewAgentStage(run, { stage: 'final' });
    const writer = run.crew.find(c => c.id === 'writer');
    expect(writer.status).toBe('running');
    expect(reviewer.status).toBe('done');
  });

  it('finalizes a successful run and marks inactive agents as skipped', () => {
    const run = createAgentRun('auto');
    
    // Make planner done
    markCrewMemberDone(run, 'planner', '已生成计划');
    
    finalizeCrewRun(run, false);

    expect(run.status).toBe('done');
    
    const planner = run.crew.find(c => c.id === 'planner');
    expect(planner.status).toBe('done');

    const reader = run.crew.find(c => c.id === 'reader');
    expect(reader.status).toBe('skipped');
    expect(reader.currentAction).toBe('本轮跳过');

    const reviewer = run.crew.find(c => c.id === 'reviewer');
    expect(reviewer.status).toBe('done');

    const writer = run.crew.find(c => c.id === 'writer');
    expect(writer.status).toBe('done');
  });

  it('finalizes a failed run with error state', () => {
    const run = createAgentRun('auto');
    applyCrewToolRequest(run, { id: 't1', name: 'read_file', status: 'approved' });

    finalizeCrewRun(run, false, 'API request timeout');

    expect(run.status).toBe('error');
    
    const reader = run.crew.find(c => c.id === 'reader');
    expect(reader.status).toBe('error');
    expect(reader.outputSummary).toBe('API request timeout');
  });
});
