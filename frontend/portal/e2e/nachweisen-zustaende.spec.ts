import { expect, test, type Page } from '@playwright/test';

/**
 * Zustände des Überblicks von Nachweisen, die ein Ladefehler erzeugt (Review Nachweisen r1, P1-2), bei 375 und 1440 px
 * auf der Bühne `e2e/energiemanagement.html` am 12.02.2029: ohne Wiedervorlage sagt die Zählerzeile „Fristen nicht
 * geladen“ - kein „Keine Frist überfällig“ und kein geratenes „Als Nächstes“ -, und der Chip passt in die Zeile.
 */

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(new Date('2029-02-12T14:00:00+01:00'));
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/energiemanagement.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

for (const breite of [375, 1440]) {
  test(`ohne Wiedervorlage bei ${breite} px: „Fristen nicht geladen · Erneut versuchen“, kein „Als Nächstes“, kein Querlauf`, async ({ page }) => {
    await oeffne(page, 'lage=ahrenberg&wv=fehler', breite);
    const chip = page.getByTestId('zaehler-fristen-fehler');
    await expect(chip).toHaveText('Fristen nicht geladen · Erneut versuchen');
    await expect(page.getByTestId('zaehler-ruhig')).toHaveCount(0);
    await expect(page.getByTestId('ueberblick-naechstes')).toHaveCount(0);
    await expect(page.getByTestId('demnaechst-leer')).toHaveText('Die Fristen ließen sich gerade nicht laden.');
    const mass = await page.evaluate(() => {
      const c = document.querySelector('[data-testid="zaehler-fristen-fehler"]')!.getBoundingClientRect();
      const zeile = document.querySelector('[data-testid="ueberblick-zaehler"]')!.getBoundingClientRect();
      return { querlauf: document.documentElement.scrollWidth - window.innerWidth, rechts: c.right, zeileRechts: zeile.right, hoehe: c.height };
    });
    expect(mass.querlauf).toBeLessThanOrEqual(0);
    expect(mass.rechts).toBeLessThanOrEqual(mass.zeileRechts + 0.5);
    expect(mass.hoehe).toBeGreaterThanOrEqual(40);
  });
}
