const MAX_LOCAL_RESULTS = 10;
const LOCAL_SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const localSearchCache = new Map();

async function runLocalDuckDuckGoSearch(query, options = {}, signal) {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) throw new Error('本地搜索 query 不能为空。');
  const maxResults = clampInt(options.maxResults, 1, MAX_LOCAL_RESULTS, 5);
  const ttlMs = Math.max(0, Number(options.cacheTtlMinutes || 0)) * 60 * 1000;
  const cacheKey = `${normalizedQuery.toLowerCase()}:${maxResults}`;
  const cached = readCache(cacheKey, ttlMs);
  if (cached) return { ...cached, cacheHit: true };

  const url = `${LOCAL_SEARCH_ENDPOINT}?q=${encodeURIComponent(normalizedQuery)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal,
  });
  if (!response.ok) throw new Error(`本地搜索兜底请求失败 (${response.status})：${response.statusText}`);
  const html = await response.text();
  const value = {
    provider: 'local_duckduckgo_html',
    experimental: true,
    query: normalizedQuery,
    cacheHit: false,
    results: parseDuckDuckGoHtml(html, maxResults),
  };
  writeCache(cacheKey, value, ttlMs);
  return value;
}

function parseDuckDuckGoHtml(html, maxResults = 5) {
  const text = String(html || '');
  const blocks = text.split(/<div[^>]+class=["'][^"']*\bresult\b[^"']*["'][^>]*>/i).slice(1);
  if (blocks.length === 0 && /\bresult__a\b/i.test(text)) blocks.push(text);
  const results = [];
  for (const block of blocks) {
    const titleMatch =
      block.match(/<a[^>]+class=["'][^"']*\bresult__a\b[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<a[^>]+href=["']([^"']+)["'][^>]*class=["'][^"']*\bresult__a\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;
    const url = decodeDuckDuckGoUrl(titleMatch[1]);
    const title = cleanHtml(titleMatch[2]).slice(0, 220);
    const snippetMatch = block.match(
      /<(?:a|div)[^>]+class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i
    );
    const snippet = snippetMatch ? cleanHtml(snippetMatch[1]).slice(0, 1200) : '';
    if (!title || !/^https?:\/\//i.test(url)) continue;
    results.push({ index: results.length + 1, title, url, content: snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function formatLocalSearchResults(payload, fallbackReason = '') {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const structured = {
    type: 'deepchat.webSearchPlanResults',
    version: 2,
    provider: 'local_duckduckgo_html',
    experimental: true,
    fallbackReason,
    telemetry: {
      provider: 'local_duckduckgo_html',
      experimental: true,
      cache: { hits: payload?.cacheHit ? 1 : 0, misses: payload?.cacheHit ? 0 : 1 },
      warnings: ['本地 DuckDuckGo HTML 搜索是实验性兜底，不等同于官方搜索 API。'],
    },
    queries: [
      {
        index: 1,
        originalQuery: payload?.query || '',
        query: payload?.query || '',
        maxResults: results.length,
      },
    ],
    results: results.map((item, index) => ({
      index: index + 1,
      title: item.title,
      url: item.url,
      content: item.content,
      provider: 'local_duckduckgo_html',
    })),
    extraction: null,
  };
  const lines = [
    `搜索时间：${new Date().toISOString().slice(0, 10)}`,
    `用户原始问题：${payload?.query || ''}`,
    `实际搜索 query：${payload?.query || ''}`,
    'Fallback provider：local_duckduckgo_html',
    'Fallback experimental：true',
    fallbackReason ? `Fallback reason：${fallbackReason}` : '',
    `缓存：${payload?.cacheHit ? 1 : 0} 命中 / ${payload?.cacheHit ? 0 : 1} 未命中`,
    '',
    'Structured Search:',
    JSON.stringify(structured, null, 2),
    '',
    '本地搜索返回来源：',
  ].filter(Boolean);
  for (const item of results) {
    lines.push(`${item.index}. ${item.title}`);
    lines.push(`   URL: ${item.url}`);
    if (item.content) lines.push(`   摘要: ${item.content}`);
    lines.push('');
  }
  if (results.length === 0) lines.push('本地搜索没有解析到可用结果，请配置 Tavily API Key 或换用更具体 query。');
  return lines.join('\n');
}

function decodeDuckDuckGoUrl(value) {
  const raw = decodeHtmlEntities(String(value || ''));
  try {
    const parsed = new URL(raw, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return parsed.href;
  } catch {
    return raw;
  }
}

function cleanHtml(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function readCache(key, ttlMs) {
  if (ttlMs <= 0) return null;
  const cached = localSearchCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > ttlMs) {
    localSearchCache.delete(key);
    return null;
  }
  return cached.value;
}

function writeCache(key, value, ttlMs) {
  if (ttlMs <= 0) return;
  localSearchCache.set(key, { timestamp: Date.now(), value });
  if (localSearchCache.size > 50) {
    const oldest = [...localSearchCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp).slice(0, 10);
    for (const [oldKey] of oldest) localSearchCache.delete(oldKey);
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

module.exports = {
  runLocalDuckDuckGoSearch,
  parseDuckDuckGoHtml,
  formatLocalSearchResults,
};
