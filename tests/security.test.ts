import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { validate, schemas, summarizeChatStartForLog } from '../electron/ipc-validation.js';
import { executeTool, isSensitivePath, redactSensitiveText, buildSandboxEnv } from '../electron/tools.js';
import { sanitizeSettingsForBackup } from '../electron/storage.js';
import { renderMarkdown } from '../src/modules/renderer.js';

describe('ipc validation schemas', () => {
  it('rejects unknown settings fields and invalid manual tool names', () => {
    expect(() =>
      validate(schemas.SettingsPatchSchema, { model: 'deepseek-v4-flash', unknown: true }, 'settings:set')
    ).toThrow('入参无效');
    expect(() => validate(schemas.RunManualToolSchema, { name: 'read_file', args: {} }, 'tools:runManual')).toThrow(
      '入参无效'
    );
    expect(
      validate(schemas.SettingsPatchSchema, { toolApprovalPolicy: 'auto_readonly' }, 'settings:set').toolApprovalPolicy
    ).toBe('auto_readonly');
    expect(() => validate(schemas.SettingsPatchSchema, { toolApprovalPolicy: 'auto_write' }, 'settings:set')).toThrow(
      'toolApprovalPolicy'
    );
  });

  it('rejects oversized chat messages and malformed approval payloads', () => {
    expect(() =>
      validate(
        schemas.ChatStartSchema,
        {
          requestId: 'req',
          messages: [{ role: 'user', content: 'x'.repeat(210000) }],
        },
        'chat:start'
      )
    ).toThrow('content');
    expect(() =>
      validate(schemas.ToolApprovalSchema, { requestId: 'req', toolCallId: 'tool', approved: 'yes' }, 'tools:approve')
    ).toThrow('approved');
  });

  it('allows only known agent execution modes in chat overrides', () => {
    const validated = validate(
      schemas.ChatStartSchema,
      {
        requestId: 'req-agent-mode',
        messages: [{ role: 'user', content: '单步执行计划' }],
        overrides: { agentExecutionMode: 'single_step' },
      },
      'chat:start'
    );

    expect(validated.overrides.agentExecutionMode).toBe('single_step');
    expect(() =>
      validate(
        schemas.ChatStartSchema,
        {
          requestId: 'req-agent-mode-bad',
          messages: [{ role: 'user', content: '执行计划' }],
          overrides: { agentExecutionMode: 'auto_write' },
        },
        'chat:start'
      )
    ).toThrow('agentExecutionMode');
  });

  it('rejects unknown chat:start fields without requiring UUID request ids', () => {
    const validated = validate(
      schemas.ChatStartSchema,
      {
        requestId: 'req-short-id',
        messages: [{ role: 'user', content: 'hello' }],
      },
      'chat:start'
    );

    expect(validated.requestId).toBe('req-short-id');
    expect(() =>
      validate(
        schemas.ChatStartSchema,
        {
          requestId: 'req-short-id',
          messages: [{ role: 'user', content: 'hello' }],
          unsafeExtra: true,
        },
        'chat:start'
      )
    ).toThrow('unsafeExtra');
  });

  it('summarizes chat:start logs without leaking message content or attachment data', () => {
    const summary = summarizeChatStartForLog({
      requestId: 'req-log',
      messages: [
        {
          role: 'user',
          content: 'secret prompt sk-should-not-leak',
          attachments: [{ name: 'secret.txt', text: 'Bearer should-not-leak' }],
        },
        { role: 'assistant', content: 'private answer' },
      ],
      overrides: { activeSkill: 'agent_auto', agentExecutionMode: 'single_step', enhance: true },
      contextSummary: 'private summary',
      cacheProfile: { prefixFingerprint: 'abc' },
    });

    const serialized = JSON.stringify(summary);
    expect(summary).toMatchObject({
      requestId: 'req-log',
      messageCount: 2,
      roles: ['user', 'assistant'],
      attachmentCount: 1,
      hasContextSummary: true,
      hasCacheProfile: true,
      overrides: { activeSkill: 'agent_auto', agentExecutionMode: 'single_step', enhance: true },
    });
    expect(serialized).not.toContain('secret prompt');
    expect(serialized).not.toContain('sk-should-not-leak');
    expect(serialized).not.toContain('Bearer should-not-leak');
    expect(serialized).not.toContain('private summary');
  });

  it('persists bounded task checkpoints while stripping unknown checkpoint fields', () => {
    const validated = validate(
      schemas.ConversationsSaveSchema,
      [
        {
          id: 'c1',
          taskCheckpoint: {
            objective: '缓存命中优化',
            latestUserGoal: '继续做 cache-first 会话',
            lastTools: ['read_file:completed'],
            unsafeExtra: 'drop me',
          },
          messages: [],
        },
      ],
      'conversations:save'
    );

    expect(validated[0].taskCheckpoint).toMatchObject({
      objective: '缓存命中优化',
      latestUserGoal: '继续做 cache-first 会话',
      lastTools: ['read_file:completed'],
    });
    expect(validated[0].taskCheckpoint.unsafeExtra).toBeUndefined();
  });

  it('persists bounded agent crew run state while stripping unknown fields', () => {
    const validated = validate(
      schemas.ConversationsSaveSchema,
      [
        {
          id: 'c1',
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              content: '处理中',
              agentRun: {
                id: 'run1',
                mode: 'agent_auto',
                status: 'running',
                startedAt: '2026-05-27T00:00:00.000Z',
                crew: [
                  {
                    id: 'planner',
                    label: 'Planner',
                    icon: '🧭',
                    title: '计划员',
                    status: 'running',
                    currentAction: '正在规划',
                    linkedStepIds: ['step1'],
                    unsafeExtra: 'drop me',
                  },
                ],
                steps: [{ id: 'step1', stage: 'planning' }],
                unsafeExtra: 'drop me',
              },
            },
          ],
        },
      ],
      'conversations:save'
    );

    const agentRun = validated[0].messages[0].agentRun;
    expect(agentRun.status).toBe('running');
    expect(agentRun.crew[0]).toMatchObject({
      id: 'planner',
      icon: '🧭',
      status: 'running',
      currentAction: '正在规划',
    });
    expect(agentRun.unsafeExtra).toBeUndefined();
    expect(agentRun.crew[0].unsafeExtra).toBeUndefined();
  });

  it('persists bounded tool job snapshots while stripping unknown job fields', () => {
    const validated = validate(
      schemas.ConversationsSaveSchema,
      [
        {
          id: 'c1',
          messages: [
            {
              role: 'assistant',
              content: '工具超时',
              toolRuns: [
                {
                  id: 'tool1',
                  name: 'run_code',
                  status: 'failed',
                  ok: false,
                  job: {
                    id: 'job_tool1',
                    requestId: 'req1',
                    toolCallId: 'tool1',
                    toolName: 'run_code',
                    status: 'timed_out',
                    timeoutMs: 7000,
                    stale: true,
                    unsafeExtra: 'drop me',
                  },
                },
              ],
            },
          ],
        },
      ],
      'conversations:save'
    );

    const job = validated[0].messages[0].toolRuns[0].job;
    expect(job).toMatchObject({ id: 'job_tool1', status: 'timed_out', timeoutMs: 7000, stale: true });
    expect(job.unsafeExtra).toBeUndefined();
  });
});

