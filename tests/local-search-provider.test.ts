import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  formatLocalSearchResults,
  parseDuckDuckGoHtml,
  runLocalDuckDuckGoSearch,
} from '../electron/local-search-provider.js';

describe('local DuckDuckGo HTML search fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses DuckDuckGo HTML into sanitized sourced results', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fx%3D1">DeepChat &amp; Docs</a>
        <a class="result__snippet">Alpha <b>snippet</b> &amp; context.</a>
      </div>
    `;

    expect(parseDuckDuckGoHtml(html, 5)).toEqual([
      {
        index: 1,
        title: 'DeepChat & Docs',
        url: 'https://example.com/docs?x=1',
        content: 'Alpha snippet & context.',
      },
    ]);
  });

  it('uses cache and formats provider/fallback metadata without raw HTML', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => `
        <a class="result__a" href="https://example.com/a">Result A</a>
        <a class="result__snippet">Search summary A.</a>
      `,
    });
    vi.stubGlobal('fetch', fetchMock);

    const options = { maxResults: 1, cacheTtlMinutes: 10, fallbackReason: 'missing_tavily_key' };
    const first = await runLocalDuckDuckGoSearch('deepchat local fallback unique test', options);
    const second = await runLocalDuckDuckGoSearch('deepchat local fallback unique test', options);
    const output = formatLocalSearchResults(second, 'missing_tavily_key');

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(output).toContain('Fallback provider：local_duckduckgo_html');
    expect(output).toContain('"experimental": true');
    expect(output).toContain('missing_tavily_key');
    expect(output).not.toContain('result__a');
  });
});
