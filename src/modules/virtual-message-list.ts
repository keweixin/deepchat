/**
 * Virtual Message List — Lightweight virtual scrolling for chat messages
 *
 * Design:
 * - Render only visible messages + 3 buffer above and below
 * - Hidden messages replaced by placeholder divs to preserve scroll position
 * - Streaming message always fully rendered
 * - Falls back to full render when disabled or message count is low (< 30)
 */

const DEFAULT_BUFFER = 3;
const ENABLE_THRESHOLD = 30; // messages

/**
 * Calculate which message indices should be rendered
 * @param {Object} opts
 * @param {number} opts.messageCount — total messages
 * @param {number} opts.visibleStart — first visible index
 * @param {number} opts.visibleEnd — last visible index
 * @param {number} [opts.buffer=3] — buffer messages above/below
 * @returns {Set<number>} indices to render
 */
export function getVisibleIndices({
  messageCount,
  visibleStart,
  visibleEnd,
  buffer = DEFAULT_BUFFER,
}: {
  messageCount: number;
  visibleStart: number;
  visibleEnd: number;
  buffer?: number;
}) {
  const start = Math.max(0, visibleStart - buffer);
  const end = Math.min(messageCount - 1, visibleEnd + buffer);
  const set = new Set<number>();
  for (let i = start; i <= end; i++) set.add(i);
  return set;
}

/**
 * Estimate message heights from DOM (or use defaults)
 * @param {HTMLElement} container — $messages element
 * @param {number} messageCount
 * @returns {number[]} estimated heights
 */
export function estimateMessageHeights(container: HTMLElement, messageCount: number) {
  const children = container.querySelectorAll('.message');
  const heights = [];
  let avgHeight = 120;

  for (let i = 0; i < messageCount; i++) {
    const el = children[i];
    if (el) {
      const h = el.getBoundingClientRect().height;
      heights.push(h);
      avgHeight = h;
    } else {
      heights.push(avgHeight);
    }
  }
  return heights;
}

/**
 * Calculate scroll-based visible range
 * @param {HTMLElement} container — scroll container ($messages)
 * @param {number[]} heights — estimated heights
 * @returns {{start: number, end: number}}
 */
export function calculateVisibleRange(container: HTMLElement, heights: number[]) {
  const scrollTop = container.scrollTop;
  const viewportHeight = container.clientHeight;

  let accumulated = 0;
  let start = -1;
  let end = -1;

  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    // Item i is visible if its bottom is below scrollTop and its top is above viewport bottom
    if (start === -1 && accumulated + h > scrollTop) {
      start = i;
    }
    if (accumulated >= scrollTop + viewportHeight) {
      end = i - 1;
      break;
    }
    accumulated += h;
  }

  if (start === -1) start = 0;
  if (end === -1) end = heights.length - 1;

  return { start, end };
}

/**
 * Create a placeholder element for a hidden message
 * @param {number} height
 * @returns {HTMLElement}
 */
export function createPlaceholder(height: number) {
  const el = document.createElement('div');
  el.className = 'message-placeholder';
  el.style.height = `${height}px`;
  el.style.pointerEvents = 'none';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/**
 * Virtual list controller
 * @param {Object} opts
 * @param {HTMLElement} opts.container — $messages element
 * @param {Function} opts.renderItem — (index, isVisible) => HTMLElement
 * @param {Function} opts.getCount — () => number
 * @param {Object} [opts.settings]
 */
export function createVirtualList(opts: Record<string, any>) {
  const { container, renderItem, getCount, settings = {} } = opts;
  let enabled = (settings as Record<string, any>).virtualScrollEnabled !== false; // default enabled
  let heights: number[] = [];
  let renderedIndices = new Set<number>();
  let rafId: number | null = null;

  function shouldEnable() {
    if (!enabled) return false;
    const count = getCount();
    return count >= ENABLE_THRESHOLD;
  }

  function refresh() {
    if (!shouldEnable()) {
      // Full render fallback
      _fullRender();
      return;
    }

    const count = getCount();
    if (heights.length !== count) {
      heights = estimateMessageHeights(container, count);
    }

    const { start, end } = calculateVisibleRange(container, heights);
    const visible = getVisibleIndices({ messageCount: count, visibleStart: start, visibleEnd: end });

    // Remove items that are no longer visible
    for (const idx of renderedIndices) {
      if (!visible.has(idx)) {
        const el = container.querySelector(`.message[data-message-index="${idx}"]`);
        if (el) {
          const h = el.getBoundingClientRect().height || heights[idx] || 120;
          heights[idx] = h;
          const placeholder = createPlaceholder(h);
          placeholder.dataset.messageIndex = String(idx);
          container.replaceChild(placeholder, el);
        }
      }
    }

    // Add newly visible items
    for (const idx of visible) {
      if (!renderedIndices.has(idx)) {
        const placeholder = container.querySelector(`.message-placeholder[data-message-index="${idx}"]`);
        const item = renderItem(idx, true);
        if (placeholder && item) {
          container.replaceChild(item, placeholder);
        } else if (item) {
          container.appendChild(item);
        }
      }
    }

    renderedIndices = visible;
  }

  function _fullRender() {
    const count = getCount();
    // Clear all placeholders before rendering
    container.querySelectorAll('.message-placeholder').forEach((el: Element) => el.remove());
    // Ensure all messages are rendered
    for (let i = 0; i < count; i++) {
      if (!renderedIndices.has(i)) {
        const item = renderItem(i, true);
        if (item) container.appendChild(item);
      }
    }
    renderedIndices = new Set(Array.from({ length: count }, (_, i) => i));
  }

  function scheduleRefresh() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      rafId = null;
      refresh();
    });
  }

  function onScroll() {
    if (!shouldEnable()) return;
    scheduleRefresh();
  }

  function enable() {
    enabled = true;
    container.addEventListener('scroll', onScroll, { passive: true });
    refresh();
  }

  function disable() {
    enabled = false;
    container.removeEventListener('scroll', onScroll);
    _fullRender();
  }

  function destroy() {
    disable();
    if (rafId) cancelAnimationFrame(rafId);
  }

  // Initial render
  if (enabled) {
    container.addEventListener('scroll', onScroll, { passive: true });
  }

  return {
    refresh,
    scheduleRefresh,
    enable,
    disable,
    destroy,
    get enabled() {
      return enabled;
    },
  };
}
