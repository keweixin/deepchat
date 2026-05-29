// @ts-nocheck
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
    panel.remove();
  });

  it('opens panel and adds visible class', () => {
    openInspectorPanel('empty');
    expect(panel.classList.contains('is-visible')).toBe(true);
    expect(isInspectorPanelOpen()).toBe(true);
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

    it('renders copy and download buttons for each artifact', () => {
      openInspectorPanel('artifact', { msg: { content: codeContent }, index: 0 });
      const content = panel.querySelector('.inspector-panel-content');
      const actions = content.querySelectorAll('.inspector-artifact-action');
      expect(actions.length).toBe(2);
      expect(actions[0].dataset.action).toBe('copy');
      expect(actions[1].dataset.action).toBe('download');
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
  });
});
