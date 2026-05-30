/**
 * Chat Streaming — Streaming orchestration with dependency injection.
 *
 * Extracted from chat.js. Call `createStreamOrchestrator(deps)` with
 * getters/setters for shared state and function references.
 */

import { renderStreamingMarkdown } from './streaming-renderer.js';
import { renderMarkdown, postProcess, safeSetHTML } from './renderer.js';
import {
  COPY_FEEDBACK_MS,
  OUTLINE_HIGHLIGHT_MS,
  STREAMING_APPEND_THRESHOLD,
  STREAMING_FULL_SYNC_INTERVAL,
} from './constants.js';
import { showToast, scrollToBottom } from './utils.js';
import {
  createAgentRun,
  applyCrewToolRequest,
  applyCrewToolResult,
  handleCrewAgentStage,
  finalizeCrewRun,
} from './agent-run-store.js';
import { TraceRecorder } from './agent-trace.js';
import { openTraceInspector } from './agent-trace-inspector.js';
import { isAgentSkill, ROLE_TOOL_MAP } from './tool-registry.js';
import { saveTrace, isTraceRecordingEnabled } from './agent-trace-store.js';
import { setInspectorToggleBadge, openInspectorPanel, updateInspectorPanel } from './inspector-panel.js';
import { extractArtifacts } from './artifacts.js';

/**
 * @param {Object} deps
 * @param {Function} deps.getIsStreaming
 * @param {Function} deps.setIsStreaming
 * @param {Function} deps.getUserScrolledUp
 * @param {Function} deps.setUserScrolledUp
 * @param {Function} deps.getAbortController
 * @param {Function} deps.setAbortController
 * @param {Function} deps.$messages
 * @param {Function} deps.getSettings
 * @param {Function} deps.toggleStreamingUI
 * @param {Function} deps.appendMessageDOM
 * @param {Function} deps.smartScroll
 * @param {Function} deps.updateSpeedIndicator
 * @param {Function} deps.removeSpeedIndicator
 * @param {Function} deps.renderToolCalls
 * @param {Function} deps.renderEvidencePanel
 * @param {Function} deps.renderAgentTimeline
 * @param {Function} deps.renderCrewOrTheatre
 * @param {Function} deps.addMessageActions
 * @param {Function} deps.renderStoppedNotice
 * @param {Function} deps.renderAssistantAnswerHeader
 * @param {Function} deps.renderAssistantArtifacts
 * @param {Function} deps.renderAssistantEvidence
 * @param {Function} deps.renderAssistantToc
 * @param {Function} deps.renderErrorContent
 * @param {Function} deps.attachCopyHandlersOnly
 * @param {Function} deps.syncToolRuns
 * @param {Function} deps.persist
 * @param {Function} deps.updateHeader
 * @param {Function} deps.refreshConversationTaskCheckpoint
 * @param {Function} deps.primeMarkdownRenderCache
 * @param {Function} deps.refreshReadingNavigator
 * @param {Function} deps.getConversationUsageSummary
 * @param {Function} deps.buildCacheProfile
 * @param {Function} deps.streamChat
 * @param {Function} deps.approveToolRequest
 * @param {Function} deps.applyToolDecision
 * @param {Function} deps.applyToolResult
 * @param {Function} deps.createToolRecord
 * @param {Function} deps.enhancePrompt
 * @param {Function} deps.isEnhanceEnabled
 * @param {Function} deps.maybeAppendRelevantMemory
 * @param {Function} deps.formatTaskCheckpointStageSummary
 * @param {Function} deps.hasUncitedSearchSource
 * @param {Function} deps.hasUncitedLocalSource
 * @param {Function} deps.openTraceInspectorFn
 */
