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

import { approveToolRequest, streamChat, runTool } from './api.js';
import { extractContextMentions } from './context-mentions.ts';
import { getSettings } from './settings-core.js';
import { normalizeTokenUsage, getConversationUsageSummary } from './token-budget.js';
import { loadConversations, saveConversations } from './client-store.ts';
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
import { confirmAction, promptText } from './dialogs.ts';
import {
  buildArtifactDownloadName,
  createSandboxedHtmlDocument,
  extractArtifacts,
  getArtifactTypeLabel,
} from './artifacts.js';
import {
  applyToolDecision,
  applyToolResult,
  buildToolEvidencePayload,
  buildToolRuns,
  createToolRecord,
  extractLocalCitations,
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
import {
  uid,
  formatTime,
  relativeTime,
  scrollToBottom,
  truncate,
  copyToClipboard,
  showToast,
  escapeHtml,
  fillComposerPrompt,
  downloadTextFile,
} from './utils.js';
import {
  createAgentRun,
  applyCrewToolRequest,
  applyCrewToolResult,
  handleCrewAgentStage,
  finalizeCrewRun,
} from './agent-run-store.js';
import { renderAgentCrew } from './agent-crew.js';
import { renderAgentTheatre } from './agent-theatre.js';
import { renderToolCalls } from './chat-tool-ui.ts';
import { renderEvidencePanel } from './evidence-panel.ts';

function renderCrewOrTheatre(container: HTMLElement | null, agentRun: any) {
  if (!container) return;
  const mode = getSettings().crewDisplayMode || 'auto';
  if (mode === 'theatre') {
    renderAgentTheatre(container, agentRun);
  } else {
    renderAgentCrew(container, agentRun);
  }
}
import { renderStreamingMarkdown } from './streaming-renderer.js';
import { TraceRecorder, migrateLegacyAgentRun } from './agent-trace.js';
import { openTraceInspector } from './agent-trace-inspector.js';
import { saveTrace, isTraceRecordingEnabled } from './agent-trace-store.js';
import { COPY_FEEDBACK_MS, OUTLINE_HIGHLIGHT_MS } from './constants.js';
import { createVirtualList } from './virtual-message-list.js';
import { escapeRegExp, clampNumber, formatBytes } from './shared-utils.js';
import { createSidebar } from './chat-sidebar.js';
import { createStreamOrchestrator } from './chat-streaming.js';
import {
  createMarkdownCache,
  getCachedRenderedMarkdown as _getCachedRenderedMarkdown,
  primeMarkdownRenderCache as _primeMarkdownRenderCache,
  getMarkdownCacheKey as _getMarkdownCacheKey,
  hashString as _hashString,
  shouldCompactHistoricalMessage as _shouldCompactHistoricalMessage,
  getCompactMessagePreview as _getCompactMessagePreview,
  createMessageElement as _createMessageElement,
} from './chat-message-renderer.js';
import {
  formatTokenUsageTitle,
  formatConversationUsageTelemetry,
  buildConversationUsageTelemetryDetails,
  buildCacheProfile,
  normalizeCacheStabilityReasons,
  formatCacheStabilityReason,
  formatCacheStabilityDetails,
  getConversationCacheProfile,
  formatCompactTokenCount,
  formatUsd,
  formatUsageSourceLabel,
  createUsageMetric,
  createUsageSectionTitle,
  createUsageRow,
} from './chat-evidence-telemetry.js';
import {
  getToolRiskMeta as _getToolRiskMeta,
  shouldOfferToolRepair as _shouldOfferToolRepair,
  buildToolRepairPrompt as _buildToolRepairPrompt,
  compactToolOutputSummaryText as _compactToolOutputSummaryText,
  getRunCodeSourceCode as _getRunCodeSourceCode,
  formatCodeFenceLanguage as _formatCodeFenceLanguage,
  getBoundedRunCodeForPrompt as _getBoundedRunCodeForPrompt,
  buildRunCodeRerunPrompt as _buildRunCodeRerunPrompt,
  buildRunCodeExplainPrompt as _buildRunCodeExplainPrompt,
  buildRunCodeArtifactMarkdown as _buildRunCodeArtifactMarkdown,
} from './chat-tool-ui.js';
export {
  buildAnswerActionMenuGroups,
  buildAnswerActionPrompt,
  buildAnswerActionEvidenceSummary,
  buildAgentPlanExecutionSummaryParts,
  buildAgentPlanActionPrompt,
  buildAgentPlanActionComposerOverrides,
  compactAnswerActionContext,
  buildAssistantHtmlExport,
} from './chat-answer-actions.js';

export {
  formatTokenUsageTitle,
  formatConversationUsageTelemetry,
  buildConversationUsageTelemetryDetails,
  buildCacheProfile,
} from './chat-evidence-telemetry.js';

export {
  shouldCompactHistoricalMessage,
  getCompactMessagePreview,
  getMarkdownCacheKey,
  hashString,
} from './chat-message-renderer.js';

const getCachedRenderedMarkdown = (content: string) => _getCachedRenderedMarkdown(markdownRenderCache, content);
const primeMarkdownRenderCache = (content: string, html: string) =>
  _primeMarkdownRenderCache(markdownRenderCache, content, html);
const getMarkdownCacheKey = _getMarkdownCacheKey;
const hashString = _hashString;
const shouldCompactHistoricalMessage = _shouldCompactHistoricalMessage;
const getCompactMessagePreview = _getCompactMessagePreview;
const createMessageElement = _createMessageElement;

export {
  getToolRiskMeta,
  shouldOfferToolRepair,
  buildToolRepairPrompt,
  compactToolOutputSummaryText,
  getRunCodeSourceCode,
  formatCodeFenceLanguage,
  getBoundedRunCodeForPrompt,
  buildRunCodeRerunPrompt,
  buildRunCodeExplainPrompt,
  buildRunCodeArtifactMarkdown,
} from './chat-tool-ui.js';

const getToolRiskMeta = _getToolRiskMeta;
const shouldOfferToolRepair = _shouldOfferToolRepair;
const buildToolRepairPrompt = _buildToolRepairPrompt;
const compactToolOutputSummaryText = _compactToolOutputSummaryText;
const getRunCodeSourceCode = _getRunCodeSourceCode;
const formatCodeFenceLanguage = _formatCodeFenceLanguage;
const getBoundedRunCodeForPrompt = _getBoundedRunCodeForPrompt;
const buildRunCodeRerunPrompt = _buildRunCodeRerunPrompt;
const buildRunCodeExplainPrompt = _buildRunCodeExplainPrompt;
const buildRunCodeArtifactMarkdown = _buildRunCodeArtifactMarkdown;

import {
  buildAnswerActionMenuGroups,
  buildAnswerActionPrompt,
  buildAnswerActionEvidenceSummary,
  buildAgentPlanExecutionSummaryParts,
  buildAgentPlanActionPrompt,
  buildAgentPlanActionComposerOverrides,
  compactAnswerActionContext,
  buildAssistantHtmlExport,
} from './chat-answer-actions.js';

let conversations: any[] = [];
let activeConvId: string | null = null;
let abortController: AbortController | null = null;
let isStreaming: boolean = false;
let userScrolledUp: boolean = false; // Smart scroll: track if user scrolled up
let sidebarFilter = SIDEBAR_FILTERS.active;
let bulkMode: boolean = false;
let selectedConversationIds: Set<string> = new Set();
let conversationMenuEl: HTMLElement | null = null;
let conversationMenuCleanup: (() => void) | null = null;
let usageTelemetryPanelEl: HTMLElement | null = null;
let evidenceDrawerEl: HTMLElement | null = null;
let _virtualList: any = null;
let sidebar: any = null;
let streamOrchestrator: any = null;

let $messages: HTMLElement | null = null,
  $welcome: HTMLElement | null = null,
  $convList: HTMLElement | null = null,
  $chatTitle: HTMLElement | null = null,
  $modelName: HTMLElement | null = null,
  $chatUsageBadge: HTMLElement | null = null,
  $evidencePanelBtn: HTMLElement | null = null;

const markdownRenderCache = createMarkdownCache();

let _chatCleanupFns: Array<() => void> = [];

function _on(el: HTMLElement, type: string, fn: any, opts?: any) {
  el.addEventListener(type, fn, opts);
  _chatCleanupFns.push(() => el.removeEventListener(type, fn, opts));
}

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

  sidebar = createSidebar({
    getConversations: () => conversations,
    setConversations: (convs: Record<string, any>[]) => {
      conversations = convs;
    },
    getActiveConvId: () => activeConvId,
    setActiveConvId: (id: string) => {
      activeConvId = id;
    },
    getSidebarFilter: () => sidebarFilter,
    setSidebarFilter: (f: string) => {
      sidebarFilter = f;
    },
    getBulkMode: () => bulkMode,
    setBulkMode: (m: boolean) => {
      bulkMode = m;
    },
    getSelectedIds: () => selectedConversationIds,
    persist,
    switchConversation,
    deleteConversation,
    renameConversation,
    showWelcome,
    updateHeader,
    togglePinConversation,
    $convList,
  });
  sidebar.bindConversationToolbar();

  streamOrchestrator = createStreamOrchestrator({
    getIsStreaming: () => isStreaming,
    setIsStreaming: (v: any) => {
      isStreaming = v;
    },
    getUserScrolledUp: () => userScrolledUp,
    setUserScrolledUp: (v: any) => {
      userScrolledUp = v;
    },
    getAbortController: () => abortController,
    setAbortController: (v: any) => {
      abortController = v;
    },
    $messages,
    getSettings,
    toggleStreamingUI,
    appendMessageDOM,
    smartScroll,
    updateSpeedIndicator,
    removeSpeedIndicator,
    renderToolCalls,
    renderEvidencePanel,
    renderAgentTimeline,
    renderCrewOrTheatre,
    addMessageActions,
    renderStoppedNotice,
    renderAssistantAnswerHeader,
    renderAssistantArtifacts,
    renderAssistantEvidence,
    renderAssistantToc,
    renderErrorContent,
    attachCopyHandlersOnly,
    syncToolRuns,
    persist,
    updateHeader,
    refreshConversationTaskCheckpoint,
    primeMarkdownRenderCache: (content: string, html: string) => primeMarkdownRenderCache(content, html),
    refreshReadingNavigator,
    getConversationUsageSummary,
    buildCacheProfile,
    streamChat,
    approveToolRequest,
    applyToolDecision,
    applyToolResult,
    createToolRecord,
    enhancePrompt,
    isEnhanceEnabled,
    maybeAppendRelevantMemory,
    formatTaskCheckpointStageSummary,
    hasUncitedSearchSource: hasUncitedSearchSource,
    hasUncitedLocalSource: hasUncitedLocalSource,
  });

  conversations = normalizeConversations(await loadConversations());

  sidebar.renderConversationList();
  if (conversations.length > 0) {
    switchConversation(conversations[0].id);
  }

  // Smart scroll: detect when user scrolls up during streaming
  let scrollRaf = 0;
  _on($messages!, 'scroll', () => {
    if (!isStreaming) return;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const threshold = 80;
      const atBottom = $messages!.scrollHeight - $messages!.scrollTop - $messages!.clientHeight < threshold;
      userScrolledUp = !atBottom;
    });
  });

  // Search
  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  if (searchInput) {
    const onInput = () => sidebar.renderConversationList(searchInput.value.trim());
    searchInput.addEventListener('input', onInput);
    _chatCleanupFns.push(() => searchInput.removeEventListener('input', onInput));
  }

  const runCodeHandler = (event: CustomEvent) => {
    handleRunCodeBlock(event.detail).catch((error) => showToast(error.message || '代码运行失败'));
  };
  document.addEventListener('deepchat:run-code-block', runCodeHandler as EventListener);
  _chatCleanupFns.push(() => document.removeEventListener('deepchat:run-code-block', runCodeHandler as EventListener));

  // Agent control events
  const agentPauseHandler = () => {
    if (isStreaming) {
      showToast('Agent 已暂停');
      stopStreaming();
    }
  };
  const agentStopHandler = () => {
    if (isStreaming) {
      showToast('Agent 已停止');
      stopStreaming();
    }
  };
  const agentSkipToolHandler = () => {
    showToast('跳过当前工具（功能开发中）');
  };
  document.addEventListener('deepchat:agent-pause', agentPauseHandler);
  document.addEventListener('deepchat:agent-stop', agentStopHandler);
  document.addEventListener('deepchat:agent-skip-tool', agentSkipToolHandler);
  _chatCleanupFns.push(() => {
    document.removeEventListener('deepchat:agent-pause', agentPauseHandler);
    document.removeEventListener('deepchat:agent-stop', agentStopHandler);
    document.removeEventListener('deepchat:agent-skip-tool', agentSkipToolHandler);
  });

  const reloadHandler = () => {
    reloadConversations().catch(() => showToast('刷新对话失败'));
  };
  window.addEventListener('deepchat:reload-conversations', reloadHandler);
  _chatCleanupFns.push(() => window.removeEventListener('deepchat:reload-conversations', reloadHandler));

  // Global shortcut: Ctrl+Shift+T opens trace for the latest assistant message
  const traceKeyHandler = (event: KeyboardEvent) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {
      event.preventDefault();
      const conv = getActiveConversation();
      if (!conv) return;
      const lastAssistant = [...conv.messages].reverse().find((m) => m.role === 'assistant');
      if (lastAssistant?.traceRecorder) {
        openTraceInspector(lastAssistant.traceRecorder, { conversationTitle: conv.title });
      } else if (lastAssistant?.agentRun) {
        // Legacy: migrate old agentRun to trace and open
        const recorder = migrateLegacyAgentRun(lastAssistant.agentRun);
        if (recorder) openTraceInspector(recorder, { conversationTitle: conv.title });
      }
    }
  };
  document.addEventListener('keydown', traceKeyHandler);
  _chatCleanupFns.push(() => document.removeEventListener('keydown', traceKeyHandler));
}

