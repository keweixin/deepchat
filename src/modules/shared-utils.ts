/**
 * Shared Utilities — Pure data-transform functions used across the codebase.
 *
 * This module is the single source of truth for generic helpers that were
 * previously duplicated in 2-8 files. Import from here instead of inlining.
 */

/** Escape HTML special characters to prevent XSS. */
export function escapeHtml(str: unknown): string {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Clamp a numeric value between min and max.
 * Non-finite inputs return `fallback` (defaults to `min`).
 */
export function clampNumber(value: unknown, min: number, max: number, fallback?: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback !== undefined ? fallback : min;
  if (max < min) return min;
  return Math.min(Math.max(number, min), max);
}

/** Escape a string for use inside a RegExp. */
export function escapeRegExp(value: unknown): string {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Generate a short unique ID (timestamp + random). */
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Truncate a string to `len` characters, appending '…' if truncated. */
export function truncate(str: unknown, len: number = 30): string {
  if (!str) return '';
  const s = String(str);
  return s.length > len ? s.slice(0, len) + '…' : s;
}

/** Format a byte count into a human-readable string. */
export function formatBytes(bytes: unknown): string {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Round a number to a given number of decimal places. */
export function roundTo(value: unknown, decimals: number = 2): number {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

/** Find the index of the last user message in a messages array. */
export function findLatestUserIndex(messages: Array<{ role?: string }> = []): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/** Get the content of the last user message. */
export function getLastUserContent(messages: Array<{ role?: string; content?: unknown }> = []): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i].content || '').trim();
  }
  return '';
}
