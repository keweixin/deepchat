const crypto = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const CONNECT_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 60000;
const MAX_MCP_OUTPUT = 16000;
const TOOL_DEFINITION_CACHE_TTL_MS = 5 * 60 * 1000;
const TOOL_SCHEMA_FLATTEN_LEAF_LIMIT = 10;
const TOOL_SCHEMA_FLATTEN_DEPTH_LIMIT = 2;

class McpManager {
  constructor() {
    this.sessions = new Map();
    this.toolDefinitionsCache = new Map();
  }

  async getToolDefinitions(settings) {
    const servers = getEnabledServers(settings).sort(compareServers);
    const cacheKey = servers.map(serverFingerprint).join('\n');
    const cached = this.toolDefinitionsCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < TOOL_DEFINITION_CACHE_TTL_MS) return cached.definitions;

    const definitions = [];
    for (const server of servers) {
      try {
        const tools = (await this.listTools(server)).sort(compareTools);
        for (const tool of tools) {
          definitions.push(toOpenAiTool(server, tool));
        }
      } catch {
        // Broken MCP servers should not prevent normal chat.
      }
    }
    definitions.sort((a, b) => String(a.function?.name || '').localeCompare(String(b.function?.name || '')));
    this.toolDefinitionsCache.set(cacheKey, { definitions, createdAt: Date.now() });
    return definitions;
  }

  async listStatus(settings) {
    this.refreshToolDefinitions();
    const allServers = (Array.isArray(settings.mcpServers) ? settings.mcpServers : []).sort(compareServers);
    const enabledServers = getEnabledServers(settings).sort(compareServers);
    const cacheKey = enabledServers.map(serverFingerprint).join('\n');
    const cachedDefinitions = [];
    const cacheCreatedAt = Date.now();
    const result = [];
    for (const server of allServers) {
      const checkedAt = new Date().toISOString();
      const startedAt = Date.now();
      if (server.enabled === false) {
        result.push(
          makeStatusPayload(server, {
            enabled: false,
            ok: false,
            tools: [],
            error: '未启用',
            checkedAt,
            cacheCreatedAt,
          })
        );
        continue;
      }
      try {
        const tools = (await this.listTools(server)).sort(compareTools);
        for (const tool of tools) {
          cachedDefinitions.push(toOpenAiTool(server, tool));
        }
        result.push(
          makeStatusPayload(server, {
            enabled: true,
            ok: true,
            tools: tools.map(summarizeTool),
            schemaHash: hashMcpTools(server, tools),
            checkedAt,
            durationMs: Date.now() - startedAt,
            cacheCreatedAt,
          })
        );
      } catch (error) {
        result.push(
          makeStatusPayload(server, {
            enabled: true,
            ok: false,
            tools: [],
            error: normalizeError(error),
            checkedAt,
            durationMs: Date.now() - startedAt,
            cacheCreatedAt,
          })
        );
      }
    }
    cachedDefinitions.sort((a, b) => String(a.function?.name || '').localeCompare(String(b.function?.name || '')));
    this.toolDefinitionsCache.set(cacheKey, { definitions: cachedDefinitions, createdAt: cacheCreatedAt });
    return result;
  }

  async callOpenAiTool(openAiToolName, args, settings, signal) {
    const parsed = parseOpenAiToolName(openAiToolName);
    if (!parsed) throw new Error(`不是 MCP 工具：${openAiToolName}`);
    const server = getEnabledServers(settings).find((item) => item.id === parsed.serverId);
    if (!server) throw new Error(`MCP Server 未启用或不存在：${parsed.serverId}`);

    const tools = await this.listTools(server);
    const tool = tools.find((item) => makeOpenAiToolName(server, item.name) === openAiToolName);
    if (!tool) throw new Error(`MCP 工具不存在：${openAiToolName}`);

    const session = await this.getSession(server);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const callArgs = restoreFlattenedArgs(args || {});
    const result = await withTimeout(
      session.client.callTool({ name: tool.name, arguments: callArgs }),
      CALL_TIMEOUT_MS,
      `MCP 工具 ${tool.name} 执行超时`
    );
    return formatMcpResult(server, tool, result);
  }

  async listTools(server) {
    const session = await this.getSession(server);
    const result = await withTimeout(
      session.client.listTools(),
      CONNECT_TIMEOUT_MS,
      `MCP Server ${server.name} 列出工具超时`
    );
    return Array.isArray(result.tools) ? result.tools : [];
  }

  async getSession(server) {
    const key = serverFingerprint(server);
    const existing = this.sessions.get(server.id);
    if (existing?.key === key) return existing;
    if (existing) await closeSession(existing);

    const client = new Client({ name: 'deepchat', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args || [],
      env: { ...process.env, ...(server.env || {}) },
    });
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP Server ${server.name} 连接超时`);
    const session = { key, client, transport };
    this.sessions.set(server.id, session);
    return session;
  }

  async closeAll() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.refreshToolDefinitions();
    await Promise.all(sessions.map(closeSession));
  }

  async pruneSessions(enabledServerIds) {
    const ids = new Set(enabledServerIds);
    for (const [id, session] of this.sessions) {
      if (!ids.has(id)) {
        await closeSession(session);
        this.sessions.delete(id);
      }
    }
  }

  refreshToolDefinitions() {
    this.toolDefinitionsCache.clear();
  }
}

function getEnabledServers(settings) {
  return (Array.isArray(settings.mcpServers) ? settings.mcpServers : []).filter(
    (server) => server && server.enabled !== false && server.command && server.id
  );
}

function compareServers(a, b) {
  return String(a.id || a.name || '').localeCompare(String(b.id || b.name || ''));
}

function compareTools(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''));
}

function isMcpToolName(name) {
  return /^mcp__[A-Za-z0-9_-]+__/.test(String(name || ''));
}

function parseOpenAiToolName(name) {
  const match = String(name || '').match(/^mcp__([A-Za-z0-9_-]+)__/);
  if (!match) return null;
  return { serverId: match[1] };
}

function toOpenAiTool(server, tool) {
  const schema = normalizeInputSchema(tool.inputSchema);
  const prepared = shouldFlattenInputSchema(schema) ? flattenInputSchema(schema) : schema;
  return {
    type: 'function',
    function: {
      name: makeOpenAiToolName(server, tool.name),
      description: `[MCP: ${server.name}] ${String(tool.description || tool.name || '').slice(0, 900)}`,
      parameters: prepared,
    },
  };
}

function makeOpenAiToolName(server, toolName) {
  const safeServer = sanitizeName(server.id).slice(0, 20);
  const safeTool = sanitizeName(toolName).slice(0, 30);
  const hash = crypto.createHash('sha1').update(`${server.id}:${toolName}`).digest('hex').slice(0, 8);
  return `mcp__${safeServer}__${safeTool}_${hash}`.slice(0, 64);
}

function sanitizeName(value) {
  return (
    String(value || 'tool')
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .replace(/_+/g, '_') || 'tool'
  );
}

function normalizeInputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }
  return {
    type: 'object',
    properties: schema.properties && typeof schema.properties === 'object' ? schema.properties : {},
    required: Array.isArray(schema.required) ? schema.required : undefined,
    additionalProperties: schema.additionalProperties ?? true,
  };
}

function shouldFlattenInputSchema(schema) {
  return (
    countSchemaLeaves(schema) > TOOL_SCHEMA_FLATTEN_LEAF_LIMIT ||
    maxSchemaDepth(schema) > TOOL_SCHEMA_FLATTEN_DEPTH_LIMIT
  );
}

function countSchemaLeaves(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 0;
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const entries = Object.values(properties);
  if (entries.length === 0) return 0;
  return entries.reduce((total, property) => {
    if (property?.type === 'object' && property.properties && typeof property.properties === 'object') {
      return total + countSchemaLeaves(property);
    }
    return total + 1;
  }, 0);
}

function maxSchemaDepth(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return depth;
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const entries = Object.values(properties);
  if (entries.length === 0) return depth;
  return Math.max(
    ...entries.map((property) =>
      property?.type === 'object' && property.properties && typeof property.properties === 'object'
        ? maxSchemaDepth(property, depth + 1)
        : depth + 1
    )
  );
}

function flattenInputSchema(schema) {
  const properties = {};
  const required = [];
  collectFlattenedProperties(schema, [], new Set(schema.required || []), true, properties, required);
  const description = [
    '复杂 MCP 参数已压平：使用 dot-path 字段名，例如 "filters.status"；DeepChat 会在执行前还原成嵌套 JSON。',
    schema.description || '',
  ]
    .filter(Boolean)
    .join('\n');
  return {
    type: 'object',
    description,
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

function collectFlattenedProperties(schema, pathParts, requiredSet, ancestorsRequired, out, requiredOut) {
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const [key, property] of Object.entries(properties)) {
    const nextPath = [...pathParts, key];
    const isRequired = requiredSet.has(key);
    if (property?.type === 'object' && property.properties && typeof property.properties === 'object') {
      collectFlattenedProperties(
        property,
        nextPath,
        new Set(property.required || []),
        ancestorsRequired && isRequired,
        out,
        requiredOut
      );
      continue;
    }
    const flatKey = nextPath.join('.');
    out[flatKey] = stripNestedSchema(property, nextPath);
    if (ancestorsRequired && isRequired) requiredOut.push(flatKey);
  }
}

function stripNestedSchema(schema, pathParts) {
  const next = schema && typeof schema === 'object' && !Array.isArray(schema) ? { ...schema } : { type: 'string' };
  delete next.properties;
  delete next.required;
  if (pathParts.length > 1) {
    next.description = [`Original path: ${pathParts.join('.')}`, next.description || ''].filter(Boolean).join('\n');
  }
  return next;
}

function restoreFlattenedArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (!String(key).includes('.')) {
      out[key] = value;
      continue;
    }
    const parts = String(key)
      .split('.')
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length <= 1) {
      out[key] = value;
      continue;
    }
    let target = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
      target = target[part];
    }
    target[parts[parts.length - 1]] = value;
  }
  return out;
}

function summarizeTool(tool) {
  return {
    name: String(tool.name || ''),
    description: String(tool.description || '').slice(0, 300),
  };
}

function makeStatusPayload(server, payload) {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  return {
    id: server.id,
    name: server.name,
    enabled: payload.enabled,
    ok: payload.ok,
    tools,
    toolCount: tools.length,
    schemaHash: payload.schemaHash || '',
    cacheTtlMs: TOOL_DEFINITION_CACHE_TTL_MS,
    cacheExpiresAt: new Date((payload.cacheCreatedAt || Date.now()) + TOOL_DEFINITION_CACHE_TTL_MS).toISOString(),
    error: payload.error,
    checkedAt: payload.checkedAt,
    durationMs: payload.durationMs,
    command: server.command,
    args: server.args || [],
  };
}

function hashMcpTools(server, tools) {
  const stable = (Array.isArray(tools) ? [...tools] : []).sort(compareTools).map((tool) => ({
    name: String(tool.name || ''),
    description: String(tool.description || '').slice(0, 900),
    openAiName: makeOpenAiToolName(server, tool.name),
    inputSchema: normalizeInputSchema(tool.inputSchema),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

function formatMcpResult(server, tool, result) {
  const lines = [`MCP Server：${server.name}`, `Tool：${tool.name}`, ''];
  if (result?.isError) lines.push('MCP 工具返回错误。', '');
  if (Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (item?.type === 'text') lines.push(String(item.text || ''));
      else lines.push(JSON.stringify(item));
    }
  }
  if (result?.structuredContent) {
    lines.push('', 'Structured Content:', JSON.stringify(result.structuredContent, null, 2));
  }
  return lines.join('\n').slice(0, MAX_MCP_OUTPUT);
}

function serverFingerprint(server) {
  return JSON.stringify({
    command: server.command,
    args: server.args || [],
    env: server.env || {},
    enabled: server.enabled !== false,
  });
}

async function closeSession(session) {
  try {
    await session.client.close();
  } catch (err) {
    console.error('[MCP] Session close failed:', err?.message || err);
    if (session.transport?.process && !session.transport.process.killed) {
      session.transport.process.kill('SIGKILL');
    }
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function normalizeError(error) {
  return error?.message || String(error || '未知错误');
}

module.exports = {
  McpManager,
  restoreFlattenedArgs,
  isMcpToolName,
  makeOpenAiToolName,
  hashMcpTools,
};
