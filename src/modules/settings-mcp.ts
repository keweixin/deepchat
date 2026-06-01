/**
 * Settings MCP utilities — MCP server list rendering, form parsing, status actions
 */

import { copyToClipboard, showToast, uid } from './utils.js';
import { hasNativeBridge } from './api.js';
import { listMcpStatus } from './client-store.ts';
import { renderEmptyList, SettingsElements } from './settings-dom.js';

export function renderMcpServerList(
  container: HTMLElement | null,
  servers: Record<string, any>[] = [],
  onChange: ((servers: Record<string, any>[]) => void) | null = null,
  statuses: Record<string, any>[] = []
) {
  if (!container) return;
  container.textContent = '';
  if (!servers.length) {
    renderEmptyList(container, '尚未配置 MCP Server', '添加 stdio server 后可在 MCP/全工具模式调用');
    return;
  }
  const statusMap = new Map((statuses || []).map((status) => [status.id, status]));
  for (const server of servers) {
    const status = statusMap.get(server.id);
    const item = document.createElement('div');
    item.className = 'workspace-item column';
    const main = document.createElement('div');
    main.className = 'workspace-item-main';
    const name = document.createElement('span');
    name.textContent = server.name || 'MCP Server';
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'icon-btn-sm';
    toggle.textContent = server.enabled === false ? '启用' : '停用';
    toggle.addEventListener('click', () => {
      onChange?.(servers.map((item) => (item.id === server.id ? { ...item, enabled: item.enabled === false } : item)));
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn-sm';
    remove.textContent = '移除';
    remove.addEventListener('click', () => onChange?.(servers.filter((item) => item.id !== server.id)));
    actions.append(toggle, remove);
    main.append(name, actions);
    const meta = document.createElement('div');
    meta.className = 'workspace-item-meta';
    const toolCount = status?.toolCount ?? status?.tools?.length ?? 0;
    const schemaText = status?.schemaHash ? ` · schema ${shortHash(status.schemaHash)}` : '';
    const toolText = status?.ok
      ? toolCount > 0
        ? `工具 ${toolCount} 个${schemaText}`
        : '连接成功，但没有工具'
      : status?.error || '未测试';
    const envText = server.inheritEnv ? '继承系统环境' : '只传安全环境';
    const cwdText = server.cwd ? ` · cwd ${server.cwd}` : '';
    meta.textContent = `${server.enabled === false ? '停用' : '启用'} · ${server.command} ${(server.args || []).join(' ')}${cwdText} · ${envText} · ${toolText}`;
    item.append(main, meta);
    if (status) {
      const detail = document.createElement('details');
      detail.className = 'mcp-status-detail';
      const summary = document.createElement('summary');
      summary.textContent = status.ok
        ? `查看工具列表${status.schemaHash ? ` · ${shortHash(status.schemaHash)}` : ''}`
        : '查看错误详情';
      const body = document.createElement('div');
      body.className = 'mcp-status-body';
      if (status.ok && status.tools.length) {
        const toolbar = document.createElement('div');
        toolbar.className = 'mcp-status-toolbar';
        const schema = document.createElement('span');
        schema.className = 'mcp-schema-badge';
        schema.textContent = status.schemaHash ? `schema ${shortHash(status.schemaHash)}` : 'schema 未知';
        schema.title = status.schemaHash
          ? `完整 schema hash：${status.schemaHash}`
          : 'MCP Server 未返回可计算 schema。';
        const ttl = document.createElement('span');
        ttl.className = 'mcp-schema-badge';
        ttl.textContent = `缓存 TTL ${formatDuration(status.cacheTtlMs)}`;
        ttl.title = status.cacheExpiresAt ? `缓存有效到 ${status.cacheExpiresAt}` : 'MCP 工具定义缓存有效期';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'icon-btn-sm mcp-copy-tools-btn';
        copyBtn.textContent = '复制清单';
        copyBtn.title = '复制当前 MCP 工具清单和 schema hash';
        copyBtn.addEventListener('click', async () => {
          const copied = await copyToClipboard(buildMcpToolsClipboard(server, status));
          showToast(copied ? 'MCP 工具清单已复制' : '复制失败');
        });
        toolbar.append(schema, ttl, copyBtn);
        body.appendChild(toolbar);
        for (const tool of status.tools.slice(0, 12)) {
          const row = document.createElement('div');
          row.className = 'mcp-tool-row';
          row.textContent = `${tool.name}${tool.description ? ` — ${tool.description}` : ''}`;
          row.title = row.textContent;
          body.appendChild(row);
        }
        if (status.tools.length > 12) {
          const more = document.createElement('div');
          more.className = 'mcp-status-meta';
          more.textContent = `还有 ${status.tools.length - 12} 个工具未显示，可复制完整清单查看。`;
          body.appendChild(more);
        }
      } else {
        body.textContent = status.error || '没有返回工具。';
      }
      const hint = getMcpResolutionHint(status);
      if (hint) {
        const hintLine = document.createElement('div');
        hintLine.className = 'mcp-status-hint';
        hintLine.textContent = hint;
        body.appendChild(hintLine);
      }
      const metaLine = document.createElement('div');
      metaLine.className = 'mcp-status-meta';
      metaLine.textContent = [
        `检测时间 ${status.checkedAt || '-'}`,
        status.phase ? `阶段 ${status.phase}` : '',
        `耗时 ${status.durationMs ?? '-'}ms`,
        status.failureReason ? `失败类型 ${formatMcpFailureReason(status.failureReason)}` : '',
        status.cacheExpiresAt ? `缓存到 ${status.cacheExpiresAt}` : '',
        status.inheritEnv ? '环境策略：继承系统环境' : '环境策略：只传安全环境和显式 env',
        status.envKeys?.length ? `显式 env：${status.envKeys.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      body.appendChild(metaLine);
      detail.append(summary, body);
      item.appendChild(detail);
    }
    container.appendChild(item);
  }
}

export function summarizeMcpStatusRefresh(statuses: Record<string, any>[] = []) {
  const rows = Array.isArray(statuses) ? statuses : [];
  if (!rows.length) return '没有配置 MCP Server';
  const ok = rows.filter((status) => status.ok).length;
  const toolCount = rows.reduce((sum, status) => sum + (status.toolCount ?? status.tools?.length ?? 0), 0);
  const schemaCount = new Set(rows.filter((status) => status.schemaHash).map((status) => status.schemaHash)).size;
  return `MCP 已刷新：${ok}/${rows.length} 可用 · ${toolCount} 个工具 · ${schemaCount} 个 schema`;
}

export function emitMcpStatusChanged(statuses: any[] = [], meta: Record<string, any> = {}) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(
    new CustomEvent('deepchat:mcp-status-changed', {
      detail: {
        statuses: Array.isArray(statuses) ? statuses : [],
        stale: Boolean(meta.stale),
      },
    })
  );
}

function shortHash(value: unknown) {
  return String(value || '').slice(0, 8);
}

function formatMcpFailureReason(reason: unknown) {
  const labels: Record<string, string> = {
    command_not_found: '命令不存在',
    cwd_missing: '工作目录不存在',
    env_missing: '缺少环境变量',
    timeout: '超时',
    initialize_failed: '初始化失败',
    failed: '失败',
  };
  return labels[String(reason || '')] || String(reason || '');
}

function getMcpResolutionHint(status: Record<string, any> = {}) {
  if (status.ok && (status.toolCount ?? status.tools?.length ?? 0) === 0) {
    return '修复建议：连接已建立，但 server 没有返回工具；请检查该 MCP server 的 listTools 实现或启动参数。';
  }
  const reason = String(status.failureReason || '');
  if (reason === 'command_not_found')
    return '修复建议：命令不存在。请检查 command 是否在 PATH 中，或改用可执行文件的绝对路径。';
  if (reason === 'cwd_missing') return '修复建议：工作目录不存在。请修正 cwd，或留空使用默认目录。';
  if (reason === 'env_missing')
    return '修复建议：缺少环境变量。DeepChat 不会自动复制 secret，请在 MCP 配置中显式添加需要的 env key。';
  if (reason === 'timeout')
    return '修复建议：server 启动或 initialize 超时。请先在终端运行同一 command/args 确认能正常启动。';
  if (reason === 'initialize_failed')
    return '修复建议：JSON-RPC initialize 失败。请检查 server 是否兼容 MCP stdio 协议。';
  if (status.error) return '修复建议：查看 stderr/错误详情，确认命令、参数、cwd 和 env 后重新测试。';
  return '';
}

function formatDuration(ms: unknown) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '未知';
  if (value < 60000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60000)}m`;
}

function buildMcpToolsClipboard(server: Record<string, any>, status: Record<string, any>) {
  return JSON.stringify(
    {
      server: {
        id: server.id,
        name: server.name,
        command: server.command,
        args: server.args || [],
        cwd: server.cwd || '',
        inheritEnv: server.inheritEnv === true,
        envKeys: Array.isArray(status.envKeys) ? status.envKeys : Object.keys(server.env || {}).sort(),
        enabled: server.enabled !== false,
      },
      ok: Boolean(status.ok),
      schemaHash: status.schemaHash || '',
      toolCount: status.toolCount ?? status.tools?.length ?? 0,
      cacheTtlMs: status.cacheTtlMs || 0,
      cacheExpiresAt: status.cacheExpiresAt || '',
      tools: status.tools || [],
    },
    null,
    2
  );
}

export function readMcpServerForm(els: SettingsElements) {
  if (!els.mcpCommand) throw new Error('请填写 MCP 启动命令。');
  const command = els.mcpCommand.value.trim();
  if (!command) throw new Error('请填写 MCP 启动命令。');
  return {
    id: `mcp_${uid()}`,
    name: (els.mcpName?.value.trim() || command) as string,
    command,
    args: parseMcpArgs(els.mcpArgs?.value),
    env: parseMcpEnv(els.mcpEnv?.value),
    cwd: els.mcpCwd?.value.trim() || '',
    inheritEnv: els.mcpInheritEnv?.checked === true,
    enabled: true,
  };
}

export function parseMcpArgs(value: unknown) {
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  return text.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, '')) || [];
}

export function parseMcpEnv(value: unknown) {
  const text = String(value || '').trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('环境变量必须是 JSON 对象。');
  return parsed;
}

export async function runStatusAction(
  statusEl: HTMLElement | null,
  pendingText: string,
  successText: string | ((result: unknown) => string),
  action: () => Promise<unknown>
) {
  if (!statusEl) return;
  statusEl.textContent = pendingText;
  statusEl.className = 'inline-status';
  try {
    const result = await action();
    statusEl.textContent = typeof successText === 'function' ? successText(result) : successText;
    statusEl.classList.add('ok');
  } catch (error: any) {
    statusEl.textContent = error.message || '失败';
    statusEl.classList.add('error');
  }
}

export async function refreshMcpStatuses() {
  if (!hasNativeBridge()) throw new Error('MCP 只能在桌面版测试。');
  const statuses = await listMcpStatus();
  emitMcpStatusChanged(statuses, { stale: false });
  return statuses;
}

export function markMcpStatusStale(els: SettingsElements, nextSettings: Record<string, any>) {
  emitMcpStatusChanged([], { stale: true });
  renderMcpServerList(els.mcpServerList, nextSettings.mcpServers || [], null, []);
  if (els.mcpStatusText) {
    els.mcpStatusText.textContent = 'MCP 配置已变更，请刷新状态以更新工具 schema 和缓存前缀。';
    els.mcpStatusText.className = 'inline-status';
  }
  return [];
}
