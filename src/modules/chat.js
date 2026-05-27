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

import { approveToolRequest, streamChat, getSettings, runTool, normalizeTokenUsage, getConversationUsageSummary } from './api.js';
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
import { confirmAction, promptText } from './dialogs.js';
import {
  applyToolDecision,
  applyToolResult,
  buildToolRuns,
  createToolRecord,
  extractToolSources,
  formatToolArgs,
  getSearchGrounding,
  getToolDurationMs,
  getToolName,
  getToolQuery,
  getToolStatusMeta,
  hasSearchWithoutCitedSource as hasUncitedSearchSource,
} from './tool-runs.js';
import { uid, formatTime, relativeTime, scrollToBottom, truncate, copyToClipboard, showToast, escapeHtml } from './utils.js';

let conversations = [];
let activeConvId = null;
let abortController = null;
let isStreaming = false;
let userScrolledUp = false; // Smart scroll: track if user scrolled up
let sidebarFilter = SIDEBAR_FILTERS.active;
let bulkMode = false;
let selectedConversationIds = new Set();
let conversationMenuEl = null;
let conversationMenuCleanup = null;

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

export async function deleteConversation(id) {
  const conv = conversations.find(c => c.id === id);
  const title = conv ? conv.title : '此对话';
  const ok = await confirmAction({
    title: '删除对话',
    message: `确定删除「${title}」？此操作不可恢复。`,
    confirmText: '删除',
    tone: 'danger',
  });
  if (!ok) return;
  
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

export async function clearCurrentChat() {
  const conv = getActiveConversation();
  if (!conv) return;
  if (conv.messages.length > 0) {
    const ok = await confirmAction({
      title: '清空当前对话',
      message: '确定清空当前对话？此操作不可恢复。',
      confirmText: '清空',
      tone: 'danger',
    });
    if (!ok) return;
  }
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
  const userEl = appendMessageDOM(userMsg);
  userEl.dataset.messageIndex = String(conv.messages.length - 1);
  addUserMessageActions(userEl, userMsg, conv.messages.length - 1);
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
    agentStages: [],
    contextBudget: null,
    composerOverrides,
  };
  const msgEl = appendMessageDOM(assistantMsg, true);
  msgEl.classList.add('streaming');
  const contentEl = msgEl.querySelector('.message-content');
  const thinkingContent = msgEl.querySelector('.thinking-content');
  const toolContainer = msgEl.querySelector('.tool-calls-container');
  const agentContainer = msgEl.querySelector('.agent-timeline-container');
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
    contextSummary: conv.contextSummary || '',
    contextSummaryMeta: conv.contextSummaryMeta || null,
    cacheProfile: conv.cacheProfile || null,
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
      assistantMsg.cacheProfile = buildCacheProfile(counts, assistantMsg.contextBudget);
      conv.cacheProfile = assistantMsg.cacheProfile;
    },
    onToolRequest(event) {
      if (!assistantMsg.toolCalls) assistantMsg.toolCalls = [];
      const tool = createToolRecord(event);
      assistantMsg.toolCalls.push(tool);
      syncToolRuns(assistantMsg);
      renderToolCalls(toolContainer, assistantMsg.toolCalls, {
        requestId: event.requestId,
        onDecision(toolCallId, approved) {
          applyToolDecision(tool, approved);
          syncToolRuns(assistantMsg);
          approveToolRequest(event.requestId, toolCallId, approved);
          renderToolCalls(toolContainer, assistantMsg.toolCalls);
        }
      });
    },
    onToolResult(event) {
      if (!assistantMsg.toolCalls) assistantMsg.toolCalls = [];
      applyToolResult(assistantMsg.toolCalls, event);
      syncToolRuns(assistantMsg);
      renderToolCalls(toolContainer, assistantMsg.toolCalls);
    },
    onAgentStage(event) {
      assistantMsg.agentStages.push({
        ...event,
        at: new Date().toISOString(),
      });
      renderAgentTimeline(agentContainer, assistantMsg);
    },
    onContextBudget(event) {
      assistantMsg.contextBudget = event;
      renderAgentTimeline(agentContainer, assistantMsg);
    },
    onContextSummary(event) {
      conv.contextSummary = event.summary || conv.contextSummary || '';
      conv.contextSummaryUpdatedAt = event.updatedAt || new Date().toISOString();
      conv.contextSummaryMeta = event.meta || conv.contextSummaryMeta || null;
      renderAgentTimeline(agentContainer, assistantMsg);
    },
    async onDone(doneEvent = {}) {
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
      assistantMsg.stopped = Boolean(doneEvent.aborted);
      assistantMsg.speed = finalSpeed;
      assistantMsg.sourceWarning = hasUncitedSearchSource(assistantMsg, fullContent);
      if (assistantMsg.agentStages?.length) renderAgentTimeline(agentContainer, assistantMsg);
      conv.messages.push(assistantMsg);
      conv.usageTotals = getConversationUsageSummary(conv);
      msgEl.dataset.messageIndex = String(conv.messages.length - 1);
      persist();
      updateHeader();

      addMessageActions(msgEl, fullContent, assistantMsg.tokens, finalSpeed, conv.messages.length - 1);
      if (assistantMsg.stopped) renderStoppedNotice(msgEl.querySelector('.message-body'), conv.messages.length - 1);
      renderAssistantEvidence(msgEl.querySelector('.message-body'), assistantMsg);

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
      conv.usageTotals = getConversationUsageSummary(conv);
      msgEl.dataset.messageIndex = String(conv.messages.length - 1);
      persist();
      updateHeader();
      const renderRetry = () => {
        // Retry: remove failed message and re-stream
        conv.messages.pop();
        persist();
        msgEl.remove();
        isStreaming = false;
        abortController = null;
        doStream(conv);
      };
      if (fullContent.trim()) {
        contentEl.innerHTML = renderMarkdown(fullContent);
        postProcess(contentEl).then(refreshReadingNavigator);
        const errorHost = document.createElement('div');
        contentEl.appendChild(errorHost);
        renderErrorContent(errorHost, err.message, () => msgEl.remove(), renderRetry);
      } else {
        renderErrorContent(contentEl, err.message, () => msgEl.remove(), renderRetry);
      }
      
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
    el.dataset.messageIndex = String(idx);
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
      if (msg.stopped) renderStoppedNotice(el.querySelector('.message-body'), idx);

      if (msg.thinking) {
        const thinkingBlock = el.querySelector('.thinking-block');
        const thinkingContentEl = el.querySelector('.thinking-content');
        if (thinkingBlock && thinkingContentEl) {
          thinkingBlock.hidden = false;
          thinkingContentEl.textContent = msg.thinking;
        }
      }
      renderToolCalls(el.querySelector('.tool-calls-container'), msg.toolCalls || []);
      renderAgentTimeline(el.querySelector('.agent-timeline-container'), msg);
      renderAssistantEvidence(el.querySelector('.message-body'), msg);
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
      <div class="agent-timeline-container" hidden></div>
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
    const statusMeta = getToolStatusMeta(tool.status);
    block.dataset.statusTone = statusMeta.tone;
    const title = document.createElement('strong');
    title.textContent = getToolName(tool);
    const status = document.createElement('span');
    status.className = 'tool-call-status';
    status.textContent = `${statusMeta.icon} ${statusMeta.label}`;
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
    const security = createToolSecurityMeta(tool);
    if (security) block.appendChild(security);
    if (tool.parseError) {
      const parse = document.createElement('div');
      parse.className = 'tool-parse-error';
      parse.textContent = `参数解析失败：${tool.parseError}`;
      block.appendChild(parse);
    }
    const query = getToolQuery(tool);
    if (getToolName(tool) === 'web_search' && query) {
      const queryLine = document.createElement('div');
      queryLine.className = 'tool-call-query';
      queryLine.textContent = `实际搜索 query：${query}`;
      block.appendChild(queryLine);
    }

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
      const copyOutput = document.createElement('button');
      copyOutput.type = 'button';
      copyOutput.className = 'tool-copy-btn';
      copyOutput.textContent = '复制原始输出';
      copyOutput.addEventListener('click', async () => {
        await copyToClipboard(tool.output);
        showToast('工具输出已复制');
      });
      block.appendChild(copyOutput);
    }

    container.appendChild(block);
  }
}

