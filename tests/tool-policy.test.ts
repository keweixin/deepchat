import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveToolPolicy,
  resolveToolApprovalDecision,
  buildToolSecurity,
  markToolConfirmed,
  isToolConfirmedInSession,
  clearSessionConfirmations,
  getToolPolicySummary,
  DEFAULT_TOOL_POLICIES,
} from '../electron/approval-manager.ts';

describe('tool policy engine', () => {
  beforeEach(() => {
    clearSessionConfirmations();
  });

  describe('DEFAULT_TOOL_POLICIES', () => {
    it('defines policies for all expected tools', () => {
      const toolNames = DEFAULT_TOOL_POLICIES.map((p) => p.tool);
      expect(toolNames).toContain('search_workspace');
      expect(toolNames).toContain('list_files');
      expect(toolNames).toContain('index_workspace');
      expect(toolNames).toContain('read_file');
      expect(toolNames).toContain('run_code');
      expect(toolNames).toContain('__mcp__');
    });
  });

  describe('resolveToolPolicy', () => {
    it('returns always_allow for search_workspace', () => {
      const policy = resolveToolPolicy('search_workspace', {}, {}, {});
      expect(policy).toMatchObject({ tool: 'search_workspace', action: 'always_allow' });
    });

    it('returns always_allow for list_files', () => {
      const policy = resolveToolPolicy('list_files', {}, {}, {});
      expect(policy).toMatchObject({ tool: 'list_files', action: 'always_allow' });
    });

    it('returns always_allow for index_workspace', () => {
      const policy = resolveToolPolicy('index_workspace', {}, {}, {});
      expect(policy).toMatchObject({ tool: 'index_workspace', action: 'always_allow' });
    });

    it('returns confirm_once for read_file inside workspace', () => {
      const policy = resolveToolPolicy(
        'read_file',
        { path: '/workspace/project/src/index.js' },
        { workspaceRoots: ['/workspace/project'] },
        {}
      );
      expect(policy).toMatchObject({ tool: 'read_file', action: 'confirm_once' });
    });

    it('returns confirm_always for read_file outside workspace', () => {
      const policy = resolveToolPolicy(
        'read_file',
        { path: '/etc/passwd' },
        { workspaceRoots: ['/workspace/project'] },
        {}
      );
      expect(policy).toMatchObject({ tool: 'read_file', action: 'confirm_always' });
    });

    it('returns confirm_always for read_file when no workspace roots configured', () => {
      const policy = resolveToolPolicy('read_file', { path: '/some/file.txt' }, {}, {});
      expect(policy).toMatchObject({ tool: 'read_file', action: 'confirm_always' });
    });

    it('returns confirm_always for run_code', () => {
      const policy = resolveToolPolicy('run_code', {}, {}, {});
      expect(policy).toMatchObject({ tool: 'run_code', action: 'confirm_always' });
    });

    it('returns null for unknown tools', () => {
      const policy = resolveToolPolicy('unknown_tool', {}, {}, {});
      expect(policy).toBeNull();
    });

    it('returns null for web_search (falls through to legacy)', () => {
      const policy = resolveToolPolicy('web_search', {}, {}, {});
      expect(policy).toBeNull();
    });
  });

  describe('resolveToolApprovalDecision', () => {
    it('auto-approves search_workspace via policy engine', () => {
      const result = resolveToolApprovalDecision('search_workspace', {}, {}, {}, undefined);
      expect(result.autoApproved).toBe(true);
      expect(result.policy).toBe('tool_policy:always_allow');
    });

    it('auto-approves list_files via policy engine', () => {
      const result = resolveToolApprovalDecision('list_files', {}, {}, {}, undefined);
      expect(result.autoApproved).toBe(true);
      expect(result.policy).toBe('tool_policy:always_allow');
    });

    it('auto-approves index_workspace via policy engine', () => {
      const result = resolveToolApprovalDecision('index_workspace', {}, {}, {}, undefined);
      expect(result.autoApproved).toBe(true);
      expect(result.policy).toBe('tool_policy:always_allow');
    });

    it('requires confirmation for read_file in workspace on first call', () => {
      const result = resolveToolApprovalDecision(
        'read_file',
        { path: '/workspace/src/index.js' },
        { workspaceRoots: ['/workspace'] },
        undefined,
        'req-1'
      );
      expect(result.autoApproved).toBe(false);
      expect(result.policy).toBe('tool_policy:confirm_once');
    });

    it('auto-approves read_file in workspace after confirm_once', () => {
      markToolConfirmed('req-1', 'read_file');
      const result = resolveToolApprovalDecision(
        'read_file',
        { path: '/workspace/src/index.js' },
        { workspaceRoots: ['/workspace'] },
        undefined,
        'req-1'
      );
      expect(result.autoApproved).toBe(true);
      expect(result.policy).toBe('tool_policy:confirm_once');
    });

    it('always requires confirmation for run_code', () => {
      const result = resolveToolApprovalDecision('run_code', {}, {}, {}, undefined);
      expect(result.autoApproved).toBe(false);
      expect(result.policy).toBe('tool_policy:confirm_always');
    });

    it('falls back to legacy auto_readonly for web_search', () => {
      const result = resolveToolApprovalDecision(
        'web_search',
        { query: 'test' },
        { toolApprovalPolicy: 'auto_readonly' },
        { riskLevel: 'low' },
        undefined
      );
      expect(result.autoApproved).toBe(true);
      expect(result.policy).toBe('auto_readonly');
    });

    it('falls back to legacy confirm_all for unknown tools', () => {
      const result = resolveToolApprovalDecision('unknown_tool', {}, {}, {}, undefined);
      expect(result.autoApproved).toBe(false);
      expect(result.policy).toBe('confirm_all');
    });
  });

  describe('buildToolSecurity', () => {
    it('includes toolPolicy metadata for search_workspace', () => {
      const security = buildToolSecurity('search_workspace', {}, {});
      expect(security.toolPolicy).toBe('always_allow');
    });

    it('includes toolPolicy metadata for run_code', () => {
      const security = buildToolSecurity('run_code', {}, { runCodeEnabled: true });
      expect(security.toolPolicy).toBe('confirm_always');
    });

    it('includes toolPolicyConditions for read_file', () => {
      const security = buildToolSecurity(
        'read_file',
        { path: '/workspace/file.txt' },
        { workspaceRoots: ['/workspace'] }
      );
      expect(security.toolPolicy).toBe('confirm_once');
      expect(security.toolPolicyConditions).toEqual({ workspaceOnly: true });
    });

    it('does not include toolPolicy for unknown tools', () => {
      const security = buildToolSecurity('unknown_tool', {}, {});
      expect(security.toolPolicy).toBeUndefined();
    });
  });

  describe('session confirmations', () => {
    it('tracks confirmed tools per session', () => {
      expect(isToolConfirmedInSession('req-1', 'read_file')).toBe(false);
      markToolConfirmed('req-1', 'read_file');
      expect(isToolConfirmedInSession('req-1', 'read_file')).toBe(true);
    });

    it('isolates confirmations by request id', () => {
      markToolConfirmed('req-1', 'read_file');
      expect(isToolConfirmedInSession('req-2', 'read_file')).toBe(false);
    });

    it('clears all confirmations', () => {
      markToolConfirmed('req-1', 'read_file');
      markToolConfirmed('req-2', 'run_code');
      clearSessionConfirmations();
      expect(isToolConfirmedInSession('req-1', 'read_file')).toBe(false);
      expect(isToolConfirmedInSession('req-2', 'run_code')).toBe(false);
    });
  });

  describe('getToolPolicySummary', () => {
    it('returns a human-readable summary of all policies', () => {
      const summary = getToolPolicySummary({});
      expect(summary.length).toBeGreaterThan(0);
      expect(summary.some((line) => line.includes('search_workspace'))).toBe(true);
      expect(summary.some((line) => line.includes('list_files'))).toBe(true);
      expect(summary.some((line) => line.includes('run_code'))).toBe(true);
      expect(summary.some((line) => line.includes('MCP'))).toBe(true);
    });

    it('includes condition labels', () => {
      const summary = getToolPolicySummary({});
      // read_file is deduplicated; first policy (workspaceOnly: true) wins
      expect(summary.some((line) => line.includes('仅工作区内'))).toBe(true);
    });

    it('includes action labels in Chinese', () => {
      const summary = getToolPolicySummary({});
      expect(summary.some((line) => line.includes('始终允许'))).toBe(true);
      expect(summary.some((line) => line.includes('每会话确认一次'))).toBe(true);
      expect(summary.some((line) => line.includes('每次确认'))).toBe(true);
    });
  });
});
