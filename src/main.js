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
import './styles/chat.css';
import './styles/message.css';
import './styles/code.css';
import './styles/markdown.css';
import './styles/widgets.css';
import './styles/settings.css';
import './styles/reading-navigator.css';
import './styles/animations.css';
import './styles/agent-crew.css';

// Modules
import {
  initApiSettings,
  estimateTokens,
  extractContextMentions,
  getSettings,
  isSkillRunnable,
  supportsVisionModel,
  getModelCapabilities,
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
} from './modules/chat.js';
import { renderMarkdown } from './modules/renderer.js';
import { onMenuNewChat, onMenuOpenSettings } from './modules/client-store.js';
import { initReadingNavigator } from './modules/reading-navigator.js';
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
import {
  buildChatSearchIndex,
  clearChatSearchHighlights,
  findChatSearchMatches,
  highlightChatSearchMatches,
} from './modules/chat-search.js';

let pendingAttachments = [];
let composerOverrides = null;
let composerModeId = 'daily';
let latestMcpStatuses = [];
const INPUT_HISTORY_KEY = 'dc_input_history';
const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
const MAX_IMAGE_ATTACHMENTS = 8;
let inputHistory = [];
let inputHistoryIndex = -1;

// ─── Initialize ───

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  await initApiSettings();
  await initChat();
  initReadingNavigator();
  initSettings(onModelChange);
  bindEvents();
});

function onModelChange(model) {
  updateModelDisplay(model);
}

// ─── Event Bindings ───

