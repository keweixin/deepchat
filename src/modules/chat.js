/**
 * Chat Module — Conversation management & UI
 * 
 * Features:
 * - Conversation search (sidebar filter)
 * - Edit user message & regenerate from that point
 * - Conversation rename (double-click)
 * - Smart auto-scroll (pause when user scrolls up)
 * - Streaming speed display (tok/s)
 * - Network error retry
 * - Regenerate last response
 * - Export conversation (Markdown)
 * - Adaptive render throttling
 */

import { approveToolRequest, streamChat, getSettings, runTool } from './api.js';
import { loadConversations, saveConversations } from './client-store.js';
import {
  SIDEBAR_FILTERS,
  filterConversations,
  getConversationGroup,
  normalizeConversation,
  normalizeConversations,
  normalizeFolderName,
  parseTagsInput,
  sortConversations,
} from './conversation-utils.js';
import { exportConversation } from './exporters.js';
import { enhancePrompt, isEnhanceEnabled } from './settings.js';
import { renderMarkdown, postProcess } from './renderer.js';
import { refreshReadingNavigator, resetReadingNavigator } from './reading-navigator.js';
import { uid, formatTime, relativeTime, scrollToBottom, truncate, copyToClipboard, showToast, escapeHtml } from './utils.js';

let conversations = [];
let activeConvId = null;
let abortController = null;
let isStreaming = false;
let userScrolledUp = false; // Smart scroll: track if user scrolled up
let sidebarFilter = SIDEBAR_FILTERS.active;
let bulkMode = false;
let selectedConversationIds = new Set();

let $messages, $welcome, $convList, $chatTitle, $modelName;

export async function initChat() {
  $messages = document.getElementById('chat-messages');
  $welcome = document.getElementById('welcome-screen');
  $convList = document.getElementById('conversation-list');
  $chatTitle = document.getElementById('chat-title');
  $modelName = document.getElementById('model-name');

  conversations = normalizeConversations(await loadConversations());

  renderConversationList();
  if (conversations.length > 0) {
    switchConversation(conversations[0].id);
  }

  // Smart scroll: detect when user scrolls up during streaming
  $messages.addEventListener('scroll', () => {
    if (!isStreaming) return;
    const threshold = 80;
    const atBottom = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < threshold;
    userScrolledUp = !atBottom;
  });

  // Search
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderConversationList(searchInput.value.trim());
    });
  }
  bindConversationToolbar();

  document.addEventListener('deepchat:run-code-block', (event) => {
    handleRunCodeBlock(event.detail).catch((error) => showToast(error.message || '代码运行失败'));
  });
  window.addEventListener('deepchat:reload-conversations', () => {
    reloadConversations().catch(() => showToast('刷新对话失败'));
  });
}

export async function reloadConversations() {
  conversations = await loadConversations();
  if (conversations.length > 0) {
    const stillExists = conversations.some((conv) => conv.id === activeConvId);
    switchConversation(stillExists ? activeConvId : conversations[0].id);
  } else {
    activeConvId = null;
    renderConversationList();
    showWelcome();
    updateHeader();
  }
}

function persist() {
  conversations = normalizeConversations(conversations);
  saveConversations(conversations).catch(() => {
    showToast('保存对话失败');
  });
}

function smartScroll(smooth = true) {
  if (!userScrolledUp) {
    scrollToBottom($messages, smooth);
  }
}

// ─── Conversation Management ───

export function createConversation() {
  const conv = normalizeConversation({ id: uid(), title: '新的对话', messages: [], createdAt: Date.now() });
  conversations.unshift(conv);
  sidebarFilter = SIDEBAR_FILTERS.active;
  bulkMode = false;
  selectedConversationIds.clear();
  persist();
  renderConversationList();
  switchConversation(conv.id);
  return conv;
}

export function switchConversation(id) {
  activeConvId = id;
  resetReadingNavigator();
  renderConversationList();
  renderMessages();
  updateHeader();
  refreshReadingNavigator();
}

export function deleteConversation(id) {
  const conv = conversations.find(c => c.id === id);
  const title = conv ? conv.title : '此对话';
  if (!confirm(`确定删除「${title}」？此操作不可恢复。`)) return;
  
  conversations = conversations.filter(c => c.id !== id);
  selectedConversationIds.delete(id);
  persist();
  if (activeConvId === id) {
    if (conversations.length > 0) {
      switchConversation(conversations[0].id);
    } else {
      activeConvId = null;
      renderConversationList();
      showWelcome();
      $chatTitle.textContent = '新的对话';
    }
  } else {
    renderConversationList();
  }
}

function renameConversation(id, newTitle) {
  const conv = conversations.find(c => c.id === id);
  if (!conv || !newTitle.trim()) return;
  conv.title = newTitle.trim();
  persist();
  renderConversationList();
  if (id === activeConvId) updateHeader();
}

function togglePinConversation(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  conv.pinned = !conv.pinned;
  persist();
  renderConversationList();
}

export function clearCurrentChat() {
  const conv = getActiveConversation();
  if (!conv) return;
  if (conv.messages.length > 0 && !confirm('确定清空当前对话？此操作不可恢复。')) return;
  conv.messages = [];
  conv.title = '新的对话';
  persist();
  renderMessages();
  updateHeader();
  renderConversationList();
}

function getActiveConversation() {
  return conversations.find(c => c.id === activeConvId) || null;
}

// ─── Export ───

export function exportCurrentChat(format = 'markdown') {
  const conv = getActiveConversation();
  exportConversation(conv, format);
}

// ─── Send / Edit / Regenerate ───

export async function sendMessage(content, options = {}) {
  if (isStreaming) return;
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  if (!content.trim() && attachments.length === 0) return;

  let conv = getActiveConversation();
  if (!conv) conv = createConversation();

  if ($welcome) $welcome.style.display = 'none';

  const userMsg = {
    role: 'user',
    content: content.trim(),
    timestamp: Date.now(),
    attachments,
    composerOverrides: options.composerOverrides || null,
  };
  conv.messages.push(userMsg);
  appendMessageDOM(userMsg);
  scrollToBottom($messages);

  if (conv.messages.filter(m => m.role === 'user').length === 1) {
    conv.title = truncate(content.trim() || attachments[0]?.name || '图片对话', 25);
    renderConversationList();
    updateHeader();
  }
  persist();

  await doStream(conv, 0, null, options.composerOverrides || null);
}

