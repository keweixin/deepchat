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

    const textarea = window.locator('#message-input');
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

  test('composer chip toggle expands and collapses chip row', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#composer-chip-toggle', { state: 'visible', timeout: 15_000 });

    const chipToggle = window.locator('#composer-chip-toggle');
    await expect(chipToggle).toBeVisible();

    // Chip row should be collapsed initially
    const chipRow = window.locator('.composer-chip-row');
    await expect(chipRow).not.toBeVisible();

    // Click toggle to expand
    await chipToggle.click();
    await expect(chipRow).toBeVisible();

    const chips = window.locator('.composer-context-chip');
    const count = await chips.count();
    expect(count).toBeGreaterThan(0);

    // Click toggle again to collapse
    await chipToggle.click();
    await expect(chipRow).not.toBeVisible();
  });

  test('composer mode select changes active mode', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#composer-mode-select', { state: 'visible', timeout: 15_000 });

    const modeSelect = window.locator('#composer-mode-select');
    await expect(modeSelect).toBeVisible();

    // Should default to 'daily'
    await expect(modeSelect).toHaveValue('daily');

    // Change to 'project' mode
    await modeSelect.selectOption('project');
    await expect(modeSelect).toHaveValue('project');

    // Change to 'agent' mode
    await modeSelect.selectOption('agent');
    await expect(modeSelect).toHaveValue('agent');
  });
});
