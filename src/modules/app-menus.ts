import { buildContextShortcutEntries } from './context-shortcuts.js';
import { buildComposerToolEntries, getComposerToolApprovalSummary } from './composer-tools.js';
import { applyPromptTemplate, getPromptTemplateEntries } from './prompt-templates.js';
import { autoResize, showToast } from './utils.js';

let promptTemplateMenu: HTMLElement | null = null;
let exportMenu: HTMLElement | null = null;
let composerToolMenu: HTMLElement | null = null;
let contextShortcutMenu: HTMLElement | null = null;

export function togglePromptTemplateMenu(anchor: HTMLElement | null, onApplyTemplate?: (template: any) => void) {
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
      const input = document.getElementById('message-input') as HTMLTextAreaElement | null;
      if (!input) return;
      input.value = applyPromptTemplate(input.value, template.text);
      autoResize(input);
      const sendBtn = document.getElementById('send-btn') as HTMLButtonElement | null;
      if (sendBtn) sendBtn.disabled = false;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      onApplyTemplate?.(template);
      promptTemplateMenu?.remove();
      promptTemplateMenu = null;
      input.focus();
    });
    menu.appendChild(item);
  }
  anchor?.closest('.composer-toolbar')?.appendChild(menu);
  promptTemplateMenu = menu;
}

export function toggleComposerToolMenu(
  anchor: HTMLElement | null,
  options: {
    settings?: Record<string, any>;
    activeSkill?: string;
    onSelect?: (entry: any) => void;
    onChange?: () => void;
    openSettings?: () => void;
  } = {}
) {
  if (composerToolMenu) {
    composerToolMenu.remove();
    composerToolMenu = null;
    anchor?.setAttribute('aria-expanded', 'false');
    return;
  }

  const settings = options.settings || {};
  const activeSkill = options.activeSkill || settings.activeSkill;
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
        options.openSettings?.();
        return;
      }
      options.onSelect?.(entry);
      composerToolMenu?.remove();
      composerToolMenu = null;
      anchor?.setAttribute('aria-expanded', 'false');
      options.onChange?.();
      showToast(`本轮工具：${entry.name}`, 1200);
    });
    menu.appendChild(item);
  }

  const footer = document.createElement('div');
  footer.className = 'composer-tool-menu-footer';
  footer.textContent = getComposerToolApprovalSummary(settings);
  menu.appendChild(footer);

  anchor?.closest('.composer-toolbar')?.appendChild(menu);
  composerToolMenu = menu;
  anchor?.setAttribute('aria-expanded', 'true');
  bindOutsideClose(
    anchor,
    () => composerToolMenu,
    (next) => {
      composerToolMenu = next;
    }
  );
}

export function toggleContextShortcutMenu(
  anchor: HTMLElement | null,
  options: {
    settings?: Record<string, any>;
    openSettings?: () => void;
    getPendingAttachmentCount?: () => number;
  } = {}
) {
  if (contextShortcutMenu) {
    contextShortcutMenu.remove();
    contextShortcutMenu = null;
    anchor?.setAttribute('aria-expanded', 'false');
    return;
  }

  const settings = options.settings || {};
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
        options.openSettings?.();
        return;
      }
      const input = document.getElementById('message-input') as HTMLTextAreaElement | null;
      insertIntoComposer(input, entry, {
        pendingAttachmentCount: options.getPendingAttachmentCount?.() || 0,
      });
      contextShortcutMenu?.remove();
      contextShortcutMenu = null;
      anchor?.setAttribute('aria-expanded', 'false');
      input?.focus();
    });
    menu.appendChild(item);
  }

  const footer = document.createElement('div');
  footer.className = 'context-shortcut-footer';
  footer.textContent = '显式上下文优先于自动判断，能减少误用工具。';
  menu.appendChild(footer);

  anchor?.closest('.composer-toolbar')?.appendChild(menu);
  contextShortcutMenu = menu;
  anchor?.setAttribute('aria-expanded', 'true');
  bindOutsideClose(
    anchor,
    () => contextShortcutMenu,
    (next) => {
      contextShortcutMenu = next;
    }
  );
}

export function insertIntoComposer(
  input: HTMLTextAreaElement | null,
  entry: any,
  options: { pendingAttachmentCount?: number } = {}
) {
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
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = !input.value.trim() && (options.pendingAttachmentCount || 0) === 0;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export function toggleExportMenu(anchor: HTMLElement | null, onExport: (format: string) => void) {
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
      onExport(format);
      exportMenu?.remove();
      exportMenu = null;
    });
    menu.appendChild(item);
  }
  (anchor?.closest('#chat-header') || document.getElementById('chat-header'))?.appendChild(menu);
  exportMenu = menu;
}

export function resetAppMenuStateForTests() {
  promptTemplateMenu?.remove();
  promptTemplateMenu = null;
  exportMenu?.remove();
  exportMenu = null;
  composerToolMenu?.remove();
  composerToolMenu = null;
  contextShortcutMenu?.remove();
  contextShortcutMenu = null;
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

function bindOutsideClose(
  anchor: HTMLElement | null,
  getMenu: () => HTMLElement | null,
  setMenu: (next: HTMLElement | null) => void
) {
  const closeOnOutside = (event: MouseEvent) => {
    const menu = getMenu();
    if (!menu) {
      document.removeEventListener('click', closeOnOutside);
      return;
    }
    const target = event.target as Node | null;
    if ((target && menu.contains(target)) || (target && anchor?.contains(target))) return;
    menu.remove();
    setMenu(null);
    anchor?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeOnOutside);
  };
  setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
}