/**
 * Edit a user message at a given index and regenerate from that point.
 * Removes all messages after the edit point.
 */
export async function editMessageAt(msgIndex, newContent) {
  if (isStreaming) return;
  const conv = getActiveConversation();
  if (!conv) return;

  // Update message content and truncate everything after it
  conv.messages[msgIndex].content = newContent.trim();
  conv.messages = conv.messages.slice(0, msgIndex + 1);
  persist();

  // Re-render all messages
  renderMessages();
  await doStream(conv);
}

export async function regenerateLastResponse() {
  if (isStreaming) return;
  const conv = getActiveConversation();
  if (!conv || conv.messages.length === 0) return;

  const idx = conv.messages.map(m => m.role).lastIndexOf('assistant');
  if (idx >= 0) await regenerateResponseAt(idx);
}

export async function regenerateResponseAt(msgIndex) {
  if (isStreaming) return;
  const conv = getActiveConversation();
  if (!conv || conv.messages[msgIndex]?.role !== 'assistant') return;

  // Save current response to versions history
  const oldMsg = conv.messages[msgIndex];
  if (!oldMsg.versions) oldMsg.versions = [];
  oldMsg.versions.push({
    content: oldMsg.content,
    thinking: oldMsg.thinking || '',
    tokens: oldMsg.tokens,
    speed: oldMsg.speed,
    timestamp: oldMsg.timestamp,
  });

  conv.messages = trimMessagesForRegeneration(conv.messages, msgIndex);
  persist();
  renderMessages();
  await doStream(conv, 0, oldMsg.versions);
}

export function trimMessagesForRegeneration(messages, msgIndex) {
  if (!Array.isArray(messages) || messages[msgIndex]?.role !== 'assistant') return messages;
  return messages.slice(0, msgIndex);
}

async function doStream(conv, retryCount = 0, inheritVersions = null, composerOverrides = null) {
  isStreaming = true;
  userScrolledUp = false;
  abortController = new AbortController();
  toggleStreamingUI(true);

  const assistantMsg = {
    role: 'assistant',
    content: '',
    thinking: '',
    timestamp: Date.now(),
    tokens: null,
    versions: inheritVersions || [],
    toolRuns: [],
    composerOverrides,
  };
  const msgEl = appendMessageDOM(assistantMsg, true);
  msgEl.classList.add('streaming');
  const contentEl = msgEl.querySelector('.message-content');
  const thinkingContent = msgEl.querySelector('.thinking-content');
  const toolContainer = msgEl.querySelector('.tool-calls-container');
  smartScroll();

  let fullContent = '';
  let fullThinking = '';
  let renderTimer = null;
  let lastRenderLen = 0;

  // Speed tracking
  let streamStartTime = 0;
  let tokenCount = 0;

  function getThrottleMs() {
    if (fullContent.length < 200) return 50;
    if (fullContent.length < 2000) return 120;
    return 250;
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(async () => {
      renderTimer = null;
      if (fullContent.length - lastRenderLen < 3 && fullContent.length > 50) return;
      lastRenderLen = fullContent.length;
      
      contentEl.innerHTML = renderMarkdown(fullContent);
      contentEl.classList.add('streaming-cursor');
      attachCopyHandlersOnly(contentEl);

      // Update speed indicator
      if (streamStartTime > 0) {
        const elapsed = (Date.now() - streamStartTime) / 1000;
        if (elapsed > 0.5) {
          const speed = Math.round(tokenCount / elapsed);
          updateSpeedIndicator(msgEl, speed);
        }
      }

      smartScroll(false);
    }, getThrottleMs());
  }

  const apiMessages = conv.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content, attachments: m.attachments || [] }));

  const enhanceEnabled = composerOverrides?.enhance ?? isEnhanceEnabled();
  if (enhanceEnabled && apiMessages.length > 0) {
    const lastIdx = apiMessages.length - 1;
    if (apiMessages[lastIdx].role === 'user') {
      const original = apiMessages[lastIdx].content;
      const enhanced = enhancePrompt(original);
      if (enhanced !== original) {
        apiMessages[lastIdx] = { ...apiMessages[lastIdx], content: enhanced };
      }
    }
  }

  await streamChat(apiMessages, {
    signal: abortController.signal,
    onToken(token) {
      if (streamStartTime === 0) streamStartTime = Date.now();
      tokenCount++;
      fullContent += token;
      scheduleRender();
    },
    onThinking(token) {
      fullThinking += token;
      if (thinkingContent) {
        thinkingContent.textContent = fullThinking;
        const thinkingBlock = msgEl.querySelector('.thinking-block');
        if (thinkingBlock) thinkingBlock.hidden = false;
      }
    },
    onTokenCount(counts) {
      assistantMsg.tokens = counts;
    },
    onToolRequest(event) {
      if (!assistantMsg.toolCalls) assistantMsg.toolCalls = [];
      const tool = {
        id: event.toolCallId,
        name: event.name,
        args: event.args,
        risk: event.risk,
        status: 'pending',
        requestedAt: new Date().toISOString(),
      };
      assistantMsg.toolCalls.push(tool);
      syncToolRuns(assistantMsg);
      renderToolCalls(toolContainer, assistantMsg.toolCalls, {
        requestId: event.requestId,
        onDecision(toolCallId, approved) {
          tool.status = approved ? 'approved' : 'denied';
          approveToolRequest(event.requestId, toolCallId, approved);
          renderToolCalls(toolContainer, assistantMsg.toolCalls);
        }
      });
    },
    onToolResult(event) {
      if (!assistantMsg.toolCalls) assistantMsg.toolCalls = [];
      let tool = assistantMsg.toolCalls.find(item => item.id === event.toolCallId);
      if (!tool) {
        tool = {
          id: event.toolCallId,
          name: event.name,
          args: event.args || {},
          risk: event.risk || '',
          status: 'approved',
        };
        assistantMsg.toolCalls.push(tool);
      }
      tool.status = event.ok ? 'completed' : (tool.status === 'denied' ? 'denied' : 'failed');
      tool.output = event.output;
      tool.ok = event.ok;
      tool.completedAt = new Date().toISOString();
      tool.sources = extractToolSources(event.output);
      syncToolRuns(assistantMsg);
      renderToolCalls(toolContainer, assistantMsg.toolCalls);
    },
    async onDone() {
      clearTimeout(renderTimer);
      
      // Calculate final speed
      const elapsed = streamStartTime > 0 ? (Date.now() - streamStartTime) / 1000 : 0;
      const finalSpeed = elapsed > 0 ? Math.round(tokenCount / elapsed) : 0;

      contentEl.innerHTML = renderMarkdown(fullContent);
      contentEl.classList.remove('streaming-cursor');
      msgEl.classList.remove('streaming');
      // Trigger completion shimmer
      msgEl.classList.add('just-completed');
      setTimeout(() => msgEl.classList.remove('just-completed'), 1200);
      await postProcess(contentEl);

      const typing = msgEl.querySelector('.typing-indicator');
      if (typing) typing.remove();
      removeSpeedIndicator(msgEl);

      assistantMsg.content = fullContent;
      assistantMsg.thinking = fullThinking;
      assistantMsg.speed = finalSpeed;
      assistantMsg.sourceWarning = hasSearchWithoutCitedSource(assistantMsg, fullContent);
      conv.messages.push(assistantMsg);
      persist();

      addMessageActions(msgEl, fullContent, assistantMsg.tokens, finalSpeed, conv.messages.length - 1);
      renderSourceWarning(msgEl.querySelector('.message-body'), assistantMsg);

      isStreaming = false;
      abortController = null;
      userScrolledUp = false;
      toggleStreamingUI(false);
      scrollToBottom($messages);
      refreshReadingNavigator();
    },
    onError(err) {
      clearTimeout(renderTimer);
      contentEl.classList.remove('streaming-cursor');
      const typing = msgEl.querySelector('.typing-indicator');
      if (typing) typing.remove();
      removeSpeedIndicator(msgEl);

      // Auto retry on network errors (up to 2 times)
      if (retryCount < 2 && (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('Failed'))) {
        msgEl.remove();
        isStreaming = false;
        abortController = null;
        showToast(`网络错误，正在重试 (${retryCount + 1}/2)...`);
        setTimeout(() => doStream(conv, retryCount + 1), 1500);
        return;
      }

      assistantMsg.content = fullContent;
      assistantMsg.thinking = fullThinking;
      assistantMsg.error = err.message;
      syncToolRuns(assistantMsg);
      conv.messages.push(assistantMsg);
      persist();
      renderErrorContent(contentEl, err.message, () => {
        msgEl.remove();
      }, () => {
        // Retry: remove failed message and re-stream
        conv.messages.pop();
        persist();
        msgEl.remove();
        isStreaming = false;
        abortController = null;
        doStream(conv);
      });
      
      isStreaming = false;
      abortController = null;
      userScrolledUp = false;
      toggleStreamingUI(false);
      refreshReadingNavigator();
    }
  });
}

