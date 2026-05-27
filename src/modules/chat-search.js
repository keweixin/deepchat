const DEFAULT_MATCH_LIMIT = 50;
const DEFAULT_MARK_LIMIT = 300;
const SKIPPED_TEXT_PARENTS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'MARK']);

export function buildChatSearchIndex(root = document) {
  const messages = Array.from(root.querySelectorAll('#chat-messages .message'));
  return messages.map((messageEl, position) => {
    const contentEl = messageEl.querySelector('.message-content');
    const plainText = contentEl?.textContent || '';
    return {
      messageId: messageEl.dataset.messageId || messageEl.dataset.messageIndex || String(position),
      messageIndex: messageEl.dataset.messageIndex || String(position),
      role: getMessageRole(messageEl),
      plainText,
      normalizedText: normalizeSearchText(plainText),
      headings: Array.from(contentEl?.querySelectorAll('h1,h2,h3,h4,h5,h6') || [])
        .map((heading) => heading.textContent?.trim())
        .filter(Boolean),
      element: messageEl,
      contentEl,
    };
  });
}

export function findChatSearchMatches(index, query, options = {}) {
  const term = normalizeSearchText(query);
  if (!term) return [];
  const limit = clampPositiveInt(options.limit, DEFAULT_MATCH_LIMIT);
  const matches = [];
  for (const entry of index || []) {
    if (!entry?.normalizedText?.includes(term)) continue;
    matches.push(entry);
    if (matches.length >= limit) break;
  }
  return matches;
}

export function clearChatSearchHighlights(root = document) {
  root.querySelectorAll('mark.search-highlight').forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    parent.normalize();
  });
  root.querySelectorAll('.chat-search-match').forEach((messageEl) => {
    messageEl.classList.remove('chat-search-match');
  });
}

export function highlightChatSearchMatches(matches, query, options = {}) {
  const term = String(query || '').trim();
  if (!term) return [];
  const markLimit = clampPositiveInt(options.markLimit, DEFAULT_MARK_LIMIT);
  const highlighted = [];
  let totalMarks = 0;
  for (const match of matches || []) {
    if (!match?.contentEl) continue;
    const remaining = markLimit - totalMarks;
    if (remaining <= 0) break;
    const marks = highlightElementText(match.contentEl, term, remaining);
    if (marks.length === 0) continue;
    match.element?.classList.add('chat-search-match');
    highlighted.push(...marks);
    totalMarks += marks.length;
  }
  return highlighted;
}

function highlightElementText(root, query, remainingMarks) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || remainingMarks <= 0) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      if (shouldSkipTextNode(node)) return NodeFilter.FILTER_REJECT;
      return normalizeSearchText(node.textContent).includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const marks = [];
  for (const node of textNodes) {
    if (marks.length >= remainingMarks) break;
    const fragment = createHighlightedFragment(node.textContent || '', query, remainingMarks - marks.length);
    if (!fragment) continue;
    const newMarks = Array.from(fragment.querySelectorAll('mark.search-highlight'));
    node.parentNode?.replaceChild(fragment, node);
    marks.push(...newMarks);
  }
  return marks;
}

function createHighlightedFragment(text, query, remainingMarks) {
  const lowerText = normalizeSearchText(text);
  const lowerQuery = normalizeSearchText(query);
  let start = 0;
  let matchIndex = lowerText.indexOf(lowerQuery, start);
  if (matchIndex < 0) return null;

  const fragment = document.createDocumentFragment();
  let markCount = 0;
  while (matchIndex >= 0 && markCount < remainingMarks) {
    if (matchIndex > start) fragment.appendChild(document.createTextNode(text.slice(start, matchIndex)));
    const end = matchIndex + query.length;
    const mark = document.createElement('mark');
    mark.className = 'search-highlight';
    mark.textContent = text.slice(matchIndex, end);
    fragment.appendChild(mark);
    markCount += 1;
    start = end;
    matchIndex = lowerText.indexOf(lowerQuery, start);
  }
  if (start < text.length) fragment.appendChild(document.createTextNode(text.slice(start)));
  return fragment;
}

function getMessageRole(messageEl) {
  if (messageEl.classList.contains('user')) return 'user';
  if (messageEl.classList.contains('assistant')) return 'assistant';
  if (messageEl.classList.contains('system')) return 'system';
  return '';
}

function shouldSkipTextNode(node) {
  let current = node.parentElement;
  while (current) {
    if (SKIPPED_TEXT_PARENTS.has(current.tagName)) return true;
    if (current.classList?.contains('message-actions')) return true;
    current = current.parentElement;
  }
  return false;
}

function normalizeSearchText(value) {
  return String(value || '').toLocaleLowerCase();
}

function clampPositiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}
