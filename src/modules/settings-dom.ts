/**
 * Settings DOM utilities — element collection, tab switching, empty states,
 * external skill list, and event binding.
 */

import {
  getSettings,
  saveSettings,
  initApiSettings,
  getProviderPreset,
  hasNativeBridge,
  testApiConnection,
  testSearchConnection,
  resolveRunnableSkill,
} from './api.js';
import {
  clearWorkspaceIndexCache,
  exportBackup,
  importBackup,
  pickExternalSkill,
  pickWorkspace,
  removeWorkspace,
} from './client-store.ts';
import { showToast } from './utils.js';
import {
  renderMcpServerList,
  readMcpServerForm,
  runStatusAction,
  refreshMcpStatuses,
  markMcpStatusStale,
  summarizeMcpStatusRefresh,
} from './settings-mcp.js';
import { renderWorkspaceList, refreshWorkspaces } from './settings-workspace.ts';
import { renderSkillGrid, renderStorageStatus, formatWorkspaceIndexClearResult } from './settings-skills.ts';
import { PROMPT_PRESETS } from './settings-prompts.ts';

export interface SettingsElements {
  [key: string]: HTMLElement | null;
  btn: HTMLElement | null;
  closeBtn: HTMLElement | null;
  overlay: HTMLElement | null;
  panel: HTMLElement | null;
  providerPresets: HTMLElement | null;
  apiKey: HTMLInputElement | null;
  apiBase: HTMLInputElement | null;
  modelInput: HTMLInputElement | null;
  temperature: HTMLInputElement | null;
  temperatureVal: HTMLElement | null;
  thinkingBudget: HTMLInputElement | null;
  thinkingBudgetVal: HTMLElement | null;
  maxTokens: HTMLInputElement | null;
  maxInputTokens: HTMLInputElement | null;
  maxContext: HTMLInputElement | null;
  agentMaxRounds: HTMLInputElement | null;
  autoContextSummary: HTMLInputElement | null;
  cacheOptimization: HTMLInputElement | null;
  privacyMode: HTMLInputElement | null;
  clearWorkspaceIndexCacheBtn: HTMLElement | null;
  workspaceIndexCacheStatus: HTMLElement | null;
  toolApprovalTimeout: HTMLInputElement | null;
  toolApprovalPolicy: HTMLSelectElement | null;
  crewDisplayMode: HTMLSelectElement | null;
  defaultComposerMode: HTMLSelectElement | null;
  runCodeEnabled: HTMLInputElement | null;
  systemPrompt: HTMLTextAreaElement | null;
  modelQuickSelect: HTMLElement | null;
  modelCapabilityStatus: HTMLElement | null;
  toggleKeyVis: HTMLElement | null;
  tavilyKey: HTMLInputElement | null;
  toggleTavilyKeyVis: HTMLElement | null;
  tavilyMaxResults: HTMLInputElement | null;
  testApiBtn: HTMLElement | null;
  apiTestStatus: HTMLElement | null;
  testSearchBtn: HTMLElement | null;
  searchTestStatus: HTMLElement | null;
  storageStatus: HTMLElement | null;
  workspaceList: HTMLElement | null;
  addWorkspaceBtn: HTMLElement | null;
  externalSkillList: HTMLElement | null;
  addExternalSkillBtn: HTMLElement | null;
  mcpName: HTMLInputElement | null;
  mcpCommand: HTMLInputElement | null;
  mcpArgs: HTMLInputElement | null;
  mcpEnv: HTMLInputElement | null;
  addMcpServerBtn: HTMLElement | null;
  refreshMcpStatusBtn: HTMLElement | null;
  mcpStatusText: HTMLElement | null;
  mcpServerList: HTMLElement | null;
  exportBackupBtn: HTMLElement | null;
  importBackupBtn: HTMLElement | null;
  enhanceToggle: HTMLInputElement | null;
  skillGrid: HTMLElement | null;
  statusProviderValue: HTMLElement | null;
  statusSearchValue: HTMLElement | null;
  statusWorkspaceValue: HTMLElement | null;
  statusMcpValue: HTMLElement | null;
  statusCodeRunValue: HTMLElement | null;
  statusIndexValue: HTMLElement | null;
}