function bindEvents() {
  const $input = document.getElementById('message-input');
  const $sendBtn = document.getElementById('send-btn');
  const $stopBtn = document.getElementById('stop-btn');
  const $newChatBtn = document.getElementById('new-chat-btn');
  const $clearBtn = document.getElementById('clear-chat-btn');
  const $exportBtn = document.getElementById('export-chat-btn');
  const $themeBtn = document.getElementById('theme-toggle-btn');
  const $sidebarToggle = document.getElementById('sidebar-toggle');
  const $mobileSidebarToggle = document.getElementById('mobile-sidebar-toggle');
  const $sidebar = document.getElementById('sidebar');
  const mobileLayoutQuery = window.matchMedia('(max-width: 768px)');
  const settingsPanel = document.getElementById('settings-panel');
  const settingsOverlay = document.getElementById('settings-overlay');

  function openSettings() {
    settingsPanel.classList.remove('hidden');
    settingsOverlay.classList.remove('hidden');
  }

  function triggerNewChat() {
    createConversation();
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
  inputHistory = loadInputHistory();

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
      navigateInputHistory(e.key === 'ArrowUp' ? -1 : 1, $input);
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
    if (
      $sidebar.classList.contains('mobile-open') &&
      !$sidebar.contains(e.target) &&
      (!$mobileSidebarToggle || (e.target !== $mobileSidebarToggle && !$mobileSidebarToggle.contains(e.target)))
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
      if (!settingsPanel.classList.contains('hidden')) {
        settingsPanel.classList.add('hidden');
        settingsOverlay.classList.add('hidden');
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
  scrollFab.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;
  scrollFab.title = '回到底部';
  document.getElementById('main-content').appendChild(scrollFab);

  scrollFab.addEventListener('click', () => {
    $chatMessages.scrollTo({ top: $chatMessages.scrollHeight, behavior: 'smooth' });
  });

  $chatMessages.addEventListener('scroll', () => {
    const threshold = 200;
    const atBottom = $chatMessages.scrollHeight - $chatMessages.scrollTop - $chatMessages.clientHeight < threshold;
    scrollFab.classList.toggle('hidden', atBottom);
  });

  // Suggestion cards
  document.querySelectorAll('.suggestion-card').forEach((card) => {
    card.addEventListener('click', () => {
      const prompt = card.dataset.prompt;
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
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      handleDroppedFiles(files, $input);
    });
  }
}

async function handleSend() {
  const $input = document.getElementById('message-input');
  const content = $input.value.trim();
  if (!content && pendingAttachments.length === 0) return;

  const hasImages = pendingAttachments.some((item) => String(item.mimeType || '').startsWith('image/'));
  if (hasImages && !supportsVisionModel(getSettings())) {
    showToast(`当前模型 ${getSettings().model} 未标记为支持图片输入，请切换 vision 模型后再发送。`, 3200);
    return;
  }

  const attachments = pendingAttachments.map((item) => ({ ...item }));
  const overrides = getComposerOverrides();

  let finalModelContent = applyComposerModeToPrompt(content, composerModeId);
  const textAttachments = pendingAttachments.filter((item) => !String(item.mimeType || '').startsWith('image/'));
  if (textAttachments.length > 0) {
    const textContext = textAttachments
      .map((item) => `[附件文件: ${item.name}]\n\`\`\`\n${item.dataUrl}\n\`\`\``)
      .join('\n\n');
    finalModelContent = `${finalModelContent}\n\n<uploaded_attachments>\n${textContext}\n</uploaded_attachments>`;
  }

  rememberInput(content);

  $input.value = '';
  $input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
  clearPendingAttachments();
  $input.dispatchEvent(new Event('input', { bubbles: true }));

  await sendMessage(content, { attachments, composerOverrides: overrides, modelContent: finalModelContent });
}

function loadInputHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(INPUT_HISTORY_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 50) : [];
  } catch {
    return [];
  }
}

function rememberInput(content) {
  const text = String(content || '').trim();
  if (!text) return;
  inputHistory = [text, ...inputHistory.filter((item) => item !== text)].slice(0, 50);
  inputHistoryIndex = -1;
  localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(inputHistory));
}

function navigateInputHistory(direction, input) {
  if (inputHistory.length === 0) return;
  if (direction < 0) inputHistoryIndex = Math.min(inputHistoryIndex + 1, inputHistory.length - 1);
  else inputHistoryIndex = Math.max(inputHistoryIndex - 1, -1);
  input.value = inputHistoryIndex >= 0 ? inputHistory[inputHistoryIndex] : '';
}

const COMPOSER_THINKING_LABELS = new Map([
  ['0', '自动'],
  ['4096', '轻量'],
  ['8192', '标准'],
  ['16384', '深度'],
  ['32768', '极深'],
]);

function initComposerOptions(openSettings) {
  const $toolbar = document.querySelector('.composer-toolbar');
  const $mode = document.getElementById('composer-mode-select');
  const $thinking = document.getElementById('composer-thinking-select');
  const $webToggle = document.getElementById('composer-web-search-toggle');
  const $webStatus = document.getElementById('composer-search-status');
  const $enhanceToggle = document.getElementById('composer-enhance-toggle');
  const $enhanceStatus = document.getElementById('composer-enhance-status');
  const $toolDrawerBtn = document.getElementById('composer-tool-drawer-btn');
  const $toolStatus = document.getElementById('composer-tool-status');
  const $contextBtn = document.getElementById('composer-context-btn');
  const $advancedToggle = document.getElementById('composer-advanced-toggle');
  const $runStatus = document.getElementById('composer-run-status');
  const $contextPreview = document.getElementById('composer-context-preview');
  const $templateBtn = document.getElementById('composer-template-btn');
  const $settingsShortcut = document.getElementById('composer-settings-shortcut');
  const $webToggleLabel = $webToggle?.closest('.composer-search-toggle');
  const $enhanceToggleLabel = $enhanceToggle?.closest('.composer-enhance-toggle');
  if (!$thinking || !$webToggle) return;

  let syncing = false;
  composerOverrides = {
    thinkingBudget: getSettings().thinkingBudget,
    activeSkill: getSettings().activeSkill,
    enhance: getSettings().enhance !== false,
  };

  function applySettingsToComposer(settings = getSettings()) {
    syncing = true;
    if (!composerOverrides) {
      composerOverrides = {
        thinkingBudget: settings.thinkingBudget,
        activeSkill: settings.activeSkill,
        enhance: settings.enhance !== false,
      };
    }
    syncComposerModeSelect($mode, composerModeId, settings);
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
      document.getElementById('message-input')?.value || ''
    );
    renderComposerContextPreview(
      $contextPreview,
      document.getElementById('message-input')?.value || '',
      composedSettings
    );
    syncing = false;
  }

  if ($mode) {
    $mode.addEventListener('change', () => {
      const settings = getSettings();
      composerModeId = getComposerMode($mode.value).id;
      const modeOverrides = getComposerModeOverrides(composerModeId, settings);
      composerOverrides = {
        ...composerOverrides,
        ...modeOverrides,
      };
      applySettingsToComposer(settings);
      showToast(`本轮模式：${getComposerMode(composerModeId).label}`, 1200);
    });
  }

  $thinking.addEventListener('change', async () => {
    if (syncing) return;
    const budget = Number.parseInt($thinking.value, 10) || 0;
    try {
      composerOverrides.thinkingBudget = budget;
      applySettingsToComposer(getSettings());
      showToast(`思考程度：${getThinkingLabel(String(budget))}`, 1200);
    } catch (error) {
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
      } catch (error) {
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
      } catch (error) {
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
      } catch (error) {
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

  document.querySelectorAll('[data-context-chip]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const settings = getSettings();
      const entry = buildContextShortcutEntries(settings).find((item) => item.id === chip.dataset.contextChip);
      if (!entry) return;
      if (!entry.available) {
        showToast(entry.state);
        if (['需工作区', '需 Tavily Key', '需 MCP'].includes(entry.state)) openSettings?.();
        return;
      }
      const input = document.getElementById('message-input');
      insertIntoComposer(input, entry);
      input?.focus();
    });
  });

  window.addEventListener('deepchat:settings-changed', (event) => {
    applySettingsToComposer(event.detail?.settings || getSettings());
  });

  window.addEventListener('deepchat:mcp-status-changed', (event) => {
    latestMcpStatuses = Array.isArray(event.detail?.statuses) && !event.detail?.stale ? event.detail.statuses : [];
    applySettingsToComposer(getSettings());
  });

  document.getElementById('message-input')?.addEventListener('input', () => {
    const settings = { ...getSettings(), ...composerOverrides, mcpStatuses: latestMcpStatuses };
    const inputText = document.getElementById('message-input')?.value || '';
    updateComposerRunStatus($runStatus, settings, $thinking.value, inputText);
    renderComposerContextPreview($contextPreview, inputText, settings);
  });

  applySettingsToComposer();
}

