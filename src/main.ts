/**
 * DeepChat — Main Entry Point
 *
 * Keyboard shortcuts:
 * - Enter: send message (default)
 * - Shift+Enter: new line
 * - Ctrl+Enter: also sends (alternative)
 * - Ctrl+N: new chat
 * - Ctrl+/: focus input box
 * - Escape: close settings panel
 */

// Styles
import './styles/index.css';
import './styles/chat-evidence.css';
import './styles/chat-sidebar.css';
import './styles/chat-header.css';
import './styles/chat-input.css';
import './styles/chat-welcome.css';
import './styles/chat-responsive.css';
import './styles/chat-extras.css';
import './styles/message-base.css';
import './styles/message-content.css';
import './styles/message-tool-call.css';
import './styles/message-dialog.css';
import './styles/code.css';
import './styles/markdown.css';
import './styles/widgets.css';
import './styles/settings.css';
import './styles/reading-navigator.css';
import './styles/animations.css';
import './styles/agent-crew.css';
import './styles/agent-theatre.css';
import './styles/inspector-panel.css';
import './styles/artifact-panel.css';
import './styles/tool-card.css';
import './styles/agent-trace.css';

// Modules
import {
  initApiSettings,
  estimateTokens,
  extractContextMentions,
  getSettings,
  isSkillRunnable,
  supportsVisionModel,
  getModelCapabilities,
  getProviderCompatibilityReport,
} from './modules/api.js';
import { initTheme, toggleTheme } from './modules/theme.js';
import { initSettings } from './modules/settings.js';
import {
  initChat,
  createConversation,
  sendMessage,
  stopStreaming,
  clearCurrentChat,
  updateModelDisplay,
  exportCurrentChat,
  setActiveConversationComposerMode,
} from './modules/chat.js';
import { onMenuNewChat, onMenuOpenSettings } from './modules/client-store.js';
import { initReadingNavigator } from './modules/reading-navigator.js';
import { initInspectorPanel } from './modules/inspector-panel.js';
import { initArtifactPanel, openArtifactPanel } from './modules/artifact-panel.js';
import { autoResize, debounce, showToast } from './modules/utils.js';
import {
  applyComposerModeToPrompt,
  buildComposerModeEntries,
  getComposerMode,
  getComposerModeOverrides,
} from './modules/composer-modes.js';
import {
  buildComposerContextPreview,
  buildComposerIntentPreview,
  buildComposerToolEntries,
  getComposerToolApprovalSummary,
  getComposerToolModeLabel,
  resolveActiveSkillForExplicitDirectives,
} from './modules/composer-tools.js';
import { buildContextShortcutEntries, formatContextMentionTitle } from './modules/context-shortcuts.js';
import { applyPromptTemplate, getPromptTemplateEntries } from './modules/prompt-templates.js';
import { maybeShowProviderSetupHint } from './modules/app-startup.js';
import { toggleChatSearch, toggleKeyboardHelp, toggleMarkdownPreview } from './modules/app-overlays.js';
import {
  appendTextAttachmentsToPrompt,
  clearPendingAttachmentPreview,
  handleDroppedFiles,
} from './modules/composer-attachments.js';
import { createComposerInputHistory } from './modules/composer-history.js';

let pendingAttachments: any[] = [];
let composerOverrides: any = null;
let composerModeId = 'daily';
let latestMcpStatuses: any[] = [];
const INPUT_HISTORY_KEY = 'dc_input_history';
const inputHistory = createComposerInputHistory({ key: INPUT_HISTORY_KEY });
let applySettingsToComposerCurrent: (settings?: any) => void = () => {};

// ─── Initialize ───

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  await initApiSettings();
  await initChat();
  bindEvents();
  maybeShowOnboardingHint();
  // Defer non-critical init to improve perceived startup time
  const schedule =
    typeof requestIdleCallback !== 'undefined' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 0);
  schedule(() => {
    initReadingNavigator();
    initSettings(onModelChange);
    initInspectorPanel();
    initArtifactPanel();
  });
});

function onModelChange(model: string) {
  updateModelDisplay(model);
}

function maybeShowOnboardingHint() {
  maybeShowProviderSetupHint({
    getSettings,
    getProviderCompatibilityReport,
    showToast,
  });
}

// ─── Event Bindings ───

