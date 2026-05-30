// @ts-check

import { isMcpToolName } from './mcp-manager.js';
import { clampNumber } from './usage-meter.js';

const DEFAULT_TOOL_APPROVAL_TIMEOUT_MS = 60000;
const DEFAULT_TOOL_APPROVAL_POLICY = 'confirm_all';
const CODE_RUN_TIMEOUT_MS = 5000;

/**
 * @typedef {{ approved: boolean; timedOut?: boolean }} ApprovalDecision
 * @typedef {{ resolve: (decision: ApprovalDecision) => void; cleanup: () => void }} PendingApproval
 * @typedef {{ riskLevel?: string }} ToolSecurity
 * @typedef {{ policy: string; autoApproved: boolean; reason: string }} ApprovalResult
 * @typedef {{ tool: string; action: 'always_allow' | 'confirm_once' | 'confirm_always' | 'deny'; conditions?: Record<string, unknown> }} ToolPolicy
 */

/**
 * Wait for a user's tool-call approval, with timeout and abort support.
 *
 * @param {string} requestId
 * @param {string} toolCallId
 * @param {AbortSignal} signal
 * @param {Map<string, PendingApproval>} pendingApprovals
 * @param {number} [timeoutMs]
 * @returns {Promise<ApprovalDecision>}
 */
function waitForApproval(
  requestId,
  toolCallId,
  signal,
  pendingApprovals,
  timeoutMs = DEFAULT_TOOL_APPROVAL_TIMEOUT_MS
) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ approved: false });
      return;
    }

    const key = `${requestId}:${toolCallId}`;
    let settled = false;
    const cleanup = () => {
      pendingApprovals.delete(key);
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };
    const finish = (/** @type {ApprovalDecision} */ decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };
    const onAbort = () => {
      finish({ approved: false });
    };
    const timer = setTimeout(() => {
      finish({ approved: false, timedOut: true });
    }, timeoutMs);
    pendingApprovals.set(key, { resolve: finish, cleanup });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeToolApprovalPolicy(value) {
  return String(value || DEFAULT_TOOL_APPROVAL_POLICY) === 'auto_readonly'
    ? 'auto_readonly'
    : DEFAULT_TOOL_APPROVAL_POLICY;
}

/** @type {ToolPolicy[]} */
const DEFAULT_TOOL_POLICIES = [
  { tool: 'search_workspace', action: 'always_allow' },
  { tool: 'list_files', action: 'always_allow' },
  { tool: 'index_workspace', action: 'always_allow' },
  { tool: 'project_map', action: 'always_allow' },
  { tool: 'git_status', action: 'always_allow' },
  { tool: 'git_diff', action: 'always_allow' },
  { tool: 'git_log', action: 'always_allow' },
  { tool: 'read_file', action: 'confirm_once', conditions: { workspaceOnly: true } },
  { tool: 'read_file', action: 'confirm_always', conditions: { workspaceOnly: false } },
  { tool: 'read_symbol', action: 'confirm_once', conditions: { workspaceOnly: true } },
  { tool: 'read_many_files', action: 'confirm_once', conditions: { workspaceOnly: true } },
  { tool: 'read_many_files', action: 'confirm_always', conditions: { workspaceOnly: false } },
  { tool: 'run_code', action: 'confirm_always' },
  { tool: '__mcp__', action: 'confirm_always' },
];

/**
 * Session-scoped store for tools that have been confirmed once.
 * Keyed by `${requestId}:${toolName}`.
 * @type {Set<string>}
 */
const confirmedOnceTools = new Set();

/**
 * Build a session key for confirm_once tracking.
 *
 * @param {string} requestId
 * @param {string} toolName
 * @returns {string}
 */
function buildSessionKey(requestId, toolName) {
  return `${requestId}:${toolName}`;
}

/**
 * Mark a tool as confirmed for the current session.
 *
 * @param {string} requestId
 * @param {string} toolName
 */
function markToolConfirmed(requestId, toolName) {
  confirmedOnceTools.add(buildSessionKey(requestId, toolName));
}

