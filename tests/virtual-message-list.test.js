/**
 * Virtual Message List Tests
 */

import { describe, it, expect, vi } from 'vitest';
import {
  getVisibleIndices,
  estimateMessageHeights,
  calculateVisibleRange,
  createPlaceholder,
  createVirtualList,
} from '../src/modules/virtual-message-list.js';

describe('getVisibleIndices', () => {
  it('returns all indices when buffer covers everything', () => {
    const set = getVisibleIndices({ messageCount: 5, visibleStart: 2, visibleEnd: 2, buffer: 5 });
    expect([...set]).toEqual([0, 1, 2, 3, 4]);
  });

  it('respects buffer above and below', () => {
    const set = getVisibleIndices({ messageCount: 10, visibleStart: 5, visibleEnd: 5, buffer: 2 });
    expect([...set]).toEqual([3, 4, 5, 6, 7]);
  });

  it('clamps to messageCount', () => {
    const set = getVisibleIndices({ messageCount: 5, visibleStart: 3, visibleEnd: 4, buffer: 5 });
    expect([...set]).toEqual([0, 1, 2, 3, 4]);
  });

  it('handles empty list', () => {
    const set = getVisibleIndices({ messageCount: 0, visibleStart: 0, visibleEnd: 0, buffer: 3 });
    expect(set.size).toBe(0);
  });
});

describe('estimateMessageHeights', () => {
  it('reads heights from existing DOM elements', () => {
    const container = document.createElement('div');
    const msg1 = document.createElement('div');
    msg1.className = 'message';
    msg1.style.height = '100px';
    const msg2 = document.createElement('div');
    msg2.className = 'message';
    msg2.style.height = '150px';
    container.append(msg1, msg2);

    // jsdom getBoundingClientRect returns 0 by default, so we mock
    msg1.getBoundingClientRect = () => ({ height: 100 });
    msg2.getBoundingClientRect = () => ({ height: 150 });

    const heights = estimateMessageHeights(container, 2);
    expect(heights).toEqual([100, 150]);
  });

  it('falls back to average for missing elements', () => {
    const container = document.createElement('div');
    const msg1 = document.createElement('div');
    msg1.className = 'message';
    msg1.getBoundingClientRect = () => ({ height: 100 });
    container.appendChild(msg1);

    const heights = estimateMessageHeights(container, 3);
    expect(heights[0]).toBe(100);
    expect(heights[1]).toBe(100);
    expect(heights[2]).toBe(100);
  });
});

describe('calculateVisibleRange', () => {
  it('calculates correct visible range', () => {
    const container = document.createElement('div');
    container.scrollTop = 200;
    Object.defineProperty(container, 'clientHeight', { value: 300, configurable: true });

    const heights = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
    const range = calculateVisibleRange(container, heights);
    // scrollTop=200, viewport=300 -> visible from ~200 to ~500
    expect(range.start).toBe(2);
    expect(range.end).toBe(4);
  });

  it('returns full range when all fits in viewport', () => {
    const container = document.createElement('div');
    container.scrollTop = 0;
    Object.defineProperty(container, 'clientHeight', { value: 1000, configurable: true });

    const heights = [50, 50, 50];
    const range = calculateVisibleRange(container, heights);
    expect(range.start).toBe(0);
    expect(range.end).toBe(2);
  });

  it('returns full range when viewport is zero height (degenerate)', () => {
    const container = document.createElement('div');
    container.scrollTop = 0;
    Object.defineProperty(container, 'clientHeight', { value: 0, configurable: true });

    const heights = [100, 100, 100];
    const range = calculateVisibleRange(container, heights);
    // Zero-height viewport is degenerate; all items are considered visible
    expect(range.start).toBe(0);
    expect(range.end).toBe(2);
  });

  it('returns last item when scrolled to bottom', () => {
    const container = document.createElement('div');
    container.scrollTop = 250;
    Object.defineProperty(container, 'clientHeight', { value: 50, configurable: true });

    const heights = [100, 100, 100];
    const range = calculateVisibleRange(container, heights);
    expect(range.start).toBe(2);
    expect(range.end).toBe(2);
  });

  it('returns full range when scrolled past all items', () => {
    const container = document.createElement('div');
    container.scrollTop = 500;
    Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true });

    const heights = [100, 100, 100];
    const range = calculateVisibleRange(container, heights);
    expect(range.start).toBe(0);
    expect(range.end).toBe(2);
  });
});

