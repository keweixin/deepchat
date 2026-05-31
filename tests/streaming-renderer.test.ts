/**
 * Streaming Renderer Tests
 */

import { describe, it, expect } from 'vitest';
import {
  renderStreamingMarkdown,
  containsBlockMarkdown,
  createStreamingRenderer,
} from '../src/modules/streaming-renderer.js';

describe('renderStreamingMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(renderStreamingMarkdown('')).toBe('');
    expect(renderStreamingMarkdown(null)).toBe('');
  });

  it('escapes plain text', () => {
    const html = renderStreamingMarkdown('hello <world> & "test"');
    expect(html).toContain('&lt;world&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;test&quot;');
  });

  it('converts newlines to <br>', () => {
    const html = renderStreamingMarkdown('line1\nline2');
    expect(html).toContain('<br>');
  });

  it('parses bold with **', () => {
    const html = renderStreamingMarkdown('this is **bold** text');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('parses bold with __', () => {
    const html = renderStreamingMarkdown('this is __bold__ text');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('parses italic with *', () => {
    const html = renderStreamingMarkdown('this is *italic* text');
    expect(html).toContain('<em>italic</em>');
  });

  it('parses italic with _', () => {
    const html = renderStreamingMarkdown('this is _italic_ text');
    expect(html).toContain('<em>italic</em>');
  });

  it('parses code spans', () => {
    const html = renderStreamingMarkdown('use `console.log()` here');
    expect(html).toContain('<code class="inline-code">console.log()</code>');
  });

  it('parses strikethrough', () => {
    const html = renderStreamingMarkdown('this is ~~deleted~~ text');
    expect(html).toContain('<del>deleted</del>');
  });

  it('parses links', () => {
    const html = renderStreamingMarkdown('see [docs](https://example.com) for more');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('>docs</a>');
  });

  it('does not parse code fences as block', () => {
    // streaming renderer treats everything inline; block detection is separate
    const html = renderStreamingMarkdown('```js\nconst x = 1;\n```');
    // Should still contain the backticks escaped or partially processed
    expect(html).toContain('const x = 1;');
  });

  it('handles mixed inline formatting', () => {
    const html = renderStreamingMarkdown('**bold** and *italic* and `code`');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code class="inline-code">code</code>');
  });
});

describe('containsBlockMarkdown', () => {
  it('detects code fences', () => {
    expect(containsBlockMarkdown('```js\nconst x = 1;\n```')).toBe(true);
  });

  it('detects tables', () => {
    expect(containsBlockMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true);
  });

  it('detects headings', () => {
    expect(containsBlockMarkdown('# Heading')).toBe(true);
    expect(containsBlockMarkdown('## Subheading')).toBe(true);
  });

  it('detects blockquotes', () => {
    expect(containsBlockMarkdown('> quote')).toBe(true);
  });

  it('detects horizontal rules', () => {
    expect(containsBlockMarkdown('---')).toBe(true);
  });

  it('detects unordered lists', () => {
    expect(containsBlockMarkdown('- item')).toBe(true);
    expect(containsBlockMarkdown('* item')).toBe(true);
  });

  it('detects ordered lists', () => {
    expect(containsBlockMarkdown('1. item')).toBe(true);
  });

  it('returns false for plain inline text', () => {
    expect(containsBlockMarkdown('hello world **bold** `code`')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(containsBlockMarkdown('')).toBe(false);
  });
});

describe('createStreamingRenderer', () => {
  it('creates renderer with update/finalize/reset methods', () => {
    const container = document.createElement('div');
    const renderer = createStreamingRenderer(container);
    expect(typeof renderer.update).toBe('function');
    expect(typeof renderer.finalize).toBe('function');
    expect(typeof renderer.reset).toBe('function');
  });

  it('update renders streaming markdown into container', () => {
    const container = document.createElement('div');
    const renderer = createStreamingRenderer(container);
    renderer.update('hello **world**');
    expect(container.innerHTML).toContain('<strong>world</strong>');
    expect(container.querySelector('.streaming-cursor-mark')).toBeTruthy();
  });

  it('update is idempotent for same text', () => {
    const container = document.createElement('div');
    const renderer = createStreamingRenderer(container);
    renderer.update('hello');
    const html = container.innerHTML;
    renderer.update('hello');
    expect(container.innerHTML).toBe(html);
  });

  it('finalize replaces with full render and removes cursor', () => {
    const container = document.createElement('div');
    const renderer = createStreamingRenderer(container);
    renderer.update('hello');
    expect(container.querySelector('.streaming-cursor-mark')).toBeTruthy();
    renderer.finalize('hello world', (text) => `<p>${text}</p>`);
    expect(container.querySelector('.streaming-cursor-mark')).toBeFalsy();
    expect(container.innerHTML).toBe('<p>hello world</p>');
  });

  it('reset clears container', () => {
    const container = document.createElement('div');
    const renderer = createStreamingRenderer(container);
    renderer.update('hello');
    renderer.reset();
    expect(container.innerHTML).toBe('');
  });

  it('prevents duplication during long text stream of 10,000+ words', () => {
    const container = document.createElement('div');

    // Simulate streaming engine similar to chat-streaming.ts
    let fullContent = '';
    let lastFullSyncLen = 0;
    let lastAppendLen = 0;

    const APPEND_THRESHOLD = 5000;
    const FULL_SYNC_INTERVAL = 3000;

    // Simulate incoming chunks totaling 12,000 chars
    const chunk = 'This is a sentence that is repeated in chunks to simulate 10k words stream. ';
    const chunkCount = 160; // 160 * 76 = 12,160 chars

    for (let step = 0; step < chunkCount; step++) {
      fullContent += chunk;

      if (fullContent.length < APPEND_THRESHOLD) {
        // Short content: full sync
        container.innerHTML = renderStreamingMarkdown(fullContent); /* safeSetHTML-exempt: verified test environment */
        lastFullSyncLen = fullContent.length;
        lastAppendLen = fullContent.length;
      } else if (fullContent.length - lastFullSyncLen > FULL_SYNC_INTERVAL || lastFullSyncLen === 0) {
        // Full sync
        container.innerHTML = renderStreamingMarkdown(fullContent); /* safeSetHTML-exempt: verified test environment */
        lastFullSyncLen = fullContent.length;
        lastAppendLen = fullContent.length;
      } else {
        // Append-only mode: render only new content
        const newContent = fullContent.slice(lastAppendLen);
        if (newContent.length > 0) {
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = renderStreamingMarkdown(newContent); /* safeSetHTML-exempt: verified test environment */
          while (tempDiv.firstChild) {
            container.appendChild(tempDiv.firstChild);
          }
          lastAppendLen = fullContent.length;
        }
      }
    }

    // The final text inside DOM must be exactly equal to the output text, without duplicate segments
    const plainText = container.textContent || '';
    // Ensure all 160 chunks are represented exactly once
    const occurrenceCount = (plainText.match(/This is a sentence that is repeated in chunks/g) || []).length;
    expect(occurrenceCount).toBe(chunkCount);
  });
});
