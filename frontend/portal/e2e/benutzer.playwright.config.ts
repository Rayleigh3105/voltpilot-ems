import { defineConfig } from '@playwright/test';
const port = '54193';
export default defineConfig({ testDir: '.', testMatch: ['benutzer.spec.ts', 'startpasswort.spec.ts'], workers: 1,
  outputDir: '/tmp/vp-uems-r03-benutzerverwaltung/playwright', reporter: 'line',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, trace: 'off' },
  webServer: { command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory /tmp/vp-uems-r03-benutzerverwaltung/e2e`,
    url: `http://127.0.0.1:${port}/e2e/benutzer.html`, reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
});
