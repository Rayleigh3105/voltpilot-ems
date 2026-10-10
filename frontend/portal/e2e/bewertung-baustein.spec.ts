import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * UEMS AP-16 IP-24 (S5/S6, R10): der Übersichts-Baustein „Energetische Bewertung“ am Unternehmen bei 375 px und
 * 1440 px auf der eigenen Bühne `e2e/bewertung-baustein.html` — vor der Frist und fällig seit 1 Tag mit den
 * Verantwortlichen. GEMESSEN: kein Querlauf des Dokuments. Mit `BEWERTUNG_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab.
 */
const BILDER = process.env.BEWERTUNG_BILDER;

for (const breite of [375, 1440]) {
  for (const fall of ['vorher', 'faellig'] as const) {
    test(`Baustein ${fall} bei ${breite} px`, async ({ page }) => {
      await page.setViewportSize({ width: breite, height: 700 });
      await page.goto(`/e2e/bewertung-baustein.html?fall=${fall}`);
      const frist = page.getByTestId('bewertung-frist');
      await expect(frist).toHaveText(
        fall === 'faellig'
          ? 'Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung fällig seit 1 Tag.'
          : 'Energetische Bewertung: Stand Nr. 2 vom 17.11.2026 · Überprüfung fällig am 17.11.2027.',
      );
      await expect(page.getByTestId('bewertung-zahlen')).toHaveText('6 wesentliche Energieeinsätze · 1 offener Messbedarf');
      await expect(page.getByTestId('bewertung-verantwortliche')).toHaveCount(fall === 'faellig' ? 1 : 0);
      const quer = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(quer).toBeLessThanOrEqual(0);
      if (BILDER) {
        mkdirSync(BILDER, { recursive: true });
        await page.getByTestId('baustein-bewertung').screenshot({ path: join(BILDER, `ip24-${fall}-${breite}.png`) });
      }
    });
  }
}
