// @ts-nocheck

const MAX_TOOL_OUTPUT = 12000;

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}\n...` : text;
}

async function webSearch(args, settings) {
  const apiKey = String(settings.tavilyApiKey || '').trim();
  if (!apiKey) throw new Error('请先在设置中配置 Tavily API Key。');

  const queries = normalizeSearchQueries(args);
  if (queries.length === 0) throw new Error('搜索关键词不能为空。');
  const maxPerQuery =
    queries.length > 1
      ? Math.max(1, Math.ceil(clampInt(args.max_results ?? settings.tavilyMaxResults, 1, 10, 5) / queries.length))
      : args.max_results;
  const { buildTavilySearchRequest } = await import('./search-utils.mjs');
  const requests = queries.map((query) => buildTavilySearchRequest(query, settings, maxPerQuery));
  const allResults = [];

  for (const request of requests) {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(request.payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Tavily 搜索失败 (${response.status})：${truncate(text || response.statusText, 300)}`);
    }

    const json = await response.json();
    const results = normalizeTavilyResults(json, request.payload.max_results).map((item) => ({
      ...item,
      query: request.originalQuery,
      normalizedQuery: request.payload.query,
    }));
    allResults.push(...results);
  }

  if (requests.length === 1) return formatTavilyResults(requests[0], allResults);
  return formatTavilySearchPlanResults(
    requests,
    dedupeTavilyResults(allResults, clampInt(args.max_results ?? settings.tavilyMaxResults, 1, 10, 5))
  );
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
    content: String(item.content || item.snippet || '').slice(0, 1000),
    publishedDate: String(item.published_date || item.publishedDate || item.date || '').slice(0, 40),
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
  }));
}

function formatTavilyResults(request, results) {
  if (typeof request === 'string') {
    request = {
      originalQuery: request,
      payload: { query: request, topic: 'general', max_results: results.length || 5 },
      requestedAt: new Date().toISOString().slice(0, 10),
    };
  }
  if (results.length === 0)
    return `没有找到与「${request.originalQuery}」相关的搜索结果。\n实际搜索 query：${request.payload.query}`;
  const lines = [
    `搜索时间：${request.requestedAt}`,
    `用户原始问题：${request.originalQuery}`,
    `实际搜索 query：${request.payload.query}`,
    `Tavily 参数：topic=${request.payload.topic || 'general'}，time_range=${request.payload.time_range || '未限定'}，days=${request.payload.days || '未限定'}，max_results=${request.payload.max_results}`,
    '',
    'Tavily 返回来源：',
  ];
  for (const item of results) {
    lines.push(`${item.index}. ${item.title}`);
    if (item.url) lines.push(`   URL: ${item.url}`);
    if (item.publishedDate) lines.push(`   Published: ${item.publishedDate}`);
    if (item.content) lines.push(`   摘要: ${item.content}`);
    lines.push('');
  }
  return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

function dedupeTavilyResults(results = [], maxResults = 5) {
  const seen = new Set();
  const out = [];
  for (const item of results) {
    const key = String(item.url || item.title || '')
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, index: out.length + 1 });
    if (out.length >= maxResults) break;
  }
  return out;
}

function formatTavilySearchPlanResults(requests, results) {
  const structured = {
    type: 'deepchat.webSearchPlanResults',
    version: 1,
    requestedAt: requests[0]?.requestedAt || new Date().toISOString().slice(0, 10),
    queries: requests.map((request, index) => ({
      index: index + 1,
      originalQuery: request.originalQuery,
      query: request.payload.query,
      topic: request.payload.topic || 'general',
      timeRange: request.payload.time_range || '',
      days: request.payload.days || 0,
      maxResults: request.payload.max_results,
    })),
    results: results.map((item) => ({
      index: item.index,
      query: item.query || '',
      normalizedQuery: item.normalizedQuery || '',
      title: item.title,
      url: item.url,
      content: item.content,
      publishedDate: item.publishedDate,
      score: item.score,
    })),
  };
  if (results.length === 0) {
    return [
      `搜索时间：${structured.requestedAt}`,
      `搜索计划：${requests.length} 个 query`,
      'Structured Search Plan:',
      JSON.stringify(structured, null, 2),
      '没有找到与搜索计划相关的结果。',
    ].join('\n');
  }
  const lines = [
    `搜索时间：${structured.requestedAt}`,
    `搜索计划：${requests.length} 个 query`,
    '',
    '计划 query：',
    ...structured.queries.map((item) => `${item.index}. ${item.originalQuery} -> ${item.query}`),
    '',
    'Structured Search Plan:',
    JSON.stringify(structured, null, 2),
    '',
    'Tavily 返回来源（已按 URL 去重）：',
  ];
  for (const item of results) {
    lines.push(`${item.index}. ${item.title}`);
    if (item.query) lines.push(`   Query: ${item.query}`);
    if (item.url) lines.push(`   URL: ${item.url}`);
    if (item.publishedDate) lines.push(`   Published: ${item.publishedDate}`);
    if (item.content) lines.push(`   摘要: ${item.content}`);
    lines.push('');
  }
  return lines.join('\n').slice(0, MAX_TOOL_OUTPUT);
}

module.exports = {
  webSearch,
  normalizeSearchQueries,
  normalizeTavilyResults,
  formatTavilyResults,
};
