import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
});

async function openWorkbenchSettings(window: any) {
  const settingsButton = window.locator('#workbench-rail-settings-btn');
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  await expect(window.locator('#app')).toHaveClass(/settings-active/);
  await expect(window.locator('#settings-dashboard')).toBeVisible();
}

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
    await openWorkbenchSettings(window);

    const settingsHeader = window.locator('.settings-dashboard-title');
    await expect(settingsHeader).toHaveText('设置与控制台');
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
    await openWorkbenchSettings(window);
    await window.locator('.sub-item[data-settings-section="section-provider"]').click();

    // Verify key settings sections exist
    const sections = window.locator('#settings-forms-container .settings-section h3');
    const sectionTexts = await sections.allTextContents();

    expect(sectionTexts.length).toBeGreaterThan(0);
    expect(sectionTexts).toContain('API 配置');
    await expect(window.locator('#section-provider')).toBeVisible();
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
    await window.evaluate(() => localStorage.removeItem('dc_font_serif'));

    await openWorkbenchSettings(window);
    await window.locator('.sub-item[data-settings-section="section-appearance"]').click();

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
