const MAX_TOOL_OUTPUT = 12000;
const MAX_RESULT_CONTENT = 1200;
const MAX_RAW_CONTENT = 3000;
const MAX_EXTRACT_CONTENT = 2200;
const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';
const { runLocalDuckDuckGoSearch, formatLocalSearchResults } = require('./local-search-provider.js');
const { searchDocsets, formatDocsetSearchResults } = require('./docset-search.js');

const tavilyCache = new Map();

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

async function webSearch(args, settings, signal) {
  const apiKey = String(settings.tavilyApiKey || '').trim();
  const queries = normalizeSearchQueries(args);
  if (queries.length === 0) throw new Error('搜索关键词不能为空。');

  if (!apiKey) {
    if (shouldUseMissingKeyFallback(settings)) {
      return runFallbackSearch(queries, args, settings, signal, 'missing_tavily_key');
    }
    throw new Error('请先在设置中配置 Tavily API Key，或在设置中开启本地实验性搜索兜底。');
  }

  try {
    return await runTavilyWebSearch(apiKey, queries, args, settings, signal);
  } catch (error) {
    if (!shouldFallbackOnProviderError(settings)) throw error;
    return runFallbackSearch(queries, args, settings, signal, `tavily_error:${truncate(error?.message || error, 180)}`);
  }
}

async function runTavilyWebSearch(apiKey, queries, args, settings, signal) {
  const { buildTavilySearchRequest } = await import('./search-utils.mjs');
  const maxPerQuery =
    queries.length > 1
      ? Math.max(1, Math.ceil(clampInt(args.max_results ?? settings.tavilyMaxResults, 1, 10, 5) / queries.length))
      : args.max_results;
  const requests = queries.map((query) => buildTavilySearchRequest(query, settings, maxPerQuery, args));

  const searchResponses = await Promise.all(requests.map((request) => runTavilySearch(apiKey, request, signal)));
  const allResults = [];
  for (let index = 0; index < searchResponses.length; index++) {
    const request = requests[index];
    const response = searchResponses[index];
    const results = normalizeTavilyResults(response.json, request.payload.max_results).map((item) => ({
      ...item,
      query: request.originalQuery,
      normalizedQuery: request.payload.query,
    }));
    allResults.push(...results);
  }

  const maxResults = clampInt(args.max_results ?? settings.tavilyMaxResults, 1, 10, 5);
  const deduped = dedupeTavilyResults(allResults, maxResults);
  const extraction = await maybeExtractTavilyResults(apiKey, requests[0], deduped, signal);
  const metadata = buildSearchMetadata(requests, searchResponses, extraction);

  if (requests.length === 1) return formatTavilyResults(requests[0], deduped, metadata, extraction);
  return formatTavilySearchPlanResults(requests, deduped, metadata, extraction);
}

async function runFallbackSearch(queries, args, settings, signal, fallbackReason) {
  const maxResults = clampInt(args.max_results ?? settings.tavilyMaxResults, 1, 10, 5);
  const docsetEnabled = settings.docsetSearchEnabled === true && Array.isArray(settings.docsetRoots);
  if (docsetEnabled) {
    const docsetPayload = searchDocsets(queries[0], settings, { maxResults, fallbackReason });
    if (docsetPayload.results.length > 0 || settings.localSearchFallbackMode === 'off') {
      return formatDocsetSearchResults(docsetPayload, fallbackReason);
    }
  }

  if (settings.localSearchFallbackMode === 'off') {
    return formatFallbackUnavailable(queries, fallbackReason, '本地 HTML 搜索兜底已关闭，且离线 Docset 没有命中。');
  }

  try {
    const localPayload = await runLocalDuckDuckGoSearch(
      queries[0],
      {
        maxResults,
        timeoutMs: clampInt(args.timeoutMs ?? args.timeout_ms, 3000, 30000, 10000),
        cacheTtlMinutes: settings.tavilyCacheTtlMinutes,
        fallbackReason,
      },
      signal
    );
    return formatLocalSearchResults(localPayload, fallbackReason);
  } catch (error) {
    return formatFallbackUnavailable(
      queries,
      fallbackReason,
      `实验性本地 HTML 搜索不可用：${truncate(error?.message || error, 300)}`
    );
  }
}

function shouldUseMissingKeyFallback(settings) {
  if (settings.docsetSearchEnabled === true) return true;
  return String(settings.localSearchFallbackMode || '') === 'missing_key';
}

function shouldFallbackOnProviderError(settings) {
  return settings.fallbackOnSearchError === true || String(settings.localSearchFallbackMode || '') === 'provider_error';
}

