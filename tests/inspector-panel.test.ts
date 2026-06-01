/**
 * Inspector Panel Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  openInspectorPanel,
  closeInspectorPanel,
  toggleInspectorPanel,
  isInspectorPanelOpen,
  updateInspectorPanel,
  bindInspectorPanelShortcut,
  setInspectorOverviewProvider,
} from '../src/modules/inspector-panel.js';

describe('inspector-panel', () => {
  let panel;

  beforeEach(() => {
    panel = document.createElement('aside');
    panel.id = 'right-inspector-panel';
    panel.innerHTML = `
      <div class="inspector-panel-header"><h2>Inspector</h2><button class="inspector-panel-close" type="button">&times;</button></div>
      <div class="inspector-panel-content"></div>
    `;
    document.body.appendChild(panel);
  });

  afterEach(() => {
    setInspectorOverviewProvider(null);
    panel.remove();
  });

  it('opens panel and adds visible class', () => {
    openInspectorPanel('empty');
    expect(panel.classList.contains('is-visible')).toBe(true);
    expect(isInspectorPanelOpen()).toBe(true);
  });

  it('does not render trusted-template audit comments as visible inspector text', () => {
    openInspectorPanel('empty');
    expect(panel.textContent).not.toContain('safeSetHTML-exempt');
  });

  it('renders conversation overview instead of a dead empty inspector when overview data exists', () => {
    setInspectorOverviewProvider(() => ({
      conversationTitle: '测试会话',
      messageCount: 3,
      latestMessageIndex: 2,
      latestToolRunCount: 1,
      usageText: '≈7.3k tok · 估算',
      usageTitle: '统计来源: 本地估算',
      hint: '点击按钮查看详情。',
    }));

    openInspectorPanel('empty');

    expect(panel.textContent).toContain('当前会话概览');
    expect(panel.textContent).toContain('测试会话');
    expect(panel.textContent).toContain('≈7.3k tok · 估算');
    expect(panel.querySelector('.inspector-overview-action')).toBeTruthy();
  });

  it('closes panel and removes visible class', () => {
    openInspectorPanel('empty');
    closeInspectorPanel();
    expect(panel.classList.contains('is-visible')).toBe(false);
    expect(isInspectorPanelOpen()).toBe(false);
  });

  it('toggles panel open/close', () => {
    toggleInspectorPanel('empty');
    expect(isInspectorPanelOpen()).toBe(true);
    toggleInspectorPanel('empty');
    expect(isInspectorPanelOpen()).toBe(false);
  });

  it('switches mode when opening different mode', () => {
    openInspectorPanel('message', { msg: { role: 'assistant' }, index: 0 });
    expect(isInspectorPanelOpen()).toBe(true);
    openInspectorPanel('model', { settings: { model: 'deepseek-chat' } });
    expect(isInspectorPanelOpen()).toBe(true);
  });

  it('renders memory retrieval diagnostics without raw memory bodies', () => {
    openInspectorPanel('message', {
      index: 0,
      msg: {
        role: 'assistant',
        timestamp: Date.now(),
        memoryDiagnostics: {
          selectedCount: 1,
          skippedCount: 2,
          reasons: [{ memoryId: 'mem-1', score: 8, reason: 'matched query terms in agent memory' }],
        },
      },
    });

    expect(panel.textContent).toContain('记忆命中');
    expect(panel.textContent).toContain('mem-1');
    expect(panel.textContent).toContain('score 8');
    expect(panel.textContent).not.toContain('DeepSeek cache uses stable prefixes');
  });

  it('renders token usage as readable fields instead of raw JSON', () => {
    openInspectorPanel('message', {
      index: 0,
      msg: {
        role: 'assistant',
        timestamp: Date.now(),
        tokens: {
          input: 1000,
          output: 250,
          total: 1250,
          reasoning: 50,
          cacheHit: 750,
          cacheMiss: 250,
          source: 'provider',
          cost: { estimatedCostUsd: 0.00123, estimatedSavingsUsd: 0.00045 },
        },
      },
    });

    expect(panel.textContent).toContain('Token 用量');
    expect(panel.textContent).toContain('输入 1,000 · 输出 250 · 总计 1,250 · 思考 50');
    expect(panel.textContent).toContain('命中 75%');
    expect(panel.textContent).toContain('Provider 实测');
    expect(panel.textContent).toContain('成本 $0.001230');
    expect(panel.textContent).not.toContain('"cacheHit"');
  });

  it('does not show fake 0 percent cache when provider has no cache telemetry', () => {
    openInspectorPanel('message', {
      index: 0,
      msg: {
        role: 'assistant',
        timestamp: Date.now(),
        tokens: { input: 1000, output: 250, total: 1250, source: 'estimated' },
      },
    });

    expect(panel.textContent).toContain('服务商未返回命中数据');
    expect(panel.textContent).not.toContain('命中 0%');
  });

  it('update does nothing when closed', () => {
    updateInspectorPanel('message', { msg: { role: 'user' }, index: 0 });
    expect(panel.classList.contains('is-visible')).toBe(false);
  });

  it('binds keyboard shortcut', () => {
    const unbind = bindInspectorPanelShortcut();
    expect(typeof unbind).toBe('function');

    const event = new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'i' });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    document.dispatchEvent(event);
    expect(preventDefault).toHaveBeenCalled();

    unbind();
  });

  it('gracefully handles missing panel DOM', () => {
    panel.remove();
    expect(() => openInspectorPanel('empty')).not.toThrow();
    expect(() => closeInspectorPanel()).not.toThrow();
    expect(() => toggleInspectorPanel('empty')).not.toThrow();
  });

  // ─── Artifact Mode ─────────────────────────────────────────────────────────

  describe('artifact mode', () => {
    const codeContent = [
      'Here is some code:',
      '',
      '```javascript',
      'function hello() {',
      '  return "world";',
      '}',
      '```',
    ].join('\n');

    const htmlContent = [
      'Here is an HTML preview:',
      '',
      '```html',
      '<div><h1>Hello</h1><p>World</p></div>',
      '```',
    ].join('\n');

    const jsonContent = ['Here is some data:', '', '```json', '{"name":"test","value":42}', '```'].join('\n');

    const mermaidContent = ['Here is a diagram:', '', '```mermaid', 'graph TD; A-->B; B-->C;', '```'].join('\n');

    const tableContent = [
      'Here is a table:',
      '',
      '```csv',
      'Name,Age,City',
      'Alice,30,Beijing',
      'Bob,25,Shanghai',
      '```',
    ].join('\n');

    const noArtifactContent = 'Just a plain text message with no code blocks.';

    it('renders artifact cards for code blocks', () => {
      openInspectorPanel('artifact', { msg: { content: codeContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const cards = content.querySelectorAll('.inspector-artifact-card');
      expect(cards.length).toBe(1);
      const title = cards[0].querySelector('.inspector-artifact-title');
      expect(title.textContent).toContain('代码');
    });

    it('renders HTML artifact with iframe preview', () => {
      openInspectorPanel('artifact', { msg: { content: htmlContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const iframe = content.querySelector('.inspector-artifact-iframe');
      expect(iframe).toBeTruthy();
      expect(iframe.getAttribute('sandbox')).toBe('');
    });

    it('renders JSON artifact with formatted preview', () => {
      openInspectorPanel('artifact', { msg: { content: jsonContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const code = content.querySelector('.inspector-artifact-code');
      expect(code).toBeTruthy();
      expect(code.textContent).toContain('"name"');
      expect(code.textContent).toContain('"test"');
    });

    it('renders Mermaid artifact with code preview', () => {
      openInspectorPanel('artifact', { msg: { content: mermaidContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const preview = content.querySelector('.inspector-artifact-preview--mermaid');
      expect(preview).toBeTruthy();
      const code = preview.querySelector('.inspector-artifact-code');
      expect(code.textContent).toContain('graph TD');
    });

    it('renders table artifact with HTML table', () => {
      openInspectorPanel('artifact', { msg: { content: tableContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const table = content.querySelector('.inspector-artifact-table');
      expect(table).toBeTruthy();
      const headers = table.querySelectorAll('th');
      expect(headers.length).toBe(3);
      expect(headers[0].textContent).toBe('Name');
      const rows = table.querySelectorAll('tbody tr');
      expect(rows.length).toBe(2);
    });

    it('shows empty state when no artifacts found', () => {
      openInspectorPanel('artifact', { msg: { content: noArtifactContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const empty = content.querySelector('.inspector-empty');
      expect(empty).toBeTruthy();
      expect(empty.textContent).toContain('未发现 artifact');
    });

    it('shows empty state when msg.content is missing', () => {
      openInspectorPanel('artifact', { msg: { role: 'assistant' }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const empty = content.querySelector('.inspector-empty');
      expect(empty).toBeTruthy();
    });

    it('renders copy, download, and download-all buttons', () => {
      openInspectorPanel('artifact', { msg: { content: codeContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const cardActions = content.querySelectorAll('.inspector-artifact-card .inspector-artifact-action');
      expect(cardActions.length).toBe(2);
      expect(cardActions[0].dataset.action).toBe('copy');
      expect(cardActions[1].dataset.action).toBe('download');
      // Download All button in the toolbar
      const downloadAll = content.querySelector('[data-action="download-all"]');
      expect(downloadAll).toBeTruthy();
    });

    it('renders multiple artifacts from multi-block content', () => {
      const multiContent = ['```javascript', 'const a = 1;', '```', '', '```json', '{"key":"value"}', '```'].join('\n');
      openInspectorPanel('artifact', { msg: { content: multiContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const cards = content.querySelectorAll('.inspector-artifact-card');
      expect(cards.length).toBe(2);
    });

    it('creates toolbar with mode buttons', () => {
      openInspectorPanel('artifact', { msg: { content: codeContent }, index: 0 });
      const toolbar = panel.querySelector('.inspector-toolbar');
      expect(toolbar).toBeTruthy();
      const btns = toolbar.querySelectorAll('.inspector-toolbar-btn');
      expect(btns.length).toBe(3);
      const activeBtn = toolbar.querySelector('.inspector-toolbar-btn.is-active');
      expect(activeBtn).toBeTruthy();
      expect(activeBtn.dataset.mode).toBe('artifact');
    });

    it('toolbar highlights correct active mode for message', () => {
      openInspectorPanel('message', { msg: { role: 'assistant' }, index: 0 });
      const toolbar = panel.querySelector('.inspector-toolbar');
      expect(toolbar).toBeTruthy();
      const activeBtn = toolbar.querySelector('.inspector-toolbar-btn.is-active');
      expect(activeBtn.dataset.mode).toBe('message');
    });

    it('renders search input for artifact filtering', () => {
      openInspectorPanel('artifact', { msg: { content: codeContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const searchInput = content.querySelector('.inspector-artifact-search-input');
      expect(searchInput).toBeTruthy();
      expect(searchInput.getAttribute('placeholder')).toContain('搜索');
    });

    it('filters artifacts by search query', () => {
      const multiContent = ['```javascript', 'const a = 1;', '```', '', '```json', '{"key":"value"}', '```'].join('\n');
      openInspectorPanel('artifact', { msg: { content: multiContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const searchInput = content.querySelector('.inspector-artifact-search-input');
      const cards = content.querySelectorAll('.inspector-artifact-card');
      expect(cards.length).toBe(2);

      // Type 'json' to filter
      searchInput.value = 'json';
      searchInput.dispatchEvent(new Event('input'));
      expect(cards[0].style.display).toBe('none');
      expect(cards[1].style.display).toBe('');
    });

    it('shows message index and timestamp in artifact metadata', () => {
      const ts = 1700000000000;
      openInspectorPanel('artifact', { msg: { content: codeContent, timestamp: ts }, index: 2 });
      const content = panel.querySelector('.inspector-panel-content');
      const meta = content.querySelector('.inspector-artifact-meta');
      expect(meta.textContent).toContain('消息 #3');
      expect(meta.textContent).toContain(new Date(ts).toLocaleString());
    });

    it('shows version badge when same artifact appears in multiple messages', () => {
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: codeContent, timestamp: 1000 },
        { role: 'user', content: 'regenerate' },
        { role: 'assistant', content: codeContent, timestamp: 2000 },
      ];
      openInspectorPanel('artifact', { msg: messages[1], index: 1, messages });
      const content = panel.querySelector('.inspector-panel-content');
      const badge = content.querySelector('.inspector-artifact-version-badge');
      expect(badge).toBeTruthy();
      expect(badge.textContent).toContain('2 版本');
    });

    it('shows diff button when multiple versions exist', () => {
      const v1 = ['```javascript', 'function hello() { return "v1"; }', '```'].join('\n');
      const v2 = ['```javascript', 'function hello() { return "v2"; }', '```'].join('\n');
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: v1, timestamp: 1000 },
        { role: 'user', content: 'regenerate' },
        { role: 'assistant', content: v2, timestamp: 2000 },
      ];
      openInspectorPanel('artifact', { msg: messages[1], index: 1, messages });
      const content = panel.querySelector('.inspector-panel-content');
      const diffBtn = content.querySelector('[data-action="diff"]');
      expect(diffBtn).toBeTruthy();
    });

    it('opens diff view when diff button is clicked', () => {
      const v1 = ['```javascript', 'function hello() { return "v1"; }', '```'].join('\n');
      const v2 = ['```javascript', 'function hello() { return "v2"; }', '```'].join('\n');
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: v1, timestamp: 1000 },
        { role: 'user', content: 'regenerate' },
        { role: 'assistant', content: v2, timestamp: 2000 },
      ];
      openInspectorPanel('artifact', { msg: messages[1], index: 1, messages });
      const content = panel.querySelector('.inspector-panel-content');
      const diffBtn = content.querySelector('[data-action="diff"]');
      diffBtn.click();

      const diffContainer = content.querySelector('.inspector-artifact-diff-container');
      expect(diffContainer.hidden).toBe(false);
      const diffView = content.querySelector('.inspector-artifact-diff-view');
      expect(diffView).toBeTruthy();
      const diffLines = diffView.querySelectorAll('.diff-line');
      expect(diffLines.length).toBeGreaterThan(0);
    });

    it('diff view shows version selectors', () => {
      const v1 = ['```json', '{"v":1}', '```'].join('\n');
      const v2 = ['```json', '{"v":2}', '```'].join('\n');
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: v1, timestamp: 1000 },
        { role: 'user', content: 'regenerate' },
        { role: 'assistant', content: v2, timestamp: 2000 },
      ];
      openInspectorPanel('artifact', { msg: messages[1], index: 1, messages });
      const content = panel.querySelector('.inspector-panel-content');
      content.querySelector('[data-action="diff"]').click();

      const selectors = content.querySelectorAll('.inspector-artifact-diff-select');
      expect(selectors.length).toBe(2);
      expect(selectors[0].querySelectorAll('option').length).toBe(2);
      expect(selectors[1].querySelectorAll('option').length).toBe(2);
    });

    it('diff view close button hides the diff container', () => {
      const v1 = ['```json', '{"v":1}', '```'].join('\n');
      const v2 = ['```json', '{"v":2}', '```'].join('\n');
      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: v1, timestamp: 1000 },
        { role: 'user', content: 'regenerate' },
        { role: 'assistant', content: v2, timestamp: 2000 },
      ];
      openInspectorPanel('artifact', { msg: messages[1], index: 1, messages });
      const content = panel.querySelector('.inspector-panel-content');
      content.querySelector('[data-action="diff"]').click();

      const closeBtn = content.querySelector('.inspector-artifact-diff-close');
      closeBtn.click();

      const diffContainer = content.querySelector('.inspector-artifact-diff-container');
      expect(diffContainer.hidden).toBe(true);
    });

    it('no version badge or diff button when messages not provided', () => {
      openInspectorPanel('artifact', { msg: { content: codeContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      expect(content.querySelector('.inspector-artifact-version-badge')).toBeNull();
      expect(content.querySelector('[data-action="diff"]')).toBeNull();
    });
  });
});
