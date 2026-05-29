// @ts-check
/**
 * Provider Adapters — API client, fallback logic, and provider capability detection
 *
 * Responsibilities:
 * - Build request headers
 * - Normalize API base URLs
 * - Fetch chat completions with parameter fallback (stream_options, thinking, tools)
 * - Detect provider tool support
 */

const { getSettings } = require('./storage');

function buildHeaders(apiKey) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function normalizeBaseUrl(apiBase) {
  let baseUrl = String(apiBase || 'https://api.deepseek.com').replace(/\/+$/, '');
  if (!baseUrl.endsWith('/v1') && !baseUrl.includes('/v1/')) baseUrl += '/v1';
  return baseUrl;
}

function normalizeError(error) {
  if (!error) return '未知错误';
  if (error.name === 'AbortError') return '请求已取消';
  const full = String(error.message || error);
  if (full.length > 1000) {
    console.error('[normalizeError] Truncated error:', full);
    return full.slice(0, 1000);
  }
  return full;
}

function parseApiError(status, text) {
  let message = `API 错误 (${status})`;
  try {
    const parsed = JSON.parse(text);
    message = parsed.error?.message || parsed.message || message;
  } catch {
    if (text) message = `${message}: ${text.slice(0, 500)}`;
  }
  return message;
}

function isUnsupportedParameterError(text, parameter) {
  const body = String(text || '').toLowerCase();
  return (
    body.includes(parameter.toLowerCase()) &&
    /unsupported|unknown|unrecognized|invalid|not support|不支持|未知|无效/.test(body)
  );
}

function isToolParameterError(text) {
  const body = String(text || '').toLowerCase();
  return (
    /(tools|tool_choice|function_call|tool_calls)/.test(body) &&
    /unsupported|unknown|unrecognized|invalid|not support|不支持|未知|无效/.test(body)
  );
}

async function testApiConnection() {
  const settings = await getSettings();
  const response = await fetch(`${normalizeBaseUrl(settings.apiBase)}/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(settings.apiKey),
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: 'Reply with OK.' },
        { role: 'user', content: 'ping' },
      ],
      stream: false,
      max_tokens: 8,
      temperature: 0,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(parseApiError(response.status, errorText));
  }
  return { ok: true };
}

async function fetchChatCompletionWithFallback(settings, body, signal) {
  const warnings = [];
  let currentBody = { ...body };
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${normalizeBaseUrl(settings.apiBase)}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(settings.apiKey),
      body: JSON.stringify(currentBody),
      signal,
    });
    if (response.ok) return { response, warnings };

    const errorText = await response.text().catch(() => '');
    const message = parseApiError(response.status, errorText);
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
    if (response.status === 400 && (currentBody.tools || currentBody.tool_choice) && isToolParameterError(errorText)) {
      throw new Error(
        `当前模型或服务商不支持工具调用参数，请切换支持工具调用的模型，或把回答模式改为"标准"。原始错误：${message}`
      );
    }
    throw new Error(message);
  }
  throw new Error('API 请求参数降级后仍然失败。');
}

function inferProviderIdFromBase(apiBase = '') {
  const base = String(apiBase || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
  if (base.startsWith('https://api.deepseek.com')) return 'deepseek';
  if (base.startsWith('https://api.openai.com/v1')) return 'openai';
  if (base.startsWith('https://openrouter.ai/api/v1')) return 'openrouter';
  if (base.startsWith('https://api.siliconflow.cn/v1')) return 'siliconflow';
  if (base.startsWith('https://dashscope.aliyuncs.com/compatible-mode/v1')) return 'dashscope';
  if (base.startsWith('https://token-plan-sgp.xiaomimimo.com')) return 'xiaomimimo';
  if (base.startsWith('https://token-plan.xiaomimimo.com')) return 'xiaomimimo';
  if (base.startsWith('http://localhost:11434/v1')) return 'ollama';
  if (base.startsWith('http://localhost:1234/v1')) return 'lmstudio';
  return 'custom';
}

function getProviderToolSupport(settings = {}) {
  const model = String(settings.model || '').trim();
  const lowerModel = model.toLowerCase();
  const provider = String(settings.providerId || inferProviderIdFromBase(settings.apiBase)).toLowerCase();
  const unsupportedProvider = provider === 'ollama' || provider === 'lmstudio';
  const unsupportedModel = provider === 'deepseek' && lowerModel === 'deepseek-reasoner';

  if (unsupportedProvider) {
    return {
      supported: false,
      reason: provider,
      warning: `当前服务商/模型（${provider || 'custom'} / ${model || 'unknown'}）未标记为支持 tool_calls，已禁用本轮工具 schema；请切换到支持工具调用的模型，或使用标准模式。`,
    };
  }

  if (unsupportedModel) {
    return {
      supported: false,
      reason: 'model_without_tools',
      warning: `当前模型 ${model} 未标记为支持 tool_calls，已禁用本轮工具 schema；需要工具型 Agent 时请切换到 deepseek-chat 或 DeepSeek v4 模型。`,
    };
  }

  return { supported: true, reason: 'supported', warning: '' };
}

function shouldWarnAboutToolSupport(settings = {}, intent = {}) {
  const activeSkill = String(settings.activeSkill || 'none');
  if (activeSkill && activeSkill !== 'none') return true;
  return Boolean((intent.selectedTools || []).length || (intent.candidateTools || []).length);
}

function filterStableBuiltInTools(tools, settings = {}) {
  return (tools || []).filter((tool) => {
    const name = tool?.function?.name;
    if (name === 'web_search') return Boolean(settings.tavilyApiKey);
    if (
      name === 'index_workspace' ||
      name === 'list_files' ||
      name === 'search_workspace' ||
      name === 'read_symbol' ||
      name === 'read_file'
    )
      return Array.isArray(settings.workspaceRoots) && settings.workspaceRoots.length > 0;
    if (name === 'run_code') return settings.runCodeEnabled !== false && settings.runCodeEnabled !== 'false';
    return true;
  });
}

module.exports = {
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
};
