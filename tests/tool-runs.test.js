import { describe, expect, it } from 'vitest';
import {
  applyToolDecision,
  applyToolResult,
  buildToolEvidencePayload,
  buildToolRuns,
  createToolRecord,
  getSearchGrounding,
  hasSearchWithoutCitedSource,
} from '../src/modules/tool-runs.js';

describe('tool run state', () => {
  it('records approval, denial, results, duration, and output preview', () => {
    const requestedAt = new Date('2026-05-19T00:00:00.000Z');
    const completedAt = new Date('2026-05-19T00:00:01.250Z');
    const tool = createToolRecord({
      toolCallId: 't1',
      name: 'read_file',
      args: { path: 'README.md' },
      risk: '读取文件',
    }, requestedAt);

    expect(tool).toMatchObject({ id: 't1', status: 'pending', name: 'read_file' });
    applyToolDecision(tool, true, requestedAt);
    expect(tool.status).toBe('approved');
    applyToolResult([tool], { toolCallId: 't1', name: 'read_file', ok: true, output: '文件内容' }, completedAt);

    const runs = buildToolRuns([tool]);
    expect(runs[0]).toMatchObject({
      id: 't1',
      status: 'completed',
      ok: true,
      durationMs: 1250,
      outputPreview: '文件内容',
    });
  });

  it('stores denied tool calls as auditable tool runs', () => {
    const tool = createToolRecord({ toolCallId: 't2', name: 'run_code', args: { language: 'python' } });

    applyToolDecision(tool, false, new Date('2026-05-19T00:00:00.000Z'));

    expect(tool.status).toBe('denied');
    expect(tool.ok).toBe(false);
    expect(buildToolRuns([tool])[0].outputPreview).toContain('用户拒绝执行工具');
  });

  it('flags web search answers without cited urls', () => {
    const output = [
      '实际搜索 query：latest AI news',
      'Tavily 返回来源：',
      '1. Example News',
      '   URL: https://example.com/news',
      '   摘要: text',
    ].join('\n');
    const tool = createToolRecord({ toolCallId: 's1', name: 'web_search', args: { query: 'latest AI news' } });
    applyToolResult([tool], { toolCallId: 's1', name: 'web_search', ok: true, output });
    const message = { toolRuns: buildToolRuns([tool]) };

    expect(getSearchGrounding(message, '来源：https://example.com/news')).toMatchObject({ hasSearch: true, cited: true, warning: false });
    expect(hasSearchWithoutCitedSource(message, '根据搜索结果回答。')).toBe(true);
  });

  it('builds structured evidence without copying the full raw output', () => {
    const requestedAt = new Date('2026-05-19T00:00:00.000Z');
    const completedAt = new Date('2026-05-19T00:00:02.000Z');
    const output = [
      'Tavily 返回来源：',
      '1. Example',
      '   URL: https://example.com',
      '   摘要: result',
      'x'.repeat(1400),
    ].join('\n');
    const tool = createToolRecord({
      toolCallId: 'e1',
      name: 'web_search',
      args: { query: 'cache hit' },
      security: { riskLevel: 'low', redaction: true },
    }, requestedAt);
    applyToolResult([tool], { toolCallId: 'e1', name: 'web_search', ok: true, output }, completedAt);

    const evidence = buildToolEvidencePayload(tool);

    expect(evidence).toMatchObject({
      type: 'deepchat.toolEvidence',
      version: 1,
      id: 'e1',
      name: 'web_search',
      status: 'completed',
      ok: true,
      query: 'cache hit',
      riskLevel: 'low',
      durationMs: 2000,
      rawOutputRef: 'tool-output:e1',
    });
    expect(evidence.sources[0].url).toBe('https://example.com');
    expect(evidence.outputPreview.length).toBeLessThanOrEqual(1200);
    expect(buildToolRuns([tool])[0].evidence).toMatchObject({ id: 'e1', name: 'web_search' });
  });

  it('stores compacted context output and token metadata from tool results', () => {
    const tool = createToolRecord({ toolCallId: 'ctx1', name: 'read_file', args: { path: 'README.md' } });
    applyToolResult([tool], {
      toolCallId: 'ctx1',
      name: 'read_file',
      ok: true,
      output: 'raw output '.repeat(200),
      contextOutput: 'compacted output',
      rawOutputTokens: 800,
      contextOutputTokens: 20,
      contextCompacted: true,
    });

    const run = buildToolRuns([tool])[0];
    expect(run.contextOutput).toBe('compacted output');
    expect(run.rawOutputTokens).toBe(800);
    expect(run.contextOutputTokens).toBe(20);
    expect(run.contextCompacted).toBe(true);
    expect(run.evidence).toMatchObject({
      contextOutput: 'compacted output',
      rawOutputTokens: 800,
      contextOutputTokens: 20,
      contextCompacted: true,
    });
  });
});
