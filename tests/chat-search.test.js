import { afterEach, describe, expect, it } from 'vitest';
import {
  buildChatSearchIndex,
  clearChatSearchHighlights,
  findChatSearchMatches,
  highlightChatSearchMatches,
} from '../src/modules/chat-search.js';

describe('chat search index', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function renderMessages(count = 3) {
    document.body.innerHTML = `
      <div id="chat-messages">
        <div class="message user" data-message-index="0">
          <div class="message-body"><div class="message-content">普通问题</div></div>
        </div>
        <div class="message assistant" data-message-index="1">
          <div class="message-body"><div class="message-content"><h2>缓存命中</h2><p>DeepSeek cache hit depends on stable prefix.</p></div></div>
        </div>
        <div class="message assistant" data-message-index="2">
          <div class="message-body"><div class="message-content">unrelated answer</div></div>
        </div>
      </div>
    `;
    const root = document.getElementById('chat-messages');
    for (let i = 3; i < count; i += 1) {
      const message = document.createElement('div');
      message.className = 'message assistant';
      message.dataset.messageIndex = String(i);
      message.innerHTML = `<div class="message-body"><div class="message-content">cache extra ${i}</div></div>`;
      root.appendChild(message);
    }
  }

  it('builds a plain text index without mutating message DOM', () => {
    renderMessages();
    const before = document.getElementById('chat-messages').innerHTML;

    const index = buildChatSearchIndex(document);

    expect(index).toHaveLength(3);
    expect(index[1]).toMatchObject({
      messageIndex: '1',
      role: 'assistant',
      headings: ['缓存命中'],
    });
    expect(index[1].plainText).toContain('stable prefix');
    expect(document.getElementById('chat-messages').innerHTML).toBe(before);
  });

  it('prefilters matching messages before highlighting and respects the match limit', () => {
    renderMessages(80);
    const index = buildChatSearchIndex(document);

    const matches = findChatSearchMatches(index, 'cache', { limit: 10 });
    const marks = highlightChatSearchMatches(matches, 'cache');

    expect(matches).toHaveLength(10);
    expect(marks).toHaveLength(10);
    expect(document.querySelectorAll('.message.chat-search-match')).toHaveLength(10);
    expect(document.querySelector('[data-message-index="79"] mark.search-highlight')).toBeNull();
  });

  it('clears only generated search highlights and restores text content', () => {
    renderMessages();
    const index = buildChatSearchIndex(document);
    const matches = findChatSearchMatches(index, 'cache');

    highlightChatSearchMatches(matches, 'cache');
    expect(document.querySelectorAll('mark.search-highlight')).toHaveLength(1);
    expect(document.querySelector('.chat-search-match')).toBeTruthy();

    clearChatSearchHighlights(document);

    expect(document.querySelector('mark.search-highlight')).toBeNull();
    expect(document.querySelector('.chat-search-match')).toBeNull();
    expect(document.querySelector('[data-message-index="1"] .message-content').textContent)
      .toContain('DeepSeek cache hit depends on stable prefix.');
  });
});
