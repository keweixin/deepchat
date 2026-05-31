import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetAppOverlayStateForTests,
  toggleChatSearch,
  toggleKeyboardHelp,
  toggleMarkdownPreview,
} from '../src/modules/app-overlays.js';

describe('app overlays', () => {
  afterEach(() => {
    resetAppOverlayStateForTests();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('toggles the keyboard shortcut help overlay', () => {
    toggleKeyboardHelp();

    expect(document.querySelector('.keyboard-help-overlay')).toBeTruthy();
    expect(document.querySelector('.keyboard-help-panel')?.textContent).toContain('快捷键速查');

    toggleKeyboardHelp();

    expect(document.querySelector('.keyboard-help-overlay')).toBeNull();
  });

  it('searches chat messages and clears highlights on close', () => {
    vi.useFakeTimers();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    document.body.innerHTML = `
      <main id="main-content">
        <div id="chat-messages">
          <div class="message assistant" data-message-index="0">
            <div class="message-content">DeepSeek cache prefix</div>
          </div>
          <div class="message user" data-message-index="1">
            <div class="message-content">ordinary prompt</div>
          </div>
        </div>
      </main>
    `;

    toggleChatSearch();
    const input = document.querySelector('.chat-search-input') as HTMLInputElement;
    input.value = 'cache';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(250);

    expect(document.querySelectorAll('mark.search-highlight')).toHaveLength(1);
    expect(document.querySelector('.chat-search-count')?.textContent).toBe('1/1');

    document.querySelector<HTMLButtonElement>('.chat-search-close')?.click();

    expect(document.querySelector('.chat-search-bar')).toBeNull();
    expect(document.querySelector('mark.search-highlight')).toBeNull();
  });

  it('renders and closes markdown preview overlay', () => {
    toggleMarkdownPreview('# 标题\n\n**重点**');

    expect(document.querySelector('.markdown-preview-overlay')).toBeTruthy();
    expect(document.querySelector('.markdown-preview-body')?.innerHTML).toContain('<strong>重点</strong>');

    document.querySelector<HTMLButtonElement>('.markdown-preview-close')?.click();

    expect(document.querySelector('.markdown-preview-overlay')).toBeNull();
  });
});