function updateSpeedIndicator(msgEl, speed) {
  let indicator = msgEl.querySelector('.speed-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'speed-indicator';
    msgEl.querySelector('.message-body').appendChild(indicator);
  }
  indicator.textContent = `⚡ ${speed} tok/s`;
}

function removeSpeedIndicator(msgEl) {
  const indicator = msgEl.querySelector('.speed-indicator');
  if (indicator) indicator.remove();
}

export function stopStreaming() {
  if (abortController) {
    abortController.abort();
    isStreaming = false;
    abortController = null;
    userScrolledUp = false;
    toggleStreamingUI(false);
  }
}

// ─── DOM Rendering ───

function showWelcome() {
  resetReadingNavigator();
  if ($welcome) $welcome.style.display = '';
  $messages.querySelectorAll('.message').forEach(m => m.remove());
  refreshReadingNavigator();
}

function renderMessages() {
  const conv = getActiveConversation();
  resetReadingNavigator();
  $messages.querySelectorAll('.message').forEach(m => m.remove());

  if (!conv || conv.messages.length === 0) {
    if ($welcome) $welcome.style.display = '';
    refreshReadingNavigator();
    return;
  }

  if ($welcome) $welcome.style.display = 'none';

  conv.messages.forEach((msg, idx) => {
    const el = appendMessageDOM(msg);
    if (msg.role === 'user') {
      addUserMessageActions(el, msg, idx);
    }
    if (msg.role === 'assistant') {
      const contentEl = el.querySelector('.message-content');
      if (msg.error) {
        if (msg.content) {
          contentEl.innerHTML = renderMarkdown(msg.content);
          postProcess(contentEl).then(refreshReadingNavigator);
          const errorWrap = document.createElement('div');
          renderErrorContent(errorWrap, msg.error);
          contentEl.appendChild(errorWrap.firstElementChild);
        } else {
          renderErrorContent(contentEl, msg.error);
        }
      } else {
        contentEl.innerHTML = renderMarkdown(msg.content);
        postProcess(contentEl).then(refreshReadingNavigator);
      }
      addMessageActions(el, msg.content, msg.tokens, msg.speed, idx);

      if (msg.thinking) {
        const thinkingBlock = el.querySelector('.thinking-block');
        const thinkingContentEl = el.querySelector('.thinking-content');
        if (thinkingBlock && thinkingContentEl) {
          thinkingBlock.hidden = false;
          thinkingContentEl.textContent = msg.thinking;
        }
      }
      renderToolCalls(el.querySelector('.tool-calls-container'), msg.toolCalls || []);
      renderSourceWarning(el.querySelector('.message-body'), msg);
    }
  });

  scrollToBottom($messages, false);
  refreshReadingNavigator();
}

