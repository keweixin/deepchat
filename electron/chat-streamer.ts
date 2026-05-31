import { normalizeTokenUsage } from './usage-meter.js';
import { NEEDS_PRO_SIGNAL, mergeToolCalls, compactToolCalls } from './stream-runner.js';
import { repairToolCallsFromText } from './tool-executor.js';
import { fetchChatCompletionWithFallback } from './provider-adapters.js';

type StreamSettings = Record<string, any> & {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  agentModelTier?: string;
};

type EmitFn = (requestId: string, type: string, payload: Record<string, any>) => void;

async function streamOnce(
  requestId: string,
  messages: Array<Record<string, any>>,
  settings: StreamSettings,
  tools: Array<Record<string, any>>,
  signal: AbortSignal | undefined,
  emit: EmitFn
) {
  const baseBody: any = {
    model: settings.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
  };

  const modelLower = String(settings.model || '').toLowerCase();
  const thinkingBudget = Number(settings.thinkingBudget || 0);
  if (modelLower.includes('reasoner') || modelLower.includes('o1') || modelLower.includes('r1')) {
    baseBody.thinking = { type: 'enabled' };
    if (thinkingBudget > 0) baseBody.thinking.budget_tokens = thinkingBudget;
  } else if (thinkingBudget > 0) {
    baseBody.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }

  if (tools.length > 0) {
    baseBody.tools = tools;
    baseBody.tool_choice = 'auto';
  }

  const { response, warnings } = await fetchChatCompletionWithFallback(settings, baseBody, signal);
  if (!response.body) throw new Error('Provider response body is empty.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let visibleContent = '';
  let pendingVisibleContent = '';
  let needsPro = false;
  let thinking = '';
  let usage: any = null;
  const toolCalls: any[] = [];
  const watchNeedsPro = String(settings.agentModelTier || 'auto') === 'auto';

  const emitVisibleContent = (token: string) => {
    if (!token) return;
    visibleContent += token;
    emit(requestId, 'token', { token });
  };

  const handleContentDelta = (token: string) => {
    content += token;
    if (!watchNeedsPro) {
      emitVisibleContent(token);
      return;
    }

    pendingVisibleContent += token;
    if (pendingVisibleContent.includes(NEEDS_PRO_SIGNAL)) {
      needsPro = true;
      pendingVisibleContent = pendingVisibleContent.replaceAll(NEEDS_PRO_SIGNAL, '');
    }

    const keepLength = NEEDS_PRO_SIGNAL.length - 1;
    const flushLength = Math.max(0, pendingVisibleContent.length - keepLength);
    if (flushLength > 0) {
      emitVisibleContent(pendingVisibleContent.slice(0, flushLength));
      pendingVisibleContent = pendingVisibleContent.slice(flushLength);
    }
  };

  const finalizeVisibleContent = () => {
    if (pendingVisibleContent.includes(NEEDS_PRO_SIGNAL)) {
      needsPro = true;
      pendingVisibleContent = pendingVisibleContent.replaceAll(NEEDS_PRO_SIGNAL, '');
    }
    emitVisibleContent(pendingVisibleContent);
    pendingVisibleContent = '';
    return watchNeedsPro ? visibleContent.trim() : content;
  };

  try {
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
          const finalContent = finalizeVisibleContent();
          const nativeToolCalls = compactToolCalls(toolCalls);
          const repaired =
            nativeToolCalls.length === 0
              ? repairToolCallsFromText(finalContent, thinking, tools)
              : { toolCalls: [], warning: '', repairReport: null };
          if (repaired.toolCalls.length > 0) {
            warnings.push(repaired.warning);
            emit(requestId, 'agentStage', {
              stage: 'tool_repair',
              round: 0,
              warning: repaired.warning,
              repairReport: repaired.repairReport,
            });
          }
          return {
            content: finalContent,
            thinking,
            usage,
            toolCalls: repaired.toolCalls.length > 0 ? repaired.toolCalls : nativeToolCalls,
            warnings,
            repairReport: repaired.repairReport,
            needsPro,
          };
        }

        try {
          const json = JSON.parse(data);
          if (json.usage) usage = normalizeTokenUsage(json.usage, { model: settings.model });
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.content) {
            handleContentDelta(delta.content);
          }
          if (delta.reasoning_content) {
            thinking += delta.reasoning_content;
            emit(requestId, 'thinking', { token: delta.reasoning_content });
          }
          if (delta.tool_calls) mergeToolCalls(toolCalls, delta.tool_calls);
        } catch {
          // Ignore malformed SSE fragments from non-standard providers.
        }
      }
    }

    const finalContent = finalizeVisibleContent();
    const nativeToolCalls = compactToolCalls(toolCalls);
    const repaired =
      nativeToolCalls.length === 0
        ? repairToolCallsFromText(finalContent, thinking, tools)
        : { toolCalls: [], warning: '', repairReport: null };
    if (repaired.toolCalls.length > 0) {
      warnings.push(repaired.warning);
      emit(requestId, 'agentStage', {
        stage: 'tool_repair',
        round: 0,
        warning: repaired.warning,
        repairReport: repaired.repairReport,
      });
    }
    return {
      content: finalContent,
      thinking,
      usage,
      toolCalls: repaired.toolCalls.length > 0 ? repaired.toolCalls : nativeToolCalls,
      warnings,
      repairReport: repaired.repairReport,
      needsPro,
    };
  } finally {
    reader.releaseLock();
  }
}

export { streamOnce };
