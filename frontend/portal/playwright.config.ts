import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Die Buehne vorher/nachher ist KEIN Fall des Gesamtlaufs: sie liest ihre
  // Aufnahme aus BUEHNE_ANTWORTEN und wirft beim Laden, wenn tools/buehne-vorher-nachher/run.sh
  // sie nicht gesetzt hat. Ohne diese Zeile bricht `npx playwright test` schon beim
  // Sammeln ab (0 Tests in 0 Dateien) - der komplette Lauf faende dann gar nichts mehr.
  testIgnore: process.env.BUEHNE_PHASE ? [] : ['buehne-vorher-nachher.spec.ts'],
  // Waermt den Entwicklungsserver einmal vor, damit nicht die erste
  // Zusicherung des Laufs die Vite-Uebersetzung bezahlt (siehe Datei).
  globalSetup: './playwright.global-setup.ts',
  fullyParallel: true,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4174',
    url: 'http://127.0.0.1:4174/e2e/edit-flow.html',
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'tablet-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1194 }, hasTouch: true } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
});
