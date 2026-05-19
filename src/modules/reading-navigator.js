/**
 * Floating reading navigator for long assistant answers.
 *
 * It builds a lightweight outline from already-sanitized rendered Markdown and
 * keeps the active item in sync with the chat scroll container.
 */

const DEFAULT_MAX_ITEMS = 12;
const MIN_ITEMS_TO_SHOW = 1;
const ACTIVE_OFFSET = 96;

let anchorCounter = 0;
let state = null;
let rafId = 0;

export function initReadingNavigator(options = {}) {
  const scrollContainer = resolveElement(options.scrollContainer || '#chat-messages');
  const host = resolveElement(options.host || '#main-content') || document.body;
  if (!scrollContainer || !host) return null;

  const nav = createNavigatorElement();
  host.appendChild(nav);

  state = {
    host,
    scrollContainer,
    nav,
    list: nav.querySelector('.reading-nav-list'),
    counter: nav.querySelector('.reading-nav-counter'),
    progress: nav.querySelector('.reading-nav-progress-bar'),
    activeContent: null,
    items: [],
    itemButtons: new Map(),
    signature: '',
    structureDirty: true,
    activeAnchorId: '',
    progressPercent: -1,
    collapsed: false,
  };

  nav.querySelector('.reading-nav-collapse').addEventListener('click', () => {
    if (isCompactViewport()) {
      const open = !nav.classList.contains('is-mobile-open');
      nav.classList.toggle('is-mobile-open', open);
      nav.querySelector('.reading-nav-collapse').setAttribute('aria-expanded', String(open));
      return;
    }

    state.collapsed = !state.collapsed;
    nav.classList.toggle('is-collapsed', state.collapsed);
    nav.querySelector('.reading-nav-collapse').setAttribute('aria-expanded', String(!state.collapsed));
  });

  scrollContainer.addEventListener('scroll', scheduleNavigatorPositionUpdate, { passive: true });
  window.addEventListener('resize', handleNavigatorResize);

  refreshReadingNavigator();
  return state;
}

export function refreshReadingNavigator() {
  if (!state) return;
  state.structureDirty = true;
  scheduleNavigatorUpdate();
}

export function resetReadingNavigator() {
  if (!state) return;
  hideNavigator({ dirty: true });
}

export function destroyReadingNavigator() {
  if (!state) return;
  state.scrollContainer.removeEventListener('scroll', scheduleNavigatorPositionUpdate);
  window.removeEventListener('resize', handleNavigatorResize);
  if (rafId) cancelAnimationFrame(rafId);
  state.nav.remove();
  state = null;
  rafId = 0;
}

export function collectReadingAnchors(root, options = {}) {
  if (!root) return [];
  const maxItems = options.maxItems || DEFAULT_MAX_ITEMS;

  const candidates = selectTopLevelHeadings(root);

  const anchors = [];
  const seen = new Set();

  for (const node of candidates) {
    if (!isUsableCandidate(node)) continue;
    const anchor = createAnchorDescriptor(node);
    if (!anchor) continue;

    const duplicateKey = `${anchor.type}:${anchor.label}`;
    if (seen.has(duplicateKey)) continue;

    seen.add(duplicateKey);
    anchors.push(anchor);
    if (anchors.length >= maxItems) break;
  }

  return anchors;
}

export function getAnchorSignature(items) {
  return items.map((item) => `${item.id}:${item.type}:${item.label}`).join('|');
}

function scheduleNavigatorUpdate() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    updateNavigator();
  });
}

function scheduleNavigatorPositionUpdate() {
  if (!state || state.structureDirty) return scheduleNavigatorUpdate();
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!state || state.nav.hidden || state.items.length === 0) return;
    updateActiveItem();
    updateProgress();
  });
}

function handleNavigatorResize() {
  if (!state) return;
  if (!isCompactViewport()) state.nav.classList.remove('is-mobile-open');
  scheduleNavigatorUpdate();
}

function updateNavigator() {
  if (state.structureDirty) {
    state.structureDirty = false;
    const items = collectReadingAnchors(state.scrollContainer);
    if (items.length < MIN_ITEMS_TO_SHOW) {
      hideNavigator({ dirty: false });
      return;
    }

    const signature = getAnchorSignature(items);
    if (state.signature !== signature) {
      state.activeContent = state.scrollContainer;
      state.items = items;
      state.signature = signature;
      state.activeAnchorId = '';
      renderNavigatorItems(items);
    }
  } else if (!state.items.length) {
    hideNavigator({ dirty: false });
    return;
  }

  state.nav.classList.remove('hidden');
  state.nav.hidden = false;
  updateActiveItem();
  updateProgress();
}

function hideNavigator(options = {}) {
  if (!state) return;
  state.nav.classList.add('hidden');
  state.nav.hidden = true;
  state.activeContent = null;
  state.items = [];
  state.itemButtons = new Map();
  state.signature = '';
  state.activeAnchorId = '';
  state.progressPercent = -1;
  state.structureDirty = Boolean(options.dirty);
  state.list.replaceChildren();
  state.counter.textContent = '';
  state.progress.style.height = '0%';
}

