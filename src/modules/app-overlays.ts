import { renderMarkdown, safeSetHTML } from './renderer.js';
import { debounce, showToast } from './utils.js';
import {
  buildChatSearchIndex,
  clearChatSearchHighlights,
  findChatSearchMatches,
  highlightChatSearchMatches,
} from './chat-search.js';

let keyboardHelpEl: HTMLElement | null = null;
let chatSearchEl: HTMLElement | null = null;
let previewOverlayEl: HTMLElement | null = null;

export function toggleKeyboardHelp() {
  if (keyboardHelpEl) {
    keyboardHelpEl.remove();
    keyboardHelpEl = null;
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'keyboard-help-overlay';
  overlay.innerHTML = /* safeSetHTML-exempt: static template */ `
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

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) toggleKeyboardHelp();
  });
  overlay.querySelector('.keyboard-help-close')?.addEventListener('click', toggleKeyboardHelp);
  document.addEventListener('keydown', function escClose(event) {
    if (event.key === 'Escape' && keyboardHelpEl) {
      toggleKeyboardHelp();
      document.removeEventListener('keydown', escClose);
    }
  });

  document.body.appendChild(overlay);
  keyboardHelpEl = overlay;
}

export function toggleChatSearch() {
  if (chatSearchEl) {
    closeChatSearch();
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'chat-search-bar';
  bar.innerHTML = /* safeSetHTML-exempt: static template */ `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
    <input type="text" class="chat-search-input" placeholder="搜索对话内容…" autofocus />
    <span class="chat-search-count"></span>
    <button class="chat-search-nav" data-dir="-1" title="上一个">▲</button>
    <button class="chat-search-nav" data-dir="1" title="下一个">▼</button>
    <button class="chat-search-close" title="关闭">&times;</button>
  `;

  const mainContent = document.getElementById('main-content');
  mainContent?.insertBefore(bar, mainContent.firstChild);
  chatSearchEl = bar;

  const input = bar.querySelector('.chat-search-input') as HTMLInputElement;
  const countEl = bar.querySelector('.chat-search-count') as HTMLElement;
  let searchIndex = buildChatSearchIndex(document);
  let matches: HTMLElement[] = [];
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

  function jumpTo(idx: number) {
    if (matches.length === 0) return;
    matches.forEach((match) => match.classList.remove('search-highlight-active'));
    currentMatch = ((idx % matches.length) + matches.length) % matches.length;
    const target = matches[currentMatch];
    target.classList.add('search-highlight-active');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    countEl.textContent = `${currentMatch + 1}/${matches.length}`;
  }

  function closeChatSearch() {
    clearHighlights();
    bar.remove();
    chatSearchEl = null;
  }

  input.addEventListener('input', debounce(doSearch, 200));
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpTo(event.shiftKey ? currentMatch - 1 : currentMatch + 1);
    }
    if (event.key === 'Escape') closeChatSearch();
  });

  bar.querySelectorAll('.chat-search-nav').forEach((button) => {
    button.addEventListener('click', () => {
      jumpTo(currentMatch + Number.parseInt((button as HTMLElement).dataset.dir || '1', 10));
    });
  });
  bar.querySelector('.chat-search-close')?.addEventListener('click', closeChatSearch);

  input.focus();
}

export function toggleMarkdownPreview(text: string) {
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
  overlay.innerHTML = /* safeSetHTML-exempt: static template */ `
    <div class="markdown-preview-panel">
      <div class="markdown-preview-header">
        <h3>📝 Markdown 预览</h3>
        <button class="markdown-preview-close icon-btn" title="关闭">&times;</button>
      </div>
      <div class="markdown-preview-body message-content"></div>
    </div>
  `;

  const body = overlay.querySelector('.markdown-preview-body') as HTMLElement | null;
  safeSetHTML(body, renderMarkdown(text));

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeMarkdownPreview();
  });
  overlay.querySelector('.markdown-preview-close')?.addEventListener('click', closeMarkdownPreview);
  document.addEventListener('keydown', function escClose(event) {
    if (event.key === 'Escape' && previewOverlayEl) {
      closeMarkdownPreview();
      document.removeEventListener('keydown', escClose);
    }
  });

  document.body.appendChild(overlay);
  previewOverlayEl = overlay;
}

function closeMarkdownPreview() {
  previewOverlayEl?.remove();
  previewOverlayEl = null;
}

export function resetAppOverlayStateForTests() {
  keyboardHelpEl?.remove();
  keyboardHelpEl = null;
  chatSearchEl?.remove();
  chatSearchEl = null;
  previewOverlayEl?.remove();
  previewOverlayEl = null;
  clearChatSearchHighlights(document);
}