export function collectSettingsElements(): SettingsElements {
  return {
    btn: document.getElementById('settings-btn'),
    closeBtn: document.getElementById('settings-close-btn'),
    overlay: document.getElementById('settings-overlay'),
    panel: document.getElementById('settings-panel'),
    providerPresets: document.querySelector('.provider-presets'),
    apiKey: document.getElementById('api-key-input') as HTMLInputElement | null,
    apiBase: document.getElementById('api-base-input') as HTMLInputElement | null,
    modelInput: document.getElementById('model-input') as HTMLInputElement | null,
    temperature: document.getElementById('temperature-input') as HTMLInputElement | null,
    temperatureVal: document.getElementById('temperature-value'),
    thinkingBudget: document.getElementById('thinking-budget-input') as HTMLInputElement | null,
    thinkingBudgetVal: document.getElementById('thinking-budget-value'),
    maxTokens: document.getElementById('max-tokens-input') as HTMLInputElement | null,
    maxInputTokens: document.getElementById('max-input-tokens-input') as HTMLInputElement | null,
    maxContext: document.getElementById('max-context-input') as HTMLInputElement | null,
    agentMaxRounds: document.getElementById('agent-max-rounds-input') as HTMLInputElement | null,
    autoContextSummary: document.getElementById('auto-context-summary-toggle') as HTMLInputElement | null,
    cacheOptimization: document.getElementById('cache-optimization-toggle') as HTMLInputElement | null,
    privacyMode: document.getElementById('privacy-mode-toggle') as HTMLInputElement | null,
    clearWorkspaceIndexCacheBtn: document.getElementById('clear-workspace-index-cache-btn'),
    workspaceIndexCacheStatus: document.getElementById('workspace-index-cache-status'),
    toolApprovalTimeout: document.getElementById('tool-approval-timeout-input') as HTMLInputElement | null,
    toolApprovalPolicy: document.getElementById('tool-approval-policy-select') as HTMLSelectElement | null,
    crewDisplayMode: document.getElementById('crew-display-mode-select') as HTMLSelectElement | null,
    defaultComposerMode: document.getElementById('default-composer-mode-select') as HTMLSelectElement | null,
    runCodeEnabled: document.getElementById('run-code-enabled-toggle') as HTMLInputElement | null,
    systemPrompt: document.getElementById('system-prompt-input') as HTMLTextAreaElement | null,
    modelQuickSelect: document.querySelector('.model-quick-select'),
    modelCapabilityStatus: document.getElementById('model-capability-status'),
    toggleKeyVis: document.getElementById('toggle-key-visibility'),
    tavilyKey: document.getElementById('tavily-key-input') as HTMLInputElement | null,
    toggleTavilyKeyVis: document.getElementById('toggle-tavily-key-visibility'),
    tavilyMaxResults: document.getElementById('tavily-max-results-input') as HTMLInputElement | null,
    testApiBtn: document.getElementById('test-api-btn'),
    apiTestStatus: document.getElementById('api-test-status'),
    testSearchBtn: document.getElementById('test-search-btn'),
    searchTestStatus: document.getElementById('search-test-status'),
    storageStatus: document.getElementById('storage-status'),
    workspaceList: document.getElementById('workspace-list'),
    addWorkspaceBtn: document.getElementById('add-workspace-btn'),
    externalSkillList: document.getElementById('external-skill-list'),
    addExternalSkillBtn: document.getElementById('add-external-skill-btn'),
    mcpName: document.getElementById('mcp-name-input') as HTMLInputElement | null,
    mcpCommand: document.getElementById('mcp-command-input') as HTMLInputElement | null,
    mcpArgs: document.getElementById('mcp-args-input') as HTMLInputElement | null,
    mcpEnv: document.getElementById('mcp-env-input') as HTMLInputElement | null,
    addMcpServerBtn: document.getElementById('add-mcp-server-btn'),
    refreshMcpStatusBtn: document.getElementById('refresh-mcp-status-btn'),
    mcpStatusText: document.getElementById('mcp-status-text'),
    mcpServerList: document.getElementById('mcp-server-list'),
    exportBackupBtn: document.getElementById('export-backup-btn'),
    importBackupBtn: document.getElementById('import-backup-btn'),
    enhanceToggle: document.getElementById('enhance-toggle') as HTMLInputElement | null,
    skillGrid: document.getElementById('skill-grid'),
    statusProviderValue: document.getElementById('status-provider-value'),
    statusSearchValue: document.getElementById('status-search-value'),
    statusWorkspaceValue: document.getElementById('status-workspace-value'),
    statusMcpValue: document.getElementById('status-mcp-value'),
    statusCodeRunValue: document.getElementById('status-code-run-value'),
    statusIndexValue: document.getElementById('status-index-value'),
  };
}

