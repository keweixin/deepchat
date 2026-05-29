// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  CREW_ROLES,
  createAgentRun,
  getCrewRoleForTool,
  applyCrewToolRequest,
  applyCrewToolResult,
  finalizeCrewRun,
} from '../src/modules/agent-run-store.js';

describe('CREW_ROLES', () => {
  it('has 6 roles', () => {
    expect(CREW_ROLES).toHaveLength(6);
  });

  it('each role has id, label, icon, title', () => {
    for (const role of CREW_ROLES) {
      expect(role).toHaveProperty('id');
      expect(role).toHaveProperty('label');
      expect(role).toHaveProperty('icon');
      expect(role).toHaveProperty('title');
    }
  });
});

describe('createAgentRun', () => {
  it('creates a running agent run', () => {
    const run = createAgentRun();
    expect(run.status).toBe('running');
    expect(run.mode).toBe('auto');
    expect(run.crew).toHaveLength(6);
    expect(run.steps).toEqual([]);
  });

  it('starts planner as running, others as idle', () => {
    const run = createAgentRun();
    const planner = run.crew.find((r) => r.id === 'planner');
    const reader = run.crew.find((r) => r.id === 'reader');
    expect(planner.status).toBe('running');
    expect(reader.status).toBe('idle');
  });

  it('accepts custom mode', () => {
    const run = createAgentRun('single_step');
    expect(run.mode).toBe('single_step');
  });
});

describe('getCrewRoleForTool', () => {
  it('maps file tools to reader', () => {
    expect(getCrewRoleForTool('read_file')).toBe('reader');
    expect(getCrewRoleForTool('list_files')).toBe('reader');
    expect(getCrewRoleForTool('search_workspace')).toBe('reader');
    expect(getCrewRoleForTool('index_workspace')).toBe('reader');
    expect(getCrewRoleForTool('read_symbol')).toBe('reader');
  });

  it('maps web_search to researcher', () => {
    expect(getCrewRoleForTool('web_search')).toBe('researcher');
  });

  it('maps run_code to coder', () => {
    expect(getCrewRoleForTool('run_code')).toBe('coder');
  });

  it('maps mcp tools to researcher by default', () => {
    expect(getCrewRoleForTool('mcp__server__tool_abc')).toBe('researcher');
  });

  it('maps mcp read tools to reader', () => {
    expect(getCrewRoleForTool('mcp__server__read_file_abc')).toBe('reader');
  });

  it('maps mcp write tools to coder', () => {
    expect(getCrewRoleForTool('mcp__server__write_code_abc')).toBe('coder');
  });
});

describe('applyCrewToolRequest', () => {
  it('links tool to correct crew member', () => {
    const run = createAgentRun();
    applyCrewToolRequest(run, { name: 'read_file', id: 't1' });
    const reader = run.crew.find((r) => r.id === 'reader');
    expect(reader.linkedToolCallIds).toContain('t1');
    expect(reader.status).toBe('running');
  });

  it('handles null agentRun gracefully', () => {
    expect(() => applyCrewToolRequest(null, { name: 'read_file' })).not.toThrow();
  });
});

describe('applyCrewToolResult', () => {
  it('marks crew member done after tool completes', () => {
    const run = createAgentRun();
    applyCrewToolResult(run, { name: 'read_file', ok: true });
    const reader = run.crew.find((r) => r.id === 'reader');
    expect(reader.status).toBe('done');
    expect(reader.finishedAt).toBeTruthy();
  });

  it('marks crew member error on failure', () => {
    const run = createAgentRun();
    applyCrewToolResult(run, { name: 'run_code', ok: false });
    const coder = run.crew.find((r) => r.id === 'coder');
    expect(coder.status).toBe('error');
  });

  it('handles null agentRun gracefully', () => {
    expect(() => applyCrewToolResult(null, { name: 'read_file' })).not.toThrow();
  });
});

describe('finalizeCrewRun', () => {
  it('sets status to done', () => {
    const run = createAgentRun();
    finalizeCrewRun(run);
    expect(run.status).toBe('done');
    expect(run.finishedAt).toBeTruthy();
  });

  it('sets status to error when error option passed', () => {
    const run = createAgentRun();
    finalizeCrewRun(run, { error: 'failed' });
    expect(run.status).toBe('error');
  });
});
