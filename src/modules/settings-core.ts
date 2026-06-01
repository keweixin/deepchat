import { hasNativeBridge } from './bridge.ts';
import { getProviderPreset, PROVIDER_PRESETS } from './settings-presets.js';
import { clampNumber } from './shared-utils.js';

export const DEFAULT_SYSTEM_PROMPT = `你是一位专业、严谨且善于深度思考的AI助手。

## 回答原则
1. **准确性优先**：不确定的内容明确标注"不确定"，不编造事实。
2. **工具透明**：需要联网搜索、读取文件或运行代码时，必须通过客户端工具调用；没有工具结果时不要假装已经完成。
3. **实用导向**：回答要可执行、可落地，避免空泛建议。

## 格式规范
- 默认使用 Markdown，但按问题意图选择版式，不要每次套同一套固定标题。
- 简单问题：直接短答，不强行分节。
- 教程/操作：用清晰步骤，必要时补充注意点。
- 对比/选型：优先使用表格，最后给适用场景或取舍。
- 排障/错误：先给最可能原因，再给验证方法和修复步骤。
- 报告/分析：先给摘要，再展开依据、风险和建议。
- 代码：使用代码块并标注语言，先给可运行实现，再解释关键点。
- 数学公式使用 LaTeX（$行内$，$$块级$$）；流程/架构图使用 Mermaid。
- 有图表、流程图或图片时，先给一句用途说明，再输出图；不要用冗长文字掩盖图示重点。
- 需要可操作演示时，优先使用当前界面支持的 widget JSON 组件。
- 复杂回答可使用安全组件块增强可读性：:::summary 核心结论、:::warning 风险提醒、:::decision 推荐方案、:::steps 执行步骤、:::source 来源证据、:::todo 行动清单、:::next 下一步、:::tool-result 工具结果摘要；块内仍写 Markdown，不要输出原始 HTML。
- 涉及工具、文件、搜索或研究时，优先用 :::source 或 :::tool-result 汇总证据；涉及改造建议时，优先用 :::decision、:::steps 和 :::todo 给出可执行结论。

## 交互式组件
当前界面支持安全内置组件，不支持任意 HTML/JavaScript。用户明确要求"交互式组件""直接在界面操作""计算器/图表/物理演示"时，优先输出 widget 代码块：
\`\`\`widget
{ "type": "mortgage-calculator", "principal": 1000000, "rate": 4.2, "years": 30 }
\`\`\`
支持的 type：
- mortgage-calculator：房贷/月供计算器
- bar-chart：柱状图，data 为 [{ "label": "A", "value": 10 }]
- line-chart：折线图，data 为 [{ "label": "1月", "value": 10 }]
- projectile-demo：抛体运动演示，可传 velocity 和 angle

不要输出 <script>、onclick、iframe 或自定义 HTML 组件。`;

export const DEFAULT_MODEL = 'deepseek-v4-flash';

export const DEFAULT_SETTINGS: Record<string, unknown> = {
  apiKey: '',
  providerId: 'deepseek',
  apiBase: 'https://api.deepseek.com',
  model: DEFAULT_MODEL,
  temperature: 0.7,
  maxTokens: 4096,
  maxInputTokens: 24000,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxContextMessages: 20,
  agentMaxRounds: 3,
  thinkingBudget: 0,
  activeSkill: 'agent_auto',
  crewDisplayMode: 'auto',
  defaultComposerMode: 'daily',
  autoContextSummary: true,
  cacheOptimization: true,
  contextFoldEconomicsEnabled: true,
  codingEditsEnabled: true,
  agentModelTier: 'auto',
  interfaceDetailLevel: 'normal',
  toolApprovalTimeoutMs: 60000,
  toolApprovalPolicy: 'confirm_all',
  runCodeEnabled: true,
  enhance: true,
  tavilyApiKey: '',
  tavilyMaxResults: 5,
  tavilySearchDepth: 'basic',
  tavilyIncludeAnswer: false,
  tavilyIncludeRawContent: false,
  tavilyExtractTopResults: 0,
  tavilyChunksPerSource: 3,
  tavilyCacheTtlMinutes: 10,
  externalMcpDiscoveryEnabled: true,
  localSearchFallbackMode: 'missing_key',
  fallbackOnSearchError: false,
  docsetSearchEnabled: false,
  docsetRoots: [],
  workspaceRoots: [],
  externalSkills: [],
  mcpServers: [],
  storageStatus: { mode: 'browser', encryptionAvailable: false, dataDir: '' },
};

