import { app, BrowserWindow, Menu, shell, ipcMain, session, dialog } from 'electron';
import path from 'path';

if (process.env.DEEPCHAT_TEST_USER_DATA_DIR) {
  app.setPath('userData', process.env.DEEPCHAT_TEST_USER_DATA_DIR);
}
import {
  getSettings,
  setSettings,
  loadConversations,
  saveConversations,
  migrateLegacy,
  pickWorkspaceRoot,
  removeWorkspaceRoot,
  exportBackup,
  importBackup,
} from './storage.js';
import { mergeSkills, pickExternalSkill, scanExternalSkills } from './external-skills.js';
import { ChatService, testApiConnection } from './chat-service.js';
import { executeTool, clearWorkspaceIndexDiskCache, getWorkspaceIndexModule } from './tools.js';
import { McpManager } from './mcp-manager.js';
import { validate, schemas, summarizeChatStartForLog } from './ipc-validation.js';
import { warmBuiltinSkills } from './system-prompt.ts';
import { configureDefaultJobRuntime, defaultJobRuntime } from './job-runtime.js';
import { createSqliteJobStore } from './job-stores.js';
import { scanExternalMcpConfigs, serverFingerprint } from './external-mcp-configs.js';
import { listDocsets, searchDocsets, validateDocsetRoot } from './docset-search.js';

