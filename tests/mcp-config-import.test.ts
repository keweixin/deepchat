import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanExternalMcpConfigs, serverFingerprint } from '../electron/external-mcp-configs.js';
import { validate, schemas } from '../electron/ipc-validation.js';

describe('external MCP config discovery', () => {
  it('scans external configs read-only and redacts secrets from renderer payload', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-mcp-scan-'));
    try {
      const appData = path.join(tmp, 'appdata');
      const workspace = path.join(tmp, 'workspace');
      await fs.mkdir(path.join(appData, 'Claude'), { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(
        path.join(appData, 'Claude', 'claude_desktop_config.json'),
        JSON.stringify({
          mcpServers: {
            filesystem: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', workspace],
              env: {
                API_KEY: 'sk-test-secret-value',
                SAFE_FLAG: 'enabled',
              },
              cwd: workspace,
            },
          },
        }),
        'utf8'
      );
      await fs.writeFile(
        path.join(workspace, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            filesystem: {
              command: 'node',
              args: ['server.js'],
            },
          },
        }),
        'utf8'
      );

      const payload = await scanExternalMcpConfigs(
        { mcpServers: [], workspaceRoots: [workspace] },
        { appData, localAppData: path.join(tmp, 'localappdata'), homeDir: tmp, workspaceRoots: [workspace] }
      );

      const serialized = JSON.stringify(payload);
      expect(payload.candidates).toHaveLength(2);
      expect(payload.candidates.some((candidate: any) => candidate.status === 'conflict')).toBe(true);
      expect(serialized).not.toContain('sk-test-secret-value');
      expect(serialized).toContain('[REDACTED]');

      const imported = payload.candidates.find((candidate: any) => candidate.command === 'npx').importServer;
      expect(imported.cwd).toBe(workspace);
      expect(imported.env).toEqual({ API_KEY: '', SAFE_FLAG: 'enabled' });
      expect(validate(schemas.SettingsPatchSchema, { mcpServers: [imported] }, 'settings:set')).toMatchObject({
        mcpServers: [expect.objectContaining({ command: 'npx', cwd: workspace })],
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('marks already imported fingerprints as imported', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-mcp-imported-'));
    try {
      const appData = path.join(tmp, 'appdata');
      await fs.mkdir(path.join(appData, 'Claude'), { recursive: true });
      const server = { command: 'node', args: ['mcp.js'], env: { TOKEN: 'secret-value' }, cwd: tmp };
      await fs.writeFile(
        path.join(appData, 'Claude', 'claude_desktop_config.json'),
        JSON.stringify({ mcpServers: { imported: server } }),
        'utf8'
      );
      const fingerprint = serverFingerprint(server);

      const payload = await scanExternalMcpConfigs(
        {
          mcpServers: [{ ...server, externalConfigFingerprint: fingerprint }],
        },
        { appData, localAppData: path.join(tmp, 'localappdata'), homeDir: tmp }
      );

      expect(payload.candidates[0].status).toBe('imported');
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
