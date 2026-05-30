import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

test.describe('Production Smoke Test', () => {
  test('launches successfully in production mode', async () => {
    // Launch Electron app in production mode
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
        NODE_ENV: 'production',
      },
    });

    const window = await electronApp.firstWindow();
    expect(window).toBeTruthy();

    const title = await window.title();
    expect(title).toContain('DeepChat');

    // Verify preload IPC works and DOM loads successfully
    await window.waitForSelector('#welcome-screen', { state: 'visible', timeout: 15_000 });
    const welcomeTitle = window.locator('.welcome-title');
    await expect(welcomeTitle).toBeVisible();

    const sidebar = window.locator('#sidebar');
    await expect(sidebar).toBeVisible();
  });
});
