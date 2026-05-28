/**
 * Settings Module — Panel UI logic
 *
 * Features:
 * - Provider presets & model selection
 * - Quality-boosting system prompt presets
 * - Thinking budget slider
 * - Answer mode selector
 * - Prompt Enhancement toggle
 */

import {
  getSettings,
  initApiSettings,
  saveSettings,
  DEFAULT_SYSTEM_PROMPT,
  SKILLS,
  hasNativeBridge,
  isSkillRunnable,
  resolveRunnableSkill,
  testApiConnection,
  testSearchConnection,
  isEnhanceEnabledSetting,
  getModelCapabilities,
  getProviderCompatibilityReport,
  getProviderPreset,
  PROVIDER_PRESETS,
} from './api.js';
import {
  clearWorkspaceIndexCache,
  exportBackup,
  importBackup,
  listMcpStatus,
  pickExternalSkill,
  pickWorkspace,
  removeWorkspace,
} from './client-store.js';
import { copyToClipboard, showToast, uid } from './utils.js';

// ─── Quality-Boosting Prompt Presets ───

const SHARED_CAPABILITY_RULES = `## 输出能力
- 默认使用 Markdown，但按意图选择版式：短答、步骤、表格、排障、报告、代码、图示分别使用不同结构。
- 简单问题直接回答；教程/操作用步骤；对比/选型用表格；排障按原因、验证、修复组织；报告先摘要再展开。
- 数学公式使用 LaTeX，代码块标注语言，流程图使用 Mermaid。
- 需要交互式演示时使用安全 widget JSON，不输出任意 HTML/JavaScript。
- 复杂回答可使用 :::summary、:::warning、:::steps、:::decision、:::source、:::todo、:::next、:::tool-result 组件块；块内仍写 Markdown，不输出原始 HTML。
- 需要联网、读文件或运行代码时调用客户端工具；没有工具结果时不要假装已经完成。
- 避免每次套用同一套固定小标题；只在内容需要层次时分节。`;

function withSharedRules(prompt) {
  return `${prompt.trim()}\n\n${SHARED_CAPABILITY_RULES}`;
}

const PROMPT_PRESETS = {
  default: DEFAULT_SYSTEM_PROMPT,

  coder: withSharedRules(`你是一位资深全栈工程师，拥有10年以上实战经验。

## 回答要求
1. **代码质量**：写出生产级代码，不是示例代码。包含错误处理、边界条件、类型检查
2. **先分析后编码**：先理解需求和约束，再给出方案。复杂问题先列出技术选型对比
3. **解释原理**：关键代码附带注释说明"为什么这样做"
4. **性能意识**：指出潜在性能问题和优化方向
5. **安全意识**：提醒常见安全隐患

## 格式
- 代码使用代码块并标注语言，关键决策用表格对比`),

  analyst: withSharedRules(`你是一位严谨的分析师，擅长将复杂问题拆解为可执行的结论。

## 分析框架
1. **问题定义**：先明确问题，避免跑偏
2. **多角度分析**：从至少2-3个角度审视
3. **数据驱动**：引用数据、案例或公认理论
4. **结论先行**：先给结论，再展开论证
5. **行动建议**：给出可执行建议，标注优先级和风险`),

  translator: withSharedRules(`你是专业译者，精通中英日韩互译。

## 翻译原则
1. **信达雅**：准确 > 通顺 > 文学表达
2. **语境适配**：根据文体调整翻译风格
3. **术语一致**：全文统一翻译
4. 未指定目标语言时，中文译为英文，其他译为中文`),

  writer: withSharedRules(`你是资深内容创作者，擅长多种文体写作。

## 写作标准
1. **结构清晰**：开头抓眼球，中间有递进，结尾有力
2. **语言精炼**：删掉废话，每句有信息量
3. **读者视角**：用目标读者能理解的方式表达
4. **具体 > 抽象**：用实例、数据、场景代替空泛描述`),

  teacher: withSharedRules(`你是经验丰富的教育者，擅长通俗易懂地讲解知识。

## 教学方法
1. **由浅入深**：从已知概念引入新知识
2. **类比先行**：用日常类比解释抽象概念
3. **主动检验**：在关键节点提出思考题
4. **常见误区**：主动指出容易犯的错误`),
};

export function getPromptPresetText(preset = 'default') {
  return PROMPT_PRESETS[preset] || PROMPT_PRESETS.default;
}

// ─── Prompt Enhancement ───

const ENHANCE_RULES = [
  {
    pattern: /^(.*房贷.*计算.*|.*交互式.*组件.*)$/,
    enhance: '$1\n\n如果适合在当前界面直接操作，请使用受支持的 ```widget``` JSON 组件，不要输出 HTML 或 JavaScript。',
  },
  {
    pattern: /^(报错|错误|失败|修复|为什么)(.+)/,
    enhance: '请排查$2：按「最可能原因 → 如何验证 → 修复步骤 → 注意/风险」组织；不要泛泛解释。',
  },
  {
    pattern: /^(总结|梳理|归纳)(.+)/,
    enhance: '请总结$2：先给一句总览，再按真正有信息量的层次展开；必要时用表格或图示，避免固定模板。',
  },
  { pattern: /^(分析|评估)(.+)/, enhance: '请分析$2：先给摘要结论，再说明依据、风险和建议；信息不足时明确列出缺口。' },
  {
    pattern: /^(写|生成|实现)(.+代码|.+脚本|.+程序)/,
    enhance: '请实现$2：先给可运行代码并标注语言，再解释关键点、边界条件和验证方式。',
  },
  { pattern: /^(.{1,15})[?？]$/, enhance: '请直接回答：$1？保持短答；只有确实需要时再补充背景、例子或注意点。' },
  {
    pattern: /^(怎么|如何|怎样)(.+)/,
    enhance: '请给出$2的可执行方法：用步骤组织；多路线时用表格对比；结尾给注意点或下一步。',
  },
  {
    pattern: /^(对比|比较|区别)(.+)/,
    enhance: '请从真正影响选择的维度对比$2：优先用表格，最后给适用/不适用场景和建议。',
  },
  {
    pattern: /^(推荐|建议)(.+)/,
    enhance: '请推荐$2：按优先级说明理由、适用场景和风险；信息可能过期时先说明需要联网检索。',
  },
  {
    pattern: /^(解释|什么是|介绍)(.+)/,
    enhance: '请解释$2：先给直观结论，再按复杂度补充原理、例子或图示；不要套固定小标题。',
  },
];

