import { contextBridge, ipcRenderer } from 'electron';
import type { ChatRequest } from './agent-contracts.js';
import type { Conversation, ExternalSkill, McpServerConfig, SettingsPatch } from '../src/types/deepchat.js';

/** Allowed IPC channels for renderer → main event listening. */
const VALID_ON_CHANNELS = ['chat:event', 'menu:openSettings', 'menu:newChat'] as const;
type ValidOnChannel = (typeof VALID_ON_CHANNELS)[number];
type IpcUnsubscribe = () => void;
type ChatEventPayload = Record<string, unknown>;
type BackupExportOptions = { includeSecrets?: boolean };
type ManualToolArgs = Record<string, unknown>;
type DocsetSearchPayload = { query: string; maxResults?: number };

function on<TPayload = unknown>(channel: string, callback: (payload: TPayload) => void): IpcUnsubscribe {
  if (!VALID_ON_CHANNELS.includes(channel as ValidOnChannel)) {
    console.warn(`[preload] Blocked unauthorized IPC channel: ${channel}`);
    return () => {};
  }
  const listener = (_event: Electron.IpcRendererEvent, payload: TPayload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('deepchat', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: SettingsPatch) => ipcRenderer.invoke('settings:set', patch),
    migrateLegacy: (payload: { settings?: SettingsPatch; conversations?: Conversation[] }) =>
      ipcRenderer.invoke('settings:migrateLegacy', payload),
    testApi: () => ipcRenderer.invoke('settings:testApi'),
    testSearch: (query: string) => ipcRenderer.invoke('settings:testSearch', query),
  },
  conversations: {
    load: () => ipcRenderer.invoke('conversations:load'),
    save: (conversations: Conversation[]) => ipcRenderer.invoke('conversations:save', conversations),
    exportBackup: (options?: BackupExportOptions) => ipcRenderer.invoke('conversations:exportBackup', options),
    importBackup: () => ipcRenderer.invoke('conversations:importBackup'),
  },
  chat: {
    start: (request: ChatRequest) => ipcRenderer.send('chat:start', request),
    cancel: (requestId: string) => ipcRenderer.send('chat:cancel', requestId),
    pause: (requestId: string) => ipcRenderer.send('chat:pause', requestId),
    resume: (requestId: string) => ipcRenderer.send('chat:resume', requestId),
    skipTool: (requestId: string, toolCallId?: string) => ipcRenderer.send('chat:skipTool', { requestId, toolCallId }),
    limitScope: (requestId: string, scopePolicy: string) =>
      ipcRenderer.send('chat:limitScope', { requestId, scopePolicy }),
    onEvent: (callback: (payload: ChatEventPayload) => void) => on('chat:event', callback),
  },
  tools: {
    approve: (requestId: string, toolCallId: string, approved: boolean) =>
      ipcRenderer.send('tools:approve', { requestId, toolCallId, approved }),
    run: (name: string, args: ManualToolArgs) => ipcRenderer.invoke('tools:runManual', { name, args }),
  },
  workspace: {
    pick: () => ipcRenderer.invoke('workspace:pick'),
    remove: (root: string) => ipcRenderer.invoke('workspace:remove', root),
    clearIndexCache: () => ipcRenderer.invoke('workspace:clearIndexCache'),
    getStats: () => ipcRenderer.invoke('workspace:getStats'),
  },
  skills: {
    pickExternal: () => ipcRenderer.invoke('skills:pickExternal'),
    scanExternal: () => ipcRenderer.invoke('skills:scanExternal'),
    importExternal: (payload: { skills: ExternalSkill[] }) => ipcRenderer.invoke('skills:importExternal', payload),
  },
  mcp: {
    listStatus: () => ipcRenderer.invoke('mcp:listStatus'),
    scanExternalConfigs: () => ipcRenderer.invoke('mcp:scanExternalConfigs'),
    importExternalConfigs: (payload: { servers: McpServerConfig[] }) =>
      ipcRenderer.invoke('mcp:importExternalConfigs', payload),
    probeExternalConfig: (payload: { server: McpServerConfig }) =>
      ipcRenderer.invoke('mcp:probeExternalConfig', payload),
  },
  docset: {
    list: () => ipcRenderer.invoke('docset:list'),
    add: (root?: string) => ipcRenderer.invoke('docset:add', root),
    remove: (root: string) => ipcRenderer.invoke('docset:remove', root),
    search: (payload: DocsetSearchPayload) => ipcRenderer.invoke('docset:search', payload),
  },
  menu: {
    onOpenSettings: (callback: () => void) => on('menu:openSettings', callback),
    onNewChat: (callback: () => void) => on('menu:newChat', callback),
  },
});
