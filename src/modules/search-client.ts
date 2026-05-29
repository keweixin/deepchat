/**
 * Search client — Tavily search in browser mode.
 */

import { buildTavilySearchRequest } from '../../electron/search-utils.mjs';
import { getSettings } from './settings-core.js';
import { hasNativeBridge } from './bridge.ts';

export interface TavilySearchRequest {
  originalQuery: string;
  payload: {
    query: string;
    max_results: number;
    search_depth: string;
    include_answer: boolean;
    include_raw_content: boolean;
    topic?: string;
    time_range?: string;
    days?: number;
  };
  freshness: { timeRange: string; days: number } | null;
  requestedAt: string;
}

export interface TavilySearchResult {
  index: number;
  title: string;
  url: string;
  content: string;
  publishedDate: string;
  score: number | null;
}

export async function requestTavilySearch(
  query: string,
  settings: Record<string, unknown>,
  maxResults = (settings.tavilyMaxResults as number) || 5
): Promise<{ response: Response; request: TavilySearchRequest }> {
  const request = buildTavilySearchRequest(query, settings, maxResults) as TavilySearchRequest;
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.tavilyApiKey}`,
    },
    body: JSON.stringify(request.payload),
  });
  return { response, request };
}

export async function browserWebSearch(
  query: string,
  settings: Record<string, unknown>
): Promise<{ request: TavilySearchRequest; results: TavilySearchResult[]; output: string }> {
  let result: { response: Response; request: TavilySearchRequest };
  try {
    result = await requestTavilySearch(query, settings);
  } catch (error: any) {
    throw new Error(
      `浏览器联网检索失败：${error.message || '网络请求被拦截'}。如果浏览器阻止跨域请求，请使用桌面版运行。`
    );
  }
  const { response, request } = result;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Tavily 搜索失败 (${response.status})${text ? `：${text.slice(0, 240)}` : ''}`);
  }
  const json = await response.json();
  const results = normalizeBrowserTavilyResults(json, request.payload.max_results);
  return {
    request,
    results,
    output: formatBrowserSearchResults(request, results),
  };
}

export function normalizeBrowserTavilyResults(
  payload: Record<string, unknown>,
  maxResults: number
): TavilySearchResult[] {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return (results as any[]).slice(0, maxResults).map((item, index) => ({
    index: index + 1,
    title: String(item.title || item.url || `Result ${index + 1}`).slice(0, 200),
    url: String(item.url || ''),
    content: String(item.content || item.snippet || '').slice(0, 1000),
    publishedDate: String(item.published_date || item.publishedDate || item.date || '').slice(0, 40),
    score: typeof item.score === 'number' ? item.score : null,
  }));
}

export function formatBrowserSearchResults(request: TavilySearchRequest, results: TavilySearchResult[]): string {
  if (results.length === 0)
    return `没有找到与「${request.originalQuery}」相关的搜索结果。\n实际搜索 query：${request.payload.query}`;
  const meta = [
    `搜索时间：${request.requestedAt}`,
    `用户原始问题：${request.originalQuery}`,
    `实际搜索 query：${request.payload.query}`,
    `Tavily 参数：topic=${request.payload.topic || 'general'}，time_range=${request.payload.time_range || '未限定'}，days=${request.payload.days || '未限定'}，max_results=${request.payload.max_results}`,
  ];
  const lines = [...meta, '', 'Tavily 返回来源：'];
  for (const item of results) {
    lines.push(`${item.index}. ${item.title}`);
    if (item.url) lines.push(`   URL: ${item.url}`);
    if (item.publishedDate) lines.push(`   Published: ${item.publishedDate}`);
    if (item.content) lines.push(`   摘要: ${item.content}`);
    lines.push('');
  }
  return lines.join('\n').slice(0, 12000);
}
