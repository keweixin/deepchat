import { hasNativeBridge } from './bridge.ts';
import { getSettings, saveSettings } from './settings-core.js';
import { SAVE_DEBOUNCE_MS } from './constants.js';
import { loadAllMessages, saveAllMessages, saveMessages } from './conversation-db.js';

const CONVERSATIONS_KEY = 'dc_conversations';
const META_VERSION_KEY = 'dc_conversations_meta_version';
const BACKUP_SECRETS_EXCLUDED = [
  'settings.apiKey',
  'settings.tavilyApiKey',
  'settings.mcpServers[].env',
  'settings.mcpServers[].args secret-like values',
];

/** Debounced save to avoid repeated serialization during rapid updates */
let lastSavedSnapshot: string | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadConversations(): Promise<any[]> {
  if (hasNativeBridge()) return (window as any).deepchat.conversations.load();

  const saved = localStorage.getItem(CONVERSATIONS_KEY);
  if (!saved) return [];

  try {
    const parsed = JSON.parse(saved);
    const metadataList = Array.isArray(parsed) ? parsed : [];
    if (metadataList.length === 0) return [];

    // Detect legacy storage: metadata still embeds messages → migrate to IndexedDB
    const hasLegacyMessages = metadataList.some((m: any) => Array.isArray(m.messages) && m.messages.length > 0);
    if (hasLegacyMessages) {
      await migrateLegacyStorage(metadataList);
    }

    // Load messages from IndexedDB and merge with metadata
    const allMessages = await loadAllMessages();
    return metadataList.map((meta: any) => ({
      ...meta,
      messages: allMessages[meta.id] || meta.messages || [],
    }));
  } catch {
    return [];
  }
}

/** Migrate conversations that still embed messages in localStorage to IndexedDB */
async function migrateLegacyStorage(metadataList: any[]): Promise<void> {
  try {
    const entries = metadataList
      .filter((m) => Array.isArray(m.messages) && m.messages.length > 0)
      .map((m) => ({ conversationId: m.id, messages: m.messages }));
    if (entries.length > 0) {
      await saveAllMessages(entries);
      // Strip messages from localStorage copy
      const stripped = metadataList.map((m) => {
        const { messages: _messages, ...rest } = m;
        return rest;
      });
      localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(stripped));
      localStorage.setItem(META_VERSION_KEY, '1');
    }
  } catch (err) {
    console.warn('[ClientStore] Legacy migration failed:', (err as Error).message);
  }
}

export function saveConversations(conversations: any[]): Promise<void> {
  const safe = Array.isArray(conversations) ? conversations : [];

  // Separate metadata (lightweight) from messages (heavy payload)
  const metadata = safe.map((conv) => {
    const { messages: _messages, ...rest } = conv;
    return rest;
  });
  const serialized = JSON.stringify(metadata);

  // Skip localStorage write if metadata unchanged, but always save messages to IndexedDB
  const metadataUnchanged = serialized === lastSavedSnapshot;

  // Debounce: cancel pending save and schedule new one
  if (persistTimer) clearTimeout(persistTimer);

  return new Promise((resolve, reject) => {
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      try {
        if (hasNativeBridge()) {
          // Electron path: keep existing behavior for now
          await (window as any).deepchat.conversations.save(safe);
        } else {
          // Browser path: metadata → localStorage, messages → IndexedDB
          if (!metadataUnchanged) {
            localStorage.setItem(CONVERSATIONS_KEY, serialized);
            lastSavedSnapshot = serialized;
          }
          await saveAllMessages(
            safe.map((c) => ({ conversationId: c.id, messages: c.messages || [] }))
          );
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    }, SAVE_DEBOUNCE_MS);
  });
}

export async function exportBackup(): Promise<any> {
  if (hasNativeBridge()) return (window as any).deepchat.conversations.exportBackup();
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

export async function importBackup(): Promise<any> {
  if (hasNativeBridge()) return (window as any).deepchat.conversations.importBackup();
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

export async function pickWorkspace(): Promise<any> {
  if (hasNativeBridge()) return (window as any).deepchat.workspace.pick();
  return getSettings();
}

export async function removeWorkspace(root: string): Promise<any> {
  if (hasNativeBridge()) return (window as any).deepchat.workspace.remove(root);
  const settings = getSettings();
  const roots = ((settings.workspaceRoots as string[]) || []).filter((item) => item !== root);
  return saveSettings({ workspaceRoots: roots });
}

export async function clearWorkspaceIndexCache(): Promise<any> {
  if (hasNativeBridge() && (window as any).deepchat.workspace.clearIndexCache) {
    return (window as any).deepchat.workspace.clearIndexCache();
  }
  return {
    ok: true,
    memoryCleared: false,
    diskEnabled: false,
    deletedFiles: 0,
    deletedBytes: 0,
  };
}

export async function pickExternalSkill(): Promise<any> {
  if (hasNativeBridge()) return (window as any).deepchat.skills.pickExternal();
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
          resolve(await saveSettings({ externalSkills: [...((settings.externalSkills as any[]) || []), skill] }));
        } catch (error) {
          reject(error);
        }
      },
      { once: true }
    );
    input.click();
  });
}

export async function listMcpStatus(): Promise<any[]> {
  if (!hasNativeBridge()) return [];
  return (window as any).deepchat.mcp.listStatus();
}

export function onMenuOpenSettings(callback: () => void): () => void {
  if (!hasNativeBridge()) return () => {};
  return (window as any).deepchat.menu.onOpenSettings(callback);
}

export function onMenuNewChat(callback: () => void): () => void {
  if (!hasNativeBridge()) return () => {};
  return (window as any).deepchat.menu.onNewChat(callback);
}

export function sanitizeSettingsForBackup(settings: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...(settings || {}) };
  delete copy.apiKey;
  delete copy.tavilyApiKey;
  if (Array.isArray(copy.mcpServers)) {
    copy.mcpServers = (copy.mcpServers as any[])
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

function sanitizeMcpArgs(args: unknown): string[] {
  const values = Array.isArray(args) ? (args as any[]).map(String) : [];
  return values.map((arg, index) => sanitizeMcpArg(arg, values[index - 1]));
}

function sanitizeMcpArg(arg: string, previousArg = ''): string {
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

function isSecretLikeArg(value: string): boolean {
  return /^(--?|\/)(api[-_]?key|token|secret|password|credential|auth|bearer)$/i.test(String(value || ''));
}

function looksLikeSecretValue(value: string): boolean {
  const text = String(value || '');
  return (
    /\b(sk-|tvly-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{6,}/i.test(text) ||
    /\bBearer\s+[A-Za-z0-9._-]{8,}/i.test(text) ||
    /\b[A-Z0-9_]*(API[-_]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*[^;\s]{4,}/i.test(text)
  );
}

function downloadJson(value: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
