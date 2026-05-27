import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderMcpServerList, renderModelCapabilities } from '../src/modules/settings.js';

describe('settings MCP rendering', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('renders MCP schema hash, cache metadata, and copyable tool catalog', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderMcpServerList(container, [
      { id: 'local', name: 'Local MCP', command: 'node', args: ['server.js'], enabled: true },
    ], vi.fn(), [
      {
        id: 'local',
        name: 'Local MCP',
        enabled: true,
        ok: true,
        tools: [
          { name: 'read_file', description: 'Read workspace file' },
        ],
        toolCount: 1,
        schemaHash: '1234567890abcdef',
        cacheTtlMs: 300000,
        cacheExpiresAt: '2026-05-27T12:00:00.000Z',
        checkedAt: '2026-05-27T11:55:00.000Z',
        durationMs: 12,
      },
    ]);

    expect(container.textContent).toContain('schema 12345678');
    expect(container.textContent).toContain('缓存 TTL 5m');
    expect(container.textContent).toContain('read_file');

    container.querySelector('.mcp-copy-tools-btn').click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload.schemaHash).toBe('1234567890abcdef');
    expect(payload.tools[0].name).toBe('read_file');
  });

  it('renders provider readiness warnings next to capability pills', () => {
    const container = document.createElement('div');

    renderModelCapabilities(container, {
      providerId: 'ollama',
      apiBase: 'http://localhost:11434/v1',
      model: 'llama3',
      activeSkill: 'agent_auto',
      cacheOptimization: true,
      maxInputTokens: 24000,
      maxContextMessages: 20,
    });

    expect(container.textContent).toContain('Provider: Ollama');
    expect(container.textContent).toContain('Agent 工具受限');
    expect(container.textContent).toContain('无法显示真实缓存命中');
    expect(container.querySelector('.provider-readiness-card.is-warning')).toBeTruthy();
  });
});
