import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getPromptPresetText, renderModelCapabilities } from '../src/modules/settings.js';
import { renderMcpServerList } from '../src/modules/settings-mcp.js';
import {
  formatDiscoveryStatus,
  renderExternalMcpImportList,
  renderExternalSkillImportList,
} from '../src/modules/settings-dom.js';

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

    renderMcpServerList(
      container,
      [{ id: 'local', name: 'Local MCP', command: 'node', args: ['server.js'], enabled: true, inheritEnv: false }],
      vi.fn(),
      [
        {
          id: 'local',
          name: 'Local MCP',
          enabled: true,
          ok: true,
          tools: [{ name: 'read_file', description: 'Read workspace file' }],
          toolCount: 1,
          schemaHash: '1234567890abcdef',
          cacheTtlMs: 300000,
          cacheExpiresAt: '2026-05-27T12:00:00.000Z',
          checkedAt: '2026-05-27T11:55:00.000Z',
          durationMs: 12,
          inheritEnv: false,
          envKeys: ['API_KEY'],
        },
      ]
    );

    expect(container.textContent).toContain('schema 12345678');
    expect(container.textContent).toContain('缓存 TTL 5m');
    expect(container.textContent).toContain('只传安全环境');
    expect(container.textContent).toContain('显式 env：API_KEY');
    expect(container.textContent).toContain('read_file');

    container.querySelector('.mcp-copy-tools-btn').click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(writeText.mock.calls[0][0]);
    expect(payload.schemaHash).toBe('1234567890abcdef');
    expect(payload.server.inheritEnv).toBe(false);
    expect(payload.server.envKeys).toEqual(['API_KEY']);
    expect(payload.tools[0].name).toBe('read_file');
  });

  it('renders MCP phase, zero-tool, and classified failure diagnostics', () => {
    const container = document.createElement('div');

    renderMcpServerList(
      container,
      [
        { id: 'empty', name: 'Empty MCP', command: 'node', enabled: true },
        { id: 'bad', name: 'Bad MCP', command: 'missing-cmd', enabled: true },
      ],
      vi.fn(),
      [
        { id: 'empty', ok: true, tools: [], toolCount: 0, phase: 'listTools', checkedAt: 'now', durationMs: 10 },
        {
          id: 'bad',
          ok: false,
          error: 'ENOENT',
          failureReason: 'command_not_found',
          phase: 'initialize/listTools',
          checkedAt: 'now',
          durationMs: 10,
        },
      ]
    );

    expect(container.textContent).toContain('连接成功，但没有工具');
    expect(container.textContent).toContain('阶段 listTools');
    expect(container.textContent).toContain('失败类型 命令不存在');
    expect(container.textContent).toContain('阶段 initialize/listTools');
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

  it('keeps quality presets aligned with the component output contract', () => {
    for (const preset of ['coder', 'analyst', 'translator', 'writer', 'teacher']) {
      const prompt = getPromptPresetText(preset);

      expect(prompt).toContain(':::summary');
      expect(prompt).toContain(':::warning');
      expect(prompt).toContain(':::steps');
      expect(prompt).toContain(':::decision');
      expect(prompt).toContain(':::source');
      expect(prompt).toContain(':::todo');
      expect(prompt).toContain(':::next');
      expect(prompt).toContain(':::tool-result');
      expect(prompt).toContain('不输出原始 HTML');
    }
  });
  it('keeps settings navigation in one primary sidebar instead of duplicated tabs', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
    const css = fs.readFileSync(path.resolve('src/styles/settings.css'), 'utf8');
    const panelRule = css.slice(css.indexOf('.settings-panel {'), css.indexOf('@media (max-width: 768px)'));
    const navRule = css.slice(css.indexOf('.settings-nav {'), css.indexOf('.settings-nav-item {'));

    expect(html).toContain('class="settings-nav"');
    expect(html).not.toContain('class="settings-tabs"');
    expect(html).not.toContain('settings-status-bar');
    expect(html).not.toContain('status-card');
    expect(html).not.toContain('role="tablist" aria-label="设置分类"');
    expect(panelRule).toContain('width: min(920px, 100vw)');
    expect(navRule).toContain('flex: 0 0 150px');
    expect(navRule).toContain('overflow-y: auto');
  });

  it('explains external discovery empty states instead of showing a bare zero count', () => {
    const skillContainer = document.createElement('div');
    const mcpContainer = document.createElement('div');

    renderExternalSkillImportList(skillContainer, [], vi.fn(), { emptyHint: '外部技能自动发现仅桌面版可用。' });
    renderExternalMcpImportList(
      mcpContainer,
      [],
      { importCandidate: vi.fn(), probeCandidate: vi.fn() },
      { emptyHint: '外部 MCP 配置发现仅桌面版可用。' }
    );

    expect(skillContainer.textContent).toContain('暂时没有可导入的技能');
    expect(skillContainer.textContent).toContain('仅桌面版可用');
    expect(mcpContainer.textContent).toContain('暂时没有可导入的 MCP 配置');
    expect(mcpContainer.textContent).toContain('仅桌面版可用');
    expect(formatDiscoveryStatus(0, ['外部 MCP 配置发现仅桌面版可用。'], '未发现外部 MCP')).toBe(
      '未发现外部 MCP：外部 MCP 配置发现仅桌面版可用。'
    );
  });
});
