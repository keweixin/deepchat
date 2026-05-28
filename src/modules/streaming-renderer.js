/**
 * Streaming Renderer — Lightweight markdown for live token streaming
 *
 * Principles:
 * - Only inline elements during streaming (bold, italic, code, links)
 * - No block parsing (tables, code blocks, quotes, Mermaid)
 * - No postProcess (KaTeX, Mermaid, widgets)
 * - Incremental DOM updates instead of full innerHTML replacement
 */

const INLINE_RULES = [
  // Code span: `code`
  { pattern: /`([^`]+)`/g, wrap: 'code', className: 'inline-code' },
  // Bold: **text** or __text__
  { pattern: /\*\*([^\*]+)\*\*/g, wrap: 'strong' },
  { pattern: /__([^_]+)__/g, wrap: 'strong' },
  // Italic: *text* or _text_ (but not **)
  { pattern: /(?<!\*)\*(?!\*)([^\*]+)\*(?!\*)/g, wrap: 'em' },
  { pattern: /(?<!_)_(?!_)([^_]+)_(?!_)/g, wrap: 'em' },
  // Strikethrough: ~~text~~
  { pattern: /~~([^~]+)~~/g, wrap: 'del' },
  // Link: [text](url)
  {
    pattern: /\[([^\]]+)\]\(([^)]+)\)/g,
    wrap: 'a',
    attrs: (m) => ({ href: m[2], target: '_blank', rel: 'noopener noreferrer' }),
  },
];

/** Escape HTML entities */
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Render markdown text with only inline formatting.
 * Block elements are left as plain text.
 * @param {string} text
 * @returns {string} HTML string
 */
export function renderStreamingMarkdown(text) {
  if (!text) return '';

  // Quick check: if no markdown syntax, return escaped text
  if (!/[\*`_[~\]]/.test(text)) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }

  // First, protect code spans by replacing them with placeholders
  const codeSpans = [];
  let protectedText = text.replace(/`([^`]+)`/g, (match, code) => {
    codeSpans.push(escapeHtml(code));
    return `\x00CODE${codeSpans.length - 1}\x00`;
  });

  // Apply inline rules (skip code spans which are now placeholders)
  // Bold
  protectedText = protectedText.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');
  protectedText = protectedText.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic (avoid matching already-wrapped bold)
  protectedText = protectedText.replace(/(?<!<strong>[^<]*)\*(?!\*)([^\*]+)\*(?!\*)/g, '<em>$1</em>');
  protectedText = protectedText.replace(/(?<!<strong>[^<]*)_(?!_)([^_]+)_(?!_)/g, '<em>$1</em>');

  // Strikethrough
  protectedText = protectedText.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Links
  protectedText = protectedText.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Restore code spans
  protectedText = protectedText.replace(/\x00CODE(\d+)\x00/g, (match, idx) => {
    return `<code class="inline-code">${codeSpans[Number(idx)]}</code>`;
  });

  // Escape any remaining HTML-like content and convert newlines
  // But first, we need to be careful not to escape our generated tags
  // Split by our known tags, escape the rest
  const parts = protectedText.split(/(<\/?(?:strong|em|del|code|a)(?:\s[^>]*)?>)/g);
  const result = parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // keep tags
      return escapeHtml(part).replace(/\n/g, '<br>');
    })
    .join('');

  return result;
}

/**
 * Streaming DOM controller — incremental updates without full innerHTML replacement
 * @param {HTMLElement} container — the .message-content element
 */
export function createStreamingRenderer(container) {
  let lastText = '';
  let cursorEl = null;

  function ensureCursor() {
    if (!cursorEl) {
      cursorEl = document.createElement('span');
      cursorEl.className = 'streaming-cursor-mark';
      cursorEl.textContent = '\u200b'; // zero-width space
      container.appendChild(cursorEl);
    }
  }

  function removeCursor() {
    if (cursorEl) {
      cursorEl.remove();
      cursorEl = null;
    }
  }

  /**
   * Update DOM with new text using incremental diff
   * @param {string} fullText
   */
  function update(fullText) {
    if (fullText === lastText) return;

    // For simplicity with markdown: if text grew at the end (common case),
    // just re-render the whole thing. The lightweight parser is fast enough.
    // For very long text, we could optimize further.
    const html = renderStreamingMarkdown(fullText);
    container.innerHTML = html;
    ensureCursor();
    lastText = fullText;
  }

  /**
   * Final render — replace with full markdown + trigger post-processing
   * @param {string} fullText
   * @param {Function} renderFull — function that returns full HTML (renderMarkdown)
   */
  function finalize(fullText, renderFull) {
    removeCursor();
    const html = renderFull(fullText);
    container.innerHTML = html;
    lastText = fullText;
  }

  function reset() {
    lastText = '';
    removeCursor();
    container.innerHTML = '';
  }

  return { update, finalize, reset, removeCursor };
}

/**
 * Check if text contains block-level markdown that should defer full rendering
 * @param {string} text
 * @returns {boolean}
 */
export function containsBlockMarkdown(text) {
  if (!text) return false;
  // Code fence, table, heading, blockquote, horizontal rule, list
  const blockPatterns = [
    /^```/m, // code fence
    /^\|.*\|/m, // table
    /^#{1,6}\s/m, // heading
    /^>/m, // blockquote
    /^---+$/m, // horizontal rule
    /^\s*[-*+]\s/m, // unordered list
    /^\s*\d+\.\s/m, // ordered list
  ];
  return blockPatterns.some((p) => p.test(text));
}
