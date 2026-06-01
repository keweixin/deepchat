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
  contextFoldEconomicsEnabled: true,
  codingEditsEnabled: true,
  agentModelTier: 'auto',
  toolApprovalTimeoutMs: 60000,
  toolApprovalPolicy: 'confirm_all',
  runCodeEnabled: true,
  enhance: true,
  tavilyMaxResults: 5,
  tavilySearchDepth: 'basic',
  tavilyIncludeAnswer: false,
  tavilyIncludeRawContent: false,
  tavilyExtractTopResults: 0,
  tavilyChunksPerSource: 3,
  tavilyCacheTtlMinutes: 10,
  externalMcpDiscoveryEnabled: true,
  localSearchFallbackMode: 'missing_key',
  fallbackOnSearchError: false,
  docsetSearchEnabled: false,
  docsetRoots: /** @type {string[]} */ ([]),
  workspaceRoots: /** @type {string[]} */ ([]),
  externalSkills: /** @type {Record<string, any>[]} */ ([]),
  mcpServers: /** @type {Record<string, any>[]} */ ([]),
};

const SECRET_KEYS = new Set(['apiKey', 'tavilyApiKey']);
const SECRET_JSON_KEYS = new Set(['mcpServers']);
const BACKUP_SECRETS_EXCLUDED = [
  'settings.apiKey',
  'settings.tavilyApiKey',
  'settings.mcpServers[].env',
  'settings.mcpServers[].args secret-like values',
];

/**
 * @returns {string}
 */
function getDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

/**
 * @param {string} fileName
 * @returns {string}
 */
function getFilePath(fileName) {
  return path.join(getDataDir(), fileName);
}

/**
 * @returns {Promise<void>}
 */
async function ensureDataDir() {
  await fs.mkdir(getDataDir(), { recursive: true });
}

/**
 * @param {string} fileName
 * @param {any} fallback
 * @returns {Promise<any>}
 */