/**
 * Check whether a tool has already been confirmed in the current session.
 *
 * @param {string} requestId
 * @param {string} toolName
 * @returns {boolean}
 */
function isToolConfirmedInSession(requestId, toolName) {
  return confirmedOnceTools.has(buildSessionKey(requestId, toolName));
}

/**
 * Clear all session confirmations (e.g. on session end).
 */
function clearSessionConfirmations() {
  confirmedOnceTools.clear();
}

/**
 * Determine whether a file path is inside the workspace roots.
 *
 * @param {string} filePath
 * @param {any} [settings]
 * @returns {boolean}
 */
function isPathInWorkspace(filePath, settings) {
  if (!filePath) return false;
  const roots = (settings && settings.workspaceRoots) || [];
  if (roots.length === 0) return false;
  const normalized = String(filePath).replace(/\\/g, '/');
  return roots.some((/** @type {string} */ root) => {
    const normalizedRoot = String(root).replace(/\\/g, '/');
    return normalized.startsWith(normalizedRoot + '/') || normalized === normalizedRoot;
  });
}

/**
 * Check whether tool conditions match the current context.
 *
 * @param {Record<string, unknown>} conditions
 * @param {string} name
 * @param {any} args
 * @param {any} settings
 * @param {any} security
 * @returns {boolean}
 */
function matchesConditions(conditions, name, args, settings, security) {
  if (conditions.workspaceOnly !== undefined) {
    const inWorkspace = isPathInWorkspace(String(args.path || ''), settings);
    if (conditions.workspaceOnly && !inWorkspace) return false;
    if (!conditions.workspaceOnly && inWorkspace) return false;
  }
  if (conditions.readOnly !== undefined) {
    const toolIsReadOnly = !['run_code', 'write_file', 'edit_file'].includes(name);
    if (conditions.readOnly !== toolIsReadOnly) return false;
  }
  if (conditions.riskLevel !== undefined) {
    const toolRisk = String(security.riskLevel || 'unknown');
    if (toolRisk !== conditions.riskLevel) return false;
  }
  return true;
}

/**
 * Resolve the matching policy for a given tool, considering conditions.
 * Policies are evaluated in order; the first match wins.
 *
 * @param {string} name
 * @param {any} [args]
 * @param {any} [settings]
 * @param {ToolSecurity} [security]
 * @returns {ToolPolicy | null}
 */
function resolveToolPolicy(name, args, settings, security) {
  const _args = args || {};
  const _settings = settings || {};
  const _security = security || {};

  for (const policy of DEFAULT_TOOL_POLICIES) {
    if (policy.tool === '__mcp__' && isMcpToolName(name)) return policy;
    if (policy.tool !== name) continue;

    if (!policy.conditions) return policy;
    if (matchesConditions(policy.conditions, name, _args, _settings, _security)) return policy;
  }

  return null;
}

/**
 * Format a human-readable label for tool policy conditions.
 *
 * @param {Record<string, unknown>} conditions
 * @returns {string}
 */
function formatConditionsLabel(conditions) {
  const parts = [];
  if (conditions.workspaceOnly === true) parts.push('仅工作区内');
  if (conditions.workspaceOnly === false) parts.push('工作区外');
  if (conditions.readOnly === true) parts.push('只读');
  if (conditions.riskLevel) parts.push(`风险等级=${conditions.riskLevel}`);
  return parts.length > 0 ? `（${parts.join('，')}）` : '';
}

/**
 * Get a human-readable summary of active tool policies.
 *
 * @param {any} [settings]
 * @returns {string[]}
 */
function getToolPolicySummary(settings) {
  /** @type {string[]} */
  const lines = [];
  const seen = new Set();

  for (const policy of DEFAULT_TOOL_POLICIES) {
    const label = policy.tool === '__mcp__' ? 'MCP 工具 (外部)' : policy.tool;
    if (seen.has(label)) continue;
    seen.add(label);

    const actionLabels = {
      always_allow: '始终允许',
      confirm_once: '每会话确认一次',
      confirm_always: '每次确认',
      deny: '拒绝',
    };
    const actionLabel = actionLabels[policy.action] || policy.action;
    let conditionLabel = '';
    if (policy.conditions) {
      conditionLabel = formatConditionsLabel(policy.conditions);
    }
    lines.push(`${label}：${actionLabel}${conditionLabel}`);
  }

  return lines;
}

