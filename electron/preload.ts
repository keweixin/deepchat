import { contextBridge, ipcRenderer } from 'electron';

/** Allowed IPC channels for renderer → main event listening. */
const VALID_ON_CHANNELS = ['chat:event', 'menu:openSettings', 'menu:newChat'] as const;

function on(channel: string, callback: (payload: any) => void) {
  if (!VALID_ON_CHANNELS.includes(channel as any)) {
    console.warn(`[preload] Blocked unauthorized IPC channel: ${channel}`);
    return () => {};
  }
  const listener = (_event: any, payload: any) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('deepchat', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: any) => ipcRenderer.invoke('settings:set', patch),
    migrateLegacy: (payload: any) => ipcRenderer.invoke('settings:migrateLegacy', payload),
    testApi: () => ipcRenderer.invoke('settings:testApi'),
    testSearch: (query: any) => ipcRenderer.invoke('settings:testSearch', query),
  },
  conversations: {
    load: () => ipcRenderer.invoke('conversations:load'),
    save: (conversations: any) => ipcRenderer.invoke('conversations:save', conversations),
    exportBackup: (options?: any) => ipcRenderer.invoke('conversations:exportBackup', options),
    importBackup: () => ipcRenderer.invoke('conversations:importBackup'),
  },
  chat: {
    start: (request: any) => ipcRenderer.send('chat:start', request),
    cancel: (requestId: any) => ipcRenderer.send('chat:cancel', requestId),
    pause: (requestId: any) => ipcRenderer.send('chat:pause', requestId),
    resume: (requestId: any) => ipcRenderer.send('chat:resume', requestId),
    skipTool: (requestId: any, toolCallId: any) => ipcRenderer.send('chat:skipTool', { requestId, toolCallId }),
    limitScope: (requestId: any, scopePolicy: any) => ipcRenderer.send('chat:limitScope', { requestId, scopePolicy }),
    onEvent: (callback: any) => on('chat:event', callback),
  },
  tools: {
    approve: (requestId: any, toolCallId: any, approved: any) =>
      ipcRenderer.send('tools:approve', { requestId, toolCallId, approved }),
    run: (name: any, args: any) => ipcRenderer.invoke('tools:runManual', { name, args }),
  },
  workspace: {
    pick: () => ipcRenderer.invoke('workspace:pick'),
    remove: (root: any) => ipcRenderer.invoke('workspace:remove', root),
    clearIndexCache: () => ipcRenderer.invoke('workspace:clearIndexCache'),
    getStats: () => ipcRenderer.invoke('workspace:getStats'),
  },
  skills: {
    pickExternal: () => ipcRenderer.invoke('skills:pickExternal'),
  },
  mcp: {
    listStatus: () => ipcRenderer.invoke('mcp:listStatus'),
  },
  menu: {
    onOpenSettings: (callback: any) => on('menu:openSettings', callback),
    onNewChat: (callback: any) => on('menu:newChat', callback),
  },
});
