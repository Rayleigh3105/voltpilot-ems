import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'steuern-assistent.spec.ts',
  fullyParallel: false,
  reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:4198', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4198',
    url: 'http://127.0.0.1:4198/e2e/steuern-assistent.html',
    reuseExistingServer: false,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
