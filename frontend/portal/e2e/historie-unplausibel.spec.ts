import { expect, test } from '@playwright/test';
import { join } from 'node:path';

const captureDir = process.env.VOLTPILOT_CAPTURE_DIR;

async function oeffnen(page: import('@playwright/test').Page, quote: 'geklemmt' | 'ungeklemmt') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/e2e/erloese-chrome.html?welt=messwerte&quote=${quote}`);
  // Seit dem Verlauf-Rework (main 763b87f39) ist die Welt „messwerte“ die Energie-Seite; die Quoten stehen unter
  // „Selbst versorgt“ (energieSeite.energieQuoten) statt im Ring der alten Verlaufsgrafik.
  await expect(page.getByRole('heading', { level: 1, name: /^Energie/ })).toBeVisible();
}

test.describe('AP-10 IP-18 · Historienquote sichtbar bestandsgeschützt', () => {
  test('vorher: der abschaltbare Bestand zeigt die geklemmte Quote', async ({ page }) => {
    await oeffnen(page, 'geklemmt');
    await expect(page.locator('.vp-vr-quote-kopf', { hasText: 'Autarkie' }).locator('b')).toHaveText(/^0\s%$/);
    await expect(page.getByText('Anteil Ihres Verbrauchs, den Sie selbst gedeckt haben — der Rest kam aus dem Netz.')).toBeVisible();
    await expect(page.getByText(/Messwerte passen nicht zusammen/)).toHaveCount(0);
    if (captureDir) await page.screenshot({ path: join(captureDir, 'historie-vorher-geklemmt.png'), fullPage: true });
  });

  test('nachher: die ungeklemmte Quote nennt den Messfehler', async ({ page }) => {
    await oeffnen(page, 'ungeklemmt');
    await expect(page.getByText(/^Messwerte passen nicht zusammen \(−25\s%\)$/)).toBeVisible();
    await expect(page.getByText(/^Messwerte passen nicht zusammen \(−20\s%\)$/)).toBeVisible();
    await expect(page.getByText('Anteil Ihres Verbrauchs, den Sie selbst gedeckt haben — der Rest kam aus dem Netz.')).toHaveCount(0);
    if (captureDir) await page.screenshot({ path: join(captureDir, 'historie-nachher-ungeklemmt.png'), fullPage: true });
  });
});
