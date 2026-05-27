import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { parseSkillMeta } = require('../electron/external-skills');
const {
  McpManager,
  hashMcpTools,
  isMcpToolName,
  makeOpenAiToolName,
  restoreFlattenedArgs,
} = require('../electron/mcp-manager');

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
    manager.listTools = async () => [
      { name: `tool_${(version += 1)}`, description: 'demo', inputSchema: { type: 'object' } },
    ];
    const settings = { mcpServers: [{ id: 'a', name: 'A', command: 'node', args: [] }] };

    const first = await manager.getToolDefinitions(settings);
    const cached = await manager.getToolDefinitions(settings);
    manager.refreshToolDefinitions();
    const refreshed = await manager.getToolDefinitions(settings);

    expect(cached).toEqual(first);
    expect(refreshed[0].function.name).not.toBe(first[0].function.name);
  });

  it('returns cache-aware MCP status metadata and reuses refreshed definitions', async () => {
    const manager = new McpManager();
    const calls = [];
    const settings = {
      mcpServers: [
        { id: 'b', name: 'B', command: 'node', args: [] },
        { id: 'a', name: 'A', command: 'node', args: [] },
      ],
    };
    manager.listTools = async (server) => {
      calls.push(server.id);
      return server.id === 'a'
        ? [
            {
              name: 'zeta',
              description: 'last',
              inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
            },
            { name: 'alpha', description: 'first', inputSchema: { type: 'object', properties: {} } },
          ]
        : [{ name: 'beta', description: 'middle', inputSchema: { type: 'object' } }];
    };

    const statuses = await manager.listStatus(settings);
    const definitions = await manager.getToolDefinitions(settings);

    expect(statuses.map((status) => status.id)).toEqual(['a', 'b']);
    expect(statuses[0].ok).toBe(true);
    expect(statuses[0].tools.map((tool) => tool.name)).toEqual(['alpha', 'zeta']);
    expect(statuses[0].toolCount).toBe(2);
    expect(statuses[0].cacheTtlMs).toBeGreaterThan(0);
    expect(statuses[0].cacheExpiresAt).toMatch(/T/);
    expect(statuses[0].schemaHash).toMatch(/^[a-f0-9]{16}$/);
    expect(definitions).toHaveLength(3);
    expect(calls).toEqual(['a', 'b']);
  });

  it('changes MCP schema hash when tool schemas change', () => {
    const server = { id: 'a', name: 'A' };
    const first = hashMcpTools(server, [
      { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    ]);
    const second = hashMcpTools(server, [
      {
        name: 'search',
        description: 'Search',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ]);

    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(second).not.toBe(first);
  });

  it('flattens complex MCP tool schemas for model reliability and restores dot-path arguments', async () => {
    const manager = new McpManager();
    const server = { id: 'a', name: 'A', command: 'node', args: [] };
    const inputSchema = {
      type: 'object',
      properties: {
        filters: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Task status' },
            owner: {
              type: 'object',
              properties: {
                id: { type: 'string' },
              },
              required: ['id'],
            },
          },
          required: ['status', 'owner'],
        },
      },
      required: ['filters'],
    };
    manager.listTools = async () => [{ name: 'search', description: 'Search tasks', inputSchema }];
    const definitions = await manager.getToolDefinitions({ mcpServers: [server] });

    const schema = definitions[0].function.parameters;
    expect(schema.description).toContain('dot-path');
    expect(schema.properties).toHaveProperty('filters.status');
    expect(schema.properties).toHaveProperty('filters.owner.id');
    expect(schema.properties.filters).toBeUndefined();
    expect(schema.required).toEqual(expect.arrayContaining(['filters.status', 'filters.owner.id']));
    expect(restoreFlattenedArgs({ 'filters.status': 'open', 'filters.owner.id': 'u1', limit: 3 })).toEqual({
      filters: { status: 'open', owner: { id: 'u1' } },
      limit: 3,
    });
  });

  it('restores flattened MCP arguments before calling the server tool', async () => {
    const manager = new McpManager();
    const server = { id: 'a', name: 'A', command: 'node', args: [] };
    const toolName = makeOpenAiToolName(server, 'search');
    let calledPayload;
    manager.listTools = async () => [{ name: 'search', description: 'Search tasks', inputSchema: { type: 'object' } }];
    manager.getSession = async () => ({
      client: {
        callTool: async (payload) => {
          calledPayload = payload;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
    });

    await manager.callOpenAiTool(toolName, { 'filters.status': 'open', query: 'cache' }, { mcpServers: [server] });

    expect(calledPayload).toEqual({
      name: 'search',
      arguments: {
        filters: { status: 'open' },
        query: 'cache',
      },
    });
  });
});
