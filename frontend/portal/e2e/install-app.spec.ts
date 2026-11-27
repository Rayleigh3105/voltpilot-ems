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
 * Jede gerät-/browser-erkennende Probe (Android-, iPhone-, iPad-, Firefox-Fälle) überspringt
 * `desktop-*`/`tablet-*` selbst (`test.skip(testInfo.project.name !== …)`): die Erkennung ist ein
 * Telefon-Thema. Der `installiert`-Fall (Kunden-Fall „mehrere Geräte", Konzept
 * `vp-app-mehrere-geraete`) betrifft dagegen JEDES Gerät - genau der Rechner aus dem
 * Kunden-Screenshot war `desktop-chromium` - und läuft deshalb ungekürzt auf allen vier Projekten.
 */

async function oeffnen(page: Page, query = '') {
  await page.goto(`/e2e/install-app.html${query}`);
  await page.locator('.vp-modal').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function mitUserAgent(page: Page, ua: string) {
  await page.addInitScript((wert) => {
    Object.defineProperty(window.navigator, 'userAgent', { value: wert, configurable: true });
  }, ua);
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
  await expect(schritte.nth(0)).toContainText(/Menü/);
  // Das Symbol sitzt MITTEN im Satz ("auf [Symbol] Menü"), nicht als eigene Zeile davor.
  await expect(schritte.nth(0).locator('.vp-installapp-step-icon')).toHaveCount(1);
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

test('installiert (jedes Gerät, auch der Rechner): kein Angebot mehr FÜR DIESES Gerät, aber auch kein totes Ende', async ({
  page,
}, testInfo) => {
  await oeffnen(page, '?standalone=1');
  await expect(page.getByText('Sie nutzen VoltPilot bereits als App.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'App installieren' })).toHaveCount(0);

  // Kein totes Ende: Link und QR-Code aufs WEITERE Gerät - derselbe Fall wie im Kunden-Screenshot
  // (ein Windows-Rechner, auf dem „Sie nutzen VoltPilot bereits als App." bisher das letzte Wort war).
  await expect(page.getByText('Auf einem weiteren Gerät installieren')).toBeVisible();
  const link = await page.evaluate(() => window.location.origin);
  await expect(page.getByText(link)).toBeVisible();
  await expect(page.getByRole('img', { name: `QR-Code: ${link}` })).toBeVisible();
  // Ein Satz für BEIDE Wege, ohne das andere Gerät zu kennen.
  await expect(page.getByText(/Home-Bildschirm/)).toBeVisible();
  await expect(page.getByText(/Browser-Menü/)).toBeVisible();

  if (testInfo.project.name === 'desktop-chromium' || testInfo.project.name === 'mobile-webkit') {
    await page.screenshot({ path: `e2e/shots/install-app-weiteres-geraet-${testInfo.project.name}.png` });
  }
});

test('installiert: „Kopieren" legt den Link in die Zwischenablage, statt ihn nur zu zeigen', async ({
  page,
  context,
  browserName,
}) => {
  // Chromium verweigert `navigator.clipboard.writeText` ohne diese Erlaubnis (auch bei einem
  // echten Klick); WebKit kennt die Berechtigung gar nicht erst - dort geht Schreiben per
  // Nutzer-Geste ohnehin ohne Nachfrage.
  if (browserName === 'chromium') await context.grantPermissions(['clipboard-write', 'clipboard-read']);
  await oeffnen(page, '?standalone=1');
  const link = await page.evaluate(() => window.location.origin);
  await page.getByRole('button', { name: 'Kopieren' }).click();
  await expect(page.getByRole('button', { name: 'Kopiert' })).toBeVisible();
  const zwischenablage = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (zwischenablage != null) expect(zwischenablage).toBe(link);
});

test('iPhone/Safari: die Teilen-Anleitung, nie ein versprochener Dialog', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-webkit');
  await oeffnen(page);
  const ua = await page.evaluate(() => navigator.userAgent);
  expect(ua, 'diese Probe braucht ein echtes iPhone-UA').toMatch(/iPhone/);

  await expect(page.getByText(WRONG_CLAIM)).toHaveCount(0);
  const schritte = page.locator('.vp-installapp-steps li');
  await expect(schritte).toHaveCount(2);
  await expect(schritte.nth(0)).toContainText(/Tippen Sie unten auf/);
  await expect(schritte.nth(0)).toContainText(/Teilen\. Sehen Sie nur/);
  await expect(schritte.nth(0)).toContainText(/tippen Sie zuerst darauf/);
  // Zwei Symbole MITTEN im Satz (Teilen UND das Menü, das es ggf. versteckt) - nicht als
  // eigene Zeile davor.
  await expect(schritte.nth(0).locator('.vp-installapp-step-icon')).toHaveCount(2);
  await expect(schritte.nth(1)).toContainText(/Home-Bildschirm/);
  await expect(page.getByRole('button', { name: 'App installieren' })).toHaveCount(0);

  await page.screenshot({ path: 'e2e/shots/install-app-iphone-anleitung.png' });
});

test('ein wirklich fremder Browser (Firefox/Android) behält zu Recht die alte Warnung', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium');
  await mitUserAgent(page, 'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/118.0 Firefox/118.0');
  await oeffnen(page);
  await expect(page.getByText(WRONG_CLAIM)).toBeVisible();
  await expect(page.getByText(/Chrome \(Android\) oder Safari \(iPhone\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'App installieren' })).toHaveCount(0);

  await page.screenshot({ path: 'e2e/shots/install-app-fremder-browser.png' });
});

test('iPad/Safari: Teilen sitzt oben am Bildschirm - eine einzige, eindeutige Lage', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-webkit');
  // Echtes iPadOS-13+-Verhalten: meldet sich als „Macintosh", unterscheidbar nur über
  // Berührungspunkte (`isIPad`/`isIos` in `installApp.ts`) - dieselbe UA-Form wie ein iPad.
  await mitUserAgent(page, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.5 Safari/605.1.15');
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'maxTouchPoints', { value: 5, configurable: true });
    Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
  });
  await oeffnen(page);

  await expect(page.getByText(WRONG_CLAIM)).toHaveCount(0);
  const schritte = page.locator('.vp-installapp-steps li');
  await expect(schritte.nth(0)).toContainText(/Tippen Sie oben auf/);
  await expect(schritte.nth(0)).toContainText(/Teilen\./);
  await expect(schritte.nth(0).locator('.vp-installapp-step-icon')).toHaveCount(1);
  await expect(page.getByText(/wie eine App statt nur als Lesezeichen/)).toBeVisible();

  await page.screenshot({ path: 'e2e/shots/install-app-ipad-anleitung.png' });
});

test('Chrome auf iPhone: Teilen sitzt oben an der Adressleiste, nicht unten in einer Browser-Leiste', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-webkit');
  // Reales Chrome-iOS-UA (CriOS) - Apple zwingt es auf WebKit, aber mit eigener Oberfläche.
  await mitUserAgent(
    page,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1',
  );
  await oeffnen(page);

  await expect(page.getByText(WRONG_CLAIM)).toHaveCount(0);
  const schritte = page.locator('.vp-installapp-steps li');
  await expect(schritte.nth(0)).toContainText(/Adressleiste auf/);
  await expect(schritte.nth(0)).toContainText(/Teilen\./);
  await expect(schritte.nth(0).locator('.vp-installapp-step-icon')).toHaveCount(1);
  // Der iOS-26-Schalter ist eine Safari-eigene Fläche - in Chrome gibt es ihn nicht.
  await expect(page.getByText(/wie eine App statt nur als Lesezeichen/)).toHaveCount(0);

  await page.screenshot({ path: 'e2e/shots/install-app-chrome-ios-anleitung.png' });
});
