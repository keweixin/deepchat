import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

test.describe('Inspector Panel', () => {
  test('inspector panel toggle is visible', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#inspector-toggle-btn', { state: 'visible', timeout: 15_000 });

    const toggleBtn = window.locator('#inspector-toggle-btn');
    await expect(toggleBtn).toBeVisible();
  });

  test('inspector panel opens and closes', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#inspector-toggle-btn', { state: 'visible', timeout: 15_000 });

    const toggleBtn = window.locator('#inspector-toggle-btn');
    const panel = window.locator('#inspector-panel');

    await toggleBtn.click();
    await expect(panel).toBeVisible();

    await toggleBtn.click();
    await expect(panel).not.toBeVisible();
  });
});
