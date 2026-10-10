import { defineConfig } from '@playwright/test';
const port = '54195';
export default defineConfig({ testDir: '.', testMatch: ['unterstuetzung.spec.ts', 'benutzer.spec.ts', 'startpasswort.spec.ts'], workers: 1,
  outputDir: '/tmp/vp-uems-r03-unterstuetzung-portal/playwright', reporter: 'line',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, trace: 'off' },
  webServer: { command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory /tmp/vp-uems-r03-unterstuetzung-portal/e2e`,
    url: `http://127.0.0.1:${port}/e2e/unterstuetzung.html`, reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
});
