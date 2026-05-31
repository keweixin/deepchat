/**
 * API and settings facade.
 *
 * Electron runtime uses the preload bridge so secrets and external tools stay in
 * the main process. Browser preview keeps a localStorage/fetch fallback.
 */

import { uid } from './utils.js';
import { buildTavilySearchRequest } from '../../electron/search-utils.mjs';

import {
  getSettings,
  initApiSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
} from './settings-core.js';

import { hasNativeBridge } from './bridge.js';
import {
  API_TIMEOUT_MS,
  NATIVE_HEARTBEAT_INTERVAL_MS,
  NATIVE_HEARTBEAT_POLL_MS,
  NATIVE_FALLBACK_TIMEOUT_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
} from './constants.js';

/** Observability: count of malformed SSE fragments encountered */
let malformedSseCount = 0;

export function getMalformedSseStats() {
  const count = malformedSseCount;
  malformedSseCount = 0;
  return count;
}

import {
  extractContextMentions,
  appendContextHintsToUserContent,
  applyContextMentionsToMessages,
} from './context-mentions.js';

import {
  estimateTokens,
  estimateMessagesTokens,
  normalizeTokenUsage,
  mergeTokenUsage,
  buildContextWithBudget,
  buildContextBudgetBundle,
  getConversationUsageSummary,
} from './token-budget.js';

import { detectAgentIntent } from './tool-detector.js';

import {
  PROVIDER_PRESETS,
  getProviderPreset,
  getModelPreset,
  getModelCapabilities,
  getProviderCompatibilityReport,
  supportsVisionModel,
  resolveRunnableSkill,
  testApiConnection,
  testSearchConnection,
  getEffectiveSystemPrompt,
  formatExternalSkills,
} from './settings-presets.js';

import { browserWebSearch, normalizeBrowserTavilyResults, formatBrowserSearchResults } from './search-client.js';

import {
  normalizeBaseUrl,
  normalizeProviderBase,
  buildHeaders,
  isLocalApi,
  parseApiError,
  isUnsupportedParameterError,
} from './api-helpers.js';

import { clampNumber, findLatestUserIndex, getLastUserContent } from './shared-utils.js';

export { getSettings, initApiSettings, saveSettings, DEFAULT_SETTINGS, DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT };

export { hasNativeBridge };

export { extractContextMentions, appendContextHintsToUserContent, applyContextMentionsToMessages };

export {
  estimateTokens,
  estimateMessagesTokens,
  normalizeTokenUsage,
  mergeTokenUsage,
  buildContextWithBudget,
  buildContextBudgetBundle,
  getConversationUsageSummary,
};

export { detectAgentIntent };

export {
  PROVIDER_PRESETS,
  getProviderPreset,
  getModelPreset,
  getModelCapabilities,
  getProviderCompatibilityReport,
  supportsVisionModel,
  resolveRunnableSkill,
  testApiConnection,
  testSearchConnection,
  getEffectiveSystemPrompt,
  formatExternalSkills,
};

export { browserWebSearch, normalizeBrowserTavilyResults, formatBrowserSearchResults };

export {
  normalizeBaseUrl,
  normalizeProviderBase,
  buildHeaders,
  isLocalApi,
  parseApiError,
  isUnsupportedParameterError,
};

export { clampNumber };

export { buildTavilySearchRequest };

export const SKILLS: Record<
  string,
  { name: string; icon: string; description: string; needs: string[]; promptSuffix: string }