export function applySettingsToInputs(els: SettingsElements, settings: Record<string, unknown>): void {
  if (!els || !settings) return;
  if (els.apiKey) els.apiKey.value = (settings.apiKey as string) || '';
  if (els.apiBase) els.apiBase.value = (settings.apiBase as string) || '';
  if (els.modelInput) els.modelInput.value = (settings.model as string) || '';
  if (els.tavilyKey) els.tavilyKey.value = (settings.tavilyApiKey as string) || '';
  if (els.tavilyMaxResults) els.tavilyMaxResults.value = String(settings.tavilyMaxResults ?? '');
  if (els.temperature) els.temperature.value = String(settings.temperature ?? '');
  if (els.temperatureVal) els.temperatureVal.textContent = String(settings.temperature ?? '');
  if (els.maxTokens) els.maxTokens.value = String(settings.maxTokens ?? '');
  if (els.maxInputTokens) els.maxInputTokens.value = String(settings.maxInputTokens ?? '');
  if (els.maxContext) els.maxContext.value = String(settings.maxContextMessages ?? '');
  if (els.agentMaxRounds) els.agentMaxRounds.value = String(settings.agentMaxRounds ?? '');
  if (els.autoContextSummary) els.autoContextSummary.checked = settings.autoContextSummary !== false;
  if (els.cacheOptimization) els.cacheOptimization.checked = settings.cacheOptimization !== false;
  if (els.toolApprovalTimeout) els.toolApprovalTimeout.value = String(settings.toolApprovalTimeoutMs ?? '');
  if (els.runCodeEnabled) els.runCodeEnabled.checked = settings.runCodeEnabled !== false;
  if (els.thinkingBudget) els.thinkingBudget.value = String(settings.thinkingBudget ?? '');
  if (els.thinkingBudgetVal)
    els.thinkingBudgetVal.textContent = settings.thinkingBudget === 0 ? '自动' : `${settings.thinkingBudget} tokens`;
  if (els.systemPrompt) els.systemPrompt.value = (settings.systemPrompt as string) || '';
  if (els.enhanceToggle) els.enhanceToggle.checked = settings.enhance !== false;
}

export function renderEmptyList(container: HTMLElement | null, titleText: string, hintText: string): void {
  if (!container) return;
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

interface ExternalSkill {
  id: string;
  name?: string;
  enabled?: boolean;
  sourcePath?: string;
  description?: string;
}

export function renderExternalSkillList(
  container: HTMLElement | null,
  skills: ExternalSkill[] = [],
  onChange?: (skills: ExternalSkill[]) => void
): void {
  if (!container) return;
  container.textContent = '';
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

export function highlightActiveProvider(current: Record<string, unknown> | string): void {
  const settings = typeof current === 'object' && current !== null ? current : { apiBase: current };
  const provider = getProviderPreset(settings);
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.provider === provider.id);
  });
}

export function highlightActiveModelTag(currentModel: string): void {
  document.querySelectorAll('.model-tag').forEach((tag) => {
    tag.classList.toggle('active', (tag as HTMLElement).dataset.model === currentModel);
  });
}