export function enhancePrompt(input) {
  if (!input || input.length > 100) return input;
  const trimmed = input.trim();
  for (const rule of ENHANCE_RULES) {
    if (rule.pattern.test(trimmed)) {
      return trimmed.replace(rule.pattern, rule.enhance);
    }
  }
  return input;
}

export function isEnhanceEnabled() {
  return isEnhanceEnabledSetting();
}

// ─── Settings UI ───

export function initSettings(onModelChange) {
  const els = {
    btn: document.getElementById('settings-btn'),
    closeBtn: document.getElementById('settings-close-btn'),
    overlay: document.getElementById('settings-overlay'),
    panel: document.getElementById('settings-panel'),
    providerPresets: document.querySelector('.provider-presets'),
    apiKey: document.getElementById('api-key-input'),
    apiBase: document.getElementById('api-base-input'),
    modelInput: document.getElementById('model-input'),
    temperature: document.getElementById('temperature-input'),
    temperatureVal: document.getElementById('temperature-value'),
    thinkingBudget: document.getElementById('thinking-budget-input'),
    thinkingBudgetVal: document.getElementById('thinking-budget-value'),
    maxTokens: document.getElementById('max-tokens-input'),
    maxInputTokens: document.getElementById('max-input-tokens-input'),
    maxContext: document.getElementById('max-context-input'),
    agentMaxRounds: document.getElementById('agent-max-rounds-input'),
    autoContextSummary: document.getElementById('auto-context-summary-toggle'),
    cacheOptimization: document.getElementById('cache-optimization-toggle'),
    privacyMode: document.getElementById('privacy-mode-toggle'),
    clearWorkspaceIndexCacheBtn: document.getElementById('clear-workspace-index-cache-btn'),
    workspaceIndexCacheStatus: document.getElementById('workspace-index-cache-status'),
    toolApprovalTimeout: document.getElementById('tool-approval-timeout-input'),
    toolApprovalPolicy: document.getElementById('tool-approval-policy-select'),
    crewDisplayMode: document.getElementById('crew-display-mode-select'),
    defaultComposerMode: document.getElementById('default-composer-mode-select'),
    runCodeEnabled: document.getElementById('run-code-enabled-toggle'),
    systemPrompt: document.getElementById('system-prompt-input'),
    modelQuickSelect: document.querySelector('.model-quick-select'),
    modelCapabilityStatus: document.getElementById('model-capability-status'),
    toggleKeyVis: document.getElementById('toggle-key-visibility'),
    tavilyKey: document.getElementById('tavily-key-input'),
    toggleTavilyKeyVis: document.getElementById('toggle-tavily-key-visibility'),
    tavilyMaxResults: document.getElementById('tavily-max-results-input'),
    testApiBtn: document.getElementById('test-api-btn'),
    apiTestStatus: document.getElementById('api-test-status'),
    testSearchBtn: document.getElementById('test-search-btn'),
    searchTestStatus: document.getElementById('search-test-status'),
    storageStatus: document.getElementById('storage-status'),
    workspaceList: document.getElementById('workspace-list'),
    addWorkspaceBtn: document.getElementById('add-workspace-btn'),
    externalSkillList: document.getElementById('external-skill-list'),
    addExternalSkillBtn: document.getElementById('add-external-skill-btn'),
    mcpName: document.getElementById('mcp-name-input'),
    mcpCommand: document.getElementById('mcp-command-input'),
    mcpArgs: document.getElementById('mcp-args-input'),
    mcpEnv: document.getElementById('mcp-env-input'),
    addMcpServerBtn: document.getElementById('add-mcp-server-btn'),
    refreshMcpStatusBtn: document.getElementById('refresh-mcp-status-btn'),
    mcpStatusText: document.getElementById('mcp-status-text'),
    mcpServerList: document.getElementById('mcp-server-list'),
    exportBackupBtn: document.getElementById('export-backup-btn'),
    importBackupBtn: document.getElementById('import-backup-btn'),
    enhanceToggle: document.getElementById('enhance-toggle'),
    skillGrid: document.getElementById('skill-grid'),
  };

  // Load saved settings
  const settings = getSettings();
  els.apiKey.value = settings.apiKey;
  els.apiBase.value = settings.apiBase;
  els.modelInput.value = settings.model;
  if (els.tavilyKey) els.tavilyKey.value = settings.tavilyApiKey || '';
  if (els.tavilyMaxResults) els.tavilyMaxResults.value = settings.tavilyMaxResults;
  els.temperature.value = settings.temperature;
  els.temperatureVal.textContent = settings.temperature;
  els.maxTokens.value = settings.maxTokens;
  if (els.maxInputTokens) els.maxInputTokens.value = settings.maxInputTokens;
  if (els.maxContext) els.maxContext.value = settings.maxContextMessages;
  if (els.agentMaxRounds) els.agentMaxRounds.value = settings.agentMaxRounds;
  if (els.autoContextSummary) els.autoContextSummary.checked = settings.autoContextSummary !== false;
  if (els.cacheOptimization) els.cacheOptimization.checked = settings.cacheOptimization !== false;
  if (els.privacyMode) els.privacyMode.checked = settings.privacyMode === true;
  if (els.toolApprovalTimeout) els.toolApprovalTimeout.value = settings.toolApprovalTimeoutMs;
  if (els.toolApprovalPolicy) els.toolApprovalPolicy.value = settings.toolApprovalPolicy || 'confirm_all';
  if (els.crewDisplayMode) els.crewDisplayMode.value = settings.crewDisplayMode || 'auto';
  if (els.defaultComposerMode) els.defaultComposerMode.value = settings.defaultComposerMode || 'daily';
  if (els.runCodeEnabled) els.runCodeEnabled.checked = settings.runCodeEnabled !== false;
  els.systemPrompt.value = settings.systemPrompt;

  // Thinking budget
  if (els.thinkingBudget) {
    els.thinkingBudget.value = settings.thinkingBudget;
    els.thinkingBudgetVal.textContent = settings.thinkingBudget === 0 ? '自动' : `${settings.thinkingBudget} tokens`;
  }

  // Enhance toggle
  if (els.enhanceToggle) {
    els.enhanceToggle.checked = isEnhanceEnabled();
    els.enhanceToggle.addEventListener('change', () => {
      saveSettings({ enhance: els.enhanceToggle.checked });
    });
  }

  let latestMcpStatuses = [];

  function renderMcpServers(nextSettings = getSettings(), statuses = latestMcpStatuses) {
    renderMcpServerList(els.mcpServerList, nextSettings.mcpServers || [], updateMcpServers, statuses);
  }

  function markMcpStatusStale(nextSettings = getSettings()) {
    latestMcpStatuses = [];
    emitMcpStatusChanged(latestMcpStatuses, { stale: true });
    renderMcpServers(nextSettings, latestMcpStatuses);
    if (els.mcpStatusText) {
      els.mcpStatusText.textContent = 'MCP 配置已变更，请刷新状态以更新工具 schema 和缓存前缀。';
      els.mcpStatusText.className = 'inline-status';
    }
  }

  async function refreshMcpStatuses() {
    if (!hasNativeBridge()) throw new Error('MCP 只能在桌面版测试。');
    latestMcpStatuses = await listMcpStatus();
    emitMcpStatusChanged(latestMcpStatuses, { stale: false });
    renderMcpServers(getSettings(), latestMcpStatuses);
    return latestMcpStatuses;
  }

  async function refreshWorkspaces(nextSettings = getSettings()) {
    renderWorkspaceList(els.workspaceList, nextSettings.workspaceRoots || [], async (root) => {
      const updated = await removeWorkspace(root);
      await refreshWorkspaces(updated);
      renderSkillGrid(els.skillGrid, updated.activeSkill, updated);
    });
  }

  async function updateExternalSkills(nextSkills) {
    const next = await saveSettings({ externalSkills: nextSkills });
    renderExternalSkillList(els.externalSkillList, next.externalSkills || [], updateExternalSkills);
  }

  async function updateMcpServers(nextServers) {
    const next = await saveSettings({ mcpServers: nextServers });
    markMcpStatusStale(next);
    renderSkillGrid(els.skillGrid, next.activeSkill, next);
  }

  // Render skills grid
  const runnableSkill = resolveRunnableSkill(settings);
  if (runnableSkill !== settings.activeSkill) {
    settings.activeSkill = runnableSkill;
    saveSettings({ activeSkill: runnableSkill });
  }
  renderSkillGrid(els.skillGrid, runnableSkill, settings);
  renderStorageStatus(els.storageStatus, settings);
  refreshWorkspaces(settings);
  renderExternalSkillList(els.externalSkillList, settings.externalSkills || [], updateExternalSkills);
  renderMcpServers(settings);
  buildSettingsTabs(els.panel);

  renderProviderPresets(els.providerPresets);
  renderModelQuickSelect(els.modelQuickSelect);
  highlightActiveProvider(settings);
  highlightActiveModelTag(settings.model);
  renderModelCapabilities(els.modelCapabilityStatus, settings);

  window.addEventListener('deepchat:settings-changed', (event) => {
    const next = event.detail?.settings || getSettings();
    const patch = event.detail?.patch || {};
    if (patch.thinkingBudget !== undefined && els.thinkingBudget) {
      els.thinkingBudget.value = next.thinkingBudget;
      els.thinkingBudgetVal.textContent = next.thinkingBudget === 0 ? '自动' : `${next.thinkingBudget} tokens`;
    }
    if (
      patch.model !== undefined ||
      patch.apiBase !== undefined ||
      patch.maxContextMessages !== undefined ||
      patch.maxInputTokens !== undefined ||
      patch.maxTokens !== undefined
    ) {
      highlightActiveProvider(next);
      renderModelCapabilities(els.modelCapabilityStatus, next);
    }
    if (patch.enhance !== undefined && els.enhanceToggle) {
      els.enhanceToggle.checked = next.enhance !== false;
    }
    if (patch.cacheOptimization !== undefined && els.cacheOptimization) {
      els.cacheOptimization.checked = next.cacheOptimization !== false;
    }
    if (patch.toolApprovalTimeoutMs !== undefined && els.toolApprovalTimeout) {
      els.toolApprovalTimeout.value = next.toolApprovalTimeoutMs;
    }
    if (patch.toolApprovalPolicy !== undefined && els.toolApprovalPolicy) {
      els.toolApprovalPolicy.value = next.toolApprovalPolicy || 'confirm_all';
    }
    if (patch.crewDisplayMode !== undefined && els.crewDisplayMode) {
      els.crewDisplayMode.value = next.crewDisplayMode || 'auto';
    }
    if (patch.defaultComposerMode !== undefined && els.defaultComposerMode) {
      els.defaultComposerMode.value = next.defaultComposerMode || 'daily';
    }
    if (patch.runCodeEnabled !== undefined && els.runCodeEnabled) {
      els.runCodeEnabled.checked = next.runCodeEnabled !== false;
    }
    if (
      patch.activeSkill !== undefined ||
      patch.tavilyApiKey !== undefined ||
      patch.workspaceRoots !== undefined ||
      patch.mcpServers !== undefined
    ) {
      renderSkillGrid(els.skillGrid, resolveRunnableSkill(next), next);
    }
    if (patch.mcpServers !== undefined) {
      markMcpStatusStale(next);
    }
  });

  // ─── Open / Close ───
  function open() {
    els.panel.classList.remove('hidden');
    els.overlay.classList.remove('hidden');
  }
  function close() {
    els.panel.classList.add('hidden');
    els.overlay.classList.add('hidden');
  }

  els.btn.addEventListener('click', open);
  els.closeBtn.addEventListener('click', close);
  els.overlay.addEventListener('click', close);

  // ─── Provider Presets ───
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const providerId = btn.dataset.provider || 'custom';
      const url = btn.dataset.url;
      const model = btn.dataset.model;
      const patch = { providerId };
      if (url) {
        els.apiBase.value = url;
        patch.apiBase = url;
      }
      if (model) {
        els.modelInput.value = model;
        patch.model = model;
        onModelChange?.(model);
        highlightActiveModelTag(model);
      }
      saveSettings(patch);
      highlightActiveProvider({ ...getSettings(), ...patch });
      renderModelCapabilities(els.modelCapabilityStatus, { ...getSettings(), ...patch });
    });
  });

  // ─── Model Quick-Select Tags ───
  document.querySelectorAll('.model-tag').forEach((tag) => {
    tag.addEventListener('click', () => {
      const model = tag.dataset.model;
      const providerId = tag.dataset.provider || getSettings().providerId;
      const url = tag.dataset.url || '';
      const patch = { providerId, model };
      els.modelInput.value = model;
      if (url && els.apiBase.value !== url) {
        els.apiBase.value = url;
        patch.apiBase = url;
      }
      saveSettings(patch);
      onModelChange?.(model);
      highlightActiveProvider({ ...getSettings(), ...patch });
      highlightActiveModelTag(model);
      renderModelCapabilities(els.modelCapabilityStatus, { ...getSettings(), ...patch });
    });
  });

  // ─── Auto-save on change ───
  els.apiKey.addEventListener('change', () => saveSettings({ apiKey: els.apiKey.value }));
  els.apiBase.addEventListener('input', () => {
    const provider = getProviderPreset(els.apiBase.value);
    const patch = { apiBase: els.apiBase.value, providerId: provider.id };
    saveSettings(patch);
    highlightActiveProvider({ ...getSettings(), ...patch });
    renderModelCapabilities(els.modelCapabilityStatus, { ...getSettings(), ...patch });
  });
  els.modelInput.addEventListener('input', () => {
    saveSettings({ model: els.modelInput.value });
    onModelChange?.(els.modelInput.value);
    highlightActiveModelTag(els.modelInput.value);
    renderModelCapabilities(els.modelCapabilityStatus, { ...getSettings(), model: els.modelInput.value });
  });
  els.temperature.addEventListener('input', () => {
    els.temperatureVal.textContent = els.temperature.value;
    saveSettings({ temperature: parseFloat(els.temperature.value) });
  });

  // Thinking budget
  if (els.thinkingBudget) {
    els.thinkingBudget.addEventListener('input', () => {
      const val = parseInt(els.thinkingBudget.value);
      els.thinkingBudgetVal.textContent = val === 0 ? '自动' : `${val} tokens`;
      saveSettings({ thinkingBudget: val });
    });
  }

  els.maxTokens.addEventListener('change', () => saveSettings({ maxTokens: parseInt(els.maxTokens.value) }));
  if (els.maxInputTokens) {
    els.maxInputTokens.addEventListener('change', () => {
      const maxInputTokens = parseInt(els.maxInputTokens.value, 10);
      saveSettings({ maxInputTokens });
      renderModelCapabilities(els.modelCapabilityStatus, { ...getSettings(), maxInputTokens });
    });
  }
  if (els.maxContext) {
    els.maxContext.addEventListener('change', () => {
      const maxContextMessages = parseInt(els.maxContext.value);
      saveSettings({ maxContextMessages });
      renderModelCapabilities(els.modelCapabilityStatus, { ...getSettings(), maxContextMessages });
    });
  }
  if (els.agentMaxRounds) {
    els.agentMaxRounds.addEventListener('change', () =>
      saveSettings({ agentMaxRounds: parseInt(els.agentMaxRounds.value, 10) })
    );
  }
  if (els.autoContextSummary) {
    els.autoContextSummary.addEventListener('change', () =>
      saveSettings({ autoContextSummary: els.autoContextSummary.checked })
    );
  }
  if (els.cacheOptimization) {
    els.cacheOptimization.addEventListener('change', () =>
      saveSettings({ cacheOptimization: els.cacheOptimization.checked })
    );
  }
  if (els.privacyMode) {
    els.privacyMode.addEventListener('change', () => saveSettings({ privacyMode: els.privacyMode.checked }));
  }
  if (els.clearWorkspaceIndexCacheBtn) {
    els.clearWorkspaceIndexCacheBtn.addEventListener('click', () =>
      runStatusAction(
        els.workspaceIndexCacheStatus,
        '正在清理工作区索引缓存...',
        formatWorkspaceIndexClearResult,
        clearWorkspaceIndexCache
      )
    );
  }
  if (els.toolApprovalTimeout) {
    els.toolApprovalTimeout.addEventListener('change', () =>
      saveSettings({ toolApprovalTimeoutMs: parseInt(els.toolApprovalTimeout.value, 10) })
    );
  }
  if (els.toolApprovalPolicy) {
    els.toolApprovalPolicy.addEventListener('change', () =>
      saveSettings({ toolApprovalPolicy: els.toolApprovalPolicy.value })
    );
  }
  if (els.crewDisplayMode) {
    els.crewDisplayMode.addEventListener('change', () => saveSettings({ crewDisplayMode: els.crewDisplayMode.value }));
  }
  if (els.defaultComposerMode) {
    els.defaultComposerMode.addEventListener('change', () =>
      saveSettings({ defaultComposerMode: els.defaultComposerMode.value })
    );
  }
  if (els.runCodeEnabled) {
    els.runCodeEnabled.addEventListener('change', () => saveSettings({ runCodeEnabled: els.runCodeEnabled.checked }));
  }
  els.systemPrompt.addEventListener('input', () => saveSettings({ systemPrompt: els.systemPrompt.value }));
  els.toggleKeyVis.addEventListener('click', () => {
    els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
  });
  if (els.toggleTavilyKeyVis) {
    els.toggleTavilyKeyVis.addEventListener('click', () => {
      els.tavilyKey.type = els.tavilyKey.type === 'password' ? 'text' : 'password';
    });
  }
  if (els.tavilyKey) {
    els.tavilyKey.addEventListener('change', async () => {
      const next = await saveSettings({ tavilyApiKey: els.tavilyKey.value });
      renderSkillGrid(els.skillGrid, next.activeSkill, next);
    });
  }
  if (els.tavilyMaxResults) {
    els.tavilyMaxResults.addEventListener('change', () =>
      saveSettings({ tavilyMaxResults: parseInt(els.tavilyMaxResults.value, 10) })
    );
  }
  if (els.testApiBtn) {
    els.testApiBtn.addEventListener('click', () =>
      runStatusAction(els.apiTestStatus, '测试中...', '连接正常', () => testApiConnection())
    );
  }
  if (els.testSearchBtn) {
    els.testSearchBtn.addEventListener('click', () =>
      runStatusAction(els.searchTestStatus, '搜索中...', '搜索正常', () => testSearchConnection('DeepChat test'))
    );
  }
  if (els.addWorkspaceBtn) {
    els.addWorkspaceBtn.addEventListener('click', async () => {
      const next = await pickWorkspace();
      await refreshWorkspaces(next);
      renderSkillGrid(els.skillGrid, next.activeSkill, next);
    });
  }
  if (els.addExternalSkillBtn) {
    els.addExternalSkillBtn.addEventListener('click', async () => {
      const next = await pickExternalSkill();
      renderExternalSkillList(els.externalSkillList, next.externalSkills || [], updateExternalSkills);
      showToast('外部 Skill 已导入');
    });
  }
  if (els.addMcpServerBtn) {
    els.addMcpServerBtn.addEventListener('click', async () => {
      if (!hasNativeBridge()) {
        showToast('MCP 只能在桌面版使用，浏览器预览不会保存 MCP 配置。');
        return;
      }
      try {
        const settings = getSettings();
        const server = readMcpServerForm(els);
        const next = await saveSettings({ mcpServers: [...(settings.mcpServers || []), server] });
        els.mcpName.value = '';
        els.mcpCommand.value = '';
        els.mcpArgs.value = '';
        els.mcpEnv.value = '';
        markMcpStatusStale(next);
        renderSkillGrid(els.skillGrid, next.activeSkill, next);
        showToast('MCP 已添加');
      } catch (error) {
        showToast(error.message || 'MCP 配置无效');
      }
    });
  }
  if (els.refreshMcpStatusBtn) {
    els.refreshMcpStatusBtn.addEventListener('click', () =>
      runStatusAction(
        els.mcpStatusText,
        '刷新 MCP 工具 schema...',
        (statuses) => summarizeMcpStatusRefresh(statuses),
        refreshMcpStatuses
      )
    );
  }
  if (els.exportBackupBtn) {
    els.exportBackupBtn.addEventListener('click', async () => {
      const result = await exportBackup();
      if (!result?.canceled) showToast('备份已导出');
    });
  }
  if (els.importBackupBtn) {
    els.importBackupBtn.addEventListener('click', async () => {
      const result = await importBackup();
      if (!result?.canceled) {
        const next = await initApiSettings();
        applySettingsToInputs(els, next, onModelChange);
        renderSkillGrid(els.skillGrid, resolveRunnableSkill(next), next);
        renderStorageStatus(els.storageStatus, next);
        await refreshWorkspaces(next);
        renderExternalSkillList(els.externalSkillList, next.externalSkills || [], updateExternalSkills);
        markMcpStatusStale(next);
        window.dispatchEvent(new CustomEvent('deepchat:reload-conversations'));
        showToast('备份已导入，界面已刷新');
      }
    });
  }

  // Prompt Preset buttons
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      if (PROMPT_PRESETS[preset]) {
        els.systemPrompt.value = PROMPT_PRESETS[preset];
        saveSettings({ systemPrompt: PROMPT_PRESETS[preset] });
        btn.classList.add('active');
        setTimeout(() => btn.classList.remove('active'), 800);
      }
    });
  });
}

