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
  SKILLS,
  hasNativeBridge,
  resolveRunnableSkill,
  getModelCapabilities,
  getProviderCompatibilityReport,
  getProviderPreset,
  PROVIDER_PRESETS,
} from './api.js';
import { getPromptPresetText, enhancePrompt, isEnhanceEnabled } from './settings-prompts.ts';
export { getPromptPresetText, enhancePrompt, isEnhanceEnabled };
import { removeWorkspace } from './client-store.ts';
import {
  collectSettingsElements,
  applySettingsToInputs,
  buildSettingsTabs,
  bindSettingsEvents,
  highlightActiveProvider,
  highlightActiveModelTag,
  renderExternalSkillList,
} from './settings-dom.js';
import { renderMcpServerList, refreshMcpStatuses, markMcpStatusStale } from './settings-mcp.js';
export { renderMcpServerList };
import { refreshWorkspaces } from './settings-workspace.ts';
import { renderSkillGrid, renderStorageStatus, formatWorkspaceIndexClearResult } from './settings-skills.ts';

// ─── Settings UI ───

export function initSettings(onModelChange?: (model: string) => void) {
  const els = collectSettingsElements();
  const settings = getSettings();

  applySettingsToInputs(els, settings);
  if (els.privacyMode) (els.privacyMode as HTMLInputElement).checked = settings.privacyMode === true;
  if (els.toolApprovalPolicy)
    (els.toolApprovalPolicy as HTMLSelectElement).value = (settings.toolApprovalPolicy as string) || 'confirm_all';
  if (els.crewDisplayMode)
    (els.crewDisplayMode as HTMLSelectElement).value = (settings.crewDisplayMode as string) || 'auto';
  if (els.defaultComposerMode)
    (els.defaultComposerMode as HTMLSelectElement).value = (settings.defaultComposerMode as string) || 'daily';

  // Enhance toggle
  if (els.enhanceToggle) {
    (els.enhanceToggle as HTMLInputElement).checked = isEnhanceEnabled();
    els.enhanceToggle.addEventListener('change', () => {
      saveSettings({ enhance: (els.enhanceToggle as HTMLInputElement).checked });
    });
  }

  let latestMcpStatuses: any[] = [];

  async function doRefreshMcpStatuses() {
    latestMcpStatuses = await refreshMcpStatuses();
    renderMcpServerList(
      els.mcpServerList,
      (getSettings().mcpServers as any[]) || [],
      updateMcpServers,
      latestMcpStatuses
    );
    return latestMcpStatuses;
  }

  async function updateExternalSkills(nextSkills: any[]) {
    const next = await saveSettings({ externalSkills: nextSkills });
    renderExternalSkillList(els.externalSkillList, (next.externalSkills as any[]) || [], updateExternalSkills);
  }

  async function updateMcpServers(nextServers: any[]) {
    const next = await saveSettings({ mcpServers: nextServers });
    latestMcpStatuses = markMcpStatusStale(els, next);
    renderSkillGrid(els.skillGrid, next.activeSkill as string, next);
  }

  // Render initial UI
  const runnableSkill = resolveRunnableSkill(settings);
  if (runnableSkill !== settings.activeSkill) {
    (settings as Record<string, any>).activeSkill = runnableSkill;
    saveSettings({ activeSkill: runnableSkill });
  }
  renderSkillGrid(els.skillGrid, runnableSkill, settings);
  renderStorageStatus(els.storageStatus, settings);
  refreshWorkspaces(els, settings, { removeWorkspace, renderSkillGrid });
  renderExternalSkillList(els.externalSkillList, (settings.externalSkills as any[]) || [], updateExternalSkills);
  renderMcpServerList(els.mcpServerList, (settings.mcpServers as any[]) || [], updateMcpServers, latestMcpStatuses);
  buildSettingsTabs(els.panel);

  renderProviderPresets(els.providerPresets);
  renderModelQuickSelect(els.modelQuickSelect);
  highlightActiveProvider(settings);
  highlightActiveModelTag(settings.model as string);
  renderModelCapabilities(els.modelCapabilityStatus, settings);

  bindSettingsEvents(
    els,
    onModelChange,
    {
      doRefreshMcpStatuses,
      updateExternalSkills,
      updateMcpServers,
      setLatestMcpStatuses: (v: any[]) => {
        latestMcpStatuses = v;
      },
    },
    {
      renderModelCapabilities,
    }
  );
}

export {
  renderSkillGrid,
  isSkillAvailable,
  getUnavailableReason,
  renderStorageStatus,
  formatWorkspaceIndexClearResult,
  formatBytes,
} from './settings-skills.ts';

export function renderModelCapabilities(container: HTMLElement | null, settings: Record<string, any> = getSettings()) {
  if (!container) return;
  const caps = getModelCapabilities(settings);
  const rows: [string, boolean, string?][] = [
    [`Provider: ${caps.providerName || '自定义'}`, true, ''],
    ['流式', Boolean(caps.streaming)],
    ['流式统计', Boolean(caps.streamUsage)],
    ['工具', Boolean(caps.tools)],
    ['视觉', Boolean(caps.vision)],
    ['思考', Boolean(caps.thinking)],
    ['缓存统计', Boolean(caps.promptCacheUsage)],
  ];
  container.textContent = '';
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

function renderProviderReadinessCard(report: Record<string, any>) {
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

function renderProviderPresets(container: HTMLElement | null) {
  if (!container) return;
  container.textContent = '';
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

function renderModelQuickSelect(container: HTMLElement | null) {
  if (!container) return;
  container.textContent = '';
  for (const provider of PROVIDER_PRESETS.filter((item: Record<string, any>) => item.models?.length)) {
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