function syncComposerModeSelect(select, activeModeId, settings = {}) {
  if (!select) return;
  const entries = buildComposerModeEntries(settings);
  for (const option of select.options) {
    const entry = entries.find((item) => item.id === option.value);
    if (!entry) continue;
    option.textContent = entry.label;
    option.title = `${entry.description}${entry.state && entry.state !== '可用' ? ` · ${entry.state}` : ''}`;
  }
  select.value = getComposerMode(activeModeId).id;
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
      const input = document.getElementById('message-input');
      input.value = applyPromptTemplate(input.value, template.text);
      autoResize(input);
      document.getElementById('send-btn').disabled = false;
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

function buildPromptTemplateTitle(template = {}) {
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
    item.innerHTML = `
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
    item.innerHTML = `
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
      const input = document.getElementById('message-input');
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

function insertIntoComposer(input, entry) {
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
  document.getElementById('send-btn').disabled = !input.value.trim() && pendingAttachments.length === 0;
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
  const inputText = document.getElementById('message-input')?.value || '';
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

function renderComposerContextPreview(target, inputText = '', settings = {}) {
  if (!target) return;
  const preview = buildComposerContextPreview(inputText, {
    ...settings,
    mcpStatuses: settings.mcpStatuses || latestMcpStatuses,
  });
  target.innerHTML = '';
  target.title = preview.title || '';
  for (const item of preview.items) {
    const chip = document.createElement('span');
    chip.className = `composer-context-preview-chip tone-${item.tone || 'muted'} kind-${item.kind || 'item'}`;
    chip.textContent = item.label;
    if (item.title) chip.title = item.title;
    target.appendChild(chip);
  }
}

function updateComposerToolButton(button, status, settings) {
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

// ─── Keyboard Shortcut Help ───

let keyboardHelpEl = null;

function toggleKeyboardHelp() {
  if (keyboardHelpEl) {
    keyboardHelpEl.remove();
    keyboardHelpEl = null;
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'keyboard-help-overlay';
  overlay.innerHTML = `
    <div class="keyboard-help-panel">
      <div class="keyboard-help-header">
        <h3>⌨️ 快捷键速查</h3>
        <button class="keyboard-help-close icon-btn" title="关闭">&times;</button>
      </div>
      <div class="keyboard-help-body">
        <div class="keyboard-help-group">
          <h4>对话</h4>
          <div class="keyboard-help-row"><kbd>Enter</kbd><span>发送消息</span></div>
          <div class="keyboard-help-row"><kbd>Shift + Enter</kbd><span>换行</span></div>
          <div class="keyboard-help-row"><kbd>Ctrl + Enter</kbd><span>发送（备用）</span></div>
          <div class="keyboard-help-row"><kbd>Ctrl + N</kbd><span>新建对话</span></div>
          <div class="keyboard-help-row"><kbd>Ctrl + /</kbd><span>聚焦输入框</span></div>
          <div class="keyboard-help-row"><kbd>Ctrl + F</kbd><span>搜索对话内容</span></div>
          <div class="keyboard-help-row"><kbd>Ctrl + P</kbd><span>预览 Markdown</span></div>
        </div>
        <div class="keyboard-help-group">
          <h4>界面</h4>
          <div class="keyboard-help-row"><kbd>Escape</kbd><span>关闭面板/弹窗</span></div>
          <div class="keyboard-help-row"><kbd>F1</kbd><span>快捷键帮助</span></div>
          <div class="keyboard-help-row"><kbd>Ctrl + ,</kbd><span>设置（桌面版）</span></div>
        </div>
        <div class="keyboard-help-group">
          <h4>图片查看器</h4>
          <div class="keyboard-help-row"><kbd>滚轮</kbd><span>缩放</span></div>
          <div class="keyboard-help-row"><kbd>双击</kbd><span>切换缩放</span></div>
          <div class="keyboard-help-row"><kbd>拖拽</kbd><span>平移</span></div>
          <div class="keyboard-help-row"><kbd>+ / -</kbd><span>缩放</span></div>
          <div class="keyboard-help-row"><kbd>0</kbd><span>100% 查看</span></div>
          <div class="keyboard-help-row"><kbd>Escape</kbd><span>关闭</span></div>
        </div>
        <div class="keyboard-help-group">
          <h4>侧边栏</h4>
          <div class="keyboard-help-row"><kbd>双击标题</kbd><span>重命名对话</span></div>
          <div class="keyboard-help-row"><kbd>📌 按钮</kbd><span>置顶/取消置顶</span></div>
        </div>
      </div>
    </div>
  `;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) toggleKeyboardHelp();
  });
  overlay.querySelector('.keyboard-help-close').addEventListener('click', toggleKeyboardHelp);
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape' && keyboardHelpEl) {
      toggleKeyboardHelp();
      document.removeEventListener('keydown', escClose);
    }
  });

  document.body.appendChild(overlay);
  keyboardHelpEl = overlay;
}

