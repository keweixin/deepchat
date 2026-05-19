const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
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

app.disableHardwareAcceleration();

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  chatService = new ChatService(() => mainWindow);
  mcpManager = new McpManager();

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_event, patch) => setSettings(patch));
  ipcMain.handle('settings:migrateLegacy', (_event, payload) => migrateLegacy(payload));
  ipcMain.handle('settings:testApi', async () => testApiConnection());
  ipcMain.handle('settings:testSearch', async (_event, query) => {
    const settings = await getSettings();
    const output = await executeTool('web_search', { query: query || 'DeepChat test', max_results: 3 }, settings);
    return { ok: true, output };
  });

  ipcMain.handle('conversations:load', () => loadConversations());
  ipcMain.handle('conversations:save', (_event, conversations) => saveConversations(conversations));
  ipcMain.handle('conversations:exportBackup', () => exportBackup(mainWindow));
  ipcMain.handle('conversations:importBackup', () => importBackup(mainWindow));

  ipcMain.handle('workspace:pick', () => pickWorkspaceRoot(mainWindow));
  ipcMain.handle('workspace:remove', (_event, root) => removeWorkspaceRoot(root));
  ipcMain.handle('skills:pickExternal', async () => {
    const settings = await getSettings();
    return pickExternalSkill(mainWindow, settings, setSettings);
  });
  ipcMain.handle('mcp:listStatus', async () => {
    const settings = await getSettings();
    return mcpManager.listStatus(settings);
  });

  ipcMain.on('chat:start', (_event, request) => chatService.start(request));
  ipcMain.on('chat:cancel', (_event, requestId) => chatService.cancel(requestId));
  ipcMain.on('tools:approve', (_event, payload) => {
    chatService.approve(payload.requestId, payload.toolCallId, payload.approved);
  });
  ipcMain.handle('tools:runManual', async (_event, payload = {}) => {
    const settings = await getSettings();
    const name = String(payload.name || '').trim();
    if (name !== 'run_code') throw new Error('手动工具执行仅支持 run_code。');
    return executeTool(name, payload.args || {}, settings);
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
      { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' },
    ],
  },
];

app.whenReady().then(() => {
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
