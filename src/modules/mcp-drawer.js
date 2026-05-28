/**
 * MCP Drawer — Enhanced MCP server/tool visualization
 *
 * Features:
 * - Server online status indicator
 * - Tool list with scope icons
 * - Recent call log
 * - Failure rate / average duration stats
 * - Per-workspace policy config
 */

export const MCP_TOOL_SCOPES = Object.freeze({
  read: { id: 'read', label: '读取', color: '#3b82f6', icon: '👁' },
  write: { id: 'write', label: '写入', color: '#f59e0b', icon: '✏' },
  execute: { id: 'execute', label: '执行', color: '#ef4444', icon: '⚡' },
  network: { id: 'network', label: '网络', color: '#8b5cf6', icon: '🌐' },
  unknown: { id: 'unknown', label: '未知', color: '#9ca3af', icon: '❓' },
});

export const SERVER_STATUS = Object.freeze({
  online: { label: '在线', color: '#10b981', icon: '🟢' },
  offline: { label: '离线', color: '#ef4444', icon: '🔴' },
  unknown: { label: '未知', color: '#9ca3af', icon: '⚪' },
  error: { label: '错误', color: '#f59e0b', icon: '🟡' },
});

function inferToolScope(toolName = '', description = '') {
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

/**
 * Build MCP server status card data
 * @param {Object} server
 * @param {Object} [stats]
 * @returns {Object}
 */
export function buildServerCard(server, stats = {}) {
  const status = SERVER_STATUS[server.status] || SERVER_STATUS.unknown;
  return {
    id: server.id || server.name,
    name: server.name || server.id,
    status,
    toolCount: server.toolCount ?? stats.toolCount ?? 0,
    lastUsed: stats.lastUsed || null,
    avgDurationMs: stats.avgDurationMs || 0,
    failureRate: stats.failureRate || 0,
    errorMessage: server.errorMessage || '',
  };
}

/**
 * Build tool item data
 * @param {Object} tool
 * @returns {Object}
 */
export function buildToolItem(tool) {
  const scope = inferToolScope(tool.name, tool.description);
  return {
    name: tool.name,
    description: tool.description || '',
    scope,
    serverId: tool.serverId || '',
    serverName: tool.serverName || '',
  };
}

/**
 * Render server status as HTML
 * @param {Object} serverCard
 * @returns {string}
 */
export function renderServerStatusHtml(serverCard) {
  const { status, failureRate, avgDurationMs } = serverCard;
  return `
    <div class="mcp-server-card">
      <div class="mcp-server-header">
        <span class="mcp-server-status" style="color:${status.color}">${status.icon} ${status.label}</span>
        <span class="mcp-server-name">${escapeHtml(serverCard.name)}</span>
        <span class="mcp-server-tools">${serverCard.toolCount} 工具</span>
      </div>
      ${serverCard.errorMessage ? `<div class="mcp-server-error">${escapeHtml(serverCard.errorMessage)}</div>` : ''}
      <div class="mcp-server-stats">
        ${avgDurationMs ? `<span>平均耗时 ${(avgDurationMs / 1000).toFixed(1)}s</span>` : ''}
        ${failureRate ? `<span style="color:${failureRate > 0.2 ? '#ef4444' : '#f59e0b'}">失败率 ${(failureRate * 100).toFixed(0)}%</span>` : ''}
      </div>
    </div>
  `;
}

/**
 * Render tool list as HTML
 * @param {Array} tools
 * @returns {string}
 */
export function renderToolListHtml(tools = []) {
  if (!tools.length) return '<div class="mcp-empty">无工具</div>';
  return `
    <div class="mcp-tool-list">
      ${tools
        .map((t) => {
          const item = buildToolItem(t);
          return `
        <div class="mcp-tool-item" title="${escapeHtml(item.description)}">
          <span class="mcp-tool-scope" style="color:${item.scope.color}">${item.scope.icon}</span>
          <span class="mcp-tool-name">${escapeHtml(item.name)}</span>
          <span class="mcp-tool-server">${escapeHtml(item.serverName)}</span>
        </div>
        `;
        })
        .join('')}
    </div>
  `;
}

/**
 * Render recent calls log
 * @param {Array} calls — { toolName, success, durationMs, timestamp, error }
 * @returns {string}
 */
export function renderRecentCallsHtml(calls = []) {
  if (!calls.length) return '<div class="mcp-empty">无最近调用</div>';
  return `
    <div class="mcp-recent-calls">
      ${calls
        .map(
          (c) => `
        <div class="mcp-call-item ${c.success ? 'is-success' : 'is-fail'}">
          <span class="mcp-call-dot"></span>
          <span class="mcp-call-name">${escapeHtml(c.toolName)}</span>
          <span class="mcp-call-meta">
            ${c.durationMs ? `${(c.durationMs / 1000).toFixed(1)}s` : ''}
            ${c.error ? `<span class="mcp-call-error">${escapeHtml(c.error)}</span>` : ''}
          </span>
          <span class="mcp-call-time">${new Date(c.timestamp).toLocaleTimeString()}</span>
        </div>
      `
        )
        .join('')}
    </div>
  `;
}

/**
 * Compute statistics from call history
 * @param {Array} calls
 * @returns {{total: number, successCount: number, failCount: number, failureRate: number, avgDurationMs: number}}
 */
export function computeCallStats(calls = []) {
  const total = calls.length;
  if (total === 0) return { total: 0, successCount: 0, failCount: 0, failureRate: 0, avgDurationMs: 0 };

  const successCount = calls.filter((c) => c.success).length;
  const failCount = total - successCount;
  const failureRate = failCount / total;
  const durations = calls.filter((c) => c.durationMs > 0).map((c) => c.durationMs);
  const avgDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

  return { total, successCount, failCount, failureRate, avgDurationMs };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