// ─── Skill Grid ───

function renderSkillGrid(container, activeSkill, settings = getSettings()) {
  if (!container) return;
  container.innerHTML = '';

  const resolvedActiveSkill = resolveRunnableSkill(settings);
  for (const [id, skill] of Object.entries(SKILLS)) {
    const card = document.createElement('button');
    const available = isSkillAvailable(id, settings);
    card.type = 'button';
    card.disabled = !available;
    card.setAttribute('aria-disabled', String(!available));
    card.className = `skill-card${id === resolvedActiveSkill ? ' active' : ''}${available ? '' : ' unavailable'}`;
    card.innerHTML = `
      <span class="skill-icon">${skill.icon}</span>
      <span class="skill-name">${skill.name}</span>
      <span class="skill-desc">${skill.description}</span>
      <span class="skill-state">${available ? '可用' : getUnavailableReason(id)}</span>
    `;
    card.addEventListener('click', () => {
      if (!available) {
        showToast(getUnavailableReason(id));
        return;
      }
      saveSettings({ activeSkill: id });
      container.querySelectorAll('.skill-card').forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
    });
    container.appendChild(card);
  }
}

function isSkillAvailable(id, settings) {
  return isSkillRunnable(id, settings);
}

function getUnavailableReason(id) {
  if (!hasNativeBridge() && id !== 'none' && id !== 'web_search') return '需桌面版';
  if (id === 'web_search') return '需 Tavily Key';
  if (id === 'file_reader') return '需工作区';
  if (id === 'mcp_tool') return '需 MCP';
  if (id === 'multi_tool') return '需配置工具';
  return '可用';
}