export function destroyChat() {
  if (isStreaming) stopStreaming();
  _chatCleanupFns.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.warn('chat cleanup failed:', err);
    }
  });
  _chatCleanupFns = [];
}

async function reloadConversations() {
  conversations = await loadConversations();
  if (conversations.length > 0) {
    const stillExists = conversations.some((conv) => conv.id === activeConvId);
    switchConversation(stillExists ? activeConvId : conversations[0].id);
  } else {
    activeConvId = null;
    sidebar.renderConversationList();
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
    scrollToBottom($messages!, smooth);
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
  sidebar.renderConversationList();
  switchConversation(conv.id);
  return conv;
}

function switchConversation(id: string) {
  if (isStreaming) stopStreaming();
  activeConvId = id;
  userScrolledUp = false;
  resetReadingNavigator();
  sidebar.renderConversationList();
  renderMessages();
  updateHeader();
  refreshReadingNavigator();
  const conv = conversations.find((c) => c.id === id);
  if (conv) {
    window.dispatchEvent(
      new CustomEvent('deepchat:conversation-switched', {
        detail: { conversationId: id, composerModeId: conv.composerModeId || '' },
      })
    );
  }
}

export function getActiveConversationComposerMode() {
  const conv = conversations.find((c) => c.id === activeConvId);
  return conv?.composerModeId || '';
}

export function setActiveConversationComposerMode(modeId: string) {
  const conv = conversations.find((c) => c.id === activeConvId);
  if (!conv) return;
  conv.composerModeId = modeId;
  persist();
}

async function deleteConversation(id: string) {
  const conv = conversations.find((c) => c.id === id);
  const title = conv ? conv.title : '此对话';
  const ok = await confirmAction({
    title: '删除对话',
    message: `确定删除「${title}」？此操作不可恢复。`,
    confirmText: '删除',
    tone: 'danger',
  });
  if (!ok) return;

  conversations = conversations.filter((c) => c.id !== id);
  selectedConversationIds.delete(id);
  persist();
  if (activeConvId === id) {
    if (conversations.length > 0) {
      switchConversation(conversations[0].id);
    } else {
      activeConvId = null;
      sidebar.renderConversationList();
      showWelcome();
      $chatTitle!.textContent = '新的对话';
    }
  } else {
    sidebar.renderConversationList();
  }
}

function renameConversation(id: string, newTitle: string) {
  const conv = conversations.find((c) => c.id === id);
  if (!conv || !newTitle.trim()) return;
  conv.title = newTitle.trim();
  persist();
  sidebar.renderConversationList();
  if (id === activeConvId) updateHeader();
}

function togglePinConversation(id: string) {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  conv.pinned = !conv.pinned;
  persist();
  sidebar.renderConversationList();
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
  sidebar.renderConversationList();
}

function getActiveConversation() {
  return conversations.find((c) => c.id === activeConvId) || null;
}

// ─── Export ───

export function exportCurrentChat(format = 'markdown') {
  const conv = getActiveConversation();
  exportConversation(conv, format);
}

// ─── Send / Edit / Regenerate ───

export async function sendMessage(content: string, options: Record<string, any> = {}) {
  if (isStreaming) return;
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  if (!content.trim() && attachments.length === 0) return;

  let conv = getActiveConversation();
  if (!conv) conv = createConversation();

  if ($welcome!) $welcome!.style.display = 'none';

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
  scrollToBottom($messages!);

  if (conv.messages.filter((m: Record<string, any>) => m.role === 'user').length === 1) {
    conv.title = truncate(content.trim() || attachments[0]?.name || '附件对话', 25);
    sidebar.renderConversationList();
    updateHeader();
  }
  persist();

  await streamOrchestrator.doStream(conv, 0, null, options.composerOverrides || null);
}

/**
 * Edit a user message at a given index and regenerate from that point.
 * Removes all messages after the edit point.
 */
async function editMessageAt(msgIndex: number, newContent: string) {
  if (isStreaming) return;
  const conv = getActiveConversation();
  if (!conv) return;

  // Update message content and truncate everything after it
  if (!conv.messages[msgIndex]) return;
  conv.messages[msgIndex].content = newContent.trim();
  conv.messages = conv.messages.slice(0, msgIndex + 1);
  refreshConversationTaskCheckpoint(conv);
  persist();

  // Re-render all messages
  renderMessages();
  await streamOrchestrator.doStream(conv);
}

async function regenerateLastResponse() {
  if (isStreaming) return;
  const conv = getActiveConversation();
  if (!conv || conv.messages.length === 0) return;

  const idx = conv.messages.map((m: Record<string, any>) => m.role).lastIndexOf('assistant');
  if (idx >= 0) await regenerateResponseAt(idx);
}

async function regenerateResponseAt(msgIndex: number) {
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
  await streamOrchestrator.doStream(conv, 0, oldMsg.versions);
}

export function trimMessagesForRegeneration(messages: Record<string, any>[], msgIndex: number) {
  if (!Array.isArray(messages) || messages[msgIndex]?.role !== 'assistant') return messages;
  return messages.slice(0, msgIndex);
}

// ─── doStream extracted to chat-streaming.js ───

function updateSpeedIndicator(msgEl: HTMLElement, speed: number) {
  let indicator = msgEl.querySelector('.speed-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'speed-indicator';
    msgEl.querySelector('.message-body')?.appendChild(indicator);
  }
  indicator.textContent = `⚡ ${speed} tok/s`;
}

function removeSpeedIndicator(msgEl: HTMLElement) {
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
  if ($welcome!) $welcome!.style.display = '';
  if (_virtualList) {
    _virtualList.destroy();
    _virtualList = null;
  }
  $messages!.querySelectorAll('.message').forEach((m) => m.remove());
  refreshReadingNavigator();
}

function renderCompactAssistantMessage(contentEl: HTMLElement, msg: Record<string, any>, idx: number) {
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
    await postProcess(contentEl, true);
    const conv = getActiveConversation();
    const currentMsg = conv?.messages?.[idx] || msg;
    if (currentMsg.stopped) renderStoppedNotice(contentEl.closest('.message-body') as HTMLElement, idx);
    refreshReadingNavigator();
  });
  card.append(meta, preview, expand);
  contentEl.appendChild(card);
}

