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

import { approveToolRequest, streamChat, extractContextMentions, getSettings, runTool, normalizeTokenUsage, getConversationUsageSummary } from './api.js';
import { loadConversations, saveConversations } from './client-store.js';
import {
  SIDEBAR_FILTERS,
  filterConversations,
  getConversationGroup,
  buildRelevantMemoryContext,
  buildTaskCheckpoint,
  buildTaskCheckpointContext,
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
import { buildArtifactDownloadName, createSandboxedHtmlDocument, extractHtmlArtifacts } from './artifacts.js';
import {
  applyToolDecision,
  applyToolResult,
  buildToolEvidencePayload,
  buildToolRuns,
  createToolRecord,
  extractLocalCitations,
  extractRunCodeResult,
  extractToolSources,
  extractWorkspaceSymbolResult,
  formatToolArgs,
  getLocalFileGrounding,
  getSearchGrounding,
  getToolDurationMs,
  getToolName,
  getToolQuery,
  getToolStatusMeta,
  hasSearchWithoutCitedSource as hasUncitedSearchSource,
  hasLocalFilesWithoutCitedSource as hasUncitedLocalSource,
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
let usageTelemetryPanelEl = null;
let evidenceDrawerEl = null;

let $messages, $welcome, $convList, $chatTitle, $modelName, $chatUsageBadge, $evidencePanelBtn;

const MARKDOWN_RENDER_CACHE_LIMIT = 240;
const HISTORICAL_FULL_RENDER_LIMIT = 60;
const HISTORICAL_COMPACT_MIN_CHARS = 800;
const ANSWER_ACTION_CONTEXT_LIMIT = 6000;
const markdownRenderCache = new Map();

export async function initChat() {
  $messages = document.getElementById('chat-messages');
  $welcome = document.getElementById('welcome-screen');
  $convList = document.getElementById('conversation-list');
  $chatTitle = document.getElementById('chat-title');
  $modelName = document.getElementById('model-name');
  $chatUsageBadge = document.getElementById('chat-usage-badge');
  $evidencePanelBtn = document.getElementById('evidence-panel-btn');
  bindUsageTelemetryPanel();
  bindEvidenceDrawer();

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
    modelContent: options.modelContent ? String(options.modelContent).trim() : '',
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
  refreshConversationTaskCheckpoint(conv);
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
  refreshConversationTaskCheckpoint(conv);
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
    model: getSettings().model || '',
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
    .map(m => ({ role: m.role, content: m.modelContent || m.content, attachments: m.attachments || [] }));

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

  const memoryContext = maybeAppendRelevantMemory(apiMessages, conv);
  if (memoryContext?.hits?.length) {
    assistantMsg.agentStages.push({
      stage: 'memory',
      round: 0,
      warning: `检索到 ${memoryContext.hits.length} 条相关历史`,
    });
    renderAgentTimeline(agentContainer, assistantMsg);
  }
  if (memoryContext?.taskCheckpointUsed) {
    const checkpointSummary = formatTaskCheckpointStageSummary(memoryContext.taskCheckpoint);
    assistantMsg.agentStages.push({
      stage: 'checkpoint',
      round: 0,
      warning: checkpointSummary || '已使用长期任务状态，作为本轮尾部上下文以保持缓存前缀稳定',
    });
    renderAgentTimeline(agentContainer, assistantMsg);
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

      const finalHtml = renderMarkdown(fullContent);
      contentEl.innerHTML = finalHtml;
      primeMarkdownRenderCache(fullContent, finalHtml);
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
      assistantMsg.sourceWarning = hasUncitedSearchSource(assistantMsg, fullContent) || hasUncitedLocalSource(assistantMsg, fullContent);
      if (assistantMsg.agentStages?.length) renderAgentTimeline(agentContainer, assistantMsg);
      conv.messages.push(assistantMsg);
      refreshConversationTaskCheckpoint(conv);
      conv.usageTotals = getConversationUsageSummary(conv);
      msgEl.dataset.messageIndex = String(conv.messages.length - 1);
      persist();
      updateHeader();

      renderAssistantAnswerHeader(msgEl.querySelector('.answer-header-container'), assistantMsg);
      addMessageActions(msgEl, fullContent, assistantMsg.tokens, finalSpeed, conv.messages.length - 1);
      if (assistantMsg.stopped) renderStoppedNotice(msgEl.querySelector('.message-body'), conv.messages.length - 1);
      renderAssistantArtifacts(msgEl.querySelector('.artifact-container'), assistantMsg);
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
      renderAssistantAnswerHeader(msgEl.querySelector('.answer-header-container'), assistantMsg);
      conv.messages.push(assistantMsg);
      refreshConversationTaskCheckpoint(conv);
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
        const partialHtml = renderMarkdown(fullContent);
        contentEl.innerHTML = partialHtml;
        primeMarkdownRenderCache(fullContent, partialHtml);
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

function getCachedRenderedMarkdown(content = '') {
  const key = getMarkdownCacheKey(content);
  if (markdownRenderCache.has(key)) {
    const html = markdownRenderCache.get(key);
    markdownRenderCache.delete(key);
    markdownRenderCache.set(key, html);
    return html;
  }
  const html = renderMarkdown(content);
  primeMarkdownRenderCache(content, html);
  return html;
}

function primeMarkdownRenderCache(content = '', html = '') {
  const key = getMarkdownCacheKey(content);
  if (markdownRenderCache.has(key)) markdownRenderCache.delete(key);
  markdownRenderCache.set(key, html);
  while (markdownRenderCache.size > MARKDOWN_RENDER_CACHE_LIMIT) {
    const oldestKey = markdownRenderCache.keys().next().value;
    markdownRenderCache.delete(oldestKey);
  }
}

function getMarkdownCacheKey(content = '') {
  return `${content.length}:${hashString(content)}`;
}

function hashString(value = '') {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function shouldCompactHistoricalMessage(totalMessages, index, message = {}, limit = HISTORICAL_FULL_RENDER_LIMIT) {
  if (message.role !== 'assistant') return false;
  if (message.error || message.stopped || message.thinking) return false;
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) return false;
  if (Array.isArray(message.toolRuns) && message.toolRuns.length > 0) return false;
  if (Array.isArray(message.agentStages) && message.agentStages.length > 0) return false;
  const content = String(message.content || '');
  if (content.length < HISTORICAL_COMPACT_MIN_CHARS) return false;
  return (Number(totalMessages) - Number(index)) > limit;
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

function renderCompactAssistantMessage(contentEl, msg, idx) {
  contentEl.innerHTML = '';
  contentEl.classList.add('is-compact');

  const card = document.createElement('div');
  card.className = 'message-compact-card';

  const meta = document.createElement('div');
  meta.className = 'message-compact-meta';
  meta.textContent = `较早回复已折叠 · ${String(msg.content || '').length} 字符`;

  const preview = document.createElement('p');
  preview.className = 'message-compact-preview';
  preview.textContent = getCompactMessagePreview(msg.content);

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'message-compact-expand';
  expand.textContent = '展开完整内容';
  expand.addEventListener('click', async () => {
    contentEl.classList.remove('is-compact');
    contentEl.innerHTML = getCachedRenderedMarkdown(msg.content);
    await postProcess(contentEl);
    const conv = getActiveConversation();
    const currentMsg = conv?.messages?.[idx] || msg;
    if (currentMsg.stopped) renderStoppedNotice(contentEl.closest('.message-body'), idx);
    refreshReadingNavigator();
  });

  card.append(meta, preview, expand);
  contentEl.appendChild(card);
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
          contentEl.innerHTML = getCachedRenderedMarkdown(msg.content);
          postProcess(contentEl).then(refreshReadingNavigator);
          const errorWrap = document.createElement('div');
          renderErrorContent(errorWrap, msg.error);
          contentEl.appendChild(errorWrap.firstElementChild);
        } else {
          renderErrorContent(contentEl, msg.error);
        }
      } else if (shouldCompactHistoricalMessage(conv.messages.length, idx, msg)) {
        renderCompactAssistantMessage(contentEl, msg, idx);
      } else {
        contentEl.innerHTML = getCachedRenderedMarkdown(msg.content);
        postProcess(contentEl).then(refreshReadingNavigator);
      }
      renderAssistantAnswerHeader(el.querySelector('.answer-header-container'), msg);
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
      renderAssistantArtifacts(el.querySelector('.artifact-container'), msg);
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
      ${msg.role === 'assistant' ? '<div class="answer-header-container" hidden></div>' : ''}
      ${thinkingHtml}
      <div class="agent-timeline-container" hidden></div>
      <div class="tool-calls-container" hidden></div>
      <div class="message-content">${contentHtml}</div>
      <div class="artifact-container" hidden></div>
    </div>
  `;

  if (msg.role === 'user' && Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    const content = el.querySelector('.message-content');
    content.appendChild(renderAttachmentStrip(msg.attachments));
  }
  if (msg.role === 'user') {
    const contextStrip = renderContextMentionStrip(msg.content);
    if (contextStrip) el.querySelector('.message-content')?.appendChild(contextStrip);
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

export function renderContextMentionStrip(content = '') {
  const mentions = extractContextMentions(content);
  if (mentions.length === 0) return null;
  const strip = document.createElement('div');
  strip.className = 'message-context-mentions';
  const label = document.createElement('span');
  label.className = 'message-context-label';
  label.textContent = '选定上下文';
  strip.appendChild(label);
  for (const mention of mentions) {
    const chip = document.createElement('span');
    chip.className = `message-context-chip type-${mention.type}`;
    chip.textContent = mention.type === 'folder'
      ? `目录 ${mention.path}`
      : (mention.type === 'symbol' ? `符号 ${mention.path}` : `文件 ${mention.path}`);
    chip.title = mention.path;
    strip.appendChild(chip);
  }
  return strip;
}

export function renderToolCalls(container, toolCalls = [], options = {}) {
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
    const nextAction = createToolNextAction(tool);
    if (nextAction) block.appendChild(nextAction);
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
      const outputSummary = createToolOutputSummary(tool.output, tool);
      if (outputSummary) block.appendChild(outputSummary);

      const preview = createToolOutputPreview(tool.output, getToolName(tool));
      if (preview) block.appendChild(preview);

      const runCard = createRunCodeExperimentCard(tool);
      if (runCard) block.appendChild(runCard);

      const output = document.createElement('details');
      output.className = 'tool-call-output';
      const summary = document.createElement('summary');
      summary.textContent = tool.ok === false ? '查看失败信息' : '查看工具结果';
      const pre = document.createElement('pre');
      pre.textContent = tool.output;
      output.append(summary, pre);
      block.appendChild(output);
    }
    if (tool.contextOutput && tool.contextOutput !== tool.output) {
      const contextOutput = document.createElement('details');
      contextOutput.className = 'tool-call-output tool-context-output';
      const summary = document.createElement('summary');
      const rawTokens = tool.rawOutputTokens || 0;
      const contextTokens = tool.contextOutputTokens || 0;
      summary.textContent = rawTokens && contextTokens
        ? `查看进入上下文的压缩输出 (${rawTokens}→${contextTokens} tokens)`
        : '查看进入上下文的压缩输出';
      const pre = document.createElement('pre');
      pre.textContent = tool.contextOutput;
      contextOutput.append(summary, pre);
      block.appendChild(contextOutput);
    }

    const copyRow = document.createElement('div');
    copyRow.className = 'tool-copy-row';
    const copyEvidence = document.createElement('button');
    copyEvidence.type = 'button';
    copyEvidence.className = 'tool-copy-btn';
    copyEvidence.textContent = '复制证据 JSON';
    copyEvidence.addEventListener('click', async () => {
      await copyToClipboard(JSON.stringify(buildToolEvidencePayload(tool), null, 2));
      showToast('工具证据已复制');
    });
    copyRow.appendChild(copyEvidence);
    if (tool.output) {
      const copyOutput = document.createElement('button');
      copyOutput.type = 'button';
      copyOutput.className = 'tool-copy-btn';
      copyOutput.textContent = '复制原始输出';
      copyOutput.addEventListener('click', async () => {
        await copyToClipboard(tool.output);
        showToast('工具输出已复制');
      });
      copyRow.appendChild(copyOutput);
    }
    if (tool.contextOutput && tool.contextOutput !== tool.output) {
      const copyContext = document.createElement('button');
      copyContext.type = 'button';
      copyContext.className = 'tool-copy-btn';
      copyContext.textContent = '复制上下文输出';
      copyContext.addEventListener('click', async () => {
        await copyToClipboard(tool.contextOutput);
        showToast('上下文输出已复制');
      });
      copyRow.appendChild(copyContext);
    }
    block.appendChild(copyRow);

    container.appendChild(block);
  }
}

function createToolMeta(tool) {
  const items = [];
  if (tool.requestedAt) items.push(`请求：${formatToolTime(tool.requestedAt)}`);
  if (tool.autoApproved) items.push('审批：自动通过');
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

function createToolNextAction(tool) {
  if (!tool.nextAction) return null;
  const next = document.createElement('div');
  next.className = 'tool-next-action';
  const label = document.createElement('span');
  label.className = 'tool-next-action-label';
  label.textContent = '下一步';
  const text = document.createElement('span');
  text.className = 'tool-next-action-text';
  text.textContent = tool.nextAction;
  next.append(label, text);
  return next;
}

function createToolOutputSummary(outputText, tool = {}) {
  const text = compactToolOutputSummaryText(outputText);
  if (!text) return null;
  const summary = document.createElement('div');
  summary.className = `tool-output-summary${tool.ok === false ? ' is-error' : ''}`;
  const label = document.createElement('span');
  label.className = 'tool-output-summary-label';
  label.textContent = tool.ok === false ? '失败摘要' : '输出摘要';
  const body = document.createElement('span');
  body.className = 'tool-output-summary-text';
  body.textContent = text;
  summary.append(label, body);
  return summary;
}

function compactToolOutputSummaryText(outputText) {
  const lines = String(outputText || '')
    .replace(/```[\s\S]*?```/g, '[代码片段]')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  const joined = lines.slice(0, 6).join(' · ');
  return joined.length > 420 ? `${joined.slice(0, 420).trim()}...` : joined;
}

function createToolOutputPreview(outputText, toolName = '') {
  const sources = extractToolSources(outputText);
  const localCitations = extractLocalCitations(outputText, toolName);
  const workspaceSymbol = extractWorkspaceSymbolResult(outputText, toolName);
  if (sources.length === 0 && localCitations.length === 0 && !workspaceSymbol?.result) return null;

  const preview = document.createElement('div');
  preview.className = 'tool-source-preview';

  if (sources.length > 0) {
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
  }

  if (localCitations.length > 0) {
    const label = document.createElement('div');
    label.className = 'tool-source-label';
    label.textContent = `本地引用 (${localCitations.length})`;
    preview.appendChild(label);

    const list = document.createElement('div');
    list.className = 'tool-local-citation-list';
    for (const citation of localCitations.slice(0, 6)) {
      const chip = document.createElement('span');
      chip.className = 'tool-local-citation';
      chip.textContent = citation.label;
      chip.title = citation.file;
      list.appendChild(chip);
    }
    preview.appendChild(list);
  }

  if (workspaceSymbol?.result) {
    const label = document.createElement('div');
    label.className = 'tool-source-label';
    label.textContent = '符号定义';
    preview.appendChild(label);

    const item = document.createElement('div');
    item.className = 'tool-source-item';
    const title = document.createElement('span');
    title.className = 'tool-source-title';
    title.textContent = `${workspaceSymbol.symbol} · ${workspaceSymbol.result.file}:${workspaceSymbol.result.startLine}-${workspaceSymbol.result.endLine}`;
    item.appendChild(title);
    if (workspaceSymbol.result.signature) {
      const signature = document.createElement('span');
      signature.className = 'tool-source-date';
      signature.textContent = workspaceSymbol.result.signature;
      item.appendChild(signature);
    }
    preview.appendChild(item);
  }

  return preview;
}

function createRunCodeExperimentCard(tool = {}) {
  if (getToolName(tool) !== 'run_code' || !tool.output) return null;
  const result = tool.runResult || extractRunCodeResult(tool.output, 'run_code');
  if (!result) return null;
  const card = document.createElement('div');
  card.className = `run-experiment-card${result.ok ? ' is-success' : ' is-failed'}`;

  const header = document.createElement('div');
  header.className = 'run-experiment-header';
  const title = document.createElement('strong');
  title.textContent = '代码实验';
  const status = document.createElement('span');
  status.className = 'run-experiment-status';
  status.textContent = result.ok ? '成功' : (result.timedOut ? '超时' : '失败');
  header.append(title, status);
  card.appendChild(header);

  const meta = document.createElement('div');
  meta.className = 'run-experiment-meta';
  meta.textContent = [
    `语言 ${result.language || tool.args?.language || 'unknown'}`,
    `退出码 ${result.exitCode ?? 'unknown'}`,
    `耗时 ${result.durationMs}ms`,
    `代码 ${result.codeLength} chars`,
    result.stdinBytes ? `stdin ${result.stdinBytes} bytes` : '',
  ].filter(Boolean).join(' · ');
  card.appendChild(meta);

  if (result.failureHint) {
    const hint = document.createElement('div');
    hint.className = 'run-experiment-hint';
    hint.textContent = result.failureHint;
    card.appendChild(hint);
  }

  const outputs = document.createElement('div');
  outputs.className = 'run-experiment-outputs';
  if (result.stdoutPreview) outputs.appendChild(createRunOutputBlock('STDOUT', result.stdoutPreview, result.stdoutBytes));
  if (result.stderrPreview) outputs.appendChild(createRunOutputBlock('STDERR', result.stderrPreview, result.stderrBytes));
  if (outputs.children.length) card.appendChild(outputs);
  return card;
}

function createRunOutputBlock(label, text, bytes) {
  const block = document.createElement('details');
  block.className = 'run-output-block';
  const summary = document.createElement('summary');
  summary.textContent = `${label}${bytes ? ` · ${bytes} bytes` : ''}`;
  const pre = document.createElement('pre');
  pre.textContent = text;
  block.append(summary, pre);
  return block;
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

  const planStage = stages.find((stage) => stage?.stage === 'plan' && stage.planSummary);
  const planCard = createAgentPlanCard(planStage?.planSummary);
  if (planCard) panel.appendChild(planCard);

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

function createAgentPlanCard(plan = null) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null;
  const card = document.createElement('section');
  card.className = 'agent-plan-card';

  const header = document.createElement('div');
  header.className = 'agent-plan-header';
  const title = document.createElement('strong');
  title.textContent = '任务计划';
  const meta = document.createElement('span');
  meta.textContent = [
    plan.mode && plan.mode !== 'none' ? plan.mode : '普通回答',
    plan.maxRounds ? `最多 ${plan.maxRounds} 轮` : '',
    Number.isFinite(Number(plan.confidence)) ? `置信 ${Math.round(Number(plan.confidence) * 100)}%` : '',
  ].filter(Boolean).join(' · ');
  header.append(title, meta);
  card.appendChild(header);

  const steps = document.createElement('ol');
  steps.className = 'agent-plan-steps';
  for (const step of plan.steps.slice(0, 8)) {
    const item = document.createElement('li');
    item.textContent = String(step || '').trim();
    steps.appendChild(item);
  }
  card.appendChild(steps);

  appendAgentPlanChips(card, '预计工具', plan.selectedTools);
  appendAgentPlanChips(card, '候选工具', plan.candidateTools);
  appendAgentSearchPlan(card, plan.searchPlan);
  appendAgentPlanChips(card, '缺少配置', plan.missingPrerequisites, 'is-warning');
  appendAgentPlanChips(card, '审批策略', plan.approvalPolicy);
  appendAgentPlanChips(card, '提示', plan.warnings, 'is-warning');
  card.appendChild(createAgentPlanActions(plan));
  return card;
}

function createAgentPlanActions(plan = {}) {
  const actions = document.createElement('div');
  actions.className = 'agent-plan-actions';
  [
    ['execute_all', '执行全部', '按这个计划继续执行'],
    ['single_step', '单步执行', '只执行计划中的下一步'],
    ['revise', '修改计划', '要求模型先调整计划'],
    ['cancel', '取消生成', '停止当前生成'],
  ].forEach(([action, label, title]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `agent-plan-action-btn action-${action}`;
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', () => applyAgentPlanAction(action, plan));
    actions.appendChild(button);
  });
  return actions;
}

function applyAgentPlanAction(action, plan = {}) {
  if (action === 'cancel') {
    if (isStreaming) {
      stopStreaming();
      showToast('已取消当前生成');
    } else {
      showToast('当前没有正在生成的任务');
    }
    return;
  }
  const prompt = buildAgentPlanActionPrompt(action, plan);
  if (!prompt) return;
  if ((action === 'execute_all' || action === 'single_step') && !isStreaming) {
    sendMessage(prompt, {
      composerOverrides: {
        enhance: false,
        activeSkill: 'agent_auto',
        agentExecutionMode: action === 'single_step' ? 'single_step' : 'execute_all',
      },
    });
    return;
  }
  fillComposerPrompt(prompt);
  showToast(action === 'execute_all' ? '当前计划已在执行，已准备继续指令' : '已填入计划控制指令');
}

function fillComposerPrompt(prompt) {
  const input = document.getElementById('message-input');
  if (!input) return;
  input.value = prompt;
  input.focus?.();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function appendAgentSearchPlan(card, searchPlan = []) {
  const items = Array.isArray(searchPlan) ? searchPlan.filter((item) => item?.query) : [];
  if (!items.length) return;
  const section = document.createElement('div');
  section.className = 'agent-search-plan';
  const title = document.createElement('div');
  title.className = 'agent-search-plan-title';
  title.textContent = '搜索计划';
  const list = document.createElement('ol');
  for (const item of items.slice(0, 4)) {
    const row = document.createElement('li');
    const purpose = document.createElement('strong');
    purpose.textContent = item.purpose || '搜索';
    const query = document.createElement('code');
    query.textContent = item.query;
    row.append(purpose, query);
    if (item.reason) {
      const reason = document.createElement('span');
      reason.textContent = item.reason;
      row.appendChild(reason);
    }
    list.appendChild(row);
  }
  section.append(title, list);
  card.appendChild(section);
}

function appendAgentPlanChips(card, labelText, values = [], extraClass = '') {
  const filtered = (Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean);
  if (!filtered.length) return;
  const group = document.createElement('div');
  group.className = `agent-plan-chip-group${extraClass ? ` ${extraClass}` : ''}`;
  const label = document.createElement('span');
  label.className = 'agent-plan-chip-label';
  label.textContent = labelText;
  group.appendChild(label);
  for (const value of filtered.slice(0, 10)) {
    const chip = document.createElement('span');
    chip.className = 'agent-plan-chip';
    chip.textContent = value;
    chip.title = value;
    group.appendChild(chip);
  }
  card.appendChild(group);
}

function collapseAgentStages(stages) {
  return stages.slice(-12);
}

function formatAgentStageLabel(stage = {}) {
  const labels = {
    plan: '规划工具',
    memory: '检索历史',
    checkpoint: '任务检查点',
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

function formatTaskCheckpointStageSummary(checkpoint = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') return '';
  const statusLabels = {
    ready: '可继续',
    needs_attention: '需要处理',
    waiting_for_approval: '等待确认',
    failed: '上一轮失败',
    completed: '已完成',
  };
  const parts = [];
  if (checkpoint.agentStatus) parts.push(statusLabels[checkpoint.agentStatus] || checkpoint.agentStatus);
  if (Array.isArray(checkpoint.pendingApprovals) && checkpoint.pendingApprovals.length) {
    parts.push(`待确认 ${checkpoint.pendingApprovals.length} 项`);
  }
  if (Array.isArray(checkpoint.failedSteps) && checkpoint.failedSteps.length) {
    parts.push(`失败/拒绝 ${checkpoint.failedSteps.length} 项`);
  }
  if (Array.isArray(checkpoint.recoveryActions) && checkpoint.recoveryActions.length) {
    parts.push(`恢复建议 ${checkpoint.recoveryActions.length} 条`);
  }
  if (parts.length === 0 && Array.isArray(checkpoint.completedSteps) && checkpoint.completedSteps.length) {
    parts.push(`已完成 ${checkpoint.completedSteps.length} 项`);
  }
  return parts.length ? `已使用长期任务状态：${parts.join('，')}` : '';
}

function syncToolRuns(message) {
  message.toolRuns = buildToolRuns(message.toolCalls || []);
}

function maybeAppendRelevantMemory(apiMessages, conversation) {
  const settings = getSettings();
  if (settings.autoContextSummary === false) return null;
  const lastIndex = findLastUserMessageIndex(apiMessages);
  if (lastIndex < 0) return null;
  const latestContent = String(apiMessages[lastIndex].content || '');
  const memoryContext = buildRelevantMemoryContext(conversations, conversation?.id, latestContent, {
    maxHits: 3,
    maxChars: 1200,
  });
  const taskCheckpointText = buildTaskCheckpointContext(conversation?.taskCheckpoint, {
    maxChars: 1200,
  });
  const contextBlocks = [memoryContext.text, taskCheckpointText].filter(Boolean);
  if (contextBlocks.length === 0) return null;
  apiMessages[lastIndex] = {
    ...apiMessages[lastIndex],
    content: `${latestContent.trim()}\n\n${contextBlocks.join('\n\n')}`.trim(),
  };
  return {
    ...memoryContext,
    taskCheckpointUsed: Boolean(taskCheckpointText),
    taskCheckpoint: conversation?.taskCheckpoint || null,
  };
}

function refreshConversationTaskCheckpoint(conversation) {
  if (!conversation) return;
  const checkpoint = buildTaskCheckpoint(conversation);
  conversation.taskCheckpoint = checkpoint;
  conversation.taskCheckpointUpdatedAt = checkpoint?.updatedAt || null;
}

function findLastUserMessageIndex(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

function formatToolTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString('zh-CN', { hour12: false });
}

export function hasSearchWithoutCitedSource(message, content) {
  return hasUncitedSearchSource(message, content);
}

export function hasLocalFilesWithoutCitedSource(message, content) {
  return hasUncitedLocalSource(message, content);
}

export function renderAssistantArtifacts(container, message) {
  if (!container) return [];
  container.innerHTML = '';
  const artifacts = extractHtmlArtifacts(message?.content || '');
  if (artifacts.length === 0) {
    container.hidden = true;
    return [];
  }

  container.hidden = false;
  const section = document.createElement('div');
  section.className = 'artifact-section';

  const header = document.createElement('div');
  header.className = 'artifact-section-header';
  const title = document.createElement('strong');
  title.textContent = 'Artifacts';
  const meta = document.createElement('span');
  meta.textContent = `${artifacts.length} 个可预览结果`;
  header.append(title, meta);
  section.appendChild(header);

  for (const [index, artifact] of artifacts.entries()) {
    section.appendChild(renderArtifactCard(artifact, index));
  }

  container.appendChild(section);
  return artifacts;
}

function renderArtifactCard(artifact, index) {
  const card = document.createElement('div');
  card.className = 'artifact-card';
  card.dataset.artifactType = artifact.type;

  const main = document.createElement('div');
  main.className = 'artifact-card-main';

  const title = document.createElement('div');
  title.className = 'artifact-title';
  title.textContent = artifact.title || 'HTML 预览';

  const meta = document.createElement('div');
  meta.className = 'artifact-meta';
  const metaParts = [
    formatBytes(artifact.size || 0),
    '脚本禁用',
    artifact.externalResourceCount ? `${artifact.externalResourceCount} 个外链资源受 CSP 限制` : '',
    artifact.truncated ? '已按预览上限裁剪' : '',
  ].filter(Boolean);
  meta.textContent = metaParts.join(' · ');
  main.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'artifact-actions';

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'artifact-action-btn primary';
  previewBtn.textContent = '预览';
  previewBtn.addEventListener('click', () => openHtmlArtifactPreview(artifact));

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'artifact-action-btn';
  downloadBtn.textContent = '导出 HTML';
  downloadBtn.addEventListener('click', () => downloadHtmlArtifact(artifact, index));

  actions.append(previewBtn, downloadBtn);
  card.append(main, actions);
  return card;
}

export function renderAssistantAnswerHeader(container, message = {}) {
  if (!container) return null;
  container.innerHTML = '';
  const items = buildAssistantAnswerHeaderItems(message);
  if (!items.length) {
    container.hidden = true;
    return null;
  }
  container.hidden = false;

  const header = document.createElement('div');
  header.className = 'answer-header';
  header.title = buildAssistantAnswerHeaderTitle(message);

  const title = document.createElement('div');
  title.className = 'answer-header-title';
  title.textContent = '回答概览';
  header.appendChild(title);

  const list = document.createElement('div');
  list.className = 'answer-header-chips';
  for (const item of items) {
    const chip = document.createElement('span');
    chip.className = `answer-header-chip chip-${item.kind}`;
    chip.textContent = item.label;
    list.appendChild(chip);
  }
  header.appendChild(list);
  container.appendChild(header);
  return header;
}

function buildAssistantAnswerHeaderItems(message = {}) {
  const items = [];
  const type = inferAnswerType(message);
  if (type) items.push({ kind: 'type', label: type });

  const model = String(message.model || message.tokens?.model || message.cacheProfile?.model || '').trim();
  if (model) items.push({ kind: 'model', label: model });

  const runs = getAssistantHeaderToolRuns(message);
  if (runs.length) {
    const failed = runs.filter((run) => isFailedToolStatus(run.status) || run.ok === false).length;
    const completed = runs.filter((run) => run.status === 'completed' || run.ok === true).length;
    const suffix = failed ? ` · ${failed} 失败` : (completed ? ` · ${completed} 完成` : '');
    items.push({ kind: failed ? 'tool-warning' : 'tool', label: `工具 ${runs.length}${suffix}` });
  }

  if (Array.isArray(message.agentStages) && message.agentStages.length) {
    const rounds = Math.max(...message.agentStages.map((stage) => Number(stage.round || 0)).filter(Number.isFinite), 0);
    items.push({ kind: 'agent', label: rounds > 0 ? `Agent ${rounds} 轮` : 'Agent 过程' });
  }

  if (message.tokens) {
    const usage = normalizeTokenUsage(message.tokens);
    const source = usage.source === 'provider' ? '实测' : (usage.source === 'mixed' ? '混合' : '估算');
    items.push({ kind: 'token', label: `${source} ${formatCompactTokenCount(usage.total)} tok` });
    if (usage.cacheHit > 0 || usage.cacheMiss > 0) {
      items.push({ kind: 'cache', label: `缓存 ${Math.round((usage.cacheHitRate || 0) * 100)}%` });
    }
    if (usage.reasoning > 0) items.push({ kind: 'thinking', label: `思考 ${formatCompactTokenCount(usage.reasoning)} tok` });
  }

  if (message.contextBudget?.trimmed) {
    items.push({ kind: 'budget', label: `裁剪 ${message.contextBudget.droppedCount || 0} 条历史` });
  } else if (message.contextBudget?.summaryUsed) {
    items.push({ kind: 'budget', label: '已用长期记忆' });
  }

  return items;
}

function buildAssistantAnswerHeaderTitle(message = {}) {
  const lines = ['回答头部'];
  const type = inferAnswerType(message);
  if (type) lines.push(`类型: ${type}`);
  const model = String(message.model || message.tokens?.model || message.cacheProfile?.model || '').trim();
  if (model) lines.push(`模型: ${model}`);
  const runs = getAssistantHeaderToolRuns(message);
  if (runs.length) {
    const names = runs.map((run) => `${getToolName(run)}:${run.status || (run.ok === true ? 'completed' : 'unknown')}`);
    lines.push(`工具: ${names.join(', ')}`);
  }
  if (message.tokens) lines.push(formatTokenUsageTitle(message.tokens));
  if (message.contextBudget?.prefixFingerprint) lines.push(`Prefix: ${message.contextBudget.prefixFingerprint}`);
  if (message.contextBudget?.trimmed) lines.push(`上下文裁剪: ${message.contextBudget.droppedCount || 0} 条`);
  if (message.contextBudget?.summaryUsed) lines.push('上下文摘要: 已使用');
  return lines.join('\n');
}

function inferAnswerType(message = {}) {
  if (message.error) return '执行错误';
  const content = String(message.content || '');
  const runs = getAssistantHeaderToolRuns(message);
  if (runs.length) return '执行结果';
  if (Array.isArray(message.agentStages) && message.agentStages.length) return 'Agent';
  if (/```|补丁|代码|函数|组件|接口/.test(content)) return '代码';
  if (/审查|风险|漏洞|安全|性能|可维护/.test(content)) return '代码审查';
  if (/调研|来源|引用|官方|文档|资料/.test(content)) return '调研';
  if (/方案|计划|步骤|优先级|P0|P1|P2/.test(content)) return '方案';
  return content ? '解释' : '';
}

function getAssistantHeaderToolRuns(message = {}) {
  return [
    ...(Array.isArray(message.toolRuns) ? message.toolRuns : []),
    ...(Array.isArray(message.toolCalls) ? message.toolCalls : []),
  ].filter(Boolean);
}

function isFailedToolStatus(status) {
  return ['failed', 'error', 'denied', 'timeout', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase());
}

function openHtmlArtifactPreview(artifact) {
  document.querySelector('.artifact-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'artifact-preview-panel';

  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('h3');
  title.textContent = artifact.title || 'HTML 预览';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'artifact-preview-close';
  closeBtn.setAttribute('aria-label', '关闭预览');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const warning = document.createElement('div');
  warning.className = 'artifact-preview-warning';
  warning.textContent = '沙箱预览：scripts、forms、network connect 和 frame 默认禁用；外链图片仅允许 https/data。';

  const iframe = document.createElement('iframe');
  iframe.className = 'artifact-preview-frame';
  iframe.setAttribute('sandbox', '');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.srcdoc = createSandboxedHtmlDocument(artifact.source, { title: artifact.title });

  panel.append(header, warning, iframe);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function downloadHtmlArtifact(artifact, index) {
  const html = createSandboxedHtmlDocument(artifact.source, { title: artifact.title });
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = buildArtifactDownloadName(artifact, index);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderAssistantEvidence(container, message) {
  if (!container) return;
  container.querySelectorAll('.source-grounding-warning, .source-grounding-card, .tool-evidence-panel').forEach((item) => item.remove());
  const grounding = getSearchGrounding(message, message?.content || '');
  const localGrounding = getLocalFileGrounding(message, message?.content || '');
  appendToolEvidencePanel(container, message, grounding, localGrounding);
  if (grounding.hasSearch) {
    appendGroundingCard(container, {
      warning: grounding.warning,
      title: grounding.warning ? '联网结果未被明确引用' : '已引用联网来源',
      meta: [
        grounding.queries[0] ? `query: ${grounding.queries[0]}` : '',
        `${grounding.sources.length} 个来源`,
      ].filter(Boolean).join(' · '),
      items: grounding.sources.slice(0, 3).map((source) => ({
        label: source.title || source.url,
        href: source.url,
      })),
      warningText: grounding.hasSources
        ? '本轮调用了联网搜索，但最终回答没有引用搜索来源 URL，请谨慎核验。'
        : '本轮调用了联网搜索，但工具没有返回可用来源 URL，请谨慎核验。',
    });
  }
  if (localGrounding.hasLocalFiles) {
    appendGroundingCard(container, {
      warning: localGrounding.warning,
      title: localGrounding.warning ? '本地文件证据未被明确引用' : '已引用本地文件证据',
      meta: `${localGrounding.citations.length} 个文件引用`,
      items: localGrounding.citations.slice(0, 4).map((citation) => ({
        label: citation.label,
        href: '',
      })),
      warningText: '本轮读取或搜索了本地工作区文件，但最终回答没有引用文件名或 file:line 证据，请谨慎核验。',
    });
  }
}

function appendToolEvidencePanel(container, message = {}, grounding = {}, localGrounding = {}) {
  const runs = Array.isArray(message.toolRuns) ? message.toolRuns.filter(Boolean) : [];
  const completedRuns = runs.filter((run) => run.status === 'completed' || run.ok === true);
  if (runs.length === 0 && !message.tokens && !message.cacheProfile) return;

  const panel = document.createElement('details');
  panel.className = 'tool-evidence-panel';
  panel.open = completedRuns.length > 0;

  const summary = document.createElement('summary');
  summary.className = 'tool-evidence-summary';
  const title = document.createElement('span');
  title.className = 'tool-evidence-title';
  title.textContent = '本轮工具证据';
  const meta = document.createElement('span');
  meta.className = 'tool-evidence-meta';
  meta.textContent = buildToolEvidenceMeta(runs, grounding, localGrounding, message);
  summary.append(title, meta);
  panel.appendChild(summary);

  const grid = document.createElement('div');
  grid.className = 'tool-evidence-grid';

  for (const run of runs) {
    grid.appendChild(createToolEvidenceRunCard(run));
  }

  const cacheCard = createCacheEvidenceCard(message);
  if (cacheCard) grid.appendChild(cacheCard);

  if (grid.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tool-evidence-empty';
    empty.textContent = '暂无可展示的工具证据。';
    grid.appendChild(empty);
  }

  panel.appendChild(grid);

  const actions = document.createElement('div');
  actions.className = 'tool-evidence-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'tool-copy-btn';
  copy.textContent = '复制本轮证据 JSON';
  copy.addEventListener('click', async () => {
    await copyToClipboard(JSON.stringify(buildMessageEvidencePayload(message), null, 2));
    showToast('本轮工具证据已复制');
  });
  actions.appendChild(copy);
  panel.appendChild(actions);

  container.appendChild(panel);
}

function buildToolEvidenceMeta(runs = [], grounding = {}, localGrounding = {}, message = {}) {
  const parts = [];
  if (runs.length) parts.push(`${runs.length} 个工具`);
  if (grounding.sources?.length) parts.push(`${grounding.sources.length} 个来源`);
  if (localGrounding.citations?.length) parts.push(`${localGrounding.citations.length} 个文件引用`);
  const usage = message.tokens ? normalizeTokenUsage(message.tokens) : null;
  if (usage?.cacheHit > 0 || usage?.cacheMiss > 0) {
    parts.push(`cache ${Math.round((usage.cacheHitRate || 0) * 100)}%`);
  } else if (message.cacheProfile?.cacheHitRate !== undefined) {
    parts.push(`cache ${Math.round(Number(message.cacheProfile.cacheHitRate || 0) * 100)}%`);
  }
  return parts.length ? parts.join(' · ') : '无工具调用';
}

function createToolEvidenceRunCard(run = {}) {
  const card = document.createElement('article');
  card.className = `tool-evidence-run status-${run.status || 'unknown'}`;

  const header = document.createElement('div');
  header.className = 'tool-evidence-run-header';
  const name = document.createElement('strong');
  name.textContent = run.name || 'unknown_tool';
  const status = document.createElement('span');
  status.className = 'tool-evidence-status';
  status.textContent = getToolStatusMeta(run.status).label;
  header.append(name, status);
  card.appendChild(header);

  const meta = document.createElement('div');
  meta.className = 'tool-evidence-run-meta';
  meta.textContent = [
    run.durationMs !== null && run.durationMs !== undefined ? `耗时 ${run.durationMs}ms` : '',
    run.query ? `query: ${run.query}` : '',
    run.args?.path ? `path: ${run.args.path}` : '',
    run.args?.symbol ? `symbol: ${run.args.symbol}` : '',
    run.args?.language ? `language: ${run.args.language}` : '',
  ].filter(Boolean).join(' · ');
  if (meta.textContent) card.appendChild(meta);

  appendEvidenceChips(card, '来源', (run.sources || []).slice(0, 3).map((source) => source.title || source.url));
  appendEvidenceChips(card, '文件', (run.localCitations || []).slice(0, 6).map((citation) => citation.label));
  if (Array.isArray(run.workspaceResults) && run.workspaceResults.length) {
    appendEvidenceChips(card, '搜索命中', run.workspaceResults.slice(0, 4).map((item) => `${item.file}:${item.startLine}-${item.endLine}`));
  }
  if (run.workspaceSymbol?.result) {
    appendEvidenceChips(card, '符号', [`${run.workspaceSymbol.symbol} ${run.workspaceSymbol.result.file}:${run.workspaceSymbol.result.startLine}-${run.workspaceSymbol.result.endLine}`]);
  }
  if (run.runResult) {
    appendEvidenceChips(card, '实验', [
      `${run.runResult.language || run.args?.language || 'unknown'} · exit ${run.runResult.exitCode ?? 'unknown'} · ${run.runResult.durationMs}ms`,
      run.runResult.failureHint,
    ]);
  }
  if (run.contextCompacted) {
    appendEvidenceChips(card, '上下文', [`已压缩 ${run.rawOutputTokens || 0}→${run.contextOutputTokens || 0} tokens`]);
  }
  if (run.parseError) appendEvidenceChips(card, '参数错误', [run.parseError]);
  if (run.outputPreview) appendEvidencePreview(card, run.outputPreview);
  return card;
}

function appendEvidenceChips(card, labelText, values = []) {
  const filtered = values.map((value) => String(value || '').trim()).filter(Boolean);
  if (!filtered.length) return;
  const group = document.createElement('div');
  group.className = 'tool-evidence-chip-group';
  const label = document.createElement('span');
  label.className = 'tool-evidence-chip-label';
  label.textContent = labelText;
  group.appendChild(label);
  for (const value of filtered) {
    const chip = document.createElement('span');
    chip.className = 'tool-evidence-chip';
    chip.textContent = value;
    chip.title = value;
    group.appendChild(chip);
  }
  card.appendChild(group);
}

function appendEvidencePreview(card, text) {
  const preview = document.createElement('p');
  preview.className = 'tool-evidence-preview';
  preview.textContent = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  card.appendChild(preview);
}

function createCacheEvidenceCard(message = {}) {
  const usage = message.tokens ? normalizeTokenUsage(message.tokens) : null;
  const profile = message.cacheProfile || {};
  if (!usage && !profile.prefixFingerprint) return null;

  const card = document.createElement('article');
  card.className = 'tool-evidence-run cache-evidence';
  const header = document.createElement('div');
  header.className = 'tool-evidence-run-header';
  const name = document.createElement('strong');
  name.textContent = 'Token / Cache';
  const status = document.createElement('span');
  status.className = 'tool-evidence-status';
  status.textContent = usage?.source || 'profile';
  header.append(name, status);
  card.appendChild(header);

  appendEvidenceChips(card, '用量', [
    usage ? `输入 ${usage.input}` : '',
    usage ? `输出 ${usage.output}` : '',
    usage?.reasoning ? `思考 ${usage.reasoning}` : '',
  ]);
  appendEvidenceChips(card, '缓存', [
    usage ? `hit ${usage.cacheHit}` : profile.cacheHit ? `hit ${profile.cacheHit}` : '',
    usage ? `miss ${usage.cacheMiss}` : profile.cacheMiss ? `miss ${profile.cacheMiss}` : '',
    usage ? `rate ${Math.round((usage.cacheHitRate || 0) * 100)}%` : '',
    profile.prefixFingerprint ? `prefix ${profile.prefixFingerprint}` : '',
  ]);
  if (usage?.cost?.estimatedSavingsUsd > 0 || profile.estimatedSavingsUsd > 0) {
    appendEvidenceChips(card, '成本', [
      `节省约 $${Number(usage?.cost?.estimatedSavingsUsd || profile.estimatedSavingsUsd || 0).toFixed(6)}`,
    ]);
  }
  return card;
}

function buildMessageEvidencePayload(message = {}) {
  return {
    type: 'deepchat.messageEvidence',
    version: 1,
    toolRuns: (message.toolRuns || []).map((run) => buildToolEvidencePayload(run)),
    tokens: message.tokens ? normalizeTokenUsage(message.tokens) : null,
    cacheProfile: message.cacheProfile || null,
    contextBudget: message.contextBudget || null,
  };
}

function appendGroundingCard(container, { warning, title: titleText, meta: metaText, items = [], warningText }) {
  const card = document.createElement('div');
  card.className = `source-grounding-card${warning ? ' is-warning' : ' is-grounded'}`;
  const title = document.createElement('div');
  title.className = 'source-grounding-title';
  title.textContent = titleText;
  const meta = document.createElement('div');
  meta.className = 'source-grounding-meta';
  meta.textContent = metaText;
  card.append(title, meta);
  if (items.length) {
    const list = document.createElement('div');
    list.className = 'source-grounding-list';
    for (const item of items) {
      if (item.href) {
        const link = document.createElement('a');
        link.href = item.href;
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = item.label;
        list.appendChild(link);
      } else {
        const span = document.createElement('span');
        span.textContent = item.label;
        list.appendChild(span);
      }
    }
    card.appendChild(list);
  }
  container.appendChild(card);
  if (warning) {
    const warning = document.createElement('div');
    warning.className = 'source-grounding-warning';
    warning.textContent = warningText;
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

  if (String(content || '').trim()) {
    actions.appendChild(createAnswerActionButton('更短', '生成一个更短版本', () => {
      sendAnswerAction('shorter', content);
    }));
    actions.appendChild(createAnswerActionButton('详细', '生成一个更详细版本', () => {
      sendAnswerAction('deeper', content);
    }));
    actions.appendChild(createAnswerActionButton('转表格', '把这条回答整理成表格', () => {
      sendAnswerAction('table', content);
    }));
    actions.appendChild(createAnswerActionButton('TODO', '把这条回答转成可执行 TODO 清单', () => {
      sendAnswerAction('todo', content);
    }));
    actions.appendChild(createAnswerActionButton('导出', '导出这条回答为 Markdown', () => {
      exportAssistantMarkdown(content, msgIndex);
    }));
  }

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

function createAnswerActionButton(label, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'msg-action-btn answer-action-btn';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function sendAnswerAction(action, content) {
  const prompt = buildAnswerActionPrompt(action, content);
  if (!prompt) return;
  sendMessage(prompt, { composerOverrides: { enhance: false } });
}

export function buildAnswerActionPrompt(action, content = '') {
  const source = compactAnswerActionContext(content);
  if (!source) return '';
  const instructions = {
    shorter: '请基于下面这段上一条回答，重新输出一个更短版本。保留关键结论和必要步骤，删除展开解释，不要引入新事实。',
    deeper: '请基于下面这段上一条回答，重新输出一个更详细版本。补充背景、原因、取舍、风险和下一步，但不要编造未验证事实。',
    table: '请基于下面这段上一条回答，整理成表格优先的版本。适合对比、清单、优先级或行动项的内容用 Markdown 表格表达，最后保留简短结论。',
    todo: '请基于下面这段上一条回答，提炼成可执行 TODO 清单。按 P0/P1/P2 分组，每项包含动作、验收标准、依赖或风险；不要引入上一条回答之外的新事实。',
  };
  const instruction = instructions[action];
  if (!instruction) return '';
  return `${instruction}\n\n<previous_answer>\n${source}\n</previous_answer>`;
}

export function buildAgentPlanActionPrompt(action, plan = {}) {
  const summary = serializeAgentPlanForPrompt(plan);
  if (!summary) return '';
  const instructions = {
    execute_all: '请按下面的 DeepChat Agent 计划继续执行。低风险读取/搜索工具按计划推进；运行代码、MCP 外部操作和任何写入动作仍必须等待我的确认。每一步完成后保留证据，最终回答说明用了哪些工具和来源。',
    single_step: '请只执行下面 DeepChat Agent 计划中的下一步。执行后先停下来汇报证据、结果和下一步建议，不要连续推进后续步骤。',
    revise: '请先修改下面的 DeepChat Agent 计划。要求：减少无关工具调用，明确每一步需要的证据，标出哪些步骤需要我确认。先输出新计划，不要立刻执行工具。',
  };
  const instruction = instructions[action];
  if (!instruction) return '';
  return `${instruction}\n\n<agent_plan>\n${summary}\n</agent_plan>`;
}

function serializeAgentPlanForPrompt(plan = {}) {
  if (!plan || typeof plan !== 'object') return '';
  const lines = [
    `模式：${plan.mode || 'unknown'}`,
    `最多轮数：${plan.maxRounds || ''}`,
    `原因：${plan.reason || ''}`,
  ];
  const pushList = (label, values, mapper = (value) => value) => {
    const list = (Array.isArray(values) ? values : []).map(mapper).map((value) => String(value || '').trim()).filter(Boolean);
    if (!list.length) return;
    lines.push('', `${label}：`);
    list.slice(0, 10).forEach((value, index) => lines.push(`${index + 1}. ${value}`));
  };
  pushList('步骤', plan.steps);
  pushList('搜索计划', plan.searchPlan, (item) => `${item.purpose || '搜索'}：${item.query}${item.reason ? `（${item.reason}）` : ''}`);
  pushList('预计工具', plan.selectedTools);
  pushList('缺少配置', plan.missingPrerequisites);
  pushList('审批策略', plan.approvalPolicy);
  return lines.join('\n').trim();
}

function compactAnswerActionContext(content = '') {
  const text = String(content || '').replace(/<\/previous_answer>/gi, '<\\/previous_answer>').trim();
  if (text.length <= ANSWER_ACTION_CONTEXT_LIMIT) return text;
  const head = text.slice(0, Math.floor(ANSWER_ACTION_CONTEXT_LIMIT * 0.62)).trimEnd();
  const tail = text.slice(-Math.floor(ANSWER_ACTION_CONTEXT_LIMIT * 0.28)).trimStart();
  return `${head}\n\n[中间内容已省略，避免后续指令过长]\n\n${tail}`;
}

function exportAssistantMarkdown(content, msgIndex) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `deepchat-answer-${msgIndex + 1}-${stamp}.md`;
  downloadTextFile(content || '', fileName, 'text/markdown;charset=utf-8');
  showToast('已导出当前回答 Markdown');
}

function downloadTextFile(text, fileName, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
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
  const reasons = normalizeCacheStabilityReasons(tokens.cacheStabilityReasons || profile.cacheStabilityReasons);
  if (reasons.length) lines.push(`Cache miss 可能原因: ${reasons.map(formatCacheStabilityReason).join('、')}`);
  const details = tokens.cacheStabilityDetails || profile.cacheStabilityDetails;
  const detailText = formatCacheStabilityDetails(details);
  if (detailText) lines.push(`变化明细: ${detailText}`);
  if (tokens.byPurpose && Object.keys(tokens.byPurpose).length) {
    lines.push(`用途: ${Object.entries(tokens.byPurpose).map(([key, value]) => `${key}=${value}`).join(', ')}`);
  }
  if (usage.rounds > 1) lines.push(`Agent 轮次: ${usage.rounds}`);
  const warnings = [...(usage.warnings || []), ...(tokens.cacheStabilityWarnings || []), ...(profile.cacheStabilityWarnings || [])];
  if (warnings.length) lines.push(`提示: ${[...new Set(warnings)].join('；')}`);
  return lines.join('\n');
}

export function formatConversationUsageTelemetry(conversation) {
  const details = buildConversationUsageTelemetryDetails(conversation);
  if (!details) return null;
  return {
    text: details.text,
    title: details.title,
    hitRate: details.hitRate,
    total: details.usage.total,
  };
}

export function buildConversationUsageTelemetryDetails(conversation) {
  const usage = getConversationUsageSummary(conversation);
  if (!usage || usage.total <= 0) return null;
  const profile = getConversationCacheProfile(conversation) || {};
  const hitRate = usage.cacheHit > 0 || usage.cacheMiss > 0
    ? Math.round(usage.cacheHitRate * 100)
    : null;
  const reasons = normalizeCacheStabilityReasons(profile.cacheStabilityReasons);
  const warnings = [...new Set([...(usage.warnings || []), ...(profile.cacheStabilityWarnings || [])])];
  const textParts = [`${formatCompactTokenCount(usage.total)} tok`];
  if (hitRate !== null) textParts.push(`缓存 ${hitRate}%`);
  if (usage.cost?.estimatedSavingsUsd > 0) textParts.push(`省 ${formatUsd(usage.cost.estimatedSavingsUsd)}`);
  if (usage.rounds > 1) textParts.push(`${usage.rounds} 轮`);

  const titleLines = [
    '本会话 Token / Cache 汇总',
    `输入: ${usage.input}`,
    `输出: ${usage.output}`,
    `总计: ${usage.total}`,
    `统计来源: ${usage.source === 'provider' ? '服务商真实 usage' : (usage.source === 'mixed' ? '真实和估算混合' : '本地估算')}`,
  ];
  if (usage.reasoning > 0) titleLines.push(`思考: ${usage.reasoning}`);
  if (usage.cacheHit > 0 || usage.cacheMiss > 0) {
    titleLines.push(`缓存命中: ${usage.cacheHit}`);
    titleLines.push(`缓存未命中: ${usage.cacheMiss}`);
    titleLines.push(`命中率: ${hitRate}%`);
  }
  if (usage.cost) {
    titleLines.push(`估算成本: ${formatUsd(usage.cost.estimatedCostUsd || 0)}`);
    titleLines.push(`缓存节省: ${formatUsd(usage.cost.estimatedSavingsUsd || 0)}`);
  }
  if (usage.rounds > 1) titleLines.push(`Agent 轮次: ${usage.rounds}`);
  if (profile.prefixFingerprint) titleLines.push(`Prefix: ${profile.prefixFingerprint}`);
  if (profile.prefixTokens) titleLines.push(`Prefix tokens: ${profile.prefixTokens}`);
  if (reasons.length) titleLines.push(`Cache miss 可能原因: ${reasons.map(formatCacheStabilityReason).join('、')}`);
  const detailText = formatCacheStabilityDetails(profile.cacheStabilityDetails);
  if (detailText) titleLines.push(`变化明细: ${detailText}`);
  if (warnings.length) titleLines.push(`提示: ${warnings.join('；')}`);

  return {
    text: textParts.join(' · '),
    title: titleLines.join('\n'),
    sourceLabel: formatUsageSourceLabel(usage.source),
    hitRate,
    hitRateLabel: hitRate === null ? '无缓存 usage' : `${hitRate}%`,
    usage,
    profile,
    reasons,
    warnings,
    detailText,
  };
}

export function renderConversationUsageTelemetryPanel(container, conversation) {
  const details = buildConversationUsageTelemetryDetails(conversation);
  container.replaceChildren();
  if (!details) {
    container.hidden = true;
    return null;
  }
  container.hidden = false;
  container.classList.add('usage-telemetry-panel');

  const header = document.createElement('div');
  header.className = 'usage-panel-header';
  const title = document.createElement('div');
  title.className = 'usage-panel-title';
  title.textContent = '本会话 Token / Cache';
  const source = document.createElement('span');
  source.className = 'usage-panel-source';
  source.textContent = details.sourceLabel;
  header.append(title, source);

  const metrics = document.createElement('div');
  metrics.className = 'usage-panel-grid';
  [
    ['输入', details.usage.input],
    ['输出', details.usage.output],
    ['思考', details.usage.reasoning],
    ['总计', details.usage.total],
    ['Cache hit', details.usage.cacheHit],
    ['Cache miss', details.usage.cacheMiss],
    ['命中率', details.hitRateLabel],
    ['Agent 轮次', details.usage.rounds || 1],
  ].forEach(([label, value]) => metrics.appendChild(createUsageMetric(label, value)));

  const cost = document.createElement('div');
  cost.className = 'usage-panel-section';
  cost.appendChild(createUsageSectionTitle('成本解释'));
  const costRows = [
    ['估算成本', details.usage.cost ? formatUsd(details.usage.cost.estimatedCostUsd || 0) : '无价格表'],
    ['缓存节省', details.usage.cost ? formatUsd(details.usage.cost.estimatedSavingsUsd || 0) : '无价格表'],
    ['命中输入成本', details.usage.cost ? formatUsd(details.usage.cost.inputCacheHitCostUsd || 0) : '无价格表'],
    ['未命中输入成本', details.usage.cost ? formatUsd(details.usage.cost.inputCacheMissCostUsd || 0) : '无价格表'],
    ['输出成本', details.usage.cost ? formatUsd(details.usage.cost.outputCostUsd || 0) : '无价格表'],
  ];
  costRows.forEach(([label, value]) => cost.appendChild(createUsageRow(label, value)));

  const prefix = document.createElement('div');
  prefix.className = 'usage-panel-section';
  prefix.appendChild(createUsageSectionTitle('Cache-first 前缀'));
  [
    ['Prefix hash', details.profile.prefixFingerprint || '无'],
    ['Prefix tokens', details.profile.prefixTokens || 0],
    ['Prefix bytes', details.profile.prefixBytes || 0],
    ['System hash', details.profile.systemHash || '无'],
    ['Tools hash', details.profile.toolsHash || '无'],
    ['Workspace hash', details.profile.workspaceSignature || '无'],
  ].forEach(([label, value]) => prefix.appendChild(createUsageRow(label, value)));

  const reasons = document.createElement('div');
  reasons.className = 'usage-panel-section';
  reasons.appendChild(createUsageSectionTitle('缓存变化原因'));
  const reasonText = details.reasons.length
    ? details.reasons.map(formatCacheStabilityReason).join('、')
    : '未检测到 prefix 变化';
  reasons.appendChild(createUsageRow('Cache miss 可能原因', reasonText));
  if (details.detailText) reasons.appendChild(createUsageRow('变化明细', details.detailText));
  if (details.warnings.length) reasons.appendChild(createUsageRow('提示', details.warnings.join('；')));

  const purposeEntries = Object.entries(details.usage.byPurpose || {});
  if (purposeEntries.length) {
    const purpose = document.createElement('div');
    purpose.className = 'usage-panel-section';
    purpose.appendChild(createUsageSectionTitle('用途拆分'));
    purposeEntries.forEach(([label, value]) => purpose.appendChild(createUsageRow(label, value)));
    container.append(header, metrics, cost, prefix, reasons, purpose);
  } else {
    container.append(header, metrics, cost, prefix, reasons);
  }
  return details;
}

export function renderLatestEvidenceDrawer(container, conversation) {
  if (!container) return null;
  const evidence = getLatestEvidenceMessage(conversation);
  container.replaceChildren();
  container.classList.add('evidence-drawer-panel');
  if (!evidence) {
    container.hidden = true;
    return null;
  }
  container.hidden = false;

  const { message, index } = evidence;
  const runs = Array.isArray(message.toolRuns) ? message.toolRuns.filter(Boolean) : [];
  const usage = message.tokens ? normalizeTokenUsage(message.tokens) : null;

  const header = document.createElement('div');
  header.className = 'evidence-drawer-header';
  const titleGroup = document.createElement('div');
  const title = document.createElement('h2');
  title.className = 'evidence-drawer-title';
  title.textContent = '证据面板';
  const subtitle = document.createElement('p');
  subtitle.className = 'evidence-drawer-subtitle';
  subtitle.textContent = [
    conversation?.title || '当前对话',
    `消息 #${index + 1}`,
    runs.length ? `${runs.length} 个工具` : '',
    usage ? `${formatCompactTokenCount(usage.total)} tok` : '',
  ].filter(Boolean).join(' · ');
  titleGroup.append(title, subtitle);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'evidence-drawer-close';
  close.textContent = '关闭';
  close.addEventListener('click', closeEvidenceDrawer);
  header.append(titleGroup, close);
  container.appendChild(header);

  if (Array.isArray(message.agentStages) && message.agentStages.length) {
    const stages = document.createElement('section');
    stages.className = 'evidence-drawer-section';
    const stageTitle = document.createElement('h3');
    stageTitle.textContent = 'Agent 过程';
    const stageList = document.createElement('ol');
    stageList.className = 'evidence-drawer-stage-list';
    for (const stage of message.agentStages.slice(-8)) {
      const item = document.createElement('li');
      item.textContent = formatAgentStageBrief(stage);
      stageList.appendChild(item);
    }
    stages.append(stageTitle, stageList);
    container.appendChild(stages);
  }

  const grid = document.createElement('div');
  grid.className = 'evidence-drawer-grid';
  for (const run of runs) {
    grid.appendChild(createToolEvidenceRunCard(run));
  }
  const cacheCard = createCacheEvidenceCard(message);
  if (cacheCard) grid.appendChild(cacheCard);
  if (grid.children.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'tool-evidence-empty';
    empty.textContent = '最近回答没有工具证据。';
    grid.appendChild(empty);
  }
  container.appendChild(grid);

  const actions = document.createElement('div');
  actions.className = 'evidence-drawer-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'tool-copy-btn';
  copy.textContent = '复制证据 JSON';
  copy.addEventListener('click', async () => {
    await copyToClipboard(JSON.stringify(buildMessageEvidencePayload(message), null, 2));
    showToast('最近工具证据已复制');
  });
  actions.appendChild(copy);
  container.appendChild(actions);
  return container;
}

function createUsageMetric(label, value) {
  const item = document.createElement('div');
  item.className = 'usage-panel-metric';
  const name = document.createElement('span');
  name.className = 'usage-panel-metric-label';
  name.textContent = label;
  const number = document.createElement('strong');
  number.className = 'usage-panel-metric-value';
  number.textContent = String(value ?? 0);
  item.append(name, number);
  return item;
}

function createUsageSectionTitle(text) {
  const title = document.createElement('div');
  title.className = 'usage-panel-section-title';
  title.textContent = text;
  return title;
}

function createUsageRow(label, value) {
  const row = document.createElement('div');
  row.className = 'usage-panel-row';
  const name = document.createElement('span');
  name.className = 'usage-panel-row-label';
  name.textContent = label;
  const content = document.createElement('code');
  content.className = 'usage-panel-row-value';
  content.textContent = String(value ?? '');
  row.append(name, content);
  return row;
}

function getConversationCacheProfile(conversation) {
  if (conversation?.cacheProfile && typeof conversation.cacheProfile === 'object') return conversation.cacheProfile;
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.cacheProfile && typeof message.cacheProfile === 'object') return message.cacheProfile;
    if (message?.tokens?.cacheProfile && typeof message.tokens.cacheProfile === 'object') return message.tokens.cacheProfile;
  }
  return null;
}

function formatCompactTokenCount(value) {
  const number = Number(value) || 0;
  if (number < 1000) return String(Math.round(number));
  if (number < 1000000) {
    const compact = number < 10000 ? (number / 1000).toFixed(1) : Math.round(number / 1000).toString();
    return `${compact.replace(/\.0$/, '')}k`;
  }
  return `${(number / 1000000).toFixed(1).replace(/\.0$/, '')}m`;
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function formatUsageSourceLabel(source) {
  if (source === 'provider') return '服务商真实 usage';
  if (source === 'mixed') return '真实和估算混合';
  return '本地估算';
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
    cacheStabilityReasons: tokens?.cacheStabilityReasons || contextBudget?.cacheStabilityReasons || profile.cacheStabilityReasons || [],
    cacheStabilityDetails: tokens?.cacheStabilityDetails || contextBudget?.cacheStabilityDetails || profile.cacheStabilityDetails || {},
    cacheHit: usage.cacheHit,
    cacheMiss: usage.cacheMiss,
    cacheHitRate: usage.cacheHitRate,
    estimatedCostUsd: usage.cost?.estimatedCostUsd || 0,
    estimatedSavingsUsd: usage.cost?.estimatedSavingsUsd || 0,
  };
}

function normalizeCacheStabilityReasons(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function formatCacheStabilityReason(reason) {
  const labels = {
    model_changed: '模型切换',
    system_prompt_changed: '系统提示词变化',
    tool_schema_changed: '工具 schema 变化',
    workspace_or_mcp_changed: '工作区/MCP 变化',
    prefix_fingerprint_changed: 'prefix 指纹变化',
  };
  return labels[reason] || reason;
}

function formatCacheStabilityDetails(details) {
  if (!details || typeof details !== 'object') return '';
  const parts = [];
  for (const [key, value] of Object.entries(details)) {
    if (!value || typeof value !== 'object') continue;
    const previous = String(value.previous || '').slice(0, 24);
    const current = String(value.current || '').slice(0, 24);
    if (previous || current) parts.push(`${key}: ${previous || '-'} -> ${current || '-'}`);
  }
  return parts.join('；');
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

  refreshConversationTaskCheckpoint(conv);
  persist();
  renderMessages();
}

async function continueFromResponseAt(msgIndex) {
  if (isStreaming) return;
  const conv = getActiveConversation();
  if (!conv || conv.messages[msgIndex]?.role !== 'assistant') return;
  conv.messages = conv.messages.slice(0, msgIndex + 1);
  refreshConversationTaskCheckpoint(conv);
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
  $modelName.textContent = settings.model;
  $modelName.title = settings.model;
  updateHeaderUsageBadge(conv);
  updateEvidenceButton(conv);
}

export function updateModelDisplay(model) {
  $modelName.textContent = model;
}

function updateHeaderUsageBadge(conversation) {
  if (!$chatUsageBadge) return;
  const telemetry = formatConversationUsageTelemetry(conversation);
  if (!telemetry) {
    $chatUsageBadge.classList.add('hidden');
    $chatUsageBadge.textContent = '';
    $chatUsageBadge.title = '';
    $chatUsageBadge.removeAttribute('role');
    $chatUsageBadge.removeAttribute('tabindex');
    closeUsageTelemetryPanel();
    return;
  }
  $chatUsageBadge.classList.remove('hidden');
  $chatUsageBadge.textContent = telemetry.text;
  $chatUsageBadge.title = telemetry.title;
  $chatUsageBadge.setAttribute('role', 'button');
  $chatUsageBadge.setAttribute('tabindex', '0');
  $chatUsageBadge.setAttribute('aria-label', '查看会话 Token 与缓存详情');
  $chatUsageBadge.dataset.hitRate = telemetry.hitRate === null ? '' : String(telemetry.hitRate);
  if (usageTelemetryPanelEl) renderConversationUsageTelemetryPanel(usageTelemetryPanelEl, conversation);
}

function bindUsageTelemetryPanel() {
  if (!$chatUsageBadge || $chatUsageBadge.dataset.panelBound === 'true') return;
  $chatUsageBadge.dataset.panelBound = 'true';
  $chatUsageBadge.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleUsageTelemetryPanel();
  });
  $chatUsageBadge.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleUsageTelemetryPanel();
  });
  document.addEventListener('click', (event) => {
    if (!usageTelemetryPanelEl) return;
    if (usageTelemetryPanelEl.contains(event.target) || $chatUsageBadge.contains(event.target)) return;
    closeUsageTelemetryPanel();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeUsageTelemetryPanel();
  });
  window.addEventListener('resize', () => {
    if (usageTelemetryPanelEl) positionUsageTelemetryPanel();
  });
}

function toggleUsageTelemetryPanel() {
  if (usageTelemetryPanelEl) {
    closeUsageTelemetryPanel();
    return;
  }
  const conv = getActiveConversation();
  const details = buildConversationUsageTelemetryDetails(conv);
  if (!details) return;
  usageTelemetryPanelEl = document.createElement('aside');
  usageTelemetryPanelEl.className = 'usage-telemetry-panel';
  usageTelemetryPanelEl.setAttribute('role', 'dialog');
  usageTelemetryPanelEl.setAttribute('aria-label', '会话 Token 与缓存详情');
  document.body.appendChild(usageTelemetryPanelEl);
  renderConversationUsageTelemetryPanel(usageTelemetryPanelEl, conv);
  positionUsageTelemetryPanel();
}

function closeUsageTelemetryPanel() {
  if (!usageTelemetryPanelEl) return;
  usageTelemetryPanelEl.remove();
  usageTelemetryPanelEl = null;
}

function positionUsageTelemetryPanel() {
  if (!usageTelemetryPanelEl || !$chatUsageBadge) return;
  const rect = $chatUsageBadge.getBoundingClientRect();
  const margin = 12;
  const right = Math.max(margin, window.innerWidth - rect.right);
  const top = Math.min(window.innerHeight - margin, rect.bottom + 8);
  usageTelemetryPanelEl.style.top = `${top}px`;
  usageTelemetryPanelEl.style.right = `${right}px`;
}

function bindEvidenceDrawer() {
  if (!$evidencePanelBtn || $evidencePanelBtn.dataset.drawerBound === 'true') return;
  $evidencePanelBtn.dataset.drawerBound = 'true';
  $evidencePanelBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleEvidenceDrawer();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEvidenceDrawer();
  });
}