function appendMessageDOM(msg, streaming = false) {
  const el = document.createElement('div');
  el.className = `message ${msg.role}`;

  const avatarText = msg.role === 'user' ? '你' : 'AI';
  const roleText = msg.role === 'user' ? '你' : 'DeepChat';
  const time = relativeTime(msg.timestamp || Date.now());
  const fullTime = formatTime(msg.timestamp || Date.now());

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
      ${thinkingHtml}
      <div class="tool-calls-container" hidden></div>
      <div class="message-content">${contentHtml}</div>
    </div>
  `;

  if (msg.role === 'user' && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    const content = el.querySelector('.message-content');
    content.appendChild(renderAttachmentStrip(msg.attachments));
  }

  const thinkingHeader = el.querySelector('.thinking-header');
  if (thinkingHeader) {
    thinkingHeader.addEventListener('click', () => {
      thinkingHeader.closest('.thinking-block')?.classList.toggle('expanded');
    });
  }

  if ($welcome && $welcome.parentNode === $messages) {
    $messages.insertBefore(el, $welcome);
  } else {
    $messages.appendChild(el);
  }

  return el;
}

function renderAttachmentStrip(attachments = []) {
  const strip = document.createElement('div');
  strip.className = 'message-attachments';
  for (const attachment of attachments) {
    const item = document.createElement('figure');
    item.className = 'message-attachment';
    if (String(attachment.mimeType || '').startsWith('image/') && attachment.dataUrl) {
      const img = document.createElement('img');
      img.src = attachment.dataUrl;
      img.alt = attachment.name || '图片附件';
      item.appendChild(img);
    }
    const caption = document.createElement('figcaption');
    caption.textContent = `${attachment.name || '附件'}${attachment.size ? ` · ${formatBytes(attachment.size)}` : ''}`;
    item.appendChild(caption);
    strip.appendChild(item);
  }
  return strip;
}

function renderToolCalls(container, toolCalls = [], options = {}) {
  if (!container) return;
  container.innerHTML = '';
  if (!toolCalls || toolCalls.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  for (const tool of toolCalls) {
    const block = document.createElement('div');
    block.className = `tool-call-block status-${tool.status || 'pending'}`;

    const header = document.createElement('div');
    header.className = 'tool-call-header';
    const title = document.createElement('strong');
    title.textContent = tool.name || tool.function?.name || 'unknown_tool';
    const status = document.createElement('span');
    status.className = 'tool-call-status';
    status.textContent = getToolStatusText(tool.status);
    header.append('工具调用：', title, status);

    const risk = document.createElement('p');
    risk.className = 'tool-call-risk';
    risk.textContent = tool.risk || '将执行一个工具调用。';

    const args = document.createElement('pre');
    args.className = 'tool-call-args';
    const code = document.createElement('code');
    code.textContent = formatToolArgs(tool);
    args.appendChild(code);

    block.append(header, risk, args);

    const meta = createToolMeta(tool);
    if (meta) block.appendChild(meta);

    if (tool.status === 'pending' && options.onDecision) {
      const actions = document.createElement('div');
      actions.className = 'tool-call-actions';
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'tool-approve-btn';
      approveBtn.textContent = '确认执行';
      approveBtn.addEventListener('click', () => options.onDecision(tool.id, true));
      const denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.className = 'tool-deny-btn';
      denyBtn.textContent = '拒绝';
      denyBtn.addEventListener('click', () => options.onDecision(tool.id, false));
      actions.append(denyBtn, approveBtn);
      block.appendChild(actions);
    }

    if (tool.output) {
      const preview = createToolOutputPreview(tool.output);
      if (preview) block.appendChild(preview);

      const output = document.createElement('details');
      output.className = 'tool-call-output';
      const summary = document.createElement('summary');
      summary.textContent = tool.ok === false ? '查看失败信息' : '查看工具结果';
      const pre = document.createElement('pre');
      pre.textContent = tool.output;
      output.append(summary, pre);
      block.appendChild(output);
    }

    container.appendChild(block);
  }
}

function createToolMeta(tool) {
  const items = [];
  if (tool.requestedAt) items.push(`请求：${formatToolTime(tool.requestedAt)}`);
  if (tool.completedAt) items.push(`完成：${formatToolTime(tool.completedAt)}`);
  const duration = getToolDurationMs(tool);
  if (duration !== null) items.push(`耗时：${duration}ms`);
  if (items.length === 0) return null;
  const meta = document.createElement('div');
  meta.className = 'tool-call-meta';
  meta.textContent = items.join(' · ');
  return meta;
}

function createToolOutputPreview(outputText) {
  const sources = extractToolSources(outputText);
  if (sources.length === 0) return null;

  const preview = document.createElement('div');
  preview.className = 'tool-source-preview';
  const label = document.createElement('div');
  label.className = 'tool-source-label';
  label.textContent = `真实来源 (${sources.length})`;
  preview.appendChild(label);

  for (const source of sources.slice(0, 3)) {
    const item = document.createElement('div');
    item.className = 'tool-source-item';
    const title = document.createElement('span');
    title.className = 'tool-source-title';
    title.textContent = source.title;
    item.appendChild(title);
    if (source.url) {
      const url = document.createElement('a');
      url.className = 'tool-source-url';
      url.href = source.url;
      url.target = '_blank';
      url.rel = 'noreferrer';
      url.textContent = source.url;
      item.appendChild(url);
    }
    if (source.publishedDate) {
      const date = document.createElement('span');
      date.className = 'tool-source-date';
      date.textContent = source.publishedDate;
      item.appendChild(date);
    }
    preview.appendChild(item);
  }

  return preview;
}

function extractToolSources(outputText) {
  const lines = String(outputText || '').split('\n');
  const sources = [];
  let current = null;
  for (const line of lines) {
    const titleMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (titleMatch) {
      current = { title: titleMatch[2].trim(), url: '', publishedDate: '' };
      sources.push(current);
      continue;
    }
    if (!current) continue;
    const urlMatch = line.match(/^\s*URL:\s*(.+)$/);
    if (urlMatch) current.url = urlMatch[1].trim();
    const dateMatch = line.match(/^\s*Published:\s*(.+)$/);
    if (dateMatch) current.publishedDate = dateMatch[1].trim();
  }
  return sources.filter(source => source.title && source.url);
}

function syncToolRuns(message) {
  message.toolRuns = (message.toolCalls || []).map((tool) => ({
    id: tool.id,
    name: tool.name || tool.function?.name || 'unknown_tool',
    args: tool.args || {},
    risk: tool.risk || '',
    status: tool.status || 'pending',
    ok: tool.ok,
    requestedAt: tool.requestedAt || '',
    completedAt: tool.completedAt || '',
    durationMs: getToolDurationMs(tool),
    outputPreview: tool.output ? String(tool.output).slice(0, 1200) : '',
    sources: tool.sources || extractToolSources(tool.output || ''),
  }));
}

function getToolDurationMs(tool) {
  if (!tool?.requestedAt || !tool?.completedAt) return null;
  const start = Date.parse(tool.requestedAt);
  const end = Date.parse(tool.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function formatToolTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function hasSearchWithoutCitedSource(message, content) {
  const searchRuns = (message.toolRuns || []).filter((run) => run.name === 'web_search' && run.status === 'completed');
  if (searchRuns.length === 0) return false;
  const urls = searchRuns.flatMap((run) => run.sources || []).map((source) => source.url).filter(Boolean);
  if (urls.length === 0) return true;
  return !urls.some((url) => String(content || '').includes(url));
}

function renderSourceWarning(container, message) {
  if (!container) return;
  container.querySelector('.source-grounding-warning')?.remove();
  if (!message?.sourceWarning) return;
  const warning = document.createElement('div');
  warning.className = 'source-grounding-warning';
  warning.textContent = '本轮调用了联网搜索，但最终回答没有引用搜索来源 URL，请谨慎核验。';
  container.appendChild(warning);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function getToolStatusText(status) {
  const map = {
    pending: '等待确认',
    approved: '已确认',
    denied: '已拒绝',
    completed: '已完成',
    failed: '失败',
  };
  return map[status] || '已记录';
}

function formatToolArgs(tool) {
  if (tool.args) return JSON.stringify(tool.args, null, 2);
  const fn = tool.function;
  if (!fn?.arguments) return '{}';
  try { return JSON.stringify(JSON.parse(fn.arguments), null, 2); } catch { return fn.arguments; }
}

function renderErrorContent(container, message, onClose, onRetry) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'message-error';
  const text = document.createElement('span');
  text.textContent = `生成失败：${message}`;
  wrap.appendChild(text);
  const btnGroup = document.createElement('div');
  btnGroup.className = 'error-btn-group';
  if (onRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'retry-btn retry-action';
    retryBtn.textContent = '重试';
    retryBtn.addEventListener('click', onRetry);
    btnGroup.appendChild(retryBtn);
  }
  if (onClose) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'retry-btn close-action';
    closeBtn.textContent = '关闭';
    closeBtn.addEventListener('click', onClose);
    btnGroup.appendChild(closeBtn);
  }
  wrap.appendChild(btnGroup);
  container.appendChild(wrap);
}

// ─── User Message Actions (Edit) ───

function addUserMessageActions(msgEl, msg, msgIndex) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';

  // Copy user message
  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn';
  copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`;
  copyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(msg.content);
    if (ok) {
      showToast('已复制到剪贴板');
      copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
      setTimeout(() => {
        copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`;
      }, 1500);
    }
  });
  actions.appendChild(copyBtn);

  // Edit user message
  const editBtn = document.createElement('button');
  editBtn.className = 'msg-action-btn';
  editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> 编辑`;
  editBtn.addEventListener('click', () => {
    const contentEl = msgEl.querySelector('.message-content');
    const originalText = msg.content;
    
    contentEl.innerHTML = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = originalText;
    textarea.rows = Math.min(originalText.split('\n').length + 1, 10);
    
    const btnGroup = document.createElement('div');
    btnGroup.className = 'edit-btn-group';
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'edit-save-btn';
    saveBtn.textContent = '保存并重新生成';
    saveBtn.addEventListener('click', () => {
      const newText = textarea.value.trim();
      if (newText) editMessageAt(msgIndex, newText);
    });
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'edit-cancel-btn';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => {
      contentEl.textContent = originalText;
    });
    
    btnGroup.appendChild(cancelBtn);
    btnGroup.appendChild(saveBtn);
    contentEl.appendChild(textarea);
    contentEl.appendChild(btnGroup);
    textarea.focus();
  });
  actions.appendChild(editBtn);

  // Delete single message
  const delBtn = document.createElement('button');
  delBtn.className = 'msg-action-btn';
  delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 删除`;
  delBtn.addEventListener('click', () => {
    if (!confirm('删除这条消息和其后的所有回复？')) return;
    const conv = conversations.find(c => c.id === activeConvId);
    if (!conv) return;
    conv.messages = conv.messages.slice(0, msgIndex);
    persist();
    renderMessages();
  });
  actions.appendChild(delBtn);

  msgEl.querySelector('.message-body').appendChild(actions);
}

// ─── Assistant Message Actions ───

function addMessageActions(msgEl, content, tokens, speed, msgIndex) {
  const existing = msgEl.querySelector('.message-actions');
  if (existing) existing.remove();

  const actions = document.createElement('div');
  actions.className = 'message-actions';
  
  // Copy
  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn';
  copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`;
  copyBtn.addEventListener('click', async () => {
    const plainText = msgEl.querySelector('.message-content')?.innerText || content;
    const ok = await copyToClipboard(plainText);
    if (ok) {
      showToast('已复制到剪贴板');
      copyBtn.classList.add('copied');
      copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
      setTimeout(() => {
        copyBtn.classList.remove('copied');
        copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`;
      }, 1500);
    }
  });
  actions.appendChild(copyBtn);

  // Copy raw Markdown
  const copyMdBtn = document.createElement('button');
  copyMdBtn.className = 'msg-action-btn';
  copyMdBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> 复制MD`;
  copyMdBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(content);
    if (ok) {
      showToast('已复制 Markdown 源码');
      copyMdBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
      setTimeout(() => {
        copyMdBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> 复制MD`;
      }, 1500);
    }
  });
  actions.appendChild(copyMdBtn);

  // Regenerate
  const regenBtn = document.createElement('button');
  regenBtn.className = 'msg-action-btn';
  regenBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> 重新生成`;
  regenBtn.addEventListener('click', () => regenerateResponseAt(msgIndex));
  actions.appendChild(regenBtn);

  const continueBtn = document.createElement('button');
  continueBtn.className = 'msg-action-btn';
  continueBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg> 继续`;
  continueBtn.addEventListener('click', () => continueFromResponseAt(msgIndex));
  actions.appendChild(continueBtn);

  const favoriteBtn = document.createElement('button');
  const conv = conversations.find(c => c.id === activeConvId);
  const msg = conv?.messages[msgIndex];
  favoriteBtn.className = `msg-action-btn${msg?.favorite ? ' is-favorite' : ''}`;
  favoriteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="${msg?.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15 8.5 22 9.3 16.8 14 18.2 21 12 17.4 5.8 21 7.2 14 2 9.3 9 8.5 12 2"/></svg> 收藏`;
  favoriteBtn.addEventListener('click', () => toggleMessageFavorite(msgIndex));
  actions.appendChild(favoriteBtn);

  // Version switcher (if message has version history)
  if (msg && msg.versions && msg.versions.length > 0) {
    const totalVersions = msg.versions.length + 1;
    const currentIdx = msg._versionIdx ?? (totalVersions - 1);

    const switcher = document.createElement('div');
    switcher.className = 'version-switcher';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'version-btn';
    prevBtn.textContent = '◀';
    prevBtn.disabled = currentIdx <= 0;

    const label = document.createElement('span');
    label.className = 'version-label';
    label.textContent = `${currentIdx + 1}/${totalVersions}`;

    const nextBtn = document.createElement('button');
    nextBtn.className = 'version-btn';
    nextBtn.textContent = '▶';
    nextBtn.disabled = currentIdx >= totalVersions - 1;

    prevBtn.addEventListener('click', () => {
      switchVersion(msgIndex, -1);
    });
    nextBtn.addEventListener('click', () => {
      switchVersion(msgIndex, 1);
    });

    switcher.append(prevBtn, label, nextBtn);
    actions.appendChild(switcher);
  }

  // Token badge + speed
  if (tokens || speed) {
    const badge = document.createElement('span');
    badge.className = 'token-badge';
    const parts = [];
    if (tokens) {
      const total = (tokens.input || 0) + (tokens.output || 0);
      parts.push(`≈${total} tokens`);
    }
    if (speed) parts.push(`${speed} tok/s`);
    badge.textContent = parts.join(' · ');
    if (tokens) badge.title = `输入: ≈${tokens.input || '?'} | 输出: ≈${tokens.output || '?'}`;
    actions.appendChild(badge);
  }

  msgEl.querySelector('.message-body').appendChild(actions);
}

function switchVersion(msgIndex, direction) {
  const conv = getActiveConversation();
  if (!conv) return;
  const msg = conv.messages[msgIndex];
  if (!msg || !msg.versions || msg.versions.length === 0) return;

  const totalVersions = msg.versions.length + 1;
  let currentIdx = msg._versionIdx ?? (totalVersions - 1);
  const newIdx = currentIdx + direction;
  if (newIdx < 0 || newIdx >= totalVersions) return;

  // Save current display into its slot
  const currentSnapshot = {
    content: msg.content,
    thinking: msg.thinking || '',
    tokens: msg.tokens,
    speed: msg.speed,
    timestamp: msg.timestamp,
  };

  if (currentIdx < msg.versions.length) {
    msg.versions[currentIdx] = currentSnapshot;
  } else {
    // Current was the "live" slot - store it temporarily at end
    msg._liveSnapshot = currentSnapshot;
  }

  // Load target version
  let target;
  if (newIdx < msg.versions.length) {
    target = msg.versions[newIdx];
  } else {
    target = msg._liveSnapshot || currentSnapshot;
  }

  msg.content = target.content;
  msg.thinking = target.thinking || '';
  msg.tokens = target.tokens;
  msg.speed = target.speed;
  msg._versionIdx = newIdx;

  persist();
  renderMessages();
}

async function continueFromResponseAt(msgIndex) {
  if (isStreaming) return;
  const conv = getActiveConversation();
  if (!conv || conv.messages[msgIndex]?.role !== 'assistant') return;
  conv.messages = conv.messages.slice(0, msgIndex + 1);
  conv.messages.push({
    role: 'user',
    content: '请从上一条回答中断处继续，不要重复已经写过的内容。',
    timestamp: Date.now(),
  });
  persist();
  renderMessages();
  await doStream(conv);
}

function toggleMessageFavorite(msgIndex) {
  const conv = getActiveConversation();
  if (!conv?.messages?.[msgIndex]) return;
  conv.messages[msgIndex].favorite = !conv.messages[msgIndex].favorite;
  persist();
  renderMessages();
  showToast(conv.messages[msgIndex].favorite ? '已收藏回答' : '已取消收藏');
}

function attachCopyHandlersOnly(container) {
  // Delegate to shared handler from renderer
  container.querySelectorAll('.code-copy-btn:not([data-bound])').forEach(btn => {
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', async () => {
      const code = decodeURIComponent(btn.dataset.code || '');
      try {
        await navigator.clipboard.writeText(code);
        btn.querySelector('.copy-icon').hidden = true;
        btn.querySelector('.check-icon').hidden = false;
        btn.querySelector('.copy-text').textContent = '已复制';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.querySelector('.copy-icon').hidden = false;
          btn.querySelector('.check-icon').hidden = true;
          btn.querySelector('.copy-text').textContent = '复制';
          btn.classList.remove('copied');
        }, 1500);
      } catch (_) {}
    });
  });

  // Run JS code blocks
  container.querySelectorAll('.code-run-btn:not([data-bound])').forEach(btn => {
    btn.setAttribute('data-bound', '1');
    btn.addEventListener('click', () => {
      const code = decodeURIComponent(btn.dataset.code || '');
      document.dispatchEvent(new CustomEvent('deepchat:run-code-block', {
        detail: { button: btn, code, language: btn.dataset.language || 'javascript' },
      }));
    });
  });
}

async function handleRunCodeBlock(detail = {}) {
  const button = detail.button;
  const code = String(detail.code || '');
  const language = String(detail.language || 'javascript');
  const wrapper = button?.closest?.('.code-block-wrapper');
  if (!wrapper || !code.trim()) return;

  wrapper.querySelector('.manual-run-confirm')?.remove();
  wrapper.querySelector('.code-output')?.remove();

  const confirmBox = document.createElement('div');
  confirmBox.className = 'manual-run-confirm';
  const title = document.createElement('strong');
  title.textContent = '确认运行这段代码';
  const hint = document.createElement('p');
  hint.textContent = '代码会通过桌面主进程的 run_code 工具执行，结果会显示在当前代码块下方。请只运行可信代码。';
  const preview = document.createElement('pre');
  preview.textContent = code.slice(0, 1600);
  const actions = document.createElement('div');
  actions.className = 'tool-call-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'tool-deny-btn';
  cancel.textContent = '取消';
  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'tool-approve-btn';
  approve.textContent = '确认运行';
  actions.append(cancel, approve);
  confirmBox.append(title, hint, preview, actions);
  wrapper.appendChild(confirmBox);

  cancel.addEventListener('click', () => confirmBox.remove(), { once: true });
  approve.addEventListener('click', async () => {
    approve.disabled = true;
    cancel.disabled = true;
    button.disabled = true;
    button.textContent = '运行中...';
    try {
      const output = await runTool('run_code', { language, code });
      confirmBox.remove();
      renderCodeOutput(wrapper, output, true);
    } catch (error) {
      renderCodeOutput(wrapper, error.message || String(error), false);
    } finally {
      button.disabled = false;
      button.textContent = '▶ 运行';
    }
  }, { once: true });
}

function renderCodeOutput(wrapper, output, ok) {
  wrapper.querySelector('.code-output')?.remove();
  const outputEl = document.createElement('div');
  outputEl.className = `code-output${ok ? '' : ' is-error'}`;
  const header = document.createElement('div');
  header.className = 'code-output-header';
  header.textContent = ok ? '运行结果' : '运行失败';
  const pre = document.createElement('pre');
  pre.textContent = output || '(无输出)';
  outputEl.append(header, pre);
  wrapper.appendChild(outputEl);
}

// ─── Conversation List with Search & Rename ───

function bindConversationToolbar() {
  document.querySelectorAll('[data-conv-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      sidebarFilter = button.dataset.convFilter || SIDEBAR_FILTERS.active;
      selectedConversationIds.clear();
      renderConversationList(document.getElementById('search-input')?.value.trim() || '');
    });
  });

  document.getElementById('conversation-bulk-toggle')?.addEventListener('click', () => {
    bulkMode = !bulkMode;
    selectedConversationIds.clear();
    renderConversationList(document.getElementById('search-input')?.value.trim() || '');
  });
  document.getElementById('conversation-bulk-delete')?.addEventListener('click', deleteSelectedConversations);
  document.getElementById('conversation-bulk-archive')?.addEventListener('click', archiveSelectedConversations);
  document.getElementById('conversation-bulk-cancel')?.addEventListener('click', () => {
    bulkMode = false;
    selectedConversationIds.clear();
    renderConversationList(document.getElementById('search-input')?.value.trim() || '');
  });
}

function renderConversationList(searchQuery = '') {
  $convList.innerHTML = '';
  updateConversationToolbarState();
  
  const filtered = filterConversations(conversations, { query: searchQuery, filter: sidebarFilter });
  
  if (filtered.length === 0) {
    $convList.innerHTML = `<div class="sidebar-empty">${getEmptyConversationText(searchQuery)}</div>`;
    return;
  }

  const sorted = sortConversations(filtered);

  let lastGroup = '';
  
  sorted.forEach(conv => {
    if (!searchQuery) {
      const group = getConversationGroup(conv);
      if (group !== lastGroup) {
        lastGroup = group;
        const header = document.createElement('div');
        header.className = `conv-date-group${conv.pinned ? ' conv-pinned-group' : ''}`;
        header.textContent = group;
        $convList.appendChild(header);
      }
    }

    const item = document.createElement('div');
    item.className = `conversation-item${conv.id === activeConvId ? ' active' : ''}${conv.pinned ? ' is-pinned' : ''}${conv.archivedAt ? ' is-archived' : ''}`;
    const pinIcon = conv.pinned ? '<span class="conv-pin-indicator" title="已置顶">📌</span>' : '';
    const tags = (conv.tags || []).map((tag) => `<span class="conv-tag">#${escapeHtml(tag)}</span>`).join('');
    const meta = [conv.folderId ? `<span class="conv-folder-label">${escapeHtml(conv.folderId)}</span>` : '', tags].filter(Boolean).join('');
    const selected = selectedConversationIds.has(conv.id);
    item.innerHTML = `
      ${bulkMode ? `<input class="conv-select" type="checkbox" ${selected ? 'checked' : ''} aria-label="选择对话">` : ''}
      <svg class="conv-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span class="conv-text">
        <span class="conv-title">${escapeHtml(conv.title)}</span>
        ${meta ? `<span class="conv-meta">${meta}</span>` : ''}
      </span>
      ${pinIcon}
      <div class="conv-actions">
        <button class="conv-tags icon-btn-sm" title="编辑标签">#</button>
        <button class="conv-folder icon-btn-sm" title="移动到文件夹">⌁</button>
        <button class="conv-archive icon-btn-sm" title="${conv.archivedAt ? '取消归档' : '归档'}">${conv.archivedAt ? '↩' : '✓'}</button>
        <button class="conv-pin icon-btn-sm" title="${conv.pinned ? '取消置顶' : '置顶'}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="${conv.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2L12 12M12 12L8 8M12 12L16 8M5 21L19 21"/></svg>
        </button>
        <button class="conv-delete icon-btn-sm" title="删除对话">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    `;
    
    // Click to switch
    item.addEventListener('click', (e) => {
      if (e.target.closest('.conv-actions') || e.target.closest('.conv-select')) return;
      if (bulkMode) {
        toggleConversationSelection(conv.id);
        return;
      }
      switchConversation(conv.id);
    });

    item.querySelector('.conv-select')?.addEventListener('change', (e) => {
      e.stopPropagation();
      toggleConversationSelection(conv.id, e.target.checked);
    });

    item.querySelector('.conv-tags')?.addEventListener('click', (e) => {
      e.stopPropagation();
      editConversationTags(conv.id);
    });

    item.querySelector('.conv-folder')?.addEventListener('click', (e) => {
      e.stopPropagation();
      moveConversationFolder(conv.id);
    });

    item.querySelector('.conv-archive')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleArchiveConversation(conv.id);
    });

    // Pin/unpin
    item.querySelector('.conv-pin').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePinConversation(conv.id);
    });

    // Double-click to rename
    const titleEl = item.querySelector('.conv-title');
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      titleEl.contentEditable = 'true';
      titleEl.focus();
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      const finishEdit = () => {
        titleEl.contentEditable = 'false';
        const newTitle = titleEl.textContent.trim();
        if (newTitle && newTitle !== conv.title) {
          renameConversation(conv.id, newTitle);
        } else {
          titleEl.textContent = conv.title;
        }
      };

      titleEl.addEventListener('blur', finishEdit, { once: true });
      titleEl.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') { ke.preventDefault(); titleEl.blur(); }
        if (ke.key === 'Escape') { titleEl.textContent = conv.title; titleEl.blur(); }
      });
    });
    
    item.querySelector('.conv-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    });
    
    $convList.appendChild(item);
  });
}

