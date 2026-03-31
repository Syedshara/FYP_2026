/**
 * Playwright configuration for FYP_2026 frontend E2E tests.
 *
 * Assumes the full dev stack is running:
 *   docker compose -f docker-compose.dev.yml up -d
 *
 * Frontend (Vite) at http://localhost:5173
 * Backend (FastAPI) at http://localhost:8000
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 600_000,           // 10 min per test — FL rounds take ~60s each
  expect: { timeout: 30_000 },
  fullyParallel: false,       // serial — tests share FL training state
  retries: 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
