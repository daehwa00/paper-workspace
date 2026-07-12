import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: process.env.PAPER_E2E_URL || 'http://127.0.0.1:18080',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: process.env.PAPER_E2E_URL ? undefined : {
    command: 'node dev-server.mjs',
    url: 'http://127.0.0.1:18080',
    cwd: import.meta.dirname,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
})
