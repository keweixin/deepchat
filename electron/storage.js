const fs = require('fs/promises');
const path = require('path');
const { app, safeStorage, dialog } = require('electron');

const DATA_VERSION = 1;

const DEFAULT_SYSTEM_PROMPT = `你是一位专业、严谨且善于深度思考的AI助手。

## 回答原则
1. **准确性优先**：不确定的内容明确标注"不确定"，不编造事实。
2. **工具透明**：需要联网搜索、读取文件或运行代码时，必须通过客户端工具调用；没有工具结果时不要假装已经完成。
3. **实用导向**：回答要可执行、可落地，避免空泛建议。

## 格式规范
- 使用 Markdown 组织内容，复杂回答先给一句简短结论。
- 对比、参数、方案选择优先使用表格。
- 代码使用代码块并标注语言。
- 数学公式使用 LaTeX（$行内$，$$块级$$）。
- 流程/架构图使用 Mermaid 代码块。
- 需要可操作演示时，优先使用当前界面支持的 widget JSON 组件。

## 安全组件
当前界面支持安全内置组件，不支持任意 HTML/JavaScript。不要输出 <script>、onclick、iframe 或自定义 HTML 组件。`;

const DEFAULT_SETTINGS = {
  providerId: 'deepseek',
  apiBase: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  temperature: 0.7,
  maxTokens: 4096,
  maxInputTokens: 24000,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxContextMessages: 20,
  agentMaxRounds: 3,
  thinkingBudget: 0,
  activeSkill: 'agent_auto',
  autoContextSummary: true,
  cacheOptimization: true,
  toolApprovalTimeoutMs: 60000,
  runCodeEnabled: true,
  enhance: true,
  tavilyMaxResults: 5,
  workspaceRoots: [],
  externalSkills: [],
  mcpServers: [],
};

const SECRET_KEYS = new Set(['apiKey', 'tavilyApiKey']);
const SECRET_JSON_KEYS = new Set(['mcpServers']);
const BACKUP_SECRETS_EXCLUDED = [
  'settings.apiKey',
  'settings.tavilyApiKey',
  'settings.mcpServers[].env',
  'settings.mcpServers[].args secret-like values',
];

function getDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function getFilePath(fileName) {
  return path.join(getDataDir(), fileName);
}

async function ensureDataDir() {
  await fs.mkdir(getDataDir(), { recursive: true });
}

