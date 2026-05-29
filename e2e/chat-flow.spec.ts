import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

test.describe('Chat Flow', () => {
  test('creating a new conversation', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#sidebar', { state: 'visible', timeout: 15_000 });

    const newChatBtn = window.locator('#new-chat-btn');
    await expect(newChatBtn).toBeVisible();
    await newChatBtn.click();

    // After clicking new chat, the welcome screen should remain visible
    const welcomeScreen = window.locator('#welcome-screen');
    await expect(welcomeScreen).toBeVisible();
  });

  test('typing in the composer', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#message-input', { state: 'visible', timeout: 15_000 });

    const composer = window.locator('#message-input');
    await composer.fill('Hello, this is a test message');

    await expect(composer).toHaveValue('Hello, this is a test message');
  });

  test('send button is visible', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#send-btn', { state: 'visible', timeout: 15_000 });

    const sendBtn = window.locator('#send-btn');
    await expect(sendBtn).toBeVisible();
  });
});
