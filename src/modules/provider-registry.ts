/**
 * Provider Registry — Structured model capability registry
 *
 * Complements api.js getModelCapabilities() with:
 * - Declarative provider definitions
 * - UI-friendly capability matrices
 * - Tool-unavailable reason strings
 */

// ─── Provider Definitions ──────────────────────────────────────────────────

export const PROVIDER_REGISTRY = Object.freeze([
  {
    id: 'deepseek',
    name: 'DeepSeek',
    authType: 'bearer',
    apiBase: 'https://api.deepseek.com',
    supportsNativeTools: true,
    supportsReasoning: true,
    supportsStreamUsage: true,
    supportsJsonMode: true,
    supportsPromptCacheUsage: true,
    maxContextTokens: 64000,
    toolCallFormat: 'openai-compatible',
    models: [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        maxTokens: 64000,
        pricing: { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        maxTokens: 64000,
        pricing: { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
        reasoning: true,
      },
    ],
    knownIssues: ['reasoner + tools 不能同时使用'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    authType: 'bearer',
    apiBase: 'https://api.openai.com',
    supportsNativeTools: true,
    supportsReasoning: false,
    supportsStreamUsage: true,
    supportsJsonMode: true,
    supportsPromptCacheUsage: false,
    maxContextTokens: 128000,
    toolCallFormat: 'openai-compatible',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', maxTokens: 128000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', maxTokens: 128000 },
      { id: 'o1', name: 'o1', maxTokens: 128000, reasoning: true },
      { id: 'o3-mini', name: 'o3-mini', maxTokens: 128000, reasoning: true },
    ],
    knownIssues: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    authType: 'bearer',
    apiBase: 'https://api.anthropic.com',
    supportsNativeTools: true,
    supportsReasoning: true,
    supportsStreamUsage: true,
    supportsJsonMode: true,
    supportsPromptCacheUsage: true,
    maxContextTokens: 200000,
    toolCallFormat: 'anthropic-messages',
    models: [
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', maxTokens: 200000 },
      { id: 'claude-3-opus', name: 'Claude 3 Opus', maxTokens: 200000 },
      { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet', maxTokens: 200000 },
    ],
    knownIssues: [],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    authType: 'bearer',
    apiBase: 'https://generativelanguage.googleapis.com',
    supportsNativeTools: true,
    supportsReasoning: false,
    supportsStreamUsage: true,
    supportsJsonMode: true,
    supportsPromptCacheUsage: false,
    maxContextTokens: 1000000,
    toolCallFormat: 'google-function-calling',
    models: [
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', maxTokens: 1000000 },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', maxTokens: 1000000 },
    ],
    knownIssues: [],
  },
  {
    id: 'custom',
    name: '自定义服务商',
    authType: 'bearer',
    apiBase: '',
    supportsNativeTools: true,
    supportsReasoning: false,
    supportsStreamUsage: true,
    supportsJsonMode: true,
    supportsPromptCacheUsage: false,
    maxContextTokens: 128000,
    toolCallFormat: 'openai-compatible',
    models: [],
    knownIssues: ['需要手动确认工具支持'],
  },
]);

// ─── Lookup Helpers ─────────────────────────────────────────────────────────

export function getProviderById(id: string) {
  return PROVIDER_REGISTRY.find((p) => p.id === id) || null;
}

export function getProviderByModel(modelId: string) {
  if (!modelId) return null;
  const m = String(modelId).toLowerCase();
  for (const provider of PROVIDER_REGISTRY) {
    if (provider.models.some((mod) => m.includes(mod.id))) return provider;
    // Heuristic fallback
    if (m.includes(provider.id)) return provider;
  }
  return null;
}

export function getModelInfo(modelId: string, providerId?: string) {
  if (!modelId) return null;
  const provider = providerId ? getProviderById(providerId) : getProviderByModel(modelId);
  if (!provider) return null;
  const m = String(modelId).toLowerCase();
  const exact = provider.models.find((mod) => m === mod.id);
  if (exact) return { ...exact, providerId: provider.id, providerName: provider.name };
  // Fuzzy match
  const fuzzy = provider.models.find((mod) => m.includes(mod.id));
  if (fuzzy) return { ...fuzzy, providerId: provider.id, providerName: provider.name };
  return {
    id: modelId,
    name: modelId,
    providerId: provider.id,
    providerName: provider.name,
    maxTokens: provider.maxContextTokens,
  };
}

// ─── Capability Queries ─────────────────────────────────────────────────────

/**
 * Get a human-readable reason why tools are unavailable
 * @param {Object} settings
 * @returns {string|null} null if tools are available
 */
export function getToolUnavailableReason(settings: Record<string, any> = {}) {
  const model = String(settings.model || '');
  if (!model) return '未选择模型';
  const provider = getProviderByModel(model);
  if (!provider) return null; // unknown provider — assume tools work
  if (!provider.supportsNativeTools) return `${provider.name} 不支持原生工具调用`;
  // Check known issues
  const issue = provider.knownIssues.find((i) => {
    if (i.includes('reasoner') && /reasoner|r1|o1|o3/i.test(model)) return true;
    return false;
  });
  if (issue) return issue;
  return null;
}

/**
 * Build a capability matrix for display
 * @param {Object} settings
 * @returns {Array<{label: string, value: string|boolean, ok: boolean}>}
 */
export function getCapabilityMatrix(settings: Record<string, any> = {}) {
  const model = String(settings.model || '');
  const provider = getProviderByModel(model);
  if (!provider) {
    return [
      { label: '原生工具', value: '未知', ok: true },
      { label: '流式用量', value: '未知', ok: true },
      { label: 'JSON 模式', value: '未知', ok: true },
    ];
  }
  const modelInfo = getModelInfo(model, provider.id);
  return [
    { label: '服务商', value: provider.name, ok: true },
    { label: '原生工具', value: provider.supportsNativeTools ? '支持' : '不支持', ok: provider.supportsNativeTools },
    { label: '推理模式', value: provider.supportsReasoning ? '支持' : '不支持', ok: provider.supportsReasoning },
    { label: '流式用量', value: provider.supportsStreamUsage ? '支持' : '不支持', ok: provider.supportsStreamUsage },
    { label: 'JSON 模式', value: provider.supportsJsonMode ? '支持' : '不支持', ok: provider.supportsJsonMode },
    {
      label: 'Prompt Cache',
      value: provider.supportsPromptCacheUsage ? '支持' : '不支持',
      ok: provider.supportsPromptCacheUsage,
    },
    {
      label: '最大上下文',
      value: modelInfo?.maxTokens ? `${(modelInfo.maxTokens / 1000).toFixed(0)}K` : '未知',
      ok: true,
    },
    { label: '工具格式', value: provider.toolCallFormat, ok: true },
  ];
}

/**
 * Get a compact badge string for the chat header
 * @param {Object} settings
 * @returns {string}
 */
export function getModelBadge(settings: Record<string, any> = {}) {
  const model = String(settings.model || '');
  const provider = getProviderByModel(model);
  if (!provider) return model || '未配置';
  const modelInfo = getModelInfo(model, provider.id);
  const parts = [modelInfo?.name || model];
  if (provider.supportsNativeTools) parts.push('🛠');
  if (provider.supportsReasoning && /reasoner|r1|o1|o3|thinking/i.test(model)) parts.push('🧠');
  return parts.join(' ');
}
