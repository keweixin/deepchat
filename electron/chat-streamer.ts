import { normalizeTokenUsage } from './usage-meter.js';
import { mergeToolCalls, compactToolCalls } from './stream-runner.js';
import { repairToolCallsFromText } from './tool-executor.js';
import { fetchChatCompletionWithFallback } from './provider-adapters.js';

async function streamOnce(requestId, messages, settings, tools, signal, emit) {
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
            emit(requestId, 'agentStage', { stage: 'tool_repair', round: 0, warning: repaired.warning });
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
            emit(requestId, 'token', { token: delta.content });
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

    const nativeToolCalls = compactToolCalls(toolCalls);
    const repaired =
      nativeToolCalls.length === 0 ? repairToolCallsFromText(content, thinking, tools) : { toolCalls: [], warning: '' };
    if (repaired.toolCalls.length > 0) {
      warnings.push(repaired.warning);
      emit(requestId, 'agentStage', { stage: 'tool_repair', round: 0, warning: repaired.warning });
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

module.exports = { streamOnce };
