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

import {
  approveToolRequest,
  streamChat,
  runTool,
  getActiveRequestId,
  pauseAgent,
  resumeAgent,
  skipToolAgent,
  limitScopeAgent,
} from './api.js';
import { extractContextMentions, renderContextMentionStrip } from './context-mentions.ts';
import { getSettings } from './settings-core.js';
import { normalizeTokenUsage, getConversationUsageSummary } from './token-budget.js';
import { loadConversations, saveConversations } from './client-store.ts';
import { loadMessages, saveMessages } from './conversation-db.js';
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
  trimMessagesForRegeneration,
} from './conversation-utils.js';
import { exportConversation } from './exporters.js';
import { enhancePrompt, isEnhanceEnabled } from './settings.js';
import { renderMarkdown, postProcess, safeSetHTML } from './renderer.js';
import { refreshReadingNavigator, resetReadingNavigator } from './reading-navigator.js';
import { confirmAction, promptText } from './dialogs.ts';
import { buildArtifactDownloadName, extractArtifacts } from './artifacts.js';
import {
  applyToolResult,
  applyToolDecision,
  createToolRecord,
  buildToolRuns,
  hasSearchWithoutCitedSource as hasUncitedSearchSource,
  hasLocalFilesWithoutCitedSource as hasUncitedLocalSource,
} from './tool-runs.js';
import {
  uid,
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
import {
  renderAssistantArtifacts,
  renderAssistantAnswerHeader,
  renderAssistantEvidence,
  renderAssistantToc,
  buildMessageEvidencePayload,
  createCacheEvidenceCard,
  createToolEvidenceRunCard,
  renderErrorContent,
} from './chat-assistant-ui.ts';
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

function getInterfaceDetailLevel() {
  const level = String(getSettings().interfaceDetailLevel || 'normal');
  return ['normal', 'advanced', 'developer'].includes(level) ? level : 'normal';
}

function shouldShowInlineDebugPanels() {
  return getInterfaceDetailLevel() !== 'normal';
}

function shouldShowDeveloperDetails() {
  return getInterfaceDetailLevel() === 'developer';
}

function getToolRenderOptions(extra: Record<string, any> = {}) {
  return { ...extra, detailLevel: getInterfaceDetailLevel() };
}
import { renderStreamingMarkdown } from './streaming-renderer.js';
import { TraceRecorder, migrateLegacyAgentRun } from './agent-trace.js';
import { openTraceInspector } from './agent-trace-inspector.js';
import { openInspectorPanel, setInspectorToggleBadge } from './inspector-panel.js';
import { openArtifactPanel } from './artifact-panel.js';
import { saveTrace, isTraceRecordingEnabled } from './agent-trace-store.js';
import { COPY_FEEDBACK_MS, OUTLINE_HIGHLIGHT_MS } from './constants.js';
import { createVirtualList } from './virtual-message-list.js';
import { formatBytes } from './shared-utils.js';
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
  formatCacheStabilityReason,
  formatCompactTokenCount,
  formatUsd,
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
let isAgentPaused: boolean = false;
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
      if (v) isAgentPaused = false;
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
    renderToolCalls: (container: HTMLElement | null, toolCalls: any[] = [], options: Record<string, any> = {}) =>
      renderToolCalls(container as HTMLElement, toolCalls, getToolRenderOptions(options)),
    renderEvidencePanel: (container: HTMLElement | null, toolCalls: any[] = []) => {
      if (!shouldShowInlineDebugPanels()) {
        if (container) {
          container.textContent = '';
          container.hidden = true;
        }
        return;
      }
      renderEvidencePanel(container, toolCalls);
    },
    renderAgentTimeline: (container: HTMLElement | null, message: Record<string, any> = {}) => {
      if (!shouldShowDeveloperDetails()) {
        if (container) {
          container.textContent = '';
          container.hidden = true;
        }
        return;
      }
      renderAgentTimeline(container as HTMLElement, message);
    },
    renderCrewOrTheatre,
    addMessageActions,
    renderStoppedNotice,
    renderAssistantAnswerHeader,
    renderAssistantArtifacts,
    renderAssistantEvidence: (container: HTMLElement | null, message: any) =>
      renderAssistantEvidence(container as HTMLElement, message, {
        showToolEvidencePanel: shouldShowInlineDebugPanels(),
      }),
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
    await switchConversation(conversations[0].id);
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

  bindAgentControlEvents();

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

  // Open Inspector artifact mode when artifact card requests it
  const artifactInspectorHandler = (e: Event) => {
    const detail = (e as CustomEvent).detail || {};
    const msgIndex = Number(detail.msgIndex ?? -1);
    const conv = getActiveConversation();
    if (!conv || msgIndex < 0 || msgIndex >= conv.messages.length) return;
    const msg = conv.messages[msgIndex];
    if (!msg) return;
    openInspectorPanel('artifact', { msg, messages: conv.messages, index: msgIndex });
    // Also open the artifact workspace panel
    openArtifactPanel(msgIndex, msg);
  };
  document.addEventListener('deepchat:open-artifact-inspector', artifactInspectorHandler);
  _chatCleanupFns.push(() =>
    document.removeEventListener('deepchat:open-artifact-inspector', artifactInspectorHandler)
  );

  // Open Inspector in any mode directly
  const openInspectorHandler = (e: Event) => {
    const detail = (e as CustomEvent).detail || {};
    const mode = detail.mode || 'message';
    const msgIndex = Number(detail.msgIndex ?? -1);
    const conv = getActiveConversation();
    if (!conv || msgIndex < 0 || msgIndex >= conv.messages.length) return;
    const msg = conv.messages[msgIndex];
    if (!msg) return;
    openInspectorPanel(mode, { msg, messages: conv.messages, index: msgIndex });
  };
  document.addEventListener('deepchat:open-inspector', openInspectorHandler);
  _chatCleanupFns.push(() => document.removeEventListener('deepchat:open-inspector', openInspectorHandler));
}

