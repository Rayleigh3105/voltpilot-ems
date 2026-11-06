import { expect, test, type Page } from '@playwright/test';

/**
 * Mobil-Durchgang Kundenakte (`vp-adminview-mobile-rework`): 390 px ist die
 * Haupt-Breite des Auftrags, 1440 px die Regressionsprobe.
 */
const PHONE = 390;
const DESKTOP = 1440;

async function keinUeberlauf(page: Page) {
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(1);
}

test('Kundenakte bei 390 px: Anlagen und Boxen/Vertrag beginnen zu, mit Urteil - Personen bleibt offen', async ({ page }) => {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.setViewportSize({ width: PHONE, height: 844 });
  await page.goto('/e2e/mandanten-akte.html');
  await page.waitForSelector('.vp-kundenakte');

  // Primär: Personen bleibt eine offene Karte - die Namen stehen ohne Klick da.
  await expect(page.getByText('Felix Diekmann')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Personen/ })).toBeVisible();

  // Sekundär: Anlagen und Boxen / Vertrag beginnen zu, tragen aber das Urteil.
  const anlagen = page.locator('details', { hasText: 'Anlagen und Boxen' });
  await expect(anlagen).not.toHaveAttribute('open', '');
  await expect(anlagen).toContainText('2 Anlagen');
  const vertrag = page.locator('details', { hasText: 'Vertrag' });
  await expect(vertrag).not.toHaveAttribute('open', '');
  await expect(vertrag).toContainText('aktiv');

  // Antippen öffnet - der Inhalt ist nicht verloren.
  await anlagen.locator('summary').click();
  await expect(anlagen).toHaveAttribute('open', '');
  await expect(anlagen).toContainText('Werk Nord');
  await expect(anlagen).toContainText('Anlage anlegen');

  await keinUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('Kundenakte bei 390 px: beendeter Vertrag trägt „beendet" als Urteil', async ({ page }) => {
  await page.setViewportSize({ width: PHONE, height: 844 });
  await page.goto('/e2e/mandanten-akte.html?vertrag=beendet');
  await page.waitForSelector('.vp-kundenakte');
  const vertrag = page.locator('details', { hasText: 'Vertrag' });
  await expect(vertrag).toContainText('beendet');
  await keinUeberlauf(page);
});

test('Kundenakte am Rechner (1440 px): Anlagen und Boxen/Vertrag bleiben offene Karten (keine Verschlechterung)', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP, height: 900 });
  await page.goto('/e2e/mandanten-akte.html');
  await page.waitForSelector('.vp-kundenakte');
  await expect(page.locator('details')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Anlagen und Boxen/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vertrag' })).toBeVisible();
  await expect(page.getByText('Werk Nord')).toBeVisible();
  await keinUeberlauf(page);
});