describe('tool security boundaries', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.DEEPCHAT_TEST_SECRET_TOKEN;
  });

  it('detects sensitive paths and redacts common secret tokens', () => {
    expect(isSensitivePath(path.join('C:\\demo', '.env'))).toBe(true);
    expect(isSensitivePath(path.join('C:\\demo', '.ssh', 'id_rsa'))).toBe(true);
    expect(
      redactSensitiveText('sk-abcdef123456 Bearer abcdef1234567890 ghp_abcdefghijk123456789 tvly-abcdef123456')
    ).toContain('[REDACTED]');
  });

  it('refuses sensitive files and redacts readable file output', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-sec-'));
    await fs.writeFile(path.join(tmpDir, '.env'), 'API_KEY=sk-abcdef123456', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'token=ghp_abcdefghijk123456789\nhello', 'utf8');

    await expect(executeTool('read_file', { path: '.env' }, { workspaceRoots: [tmpDir] })).rejects.toThrow('敏感');
    const output = await executeTool('read_file', { path: 'notes.txt' }, { workspaceRoots: [tmpDir] });
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('ghp_abcdefghijk123456789');
  });

  it('runs code with a minimal isolated environment', async () => {
    process.env.DEEPCHAT_TEST_SECRET_TOKEN = 'sk-should-not-leak';
    const env = buildSandboxEnv('javascript', os.tmpdir());
    expect(env.DEEPCHAT_TEST_SECRET_TOKEN).toBeUndefined();

    const output = await executeTool(
      'run_code',
      {
        language: 'javascript',
        code: `
        console.log(JSON.stringify({
          secret: process.env.DEEPCHAT_TEST_SECRET_TOKEN || '',
          cwd: process.cwd(),
          home: process.env.HOME || process.env.USERPROFILE || '',
          temp: process.env.TEMP || process.env.TMP || ''
        }));
      `,
      },
      { runCodeEnabled: true }
    );

    expect(output).toContain('"secret":""');
    expect(output).toContain('Structured Run:');
    expect(output).toContain('"type": "deepchat.runCodeResult"');
    expect(output).toContain('耗时：');
    expect(output).toContain('沙箱目录');
    expect(output).toContain('环境：最小变量白名单');
  });

  it('honors the runCodeEnabled setting', async () => {
    await expect(
      executeTool(
        'run_code',
        {
          language: 'javascript',
          code: 'console.log(1)',
        },
        { runCodeEnabled: false }
      )
    ).rejects.toThrow('已在设置中关闭');
  });
});