export function buildSettingsTabs(panel: HTMLElement | null): void {
  if (!panel) return;

  let tabsContainer = panel.querySelector('.settings-tabs') as HTMLElement | null;
  if (!tabsContainer) {
    tabsContainer = document.createElement('div');
    tabsContainer.className = 'settings-tabs';
    const body = panel.querySelector('.settings-body');
    if (body) body.insertBefore(tabsContainer, body.firstChild);
  }

  tabsContainer.textContent = '';
  tabsContainer.className = 'settings-tabs settings-subtabs';

  const body = panel.querySelector('.settings-body') as HTMLElement | null;
  if (!body) return;

  const sections = [...body.querySelectorAll('.settings-section')] as HTMLElement[];
  if (sections.length === 0) return;

  const segments = [
    { title: 'API 配置', label: '连接' },
    { title: '联网搜索', label: '搜索' },
    { title: '工作区与备份', label: '工作区' },
    { title: '外部 Skill', label: 'Skill' },
    { title: 'MCP Server', label: 'MCP' },
    { title: '模型设置', label: '模型' },
    { title: 'Agent 与 Token', label: 'Agent' },
    { title: '回答模式', label: '边界' },
    { title: '系统提示词', label: '提示词' },
  ];

  segments.forEach((seg, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `settings-tab${index === 0 ? ' active' : ''}`;
    btn.textContent = seg.label;
    btn.dataset.targetTitle = seg.title;

    btn.addEventListener('click', () => {
      const targetSec = sections.find((sec) => {
        const h3 = sec.querySelector('h3');
        return h3 && h3.textContent?.trim() === seg.title;
      });

      if (targetSec) {
        tabsContainer!.querySelectorAll('.settings-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        targetSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    tabsContainer!.appendChild(btn);
  });

  sections.forEach((sec) => {
    sec.style.display = 'block';
    sec.style.opacity = '1';
  });

  const scrollContainer = body.querySelector('.settings-content') as HTMLElement | null;
  (scrollContainer || body).addEventListener('scroll', () => {
    let activeTitle = segments[0].title;
    const containerRect = (scrollContainer || body).getBoundingClientRect();

    for (const sec of sections) {
      const rect = sec.getBoundingClientRect();
      if (rect.top - containerRect.top < 150) {
        const h3 = sec.querySelector('h3');
        if (h3 && h3.textContent) {
          const matched = segments.find((seg) => seg.title === h3.textContent?.trim());
          if (matched) activeTitle = matched.title;
        }
      }
    }

    tabsContainer!.querySelectorAll('.settings-tab').forEach((btn) => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', el.dataset.targetTitle === activeTitle);
    });

    // Sync left nav active state
    const navItems = panel!.querySelectorAll('.settings-nav-item');
    navItems.forEach((item) => {
      const el = item as HTMLElement;
      el.classList.toggle('active', el.dataset.targetTitle === activeTitle);
    });
  });

  // Left nav click handlers
  const navItems = panel!.querySelectorAll('.settings-nav-item');
  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const targetTitle = (item as HTMLElement).dataset.targetTitle;
      const targetSec = sections.find((sec) => {
        const h3 = sec.querySelector('h3');
        return h3 && h3.textContent?.trim() === targetTitle;
      });

      if (targetSec) {
        navItems.forEach((b) => b.classList.remove('active'));
        item.classList.add('active');
        tabsContainer!.querySelectorAll('.settings-tab').forEach((b) => {
          const el = b as HTMLElement;
          el.classList.toggle('active', el.dataset.targetTitle === targetTitle);
        });
        targetSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}

interface SettingsCallbacks {
  doRefreshMcpStatuses: () => Promise<unknown>;
  updateExternalSkills: (skills: ExternalSkill[]) => void;
  updateMcpServers: (servers: unknown[]) => void;
  setLatestMcpStatuses: (statuses: unknown[]) => void;
}

interface SettingsRenderers {
  renderModelCapabilities: (container: HTMLElement | null, settings: Record<string, unknown>) => void;
}

export function bindSettingsEvents(
  els: SettingsElements,
  onModelChange?: (model: string) => void,
  callbacks?: SettingsCallbacks,
  renderers?: SettingsRenderers
): void {
  const { doRefreshMcpStatuses, updateExternalSkills, updateMcpServers, setLatestMcpStatuses } = callbacks || {};
  const { renderModelCapabilities } = renderers || {};

  window.addEventListener('deepchat:settings-changed', (event) => {
    const customEvent = event as CustomEvent;
    const next = customEvent.detail?.settings || getSettings();
    const patch = customEvent.detail?.patch || {};
    if (patch.thinkingBudget !== undefined && els.thinkingBudget) {
      els.thinkingBudget.value = String(next.thinkingBudget);
      if (els.thinkingBudgetVal)
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
      renderModelCapabilities?.(els.modelCapabilityStatus, next);
    }
    if (patch.enhance !== undefined && els.enhanceToggle) {
      els.enhanceToggle.checked = next.enhance !== false;
    }
    if (patch.cacheOptimization !== undefined && els.cacheOptimization) {
      els.cacheOptimization.checked = next.cacheOptimization !== false;
    }
    if (patch.toolApprovalTimeoutMs !== undefined && els.toolApprovalTimeout) {
      els.toolApprovalTimeout.value = String(next.toolApprovalTimeoutMs);
    }
    if (patch.toolApprovalPolicy !== undefined && els.toolApprovalPolicy) {
      els.toolApprovalPolicy.value = (next.toolApprovalPolicy as string) || 'confirm_all';
    }
    if (patch.crewDisplayMode !== undefined && els.crewDisplayMode) {
      els.crewDisplayMode.value = (next.crewDisplayMode as string) || 'auto';
    }
    if (patch.defaultComposerMode !== undefined && els.defaultComposerMode) {
      els.defaultComposerMode.value = (next.defaultComposerMode as string) || 'daily';
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
      setLatestMcpStatuses?.(markMcpStatusStale(els, next));
    }
    refreshSettingsDiagnostics(els, next);
  });

  // ─── Open / Close ───
  function open() {
    if (els.panel) els.panel.classList.remove('hidden');
    if (els.overlay) els.overlay.classList.remove('hidden');
  }
  function close() {
    if (els.panel) els.panel.classList.add('hidden');
    if (els.overlay) els.overlay.classList.add('hidden');
  }

  if (els.btn) els.btn.addEventListener('click', open);
  if (els.closeBtn) els.closeBtn.addEventListener('click', close);
  if (els.overlay) els.overlay.addEventListener('click', close);

  // ─── Settings Tabs ───
  const settingsBody = els.panel?.querySelector('.settings-body') as HTMLElement | null;
  const tabButtons = els.panel?.querySelectorAll('.settings-tab') ?? [];
  function switchSettingsTab(tabId: string) {
    if (!settingsBody) return;
    settingsBody.dataset.activeTab = tabId;
    tabButtons.forEach((btn) => {
      const isActive = (btn as HTMLElement).dataset.tab === tabId;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
  }
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = (btn as HTMLElement).dataset.tab;
      if (tabId) switchSettingsTab(tabId);
    });
  });
  if (settingsBody && !settingsBody.dataset.activeTab) {
    settingsBody.dataset.activeTab = 'tab-connection';
  }

  // ─── Provider Presets ───
  document.querySelectorAll('.provider-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const providerId = (btn as HTMLElement).dataset.provider || 'custom';
      const url = (btn as HTMLElement).dataset.url;
      const model = (btn as HTMLElement).dataset.model;
      const patch: Record<string, unknown> = { providerId };
      if (url && els.apiBase) {
        els.apiBase.value = url;
        patch.apiBase = url;
      }
      if (model && els.modelInput) {
        els.modelInput.value = model;
        patch.model = model;
        onModelChange?.(model);
        highlightActiveModelTag(model);
      }
      saveSettings(patch);
      highlightActiveProvider({ ...getSettings(), ...patch });
      renderModelCapabilities?.(els.modelCapabilityStatus, { ...getSettings(), ...patch });
    });
  });

  // ─── Model Quick-Select Tags ───
  document.querySelectorAll('.model-tag').forEach((tag) => {
    tag.addEventListener('click', () => {
      const model = (tag as HTMLElement).dataset.model || '';
      const providerId = (tag as HTMLElement).dataset.provider || (getSettings().providerId as string);
      const url = (tag as HTMLElement).dataset.url || '';
      const patch: Record<string, unknown> = { providerId, model };
      if (els.modelInput) els.modelInput.value = model;
      if (url && els.apiBase && els.apiBase.value !== url) {
        els.apiBase.value = url;
        patch.apiBase = url;
      }
      saveSettings(patch);
      onModelChange?.(model);
      highlightActiveProvider({ ...getSettings(), ...patch });
      highlightActiveModelTag(model);
      renderModelCapabilities?.(els.modelCapabilityStatus, { ...getSettings(), ...patch });
    });
  });

  // ─── Auto-save on change ───
  if (els.apiKey) {
    els.apiKey.addEventListener('change', () => saveSettings({ apiKey: els.apiKey!.value }));
  }
  if (els.apiBase) {
    els.apiBase.addEventListener('input', () => {
      const provider = getProviderPreset(els.apiBase!.value);
      const patch = { apiBase: els.apiBase!.value, providerId: provider.id };
      saveSettings(patch);
      highlightActiveProvider({ ...getSettings(), ...patch });
      renderModelCapabilities?.(els.modelCapabilityStatus, { ...getSettings(), ...patch });
    });
  }
  if (els.modelInput) {
    els.modelInput.addEventListener('input', () => {
      saveSettings({ model: els.modelInput!.value });
      onModelChange?.(els.modelInput!.value);
      highlightActiveModelTag(els.modelInput!.value);
      renderModelCapabilities?.(els.modelCapabilityStatus, { ...getSettings(), model: els.modelInput!.value });
    });
  }
  if (els.temperature) {
    els.temperature.addEventListener('input', () => {
      if (els.temperatureVal) els.temperatureVal.textContent = els.temperature!.value;
      saveSettings({ temperature: parseFloat(els.temperature!.value) });
    });
  }

  // Thinking budget
  if (els.thinkingBudget) {
    els.thinkingBudget.addEventListener('input', () => {
      const val = parseInt(els.thinkingBudget!.value);
      if (els.thinkingBudgetVal) els.thinkingBudgetVal.textContent = val === 0 ? '自动' : `${val} tokens`;
      saveSettings({ thinkingBudget: val });
    });
  }

  if (els.maxTokens) {
    els.maxTokens.addEventListener('change', () => saveSettings({ maxTokens: parseInt(els.maxTokens!.value) }));
  }
  if (els.maxInputTokens) {
    els.maxInputTokens.addEventListener('change', () => {
      const maxInputTokens = parseInt(els.maxInputTokens!.value, 10);
      saveSettings({ maxInputTokens });
      renderModelCapabilities?.(els.modelCapabilityStatus, { ...getSettings(), maxInputTokens });
    });
  }
  if (els.maxContext) {
    els.maxContext.addEventListener('change', () => {
      const maxContextMessages = parseInt(els.maxContext!.value);
      saveSettings({ maxContextMessages });
      renderModelCapabilities?.(els.modelCapabilityStatus, { ...getSettings(), maxContextMessages });
    });
  }
  if (els.agentMaxRounds) {
    els.agentMaxRounds.addEventListener('change', () =>
      saveSettings({ agentMaxRounds: parseInt(els.agentMaxRounds!.value, 10) })
    );
  }
  if (els.autoContextSummary) {
    els.autoContextSummary.addEventListener('change', () =>
      saveSettings({ autoContextSummary: els.autoContextSummary!.checked })
    );
  }
  if (els.cacheOptimization) {
    els.cacheOptimization.addEventListener('change', () =>
      saveSettings({ cacheOptimization: els.cacheOptimization!.checked })
    );
  }
  if (els.privacyMode) {
    els.privacyMode.addEventListener('change', () => saveSettings({ privacyMode: els.privacyMode!.checked }));
  }
  if (els.clearWorkspaceIndexCacheBtn) {
    els.clearWorkspaceIndexCacheBtn.addEventListener('click', () =>
      runStatusAction(
        els.workspaceIndexCacheStatus,
        '正在清理工作区索引缓存...',
        (result: unknown) => formatWorkspaceIndexClearResult(result as Record<string, unknown>),
        clearWorkspaceIndexCache
      )
    );
  }
  if (els.toolApprovalTimeout) {
    els.toolApprovalTimeout.addEventListener('change', () =>
      saveSettings({ toolApprovalTimeoutMs: parseInt(els.toolApprovalTimeout!.value, 10) })
    );
  }
  if (els.toolApprovalPolicy) {
    els.toolApprovalPolicy.addEventListener('change', () =>
      saveSettings({ toolApprovalPolicy: els.toolApprovalPolicy!.value })
    );
  }
  if (els.crewDisplayMode) {
    els.crewDisplayMode.addEventListener('change', () => saveSettings({ crewDisplayMode: els.crewDisplayMode!.value }));
  }
  if (els.defaultComposerMode) {
    els.defaultComposerMode.addEventListener('change', () =>
      saveSettings({ defaultComposerMode: els.defaultComposerMode!.value })
    );
  }
  if (els.runCodeEnabled) {
    els.runCodeEnabled.addEventListener('change', () => saveSettings({ runCodeEnabled: els.runCodeEnabled!.checked }));
  }
  if (els.systemPrompt) {
    els.systemPrompt.addEventListener('input', () => saveSettings({ systemPrompt: els.systemPrompt!.value }));
  }
  if (els.toggleKeyVis) {
    els.toggleKeyVis.addEventListener('click', () => {
      if (els.apiKey) els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
    });
  }
  if (els.toggleTavilyKeyVis) {
    els.toggleTavilyKeyVis.addEventListener('click', () => {
      if (els.tavilyKey) els.tavilyKey.type = els.tavilyKey.type === 'password' ? 'text' : 'password';
    });
  }
  if (els.tavilyKey) {
    els.tavilyKey.addEventListener('change', async () => {
      const next = await saveSettings({ tavilyApiKey: els.tavilyKey!.value });
      renderSkillGrid(els.skillGrid, (next.activeSkill as string) || '', next);
    });
  }
  if (els.tavilyMaxResults) {
    els.tavilyMaxResults.addEventListener('change', () =>
      saveSettings({ tavilyMaxResults: parseInt(els.tavilyMaxResults!.value, 10) })
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
      await refreshWorkspaces(els, next, { removeWorkspace, renderSkillGrid });
      renderSkillGrid(els.skillGrid, (next.activeSkill as string) || '', next);
    });
  }
  if (els.addExternalSkillBtn) {
    els.addExternalSkillBtn.addEventListener('click', async () => {
      const next = await pickExternalSkill();
      renderExternalSkillList(
        els.externalSkillList,
        (next.externalSkills as ExternalSkill[]) || [],
        updateExternalSkills
      );
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
        const next = await saveSettings({ mcpServers: [...((settings.mcpServers as unknown[]) || []), server] });
        if (els.mcpName) els.mcpName.value = '';
        if (els.mcpCommand) els.mcpCommand.value = '';
        if (els.mcpArgs) els.mcpArgs.value = '';
        if (els.mcpEnv) els.mcpEnv.value = '';
        setLatestMcpStatuses?.(markMcpStatusStale(els, next));
        renderSkillGrid(els.skillGrid, resolveRunnableSkill(next), next);
        showToast('MCP 已添加');
      } catch (error) {
        showToast((error as Error).message || 'MCP 配置无效');
      }
    });
  }
  if (els.refreshMcpStatusBtn) {
    els.refreshMcpStatusBtn.addEventListener('click', () =>
      runStatusAction(
        els.mcpStatusText,
        '刷新 MCP 工具 schema...',
        (statuses: unknown) => summarizeMcpStatusRefresh(statuses as Record<string, any>[]),
        doRefreshMcpStatuses || (() => Promise.resolve())
      )
    );
  }
  if (els.exportBackupBtn) {
    els.exportBackupBtn.addEventListener('click', async () => {
      const excludeCode = (document.getElementById('exclude-code-chk') as HTMLInputElement | null)?.checked || false;
      const excludeLogs = (document.getElementById('exclude-logs-chk') as HTMLInputElement | null)?.checked || false;
      const excludeConfigs =
        (document.getElementById('exclude-configs-chk') as HTMLInputElement | null)?.checked || false;

      const result = await exportBackup({ excludeCode, excludeLogs, excludeConfigs });
      if (!result?.canceled) showToast('备份已导出');
    });
  }
  if (els.importBackupBtn) {
    els.importBackupBtn.addEventListener('click', async () => {
      const result = await importBackup();
      if (!result?.canceled) {
        const next = await initApiSettings();
        applySettingsToInputs(els, next);
        highlightActiveProvider(next);
        highlightActiveModelTag((next.model as string) || '');
        renderModelCapabilities?.(els.modelCapabilityStatus, next);
        onModelChange?.((next.model as string) || '');
        renderSkillGrid(els.skillGrid, resolveRunnableSkill(next), next);
        renderStorageStatus(els.storageStatus, next);
        await refreshWorkspaces(els, next, { removeWorkspace, renderSkillGrid });
        renderExternalSkillList(
          els.externalSkillList,
          (next.externalSkills as ExternalSkill[]) || [],
          updateExternalSkills
        );
        setLatestMcpStatuses?.(markMcpStatusStale(els, next));
        window.dispatchEvent(new CustomEvent('deepchat:reload-conversations'));
        showToast('备份已导入，界面已刷新');
      }
    });
  }

  // Prompt Preset buttons
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = (btn as HTMLElement).dataset.preset || '';
      if (PROMPT_PRESETS[preset] && els.systemPrompt) {
        els.systemPrompt.value = PROMPT_PRESETS[preset];
        saveSettings({ systemPrompt: PROMPT_PRESETS[preset] });
        btn.classList.add('active');
        setTimeout(() => btn.classList.remove('active'), 800);
      }
    });
  });

  // ─── Diagnostics status cards click handlers ───
  document.querySelectorAll('.status-card').forEach((card) => {
    card.addEventListener('click', () => {
      let title = '';
      const target = card.getAttribute('data-target');
      if (target === 'provider') title = 'API 配置';
      else if (target === 'search') title = '联网搜索';
      else if (target === 'workspace') title = '工作区与备份';
      else if (target === 'mcp') title = 'MCP Server';
      else if (target === 'code-run') title = 'Agent 与 Token';
      else if (target === 'index') title = '工作区与备份';

      if (!title) return;

      const sections = [...(settingsBody?.querySelectorAll('.settings-section') ?? [])] as HTMLElement[];
      const targetSec = sections.find((sec) => {
        const h3 = sec.querySelector('h3');
        return h3 && h3.textContent?.trim() === title;
      });

      if (targetSec) {
        // Sync active state in top subtabs
        const tabsContainer = els.panel?.querySelector('.settings-tabs');
        if (tabsContainer) {
          tabsContainer.querySelectorAll('.settings-tab').forEach((b) => {
            const el = b as HTMLElement;
            el.classList.toggle('active', el.dataset.targetTitle === title);
          });
        }

        // Sync left nav active state
        const navItems = els.panel?.querySelectorAll('.settings-nav-item');
        if (navItems) {
          navItems.forEach((b) => {
            const el = b as HTMLElement;
            el.classList.toggle('active', el.dataset.targetTitle === title);
          });
        }

        targetSec.scrollIntoView({ behavior: 'smooth', block: 'start' });

        // Highlight the section briefly
        targetSec.style.outline = '2px solid var(--accent-primary)';
        targetSec.style.outlineOffset = '4px';
        targetSec.style.borderRadius = 'var(--radius-md)';
        setTimeout(() => {
          targetSec.style.outline = '';
          targetSec.style.outlineOffset = '';
        }, 1200);
      }
    });
  });
}

