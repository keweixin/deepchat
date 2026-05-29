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

/**
 * Determine whether a tool call should be auto-approved based on policy and security.
 *
 * @param {string} name
 * @param {any} [args]
 * @param {any} [settings]
 * @param {ToolSecurity} [security]
 * @returns {ApprovalResult}
 */
function resolveToolApprovalDecision(name, args, settings, security) {
  const _args = args || {};
  const _settings = settings || {};
  const _security = security !== undefined ? security : buildToolSecurity(name, _args, _settings);
  const policy = normalizeToolApprovalPolicy(_settings.toolApprovalPolicy);
  if (policy !== 'auto_readonly') return { policy, autoApproved: false, reason: '' };
  if (!isAutoApprovableReadOnlyTool(name, _security)) return { policy, autoApproved: false, reason: '' };
  return {
    policy,
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
    ['web_search', 'index_workspace', 'list_files', 'search_workspace', 'read_symbol', 'read_file'].includes(name) &&
    ['low', 'medium'].includes(String(_security.riskLevel || 'unknown'))
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
  if (name === 'run_code') {
    return {
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
  }
  if (name === 'read_file') {
    return {
      riskLevel: 'medium',
      path: String(_args.path || ''),
      startLine: _args.start_line || null,
      endLine: _args.end_line || null,
      sensitiveDenylist: true,
      redaction: true,
    };
  }
  if (name === 'read_symbol') {
    return {
      riskLevel: 'medium',
      symbol: String(_args.symbol || ''),
      directory: String(_args.directory || ''),
      pattern: String(_args.pattern || ''),
      sensitiveDenylist: true,
      redaction: true,
    };
  }
  if (name === 'search_workspace') {
    return {
      riskLevel: 'medium',
      query: String(_args.query || ''),
      directory: String(_args.directory || ''),
      sensitiveDenylist: true,
      redaction: true,
    };
  }
  if (name === 'web_search') return { riskLevel: 'low', network: 'https', query: String(_args.query || '') };
  if (isMcpToolName(name)) return { riskLevel: 'external', mcp: true };
  return { riskLevel: 'unknown' };
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
  return ['web_search', 'list_files', 'search_workspace', 'read_symbol', 'read_file'].includes(name);
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
  DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
  DEFAULT_TOOL_APPROVAL_POLICY,
  CODE_RUN_TIMEOUT_MS,
};
