import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * UEMS AP-19 IP-21 (WV5, E10, R12): der Übersichts-Baustein „Energiemanagement“ am Unternehmen bei 375 px und 1440 px
 * auf der eigenen Bühne `e2e/energiemanagement-baustein.html` — R12 (acht fällig, eine Vorschau), nur eine Vorschau,
 * ein gescheiterter Kalender-Abzug und ohne Frist (keine Kachel). GEMESSEN: kein Querlauf des Dokuments, kein Element
 * über dem Rand der Kachel. Mit `ENERGIEMANAGEMENT_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab.
 */
const BILDER = process.env.ENERGIEMANAGEMENT_BILDER;

for (const breite of [375, 1440]) {
  for (const fall of ['r12', 'vorschau', 'fehler'] as const) {
    test(`Baustein Energiemanagement ${fall} bei ${breite} px`, async ({ page }) => {
      await page.setViewportSize({ width: breite, height: 800 });
      await page.goto(`/e2e/energiemanagement-baustein.html?fall=${fall}`);
      await expect(page.getByRole('heading', { name: 'Energiemanagement' })).toBeVisible();
      const summe = page.getByTestId('energiemanagement-summe');
      if (fall === 'vorschau') {
        await expect(summe).toHaveText('0 fällig · 1 in den nächsten 30 Tagen.');
        await expect(summe).not.toHaveClass(/is-warn/);
      } else {
        await expect(summe).toHaveText('8 fällig · 1 in den nächsten 30 Tagen.');
        await expect(summe).toHaveClass(/is-warn/);
      }
      await expect(page.getByTestId('energiemanagement-kalender')).toHaveText('Kalender-Abzug (.ics)');
      await expect(page.getByRole('alert')).toHaveCount(fall === 'fehler' ? 1 : 0);
      const kachel = page.getByTestId('baustein-energiemanagement');
      await expect(kachel).toContainText('Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen.');
      await expect(kachel).toContainText('Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.');
      const quer = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(quer).toBeLessThanOrEqual(0);
      const draussen = await kachel.evaluate((el) => {
        const rand = el.getBoundingClientRect();
        return [...el.querySelectorAll('*')]
          .map((k) => k.getBoundingClientRect())
          .filter((r) => r.width > 0 && (r.left < rand.left - 0.5 || r.right > rand.right + 0.5)).length;
      });
      expect(draussen).toBe(0);
      if (BILDER) {
        mkdirSync(BILDER, { recursive: true });
        await kachel.screenshot({ path: join(BILDER, `ip21-${fall}-${breite}.png`) });
      }
    });
  }
  test(`ohne Frist keine Kachel bei ${breite} px`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: 800 });
    await page.goto('/e2e/energiemanagement-baustein.html?fall=leer');
    await expect(page.getByTestId('uebersicht-bausteine')).toBeAttached();
    await expect(page.getByTestId('baustein-energiemanagement')).toHaveCount(0);
  });
}
