import { expect, test, type Page } from '@playwright/test';

/**
 * Die Glocke im Kopf (Alerting Scheibe 1, Konzept §6.8, Entscheid 4A) bei 390 und 1440 px auf der
 * Bühne `startansicht` - die ECHTE Schale, dieselbe Bühne wie `messstellen.spec.ts`. Die Bühne
 * stellt eine ungesehene Warnung auf Halle 1 (`AL-2026-000123`), siehe `startansicht.tsx`
 * `MELDUNGEN_BUEHNE`.
 *
 * Nur die Glocke: `startansicht.tsx` ist eine eigene, schlanke Nachbildung der Schale mit ihrem
 * EIGENEN kleinen Router (nicht `App.tsx` selbst) und kennt `#/meldungen` darum nicht als Seite -
 * das Meldungs-Center selbst ist über `npm run typecheck`, `npm run build`
 * (Bündel-Grenze, `test/bundle-smoke.sh`) und `src/meldungen.test.ts` geprüft.
 *
 * GEMESSEN, nicht behauptet: Querlauf des Dokuments (`scrollWidth − clientWidth`), Konsole sauber.
 */

async function oeffne(page: Page, breite: number) {
  const fehler: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') fehler.push(msg.text());
  });
  page.on('pageerror', (e) => fehler.push(String(e)));
  await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
  await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=messstellen');
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  return fehler;
}

function querlauf(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const breite of [390, 1440] as const) {
  test(`Glocke zeigt die ungesehene Meldung, kein Querlauf, Konsole sauber bei ${breite}px`, async ({ page }) => {
    const fehler = await oeffne(page, breite);

    const glocke = page.getByRole('button', { name: /^Meldungen/ });
    await expect(glocke).toBeVisible();
    await expect(glocke.locator('.vp-glocke-zahl')).toHaveText('1');
    await expect(glocke).not.toHaveClass(/dringend/);

    expect(await querlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });
}
