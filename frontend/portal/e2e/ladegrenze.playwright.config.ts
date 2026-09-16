import { defineConfig, devices } from '@playwright/test';

/** Eigenständiger Port, damit die visuelle Abnahme parallel zu anderen UEMS-Bahnen laufen kann. */
export default defineConfig({
  testDir: '.',
  testMatch: 'ladegrenze.spec.ts',
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4184',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4184',
    url: 'http://127.0.0.1:4184/e2e/ladegrenze.html',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
