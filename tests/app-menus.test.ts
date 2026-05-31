import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  insertIntoComposer,
  resetAppMenuStateForTests,
  toggleComposerToolMenu,
  toggleContextShortcutMenu,
  toggleExportMenu,
  togglePromptTemplateMenu,
} from '../src/modules/app-menus.js';

describe('app menus', () => {
  afterEach(() => {
    resetAppMenuStateForTests();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function renderShell() {
    document.body.innerHTML = `
      <header id="chat-header"></header>
      <div class="composer-toolbar">
        <button id="template-btn"></button>
        <button id="tool-btn"></button>
        <button id="context-btn"></button>
      </div>
      <textarea id="message-input"></textarea>
      <button id="send-btn" disabled></button>
    `;
    return {
      templateBtn: document.getElementById('template-btn') as HTMLElement,
      toolBtn: document.getElementById('tool-btn') as HTMLElement,
      contextBtn: document.getElementById('context-btn') as HTMLElement,
      input: document.getElementById('message-input') as HTMLTextAreaElement,
      sendBtn: document.getElementById('send-btn') as HTMLButtonElement,
    };
  }

  it('renders prompt templates and applies the selected template to the composer', () => {
    const { templateBtn, input, sendBtn } = renderShell();
    const onApply = vi.fn();

    togglePromptTemplateMenu(templateBtn, onApply);
    document.querySelector<HTMLButtonElement>('.prompt-template-item')?.click();

    expect(input.value).toContain('@changed 请分析当前工作区');
    expect(sendBtn.disabled).toBe(false);
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: 'project-audit' }));
    expect(document.querySelector('.prompt-template-menu')).toBeNull();
  });

  it('renders composer tools and reports the selected tool', () => {
    const { toolBtn } = renderShell();
    const onSelect = vi.fn();
    const onChange = vi.fn();

    toggleComposerToolMenu(toolBtn, {
      settings: { activeSkill: 'none', tavilyApiKey: 'tvly-test', runCodeEnabled: true },
      activeSkill: 'none',
      onSelect,
      onChange,
    });
    document.querySelector<HTMLButtonElement>('.composer-tool-item[aria-disabled="false"]')?.click();

    expect(onSelect).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalled();
    expect(toolBtn.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.composer-tool-menu')).toBeNull();
  });

  it('inserts an available context shortcut into the composer', () => {
    const { contextBtn, input, sendBtn } = renderShell();

    toggleContextShortcutMenu(contextBtn, { settings: { tavilyApiKey: 'tvly-test' } });
    const webItem = Array.from(document.querySelectorAll<HTMLButtonElement>('.context-shortcut-item')).find((item) =>
      item.textContent?.includes('@web')
    );
    webItem?.click();

    expect(input.value).toContain('@web 最新资料');
    expect(sendBtn.disabled).toBe(false);
    expect(document.querySelector('.context-shortcut-menu')).toBeNull();
  });

  it('inserts text at the current selection and preserves send state with attachments', () => {
    const { input, sendBtn } = renderShell();
    input.value = 'hello';
    input.setSelectionRange(5, 5);

    insertIntoComposer(input, { insertText: '@file:"src/main.ts"', selectStartOffset: 7, selectEndOffset: 18 });

    expect(input.value).toBe('hello @file:"src/main.ts"');
    expect(input.selectionStart).toBe(13);
    expect(input.selectionEnd).toBe(24);
    expect(sendBtn.disabled).toBe(false);
  });

  it('renders export formats and invokes the selected export handler', () => {
    renderShell();
    const onExport = vi.fn();

    toggleExportMenu(document.getElementById('chat-header'), onExport);
    const htmlExport = Array.from(document.querySelectorAll<HTMLButtonElement>('.export-format-menu button')).find(
      (button) => button.textContent === '导出 HTML'
    );
    htmlExport?.click();

    expect(onExport).toHaveBeenCalledWith('html');
    expect(document.querySelector('.export-format-menu')).toBeNull();
  });
});