function renderNavigatorItems(items) {
  const fragment = document.createDocumentFragment();
  state.itemButtons = new Map();
  state.counter.textContent = `${items.length} 个标题`;

  items.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `reading-nav-item is-${item.type}`;
    button.dataset.anchorId = item.id;
    button.title = item.label;
    button.setAttribute('aria-label', `跳转到 ${item.label}`);
    if (item.level) button.style.setProperty('--nav-indent', `${Math.max(0, item.level - 2) * 10}px`);

    const marker = document.createElement('span');
    marker.className = 'reading-nav-marker';
    marker.textContent = getItemGlyph(item);

    const text = document.createElement('span');
    text.className = 'reading-nav-text';
    text.textContent = item.label;

    button.append(marker, text);
    button.addEventListener('click', () => scrollToAnchor(item.node));
    fragment.appendChild(button);
    state.itemButtons.set(item.id, button);

    if (index === 0) button.setAttribute('aria-current', 'true');
  });
  state.list.replaceChildren(fragment);
}

function updateActiveItem() {
  if (!state.items.length) return;

  const containerRect = state.scrollContainer.getBoundingClientRect();
  const focusLine = containerRect.top + ACTIVE_OFFSET;
  let active = state.items[0];

  for (const item of state.items) {
    const rect = item.node.getBoundingClientRect();
    if (rect.top <= focusLine) active = item;
    if (rect.top > focusLine) break;
  }

  if (state.activeAnchorId === active.id) return;

  const previous = state.itemButtons.get(state.activeAnchorId);
  if (previous) {
    previous.classList.remove('is-active');
    previous.removeAttribute('aria-current');
  }

  const next = state.itemButtons.get(active.id);
  if (next) {
    next.classList.add('is-active');
    next.setAttribute('aria-current', 'true');
  }
  state.activeAnchorId = active.id;
}

function updateProgress() {
  if (!state.activeContent) return;

  const maxScroll = Math.max(1, state.scrollContainer.scrollHeight - state.scrollContainer.clientHeight);
  const value = clamp(state.scrollContainer.scrollTop / maxScroll, 0, 1);
  const percent = Math.round(value * 100);
  if (percent === state.progressPercent) return;
  state.progressPercent = percent;
  state.progress.style.height = `${percent}%`;
}

function scrollToAnchor(node) {
  const targetTop = getTopWithinScroll(node, state.scrollContainer) - ACTIVE_OFFSET;
  state.scrollContainer.scrollTo({
    top: Math.max(0, targetTop),
    behavior: 'smooth',
  });
}

function createAnchorDescriptor(node) {
  const tag = node.tagName?.toLowerCase();
  const id = ensureAnchorId(node);

  if (/^h[1-6]$/.test(tag)) {
    return {
      id,
      node,
      type: 'heading',
      level: Number(tag.slice(1)),
      label: truncateLabel(cleanText(node.textContent), 34),
    };
  }

  if (node.classList.contains('answer-summary')) {
    return null;
  }

  if (node.classList.contains('answer-callout')) {
    return null;
  }

  return null;
}

function createNavigatorElement() {
  const nav = document.createElement('nav');
  nav.className = 'reading-navigator hidden';
  nav.hidden = true;
  nav.setAttribute('aria-label', '回答阅读导航');
  nav.innerHTML = `
    <div class="reading-nav-header">
      <span class="reading-nav-title">阅读导航</span>
      <span class="reading-nav-counter"></span>
      <button class="reading-nav-collapse" type="button" aria-label="收起阅读导航" aria-expanded="true">
        <span aria-hidden="true">−</span>
      </button>
    </div>
    <div class="reading-nav-body">
      <div class="reading-nav-list" role="list"></div>
      <div class="reading-nav-progress" aria-hidden="true"><span class="reading-nav-progress-bar"></span></div>
    </div>
  `;
  return nav;
}

function getItemGlyph(item) {
  const map = {
    heading: '§',
  };
  return map[item.type] || '·';
}

function ensureAnchorId(node) {
  if (!node.dataset.readingAnchorId) {
    anchorCounter += 1;
    node.dataset.readingAnchorId = `reading-anchor-${anchorCounter}`;
  }
  return node.dataset.readingAnchorId;
}

function isUsableCandidate(node) {
  if (!node || node.closest('[hidden]')) return false;
  if (node.matches('h1,h2,h3,h4,h5,h6')) {
    return cleanText(node.textContent).length > 0;
  }
  return true;
}

function selectTopLevelHeadings(root) {
  const headings = [...root.querySelectorAll('.message.assistant .message-content h1, .message.assistant .message-content h2, .message.assistant .message-content h3, .message.assistant .message-content h4, .message.assistant .message-content h5, .message.assistant .message-content h6, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')]
    .filter(isUsableCandidate);
  if (headings.length === 0) return [];

  const minLevel = Math.min(...headings.map((node) => Number(node.tagName.slice(1))));
  return headings.filter((node) => Number(node.tagName.slice(1)) === minLevel);
}

function getTopWithinScroll(node, scrollContainer) {
  const nodeRect = node.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  return scrollContainer.scrollTop + (nodeRect.top - containerRect.top);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateLabel(text, maxLength) {
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolveElement(target) {
  if (!target) return null;
  if (typeof target === 'string') return document.querySelector(target);
  return target;
}

function isCompactViewport() {
  return window.matchMedia?.('(max-width: 760px)').matches;
}
