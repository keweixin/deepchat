# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app-launch.spec.ts >> App Launch >> app window opens
- Location: e2e\app-launch.spec.ts:11:7

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
  10 | test.describe('App Launch', () => {
  11 |   test('app window opens', async () => {
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
  21 |     expect(window).toBeTruthy();
  22 |
  23 |     const title = await window.title();
  24 |     expect(title).toContain('DeepChat');
  25 |   });
  26 |
  27 |   test('welcome screen is visible', async () => {
  28 |     electronApp = await electron.launch({
  29 |       args: [path.join(__dirname, '..', 'electron.js')],
  30 |       env: {
  31 |         ...process.env,
  32 |         DEEPCHAT_DISABLE_GPU: '1',
  33 |       },
  34 |     });
  35 |
  36 |     const window = await electronApp.firstWindow();
  37 |     await window.waitForSelector('#welcome-screen', { state: 'visible', timeout: 15_000 });
  38 |
  39 |     const welcomeTitle = window.locator('.welcome-title');
  40 |     await expect(welcomeTitle).toBeVisible();
  41 |   });
  42 |
  43 |   test('sidebar is rendered', async () => {
  44 |     electronApp = await electron.launch({
  45 |       args: [path.join(__dirname, '..', 'electron.js')],
  46 |       env: {
  47 |         ...process.env,
  48 |         DEEPCHAT_DISABLE_GPU: '1',
  49 |       },
  50 |     });
  51 |
  52 |     const window = await electronApp.firstWindow();
  53 |     await window.waitForSelector('#sidebar', { state: 'visible', timeout: 15_000 });
  54 |
  55 |     const sidebar = window.locator('#sidebar');
  56 |     await expect(sidebar).toBeVisible();
  57 |
  58 |     const logo = window.locator('.logo-text');
  59 |     await expect(logo).toHaveText('DeepChat');
  60 |   });
  61 | });
  62 |
```
