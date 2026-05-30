# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: settings.spec.ts >> Settings >> opening settings panel
- Location: e2e\settings.spec.ts:11:7

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: electronApplication.firstWindow: Target page, context or browser has been closed
```

# Test source

```ts
  1  | import { test, expect, _electron as electron } from '@playwright/test';
  2  | import path from 'path';
  3  | 
  4  | let electronApp: Awaited<ReturnType<typeof electron.launch>>;
  5  | 
  6  | test.afterEach(async () => {
  7  |   if (electronApp) await electronApp.close();
  8  | });
  9  | 
  10 | test.describe('Settings', () => {
  11 |   test('opening settings panel', async () => {
  12 |     electronApp = await electron.launch({
  13 |       args: [path.join(__dirname, '..', 'electron.js')],
  14 |       env: {
  15 |         ...process.env,
  16 |         DEEPCHAT_DISABLE_GPU: '1',
  17 |       },
  18 |     });
  19 | 
> 20 |     const window = await electronApp.firstWindow();
     |                                      ^ Error: electronApplication.firstWindow: Target page, context or browser has been closed
  21 |     await window.waitForSelector('#settings-btn', { state: 'visible', timeout: 15_000 });
  22 | 
  23 |     // Settings panel should be hidden initially
  24 |     const settingsPanel = window.locator('#settings-panel');
  25 |     await expect(settingsPanel).toHaveClass(/hidden/);
  26 | 
  27 |     // Click settings button
  28 |     const settingsBtn = window.locator('#settings-btn');
  29 |     await settingsBtn.click();
  30 | 
  31 |     // Settings panel should now be visible
  32 |     await expect(settingsPanel).not.toHaveClass(/hidden/);
  33 | 
  34 |     const settingsHeader = window.locator('.settings-header h2');
  35 |     await expect(settingsHeader).toHaveText('设置');
  36 |   });
  37 | 
  38 |   test('settings sections are rendered', async () => {
  39 |     electronApp = await electron.launch({
  40 |       args: [path.join(__dirname, '..', 'electron.js')],
  41 |       env: {
  42 |         ...process.env,
  43 |         DEEPCHAT_DISABLE_GPU: '1',
  44 |       },
  45 |     });
  46 | 
  47 |     const window = await electronApp.firstWindow();
  48 |     await window.waitForSelector('#settings-btn', { state: 'visible', timeout: 15_000 });
  49 | 
  50 |     // Open settings
  51 |     await window.locator('#settings-btn').click();
  52 |     await window.waitForSelector('#settings-panel:not(.hidden)', { timeout: 5_000 });
  53 | 
  54 |     // Verify key settings sections exist
  55 |     const sections = window.locator('.settings-section h3');
  56 |     const sectionTexts = await sections.allTextContents();
  57 | 
  58 |     expect(sectionTexts.length).toBeGreaterThan(0);
  59 |     expect(sectionTexts).toContain('API 配置');
  60 |   });
  61 | });
  62 | 
```