let settingsCache: Record<string, unknown> = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;

export async function initApiSettings(): Promise<Record<string, unknown>> {
  if (hasNativeBridge()) {
    await migrateLegacyStorage();
    settingsCache = normalizeSettings(await (window as any).deepchat.settings.get());
  } else {
    settingsCache = loadBrowserSettings();
  }
  settingsLoaded = true;
  return settingsCache;
}

export function getSettings(): Record<string, unknown> {
  if (!settingsLoaded && !hasNativeBridge()) settingsCache = loadBrowserSettings();
  return settingsCache;
}

export async function saveSettings(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  settingsCache = normalizeSettings({ ...settingsCache, ...patch });
  if (hasNativeBridge()) {
    settingsCache = normalizeSettings(await (window as any).deepchat.settings.set(patch));
  } else {
    saveBrowserSettings(patch);
  }
  settingsLoaded = true;
  emitSettingsChanged(settingsCache, patch);
  return settingsCache;
}

function emitSettingsChanged(settings: Record<string, unknown>, patch: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(
    new CustomEvent('deepchat:settings-changed', {
      detail: { settings, patch },
    })
  );
}

async function migrateLegacyStorage(): Promise<void> {
  if (localStorage.getItem('dc_nativeMigrated') === 'true') return;
  const settings: Record<string, unknown> = {};
  const map: Record<string, string> = {
    dc_apiKey: 'apiKey',
    dc_apiBase: 'apiBase',
    dc_model: 'model',
    dc_temperature: 'temperature',
    dc_maxTokens: 'maxTokens',
    dc_maxInputTokens: 'maxInputTokens',
    dc_systemPrompt: 'systemPrompt',
    dc_maxContext: 'maxContextMessages',
    dc_agentMaxRounds: 'agentMaxRounds',
    dc_toolApprovalTimeoutMs: 'toolApprovalTimeoutMs',
    dc_toolApprovalPolicy: 'toolApprovalPolicy',
    dc_thinkingBudget: 'thinkingBudget',
    dc_activeSkill: 'activeSkill',
    dc_cacheOptimization: 'cacheOptimization',
    dc_contextFoldEconomicsEnabled: 'contextFoldEconomicsEnabled',
    dc_codingEditsEnabled: 'codingEditsEnabled',
    dc_agentModelTier: 'agentModelTier',
    dc_interfaceDetailLevel: 'interfaceDetailLevel',
    dc_runCodeEnabled: 'runCodeEnabled',
    dc_autoContextSummary: 'autoContextSummary',
    dc_enhance: 'enhance',
    dc_tavilyApiKey: 'tavilyApiKey',
    dc_tavilyMaxResults: 'tavilyMaxResults',
    dc_tavilySearchDepth: 'tavilySearchDepth',
    dc_tavilyIncludeAnswer: 'tavilyIncludeAnswer',
    dc_tavilyIncludeRawContent: 'tavilyIncludeRawContent',
    dc_tavilyExtractTopResults: 'tavilyExtractTopResults',
    dc_tavilyChunksPerSource: 'tavilyChunksPerSource',
    dc_tavilyCacheTtlMinutes: 'tavilyCacheTtlMinutes',
    dc_externalMcpDiscoveryEnabled: 'externalMcpDiscoveryEnabled',
    dc_localSearchFallbackMode: 'localSearchFallbackMode',
    dc_fallbackOnSearchError: 'fallbackOnSearchError',
    dc_docsetSearchEnabled: 'docsetSearchEnabled',
  };
  for (const [storageKey, settingKey] of Object.entries(map)) {
    const value = localStorage.getItem(storageKey);
    if (value !== null && value !== '') (settings as any)[settingKey] = parseStoredValue(settingKey, value);
  }

  let conversations: any[] = [];
  const rawConversations = localStorage.getItem('dc_conversations');
  if (rawConversations) {
    try {
      conversations = JSON.parse(rawConversations);
    } catch {
      console.warn('Failed to parse stored conversations, resetting.');
      conversations = [];
    }
  }

  if (Object.keys(settings).length > 0 || conversations.length > 0) {
    await (window as any).deepchat.settings.migrateLegacy({ settings, conversations });
  }
  localStorage.removeItem('dc_apiKey');
  localStorage.removeItem('dc_tavilyApiKey');
  localStorage.setItem('dc_nativeMigrated', 'true');
}

