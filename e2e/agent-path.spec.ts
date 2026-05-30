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

test.beforeAll(async () => {
  // Start dynamic in-memory mock LLM provider
  server = http.createServer((req, res) => {
    console.log(`[E2E Mock Server] Request received: ${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      requestCount++;
      console.log(`[E2E Mock Server] Match: completions request #${requestCount}`);

      // Set headers for SSE (Server-Sent Events)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (requestCount === 1) {
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
        res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
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
        res.write(`data: ${JSON.stringify(finalAnswerChunk)}\n\n`);
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

  // Pre-configure settings.json targeting our local mock LLM provider
  const settings = {
    version: 1,
    settings: {
      providerId: 'custom',
      apiBase: `http://127.0.0.1:${port}/v1`,
      model: 'deepseek-chat',
      workspaceRoots: [path.resolve(__dirname, '..')],
      toolApprovalPolicy: 'confirm_all',
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
});
