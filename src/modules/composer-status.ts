import { getModelCapabilities } from './api.js';
import { hasNativeBridge } from './bridge.js';
import { buildComposerModeEntries, getComposerMode } from './composer-modes.js';
import {
  buildComposerContextPreview,
  buildComposerIntentPreview,
  buildComposerToolEntries,
  getComposerToolModeLabel,
} from './composer-tools.js';

const COMPOSER_THINKING_LABELS = new Map([
  ['0', '自动'],
  ['4096', '轻量'],
  ['8192', '标准'],
  ['16384', '深度'],
  ['32768', '极深'],
]);

export function syncComposerModeSelect(
  select: HTMLSelectElement | null,
  activeModeId: string,
  settings: Record<string, any> = {}
) {
  if (!select) return;
  const entries = buildComposerModeEntries(settings);
  const resolvedModeId = getComposerMode(activeModeId).id;
  for (const option of select.options) {
    const entry = entries.find((item) => item.id === option.value);
    if (entry) {
      option.textContent = entry.label;
      option.title = entry.description;
      option.disabled = !entry.available;
    }
  }
  select.value = resolvedModeId;
}

export function syncThinkingSelect(select: HTMLSelectElement | null, budget: unknown) {
  if (!select) return;
  const normalized = String(Number.parseInt(String(budget), 10) || 0);
  const customOption = select.querySelector('[data-custom-thinking="true"]');

  if (COMPOSER_THINKING_LABELS.has(normalized)) {
    customOption?.remove();
  } else {
    const option = (customOption as HTMLOptionElement | null) || document.createElement('option');
    option.dataset.customThinking = 'true';
    option.value = normalized;
    option.textContent = `自定义 ${normalized}`;
    if (!customOption) select.appendChild(option);
  }

  select.value = normalized;
}

export function getThinkingLabel(value: unknown) {
  const normalized = String(value);
  return COMPOSER_THINKING_LABELS.get(normalized) || `${normalized} tokens`;
}

export function getSearchStatusText(settings: Record<string, any> = {}) {
  if (!hasSearchCapability(settings)) return '需配置';
  if (settings.activeSkill === 'web_search') return '开启';
  if (settings.activeSkill === 'multi_tool') return '全工具';
  if (!settings.tavilyApiKey) return '兜底';
  return '关闭';
}

function hasSearchCapability(settings: Record<string, any> = {}) {
  if (settings.tavilyApiKey) return true;
  if (!hasNativeBridge()) return false;
  if (settings.docsetSearchEnabled === true && Array.isArray(settings.docsetRoots) && settings.docsetRoots.length > 0) {
    return true;
  }
  return String(settings.localSearchFallbackMode || '') === 'missing_key';
}

export function updateComposerRunStatus(
  target: HTMLElement | null,
  settings: Record<string, any>,
  thinkingValue: unknown,
  inputText = '',
  modeId = 'daily'
) {
  if (!target) return;
  const thinking = getThinkingLabel(String(Number.parseInt(String(thinkingValue), 10) || 0));
  const tool = getComposerToolModeLabel(settings.activeSkill);
  const mode = getComposerMode(modeId);
  const search = getSearchStatusText(settings);
  const enhance = settings.enhance === false ? '增强关闭' : '增强开启';
  const caps = getModelCapabilities(settings);
  const preview = buildComposerIntentPreview(inputText, settings);
  const base = `本轮：${mode.label}模式 · ${tool} · ${thinking}思考 · 搜索${search} · ${enhance} · 图片${caps.vision ? '可用' : '不可用'}`;
  target.textContent = preview.text ? `${base} · ${preview.text}` : base;
  target.title = preview.title || '根据当前设置展示本轮模型、工具和输入意图预判。';
  target.dataset.intentState = preview.state || 'idle';
}

export function renderComposerContextPreview(
  target: HTMLElement | null,
  inputText = '',
  settings: Record<string, any> = {}
) {
  if (!target) return;
  const preview = buildComposerContextPreview(inputText, settings);
  target.textContent = '';
  target.title = preview.title || '';
  for (const item of preview.items) {
    const chip = document.createElement('span');
    chip.className = `composer-context-preview-chip tone-${item.tone || 'muted'} kind-${item.kind || 'item'}`;
    chip.textContent = item.label;
    if (item.title) chip.title = item.title;
    target.appendChild(chip);
  }
}

export function updateComposerToolButton(
  button: HTMLElement | null,
  status: HTMLElement | null,
  settings: Record<string, any>
) {
  if (!button) return;
  const entries = buildComposerToolEntries(settings, settings.activeSkill);
  const current = entries.find((entry) => entry.id === settings.activeSkill) || entries[0];
  button.classList.toggle('is-unavailable', Boolean(current && !current.available));
  button.title = current
    ? `${current.name}：${current.available ? current.description : current.state}`
    : '选择本轮可用工具';
  const icon = button.querySelector('.composer-tool-icon');
  if (icon && current) icon.textContent = current.icon;
  if (status && current) status.textContent = current.name;
}