/**
 * Determine whether a tool call should be auto-approved based on policy and security.
 *
 * @param {string} name
 * @param {any} [args]
 * @param {any} [settings]
 * @param {ToolSecurity} [security]
 * @param {string} [requestId]
 * @returns {ApprovalResult}
 */
function resolveToolApprovalDecision(name, args, settings, security, requestId) {
  const _args = args || {};
  const _settings = settings || {};
  const _security = security !== undefined ? security : buildToolSecurity(name, _args, _settings);
  const approvalPolicy = normalizeToolApprovalPolicy(_settings.toolApprovalPolicy);

  // --- Per-tool policy engine ---
  const toolPolicy = resolveToolPolicy(name, _args, _settings, _security);
  if (toolPolicy) {
    if (toolPolicy.action === 'deny') {
      return { policy: `tool_policy:${toolPolicy.action}`, autoApproved: false, reason: `工具 ${name} 已被策略拒绝。` };
    }
    if (toolPolicy.action === 'always_allow') {
      return {
        policy: `tool_policy:${toolPolicy.action}`,
        autoApproved: true,
        reason: `工具 ${name} 已按策略自动通过。`,
      };
    }
    if (toolPolicy.action === 'confirm_once' && requestId) {
      if (isToolConfirmedInSession(requestId, name)) {
        return {
          policy: `tool_policy:${toolPolicy.action}`,
          autoApproved: true,
          reason: `工具 ${name} 已在本会话中确认过，自动通过。`,
        };
      }
      // First time in session — fall through to user confirmation
      return {
        policy: `tool_policy:${toolPolicy.action}`,
        autoApproved: false,
        reason: `工具 ${name} 需要首次确认（本会话后续调用将自动通过）。`,
      };
    }
    if (toolPolicy.action === 'confirm_always') {
      return { policy: `tool_policy:${toolPolicy.action}`, autoApproved: false, reason: '' };
    }
    if (toolPolicy.action === 'confirm_once') {
      // No requestId available — treat as requiring confirmation
      return { policy: `tool_policy:${toolPolicy.action}`, autoApproved: false, reason: '' };
    }
  }

  // --- Legacy fallback ---
  if (approvalPolicy !== 'auto_readonly') return { policy: approvalPolicy, autoApproved: false, reason: '' };
  if (!isAutoApprovableReadOnlyTool(name, _security))
    return { policy: approvalPolicy, autoApproved: false, reason: '' };
  return {
    policy: approvalPolicy,
    autoApproved: true,
    reason: `已按审批策略自动通过低风险读取/搜索工具：${name}。`,
  };
}

/**
 * Check whether a tool is read-only and eligible for auto-approval.
 *
 * @param {string} name
 * @param {any} [security]
 * @returns {boolean}
 */
function isAutoApprovableReadOnlyTool(name, security) {
  const _security = security || {};
  if (isMcpToolName(name) || name === 'run_code') return false;
  return (
    [
      'web_search',
      'index_workspace',
      'list_files',
      'search_workspace',
      'read_symbol',
      'read_file',
      'project_map',
      'git_status',
      'git_diff',
      'git_log',
    ].includes(name) && ['low', 'medium'].includes(String(_security.riskLevel || 'unknown'))
  );
}

/**
 * Build security metadata for a tool call.
 *
 * @param {string} name
 * @param {any} [args]
 * @param {any} [settings]
 * @returns {Record<string, unknown>}
 */