function bindAgentControlEvents() {
  const agentPauseHandler = () => {
    if (!isStreaming) return;
    const requestId = getActiveRequestId();
    if (!requestId) return;
    const btn = document.querySelector('.theatre-control-pause');
    if (isAgentPaused) {
      resumeAgent(requestId);
      isAgentPaused = false;
      showToast('Agent 已继续运行');
      if (btn) btn.textContent = '暂停';
    } else {
      pauseAgent(requestId);
      isAgentPaused = true;
      showToast('Agent 已暂停');
      if (btn) btn.textContent = '继续';
    }
  };
  const agentStopHandler = () => {
    if (!isStreaming) return;
    showToast('Agent 已停止');
    stopStreaming();
  };
  const agentSkipToolHandler = (event: Event) => {
    if (!isStreaming) return;
    const requestId = getActiveRequestId();
    if (!requestId) return;
    const detail = (event as CustomEvent).detail || {};
    skipToolAgent(requestId, detail.toolCallId || 'current');
    showToast('已跳过当前工具');
  };
  document.addEventListener('deepchat:agent-pause', agentPauseHandler);
  document.addEventListener('deepchat:agent-stop', agentStopHandler);
  document.addEventListener('deepchat:agent-skip-tool', agentSkipToolHandler as EventListener);
  _chatCleanupFns.push(() => {
    document.removeEventListener('deepchat:agent-pause', agentPauseHandler);
    document.removeEventListener('deepchat:agent-stop', agentStopHandler);
    document.removeEventListener('deepchat:agent-skip-tool', agentSkipToolHandler as EventListener);
  });
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
    await switchConversation(stillExists ? activeConvId : conversations[0].id);
  } else {
    activeConvId = null;
    sidebar.renderConversationList();
    showWelcome();
    updateHeader();
  }
}

async function persist(): Promise<void> {
  try {
    await saveConversations(conversations);
  } catch {
    showToast('保存对话失败');
  }
}

function smartScroll(smooth = true) {
  if (!userScrolledUp) {
    scrollToBottom($messages!, smooth);
  }
}

// ─── Conversation Management ───

export async function createConversation() {
  const conv = normalizeConversation({ id: uid(), title: '新的对话', messages: [], createdAt: Date.now() });
  conversations.unshift(conv);
  sidebarFilter = SIDEBAR_FILTERS.active;
  bulkMode = false;
  selectedConversationIds.clear();
  persist();
  sidebar.renderConversationList();
  await switchConversation(conv.id);
  return conv;
}

