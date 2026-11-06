import { expect, test, type Page } from '@playwright/test';

/**
 * Mobil-Durchgang Katalog (`vp-adminview-mobile-rework`): 390 px ist die
 * Haupt-Breite, 1440 px die Regressionsprobe. Die drei Unter-Reiter
 * (Gerätevorlagen, Steuerungs-Freigabe, Prognosemodelle) waren schon vorher
 * kompakt (Tabellen, `.vp-table.responsive`) - der einzige echte Befund war
 * das Wort-Budget der Gerätevorlagen-Erklärung (Konzept-Prüfregel, erster
 * Bildschirm ≤ 50 Wörter): sie zieht jetzt in einen `InfoTip` um.
 */
const PHONE = 390;
const DESKTOP = 1440;

async function keinUeberlauf(page: Page) {
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(1);
}

test('Gerätevorlagen bei 390 px: die lange Erklärung steht im InfoTip, nicht im Fließtext', async ({ page }) => {
  await page.setViewportSize({ width: PHONE, height: 844 });
  await page.goto('/e2e/katalog-bereich.html?sektion=vorlagen');
  await expect(page.getByRole('heading', { name: 'Gerätevorlagen' })).toBeVisible();
  // Kurzsatz sichtbar, die lange Erklärung erst nach dem Antippen.
  await expect(page.getByText('Eine geprüfte Vorlage ist ein Datensatz, kein Software-Update.')).toBeVisible();
  await expect(page.getByText('Eingebaute Vorlagen kommen aus dem')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mehr zu Gerätevorlagen' }).click();
  await expect(page.getByText(/Eingebaute Vorlagen kommen aus dem/)).toBeVisible();
  await keinUeberlauf(page);
});

test('Katalog-Reiter bei 390 px: kein Überlauf auf allen drei Unter-Reitern', async ({ page }) => {
  await page.setViewportSize({ width: PHONE, height: 844 });
  for (const sektion of ['vorlagen', 'modelle', 'prognose']) {
    await page.goto(`/e2e/katalog-bereich.html?sektion=${sektion}`);
    await page.waitForTimeout(150);
    await keinUeberlauf(page);
  }
});

test('Gerätevorlagen am Rechner (1440 px): Erklärung bleibt im Fließtext sichtbar (keine Verschlechterung)', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP, height: 900 });
  await page.goto('/e2e/katalog-bereich.html?sektion=vorlagen');
  await expect(page.getByText(/Eingebaute Vorlagen kommen aus dem/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Mehr zu Gerätevorlagen' }).click();
  await expect(page.getByText(/Eingebaute Vorlagen kommen aus dem/)).toBeVisible();
  await keinUeberlauf(page);
});