function _setupMessageElement(el: HTMLElement, msg: Record<string, any>, idx: number, totalMessageCount: number) {
  el.dataset.messageIndex = String(idx);
  if (msg.role === 'user') {
    addUserMessageActions(el, msg, idx);
  }
  if (msg.role === 'assistant') {
    const contentEl = el.querySelector('.message-content') as HTMLElement | null;
    if (!contentEl) return;
    if (msg.error) {
      if (msg.content) {
        contentEl.innerHTML = getCachedRenderedMarkdown(msg.content);
        postProcess(contentEl, true)
          .then(() => {
            renderAssistantToc(el.querySelector('.answer-toc-container') as HTMLElement, contentEl);
            refreshReadingNavigator();
          })
          .catch((err) => console.warn('[Chat] postProcess failed:', err));
        const errorWrap = document.createElement('div');
        renderErrorContent(errorWrap, msg.error);
        if (errorWrap.firstElementChild) contentEl.appendChild(errorWrap.firstElementChild);
      } else {
        renderErrorContent(contentEl, msg.error);
      }
    } else if (shouldCompactHistoricalMessage(totalMessageCount, idx, msg)) {
      renderCompactAssistantMessage(contentEl!, msg, idx);
    } else {
      contentEl.innerHTML = getCachedRenderedMarkdown(msg.content);
      postProcess(contentEl, true)
        .then(() => {
          renderAssistantToc(el.querySelector('.answer-toc-container') as HTMLElement, contentEl);
          refreshReadingNavigator();
        })
        .catch((err) => console.warn('[Chat] postProcess failed:', err));
    }
    renderAssistantAnswerHeader(el.querySelector('.answer-header-container') as HTMLElement, msg);
    addMessageActions(el, msg.content, msg.tokens, msg.speed, idx);
    if (msg.stopped) renderStoppedNotice(el.querySelector('.message-body') as HTMLElement, idx);

    if (msg.thinking) {
      const thinkingBlock = el.querySelector('.thinking-block') as HTMLElement | null;
      const thinkingContentEl = el.querySelector('.thinking-content') as HTMLElement | null;
      if (thinkingBlock && thinkingContentEl) {
        thinkingBlock.hidden = false;
        thinkingContentEl.textContent = msg.thinking;
      }
    }
    renderToolCalls(el.querySelector('.tool-calls-container') as HTMLElement, msg.toolCalls || []);
    renderEvidencePanel(el.querySelector('.evidence-panel') as HTMLElement | null, msg.toolCalls || []);
    renderAgentTimeline(el.querySelector('.agent-timeline-container') as HTMLElement, msg);

    let agentRun = msg.agentRun;
    if (!agentRun && ((msg.toolCalls && msg.toolCalls.length > 0) || (msg.agentStages && msg.agentStages.length > 0))) {
      agentRun = createAgentRun(msg.composerOverrides?.activeSkill || 'auto');
      if (msg.agentStages && msg.agentStages.length > 0) {
        msg.agentStages.forEach((stage: Record<string, any>) => handleCrewAgentStage(agentRun, stage));
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        msg.toolCalls.forEach((tool: Record<string, any>) => {
          applyCrewToolRequest(agentRun, tool);
          applyCrewToolResult(agentRun, tool, msg.toolCalls);
        });
      }
      finalizeCrewRun(agentRun, { aborted: msg.stopped, error: msg.error });
      msg.agentRun = agentRun;
    }
    const historyCrewContainer = el.querySelector('.agent-crew-container') as HTMLElement | null;
    renderCrewOrTheatre(historyCrewContainer as HTMLElement, agentRun);
    if (historyCrewContainer && !(historyCrewContainer as any).__crewClickBound) {
      (historyCrewContainer as any).__crewClickBound = true;
      historyCrewContainer.addEventListener('deepchat:crew-role-click', (e: Event) => {
        const roleId = (e as CustomEvent).detail?.roleId;
        if (!roleId) return;
        const toolNameMap: Record<string, string[]> = {
          reader: ['read_file', 'search_workspace', 'read_symbol'],
          researcher: ['web_search'],
          coder: ['run_code'],
        };
        const targetTools = toolNameMap[roleId];
        const historyToolContainer = el.querySelector('.tool-calls-container');
        if (targetTools && historyToolContainer) {
          const blocks = historyToolContainer.querySelectorAll('.tool-call-block');
          for (const block of blocks) {
            const nameEl = block.querySelector('.tool-call-header strong');
            if (nameEl && targetTools.some((t: string) => nameEl.textContent!.includes(t))) {
              (block as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
              (block as HTMLElement).style.outline = '2px solid var(--accent-primary)';
              setTimeout(() => {
                if (block.isConnected) (block as HTMLElement).style.outline = '';
              }, OUTLINE_HIGHLIGHT_MS);
              return;
            }
          }
        }
        const historyContentEl = el.querySelector('.message-content');
        if (historyContentEl) {
          historyContentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      // Ctrl+Click on historical crew opens Trace Inspector
      historyCrewContainer.addEventListener('click', (e: MouseEvent) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        const historyTraceRecorder = agentRun ? migrateLegacyAgentRun(agentRun) : null;
        if (historyTraceRecorder) {
          openTraceInspector(historyTraceRecorder, { readOnly: true } as any);
        }
      });
    }

    renderAssistantArtifacts(el.querySelector('.artifact-container') as HTMLElement, msg);
    renderAssistantEvidence(el.querySelector('.message-body') as HTMLElement, msg);
  }
}

function renderMessages() {
  const conv = getActiveConversation();
  resetReadingNavigator();

  if (_virtualList) {
    _virtualList.destroy();
    _virtualList = null;
  }

  $messages!.querySelectorAll('.message').forEach((m) => m.remove());

  if (!conv || conv.messages.length === 0) {
    if ($welcome!) $welcome!.style.display = '';
    refreshReadingNavigator();
    return;
  }

  if ($welcome!) $welcome!.style.display = 'none';

  // Use virtual list for long conversations
  if (conv.messages.length >= 30 && !isStreaming) {
    _virtualList = createVirtualList({
      container: $messages,
      getCount: () => conv.messages.length,
      renderItem: (index: number) => {
        const msg = conv.messages[index];
        const el = _createMessageElement(msg);
        _setupMessageElement(el, msg, index, conv.messages.length);
        return el;
      },
      settings: { virtualScrollEnabled: true },
    });
    _virtualList.enable();
  } else {
    // Incremental render: show last 15 immediately, fill the rest during idle
    const total = conv.messages.length;
    const immediateCount = Math.min(total, 15);
    const startImmediate = Math.max(0, total - immediateCount);

    for (let idx = startImmediate; idx < total; idx++) {
      const msg = conv.messages[idx];
      const el = _createMessageElement(msg);
      _setupMessageElement(el, msg, idx, total);
      $messages!.appendChild(el);
    }

    // Render earlier messages during idle time
    if (startImmediate > 0) {
      const schedule = typeof requestIdleCallback !== 'undefined' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 0);
      let batchStart = startImmediate - 1;
      const renderBatch = () => {
        if (batchStart < 0) return;
        const batchEnd = Math.max(0, batchStart - 4); // render 5 at a time
        for (let idx = batchStart; idx >= batchEnd; idx--) {
          const msg = conv.messages[idx];
          const el = _createMessageElement(msg);
          _setupMessageElement(el, msg, idx, total);
          if ($messages!.firstChild) {
            $messages!.insertBefore(el, $messages!.firstChild);
          } else {
            $messages!.appendChild(el);
          }
        }
        batchStart = batchEnd - 1;
        if (batchStart >= 0) schedule(renderBatch);
      };
      schedule(renderBatch);
    }
  }

  scrollToBottom($messages!, false);
  refreshReadingNavigator();
}

function appendMessageDOM(msg: Record<string, any>, streaming = false) {
  if (_virtualList) {
    _virtualList.destroy();
    _virtualList = null;
  }
  const el = _createMessageElement(msg, streaming);
  if ($welcome! && $welcome!.parentNode === $messages!) {
    $messages!.insertBefore(el, $welcome!);
  } else {
    $messages!.appendChild(el);
  }
  return el;
}

function renderAttachmentStrip(attachments: any[] = []) {
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
    } else {
      const icon = document.createElement('div');
      icon.className = 'message-attachment-icon';
      icon.textContent = '📄';
      item.appendChild(icon);
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
    chip.textContent =
      mention.type === 'folder'
        ? `目录 ${mention.path}`
        : mention.type === 'symbol'
          ? `符号 ${mention.path}`
          : `文件 ${mention.path}`;
    chip.title = mention.path;
    strip.appendChild(chip);
  }
  return strip;
}

export function renderAgentTimeline(container: HTMLElement, message: Record<string, any> = {}) {
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
  const planCard = createAgentPlanCard(planStage?.planSummary, message.contextBudget);
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
    ]
      .filter(Boolean)
      .join(' · ');
    item.append(title);
    if (meta.textContent) item.appendChild(meta);
    list.appendChild(item);
  }
  panel.appendChild(list);
  container.appendChild(panel);
}

