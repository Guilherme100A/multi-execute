import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const chrome = process.env.PLAYWRIGHT_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: 0,
  timeout: 240_000,
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    headless: false,
    viewport: { width: 1440, height: 1000 },
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
    screenshot: 'only-on-failure',
    trace: 'off', // Traces would retain authentication headers and prompt content.
  },
});
