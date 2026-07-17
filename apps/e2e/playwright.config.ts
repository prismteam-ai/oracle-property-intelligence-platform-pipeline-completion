import { defineConfig, devices } from '@playwright/test';

import { evaluatorTargetConfiguration } from './support/target.js';

const target = evaluatorTargetConfiguration();

export default defineConfig({
  testDir: './tests',
  outputDir: 'test-results',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: target.target === 'hosted' ? 1 : 0,
  workers: target.target === 'hosted' ? 2 : 1,
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  timeout: target.target === 'hosted' ? 30_000 : 15_000,
  expect: { timeout: target.target === 'hosted' ? 10_000 : 5_000 },
  use: {
    baseURL: target.baseURL,
    actionTimeout: 5_000,
    navigationTimeout: target.target === 'hosted' ? 15_000 : 8_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'evaluator-desktop',
      testIgnore: /responsive\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'responsive-mobile-375',
      testMatch: /responsive\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 } },
    },
    {
      name: 'responsive-tablet',
      testMatch: /responsive\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'responsive-desktop',
      testMatch: /responsive\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'responsive-mobile-landscape',
      testMatch: /responsive\.spec\.ts/u,
      use: { ...devices['Desktop Chrome'], viewport: { width: 812, height: 375 } },
    },
  ],
  ...(target.startLocalServer
    ? {
        webServer: [
          {
            command:
              'pnpm --filter @oracle/web build && pnpm --filter @oracle/web exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
            cwd: '../..',
            url: target.baseURL,
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
          },
          {
            command: 'node --experimental-strip-types support/local-health-server.ts',
            url: `${target.apiBaseURL}/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 10_000,
          },
        ],
      }
    : {}),
});