describe('backup secret handling', () => {
  it('keeps MCP server shape while stripping backup secrets', () => {
    const sanitized = sanitizeSettingsForBackup({
      apiKey: 'sk-electron-secret',
      tavilyApiKey: 'tvly-electron-secret',
      storageStatus: { mode: 'electron' },
      mcpServers: [
        {
          id: 'local',
          name: 'Local MCP',
          command: 'node',
          args: ['server.js', '--auth', 'Bearer abcdef1234567890', '--repo=demo'],
          env: { API_KEY: 'sk-env-secret' },
          enabled: false,
        },
      ],
    });

    expect(sanitized.apiKey).toBeUndefined();
    expect(sanitized.tavilyApiKey).toBeUndefined();
    expect(sanitized.storageStatus).toBeUndefined();
    expect(sanitized.mcpServers).toEqual([
      {
        id: 'local',
        name: 'Local MCP',
        command: 'node',
        args: ['server.js', '--auth', '[REDACTED]', '--repo=demo'],
        enabled: false,
      },
    ]);
  });
});

describe('XSS and HTML rendering safety', () => {
  it('escapes dynamic scripts and handles inline events in Markdown', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> <img src="x" onerror="alert(2)">');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror');
  });

  it('escapes and sanitizes dangerous links', () => {
    const html = renderMarkdown('[link](javascript:alert(1))');
    expect(html).toContain('href="#"');
  });

  it('blocks iframe in regular markdown for security', () => {
    const html = renderMarkdown('<iframe src="https://example.com" sandbox="allow-scripts"></iframe>');
    // iframe should be escaped in regular markdown, only allowed in Artifact sandbox preview
    expect(html).not.toContain('<iframe');
    expect(html).toContain('&lt;iframe');
  });
});
