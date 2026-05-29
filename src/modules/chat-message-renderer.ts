/**
 * Chat Message Renderer — Markdown cache, compaction logic, and helpers.
 *
 * Pure data-transformation functions extracted from chat.js.
 */

import { renderMarkdown, postProcess } from './renderer.js';
import { escapeHtml } from './shared-utils.js';
import { relativeTime, formatTime } from './utils.js';
import { MARKDOWN_RENDER_CACHE_LIMIT } from './constants.js';

const HISTORICAL_FULL_RENDER_LIMIT = 60;
const HISTORICAL_COMPACT_MIN_CHARS = 800;

// ─── Markdown Cache ──────────────────────────────────────────────────────────

export function createMarkdownCache() {
  return new Map();
}

export function getCachedRenderedMarkdown(cache: Map<string, string>, content = '') {
  const key = getMarkdownCacheKey(content);
  if (cache.has(key)) {
    const html = cache.get(key)!;
    cache.delete(key);
    cache.set(key, html);
    return html;
  }
  const html = renderMarkdown(content);
  primeMarkdownRenderCache(cache, content, html);
  return html;
}

export function primeMarkdownRenderCache(cache: Map<string, string>, content = '', html = '') {
  const key = getMarkdownCacheKey(content);
  if (cache.has(key)) cache.delete(key);
  cache.set(key, html);
  while (cache.size > MARKDOWN_RENDER_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
}

export function getMarkdownCacheKey(content = '') {
  return `${content.length}:${hashString(content)}`;
}

export function hashString(value = '') {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

// ─── Message Compaction ──────────────────────────────────────────────────────

export function shouldCompactHistoricalMessage(
  totalMessages: number,
  index: number,
  message: Record<string, unknown> = {},
  limit: number = HISTORICAL_FULL_RENDER_LIMIT
) {
  if (message.role !== 'assistant') return false;
  if (message.error || message.stopped || message.thinking) return false;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return false;
  if (Array.isArray(message.toolRuns) && message.toolRuns.length > 0) return false;
  if (Array.isArray(message.agentStages) && message.agentStages.length > 0) return false;
  const content = String(message.content || '');
  if (content.length < HISTORICAL_COMPACT_MIN_CHARS) return false;
  return Number(totalMessages) - Number(index) > limit;
}

export function getCompactMessagePreview(content = '', maxLength = 260) {
  const text = String(content)
    .replace(/```[\s\S]*?```/g, ' [代码片段] ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[#*_>()-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

// ─── Message Element Creation ────────────────────────────────────────────────

export function createMessageElement(msg: Record<string, unknown>, streaming: boolean = false) {
  const el = document.createElement('div');
  el.className = `message ${msg.role}`;

  const avatarText = msg.role === 'user' ? '你' : 'AI';
  const roleText = msg.role === 'user' ? '你' : 'DeepChat';
  const timestamp = (msg.timestamp as number) || Date.now();
  const time = relativeTime(timestamp);
  const fullTime = formatTime(timestamp);

  let thinkingHtml = '';
  if (msg.role === 'assistant') {
    thinkingHtml = `<div class="thinking-block" hidden>
      <button class="thinking-header" type="button">
        <span class="chevron">▶</span>
        <span>思考过程</span>
      </button>
      <div class="thinking-content"></div>
    </div>`;
  }

  let contentHtml = '';
  if (msg.role === 'user') {
    contentHtml = escapeHtml(msg.content);
  } else if (streaming) {
    contentHtml = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;
  }

  el.innerHTML = `
    <div class="message-avatar">${avatarText}</div>
    <div class="message-body">
      <div class="message-header">
        <span class="message-role">${roleText}</span>
        <span class="message-time" title="${fullTime}">${time}</span>
      </div>
      ${msg.role === 'assistant' ? '<div class="answer-header-container" hidden></div>' : ''}
      ${thinkingHtml}
      ${msg.role === 'assistant' ? '<section class="agent-crew-container" hidden></section>' : ''}
      <div class="agent-timeline-container" hidden></div>
      <div class="tool-calls-container" hidden></div>
      ${msg.role === 'assistant' ? '<nav class="answer-toc-container" hidden aria-label="回答目录"></nav>' : ''}
      <div class="message-content">${contentHtml}</div>
      ${msg.role === 'assistant' ? '<div class="evidence-panel" hidden></div>' : ''}
      <div class="artifact-container" hidden></div>
    </div>
  `;

  const thinkingHeader = el.querySelector('.thinking-header');
  if (thinkingHeader) {
    thinkingHeader.addEventListener('click', () => {
      thinkingHeader.closest('.thinking-block')?.classList.toggle('expanded');
    });
  }

  return el;
}
