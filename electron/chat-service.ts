import { getSettings } from './storage.js';
import { getToolDefinitions, describeToolRisk } from './tools.js';
import { McpManager, isMcpToolName } from './mcp-manager.js';
import crypto from 'crypto';
import {
  DEFAULT_AGENT_MAX_ROUNDS,
  detectAgentIntent,
  getLastUserText,
  buildAgentPlanSummary,
  buildResearchSearchPlan,
  buildPlanApprovalPolicy,
  needsSearch,
  needsFiles,
  needsCode,
  needsMcp,
  detectExplicitToolDirectives,
  hasAtDirective,
  needsYearScopedExternalLookup,
  normalizeResearchTopic,
  dedupeSearchPlan,
  stripVolatileContextBlocks,
} from './agent-planner.js';
import {
  waitForApproval as _waitForApproval,
  normalizeToolApprovalPolicy,
  resolveToolApprovalDecision,
  isAutoApprovableReadOnlyTool,
  buildToolSecurity,
  isParallelSafeToolCall,
  resolveToolApprovalTimeout,
  DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
} from './approval-manager.js';

import {
  DEEPSEEK_PRICING,
  MIMO_PRICING,
  estimateTokens,
  estimateMessagesTokens,
  normalizeTokenUsage,
  mergeTokenUsage,
  finalizeTokenUsage,
  normalizePurposeUsage,
  mergePurposeUsage,
  mergeUsageCost,
  estimateUsageCost,
  pricingForModel,
  roundCost,
  toTokenNumber,
  clampNumber,
} from './usage-meter.js';

import {
  testApiConnection,
  buildHeaders,
  fetchChatCompletionWithFallback,
  normalizeBaseUrl,
  getProviderToolSupport,
  shouldWarnAboutToolSupport,
  filterStableBuiltInTools,
  inferProviderIdFromBase,
  parseApiError,
  isUnsupportedParameterError,
  isToolParameterError,
  normalizeError,
} from './provider-adapters.js';

import {
  DEFAULT_MAX_INPUT_TOKENS as CM_DEFAULT_MAX_INPUT_TOKENS,
  buildContextWithBudget,
  buildContextBudgetBundle,
  trimContext,
  formatMessagesForSummary,
  hashMessages,
  findLatestUserIndex,
  trimByRecentBudget,
  dropLeadingAssistant,
  createContextBudgetMeta,
} from './context-manager.js';

import {
  getStableAgentToolMode,
  buildCacheStablePrefix,
  canonicalStringify,
  buildCacheStabilityDiagnostics,
} from './system-prompt.js';

import {
  MAX_TOOL_CONTEXT_TOKENS,
  compactToolOutputForContext,
  repairToolCallsFromText,
  parseToolArgsDetailed,
} from './tool-executor.js';

import {
  mergeToolCalls,
  compactToolCalls,
  compactToolCallsForContext,
  normalizeMessage,
  sanitizeMessages,
  isImageAttachment,
  appendTurnTailMetadata,
  buildTurnTailMetadata,
  buildReasoningRoundTrip,
  toolCallSignature,
  resolveAuxiliaryModel,
  resolveAgentMaxRounds,
} from './stream-runner.js';

import {
  attachPrefixProfile,
  applyRequestOverrides,
  normalizeAgentExecutionMode,
  buildSingleStepStopReason,
  parseToolArgs,
} from './chat-service-helpers.js';

import { COMPACTION_SUMMARY_MARKER, maybeBuildContextSummary, summarizeContext } from './context-summarizer.js';

import { streamOnce } from './chat-streamer.js';

import { handleToolCall, handleToolCallsForRound } from './tool-call-handler.js';

class ChatService {
  constructor(getWindow) {
    this.getWindow = getWindow;
    this.sessions = new Map();
    this.pendingApprovals = new Map();
    this.mcpManager = new McpManager();
    this.controllers = new Map();
  }