function loadBrowserSettings(): Record<string, unknown> {
  return normalizeSettings({
    apiKey: localStorage.getItem('dc_apiKey') || '',
    providerId: localStorage.getItem('dc_providerId') || DEFAULT_SETTINGS.providerId,
    apiBase: localStorage.getItem('dc_apiBase') || DEFAULT_SETTINGS.apiBase,
    model: localStorage.getItem('dc_model') || DEFAULT_MODEL,
    temperature: parseFloat(localStorage.getItem('dc_temperature') || String(DEFAULT_SETTINGS.temperature)),
    maxTokens: parseInt(localStorage.getItem('dc_maxTokens') || String(DEFAULT_SETTINGS.maxTokens), 10),
    maxInputTokens: parseInt(localStorage.getItem('dc_maxInputTokens') || String(DEFAULT_SETTINGS.maxInputTokens), 10),
    systemPrompt: localStorage.getItem('dc_systemPrompt') || DEFAULT_SYSTEM_PROMPT,
    maxContextMessages: parseInt(
      localStorage.getItem('dc_maxContext') || String(DEFAULT_SETTINGS.maxContextMessages),
      10
    ),
    agentMaxRounds: parseInt(localStorage.getItem('dc_agentMaxRounds') || String(DEFAULT_SETTINGS.agentMaxRounds), 10),
    thinkingBudget: parseInt(localStorage.getItem('dc_thinkingBudget') || String(DEFAULT_SETTINGS.thinkingBudget), 10),
    activeSkill: localStorage.getItem('dc_activeSkill') || DEFAULT_SETTINGS.activeSkill,
    autoContextSummary: localStorage.getItem('dc_autoContextSummary') !== 'false',
    cacheOptimization: localStorage.getItem('dc_cacheOptimization') !== 'false',
    contextFoldEconomicsEnabled: localStorage.getItem('dc_contextFoldEconomicsEnabled') !== 'false',
    codingEditsEnabled: localStorage.getItem('dc_codingEditsEnabled') !== 'false',
    agentModelTier: localStorage.getItem('dc_agentModelTier') || DEFAULT_SETTINGS.agentModelTier,
    interfaceDetailLevel: localStorage.getItem('dc_interfaceDetailLevel') || DEFAULT_SETTINGS.interfaceDetailLevel,
    toolApprovalTimeoutMs: parseInt(
      localStorage.getItem('dc_toolApprovalTimeoutMs') || String(DEFAULT_SETTINGS.toolApprovalTimeoutMs),
      10
    ),
    toolApprovalPolicy: localStorage.getItem('dc_toolApprovalPolicy') || DEFAULT_SETTINGS.toolApprovalPolicy,
    runCodeEnabled: localStorage.getItem('dc_runCodeEnabled') !== 'false',
    enhance: localStorage.getItem('dc_enhance') !== 'false',
    tavilyApiKey: localStorage.getItem('dc_tavilyApiKey') || '',
    tavilyMaxResults: parseInt(
      localStorage.getItem('dc_tavilyMaxResults') || String(DEFAULT_SETTINGS.tavilyMaxResults),
      10
    ),
    tavilySearchDepth: localStorage.getItem('dc_tavilySearchDepth') || DEFAULT_SETTINGS.tavilySearchDepth,
    tavilyIncludeAnswer: localStorage.getItem('dc_tavilyIncludeAnswer') === 'true',
    tavilyIncludeRawContent: localStorage.getItem('dc_tavilyIncludeRawContent') === 'true',
    tavilyExtractTopResults: parseInt(
      localStorage.getItem('dc_tavilyExtractTopResults') || String(DEFAULT_SETTINGS.tavilyExtractTopResults),
      10
    ),
    tavilyChunksPerSource: parseInt(
      localStorage.getItem('dc_tavilyChunksPerSource') || String(DEFAULT_SETTINGS.tavilyChunksPerSource),
      10
    ),
    tavilyCacheTtlMinutes: parseInt(
      localStorage.getItem('dc_tavilyCacheTtlMinutes') || String(DEFAULT_SETTINGS.tavilyCacheTtlMinutes),
      10
    ),
    externalMcpDiscoveryEnabled: localStorage.getItem('dc_externalMcpDiscoveryEnabled') !== 'false',
    localSearchFallbackMode:
      localStorage.getItem('dc_localSearchFallbackMode') || DEFAULT_SETTINGS.localSearchFallbackMode,
    fallbackOnSearchError: localStorage.getItem('dc_fallbackOnSearchError') === 'true',
    docsetSearchEnabled: localStorage.getItem('dc_docsetSearchEnabled') === 'true',
    docsetRoots: safeJsonArray(localStorage.getItem('dc_docsetRoots')),
    workspaceRoots: safeJsonArray(localStorage.getItem('dc_workspaceRoots')),
    externalSkills: safeJsonArray(localStorage.getItem('dc_externalSkills')),
    mcpServers: [],
  });
}

