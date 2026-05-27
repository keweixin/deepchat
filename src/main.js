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

// Modules
import { initApiSettings, estimateTokens, extractContextMentions, getSettings, isSkillRunnable, supportsVisionModel, getModelCapabilities } from './modules/api.js';
import { initTheme, toggleTheme } from './modules/theme.js';
import { initSettings } from './modules/settings.js';
import { initChat, createConversation, sendMessage, stopStreaming, clearCurrentChat, updateModelDisplay, exportCurrentChat } from './modules/chat.js';
import { renderMarkdown } from './modules/renderer.js';
import { onMenuNewChat, onMenuOpenSettings } from './modules/client-store.js';
import { initReadingNavigator } from './modules/reading-navigator.js';
import { autoResize, debounce, showToast } from './modules/utils.js';

let pendingAttachments = [];
let composerOverrides = null;
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
      badge.title = contextMentions.length
        ? contextMentions.map((item) => `${item.type === 'folder' ? '目录' : '文件'}：${item.path}`).join('\n')
        : '';
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
    if ($sidebar.classList.contains('mobile-open') &&
        !$sidebar.contains(e.target) &&
        (!$mobileSidebarToggle || (e.target !== $mobileSidebarToggle &&
        !$mobileSidebarToggle.contains(e.target)))) {
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
  document.querySelectorAll('.suggestion-card').forEach(card => {
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

  if (pendingAttachments.length > 0 && !supportsVisionModel(getSettings())) {
    showToast(`当前模型 ${getSettings().model} 未标记为支持图片输入，请切换 vision 模型后再发送。`, 3200);
    return;
  }

  const attachments = pendingAttachments.map((item) => ({ ...item }));
  const overrides = getComposerOverrides();
  rememberInput(content);

  $input.value = '';
  $input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
  clearPendingAttachments();

  await sendMessage(content, { attachments, composerOverrides: overrides });
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
  const $thinking = document.getElementById('composer-thinking-select');
  const $webToggle = document.getElementById('composer-web-search-toggle');
  const $webStatus = document.getElementById('composer-search-status');
  const $enhanceToggle = document.getElementById('composer-enhance-toggle');
  const $enhanceStatus = document.getElementById('composer-enhance-status');
  const $runStatus = document.getElementById('composer-run-status');
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
    updateComposerRunStatus($runStatus, { ...settings, ...composerOverrides }, $thinking.value);
    syncing = false;
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
    $templateBtn.addEventListener('click', () => togglePromptTemplateMenu($templateBtn));
  }

  window.addEventListener('deepchat:settings-changed', (event) => {
    applySettingsToComposer(event.detail?.settings || getSettings());
  });

  applySettingsToComposer();
}

const PROMPT_TEMPLATES = [
  { title: '排障', text: '请帮我排查这个问题：\n\n现象：\n报错：\n我已经尝试：\n\n请按「最可能原因 -> 如何验证 -> 修复步骤 -> 风险」回答。' },
  { title: '对比选型', text: '请对比以下方案：A / B / C。\n\n请用表格列出关键维度、适用场景、风险，最后给推荐结论。' },
  { title: '代码审查', text: '请审查下面代码，重点看 bug、边界条件、安全风险、性能问题和缺少的测试：\n\n```语言\n\n```' },
  { title: '学习讲解', text: '请用初学者能理解的方式讲解：\n\n要求：先直观解释，再给例子，最后给练习题。' },
];

let promptTemplateMenu = null;
let exportMenu = null;

function togglePromptTemplateMenu(anchor) {
  if (promptTemplateMenu) {
    promptTemplateMenu.remove();
    promptTemplateMenu = null;
    return;
  }
  const menu = document.createElement('div');
  menu.className = 'prompt-template-menu';
  for (const template of PROMPT_TEMPLATES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = template.title;
    item.addEventListener('click', () => {
      const input = document.getElementById('message-input');
      input.value = input.value ? `${input.value}\n\n${template.text}` : template.text;
      autoResize(input);
      document.getElementById('send-btn').disabled = false;
      promptTemplateMenu?.remove();
      promptTemplateMenu = null;
      input.focus();
    });
    menu.appendChild(item);
  }
  anchor.closest('.composer-toolbar')?.appendChild(menu);
  promptTemplateMenu = menu;
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
  return {
    thinkingBudget: composerOverrides?.thinkingBudget ?? settings.thinkingBudget,
    activeSkill: composerOverrides?.activeSkill ?? settings.activeSkill,
    enhance: composerOverrides?.enhance ?? (settings.enhance !== false),
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

function updateComposerRunStatus(target, settings, thinkingValue) {
  if (!target) return;
  const thinking = getThinkingLabel(String(Number.parseInt(thinkingValue, 10) || 0));
  const search = getSearchStatusText(settings);
  const enhance = settings.enhance === false ? '增强关闭' : '增强开启';
  const caps = getModelCapabilities(settings);
  target.textContent = `本轮：${thinking}思考 · 搜索${search} · ${enhance} · 图片${caps.vision ? '可用' : '不可用'}`;
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
  let matches = [];
  let currentMatch = -1;

  function clearHighlights() {
    document.querySelectorAll('.search-highlight').forEach(el => {
      const parent = el.parentNode;
      parent.replaceChild(document.createTextNode(el.textContent), el);
      parent.normalize();
    });
    matches = [];
    currentMatch = -1;
  }

  function doSearch() {
    clearHighlights();
    const query = input.value.trim();
    if (!query) { countEl.textContent = ''; return; }

    const messages = document.querySelectorAll('#chat-messages .message-content');
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

    messages.forEach(msgEl => {
      const walker = document.createTreeWalker(msgEl, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      textNodes.forEach(node => {
        const text = node.textContent;
        if (!regex.test(text)) return;
        regex.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
          if (match.index > lastIdx) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
          }
          const mark = document.createElement('mark');
          mark.className = 'search-highlight';
          mark.textContent = match[0];
          frag.appendChild(mark);
          lastIdx = regex.lastIndex;
        }
        if (lastIdx < text.length) {
          frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        }
        node.parentNode.replaceChild(frag, node);
      });
    });

    matches = Array.from(document.querySelectorAll('.search-highlight'));
    countEl.textContent = matches.length > 0 ? `${matches.length} 个结果` : '无结果';
    if (matches.length > 0) jumpTo(0);
  }

  function jumpTo(idx) {
    if (matches.length === 0) return;
    matches.forEach(m => m.classList.remove('search-highlight-active'));
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

  bar.querySelectorAll('.chat-search-nav').forEach(btn => {
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
    if (e.target === overlay) { overlay.remove(); previewOverlayEl = null; }
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
  const imageFiles = files.filter(f => f.type.startsWith('image/'));
  const textFiles = files.filter(f => !f.type.startsWith('image/'));

  if (imageFiles.length > 0) {
    const remainingSlots = Math.max(0, MAX_IMAGE_ATTACHMENTS - pendingAttachments.length);
    const acceptedImages = imageFiles.slice(0, remainingSlots);
    if (acceptedImages.length < imageFiles.length) {
      showToast(`最多保留 ${MAX_IMAGE_ATTACHMENTS} 张待发送图片，多余图片已忽略。`, 2400);
    }
    acceptedImages.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        // Show attachment preview
        let preview = document.querySelector('.attachment-preview');
        if (!preview) {
          preview = document.createElement('div');
          preview.className = 'attachment-preview';
          const inputArea = document.querySelector('.input-container');
          inputArea.parentNode.insertBefore(preview, inputArea);
        }

        const item = document.createElement('div');
        item.className = 'attachment-item';
        const image = document.createElement('img');
        image.src = reader.result;
        image.alt = file.name || '图片附件';
        const name = document.createElement('span');
        name.className = 'attachment-name';
        name.textContent = file.name || '图片附件';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'attachment-remove';
        remove.title = '移除';
        remove.setAttribute('aria-label', `移除 ${file.name || '图片附件'}`);
        remove.textContent = '×';
        remove.addEventListener('click', () => {
          pendingAttachments = pendingAttachments.filter((attachment) => attachment.id !== item.dataset.attachmentId);
          item.remove();
          if (preview.children.length === 0) preview.remove();
          document.getElementById('send-btn').disabled = !$input.value.trim() && pendingAttachments.length === 0;
        });
        item.append(image, name, remove);
        // Store base64 data for sending
        item.dataset.base64 = reader.result;
        item.dataset.mimeType = file.type;
        const attachment = {
          id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          mimeType: file.type,
          size: file.size,
          dataUrl: reader.result,
        };
        item.dataset.attachmentId = attachment.id;
        pendingAttachments.push(attachment);
        preview.appendChild(item);
        document.getElementById('send-btn').disabled = !$input.value.trim() && pendingAttachments.length === 0;
      };
      reader.readAsDataURL(file);
    });
    if (acceptedImages.length > 0) showToast(`已添加 ${acceptedImages.length} 张图片`, 1500);
  }

  if (textFiles.length > 0) {
    // For non-image files, read as text and paste into input
    const acceptedTextFiles = textFiles.filter((file) => {
      if (file.size <= MAX_TEXT_ATTACHMENT_BYTES) return true;
      showToast(`${file.name} 超过 256KB，已跳过。`, 2600);
      return false;
    });
    acceptedTextFiles.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result;
        const label = file.type || 'text/plain';
        $input.value += (($input.value ? '\n' : '') + `文件：${file.name}\n\n\`\`\`${label}\n${content}\n\`\`\``);
        autoResize($input);
        document.getElementById('send-btn').disabled = false;
      };
      reader.readAsText(file);
    });
    if (acceptedTextFiles.length > 0) showToast(`已插入 ${acceptedTextFiles.length} 个文件内容`);
  }
}

function clearPendingAttachments() {
  pendingAttachments = [];
  document.querySelector('.attachment-preview')?.remove();
}
