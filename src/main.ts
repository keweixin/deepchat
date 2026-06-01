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
import './styles/workbench.css';

// Modules
import {
  initApiSettings,
  estimateTokens,
  extractContextMentions,
  getSettings,
  isSkillRunnable,
  supportsVisionModel,
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
  getInspectorOverviewData,
} from './modules/chat.js';
import { onMenuNewChat, onMenuOpenSettings } from './modules/client-store.js';
import { initReadingNavigator } from './modules/reading-navigator.js';
import { initInspectorPanel } from './modules/inspector-panel.js';
import { initArtifactPanel, openArtifactPanel } from './modules/artifact-panel.js';
import { autoResize, debounce, showToast } from './modules/utils.js';
import { applyComposerModeToPrompt, getComposerMode, getComposerModeOverrides } from './modules/composer-modes.js';
import { buildSendPreflightBlocker, resolveActiveSkillForExplicitDirectives } from './modules/composer-tools.js';
import { buildContextShortcutEntries, formatContextMentionTitle } from './modules/context-shortcuts.js';
import { maybeShowProviderSetupHint } from './modules/app-startup.js';
import {
  insertIntoComposer,
  toggleComposerToolMenu,
  toggleContextShortcutMenu,
  toggleExportMenu,
  togglePromptTemplateMenu,
} from './modules/app-menus.js';
import { toggleChatSearch, toggleKeyboardHelp, toggleMarkdownPreview } from './modules/app-overlays.js';
import {
  getSearchStatusText,
  getThinkingLabel,
  renderComposerContextPreview,
  syncComposerModeSelect,
  syncThinkingSelect,
  updateComposerRunStatus,
  updateComposerToolButton,
} from './modules/composer-status.js';
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
  // Restore serif font choice on startup
  const useSerif = localStorage.getItem('dc_font_serif') === 'true';
  if (useSerif) {
    document.body.classList.add('use-serif');
  }
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
    initInspectorPanel({ getOverviewData: getInspectorOverviewData });
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

