import { contextBridge, ipcRenderer } from 'electron';

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('deepchat', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    migrateLegacy: (payload) => ipcRenderer.invoke('settings:migrateLegacy', payload),
    testApi: () => ipcRenderer.invoke('settings:testApi'),
    testSearch: (query) => ipcRenderer.invoke('settings:testSearch', query),
  },
  conversations: {
    load: () => ipcRenderer.invoke('conversations:load'),
    save: (conversations) => ipcRenderer.invoke('conversations:save', conversations),
    exportBackup: () => ipcRenderer.invoke('conversations:exportBackup'),
    importBackup: () => ipcRenderer.invoke('conversations:importBackup'),
  },
  chat: {
    start: (request) => ipcRenderer.send('chat:start', request),
    cancel: (requestId) => ipcRenderer.send('chat:cancel', requestId),
    onEvent: (callback) => on('chat:event', callback),
  },
  tools: {
    approve: (requestId, toolCallId, approved) =>
      ipcRenderer.send('tools:approve', { requestId, toolCallId, approved }),
    run: (name, args) => ipcRenderer.invoke('tools:runManual', { name, args }),
  },
  workspace: {
    pick: () => ipcRenderer.invoke('workspace:pick'),
    remove: (root) => ipcRenderer.invoke('workspace:remove', root),
    clearIndexCache: () => ipcRenderer.invoke('workspace:clearIndexCache'),
  },
  skills: {
    pickExternal: () => ipcRenderer.invoke('skills:pickExternal'),
  },
  mcp: {
    listStatus: () => ipcRenderer.invoke('mcp:listStatus'),
  },
  menu: {
    onOpenSettings: (callback) => on('menu:openSettings', callback),
    onNewChat: (callback) => on('menu:newChat', callback),
  },
});