function renderStorageStatus(container, settings) {
  if (!container) return;
  const status = settings.storageStatus || { mode: 'browser' };
  if (status.mode === 'electron') {
    container.textContent = `桌面安全存储：${status.encryptionAvailable ? '加密可用' : '加密不可用'} · 备份不包含 API Key/Tavily Key/MCP env · ${status.dataDir || ''}`;
  } else {
    container.textContent =
      '浏览器预览模式：非敏感设置和对话保存在 localStorage；密钥仅当前页面会话保留，备份不包含 API Key/Tavily Key/MCP env。';
  }
}

function formatWorkspaceIndexClearResult(result = {}) {
  if (!result.diskEnabled) return '已清理内存索引；浏览器预览或当前存储目录未启用磁盘索引缓存。';
  const bytes = Number(result.deletedBytes || 0);
  return `已清理工作区索引缓存：${result.deletedFiles || 0} 个文件，${formatBytes(bytes)}。`;
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round((value / 1024 / 1024) * 10) / 10} MB`;
}

export function renderModelCapabilities(container, settings = getSettings()) {
  if (!container) return;
  const caps = getModelCapabilities(settings);
  const rows = [
    [`Provider: ${caps.providerName || '自定义'}`, true, ''],
    ['流式', caps.streaming],
    ['流式统计', caps.streamUsage],
    ['工具', caps.tools],
    ['视觉', caps.vision],
    ['思考', caps.thinking],
    ['缓存统计', caps.promptCacheUsage],
  ];
  container.innerHTML = '';
  for (const [label, enabled, suffix] of rows) {
    const pill = document.createElement('span');
    pill.className = `capability-pill ${enabled ? 'is-on' : 'is-off'}`;
    pill.textContent = `${label}${suffix ?? (enabled ? '可用' : '不可用')}`;
    container.appendChild(pill);
  }
  container.appendChild(renderProviderReadinessCard(getProviderCompatibilityReport(settings)));
  const contextText = caps.maxContextMessages ? `${caps.maxContextMessages} 条上下文` : '上下文按默认';
  const inputBudget = settings.maxInputTokens ? `输入预算 ${settings.maxInputTokens} tokens` : '输入预算按默认';
  container.title = `${caps.providerName || '自定义服务商'}；${contextText}；${inputBudget}；能力来自 Provider Registry 和模型名称规则，最终以服务商实际支持为准。`;
}

function renderProviderReadinessCard(report) {
  const card = document.createElement('div');
  card.className = `provider-readiness-card is-${report.status}`;

  const head = document.createElement('div');
  head.className = 'provider-readiness-head';
  const title = document.createElement('strong');
  title.textContent = report.summary;
  const status = document.createElement('span');
  status.textContent = report.status === 'blocked' ? '需配置' : report.status === 'warning' ? '有限制' : '可用';
  head.append(title, status);
  card.appendChild(head);

  const visibleItems = report.items.slice(0, 4);
  if (visibleItems.length > 0) {
    const list = document.createElement('div');
    list.className = 'provider-readiness-list';
    for (const item of visibleItems) {
      const row = document.createElement('div');
      row.className = `provider-readiness-item is-${item.severity}`;
      const label = document.createElement('span');
      label.textContent = item.label;
      const detail = document.createElement('small');
      detail.textContent = item.detail;
      row.append(label, detail);
      list.appendChild(row);
    }
    card.appendChild(list);
  } else {
    const ok = document.createElement('p');
    ok.className = 'provider-readiness-ok';
    ok.textContent = '工具、流式 usage、缓存统计和思考能力将按上方能力矩阵启用。';
    card.appendChild(ok);
  }

  if (report.suggestions.length > 0) {
    const suggestion = document.createElement('p');
    suggestion.className = 'provider-readiness-suggestion';
    suggestion.textContent = `建议：${report.suggestions[0]}`;
    card.appendChild(suggestion);
  }

  return card;
}

function renderProviderPresets(container) {
  if (!container) return;
  container.innerHTML = '';
  for (const provider of PROVIDER_PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'provider-btn';
    btn.dataset.provider = provider.id;
    btn.dataset.url = provider.apiBase || '';
    btn.dataset.model = provider.defaultModel || '';
    btn.title = [
      provider.name,
      provider.authType === 'none' ? '无需 API Key' : 'Bearer API Key',
      provider.supportsPromptCacheUsage ? '支持 cache usage' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = provider.name;
    btn.appendChild(name);
    container.appendChild(btn);
  }
}

function renderModelQuickSelect(container) {
  if (!container) return;
  container.innerHTML = '';
  for (const provider of PROVIDER_PRESETS.filter((item) => item.models?.length)) {
    const group = document.createElement('div');
    group.className = 'model-group';
    const title = document.createElement('span');
    title.className = 'model-group-title';
    title.textContent = provider.name;
    group.appendChild(title);
    for (const model of provider.models) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'model-tag';
      btn.dataset.provider = provider.id;
      btn.dataset.url = provider.apiBase;
      btn.dataset.model = model.id;
      btn.textContent = model.label || model.id;
      btn.title = `${provider.name} · ${model.id}`;
      group.appendChild(btn);
    }
    container.appendChild(group);
  }
}

function renderExternalSkillList(container, skills = [], onChange) {
  if (!container) return;
  container.innerHTML = '';
  if (!skills.length) {
    renderEmptyList(container, '尚未导入外部 Skill', '可导入本地 SKILL.md');
    return;
  }
  for (const skill of skills) {
    const item = document.createElement('div');
    item.className = 'workspace-item column';
    const main = document.createElement('div');
    main.className = 'workspace-item-main';
    const name = document.createElement('span');
    name.textContent = skill.name || '外部 Skill';
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'icon-btn-sm';
    toggle.textContent = skill.enabled === false ? '启用' : '停用';
    toggle.addEventListener('click', () => {
      onChange?.(skills.map((item) => (item.id === skill.id ? { ...item, enabled: item.enabled === false } : item)));
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn-sm';
    remove.textContent = '移除';
    remove.addEventListener('click', () => onChange?.(skills.filter((item) => item.id !== skill.id)));
    actions.append(toggle, remove);
    main.append(name, actions);
    const meta = document.createElement('div');
    meta.className = 'workspace-item-meta';
    meta.textContent = `${skill.enabled === false ? '停用' : '启用'} · ${skill.sourcePath || skill.description || '已导入内容'}`;
    item.append(main, meta);
    container.appendChild(item);
  }
}

export function renderMcpServerList(container, servers = [], onChange, statuses = []) {
  if (!container) return;
  container.innerHTML = '';
  if (!servers.length) {
    renderEmptyList(container, '尚未配置 MCP Server', '添加 stdio server 后可在 MCP/全工具模式调用');
    return;
  }
  const statusMap = new Map((statuses || []).map((status) => [status.id, status]));
  for (const server of servers) {
    const status = statusMap.get(server.id);
    const item = document.createElement('div');
    item.className = 'workspace-item column';
    const main = document.createElement('div');
    main.className = 'workspace-item-main';
    const name = document.createElement('span');
    name.textContent = server.name || 'MCP Server';
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'icon-btn-sm';
    toggle.textContent = server.enabled === false ? '启用' : '停用';
    toggle.addEventListener('click', () => {
      onChange?.(servers.map((item) => (item.id === server.id ? { ...item, enabled: item.enabled === false } : item)));
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn-sm';
    remove.textContent = '移除';
    remove.addEventListener('click', () => onChange?.(servers.filter((item) => item.id !== server.id)));
    actions.append(toggle, remove);
    main.append(name, actions);
    const meta = document.createElement('div');
    meta.className = 'workspace-item-meta';
    const toolCount = status?.toolCount ?? status?.tools?.length ?? 0;
    const schemaText = status?.schemaHash ? ` · schema ${shortHash(status.schemaHash)}` : '';
    const toolText = status?.ok ? `工具 ${toolCount} 个${schemaText}` : status?.error || '未测试';
    meta.textContent = `${server.enabled === false ? '停用' : '启用'} · ${server.command} ${(server.args || []).join(' ')} · ${toolText}`;
    item.append(main, meta);
    if (status) {
      const detail = document.createElement('details');
      detail.className = 'mcp-status-detail';
      const summary = document.createElement('summary');
      summary.textContent = status.ok
        ? `查看工具列表${status.schemaHash ? ` · ${shortHash(status.schemaHash)}` : ''}`
        : '查看错误详情';
      const body = document.createElement('div');
      body.className = 'mcp-status-body';
      if (status.ok && status.tools.length) {
        const toolbar = document.createElement('div');
        toolbar.className = 'mcp-status-toolbar';
        const schema = document.createElement('span');
        schema.className = 'mcp-schema-badge';
        schema.textContent = status.schemaHash ? `schema ${shortHash(status.schemaHash)}` : 'schema 未知';
        schema.title = status.schemaHash
          ? `完整 schema hash：${status.schemaHash}`
          : 'MCP Server 未返回可计算 schema。';
        const ttl = document.createElement('span');
        ttl.className = 'mcp-schema-badge';
        ttl.textContent = `缓存 TTL ${formatDuration(status.cacheTtlMs)}`;
        ttl.title = status.cacheExpiresAt ? `缓存有效到 ${status.cacheExpiresAt}` : 'MCP 工具定义缓存有效期';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'icon-btn-sm mcp-copy-tools-btn';
        copyBtn.textContent = '复制清单';
        copyBtn.title = '复制当前 MCP 工具清单和 schema hash';
        copyBtn.addEventListener('click', async () => {
          const copied = await copyToClipboard(buildMcpToolsClipboard(server, status));
          showToast(copied ? 'MCP 工具清单已复制' : '复制失败');
        });
        toolbar.append(schema, ttl, copyBtn);
        body.appendChild(toolbar);
        for (const tool of status.tools.slice(0, 12)) {
          const row = document.createElement('div');
          row.className = 'mcp-tool-row';
          row.textContent = `${tool.name}${tool.description ? ` — ${tool.description}` : ''}`;
          row.title = row.textContent;
          body.appendChild(row);
        }
        if (status.tools.length > 12) {
          const more = document.createElement('div');
          more.className = 'mcp-status-meta';
          more.textContent = `还有 ${status.tools.length - 12} 个工具未显示，可复制完整清单查看。`;
          body.appendChild(more);
        }
      } else {
        body.textContent = status.error || '没有返回工具。';
      }
      const metaLine = document.createElement('div');
      metaLine.className = 'mcp-status-meta';
      metaLine.textContent = [
        `检测时间 ${status.checkedAt || '-'}`,
        `耗时 ${status.durationMs ?? '-'}ms`,
        status.cacheExpiresAt ? `缓存到 ${status.cacheExpiresAt}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      body.appendChild(metaLine);
      detail.append(summary, body);
      item.appendChild(detail);
    }
    container.appendChild(item);
  }
}