> = {
  agent_auto: {
    name: '智能 Agent',
    icon: '✦',
    description: '自动判断是否需要联网、读文件、运行代码或 MCP',
    needs: [],
    promptSuffix:
      '\n\n当前客户端启用了智能 Agent。你需要先判断是否需要工具：最新事实用联网搜索，本地资料用文件工具，代码验证用代码工具，外部系统用 MCP。所有工具调用都必须等待用户确认；缺少配置时说明需要配置什么。',
  },
  none: {
    name: '标准',
    icon: '💬',
    description: '日常问答，不调用外部工具',
    needs: [],
    promptSuffix: '',
  },
  web_search: {
    name: '联网检索',
    icon: '🌐',
    description: '使用 Tavily 搜索网页并带来源回答',
    needs: ['tavilyApiKey'],
    promptSuffix:
      '\n\n当前客户端具备联网搜索能力（Tavily）。当问题需要最新信息或你不确定事实时，请明确说明你需要搜索，客户端会自动调用搜索工具并将结果提供给你。基于搜索结果回答时请标注信息来源。',
  },
  file_reader: {
    name: '文件分析',
    icon: '📄',
    description: '读取已授权工作区内的文本文件',
    needs: ['workspaceRoots'],
    promptSuffix:
      '\n\n当前客户端具备文件读取能力。用户提到文件或符号时，客户端会在授权工作区内建立索引、查找并提供带 file:line 的内容；遇到函数/类/变量名或 @symbol 时优先按符号读取定义块。请基于实际提供的文件内容进行分析，不要假装已读取文件。',
  },
  code_runner: {
    name: '代码运行',
    icon: '▶',
    description: '确认后运行代码或预览安全编辑',
    needs: [],
    promptSuffix:
      '\n\n当前客户端具备代码执行能力和受控文件编辑能力（均需用户确认）。需要计算验证时提供可执行代码；需要修改文件时使用 SEARCH/REPLACE，并先读取目标上下文。客户端会弹出确认卡片，用户同意后才会执行。',
  },
  mcp_tool: {
    name: 'MCP',
    icon: '🔌',
    description: '调用外部 MCP Server 工具',
    needs: ['mcpServers'],
    promptSuffix:
      '\n\n当前客户端具备 MCP 工具能力。需要外部系统数据或操作时，可以调用已配置的 MCP 工具；所有 MCP 调用都需要用户确认后才会执行。',
  },
  multi_tool: {
    name: '全工具',
    icon: '🛠',
    description: '按需联网、读文件、运行代码、编辑文件、MCP',
    needs: ['anyTool'],
    promptSuffix:
      '\n\n当前客户端具备多种工具能力：联网搜索（Tavily）、文件读取（授权工作区）、代码执行（需确认）、受控文件编辑（需确认且备份）、MCP Server 工具。根据用户需求主动使用合适的工具。所有工具调用都需要用户确认后才会执行。',
  },
};

export function isSkillRunnable(id: string, settings: Record<string, unknown> = getSettings()): boolean {
  if (!id || !SKILLS[id]) return false;
  if (id === 'agent_auto') return true;
  if (id === 'none') return true;
  if (!hasNativeBridge()) {
    return id === 'web_search' && Boolean((settings as any).tavilyApiKey);
  }
  if (id === 'web_search') return Boolean((settings as any).tavilyApiKey);
  if (id === 'file_reader') return ((settings as any).workspaceRoots || []).length > 0;
  if (id === 'code_runner') return (settings as any).runCodeEnabled !== false;
  if (id === 'mcp_tool')
    return ((settings as any).mcpServers || []).some((server: any) => server?.enabled !== false && server?.command);
  if (id === 'multi_tool') return true;
  return true;
}

export function isEnhanceEnabledSetting(): boolean {
  return (getSettings() as any).enhance !== false;
}

export function trimContext(messages: any[], maxMessages = 20): any[] {
  return buildContextWithBudget(messages, {
    maxMessages,
    maxInputTokens: DEFAULT_SETTINGS.maxInputTokens as number,
  });
}

interface StreamChatOpts {
  requestId?: string;
  overrides?: Record<string, unknown>;
  contextSummary?: string;
  contextSummaryMeta?: unknown;
  cacheProfile?: unknown;
  signal?: AbortSignal;
  onToken?: (token: string) => void;
  onThinking?: (token: string) => void;
  onTokenCount?: (usage: unknown) => void;
  onToolRequest?: (event: unknown) => void;
  onToolResult?: (event: unknown) => void;
  onAgentStage?: (event: unknown) => void;
  onContextBudget?: (meta: unknown) => void;
  onContextSummary?: (event: unknown) => void;
  onDone?: (event?: unknown) => void;
  onError?: (error: Error) => void;
}

export async function streamChat(messages: any[], opts: StreamChatOpts = {}): Promise<void> {
  const settings = applyComposerOverrides(getSettings(), opts.overrides || {});
  const preparedMessages = applyContextMentionsToMessages(messages, settings);
  if (hasNativeBridge()) return streamNativeChat(preparedMessages, opts);
  return streamBrowserChat(preparedMessages, opts);
}

export function approveToolRequest(requestId: string, toolCallId: string, approved: boolean): void {
  if (hasNativeBridge()) (window as any).deepchat.tools.approve(requestId, toolCallId, approved);
}

let activeRequestId: string | null = null;

export function getActiveRequestId(): string | null {
  return activeRequestId;
}

export function pauseAgent(requestId: string): void {
  if (hasNativeBridge()) (window as any).deepchat.chat.pause(requestId);
}

export function resumeAgent(requestId: string): void {
  if (hasNativeBridge()) (window as any).deepchat.chat.resume(requestId);
}

