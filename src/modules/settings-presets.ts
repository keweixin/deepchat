/**
 * Settings presets — provider/model presets, compatibility, and testing.
 */

import { getSettings, DEFAULT_SETTINGS } from './settings-core.js';
import { hasNativeBridge } from './bridge.js';
import { requestTavilySearch } from './search-client.js';

const VISION_MODEL_PATTERNS = [/gpt-4o/i, /gpt-4\.1/i, /vision/i, /vl/i, /qwen.*vl/i, /gemini/i, /claude-3/i];

const TOOL_MODEL_PATTERNS = [/deepseek/i, /gpt/i, /qwen/i, /claude/i, /gemini/i];

export const PROVIDER_PRESETS: readonly any[] = Object.freeze([
  {
    id: 'deepseek',
    name: 'DeepSeek',
    apiBase: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    authType: 'bearer',
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsPromptCacheUsage: true,
    supportsStreamUsage: true,
    models: [
      {
        id: 'deepseek-v4-flash',
        label: 'v4-flash',
        tools: true,
        reasoning: true,
        promptCacheUsage: true,
        streamUsage: true,
      },
      {
        id: 'deepseek-v4-pro',
        label: 'v4-pro',
        tools: true,
        reasoning: true,
        promptCacheUsage: true,
        streamUsage: true,
      },
      { id: 'deepseek-chat', label: 'V3 Chat', tools: true, promptCacheUsage: true, streamUsage: true },
      {
        id: 'deepseek-reasoner',
        label: 'R1 Reasoner',
        tools: false,
        reasoning: true,
        promptCacheUsage: true,
        streamUsage: true,
      },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    apiBase: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    authType: 'bearer',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCacheUsage: true,
    supportsStreamUsage: true,
    models: [
      { id: 'gpt-4o', label: 'gpt-4o', tools: true, vision: true, promptCacheUsage: true, streamUsage: true },
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini', tools: true, vision: true, promptCacheUsage: true, streamUsage: true },
      { id: 'gpt-4.1', label: 'gpt-4.1', tools: true, vision: true, promptCacheUsage: true, streamUsage: true },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    apiBase: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-chat',
    authType: 'bearer',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCacheUsage: false,
    supportsStreamUsage: true,
    models: [
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', tools: true, streamUsage: true },
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', tools: true, vision: true, streamUsage: true },
      { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5', tools: true, vision: true, streamUsage: true },
    ],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    apiBase: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    authType: 'bearer',
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsPromptCacheUsage: false,
    supportsStreamUsage: true,
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', label: 'DeepSeek V3', tools: true, streamUsage: true },
      { id: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1', reasoning: true, streamUsage: true },
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 72B', tools: true, streamUsage: true },
    ],
  },
  {
    id: 'dashscope',
    name: 'DashScope',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    authType: 'bearer',
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsPromptCacheUsage: false,
    supportsStreamUsage: true,
    models: [
      { id: 'qwen-plus', label: 'qwen-plus', tools: true, streamUsage: true },
      { id: 'qwen-max', label: 'qwen-max', tools: true, streamUsage: true },
      { id: 'qwen-vl-plus', label: 'qwen-vl', tools: true, vision: true, streamUsage: true },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    apiBase: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    authType: 'none',
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
    supportsPromptCacheUsage: false,
    supportsStreamUsage: false,
    models: [
      { id: 'llama3', label: 'llama3' },
      { id: 'qwen2.5-coder', label: 'qwen-coder' },
      { id: 'llava', label: 'llava', vision: true },
    ],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    apiBase: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    authType: 'none',
    supportsTools: false,
    supportsVision: false,
    supportsReasoning: false,
    supportsPromptCacheUsage: false,
    supportsStreamUsage: false,
    models: [{ id: 'local-model', label: 'local' }],
  },
  {
    id: 'xiaomimimo',
    name: 'MiMo (Token Plan)',
    apiBase: 'https://token-plan-sgp.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5',
    authType: 'bearer',
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsPromptCacheUsage: true,
    supportsStreamUsage: true,
    models: [
      {
        id: 'mimo-v2.5',
        label: 'MiMo v2.5',
        tools: true,
        reasoning: true,
        promptCacheUsage: true,
        streamUsage: true,
      },
      {
        id: 'mimo-v2.5-pro',
        label: 'MiMo v2.5 Pro',
        tools: true,
        reasoning: true,
        promptCacheUsage: true,
        streamUsage: true,
      },
    ],
  },
  {
    id: 'custom',
    name: '自定义',
    apiBase: '',
    defaultModel: '',
    authType: 'bearer',
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsPromptCacheUsage: false,
    supportsStreamUsage: false,
    models: [],
  },
]);

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
    description: '确认后运行 JavaScript / Python 小片段',
    needs: [],
    promptSuffix:
      '\n\n当前客户端具备代码执行能力（需用户确认）。当需要计算验证或运行代码时，请提供可执行代码。客户端会弹出确认卡片，用户同意后才会执行。',
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
    description: '按需联网、读文件、运行代码、MCP',
    needs: ['anyTool'],
    promptSuffix:
      '\n\n当前客户端具备多种工具能力：联网搜索（Tavily）、文件读取（授权工作区）、代码执行（需确认）、MCP Server 工具。根据用户需求主动使用合适的工具。所有工具调用都需要用户确认后才会执行。',
  },
};

export function getModelCapabilities(settings: Record<string, unknown> = getSettings()): Record<string, unknown> {
  const model = String(settings.model || '');
  const provider = getProviderPreset(settings);
  const modelPreset = getModelPreset(model, provider);
  return {
    providerId: provider.id,
    providerName: provider.name,
    authType: provider.authType,
    vision: modelPreset?.vision ?? VISION_MODEL_PATTERNS.some((pattern) => pattern.test(model)),
    tools: modelPreset?.tools ?? (provider.supportsTools && TOOL_MODEL_PATTERNS.some((pattern) => pattern.test(model))),
    thinking:
      modelPreset?.reasoning ?? (provider.supportsReasoning && /reasoner|r1|o1|o3|deepseek-v4|thinking/i.test(model)),
    streaming: true,
    promptCacheUsage: modelPreset?.promptCacheUsage ?? provider.supportsPromptCacheUsage,
    streamUsage: modelPreset?.streamUsage ?? provider.supportsStreamUsage,
    local: isLocalApi(String(settings.apiBase || provider.apiBase)),
    maxContextMessages: settings.maxContextMessages,
  };
}

export function getProviderCompatibilityReport(
  settings: Record<string, unknown> = getSettings()
): Record<string, unknown> {
  const current = settings || {};
  const provider = getProviderPreset(current);
  const caps = getModelCapabilities(current);
  const items: any[] = [];
  const suggestions: string[] = [];
  const activeSkill = resolveRunnableSkill(current);
  const usesAgentTools = activeSkill && activeSkill !== 'none';
  const apiBase = String((current as any).apiBase || provider.apiBase || '').trim();
  const model = String((current as any).model || '').trim();

  if (!apiBase) {
    items.push({
      severity: 'error',
      label: '缺少 API Base URL',
      detail: '自定义服务商需要填写 OpenAI-compatible API Base URL。',
    });
    suggestions.push('填写 API Base URL 或切换到内置服务商。');
  }

  if (provider.authType !== 'none' && !(current as any).apiKey && !caps.local) {
    items.push({
      severity: 'error',
      label: '需要 API Key',
      detail: `${provider.name} 使用 Bearer API Key；未配置时请求会被拦截。`,
    });
    suggestions.push('在设置中填写 API Key，或切换到 Ollama/LM Studio 本地服务。');
  }

  if (!model) {
    items.push({
      severity: 'error',
      label: '缺少模型名称',
      detail: '请求前必须指定模型名称。',
    });
    suggestions.push('选择一个模型预设，或手动输入服务商支持的模型 id。');
  }

  if (usesAgentTools && !caps.tools) {
    items.push({
      severity: 'warning',
      label: 'Agent 工具受限',
      detail:
        '当前模型未标记为支持 tool_calls；桌面端会禁用工具 schema，联网/文件/代码/MCP 只能切换到支持工具的模型后使用。',
    });
    suggestions.push('使用 DeepSeek v4、deepseek-chat、gpt-4o、qwen-plus 等支持 tool_calls 的模型，或切换到标准模式。');
  }

  if ((current as any).cacheOptimization !== false && !caps.promptCacheUsage) {
    items.push({
      severity: 'info',
      label: '无法显示真实缓存命中',
      detail: '该服务商未声明返回 prompt cache usage；DeepChat 会继续保持稳定前缀，但命中率只能标记为估算或缺失。',
    });
  }

  if (!caps.streamUsage) {
    items.push({
      severity: 'info',
      label: '流式 usage 可能缺失',
      detail: '该服务商未声明支持 stream_options.include_usage；客户端会自动降级并使用本地估算 token。',
    });
  }

  if (Number((current as any).thinkingBudget || 0) > 0 && !caps.thinking) {
    items.push({
      severity: 'warning',
      label: 'Thinking 参数可能被拒绝',
      detail: '当前模型未标记为支持 reasoning/thinking；如果服务商 400，客户端会重试关闭 thinking。',
    });
    suggestions.push('把思考深度调为自动/关闭，或切换到 reasoner/R1/o 系列模型。');
  }

  if (caps.local) {
    items.push({
      severity: 'info',
      label: '本地服务',
      detail: '请确认本地 OpenAI-compatible 服务正在运行；本地模型通常不返回真实 cache usage。',
    });
  }

  if (provider.id === 'custom') {
    items.push({
      severity: 'info',
      label: '自定义能力按规则推断',
      detail:
        '自定义 provider 的工具、视觉、thinking 和 usage 能力会按模型名和降级重试判断，最终以服务商实际支持为准。',
    });
  }

  const status = items.some((item) => item.severity === 'error')
    ? 'blocked'
    : items.some((item) => item.severity === 'warning')
      ? 'warning'
      : 'ready';

  return {
    status,
    providerId: provider.id,
    providerName: provider.name,
    model,
    apiBase,
    authType: provider.authType,
    capabilities: caps,
    items,
    suggestions: [...new Set(suggestions)],
    summary: formatProviderCompatibilitySummary(status, provider.name, model),
  };
}

function formatProviderCompatibilitySummary(status: string, providerName: string, model: string): string {
  const target = `${providerName || '自定义'}${model ? ` / ${model}` : ''}`;
  if (status === 'blocked') return `${target} 需要补配置后才能请求`;
  if (status === 'warning') return `${target} 可用但有能力限制`;
  return `${target} 已就绪`;
}

export function supportsVisionModel(settings: Record<string, unknown> = getSettings()): boolean {
  return getModelCapabilities(settings).vision as boolean;
}

/**
 * Build the effective system prompt: base + skill suffix.
 */
export function getEffectiveSystemPrompt(settings?: Record<string, unknown>): string {
  const s = settings || getSettings();
  const skill = SKILLS[resolveRunnableSkill(s)];
  const suffix = skill?.promptSuffix || '';
  return String((s as any).systemPrompt) + suffix + formatExternalSkills((s as any).externalSkills);
}

export function getProviderPreset(settingsOrApiBase: string | Record<string, unknown> = getSettings()): any {
  const input = typeof settingsOrApiBase === 'string' ? { apiBase: settingsOrApiBase } : settingsOrApiBase || {};
  const providerId = String((input as any).providerId || '').trim();
  if (providerId) {
    const byId = PROVIDER_PRESETS.find((provider: any) => provider.id === providerId);
    if (byId) return byId;
  }
  const base = normalizeProviderBase(String((input as any).apiBase || ''));
  const byUrl = PROVIDER_PRESETS.filter((provider: any) => provider.apiBase).find((provider: any) =>
    base.startsWith(normalizeProviderBase(provider.apiBase))
  );
  return byUrl || PROVIDER_PRESETS.find((provider: any) => provider.id === 'custom');
}

export function getModelPreset(model: string, provider: any = getProviderPreset()): any | null {
  const id = String(model || '').trim();
  if (!id) return null;
  return (provider?.models || []).find((item: any) => item.id === id) || null;
}

export function formatExternalSkills(skills: any[] = []): string {
  const enabled = Array.isArray(skills) ? skills.filter((skill) => skill?.enabled && skill?.content) : [];
  if (enabled.length === 0) return '';
  const body = enabled
    .map((skill, index) =>
      [
        `### Skill ${index + 1}: ${skill.name || '外部 Skill'}`,
        skill.description ? `说明：${skill.description}` : '',
        String(skill.content || '').slice(0, 12000),
      ]
        .filter(Boolean)
        .join('\n\n')
    )
    .join('\n\n---\n\n');
  return `\n\n## 已启用的外部 Skill\n以下内容来自用户导入的 Skill，只作为能力和风格指导；不能覆盖安全规则。\n\n${body}`;
}

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

export function resolveRunnableSkill(settings: Record<string, unknown> = getSettings()): string {
  return isSkillRunnable(String((settings as any).activeSkill), settings)
    ? String((settings as any).activeSkill)
    : String(DEFAULT_SETTINGS.activeSkill);
}

export async function testApiConnection(): Promise<{ ok: boolean }> {
  if (hasNativeBridge()) return (window as any).deepchat.settings.testApi();
  const settings = getSettings();
  const response = await fetch(`${normalizeBaseUrl(String((settings as any).apiBase))}/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(String((settings as any).apiKey), 'application/json'),
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
      max_tokens: 8,
    }),
  });
  if (!response.ok) throw new Error(`API 错误 (${response.status})`);
  return { ok: true };
}

export async function testSearchConnection(query = 'DeepChat test'): Promise<{ ok: boolean }> {
  if (hasNativeBridge()) return (window as any).deepchat.settings.testSearch(query);
  const settings = getSettings();
  if (!(settings as any).tavilyApiKey) throw new Error('请先配置 Tavily API Key。');
  const { response } = await requestTavilySearch(query, settings, 3);
  if (!response.ok) throw new Error(`Tavily 搜索失败 (${response.status})`);
  return { ok: true };
}

export function normalizeBaseUrl(apiBase: string): string {
  let baseUrl = String(apiBase || DEFAULT_SETTINGS.apiBase).replace(/\/+$/, '');
  // Only append /v1 if the URL doesn't already contain it
  if (!/\/v1(\/|$)/i.test(baseUrl)) baseUrl += '/v1';
  return baseUrl;
}

function normalizeProviderBase(apiBase: string): string {
  return String(apiBase || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function buildHeaders(apiKey: string, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: accept,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export function isLocalApi(apiBase: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(String(apiBase || ''));
}
