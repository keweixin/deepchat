// @ts-nocheck
import { describe, expect, it } from 'vitest';
import {
  applyToolDecision,
  applyToolResult,
  buildToolEvidencePayload,
  buildToolRuns,
  createToolRecord,
  extractLocalCitations,
  extractRunCodeResult,
  extractWorkspaceSymbolResult,
  extractWorkspaceSearchResults,
  getLocalFileGrounding,
  getSearchGrounding,
  hasLocalFilesWithoutCitedSource,
  hasSearchWithoutCitedSource,
} from '../src/modules/tool-runs.js';

describe('tool run state', () => {
  it('records approval, denial, results, duration, and output preview', () => {
    const requestedAt = new Date('2026-05-19T00:00:00.000Z');
    const completedAt = new Date('2026-05-19T00:00:01.250Z');
    const tool = createToolRecord(
      {
        toolCallId: 't1',
        name: 'read_file',
        args: { path: 'README.md' },
        risk: '读取文件',
      },
      requestedAt
    );

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

    expect(getSearchGrounding(message, '来源：https://example.com/news')).toMatchObject({
      hasSearch: true,
      cited: true,
      warning: false,
    });
    expect(hasSearchWithoutCitedSource(message, '根据搜索结果回答。')).toBe(true);
  });

  it('extracts and checks local workspace file citations', () => {
    const searchOutput = [
      '工作区搜索：cache telemetry',
      '1. src/agent.md:2-3',
      '   摘录:',
      '   2: DeepSeek cache telemetry should explain hit and miss tokens.',
    ].join('\n');
    const readOutput = [
      '文件：E:\\demo\\src\\agent.md',
      '大小：200 bytes',
      '行范围：2-3',
      '',
      '2: DeepSeek cache telemetry should explain hit and miss tokens.',
    ].join('\n');
    const searchTool = createToolRecord({
      toolCallId: 'l1',
      name: 'search_workspace',
      args: { query: 'cache telemetry' },
    });
    const readTool = createToolRecord({ toolCallId: 'l2', name: 'read_file', args: { path: 'src/agent.md:2-3' } });
    applyToolResult([searchTool], { toolCallId: 'l1', name: 'search_workspace', ok: true, output: searchOutput });
    applyToolResult([readTool], { toolCallId: 'l2', name: 'read_file', ok: true, output: readOutput });
    const message = { toolRuns: buildToolRuns([searchTool, readTool]) };

    expect(extractLocalCitations(searchOutput, 'search_workspace')[0]).toMatchObject({
      file: 'src/agent.md',
      lineStart: 2,
      lineEnd: 3,
      label: 'src/agent.md:2-3',
    });
    expect(getLocalFileGrounding(message, '结论见 src/agent.md:2-3。')).toMatchObject({
      hasLocalFiles: true,
      hasCitations: true,
      cited: true,
      warning: false,
    });
    expect(hasLocalFilesWithoutCitedSource(message, '根据本地文件可知。')).toBe(true);
  });

  it('extracts structured workspace search results for evidence panels', () => {
    const output = [
      '工作区搜索：cache telemetry',
      'Structured Results:',
      JSON.stringify(
        {
          type: 'deepchat.workspaceSearchResults',
          version: 1,
          query: 'cache telemetry',
          results: [
            {
              index: 1,
              file: 'src/agent.md',
              startLine: 2,
              endLine: 3,
              score: 6,
              kind: 'text',
              symbol: '',
              snippet: [{ line: 2, text: 'DeepSeek cache telemetry should explain hit and miss tokens.' }],
            },
          ],
        },
        null,
        2
      ),
      '',
      '1. src/agent.md:2-3',
      '   score: 6',
    ].join('\n');
    const tool = createToolRecord({ toolCallId: 'ws1', name: 'search_workspace', args: { query: 'cache telemetry' } });
    applyToolResult([tool], { toolCallId: 'ws1', name: 'search_workspace', ok: true, output });

    const runs = buildToolRuns([tool]);
    const evidence = buildToolEvidencePayload(tool);

    expect(extractWorkspaceSearchResults(output, 'search_workspace')).toEqual([
      expect.objectContaining({
        file: 'src/agent.md',
        startLine: 2,
        endLine: 3,
        score: 6,
        kind: 'text',
      }),
    ]);
    expect(runs[0].workspaceResults[0].snippet[0].text).toContain('DeepSeek cache telemetry');
    expect(evidence.workspaceResults[0]).toMatchObject({ file: 'src/agent.md', startLine: 2 });
  });

  it('keeps multi-query web search plans visible in evidence queries', () => {
    const tool = createToolRecord({
      toolCallId: 'web-plan',
      name: 'web_search',
      args: { queries: ['official docs', 'github issue'] },
    });
    applyToolResult([tool], {
      toolCallId: 'web-plan',
      name: 'web_search',
      ok: true,
      output: [
        'Tavily 返回来源（已按 URL 去重）：',
        '1. Official Docs',
        '   Query: official docs',
        '   URL: https://example.com/docs',
      ].join('\n'),
    });

    const runs = buildToolRuns([tool]);
    expect(runs[0].query).toBe('official docs / github issue');
    expect(runs[0].sources[0].url).toBe('https://example.com/docs');
  });

  it('extracts structured workspace symbol results for evidence panels', () => {
    const output = [
      '符号读取：buildContextBudgetBundle',
      '结果：src/budget.js:3-6',
      '类型：function',
      '签名：export function buildContextBudgetBundle(messages, options = {}) {',
      'Structured Symbol:',
      JSON.stringify(
        {
          type: 'deepchat.workspaceSymbolResult',
          version: 1,
          symbol: 'buildContextBudgetBundle',
          result: {
            file: 'src/budget.js',
            startLine: 3,
            endLine: 6,
            definitionLine: 3,
            score: 24,
            kind: 'function',
            signature: 'export function buildContextBudgetBundle(messages, options = {}) {',
            snippet: [
              { line: 3, text: 'export function buildContextBudgetBundle(messages, options = {}) {' },
              { line: 4, text: '  return { messages, options };' },
            ],
          },
          alternatives: [],
        },
        null,
        2
      ),
    ].join('\n');
    const tool = createToolRecord({
      toolCallId: 'sym1',
      name: 'read_symbol',
      args: { symbol: 'buildContextBudgetBundle' },
    });
    applyToolResult([tool], { toolCallId: 'sym1', name: 'read_symbol', ok: true, output });

    const runs = buildToolRuns([tool]);
    const evidence = buildToolEvidencePayload(tool);

    expect(extractLocalCitations(output, 'read_symbol')[0]).toMatchObject({
      file: 'src/budget.js',
      lineStart: 3,
      lineEnd: 6,
    });
    expect(extractWorkspaceSymbolResult(output, 'read_symbol')).toMatchObject({
      symbol: 'buildContextBudgetBundle',
      result: { file: 'src/budget.js', definitionLine: 3, kind: 'function' },
    });
    expect(runs[0].workspaceSymbol.result.signature).toContain('buildContextBudgetBundle');
    expect(evidence.workspaceSymbol.result).toMatchObject({ file: 'src/budget.js', startLine: 3 });
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
    const tool = createToolRecord(
      {
        toolCallId: 'e1',
        name: 'web_search',
        args: { query: 'cache hit' },
        security: { riskLevel: 'low', redaction: true },
        approvalPolicy: 'auto_readonly',
        autoApproved: true,
      },
      requestedAt
    );
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
      autoApproved: true,
      durationMs: 2000,
      rawOutputRef: 'tool-output:e1',
    });
    expect(evidence.sources[0].url).toBe('https://example.com');
    expect(evidence.outputPreview.length).toBeLessThanOrEqual(1200);
    expect(buildToolRuns([tool])[0].evidence).toMatchObject({ id: 'e1', name: 'web_search' });
    expect(buildToolRuns([tool])[0]).toMatchObject({ autoApproved: true, approvalPolicy: 'auto_readonly' });
  });

  it('extracts structured run_code experiment results for evidence panels', () => {
    const output = [
      '语言：javascript',
      '退出码：1',
      '耗时：42ms',
      'Structured Run:',
      JSON.stringify(
        {
          type: 'deepchat.runCodeResult',
          version: 1,
          language: 'javascript',
          codeLength: 32,
          stdinBytes: 0,
          durationMs: 42,
          exitCode: 1,
          timedOut: false,
          ok: false,
          stdoutBytes: 6,
          stderrBytes: 17,
          stdoutPreview: 'before',
          stderrPreview: 'ReferenceError: x',
          failureHint: '变量或函数未定义：请检查上下文是否完整。',
        },
        null,
        2
      ),
      '',
      'STDOUT:',
      'before',
      '',
      'STDERR:',
      'ReferenceError: x',
    ].join('\n');
    const tool = createToolRecord({ toolCallId: 'run1', name: 'run_code', args: { language: 'javascript' } });
    applyToolResult([tool], { toolCallId: 'run1', name: 'run_code', ok: false, output });

    const runs = buildToolRuns([tool]);
    const evidence = buildToolEvidencePayload(tool);

    expect(extractRunCodeResult(output, 'run_code')).toMatchObject({
      language: 'javascript',
      exitCode: 1,
      durationMs: 42,
      ok: false,
      failureHint: expect.stringContaining('变量或函数未定义'),
    });
    expect(runs[0].runResult.stderrPreview).toContain('ReferenceError');
    expect(evidence.runResult).toMatchObject({ codeLength: 32, stdoutBytes: 6 });
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

  it('carries tool recovery suggestions into runs and evidence payloads', () => {
    const tool = createToolRecord({ toolCallId: 'fail1', name: 'web_search', args: { query: 'cache' } });
    applyToolResult([tool], {
      toolCallId: 'fail1',
      name: 'web_search',
      ok: false,
      output: 'Tavily 搜索失败',
      nextAction: '检查 Tavily Key 后重试。',
    });

    const run = buildToolRuns([tool])[0];
    const evidence = buildToolEvidencePayload(tool);

    expect(run.nextAction).toBe('检查 Tavily Key 后重试。');
    expect(evidence.nextAction).toBe('检查 Tavily Key 后重试。');
  });
});