export async function refreshSettingsDiagnostics(els: SettingsElements, settings: Record<string, any>): Promise<void> {
  if (!els) return;

  // 1. Provider
  if (els.statusProviderValue) {
    const card = els.statusProviderValue.closest('.status-card') as HTMLElement | null;
    if (settings.apiKey) {
      const provider = getProviderPreset(settings);
      els.statusProviderValue.textContent = provider.name || '已配置';
      if (card) {
        card.className = 'status-card status-success';
      }
    } else {
      els.statusProviderValue.textContent = '未配置';
      if (card) {
        card.className = 'status-card status-warning';
      }
    }
  }

  // 2. Search
  if (els.statusSearchValue) {
    const card = els.statusSearchValue.closest('.status-card') as HTMLElement | null;
    if (settings.tavilyApiKey) {
      els.statusSearchValue.textContent = '已配置';
      if (card) {
        card.className = 'status-card status-success';
      }
    } else {
      els.statusSearchValue.textContent = '未配置';
      if (card) {
        card.className = 'status-card status-warning';
      }
    }
  }

  // 3. Workspace
  if (els.statusWorkspaceValue) {
    const card = els.statusWorkspaceValue.closest('.status-card') as HTMLElement | null;
    const count = (settings.workspaceRoots as string[])?.length || 0;
    els.statusWorkspaceValue.textContent = `${count} 个`;
    if (card) {
      card.className = count > 0 ? 'status-card status-success' : 'status-card status-warning';
    }
  }

  // 4. MCP
  if (els.statusMcpValue) {
    const card = els.statusMcpValue.closest('.status-card') as HTMLElement | null;
    const count = (settings.mcpServers as any[])?.length || 0;
    els.statusMcpValue.textContent = `${count} 个`;
    if (card) {
      card.className = count > 0 ? 'status-card status-success' : 'status-card';
    }
  }

  // 5. Code execution
  if (els.statusCodeRunValue) {
    const card = els.statusCodeRunValue.closest('.status-card') as HTMLElement | null;
    const enabled = settings.runCodeEnabled !== false;
    els.statusCodeRunValue.textContent = enabled ? '开启 (每次确认)' : '关闭';
    if (card) {
      card.className = enabled ? 'status-card status-success' : 'status-card';
    }
  }

  // 6. Workspace Index
  if (els.statusIndexValue && typeof window !== 'undefined' && (window as any).deepchat?.workspace?.getStats) {
    const card = els.statusIndexValue.closest('.status-card') as HTMLElement | null;
    try {
      const stats = await (window as any).deepchat.workspace.getStats();
      if (stats && stats.fileCount > 0) {
        els.statusIndexValue.textContent = `${stats.fileCount} 文件`;
        if (card) {
          card.className = 'status-card status-success';
        }
      } else {
        els.statusIndexValue.textContent = '未建立';
        if (card) {
          card.className = 'status-card status-warning';
        }
      }
    } catch (err) {
      console.warn('[Settings] Failed to fetch workspace stats:', err);
      els.statusIndexValue.textContent = '加载失败';
      if (card) {
        card.className = 'status-card status-error';
      }
    }
  } else if (els.statusIndexValue) {
    els.statusIndexValue.textContent = '未知';
  }
}