if (process.env.DEEPCHAT_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | null;
let chatService: InstanceType<typeof ChatService> | null;
let mcpManager: InstanceType<typeof McpManager> | null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'DeepChat',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload:
        process.env.NODE_ENV === 'development'
          ? path.join(__dirname, '..', 'dist-electron', 'preload.js')
          : path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#10161a',
    show: false,
  });

  mainWindow!.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  mainWindow!.once('ready-to-show', () => {
    mainWindow!.show();
  });

  mainWindow!.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow!.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigation(url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });

  mainWindow!.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  configureDefaultJobRuntime(createSqliteJobStore(path.join(app.getPath('userData'), 'data', 'deepchat-jobs.sqlite')));
  chatService = new ChatService(() => mainWindow);
  mcpManager = new McpManager();

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_event, patch) =>
    setSettings(validate(schemas.SettingsPatchSchema, patch, 'settings:set'))
  );
  ipcMain.handle('settings:migrateLegacy', (_event, payload) =>
    migrateLegacy(validate(schemas.MigrateLegacySchema, payload, 'settings:migrateLegacy'))
  );
  ipcMain.handle('settings:testApi', async () => testApiConnection());
  ipcMain.handle('settings:testSearch', async (_event, query) => {
    const safeQuery = validate(schemas.TestSearchSchema, query, 'settings:testSearch');
    const settings = await getSettings();
    const output = await executeTool('web_search', { query: safeQuery || 'DeepChat test', max_results: 3 }, settings);
    return { ok: true, output };
  });

  ipcMain.handle('conversations:load', () => loadConversations());
  ipcMain.handle('conversations:save', (_event, conversations) =>
    saveConversations(validate(schemas.ConversationsSaveSchema, conversations, 'conversations:save'))
  );
  ipcMain.handle('conversations:exportBackup', (_event, options) => {
    if (!mainWindow) throw new Error('主窗口未初始化');
    return exportBackup(mainWindow, options);
  });
  ipcMain.handle('conversations:importBackup', () => {
    if (!mainWindow) throw new Error('主窗口未初始化');
    return importBackup(mainWindow);
  });

  ipcMain.handle('workspace:pick', () => {
    if (!mainWindow) throw new Error('主窗口未初始化');
    return pickWorkspaceRoot(mainWindow);
  });
  ipcMain.handle('workspace:remove', (_event, root) =>
    removeWorkspaceRoot(validate(schemas.WorkspaceRemoveSchema, root, 'workspace:remove'))
  );
  ipcMain.handle('workspace:clearIndexCache', async () => {
    const settings = await getSettings();
    return clearWorkspaceIndexDiskCache(settings);
  });
  ipcMain.handle('workspace:getStats', async () => {
    const indexMod = getWorkspaceIndexModule();
    if (indexMod) {
      try {
        return indexMod.getWorkspaceStats();
      } catch (err) {
        console.error('[Main] getWorkspaceStats failed:', err);
      }
    }
    return { fileCount: 0, chunkCount: 0, symbolCount: 0 };
  });
  ipcMain.handle('skills:pickExternal', async () => {
    const settings = await getSettings();
    return pickExternalSkill(mainWindow, settings, setSettings);
  });
  ipcMain.handle('skills:scanExternal', async () => {
    const settings = await getSettings();
    return scanExternalSkills(settings);
  });
  ipcMain.handle('skills:importExternal', async (_event, payload) => {
    const safePayload = validate(schemas.ExternalSkillImportSchema, payload, 'skills:importExternal');
    const settings = await getSettings();
    const externalSkills = mergeSkills(settings.externalSkills || [], safePayload.skills);
    return setSettings({ externalSkills });
  });
  ipcMain.handle('mcp:listStatus', async () => {
    const settings = await getSettings();
    return mcpManager!.listStatus(settings);
  });
  ipcMain.handle('mcp:scanExternalConfigs', async () => {
    const settings = await getSettings();
    if (settings.externalMcpDiscoveryEnabled === false) {
      return { candidates: [], warnings: ['外部 MCP 配置发现已在设置中关闭。'] };
    }
    return scanExternalMcpConfigs(settings);
  });
  ipcMain.handle('mcp:importExternalConfigs', async (_event, payload) => {
    const safePayload = validate(schemas.ExternalMcpImportSchema, payload, 'mcp:importExternalConfigs');
    const settings = await getSettings();
    const imported = mergeImportedMcpServers(settings.mcpServers || [], safePayload.servers);
    const next = await setSettings({ mcpServers: imported });
    mcpManager!.refreshToolDefinitions();
    return next;
  });
  ipcMain.handle('mcp:probeExternalConfig', async (_event, payload) => {
    const safePayload = validate(schemas.ExternalMcpProbeSchema, payload, 'mcp:probeExternalConfig');
    return probeMcpConfig(safePayload.server);
  });
  ipcMain.handle('docset:list', async () => {
    const settings = await getSettings();
    return listDocsets(settings);
  });
  ipcMain.handle('docset:add', async (_event, root) => {
    let selected = typeof root === 'string' && root.trim() ? root.trim() : '';
    if (!selected) {
      if (!mainWindow) throw new Error('主窗口未初始化');
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择 Docset 目录',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return getSettings();
      selected = result.filePaths[0];
    }
    const safeRoot = validate(schemas.DocsetRootSchema, selected, 'docset:add');
    const info = validateDocsetRoot(safeRoot);
    const settings = await getSettings();
    const roots = [...new Set([...(settings.docsetRoots || []), info.root])];
    return setSettings({ docsetRoots: roots, docsetSearchEnabled: true });
  });
  ipcMain.handle('docset:remove', async (_event, root) => {
    const safeRoot = validate(schemas.DocsetRootSchema, root, 'docset:remove');
    const resolved = path.resolve(safeRoot);
    const settings = await getSettings();
    const roots = (settings.docsetRoots || []).filter((item: string) => path.resolve(item) !== resolved);
    return setSettings({ docsetRoots: roots });
  });
  ipcMain.handle('docset:search', async (_event, payload) => {
    const safePayload = validate(schemas.DocsetSearchSchema, payload, 'docset:search');
    const settings = await getSettings();
    return searchDocsets(safePayload.query, settings, { maxResults: safePayload.maxResults });
  });

  ipcMain.on('chat:start', (_event, request) => {
    console.log(`[IPC chat:start] Received request:`, summarizeChatStartForLog(request));
    try {
      chatService!.start(validate(schemas.ChatStartSchema, request, 'chat:start'));
    } catch (error) {
      console.error(`[IPC chat:start] Validation/Start Error:`, error);
      emitChatValidationError(request?.requestId, error);
    }
  });
  ipcMain.on('chat:cancel', (_event, requestId) => {
    try {
      chatService!.cancel(validate(schemas.RequestIdSchema, requestId, 'chat:cancel'));
    } catch {
      // Invalid cancel payloads should not crash the main process.
    }
  });
  ipcMain.on('chat:pause', (_event, requestId) => {
    try {
      chatService!.pause(validate(schemas.RequestIdSchema, requestId, 'chat:pause'));
    } catch {
      // Ignore invalid payloads.
    }
  });
  ipcMain.on('chat:resume', (_event, requestId) => {
    try {
      chatService!.resume(validate(schemas.RequestIdSchema, requestId, 'chat:resume'));
    } catch {
      // Ignore invalid payloads.
    }
  });
  ipcMain.on('chat:skipTool', (_event, payload) => {
    try {
      const safePayload = validate(schemas.ToolSkipSchema, payload, 'chat:skipTool');
      chatService!.skipTool(safePayload.requestId, safePayload.toolCallId);
    } catch {
      // Ignore invalid payloads.
    }
  });
  ipcMain.on('chat:limitScope', (_event, payload) => {
    try {
      const safePayload = validate(schemas.LimitScopeSchema, payload, 'chat:limitScope');
      chatService!.limitScope(safePayload.requestId, safePayload.scopePolicy);
    } catch {
      // Ignore invalid payloads.
    }
  });
  ipcMain.on('tools:approve', (_event, payload) => {
    try {
      const safePayload = validate(schemas.ToolApprovalSchema, payload, 'tools:approve');
      chatService!.approve(safePayload.requestId, safePayload.toolCallId, safePayload.approved);
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

function mergeImportedMcpServers(existingServers: any[], importedServers: any[]) {
  const merged = Array.isArray(existingServers) ? [...existingServers] : [];
  const seen = new Set(merged.map((server) => server.externalConfigFingerprint || serverFingerprint(server)));
  for (const server of importedServers) {
    const fingerprint = server.externalConfigFingerprint || serverFingerprint(server);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    merged.push({
      ...server,
      id: server.id || `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      externalConfigFingerprint: fingerprint,
      enabled: server.enabled !== false,
    });
  }
  return merged.slice(0, 20);
}

async function probeMcpConfig(server: any) {
  const job = defaultJobRuntime.createJob({
    id: `job_mcp_probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    toolName: 'mcp_probe',
    args: { id: server.id, name: server.name, command: server.command },
    timeoutMs: 15000,
  });
  let statuses: any[] = [];
  try {
    await defaultJobRuntime.runJob(
      job.id,
      async (signal) => {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const manager = new McpManager();
        try {
          statuses = await manager.listStatus({ mcpServers: [{ ...server, enabled: true }] });
          return JSON.stringify(statuses).slice(0, 4000);
        } finally {
          await manager.closeAll();
        }
      },
      { timeoutMs: 15000 }
    );
    return {
      ok: statuses.some((item) => item?.ok === true),
      statuses,
      job: serializeJob(defaultJobRuntime.getJob(job.id)),
    };
  } catch (error) {
    return {
      ok: false,
      error: normalizeProbeError(error),
      statuses,
      job: serializeJob(defaultJobRuntime.getJob(job.id)),
    };
  }
}

function serializeJob(job: any) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    timeoutMs: job.timeoutMs,
    stale: job.stale,
    orphaned: job.orphaned,
    error: job.error,
  };
}

function normalizeProbeError(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error || 'MCP 探测失败');
}

function sendMenuEvent(channel: string) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel);
}

