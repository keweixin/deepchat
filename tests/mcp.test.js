import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseSkillMeta } = require('../electron/external-skills');
const { McpManager, isMcpToolName, makeOpenAiToolName } = require('../electron/mcp-manager');

describe('external skills and MCP helpers', () => {
  it('parses frontmatter from SKILL.md files', () => {
    const meta = parseSkillMeta(`---
name: demo-skill
description: Demo skill description
---

# Demo`);

    expect(meta).toEqual({
      name: 'demo-skill',
      description: 'Demo skill description',
    });
  });

  it('creates OpenAI-safe names for MCP tools', () => {
    const name = makeOpenAiToolName({ id: 'local-files', name: 'Local Files' }, 'read/file.with spaces');

    expect(name).toMatch(/^mcp__local-files__/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(isMcpToolName(name)).toBe(true);
  });

  it('returns MCP tool definitions in a stable sorted order and reuses the cache', async () => {
    const manager = new McpManager();
    const calls = [];
    manager.listTools = async (server) => {
      calls.push(server.id);
      return server.id === 'b'
        ? [
            { name: 'zeta', description: 'z', inputSchema: { type: 'object' } },
            { name: 'alpha', description: 'a', inputSchema: { type: 'object' } },
          ]
        : [{ name: 'beta', description: 'b', inputSchema: { type: 'object' } }];
    };

    const settings = {
      mcpServers: [
        { id: 'b', name: 'B', command: 'node', args: [] },
        { id: 'a', name: 'A', command: 'node', args: [] },
      ],
    };

    const first = await manager.getToolDefinitions(settings);
    const second = await manager.getToolDefinitions(settings);

    expect(first.map((tool) => tool.function.name)).toEqual([...first.map((tool) => tool.function.name)].sort());
    expect(second).toEqual(first);
    expect(calls).toEqual(['a', 'b']);
  });

  it('refreshes cached MCP tool definitions on demand', async () => {
    const manager = new McpManager();
    let version = 0;
    manager.listTools = async () => [{ name: `tool_${version += 1}`, description: 'demo', inputSchema: { type: 'object' } }];
    const settings = { mcpServers: [{ id: 'a', name: 'A', command: 'node', args: [] }] };

    const first = await manager.getToolDefinitions(settings);
    const cached = await manager.getToolDefinitions(settings);
    manager.refreshToolDefinitions();
    const refreshed = await manager.getToolDefinitions(settings);

    expect(cached).toEqual(first);
    expect(refreshed[0].function.name).not.toBe(first[0].function.name);
  });
});
