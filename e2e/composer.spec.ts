import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

test.describe('Composer', () => {
  test('composer input is visible and can receive text', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#composer', { state: 'visible', timeout: 15_000 });

    const composer = window.locator('#composer');
    await expect(composer).toBeVisible();

    const textarea = window.locator('#composer-textarea');
    await expect(textarea).toBeVisible();
    await textarea.fill('Hello DeepChat');
    await expect(textarea).toHaveValue('Hello DeepChat');
  });

  test('composer advanced options toggle works', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#composer-advanced-toggle', { state: 'visible', timeout: 15_000 });

    const toggle = window.locator('#composer-advanced-toggle');
    await expect(toggle).toBeVisible();

    const advancedOptions = window.locator('#composer-advanced-options');
    // Advanced options should be collapsed initially
    await expect(advancedOptions).not.toBeVisible();

    await toggle.click();
    await expect(advancedOptions).toBeVisible();
  });

  test('composer context chips are visible', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('.composer-chip-row', { state: 'visible', timeout: 15_000 });

    const chips = window.locator('.composer-context-chip');
    const count = await chips.count();
    expect(count).toBeGreaterThan(0);
  });
});
