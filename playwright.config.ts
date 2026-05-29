import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  projects: [
    {
      name: 'electron',
      use: {},
    },
  ],
  globalSetup: undefined,
  // Electron-specific launch is handled in each test via _electron.launch
});