function saveBrowserSettings(patch: Record<string, unknown>): void {
  const keys: Record<string, string> = {
    providerId: 'dc_providerId',
    apiBase: 'dc_apiBase',
    model: 'dc_model',
    temperature: 'dc_temperature',
    maxTokens: 'dc_maxTokens',
    maxInputTokens: 'dc_maxInputTokens',
    systemPrompt: 'dc_systemPrompt',
    maxContextMessages: 'dc_maxContext',
    agentMaxRounds: 'dc_agentMaxRounds',
    thinkingBudget: 'dc_thinkingBudget',
    activeSkill: 'dc_activeSkill',
    autoContextSummary: 'dc_autoContextSummary',
    cacheOptimization: 'dc_cacheOptimization',
    contextFoldEconomicsEnabled: 'dc_contextFoldEconomicsEnabled',
    codingEditsEnabled: 'dc_codingEditsEnabled',
    agentModelTier: 'dc_agentModelTier',
    interfaceDetailLevel: 'dc_interfaceDetailLevel',
    toolApprovalTimeoutMs: 'dc_toolApprovalTimeoutMs',
    toolApprovalPolicy: 'dc_toolApprovalPolicy',
    runCodeEnabled: 'dc_runCodeEnabled',
    enhance: 'dc_enhance',
    tavilyMaxResults: 'dc_tavilyMaxResults',
    tavilySearchDepth: 'dc_tavilySearchDepth',
    tavilyIncludeAnswer: 'dc_tavilyIncludeAnswer',
    tavilyIncludeRawContent: 'dc_tavilyIncludeRawContent',
    tavilyExtractTopResults: 'dc_tavilyExtractTopResults',
    tavilyChunksPerSource: 'dc_tavilyChunksPerSource',
    tavilyCacheTtlMinutes: 'dc_tavilyCacheTtlMinutes',
    externalMcpDiscoveryEnabled: 'dc_externalMcpDiscoveryEnabled',
    localSearchFallbackMode: 'dc_localSearchFallbackMode',
    fallbackOnSearchError: 'dc_fallbackOnSearchError',
    docsetSearchEnabled: 'dc_docsetSearchEnabled',
    docsetRoots: 'dc_docsetRoots',
    workspaceRoots: 'dc_workspaceRoots',
    externalSkills: 'dc_externalSkills',
  };
  for (const [key, storageKey] of Object.entries(keys)) {
    if (patch[key] === undefined) continue;
    const value = Array.isArray(patch[key]) ? JSON.stringify(patch[key]) : String(patch[key]);
    localStorage.setItem(storageKey, value);
  }
}

