export const SIDEBAR_FILTERS = {
  active: 'active',
  favorites: 'favorites',
  archived: 'archived',
  all: 'all',
};

export function normalizeConversation(conversation = {}) {
  return {
    ...conversation,
    tags: normalizeTags(conversation.tags),
    folderId: normalizeFolderName(conversation.folderId),
    archivedAt: normalizeArchiveTime(conversation.archivedAt),
    contextSummary: typeof conversation.contextSummary === 'string' ? conversation.contextSummary : '',
    contextSummaryUpdatedAt: conversation.contextSummaryUpdatedAt || null,
    usageTotals: conversation.usageTotals && typeof conversation.usageTotals === 'object' ? conversation.usageTotals : null,
    messages: Array.isArray(conversation.messages) ? conversation.messages : [],
  };
}

export function normalizeConversations(conversations) {
  return (Array.isArray(conversations) ? conversations : []).map(normalizeConversation);
}

export function filterConversations(conversations, { query = '', filter = SIDEBAR_FILTERS.active } = {}) {
  const normalizedQuery = normalizeSearchQuery(query);
  return normalizeConversations(conversations)
    .filter((conversation) => matchesSidebarFilter(conversation, filter))
    .filter((conversation) => matchesConversationSearch(conversation, normalizedQuery));
}

export function sortConversations(conversations) {
  return [...conversations].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
}

export function conversationHasFavorite(conversation) {
  return (conversation?.messages || []).some((message) => Boolean(message?.favorite));
}

export function getConversationGroup(conversation) {
  if (conversation.archivedAt) return '归档';
  if (conversation.pinned) return '已置顶';
  if (conversation.folderId) return `文件夹：${conversation.folderId}`;
  return getDateGroup(conversation.createdAt);
}

export function parseTagsInput(value) {
  return normalizeTags(String(value || '').split(/[,，;；\n]/));
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const next = [];
  for (const tag of tags) {
    const value = String(tag || '').trim().replace(/^#/, '').slice(0, 24);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    next.push(value);
    if (next.length >= 8) break;
  }
  return next;
}

export function normalizeFolderName(value) {
  return String(value || '').trim().slice(0, 40);
}

function normalizeArchiveTime(value) {
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function matchesSidebarFilter(conversation, filter) {
  if (filter === SIDEBAR_FILTERS.all) return true;
  if (filter === SIDEBAR_FILTERS.archived) return Boolean(conversation.archivedAt);
  if (filter === SIDEBAR_FILTERS.favorites) return !conversation.archivedAt && conversationHasFavorite(conversation);
  return !conversation.archivedAt;
}

function matchesConversationSearch(conversation, query) {
  if (!query) return true;
  const haystack = [
    conversation.title,
    conversation.folderId,
    ...(conversation.tags || []),
    ...(conversation.messages || []).map((message) => message?.content || ''),
  ].join('\n').toLowerCase();
  return haystack.includes(query);
}

function normalizeSearchQuery(value) {
  return String(value || '').trim().toLowerCase();
}

function getDateGroup(timestamp) {
  if (!timestamp) return '更早';
  const now = new Date();
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = (today - target) / 86400000;
  if (diff < 1) return '今天';
  if (diff < 2) return '昨天';
  if (diff < 7) return '本周';
  if (diff < 30) return '本月';
  return '更早';
}