// ─── Ctrl+F Chat Search ───

let chatSearchEl = null;

function toggleChatSearch() {
  if (chatSearchEl) {
    closeChatSearch();
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'chat-search-bar';
  bar.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
    <input type="text" class="chat-search-input" placeholder="搜索对话内容…" autofocus />
    <span class="chat-search-count"></span>
    <button class="chat-search-nav" data-dir="-1" title="上一个">▲</button>
    <button class="chat-search-nav" data-dir="1" title="下一个">▼</button>
    <button class="chat-search-close" title="关闭">&times;</button>
  `;

  const mainContent = document.getElementById('main-content');
  mainContent.insertBefore(bar, mainContent.firstChild);
  chatSearchEl = bar;

  const input = bar.querySelector('.chat-search-input');
  const countEl = bar.querySelector('.chat-search-count');
  let searchIndex = buildChatSearchIndex(document);
  let matches = [];
  let currentMatch = -1;

  function clearHighlights() {
    clearChatSearchHighlights(document);
    matches = [];
    currentMatch = -1;
  }

  function doSearch() {
    clearHighlights();
    const query = input.value.trim();
    if (!query) {
      countEl.textContent = '';
      return;
    }

    searchIndex = buildChatSearchIndex(document);
    const matchedMessages = findChatSearchMatches(searchIndex, query, { limit: 50 });
    matches = highlightChatSearchMatches(matchedMessages, query, { markLimit: 300 });
    countEl.textContent =
      matches.length > 0
        ? `${matches.length} 个结果${matchedMessages.length >= 50 ? '（前 50 条消息）' : ''}`
        : '无结果';
    if (matches.length > 0) jumpTo(0);
  }

  function jumpTo(idx) {
    if (matches.length === 0) return;
    matches.forEach((m) => m.classList.remove('search-highlight-active'));
    currentMatch = ((idx % matches.length) + matches.length) % matches.length;
    const target = matches[currentMatch];
    target.classList.add('search-highlight-active');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    countEl.textContent = `${currentMatch + 1}/${matches.length}`;
  }

  input.addEventListener('input', debounce(doSearch, 200));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpTo(e.shiftKey ? currentMatch - 1 : currentMatch + 1);
    }
    if (e.key === 'Escape') closeChatSearch();
  });

  bar.querySelectorAll('.chat-search-nav').forEach((btn) => {
    btn.addEventListener('click', () => {
      jumpTo(currentMatch + parseInt(btn.dataset.dir));
    });
  });
  bar.querySelector('.chat-search-close').addEventListener('click', closeChatSearch);

  input.focus();

  function closeChatSearch() {
    clearHighlights();
    bar.remove();
    chatSearchEl = null;
  }
}

// ─── Ctrl+P Markdown Preview ───

let previewOverlayEl = null;

function toggleMarkdownPreview(text) {
  if (previewOverlayEl) {
    previewOverlayEl.remove();
    previewOverlayEl = null;
    return;
  }

  if (!text || !text.trim()) {
    showToast('输入框为空，无内容可预览');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'markdown-preview-overlay';
  overlay.innerHTML = `
    <div class="markdown-preview-panel">
      <div class="markdown-preview-header">
        <h3>📝 Markdown 预览</h3>
        <button class="markdown-preview-close icon-btn" title="关闭">&times;</button>
      </div>
      <div class="markdown-preview-body message-content"></div>
    </div>
  `;

  const body = overlay.querySelector('.markdown-preview-body');
  body.innerHTML = renderMarkdown(text);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.remove();
      previewOverlayEl = null;
    }
  });
  overlay.querySelector('.markdown-preview-close').addEventListener('click', () => {
    overlay.remove();
    previewOverlayEl = null;
  });
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape' && previewOverlayEl) {
      overlay.remove();
      previewOverlayEl = null;
      document.removeEventListener('keydown', escClose);
    }
  });

  document.body.appendChild(overlay);
  previewOverlayEl = overlay;
}

// ─── Drag-and-Drop File Handler ───

function handleDroppedFiles(files, $input) {
  const remainingSlots = Math.max(0, MAX_IMAGE_ATTACHMENTS - pendingAttachments.length);
  const acceptedFiles = files.slice(0, remainingSlots);
  if (acceptedFiles.length < files.length) {
    showToast(`最多保留 ${MAX_IMAGE_ATTACHMENTS} 个附件，多余的文件已忽略。`, 2400);
  }

  acceptedFiles.forEach((file) => {
    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();

    reader.onload = () => {
      let preview = document.querySelector('.attachment-preview');
      if (!preview) {
        preview = document.createElement('div');
        preview.className = 'attachment-preview';
        const inputArea = document.querySelector('.input-container');
        inputArea.parentNode.insertBefore(preview, inputArea);
      }

      const item = document.createElement('div');
      item.className = 'attachment-item' + (isImage ? ' type-image' : ' type-text');

      if (isImage) {
        const image = document.createElement('img');
        image.src = String(reader.result || '');
        image.alt = file.name || '图片附件';
        item.appendChild(image);
      } else {
        const icon = document.createElement('div');
        icon.className = 'attachment-text-icon';
        icon.textContent = '📄';
        item.appendChild(icon);
      }

      const name = document.createElement('span');
      name.className = 'attachment-name';
      name.textContent = file.name || '附件';

      let previewAction = null;
      if (!isImage) {
        previewAction = document.createElement('button');
        previewAction.type = 'button';
        previewAction.className = 'attachment-preview-action';
        previewAction.title = '预览文本附件';
        previewAction.setAttribute('aria-label', `预览 ${file.name || '文本附件'}`);
        previewAction.textContent = '预览';
        previewAction.addEventListener('click', () => {
          const text = String(reader.result || '');
          toggleMarkdownPreview(`文件：${file.name || '文本附件'}\n\n\`\`\`text\n${text}\n\`\`\``);
        });
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.title = '移除';
      remove.setAttribute('aria-label', `移除 ${file.name || '附件'}`);
      remove.textContent = '×';

      remove.addEventListener('click', () => {
        pendingAttachments = pendingAttachments.filter((attachment) => attachment.id !== item.dataset.attachmentId);
        item.remove();
        if (preview.children.length === 0) preview.remove();
        document.getElementById('send-btn').disabled = !$input.value.trim() && pendingAttachments.length === 0;
      });

      item.append(name);
      if (previewAction) item.appendChild(previewAction);
      item.appendChild(remove);

      const attachment = {
        id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        mimeType: file.type || 'text/plain',
        size: file.size,
        dataUrl: reader.result,
      };

      item.dataset.attachmentId = attachment.id;
      pendingAttachments.push(attachment);
      preview.appendChild(item);
      document.getElementById('send-btn').disabled = !$input.value.trim() && pendingAttachments.length === 0;
    };

    if (isImage) {
      reader.readAsDataURL(file);
    } else {
      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
        showToast(`${file.name} 超过 256KB，已跳过。`, 2600);
        return;
      }
      reader.readAsText(file);
    }
  });

  if (acceptedFiles.length > 0) {
    showToast(`已添加 ${acceptedFiles.length} 个附件`, 1500);
  }
}

function clearPendingAttachments() {
  pendingAttachments = [];
  document.querySelector('.attachment-preview')?.remove();
}