function updateEvidenceButton(conversation) {
  if (!$evidencePanelBtn) return;
  const evidence = getLatestEvidenceMessage(conversation);
  if (!evidence) {
    $evidencePanelBtn.classList.add('hidden');
    $evidencePanelBtn.title = '暂无工具证据';
    closeEvidenceDrawer();
    return;
  }
  const runCount = Array.isArray(evidence.message.toolRuns) ? evidence.message.toolRuns.length : 0;
  $evidencePanelBtn.classList.remove('hidden');
  $evidencePanelBtn.title = runCount
    ? `查看最近工具证据：${runCount} 个工具`
    : '查看最近 Token / Cache 证据';
  if (evidenceDrawerEl) renderLatestEvidenceDrawer(evidenceDrawerEl, conversation);
}

function toggleEvidenceDrawer() {
  if (evidenceDrawerEl) {
    closeEvidenceDrawer();
    return;
  }
  const conv = getActiveConversation();
  if (!getLatestEvidenceMessage(conv)) return;
  closeUsageTelemetryPanel();
  evidenceDrawerEl = document.createElement('aside');
  evidenceDrawerEl.className = 'evidence-drawer-panel';
  evidenceDrawerEl.setAttribute('role', 'dialog');
  evidenceDrawerEl.setAttribute('aria-label', '最近工具证据');
  document.body.appendChild(evidenceDrawerEl);
  renderLatestEvidenceDrawer(evidenceDrawerEl, conv);
}

function closeEvidenceDrawer() {
  if (!evidenceDrawerEl) return;
  evidenceDrawerEl.remove();
  evidenceDrawerEl = null;
}

function getLatestEvidenceMessage(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const hasRuns = Array.isArray(message.toolRuns) && message.toolRuns.length > 0;
    const usage = message.tokens ? normalizeTokenUsage(message.tokens) : null;
    const hasUsage = Boolean(usage && usage.total > 0);
    const hasCacheProfile = Boolean(message.cacheProfile?.prefixFingerprint);
    if (hasRuns || hasUsage || hasCacheProfile) return { message, index };
  }
  return null;
}

function formatAgentStageBrief(stage = {}) {
  const round = stage.round !== undefined ? `R${stage.round} ` : '';
  const name = stage.stage || 'stage';
  const detail = [
    stage.toolName,
    stage.intent?.toolMode,
    stage.warning,
    stage.stopReason,
  ].filter(Boolean).join(' · ');
  return `${round}${name}${detail ? `：${detail}` : ''}`;
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
