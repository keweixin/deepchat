import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

test.describe('App Launch', () => {
  test('app window opens', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    expect(window).toBeTruthy();

    const title = await window.title();
    expect(title).toContain('DeepChat');
  });

  test('welcome screen is visible', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#welcome-screen', { state: 'visible', timeout: 15_000 });

    const welcomeTitle = window.locator('.welcome-title');
    await expect(welcomeTitle).toBeVisible();
  });

  test('sidebar is rendered', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#sidebar', { state: 'visible', timeout: 15_000 });

    const sidebar = window.locator('#sidebar');
    await expect(sidebar).toBeVisible();

    const logo = window.locator('.logo-text');
    await expect(logo).toHaveText('DeepChat');
  });
});