export function skipToolAgent(requestId: string, toolCallId: string): void {
  if (hasNativeBridge()) (window as any).deepchat.chat.skipTool(requestId, toolCallId);
}

export function limitScopeAgent(requestId: string, scopePolicy: string): void {
  if (hasNativeBridge()) (window as any).deepchat.chat.limitScope(requestId, scopePolicy);
}

export async function runTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!hasNativeBridge()) throw new Error('工具执行只能在桌面版使用。');
  return (window as any).deepchat.tools.run(name, args);
}

function streamNativeChat(messages: any[], opts: StreamChatOpts): void {
  const requestId = opts.requestId || uid();
  activeRequestId = requestId;
  let settled = false;
  let lastTokenTime = Date.now();

  const unsubscribe = (window as any).deepchat.chat.onEvent((event: any) => {
    if (!event || event.requestId !== requestId) return;
    if (event.type === 'token') {
      lastTokenTime = Date.now();
      opts.onToken?.(event.token);
    }
    if (event.type === 'thinking') {
      lastTokenTime = Date.now();
      opts.onThinking?.(event.token);
    }
    if (event.type === 'tokenCount') {
      const { type: _type, requestId: _requestId, ...usageEvent } = event;
      opts.onTokenCount?.(event.usage || usageEvent);
    }
    if (event.type === 'toolRequest') opts.onToolRequest?.(event);
    if (event.type === 'toolResult') opts.onToolResult?.(event);
    if (event.type === 'agentStage') opts.onAgentStage?.(event);
    if (event.type === 'contextBudget') opts.onContextBudget?.(event);
    if (event.type === 'contextSummary') opts.onContextSummary?.(event);
    if (event.type === 'done') {
      settled = true;
      activeRequestId = null;
      unsubscribe();
      clearTimeout(fallbackTimer);
      clearInterval(heartbeatTimer);
      removeAbortListener();
      opts.onDone?.(event);
    }
    if (event.type === 'error') {
      settled = true;
      activeRequestId = null;
      unsubscribe();
      clearTimeout(fallbackTimer);
      clearInterval(heartbeatTimer);
      removeAbortListener();
      opts.onError?.(new Error(event.message || '未知错误'));
    }
  });

  const abort = () => {
    if (!settled) {
      settled = true;
      activeRequestId = null;
      unsubscribe();
      clearTimeout(fallbackTimer);
      clearInterval(heartbeatTimer);
      (window as any).deepchat.chat.cancel(requestId);
    }
  };
  opts.signal?.addEventListener('abort', abort, { once: true });
  const removeAbortListener = () => opts.signal?.removeEventListener('abort', abort);

  // Heartbeat: if no token/thinking for 30s, main process may be unresponsive
  const heartbeatTimer = setInterval(() => {
    if (settled) return;
    if (Date.now() - lastTokenTime > NATIVE_HEARTBEAT_INTERVAL_MS) {
      settled = true;
      unsubscribe();
      clearTimeout(fallbackTimer);
      clearInterval(heartbeatTimer);
      removeAbortListener();
      opts.onError?.(new Error('主进程响应超时，请检查服务状态'));
    }
  }, NATIVE_HEARTBEAT_POLL_MS);

  // Fallback: if main process never sends done/error, clean up after 10 min
  const fallbackTimer = setTimeout(() => {
    if (!settled) {
      settled = true;
      unsubscribe();
      clearInterval(heartbeatTimer);
      removeAbortListener();
    }
  }, NATIVE_FALLBACK_TIMEOUT_MS);

  (window as any).deepchat.chat.start({
    requestId,
    messages,
    overrides: opts.overrides || {},
    contextSummary: opts.contextSummary || '',
    contextSummaryMeta: opts.contextSummaryMeta || null,
    cacheProfile: opts.cacheProfile || null,
  });
}

