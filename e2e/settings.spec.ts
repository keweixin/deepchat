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

  test('font typography preference toggles message reading mode', async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '..', 'electron.js')],
      env: {
        ...process.env,
        DEEPCHAT_DISABLE_GPU: '1',
      },
    });

    const window = await electronApp.firstWindow();
    await window.waitForSelector('#settings-btn', { state: 'visible', timeout: 15_000 });
    await window.evaluate(() => localStorage.removeItem('dc_font_serif'));

    await window.locator('#settings-btn').click();
    await window.waitForSelector('#settings-panel:not(.hidden)', { timeout: 5_000 });

    const sansButton = window.locator('#font-sans-btn');
    const serifButton = window.locator('#font-serif-btn');
    await expect(sansButton).toBeVisible();
    await expect(serifButton).toBeVisible();

    await serifButton.click();
    await expect(serifButton).toHaveClass(/active/);
    await expect(serifButton).toHaveAttribute('aria-pressed', 'true');
    await expect(window.locator('body')).toHaveClass(/use-serif/);
    await expect.poll(() => window.evaluate(() => localStorage.getItem('dc_font_serif'))).toBe('true');

    await sansButton.click();
    await expect(sansButton).toHaveClass(/active/);
    await expect(sansButton).toHaveAttribute('aria-pressed', 'true');
    await expect(window.locator('body')).not.toHaveClass(/use-serif/);
    await expect.poll(() => window.evaluate(() => localStorage.getItem('dc_font_serif'))).toBe('false');
  });
});