function createToolMeta(tool) {
  const items = [];
  if (tool.requestedAt) items.push(`请求：${formatToolTime(tool.requestedAt)}`);
  if (tool.expiresAt && tool.status === 'pending') {
    const seconds = Math.max(0, Math.ceil((Date.parse(tool.expiresAt) - Date.now()) / 1000));
    items.push(`确认倒计时：${seconds}s`);
  }
  if (tool.completedAt) items.push(`完成：${formatToolTime(tool.completedAt)}`);
  const duration = getToolDurationMs(tool);
  if (duration !== null) items.push(`耗时：${duration}ms`);
  if (items.length === 0) return null;
  const meta = document.createElement('div');
  meta.className = 'tool-call-meta';
  meta.textContent = items.join(' · ');
  return meta;
}

function createToolSecurityMeta(tool) {
  if (!tool.security) return null;
  const items = [];
  if (tool.security.riskLevel) items.push(`风险：${tool.security.riskLevel}`);
  if (tool.security.sandbox) items.push(`沙箱：${tool.security.sandbox}`);
  if (tool.security.envPolicy) items.push(`环境：${tool.security.envPolicy}`);
  if (tool.security.network) items.push(`网络：${tool.security.network}`);
  if (tool.security.redaction) items.push('输出脱敏');
  if (!items.length) return null;
  const meta = document.createElement('div');
  meta.className = 'tool-security-meta';
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

export function renderAgentTimeline(container, message = {}) {
  if (!container) return;
  container.innerHTML = '';
  const stages = Array.isArray(message.agentStages) ? message.agentStages : [];
  const contextBudget = message.contextBudget;
  if (stages.length === 0 && !contextBudget) {
    container.hidden = true;
    return;
  }

  container.hidden = false;
  const panel = document.createElement('div');
  panel.className = 'agent-timeline';
  const header = document.createElement('div');
  header.className = 'agent-timeline-header';
  const latest = stages[stages.length - 1];
  header.textContent = latest ? `Agent：${formatAgentStageLabel(latest)}` : 'Agent 过程';
  panel.appendChild(header);

  if (contextBudget) {
    const budget = document.createElement('div');
    budget.className = `agent-budget${contextBudget.trimmed ? ' is-trimmed' : ''}`;
    const parts = [
      `输入预算 ${contextBudget.maxInputTokens || 0}`,
      `预计 ${contextBudget.estimatedInputTokens || 0}`,
      contextBudget.prefixFingerprint ? `prefix ${contextBudget.prefixFingerprint}` : '',
      contextBudget.trimmed ? `裁剪 ${contextBudget.droppedCount || 0} 条` : '未裁剪',
      contextBudget.summaryUsed ? '已用摘要' : '',
    ].filter(Boolean);
    budget.textContent = parts.join(' · ');
    panel.appendChild(budget);
  }

  const list = document.createElement('ol');
  list.className = 'agent-stage-list';
  for (const stage of collapseAgentStages(stages)) {
    const item = document.createElement('li');
    item.className = `agent-stage stage-${String(stage.stage || 'unknown').replace(/[^a-z0-9_-]/gi, '-')}`;
    const title = document.createElement('span');
    title.className = 'agent-stage-title';
    title.textContent = formatAgentStageLabel(stage);
    const meta = document.createElement('span');
    meta.className = 'agent-stage-meta';
    meta.textContent = [
      stage.round ? `第 ${stage.round} 轮` : '',
      stage.toolName || '',
      stage.warning || stage.stopReason || '',
    ].filter(Boolean).join(' · ');
    item.append(title);
    if (meta.textContent) item.appendChild(meta);
    list.appendChild(item);
  }
  panel.appendChild(list);
  container.appendChild(panel);
}

function collapseAgentStages(stages) {
  return stages.slice(-12);
}

function formatAgentStageLabel(stage = {}) {
  const labels = {
    plan: '规划工具',
    summary: '压缩记忆',
    warning: '配置提示',
    model: '模型思考',
    tool: '准备工具',
    tool_pending: '等待确认',
    tool_approved: '已确认工具',
    tool_denied: '工具被拒绝',
    tool_result: '已获得结果',
    tool_failed: '工具失败',
    final: '整理回答',
    stop: '已停止',
  };
  if (stage.stage === 'plan' && stage.intent?.toolMode) {
    const mode = stage.intent.toolMode === 'none' ? '普通回答' : stage.intent.toolMode;
    return `规划工具：${mode}`;
  }
  return labels[stage.stage] || String(stage.stage || 'Agent');
}

function syncToolRuns(message) {
  message.toolRuns = buildToolRuns(message.toolCalls || []);
}

function formatToolTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function hasSearchWithoutCitedSource(message, content) {
  return hasUncitedSearchSource(message, content);
}

function renderAssistantEvidence(container, message) {
  if (!container) return;
  container.querySelector('.source-grounding-warning')?.remove();
  container.querySelector('.source-grounding-card')?.remove();
  const grounding = getSearchGrounding(message, message?.content || '');
  if (!grounding.hasSearch) return;

  const card = document.createElement('div');
  card.className = `source-grounding-card${grounding.warning ? ' is-warning' : ' is-grounded'}`;
  const title = document.createElement('div');
  title.className = 'source-grounding-title';
  title.textContent = grounding.warning ? '联网结果未被明确引用' : '已引用联网来源';
  const meta = document.createElement('div');
  meta.className = 'source-grounding-meta';
  meta.textContent = [
    grounding.queries[0] ? `query: ${grounding.queries[0]}` : '',
    `${grounding.sources.length} 个来源`,
  ].filter(Boolean).join(' · ');
  card.append(title, meta);
  if (grounding.sources.length) {
    const list = document.createElement('div');
    list.className = 'source-grounding-list';
    for (const source of grounding.sources.slice(0, 3)) {
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = source.title || source.url;
      list.appendChild(link);
    }
    card.appendChild(list);
  }
  container.appendChild(card);
  if (grounding.warning) {
    const warning = document.createElement('div');
    warning.className = 'source-grounding-warning';
    warning.textContent = grounding.hasSources
      ? '本轮调用了联网搜索，但最终回答没有引用搜索来源 URL，请谨慎核验。'
      : '本轮调用了联网搜索，但工具没有返回可用来源 URL，请谨慎核验。';
    container.appendChild(warning);
  }
}

function renderStoppedNotice(container, msgIndex) {
  if (!container || container.querySelector('.generation-stopped-notice')) return;
  const notice = document.createElement('div');
  notice.className = 'generation-stopped-notice';
  const text = document.createElement('span');
  text.textContent = '生成已停止，已保留当前内容。';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '继续生成';
  button.addEventListener('click', () => continueFromResponseAt(msgIndex));
  notice.append(text, button);
  container.appendChild(notice);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
  delBtn.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: '删除消息',
      message: '删除这条消息和其后的所有回复？此操作不可恢复。',
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
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
      const usage = normalizeTokenUsage(tokens);
      const prefix = usage.source === 'provider' ? '实测' : (usage.source === 'mixed' ? '混合' : '估算');
      parts.push(`${prefix} ${usage.total} tokens`);
      if (usage.cacheHit > 0) parts.push(`命中 ${Math.round(usage.cacheHitRate * 100)}%`);
      if (usage.cost?.estimatedCostUsd > 0) parts.push(`$${usage.cost.estimatedCostUsd.toFixed(6)}`);
      if (usage.rounds > 1) parts.push(`${usage.rounds} 轮`);
    }
    if (speed) parts.push(`${speed} tok/s`);
    badge.textContent = parts.join(' · ');
    if (tokens) badge.title = formatTokenUsageTitle(tokens);
    actions.appendChild(badge);
  }

  msgEl.querySelector('.message-body').appendChild(actions);
}