async function streamBrowserChat(messages: any[], opts: StreamChatOpts = {}): Promise<void> {
  const settings = applyComposerOverrides(getSettings(), opts.overrides || {});
  if (!(settings as any).apiKey && !isLocalApi(String((settings as any).apiBase))) {
    opts.onError?.(new Error('请先在设置中配置 API Key'));
    return;
  }

  const hasImageAttachments = messages.some(
    (msg) => Array.isArray(msg.attachments) && msg.attachments.some(isImageAttachment)
  );
  if (!supportsVisionModel(settings) && hasImageAttachments) {
    opts.onError?.(
      new Error(`当前模型 ${(settings as any).model} 未标记为支持图片输入，请切换到 vision 模型后再发送图片。`)
    );
    return;
  }

  const cleanMessages = messages.map(normalizeClientMessage).filter(Boolean);
  const contextBundle = buildContextBudgetBundle(cleanMessages, {
    maxMessages: (settings as any).maxContextMessages,
    maxInputTokens: (settings as any).maxInputTokens,
  });
  opts.onContextBudget?.(contextBundle.meta);
  const trimmedMessages = contextBundle.messages;
  let requestMessages = trimmedMessages;
  const intent =
    (settings as any).activeSkill === 'agent_auto'
      ? detectAgentIntent(trimmedMessages, settings)
      : { toolMode: (settings as any).activeSkill, selectedTools: [], missingPrerequisites: [] };
  opts.onAgentStage?.({
    stage: 'plan',
    round: 0,
    maxRounds: (settings as any).agentMaxRounds,
    intent,
    selectedTools: intent.selectedTools || [],
    missingPrerequisites: intent.missingPrerequisites || [],
  });

  if (
    ((settings as any).activeSkill === 'web_search' ||
      intent.toolMode === 'web_search' ||
      intent.toolMode === 'multi_tool') &&
    (settings as any).tavilyApiKey
  ) {
    const searchQuery = getLastUserContent(trimmedMessages);
    if (searchQuery) {
      try {
        const toolCallId = uid();
        const search = await browserWebSearch(searchQuery, settings);
        opts.onToolResult?.({
          toolCallId,
          name: 'web_search',
          args: search.request.payload,
          risk: `已使用 Tavily 搜索网络：${search.request.payload.query.slice(0, 120)}`,
          ok: true,
          output: search.output,
        });
        requestMessages = [
          ...trimmedMessages,
          {
            role: 'system',
            content: [
              '本轮已经执行 Tavily 联网搜索。',
              '必须只基于下面的 Tavily 搜索结果回答；不要使用训练数据补充新闻事实。',
              '如果结果不够新或不匹配用户要求，要直接说明没有检索到符合要求的近期结果。',
              '回答中必须包含来源 URL。',
              '',
              search.output,
            ].join('\n'),
          },
        ];
      } catch (error) {
        if ((settings as any).activeSkill === 'web_search') {
          opts.onError?.(error as Error);
          return;
        }
      }
    }
  }

  const body: Record<string, unknown> = {
    model: (settings as any).model,
    messages: [{ role: 'system', content: getEffectiveSystemPrompt(settings) }, ...requestMessages.map(toApiMessage)],
    stream: true,
    stream_options: { include_usage: true },
    temperature: (settings as any).temperature,
    max_tokens: (settings as any).maxTokens,
  };

  // Thinking budget injection (browser mode)
  const modelLower = String((settings as any).model).toLowerCase();
  if (modelLower.includes('reasoner') || modelLower.includes('o1') || modelLower.includes('r1')) {
    (body as any).thinking = { type: 'enabled' };
    if ((settings as any).thinkingBudget > 0) (body as any).thinking.budget_tokens = (settings as any).thinkingBudget;
  } else if ((settings as any).thinkingBudget > 0) {
    (body as any).thinking = { type: 'enabled', budget_tokens: (settings as any).thinkingBudget };
  }

  const inputTokens = estimateMessagesTokens(body.messages as any[]);
  let fullOutput = '';
  let doneCalled = false;
  let providerUsage: unknown = null;
  const warnings: string[] = [];

  function callDone(output: string, meta: Record<string, unknown> = {}) {
    if (doneCalled) return;
    doneCalled = true;
    const usage = normalizeTokenUsage(providerUsage as Record<string, unknown>, {
      input: inputTokens,
      output: estimateTokens(output),
      warnings,
      model: (settings as any).model,
      byPurpose: { main: inputTokens + estimateTokens(output) },
    });
    opts.onTokenCount?.(usage);
    opts.onDone?.(meta);
  }

  try {
    const { response, warnings: fallbackWarnings } = await fetchBrowserChatCompletionWithFallback(
      settings,
      body,
      opts.signal
    );
    warnings.push(...fallbackWarnings);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      opts.onError?.(new Error(parseApiError(response.status, errorText)));
      return;
    }

    if (!response.body) {
      opts.onError?.(new Error('Response body is unavailable (network or proxy issue)'));
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          callDone(fullOutput);
          return;
        }
        try {
          const json = JSON.parse(data);
          if (json.usage) providerUsage = normalizeTokenUsage(json.usage, { model: (settings as any).model });
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            fullOutput += delta.content;
            opts.onToken?.(delta.content);
          }
          if (delta?.reasoning_content) opts.onThinking?.(delta.reasoning_content);
        } catch {
          // Track malformed SSE for observability
          malformedSseCount++;
        }
      }
    }

    callDone(fullOutput);
  } catch (err: any) {
    if (err.name === 'AbortError') callDone(fullOutput, { aborted: true });
    else opts.onError?.(err);
  }
}