async function switchConversation(id: string) {
  if (isStreaming) stopStreaming();

  // Persist and unload messages for the outgoing conversation
  const outgoingId = activeConvId;
  if (outgoingId && outgoingId !== id) {
    const outgoingConv = conversations.find((c) => c.id === outgoingId);
    if (outgoingConv && outgoingConv.messages && outgoingConv.messages.length > 0) {
      await saveMessages(outgoingId, outgoingConv.messages);
      outgoingConv.messages = [];
    }
  }

  activeConvId = id;
  userScrolledUp = false;
  resetReadingNavigator();

  // Load messages for the incoming conversation if not already in memory
  const incomingConv = conversations.find((c) => c.id === id);
  if (incomingConv && (!incomingConv.messages || incomingConv.messages.length === 0)) {
    const loaded = await loadMessages(id);
    incomingConv.messages = loaded;
  }

  sidebar.renderConversationList();
  renderMessages();
  updateHeader();
  refreshReadingNavigator();
  if (incomingConv) {
    window.dispatchEvent(
      new CustomEvent('deepchat:conversation-switched', {
        detail: { conversationId: id, composerModeId: incomingConv.composerModeId || '' },
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
      await switchConversation(conversations[0].id);
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
  if (!conv) conv = await createConversation();

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
  contentEl.textContent = '';
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
    safeSetHTML(contentEl, getCachedRenderedMarkdown(msg.content));
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
        safeSetHTML(contentEl, getCachedRenderedMarkdown(msg.content));
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
      safeSetHTML(contentEl, getCachedRenderedMarkdown(msg.content));
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

    if (msg.thinking && shouldShowDeveloperDetails()) {
      const thinkingBlock = el.querySelector('.thinking-block') as HTMLElement | null;
      const thinkingContentEl = el.querySelector('.thinking-content') as HTMLElement | null;
      if (thinkingBlock && thinkingContentEl) {
        thinkingBlock.hidden = false;
        thinkingContentEl.textContent = msg.thinking;
      }
    }
    renderToolCalls(
      el.querySelector('.tool-calls-container') as HTMLElement,
      msg.toolCalls || [],
      getToolRenderOptions()
    );
    if (shouldShowInlineDebugPanels()) {
      renderEvidencePanel(el.querySelector('.evidence-panel') as HTMLElement | null, msg.toolCalls || []);
    }
    if (shouldShowDeveloperDetails()) {
      renderAgentTimeline(el.querySelector('.agent-timeline-container') as HTMLElement, msg);
    }

    let agentRun = msg.agentRun;
    if (!agentRun && ((msg.toolCalls && msg.toolCalls.length > 0) || (msg.agentStages && msg.agentStages.length > 0))) {
      agentRun = createAgentRun(msg.composerOverrides?.activeSkill || 'agent_auto');
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

    renderAssistantArtifacts(el.querySelector('.artifact-container') as HTMLElement, msg, idx);
    renderAssistantEvidence(el.querySelector('.message-body') as HTMLElement, msg, {
      showToolEvidencePanel: shouldShowInlineDebugPanels(),
    });
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
      const schedule =
        typeof requestIdleCallback !== 'undefined' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 0);
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

  // Highlight inspector toggle if any message has artifacts
  const hasArtifacts = conv.messages.some(
    (m: any) => m.role === 'assistant' && extractArtifacts(m.content || '').length > 0
  );
  setInspectorToggleBadge(hasArtifacts);
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

export function renderAgentTimeline(container: HTMLElement, message: Record<string, any> = {}) {
  if (!container) return;
  container.textContent = '';
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
    model_upgrade: '模型升级',
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

// ─── User Message Actions (Edit) ───

function addUserMessageActions(msgEl: HTMLElement, msg: Record<string, any>, msgIndex: number) {
  const actions = document.createElement('div');
  actions.className = 'message-actions';

  // Copy user message
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'msg-action-btn';
  copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`; /* safeSetHTML-exempt: static template */
  copyBtn.addEventListener('click', async () => {
    const ok = await copyToClipboard(msg.content);
    if (ok) {
      showToast('已复制到剪贴板');
      copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 已复制`; /* safeSetHTML-exempt: static template */
      setTimeout(() => {
        if (copyBtn.isConnected)
          copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`; /* safeSetHTML-exempt: static template */
      }, COPY_FEEDBACK_MS);
    }
  });
  actions.appendChild(copyBtn);

  // Edit user message
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'msg-action-btn';
  editBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> 编辑`; /* safeSetHTML-exempt: static template */
  editBtn.addEventListener('click', () => {
    const contentEl = msgEl.querySelector('.message-content') as HTMLElement | null;
    if (!contentEl) return;
    const originalText = msg.content;

    contentEl.textContent = '';
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = originalText;
    textarea.rows = Math.min(originalText.split('\n').length + 1, 10);

    const btnGroup = document.createElement('div');
    btnGroup.className = 'edit-btn-group';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'edit-save-btn';
    saveBtn.textContent = '保存并重新生成';
    saveBtn.addEventListener('click', () => {
      const newText = textarea.value.trim();
      if (newText) editMessageAt(msgIndex, newText);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
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
  delBtn.type = 'button';
  delBtn.className = 'msg-action-btn';
  delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 删除`; /* safeSetHTML-exempt: static template */
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

function addMessageActions(msgEl: HTMLElement, content: string, _tokens: any, _speed: number, msgIndex: number) {
  const existing = msgEl.querySelector('.message-actions');
  if (existing) existing.remove();

  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const conv = conversations.find((c) => c.id === activeConvId);
  const msg = conv?.messages[msgIndex];

  // Copy
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'msg-action-btn';
  copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`; /* safeSetHTML-exempt: static template */
  copyBtn.addEventListener('click', async () => {
    const plainText = (msgEl.querySelector('.message-content') as HTMLElement | null)?.innerText || content;
    const ok = await copyToClipboard(plainText);
    if (ok) {
      showToast('已复制到剪贴板');
      copyBtn.classList.add('copied');
      copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> 已复制`; /* safeSetHTML-exempt: static template */
      setTimeout(() => {
        if (copyBtn.isConnected) {
          copyBtn.classList.remove('copied');
          copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制`; /* safeSetHTML-exempt: static template */
        }
      }, COPY_FEEDBACK_MS);
    }
  });
  actions.appendChild(copyBtn);

  // Regenerate
  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'msg-action-btn';
  regenBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> 重新生成`; /* safeSetHTML-exempt: static template */
  regenBtn.addEventListener('click', () => regenerateResponseAt(msgIndex));
  actions.appendChild(regenBtn);

  const detailBtn = document.createElement('button');
  detailBtn.type = 'button';
  detailBtn.className = 'msg-action-btn';
  detailBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg> 详情`; /* safeSetHTML-exempt: static template */
  detailBtn.title = '在 Inspector 查看模型、Token、工具和证据详情';
  detailBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('deepchat:open-inspector', { detail: { mode: 'message', msgIndex } }));
  });
  actions.appendChild(detailBtn);

  const moreItems: any[] = [];
  if (String(content || '').trim()) {
    const groups = buildAnswerActionMenuGroups();
    moreItems.push(
      {
        label: '继续回答',
        title: '让 AI 从这条回答继续补完',
        onClick: () => continueFromResponseAt(msgIndex),
      },
      {
        label: '复制 Markdown',
        title: '复制这条回答的 Markdown 源码',
        onClick: async () => {
          const ok = await copyToClipboard(content);
          if (ok) showToast('已复制 Markdown 源码');
        },
      },
      {
        label: '更短版本',
        title: '生成一个更短版本',
        onClick: () => {
          sendAnswerAction('shorter', content, msg);
        },
      },
      {
        label: '更详细版本',
        title: '生成一个更详细版本',
        onClick: () => {
          sendAnswerAction('deeper', content, msg);
        },
      },
      ...groups.rewrite.map((item) => ({
        ...item,
        label: `改写：${item.label}`,
        onClick: () => sendAnswerAction(item.action, content, msg),
      })),
      ...groups.export.map((item) => ({
        ...item,
        label: `导出：${item.label}`,
        onClick: () => {
          if (item.action === 'markdown') exportAssistantMarkdown(content, msgIndex);
          if (item.action === 'html') exportAssistantHtml(msgEl, content, msgIndex);
          if (item.action === 'artifact') exportAssistantArtifact(content, msgIndex);
        },
      }))
    );
  }

  moreItems.push({
    label: msg?.favorite ? '取消收藏' : '收藏',
    title: msg?.favorite ? '从收藏中移除' : '收藏这条回答',
    onClick: () => toggleMessageFavorite(msgIndex),
  });
  actions.appendChild(createAnswerActionMenu('更多', '更多回答操作', moreItems));

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

  msgEl.querySelector('.message-body')?.appendChild(actions);
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
    ['Agent 轮次', details.usage.rounds || 1],
  ];
  if (details.hasCacheTelemetry) {
    usageMetrics.splice(
      4,
      0,
      ['Cache hit', details.usage.cacheHit],
      ['Cache miss', details.usage.cacheMiss],
      ['命中率', details.hitRateLabel]
    );
  } else {
    usageMetrics.splice(4, 0, ['缓存', details.hitRateLabel]);
  }
  usageMetrics.forEach(([label, value]) => metrics.appendChild(createUsageMetric(label, String(value))));

  const cost = document.createElement('div');
  cost.className = 'usage-panel-section';
  cost.appendChild(createUsageSectionTitle('成本解释'));
  const costRows = [
    [
      '统计依据',
      details.sourceKind === 'provider'
        ? 'provider usage'
        : details.sourceKind === 'mixed'
          ? 'provider usage + 本地估算'
          : '本地估算',
    ],
    ['估算成本', details.usage.cost ? formatUsd(details.usage.cost.estimatedCostUsd || 0) : '无价格表'],
    ['缓存节省', details.usage.cost ? formatUsd(details.usage.cost.estimatedSavingsUsd || 0) : '无价格表'],
    ['输出成本', details.usage.cost ? formatUsd(details.usage.cost.outputCostUsd || 0) : '无价格表'],
  ];
  if (details.hasCacheTelemetry) {
    costRows.splice(
      3,
      0,
      ['命中输入成本', details.usage.cost ? formatUsd(details.usage.cost.inputCacheHitCostUsd || 0) : '无价格表'],
      ['未命中输入成本', details.usage.cost ? formatUsd(details.usage.cost.inputCacheMissCostUsd || 0) : '无价格表']
    );
  } else {
    costRows.push(['缓存说明', 'provider 未返回 cache hit/miss，不展示伪命中率']);
  }
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

export function getInspectorOverviewData() {
  const conversation = getActiveConversation();
  if (!conversation) {
    return {
      conversationTitle: '新的对话',
      messageCount: 0,
      hint: '还没有对话内容。发送一条消息后，Inspector 会展示最近消息、工具证据、Trace 和 Artifact。',
    };
  }
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const latestEvidence = getLatestEvidenceMessage(conversation);
  const latestArtifactIndex = findLatestArtifactMessageIndex(messages);
  const latestTraceIndex = findLatestTraceMessageIndex(messages);
  const latestAssistantIndex = findLatestAssistantMessageIndex(messages);
  const latestMessage = latestEvidence?.message || (latestAssistantIndex >= 0 ? messages[latestAssistantIndex] : null);
  const usage = buildConversationUsageTelemetryDetails(conversation);
  const stages = Array.isArray(latestMessage?.agentStages) ? latestMessage.agentStages : [];
  const lastStage = stages.length ? formatAgentStageBrief(stages[stages.length - 1]) : '';
  return {
    conversationTitle: conversation.title || '当前对话',
    messageCount: messages.length,
    latestMessageIndex: latestEvidence?.index ?? (latestAssistantIndex >= 0 ? latestAssistantIndex : undefined),
    latestTraceIndex: latestTraceIndex >= 0 ? latestTraceIndex : undefined,
    latestArtifactIndex: latestArtifactIndex >= 0 ? latestArtifactIndex : undefined,
    latestToolRunCount: Array.isArray(latestEvidence?.message?.toolRuns) ? latestEvidence.message.toolRuns.length : 0,
    latestArtifactCount:
      latestArtifactIndex >= 0 ? extractArtifacts(messages[latestArtifactIndex]?.content || '').length : 0,
    usageText: usage?.text || '',
    usageTitle: usage?.title || '',
    lastStage,
    latestStopReason: findLatestStopReason(stages),
    hint: '点击上方按钮可切到最近消息、Trace 或 Artifact；没有证据时按钮会禁用。',
  };
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
        renderToolCalls(msgEl.querySelector('.tool-calls-container'), msg.toolCalls, getToolRenderOptions());
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
          renderToolCalls(msgEl.querySelector('.tool-calls-container'), msg.toolCalls, getToolRenderOptions());
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
          renderToolCalls(
            msgEl.querySelector('.tool-calls-container') as HTMLElement,
            msg.toolCalls,
            getToolRenderOptions()
          );
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

function findLatestAssistantMessageIndex(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') return index;
  }
  return -1;
}

function findLatestTraceMessageIndex(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.traceRecorder ||
      message?.agentRun ||
      (Array.isArray(message?.agentStages) && message.agentStages.length)
    ) {
      return index;
    }
  }
  return -1;
}

function findLatestArtifactMessageIndex(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && extractArtifacts(message.content || '').length > 0) return index;
  }
  return -1;
}

function findLatestStopReason(stages: any[]) {
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    if (stages[index]?.stopReason) return stages[index].stopReason;
  }
  return '';
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