function summarizeMcpStatusRefresh(statuses = []) {
  const rows = Array.isArray(statuses) ? statuses : [];
  if (!rows.length) return '没有配置 MCP Server';
  const ok = rows.filter((status) => status.ok).length;
  const toolCount = rows.reduce((sum, status) => sum + (status.toolCount ?? status.tools?.length ?? 0), 0);
  const schemaCount = new Set(rows.filter((status) => status.schemaHash).map((status) => status.schemaHash)).size;
  return `MCP 已刷新：${ok}/${rows.length} 可用 · ${toolCount} 个工具 · ${schemaCount} 个 schema`;
}

function emitMcpStatusChanged(statuses = [], meta = {}) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(
    new CustomEvent('deepchat:mcp-status-changed', {
      detail: {
        statuses: Array.isArray(statuses) ? statuses : [],
        stale: Boolean(meta.stale),
      },
    })
  );
}

function shortHash(value) {
  return String(value || '').slice(0, 8);
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '未知';
  if (value < 60000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value / 60000)}m`;
}

function buildMcpToolsClipboard(server, status) {
  return JSON.stringify(
    {
      server: {
        id: server.id,
        name: server.name,
        command: server.command,
        args: server.args || [],
        enabled: server.enabled !== false,
      },
      ok: Boolean(status.ok),
      schemaHash: status.schemaHash || '',
      toolCount: status.toolCount ?? status.tools?.length ?? 0,
      cacheTtlMs: status.cacheTtlMs || 0,
      cacheExpiresAt: status.cacheExpiresAt || '',
      tools: status.tools || [],
    },
    null,
    2
  );
}

function renderEmptyList(container, titleText, hintText) {
  const empty = document.createElement('div');
  empty.className = 'workspace-empty';
  const title = document.createElement('div');
  title.textContent = titleText;
  const hint = document.createElement('div');
  hint.className = 'workspace-empty-hint';
  hint.textContent = hintText;
  empty.append(title, hint);
  container.appendChild(empty);
}

function readMcpServerForm(els) {
  const command = els.mcpCommand.value.trim();
  if (!command) throw new Error('请填写 MCP 启动命令。');
  return {
    id: `mcp_${uid()}`,
    name: els.mcpName.value.trim() || command,
    command,
    args: parseMcpArgs(els.mcpArgs.value),
    env: parseMcpEnv(els.mcpEnv.value),
    enabled: true,
  };
}

function parseMcpArgs(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  return text.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, '')) || [];
}

function parseMcpEnv(value) {
  const text = String(value || '').trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('环境变量必须是 JSON 对象。');
  return parsed;
}

function renderWorkspaceList(container, roots, onRemove) {
  if (!container) return;
  container.innerHTML = '';
  if (!roots || roots.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'workspace-empty';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add('workspace-empty-icon');
    icon.setAttribute('width', '24');
    icon.setAttribute('height', '24');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z');
    icon.appendChild(path);

    const title = document.createElement('div');
    title.textContent = '尚未添加工作区';
    const hint = document.createElement('div');
    hint.className = 'workspace-empty-hint';
    hint.textContent = '文件读取能力暂时受限';
    empty.append(icon, title, hint);
    container.appendChild(empty);
    return;
  }
  for (const root of roots) {
    const item = document.createElement('div');
    item.className = 'workspace-item';
    const text = document.createElement('span');
    text.textContent = root;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'icon-btn-sm';
    removeBtn.title = '移除工作区';
    removeBtn.textContent = '移除';
    removeBtn.addEventListener('click', () => onRemove(root));
    item.append(text, removeBtn);
    container.appendChild(item);
  }
}

async function runStatusAction(statusEl, pendingText, successText, action) {
  if (!statusEl) return;
  statusEl.textContent = pendingText;
  statusEl.className = 'inline-status';
  try {
    const result = await action();
    statusEl.textContent = typeof successText === 'function' ? successText(result) : successText;
    statusEl.classList.add('ok');
  } catch (error) {
    statusEl.textContent = error.message || '失败';
    statusEl.classList.add('error');
  }
}

// ─── Helpers ───

function highlightActiveProvider(current) {
  const settings = typeof current === 'object' && current !== null ? current : { apiBase: current };
  const provider = getProviderPreset(settings);
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.provider === provider.id);
  });
}

function highlightActiveModelTag(currentModel) {
  document.querySelectorAll('.model-tag').forEach((tag) => {
    tag.classList.toggle('active', tag.dataset.model === currentModel);
  });
}

function applySettingsToInputs(els, settings, onModelChange) {
  if (!els || !settings) return;
  if (els.apiKey) els.apiKey.value = settings.apiKey || '';
  if (els.apiBase) els.apiBase.value = settings.apiBase || '';
  if (els.modelInput) els.modelInput.value = settings.model || '';
  if (els.tavilyKey) els.tavilyKey.value = settings.tavilyApiKey || '';
  if (els.tavilyMaxResults) els.tavilyMaxResults.value = settings.tavilyMaxResults;
  if (els.temperature) els.temperature.value = settings.temperature;
  if (els.temperatureVal) els.temperatureVal.textContent = settings.temperature;
  if (els.maxTokens) els.maxTokens.value = settings.maxTokens;
  if (els.maxInputTokens) els.maxInputTokens.value = settings.maxInputTokens;
  if (els.maxContext) els.maxContext.value = settings.maxContextMessages;
  if (els.agentMaxRounds) els.agentMaxRounds.value = settings.agentMaxRounds;
  if (els.autoContextSummary) els.autoContextSummary.checked = settings.autoContextSummary !== false;
  if (els.cacheOptimization) els.cacheOptimization.checked = settings.cacheOptimization !== false;
  if (els.toolApprovalTimeout) els.toolApprovalTimeout.value = settings.toolApprovalTimeoutMs;
  if (els.runCodeEnabled) els.runCodeEnabled.checked = settings.runCodeEnabled !== false;
  if (els.thinkingBudget) els.thinkingBudget.value = settings.thinkingBudget;
  if (els.thinkingBudgetVal)
    els.thinkingBudgetVal.textContent = settings.thinkingBudget === 0 ? '自动' : `${settings.thinkingBudget} tokens`;
  if (els.systemPrompt) els.systemPrompt.value = settings.systemPrompt || '';
  if (els.enhanceToggle) els.enhanceToggle.checked = settings.enhance !== false;
  highlightActiveProvider(settings);
  highlightActiveModelTag(settings.model);
  renderModelCapabilities(els.modelCapabilityStatus, settings);
  onModelChange?.(settings.model);
}

function buildSettingsTabs(panel) {
  if (!panel || panel.querySelector('.settings-tabs')) return;
  const body = panel.querySelector('.settings-body');
  const sections = [...body.querySelectorAll('.settings-section')];
  if (!body || sections.length === 0) return;

  const groups = [
    { id: 'common', label: '常用', match: /API 配置|联网搜索|工作区与备份|智能增强/ },
    { id: 'tools', label: '工具', match: /回答模式|Agent 与 Token|外部 Skill|MCP Server/ },
    { id: 'model', label: '模型', match: /模型设置|系统提示词/ },
  ];

  const tabs = document.createElement('div');
  tabs.className = 'settings-tabs';
  const activeGroup = 'common';

  for (const group of groups) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `settings-tab${group.id === activeGroup ? ' active' : ''}`;
    btn.dataset.settingsGroup = group.id;
    btn.textContent = group.label;
    btn.addEventListener('click', () => setActiveSettingsGroup(body, groups, group.id));
    tabs.appendChild(btn);
  }

  for (const section of sections) {
    const title = section.querySelector('h3')?.textContent || '';
    const group = groups.find((item) => item.match.test(title)) || groups[0];
    section.dataset.settingsGroup = group.id;
  }

  body.insertBefore(tabs, body.firstChild);
  setActiveSettingsGroup(body, groups, activeGroup);
}

function setActiveSettingsGroup(body, groups, activeId) {
  body.querySelectorAll('.settings-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.settingsGroup === activeId);
  });
  body.querySelectorAll('.settings-section').forEach((section) => {
    section.hidden = section.dataset.settingsGroup !== activeId;
  });
}
