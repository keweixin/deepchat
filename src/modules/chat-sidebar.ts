/**
 * Chat Sidebar — Conversation list, context menu, bulk operations.
 *
 * Extracted from chat.js using dependency injection to avoid module-level state.
 * Call `createSidebar(deps)` with getters/setters for shared state.
 */

import { escapeHtml, clampNumber } from './shared-utils.js';
import { formatTime, relativeTime, showToast } from './utils.js';
import { confirmAction, promptText } from './dialogs.ts';
import {
  SIDEBAR_FILTERS,
  filterConversations,
  getConversationGroup,
  normalizeFolderName,
  parseTagsInput,
  sortConversations,
} from './conversation-utils.js';

/**
 * @param {Object} deps
 * @param {Function} deps.getConversations
 * @param {Function} deps.setConversations
 * @param {Function} deps.getActiveConvId
 * @param {Function} deps.setActiveConvId
 * @param {Function} deps.getSidebarFilter
 * @param {Function} deps.setSidebarFilter
 * @param {Function} deps.getBulkMode
 * @param {Function} deps.setBulkMode
 * @param {Function} deps.getSelectedIds
 * @param {Function} deps.persist
 * @param {Function} deps.switchConversation
 * @param {Function} deps.deleteConversation
 * @param {Function} deps.renameConversation
 * @param {Function} deps.showWelcome
 * @param {Function} deps.updateHeader
 * @param {HTMLElement} deps.$convList
 */