async function readJson(fileName, fallback) {
  try {
    const raw = await fs.readFile(getFilePath(fileName), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(fileName, value) {
  await ensureDataDir();
  const target = getFilePath(fileName);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

function normalizeSettings(input = {}) {
  const next = { ...DEFAULT_SETTINGS, ...input };
  next.providerId = input.providerId ? normalizeProviderId(next.providerId) : inferProviderId(next.apiBase);
  next.temperature = clampNumber(next.temperature, 0, 2, DEFAULT_SETTINGS.temperature);
  next.maxTokens = Math.round(clampNumber(next.maxTokens, 256, 65536, DEFAULT_SETTINGS.maxTokens));
  next.maxInputTokens = Math.round(clampNumber(next.maxInputTokens, 1024, 262144, DEFAULT_SETTINGS.maxInputTokens));
  next.maxContextMessages = Math.round(clampNumber(next.maxContextMessages, 2, 100, DEFAULT_SETTINGS.maxContextMessages));
  next.agentMaxRounds = Math.round(clampNumber(next.agentMaxRounds, 1, 10, DEFAULT_SETTINGS.agentMaxRounds));
  next.thinkingBudget = Math.round(clampNumber(next.thinkingBudget, 0, 65536, DEFAULT_SETTINGS.thinkingBudget));
  next.tavilyMaxResults = Math.round(clampNumber(next.tavilyMaxResults, 1, 10, DEFAULT_SETTINGS.tavilyMaxResults));
  next.autoContextSummary = next.autoContextSummary !== false && next.autoContextSummary !== 'false';
  next.cacheOptimization = next.cacheOptimization !== false && next.cacheOptimization !== 'false';
  next.toolApprovalTimeoutMs = Math.round(clampNumber(next.toolApprovalTimeoutMs, 5000, 300000, DEFAULT_SETTINGS.toolApprovalTimeoutMs));
  next.runCodeEnabled = next.runCodeEnabled !== false && next.runCodeEnabled !== 'false';
  next.workspaceRoots = normalizeWorkspaceRoots(next.workspaceRoots);
  next.externalSkills = normalizeExternalSkills(next.externalSkills);
  next.mcpServers = normalizeMcpServers(next.mcpServers);
  next.enhance = next.enhance !== false && next.enhance !== 'false';
  return next;
}

function normalizeProviderId(value) {
  const id = String(value || DEFAULT_SETTINGS.providerId).trim();
  return /^(deepseek|openai|openrouter|siliconflow|dashscope|ollama|lmstudio|custom)$/.test(id) ? id : DEFAULT_SETTINGS.providerId;
}

function inferProviderId(apiBase) {
  const base = String(apiBase || '').trim().replace(/\/+$/, '').toLowerCase();
  if (base.startsWith('https://api.deepseek.com')) return 'deepseek';
  if (base.startsWith('https://api.openai.com/v1')) return 'openai';
  if (base.startsWith('https://openrouter.ai/api/v1')) return 'openrouter';
  if (base.startsWith('https://api.siliconflow.cn/v1')) return 'siliconflow';
  if (base.startsWith('https://dashscope.aliyuncs.com/compatible-mode/v1')) return 'dashscope';
  if (base.startsWith('http://localhost:11434/v1')) return 'ollama';
  if (base.startsWith('http://localhost:1234/v1')) return 'lmstudio';
  return 'custom';
}

function normalizeWorkspaceRoots(roots) {
  if (!Array.isArray(roots)) return [];
  const seen = new Set();
  const normalized = [];
  for (const root of roots) {
    if (typeof root !== 'string') continue;
    const value = path.resolve(root.trim());
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    if (!value || seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized.slice(0, 20);
}

function normalizeExternalSkills(skills) {
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((skill) => skill && typeof skill === 'object')
    .map((skill) => ({
      id: String(skill.id || '').trim() || randomId('skill'),
      name: String(skill.name || '外部 Skill').trim().slice(0, 80),
      description: String(skill.description || '').trim().slice(0, 300),
      sourcePath: String(skill.sourcePath || '').trim(),
      content: String(skill.content || '').slice(0, 40000),
      enabled: skill.enabled !== false,
      updatedAt: String(skill.updatedAt || new Date().toISOString()),
    }))
    .filter((skill) => skill.content)
    .slice(0, 20);
}

function normalizeMcpServers(servers) {
  if (!Array.isArray(servers)) return [];
  return servers
    .filter((server) => server && typeof server === 'object')
    .map((server) => ({
      id: String(server.id || '').trim() || randomId('mcp'),
      name: String(server.name || 'MCP Server').trim().slice(0, 80),
      command: String(server.command || '').trim(),
      args: Array.isArray(server.args) ? server.args.map(String).slice(0, 40) : parseArgs(String(server.args || '')),
      env: normalizeEnv(server.env),
      enabled: server.enabled !== false,
    }))
    .filter((server) => server.command)
    .slice(0, 20);
}

function normalizeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const next = {};
  for (const [key, value] of Object.entries(env)) {
    const envKey = String(key || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) continue;
    next[envKey] = String(value ?? '');
  }
  return next;
}

function parseArgs(value) {
  if (!value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).slice(0, 40);
  } catch {}
  return value.split(/\s+/).filter(Boolean).slice(0, 40);
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptSecret(value) {
  const text = String(value || '');
  if (!text) return null;
  if (!canEncrypt()) {
    throw new Error('当前系统暂不可用安全加密存储，密钥未保存。');
  }
  const encrypted = safeStorage.encryptString(text);
  return {
    version: 1,
    provider: 'safeStorage',
    value: encrypted.toString('base64'),
  };
}

function decryptSecret(entry) {
  if (!entry || entry.provider !== 'safeStorage' || !entry.value) return '';
  if (!canEncrypt()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(entry.value, 'base64'));
  } catch {
    return '';
  }
}

function encryptSecretJson(value) {
  return encryptSecret(JSON.stringify(value ?? null));
}

function decryptSecretJson(entry, fallback) {
  const text = decryptSecret(entry);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function readSecretMap() {
  return readJson('secrets.json', { version: DATA_VERSION, secrets: {} });
}

async function getSettings() {
  const stored = await readJson('settings.json', { version: DATA_VERSION, settings: {} });
  const secrets = await readSecretMap();
  const publicSettings = { ...(stored.settings || {}) };
  for (const key of SECRET_JSON_KEYS) {
    publicSettings[key] = decryptSecretJson(secrets.secrets?.[key], publicSettings[key] ?? DEFAULT_SETTINGS[key]);
  }
  const settings = normalizeSettings(publicSettings);
  return {
    ...settings,
    apiKey: decryptSecret(secrets.secrets?.apiKey),
    tavilyApiKey: decryptSecret(secrets.secrets?.tavilyApiKey),
    storageStatus: getStorageStatus(),
  };
}

async function setSettings(patch = {}) {
  const current = await getSettings();
  const publicPatch = {};
  const secretPatch = {};

  for (const [key, value] of Object.entries(patch)) {
    if (SECRET_KEYS.has(key) || SECRET_JSON_KEYS.has(key)) secretPatch[key] = value;
    else publicPatch[key] = value;
  }

  const nextPublic = normalizeSettings({ ...current, ...publicPatch });
  for (const key of SECRET_KEYS) delete nextPublic[key];
  for (const key of SECRET_JSON_KEYS) delete nextPublic[key];
  delete nextPublic.storageStatus;
  await writeJson('settings.json', { version: DATA_VERSION, settings: nextPublic });

  if (Object.keys(secretPatch).length > 0) {
    const secretMap = await readSecretMap();
    const secrets = { ...(secretMap.secrets || {}) };
    for (const [key, value] of Object.entries(secretPatch)) {
      if (!value) delete secrets[key];
      else if (SECRET_JSON_KEYS.has(key)) secrets[key] = encryptSecretJson(value);
      else secrets[key] = encryptSecret(value);
    }
    await writeJson('secrets.json', { version: DATA_VERSION, secrets });
  }

  return getSettings();
}

async function loadConversations() {
  const stored = await readJson('conversations.json', { version: DATA_VERSION, conversations: [] });
  return Array.isArray(stored.conversations) ? stored.conversations : [];
}

async function saveConversations(conversations) {
  const safeConversations = Array.isArray(conversations) ? conversations : [];
  await writeJson('conversations.json', {
    version: DATA_VERSION,
    updatedAt: new Date().toISOString(),
    conversations: safeConversations,
  });
  return safeConversations;
}

async function migrateLegacy(payload = {}) {
  const currentSettingsFile = await readJson('settings.json', null);
  const currentConversations = await loadConversations();

  if (!currentSettingsFile && payload.settings && typeof payload.settings === 'object') {
    const settingsPatch = {};
    for (const [key, value] of Object.entries(payload.settings)) {
      if (value !== undefined && value !== null && value !== '') settingsPatch[key] = value;
    }
    if (Object.keys(settingsPatch).length > 0) await setSettings(settingsPatch);
  }

  if (currentConversations.length === 0 && Array.isArray(payload.conversations) && payload.conversations.length > 0) {
    await saveConversations(payload.conversations);
  }

  return { ok: true };
}

async function addWorkspaceRoot(rootPath) {
  const settings = await getSettings();
  const roots = normalizeWorkspaceRoots([...(settings.workspaceRoots || []), rootPath]);
  return setSettings({ workspaceRoots: roots });
}

async function removeWorkspaceRoot(rootPath) {
  const settings = await getSettings();
  const target = path.resolve(rootPath);
  const targetKey = process.platform === 'win32' ? target.toLowerCase() : target;
  const roots = (settings.workspaceRoots || []).filter((root) => {
    const key = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
    return key !== targetKey;
  });
  return setSettings({ workspaceRoots: roots });
}

async function pickWorkspaceRoot(parentWindow) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: '选择 DeepChat 可读取的工作区目录',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return getSettings();
  return addWorkspaceRoot(result.filePaths[0]);
}

async function exportBackup(parentWindow) {
  const settings = await getSettings();
  const conversations = await loadConversations();
  const backup = {
    version: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    secretsExcluded: BACKUP_SECRETS_EXCLUDED,
    settings: sanitizeSettingsForBackup(settings),
    conversations,
  };

  const result = await dialog.showSaveDialog(parentWindow, {
    title: '导出 DeepChat 备份',
    defaultPath: `deepchat-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, JSON.stringify(backup, null, 2), 'utf8');
  return { canceled: false, path: result.filePath };
}

async function importBackup(parentWindow) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: '导入 DeepChat 备份',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const raw = await fs.readFile(result.filePaths[0], 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('备份文件格式不正确。');
  if (parsed.settings && typeof parsed.settings === 'object') await setSettings(sanitizeSettingsForBackup(parsed.settings));
  if (Array.isArray(parsed.conversations)) await saveConversations(parsed.conversations);
  return { canceled: false, path: result.filePaths[0] };
}

function sanitizeSettingsForBackup(settings) {
  const copy = { ...(settings || {}) };
  for (const key of SECRET_KEYS) delete copy[key];
  if (Array.isArray(copy.mcpServers)) {
    copy.mcpServers = copy.mcpServers
      .filter((server) => server && typeof server === 'object')
      .map((server) => ({
        id: String(server.id || ''),
        name: String(server.name || ''),
        command: String(server.command || ''),
        args: sanitizeMcpArgs(server.args),
        enabled: server.enabled !== false,
      }))
      .filter((server) => server.command);
  }
  delete copy.storageStatus;
  return copy;
}

function sanitizeMcpArgs(args) {
  const values = Array.isArray(args) ? args.map(String) : [];
  return values.map((arg, index) => sanitizeMcpArg(arg, values[index - 1]));
}

function sanitizeMcpArg(arg, previousArg = '') {
  const value = String(arg || '');
  const previous = String(previousArg || '');
  if (isSecretLikeArg(previous)) return '[REDACTED]';
  if (/^(--?|\/)(api[-_]?key|token|secret|password|credential|auth|bearer)$/i.test(value)) return value;
  if (/^(--?|\/)(api[-_]?key|token|secret|password|credential|auth|bearer)[=:]/i.test(value)) {
    return value.replace(/([=:]).*$/, '$1[REDACTED]');
  }
  if (looksLikeSecretValue(value)) return '[REDACTED]';
  return value;
}

function isSecretLikeArg(value) {
  return /^(--?|\/)(api[-_]?key|token|secret|password|credential|auth|bearer)$/i.test(String(value || ''));
}

function looksLikeSecretValue(value) {
  const text = String(value || '');
  return /\b(sk-|tvly-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{6,}/i.test(text) ||
    /\bBearer\s+[A-Za-z0-9._-]{8,}/i.test(text) ||
    /\b[A-Z0-9_]*(API[-_]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*[^;\s]{4,}/i.test(text);
}

function getStorageStatus() {
  return {
    mode: 'electron',
    dataDir: getDataDir(),
    encryptionAvailable: canEncrypt(),
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  getSettings,
  setSettings,
  loadConversations,
  saveConversations,
  migrateLegacy,
  addWorkspaceRoot,
  removeWorkspaceRoot,
  pickWorkspaceRoot,
  exportBackup,
  importBackup,
  getStorageStatus,
  normalizeWorkspaceRoots,
  sanitizeSettingsForBackup,
};
