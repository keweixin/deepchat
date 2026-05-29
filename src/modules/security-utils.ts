/**
 * Security Utils — Risk assessment and execution safety for tool calls
 */

export interface RiskLevel {
  id: string;
  label: string;
  color: string;
  needsApproval: boolean;
}

export const RISK_LEVELS: Record<string, RiskLevel> = Object.freeze({
  none: { id: 'none', label: '无风险', color: '#10b981', needsApproval: false },
  low: { id: 'low', label: '低风险', color: '#3b82f6', needsApproval: false },
  medium: { id: 'medium', label: '中风险', color: '#f59e0b', needsApproval: true },
  high: { id: 'high', label: '高风险', color: '#ef4444', needsApproval: true },
  critical: { id: 'critical', label: '极高风险', color: '#7f1d1d', needsApproval: true },
});

interface DangerPattern {
  pattern: RegExp;
  risk: string;
  reason: string;
}

const DANGEROUS_PATTERNS: DangerPattern[] = [
  { pattern: /rm\s+-rf\s+[/~]|del\s+\/f\/s\/q|format\s+/i, risk: 'critical', reason: '破坏性文件操作' },
  { pattern: /curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|Invoke-Expression/i, risk: 'critical', reason: '远程代码执行' },
  { pattern: /eval\s*\(|exec\s*\(|system\s*\(|subprocess\.call/i, risk: 'high', reason: '动态代码执行' },
  { pattern: /sudo|chmod\s+777|chown\s+root|reg\s+add/i, risk: 'high', reason: '系统权限操作' },
  { pattern: /fetch\s*\(|XMLHttpRequest|axios\.|request\(/i, risk: 'medium', reason: '网络请求' },
  { pattern: /writeFile|fs\.write|\.save\(|\.download\(/i, risk: 'medium', reason: '文件写入' },
  { pattern: /child_process|spawn\s*\(|fork\s*\(/i, risk: 'high', reason: '子进程创建' },
];

export interface RiskResult extends RiskLevel {
  reason: string;
  baseline: string;
  triggeredPattern?: string;
}

export function assessToolRisk(toolName: string, args: Record<string, unknown> = {}): RiskResult {
  const name = String(toolName || '').toLowerCase();
  const code = String(args.code || args.command || args.script || args.input || '');

  // Start with tool-name-based baseline
  let baseline = RISK_LEVELS.low;
  if (name.includes('run_code') || name.includes('execute') || name.includes('shell')) {
    baseline = RISK_LEVELS.high;
  } else if (name.includes('write') || name.includes('edit') || name.includes('create') || name.includes('delete')) {
    baseline = RISK_LEVELS.medium;
  } else if (name.includes('read') || name.includes('search') || name.includes('list')) {
    baseline = RISK_LEVELS.low;
  }

  // Check dangerous patterns in code
  for (const { pattern, risk, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      return {
        ...RISK_LEVELS[risk],
        reason,
        baseline: baseline.id,
        triggeredPattern: pattern.source.slice(0, 50),
      };
    }
  }

  return { ...baseline, reason: '常规操作', baseline: baseline.id };
}

export interface ApprovalPolicy {
  autoApprove?: string[];
  neverApprove?: string[];
  minRiskLevel?: string;
}

export interface ApprovalCheck {
  needsApproval: boolean;
  risk: RiskResult;
  reason: string;
}

export function checkApprovalRequired(
  toolName: string,
  args: Record<string, unknown> = {},
  policy: ApprovalPolicy = {}
): ApprovalCheck {
  const risk = assessToolRisk(toolName, args);
  const { autoApprove = [], neverApprove = [], minRiskLevel = 'medium' } = policy;

  const name = String(toolName || '').toLowerCase();

  // Never-auto-approve list wins
  if (neverApprove.some((n) => name.includes(n))) {
    return { needsApproval: true, risk, reason: '策略禁止自动通过' };
  }

  // Auto-approve list
  if (autoApprove.some((n) => name.includes(n))) {
    return { needsApproval: false, risk, reason: '策略自动通过' };
  }

  // Risk-level threshold
  const levelOrder = ['none', 'low', 'medium', 'high', 'critical'];
  if (levelOrder.indexOf(risk.id) >= levelOrder.indexOf(minRiskLevel)) {
    return { needsApproval: true, risk, reason: `风险等级达到 ${risk.label}` };
  }

  return { needsApproval: false, risk, reason: '低风险，自动通过' };
}

export function sanitizeCodePreview(code: string, maxLen = 500): string {
  if (!code) return '';
  let s = String(code);
  // Strip ANSI escape codes
  s = s.replace(/\u001b\[[0-9;]*m/g, '');
  // Truncate
  if (s.length > maxLen) s = s.slice(0, maxLen) + '…';
  return s;
}

export interface ExecutionTrace {
  toolName: string;
  args: unknown;
  risk: RiskResult;
  approved: boolean;
  autoApproved: boolean;
  durationMs: number;
  ok: boolean;
  error: string | null;
  outputPreview: string;
  timestamp: number;
}

export function buildExecutionTrace(
  toolCall: { name: string; args: unknown; approved: boolean; autoApproved: boolean },
  result: Record<string, unknown> = {}
): ExecutionTrace {
  return {
    toolName: toolCall.name,
    args: toolCall.args,
    risk: assessToolRisk(toolCall.name, toolCall.args as Record<string, unknown>),
    approved: toolCall.approved,
    autoApproved: toolCall.autoApproved,
    durationMs: (result.durationMs as number) || 0,
    ok: (result.ok as boolean) ?? true,
    error: (result.error as string) || null,
    outputPreview: sanitizeCodePreview(result.output as string, 1000),
    timestamp: Date.now(),
  };
}