function createAgentPlanCard(
  plan: Record<string, any> | null = null,
  contextBudget: Record<string, any> | null = null
) {
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
  ]
    .filter(Boolean)
    .join(' · ');
  header.append(title, meta);
  card.appendChild(header);

  const summary = createAgentPlanExecutionSummary(plan);
  if (summary) card.appendChild(summary);
  const budgetSummary = createAgentPlanBudgetSummary(contextBudget);
  if (budgetSummary) card.appendChild(budgetSummary);

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
  const blockedNotice = createAgentPlanBlockedNotice(plan);
  if (blockedNotice) card.appendChild(blockedNotice);
  card.appendChild(createAgentPlanActions(plan));
  return card;
}

function createAgentPlanBlockedNotice(plan: Record<string, any> = {}) {
  const availability = getAgentPlanActionAvailability(plan);
  const reason = availability.disabledReasons.execute_all || availability.disabledReasons.single_step || '';
  if (!reason) return null;
  const notice = document.createElement('div');
  notice.className = 'agent-plan-blocked-notice';
  notice.textContent = `执行已暂停：${reason}`;
  return notice;
}

function createAgentPlanActions(plan: Record<string, any> = {}) {
  const actions = document.createElement('div');
  actions.className = 'agent-plan-actions';
  const availability = getAgentPlanActionAvailability(plan);
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
    const disabledReason = availability.disabledReasons[action] || '';
    button.title = disabledReason || title;
    if (disabledReason) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
    button.addEventListener('click', () => applyAgentPlanAction(action, plan));
    actions.appendChild(button);
  });
  return actions;
}

export function getAgentPlanActionAvailability(plan: Record<string, any> = {}) {
  const missing = Array.isArray(plan.missingPrerequisites)
    ? plan.missingPrerequisites.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const disabledReasons: Record<string, any> = {};
  if (missing.length) {
    const reason = `缺少配置：${missing.join('、')}。请先修改计划或完成配置。`;
    disabledReasons.execute_all = reason;
    disabledReasons.single_step = reason;
  }
  return { missingPrerequisites: missing, disabledReasons };
}

function applyAgentPlanAction(action: string, plan: Record<string, any> = {}) {
  const disabledReason = getAgentPlanActionAvailability(plan).disabledReasons[action];
  if (disabledReason) {
    showToast(disabledReason, 3200);
    return;
  }
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
  if (shouldAutoSendAgentPlanAction(action)) {
    sendMessage(prompt, {
      composerOverrides: buildAgentPlanActionComposerOverrides(action),
    });
    return;
  }
  fillComposerPrompt(prompt);
  showToast(action === 'execute_all' ? '当前计划已在执行，已准备继续指令' : '已填入计划控制指令');
}

function shouldAutoSendAgentPlanAction(action: string) {
  if (isStreaming) return false;
  if (!['execute_all', 'single_step', 'revise'].includes(action)) return false;
  return Boolean(conversations.find((conv) => conv.id === activeConvId));
}