describe('createPlaceholder', () => {
  it('creates placeholder with correct height', () => {
    const el = createPlaceholder(120);
    expect(el.className).toBe('message-placeholder');
    expect(el.style.height).toBe('120px');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('createVirtualList', () => {
  it('creates controller with expected methods', () => {
    const container = document.createElement('div');
    const list = createVirtualList({
      container,
      renderItem: (i) => {
        const el = document.createElement('div');
        el.className = 'message';
        el.dataset.messageIndex = String(i);
        return el;
      },
      getCount: () => 5,
      settings: { virtualScrollEnabled: false },
    });

    expect(typeof list.refresh).toBe('function');
    expect(typeof list.enable).toBe('function');
    expect(typeof list.disable).toBe('function');
    expect(typeof list.destroy).toBe('function');
    expect(list.enabled).toBe(false);
  });

  it('does not virtualize when disabled', () => {
    const container = document.createElement('div');
    const renderItem = vi.fn((i) => {
      const el = document.createElement('div');
      el.className = 'message';
      el.dataset.messageIndex = String(i);
      return el;
    });

    const list = createVirtualList({
      container,
      renderItem,
      getCount: () => 5,
      settings: { virtualScrollEnabled: false },
    });

    list.refresh();
    // Should full-render all items
    expect(container.querySelectorAll('.message').length).toBe(5);
  });

  it('does not virtualize when message count below threshold', () => {
    const container = document.createElement('div');
    const renderItem = vi.fn((i) => {
      const el = document.createElement('div');
      el.className = 'message';
      el.dataset.messageIndex = String(i);
      return el;
    });

    const list = createVirtualList({
      container,
      renderItem,
      getCount: () => 10, // below 30 threshold
      settings: { virtualScrollEnabled: true },
    });

    list.refresh();
    expect(container.querySelectorAll('.message').length).toBe(10);
  });

  it('virtualizes when message count is at threshold', () => {
    const container = document.createElement('div');
    container.scrollTop = 0;
    Object.defineProperty(container, 'clientHeight', { value: 300, configurable: true });

    const renderItem = vi.fn((i) => {
      const el = document.createElement('div');
      el.className = 'message';
      el.dataset.messageIndex = String(i);
      el.style.height = '100px';
      return el;
    });

    const list = createVirtualList({
      container,
      renderItem,
      getCount: () => 35,
      settings: { virtualScrollEnabled: true },
    });

    list.enable();
    // With viewport 300px and messages 100px each, only ~3-9 messages should be rendered (with buffer)
    const rendered = container.querySelectorAll('.message');
    expect(rendered.length).toBeLessThan(35);
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('destroys and full-renders all messages on disable', () => {
    const container = document.createElement('div');
    container.scrollTop = 0;
    Object.defineProperty(container, 'clientHeight', { value: 300, configurable: true });

    const renderItem = vi.fn((i) => {
      const el = document.createElement('div');
      el.className = 'message';
      el.dataset.messageIndex = String(i);
      el.style.height = '100px';
      return el;
    });

    const list = createVirtualList({
      container,
      renderItem,
      getCount: () => 35,
      settings: { virtualScrollEnabled: true },
    });

    list.enable();
    expect(container.querySelectorAll('.message').length).toBeLessThan(35);

    list.disable();
    expect(container.querySelectorAll('.message').length).toBe(35);
    expect(container.querySelectorAll('.message-placeholder').length).toBe(0);
  });

  it('cleans up placeholders on destroy', () => {
    const container = document.createElement('div');
    container.scrollTop = 0;
    Object.defineProperty(container, 'clientHeight', { value: 300, configurable: true });

    const renderItem = vi.fn((i) => {
      const el = document.createElement('div');
      el.className = 'message';
      el.dataset.messageIndex = String(i);
      el.style.height = '100px';
      return el;
    });

    const list = createVirtualList({
      container,
      renderItem,
      getCount: () => 35,
      settings: { virtualScrollEnabled: true },
    });

    list.enable();
    list.destroy();
    expect(container.querySelectorAll('.message-placeholder').length).toBe(0);
  });
});
