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
    contextSummaryMeta: conversation.contextSummaryMeta && typeof conversation.contextSummaryMeta === 'object' ? conversation.contextSummaryMeta : null,
    taskCheckpoint: normalizeTaskCheckpoint(conversation.taskCheckpoint),
    taskCheckpointUpdatedAt: conversation.taskCheckpointUpdatedAt || conversation.taskCheckpoint?.updatedAt || null,
    usageTotals: conversation.usageTotals && typeof conversation.usageTotals === 'object' ? conversation.usageTotals : null,
    cacheProfile: conversation.cacheProfile && typeof conversation.cacheProfile === 'object' ? conversation.cacheProfile : null,
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

export function buildRelevantMemoryContext(conversations, activeConversationId, latestUserContent, options = {}) {
  const maxHits = clampInt(options.maxHits, 1, 6, 3);
  const maxChars = clampInt(options.maxChars, 400, 2400, 1200);
  const terms = extractMemoryTerms(latestUserContent);
  if (terms.length === 0) return { text: '', hits: [], terms: [] };

  const normalizedLatest = normalizeMemoryText(latestUserContent);
  const hits = [];
  for (const conversation of normalizeConversations(conversations)) {
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const latestUserIndex = conversation.id === activeConversationId ? findLatestUserIndex(messages) : -1;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
      if (conversation.id === activeConversationId && index === latestUserIndex) continue;
      const content = stripGeneratedMemoryBlocks(message.content || '');
      if (!content.trim()) continue;
      if (normalizeMemoryText(content) === normalizedLatest) continue;
      const score = scoreMemoryCandidate(conversation, message, terms);
      if (score <= 0) continue;
      hits.push({
        conversationId: conversation.id,
        title: conversation.title || '未命名对话',
        timestamp: Number(message.timestamp || conversation.updatedAt || conversation.createdAt || 0),
        role: message.role,
        score,
        snippet: compactMemorySnippet(content, 320),
        neighbor: getNeighborSnippet(messages, index),
      });
    }
  }

  const selected = hits
    .sort((left, right) => (right.score - left.score) || (right.timestamp - left.timestamp))
    .slice(0, maxHits);
  if (selected.length === 0) return { text: '', hits: [], terms };

  const lines = [
    '<related_memory>',
    '以下为 DeepChat 从本地历史对话检索到的相关片段，只作参考；如果与当前用户消息冲突，以当前消息为准。',
    ...selected.map((hit, index) => {
      const role = hit.role === 'assistant' ? '助手' : '用户';
      const neighbor = hit.neighbor ? `\n   相邻上下文：${hit.neighbor}` : '';
      return `${index + 1}. [${hit.title}] ${role}: ${hit.snippet}${neighbor}`;
    }),
    '</related_memory>',
  ];
  const text = lines.join('\n').slice(0, maxChars);
  return { text, hits: selected, terms };
}

