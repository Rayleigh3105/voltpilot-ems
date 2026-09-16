import { expect, test } from '@playwright/test';
import { join } from 'node:path';

const captureDir = process.env.VOLTPILOT_CAPTURE_DIR;

async function oeffnen(page: import('@playwright/test').Page, quote: 'geklemmt' | 'ungeklemmt') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/e2e/erloese-chrome.html?welt=messwerte&quote=${quote}`);
  await expect(page.getByText('Ihre Energie im Verlauf')).toBeVisible();
}

test.describe('AP-10 IP-18 · Historienquote sichtbar bestandsgeschützt', () => {
  test('vorher: der abschaltbare Bestand zeigt die geklemmte Quote', async ({ page }) => {
    await oeffnen(page, 'geklemmt');
    await expect(page.locator('.vp-chart-kern-wert')).toHaveText('0 %');
    await expect(page.getByText(/Ihrer Sonne haben Sie heute selbst genutzt/)).toBeVisible();
    await expect(page.getByText(/Messwerte passen nicht zusammen/)).toHaveCount(0);
    if (captureDir) await page.screenshot({ path: join(captureDir, 'historie-vorher-geklemmt.png'), fullPage: true });
  });

  test('nachher: die ungeklemmte Quote nennt den Messfehler', async ({ page }) => {
    await oeffnen(page, 'ungeklemmt');
    await expect(page.getByText('Messwerte passen nicht zusammen (−25 %).')).toBeVisible();
    await expect(page.getByText(/Ihrer Sonne haben Sie heute selbst genutzt/)).toHaveCount(0);
    if (captureDir) await page.screenshot({ path: join(captureDir, 'historie-nachher-ungeklemmt.png'), fullPage: true });
  });
});
