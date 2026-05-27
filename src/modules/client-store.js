import { hasNativeBridge, getSettings, saveSettings } from './api.js';

const CONVERSATIONS_KEY = 'dc_conversations';
const BACKUP_SECRETS_EXCLUDED = [
  'settings.apiKey',
  'settings.tavilyApiKey',
  'settings.mcpServers[].env',
  'settings.mcpServers[].args secret-like values',
];

export async function loadConversations() {
  if (hasNativeBridge()) return window.deepchat.conversations.load();
  const saved = localStorage.getItem(CONVERSATIONS_KEY);
  if (!saved) return [];
  try {
    const parsed = JSON.parse(saved);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveConversations(conversations) {
  const safe = Array.isArray(conversations) ? conversations : [];
  if (hasNativeBridge()) {
    await window.deepchat.conversations.save(safe);
  } else {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(safe));
  }
}

export async function exportBackup() {
  if (hasNativeBridge()) return window.deepchat.conversations.exportBackup();
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    secretsExcluded: BACKUP_SECRETS_EXCLUDED,
    settings: sanitizeSettingsForBackup(getSettings()),
    conversations: await loadConversations(),
  };
  downloadJson(backup, `deepchat-backup-${new Date().toISOString().slice(0, 10)}.json`);
  return { canceled: false };
}

export async function importBackup() {
  if (hasNativeBridge()) return window.deepchat.conversations.importBackup();
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener(
      'change',
      async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve({ canceled: true });
          return;
        }
        try {
          const parsed = JSON.parse(await file.text());
          if (parsed.settings) await saveSettings(sanitizeSettingsForBackup(parsed.settings));
          if (Array.isArray(parsed.conversations)) await saveConversations(parsed.conversations);
          resolve({ canceled: false });
        } catch (error) {
          reject(error);
        }
      },
      { once: true }
    );
    input.click();
  });
}

export async function pickWorkspace() {
  if (hasNativeBridge()) return window.deepchat.workspace.pick();
  return getSettings();
}

export async function removeWorkspace(root) {
  if (hasNativeBridge()) return window.deepchat.workspace.remove(root);
  const settings = getSettings();
  const roots = (settings.workspaceRoots || []).filter((item) => item !== root);
  return saveSettings({ workspaceRoots: roots });
}

export async function clearWorkspaceIndexCache() {
  if (hasNativeBridge() && window.deepchat.workspace.clearIndexCache) {
    return window.deepchat.workspace.clearIndexCache();
  }
  return {
    ok: true,
    memoryCleared: false,
    diskEnabled: false,
    deletedFiles: 0,
    deletedBytes: 0,
  };
}

export async function pickExternalSkill() {
  if (hasNativeBridge()) return window.deepchat.skills.pickExternal();
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,text/markdown,text/plain';
    input.addEventListener(
      'change',
      async () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(getSettings());
          return;
        }
        try {
          const content = await file.text();
          const settings = getSettings();
          const skill = {
            id: `skill_${Date.now().toString(36)}`,
            name: file.name.replace(/\.md$/i, ''),
            description: '',
            sourcePath: file.name,
            content,
            enabled: true,
            updatedAt: new Date().toISOString(),
          };
          resolve(await saveSettings({ externalSkills: [...(settings.externalSkills || []), skill] }));
        } catch (error) {
          reject(error);
        }
      },
      { once: true }
    );
    input.click();
  });
}

export async function listMcpStatus() {
  if (!hasNativeBridge()) return [];
  return window.deepchat.mcp.listStatus();
}

export function onMenuOpenSettings(callback) {
  if (!hasNativeBridge()) return () => {};
  return window.deepchat.menu.onOpenSettings(callback);
}

export function onMenuNewChat(callback) {
  if (!hasNativeBridge()) return () => {};
  return window.deepchat.menu.onNewChat(callback);
}

export function sanitizeSettingsForBackup(settings) {
  const copy = { ...(settings || {}) };
  delete copy.apiKey;
  delete copy.tavilyApiKey;
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
  return (
    /\b(sk-|tvly-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{6,}/i.test(text) ||
    /\bBearer\s+[A-Za-z0-9._-]{8,}/i.test(text) ||
    /\b[A-Z0-9_]*(API[-_]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*[^;\s]{4,}/i.test(text)
  );
}

function downloadJson(value, fileName) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
