const { app, BrowserWindow, Menu, shell, ipcMain, session } = require('electron');
const path = require('path');
const {
  getSettings,
  setSettings,
  loadConversations,
  saveConversations,
  migrateLegacy,
  pickWorkspaceRoot,
  removeWorkspaceRoot,
  exportBackup,
  importBackup,
} = require('./electron/storage');
const { pickExternalSkill } = require('./electron/external-skills');
const { ChatService, testApiConnection } = require('./electron/chat-service');
const { executeTool } = require('./electron/tools');
const { McpManager } = require('./electron/mcp-manager');
const { validate, schemas } = require('./electron/ipc-validation');

if (process.env.DEEPCHAT_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

let mainWindow;
let chatService;
let mcpManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepChat',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#10161a',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigation(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  chatService = new ChatService(() => mainWindow);
  mcpManager = new McpManager();

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_event, patch) => setSettings(validate(schemas.SettingsPatchSchema, patch, 'settings:set')));
  ipcMain.handle('settings:migrateLegacy', (_event, payload) => migrateLegacy(validate(schemas.MigrateLegacySchema, payload, 'settings:migrateLegacy')));
  ipcMain.handle('settings:testApi', async () => testApiConnection());
  ipcMain.handle('settings:testSearch', async (_event, query) => {
    const safeQuery = validate(schemas.TestSearchSchema, query, 'settings:testSearch');
    const settings = await getSettings();
    const output = await executeTool('web_search', { query: safeQuery || 'DeepChat test', max_results: 3 }, settings);
    return { ok: true, output };
  });

  ipcMain.handle('conversations:load', () => loadConversations());
  ipcMain.handle('conversations:save', (_event, conversations) => saveConversations(validate(schemas.ConversationsSaveSchema, conversations, 'conversations:save')));
  ipcMain.handle('conversations:exportBackup', () => exportBackup(mainWindow));
  ipcMain.handle('conversations:importBackup', () => importBackup(mainWindow));

  ipcMain.handle('workspace:pick', () => pickWorkspaceRoot(mainWindow));
  ipcMain.handle('workspace:remove', (_event, root) => removeWorkspaceRoot(validate(schemas.WorkspaceRemoveSchema, root, 'workspace:remove')));
  ipcMain.handle('skills:pickExternal', async () => {
    const settings = await getSettings();
    return pickExternalSkill(mainWindow, settings, setSettings);
  });
  ipcMain.handle('mcp:listStatus', async () => {
    const settings = await getSettings();
    return mcpManager.listStatus(settings);
  });

  ipcMain.on('chat:start', (_event, request) => {
    try {
      chatService.start(validate(schemas.ChatStartSchema, request, 'chat:start'));
    } catch (error) {
      emitChatValidationError(request?.requestId, error);
    }
  });
  ipcMain.on('chat:cancel', (_event, requestId) => {
    try {
      chatService.cancel(validate(schemas.RequestIdSchema, requestId, 'chat:cancel'));
    } catch {
      // Invalid cancel payloads should not crash the main process.
    }
  });
  ipcMain.on('tools:approve', (_event, payload) => {
    try {
      const safePayload = validate(schemas.ToolApprovalSchema, payload, 'tools:approve');
      chatService.approve(safePayload.requestId, safePayload.toolCallId, safePayload.approved);
    } catch {
      // Renderer-originated invalid approvals are ignored at the trust boundary.
    }
  });
  ipcMain.handle('tools:runManual', async (_event, payload = {}) => {
    const settings = await getSettings();
    const safePayload = validate(schemas.RunManualToolSchema, payload, 'tools:runManual');
    return executeTool(safePayload.name, safePayload.args || {}, settings);
  });
}

function sendMenuEvent(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
}

const menuTemplate = [
  {
    label: 'DeepChat',
    submenu: [
      { label: '关于 DeepChat', role: 'about' },
      { type: 'separator' },
      { label: '设置', accelerator: 'CmdOrCtrl+,', click: () => sendMenuEvent('menu:openSettings') },
      { type: 'separator' },
      { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
    ],
  },
  {
    label: '编辑',
    submenu: [
      { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
      { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
      { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
      { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
      { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
    ],
  },
  {
    label: '视图',
    submenu: [
      { label: '新建对话', accelerator: 'CmdOrCtrl+N', click: () => sendMenuEvent('menu:newChat') },
      { type: 'separator' },
      { label: '放大', accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
      { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
      { label: '重置缩放', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
      { type: 'separator' },
      { label: '全屏', accelerator: 'F11', role: 'togglefullscreen' },
      ...(isDevToolsAllowed() ? [{ label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' }] : []),
    ],
  },
];

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  registerIpc();
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  createWindow();
});

app.on('window-all-closed', () => {
  mcpManager?.closeAll();
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

function emitChatValidationError(requestId, error) {
  const safeRequestId = typeof requestId === 'string' && requestId.length <= 160 ? requestId : '';
  if (!safeRequestId || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('chat:event', {
    requestId: safeRequestId,
    type: 'error',
    message: error?.message || 'chat:start 入参无效',
  });
}

function isAllowedAppNavigation(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return true;
    if (process.env.NODE_ENV === 'development' && /^https?:$/.test(parsed.protocol)) {
      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    }
  } catch {}
  return false;
}

function isSafeExternalUrl(url) {
  return /^(https?:|mailto:)/i.test(String(url || ''));
}

function isDevToolsAllowed() {
  return process.env.NODE_ENV === 'development' || process.env.DEEPCHAT_ENABLE_DEVTOOLS === '1';
}