async function readJson(fileName, fallback) {
  try {
    const raw = await fs.readFile(getFilePath(fileName), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[storage] Failed to read ${fileName}:`, /** @type {any} */ (err).message || err);
    return fallback;
  }
}

/**
 * @param {string} fileName
 * @param {any} value
 * @returns {Promise<void>}
 */
async function writeJson(fileName, value) {
  await ensureDataDir();
  const target = getFilePath(fileName);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

/**
 * @param {Record<string, any>} [input]
 * @returns {Record<string, any>}
 */
function normalizeSettings(input = /** @type {Record<string, any>} */ ({})) {
  const next = /** @type {Record<string, any>} */ ({ ...DEFAULT_SETTINGS, ...input });
  const nextAny = /** @type {any} */ (next);
  next.providerId = input.providerId ? normalizeProviderId(next.providerId) : inferProviderId(next.apiBase);
  next.temperature = clampNumber(next.temperature, 0, 2, DEFAULT_SETTINGS.temperature);
  next.maxTokens = Math.round(clampNumber(next.maxTokens, 256, 65536, DEFAULT_SETTINGS.maxTokens));
  next.maxInputTokens = Math.round(clampNumber(next.maxInputTokens, 1024, 262144, DEFAULT_SETTINGS.maxInputTokens));
  next.maxContextMessages = Math.round(
    clampNumber(next.maxContextMessages, 2, 100, DEFAULT_SETTINGS.maxContextMessages)
  );
  next.agentMaxRounds = Math.round(clampNumber(next.agentMaxRounds, 1, 10, DEFAULT_SETTINGS.agentMaxRounds));
  next.thinkingBudget = Math.round(clampNumber(next.thinkingBudget, 0, 65536, DEFAULT_SETTINGS.thinkingBudget));
  next.tavilyMaxResults = Math.round(clampNumber(next.tavilyMaxResults, 1, 10, DEFAULT_SETTINGS.tavilyMaxResults));
  next.tavilySearchDepth = ['ultra-fast', 'fast', 'basic', 'advanced'].includes(String(next.tavilySearchDepth))
    ? String(next.tavilySearchDepth)
    : DEFAULT_SETTINGS.tavilySearchDepth;
  next.tavilyIncludeAnswer = nextAny.tavilyIncludeAnswer === true || nextAny.tavilyIncludeAnswer === 'true';
  next.tavilyIncludeRawContent = nextAny.tavilyIncludeRawContent === true || nextAny.tavilyIncludeRawContent === 'true';
  next.tavilyExtractTopResults = Math.round(
    clampNumber(next.tavilyExtractTopResults, 0, 5, DEFAULT_SETTINGS.tavilyExtractTopResults)
  );
  next.tavilyChunksPerSource = Math.round(
    clampNumber(next.tavilyChunksPerSource, 1, 5, DEFAULT_SETTINGS.tavilyChunksPerSource)
  );
  next.tavilyCacheTtlMinutes = Math.round(
    clampNumber(next.tavilyCacheTtlMinutes, 0, 1440, DEFAULT_SETTINGS.tavilyCacheTtlMinutes)
  );
  next.externalMcpDiscoveryEnabled =
    nextAny.externalMcpDiscoveryEnabled !== false && nextAny.externalMcpDiscoveryEnabled !== 'false';
  next.localSearchFallbackMode = ['missing_key', 'provider_error', 'off'].includes(String(next.localSearchFallbackMode))
    ? String(next.localSearchFallbackMode)
    : DEFAULT_SETTINGS.localSearchFallbackMode;
  next.fallbackOnSearchError = nextAny.fallbackOnSearchError === true || nextAny.fallbackOnSearchError === 'true';
  next.docsetSearchEnabled = nextAny.docsetSearchEnabled === true || nextAny.docsetSearchEnabled === 'true';
  next.docsetRoots = normalizePathList(next.docsetRoots, 20);
  next.autoContextSummary = nextAny.autoContextSummary !== false && nextAny.autoContextSummary !== 'false';
  next.cacheOptimization = nextAny.cacheOptimization !== false && nextAny.cacheOptimization !== 'false';
  next.contextFoldEconomicsEnabled =
    nextAny.contextFoldEconomicsEnabled !== false && nextAny.contextFoldEconomicsEnabled !== 'false';
  next.codingEditsEnabled = nextAny.codingEditsEnabled !== false && nextAny.codingEditsEnabled !== 'false';
  next.agentModelTier = ['flash', 'auto', 'pro'].includes(String(next.agentModelTier))
    ? String(next.agentModelTier)
    : DEFAULT_SETTINGS.agentModelTier;
  next.toolApprovalTimeoutMs = Math.round(
    clampNumber(next.toolApprovalTimeoutMs, 5000, 300000, DEFAULT_SETTINGS.toolApprovalTimeoutMs)
  );
  next.toolApprovalPolicy =
    String(next.toolApprovalPolicy || DEFAULT_SETTINGS.toolApprovalPolicy) === 'auto_readonly'
      ? 'auto_readonly'
      : DEFAULT_SETTINGS.toolApprovalPolicy;
  next.runCodeEnabled = nextAny.runCodeEnabled !== false && nextAny.runCodeEnabled !== 'false';
  next.workspaceRoots = normalizeWorkspaceRoots(next.workspaceRoots);
  next.externalSkills = normalizeExternalSkills(next.externalSkills);
  next.mcpServers = normalizeMcpServers(next.mcpServers);
  next.enhance = nextAny.enhance !== false && nextAny.enhance !== 'false';
  return next;
}

/**
 * @param {any} value
 * @returns {string}
 */
function normalizeProviderId(value) {
  const id = String(value || DEFAULT_SETTINGS.providerId).trim();
  return /^(deepseek|openai|openrouter|siliconflow|dashscope|ollama|lmstudio|custom)$/.test(id)
    ? id
    : DEFAULT_SETTINGS.providerId;
}

/**
 * @param {any} apiBase
 * @returns {string}
 */
function inferProviderId(apiBase) {
  const base = String(apiBase || '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();
  if (base.startsWith('https://api.deepseek.com')) return 'deepseek';
  if (base.startsWith('https://api.openai.com/v1')) return 'openai';
  if (base.startsWith('https://openrouter.ai/api/v1')) return 'openrouter';
  if (base.startsWith('https://api.siliconflow.cn/v1')) return 'siliconflow';
  if (base.startsWith('https://dashscope.aliyuncs.com/compatible-mode/v1')) return 'dashscope';
  if (base.startsWith('http://localhost:11434/v1')) return 'ollama';
  if (base.startsWith('http://localhost:1234/v1')) return 'lmstudio';
  return 'custom';
}

/**
 * @param {any} roots
 * @returns {string[]}
 */
function normalizeWorkspaceRoots(roots) {
  return normalizePathList(roots, 20);
}

/**
 * @param {any} roots
 * @param {number} max
 * @returns {string[]}
 */
function normalizePathList(roots, max) {
  if (!Array.isArray(roots)) return [];
  const seen = /** @type {Set<string>} */ (new Set());
  const normalized = /** @type {string[]} */ ([]);
  for (const root of roots) {
    if (typeof root !== 'string') continue;
    const raw = root.trim();
    if (!raw) continue;
    const value = path.resolve(raw);
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    if (!value || seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
  }
  return normalized.slice(0, max);
}

/**
 * @param {any} skills
 * @returns {Record<string, any>[]}
 */
function normalizeExternalSkills(skills) {
  if (!Array.isArray(skills)) return [];
  return /** @type {any[]} */ (skills)
    .filter((skill) => skill && typeof skill === 'object')
    .map((skill) => ({
      id: String(skill.id || '').trim() || randomId('skill'),
      name: String(skill.name || '外部 Skill')
        .trim()
        .slice(0, 80),
      description: String(skill.description || '')
        .trim()
        .slice(0, 300),
      sourcePath: String(skill.sourcePath || '').trim(),
      content: String(skill.content || '').slice(0, 40000),
      enabled: skill.enabled !== false,
      updatedAt: String(skill.updatedAt || new Date().toISOString()),
    }))
    .filter((skill) => skill.content)
    .slice(0, 20);
}

/**
 * @param {any} servers
 * @returns {Record<string, any>[]}
 */
function normalizeMcpServers(servers) {
  if (!Array.isArray(servers)) return [];
  return /** @type {any[]} */ (servers)
    .filter((server) => server && typeof server === 'object')
    .map((server) => ({
      id: String(server.id || '').trim() || randomId('mcp'),
      name: String(server.name || 'MCP Server')
        .trim()
        .slice(0, 80),
      command: String(server.command || '').trim(),
      args: Array.isArray(server.args) ? server.args.map(String).slice(0, 40) : parseArgs(String(server.args || '')),
      env: normalizeEnv(server.env),
      cwd: String(server.cwd || '')
        .trim()
        .slice(0, 2000),
      externalConfigSource: String(server.externalConfigSource || '')
        .trim()
        .slice(0, 80),
      externalConfigPath: String(server.externalConfigPath || '')
        .trim()
        .slice(0, 2000),
      externalConfigFingerprint: String(server.externalConfigFingerprint || server.fingerprint || '')
        .trim()
        .slice(0, 120),
      enabled: server.enabled !== false,
    }))
    .filter((server) => server.command)
    .slice(0, 20);
}

/**
 * @param {any} env
 * @returns {Record<string, string>}
 */
function normalizeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return /** @type {Record<string, string>} */ ({});
  const next = /** @type {Record<string, string>} */ ({});
  for (const [key, value] of Object.entries(env)) {
    const envKey = String(key || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) continue;
    next[envKey] = String(value ?? '');
  }
  return next;
}

/**
 * @param {any} value
 * @returns {string[]}
 */
function parseArgs(value) {
  if (!value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).slice(0, 40);
  } catch {}
  return value.split(/\s+/).filter(Boolean).slice(0, 40);
}

/**
 * @param {string} prefix
 * @returns {string}
 */
function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

/**
 * @returns {boolean}
 */
function canEncrypt() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/**
 * @param {any} value
 * @returns {Record<string, any> | null}
 */
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

/**
 * @param {any} entry
 * @returns {string}
 */
function decryptSecret(entry) {
  if (!entry || entry.provider !== 'safeStorage' || !entry.value) return '';
  if (!canEncrypt()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(entry.value, 'base64'));
  } catch {
    return '';
  }
}

/**
 * @param {any} value
 * @returns {Record<string, any> | null}
 */
function encryptSecretJson(value) {
  return encryptSecret(JSON.stringify(value ?? null));
}

/**
 * @param {any} entry
 * @param {any} fallback
 * @returns {any}
 */
function decryptSecretJson(entry, fallback) {
  const text = decryptSecret(entry);
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * @returns {Promise<Record<string, any>>}
 */
async function readSecretMap() {
  return readJson('secrets.json', { version: DATA_VERSION, secrets: /** @type {Record<string, any>} */ ({}) });
}

/**
 * @returns {Promise<Record<string, any>>}
 */
async function getSettings() {
  const stored = await readJson('settings.json', {
    version: DATA_VERSION,
    settings: /** @type {Record<string, any>} */ ({}),
  });
  const secrets = await readSecretMap();
  const publicSettings = /** @type {Record<string, any>} */ ({
    ...(stored.settings || /** @type {Record<string, any>} */ ({})),
  });
  for (const key of SECRET_JSON_KEYS) {
    publicSettings[key] = decryptSecretJson(
      secrets.secrets?.[key],
      publicSettings[key] ?? /** @type {Record<string, any>} */ (DEFAULT_SETTINGS)[key]
    );
  }
  const settings = normalizeSettings(publicSettings);
  return {
    ...settings,
    apiKey: decryptSecret(secrets.secrets?.apiKey),
    tavilyApiKey: decryptSecret(secrets.secrets?.tavilyApiKey),
    storageStatus: getStorageStatus(),
  };
}

/**
 * @param {Record<string, any>} [patch]
 * @returns {Promise<Record<string, any>>}
 */
async function setSettings(patch = /** @type {Record<string, any>} */ ({})) {
  const current = await getSettings();
  const publicPatch = /** @type {Record<string, any>} */ ({});
  const secretPatch = /** @type {Record<string, any>} */ ({});

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

/**
 * @returns {Promise<Record<string, any>[]>}
 */
async function loadConversations() {
  const stored = await readJson('conversations.json', {
    version: DATA_VERSION,
    conversations: /** @type {Record<string, any>[]} */ ([]),
  });
  return Array.isArray(stored.conversations) ? stored.conversations : [];
}

/**
 * @param {any[]} conversations
 * @returns {Promise<any[]>}
 */
async function saveConversations(conversations) {
  const safeConversations = /** @type {any[]} */ (Array.isArray(conversations) ? conversations : []);
  await writeJson('conversations.json', {
    version: DATA_VERSION,
    updatedAt: new Date().toISOString(),
    conversations: safeConversations,
  });
  return safeConversations;
}

/**
 * @param {Record<string, any>} [payload]
 * @returns {Promise<Record<string, any>>}
 */
async function migrateLegacy(payload = /** @type {Record<string, any>} */ ({})) {
  const currentSettingsFile = await readJson('settings.json', null);
  const currentConversations = await loadConversations();

  if (!currentSettingsFile && payload.settings && typeof payload.settings === 'object') {
    const settingsPatch = /** @type {Record<string, any>} */ ({});
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

/**
 * @param {string} rootPath
 * @returns {Promise<Record<string, any>>}
 */
async function addWorkspaceRoot(rootPath) {
  const settings = await getSettings();
  const roots = normalizeWorkspaceRoots([...(settings.workspaceRoots || []), rootPath]);
  return setSettings({ workspaceRoots: roots });
}

/**
 * @param {string} rootPath
 * @returns {Promise<Record<string, any>>}
 */
async function removeWorkspaceRoot(rootPath) {
  const settings = await getSettings();
  const target = path.resolve(rootPath);
  const targetKey = process.platform === 'win32' ? target.toLowerCase() : target;
  const roots = /** @type {string[]} */ (
    /** @type {string[]} */ (settings.workspaceRoots || []).filter((root) => {
      const key = process.platform === 'win32' ? path.resolve(root).toLowerCase() : path.resolve(root);
      return key !== targetKey;
    })
  );
  return setSettings({ workspaceRoots: roots });
}

/**
 * @param {import('electron').BrowserWindow} parentWindow
 * @returns {Promise<Record<string, any>>}
 */
async function pickWorkspaceRoot(parentWindow) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: '选择 DeepChat 可读取的工作区目录',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return getSettings();
  return addWorkspaceRoot(result.filePaths[0]);
}

/**
 * @param {import('electron').BrowserWindow} parentWindow
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function exportBackup(parentWindow, options = /** @type {Record<string, any>} */ ({})) {
  // Show a premium pre-flight privacy alert dialog
  const warnResult = await dialog.showMessageBox(parentWindow, {
    type: 'info',
    title: '导出备份安全提示',
    message: '您即将导出 DeepChat 本地数据备份。',
    detail:
      '请注意，虽然系统配置中的 API 密钥等凭证在导出时会被自动剔除，但您的历史聊天消息、代码块或工具执行日志中，仍可能残留您手动输入或生成过的隐私凭证（如 API Key 或绝对路径）。若您计划将备份分享给第三方或在公共环境导入，建议选择“脱敏”或定制排除过滤选项。',
    buttons: ['继续导出', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (warnResult.response === 1) return { canceled: true };

  const settings = await getSettings();
  const conversations = await loadConversations();

  let safeConversations = conversations;

  if (options.exportMode === 'settings') {
    safeConversations = /** @type {any[]} */ ([]);
  } else {
    safeConversations = /** @type {any[]} */ (conversations).map((c) => {
      if (!Array.isArray(c.messages)) return c;
      return {
        ...c,
        messages: /** @type {any[]} */ (c.messages).map((m) => {
          let content = /** @type {string} */ (m.content);
          let thinking = /** @type {string} */ (m.thinking);
          let toolRuns = /** @type {any[]} */ (m.toolRuns);
          let toolCalls = /** @type {any[]} */ (m.toolCalls);
          let attachments = /** @type {any[]} */ (m.attachments);

          // Apply excludeCodeBlocks
          if (options.excludeCodeBlocks || options.excludeCode) {
            if (typeof content === 'string') {
              content = content.replace(/```[\s\S]*?```/g, '[代码块已根据隐私设置排除]');
            }
            if (typeof thinking === 'string') {
              thinking = thinking.replace(/```[\s\S]*?```/g, '[代码块已根据隐私设置排除]');
            }
          }

          // Apply excludeToolOutputs
          if (options.excludeToolOutputs && Array.isArray(toolRuns)) {
            toolRuns = /** @type {any[]} */ (toolRuns).map((run) => ({
              ...run,
              output: '[工具输出已根据隐私设置排除]',
            }));
          }
          if (options.excludeToolOutputs && Array.isArray(toolCalls)) {
            toolCalls = /** @type {any[]} */ (toolCalls).map((call) => ({
              ...call,
              output: '[工具输出已根据隐私设置排除]',
            }));
          }

          // Apply excludeMcpReturns
          if (options.excludeMcpReturns) {
            if (Array.isArray(toolRuns)) {
              toolRuns = /** @type {any[]} */ (toolRuns).map((run) => {
                if (run.toolName && run.toolName.includes('/')) {
                  return { ...run, output: '[MCP工具输出已根据隐私设置排除]' };
                }
                return run;
              });
            }
            if (Array.isArray(toolCalls)) {
              toolCalls = /** @type {any[]} */ (toolCalls).map((call) => {
                if (call.toolName && call.toolName.includes('/')) {
                  return { ...call, output: '[MCP工具输出已根据隐私设置排除]' };
                }
                return call;
              });
            }
          }

          // Apply excludeAttachments
          if (options.excludeAttachments) {
            attachments = /** @type {any[]} */ ([]);
          }

          // Apply deidentified mode: sanitize absolute paths, API keys, etc.
          if (options.exportMode === 'deidentified') {
            if (typeof content === 'string') {
              content = content.replace(/sk-[a-zA-Z0-9\-]{20,}/g, '[已脱敏 API KEY]');
              content = content.replace(/[a-zA-Z]:\\[\\\w\s\-\.\_]+/g, '[已脱敏绝对路径]');
              content = content.replace(/\/Users\/[\w\s\-\.\_]+/g, '[已脱敏绝对路径]');
            }
            if (typeof thinking === 'string') {
              thinking = thinking.replace(/sk-[a-zA-Z0-9\-]{20,}/g, '[已脱敏 API KEY]');
              thinking = thinking.replace(/[a-zA-Z]:\\[\\\w\s\-\.\_]+/g, '[已脱敏绝对路径]');
              thinking = thinking.replace(/\/Users\/[\w\s\-\.\_]+/g, '[已脱敏绝对路径]');
            }
          }

          return {
            ...m,
            content,
            thinking,
            toolRuns,
            toolCalls,
            attachments,
          };
        }),
      };
    });
  }

  const backup = {
    version: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    secretsExcluded: BACKUP_SECRETS_EXCLUDED,
    settings: options.exportMode === 'sessions' ? {} : sanitizeSettingsForBackup(settings),
    conversations: safeConversations,
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

/**
 * @param {import('electron').BrowserWindow} parentWindow
 * @returns {Promise<Record<string, any>>}
 */
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
  if (parsed.version && parsed.version !== DATA_VERSION) {
    console.warn(`[Import] Backup version ${parsed.version} differs from current ${DATA_VERSION}`);
  }
  if (parsed.settings && typeof parsed.settings === 'object')
    await setSettings(sanitizeSettingsForBackup(parsed.settings));
  if (Array.isArray(parsed.conversations)) {
    const validated = /** @type {any[]} */ (parsed.conversations).filter((c) => c && c.id && Array.isArray(c.messages));
    await saveConversations(validated);
  }
  return { canceled: false, path: result.filePaths[0] };
}

/**
 * @param {Record<string, any>} settings
 * @returns {Record<string, any>}
 */
function sanitizeSettingsForBackup(settings) {
  const copy = /** @type {Record<string, any>} */ ({ ...(settings || /** @type {Record<string, any>} */ ({})) });
  for (const key of SECRET_KEYS) delete copy[key];
  const mcpServers = /** @type {any[]} */ (copy.mcpServers);
  if (Array.isArray(mcpServers)) {
    copy.mcpServers = mcpServers
      .filter((server) => server && typeof server === 'object')
      .map((server) => ({
        id: String(server.id || ''),
        name: String(server.name || ''),
        command: String(server.command || ''),
        args: sanitizeMcpArgs(server.args),
        ...(server.cwd ? { cwd: String(server.cwd) } : {}),
        ...(server.externalConfigSource ? { externalConfigSource: String(server.externalConfigSource) } : {}),
        ...(server.externalConfigPath ? { externalConfigPath: String(server.externalConfigPath) } : {}),
        ...(server.externalConfigFingerprint
          ? { externalConfigFingerprint: String(server.externalConfigFingerprint) }
          : {}),
        enabled: server.enabled !== false,
      }))
      .filter((server) => server.command);
  }
  delete copy.storageStatus;
  return copy;
}

/**
 * @param {any} args
 * @returns {string[]}
 */
function sanitizeMcpArgs(args) {
  const values = Array.isArray(args) ? args.map(String) : [];
  return values.map((arg, index) => sanitizeMcpArg(arg, values[index - 1]));
}

/**
 * @param {any} arg
 * @param {string} [previousArg]
 * @returns {string}
 */
function sanitizeMcpArg(arg, previousArg = '') {
  const value = String(arg || '');
  const previous = String(previousArg || '');
  if (isSecretLikeArg(previous)) return '[REDACTED]';
  if (/^(--?|\/)(api[-_]?key|token|secret|password|credential|auth|bearer)$/i.test(value)) return value;
  if (/^(--?|\/)(api[-_]?key|token|secret|password|credential|auth|bearer)[=:]*/i.test(value)) {
    return value.replace(/([=:]).*$/, '$1[REDACTED]');
  }
  if (looksLikeSecretValue(value)) return '[REDACTED]';
  return value;
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isSecretLikeArg(value) {
  return /^(--?|\/)(api[-_]?key|token|secret|password|credential|auth|bearer)$/i.test(String(value || ''));
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function looksLikeSecretValue(value) {
  const text = String(value || '');
  return (
    /\b(sk-|tvly-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{6,}/i.test(text) ||
    /\bBearer\s+[A-Za-z0-9._-]{8,}/i.test(text) ||
    /\b[A-Z0-9_]*(API[-_]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*[^;\s]{4,}/i.test(text)
  );
}

/**
 * @returns {Record<string, any>}
 */
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