function normalizeSettings(input: Record<string, unknown> = {}): Record<string, unknown> {
  const next = { ...DEFAULT_SETTINGS, ...input };
  const hasProviderId = input.providerId !== undefined && input.providerId !== null && input.providerId !== '';
  const provider = getProviderPreset(
    hasProviderId ? { providerId: String(next.providerId) } : { apiBase: String(next.apiBase) }
  );
  next.providerId =
    hasProviderId && PROVIDER_PRESETS.some((item: any) => item.id === next.providerId) ? next.providerId : provider.id;
  if (!next.apiBase && provider.apiBase) next.apiBase = provider.apiBase;
  if (!next.model && provider.defaultModel) next.model = provider.defaultModel;
  next.temperature = clampNumber(next.temperature as number, 0, 2, DEFAULT_SETTINGS.temperature as number);
  next.maxTokens = Math.round(clampNumber(next.maxTokens as number, 256, 65536, DEFAULT_SETTINGS.maxTokens as number));
  next.maxInputTokens = Math.round(
    clampNumber(next.maxInputTokens as number, 1024, 262144, DEFAULT_SETTINGS.maxInputTokens as number)
  );
  next.maxContextMessages = Math.round(
    clampNumber(next.maxContextMessages as number, 2, 100, DEFAULT_SETTINGS.maxContextMessages as number)
  );
  next.agentMaxRounds = Math.round(
    clampNumber(next.agentMaxRounds as number, 1, 10, DEFAULT_SETTINGS.agentMaxRounds as number)
  );
  next.thinkingBudget = Math.round(
    clampNumber(next.thinkingBudget as number, 0, 65536, DEFAULT_SETTINGS.thinkingBudget as number)
  );
  next.tavilyMaxResults = Math.round(
    clampNumber(next.tavilyMaxResults as number, 1, 10, DEFAULT_SETTINGS.tavilyMaxResults as number)
  );
  next.tavilySearchDepth = ['ultra-fast', 'fast', 'basic', 'advanced'].includes(String(next.tavilySearchDepth))
    ? next.tavilySearchDepth
    : DEFAULT_SETTINGS.tavilySearchDepth;
  next.tavilyIncludeAnswer = next.tavilyIncludeAnswer === true || next.tavilyIncludeAnswer === 'true';
  next.tavilyIncludeRawContent = next.tavilyIncludeRawContent === true || next.tavilyIncludeRawContent === 'true';
  next.tavilyExtractTopResults = Math.round(
    clampNumber(next.tavilyExtractTopResults as number, 0, 5, DEFAULT_SETTINGS.tavilyExtractTopResults as number)
  );
  next.tavilyChunksPerSource = Math.round(
    clampNumber(next.tavilyChunksPerSource as number, 1, 5, DEFAULT_SETTINGS.tavilyChunksPerSource as number)
  );
  next.tavilyCacheTtlMinutes = Math.round(
    clampNumber(next.tavilyCacheTtlMinutes as number, 0, 1440, DEFAULT_SETTINGS.tavilyCacheTtlMinutes as number)
  );
  next.externalMcpDiscoveryEnabled =
    next.externalMcpDiscoveryEnabled !== false && next.externalMcpDiscoveryEnabled !== 'false';
  const fallbackModes = ['missing_key', 'provider_error', 'off'];
  next.localSearchFallbackMode = fallbackModes.includes(String(next.localSearchFallbackMode))
    ? next.localSearchFallbackMode
    : DEFAULT_SETTINGS.localSearchFallbackMode;
  next.fallbackOnSearchError = next.fallbackOnSearchError === true || next.fallbackOnSearchError === 'true';
  next.docsetSearchEnabled = next.docsetSearchEnabled === true || next.docsetSearchEnabled === 'true';
  next.docsetRoots = Array.isArray(next.docsetRoots)
    ? [
        ...new Set(
          (next.docsetRoots as unknown[])
            .map(String)
            .map((item) => item.trim())
            .filter(Boolean)
        ),
      ].slice(0, 20)
    : [];
  next.toolApprovalTimeoutMs = Math.round(
    clampNumber(next.toolApprovalTimeoutMs as number, 5000, 300000, DEFAULT_SETTINGS.toolApprovalTimeoutMs as number)
  );
  next.toolApprovalPolicy =
    String(next.toolApprovalPolicy || DEFAULT_SETTINGS.toolApprovalPolicy) === 'auto_readonly'
      ? 'auto_readonly'
      : DEFAULT_SETTINGS.toolApprovalPolicy;
  next.workspaceRoots = Array.isArray(next.workspaceRoots) ? next.workspaceRoots : [];
  next.externalSkills = Array.isArray(next.externalSkills) ? next.externalSkills : [];
  next.mcpServers = Array.isArray(next.mcpServers) ? next.mcpServers : [];
  next.autoContextSummary = next.autoContextSummary !== false && next.autoContextSummary !== 'false';
  next.cacheOptimization = next.cacheOptimization !== false && next.cacheOptimization !== 'false';
  next.contextFoldEconomicsEnabled =
    next.contextFoldEconomicsEnabled !== false && next.contextFoldEconomicsEnabled !== 'false';
  next.codingEditsEnabled = next.codingEditsEnabled !== false && next.codingEditsEnabled !== 'false';
  next.runCodeEnabled = next.runCodeEnabled !== false && next.runCodeEnabled !== 'false';
  next.enhance = next.enhance !== false && next.enhance !== 'false';
  const validActiveSkills = [
    'agent_auto',
    'none',
    'web_search',
    'file_reader',
    'code_runner',
    'mcp_tool',
    'multi_tool',
  ];
  next.activeSkill = validActiveSkills.includes(String(next.activeSkill))
    ? next.activeSkill
    : DEFAULT_SETTINGS.activeSkill;
  const validAgentModelTiers = ['flash', 'auto', 'pro'];
  next.agentModelTier = validAgentModelTiers.includes(String(next.agentModelTier))
    ? next.agentModelTier
    : DEFAULT_SETTINGS.agentModelTier;
  const validInterfaceDetailLevels = ['normal', 'advanced', 'developer'];
  next.interfaceDetailLevel = validInterfaceDetailLevels.includes(String(next.interfaceDetailLevel))
    ? next.interfaceDetailLevel
    : DEFAULT_SETTINGS.interfaceDetailLevel;
  const validCrewModes = ['auto', 'always', 'tools_only', 'theatre', 'compact', 'off'];
  next.crewDisplayMode = validCrewModes.includes(String(next.crewDisplayMode))
    ? next.crewDisplayMode
    : DEFAULT_SETTINGS.crewDisplayMode;
  const validComposerModes = ['daily', 'analysis', 'project', 'agent', 'research', 'code', 'writing', 'polish'];
  next.defaultComposerMode = validComposerModes.includes(String(next.defaultComposerMode))
    ? next.defaultComposerMode
    : DEFAULT_SETTINGS.defaultComposerMode;
  return next;
}

function parseStoredValue(key: string, value: string): unknown {
  if (['temperature'].includes(key)) return parseFloat(value);
  if (
    [
      'maxTokens',
      'maxInputTokens',
      'maxContextMessages',
      'agentMaxRounds',
      'thinkingBudget',
      'tavilyMaxResults',
      'tavilyExtractTopResults',
      'tavilyChunksPerSource',
      'tavilyCacheTtlMinutes',
      'toolApprovalTimeoutMs',
    ].includes(key)
  )
    return parseInt(value, 10);
  if (
    key === 'enhance' ||
    key === 'autoContextSummary' ||
    key === 'cacheOptimization' ||
    key === 'contextFoldEconomicsEnabled' ||
    key === 'codingEditsEnabled' ||
    key === 'externalMcpDiscoveryEnabled' ||
    key === 'fallbackOnSearchError' ||
    key === 'docsetSearchEnabled' ||
    key === 'tavilyIncludeAnswer' ||
    key === 'tavilyIncludeRawContent' ||
    key === 'runCodeEnabled'
  )
    return value !== 'false';
  return value;
}

function safeJsonArray(value: string | null): any[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
