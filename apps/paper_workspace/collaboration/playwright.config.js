import { defineConfig } from '@playwright/test'

const port = Number(process.env.PAPER_E2E_PORT || 18080)
const baseURL = process.env.PAPER_E2E_URL || `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: process.env.PAPER_E2E_URL ? undefined : {
    command: 'node dev-server.mjs',
    url: baseURL,
    cwd: import.meta.dirname,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
})
