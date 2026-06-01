const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const SOURCE_LABELS = {
  claude_desktop: 'Claude Desktop',
  claude_desktop_msix: 'Claude Desktop (MSIX)',
  claude_code_global: 'Claude Code Global',
  claude_code_project_mcp: 'Claude Code Project .mcp.json',
  claude_code_project_settings: 'Claude Code Project settings',
};

async function scanExternalMcpConfigs(settings = {}, options = {}) {
  const entries = await readExternalConfigEntries(settings, options);
  const existingServers = Array.isArray(settings.mcpServers) ? settings.mcpServers : [];
  const existingFingerprints = new Set(
    existingServers.map((server) => server.externalConfigFingerprint || serverFingerprint(server))
  );
  const candidates = [];
  const warnings = [];

  for (const entry of entries) {
    if (entry.warning) {
      warnings.push(entry.warning);
      continue;
    }
    const servers = extractMcpServers(entry.json);
    for (const [serverName, server] of servers) {
      const normalized = normalizeExternalServer(serverName, server, entry);
      if (!normalized) continue;
      normalized.imported = existingFingerprints.has(normalized.fingerprint);
      candidates.push(normalized);
    }
  }

  applyConflictFlags(candidates);
  return {
    scannedAt: new Date().toISOString(),
    candidates,
    warnings,
    summary: summarizeCandidates(candidates, warnings),
  };
}

async function readExternalConfigEntries(settings = {}, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const appData = options.appData || process.env.APPDATA || '';
  const localAppData = options.localAppData || process.env.LOCALAPPDATA || '';
  const workspaceRoots = Array.isArray(options.workspaceRoots)
    ? options.workspaceRoots
    : Array.isArray(settings.workspaceRoots)
      ? settings.workspaceRoots
      : [];
  const paths = [
    {
      source: 'claude_desktop',
      filePath:
        platform === 'darwin'
          ? path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : path.join(appData, 'Claude', 'claude_desktop_config.json'),
    },
    {
      source: 'claude_desktop_msix',
      filePath: path.join(
        localAppData,
        'Packages',
        'Claude_pzs8sxrjxfjjc',
        'LocalCache',
        'Roaming',
        'Claude',
        'claude_desktop_config.json'
      ),
    },
    { source: 'claude_code_global', filePath: path.join(homeDir, '.claude.json') },
  ];

  for (const root of workspaceRoots) {
    const workspaceRoot = String(root || '').trim();
    if (!workspaceRoot) continue;
    paths.push(
      { source: 'claude_code_project_mcp', filePath: path.join(workspaceRoot, '.mcp.json') },
      { source: 'claude_code_project_settings', filePath: path.join(workspaceRoot, '.claude', 'settings.json') }
    );
  }

  const out = [];
  const seenPaths = new Set();
  for (const item of paths) {
    const filePath = path.resolve(item.filePath);
    const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    const entry = await readJsonConfig(filePath, item.source);
    if (entry) out.push(entry);
  }
  return out;
}

async function readJsonConfig(filePath, source) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_CONFIG_BYTES) {
      return { source, sourcePath: filePath, warning: `${sourceLabel(source)} 配置过大，已跳过：${filePath}` };
    }
    const raw = await fs.readFile(filePath, 'utf8');
    return { source, sourcePath: filePath, json: JSON.parse(raw) };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return { source, sourcePath: filePath, warning: `${sourceLabel(source)} 配置读取失败：${error?.message || error}` };
  }
}

function extractMcpServers(json) {
  const entries = [];
  collectMcpServers(json?.mcpServers, entries);
  collectMcpServers(json?.mcp?.servers, entries);
  collectMcpServers(json?.mcp_servers, entries);
  if (json?.projects && typeof json.projects === 'object') {
    for (const project of Object.values(json.projects)) {
      collectMcpServers(project?.mcpServers, entries);
      collectMcpServers(project?.mcp?.servers, entries);
    }
  }
  return entries;
}

function collectMcpServers(value, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') out.push([item.name || item.id || item.command || 'mcp-server', item]);
    }
    return;
  }
  for (const [name, server] of Object.entries(value)) {
    if (server && typeof server === 'object') out.push([name, server]);
  }
}

