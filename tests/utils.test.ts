import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce, formatTime, relativeTime, uid, truncate, escapeHtml, showToast } from '../src/modules/utils.js';

describe('uid', () => {
  it('returns a string', () => {
    expect(typeof uid()).toBe('string');
  });

  it('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uid()));
    expect(ids.size).toBe(100);
  });
});

describe('truncate', () => {
  it('returns empty string for falsy input', () => {
    expect(truncate('')).toBe('');
    expect(truncate(null)).toBe('');
    expect(truncate(undefined)).toBe('');
  });

  it('returns original string if shorter than limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and appends ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hello…');
  });

  it('uses default length of 30', () => {
    const short = 'a'.repeat(29);
    expect(truncate(short)).toBe(short);
    const long = 'a'.repeat(31);
    expect(truncate(long)).toBe('a'.repeat(30) + '…');
  });
});

describe('escapeHtml', () => {
  it('escapes ampersand', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('"hi"')).toBe('&quot;hi&quot;');
  });

  it('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('converts non-string to string', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delays execution', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('resets timer on subsequent calls', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('passes arguments to the function', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced('a', 'b');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('a', 'b');
  });
});

describe('formatTime', () => {
  it('returns HH:MM for today', () => {
    const now = new Date();
    const result = formatTime(now);
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });

  it('returns 昨天 HH:MM for yesterday', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const result = formatTime(yesterday);
    expect(result).toMatch(/^昨天 \d{2}:\d{2}$/);
  });

  it('returns MM-DD HH:MM for older dates', () => {
    const old = new Date('2024-01-15T10:30:00');
    const result = formatTime(old);
    expect(result).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 刚刚 for recent timestamps', () => {
    expect(relativeTime(Date.now())).toBe('刚刚');
    expect(relativeTime(Date.now() - 30000)).toBe('刚刚');
  });

  it('returns minutes ago', () => {
    expect(relativeTime(Date.now() - 5 * 60000)).toBe('5 分钟前');
  });

  it('returns hours ago', () => {
    expect(relativeTime(Date.now() - 3 * 3600000)).toBe('3 小时前');
  });

  it('returns days ago', () => {
    expect(relativeTime(Date.now() - 2 * 86400000)).toBe('2 天前');
  });

  it('falls back to formatTime for older than 7 days', () => {
    const old = Date.now() - 10 * 86400000;
    const result = relativeTime(old);
    expect(result).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('showToast', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('creates a toast element', () => {
    showToast('hello');
    const toast = document.querySelector('.toast');
    expect(toast).toBeTruthy();
    expect(toast.textContent).toBe('hello');
    expect(toast.getAttribute('role')).toBe('alert');
    expect(toast.getAttribute('aria-live')).toBe('assertive');
  });

  it('reuses existing toast element', () => {
    showToast('first');
    showToast('second');
    const toasts = document.querySelectorAll('.toast');
    expect(toasts.length).toBe(1);
    expect(toasts[0].textContent).toBe('second');
  });
});
