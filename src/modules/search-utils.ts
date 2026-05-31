function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function normalizeEnum(value: unknown, allowed: string[], fallback = '') {
  const text = String(value || '').trim();
  return allowed.includes(text) ? text : fallback;
}

function stripExplicitToolDirectives(text: unknown) {
  return String(text || '').replace(/(^|[\s([，,;；])@(web|search|run|code|changed|recent|mcp)\s*:?\s*/gi, '$1');
}

export function normalizeSearchQuery(query: unknown) {
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

export function deriveSearchMaxResults(query: unknown, requested: unknown) {
  if (/一个|一条|一篇|\b1\b|one/i.test(String(query || ''))) return 1;
  return clampInt(requested, 1, 10, 5);
}

export function getFreshnessWindow(query: unknown) {
  const text = String(query || '');
  if (!/最新|新闻|今日|今天|实时|刚刚|本周|recent|latest|news|today|current/i.test(text)) return null;
  if (/今日|今天|today|刚刚/i.test(text)) return { timeRange: 'day', days: 1 };
  return { timeRange: 'week', days: 7 };
}

export function normalizeDomainFilters(value: unknown, maxItems = 20): string[] {
  const input = Array.isArray(value)
    ? value
    : String(value || '')
        .split(/[,，\s]+/)
        .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    const domain = String(item || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
    if (!domain || seen.has(domain)) continue;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) && !/^[a-z0-9.-]+\/.+/i.test(domain)) continue;
    seen.add(domain);
    out.push(domain);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function resolveTavilyOptions(settings: Record<string, any> = {}, args: Record<string, any> = {}) {
  const includeRawContent =
    args.include_raw_content !== undefined
      ? args.include_raw_content === true || args.include_raw_content === 'true'
      : settings.tavilyIncludeRawContent === true || settings.tavilyIncludeRawContent === 'true';
  const includeAnswer =
    args.include_answer !== undefined
      ? args.include_answer === true || args.include_answer === 'true'
      : settings.tavilyIncludeAnswer === true || settings.tavilyIncludeAnswer === 'true';
  return {
    searchDepth: normalizeEnum(
      args.search_depth ?? settings.tavilySearchDepth,
      ['ultra-fast', 'fast', 'basic', 'advanced'],
      'basic'
    ),
    topic: normalizeEnum(args.topic, ['general', 'news', 'finance'], ''),
    timeRange: normalizeEnum(args.time_range, ['day', 'week', 'month', 'year'], ''),
    includeRawContent,
    includeAnswer,
    includeFavicon: true,
    includeDomains: normalizeDomainFilters(args.include_domains ?? settings.tavilyIncludeDomains, 20),
    excludeDomains: normalizeDomainFilters(args.exclude_domains ?? settings.tavilyExcludeDomains, 20),
    extractTopResults: clampInt(args.extract_top_results ?? settings.tavilyExtractTopResults, 0, 5, 0),
    chunksPerSource: clampInt(args.chunks_per_source ?? settings.tavilyChunksPerSource, 1, 5, 3),
    cacheTtlMinutes: clampInt(settings.tavilyCacheTtlMinutes, 0, 1440, 10),
  };
}

export function buildTavilySearchRequest(
  rawQuery: string,
  settings: Record<string, any> = {},
  explicitMaxResults?: number,
  args: Record<string, any> = {}
) {
  const originalQuery = String(rawQuery || '').trim();
  const cleanedQuery = normalizeSearchQuery(originalQuery);
  const maxResults = deriveSearchMaxResults(originalQuery, explicitMaxResults ?? settings.tavilyMaxResults);
  const freshness = getFreshnessWindow(originalQuery);
  const options = resolveTavilyOptions(settings, args);
  const payload: Record<string, any> = {
    query: cleanedQuery,
    max_results: maxResults,
    search_depth: options.searchDepth,
    include_answer: options.includeAnswer,
    include_raw_content: options.includeRawContent ? 'markdown' : false,
    include_favicon: options.includeFavicon,
    include_usage: true,
  };
  if (options.searchDepth === 'advanced') payload.chunks_per_source = Math.min(options.chunksPerSource, 3);

  if (options.topic) {
    payload.topic = options.topic;
  } else if (freshness) {
    payload.topic = 'news';
  }
  if (options.timeRange) {
    payload.time_range = options.timeRange;
  } else if (freshness) {
    payload.time_range = freshness.timeRange;
    payload.days = freshness.days;
  }
  if (payload.time_range === 'day') payload.days = 1;
  if (payload.time_range === 'week' && freshness?.timeRange === 'week') payload.days = freshness.days;
  if (options.includeDomains.length) payload.include_domains = options.includeDomains;
  if (options.excludeDomains.length) payload.exclude_domains = options.excludeDomains;

  return {
    originalQuery,
    payload,
    freshness,
    options,
    requestedAt: new Date().toISOString().slice(0, 10),
  };
}