export function buildTaskCheckpoint(conversation = {}, options = {}) {
  const messages = (Array.isArray(conversation.messages) ? conversation.messages : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'));
  if (messages.length === 0) return null;

  const users = messages.filter((message) => message.role === 'user');
  const assistants = messages.filter((message) => message.role === 'assistant');
  const firstUser = users[0];
  const latestUser = users.at(-1);
  const latestAssistant = assistants.at(-1);
  const cacheProfile = conversation.cacheProfile && typeof conversation.cacheProfile === 'object'
    ? conversation.cacheProfile
    : {};

  return normalizeTaskCheckpoint({
    objective: compactMemorySnippet(firstUser?.content || '', 320),
    latestUserGoal: compactMemorySnippet(latestUser?.content || '', 360),
    lastAssistantSummary: compactMemorySnippet(latestAssistant?.content || '', 420),
    contextSummary: compactMemorySnippet(conversation.contextSummary || '', 420),
    openItems: extractRecentAgentOpenItems(messages),
    lastTools: extractRecentToolNames(messages),
    sourceMessageCount: messages.length,
    updatedAt: options.now || new Date().toISOString(),
    prefixFingerprint: cacheProfile.prefixFingerprint || conversation.cacheProfile?.prefixFingerprint || '',
  });
}

export function buildTaskCheckpointContext(checkpoint, options = {}) {
  const normalized = normalizeTaskCheckpoint(checkpoint);
  if (!normalized) return '';
  const maxChars = clampInt(options.maxChars, 500, 2400, 1200);
  const lines = [
    '<task_checkpoint>',
    '以下是 DeepChat 保存的长期任务状态，放在本轮用户消息尾部以保持 DeepSeek prefix cache 稳定；如果与用户最新消息冲突，以最新消息为准。',
  ];
  if (normalized.objective) lines.push(`目标: ${normalized.objective}`);
  if (normalized.latestUserGoal && normalized.latestUserGoal !== normalized.objective) {
    lines.push(`最近用户目标: ${normalized.latestUserGoal}`);
  }
  if (normalized.contextSummary) lines.push(`长期摘要: ${normalized.contextSummary}`);
  if (normalized.lastAssistantSummary) lines.push(`上一轮结论: ${normalized.lastAssistantSummary}`);
  if (normalized.lastTools.length) lines.push(`最近工具: ${normalized.lastTools.join(', ')}`);
  if (normalized.openItems.length) lines.push(`待注意: ${normalized.openItems.join('；')}`);
  if (normalized.prefixFingerprint) lines.push(`上一轮 prefix: ${normalized.prefixFingerprint}`);
  lines.push('</task_checkpoint>');
  const text = lines.join('\n');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 24)).trim()}\n</task_checkpoint>`;
}

export function normalizeTaskCheckpoint(value) {
  if (!value || typeof value !== 'object') return null;
  const checkpoint = {
    objective: compactCheckpointText(value.objective, 360),
    latestUserGoal: compactCheckpointText(value.latestUserGoal, 420),
    lastAssistantSummary: compactCheckpointText(value.lastAssistantSummary, 520),
    contextSummary: compactCheckpointText(value.contextSummary, 520),
    openItems: normalizeStringList(value.openItems, 6, 320),
    lastTools: normalizeStringList(value.lastTools, 8, 160),
    sourceMessageCount: clampInt(value.sourceMessageCount, 0, 10000, 0),
    updatedAt: compactCheckpointText(value.updatedAt, 80),
    prefixFingerprint: compactCheckpointText(value.prefixFingerprint, 80),
  };
  const hasContent = checkpoint.objective ||
    checkpoint.latestUserGoal ||
    checkpoint.lastAssistantSummary ||
    checkpoint.contextSummary ||
    checkpoint.openItems.length ||
    checkpoint.lastTools.length;
  return hasContent ? checkpoint : null;
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

function extractMemoryTerms(content = '') {
  const cleaned = normalizeContextDirectivesForMemory(stripGeneratedMemoryBlocks(content))
    .replace(/```[\s\S]*?```/g, ' ')
    .toLowerCase();
  const matches = cleaned.match(/[a-z0-9_./-]{3,}|[\u4e00-\u9fa5]{2,}/g) || [];
  const stopWords = new Set([
    '这个', '那个', '一下', '帮我', '请你', '请帮', '怎么', '为什么', '进行', '根据', '优化', '问题',
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'file', 'folder', 'symbol', 'web', 'run',
  ]);
  const terms = [];
  const seen = new Set();
  for (const match of matches) {
    const term = match.trim();
    const candidates = /[\u4e00-\u9fa5]/.test(term)
      ? [term, ...buildChineseSubTerms(term)]
      : [term];
    for (const candidate of candidates) {
      if (candidate.length < 2 || stopWords.has(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      terms.push(candidate);
      if (terms.length >= 12) break;
    }
    if (terms.length >= 12) break;
  }
  return terms;
}

function normalizeContextDirectivesForMemory(content = '') {
  return String(content || '').replace(
    /@(file|folder|symbol)\s*:\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s,，;；)\]]+))/gi,
    (_match, _type, doubleQuoted, singleQuoted, backticked, bare) => ` ${doubleQuoted || singleQuoted || backticked || bare || ''} `,
  );
}

function buildChineseSubTerms(term) {
  const parts = [];
  for (const size of [4, 3, 2]) {
    for (let index = 0; index <= term.length - size; index += 1) {
      parts.push(term.slice(index, index + size));
    }
  }
  return parts;
}

function scoreMemoryCandidate(conversation, message, terms) {
  const title = String(conversation.title || '').toLowerCase();
  const content = normalizeMemoryText(message.content || '');
  let score = 0;
  for (const term of terms) {
    if (content.includes(term)) score += Math.min(6, Math.max(1, term.length / 2));
    if (title.includes(term)) score += 3;
  }
  if (message.favorite) score += 2;
  return score;
}

function getNeighborSnippet(messages, index) {
  const neighbors = [messages[index - 1], messages[index + 1]]
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => `${message.role === 'assistant' ? '助手' : '用户'}: ${compactMemorySnippet(message.content || '', 180)}`)
    .filter(Boolean);
  return neighbors[0] || '';
}

function compactMemorySnippet(content = '', maxLength = 280) {
  const text = stripGeneratedMemoryBlocks(content)
    .replace(/```[\s\S]*?```/g, ' [代码片段] ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

function normalizeMemoryText(content = '') {
  return stripGeneratedMemoryBlocks(content)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripGeneratedMemoryBlocks(content = '') {
  return String(content || '')
    .replace(/<related_memory>[\s\S]*?<\/related_memory>/gi, ' ')
    .replace(/<selected_context>[\s\S]*?<\/selected_context>/gi, ' ')
    .replace(/<task_checkpoint>[\s\S]*?<\/task_checkpoint>/gi, ' ');
}

function findLatestUserIndex(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function compactCheckpointText(value, maxLength) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeStringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const text = compactCheckpointText(item, maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractRecentAgentOpenItems(messages) {
  const items = [];
  for (let i = messages.length - 1; i >= 0 && items.length < 6; i -= 1) {
    const message = messages[i];
    if (message?.error) items.push(`上一轮错误: ${compactMemorySnippet(message.error, 220)}`);
    const stages = Array.isArray(message?.agentStages) ? message.agentStages : [];
    for (let j = stages.length - 1; j >= 0 && items.length < 6; j -= 1) {
      const stage = stages[j];
      const text = stage?.stopReason || stage?.warning;
      if (text) items.push(compactMemorySnippet(text, 240));
    }
  }
  return normalizeStringList(items, 6, 260);
}

function extractRecentToolNames(messages) {
  const names = [];
  for (let i = messages.length - 1; i >= 0 && names.length < 8; i -= 1) {
    const runs = [
      ...(Array.isArray(messages[i]?.toolRuns) ? messages[i].toolRuns : []),
      ...(Array.isArray(messages[i]?.toolCalls) ? messages[i].toolCalls : []),
    ];
    for (let j = runs.length - 1; j >= 0 && names.length < 8; j -= 1) {
      const run = runs[j] || {};
      const name = String(run.name || run.function?.name || '').trim();
      if (!name) continue;
      const status = String(run.status || (run.ok === true ? 'completed' : (run.ok === false ? 'failed' : ''))).trim();
      names.push(status ? `${name}:${status}` : name);
    }
  }
  return normalizeStringList(names, 8, 140);
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