export function createSidebar(deps: Record<string, any>) {
  let conversationMenuEl: HTMLElement | null = null;
  let conversationMenuCleanup: (() => void) | null = null;

  function closeConversationMenu() {
    if (conversationMenuCleanup) conversationMenuCleanup();
    conversationMenuCleanup = null;
    conversationMenuEl?.remove();
    conversationMenuEl = null;
  }

  function positionConversationMenu(menu: HTMLElement, anchor: HTMLElement) {
    if (!menu || !anchor?.isConnected) {
      closeConversationMenu();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(196, menu.offsetWidth || 196);
    const height = menu.offsetHeight || 260;
    const margin = 8;
    const left = clampNumber(rect.right - width, margin, window.innerWidth - width - margin);
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, rect.top - height - 8);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function openConversationMenu(id: string, anchor: HTMLElement) {
    const conv = deps.getConversations().find((c: Record<string, any>) => c.id === id);
    if (!conv || !anchor) return;
    closeConversationMenu();
    anchor.setAttribute('aria-expanded', 'true');
    anchor.closest('.conversation-item')?.classList.add('is-menu-open');

    const menu = document.createElement('div');
    menu.className = 'conversation-action-menu';
    menu.dataset.conversationId = id;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', `对话操作：${conv.title}`);

    const actions = [
      { label: '重命名', icon: '✎', onClick: () => promptRenameConversation(id) },
      { label: '编辑标签', icon: '#', onClick: () => editConversationTags(id) },
      { label: '移动到文件夹', icon: '▣', onClick: () => moveConversationFolder(id) },
      { label: conv.pinned ? '取消置顶' : '置顶聊天', icon: '⌃', onClick: () => deps.togglePinConversation?.(id) },
      {
        label: conv.archivedAt ? '取消归档' : '归档',
        icon: conv.archivedAt ? '↩' : '□',
        onClick: () => toggleArchiveConversation(id),
      },
      { label: '删除', icon: '⌫', tone: 'danger', onClick: () => deps.deleteConversation(id) },
    ];

    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `conversation-menu-item${action.tone === 'danger' ? ' is-danger' : ''}`;
      button.setAttribute('role', 'menuitem');
      const icon = document.createElement('span');
      icon.className = 'conversation-menu-icon';
      icon.textContent = action.icon;
      const text = document.createElement('span');
      text.textContent = action.label;
      button.append(icon, text);
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        closeConversationMenu();
        await action.onClick();
      });
      menu.appendChild(button);
    }

    document.body.appendChild(menu);
    positionConversationMenu(menu, anchor);
    conversationMenuEl = menu;

    const onPointerDown = (event: PointerEvent) => {
      if (menu.contains(event.target as Node) || anchor.contains(event.target as Node)) return;
      closeConversationMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeConversationMenu();
    };
    const onReposition = () => positionConversationMenu(menu, anchor);
    const pointerDownTimeout = setTimeout(() => document.addEventListener('pointerdown', onPointerDown, true), 0);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition, { passive: true });
    window.addEventListener('scroll', onReposition, { passive: true, capture: true });
    conversationMenuCleanup = () => {
      clearTimeout(pointerDownTimeout);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      anchor.setAttribute('aria-expanded', 'false');
      anchor.closest('.conversation-item')?.classList.remove('is-menu-open');
    };
    menu.querySelector('button')?.focus();
  }

  function toggleConversationMenu(id: string, anchor: HTMLElement) {
    if (conversationMenuEl?.dataset.conversationId === id) {
      closeConversationMenu();
      return;
    }
    openConversationMenu(id, anchor);
  }

  function getEmptyConversationText(searchQuery: string) {
    if (searchQuery) return '未找到匹配的对话';
    if (deps.getSidebarFilter() === SIDEBAR_FILTERS.favorites) return '暂无收藏回答';
    if (deps.getSidebarFilter() === SIDEBAR_FILTERS.archived) return '暂无归档对话';
    return '暂无对话记录';
  }

  function updateConversationToolbarState() {
    document.querySelectorAll('[data-conv-filter]').forEach((button) => {
      const el = button as HTMLElement;
      el.classList.toggle('active', el.dataset.convFilter === deps.getSidebarFilter());
    });
    document.getElementById('conversation-bulk-toggle')?.classList.toggle('active', deps.getBulkMode());
    const bar = document.getElementById('conversation-bulk-bar');
    const count = document.getElementById('conversation-bulk-count');
    if (bar) bar.classList.toggle('hidden', !deps.getBulkMode());
    if (count) count.textContent = `已选 ${deps.getSelectedIds().size}`;
  }

  function toggleConversationSelection(id: string, checked?: boolean) {
    const selectedIds = deps.getSelectedIds();
    const next = checked ?? !selectedIds.has(id);
    if (next) selectedIds.add(id);
    else selectedIds.delete(id);
    renderConversationList((document.getElementById('search-input') as HTMLInputElement)?.value?.trim() || '');
  }

  function renderConversationList(searchQuery = '') {
    closeConversationMenu();
    deps.$convList.textContent = '';
    updateConversationToolbarState();

    const filtered = filterConversations(deps.getConversations(), {
      query: searchQuery,
      filter: deps.getSidebarFilter(),
    });

    if (filtered.length === 0) {
      deps.$convList.innerHTML = `<div class="sidebar-empty">${getEmptyConversationText(searchQuery)}</div>`; /* safeSetHTML-exempt: static template */
      return;
    }

    const sorted = sortConversations(filtered);
    let lastGroup = '';

    sorted.forEach((conv) => {
      if (!searchQuery) {
        const group = getConversationGroup(conv);
        if (group !== lastGroup) {
          lastGroup = group;
          const header = document.createElement('div');
          header.className = `conv-date-group${conv.pinned ? ' conv-pinned-group' : ''}`;
          header.textContent = group;
          deps.$convList.appendChild(header);
        }
      }

      const item = document.createElement('div');
      item.className = `conversation-item${conv.id === deps.getActiveConvId() ? ' active' : ''}${conv.pinned ? ' is-pinned' : ''}${conv.archivedAt ? ' is-archived' : ''}`;
      item.dataset.conversationId = conv.id;
      const pinIcon = conv.pinned ? '<span class="conv-pin-indicator" title="已置顶">📌</span>' : '';
      const tags = (conv.tags || []).map((tag: string) => `<span class="conv-tag">#${escapeHtml(tag)}</span>`).join('');
      const meta = [conv.folderId ? `<span class="conv-folder-label">${escapeHtml(conv.folderId)}</span>` : '', tags]
        .filter(Boolean)
        .join('');
      const selected = deps.getSelectedIds().has(conv.id);
      item.innerHTML = /* safeSetHTML-exempt: static template */ `
        ${deps.getBulkMode() ? `<input class="conv-select" type="checkbox" ${selected ? 'checked' : ''} aria-label="选择对话">` : ''}
        <svg class="conv-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <span class="conv-text">
          <span class="conv-title">${escapeHtml(conv.title)}</span>
          ${meta ? `<span class="conv-meta">${meta}</span>` : ''}
        </span>
        ${pinIcon}
        <div class="conv-actions">
          <button class="conv-menu-trigger icon-btn-sm" title="更多操作" aria-label="打开对话操作菜单" aria-haspopup="menu" aria-expanded="false">
            <span aria-hidden="true">•••</span>
          </button>
        </div>
      `;

      item.addEventListener('click', (e) => {
        const target = e.target as Element;
        if (target.closest('.conv-actions') || target.closest('.conv-select')) return;
        if (deps.getBulkMode()) {
          toggleConversationSelection(conv.id);
          return;
        }
        deps.switchConversation(conv.id);
      });

      item.querySelector('.conv-select')?.addEventListener('change', (e) => {
        e.stopPropagation();
        toggleConversationSelection(conv.id, (e.target as HTMLInputElement).checked);
      });

      item.querySelector('.conv-menu-trigger')?.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleConversationMenu(conv.id, e.currentTarget as HTMLElement);
      });

      const titleEl = item.querySelector('.conv-title') as HTMLElement;
      titleEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        titleEl.contentEditable = 'true';
        titleEl.focus();
        const range = document.createRange();
        range.selectNodeContents(titleEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        const finishEdit = () => {
          titleEl.contentEditable = 'false';
          const newTitle = titleEl.textContent?.trim() || '';
          if (newTitle && newTitle !== conv.title) {
            deps.renameConversation(conv.id, newTitle);
          } else {
            titleEl.textContent = conv.title;
          }
        };
        titleEl.addEventListener('blur', finishEdit, { once: true });
        titleEl.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') {
            ke.preventDefault();
            titleEl.blur();
          }
          if (ke.key === 'Escape') {
            titleEl.textContent = conv.title;
            titleEl.blur();
          }
        });
      });

      deps.$convList.appendChild(item);
    });
  }

  async function promptRenameConversation(id: string) {
    const conv = deps.getConversations().find((c: Record<string, any>) => c.id === id);
    if (!conv) return;
    const next = await promptText({
      title: '重命名对话',
      message: '输入新的对话名称。',
      value: conv.title || '',
      placeholder: '对话名称',
    });
    if (next === null) return;
    const title = next.trim();
    if (title) deps.renameConversation(id, title);
  }

  async function deleteSelectedConversations() {
    const selectedIds = deps.getSelectedIds();
    if (selectedIds.size === 0) return;
    const ok = await confirmAction({
      title: '批量删除对话',
      message: `确定删除选中的 ${selectedIds.size} 个对话？此操作不可恢复。`,
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    const conversations = deps.getConversations().filter((c: Record<string, any>) => !selectedIds.has(c.id));
    deps.setConversations(conversations);
    const activeConvId = deps.getActiveConvId();
    if (activeConvId && selectedIds.has(activeConvId)) {
      deps.setActiveConvId(conversations[0]?.id || null);
    }
    selectedIds.clear();
    deps.setBulkMode(false);
    deps.persist();
    const newActiveId = deps.getActiveConvId();
    if (newActiveId) deps.switchConversation(newActiveId);
    else {
      renderConversationList();
      deps.showWelcome();
      deps.updateHeader();
    }
  }

  function archiveSelectedConversations() {
    const selectedIds = deps.getSelectedIds();
    if (selectedIds.size === 0) return;
    for (const conv of deps.getConversations()) {
      if (selectedIds.has(conv.id)) conv.archivedAt = Date.now();
    }
    selectedIds.clear();
    deps.setBulkMode(false);
    deps.persist();
    renderConversationList((document.getElementById('search-input') as HTMLInputElement)?.value?.trim() || '');
  }

  function toggleArchiveConversation(id: string) {
    const conv = deps.getConversations().find((c: Record<string, any>) => c.id === id);
    if (!conv) return;
    conv.archivedAt = conv.archivedAt ? null : Date.now();
    deps.persist();
    const activeConvId = deps.getActiveConvId();
    if (conv.id === activeConvId && conv.archivedAt && deps.getSidebarFilter() === SIDEBAR_FILTERS.active) {
      const next = deps.getConversations().find((item: Record<string, any>) => !item.archivedAt && item.id !== conv.id);
      if (next) deps.switchConversation(next.id);
      else {
        deps.setActiveConvId(null);
        deps.showWelcome();
        deps.updateHeader();
        renderConversationList((document.getElementById('search-input') as HTMLInputElement)?.value?.trim() || '');
      }
      return;
    }
    renderConversationList((document.getElementById('search-input') as HTMLInputElement)?.value?.trim() || '');
  }

  async function editConversationTags(id: string) {
    const conv = deps.getConversations().find((c: Record<string, any>) => c.id === id);
    if (!conv) return;
    const next = await promptText({
      title: '编辑标签',
      message: '输入标签，用逗号、分号或换行分隔。留空表示清除标签。',
      value: (conv.tags || []).join(', '),
      placeholder: '例如：项目, 排障, 收藏',
    });
    if (next === null) return;
    conv.tags = parseTagsInput(next);
    deps.persist();
    renderConversationList((document.getElementById('search-input') as HTMLInputElement)?.value?.trim() || '');
  }

  async function moveConversationFolder(id: string) {
    const conv = deps.getConversations().find((c: Record<string, any>) => c.id === id);
    if (!conv) return;
    const next = await promptText({
      title: '移动到文件夹',
      message: '输入文件夹名称。留空表示移出文件夹。',
      value: conv.folderId || '',
      placeholder: '例如：工作 / 学习 / 项目',
    });
    if (next === null) return;
    conv.folderId = normalizeFolderName(next);
    deps.persist();
    renderConversationList((document.getElementById('search-input') as HTMLInputElement)?.value?.trim() || '');
  }

  function bindConversationToolbar() {
    document.querySelectorAll('[data-conv-filter]').forEach((button) => {
      const el = button as HTMLElement;
      el.addEventListener('click', () => {
        deps.setSidebarFilter(el.dataset.convFilter || SIDEBAR_FILTERS.active);
        deps.getSelectedIds().clear();
        renderConversationList((document.getElementById('search-input') as HTMLInputElement)?.value?.trim() || '');
      });
    });
    document.getElementById('conversation-bulk-toggle')?.addEventListener('click', () => {
      deps.setBulkMode(!deps.getBulkMode());
      deps.getSelectedIds().clear();
      renderConversationList((document.getElementById('search-input') as HTMLInputElement)?.value?.trim() || '');
    });
    document.getElementById('conversation-bulk-delete')?.addEventListener('click', deleteSelectedConversations);
    document.getElementById('conversation-bulk-archive')?.addEventListener('click', archiveSelectedConversations);
    document.getElementById('conversation-bulk-cancel')?.addEventListener('click', () => {
      deps.setBulkMode(false);
      deps.getSelectedIds().clear();
      renderConversationList((document.getElementById('search-input') as HTMLInputElement)?.value?.trim() || '');
    });
  }

  return {
    bindConversationToolbar,
    renderConversationList,
    toggleConversationMenu,
    closeConversationMenu,
    updateConversationToolbarState,
    deleteSelectedConversations,
    archiveSelectedConversations,
    toggleArchiveConversation,
    editConversationTags,
    moveConversationFolder,
    promptRenameConversation,
  };
}