function formatTokenUsageTitle(tokens) {
  const usage = normalizeTokenUsage(tokens);
  const profile = tokens?.cacheProfile && typeof tokens.cacheProfile === 'object' ? tokens.cacheProfile : {};
  const lines = [
    `输入: ${usage.input}`,
    `输出: ${usage.output}`,
    `总计: ${usage.total}`,
    `统计来源: ${usage.source === 'provider' ? '服务商真实 usage' : (usage.source === 'mixed' ? '真实和估算混合' : '本地估算')}`,
  ];
  if (usage.reasoning > 0) lines.push(`思考: ${usage.reasoning}`);
  if (usage.cacheHit > 0 || usage.cacheMiss > 0) {
    lines.push(`缓存命中: ${usage.cacheHit}`);
    lines.push(`缓存未命中: ${usage.cacheMiss}`);
    lines.push(`命中率: ${Math.round(usage.cacheHitRate * 100)}%`);
  }
  if (usage.cost) {
    lines.push(`估算成本: $${Number(usage.cost.estimatedCostUsd || 0).toFixed(6)}`);
    lines.push(`缓存节省: $${Number(usage.cost.estimatedSavingsUsd || 0).toFixed(6)}`);
  }
  if (tokens.prefixFingerprint) lines.push(`Prefix: ${tokens.prefixFingerprint}`);
  if (profile.systemHash) lines.push(`System hash: ${profile.systemHash}`);
  if (profile.toolsHash) lines.push(`Tools hash: ${profile.toolsHash}`);
  if (profile.workspaceSignature) lines.push(`Workspace hash: ${profile.workspaceSignature}`);
  if (Array.isArray(profile.toolNames) && profile.toolNames.length) lines.push(`工具 schema: ${profile.toolNames.join(', ')}`);
  if (tokens.byPurpose && Object.keys(tokens.byPurpose).length) {
    lines.push(`用途: ${Object.entries(tokens.byPurpose).map(([key, value]) => `${key}=${value}`).join(', ')}`);
  }
  if (usage.rounds > 1) lines.push(`Agent 轮次: ${usage.rounds}`);
  const warnings = [...(usage.warnings || []), ...(tokens.cacheStabilityWarnings || []), ...(profile.cacheStabilityWarnings || [])];
  if (warnings.length) lines.push(`提示: ${[...new Set(warnings)].join('；')}`);
  return lines.join('\n');
}

