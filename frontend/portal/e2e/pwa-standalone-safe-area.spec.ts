import { expect, test } from '@playwright/test';

/**
 * **Fernmeldung `vp-app-installieren` (iPhone-Nachlauf)** - Beleg, dass die Seite im
 * installierten Modus wirklich tut, was `Shell.css`/`shell.css` versprechen: das
 * Boden-Polster (`.vp-bottombar`, `padding-bottom: env(safe-area-inset-bottom, 0)`) wächst mit
 * einem echten, von Null verschiedenen Einzug, und `isStandalone()` (`src/installApp.ts`) - die
 * EINE Weiche, die auch entscheidet, ob die Anmeldung im `localStorage` bleibt (`auth.ts`,
 * `alsApp()`) - erkennt den installierten Zustand in einer echten Browser-Engine, nicht nur im
 * simulierten `installApp.test.ts`.
 *
 * Zwei echte, aber unterschiedliche Lücken der Automation, beide umschifft statt verschwiegen:
 *  - `env(safe-area-inset-*)` bleibt in JEDER Geräte-Emulation (auch "iPhone 13" in Playwright/
 *    WebKit) stur bei `0px` - weder WebKit noch eine `page.emulateMedia`-ähnliche API kennt dafür
 *    einen Schalter. Chromes CDP-Befehl `Emulation.setSafeAreaInsetsOverride` kann es aber
 *    erzwingen (geprüft 26.11.2026) - dieselbe `env()`-Regel läuft dann gegen einen echten,
 *    iPhone-typischen Einzug (59px oben/Notch, 34px unten/Home-Indicator), nur eben in Chromium.
 *  - `matchMedia('(display-mode: standalone)')` lässt sich über CDP NICHT erzwingen (geprüft:
 *    `Emulation.setEmulatedMedia` mit `display-mode` bleibt wirkungslos, anders als bei
 *    `prefers-color-scheme` - es spiegelt echtes Fenster-Chrome, keine reine Anzeige-Vorliebe).
 *    Apples EIGENER, zweiter Marker `navigator.standalone` dagegen ist eine gewöhnliche
 *    Eigenschaft und lässt sich per Skript setzen (`page.addInitScript`) - genau der Pfad, den
 *    `isStandalone()` für Safari zusätzlich abfragt. Das läuft deshalb auf `mobile-webkit`.
 */

test('installierter Modus: Boden-Polster wächst mit einem echten Einzug, nicht nur in der Theorie', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'CDP-Einzug-Override nur in Chromium');

  await page.setViewportSize({ width: 393, height: 852 }); // iPhone-14/15/16-Maße
  const cdp = await page.context().newCDPSession(page);
  // Dieselben Werte, die Chrome selbst für ein Gerät mit Notch + Home-Indicator ansetzt.
  await cdp.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 59, left: 0, bottom: 34, right: 0 },
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'display-mode', value: 'standalone' }],
  });

  await page.goto('/e2e/abweichungen.html');
  await page.locator('.vp-bottombar').first().waitFor();
  await page.evaluate(() => document.fonts.ready);

  const polster = await page
    .locator('.vp-bottombar')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
  // `env(safe-area-inset-bottom, 0)` pur wäre 34; die Leiste hat daneben kein zusätzliches
  // festes Polster - 34 ist also der korrekte, nicht nur ein plausibler Wert.
  expect(polster).toBeGreaterThanOrEqual(34);

  await page.screenshot({ path: 'e2e/shots/pwa-standalone-bottombar-safe-area.png' });
});

test('installierter Modus auf dem iPhone: `isStandalone()` erkennt Apples echten Marker in WebKit selbst', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-webkit', 'navigator.standalone ist Apples eigener, nur dort echter Marker');

  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'standalone', { value: true, configurable: true });
  });

  await page.goto('/e2e/install-app.html');
  await page.locator('.vp-modal').waitFor();
  await page.evaluate(() => document.fonts.ready);

  const ua = await page.evaluate(() => navigator.userAgent);
  expect(ua, 'diese Probe braucht ein echtes iPhone-UA').toMatch(/iPhone/);

  // `isStandalone()` (`src/installApp.ts`) ist dieselbe Funktion, die `auth.ts` (`alsApp()`)
  // befragt, bevor es entscheidet, ob Tokens den App-Neustart überleben (`localStorage`) oder
  // mit dem Tab sterben (`sessionStorage`) - geprüft über ihre einzig sichtbare Wirkung (den
  // Satz unten), NIE über einen zweiten, frischen Modul-Import: der lädt in dieser Vite-
  // Entwicklungsumgebung über Vites HMR-Übernahme den gesamten Einstieg ein zweites Mal nach.
  await expect(page.getByText('Sie nutzen VoltPilot bereits als App.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'App installieren' })).toHaveCount(0);
});
