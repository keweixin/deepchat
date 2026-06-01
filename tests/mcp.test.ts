import { describe, expect, it } from 'vitest';

import { parseSkillMeta, scanExternalSkills } from '../electron/external-skills.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  McpManager,
  buildMcpEnv,
  hashMcpTools,
  isMcpToolName,
  makeOpenAiToolName,
  restoreFlattenedArgs,
} from '../electron/mcp-manager.js';

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

  it('discovers Codex, Agents, Claude, and workspace skill roots without importing automatically', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'deepchat-skills-'));
    try {
      const codexSkill = path.join(tmp, '.codex', 'skills', 'demo-codex');
      const workspaceSkill = path.join(tmp, 'workspace', '.claude', 'skills', 'demo-workspace');
      await fs.mkdir(codexSkill, { recursive: true });
      await fs.mkdir(workspaceSkill, { recursive: true });
      await fs.writeFile(
        path.join(codexSkill, 'SKILL.md'),
        ['---', 'name: codex-demo', 'description: Codex demo skill', '---', '', '# Demo'].join('\n'),
        'utf8'
      );
      await fs.writeFile(
        path.join(workspaceSkill, 'SKILL.md'),
        ['---', 'name: workspace-demo', 'description: Workspace demo skill', '---', '', '# Demo'].join('\n'),
        'utf8'
      );

      const payload = await scanExternalSkills(
        { externalSkills: [], workspaceRoots: [path.join(tmp, 'workspace')] },
        { homeDir: tmp }
      );

      expect(payload.candidates.map((candidate: any) => candidate.name)).toEqual(
        expect.arrayContaining(['codex-demo', 'workspace-demo'])
      );
      expect(payload.candidates.every((candidate: any) => candidate.importSkill?.content)).toBe(true);
      expect(payload.candidates.every((candidate: any) => candidate.status === 'new')).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('creates OpenAI-safe names for MCP tools', () => {
    const name = makeOpenAiToolName({ id: 'local-files', name: 'Local Files' }, 'read/file.with spaces');

    expect(name).toMatch(/^mcp__local-files__/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(isMcpToolName(name)).toBe(true);
  });

  it('does not inherit secret-like process env for MCP by default', () => {
    const original = process.env.DEEPCHAT_TEST_SECRET;
    process.env.DEEPCHAT_TEST_SECRET = 'should-not-leak';
    try {
      const safeEnv = buildMcpEnv({ env: { EXPLICIT_TOKEN: 'allowed' } });
      expect(safeEnv.EXPLICIT_TOKEN).toBe('allowed');
      expect(safeEnv.DEEPCHAT_TEST_SECRET).toBeUndefined();

      const inheritedEnv = buildMcpEnv({ inheritEnv: true, env: { EXPLICIT_TOKEN: 'allowed' } });
      expect(inheritedEnv.DEEPCHAT_TEST_SECRET).toBe('should-not-leak');
    } finally {
      if (original === undefined) delete process.env.DEEPCHAT_TEST_SECRET;
      else process.env.DEEPCHAT_TEST_SECRET = original;
    }
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
    expect(statuses[0].phase).toBe('listTools');
    expect(statuses[0].cacheTtlMs).toBeGreaterThan(0);
    expect(statuses[0].cacheExpiresAt).toMatch(/T/);
    expect(statuses[0].schemaHash).toMatch(/^[a-f0-9]{16}$/);
    expect(definitions).toHaveLength(3);
    expect(calls).toEqual(['a', 'b']);
  });

  it('classifies MCP status failures for diagnostics', async () => {
    const manager = new McpManager();
    const settings = { mcpServers: [{ id: 'bad', name: 'Bad', command: 'missing-cmd', args: [] }] };
    manager.listTools = async () => {
      throw new Error('spawn ENOENT missing-cmd');
    };

    const statuses = await manager.listStatus(settings);

    expect(statuses[0]).toMatchObject({
      id: 'bad',
      ok: false,
      phase: 'initialize/listTools',
      failureReason: 'command_not_found',
    });
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