function buildCacheProfile(tokens, contextBudget) {
  const usage = normalizeTokenUsage(tokens);
  const profile = tokens?.cacheProfile && typeof tokens.cacheProfile === 'object' ? tokens.cacheProfile : {};
  return {
    ...profile,
    prefixFingerprint: contextBudget?.prefixFingerprint || tokens?.prefixFingerprint || profile.prefixFingerprint || '',
    prefixTokens: contextBudget?.prefixTokens || tokens?.prefixTokens || profile.prefixTokens || 0,
    prefixBytes: contextBudget?.prefixBytes || tokens?.prefixBytes || profile.prefixBytes || 0,
    cacheStabilityWarnings: tokens?.cacheStabilityWarnings || contextBudget?.cacheStabilityWarnings || profile.cacheStabilityWarnings || [],
    cacheHit: usage.cacheHit,
    cacheMiss: usage.cacheMiss,
    cacheHitRate: usage.cacheHitRate,
    estimatedCostUsd: usage.cost?.estimatedCostUsd || 0,
    estimatedSavingsUsd: usage.cost?.estimatedSavingsUsd || 0,
  };
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
    const msgEl = wrapper.closest('.message.assistant');
    const msgIndex = Number.parseInt(msgEl?.dataset.messageIndex || '-1', 10);
    const conv = getActiveConversation();
    const msg = Number.isInteger(msgIndex) && msgIndex >= 0 ? conv?.messages?.[msgIndex] : null;
    const tool = msg ? {
      id: `manual_run_${uid()}`,
      name: 'run_code',
      args: { language, code },
      risk: '用户从代码块手动确认运行代码片段。',
      status: 'approved',
      requestedAt: new Date().toISOString(),
    } : null;
    if (msg && tool) {
      msg.toolCalls = [...(msg.toolCalls || []), tool];
      syncToolRuns(msg);
      renderToolCalls(msgEl.querySelector('.tool-calls-container'), msg.toolCalls);
      persist();
    }
    try {
      const output = await runTool('run_code', { language, code });
      if (tool) {
        applyToolResult(msg.toolCalls, {
          toolCallId: tool.id,
          name: 'run_code',
          args: { language, code },
          ok: true,
          output,
        });
        syncToolRuns(msg);
        renderToolCalls(msgEl.querySelector('.tool-calls-container'), msg.toolCalls);
        persist();
      }
      confirmBox.remove();
      renderCodeOutput(wrapper, output, true);
    } catch (error) {
      if (tool) {
        applyToolResult(msg.toolCalls, {
          toolCallId: tool.id,
          name: 'run_code',
          args: { language, code },
          ok: false,
          output: error.message || String(error),
        });
        syncToolRuns(msg);
        renderToolCalls(msgEl.querySelector('.tool-calls-container'), msg.toolCalls);
        persist();
      }
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
  closeConversationMenu();
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
    item.dataset.conversationId = conv.id;
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
        <button class="conv-menu-trigger icon-btn-sm" title="更多操作" aria-label="打开对话操作菜单" aria-haspopup="menu" aria-expanded="false">
          <span aria-hidden="true">•••</span>
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

    item.querySelector('.conv-menu-trigger')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleConversationMenu(conv.id, e.currentTarget);
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
    
    $convList.appendChild(item);
  });
}