function updateConversationToolbarState() {
  document.querySelectorAll('[data-conv-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.convFilter === sidebarFilter);
  });
  document.getElementById('conversation-bulk-toggle')?.classList.toggle('active', bulkMode);
  const bar = document.getElementById('conversation-bulk-bar');
  const count = document.getElementById('conversation-bulk-count');
  if (bar) bar.classList.toggle('hidden', !bulkMode);
  if (count) count.textContent = `已选 ${selectedConversationIds.size}`;
}

function getEmptyConversationText(searchQuery) {
  if (searchQuery) return '未找到匹配的对话';
  if (sidebarFilter === SIDEBAR_FILTERS.favorites) return '暂无收藏回答';
  if (sidebarFilter === SIDEBAR_FILTERS.archived) return '暂无归档对话';
  return '暂无对话记录';
}

function toggleConversationSelection(id, checked) {
  const next = checked ?? !selectedConversationIds.has(id);
  if (next) selectedConversationIds.add(id);
  else selectedConversationIds.delete(id);
  renderConversationList(document.getElementById('search-input')?.value.trim() || '');
}

function deleteSelectedConversations() {
  if (selectedConversationIds.size === 0) return;
  if (!confirm(`确定删除选中的 ${selectedConversationIds.size} 个对话？此操作不可恢复。`)) return;
  conversations = conversations.filter((conversation) => !selectedConversationIds.has(conversation.id));
  if (activeConvId && selectedConversationIds.has(activeConvId)) {
    activeConvId = conversations[0]?.id || null;
  }
  selectedConversationIds.clear();
  bulkMode = false;
  persist();
  if (activeConvId) switchConversation(activeConvId);
  else {
    renderConversationList();
    showWelcome();
    updateHeader();
  }
}

