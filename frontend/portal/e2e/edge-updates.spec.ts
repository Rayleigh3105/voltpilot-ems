import { expect, test, type Page } from '@playwright/test';

/**
 * Mobil-Durchgang Software (`vp-adminview-mobile-rework`): die Seite war
 * schon vor diesem Auftrag kompakt (zwei dichte Linien-Karten, „Verlauf"
 * schon als natives `<details>` zu) - dieser Lauf belegt nur, dass das bei
 * 390/1440 px so bleibt (kein Überlauf, der Raum-Reiter „Software" ist voll
 * sichtbar, „Verlauf" bleibt zu), ohne etwas Funktionierendes umzubauen.
 */
const PHONE = 390;
const DESKTOP = 1440;

async function keinUeberlauf(page: Page) {
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(1);
}

for (const breite of [PHONE, DESKTOP]) {
  test(`Software bei ${breite} px: Raum-Reiter sichtbar, beide Linien, Verlauf bleibt zu, kein Überlauf`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    await page.setViewportSize({ width: breite, height: breite === PHONE ? 844 : 900 });
    await page.goto('/e2e/edge-updates.html');
    await expect(page.getByRole('tab', { name: 'Software' })).toHaveAttribute('aria-selected', 'true');
    const reiter = page.getByRole('tab', { name: 'Software' }).boundingBox();
    const leiste = page.locator('.vp-geraete-tabs').boundingBox();
    const [r, l] = await Promise.all([reiter, leiste]);
    expect(r!.x).toBeGreaterThanOrEqual(l!.x - 1);
    expect(r!.x + r!.width).toBeLessThanOrEqual(l!.x + l!.width + 1);

    await expect(page.getByText('Docker-Box')).toBeVisible();
    await expect(page.getByText('Edge Light')).toBeVisible();
    const verlauf = page.locator('details', { hasText: 'Verlauf' });
    await expect(verlauf).not.toHaveAttribute('open', '');

    await keinUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}