function appendAgentSearchPlan(card: HTMLElement, searchPlan: any[] = []) {
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

function appendAgentPlanChips(card: HTMLElement, labelText: string, values: any[] = [], extraClass = '') {
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

function createAgentPlanExecutionSummary(plan: Record<string, any> = {}) {
  const { parts, hasWarning } = buildAgentPlanExecutionSummaryParts(plan);
  if (!parts.length) return null;
  const box = document.createElement('div');
  box.className = `agent-plan-execution-summary${hasWarning ? ' is-warning' : ''}`;
  box.textContent = parts.join(' · ');
  box.title = '根据计划中的工具、搜索计划和缺失配置生成的执行前摘要。';
  return box;
}

function createAgentPlanBudgetSummary(contextBudget: Record<string, any> | null = null) {
  if (!contextBudget || typeof contextBudget !== 'object') return null;
  const max = Number(contextBudget.maxInputTokens || 0);
  const estimated = Number(contextBudget.estimatedInputTokens || 0);
  const parts = [
    max || estimated ? `上下文：${formatCompactTokenCount(estimated)} / ${formatCompactTokenCount(max)} tok` : '',
    contextBudget.trimmed ? `已裁剪 ${contextBudget.droppedCount || 0} 条历史` : '未裁剪历史',
    contextBudget.summaryUsed ? '已使用长期记忆' : '',
    contextBudget.prefixFingerprint ? `prefix ${contextBudget.prefixFingerprint}` : '',
  ].filter(Boolean);
  if (!parts.length) return null;
  const box = document.createElement('div');
  box.className = `agent-plan-budget-summary${contextBudget.trimmed ? ' is-trimmed' : ''}`;
  box.textContent = parts.join(' · ');
  box.title = '本轮 Agent 计划将使用的输入预算、裁剪状态和缓存前缀。';
  return box;
}

function collapseAgentStages(stages: Record<string, any>[]) {
  return stages.slice(-12);
}

function formatAgentStageLabel(stage: Record<string, any> = {}) {
  const labels: Record<string, string> = {
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

function formatTaskCheckpointStageSummary(checkpoint: Record<string, any> = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') return '';
  const statusLabels: Record<string, string> = {
    ready: '可继续',
    needs_attention: '需要处理',
    waiting_for_approval: '等待确认',
    failed: '上一轮失败',
    completed: '已完成',
  };
  const parts: string[] = [];
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

function syncToolRuns(message: any) {
  message.toolRuns = buildToolRuns(message.toolCalls || []);
}

function maybeAppendRelevantMemory(apiMessages: Record<string, any>[], conversation: Record<string, any>) {
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

function refreshConversationTaskCheckpoint(conversation: Record<string, any>) {
  if (!conversation) return;
  const checkpoint = buildTaskCheckpoint(conversation);
  conversation.taskCheckpoint = checkpoint;
  conversation.taskCheckpointUpdatedAt = checkpoint?.updatedAt || null;
}

function findLastUserMessageIndex(messages: any[] = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

export function hasSearchWithoutCitedSource(message: any, content: string) {
  return hasUncitedSearchSource(message, content);
}

export function hasLocalFilesWithoutCitedSource(message: any, content: string) {
  return hasUncitedLocalSource(message, content);
}

export function renderAssistantArtifacts(container: HTMLElement, message: any) {
  if (!container) return [];
  container.replaceChildren();
  const artifacts = extractArtifacts(message?.content || '');
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

function renderArtifactCard(artifact: Record<string, any>, index: number) {
  const card = document.createElement('div');
  card.className = 'artifact-card';
  card.dataset.artifactType = artifact.type;

  const main = document.createElement('div');
  main.className = 'artifact-card-main';

  const title = document.createElement('div');
  title.className = 'artifact-title';
  title.textContent = artifact.title || getArtifactTypeLabel(artifact.type);

  const meta = document.createElement('div');
  meta.className = 'artifact-meta';
  const metaParts = buildArtifactMetaParts(artifact);
  meta.textContent = metaParts.join(' · ');
  main.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'artifact-actions';

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'artifact-action-btn primary';
  previewBtn.textContent = '预览';
  previewBtn.addEventListener('click', () => openArtifactPreview(artifact));

  const downloadBtn = document.createElement('button');
  downloadBtn.type = 'button';
  downloadBtn.className = 'artifact-action-btn';
  downloadBtn.textContent = '导出';
  downloadBtn.addEventListener('click', () => downloadArtifact(artifact, index));

  actions.append(previewBtn, downloadBtn);
  card.append(main, actions);
  return card;
}

function buildArtifactMetaParts(artifact: Record<string, any>) {
  const parts = [formatBytes(artifact.size || 0)];
  switch (artifact.type) {
    case 'html-preview': {
      parts.push('脚本禁用');
      if (artifact.externalResourceCount) parts.push(`${artifact.externalResourceCount} 个外链资源受 CSP 限制`);
      break;
    }
    case 'mermaid': {
      parts.push('图表');
      break;
    }
    case 'table': {
      parts.push(artifact.format === 'markdown' ? 'Markdown 表格' : artifact.format?.toUpperCase() || '表格');
      break;
    }
    case 'json-data': {
      parts.push(artifact.parsed ? '有效 JSON' : '原始 JSON');
      break;
    }
    case 'code-file': {
      parts.push(artifact.language || '代码');
      break;
    }
    default:
      break;
  }
  if (artifact.truncated) parts.push('已按预览上限裁剪');
  return parts.filter(Boolean);
}

export function renderAssistantAnswerHeader(container: HTMLElement, message: Record<string, any> = {}) {
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

export function renderAssistantToc(container: HTMLElement, contentEl: HTMLElement, options: Record<string, any> = {}) {
  if (!container || !contentEl) return [];
  container.innerHTML = '';
  const minHeadings = Number.isFinite(options.minHeadings) ? options.minHeadings : 3;
  const headings = Array.from(contentEl.querySelectorAll('h2, h3'))
    .map((heading: Element, index: number) => {
      const text = String(heading.textContent || '')
        .trim()
        .replace(/\s+/g, ' ');
      if (!text) return null;
      const id = ensureHeadingId(heading, text, index);
      return {
        id,
        text: truncate(text, 48),
        level: heading.tagName.toLowerCase(),
      };
    })
    .filter(Boolean);

  if (headings.length < minHeadings) {
    container.hidden = true;
    return [];
  }

  container.hidden = false;
  const title = document.createElement('div');
  title.className = 'answer-toc-title';
  title.textContent = '目录';
  const list = document.createElement('ol');
  list.className = 'answer-toc-list';
  for (const item of headings.slice(0, 8)) {
    if (!item) continue;
    const row = document.createElement('li');
    row.className = `answer-toc-item level-${item.level}`;
    const link = document.createElement('a');
    link.href = `#${item.id}`;
    link.textContent = item.text;
    row.appendChild(link);
    list.appendChild(row);
  }
  if (headings.length > 8) {
    const more = document.createElement('li');
    more.className = 'answer-toc-more';
    more.textContent = `还有 ${headings.length - 8} 个小节`;
    list.appendChild(more);
  }
  container.append(title, list);
  return headings;
}

function ensureHeadingId(heading: Element, text: string, index: number) {
  const current = String(heading.id || '').trim();
  if (current) return current;
  const slug = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const id = `answer-section-${slug || 'section'}-${index + 1}`;
  heading.id = id;
  return id;
}

function buildAssistantAnswerHeaderItems(message: Record<string, any> = {}) {
  const items = [];
  const type = inferAnswerType(message);
  if (type) items.push({ kind: 'type', label: type });

  const model = String(message.model || message.tokens?.model || message.cacheProfile?.model || '').trim();
  if (model) items.push({ kind: 'model', label: model });

  const runs = getAssistantHeaderToolRuns(message);
  if (runs.length) {
    const failed = runs.filter((run) => isFailedToolStatus(run.status) || run.ok === false).length;
    const completed = runs.filter((run) => run.status === 'completed' || run.ok === true).length;
    const suffix = failed ? ` · ${failed} 失败` : completed ? ` · ${completed} 完成` : '';
    items.push({ kind: failed ? 'tool-warning' : 'tool', label: `工具 ${runs.length}${suffix}` });
  }

  if (Array.isArray(message.agentStages) && message.agentStages.length) {
    const rounds = Math.max(...message.agentStages.map((stage) => Number(stage.round || 0)).filter(Number.isFinite), 0);
    items.push({ kind: 'agent', label: rounds > 0 ? `Agent ${rounds} 轮` : 'Agent 过程' });
  }

  if (message.tokens) {
    const usage = normalizeTokenUsage(message.tokens);
    const source = usage.source === 'provider' ? '实测' : usage.source === 'mixed' ? '混合' : '估算';
    items.push({ kind: 'token', label: `${source} ${formatCompactTokenCount(usage.total)} tok` });
    if (usage.cacheHit > 0 || usage.cacheMiss > 0) {
      items.push({ kind: 'cache', label: `缓存 ${Math.round((usage.cacheHitRate || 0) * 100)}%` });
    }
    if (usage.reasoning > 0)
      items.push({ kind: 'thinking', label: `思考 ${formatCompactTokenCount(usage.reasoning)} tok` });
  }

  if (message.contextBudget?.trimmed) {
    items.push({ kind: 'budget', label: `裁剪 ${message.contextBudget.droppedCount || 0} 条历史` });
  } else if (message.contextBudget?.summaryUsed) {
    items.push({ kind: 'budget', label: '已用长期记忆' });
  }

  return items;
}

function buildAssistantAnswerHeaderTitle(message: Record<string, any> = {}) {
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

function inferAnswerType(message: Record<string, any> = {}) {
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

function getAssistantHeaderToolRuns(message: Record<string, any> = {}) {
  return [
    ...(Array.isArray(message.toolRuns) ? message.toolRuns : []),
    ...(Array.isArray(message.toolCalls) ? message.toolCalls : []),
  ].filter(Boolean);
}

function isFailedToolStatus(status: Record<string, any>) {
  return ['failed', 'error', 'denied', 'timeout', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase());
}

function openArtifactPreview(artifact: Record<string, any>) {
  switch (artifact.type) {
    case 'html-preview':
      openHtmlArtifactPreview(artifact);
      break;
    case 'mermaid':
      openMermaidArtifactPreview(artifact);
      break;
    case 'json-data':
      openJsonArtifactPreview(artifact);
      break;
    case 'code-file':
      openCodeArtifactPreview(artifact);
      break;
    case 'table':
      openTableArtifactPreview(artifact);
      break;
    default:
      openHtmlArtifactPreview(artifact);
  }
}

function openHtmlArtifactPreview(artifact: Record<string, any>) {
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
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function openMermaidArtifactPreview(artifact: Record<string, any>) {
  document.querySelector('.artifact-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'artifact-preview-panel';

  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('h3');
  title.textContent = artifact.title || 'Mermaid 图表';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'artifact-preview-close';
  closeBtn.setAttribute('aria-label', '关闭预览');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const content = document.createElement('div');
  content.className = 'artifact-preview-content';
  const pre = document.createElement('pre');
  pre.className = 'artifact-preview-code language-mermaid';
  pre.textContent = artifact.source;
  content.appendChild(pre);

  panel.append(header, content);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function openJsonArtifactPreview(artifact: Record<string, any>) {
  document.querySelector('.artifact-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'artifact-preview-panel';

  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('h3');
  title.textContent = artifact.title || 'JSON 数据';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'artifact-preview-close';
  closeBtn.setAttribute('aria-label', '关闭预览');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const content = document.createElement('div');
  content.className = 'artifact-preview-content';
  const pre = document.createElement('pre');
  pre.className = 'artifact-preview-code language-json';
  try {
    pre.textContent = JSON.stringify(JSON.parse(artifact.source), null, 2);
  } catch {
    pre.textContent = artifact.source;
  }
  content.appendChild(pre);

  panel.append(header, content);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function openCodeArtifactPreview(artifact: Record<string, any>) {
  document.querySelector('.artifact-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'artifact-preview-panel';

  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('h3');
  title.textContent = artifact.title || '代码文件';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'artifact-preview-close';
  closeBtn.setAttribute('aria-label', '关闭预览');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const content = document.createElement('div');
  content.className = 'artifact-preview-content';
  const pre = document.createElement('pre');
  pre.className = `artifact-preview-code language-${artifact.language || 'text'}`;
  pre.textContent = artifact.source;
  content.appendChild(pre);

  panel.append(header, content);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function openTableArtifactPreview(artifact: Record<string, any>) {
  document.querySelector('.artifact-preview-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'artifact-preview-overlay';

  const panel = document.createElement('div');
  panel.className = 'artifact-preview-panel';

  const header = document.createElement('div');
  header.className = 'artifact-preview-header';
  const title = document.createElement('h3');
  title.textContent = artifact.title || '表格';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'artifact-preview-close';
  closeBtn.setAttribute('aria-label', '关闭预览');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const content = document.createElement('div');
  content.className = 'artifact-preview-content';
  const pre = document.createElement('pre');
  pre.className = 'artifact-preview-code';
  pre.textContent = artifact.source;
  content.appendChild(pre);

  panel.append(header, content);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    overlay.remove();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') cleanup();
  };
  closeBtn.addEventListener('click', cleanup, { once: true });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.addEventListener('keydown', onKeyDown);
}

function downloadArtifact(artifact: Record<string, any>, index: number) {
  let blob;
  let mimeType = 'text/plain;charset=utf-8';
  switch (artifact.type) {
    case 'html-preview': {
      const html = createSandboxedHtmlDocument(artifact.source, { title: artifact.title });
      blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      mimeType = 'text/html;charset=utf-8';
      break;
    }
    case 'json-data': {
      blob = new Blob([artifact.source], { type: 'application/json;charset=utf-8' });
      mimeType = 'application/json;charset=utf-8';
      break;
    }
    default: {
      blob = new Blob([artifact.source], { type: 'text/plain;charset=utf-8' });
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = buildArtifactDownloadName(artifact as any, index);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // URL revocation delay, not a shared constant
}

export function renderAssistantEvidence(container: HTMLElement, message: any) {
  if (!container) return;
  container
    .querySelectorAll('.source-grounding-warning, .source-grounding-card, .tool-evidence-panel')
    .forEach((item: Record<string, any>) => item.remove());
  const grounding = getSearchGrounding(message, message?.content || '');
  const localGrounding = getLocalFileGrounding(message, message?.content || '');
  appendToolEvidencePanel(container, message, grounding, localGrounding);
  if (grounding.hasSearch) {
    appendGroundingCard(container, {
      warning: grounding.warning,
      title: grounding.warning ? '联网结果未被明确引用' : '已引用联网来源',
      meta: [grounding.queries[0] ? `query: ${grounding.queries[0]}` : '', `${grounding.sources.length} 个来源`]
        .filter(Boolean)
        .join(' · '),
      items: grounding.sources.slice(0, 3).map((source: Record<string, any>) => ({
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
      items: localGrounding.citations.slice(0, 4).map((citation: Record<string, any>) => ({
        label: citation.label,
        href: '',
      })),
      warningText: '本轮读取或搜索了本地工作区文件，但最终回答没有引用文件名或 file:line 证据，请谨慎核验。',
    });
  }
}

function appendToolEvidencePanel(
  container: HTMLElement,
  message: Record<string, any> = {},
  grounding: Record<string, any> = {},
  localGrounding: Record<string, any> = {}
) {
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
    grid.appendChild(createToolEvidenceRunCard(run, message.content || ''));
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

function buildToolEvidenceMeta(
  runs: any[] = [],
  grounding: Record<string, any> = {},
  localGrounding: Record<string, any> = {},
  message: Record<string, any> = {}
) {
  const parts = [];
  if (runs.length) parts.push(`${runs.length} 个工具`);
  if (grounding.sources?.length) parts.push(`${grounding.sources.length} 个来源`);
  if (localGrounding.citations?.length) parts.push(`${localGrounding.citations.length} 个文件引用`);
  const usage = message.tokens ? normalizeTokenUsage(message.tokens) : null;
  if ((usage?.cacheHit || 0) > 0 || (usage?.cacheMiss || 0) > 0) {
    parts.push(`cache ${Math.round((usage?.cacheHitRate || 0) * 100)}%`);
  } else if (message.cacheProfile?.cacheHitRate !== undefined) {
    parts.push(`cache ${Math.round(Number(message.cacheProfile.cacheHitRate || 0) * 100)}%`);
  }
  return parts.length ? parts.join(' · ') : '无工具调用';
}

function createToolEvidenceRunCard(run: Record<string, any> = {}, answerContent = '') {
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
  ]
    .filter(Boolean)
    .join(' · ');
  if (meta.textContent) card.appendChild(meta);

  const citationStatus = buildToolCitationStatus(run, answerContent);
  if (citationStatus) appendToolCitationStatus(card, citationStatus);

  appendEvidenceChips(
    card,
    '来源',
    (run.sources || []).slice(0, 3).map((source: Record<string, any>) => source.title || source.url)
  );
  appendEvidenceChips(
    card,
    '文件',
    (run.localCitations || []).slice(0, 6).map((citation: Record<string, any>) => citation.label)
  );
  if (Array.isArray(run.workspaceResults) && run.workspaceResults.length) {
    appendEvidenceChips(
      card,
      '搜索命中',
      run.workspaceResults.slice(0, 4).map((item) => `${item.file}:${item.startLine}-${item.endLine}`)
    );
  }
  if (run.workspaceSymbol?.result) {
    appendEvidenceChips(card, '符号', [
      `${run.workspaceSymbol.symbol} ${run.workspaceSymbol.result.file}:${run.workspaceSymbol.result.startLine}-${run.workspaceSymbol.result.endLine}`,
    ]);
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

function appendEvidenceChips(card: HTMLElement, labelText: string, values: any[] = []) {
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

function appendEvidencePreview(card: HTMLElement, text: string) {
  const preview = document.createElement('p');
  preview.className = 'tool-evidence-preview';
  preview.textContent = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  card.appendChild(preview);
}

function appendToolCitationStatus(card: HTMLElement, status: Record<string, any>) {
  const box = document.createElement('div');
  box.className = `tool-evidence-citation-status ${status.state}`;
  box.textContent = `${status.label} · ${status.cited}/${status.total} 条证据`;
  box.title = '根据最终回答文本中是否出现 URL、文件名或 file:line 判断。';
  card.appendChild(box);
  appendEvidenceRefBreakdown(card, status.refs);
}

function appendEvidenceRefBreakdown(card: HTMLElement, refs: any[] = []) {
  const visible = (Array.isArray(refs) ? refs : []).slice(0, 6);
  if (!visible.length) return;
  const group = document.createElement('div');
  group.className = 'tool-evidence-ref-list';
  const label = document.createElement('span');
  label.className = 'tool-evidence-chip-label';
  label.textContent = '引用明细';
  group.appendChild(label);
  for (const ref of visible) {
    const item = document.createElement('span');
    item.className = `tool-evidence-ref ${ref.cited ? 'is-cited' : 'is-missing'}`;
    item.textContent = `${ref.cited ? '已引用' : '未引用'}: ${ref.label || ref.value || ref.file || ref.type}`;
    item.title = ref.value || ref.file || ref.label || '';
    group.appendChild(item);
  }
  card.appendChild(group);
}

function createCacheEvidenceCard(message: Record<string, any> = {}) {
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
  if (Number(usage?.cost?.estimatedSavingsUsd || 0) > 0 || Number(profile.estimatedSavingsUsd || 0) > 0) {
    appendEvidenceChips(card, '成本', [
      `节省约 $${Number(usage?.cost?.estimatedSavingsUsd || profile.estimatedSavingsUsd || 0).toFixed(6)}`,
    ]);
  }
  return card;
}

function buildMessageEvidencePayload(message: Record<string, any> = {}) {
  const content = message.content || '';
  return {
    type: 'deepchat.messageEvidence',
    version: 1,
    toolRuns: (message.toolRuns || []).map((run: Record<string, any>) => ({
      ...buildToolEvidencePayload(run),
      citationStatus: buildToolCitationStatus(run, content),
    })),
    tokens: message.tokens ? normalizeTokenUsage(message.tokens) : null,
    cacheProfile: message.cacheProfile || null,
    contextBudget: message.contextBudget || null,
  };
}

function buildToolCitationStatus(run: Record<string, any> = {}, answerContent = '') {
  const refs = collectToolEvidenceRefs(run);
  if (!refs.length) return null;
  const content = String(answerContent || '');
  const checkedRefs = refs.map((ref) => ({
    ...ref,
    cited: isEvidenceRefMentioned(content, ref),
  }));
  const cited = checkedRefs.filter((ref) => ref.cited).length;
  const state = cited === checkedRefs.length ? 'is-cited' : cited > 0 ? 'is-partial' : 'is-missing';
  return {
    state,
    label: state === 'is-cited' ? '已被回答引用' : state === 'is-partial' ? '部分证据已引用' : '未被回答引用',
    cited,
    total: checkedRefs.length,
    refs: checkedRefs.slice(0, 8),
  };
}

function collectToolEvidenceRefs(run: Record<string, any> = {}) {
  const refs = [];
  for (const source of Array.isArray(run.sources) ? run.sources : []) {
    const url = String(source?.url || '').trim();
    if (url) refs.push({ type: 'url', label: source.title || url, value: url });
  }
  for (const citation of Array.isArray(run.localCitations) ? run.localCitations : []) {
    const file = String(citation?.file || '').trim();
    const label = String(citation?.label || '').trim();
    if (file || label)
      refs.push({
        type: 'file',
        label: label || file,
        value: label || file,
        file,
        lineStart: Number(citation?.lineStart || 0),
        lineEnd: Number(citation?.lineEnd || citation?.lineStart || 0),
      });
  }
  if (run.workspaceSymbol?.result) {
    const result = run.workspaceSymbol.result;
    const file = String(result.file || '').trim();
    if (file) {
      const range = result.startLine
        ? `${result.startLine}${result.endLine && result.endLine !== result.startLine ? `-${result.endLine}` : ''}`
        : '';
      refs.push({
        type: 'file',
        label: `${run.workspaceSymbol.symbol || 'symbol'} ${file}${range ? `:${range}` : ''}`,
        value: `${file}${range ? `:${range}` : ''}`,
        file,
        lineStart: Number(result.startLine || 0),
        lineEnd: Number(result.endLine || result.startLine || 0),
      });
    }
  }
  return dedupeEvidenceRefs(refs);
}

function dedupeEvidenceRefs(refs: any[] = []) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.value || ref.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isEvidenceRefMentioned(content = '', ref: Record<string, any> = {}) {
  const text = String(content || '');
  if (!text) return false;
  if (ref.type === 'url') return Boolean(ref.value && text.includes(ref.value));
  const file = String(ref.file || ref.value || '').trim();
  const label = String(ref.value || ref.label || '').trim();
  if (label && text.includes(label)) return true;
  if (file && text.includes(file)) return true;
  if (file && ref.lineStart > 0) {
    const escapedFile = escapeRegExp(file);
    const start = Number(ref.lineStart || 0);
    const end = Number(ref.lineEnd || start);
    const rangePattern = end && end !== start ? `${start}\\s*-\\s*${end}` : String(start);
    return new RegExp(`${escapedFile}\\s*[:：]\\s*${rangePattern}`).test(text);
  }
  return false;
}

function appendGroundingCard(
  container: HTMLElement,
  { warning, title: titleText, meta: metaText, items = [], warningText }: Record<string, any>
) {
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

function renderStoppedNotice(container: HTMLElement, msgIndex: number) {
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

function renderErrorContent(container: HTMLElement, message: string, onClose?: any, onRetry?: any) {
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

function addUserMessageActions(msgEl: HTMLElement, msg: Record<string, any>, msgIndex: number) {
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
        if (copyBtn.isConnected) copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`;
      }, COPY_FEEDBACK_MS);
    }
  });
  actions.appendChild(copyBtn);

  // Edit user message
  const editBtn = document.createElement('button');
  editBtn.className = 'msg-action-btn';
  editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> 编辑`;
  editBtn.addEventListener('click', () => {
    const contentEl = msgEl.querySelector('.message-content') as HTMLElement | null;
    if (!contentEl) return;
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
    const conv = conversations.find((c) => c.id === activeConvId);
    if (!conv) return;
    conv.messages = conv.messages.slice(0, msgIndex);
    persist();
    renderMessages();
  });
  actions.appendChild(delBtn);

  msgEl.querySelector('.message-body')?.appendChild(actions);
}

// ─── Assistant Message Actions ───

function addMessageActions(msgEl: HTMLElement, content: string, tokens: any, speed: number, msgIndex: number) {
  const existing = msgEl.querySelector('.message-actions');
  if (existing) existing.remove();

  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const conv = conversations.find((c) => c.id === activeConvId);
  const msg = conv?.messages[msgIndex];

  // Copy
  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn';
  copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`;
  copyBtn.addEventListener('click', async () => {
    const plainText = (msgEl.querySelector('.message-content') as HTMLElement | null)?.innerText || content;
    const ok = await copyToClipboard(plainText);
    if (ok) {
      showToast('已复制到剪贴板');
      copyBtn.classList.add('copied');
      copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 已复制`;
      setTimeout(() => {
        if (copyBtn.isConnected) {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`;
        }
      }, COPY_FEEDBACK_MS);
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
        if (copyMdBtn.isConnected) copyMdBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> 复制MD`;
      }, COPY_FEEDBACK_MS);
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
    const groups = buildAnswerActionMenuGroups();
    actions.appendChild(
      createAnswerActionButton('更短', '生成一个更短版本', () => {
        sendAnswerAction('shorter', content, msg);
      })
    );
    actions.appendChild(
      createAnswerActionButton('详细', '生成一个更详细版本', () => {
        sendAnswerAction('deeper', content, msg);
      })
    );
    actions.appendChild(
      createAnswerActionMenu(
        '改写',
        '把回答转成表格、精排、代码、TODO 或报告',
        groups.rewrite.map((item) => ({
          ...item,
          onClick: () => sendAnswerAction(item.action, content, msg),
        }))
      )
    );
    actions.appendChild(
      createAnswerActionMenu(
        '导出',
        '导出当前回答',
        groups.export.map((item) => ({
          ...item,
          onClick: () => {
            if (item.action === 'markdown') exportAssistantMarkdown(content, msgIndex);
            if (item.action === 'html') exportAssistantHtml(msgEl, content, msgIndex);
            if (item.action === 'artifact') exportAssistantArtifact(content, msgIndex);
          },
        }))
      )
    );
  }

  const favoriteBtn = document.createElement('button');
  favoriteBtn.className = `msg-action-btn${msg?.favorite ? ' is-favorite' : ''}`;
  favoriteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="${msg?.favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15 8.5 22 9.3 16.8 14 18.2 21 12 17.4 5.8 21 7.2 14 2 9.3 9 8.5 12 2"/></svg> 收藏`;
  favoriteBtn.addEventListener('click', () => toggleMessageFavorite(msgIndex));
  actions.appendChild(favoriteBtn);

  // Version switcher (if message has version history)
  if (msg && msg.versions && msg.versions.length > 0) {
    const totalVersions = msg.versions.length + 1;
    const currentIdx = msg._versionIdx ?? totalVersions - 1;

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
      const prefix = usage.source === 'provider' ? '实测' : usage.source === 'mixed' ? '混合' : '估算';
      parts.push(`${prefix} ${usage.total} tokens`);
      if (usage.cacheHit > 0) parts.push(`命中 ${Math.round(usage.cacheHitRate * 100)}%`);
      if (Number(usage.cost?.estimatedCostUsd || 0) > 0)
        parts.push(`$${Number(usage.cost?.estimatedCostUsd || 0).toFixed(6)}`);
      if ((usage.rounds || 0) > 1) parts.push(`${usage.rounds} 轮`);
    }
    if (speed) parts.push(`${speed} tok/s`);
    badge.textContent = parts.join(' · ');
    if (tokens) badge.title = formatTokenUsageTitle(tokens);
    actions.appendChild(badge);
  }

  msgEl.querySelector('.message-body')?.appendChild(actions);
}

function createAnswerActionButton(label: string, title: any, onClick: () => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'msg-action-btn answer-action-btn';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function createAnswerActionMenu(label: string, title: any, items: any[] = []) {
  const details = document.createElement('details');
  details.className = 'answer-action-menu';
  details.title = title;

  const summary = document.createElement('summary');
  summary.className = 'msg-action-btn answer-action-menu-trigger';
  summary.textContent = label;
  details.appendChild(summary);

  const menu = document.createElement('div');
  menu.className = 'answer-action-menu-list';
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'answer-action-menu-item';
    button.textContent = item.label;
    button.title = item.title || item.label;
    button.addEventListener('click', () => {
      details.removeAttribute('open');
      item.onClick?.();
    });
    menu.appendChild(button);
  }
  details.appendChild(menu);
  return details;
}

function sendAnswerAction(action: string, content: string, message: any) {
  const prompt = buildAnswerActionPrompt(action, content, message);
  if (!prompt) return;
  sendMessage(prompt, { composerOverrides: { enhance: false } });
}

function exportAssistantMarkdown(content: string, msgIndex: number) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `deepchat-answer-${msgIndex + 1}-${stamp}.md`;
  downloadTextFile(content || '', fileName, 'text/markdown;charset=utf-8');
  showToast('已导出当前回答 Markdown');
}

function exportAssistantHtml(msgEl: HTMLElement, content: string, msgIndex: number) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const contentEl = msgEl?.querySelector?.('.message-content');
  const bodyHtml = contentEl?.innerHTML || escapeHtml(content || '').replace(/\n/g, '<br>');
  const fileName = `deepchat-answer-${msgIndex + 1}-${stamp}.html`;
  const html = buildAssistantHtmlExport(bodyHtml, {
    title: `DeepChat 回答 #${msgIndex + 1}`,
    generatedAt: new Date().toISOString(),
  });
  downloadTextFile(html, fileName, 'text/html;charset=utf-8');
  showToast('已导出当前回答 HTML');
}

function exportAssistantArtifact(content: string, msgIndex: number) {
  const artifacts = extractArtifacts(content || '');
  if (artifacts.length > 0) {
    for (const [index, artifact] of artifacts.entries()) {
      const fileName = buildArtifactDownloadName(artifact, index);
      downloadTextFile(artifact.source || '', fileName, 'text/plain;charset=utf-8');
    }
    showToast(`已下载 ${artifacts.length} 个 Artifact`);
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `deepchat-artifact-${msgIndex + 1}-${stamp}.md`;
    downloadTextFile(content || '', fileName, 'text/markdown;charset=utf-8');
    showToast('已保存当前回答为 Artifact');
  }
}

export function renderConversationUsageTelemetryPanel(container: HTMLElement, conversation: Record<string, any>) {
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
  const usageMetrics: [string, string | number][] = [
    ['输入', details.usage.input],
    ['输出', details.usage.output],
    ['思考', details.usage.reasoning],
    ['总计', details.usage.total],
    ['Cache hit', details.usage.cacheHit],
    ['Cache miss', details.usage.cacheMiss],
    ['命中率', details.hitRateLabel],
    ['Agent 轮次', details.usage.rounds || 1],
  ];
  usageMetrics.forEach(([label, value]) => metrics.appendChild(createUsageMetric(label, String(value))));

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

export function renderLatestEvidenceDrawer(container: HTMLElement, conversation: Record<string, any>) {
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
  ]
    .filter(Boolean)
    .join(' · ');
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
    grid.appendChild(createToolEvidenceRunCard(run, message.content || ''));
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

function switchVersion(msgIndex: number, direction: number) {
  const conv = getActiveConversation();
  if (!conv) return;
  const msg = conv.messages[msgIndex];
  if (!msg || !msg.versions || msg.versions.length === 0) return;

  const totalVersions = msg.versions.length + 1;
  let currentIdx = Number(msg._versionIdx ?? totalVersions - 1);
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

async function continueFromResponseAt(msgIndex: number) {
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
  await streamOrchestrator.doStream(conv);
}

function toggleMessageFavorite(msgIndex: number) {
  const conv = getActiveConversation();
  if (!conv?.messages?.[msgIndex]) return;
  conv.messages[msgIndex].favorite = !conv.messages[msgIndex].favorite;
  persist();
  renderMessages();
  showToast(conv.messages[msgIndex].favorite ? '已收藏回答' : '已取消收藏');
}

function attachCopyHandlersOnly(container: HTMLElement) {
  // Delegate to shared handler from renderer
  container.querySelectorAll('.code-copy-btn:not([data-bound])').forEach((btn) => {
    const el = btn as HTMLElement;
    el.setAttribute('data-bound', '1');
    el.addEventListener('click', async () => {
      const code = decodeURIComponent(el.dataset.code || '');
      try {
        await navigator.clipboard.writeText(code);
        (el.querySelector('.copy-icon') as HTMLElement | null)!.hidden = true;
        (el.querySelector('.check-icon') as HTMLElement | null)!.hidden = false;
        (el.querySelector('.copy-text') as HTMLElement | null)!.textContent = '已复制';
        el.classList.add('copied');
        setTimeout(() => {
          if (el.isConnected) {
            (el.querySelector('.copy-icon') as HTMLElement | null)!.hidden = false;
            (el.querySelector('.check-icon') as HTMLElement | null)!.hidden = true;
            (el.querySelector('.copy-text') as HTMLElement | null)!.textContent = '复制';
            el.classList.remove('copied');
          }
        }, COPY_FEEDBACK_MS);
      } catch (err) {
        console.warn('[Chat] clipboard write failed:', err);
      }
    });
  });

  // Run JS code blocks
  container.querySelectorAll('.code-run-btn:not([data-bound])').forEach((btn) => {
    const el = btn as HTMLElement;
    el.setAttribute('data-bound', '1');
    el.addEventListener('click', () => {
      const code = decodeURIComponent(el.dataset.code || '');
      document.dispatchEvent(
        new CustomEvent('deepchat:run-code-block', {
          detail: { button: el, code, language: el.dataset.language || 'javascript' },
        })
      );
    });
  });
}

async function handleRunCodeBlock(detail: Record<string, any> = {}) {
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
  approve.addEventListener(
    'click',
    async () => {
      approve.disabled = true;
      cancel.disabled = true;
      button.disabled = true;
      button.textContent = '运行中...';
      const msgEl = wrapper.closest('.message.assistant');
      const msgIndex = Number.parseInt(msgEl?.dataset.messageIndex || '-1', 10);
      const conv = getActiveConversation();
      const msg = Number.isInteger(msgIndex) && msgIndex >= 0 ? conv?.messages?.[msgIndex] : null;
      const tool = msg
        ? {
            id: `manual_run_${uid()}`,
            name: 'run_code',
            args: { language, code },
            risk: '用户从代码块手动确认运行代码片段。',
            status: 'approved',
            requestedAt: new Date().toISOString(),
          }
        : null;
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
        renderCodeOutput(wrapper, output as string, true);
      } catch (error) {
        if (tool) {
          applyToolResult(msg.toolCalls, {
            toolCallId: tool.id,
            name: 'run_code',
            args: { language, code },
            ok: false,
            output: (error as Error).message || String(error),
          });
          syncToolRuns(msg);
          renderToolCalls(msgEl.querySelector('.tool-calls-container') as HTMLElement, msg.toolCalls);
          persist();
        }
        renderCodeOutput(wrapper, (error as Error).message || String(error), false);
      } finally {
        button.disabled = false;
        button.textContent = '▶ 运行';
      }
    },
    { once: true }
  );
}

function renderCodeOutput(wrapper: HTMLElement, output: string, ok: boolean) {
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

// ─── Sidebar functions extracted to chat-sidebar.js ───

function updateHeader() {
  const conv = getActiveConversation();
  const settings = getSettings();
  $chatTitle!.textContent = conv ? conv.title : '新的对话';
  $modelName!.textContent = settings.model as string;
  $modelName!.title = settings.model as string;
  updateHeaderUsageBadge(conv);
  updateEvidenceButton(conv);
}

export function updateModelDisplay(model: string) {
  $modelName!.textContent = model;
}

function updateHeaderUsageBadge(conversation: Record<string, any>) {
  if (!$chatUsageBadge) return;
  const telemetry = formatConversationUsageTelemetry(conversation);
  if (!telemetry) {
    $chatUsageBadge!.classList.add('hidden');
    $chatUsageBadge!.textContent = '';
    $chatUsageBadge!.title = '';
    $chatUsageBadge!.removeAttribute('role');
    $chatUsageBadge!.removeAttribute('tabindex');
    closeUsageTelemetryPanel();
    return;
  }
  $chatUsageBadge!.classList.remove('hidden');
  $chatUsageBadge!.textContent = telemetry.text;
  $chatUsageBadge!.title = telemetry.title;
  $chatUsageBadge!.setAttribute('role', 'button');
  $chatUsageBadge!.setAttribute('tabindex', '0');
  $chatUsageBadge!.setAttribute('aria-label', '查看会话 Token 与缓存详情');
  $chatUsageBadge!.dataset.hitRate = telemetry.hitRate === null ? '' : String(telemetry.hitRate);
  if (usageTelemetryPanelEl) renderConversationUsageTelemetryPanel(usageTelemetryPanelEl, conversation);
}

function bindUsageTelemetryPanel() {
  if (!$chatUsageBadge || $chatUsageBadge!.dataset.panelBound === 'true') return;
  $chatUsageBadge!.dataset.panelBound = 'true';
  $chatUsageBadge!.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleUsageTelemetryPanel();
  });
  $chatUsageBadge!.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleUsageTelemetryPanel();
  });
  document.addEventListener('click', (event) => {
    if (!usageTelemetryPanelEl) return;
    if (usageTelemetryPanelEl.contains(event.target as Node) || $chatUsageBadge!.contains(event.target as Node)) return;
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
  const rect = $chatUsageBadge!.getBoundingClientRect();
  const margin = 12;
  const right = Math.max(margin, window.innerWidth - rect.right);
  const top = Math.min(window.innerHeight - margin, rect.bottom + 8);
  usageTelemetryPanelEl.style.top = `${top}px`;
  usageTelemetryPanelEl.style.right = `${right}px`;
}

function bindEvidenceDrawer() {
  if (!$evidencePanelBtn || $evidencePanelBtn!.dataset.drawerBound === 'true') return;
  $evidencePanelBtn!.dataset.drawerBound = 'true';
  $evidencePanelBtn!.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleEvidenceDrawer();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEvidenceDrawer();
  });
}

function updateEvidenceButton(conversation: Record<string, any>) {
  if (!$evidencePanelBtn) return;
  const evidence = getLatestEvidenceMessage(conversation);
  if (!evidence) {
    $evidencePanelBtn!.classList.add('hidden');
    $evidencePanelBtn!.title = '暂无工具证据';
    closeEvidenceDrawer();
    return;
  }
  const runCount = Array.isArray(evidence.message.toolRuns) ? evidence.message.toolRuns.length : 0;
  $evidencePanelBtn!.classList.remove('hidden');
  $evidencePanelBtn!.title = runCount ? `查看最近工具证据：${runCount} 个工具` : '查看最近 Token / Cache 证据';
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

function getLatestEvidenceMessage(conversation: Record<string, any>) {
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

function formatAgentStageBrief(stage: Record<string, any> = {}) {
  const round = stage.round !== undefined ? `R${stage.round} ` : '';
  const name = stage.stage || 'stage';
  const detail = [stage.toolName, stage.intent?.toolMode, stage.warning, stage.stopReason].filter(Boolean).join(' · ');
  return `${round}${name}${detail ? `：${detail}` : ''}`;
}

function toggleStreamingUI(streaming: boolean) {
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const input = document.getElementById('message-input') as HTMLInputElement;

  if (!sendBtn || !stopBtn) return;

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