function archiveSelectedConversations() {
  if (selectedConversationIds.size === 0) return;
  for (const conversation of conversations) {
    if (selectedConversationIds.has(conversation.id)) conversation.archivedAt = Date.now();
  }
  selectedConversationIds.clear();
  bulkMode = false;
  persist();
  renderConversationList(document.getElementById('search-input')?.value.trim() || '');
}

function toggleArchiveConversation(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  conv.archivedAt = conv.archivedAt ? null : Date.now();
  persist();
    if (conv.id === activeConvId && conv.archivedAt && sidebarFilter === SIDEBAR_FILTERS.active) {
      const next = conversations.find((item) => !item.archivedAt && item.id !== conv.id);
      if (next) switchConversation(next.id);
      else {
        activeConvId = null;
        showWelcome();
        updateHeader();
        renderConversationList(document.getElementById('search-input')?.value.trim() || '');
      }
      return;
    }
  renderConversationList(document.getElementById('search-input')?.value.trim() || '');
}

function editConversationTags(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  const next = prompt('输入标签，用逗号分隔。留空表示清除标签。', (conv.tags || []).join(', '));
  if (next === null) return;
  conv.tags = parseTagsInput(next);
  persist();
  renderConversationList(document.getElementById('search-input')?.value.trim() || '');
}

function moveConversationFolder(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  const next = prompt('输入文件夹名称。留空表示移出文件夹。', conv.folderId || '');
  if (next === null) return;
  conv.folderId = normalizeFolderName(next);
  persist();
  renderConversationList(document.getElementById('search-input')?.value.trim() || '');
}

function updateHeader() {
  const conv = getActiveConversation();
  const settings = getSettings();
  $chatTitle.textContent = conv ? conv.title : '新的对话';
  $modelName.textContent = settings.model;
}

export function updateModelDisplay(model) {
  $modelName.textContent = model;
}

function toggleStreamingUI(streaming) {
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const input = document.getElementById('message-input');
  
  if (streaming) {
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    input.disabled = true;
  } else {
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    input.disabled = false;
    input.focus();
  }
}

// escapeHtml imported from utils.js
