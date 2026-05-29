import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

test.describe('Settings', () => {
  test('opening settings panel', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#settings-btn', { state: 'visible', timeout: 15_000 });

    // Settings panel should be hidden initially
    const settingsPanel = window.locator('#settings-panel');
    await expect(settingsPanel).toHaveClass(/hidden/);

    // Click settings button
    const settingsBtn = window.locator('#settings-btn');
    await settingsBtn.click();

    // Settings panel should now be visible
    await expect(settingsPanel).not.toHaveClass(/hidden/);

    const settingsHeader = window.locator('.settings-header h2');
    await expect(settingsHeader).toHaveText('设置');
  });

  test('settings sections are rendered', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#settings-btn', { state: 'visible', timeout: 15_000 });

    // Open settings
    await window.locator('#settings-btn').click();
    await window.waitForSelector('#settings-panel:not(.hidden)', { timeout: 5_000 });

    // Verify key settings sections exist
    const sections = window.locator('.settings-section h3');
    const sectionTexts = await sections.allTextContents();

    expect(sectionTexts.length).toBeGreaterThan(0);
    expect(sectionTexts).toContain('API 配置');
  });
});