/** Fetch with independent timeout guard (30s default) */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);

  if (init.signal) {
    init.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        controller.abort();
      },
      { once: true }
    );
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Exponential backoff with jitter: min(1000 * 2^attempt + random, 8000) */
function getRetryDelay(attempt: number): number {
  const base = 1000 * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return Math.min(base + jitter, 8000);
}

async function fetchBrowserChatCompletionWithFallback(
  settings: Record<string, unknown>,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ response: Response; warnings: string[] }> {
  const warnings: string[] = [];
  let currentBody = { ...body };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchWithTimeout(
        `${normalizeBaseUrl(String((settings as any).apiBase))}/chat/completions`,
        {
          method: 'POST',
          headers: buildHeaders(String((settings as any).apiKey), 'text/event-stream'),
          body: JSON.stringify(currentBody),
          signal,
        }
      );
      if (response.ok) return { response, warnings };
      const errorText = await response.text().catch(() => '');
      if (
        response.status === 400 &&
        currentBody.stream_options &&
        isUnsupportedParameterError(errorText, 'stream_options')
      ) {
        currentBody = { ...currentBody };
        delete currentBody.stream_options;
        warnings.push('当前服务商不支持 stream_options.include_usage，已自动重试并使用本地估算 token。');
        continue;
      }
      if (response.status === 400 && currentBody.thinking && isUnsupportedParameterError(errorText, 'thinking')) {
        currentBody = { ...currentBody };
        delete currentBody.thinking;
        warnings.push('当前服务商不支持 thinking 参数，已自动关闭思考预算后重试。');
        continue;
      }
      return { response, warnings };
    } catch (err: any) {
      const isLastAttempt = attempt === 2;
      if (isLastAttempt) throw err;
      if (err.message?.includes('timeout')) {
        warnings.push(`请求超时，${Math.round(getRetryDelay(attempt) / 1000)}秒后重试…`);
      }
      await new Promise((r) => setTimeout(r, getRetryDelay(attempt)));
    }
  }
  throw new Error('API 请求参数降级后仍然失败。');
}

function applyComposerOverrides(settings: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const next = { ...settings };
  if (overrides.thinkingBudget !== undefined)
    (next as any).thinkingBudget = Number.parseInt(String(overrides.thinkingBudget), 10) || 0;
  if (overrides.activeSkill !== undefined) (next as any).activeSkill = String(overrides.activeSkill || 'none');
  if (overrides.enhance !== undefined) (next as any).enhance = overrides.enhance !== false;
  if (overrides.agentMaxRounds !== undefined)
    (next as any).agentMaxRounds =
      Number.parseInt(String(overrides.agentMaxRounds), 10) || DEFAULT_SETTINGS.agentMaxRounds;
  if (overrides.maxInputTokens !== undefined)
    (next as any).maxInputTokens =
      Number.parseInt(String(overrides.maxInputTokens), 10) || DEFAULT_SETTINGS.maxInputTokens;
  if (overrides.agentExecutionMode !== undefined)
    (next as any).agentExecutionMode = String(overrides.agentExecutionMode || 'execute_all');
  return next;
}

function normalizeClientMessage(message: any): any | null {
  if (!message || (message.role !== 'user' && message.role !== 'assistant')) return null;
  const content = typeof message.content === 'string' ? message.content : '';
  const attachments = Array.isArray(message.attachments) ? message.attachments.filter(isImageAttachment) : [];
  if (!content.trim() && attachments.length === 0) return null;
  return {
    role: message.role,
    content,
    attachments: message.role === 'user' ? attachments : [],
  };
}

function toApiMessage(message: any): any {
  if (message.role !== 'user' || !message.attachments?.length) {
    return { role: message.role, content: message.content };
  }
  return {
    role: 'user',
    content: [
      { type: 'text', text: message.content || '请分析这张图片。' },
      ...message.attachments.map((attachment: any) => ({
        type: 'image_url',
        image_url: { url: attachment.dataUrl || attachment.url },
      })),
    ],
  };
}

function isImageAttachment(attachment: any): boolean {
  const mime = String(attachment?.mimeType || attachment?.type || '');
  return Boolean((attachment?.dataUrl || attachment?.url) && mime.startsWith('image/'));
}
