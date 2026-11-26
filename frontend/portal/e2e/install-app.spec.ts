import { expect, test, type Page } from '@playwright/test';

/**
 * **Fernmeldung `vp-app-installieren`** - die Fläche „Als App auf diesem Gerät" auf dem
 * ECHTEN Gerät (`mobile-webkit` = iPhone/Safari-Rendering, `mobile-chromium` = Android/Chrome-
 * Rendering, siehe `playwright.config.ts`), nie nur im simulierten `installApp.test.ts`.
 *
 * Anlass (Captain-Screenshot `captain-screenshot.png`): ein Kunde in Chrome auf Android sah
 * „Dieser Browser bietet das Einrichten hier nicht an. Öffnen Sie VoltPilot … in Chrome
 * (Android) …" - eine falsche Behauptung, während er GENAU in Chrome auf Android saß. Dieser
 * Lauf prüft die Fläche in jedem der fünf Zustände aus `installApp.ts`, auf dem Gerät, dessen
 * `navigator.userAgent` sie wirklich liest.
 *
 * Nur `desktop-*`-Projekte werden übersprungen: die Fläche ist ein Telefon-Thema, und ihre
 * Browser-Erkennung unterscheidet nicht nach Bildschirmgröße.
 */

test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name.startsWith('desktop') || testInfo.project.name.startsWith('tablet'));
});

async function oeffnen(page: Page, query = '') {
  await page.goto(`/e2e/install-app.html${query}`);
  await page.locator('.vp-modal').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

const WRONG_CLAIM = /bietet das Einrichten hier nicht an/;

test('Android/Chrome ohne Angebot: Menü-Weg statt der falschen Behauptung (der Captain-Fall)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');
  await oeffnen(page);
  const ua = await page.evaluate(() => navigator.userAgent);
  expect(ua, 'diese Probe braucht ein echtes Android-Chrome-UA, sonst prüft sie nichts').toMatch(/Android.*Chrome\//);

  await expect(page.getByText(WRONG_CLAIM)).toHaveCount(0);
  await expect(page.getByText(/noch nicht von sich aus angeboten/)).toBeVisible();
  const schritte = page.locator('.vp-installapp-steps li');
  await expect(schritte).toHaveCount(2);
  await expect(schritte.nth(1)).toContainText(/App installieren|Startbildschirm/);
  await expect(page.getByRole('button', { name: 'App installieren' })).toHaveCount(0);

  await page.screenshot({ path: 'e2e/shots/install-app-android-ohne-angebot.png' });
});

test('Android/Chrome MIT Angebot: echter Knopf, der wirklich den Browser-Dialog ruft', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');
  await oeffnen(page, '?angebot=1');
  await expect(page.getByText(/eigenem Symbol auf Ihrem Startbildschirm/)).toBeVisible();
  const knopf = page.getByRole('button', { name: 'App installieren' });
  await expect(knopf).toBeVisible();
  await knopf.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __angebotGerufen?: boolean }).__angebotGerufen)).toBe(true);

  await page.screenshot({ path: 'e2e/shots/install-app-android-installierbar.png' });
});

test('installiert (jedes Gerät): nur der ruhige Satz, kein Angebot und kein Weg mehr', async ({ page }) => {
  await oeffnen(page, '?standalone=1');
  await expect(page.getByText('Sie nutzen VoltPilot bereits als App.')).toBeVisible();
  await expect(page.locator('.vp-installapp-hint')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'App installieren' })).toHaveCount(0);
});

test('iPhone/Safari: die Teilen-Anleitung, nie ein versprochener Dialog', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-webkit');
  await oeffnen(page);
  const ua = await page.evaluate(() => navigator.userAgent);
  expect(ua, 'diese Probe braucht ein echtes iPhone-UA').toMatch(/iPhone/);

  await expect(page.getByText(WRONG_CLAIM)).toHaveCount(0);
  const schritte = page.locator('.vp-installapp-steps li');
  await expect(schritte).toHaveCount(2);
  await expect(schritte.nth(0)).toContainText(/Teilen/);
  await expect(schritte.nth(1)).toContainText(/Home-Bildschirm/);
  await expect(page.getByRole('button', { name: 'App installieren' })).toHaveCount(0);

  await page.screenshot({ path: 'e2e/shots/install-app-iphone-anleitung.png' });
});

test('ein wirklich fremder Browser (Firefox/Android) behält zu Recht die alte Warnung', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/118.0 Firefox/118.0',
      configurable: true,
    });
  });
  await oeffnen(page);
  await expect(page.getByText(WRONG_CLAIM)).toBeVisible();
  await expect(page.getByText(/Chrome \(Android\) oder Safari \(iPhone\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'App installieren' })).toHaveCount(0);

  await page.screenshot({ path: 'e2e/shots/install-app-fremder-browser.png' });
});