function bindEvents() {
  const $input = document.getElementById('message-input') as HTMLTextAreaElement;
  const $sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  const $stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
  const $newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement;
  const $clearBtn = document.getElementById('clear-chat-btn') as HTMLButtonElement;
  const $exportBtn = document.getElementById('export-chat-btn') as HTMLButtonElement | null;
  const $themeBtn = document.getElementById('theme-toggle-btn') as HTMLButtonElement;
  const $sidebarToggle = document.getElementById('sidebar-toggle') as HTMLButtonElement;
  const $mobileSidebarToggle = document.getElementById('mobile-sidebar-toggle') as HTMLButtonElement | null;
  const $sidebar = document.getElementById('sidebar') as HTMLElement;
  const mobileLayoutQuery = window.matchMedia('(max-width: 768px)');
  const settingsPanel = document.getElementById('settings-panel') as HTMLElement;
  const settingsOverlay = document.getElementById('settings-overlay') as HTMLElement;

  function openSettings() {
    settingsPanel.classList.remove('hidden');
    settingsOverlay.classList.remove('hidden');
  }

  async function triggerNewChat() {
    await createConversation();
    const settings: any = getSettings();
    composerModeId = getComposerMode(settings.defaultComposerMode || 'daily').id;
    composerOverrides = {
      ...composerOverrides,
      ...getComposerModeOverrides(composerModeId, settings),
    };
    applySettingsToComposerCurrent(settings);
    $input.value = '';
    $input.style.height = 'auto';
    $sendBtn.disabled = true;
    clearPendingAttachments();
    $input.dispatchEvent(new Event('input', { bubbles: true }));
    // Reset token estimator
    const badge = document.getElementById('token-badge');
    if (badge) badge.classList.add('hidden');
    $input.focus();
  }

  function syncSidebarToggleState() {
    const collapsed = $sidebar.classList.contains('collapsed');
    const mobileOpen = $sidebar.classList.contains('mobile-open');
    const expanded = mobileLayoutQuery.matches ? mobileOpen : !collapsed;

    $sidebarToggle.setAttribute('aria-expanded', String(expanded));
    $sidebarToggle.title = mobileLayoutQuery.matches ? '关闭侧边栏' : '折叠侧边栏';

    if ($mobileSidebarToggle) {
      $mobileSidebarToggle.setAttribute('aria-expanded', String(expanded));
      $mobileSidebarToggle.title = collapsed ? '展开侧边栏' : '菜单';
    }
  }

  // ─── Input ───
  const badge = document.getElementById('token-badge');
  initComposerOptions(openSettings);
  inputHistory.reload();

  const updateTokenHint = debounce(() => {
    if (!badge) return;
    const text = $input.value.trim();
    if (text.length > 0) {
      const tokens = estimateTokens(text);
      const contextMentions = extractContextMentions(text);
      badge.textContent = `≈${tokens} tokens · ${text.length} 字符${contextMentions.length ? ` · 上下文 ${contextMentions.length}` : ''}`;
      badge.title = contextMentions.length ? formatContextMentionTitle(contextMentions) : '';
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
      badge.title = '';
    }
  }, 100);

  $input.addEventListener('input', () => {
    autoResize($input);
    $sendBtn.disabled = !$input.value.trim() && pendingAttachments.length === 0;
    updateTokenHint();
  });

  // Keyboard: Enter sends, Shift+Enter newline, Ctrl+Enter also sends
  $input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      $input.value = inputHistory.navigate(e.key === 'ArrowUp' ? -1 : 1);
      autoResize($input);
      $sendBtn.disabled = !$input.value.trim() && pendingAttachments.length === 0;
      updateTokenHint();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  $sendBtn.addEventListener('click', handleSend);
  $stopBtn.addEventListener('click', stopStreaming);

  // New chat
  $newChatBtn.addEventListener('click', triggerNewChat);

  // Clear chat
  $clearBtn.addEventListener('click', () => {
    clearCurrentChat();
    $input.focus();
  });

  // Export chat
  if ($exportBtn) {
    $exportBtn.addEventListener('click', () => toggleExportMenu($exportBtn));
  }

  // Theme toggle
  $themeBtn.addEventListener('click', toggleTheme);

  onMenuOpenSettings(openSettings);
  onMenuNewChat(triggerNewChat);

  // Sidebar toggle (desktop collapse / mobile drawer close)
  $sidebarToggle.addEventListener('click', () => {
    if (mobileLayoutQuery.matches) {
      $sidebar.classList.remove('mobile-open');
    } else {
      $sidebar.classList.toggle('collapsed');
    }
    syncSidebarToggleState();
  });

  // External sidebar toggle: reopen desktop sidebar or open mobile drawer
  if ($mobileSidebarToggle) {
    $mobileSidebarToggle.addEventListener('click', () => {
      if ($sidebar.classList.contains('collapsed')) {
        $sidebar.classList.remove('collapsed');
      } else {
        $sidebar.classList.toggle('mobile-open');
      }
      syncSidebarToggleState();
    });
  }

  // Close mobile sidebar when clicking outside
  document.addEventListener('click', (e) => {
    const target = e.target as Node | null;
    if (
      $sidebar.classList.contains('mobile-open') &&
      target &&
      !$sidebar.contains(target) &&
      (!$mobileSidebarToggle || (target !== $mobileSidebarToggle && !$mobileSidebarToggle.contains(target)))
    ) {
      $sidebar.classList.remove('mobile-open');
      syncSidebarToggleState();
    }
  });

  mobileLayoutQuery.addEventListener('change', () => {
    $sidebar.classList.remove('mobile-open');
    syncSidebarToggleState();
  });

  syncSidebarToggleState();

  // Escape key: close settings / stop streaming
  // Ctrl+/: focus input · Ctrl+N: new chat
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const settingsPanel = document.getElementById('settings-panel');
      const settingsOverlay = document.getElementById('settings-overlay');
      if (settingsPanel && !settingsPanel.classList.contains('hidden')) {
        settingsPanel.classList.add('hidden');
        settingsOverlay?.classList.add('hidden');
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault();
      $input.focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      e.preventDefault();
      triggerNewChat();
    }
    if (e.key === 'F1') {
      e.preventDefault();
      toggleKeyboardHelp();
    }
    // Ctrl+F: search within current conversation
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      toggleChatSearch();
    }
    // Ctrl+P: preview markdown input
    if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
      e.preventDefault();
      toggleMarkdownPreview($input.value);
    }
  });

  // ─── Scroll-to-bottom FAB ───
  const $chatMessages = document.getElementById('chat-messages');
  const scrollFab = document.createElement('button');
  scrollFab.className = 'scroll-to-bottom-fab hidden';
  scrollFab.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`; /* safeSetHTML-exempt: static template */
  scrollFab.title = '回到底部';
  document.getElementById('main-content')?.appendChild(scrollFab);

  scrollFab.addEventListener('click', () => {
    $chatMessages?.scrollTo({ top: $chatMessages.scrollHeight, behavior: 'smooth' });
  });

  $chatMessages?.addEventListener('scroll', () => {
    const threshold = 200;
    const atBottom = $chatMessages.scrollHeight - $chatMessages.scrollTop - $chatMessages.clientHeight < threshold;
    scrollFab.classList.toggle('hidden', atBottom);
  });

  // Suggestion cards
  document.querySelectorAll('.suggestion-card').forEach((card) => {
    card.addEventListener('click', () => {
      const prompt = (card as HTMLElement).dataset.prompt;
      if (prompt) {
        $input.value = prompt;
        autoResize($input);
        $sendBtn.disabled = false;
        handleSend();
      }
    });
  });

  // Focus input on load
  $input.focus();

  // ─── Drag-and-Drop File Attachment ───
  const $inputContainer = document.querySelector('.input-container');
  if ($inputContainer) {
    $inputContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      $inputContainer.classList.add('drag-over');
    });
    $inputContainer.addEventListener('dragleave', (e) => {
      e.preventDefault();
      $inputContainer.classList.remove('drag-over');
    });
    $inputContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      $inputContainer.classList.remove('drag-over');
      const files = Array.from((e as DragEvent).dataTransfer?.files || []);
      if (files.length === 0) return;
      handleDroppedFiles(files, $input, {
        getPendingAttachments: () => pendingAttachments,
        setPendingAttachments: (attachments) => {
          pendingAttachments = attachments;
        },
        showToast,
        autoResize,
        toggleMarkdownPreview,
      });
    });
  }
}

async function handleSend() {
  const $input = document.getElementById('message-input') as HTMLTextAreaElement | null;
  const content = $input?.value?.trim() || '';
  if (!content && pendingAttachments.length === 0) return;

  const hasImages = pendingAttachments.some((item) => String(item.mimeType || '').startsWith('image/'));
  if (hasImages && !supportsVisionModel(getSettings())) {
    showToast(`当前模型 ${getSettings().model} 未标记为支持图片输入，请切换 vision 模型后再发送。`, 3200);
    return;
  }

  const attachments = pendingAttachments.map((item) => ({ ...item }));
  const overrides = getComposerOverrides();

  let finalModelContent = applyComposerModeToPrompt(content, composerModeId);
  finalModelContent = appendTextAttachmentsToPrompt(finalModelContent, pendingAttachments);

  inputHistory.remember(content);

  $input.value = '';
  $input.style.height = 'auto';
  (document.getElementById('send-btn') as HTMLButtonElement | null)!.disabled = true;
  clearPendingAttachments();
  $input.dispatchEvent(new Event('input', { bubbles: true }));

  await sendMessage(content, { attachments, composerOverrides: overrides, modelContent: finalModelContent });
  setActiveConversationComposerMode(composerModeId);
}

const COMPOSER_THINKING_LABELS = new Map([
  ['0', '自动'],
  ['4096', '轻量'],
  ['8192', '标准'],
  ['16384', '深度'],
  ['32768', '极深'],
]);

function initComposerOptions(openSettings: (() => void) | undefined) {
  const $toolbar = document.querySelector('.composer-toolbar') as HTMLElement | null;
  const $modeSelect = document.getElementById('composer-mode-select') as HTMLSelectElement | null;
  const $chipToggle = document.getElementById('composer-chip-toggle') as HTMLButtonElement | null;
  const $thinking = document.getElementById('composer-thinking-select') as HTMLSelectElement | null;
  const $webToggle = document.getElementById('composer-web-search-toggle') as HTMLInputElement | null;
  const $webStatus = document.getElementById('composer-search-status') as HTMLElement | null;
  const $enhanceToggle = document.getElementById('composer-enhance-toggle') as HTMLInputElement | null;
  const $enhanceStatus = document.getElementById('composer-enhance-status') as HTMLElement | null;
  const $toolDrawerBtn = document.getElementById('composer-tool-drawer-btn') as HTMLButtonElement | null;
  const $toolStatus = document.getElementById('composer-tool-status') as HTMLElement | null;
  const $contextBtn = document.getElementById('composer-context-btn') as HTMLButtonElement | null;
  const $advancedToggle = document.getElementById('composer-advanced-toggle') as HTMLButtonElement | null;
  const $runStatus = document.getElementById('composer-run-status') as HTMLElement | null;
  const $contextPreview = document.getElementById('composer-context-preview') as HTMLElement | null;
  const $templateBtn = document.getElementById('composer-template-btn') as HTMLButtonElement | null;
  const $settingsShortcut = document.getElementById('composer-settings-shortcut') as HTMLButtonElement | null;
  const $webToggleLabel = $webToggle?.closest('.composer-search-toggle');
  const $enhanceToggleLabel = $enhanceToggle?.closest('.composer-enhance-toggle');
  if (!$thinking || !$webToggle) return;

  let syncing = false;
  composerOverrides = {
    thinkingBudget: getSettings().thinkingBudget,
    activeSkill: getSettings().activeSkill,
    enhance: getSettings().enhance !== false,
  };

  function applySettingsToComposer(settings: any = getSettings()) {
    syncing = true;
    if (!composerOverrides) {
      composerOverrides = {
        thinkingBudget: settings.thinkingBudget,
        activeSkill: settings.activeSkill,
        enhance: settings.enhance !== false,
      };
    }
    syncComposerModeSelect($modeSelect, composerModeId, settings);
    // Mode select sync handled by syncComposerModeSelect above
    syncThinkingSelect($thinking, composerOverrides.thinkingBudget);

    const hasSearchKey = Boolean(settings.tavilyApiKey);
    const activeSkill = composerOverrides.activeSkill || settings.activeSkill;
    const searchMode = activeSkill === 'web_search';
    const multiToolSearch = activeSkill === 'multi_tool' && hasSearchKey;
    $webToggle.checked = searchMode || multiToolSearch;
    if ($webStatus) $webStatus.textContent = getSearchStatusText({ ...settings, activeSkill });
    $webToggleLabel?.classList.toggle('is-unavailable', !hasSearchKey);

    if ($enhanceToggle) $enhanceToggle.checked = composerOverrides.enhance !== false;
    if ($enhanceStatus) $enhanceStatus.textContent = composerOverrides.enhance === false ? '关闭' : '开启';
    $enhanceToggleLabel?.classList.toggle('is-disabled', composerOverrides.enhance === false);
    updateComposerToolButton($toolDrawerBtn, $toolStatus, { ...settings, activeSkill });
    const composedSettings = { ...settings, ...composerOverrides, mcpStatuses: latestMcpStatuses };
    updateComposerRunStatus(
      $runStatus,
      composedSettings,
      $thinking.value,
      (document.getElementById('message-input') as HTMLTextAreaElement | null)?.value || ''
    );
    renderComposerContextPreview(
      $contextPreview,
      (document.getElementById('message-input') as HTMLTextAreaElement | null)?.value || '',
      composedSettings
    );
    syncing = false;
  }
  applySettingsToComposerCurrent = applySettingsToComposer;

  if ($modeSelect) {
    $modeSelect.addEventListener('change', () => {
      const modeValue = $modeSelect.value;
      if (!modeValue) return;
      const settings = getSettings();
      composerModeId = getComposerMode(modeValue).id;
      const modeOverrides = getComposerModeOverrides(composerModeId, settings);
      composerOverrides = {
        ...composerOverrides,
        ...modeOverrides,
      };
      applySettingsToComposer(settings);
      setActiveConversationComposerMode(composerModeId);
      showToast(`本轮模式：${getComposerMode(composerModeId).label}`, 1200);
    });
  }

  if ($chipToggle) {
    $chipToggle.addEventListener('click', () => {
      const isOpen = $toolbar?.classList.toggle('is-chip-open');
      $chipToggle.setAttribute('aria-expanded', String(isOpen));
    });
  }

  $thinking.addEventListener('change', async () => {
    if (syncing) return;
    const budget = Number.parseInt($thinking.value, 10) || 0;
    try {
      composerOverrides.thinkingBudget = budget;
      applySettingsToComposer(getSettings());
      showToast(`思考程度：${getThinkingLabel(String(budget))}`, 1200);
    } catch (error: any) {
      applySettingsToComposer();
      showToast(error.message || '思考程度保存失败');
    }
  });

  $webToggle.addEventListener('change', async () => {
    if (syncing) return;
    const settings = getSettings();

    if ($webToggle.checked) {
      if (!isSkillRunnable('web_search', { ...settings, activeSkill: 'web_search' })) {
        applySettingsToComposer(settings);
        showToast('请先在设置中配置 Tavily API Key');
        openSettings?.();
        return;
      }
      try {
        composerOverrides.activeSkill = 'web_search';
        applySettingsToComposer(settings);
        showToast('本轮已开启联网搜索', 1200);
      } catch (error: any) {
        applySettingsToComposer();
        showToast(error.message || '联网搜索开启失败');
      }
      return;
    }

    if (settings.activeSkill === 'web_search' || settings.activeSkill === 'multi_tool') {
      try {
        composerOverrides.activeSkill = 'none';
        applySettingsToComposer(settings);
        showToast('本轮已关闭联网搜索', 1200);
      } catch (error: any) {
        applySettingsToComposer();
        showToast(error.message || '联网搜索关闭失败');
      }
    } else {
      composerOverrides.activeSkill = 'none';
      applySettingsToComposer(settings);
    }
  });

  if ($enhanceToggle) {
    $enhanceToggle.addEventListener('change', async () => {
      if (syncing) return;
      try {
        composerOverrides.enhance = $enhanceToggle.checked;
        applySettingsToComposer(getSettings());
        showToast($enhanceToggle.checked ? '本轮已开启提示词自动增强' : '本轮已关闭提示词自动增强', 1200);
      } catch (error: any) {
        applySettingsToComposer();
        showToast(error.message || '自动增强保存失败');
      }
    });
  }

  if ($settingsShortcut) {
    $settingsShortcut.addEventListener('click', () => openSettings?.());
  }

  if ($templateBtn) {
    $templateBtn.addEventListener('click', () =>
      togglePromptTemplateMenu($templateBtn, (template) => {
        const modeId = getComposerMode(template.recommendedModeId || 'daily').id;
        const settings = getSettings();
        composerModeId = modeId;
        composerOverrides = {
          ...composerOverrides,
          ...getComposerModeOverrides(composerModeId, settings),
        };
        applySettingsToComposer(settings);
        showToast(`已套用模板：${template.title} · ${getComposerMode(composerModeId).label}模式`, 1600);
      })
    );
  }

  if ($advancedToggle && $toolbar) {
    $advancedToggle.addEventListener('click', () => {
      const expanded = $toolbar.classList.toggle('is-advanced-open');
      $advancedToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      $advancedToggle.textContent = expanded ? '收起' : '选项';
    });
  }

  if ($toolDrawerBtn) {
    $toolDrawerBtn.addEventListener('click', () =>
      toggleComposerToolMenu(
        $toolDrawerBtn,
        () => {
          applySettingsToComposer(getSettings());
        },
        openSettings
      )
    );
  }

  if ($contextBtn) {
    $contextBtn.addEventListener('click', () => toggleContextShortcutMenu($contextBtn, openSettings));
  }

  // Mode select change handler (replaces mode pills)

  document.querySelectorAll('[data-context-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const settings = getSettings();
      const entry = buildContextShortcutEntries(settings).find(
        (item) => item.id === (chip as HTMLElement).dataset.contextChip
      );
      if (!entry) return;
      if (!entry.available) {
        showToast(entry.state);
        if (['需工作区', '需 Tavily Key', '需 MCP'].includes(entry.state)) openSettings?.();
        return;
      }
      const input = document.getElementById('message-input') as HTMLTextAreaElement | null;
      insertIntoComposer(input, entry);
      input?.focus();
    });
  });

  window.addEventListener('deepchat:conversation-switched', (event) => {
    const detail = (event as CustomEvent).detail || {};
    const savedMode = detail.composerModeId;
    if (savedMode) {
      composerModeId = getComposerMode(savedMode).id;
      const settings = getSettings();
      composerOverrides = {
        ...composerOverrides,
        ...getComposerModeOverrides(composerModeId, settings),
      };
      applySettingsToComposer(settings);
    }
  });

  window.addEventListener('deepchat:settings-changed', (event) => {
    const detail = (event as CustomEvent).detail || {};
    applySettingsToComposer(detail.settings || getSettings());
  });

  window.addEventListener('deepchat:mcp-status-changed', (event) => {
    const detail = (event as CustomEvent).detail || {};
    latestMcpStatuses = Array.isArray(detail.statuses) && !detail.stale ? detail.statuses : [];
    applySettingsToComposer(getSettings());
  });

  document.getElementById('message-input')?.addEventListener('input', () => {
    const settings = { ...getSettings(), ...composerOverrides, mcpStatuses: latestMcpStatuses };
    const inputText = (document.getElementById('message-input') as HTMLTextAreaElement | null)?.value || '';
    updateComposerRunStatus($runStatus, settings, $thinking.value, inputText);
    renderComposerContextPreview($contextPreview, inputText, settings);
  });

  applySettingsToComposer();
}

function syncComposerModeSelect(select, activeModeId, settings = {}) {
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

let promptTemplateMenu = null;
let exportMenu = null;
let composerToolMenu = null;
let contextShortcutMenu = null;

function togglePromptTemplateMenu(anchor, onApplyTemplate) {
  if (promptTemplateMenu) {
    promptTemplateMenu.remove();
    promptTemplateMenu = null;
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'prompt-template-menu';
  for (const template of getPromptTemplateEntries()) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'prompt-template-item';
    item.title = buildPromptTemplateTitle(template);
    const head = document.createElement('span');
    head.className = 'prompt-template-head';
    const title = document.createElement('span');
    title.className = 'prompt-template-title';
    title.textContent = template.title;
    const mode = document.createElement('span');
    mode.className = 'prompt-template-mode';
    mode.textContent = template.mode || '模板';
    head.append(title, mode);
    const desc = document.createElement('span');
    desc.className = 'prompt-template-desc';
    desc.textContent = template.description || template.intent || '插入常用提示词模板';
    const intent = document.createElement('span');
    intent.className = 'prompt-template-intent';
    intent.textContent = template.intent || '';
    item.append(head, desc);
    if (intent.textContent) item.appendChild(intent);
    item.addEventListener('click', () => {
      const input = document.getElementById('message-input') as HTMLTextAreaElement;
      input.value = applyPromptTemplate(input.value, template.text);
      autoResize(input);
      (document.getElementById('send-btn') as HTMLButtonElement | null)!.disabled = false;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      onApplyTemplate?.(template);
      promptTemplateMenu?.remove();
      promptTemplateMenu = null;
      input.focus();
    });
    menu.appendChild(item);
  }
  anchor.closest('.composer-toolbar')?.appendChild(menu);
  promptTemplateMenu = menu;
}

function buildPromptTemplateTitle(template: any = {}) {
  return [
    template.description,
    template.mode ? `推荐模式：${template.mode}` : '',
    template.intent ? `上下文/工具：${template.intent}` : '',
    '',
    template.text,
  ]
    .filter((line) => line !== undefined && line !== null)
    .join('\n')
    .trim();
}

function toggleComposerToolMenu(anchor, onChange, openSettings) {
  if (composerToolMenu) {
    composerToolMenu.remove();
    composerToolMenu = null;
    anchor?.setAttribute('aria-expanded', 'false');
    return;
  }

  const settings = getSettings();
  const activeSkill = composerOverrides?.activeSkill || settings.activeSkill;
  const menu = document.createElement('div');
  menu.className = 'composer-tool-menu';
  menu.setAttribute('role', 'menu');
  const entries = buildComposerToolEntries(settings, activeSkill);

  for (const entry of entries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `composer-tool-item${entry.active ? ' active' : ''}${entry.available ? '' : ' unavailable'}`;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(entry.active));
    item.setAttribute('aria-disabled', String(!entry.available));
    item.innerHTML = ` /* safeSetHTML-exempt: static template */
      <span class="composer-tool-item-icon">${entry.icon}</span>
      <span class="composer-tool-item-body">
        <span class="composer-tool-item-title">${entry.name}</span>
        <span class="composer-tool-item-desc">${entry.description}</span>
      </span>
      <span class="composer-tool-item-state">${entry.available ? entry.risk : entry.state}</span>
    `;
    item.addEventListener('click', () => {
      if (!entry.available) {
        showToast(entry.state);
        openSettings?.();
        return;
      }
      composerOverrides.activeSkill = entry.id;
      composerToolMenu?.remove();
      composerToolMenu = null;
      anchor?.setAttribute('aria-expanded', 'false');
      onChange?.();
      showToast(`本轮工具：${entry.name}`, 1200);
    });
    menu.appendChild(item);
  }

  const footer = document.createElement('div');
  footer.className = 'composer-tool-menu-footer';
  footer.textContent = getComposerToolApprovalSummary(settings);
  menu.appendChild(footer);

  anchor.closest('.composer-toolbar')?.appendChild(menu);
  composerToolMenu = menu;
  anchor?.setAttribute('aria-expanded', 'true');

  const closeOnOutside = (event) => {
    if (!composerToolMenu) {
      document.removeEventListener('click', closeOnOutside);
      return;
    }
    if (composerToolMenu.contains(event.target) || anchor.contains(event.target)) return;
    composerToolMenu.remove();
    composerToolMenu = null;
    anchor?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeOnOutside);
  };
  setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
}

function toggleContextShortcutMenu(anchor, openSettings) {
  if (contextShortcutMenu) {
    contextShortcutMenu.remove();
    contextShortcutMenu = null;
    anchor?.setAttribute('aria-expanded', 'false');
    return;
  }

  const settings = getSettings();
  const menu = document.createElement('div');
  menu.className = 'context-shortcut-menu';
  menu.setAttribute('role', 'menu');

  for (const entry of buildContextShortcutEntries(settings)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `context-shortcut-item${entry.available ? '' : ' unavailable'}`;
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-disabled', String(!entry.available));
    item.innerHTML = ` /* safeSetHTML-exempt: static template */
      <span class="context-shortcut-title">${entry.title}</span>
      <span class="context-shortcut-desc">${entry.description}</span>
      <code class="context-shortcut-code">${entry.insertText}</code>
      <span class="context-shortcut-state">${entry.state}</span>
    `;
    item.addEventListener('click', () => {
      if (!entry.available) {
        showToast(entry.state);
        openSettings?.();
        return;
      }
      const input = document.getElementById('message-input') as HTMLTextAreaElement;
      insertIntoComposer(input, entry);
      contextShortcutMenu?.remove();
      contextShortcutMenu = null;
      anchor?.setAttribute('aria-expanded', 'false');
      input.focus();
    });
    menu.appendChild(item);
  }

  const footer = document.createElement('div');
  footer.className = 'context-shortcut-footer';
  footer.textContent = '显式上下文优先于自动判断，能减少误用工具。';
  menu.appendChild(footer);

  anchor.closest('.composer-toolbar')?.appendChild(menu);
  contextShortcutMenu = menu;
  anchor?.setAttribute('aria-expanded', 'true');

  const closeOnOutside = (event) => {
    if (!contextShortcutMenu) {
      document.removeEventListener('click', closeOnOutside);
      return;
    }
    if (contextShortcutMenu.contains(event.target) || anchor.contains(event.target)) return;
    contextShortcutMenu.remove();
    contextShortcutMenu = null;
    anchor?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeOnOutside);
  };
  setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
}

function insertIntoComposer(input: HTMLTextAreaElement | null, entry: any) {
  if (!input || !entry?.insertText) return;
  const prefix = input.value && !/\s$/.test(input.value) ? ' ' : '';
  const insertion = `${prefix}${entry.insertText}`;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(insertion, start, end, 'end');
  if (entry.selectStartOffset >= 0 && entry.selectEndOffset >= 0) {
    const selectionStart = start + prefix.length + entry.selectStartOffset;
    const selectionEnd = start + prefix.length + entry.selectEndOffset;
    input.setSelectionRange(selectionStart, selectionEnd);
  }
  autoResize(input);
  (document.getElementById('send-btn') as HTMLButtonElement | null)!.disabled =
    !input.value.trim() && pendingAttachments.length === 0;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function toggleExportMenu(anchor) {
  if (exportMenu) {
    exportMenu.remove();
    exportMenu = null;
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'prompt-template-menu export-format-menu';
  const formats = [
    ['markdown', '导出 Markdown'],
    ['html', '导出 HTML'],
    ['pdf', '打印 / 另存 PDF'],
    ['favorites', '只导出收藏'],
    ['tool-evidence', '导出工具证据'],
    ['assets', '导出资源索引'],
  ];
  for (const [format, label] of formats) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', () => {
      exportCurrentChat(format);
      exportMenu?.remove();
      exportMenu = null;
    });
    menu.appendChild(item);
  }
  document.getElementById('chat-header').appendChild(menu);
  exportMenu = menu;
}

function getComposerOverrides() {
  const settings = getSettings();
  const modeOverrides = getComposerModeOverrides(composerModeId, settings);
  const inputText = (document.getElementById('message-input') as HTMLTextAreaElement | null)?.value || '';
  const baseActiveSkill = composerOverrides?.activeSkill ?? modeOverrides.activeSkill ?? settings.activeSkill;
  const activeSkill = resolveActiveSkillForExplicitDirectives(inputText, settings, baseActiveSkill);
  return {
    ...modeOverrides,
    thinkingBudget: composerOverrides?.thinkingBudget ?? settings.thinkingBudget,
    activeSkill,
    enhance: composerOverrides?.enhance ?? modeOverrides.enhance ?? settings.enhance !== false,
  };
}

function syncThinkingSelect(select, budget) {
  const normalized = String(Number.parseInt(budget, 10) || 0);
  const customOption = select.querySelector('[data-custom-thinking="true"]');

  if (COMPOSER_THINKING_LABELS.has(normalized)) {
    customOption?.remove();
  } else {
    const option = customOption || document.createElement('option');
    option.dataset.customThinking = 'true';
    option.value = normalized;
    option.textContent = `自定义 ${normalized}`;
    if (!customOption) select.appendChild(option);
  }

  select.value = normalized;
}

function getThinkingLabel(value) {
  return COMPOSER_THINKING_LABELS.get(value) || `${value} tokens`;
}

function getSearchStatusText(settings) {
  if (!settings.tavilyApiKey) return '需配置';
  if (settings.activeSkill === 'web_search') return '开启';
  if (settings.activeSkill === 'multi_tool') return '全工具';
  return '关闭';
}

function updateComposerRunStatus(target, settings, thinkingValue, inputText = '') {
  if (!target) return;
  const thinking = getThinkingLabel(String(Number.parseInt(thinkingValue, 10) || 0));
  const tool = getComposerToolModeLabel(settings.activeSkill);
  const mode = getComposerMode(composerModeId);
  const search = getSearchStatusText(settings);
  const enhance = settings.enhance === false ? '增强关闭' : '增强开启';
  const caps = getModelCapabilities(settings);
  const preview = buildComposerIntentPreview(inputText, settings);
  const base = `本轮：${mode.label}模式 · ${tool} · ${thinking}思考 · 搜索${search} · ${enhance} · 图片${caps.vision ? '可用' : '不可用'}`;
  target.textContent = preview.text ? `${base} · ${preview.text}` : base;
  target.title = preview.title || '根据当前设置展示本轮模型、工具和输入意图预判。';
  target.dataset.intentState = preview.state || 'idle';
}

function renderComposerContextPreview(target: HTMLElement | null, inputText = '', settings: any = {}) {
  if (!target) return;
  const preview = buildComposerContextPreview(inputText, {
    ...settings,
    mcpStatuses: settings.mcpStatuses || latestMcpStatuses,
  });
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

function updateComposerToolButton(button: HTMLElement | null, status: HTMLElement | null, settings: any) {
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

function clearPendingAttachments() {
  pendingAttachments = [];
  clearPendingAttachmentPreview();
}