function toggleConversationMenu(id, anchor) {
  if (conversationMenuEl?.dataset.conversationId === id) {
    closeConversationMenu();
    return;
  }
  openConversationMenu(id, anchor);
}

function openConversationMenu(id, anchor) {
  const conv = conversations.find(c => c.id === id);
  if (!conv || !anchor) return;
  closeConversationMenu();

  anchor.setAttribute('aria-expanded', 'true');
  anchor.closest('.conversation-item')?.classList.add('is-menu-open');

  const menu = document.createElement('div');
  menu.className = 'conversation-action-menu';
  menu.dataset.conversationId = id;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `对话操作：${conv.title}`);

  const actions = [
    { label: '重命名', icon: '✎', onClick: () => promptRenameConversation(id) },
    { label: '编辑标签', icon: '#', onClick: () => editConversationTags(id) },
    { label: '移动到文件夹', icon: '▣', onClick: () => moveConversationFolder(id) },
    { label: conv.pinned ? '取消置顶' : '置顶聊天', icon: '⌃', onClick: () => togglePinConversation(id) },
    { label: conv.archivedAt ? '取消归档' : '归档', icon: conv.archivedAt ? '↩' : '□', onClick: () => toggleArchiveConversation(id) },
    { label: '删除', icon: '⌫', tone: 'danger', onClick: () => deleteConversation(id) },
  ];

  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `conversation-menu-item${action.tone === 'danger' ? ' is-danger' : ''}`;
    button.setAttribute('role', 'menuitem');

    const icon = document.createElement('span');
    icon.className = 'conversation-menu-icon';
    icon.textContent = action.icon;

    const text = document.createElement('span');
    text.textContent = action.label;

    button.append(icon, text);
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      closeConversationMenu();
      await action.onClick();
    });
    menu.appendChild(button);
  }

  document.body.appendChild(menu);
  positionConversationMenu(menu, anchor);
  conversationMenuEl = menu;

  const onPointerDown = (event) => {
    if (menu.contains(event.target) || anchor.contains(event.target)) return;
    closeConversationMenu();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') closeConversationMenu();
  };
  const onReposition = () => positionConversationMenu(menu, anchor);

  setTimeout(() => document.addEventListener('pointerdown', onPointerDown, true), 0);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onReposition, { passive: true });
  window.addEventListener('scroll', onReposition, { passive: true, capture: true });

  conversationMenuCleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onReposition);
    window.removeEventListener('scroll', onReposition, true);
    anchor.setAttribute('aria-expanded', 'false');
    anchor.closest('.conversation-item')?.classList.remove('is-menu-open');
  };

  menu.querySelector('button')?.focus();
}