function openSettingsPanel() {
  const settingsPanel = document.getElementById('settings-panel') as HTMLElement | null;
  const settingsOverlay = document.getElementById('settings-overlay') as HTMLElement | null;
  settingsPanel?.classList.remove('hidden');
  settingsOverlay?.classList.remove('hidden');
}

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
  const $workbenchTraceBtn = document.getElementById('workbench-trace-btn') as HTMLButtonElement | null;
  const $workbenchPerformanceBtn = document.getElementById('workbench-performance-btn') as HTMLButtonElement | null;
  const $workbenchArtifactsBtn = document.getElementById('workbench-artifacts-btn') as HTMLButtonElement | null;
  const $sidebar = document.getElementById('sidebar') as HTMLElement;
  const mobileLayoutQuery = window.matchMedia('(max-width: 768px)');
  function openSettings() {
    openSettingsPanel();
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
    $exportBtn.addEventListener('click', () => toggleExportMenu($exportBtn, exportCurrentChat));
  }

  $workbenchTraceBtn?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('deepchat:open-inspector', { detail: { mode: 'trace' } }));
  });

  $workbenchPerformanceBtn?.addEventListener('click', () => {
    const usageBadge = document.getElementById('chat-usage-badge') as HTMLElement | null;
    if (usageBadge && !usageBadge.classList.contains('hidden')) {
      usageBadge.click();
      return;
    }
    showToast('还没有本轮性能和 Token 统计；发送一次消息后这里会显示。', 2200);
  });

  $workbenchArtifactsBtn?.addEventListener('click', () => {
    const overview = getInspectorOverviewData();
    if (Number.isFinite(overview.latestArtifactIndex) && overview.latestArtifactIndex >= 0) {
      document.dispatchEvent(
        new CustomEvent('deepchat:open-artifact-inspector', { detail: { msgIndex: overview.latestArtifactIndex } })
      );
      return;
    }
    showToast('当前会话还没有 Artifact。', 1800);
  });

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
  scrollFab.type = 'button';
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

  // ─── Font Typography Switcher ───
  const $fontSansBtn = document.getElementById('font-sans-btn');
  const $fontSerifBtn = document.getElementById('font-serif-btn');
  if ($fontSansBtn && $fontSerifBtn) {
    const currentSerif = localStorage.getItem('dc_font_serif') === 'true';
    const applyFontChoice = (useSerif: boolean) => {
      localStorage.setItem('dc_font_serif', String(useSerif));
      document.body.classList.toggle('use-serif', useSerif);
      $fontSansBtn.classList.toggle('active', !useSerif);
      $fontSerifBtn.classList.toggle('active', useSerif);
      $fontSansBtn.setAttribute('aria-pressed', String(!useSerif));
      $fontSerifBtn.setAttribute('aria-pressed', String(useSerif));
    };
    applyFontChoice(currentSerif);

    $fontSansBtn.addEventListener('click', () => {
      applyFontChoice(false);
      showToast('已切换为无衬线字体', 1000);
    });

    $fontSerifBtn.addEventListener('click', () => {
      applyFontChoice(true);
      showToast('已切换为优雅衬线字体', 1000);
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

  const overrides = getComposerOverrides();
  const composedSettings = { ...getSettings(), ...overrides, mcpStatuses: latestMcpStatuses };
  const preflightBlocker = buildSendPreflightBlocker(
    content,
    composedSettings,
    getProviderCompatibilityReport(composedSettings)
  );
  if (preflightBlocker) {
    showToast(preflightBlocker.message, 5200);
    if (preflightBlocker.openSettings) openSettingsPanel();
    return;
  }

  const attachments = pendingAttachments.map((item) => ({ ...item }));

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
  const $advancedOptions = document.getElementById('composer-advanced-options') as HTMLElement | null;
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
      (document.getElementById('message-input') as HTMLTextAreaElement | null)?.value || '',
      composerModeId
    );
    renderComposerContextPreview(
      $contextPreview,
      (document.getElementById('message-input') as HTMLTextAreaElement | null)?.value || '',
      { ...composedSettings, mcpStatuses: latestMcpStatuses }
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
      if ($advancedOptions) {
        $advancedOptions.hidden = !expanded;
        $advancedOptions.setAttribute('aria-hidden', expanded ? 'false' : 'true');
      }
      $advancedToggle.textContent = expanded ? '收起' : '选项';
    });
  }

  if ($toolDrawerBtn) {
    $toolDrawerBtn.addEventListener('click', () =>
      toggleComposerToolMenu($toolDrawerBtn, {
        settings: getSettings(),
        activeSkill: composerOverrides?.activeSkill || getSettings().activeSkill,
        onSelect: (entry) => {
          composerOverrides = { ...composerOverrides, activeSkill: entry.id };
        },
        onChange: () => {
          applySettingsToComposer(getSettings());
        },
        openSettings,
      })
    );
  }

  if ($contextBtn) {
    $contextBtn.addEventListener('click', () =>
      toggleContextShortcutMenu($contextBtn, {
        settings: getSettings(),
        openSettings,
        getPendingAttachmentCount: () => pendingAttachments.length,
      })
    );
  }

  if ($contextPreview) {
    $contextPreview.addEventListener('click', (event) => {
      const chip = (event.target as HTMLElement | null)?.closest(
        '.composer-context-preview-chip'
      ) as HTMLElement | null;
      if (!chip) return;
      const action = chip.dataset.action || '';
      if (action === 'tools') {
        if ($toolDrawerBtn) {
          toggleComposerToolMenu($toolDrawerBtn, {
            settings: getSettings(),
            activeSkill: composerOverrides?.activeSkill || getSettings().activeSkill,
            onSelect: (entry) => {
              composerOverrides = { ...composerOverrides, activeSkill: entry.id };
            },
            onChange: () => applySettingsToComposer(getSettings()),
            openSettings,
          });
        }
        return;
      }
      if (action === 'context') {
        if ($contextBtn) {
          toggleContextShortcutMenu($contextBtn, {
            settings: getSettings(),
            openSettings,
            getPendingAttachmentCount: () => pendingAttachments.length,
          });
        }
        return;
      }
      if (action.startsWith('settings:')) {
        openSettings?.();
        window.dispatchEvent(new CustomEvent('deepchat:settings-focus', { detail: { title: action.slice(9) } }));
        return;
      }
      document.dispatchEvent(new CustomEvent('deepchat:open-inspector', { detail: { mode: 'message' } }));
    });
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
      insertIntoComposer(input, entry, { pendingAttachmentCount: pendingAttachments.length });
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
    updateComposerRunStatus($runStatus, settings, $thinking.value, inputText, composerModeId);
    renderComposerContextPreview($contextPreview, inputText, settings);
  });

  applySettingsToComposer();
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

function clearPendingAttachments() {
  pendingAttachments = [];
  clearPendingAttachmentPreview();
}
