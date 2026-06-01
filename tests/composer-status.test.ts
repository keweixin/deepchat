import { afterEach, describe, expect, it } from 'vitest';
import {
  getSearchStatusText,
  getThinkingLabel,
  renderComposerContextPreview,
  syncComposerModeSelect,
  syncThinkingSelect,
  updateComposerRunStatus,
  updateComposerToolButton,
} from '../src/modules/composer-status.js';

describe('composer status helpers', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('syncs composer mode option labels and selected value', () => {
    document.body.innerHTML = `
      <select>
        <option value="daily"></option>
        <option value="research"></option>
      </select>
    `;
    const select = document.querySelector('select') as HTMLSelectElement;

    syncComposerModeSelect(select, 'research', { tavilyApiKey: 'tvly-test' });

    expect(select.value).toBe('research');
    expect(select.options[0].textContent).toBe('日常');
    expect(select.options[1].textContent).toBe('研究');
  });

  it('syncs preset and custom thinking values', () => {
    document.body.innerHTML = `
      <select>
        <option value="0">自动</option>
        <option value="4096">轻量</option>
      </select>
    `;
    const select = document.querySelector('select') as HTMLSelectElement;

    syncThinkingSelect(select, 12345);

    expect(select.value).toBe('12345');
    expect(select.querySelector('[data-custom-thinking="true"]')?.textContent).toBe('自定义 12345');
    expect(getThinkingLabel('4096')).toBe('轻量');
    expect(getThinkingLabel('12345')).toBe('12345 tokens');
  });

  it('formats search and run status text', () => {
    expect(getSearchStatusText({})).toBe('需配置');
    expect(getSearchStatusText({ tavilyApiKey: 'tvly-test', activeSkill: 'web_search' })).toBe('开启');
    expect(getSearchStatusText({ tavilyApiKey: 'tvly-test', activeSkill: 'multi_tool' })).toBe('全工具');
    expect(getSearchStatusText({ tavilyApiKey: 'tvly-test', activeSkill: 'none' })).toBe('关闭');

    const target = document.createElement('div');
    updateComposerRunStatus(
      target,
      { activeSkill: 'web_search', tavilyApiKey: 'tvly-test', enhance: true, model: 'deepseek-chat' },
      4096,
      '@web latest',
      'research'
    );

    expect(target.textContent).toContain('研究模式');
    expect(target.textContent).toContain('联网检索');
    expect(target.textContent).toContain('轻量思考');
    expect(target.dataset.intentState).toBeTruthy();
  });

  it('renders context preview chips', () => {
    const target = document.createElement('div');

    renderComposerContextPreview(target, '@web latest', {
      activeSkill: 'web_search',
      tavilyApiKey: 'tvly-test',
    });

    expect(target.querySelectorAll('.composer-context-preview-chip').length).toBeGreaterThan(0);
    expect(target.querySelector('.composer-context-preview-chip')?.tagName).toBe('BUTTON');
    expect(target.textContent).toContain('工具 联网检索');
  });

  it('hides the context preview for ordinary chat without explicit context', () => {
    const target = document.createElement('div');

    renderComposerContextPreview(target, '普通聊天', {
      activeSkill: 'agent_auto',
      workspaceRoots: [],
      runCodeEnabled: true,
      mcpServers: [],
    });

    expect(target.hidden).toBe(true);
    expect(target.querySelectorAll('.composer-context-preview-chip')).toHaveLength(0);
  });

  it('updates the composer tool button label and availability', () => {
    document.body.innerHTML = `
      <button><span class="composer-tool-icon"></span></button>
      <span id="status"></span>
    `;
    const button = document.querySelector('button') as HTMLButtonElement;
    const status = document.getElementById('status') as HTMLElement;

    updateComposerToolButton(button, status, { activeSkill: 'web_search' });

    expect(button.classList.contains('is-unavailable')).toBe(true);
    expect(status.textContent).toBe('联网检索');
    expect(button.querySelector('.composer-tool-icon')?.textContent).toBe('🌐');
  });
});
