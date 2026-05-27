import { createRequire } from 'module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { validate, schemas } = require('../electron/ipc-validation');
const { executeTool, isSensitivePath, redactSensitiveText, buildSandboxEnv } = require('../electron/tools');
const { sanitizeSettingsForBackup } = require('../electron/storage');

describe('ipc validation schemas', () => {
  it('rejects unknown settings fields and invalid manual tool names', () => {
    expect(() => validate(schemas.SettingsPatchSchema, { model: 'deepseek-v4-flash', unknown: true }, 'settings:set')).toThrow('入参无效');
    expect(() => validate(schemas.RunManualToolSchema, { name: 'read_file', args: {} }, 'tools:runManual')).toThrow('入参无效');
  });

  it('rejects oversized chat messages and malformed approval payloads', () => {
    expect(() => validate(schemas.ChatStartSchema, {
      requestId: 'req',
      messages: [{ role: 'user', content: 'x'.repeat(210000) }],
    }, 'chat:start')).toThrow('content');
    expect(() => validate(schemas.ToolApprovalSchema, { requestId: 'req', toolCallId: 'tool', approved: 'yes' }, 'tools:approve')).toThrow('approved');
  });

  it('allows only known agent execution modes in chat overrides', () => {
    const validated = validate(schemas.ChatStartSchema, {
      requestId: 'req-agent-mode',
      messages: [{ role: 'user', content: '单步执行计划' }],
      overrides: { agentExecutionMode: 'single_step' },
    }, 'chat:start');

    expect(validated.overrides.agentExecutionMode).toBe('single_step');
    expect(() => validate(schemas.ChatStartSchema, {
      requestId: 'req-agent-mode-bad',
      messages: [{ role: 'user', content: '执行计划' }],
      overrides: { agentExecutionMode: 'auto_write' },
    }, 'chat:start')).toThrow('agentExecutionMode');
  });

  it('persists bounded task checkpoints while stripping unknown checkpoint fields', () => {
    const validated = validate(schemas.ConversationsSaveSchema, [{
      id: 'c1',
      taskCheckpoint: {
        objective: '缓存命中优化',
        latestUserGoal: '继续做 cache-first 会话',
        lastTools: ['read_file:completed'],
        unsafeExtra: 'drop me',
      },
      messages: [],
    }], 'conversations:save');

    expect(validated[0].taskCheckpoint).toMatchObject({
      objective: '缓存命中优化',
      latestUserGoal: '继续做 cache-first 会话',
      lastTools: ['read_file:completed'],
    });
    expect(validated[0].taskCheckpoint.unsafeExtra).toBeUndefined();
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
    expect(redactSensitiveText('sk-abcdef123456 Bearer abcdef1234567890 ghp_abcdefghijk123456789 tvly-abcdef123456')).toContain('[REDACTED]');
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

    const output = await executeTool('run_code', {
      language: 'javascript',
      code: `
        console.log(JSON.stringify({
          secret: process.env.DEEPCHAT_TEST_SECRET_TOKEN || '',
          cwd: process.cwd(),
          home: process.env.HOME || process.env.USERPROFILE || '',
          temp: process.env.TEMP || process.env.TMP || ''
        }));
      `,
    }, { runCodeEnabled: true });

    expect(output).toContain('"secret":""');
    expect(output).toContain('Structured Run:');
    expect(output).toContain('"type": "deepchat.runCodeResult"');
    expect(output).toContain('耗时：');
    expect(output).toContain('沙箱目录');
    expect(output).toContain('环境变量：仅传递');
  });

  it('honors the runCodeEnabled setting', async () => {
    await expect(executeTool('run_code', {
      language: 'javascript',
      code: 'console.log(1)',
    }, { runCodeEnabled: false })).rejects.toThrow('已在设置中关闭');
  });
});

describe('backup secret handling', () => {
  it('keeps MCP server shape while stripping backup secrets', () => {
    const sanitized = sanitizeSettingsForBackup({
      apiKey: 'sk-electron-secret',
      tavilyApiKey: 'tvly-electron-secret',
      storageStatus: { mode: 'electron' },
      mcpServers: [{
        id: 'local',
        name: 'Local MCP',
        command: 'node',
        args: ['server.js', '--auth', 'Bearer abcdef1234567890', '--repo=demo'],
        env: { API_KEY: 'sk-env-secret' },
        enabled: false,
      }],
    });

    expect(sanitized.apiKey).toBeUndefined();
    expect(sanitized.tavilyApiKey).toBeUndefined();
    expect(sanitized.storageStatus).toBeUndefined();
    expect(sanitized.mcpServers).toEqual([{
      id: 'local',
      name: 'Local MCP',
      command: 'node',
      args: ['server.js', '--auth', '[REDACTED]', '--repo=demo'],
      enabled: false,
    }]);
  });
});
