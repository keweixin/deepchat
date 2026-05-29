// @ts-nocheck
const { getSettings } = require('./storage');
const { getToolDefinitions, describeToolRisk, executeTool } = require('./tools');
const { McpManager, isMcpToolName } = require('./mcp-manager');
const crypto = require('crypto');
const {
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
} = require('./agent-planner.ts');
const {
  waitForApproval: _waitForApproval,
  normalizeToolApprovalPolicy,
  resolveToolApprovalDecision,
  isAutoApprovableReadOnlyTool,
  buildToolSecurity,
  isParallelSafeToolCall,
  resolveToolApprovalTimeout,
  DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
} = require('./approval-manager.ts');

const {
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
} = require('./usage-meter');

const {
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
} = require('./provider-adapters');

const {
  DEFAULT_MAX_INPUT_TOKENS: CM_DEFAULT_MAX_INPUT_TOKENS,
  buildContextWithBudget,
  buildContextBudgetBundle,
  trimContext,
  formatMessagesForSummary,
  hashMessages,
  findLatestUserIndex,
  trimByRecentBudget,
  dropLeadingAssistant,
  createContextBudgetMeta,
} = require('./context-manager');

const {
  getStableAgentToolMode,
  buildCacheStablePrefix,
  canonicalStringify,
  buildCacheStabilityDiagnostics,
} = require('./system-prompt.ts');

const {
  MAX_TOOL_CONTEXT_TOKENS,
  compactToolOutputForContext,
  repairToolCallsFromText,
  parseToolArgsDetailed,
} = require('./tool-executor.ts');

const {
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
} = require('./stream-runner.ts');

const DEFAULT_MAX_INPUT_TOKENS = 24000;
const SUMMARY_TRIGGER_RATIO = 0.8;
const COMPACTION_SUMMARY_MARKER = '[CONVERSATION HISTORY SUMMARY — earlier turns folded for context efficiency]\n\n';
const AGENT_EXECUTION_MODES = new Set(['execute_all', 'single_step']);

class ChatService {
  constructor(getWindow) {
    this.getWindow = getWindow;
    this.sessions = new Map();
    this.pendingApprovals = new Map();
    this.mcpManager = new McpManager();
  }

  start(request) {
    const requestId = request?.requestId;
    if (!requestId) return;
    this.cancel(requestId);

    const abortController = new AbortController();
    this.sessions.set(requestId, abortController);
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
    const existingSummary = String(request.contextSummary || '').trim();
    const droppedMessages = contextBundle.meta.droppedMessages || [];
    const summarySourceMessages =
      droppedMessages.length > 0
        ? droppedMessages
        : contextBundle.messages.slice(0, Math.max(0, contextBundle.messages.length - 1));
    const shouldSummarize = droppedMessages.length > 0 || contextBundle.meta.budgetRatio >= SUMMARY_TRIGGER_RATIO;
    if (!shouldSummarize) return existingSummary ? { summary: existingSummary, generated: false } : null;
    if (summarySourceMessages.length === 0)
      return existingSummary ? { summary: existingSummary, generated: false } : null;
    const summaryHash = hashMessages(summarySourceMessages);
    const priorMeta =
      request.contextSummaryMeta && typeof request.contextSummaryMeta === 'object' ? request.contextSummaryMeta : {};
    if (existingSummary && priorMeta.hash === summaryHash) {
      return {
        summary: existingSummary,
        generated: false,
        meta: { hash: summaryHash, sourceMessageCount: summarySourceMessages.length, cacheHit: true },
      };
    }

    const summaryModel = resolveAuxiliaryModel(settings);
    this.emit(request.requestId, 'agentStage', {
      stage: 'summary',
      round: 0,
      maxRounds: resolveAgentMaxRounds(settings),
      warning: summaryModel !== settings.model ? `摘要辅助调用使用 ${summaryModel} 以降低成本。` : undefined,
    });
    try {
      const summary = await this.summarizeContext(
        { ...settings, model: summaryModel },
        existingSummary,
        summarySourceMessages,
        signal
      );
      const input =
        estimateMessagesTokens([
          { role: 'system', content: 'Summarize conversation context.' },
          { role: 'user', content: `${existingSummary}\n${formatMessagesForSummary(summarySourceMessages)}` },
        ]) + prefixTokens;
      return {
        summary,
        generated: true,
        meta: {
          hash: summaryHash,
          sourceMessageCount: summarySourceMessages.length,
          cacheHit: false,
          auxiliaryModel: summaryModel,
          requestedModel: settings.model,
        },
        usage: normalizeTokenUsage(null, {
          input,
          output: estimateTokens(summary),
          model: summaryModel,
          byPurpose: { summary: input + estimateTokens(summary) },
        }),
      };
    } catch (err) {
      console.error('[ContextSummary] Failed:', normalizeError(err));
      if (existingSummary)
        return {
          summary: existingSummary,
          generated: false,
          meta: {
            hash: priorMeta.hash || summaryHash,
            sourceMessageCount: priorMeta.sourceMessageCount || 0,
            cacheHit: true,
            stale: true,
          },
        };
      return null;
    }
  }