function formatFallbackUnavailable(queries, fallbackReason, message) {
  const structured = {
    type: 'deepchat.webSearchPlanResults',
    version: 2,
    provider: 'deepchat_fallback_unavailable',
    experimental: true,
    requestedAt: new Date().toISOString().slice(0, 10),
    fallbackReason,
    telemetry: {
      provider: 'deepchat_fallback_unavailable',
      fallbackReason,
      warnings: [message],
      cache: { hits: 0, misses: 0 },
    },
    queries: queries.map((query, index) => ({
      index: index + 1,
      originalQuery: query,
      query,
      maxResults: 0,
    })),
    results: [],
  };
  return [
    `搜索时间：${structured.requestedAt}`,
    `Fallback provider：deepchat_fallback_unavailable`,
    `Fallback reason：${fallbackReason}`,
    message,
    '',
    'Structured Search:',
    JSON.stringify(structured, null, 2),
  ]
    .join('\n')
    .slice(0, MAX_TOOL_OUTPUT);
}

async function runTavilySearch(apiKey, request, signal) {
  const ttlMs = Math.max(0, Number(request.options?.cacheTtlMinutes || 0)) * 60 * 1000;
  const cacheKey = makeCacheKey('search', request.payload);
  const cached = readCache(cacheKey, ttlMs);
  if (cached) return { json: cached, cached: true, cacheKey };

  const response = await fetch(TAVILY_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(request.payload),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Tavily 搜索失败 (${response.status})：${truncate(text || response.statusText, 300)}`);
  }

  const json = await response.json();
  writeCache(cacheKey, json, ttlMs);
  return { json, cached: false, cacheKey };
}

async function maybeExtractTavilyResults(apiKey, request, results, signal) {
  const options = request.options || {};
  const count = clampInt(options.extractTopResults, 0, 5, 0);
  if (count <= 0 || results.length === 0) return null;

  const urls = results
    .map((item) => item.url)
    .filter(Boolean)
    .slice(0, count);
  if (urls.length === 0) return null;

  const payload = {
    urls,
    query: request.payload.query,
    extract_depth: 'basic',
    format: 'markdown',
    chunks_per_source: clampInt(options.chunksPerSource, 1, 5, 3),
    include_usage: true,
    include_favicon: true,
  };
  const ttlMs = Math.max(0, Number(options.cacheTtlMinutes || 0)) * 60 * 1000;
  const cacheKey = makeCacheKey('extract', payload);
  const cached = readCache(cacheKey, ttlMs);
  if (cached) return normalizeTavilyExtraction(cached, { cached: true, cacheKey, payload });

  const response = await fetch(TAVILY_EXTRACT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      cached: false,
      cacheKey,
      payload,
      error: `Tavily 抽取失败 (${response.status})：${truncate(text || response.statusText, 240)}`,
      results: [],
      failedResults: urls.map((url) => ({ url, error: response.statusText || String(response.status) })),
    };
  }

  const json = await response.json();
  writeCache(cacheKey, json, ttlMs);
  return normalizeTavilyExtraction(json, { cached: false, cacheKey, payload });
}

function normalizeTavilyExtraction(payload, meta = {}) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const failed = Array.isArray(payload?.failed_results) ? payload.failed_results : [];
  return {
    cached: meta.cached === true,
    cacheKey: meta.cacheKey || '',
    payload: meta.payload || {},
    requestId: String(payload?.request_id || payload?.requestId || ''),
    responseTime: typeof payload?.response_time === 'number' ? payload.response_time : null,
    usageCredits: Number.isFinite(Number(payload?.usage?.credits)) ? Number(payload.usage.credits) : null,
    results: results.map((item) => ({
      url: String(item.url || ''),
      title: String(item.title || item.url || '').slice(0, 200),
      content: truncate(cleanText(item.raw_content || item.content || item.text || ''), MAX_EXTRACT_CONTENT),
      favicon: String(item.favicon || ''),
    })),
    failedResults: failed.map((item) => ({
      url: String(item.url || ''),
      error: String(item.error || item.message || 'extract failed').slice(0, 300),
    })),
    error: meta.error || '',
  };
}

function normalizeSearchQueries(args = {}) {
  const values = [];
  if (Array.isArray(args.queries)) values.push(...args.queries);
  if (args.query !== undefined) values.unshift(args.query);
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeTavilyResults(payload, maxResults = 5) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results.slice(0, maxResults).map((item, index) => ({
    index: index + 1,
    title: String(item.title || item.url || `Result ${index + 1}`).slice(0, 200),
    url: String(item.url || ''),
    content: truncate(cleanText(item.content || item.snippet || ''), MAX_RESULT_CONTENT),
    rawContent: truncate(cleanText(item.raw_content || item.rawContent || ''), MAX_RAW_CONTENT),
    publishedDate: String(item.published_date || item.publishedDate || item.date || '').slice(0, 40),
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
    favicon: String(item.favicon || ''),
  }));
}

function formatTavilyResults(request, results, metadata = {}, extraction = null) {
  if (typeof request === 'string') {
    request = {
      originalQuery: request,
      payload: { query: request, topic: 'general', max_results: results.length || 5, search_depth: 'basic' },
      requestedAt: new Date().toISOString().slice(0, 10),
      options: {},
    };
  }
  if (results.length === 0) {
    return [
      `搜索时间：${request.requestedAt}`,
      `用户原始问题：${request.originalQuery}`,
      `实际搜索 query：${request.payload.query}`,
      formatTavilyTelemetry(metadata),
      `没有找到与「${request.originalQuery}」相关的搜索结果。`,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_TOOL_OUTPUT);
  }

  const structured = buildStructuredSearchPayload([request], results, metadata, extraction);
  const lines = [
    `搜索时间：${request.requestedAt}`,
    `用户原始问题：${request.originalQuery}`,
    `实际搜索 query：${request.payload.query}`,
    formatTavilyRequestLine(request),
    formatTavilyTelemetry(metadata),
    '',
    'Structured Search:',
    JSON.stringify(structured, null, 2),
    '',
    'Tavily 返回来源：',
  ].filter(Boolean);
  appendFormattedResults(lines, results, extraction);
  return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function dedupeTavilyResults(results = [], maxResults = 5) {
  const seen = new Set();
  const out = [];
  for (const item of results) {
    const key =
      normalizeUrlKey(item.url) ||
      String(item.title || '')
        .trim()
        .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, index: out.length + 1 });
    if (out.length >= maxResults) break;
  }
  return out;
}

function formatTavilySearchPlanResults(requests, results, metadata = {}, extraction = null) {
  const structured = buildStructuredSearchPayload(requests, results, metadata, extraction);
  if (results.length === 0) {
    return [
      `搜索时间：${structured.requestedAt}`,
      `搜索计划：${requests.length} 个 query`,
      formatTavilyTelemetry(metadata),
      'Structured Search Plan:',
      JSON.stringify(structured, null, 2),
      '没有找到与搜索计划相关的结果。',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_TOOL_OUTPUT);
  }
  const lines = [
    `搜索时间：${structured.requestedAt}`,
    `搜索计划：${requests.length} 个 query`,
    formatTavilyTelemetry(metadata),
    '',
    '计划 query：',
    ...structured.queries.map((item) => `${item.index}. ${item.originalQuery} -> ${item.query}`),
    '',
    'Structured Search Plan:',
    JSON.stringify(structured, null, 2),
    '',
    'Tavily 返回来源（已按 URL 去重）：',
  ].filter(Boolean);
  appendFormattedResults(lines, results, extraction);
  return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function buildStructuredSearchPayload(requests, results, metadata, extraction) {
  return {
    type: 'deepchat.webSearchPlanResults',
    version: 2,
    provider: 'tavily',
    requestedAt: requests[0]?.requestedAt || new Date().toISOString().slice(0, 10),
    telemetry: metadata,
    queries: requests.map((request, index) => ({
      index: index + 1,
      originalQuery: request.originalQuery,
      query: request.payload.query,
      topic: request.payload.topic || 'general',
      timeRange: request.payload.time_range || '',
      days: request.payload.days || 0,
      maxResults: request.payload.max_results,
      searchDepth: request.payload.search_depth || 'basic',
      includeRawContent: Boolean(request.payload.include_raw_content),
      includeAnswer: Boolean(request.payload.include_answer),
      includeDomains: request.payload.include_domains || [],
      excludeDomains: request.payload.exclude_domains || [],
    })),
    results: results.map((item) => ({
      index: item.index,
      query: item.query || '',
      normalizedQuery: item.normalizedQuery || '',
      title: item.title,
      url: item.url,
      content: item.content,
      rawContent: item.rawContent,
      publishedDate: item.publishedDate,
      score: item.score,
      favicon: item.favicon,
    })),
    extraction: extraction
      ? {
          cached: extraction.cached === true,
          requestId: extraction.requestId || '',
          responseTime: extraction.responseTime,
          usageCredits: extraction.usageCredits,
          error: extraction.error || '',
          failedResults: extraction.failedResults || [],
          results: extraction.results || [],
        }
      : null,
  };
}

function buildSearchMetadata(requests, responses, extraction) {
  const searchCredits = responses
    .map((response) => Number(response.json?.usage?.credits))
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
  const cacheHits = responses.filter((response) => response.cached).length + (extraction?.cached ? 1 : 0);
  const cacheMisses = responses.length + (extraction ? 1 : 0) - cacheHits;
  return {
    provider: 'tavily',
    cache: {
      hits: cacheHits,
      misses: cacheMisses,
      ttlMinutes: requests[0]?.options?.cacheTtlMinutes ?? 10,
    },
    search: responses.map((response, index) => ({
      query: requests[index]?.payload?.query || '',
      cached: response.cached === true,
      requestId: String(response.json?.request_id || response.json?.requestId || ''),
      responseTime: typeof response.json?.response_time === 'number' ? response.json.response_time : null,
      usageCredits: Number.isFinite(Number(response.json?.usage?.credits)) ? Number(response.json.usage.credits) : null,
    })),
    extraction: extraction
      ? {
          enabled: true,
          cached: extraction.cached === true,
          requestedUrls: extraction.payload?.urls || [],
          chunksPerSource: extraction.payload?.chunks_per_source || 0,
          requestId: extraction.requestId || '',
          responseTime: extraction.responseTime,
          usageCredits: extraction.usageCredits,
          error: extraction.error || '',
        }
      : { enabled: false },
    usageCredits:
      searchCredits + (Number.isFinite(Number(extraction?.usageCredits)) ? Number(extraction.usageCredits) : 0),
  };
}

function formatTavilyRequestLine(request) {
  return [
    `Tavily 参数：topic=${request.payload.topic || 'general'}`,
    `time_range=${request.payload.time_range || '未限定'}`,
    `days=${request.payload.days || '未限定'}`,
    `max_results=${request.payload.max_results}`,
    `search_depth=${request.payload.search_depth || 'basic'}`,
    `raw=${request.payload.include_raw_content ? 'on' : 'off'}`,
  ].join('，');
}

function formatTavilyTelemetry(metadata) {
  if (!metadata || !metadata.provider) return '';
  const cache = metadata.cache || {};
  const search = Array.isArray(metadata.search) ? metadata.search : [];
  const requestIds = search.map((item) => item.requestId).filter(Boolean);
  const responseTimes = search.map((item) => item.responseTime).filter((value) => typeof value === 'number');
  const parts = [
    `Tavily provider：${metadata.provider}`,
    `缓存：${cache.hits || 0} 命中 / ${cache.misses || 0} 未命中，TTL ${cache.ttlMinutes ?? 10} 分钟`,
  ];
  if (metadata.usageCredits) parts.push(`credits≈${metadata.usageCredits}`);
  if (requestIds.length) parts.push(`request_id=${requestIds.join(',')}`);
  if (responseTimes.length) parts.push(`response_time=${responseTimes.join(',')}s`);
  if (metadata.extraction?.enabled) {
    parts.push(
      `抽取：${metadata.extraction.cached ? '缓存命中' : '已请求'}，chunks/source=${metadata.extraction.chunksPerSource || 0}`
    );
  }
  if (metadata.extraction?.error) parts.push(`抽取警告：${metadata.extraction.error}`);
  return parts.join('\n');
}

function appendFormattedResults(lines, results, extraction) {
  const extractedByUrl = new Map();
  for (const item of extraction?.results || []) {
    const key = normalizeUrlKey(item.url);
    if (key) extractedByUrl.set(key, item);
  }
  for (const item of results) {
    lines.push(`${item.index}. ${item.title}`);
    if (item.query) lines.push(`   Query: ${item.query}`);
    if (item.url) lines.push(`   URL: ${item.url}`);
    if (item.publishedDate) lines.push(`   Published: ${item.publishedDate}`);
    if (item.score !== null) lines.push(`   Score: ${item.score}`);
    if (item.content) lines.push(`   摘要: ${item.content}`);
    if (item.rawContent) lines.push(`   原文片段: ${item.rawContent}`);
    const extracted = extractedByUrl.get(normalizeUrlKey(item.url));
    if (extracted?.content) lines.push(`   抽取片段: ${extracted.content}`);
    lines.push('');
  }
}

function readCache(key, ttlMs) {
  if (ttlMs <= 0) return null;
  const item = tavilyCache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > ttlMs) {
    tavilyCache.delete(key);
    return null;
  }
  return item.value;
}

function writeCache(key, value, ttlMs) {
  if (ttlMs <= 0) return;
  tavilyCache.set(key, { timestamp: Date.now(), value });
  if (tavilyCache.size > 100) {
    const oldest = [...tavilyCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp).slice(0, 20);
    for (const [oldKey] of oldest) tavilyCache.delete(oldKey);
  }
}

function makeCacheKey(endpoint, payload) {
  return `${endpoint}:${stableJson(payload)}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeUrlKey(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    parsed.hash = '';
    parsed.searchParams.sort();
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return text.replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
  }
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  webSearch,
  normalizeSearchQueries,
  normalizeTavilyResults,
  formatTavilyResults,
  dedupeTavilyResults,
  normalizeTavilyExtraction,
};
