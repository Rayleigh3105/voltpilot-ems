import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * UEMS AP-18 IP-19 (F2/F3, R9, R13): der Übersichts-Baustein „Ziele und Maßnahmen“ am Unternehmen bei 375 px und
 * 1440 px auf der eigenen Bühne `e2e/ziele-massnahmen-baustein.html` — R9, mehrere fällige Vorgänge und R13 ohne Vorgang
 * (keine Kachel). GEMESSEN: kein Querlauf des Dokuments. Mit `ZIELE_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab.
 */
const BILDER = process.env.ZIELE_BILDER;

for (const breite of [375, 1440]) {
  for (const fall of ['r9', 'mehr'] as const) {
    test(`Baustein ${fall} bei ${breite} px`, async ({ page }) => {
      await page.setViewportSize({ width: breite, height: 700 });
      await page.goto(`/e2e/ziele-massnahmen-baustein.html?fall=${fall}`);
      await expect(page.getByRole('heading', { name: 'Ziele und Maßnahmen' })).toBeVisible();
      if (fall === 'r9') {
        await expect(page.getByTestId('ziele-massnahmen-summe')).toHaveText(
          '1 Maßnahme überfällig: M-2028-0002 Druckluft-Leckagen orten und beseitigen, Termin 29.02.2028, überfällig seit 15 Tagen (Ines Kaltenbach) · 1 Maßnahme umgesetzt, noch nicht bewertet · 1 Energieziel läuft.',
        );
        await expect(page.getByTestId('faellig-massnahme-m-2')).toHaveText(
          'M-2028-0002 · geplant · Termin 29.02.2028 · überfällig seit 15 Tagen · Ines Kaltenbach.',
        );
      } else {
        await expect(page.getByTestId('ziele-massnahmen-faellig').getByRole('listitem')).toHaveCount(3);
        await expect(page.getByTestId('faellig-energieziel-ez-1')).toContainText('Bewertung fällig seit 3 Tagen');
      }
      const quer = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(quer).toBeLessThanOrEqual(0);
      if (BILDER) {
        mkdirSync(BILDER, { recursive: true });
        await page.getByTestId('baustein-ziele-massnahmen').screenshot({ path: join(BILDER, `ip19-${fall}-${breite}.png`) });
      }
    });
  }
  test(`R13: ohne Vorgang keine Kachel bei ${breite} px`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: 700 });
    await page.goto('/e2e/ziele-massnahmen-baustein.html?fall=leer');
    await expect(page.getByTestId('uebersicht-bausteine')).toBeAttached();
    await expect(page.getByTestId('baustein-ziele-massnahmen')).toHaveCount(0);
  });
}
