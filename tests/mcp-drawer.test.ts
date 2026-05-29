// @ts-nocheck
/**
 * MCP Drawer Tests
 */

import { describe, it, expect } from 'vitest';
import {
  MCP_TOOL_SCOPES,
  SERVER_STATUS,
  buildServerCard,
  buildToolItem,
  renderServerStatusHtml,
  renderToolListHtml,
  renderRecentCallsHtml,
  computeCallStats,
} from '../src/modules/mcp-drawer.js';

describe('constants', () => {
  it('has tool scopes', () => {
    expect(MCP_TOOL_SCOPES.read.label).toBe('读取');
    expect(MCP_TOOL_SCOPES.execute.label).toBe('执行');
  });

  it('has server statuses', () => {
    expect(SERVER_STATUS.online.label).toBe('在线');
    expect(SERVER_STATUS.offline.label).toBe('离线');
  });
});

describe('buildServerCard', () => {
  it('builds card with online status', () => {
    const card = buildServerCard({ id: 'fs', name: 'Filesystem', status: 'online', toolCount: 5 });
    expect(card.name).toBe('Filesystem');
    expect(card.status.label).toBe('在线');
    expect(card.toolCount).toBe(5);
  });

  it('uses unknown status fallback', () => {
    const card = buildServerCard({ id: 'x' });
    expect(card.status.label).toBe('未知');
  });

  it('includes stats', () => {
    const card = buildServerCard({ id: 'x', name: 'X' }, { avgDurationMs: 1200, failureRate: 0.05 });
    expect(card.avgDurationMs).toBe(1200);
    expect(card.failureRate).toBe(0.05);
  });
});

describe('buildToolItem', () => {
  it('infers read scope', () => {
    const item = buildToolItem({ name: 'read_file', description: 'Read a file' });
    expect(item.scope.id).toBe('read');
  });

  it('infers execute scope', () => {
    const item = buildToolItem({ name: 'run_shell', description: 'Run a command' });
    expect(item.scope.id).toBe('execute');
  });

  it('infers network scope', () => {
    const item = buildToolItem({ name: 'fetch_url', description: 'Fetch a URL' });
    expect(item.scope.id).toBe('network');
  });

  it('infers write scope', () => {
    const item = buildToolItem({ name: 'write_file', description: 'Write content' });
    expect(item.scope.id).toBe('write');
  });

  it('defaults to unknown scope', () => {
    const item = buildToolItem({ name: 'foo', description: 'bar' });
    expect(item.scope.id).toBe('unknown');
  });
});

describe('renderServerStatusHtml', () => {
  it('renders server card HTML', () => {
    const html = renderServerStatusHtml(
      buildServerCard({ id: 'fs', name: 'Filesystem', status: 'online', toolCount: 3 })
    );
    expect(html).toContain('Filesystem');
    expect(html).toContain('3 工具');
  });

  it('renders error message if present', () => {
    const html = renderServerStatusHtml(
      buildServerCard({ id: 'fs', name: 'FS', status: 'error', errorMessage: 'timeout' })
    );
    expect(html).toContain('timeout');
  });
});

describe('renderToolListHtml', () => {
  it('renders tool list', () => {
    const html = renderToolListHtml([{ name: 'read_file', description: 'Read' }]);
    expect(html).toContain('read_file');
  });

  it('renders empty state', () => {
    const html = renderToolListHtml([]);
    expect(html).toContain('无工具');
  });
});

describe('renderRecentCallsHtml', () => {
  it('renders call log', () => {
    const html = renderRecentCallsHtml([
      { toolName: 'read_file', success: true, durationMs: 500, timestamp: Date.now() },
    ]);
    expect(html).toContain('read_file');
    expect(html).toContain('0.5s');
  });

  it('renders empty state', () => {
    const html = renderRecentCallsHtml([]);
    expect(html).toContain('无最近调用');
  });
});

describe('computeCallStats', () => {
  it('returns zeros for empty calls', () => {
    const stats = computeCallStats([]);
    expect(stats.total).toBe(0);
    expect(stats.failureRate).toBe(0);
  });

  it('computes success rate', () => {
    const stats = computeCallStats([
      { success: true, durationMs: 100 },
      { success: true, durationMs: 200 },
      { success: false, durationMs: 50 },
    ]);
    expect(stats.total).toBe(3);
    expect(stats.successCount).toBe(2);
    expect(stats.failCount).toBe(1);
    expect(stats.failureRate).toBeCloseTo(0.333, 2);
    expect(stats.avgDurationMs).toBeCloseTo(116.67, 1);
  });
});
