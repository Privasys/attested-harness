import { defineConfig, devices } from '@playwright/test'

// Smoke tests run against the LIVE deployed harness (not a local build), so
// they double as a post-deploy health check. Override the target with
// E2E_HARNESS_URL.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure'
  }
})
