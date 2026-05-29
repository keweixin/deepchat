/**
 * MCP Drawer — Enhanced MCP server/tool visualization
 */

import { escapeHtml } from './shared-utils.js';

export interface McpToolScope {
  id: string;
  label: string;
  color: string;
  icon: string;
}

export const MCP_TOOL_SCOPES: Readonly<Record<string, McpToolScope>> = Object.freeze({
  read: { id: 'read', label: '读取', color: '#3b82f6', icon: '👁' },
  write: { id: 'write', label: '写入', color: '#f59e0b', icon: '✏' },
  execute: { id: 'execute', label: '执行', color: '#ef4444', icon: '⚡' },
  network: { id: 'network', label: '网络', color: '#8b5cf6', icon: '🌐' },
  unknown: { id: 'unknown', label: '未知', color: '#9ca3af', icon: '❓' },
});

export interface ServerStatus {
  label: string;
  color: string;
  icon: string;
}

export const SERVER_STATUS: Readonly<Record<string, ServerStatus>> = Object.freeze({
  online: { label: '在线', color: '#10b981', icon: '🟢' },
  offline: { label: '离线', color: '#ef4444', icon: '🔴' },
  unknown: { label: '未知', color: '#9ca3af', icon: '⚪' },
  error: { label: '错误', color: '#f59e0b', icon: '🟡' },
});

function inferToolScope(toolName = '', description = ''): McpToolScope {
  const text = `${toolName} ${description}`.toLowerCase();
  if (text.includes('exec') || text.includes('run') || text.includes('shell') || text.includes('command'))
    return MCP_TOOL_SCOPES.execute;
  if (text.includes('fetch') || text.includes('http') || text.includes('url') || text.includes('web'))
    return MCP_TOOL_SCOPES.network;
  if (text.includes('write') || text.includes('create') || text.includes('delete') || text.includes('edit'))
    return MCP_TOOL_SCOPES.write;
  if (text.includes('read') || text.includes('get') || text.includes('list') || text.includes('search'))
    return MCP_TOOL_SCOPES.read;
  return MCP_TOOL_SCOPES.unknown;
}

export function buildServerCard(
  server: Record<string, unknown>,
  stats: Record<string, unknown> = {}
): Record<string, unknown> {
  const status = SERVER_STATUS[String(server.status || '')] || SERVER_STATUS.unknown;
  return {
    id: server.id || server.name,
    name: server.name || server.id,
    status,
    toolCount: (server.toolCount as number) ?? (stats.toolCount as number) ?? 0,
    lastUsed: stats.lastUsed || null,
    avgDurationMs: (stats.avgDurationMs as number) || 0,
    failureRate: (stats.failureRate as number) || 0,
    errorMessage: (server.errorMessage as string) || '',
  };
}

export function buildToolItem(tool: Record<string, unknown>): Record<string, unknown> {
  const scope = inferToolScope(String(tool.name || ''), String(tool.description || ''));
  return {
    name: tool.name,
    description: tool.description || '',
    scope,
    serverId: tool.serverId || '',
    serverName: tool.serverName || '',
  };
}

export function renderServerStatusHtml(serverCard: Record<string, unknown>): string {
  const status = (serverCard.status as ServerStatus) || SERVER_STATUS.unknown;
  const failureRate = (serverCard.failureRate as number) || 0;
  const avgDurationMs = (serverCard.avgDurationMs as number) || 0;
  return `
    <div class="mcp-server-card">
      <div class="mcp-server-header">
        <span class="mcp-server-status" style="color:${status.color}">${status.icon} ${status.label}</span>
        <span class="mcp-server-name">${escapeHtml(String(serverCard.name || ''))}</span>
        <span class="mcp-server-tools">${serverCard.toolCount} 工具</span>
      </div>
      ${serverCard.errorMessage ? `<div class="mcp-server-error">${escapeHtml(String(serverCard.errorMessage))}</div>` : ''}
      <div class="mcp-server-stats">
        ${avgDurationMs ? `<span>平均耗时 ${(avgDurationMs / 1000).toFixed(1)}s</span>` : ''}
        ${failureRate ? `<span style="color:${failureRate > 0.2 ? '#ef4444' : '#f59e0b'}">失败率 ${(failureRate * 100).toFixed(0)}%</span>` : ''}
      </div>
    </div>
  `;
}

export function renderToolListHtml(tools: Array<Record<string, unknown>> = []): string {
  if (!tools.length) return '<div class="mcp-empty">无工具</div>';
  return `
    <div class="mcp-tool-list">
      ${tools
        .map((t) => {
          const item = buildToolItem(t);
          const scope = (item.scope as McpToolScope) || MCP_TOOL_SCOPES.unknown;
          return `
        <div class="mcp-tool-item" title="${escapeHtml(String(item.description || ''))}">
          <span class="mcp-tool-scope" style="color:${scope.color}">${scope.icon}</span>
          <span class="mcp-tool-name">${escapeHtml(String(item.name || ''))}</span>
          <span class="mcp-tool-server">${escapeHtml(String(item.serverName || ''))}</span>
        </div>
        `;
        })
        .join('')}
    </div>
  `;
}

export function renderRecentCallsHtml(calls: Array<Record<string, unknown>> = []): string {
  if (!calls.length) return '<div class="mcp-empty">无最近调用</div>';
  return `
    <div class="mcp-recent-calls">
      ${calls
        .map(
          (c) => `
        <div class="mcp-call-item ${c.success ? 'is-success' : 'is-fail'}">
          <span class="mcp-call-dot"></span>
          <span class="mcp-call-name">${escapeHtml(String(c.toolName || ''))}</span>
          <span class="mcp-call-meta">
            ${c.durationMs ? `${((c.durationMs as number) / 1000).toFixed(1)}s` : ''}
            ${c.error ? `<span class="mcp-call-error">${escapeHtml(String(c.error))}</span>` : ''}
          </span>
          <span class="mcp-call-time">${new Date(c.timestamp as number).toLocaleTimeString()}</span>
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

export function computeCallStats(calls: Array<Record<string, unknown>> = []): {
  total: number;
  successCount: number;
  failCount: number;
  failureRate: number;
  avgDurationMs: number;
} {
  const total = calls.length;
  if (total === 0) return { total: 0, successCount: 0, failCount: 0, failureRate: 0, avgDurationMs: 0 };

  const successCount = calls.filter((c) => c.success).length;
  const failCount = total - successCount;
  const failureRate = failCount / total;
  const durations = calls.filter((c) => (c.durationMs as number) > 0).map((c) => c.durationMs as number);
  const avgDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

  return { total, successCount, failCount, failureRate, avgDurationMs };
}