function buildToolSecurity(name, args, settings) {
  const _args = args || {};
  const _settings = settings || {};
  let base;
  if (name === 'run_code') {
    base = {
      riskLevel: 'high',
      language: String(_args.language || ''),
      codeLength: String(_args.code || '').length,
      timeoutMs: CODE_RUN_TIMEOUT_MS,
      sandbox: process.platform === 'win32' ? 'windows-light' : `${process.platform}-light`,
      envPolicy: 'minimal-allowlist-redacted',
      isolatedCwd: true,
      network: 'not-hard-blocked',
      enabled: _settings.runCodeEnabled !== false && _settings.runCodeEnabled !== 'false',
    };
  } else if (name === 'read_file') {
    base = {
      riskLevel: 'medium',
      path: String(_args.path || ''),
      startLine: _args.start_line || null,
      endLine: _args.end_line || null,
      sensitiveDenylist: true,
      redaction: true,
    };
  } else if (name === 'read_symbol') {
    base = {
      riskLevel: 'medium',
      symbol: String(_args.symbol || ''),
      directory: String(_args.directory || ''),
      pattern: String(_args.pattern || ''),
      sensitiveDenylist: true,
      redaction: true,
    };
  } else if (name === 'search_workspace') {
    base = {
      riskLevel: 'medium',
      query: String(_args.query || ''),
      directory: String(_args.directory || ''),
      sensitiveDenylist: true,
      redaction: true,
    };
  } else if (name === 'project_map') {
    base = {
      riskLevel: 'low',
      directory: String(_args.directory || ''),
      maxDepth: _args.maxDepth || 4,
      sensitiveDenylist: true,
    };
  } else if (name === 'git_status') {
    base = { riskLevel: 'low', readOnly: true, vcs: 'git' };
  } else if (name === 'git_diff') {
    base = {
      riskLevel: 'low',
      readOnly: true,
      vcs: 'git',
      file: String(_args.file || ''),
      staged: Boolean(_args.staged),
    };
  } else if (name === 'git_log') {
    base = {
      riskLevel: 'low',
      readOnly: true,
      vcs: 'git',
      file: String(_args.file || ''),
      count: _args.count || 10,
    };
  } else if (name === 'read_many_files') {
    base = {
      riskLevel: 'medium',
      paths: Array.isArray(_args.paths) ? _args.paths : [],
      sensitiveDenylist: true,
      redaction: true,
    };
  } else if (name === 'web_search') {
    base = { riskLevel: 'low', network: 'https', query: String(_args.query || '') };
  } else if (isMcpToolName(name)) {
    base = { riskLevel: 'external', mcp: true };
  } else {
    base = { riskLevel: 'unknown' };
  }

  // Attach policy metadata
  const toolPolicy = resolveToolPolicy(name, _args, _settings, base);
  if (toolPolicy) {
    base.toolPolicy = toolPolicy.action;
    if (toolPolicy.conditions) base.toolPolicyConditions = toolPolicy.conditions;
  }

  return base;
}

/**
 * Check whether a tool call is safe to run in parallel with others.
 *
 * @param {any} [toolCall]
 * @returns {boolean}
 */
function isParallelSafeToolCall(toolCall) {
  const _toolCall = toolCall || {};
  const name = String(_toolCall.function?.name || '');
  return [
    'web_search',
    'list_files',
    'search_workspace',
    'read_symbol',
    'read_file',
    'project_map',
    'git_status',
    'git_diff',
    'git_log',
  ].includes(name);
}

/**
 * Resolve the tool approval timeout from settings.
 *
 * @param {any} [settings]
 * @returns {number}
 */
function resolveToolApprovalTimeout(settings) {
  const _settings = settings || {};
  return Math.round(clampNumber(_settings.toolApprovalTimeoutMs, 5000, 300000, DEFAULT_TOOL_APPROVAL_TIMEOUT_MS));
}

export {
  waitForApproval,
  normalizeToolApprovalPolicy,
  resolveToolApprovalDecision,
  isAutoApprovableReadOnlyTool,
  buildToolSecurity,
  isParallelSafeToolCall,
  resolveToolApprovalTimeout,
  resolveToolPolicy,
  markToolConfirmed,
  isToolConfirmedInSession,
  clearSessionConfirmations,
  getToolPolicySummary,
  DEFAULT_TOOL_POLICIES,
  DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
  DEFAULT_TOOL_APPROVAL_POLICY,
  CODE_RUN_TIMEOUT_MS,
};