function normalizeExternalServer(serverName, server, entry) {
  const command = String(server.command || server.cmd || '').trim();
  if (!command) return null;
  const args = normalizeArgs(server.args);
  const cwd = typeof server.cwd === 'string' ? server.cwd.slice(0, 2000) : '';
  const env = normalizeEnv(server.env);
  const envSummary = summarizeEnv(env);
  const importEnv = buildImportEnv(env);
  const fingerprint = serverFingerprint({ command, args, cwd, env });
  const id = `external_mcp_${hashText(`${entry.source}:${entry.sourcePath}:${serverName}:${fingerprint}`).slice(0, 16)}`;
  const warnings = [];
  if (Object.keys(env).length > 0) warnings.push('环境变量值不会自动导入；请在 DeepChat 中重新确认需要的密钥。');
  if (/^npx(\.cmd)?$/i.test(command)) warnings.push('npx 依赖当前 PATH 和 Node 环境，建议导入后先测试。');
  if (path.isAbsolute(command)) warnings.push('命令为绝对路径，迁移到其他机器时可能失效。');
  if (cwd) warnings.push('检测到 cwd 配置，DeepChat 会保留路径但不会自动扩大工作区授权。');
  return {
    id,
    source: entry.source,
    sourceLabel: sourceLabel(entry.source),
    sourcePath: entry.sourcePath,
    name: String(server.name || serverName || command).slice(0, 100),
    command,
    args,
    cwd,
    envKeys: Object.keys(env).sort(),
    envPreview: envSummary,
    fingerprint,
    imported: false,
    duplicate: false,
    conflict: false,
    status: 'new',
    warnings,
    importServer: {
      id: `mcp_${hashText(`${serverName}:${fingerprint}`).slice(0, 12)}`,
      name: String(server.name || serverName || command).slice(0, 80),
      command,
      args,
      env: importEnv,
      cwd,
      enabled: true,
      externalConfigSource: entry.source,
      externalConfigPath: entry.sourcePath,
      externalConfigFingerprint: fingerprint,
    },
  };
}

function applyConflictFlags(candidates) {
  const byFingerprint = new Map();
  const byName = new Map();
  for (const candidate of candidates) {
    if (!byFingerprint.has(candidate.fingerprint)) byFingerprint.set(candidate.fingerprint, []);
    byFingerprint.get(candidate.fingerprint).push(candidate);
    const nameKey = String(candidate.name || '')
      .trim()
      .toLowerCase();
    if (!byName.has(nameKey)) byName.set(nameKey, []);
    byName.get(nameKey).push(candidate);
  }
  for (const group of byFingerprint.values()) {
    if (group.length <= 1) continue;
    for (const candidate of group) {
      candidate.duplicate = true;
      candidate.duplicateOf = group.find((item) => item.id !== candidate.id)?.id || '';
    }
  }
  for (const group of byName.values()) {
    const fingerprints = new Set(group.map((item) => item.fingerprint));
    if (fingerprints.size <= 1) continue;
    for (const candidate of group) candidate.conflict = true;
  }
  for (const candidate of candidates) {
    candidate.status = candidate.imported
      ? 'imported'
      : candidate.conflict
        ? 'conflict'
        : candidate.duplicate
          ? 'duplicate'
          : 'new';
  }
}

function summarizeCandidates(candidates, warnings) {
  return {
    total: candidates.length,
    new: candidates.filter((item) => item.status === 'new').length,
    duplicate: candidates.filter((item) => item.status === 'duplicate').length,
    conflict: candidates.filter((item) => item.status === 'conflict').length,
    imported: candidates.filter((item) => item.status === 'imported').length,
    warnings: warnings.length,
  };
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.map((item) => String(item)).slice(0, 80);
}

function normalizeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    const envKey = String(key || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) continue;
    out[envKey] = String(value ?? '');
  }
  return out;
}

function summarizeEnv(env) {
  const out = {};
  for (const key of Object.keys(env).sort()) {
    out[key] = isSecretLikeKey(key) || looksLikeSecretValue(env[key]) ? '[REDACTED]' : '[set]';
  }
  return out;
}

function buildImportEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = isSecretLikeKey(key) || looksLikeSecretValue(value) ? '' : String(value);
  }
  return out;
}

function serverFingerprint(server) {
  return hashText(
    stableJson({
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      cwd: server.cwd || '',
      env: Object.fromEntries(
        Object.entries(server.env || {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => [key, hashText(String(value ?? ''))])
      ),
    })
  );
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sourceLabel(source) {
  return SOURCE_LABELS[source] || source;
}

function isSecretLikeKey(key) {
  return /api[-_]?key|token|secret|password|credential|auth|bearer/i.test(String(key || ''));
}

function looksLikeSecretValue(value) {
  const text = String(value || '');
  return (
    /\b(sk-|tvly-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{6,}/i.test(text) ||
    /\bBearer\s+[A-Za-z0-9._-]{8,}/i.test(text) ||
    text.length > 80
  );
}

module.exports = {
  scanExternalMcpConfigs,
  readExternalConfigEntries,
  extractMcpServers,
  serverFingerprint,
  normalizeExternalServer,
};
