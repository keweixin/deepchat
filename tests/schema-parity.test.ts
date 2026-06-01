import { describe, expect, it } from 'vitest';
import { AgentToolRunSchema, ChatRequestSchema, ToolJobSnapshotSchema } from '../electron/agent-contracts.js';
import { validate, schemas } from '../electron/ipc-validation.js';
import { ChatMessageSchema } from '../src/types/schemas.js';
import { SettingsSchema } from '../src/types/schemas.js';

describe('runtime schema parity', () => {
  it('keeps tool job evidence across IPC, renderer, and agent contract schemas', () => {
    const job = {
      id: 'job_call_1',
      requestId: 'req-short',
      toolCallId: 'call_1',
      toolName: 'run_code',
      status: 'timed_out',
      createdAt: '2026-05-31T00:00:00.000Z',
      updatedAt: '2026-05-31T00:00:01.000Z',
      startedAt: '2026-05-31T00:00:00.100Z',
      finishedAt: '2026-05-31T00:00:01.100Z',
      timeoutMs: 5000,
      cancelGraceMs: 1000,
      durationMs: 1000,
      outputPreview: 'partial output',
      error: 'timed out',
      stale: true,
      staleResult: 'late success',
      orphaned: false,
      rollbackError: 'restore failed',
    };
    const toolRun = {
      id: 'call_1',
      name: 'run_code',
      args: { language: 'python' },
      status: 'failed',
      ok: false,
      requestedAt: '2026-05-31T00:00:00.000Z',
      completedAt: '2026-05-31T00:00:01.000Z',
      outputPreview: 'timed out',
      contextOutput: 'summary',
      parseError: '',
      repairReport: { storm: false, result: 'ok' },
      editPreview: null,
      backupPath: '',
      job,
      searchProvider: 'local_duckduckgo_html',
      fallbackReason: 'missing_tavily_key',
      externalConfigSource: 'claude_desktop',
      warnings: ['experimental fallback'],
      unsafeExtra: 'drop me',
    };

    const ipcConversation = validate(
      schemas.ConversationsSaveSchema,
      [{ id: 'conv-1', messages: [{ role: 'assistant', content: 'done', toolRuns: [toolRun] }] }],
      'conversations:save'
    );
    const rendererMessage = ChatMessageSchema.parse({ role: 'assistant', content: 'done', toolRuns: [toolRun] });
    const agentToolRun = AgentToolRunSchema.parse(toolRun);
    const agentJob = ToolJobSnapshotSchema.parse(job);

    expect(ipcConversation[0].messages[0].toolRuns[0].job).toMatchObject(job);
    expect(ipcConversation[0].messages[0].toolRuns[0].searchProvider).toBe('local_duckduckgo_html');
    expect(ipcConversation[0].messages[0].toolRuns[0].unsafeExtra).toBeUndefined();
    expect(rendererMessage.toolRuns?.[0].job).toMatchObject(job);
    expect(agentToolRun.job).toMatchObject(agentJob);
    expect(agentToolRun.searchProvider).toBe('local_duckduckgo_html');
  });

  it('keeps chat request boundaries consistent for short ids and unknown fields', () => {
    const request = {
      requestId: 'req-short-id',
      messages: [{ role: 'user', content: 'hello' }],
      overrides: { activeSkill: 'agent_auto' },
      contextSummary: '',
      contextSummaryMeta: null,
      cacheProfile: null,
    };

    expect(validate(schemas.ChatStartSchema, request, 'chat:start').requestId).toBe('req-short-id');
    expect(ChatRequestSchema.parse(request).requestId).toBe('req-short-id');
    expect(() => validate(schemas.ChatStartSchema, { ...request, unsafeExtra: true }, 'chat:start')).toThrow(
      'unsafeExtra'
    );
    expect(() => ChatRequestSchema.parse({ ...request, unsafeExtra: true })).toThrow();
  });

  it('keeps Tavily optimization settings across IPC and renderer schemas', () => {
    const patch = {
      tavilyMaxResults: 8,
      tavilySearchDepth: 'advanced',
      tavilyIncludeAnswer: true,
      tavilyIncludeRawContent: false,
      tavilyExtractTopResults: 2,
      tavilyChunksPerSource: 3,
      tavilyCacheTtlMinutes: 30,
      externalMcpDiscoveryEnabled: true,
      localSearchFallbackMode: 'missing_key',
      fallbackOnSearchError: true,
      docsetSearchEnabled: true,
      docsetRoots: ['E:/Docs/Example.docset'],
    };

    expect(validate(schemas.SettingsPatchSchema, patch, 'settings:set')).toMatchObject(patch);
    expect(SettingsSchema.parse(patch)).toMatchObject(patch);
    expect(() =>
      validate(
        schemas.SettingsPatchSchema,
        { tavilySearchDepth: 'scrape', tavilyExtractTopResults: 20 },
        'settings:set'
      )
    ).toThrow();
    expect(() => SettingsSchema.parse({ tavilySearchDepth: 'scrape' })).toThrow();
  });

  it('keeps tool approval policy values aligned across IPC and renderer schemas', () => {
    const supported = [{ toolApprovalPolicy: 'confirm_all' }, { toolApprovalPolicy: 'auto_readonly' }];

    for (const patch of supported) {
      expect(validate(schemas.SettingsPatchSchema, patch, 'settings:set')).toMatchObject(patch);
      expect(SettingsSchema.parse(patch)).toMatchObject(patch);
    }

    for (const toolApprovalPolicy of ['confirm_risky', 'auto_approve', 'auto_write']) {
      expect(() => validate(schemas.SettingsPatchSchema, { toolApprovalPolicy }, 'settings:set')).toThrow();
      expect(() => SettingsSchema.parse({ toolApprovalPolicy })).toThrow();
    }
  });

  it('keeps visible settings controls aligned with IPC and renderer schemas', () => {
    const patch = {
      activeSkill: 'agent_auto',
      crewDisplayMode: 'theatre',
      defaultComposerMode: 'project',
    };

    expect(validate(schemas.SettingsPatchSchema, patch, 'settings:set')).toMatchObject(patch);
    expect(SettingsSchema.parse(patch)).toMatchObject(patch);

    expect(() => validate(schemas.SettingsPatchSchema, { activeSkill: 'auto' }, 'settings:set')).toThrow();
    expect(() => SettingsSchema.parse({ activeSkill: 'auto' })).toThrow();
    expect(() => validate(schemas.SettingsPatchSchema, { crewDisplayMode: 'floating' }, 'settings:set')).toThrow();
    expect(() => SettingsSchema.parse({ defaultComposerMode: 'debug' })).toThrow();
  });
});
