import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let server: http.Server;
let port: number;
let requestCount = 0;
let testUserDataDir: string;
let testWorkspaceDir: string;
let editTargetPath: string;

test.beforeAll(async () => {
  // Start dynamic in-memory mock LLM provider
  server = http.createServer(async (req, res) => {
    console.log(`[E2E Mock Server] Request received: ${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      requestCount++;
      console.log(`[E2E Mock Server] Match: completions request #${requestCount}`);
      const bodyText = await readRequestBody(req);
      const body = safeJsonParse(bodyText) || {};
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const isEditTurn =
        bodyText.includes('E2E_WRITE_TARGET') ||
        bodyText.includes('E2E_WRITE_DENY_TARGET') ||
        bodyText.includes('E2E_WRITE_TIMEOUT_TARGET');
      const isDeniedOrTimedOut = bodyText.includes('用户拒绝执行工具') || bodyText.includes('自动拒绝');
      const hasToolResult = messages.some((message: any) => message?.role === 'tool');

      // Set headers for SSE (Server-Sent Events)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (isEditTurn && !hasToolResult) {
        const toolCallChunk = {
          choices: [
            {
              delta: {
                role: 'assistant',
                content: '我会先生成写入预览，等待确认后再修改临时工作区文件。',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_edit_e2e_target',
                    type: 'function',
                    function: {
                      name: 'edit_file',
                      arguments: JSON.stringify({
                        path: editTargetPath,
                        search: 'world',
                        replace: bodyText.includes('E2E_WRITE_DENY_TARGET')
                          ? 'DeniedShouldNotWrite'
                          : bodyText.includes('E2E_WRITE_TIMEOUT_TARGET')
                            ? 'TimeoutShouldNotWrite'
                            : 'DeepChatE2E',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        };
        writeSseChunk(res, toolCallChunk);
        res.write('data: [DONE]\n\n');
        res.end();
      } else if (isEditTurn) {
        const finalAnswerChunk = {
          choices: [
            {
              delta: {
                role: 'assistant',
                content: isDeniedOrTimedOut
                  ? '写入已取消，没有修改文件。'
                  : '写入完成，已修改临时文件，并保留了可恢复的备份证据。',
              },
            },
          ],
        };
        writeSseChunk(res, finalAnswerChunk);
        res.write('data: [DONE]\n\n');
        res.end();
      } else if (!hasToolResult) {
        // First request: return the tool call to read package.json
        const toolCallChunk = {
          choices: [
            {
              delta: {
                role: 'assistant',
                content: '我将为您分析当前项目，首先读取项目根目录的 package.json 文件。',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_read_package_json',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: 'package.json' }),
                    },
                  },
                ],
              },
            },
          ],
        };
        writeSseChunk(res, toolCallChunk);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        // Second request (after tool execution result is submitted): return final answer
        const finalAnswerChunk = {
          choices: [
            {
              delta: {
                role: 'assistant',
                content:
                  '分析完成！这是一个包含 Electron、TypeScript、Vite 和 Playwright 的现代 AI 桌面端项目。项目配置非常完善，拥有严格的代码规范和全套 E2E 测试。',
              },
            },
          ],
        };
        writeSseChunk(res, finalAnswerChunk);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as any;
      port = address.port;
      resolve();
    });
  });

  // Setup isolated temporary user data directory
  testUserDataDir = path.join(os.tmpdir(), `deepchat-e2e-test-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
  fs.mkdirSync(path.join(testUserDataDir, 'data'), { recursive: true });
  testWorkspaceDir = path.join(testUserDataDir, 'workspace');
  fs.mkdirSync(testWorkspaceDir, { recursive: true });
  editTargetPath = path.join(testWorkspaceDir, 'e2e-edit-target.md');
  fs.writeFileSync(editTargetPath, 'alpha\nworld\nomega\n', 'utf8');

  // Pre-configure settings.json targeting our local mock LLM provider
  const settings = {
    version: 1,
    settings: {
      providerId: 'custom',
      apiBase: `http://127.0.0.1:${port}/v1`,
      model: 'deepseek-chat',
      workspaceRoots: [path.resolve(__dirname, '..'), testWorkspaceDir],
      toolApprovalPolicy: 'confirm_all',
      toolApprovalTimeoutMs: 5000,
    },
  };
  fs.writeFileSync(path.join(testUserDataDir, 'data', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
});

test.afterAll(async () => {
  // Clean up server
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Clean up temp directory
  try {
    fs.rmSync(testUserDataDir, { recursive: true, force: true });
  } catch (err) {
    console.error('Failed to clean up temp user data directory:', err);
  }
});

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

test.describe('Agent Path End-To-End Integration', () => {
  test('runs full agent loop: user prompt -> tool call -> manual approval -> tool execution -> final response', async () => {
    // Launch Electron app using the isolated user data directory
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
        DEEPCHAT_TEST_USER_DATA_DIR: testUserDataDir,
        NODE_ENV: 'development',
      },
    });

    electronApp.process().stdout?.on('data', (data) => {
      console.log(`[Electron Stdout] ${data.toString().trim()}`);
    });
    electronApp.process().stderr?.on('data', (data) => {
      console.error(`[Electron Stderr] ${data.toString().trim()}`);
    });

    const window = await electronApp.firstWindow();
    expect(window).toBeTruthy();

    window.on('console', (msg) => {
      console.log(`[Browser Console] ${msg.type()}: ${msg.text()}`);
    });
    window.on('pageerror', (err) => {
      console.error(`[Browser PageError] ${err.message}`);
    });

    // 1. Wait for Sidebar and Composer to load
    await window.waitForSelector('#sidebar', { state: 'visible', timeout: 15_000 });
    await window.waitForSelector('#message-input', { state: 'visible', timeout: 15_000 });

    // 2. Switch to 'agent' mode in Composer to support full tool calls
    const modeSelect = window.locator('#composer-mode-select');
    await expect(modeSelect).toBeVisible();
    await modeSelect.selectOption('agent');
    await expect(modeSelect).toHaveValue('agent');

    // 3. Type "分析当前项目" and click send button
    const composer = window.locator('#message-input');
    await composer.fill('分析当前项目');
    await expect(composer).toHaveValue('分析当前项目');

    const sendBtn = window.locator('#send-btn');
    await expect(sendBtn).toBeVisible();
    await sendBtn.click();

    // 4. Wait for the tool approval block to appear
    await window.waitForSelector('.tool-approve-btn', { state: 'visible', timeout: 15_000 });
    const approveBtn = window.locator('.tool-approve-btn');
    await expect(approveBtn).toBeVisible();
    await expect(approveBtn).toHaveText('确认执行');

    // 5. Click the approval button to execute the tool
    await approveBtn.click();

    // 6. Wait for the assistant message streaming loop to finish
    // Since send button gains 'hidden' class during streaming, we wait for it to become visible again
    await expect(sendBtn).not.toHaveClass(/hidden/, { timeout: 30_000 });

    // 7. Verify the final assistant response text
    const messageList = window.locator('#chat-messages');
    await expect(messageList).toContainText('分析完成');
    await expect(messageList).toContainText('Electron');

    // 8. Open Inspector via custom event directly in 'message' mode for assistant message
    await window.evaluate(() => {
      document.dispatchEvent(new CustomEvent('deepchat:open-inspector', { detail: { mode: 'message', msgIndex: 1 } }));
    });

    const inspectorPanel = window.locator('#right-inspector-panel');
    await expect(inspectorPanel).toBeVisible();

    // Verify toolbar buttons are visible
    const messageTab = inspectorPanel.locator('.inspector-toolbar-btn[data-mode="message"]');
    await expect(messageTab).toBeVisible();

    // The inspector panel should render the tool evidence and trace steps
    await expect(inspectorPanel).toContainText('read_file');
    await expect(inspectorPanel).toContainText('package.json');
  });

  test('runs edit_file path: preview -> approval -> write -> backup restore', async () => {
    fs.writeFileSync(editTargetPath, 'alpha\nworld\nomega\n', 'utf8');
    fs.rmSync(path.join(testUserDataDir, 'data', 'file-backups'), { recursive: true, force: true });

    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
        DEEPCHAT_TEST_USER_DATA_DIR: testUserDataDir,
        NODE_ENV: 'development',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#sidebar', { state: 'visible', timeout: 15_000 });
    await window.waitForSelector('#message-input', { state: 'visible', timeout: 15_000 });

    const modeSelect = window.locator('#composer-mode-select');
    await modeSelect.selectOption('agent');
    await expect(modeSelect).toHaveValue('agent');

    const composer = window.locator('#message-input');
    await composer.fill('请把 E2E_WRITE_TARGET 里的 world 改成 DeepChatE2E');
    const sendBtn = window.locator('#send-btn');
    await sendBtn.click();

    await window.waitForSelector('.tool-approve-btn', { state: 'visible', timeout: 15_000 });
    const editPreview = window.locator('.tool-edit-preview').filter({ hasText: '写入预览' }).last();
    await expect(editPreview).toContainText('写入预览');
    await expect(editPreview).toContainText('唯一匹配');
    await expect(window.locator('.tool-security-meta').filter({ hasText: '临时文件重命名' })).toBeVisible();
    expect(fs.readFileSync(editTargetPath, 'utf8')).toBe('alpha\nworld\nomega\n');

    await window.locator('.tool-approve-btn').click();
    await expect(sendBtn).not.toHaveClass(/hidden/, { timeout: 30_000 });
    await expect(window.locator('#chat-messages')).toContainText('写入完成');
    expect(fs.readFileSync(editTargetPath, 'utf8')).toBe('alpha\nDeepChatE2E\nomega\n');

    const backupPath = await waitForBackupFile(path.basename(editTargetPath));
    expect(fs.readFileSync(backupPath, 'utf8')).toBe('alpha\nworld\nomega\n');
    fs.copyFileSync(backupPath, editTargetPath);
    expect(fs.readFileSync(editTargetPath, 'utf8')).toBe('alpha\nworld\nomega\n');
  });

  test('does not write when the user denies an edit_file approval', async () => {
    fs.writeFileSync(editTargetPath, 'alpha\nworld\nomega\n', 'utf8');
    fs.rmSync(path.join(testUserDataDir, 'data', 'file-backups'), { recursive: true, force: true });

    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
        DEEPCHAT_TEST_USER_DATA_DIR: testUserDataDir,
        NODE_ENV: 'development',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#sidebar', { state: 'visible', timeout: 15_000 });
    await window.waitForSelector('#message-input', { state: 'visible', timeout: 15_000 });

    await window.locator('#composer-mode-select').selectOption('agent');
    await window.locator('#message-input').fill('请把 E2E_WRITE_DENY_TARGET 里的 world 改成 DeniedShouldNotWrite');
    const sendBtn = window.locator('#send-btn');
    await sendBtn.click();

    await window.waitForSelector('.tool-deny-btn', { state: 'visible', timeout: 15_000 });
    await expect(window.locator('.tool-edit-preview').filter({ hasText: '写入预览' }).last()).toContainText('写入预览');
    expect(fs.readFileSync(editTargetPath, 'utf8')).toBe('alpha\nworld\nomega\n');

    await window.locator('.tool-deny-btn').click();
    await expect(sendBtn).not.toHaveClass(/hidden/, { timeout: 30_000 });
    await expect(window.locator('#chat-messages')).toContainText('写入已取消');
    expect(fs.readFileSync(editTargetPath, 'utf8')).toBe('alpha\nworld\nomega\n');
    expect(findBackupFile(path.join(testUserDataDir, 'data', 'file-backups'), path.basename(editTargetPath))).toBe('');
  });

  test('auto-denies edit_file after approval timeout without writing', async () => {
    fs.writeFileSync(editTargetPath, 'alpha\nworld\nomega\n', 'utf8');
    fs.rmSync(path.join(testUserDataDir, 'data', 'file-backups'), { recursive: true, force: true });

    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
        DEEPCHAT_TEST_USER_DATA_DIR: testUserDataDir,
        NODE_ENV: 'development',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#sidebar', { state: 'visible', timeout: 15_000 });
    await window.waitForSelector('#message-input', { state: 'visible', timeout: 15_000 });

    await window.locator('#composer-mode-select').selectOption('agent');
    await window.locator('#message-input').fill('请把 E2E_WRITE_TIMEOUT_TARGET 里的 world 改成 TimeoutShouldNotWrite');
    const sendBtn = window.locator('#send-btn');
    await sendBtn.click();

    await window.waitForSelector('.tool-approve-btn', { state: 'visible', timeout: 15_000 });
    await expect(window.locator('.tool-edit-preview').filter({ hasText: '写入预览' }).last()).toContainText('写入预览');
    expect(fs.readFileSync(editTargetPath, 'utf8')).toBe('alpha\nworld\nomega\n');

    await expect(sendBtn).not.toHaveClass(/hidden/, { timeout: 45_000 });
    await expect(window.locator('#chat-messages')).toContainText('写入已取消');
    expect(fs.readFileSync(editTargetPath, 'utf8')).toBe('alpha\nworld\nomega\n');
    expect(findBackupFile(path.join(testUserDataDir, 'data', 'file-backups'), path.basename(editTargetPath))).toBe('');
  });
});

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeSseChunk(res: http.ServerResponse, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function waitForBackupFile(targetBaseName: string): Promise<string> {
  const roots = [path.join(testUserDataDir, 'data', 'file-backups'), path.join(os.tmpdir(), 'deepchat-file-backups')];
  for (let attempt = 0; attempt < 50; attempt++) {
    for (const root of roots) {
      const found = findBackupFile(root, targetBaseName);
      if (found) return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backup file not found for ${targetBaseName}`);
}

function findBackupFile(root: string, targetBaseName: string): string {
  if (!fs.existsSync(root)) return '';
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findBackupFile(fullPath, targetBaseName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.startsWith(`${targetBaseName}.`) && entry.name.endsWith('.bak')) {
      return fullPath;
    }
  }
  return '';
}