  async summarizeContext(settings, existingSummary, droppedMessages, signal) {
    const prompt = [
      '请把下面较早的对话压缩成 DeepChat 后续回答可用的短记忆。',
      '保留用户目标、关键约束、已确认事实、文件/工具结果、未完成事项。',
      '不要添加新事实。控制在 220 个中文字以内。',
      existingSummary ? `已有记忆：\n${existingSummary}` : '',
      '较早对话：',
      formatMessagesForSummary(droppedMessages),
    ]
      .filter(Boolean)
      .join('\n\n');
    const body = {
      model: settings.model,
      messages: [
        { role: 'system', content: '你负责压缩对话记忆，只输出摘要正文。' },
        { role: 'user', content: prompt },
      ],
      stream: false,
      temperature: 0.2,
      max_tokens: 500,
    };
    const response = await fetch(`${normalizeBaseUrl(settings.apiBase)}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(settings.apiKey),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error('summary failed');
    const json = await response.json();
    const content = json.choices?.[0]?.message?.content || '';
    return String(content).trim().slice(0, 1200);
  }

  async streamOnce(requestId, messages, settings, tools, signal) {
    const baseBody = {
      model: settings.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
    };

    const modelLower = String(settings.model || '').toLowerCase();
    if (modelLower.includes('reasoner') || modelLower.includes('o1') || modelLower.includes('r1')) {
      baseBody.thinking = { type: 'enabled' };
      if (settings.thinkingBudget > 0) baseBody.thinking.budget_tokens = settings.thinkingBudget;
    } else if (settings.thinkingBudget > 0) {
      baseBody.thinking = { type: 'enabled', budget_tokens: settings.thinkingBudget };
    }

    if (tools.length > 0) {
      baseBody.tools = tools;
      baseBody.tool_choice = 'auto';
    }

    const { response, warnings } = await fetchChatCompletionWithFallback(settings, baseBody, signal);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let thinking = '';
    let usage = null;
    const toolCalls = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            const nativeToolCalls = compactToolCalls(toolCalls);
            const repaired =
              nativeToolCalls.length === 0
                ? repairToolCallsFromText(content, thinking, tools)
                : { toolCalls: [], warning: '' };
            if (repaired.toolCalls.length > 0) {
              warnings.push(repaired.warning);
              this.emit(requestId, 'agentStage', { stage: 'tool_repair', round: 0, warning: repaired.warning });
            }
            return {
              content,
              thinking,
              usage,
              toolCalls: repaired.toolCalls.length > 0 ? repaired.toolCalls : nativeToolCalls,
              warnings,
            };
          }

          try {
            const json = JSON.parse(data);
            if (json.usage) usage = normalizeTokenUsage(json.usage, { model: settings.model });
            const delta = json.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) {
              content += delta.content;
              this.emit(requestId, 'token', { token: delta.content });
            }
            if (delta.reasoning_content) {
              thinking += delta.reasoning_content;
              this.emit(requestId, 'thinking', { token: delta.reasoning_content });
            }
            if (delta.tool_calls) mergeToolCalls(toolCalls, delta.tool_calls);
          } catch {
            // Ignore malformed SSE fragments from non-standard providers.
          }
        }
      }

      const nativeToolCalls = compactToolCalls(toolCalls);
      const repaired =
        nativeToolCalls.length === 0
          ? repairToolCallsFromText(content, thinking, tools)
          : { toolCalls: [], warning: '' };
      if (repaired.toolCalls.length > 0) {
        warnings.push(repaired.warning);
        this.emit(requestId, 'agentStage', { stage: 'tool_repair', round: 0, warning: repaired.warning });
      }
      return {
        content,
        thinking,
        usage,
        toolCalls: repaired.toolCalls.length > 0 ? repaired.toolCalls : nativeToolCalls,
        warnings,
      };
    } finally {
      reader.releaseLock();
    }
  }

  async handleToolCall(requestId, toolCall, settings, signal, round = 0, maxRounds = 0) {
    const fn = toolCall.function || {};
    const parsedArgs = parseToolArgsDetailed(fn.arguments);
    const args = parsedArgs.args;
    this.emit(requestId, 'agentStage', { stage: 'tool_pending', round, maxRounds, toolName: fn.name });
    if (parsedArgs.repaired) {
      this.emit(requestId, 'agentStage', {
        stage: 'tool_repair',
        round,
        maxRounds,
        toolName: fn.name,
        warning: parsedArgs.warning,
      });
    }
    const security = buildToolSecurity(fn.name, args, settings);
    const approval = resolveToolApprovalDecision(fn.name, args, settings, security);
    this.emit(requestId, 'toolRequest', {
      toolCallId: toolCall.id,
      name: fn.name,
      args,
      rawArguments: fn.arguments || '',
      parseError: parsedArgs.error,
      parseRepair: parsedArgs.repaired ? parsedArgs.warning : '',
      risk: this.describeRisk(fn.name, args, settings),
      security,
      approvalPolicy: approval.policy,
      autoApproved: approval.autoApproved,
      expiresAt: new Date(Date.now() + resolveToolApprovalTimeout(settings)).toISOString(),
    });
    if (parsedArgs.error) {
      const message = `工具 ${fn.name || 'unknown_tool'} 参数 JSON 解析失败：${parsedArgs.error}`;
      const nextAction = buildToolNextAction(fn.name, args, { parseError: parsedArgs.error, output: message });
      this.emit(requestId, 'agentStage', {
        stage: 'tool_failed',
        round,
        maxRounds,
        toolName: fn.name,
        warning: message,
      });
      const contextMeta = buildToolContextOutput(fn.name, args, message);
      this.emit(requestId, 'toolResult', {
        toolCallId: toolCall.id,
        name: fn.name,
        ok: false,
        output: message,
        nextAction,
        ...contextMeta,
        rawArguments: fn.arguments || '',
        parseError: parsedArgs.error,
      });
      return message;
    }

    const decision = approval.autoApproved
      ? { approved: true, autoApproved: true, reason: approval.reason }
      : await this.waitForApproval(requestId, toolCall.id, signal, resolveToolApprovalTimeout(settings));
    if (!decision.approved) {
      const denied = decision.timedOut
        ? `工具 ${fn.name} 等待确认超过 ${Math.round(resolveToolApprovalTimeout(settings) / 1000)} 秒，已自动拒绝。`
        : `用户拒绝执行工具 ${fn.name}。`;
      const nextAction = buildToolNextAction(fn.name, args, {
        denied: true,
        timedOut: decision.timedOut,
        output: denied,
      });
      this.emit(requestId, 'agentStage', {
        stage: 'tool_denied',
        round,
        maxRounds,
        toolName: fn.name,
        stopReason: denied,
      });
      this.emit(requestId, 'toolResult', {
        toolCallId: toolCall.id,
        name: fn.name,
        ok: false,
        output: denied,
        nextAction,
        ...buildToolContextOutput(fn.name, args, denied),
      });
      return denied;
    }

    try {
      this.emit(requestId, 'agentStage', {
        stage: decision.autoApproved ? 'tool_auto_approved' : 'tool_approved',
        round,
        maxRounds,
        toolName: fn.name,
        warning: decision.autoApproved ? decision.reason : undefined,
      });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const output = isMcpToolName(fn.name)
        ? await this.mcpManager.callOpenAiTool(fn.name, args, settings, signal)
        : await executeTool(fn.name, args, settings, signal);
      this.emit(requestId, 'agentStage', { stage: 'tool_result', round, maxRounds, toolName: fn.name });
      this.emit(requestId, 'toolResult', {
        toolCallId: toolCall.id,
        name: fn.name,
        ok: true,
        output,
        ...buildToolContextOutput(fn.name, args, output),
        security: buildToolSecurity(fn.name, args, settings),
        autoApproved: decision.autoApproved === true,
      });
      return output;
    } catch (error) {
      const message = normalizeError(error);
      const returned = `工具 ${fn.name} 执行失败：${message}`;
      const nextAction = buildToolNextAction(fn.name, args, { failed: true, output: returned, error: message });
      this.emit(requestId, 'agentStage', {
        stage: 'tool_failed',
        round,
        maxRounds,
        toolName: fn.name,
        warning: message,
      });
      this.emit(requestId, 'toolResult', {
        toolCallId: toolCall.id,
        name: fn.name,
        ok: false,
        output: message,
        nextAction,
        ...buildToolContextOutput(fn.name, args, returned),
        security: buildToolSecurity(fn.name, args, settings),
      });
      return returned;
    }
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
    const results = new Array(toolCalls.length);
    let parallelGroup = [];

    const flushParallelGroup = async () => {
      if (parallelGroup.length === 0) return;
      const group = parallelGroup;
      parallelGroup = [];
      this.emit(requestId, 'agentStage', {
        stage: 'tool_parallel',
        round,
        maxRounds,
        selectedTools: group.map((item) => item.toolCall.function?.name || 'unknown_tool'),
      });
      const settled = await Promise.allSettled(
        group.map((item) => this.handleToolCall(requestId, item.toolCall, settings, signal, round, maxRounds))
      );
      settled.forEach((result, offset) => {
        const { index, toolCall } = group[offset];
        results[index] = {
          toolCall,
          output:
            result.status === 'fulfilled'
              ? result.value
              : `工具 ${toolCall.function?.name || 'unknown_tool'} 执行失败：${normalizeError(result.reason)}`,
        };
      });
    };

    for (let index = 0; index < toolCalls.length; index++) {
      const toolCall = toolCalls[index];
      const signature = toolCallSignature(toolCall);
      if (seenToolCalls.has(signature)) {
        await flushParallelGroup();
        const blocked = `重复工具调用已抑制：${toolCall.function?.name || 'unknown_tool'}。请基于已有工具结果继续推理，或换用不同参数。`;
        warnings.push(blocked);
        this.emit(requestId, 'agentStage', {
          stage: 'tool_failed',
          round,
          maxRounds,
          toolName: toolCall.function?.name,
          warning: blocked,
        });
        this.emit(requestId, 'toolResult', {
          toolCallId: toolCall.id,
          name: toolCall.function?.name,
          ok: false,
          output: blocked,
        });
        results[index] = { toolCall, output: blocked };
        continue;
      }
      seenToolCalls.add(signature);
      this.emit(requestId, 'agentStage', { stage: 'tool', round, maxRounds, toolName: toolCall.function?.name });
      if (isParallelSafeToolCall(toolCall)) {
        parallelGroup.push({ index, toolCall });
        continue;
      }
      await flushParallelGroup();
      const output = await this.handleToolCall(requestId, toolCall, settings, signal, round, maxRounds);
      results[index] = { toolCall, output };
    }

    await flushParallelGroup();
    return results.filter(Boolean);
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
    return [...builtIn, ...mcpTools];
  }

  describeRisk(name, args, settings) {
    if (isMcpToolName(name)) return `将调用外部 MCP 工具：${name}。参数：${JSON.stringify(args || {}).slice(0, 300)}`;
    return describeToolRisk(name, args, settings);
  }
}

// buildAgentPlanSummary, buildResearchSearchPlan, normalizeResearchTopic,
// dedupeSearchPlan, buildPlanApprovalPolicy — extracted to ./agent-planner.ts

function attachPrefixProfile(usage, prefix, settings = {}) {
  usage.prefixFingerprint = prefix.prefixFingerprint;
  usage.prefixBytes = prefix.prefixBytes;
  usage.prefixTokens = prefix.prefixTokens;
  usage.cacheStabilityWarnings = prefix.cacheStabilityWarnings || [];
  usage.cacheStabilityReasons = prefix.cacheStabilityReasons || [];
  usage.cacheStabilityDetails = prefix.cacheStabilityDetails || {};
  usage.cacheProfile = {
    ...(prefix.profile || {}),
    model: String(settings.model || prefix.profile?.model || ''),
    cacheHit: usage.cacheHit,
    cacheMiss: usage.cacheMiss,
    cacheHitRate: usage.cacheHitRate,
    estimatedCostUsd: usage.cost?.estimatedCostUsd || 0,
    estimatedSavingsUsd: usage.cost?.estimatedSavingsUsd || 0,
    cacheStabilityWarnings: prefix.cacheStabilityWarnings || [],
    cacheStabilityReasons: prefix.cacheStabilityReasons || [],
    cacheStabilityDetails: prefix.cacheStabilityDetails || {},
  };
  return usage;
}

function applyRequestOverrides(settings, overrides = {}) {
  const next = { ...settings };
  if (overrides.thinkingBudget !== undefined) next.thinkingBudget = Number.parseInt(overrides.thinkingBudget, 10) || 0;
  if (overrides.activeSkill !== undefined) next.activeSkill = String(overrides.activeSkill || 'none');
  if (overrides.enhance !== undefined) next.enhance = overrides.enhance !== false;
  if (overrides.agentMaxRounds !== undefined)
    next.agentMaxRounds = Number.parseInt(overrides.agentMaxRounds, 10) || DEFAULT_AGENT_MAX_ROUNDS;
  if (overrides.maxInputTokens !== undefined)
    next.maxInputTokens = Number.parseInt(overrides.maxInputTokens, 10) || DEFAULT_MAX_INPUT_TOKENS;
  if (overrides.agentExecutionMode !== undefined)
    next.agentExecutionMode = normalizeAgentExecutionMode(overrides.agentExecutionMode);
  return next;
}

function normalizeAgentExecutionMode(value) {
  const mode = String(value || 'execute_all');
  return AGENT_EXECUTION_MODES.has(mode) ? mode : 'execute_all';
}

function buildSingleStepStopReason(toolResults = []) {
  const names = (Array.isArray(toolResults) ? toolResults : [])
    .map(({ toolCall }) => toolCall?.function?.name || 'unknown_tool')
    .filter(Boolean);
  const summary = names.length ? `已完成单步执行：${names.join(', ')}。` : '已完成单步执行。';
  return `${summary}已暂停后续工具轮次；可继续点击“单步执行”推进下一步，或点击“执行全部”让 Agent 按计划继续。`;
}

function buildToolNextAction(name, args = {}, outcome = {}) {
  const toolName = String(name || 'unknown_tool');
  if (outcome.parseError) {
    return '让模型重新发送合法 JSON 参数；不要执行空参数工具调用。';
  }
  if (outcome.denied) {
    if (outcome.timedOut) {
      return '确认超时后已停止该工具；可以重新点击执行，或改用“修改计划”减少本步工具调用。';
    }
    return '已按用户选择停止该工具；可以修改计划、换用低风险读取/搜索工具，或重新确认后继续。';
  }
  if (toolName === 'web_search') {
    return '检查 Tavily Key、网络连接和 query；必要时缩小关键词或降低 max_results 后重试。';
  }
  if (['index_workspace', 'list_files', 'search_workspace', 'read_symbol', 'read_file'].includes(toolName)) {
    const target = String(args.path || args.directory || args.root || args.symbol || args.query || '').trim();
    return target
      ? `确认工作区授权、路径/符号是否存在：${target.slice(0, 160)}；必要时先 list_files 或 search_workspace 定位。`
      : '确认工作区已授权；必要时先 list_files 或 search_workspace 定位目标文件。';
  }
  if (toolName === 'run_code') {
    return '查看 stderr/stdout 和退出码；必要时缩小代码片段、补充依赖前置条件，或改为只生成代码不运行。';
  }
  if (isMcpToolName(toolName)) {
    return '检查 MCP Server 是否在线、工具参数 schema 是否变化；可在设置中刷新 MCP 状态后重试。';
  }
  return '检查工具名称、参数和可用配置；必要时修改计划后重试。';
}

function parseToolArgs(raw) {
  return parseToolArgsDetailed(raw).args;
}

function buildToolContextOutput(toolName, args, output) {
  const raw = String(output || '');
  const contextOutput = compactToolOutputForContext(toolName, args, raw);
  return {
    contextOutput,
    rawOutputTokens: estimateTokens(raw),
    contextOutputTokens: estimateTokens(contextOutput),
    contextCompacted: contextOutput !== raw,
  };
}

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
