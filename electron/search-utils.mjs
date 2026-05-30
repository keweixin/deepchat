/**
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripExplicitToolDirectives(text) {
  return String(text || '').replace(/(^|[\s([，,;；])@(web|search|run|code|changed|recent|mcp)\s*:?\s*/gi, '$1');
}

/**
 * @param {string} query
 * @returns {string}
 */
export function normalizeSearchQuery(query) {
  const trimmed = String(query || '').trim();
  const compact = stripExplicitToolDirectives(trimmed)
    .replace(/[，。！？?]/g, ' ')
    .replace(/帮我|请|麻烦|一下|搜索|搜一下|查找|查询|查一下|给我|告诉我/g, ' ')
    .replace(/一个就行|一条就行|一篇就行|就行|即可/g, ' ')
    .replace(/["'`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/ai|人工智能/i.test(compact) && /新闻|news|最新|today|recent|latest/i.test(compact)) {
    return `latest AI news ${new Date().toISOString().slice(0, 10)}`;
  }
  return compact || trimmed || 'latest news';
}

/**
 * @param {string} query
 * @param {number} requested
 * @returns {number}
 */
export function deriveSearchMaxResults(query, requested) {
  if (/一个|一条|一篇|\b1\b|one/i.test(String(query || ''))) return 1;
  return clampInt(requested, 1, 10, 5);
}

/**
 * @param {string} query
 * @returns {{ timeRange: string; days: number } | null}
 */
export function getFreshnessWindow(query) {
  const text = String(query || '');
  if (!/最新|新闻|今日|今天|实时|刚刚|本周|recent|latest|news|today|current/i.test(text)) return null;
  if (/今日|今天|today|刚刚/i.test(text)) return { timeRange: 'day', days: 1 };
  return { timeRange: 'week', days: 7 };
}

/**
 * @param {string} rawQuery
 * @param {{ tavilyMaxResults?: number }} [settings]
 * @param {number} [explicitMaxResults]
 * @returns {{
 *   originalQuery: string;
 *   payload: {
 *     query: string;
 *     max_results: number;
 *     search_depth: string;
 *     include_answer: boolean;
 *     include_raw_content: boolean;
 *     topic?: string;
 *     time_range?: string;
 *     days?: number;
 *   };
 *   freshness: { timeRange: string; days: number } | null;
 *   requestedAt: string;
 * }}
 */
export function buildTavilySearchRequest(rawQuery, settings = {}, explicitMaxResults) {
  const originalQuery = String(rawQuery || '').trim();
  const cleanedQuery = normalizeSearchQuery(originalQuery);
  const maxResults = deriveSearchMaxResults(originalQuery, explicitMaxResults ?? settings.tavilyMaxResults ?? 5);
  const freshness = getFreshnessWindow(originalQuery);
  /** @type {{ query: string; max_results: number; search_depth: string; include_answer: boolean; include_raw_content: boolean; topic?: string; time_range?: string; days?: number }} */
  const payload = {
    query: cleanedQuery,
    max_results: maxResults,
    search_depth: 'basic',
    include_answer: false,
    include_raw_content: false,
  };

  if (freshness) {
    payload.topic = 'news';
    payload.time_range = freshness.timeRange;
    payload.days = freshness.days;
  }

  return {
    originalQuery,
    payload,
    freshness,
    requestedAt: new Date().toISOString().slice(0, 10),
  };
}