const menuTemplate: Electron.MenuItemConstructorOptions[] = [
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
      ...(isDevToolsAllowed() ? [{ label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' as const }] : []),
    ],
  },
];

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: https:",
            "font-src 'self' data:",
            "connect-src 'self' https:",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-src 'self' blob:",
          ].join('; '),
        ],
      },
    });
  });
  await warmBuiltinSkills();
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

function emitChatValidationError(requestId: string, error: any) {
  const safeRequestId = typeof requestId === 'string' && requestId.length <= 160 ? requestId : '';
  if (!safeRequestId || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('chat:event', {
    requestId: safeRequestId,
    type: 'error',
    message: error?.message || 'chat:start 入参无效',
  });
}

function isAllowedAppNavigation(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') {
      const filePath = path.normalize(decodeURIComponent(parsed.pathname));
      const resolvedPath = filePath.replace(/^\/([A-Za-z]:\/)/, '$1');
      return resolvedPath.startsWith(path.normalize(__dirname));
    }
    if (process.env.NODE_ENV === 'development' && /^https?:$/.test(parsed.protocol)) {
      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    }
  } catch {}
  return false;
}

function isSafeExternalUrl(url: string) {
  return /^(https?:|mailto:)/i.test(String(url || ''));
}

function isDevToolsAllowed() {
  return process.env.NODE_ENV === 'development' || process.env.DEEPCHAT_ENABLE_DEVTOOLS === '1';
}