function closeConversationMenu() {
  if (conversationMenuCleanup) conversationMenuCleanup();
  conversationMenuCleanup = null;
  conversationMenuEl?.remove();
  conversationMenuEl = null;
}

function positionConversationMenu(menu, anchor) {
  if (!menu || !anchor?.isConnected) {
    closeConversationMenu();
    return;
  }

  const rect = anchor.getBoundingClientRect();
  const width = Math.max(196, menu.offsetWidth || 196);
  const height = menu.offsetHeight || 260;
  const margin = 8;
  const left = clampNumber(rect.right - width, margin, window.innerWidth - width - margin);
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 8);

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

async function promptRenameConversation(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;

  const next = await promptText({
    title: '重命名对话',
    message: '输入新的对话名称。',
    value: conv.title || '',
    placeholder: '对话名称',
  });
  if (next === null) return;

  const title = next.trim();
  if (title) renameConversation(id, title);
}

function clampNumber(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
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

async function deleteSelectedConversations() {
  if (selectedConversationIds.size === 0) return;
  const ok = await confirmAction({
    title: '批量删除对话',
    message: `确定删除选中的 ${selectedConversationIds.size} 个对话？此操作不可恢复。`,
    confirmText: '删除',
    tone: 'danger',
  });
  if (!ok) return;
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

async function editConversationTags(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  const next = await promptText({
    title: '编辑标签',
    message: '输入标签，用逗号、分号或换行分隔。留空表示清除标签。',
    value: (conv.tags || []).join(', '),
    placeholder: '例如：项目, 排障, 收藏',
  });
  if (next === null) return;
  conv.tags = parseTagsInput(next);
  persist();
  renderConversationList(document.getElementById('search-input')?.value.trim() || '');
}

async function moveConversationFolder(id) {
  const conv = conversations.find(c => c.id === id);
  if (!conv) return;
  const next = await promptText({
    title: '移动到文件夹',
    message: '输入文件夹名称。留空表示移出文件夹。',
    value: conv.folderId || '',
    placeholder: '例如：工作 / 学习 / 项目',
  });
  if (next === null) return;
  conv.folderId = normalizeFolderName(next);
  persist();
  renderConversationList(document.getElementById('search-input')?.value.trim() || '');
}

function updateHeader() {
  const conv = getActiveConversation();
  const settings = getSettings();
  $chatTitle.textContent = conv ? conv.title : '新的对话';
  const usage = conv ? getConversationUsageSummary(conv) : null;
  const usageText = usage && usage.total > 0
    ? ` · 本会话 ${usage.total} tokens${usage.cacheHit > 0 ? ` · 命中 ${Math.round(usage.cacheHitRate * 100)}%` : ''}`
    : '';
  $modelName.textContent = `${settings.model}${usageText}`;
  $modelName.title = usage && usage.total > 0
    ? `输入 ${usage.input} · 输出 ${usage.output} · 思考 ${usage.reasoning} · 缓存命中 ${usage.cacheHit}`
    : settings.model;
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