  start(request) {
    const requestId = request?.requestId;
    if (!requestId) return;
    this.cancel(requestId);

    const abortController = new AbortController();
    this.sessions.set(requestId, abortController);

    // Create AgentRunController
    const controller = {
      requestId,
      status: 'running',
      skippedToolCallIds: new Set(),
      scopePolicy: 'all',
      pausePromise: null,
      pauseResolver: null,
      async checkPausePoint() {
        while (this.status === 'paused') {
          if (this.pausePromise) {
            await this.pausePromise;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      },
    };
    this.controllers.set(requestId, controller);

    this.run(request, abortController)
      .catch((error) => {
        if (error.name === 'AbortError') {
          this.emit(requestId, 'done', { aborted: true });
          return;
        }
        this.emit(requestId, 'error', { message: normalizeError(error) });
      })
      .finally(() => {
        this.sessions.delete(requestId);
        this.controllers.delete(requestId);
        for (const key of [...this.pendingApprovals.keys()]) {
          if (key.startsWith(`${requestId}:`)) this.pendingApprovals.delete(key);
        }
      });
  }

  cancel(requestId) {
    const controller = this.sessions.get(requestId);
    if (controller) controller.abort();
    for (const [key, pending] of this.pendingApprovals.entries()) {
      if (key.startsWith(`${requestId}:`)) {
        pending.resolve({ approved: false });
        this.pendingApprovals.delete(key);
      }
    }
  }

  approve(requestId, toolCallId, approved) {
    const key = `${requestId}:${toolCallId}`;
    const pending = this.pendingApprovals.get(key);
    if (!pending) return;
    pending.resolve({ approved: Boolean(approved) });
    this.pendingApprovals.delete(key);
  }

  pause(requestId) {
    const controller = this.controllers.get(requestId);
    if (controller && controller.status === 'running') {
      controller.status = 'paused';
      controller.pausePromise = new Promise((resolve) => {
        controller.pauseResolver = resolve;
      });
      this.emit(requestId, 'agentStage', { stage: 'paused', round: 0, maxRounds: 0, warning: 'Agent 已被用户暂停' });
    }
  }

  resume(requestId) {
    const controller = this.controllers.get(requestId);
    if (controller && controller.status === 'paused') {
      controller.status = 'running';
      if (controller.pauseResolver) {
        controller.pauseResolver();
        controller.pausePromise = null;
        controller.pauseResolver = null;
      }
      this.emit(requestId, 'agentStage', { stage: 'running', round: 0, maxRounds: 0, warning: 'Agent 继续运行' });
    }
  }

  skipTool(requestId, toolCallId) {
    const controller = this.controllers.get(requestId);
    if (controller) {
      if (toolCallId === 'current' || !toolCallId) {
        // Skip current waiting approval tool
        for (const [key, pending] of this.pendingApprovals.entries()) {
          if (key.startsWith(`${requestId}:`)) {
            const actualId = key.slice(requestId.length + 1);
            controller.skippedToolCallIds.add(actualId);
            pending.resolve({ approved: true, skipped: true });
            this.pendingApprovals.delete(key);
          }
        }
      } else {
        controller.skippedToolCallIds.add(toolCallId);
        const key = `${requestId}:${toolCallId}`;
        const pending = this.pendingApprovals.get(key);
        if (pending) {
          pending.resolve({ approved: true, skipped: true });
          this.pendingApprovals.delete(key);
        }
      }
    }
  }

  limitScope(requestId, scopePolicy) {
    const controller = this.controllers.get(requestId);
    if (controller) {
      controller.scopePolicy = scopePolicy;
      this.emit(requestId, 'agentStage', {
        stage: 'warning',
        round: 0,
        maxRounds: 0,
        warning: `已限制读取范围/策略：${scopePolicy}`,
      });
    }
  }

  async run(request, abortController) {
    const requestId = request.requestId;
    const settings = applyRequestOverrides(await getSettings(), request.overrides || {});
    return this.runWithSettings(request, settings, abortController);
  }

  async runWithSettings(request, settings, abortController) {
    const requestId = request.requestId;
    const messages = sanitizeMessages(request.messages || []);
    const intent = detectAgentIntent(messages, settings);
    const toolSupport = getProviderToolSupport(settings);
    const toolSettings = toolSupport.supported ? settings : { ...settings, activeSkill: 'none' };
    const tools = toolSupport.supported ? await this.getAvailableTools(settings, intent) : [];
    const prefix = buildCacheStablePrefix(toolSettings, tools, request.cacheProfile);
    const systemPrompt = prefix.systemPrompt;
    const prefixTokens = prefix.prefixTokens;
    let contextBundle = buildContextBudgetBundle(messages, {
      maxMessages: settings.maxContextMessages,
      maxInputTokens: settings.maxInputTokens,
      prefixTokens,
      prefix,
    });
    const apiMessages = [...contextBundle.messages];
    const maxToolRounds = resolveAgentMaxRounds(settings);
    const agentExecutionMode = normalizeAgentExecutionMode(settings.agentExecutionMode);
    const usageRounds = [];
    const warnings = [];
    const seenToolCalls = new Set();

    const prefixWarnings = prefix.cacheStabilityWarnings || [];
    if (prefixWarnings.length > 0) warnings.push(...prefixWarnings);

    let workingMessages = [{ role: 'system', content: systemPrompt }];
    const latestUserText = getLastUserText(messages);
    const planSummary = buildAgentPlanSummary(intent, tools, settings, maxToolRounds, latestUserText);

    this.emit(requestId, 'agentStage', {
      stage: 'plan',
      round: 0,
      maxRounds: maxToolRounds,
      intent,
      planSummary,
      agentExecutionMode,
      selectedTools: intent.selectedTools,
      candidateTools: intent.candidateTools,
      missingPrerequisites: intent.missingPrerequisites,
    });
    if (intent.missingPrerequisites.length > 0) {
      const warning = `智能 Agent 判断本轮可能需要 ${(intent.candidateTools || intent.selectedTools).join(', ') || intent.reason}，但缺少配置：${intent.missingPrerequisites.join('、')}。`;
      warnings.push(warning);
      this.emit(requestId, 'agentStage', { stage: 'warning', round: 0, maxRounds: maxToolRounds, warning });
    }
    if (!toolSupport.supported && shouldWarnAboutToolSupport(settings, intent)) {
      warnings.push(toolSupport.warning);
      this.emit(requestId, 'agentStage', {
        stage: 'warning',
        round: 0,
        maxRounds: maxToolRounds,
        warning: toolSupport.warning,
        selectedTools: [],
        stopReason: 'provider_tools_unsupported',
      });
    }
    for (const warning of prefixWarnings) {
      this.emit(requestId, 'agentStage', { stage: 'warning', round: 0, maxRounds: maxToolRounds, warning });
    }

    if (settings.autoContextSummary !== false) {
      const summaryResult = await this.maybeBuildContextSummary(
        request,
        settings,
        contextBundle,
        prefixTokens,
        abortController.signal
      );
      if (summaryResult?.summary) {
        workingMessages.push({
          role: 'system',
          content: `${COMPACTION_SUMMARY_MARKER}${summaryResult.summary}`,
        });
        usageRounds.push(summaryResult.usage);
        contextBundle = {
          ...contextBundle,
          meta: {
            ...contextBundle.meta,
            summaryUsed: true,
            summaryGenerated: summaryResult.generated,
          },
        };
        this.emit(requestId, 'contextSummary', {
          summary: summaryResult.summary,
          generated: summaryResult.generated,
          updatedAt: new Date().toISOString(),
          meta: summaryResult.meta,
        });
      }
    }

    workingMessages.push(...appendTurnTailMetadata(apiMessages, buildTurnTailMetadata(intent, settings, planSummary)));
    this.emit(requestId, 'contextBudget', contextBundle.meta);

    for (let round = 0; round <= maxToolRounds; round++) {
      const controller = this.controllers.get(requestId);
      if (controller) {
        await controller.checkPausePoint();
      }

      this.emit(requestId, 'agentStage', { stage: 'model', round: round + 1, maxRounds: maxToolRounds });
      const result = await this.streamOnce(requestId, workingMessages, settings, tools, abortController.signal);
      if (Array.isArray(result.warnings)) warnings.push(...result.warnings);
      usageRounds.push(
        normalizeTokenUsage(result.usage, {
          input: estimateMessagesTokens(workingMessages),
          output: estimateTokens(result.content),
          model: settings.model,
          byPurpose: { main: estimateTokens(result.content) },
        })
      );
      if (abortController.signal.aborted) {
        this.emit(requestId, 'done', { aborted: true });
        return;
      }

      if (!result.toolCalls.length) {
        this.emit(requestId, 'agentStage', {
          stage: 'final',
          round: round + 1,
          maxRounds: maxToolRounds,
          stopReason: 'final',
        });
        const usage = mergeTokenUsage(usageRounds, { warnings });
        attachPrefixProfile(usage, prefix, settings);
        this.emit(requestId, 'tokenCount', usage);
        this.emit(requestId, 'done', { aborted: false });
        return;
      }

      if (round >= maxToolRounds) {
        const stopReason = `工具调用超过 ${maxToolRounds} 轮，已停止。`;
        this.emit(requestId, 'agentStage', { stage: 'stop', round: round + 1, maxRounds: maxToolRounds, stopReason });
        const usage = mergeTokenUsage(usageRounds, { warnings });
        attachPrefixProfile(usage, prefix, settings);
        this.emit(requestId, 'tokenCount', usage);
        this.emit(requestId, 'done', { aborted: false, stopReason });
        return;
      }

      workingMessages.push({
        role: 'assistant',
        content: result.content || '',
        tool_calls: compactToolCallsForContext(result.toolCalls),
        ...buildReasoningRoundTrip(result, settings),
      });

      if (controller) {
        await controller.checkPausePoint();
      }

      const toolResults = await this.handleToolCallsForRound(
        requestId,
        result.toolCalls,
        settings,
        abortController.signal,
        round + 1,
        maxToolRounds,
        seenToolCalls,
        warnings
      );
      workingMessages.push(
        ...toolResults.map(({ toolCall, output }) => ({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: compactToolOutputForContext(
            toolCall.function?.name,
            parseToolArgs(toolCall.function?.arguments),
            output
          ),
        }))
      );

      if (agentExecutionMode === 'single_step') {
        const stopReason = buildSingleStepStopReason(toolResults);
        const stopContent = `\n\n${stopReason}`;
        this.emit(requestId, 'token', { token: stopContent });
        this.emit(requestId, 'agentStage', {
          stage: 'stop',
          round: round + 1,
          maxRounds: maxToolRounds,
          stopReason,
          selectedTools: toolResults.map(({ toolCall }) => toolCall.function?.name || 'unknown_tool'),
        });
        const usage = mergeTokenUsage(usageRounds, { warnings });
        attachPrefixProfile(usage, prefix, settings);
        this.emit(requestId, 'tokenCount', usage);
        this.emit(requestId, 'done', { aborted: false, stopReason: 'single_step' });
        return;
      }
    }
  }

  async maybeBuildContextSummary(request, settings, contextBundle, prefixTokens, signal) {
    return maybeBuildContextSummary(
      request,
      settings,
      contextBundle,
      prefixTokens,
      signal,
      this.emit.bind(this),
      this.summarizeContext.bind(this)
    );
  }

  async summarizeContext(settings, existingSummary, droppedMessages, signal) {
    return summarizeContext(settings, existingSummary, droppedMessages, signal);
  }

  async streamOnce(requestId, messages, settings, tools, signal) {
    return streamOnce(requestId, messages, settings, tools, signal, this.emit.bind(this));
  }

  async handleToolCall(requestId, toolCall, settings, signal, round = 0, maxRounds = 0) {
    return handleToolCall(requestId, toolCall, settings, signal, round, maxRounds, {
      emit: this.emit.bind(this),
      waitForApproval: this.waitForApproval.bind(this),
      describeRisk: this.describeRisk.bind(this),
      mcpManager: this.mcpManager,
      controller: this.controllers.get(requestId),
    });
  }

  async handleToolCallsForRound(
    requestId,
    toolCalls,
    settings,
    signal,
    round = 0,
    maxRounds = 0,
    seenToolCalls = new Set(),
    warnings = []
  ) {
    return handleToolCallsForRound(requestId, toolCalls, settings, signal, round, maxRounds, seenToolCalls, warnings, {
      emit: this.emit.bind(this),
      handleToolCall: this.handleToolCall.bind(this),
    });
  }

  waitForApproval(requestId, toolCallId, signal, timeoutMs = DEFAULT_TOOL_APPROVAL_TIMEOUT_MS) {
    return _waitForApproval(requestId, toolCallId, signal, this.pendingApprovals, timeoutMs);
  }

  emit(requestId, type, payload = {}) {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send('chat:event', { requestId, type, ...payload });
  }

  async getAvailableTools(settings, intent = detectAgentIntent([], settings)) {
    const activeSkill =
      settings.activeSkill === 'agent_auto'
        ? settings.cacheOptimization === false
          ? intent.toolMode
          : getStableAgentToolMode(settings)
        : settings.activeSkill;
    const builtIn =
      settings.activeSkill === 'agent_auto' && settings.cacheOptimization !== false
        ? filterStableBuiltInTools(getToolDefinitions(activeSkill), settings)
        : getToolDefinitions(activeSkill);
    if (activeSkill !== 'mcp_tool' && activeSkill !== 'multi_tool') return builtIn;
    const mcpTools = await this.mcpManager.getToolDefinitions(settings);
    const combined = [...builtIn, ...mcpTools];
    if (settings.cacheOptimization !== false) {
      combined.sort((a, b) => {
        const nameA = a.function?.name || a.name || '';
        const nameB = b.function?.name || b.name || '';
        return nameA.localeCompare(nameB);
      });
    }
    return combined;
  }

  describeRisk(name, args, settings) {
    if (isMcpToolName(name)) return `将调用外部 MCP 工具：${name}。参数：${JSON.stringify(args || {}).slice(0, 300)}`;
    return describeToolRisk(name, args, settings);
  }
}

// buildAgentPlanSummary, buildResearchSearchPlan, normalizeResearchTopic,
// dedupeSearchPlan, buildPlanApprovalPolicy — extracted to ./agent-planner.ts

module.exports = {
  ChatService,
  testApiConnection,
  normalizeBaseUrl,
  buildContextWithBudget,
  buildContextBudgetBundle,
  buildAgentPlanSummary,
  buildResearchSearchPlan,
  compactToolOutputForContext,
  detectAgentIntent,
  mergeTokenUsage,
  normalizeTokenUsage,
  buildCacheStabilityDiagnostics,
  trimContext,
  // Re-exports from extracted modules (backward compatibility + new access)
  mergeToolCalls,
  compactToolCalls,
  compactToolCallsForContext,
  normalizeMessage,
  sanitizeMessages,
  isImageAttachment,
  appendTurnTailMetadata,
  buildTurnTailMetadata,
  buildReasoningRoundTrip,
  toolCallSignature,
  resolveAuxiliaryModel,
  resolveAgentMaxRounds,
  estimateTokens,
  estimateMessagesTokens,
  finalizeTokenUsage,
  normalizePurposeUsage,
  mergePurposeUsage,
  mergeUsageCost,
  estimateUsageCost,
  pricingForModel,
  roundCost,
  toTokenNumber,
  clampNumber,
  buildHeaders,
  fetchChatCompletionWithFallback,
  getProviderToolSupport,
  shouldWarnAboutToolSupport,
  filterStableBuiltInTools,
  inferProviderIdFromBase,
  parseApiError,
  isUnsupportedParameterError,
  isToolParameterError,
  normalizeError,
  formatMessagesForSummary,
  hashMessages,
  findLatestUserIndex,
  trimByRecentBudget,
  dropLeadingAssistant,
  createContextBudgetMeta,
};
