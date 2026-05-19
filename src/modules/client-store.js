import { hasNativeBridge, getSettings, saveSettings } from './api.js';

const CONVERSATIONS_KEY = 'dc_conversations';

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
    settings: stripSecrets(getSettings()),
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
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve({ canceled: true });
        return;
      }
      try {
        const parsed = JSON.parse(await file.text());
        if (parsed.settings) await saveSettings(stripSecrets(parsed.settings));
        if (Array.isArray(parsed.conversations)) await saveConversations(parsed.conversations);
        resolve({ canceled: false });
      } catch (error) {
        reject(error);
      }
    }, { once: true });
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

export async function pickExternalSkill() {
  if (hasNativeBridge()) return window.deepchat.skills.pickExternal();
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,text/markdown,text/plain';
    input.addEventListener('change', async () => {
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
    }, { once: true });
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

function stripSecrets(settings) {
  const copy = { ...(settings || {}) };
  delete copy.apiKey;
  delete copy.tavilyApiKey;
  delete copy.mcpServers;
  delete copy.storageStatus;
  return copy;
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
