import { createRequire } from 'module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { validate, schemas } = require('../electron/ipc-validation');
const { executeTool, isSensitivePath, redactSensitiveText, buildSandboxEnv } = require('../electron/tools');

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