export function createStreamOrchestrator(deps: Record<string, any>) {
  async function doStream(
    conv: Record<string, any>,
    retryCount = 0,
    inheritVersions: any[] | null = null,
    composerOverrides: Record<string, any> | null = null
  ) {
    deps.setIsStreaming(true);
    deps.setUserScrolledUp(false);
    deps.setAbortController(new AbortController());
    deps.toggleStreamingUI(true);

    const assistantMsg: Record<string, any> = {
      role: 'assistant',
      content: '',
      thinking: '',
      timestamp: Date.now(),
      model: deps.getSettings().model || '',
      tokens: null,
      versions: inheritVersions || [],
      toolRuns: [],
      toolCalls: [],
      agentStages: [],
      agentRun: null,
      contextBudget: null,
      composerOverrides,
      cacheProfile: null,
      traceRecorder: null,
      stopped: false,
      speed: 0,
      sourceWarning: false,
    };
    const msgEl = deps.appendMessageDOM(assistantMsg, true);
    msgEl.classList.add('streaming');
    const contentEl = msgEl.querySelector('.message-content');
    const thinkingContent = msgEl.querySelector('.thinking-content');
    const crewContainer = msgEl.querySelector('.agent-crew-container');
    const toolContainer = msgEl.querySelector('.tool-calls-container');
    const evidenceContainer = msgEl.querySelector('.evidence-panel');
    const agentContainer = msgEl.querySelector('.agent-timeline-container');

    function shouldShowAgentCrewEarly() {
      const mode = deps.getSettings().crewDisplayMode || 'auto';
      if (mode === 'off') return false;
      if (mode === 'always') return true;
      const skill = composerOverrides?.activeSkill || deps.getSettings().activeSkill || 'auto';
      return isAgentSkill(skill);
    }

    function shouldCreateCrewFromStage(event: Record<string, any>) {
      const mode = deps.getSettings().crewDisplayMode || 'auto';
      if (mode === 'off') return false;
      if (mode === 'always') return true;
      const skill = composerOverrides?.activeSkill || deps.getSettings().activeSkill || 'auto';
      if (isAgentSkill(skill)) return true;
      const toolCalls = assistantMsg.toolCalls as unknown[];
      if (toolCalls?.length > 0) return true;
      if (['tool_repair', 'summary', 'final'].includes(event.stage)) return toolCalls?.length > 0;
      return false;
    }

    function ensureAgentRun() {
      if (!assistantMsg.agentRun) {
        assistantMsg.agentRun = createAgentRun(
          composerOverrides?.activeSkill || deps.getSettings().activeSkill || 'auto'
        );
      }
      return assistantMsg.agentRun;
    }

    const traceRecorder = new TraceRecorder({
      runId: assistantMsg.id || `msg_${assistantMsg.timestamp}`,
      mode: composerOverrides?.activeSkill || deps.getSettings().activeSkill || 'auto',
      model: deps.getSettings().model || '',
    });
    assistantMsg.traceRecorder = traceRecorder;

    if (shouldShowAgentCrewEarly()) {
      ensureAgentRun();
      deps.renderCrewOrTheatre(crewContainer, assistantMsg.agentRun);
    }
    crewContainer.addEventListener('deepchat:crew-role-click', (e: Event) => {
      const roleId = (e as CustomEvent).detail?.roleId;
      if (!roleId) return;
      if ((e as any).shiftKey && assistantMsg.traceRecorder) {
        (deps.openTraceInspectorFn || openTraceInspector)(assistantMsg.traceRecorder, {
          conversationTitle: conv.title,
        });
        return;
      }
      const toolNameMap = ROLE_TOOL_MAP;
      const targetTools = (toolNameMap as Record<string, readonly string[]>)[roleId as string];
      if (targetTools && toolContainer) {
        const blocks = toolContainer.querySelectorAll('.tool-call-block');
        for (const block of blocks) {
          const nameEl = block.querySelector('.tool-call-header strong');
          if (nameEl && targetTools.some((t: string) => nameEl.textContent?.includes(t))) {
            block.scrollIntoView({ behavior: 'smooth', block: 'center' });
            block.style.outline = '2px solid var(--accent-primary)';
            setTimeout(() => {
              block.style.outline = '';
            }, OUTLINE_HIGHLIGHT_MS);
            return;
          }
        }
      }
      if (contentEl) contentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    deps.smartScroll();

    let fullContent = '';
    let fullThinking = '';
    let renderTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRenderLen = 0;
    let streamStartTime = 0;
    let tokenCount = 0;
    let artifactFocused = false;

    // Append-only rendering for long content
    const APPEND_THRESHOLD = STREAMING_APPEND_THRESHOLD;
    const FULL_SYNC_INTERVAL = STREAMING_FULL_SYNC_INTERVAL;
    let lastFullSyncLen = 0;
    let lastAppendLen = 0;

    function getThrottleMs() {
      if (fullContent.length < 200) return 50;
      if (fullContent.length < STREAMING_APPEND_THRESHOLD) return 120;
      return 250;
    }

    function scheduleRender() {
      if (renderTimer) return;
      renderTimer = setTimeout(async () => {
        renderTimer = null;
        if (fullContent.length - lastRenderLen < 3 && fullContent.length > 50) {
          renderTimer = setTimeout(scheduleRender, getThrottleMs());
          return;
        }
        lastRenderLen = fullContent.length;

        // Tiered rendering strategy
        if (fullContent.length < APPEND_THRESHOLD) {
          // Short content: full re-render (fast enough)
          safeSetHTML(contentEl, renderStreamingMarkdown(fullContent));
          lastFullSyncLen = fullContent.length;
          lastAppendLen = fullContent.length;
        } else if (fullContent.length - lastFullSyncLen > FULL_SYNC_INTERVAL || lastFullSyncLen === 0) {
          // Periodic full sync to correct markdown formatting drift
          safeSetHTML(contentEl, renderStreamingMarkdown(fullContent));
          lastFullSyncLen = fullContent.length;
          lastAppendLen = fullContent.length;
        } else {
          // Append-only mode: render only new content
          const newContent = fullContent.slice(lastAppendLen);
          if (newContent.length > 0) {
            const tempDiv = document.createElement('div');
            safeSetHTML(tempDiv, renderStreamingMarkdown(newContent));
            while (tempDiv.firstChild) {
              contentEl.appendChild(tempDiv.firstChild);
            }
            lastAppendLen = fullContent.length;
          }
        }

        contentEl.classList.add('streaming-cursor');
        // Only attach copy handlers if content may contain code blocks
        if (fullContent.includes('```')) {
          deps.attachCopyHandlersOnly(contentEl);
        }

        const hasArtifacts = fullContent.includes('```mermaid') || fullContent.includes('```html');
        if (hasArtifacts) {
          const artifactData = {
            msg: { content: fullContent, role: 'assistant', timestamp: Date.now() },
            index: conv.messages.length,
            messages: [...conv.messages, { content: fullContent, role: 'assistant' }],
          };
          if (!artifactFocused) {
            artifactFocused = true;
            openInspectorPanel('artifact', artifactData);
          } else {
            updateInspectorPanel('artifact', artifactData);
          }
        }
        if (streamStartTime > 0) {
          const elapsed = (Date.now() - streamStartTime) / 1000;
          if (elapsed > 0.5) {
            const speed = Math.round(tokenCount / elapsed);
            deps.updateSpeedIndicator(msgEl, speed);
          }
        }
        deps.smartScroll(false);
      }, getThrottleMs());
    }

    const apiMessages = conv.messages
      .filter((m: Record<string, any>) => m.role === 'user' || m.role === 'assistant')
      .map((m: Record<string, any>) => ({
        role: m.role,
        content: m.modelContent || m.content,
        attachments: m.attachments || [],
      }));

    const enhanceEnabled = composerOverrides?.enhance ?? deps.isEnhanceEnabled();
    if (enhanceEnabled && apiMessages.length > 0) {
      const lastIdx = apiMessages.length - 1;
      if (apiMessages[lastIdx].role === 'user') {
        const original = apiMessages[lastIdx].content;
        const enhanced = deps.enhancePrompt(original);
        if (enhanced !== original) apiMessages[lastIdx] = { ...apiMessages[lastIdx], content: enhanced };
      }
    }

    const memoryContext = deps.maybeAppendRelevantMemory(apiMessages, conv);
    if (memoryContext?.hits?.length) {
      (assistantMsg.agentStages as Record<string, unknown>[]).push({
        stage: 'memory',
        round: 0,
        warning: `检索到 ${memoryContext.hits.length} 条相关历史`,
      });
      deps.renderAgentTimeline(agentContainer, assistantMsg);
    }
    if (memoryContext?.taskCheckpointUsed) {
      const checkpointSummary = deps.formatTaskCheckpointStageSummary(memoryContext.taskCheckpoint);
      (assistantMsg.agentStages as Record<string, unknown>[]).push({
        stage: 'checkpoint',
        round: 0,
        warning: checkpointSummary || '已使用长期任务状态',
      });
      deps.renderAgentTimeline(agentContainer, assistantMsg);
    }

    const abortController = deps.getAbortController();
    await deps.streamChat(apiMessages, {
      signal: abortController.signal,
      contextSummary: conv.contextSummary || '',
      contextSummaryMeta: conv.contextSummaryMeta || null,
      cacheProfile: conv.cacheProfile || null,
      onToken(token: string) {
        if (streamStartTime === 0) streamStartTime = Date.now();
        tokenCount++;
        fullContent += token;
        scheduleRender();
      },
      onThinking(token: string) {
        fullThinking += token;
        if (thinkingContent) {
          thinkingContent.textContent = fullThinking;
          const thinkingBlock = msgEl.querySelector('.thinking-block');
          if (thinkingBlock) thinkingBlock.hidden = false;
        }
      },
      onTokenCount(counts: Record<string, any>) {
        assistantMsg.tokens = counts;
        assistantMsg.cacheProfile = deps.buildCacheProfile(counts, assistantMsg.contextBudget);
        conv.cacheProfile = assistantMsg.cacheProfile;
      },
      onToolRequest(event: Record<string, any>) {
        if (!assistantMsg.toolCalls) assistantMsg.toolCalls = [];
        const tool = deps.createToolRecord(event);
        (assistantMsg.toolCalls as Record<string, unknown>[]).push(tool);
        deps.syncToolRuns(assistantMsg);
        applyCrewToolRequest(ensureAgentRun(), tool);
        deps.renderCrewOrTheatre(crewContainer, assistantMsg.agentRun);
        traceRecorder.recordToolRequest({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          risk: event.risk,
          approvalPolicy: event.approvalPolicy,
          autoApproved: event.autoApproved,
          inputSummary: event.args ? JSON.stringify(event.args).slice(0, 200) : '',
        });
        deps.renderToolCalls(toolContainer, assistantMsg.toolCalls, {
          requestId: event.requestId,
          onDecision(toolCallId: string, approved: boolean) {
            deps.applyToolDecision(tool, approved);
            deps.syncToolRuns(assistantMsg);
            applyCrewToolResult(ensureAgentRun(), tool, assistantMsg.toolCalls as any[]);
            deps.renderCrewOrTheatre(crewContainer, assistantMsg.agentRun);
            traceRecorder.recordApproval({
              toolCallId,
              approved,
              decision: approved ? 'approved' : 'denied',
              reason: approved ? '用户确认' : '用户拒绝',
            });
            deps.approveToolRequest(event.requestId, toolCallId, approved);
            deps.renderToolCalls(toolContainer, assistantMsg.toolCalls);
            deps.renderEvidencePanel(evidenceContainer, assistantMsg.toolCalls);
          },
        });
      },
      onToolResult(event: Record<string, any>) {
        if (!assistantMsg.toolCalls) assistantMsg.toolCalls = [];
        deps.applyToolResult(assistantMsg.toolCalls, event);
        deps.syncToolRuns(assistantMsg);
        deps.renderToolCalls(toolContainer, assistantMsg.toolCalls);
        deps.renderEvidencePanel(evidenceContainer, assistantMsg.toolCalls);
        applyCrewToolResult(ensureAgentRun(), event, assistantMsg.toolCalls as any[]);
        deps.renderCrewOrTheatre(crewContainer, assistantMsg.agentRun);
        traceRecorder.recordToolResult({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ok: event.ok,
          output: event.output,
          outputSummary: event.outputSummary || '',
          error: event.error,
          durationMs: event.durationMs,
          outputBytes: event.output ? String(event.output).length : 0,
          evidenceIds: event.evidenceIds,
        });
      },
      onAgentStage(event: Record<string, any>) {
        (assistantMsg.agentStages as Record<string, unknown>[]).push({ ...event, at: new Date().toISOString() });
        traceRecorder.recordStage(event);
        deps.renderAgentTimeline(agentContainer, assistantMsg);
        if (shouldCreateCrewFromStage(event)) {
          handleCrewAgentStage(ensureAgentRun(), event);
          deps.renderCrewOrTheatre(crewContainer, assistantMsg.agentRun);
        }
      },
      onContextBudget(event: Record<string, any>) {
        assistantMsg.contextBudget = event;
        deps.renderAgentTimeline(agentContainer, assistantMsg);
      },
      onContextSummary(event: Record<string, any>) {
        conv.contextSummary = event.summary || conv.contextSummary || '';
        conv.contextSummaryUpdatedAt = event.updatedAt || new Date().toISOString();
        conv.contextSummaryMeta = event.meta || conv.contextSummaryMeta || null;
        traceRecorder.recordContextCompaction({
          messageCount: event.meta?.messageCount,
          tokenCount: event.meta?.tokenCount,
          summaryTokens: event.meta?.summaryTokens,
          trigger: event.meta?.trigger || 'auto',
        });
        deps.renderAgentTimeline(agentContainer, assistantMsg);
      },
      async onDone(doneEvent: Record<string, any> = {}) {
        clearTimeout(renderTimer ?? undefined);
        if (assistantMsg.agentRun) {
          finalizeCrewRun(assistantMsg.agentRun, { aborted: Boolean(doneEvent.aborted) });
          deps.renderCrewOrTheatre(crewContainer, assistantMsg.agentRun);
        }
        traceRecorder.recordRunEnd({
          status: doneEvent.aborted ? 'cancelled' : 'done',
          finalContentLength: fullContent.length,
        });
        if (isTraceRecordingEnabled(deps.getSettings())) {
          saveTrace(traceRecorder, conv.id).catch((err) => console.warn('[Chat] saveTrace failed:', err));
        }
        deps.renderEvidencePanel(evidenceContainer, assistantMsg.toolCalls);
        const elapsed = streamStartTime > 0 ? (Date.now() - streamStartTime) / 1000 : 0;
        const finalSpeed = elapsed > 0 ? Math.round(tokenCount / elapsed) : 0;
        const finalHtml = renderMarkdown(fullContent);
        safeSetHTML(contentEl, finalHtml);
        deps.primeMarkdownRenderCache(fullContent, finalHtml);
        contentEl.classList.remove('streaming-cursor');
        msgEl.classList.remove('streaming');
        msgEl.classList.add('just-completed');
        setTimeout(() => msgEl.classList.remove('just-completed'), 1200);
        await postProcess(contentEl);
        deps.renderAssistantToc(msgEl.querySelector('.answer-toc-container'), contentEl);
        const typing = msgEl.querySelector('.typing-indicator');
        if (typing) typing.remove();
        deps.removeSpeedIndicator(msgEl);
        assistantMsg.content = fullContent;
        assistantMsg.thinking = fullThinking;
        assistantMsg.stopped = Boolean(doneEvent.aborted);
        assistantMsg.speed = finalSpeed;
        assistantMsg.sourceWarning =
          deps.hasUncitedSearchSource(assistantMsg, fullContent) ||
          deps.hasUncitedLocalSource(assistantMsg, fullContent);
        if ((assistantMsg.agentStages as unknown[])?.length) deps.renderAgentTimeline(agentContainer, assistantMsg);
        conv.messages.push(assistantMsg);
        deps.refreshConversationTaskCheckpoint(conv);
        conv.usageTotals = deps.getConversationUsageSummary(conv);
        msgEl.dataset.messageIndex = String(conv.messages.length - 1);
        await deps.persist();
        deps.updateHeader();
        deps.renderAssistantAnswerHeader(msgEl.querySelector('.answer-header-container'), assistantMsg);
        deps.addMessageActions(msgEl, fullContent, assistantMsg.tokens, finalSpeed, conv.messages.length - 1);
        if (assistantMsg.stopped)
          deps.renderStoppedNotice(msgEl.querySelector('.message-body'), conv.messages.length - 1);
        deps.renderAssistantArtifacts(
          msgEl.querySelector('.artifact-container'),
          assistantMsg,
          conv.messages.length - 1
        );
        deps.renderAssistantEvidence(msgEl.querySelector('.message-body'), assistantMsg);
        setInspectorToggleBadge(extractArtifacts(fullContent).length > 0);
        deps.setIsStreaming(false);
        deps.setAbortController(null);
        deps.setUserScrolledUp(false);
        deps.toggleStreamingUI(false);
        scrollToBottom(deps.$messages);
        deps.refreshReadingNavigator();
      },
      async onError(err: Error) {
        clearTimeout(renderTimer ?? undefined);
        contentEl.classList.remove('streaming-cursor');
        const typing = msgEl.querySelector('.typing-indicator');
        if (typing) typing.remove();
        deps.removeSpeedIndicator(msgEl);
        if (
          retryCount < 2 &&
          (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('Failed'))
        ) {
          msgEl.remove();
          deps.setIsStreaming(false);
          deps.setAbortController(null);
          showToast(`网络错误，正在重试 (${retryCount + 1}/2)...`);
          setTimeout(() => {
            if (!deps.getIsStreaming()) doStream(conv, retryCount + 1);
          }, COPY_FEEDBACK_MS);
          return;
        }
        traceRecorder.recordError({ source: 'model_stream', message: err.message });
        traceRecorder.recordRunEnd({ status: 'error', errorMessage: err.message });
        if (isTraceRecordingEnabled(deps.getSettings())) {
          saveTrace(traceRecorder, conv.id).catch((e) => console.warn('[Chat] saveTrace failed:', e));
        }
        if (assistantMsg.agentRun) {
          finalizeCrewRun(assistantMsg.agentRun, { error: err.message, source: 'model_stream' });
          deps.renderCrewOrTheatre(crewContainer, assistantMsg.agentRun);
        }
        deps.renderEvidencePanel(evidenceContainer, assistantMsg.toolCalls);
        assistantMsg.content = fullContent;
        assistantMsg.thinking = fullThinking;
        assistantMsg.error = err.message;
        deps.syncToolRuns(assistantMsg);
        deps.renderAssistantAnswerHeader(msgEl.querySelector('.answer-header-container'), assistantMsg);
        conv.messages.push(assistantMsg);
        deps.refreshConversationTaskCheckpoint(conv);
        conv.usageTotals = deps.getConversationUsageSummary(conv);
        msgEl.dataset.messageIndex = String(conv.messages.length - 1);
        await deps.persist();
        deps.updateHeader();
        const renderRetry = async () => {
          conv.messages.pop();
          await deps.persist();
          msgEl.remove();
          deps.setIsStreaming(false);
          deps.setAbortController(null);
          doStream(conv);
        };
        if (fullContent.trim()) {
          const partialHtml = renderMarkdown(fullContent);
          safeSetHTML(contentEl, partialHtml);
          deps.primeMarkdownRenderCache(fullContent, partialHtml);
          postProcess(contentEl)
            .then(deps.refreshReadingNavigator)
            .catch((e) => console.warn('[Chat] postProcess failed:', e));
          const errorHost = document.createElement('div');
          contentEl.appendChild(errorHost);
          deps.renderErrorContent(errorHost, err.message, () => msgEl.remove(), renderRetry);
        } else {
          deps.renderErrorContent(contentEl, err.message, () => msgEl.remove(), renderRetry);
        }
        deps.setIsStreaming(false);
        deps.setAbortController(null);
        deps.setUserScrolledUp(false);
        deps.toggleStreamingUI(false);
        deps.refreshReadingNavigator();
      },
    });
  }

  return { doStream };
}
