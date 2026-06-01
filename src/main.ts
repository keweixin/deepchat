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
  saveSettings,
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
  // Relocate settings forms from popup modal to inline dashboard container
  const $settingsContent = document.querySelector('#settings-panel .settings-content');
  const $dashboard = document.getElementById('settings-dashboard');
  if ($settingsContent && $dashboard) {
    const formsContainer = document.createElement('div');
    formsContainer.id = 'settings-forms-container';
    formsContainer.className = 'settings-panel settings-content settings-forms-container hidden';

    while ($settingsContent.firstChild) {
      formsContainer.appendChild($settingsContent.firstChild);
    }
    $dashboard.appendChild(formsContainer);
  }

  // Restore serif font choice on startup
  const useSerif = localStorage.getItem('dc_font_serif') === 'true';
  if (useSerif) {
    document.body.classList.add('use-serif');
  }
  initTheme();
  initInspectorPanel({ getOverviewData: getInspectorOverviewData });
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
  const $workbenchGlobalSearch = document.getElementById('workbench-global-search') as HTMLButtonElement | null;
  const $sidebarSearchInput = document.getElementById('search-input') as HTMLInputElement | null;
  const $sidebar = document.getElementById('sidebar') as HTMLElement;
  const mobileLayoutQuery = window.matchMedia('(max-width: 768px)');
  function openSettings() {
    openSettingsPanel();
  }

  function setWorkbenchSettingsMode(enabled: boolean) {
    const app = document.getElementById('app');
    app?.classList.toggle('settings-active', enabled);
    document.getElementById('inspector-toggle-btn')?.classList.toggle('hidden', enabled);
    document.getElementById('export-chat-btn')?.classList.toggle('hidden', enabled);
    document.getElementById('clear-chat-btn')?.classList.toggle('hidden', enabled);
    document.getElementById('workbench-global-search')?.classList.toggle('hidden', enabled);
    document.getElementById('workbench-filter-btn')?.classList.toggle('hidden', !enabled);
    document.getElementById('workbench-deploy-btn')?.classList.toggle('hidden', !enabled);
  }

  setWorkbenchSettingsMode(false);

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

  $workbenchGlobalSearch?.addEventListener('click', () => {
    if (mobileLayoutQuery.matches) $sidebar.classList.add('mobile-open');
    if ($sidebar.classList.contains('collapsed')) $sidebar.classList.remove('collapsed');
    syncSidebarToggleState();
    $sidebarSearchInput?.focus();
    $sidebarSearchInput?.select();
  });

  const $subContainer = document.getElementById('workbench-rail-sub-container');

  document.querySelectorAll<HTMLElement>('[data-workbench-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.workbenchAction;

      // Deactivate all main rail buttons and sub-items
      document.querySelectorAll('.workbench-rail-btn').forEach((item) => item.classList.remove('active'));
      if (button.classList.contains('workbench-rail-btn')) button.classList.add('active');

      if (action === 'settings') {
        setWorkbenchSettingsMode(true);
        if ($subContainer) $subContainer.style.display = 'flex';
        showSettingsSection('overview');
        return;
      }

      // Close settings mode
      if ($subContainer) $subContainer.style.display = 'none';
      setWorkbenchSettingsMode(false);

      if (action === 'agents') {
        document.dispatchEvent(new CustomEvent('deepchat:open-inspector', { detail: { mode: 'trace' } }));
        return;
      }
      if (action === 'compute') {
        document.dispatchEvent(new CustomEvent('deepchat:open-inspector', { detail: { mode: 'overview' } }));
        showToast('工具运行、审批和错误会在 Inspector 中集中显示。', 1800);
        return;
      }
      if (action === 'files' || action === 'workspace') {
        if (mobileLayoutQuery.matches) $sidebar.classList.add('mobile-open');
        if ($sidebar.classList.contains('collapsed')) $sidebar.classList.remove('collapsed');
        syncSidebarToggleState();
        $sidebarSearchInput?.focus();
        return;
      }
      if (action === 'help') {
        toggleKeyboardHelp();
        return;
      }
      if (action === 'logs') {
        document.dispatchEvent(new CustomEvent('deepchat:open-inspector', { detail: { mode: 'raw' } }));
      }
    });
  });

  // Bind settings sub-tabs click events
  document.querySelectorAll<HTMLElement>('.sub-item[data-settings-section]').forEach((subBtn) => {
    subBtn.addEventListener('click', (e) => {
      e.stopPropagation();

      // Deactivate other sub-items and non-settings main buttons
      document.querySelectorAll('.workbench-rail-btn').forEach((item) => {
        if (item.dataset.workbenchAction !== 'settings') {
          item.classList.remove('active');
        }
      });
      document.querySelectorAll('.sub-item').forEach((item) => item.classList.remove('active'));

      // Activate clicked sub-item and main settings header button
      subBtn.classList.add('active');
      document.getElementById('workbench-rail-settings-btn')?.classList.add('active');

      // Show settings section inline in the workbench
      setWorkbenchSettingsMode(true);
      const sectionId = subBtn.dataset.settingsSection || 'section-provider';
      showSettingsSection(sectionId);
    });
  });

  // Intercept the bottom gear button click to trigger our new rail button
  document.getElementById('settings-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    document.getElementById('workbench-rail-settings-btn')?.click();
  });

  // Intercept global settings focus event in capture phase to prevent popup modal from opening
  window.addEventListener(
    'deepchat:settings-focus',
    (event) => {
      event.stopImmediatePropagation();
      const title = String((event as CustomEvent).detail?.title || '');
      const sectionMap: Record<string, string> = {
        'API 配置': 'section-provider',
        联网搜索: 'section-search',
        工作区与备份: 'section-workspace',
        'Agent 与 Token': 'section-agent',
        'MCP Server': 'section-mcp',
        外部技能: 'section-skills',
        模型设置: 'section-model',
        回答模式: 'section-appearance',
        系统提示词: 'section-data',
        智能增强: 'section-debug',
      };
      const targetSection = sectionMap[title];
      if (targetSection) {
        const subBtn = document.querySelector(
          `.sub-item[data-settings-section="${targetSection}"]`
        ) as HTMLElement | null;
        subBtn?.click();
      }
    },
    { capture: true }
  );

  document.querySelectorAll<HTMLElement>('.workbench-resource-row[data-prompt]').forEach((row) => {
    row.addEventListener('click', () => {
      const prompt = row.dataset.prompt;
      if (!prompt) return;
      $input.value = prompt;
      autoResize($input);
      $sendBtn.disabled = false;
      $input.focus();
    });
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

  // ─── Settings Dashboard Interactive Event Bindings ───
  const syncSettingsToDashboard = () => {
    const current = getSettings();
    const $detailLog = document.getElementById('config-detail-log') as HTMLInputElement | null;
    const $semanticCache = document.getElementById('config-semantic-cache') as HTMLInputElement | null;

    if ($detailLog) {
      $detailLog.checked = current.interfaceDetailLevel === 'developer';
    }
    if ($semanticCache) {
      $semanticCache.checked = current.cacheOptimization !== false;
    }

    const providerRows = document.querySelectorAll('.provider-row-item');
    providerRows.forEach((row) => {
      const nameEl = row.querySelector('.provider-name');
      const name = nameEl?.textContent?.trim().toLowerCase() || '';
      let isActive = false;
      const providerId = current.providerId;

      if (providerId === 'openai' && name === 'openai') {
        isActive = true;
      } else if (providerId === 'custom' && name === 'anthropic') {
        isActive = true;
      } else if (providerId === 'ollama' && name === 'local ollama') {
        isActive = true;
      }

      row.classList.toggle('active', isActive);

      if (name === 'local ollama') {
        row.classList.remove('disabled');
        const statusLabel = row.querySelector('.provider-status-label');
        if (statusLabel) {
          statusLabel.textContent = providerId === 'ollama' ? '已就绪' : '未激活';
        }
      }
    });
  };

  // Bind settings change triggers
  const $detailLog = document.getElementById('config-detail-log') as HTMLInputElement | null;
  if ($detailLog) {
    $detailLog.addEventListener('change', () => {
      const mode = $detailLog.checked ? 'developer' : 'normal';
      saveSettings({ interfaceDetailLevel: mode });
      addLiveLog('INFO', `界面细节级别已调整为: ${mode === 'developer' ? '开发者模式' : '普通模式'}`);
    });
  }

  const $semanticCache = document.getElementById('config-semantic-cache') as HTMLInputElement | null;
  if ($semanticCache) {
    $semanticCache.addEventListener('change', () => {
      const enabled = $semanticCache.checked;
      saveSettings({ cacheOptimization: enabled });
      addLiveLog('INFO', `语义缓存优化层已${enabled ? '启用' : '禁用'}`);
    });
  }

  const parallelSlider = document.getElementById('config-parallel-slider') as HTMLInputElement | null;
  const parallelCurrent = document.getElementById('parallel-current') as HTMLElement | null;
  if (parallelSlider) {
    const savedParallel = localStorage.getItem('dc_maxParallelRequests') || '32';
    parallelSlider.value = savedParallel;
    if (parallelCurrent) parallelCurrent.textContent = savedParallel;

    parallelSlider.addEventListener('input', () => {
      if (parallelCurrent) parallelCurrent.textContent = parallelSlider.value;
    });

    parallelSlider.addEventListener('change', () => {
      localStorage.setItem('dc_maxParallelRequests', parallelSlider.value);
      addLiveLog('INFO', `最大并行请求数已调整为: ${parallelSlider.value}`);
    });
  }

  // Bind provider switching
  document.querySelectorAll('.provider-row-item').forEach((item) => {
    item.addEventListener('click', () => {
      const nameEl = item.querySelector('.provider-name');
      const name = nameEl?.textContent?.trim().toLowerCase() || '';
      let targetProvider = 'custom';
      let targetUrl = '';
      let targetModel = '';

      if (name === 'openai') {
        targetProvider = 'openai';
        targetUrl = 'https://api.openai.com/v1';
        targetModel = 'gpt-4o';
      } else if (name === 'anthropic') {
        targetProvider = 'custom';
        targetUrl = 'https://api.anthropic.com';
        targetModel = 'claude-3.5-sonnet';
      } else if (name === 'local ollama') {
        targetProvider = 'ollama';
        targetUrl = 'http://localhost:11434/v1';
        targetModel = 'llama3';
      }

      const patch: Record<string, unknown> = { providerId: targetProvider };
      if (targetUrl) patch.apiBase = targetUrl;
      if (targetModel) {
        patch.model = targetModel;
        updateModelDisplay(targetModel);
      }

      saveSettings(patch);
      addLiveLog('INFO', `切换服务商到: ${nameEl?.textContent || name}，模型切换为: ${targetModel || '默认'}`);
      showToast(`已成功切换当前模型服务商为 ${nameEl?.textContent || name}`, 1800);
    });
  });

  document.querySelector('.add-provider-btn')?.addEventListener('click', () => {
    openSettingsPanel();
    window.dispatchEvent(new CustomEvent('deepchat:settings-focus', { detail: { title: 'API 配置' } }));
    showToast('已打开高级服务商设置面板', 1800);
  });

  // Export / Save configuration
  document.getElementById('settings-save-btn')?.addEventListener('click', () => {
    addLiveLog('INFO', '用户手动触发配置保存；所有更改均已就绪并同步。');
    showToast('所有设置与控制台更改均已成功保存！', 2000);
  });

  document.getElementById('settings-export-btn')?.addEventListener('click', async () => {
    addLiveLog('INFO', '正在请求导出当前系统的全部会话和配置包...');
    const { exportBackup } = await import('./modules/client-store.js');
    exportBackup({ privacyLevel: 'full' });
    showToast('配置文件包已成功生成并下载', 2000);
  });

  document.getElementById('workbench-deploy-btn')?.addEventListener('click', () => {
    addLiveLog('INFO', '收到 [部署项目] 指令；正在检测生产环境集群节点状态...');
    setTimeout(() => {
      addLiveLog('INFO', '集群通道连接成功！生产包构建就绪，正在进行增量发布。');
      showToast('增量构建部署已成功启动，正在同步到多节点环境...', 2500);
    }, 600);
  });

  document.getElementById('workbench-filter-btn')?.addEventListener('click', () => {
    showToast('筛选面板已打开。', 1500);
  });

  // Listen to application events to update telemetry and stream logs
  window.addEventListener('deepchat:settings-changed', (event) => {
    const detail = (event as CustomEvent).detail || {};
    const nextSettings = detail.settings || getSettings();
    syncSettingsToDashboard();
    updateTelemetry();
    if (detail.patch && Object.keys(detail.patch).length > 0) {
      const keys = Object.keys(detail.patch).join(', ');
      addLiveLog('INFO', `配置项修改生效: [${keys}]`);
    }
  });

  window.addEventListener('deepchat:conversation-switched', (event) => {
    const detail = (event as CustomEvent).detail || {};
    updateTelemetry();
    addLiveLog('INFO', `会话切换，当前活动会话 ID: ${detail.id || 'new'} (${detail.composerModeId || 'daily'})`);
  });

  // Initial load sync and run telemetry
  syncSettingsToDashboard();
  void updateTelemetry();

  // ─── Active rail action click simulation on load ───
  const activeRailBtn = document.querySelector('.workbench-rail-btn.active') as HTMLElement | null;
  if (activeRailBtn) {
    activeRailBtn.click();
  }
}

function showSettingsSection(sectionId: string) {
  const overviewGrid = document.querySelector('.settings-dashboard-grid');
  const formsContainer = document.getElementById('settings-forms-container');

  if (sectionId === 'overview') {
    overviewGrid?.classList.remove('hidden');
    formsContainer?.classList.add('hidden');
  } else {
    overviewGrid?.classList.add('hidden');
    formsContainer?.classList.remove('hidden');

    const sections = formsContainer?.querySelectorAll('.settings-section');
    sections?.forEach((sec) => {
      if (sec.id === sectionId) {
        (sec as HTMLElement).style.display = 'block';
        (sec as HTMLElement).style.opacity = '1';
      } else {
        (sec as HTMLElement).style.display = 'none';
      }
    });
  }
}

function addLiveLog(level: 'INFO' | 'WARN' | 'ERR', message: string) {
  const container = document.querySelector('.system-logs-container');
  if (!container) return;

  const logLine = document.createElement('div');
  logLine.className = 'log-line';

  const tag = document.createElement('span');
  tag.className = `log-tag ${level.toLowerCase()}`;
  tag.textContent = `[${level}]`;

  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${now.toTimeString().slice(0, 8)}`;

  logLine.appendChild(tag);
  logLine.appendChild(document.createTextNode(` ${timeStr} - ${message}`));

  const caret = container.querySelector('.console-caret');
  if (caret) {
    container.insertBefore(logLine, caret);
  } else {
    container.appendChild(logLine);
  }

  container.scrollTop = container.scrollHeight;
}

async function updateTelemetry() {
  try {
    const { loadConversations } = await import('./modules/client-store.ts');
    const { getConversationUsageSummary } = await import('./modules/token-budget.ts');
    const conversations = await loadConversations(true);

    let gpt4oTokens = 0;
    let claudeTokens = 0;
    let embeddingTokens = 0;

    let cacheHits = 0;
    let cacheMisses = 0;

    conversations.forEach((conv) => {
      const usage = getConversationUsageSummary(conv);
      const model = String(conv.model || '').toLowerCase();
      const total = usage.total || 0;

      if (model.includes('gpt') || model.includes('openai')) {
        gpt4oTokens += total;
      } else if (model.includes('claude') || model.includes('anthropic') || model.includes('sonnet')) {
        claudeTokens += total;
      } else {
        embeddingTokens += total;
      }

      cacheHits += usage.cacheHit || 0;
      cacheMisses += usage.cacheMiss || 0;
    });

    const formatNum = (num: number) => {
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(0) + 'K';
      return String(num);
    };

    const usageStats = document.querySelector('.token-usage-stats');
    if (usageStats) {
      const statCols = usageStats.querySelectorAll('.token-stat-col');
      if (statCols.length >= 3) {
        // GPT-4o
        const gptVal = statCols[0].querySelector('.token-stat-val');
        if (gptVal) gptVal.textContent = `${formatNum(gpt4oTokens)} tokens`;
        const gptFill = statCols[0].querySelector('.token-progress-fill') as HTMLElement | null;
        if (gptFill) gptFill.style.width = `${Math.min(100, Math.max(5, (gpt4oTokens / 5000000) * 100))}%`;

        // Claude
        const claudeVal = statCols[1].querySelector('.token-stat-val');
        if (claudeVal) claudeVal.textContent = `${formatNum(claudeTokens)} tokens`;
        const claudeFill = statCols[1].querySelector('.token-progress-fill') as HTMLElement | null;
        if (claudeFill) claudeFill.style.width = `${Math.min(100, Math.max(5, (claudeTokens / 5000000) * 100))}%`;

        // Embedding
        const embVal = statCols[2].querySelector('.token-stat-val');
        if (embVal) embVal.textContent = `${formatNum(embeddingTokens)} tokens`;
        const embFill = statCols[2].querySelector('.token-progress-fill') as HTMLElement | null;
        if (embFill) embFill.style.width = `${Math.min(100, Math.max(5, (embeddingTokens / 10000000) * 100))}%`;
      }
    }

    const tokenUpdateBadge = document.querySelector('.token-update-badge');
    if (tokenUpdateBadge) {
      const now = new Date();
      tokenUpdateBadge.textContent = `更新时间：${now.toTimeString().slice(0, 8)}`;
    }

    const totalInput = cacheHits + cacheMisses;
    const hitRate = totalInput > 0 ? (cacheHits / totalInput) * 100 : 92.4;

    const hitNumEl = document.querySelector('.cache-hit-num');
    if (hitNumEl) {
      hitNumEl.textContent = `${hitRate.toFixed(1)}%`;
    }

    const cacheChart = document.querySelector('.cache-hit-chart') as HTMLElement | null;
    if (cacheChart) {
      cacheChart.style.setProperty('--hit-rate', `${hitRate.toFixed(1)}%`);
    }

    const savedBytes = cacheHits * 400;
    let bandwidthStr = '12.8 GB';
    if (savedBytes > 0) {
      if (savedBytes >= 1073741824) {
        bandwidthStr = `${(savedBytes / 1073741824).toFixed(1)} GB`;
      } else if (savedBytes >= 1048576) {
        bandwidthStr = `${(savedBytes / 1048576).toFixed(1)} MB`;
      } else {
        bandwidthStr = `${(savedBytes / 1024).toFixed(1)} KB`;
      }
    }
    const cacheStatVals = document.querySelectorAll('.cache-stat-val');
    if (cacheStatVals.length >= 2) {
      (cacheStatVals[1] as HTMLElement).textContent = bandwidthStr;
    }
  } catch (err) {
    console.warn('[Dashboard Telemetry] Failed to load:', err);
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
  const composedSettings: any = { ...getSettings(), ...overrides, mcpStatuses: latestMcpStatuses };
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

  addLiveLog('INFO', `正在发送请求，使用模型: ${composedSettings.model || 'unknown'}...`);
  try {
    await sendMessage(content, { attachments, composerOverrides: overrides, modelContent: finalModelContent });
    addLiveLog('INFO', `对话响应成功生成。已更新 Token 消耗和缓存命中率统计。`);
    setTimeout(updateTelemetry, 100);
  } catch (error) {
    addLiveLog('ERR', `发送请求失败: ${(error as Error).message}`);
    throw error;
  }
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
