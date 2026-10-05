import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * „Was steht an“ (Konzept Wiedervorlage w1, Variante A) bei 375, 390 und 1440 px auf der eigenen Bühne
 * `e2e/energiemanagement-baustein.html`: R12 (acht überfällig in vier Bündeln), die Demo (zehn Korrekturen sind ein
 * Eintrag), der Normalfall (die nächsten zwei Fristen aus dem Jahresplan), nur eine Frist in den nächsten Tagen, ohne
 * jede Frist (kein Block). GEMESSEN: kein Querlauf
 * des Dokuments, kein Element über dem Rand des Blocks, jede Zeile mindestens 52 px hoch (Tippfläche). Mit
 * `ENERGIEMANAGEMENT_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab.
 */
const BILDER = process.env.ENERGIEMANAGEMENT_BILDER;

const ERWARTET: Record<string, { marken: string[]; zeilen: string[]; ruhe?: string }> = {
  r12: {
    marken: ['8 überfällig', '1 in den nächsten 30 Tagen'],
    zeilen: [
      '4 Bezugsbasen überprüfen',
      'Leistungsvergleich Kunststoffwerk Ahrenberg GmbH Dezember 2027 neu freigeben',
      'Energetische Bewertung überprüfen',
      'Energiepolitik und Anwendungsbereich überprüfen',
    ],
  },
  demo: {
    marken: ['4 überfällig'],
    zeilen: ['Monatsbericht Standort Werk Ahrenberg Oktober 2026 neu freigeben', 'Messstelle für Messbedarf MB-1 einrichten', '2 Bezugsbasen überprüfen'],
  },
  // Nichts in den nächsten 30 Tagen: die nächsten zwei Fristen aus dem Jahresplan, je Monat gebündelt.
  normal: { marken: ['Keine Frist überfällig'], zeilen: ['2 Maßnahmen umsetzen', 'Kriterien für Betrieb und Instandhaltung überprüfen'] },
  bald: {
    marken: ['Keine Frist überfällig', '1 in den nächsten 30 Tagen'],
    zeilen: ['Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen und über die zweite Prüfung entscheiden', 'Feststellung F-2029-0001 klären'],
  },
};

for (const breite of [375, 390, 1440]) {
  for (const [fall, e] of Object.entries(ERWARTET)) {
    test(`Was steht an: ${fall} bei ${breite} px`, async ({ page }) => {
      await page.setViewportSize({ width: breite, height: 900 });
      await page.goto(`/e2e/energiemanagement-baustein.html?fall=${fall}`);
      await page.evaluate(() => document.fonts.ready);
      const block = page.getByTestId('baustein-energiemanagement');
      await expect(block.getByRole('heading', { name: 'Was steht an' })).toBeVisible();
      await expect(block).toContainText('Fristen aus Ihrem Energiemanagement');
      await expect(block.getByTestId('energiemanagement-marken').locator('.vp-k-marke')).toHaveText(e.marken);
      if (e.zeilen.length) {
        await expect(block.getByTestId('was-steht-an').locator('.vp-fz-titel')).toHaveText(e.zeilen);
        const hoehen = await block.getByTestId('was-steht-an').locator('.vp-fz').evaluateAll((z) => z.map((x) => x.getBoundingClientRect().height));
        expect(Math.min(...hoehen)).toBeGreaterThanOrEqual(52);
      } else {
        await expect(block.getByTestId('was-steht-an-ruhe')).toHaveText(e.ruhe!);
      }
      // Am Rechner steht der Schritt als Wort, am Telefon das Zeichen.
      const schritt = block.locator('.vp-fz-schritt').first();
      if (e.zeilen.length) {
        if (breite >= 720) await expect(schritt).toBeVisible();
        else await expect(schritt).toBeHidden();
      }
      // Die Sätze stehen einmal unten auf der Seite (K7), nicht im Block; „Woher“ öffnet die Herleitung.
      await expect(block).not.toContainText('Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen.');
      await block.getByText('Woher kommen diese Fristen?').click();
      await expect(block.getByTestId('was-steht-an-woher')).toContainText('VoltPilot verschickt keine Erinnerungen.');
      const quer = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(quer).toBeLessThanOrEqual(0);
      const draussen = await block.evaluate((el) => {
        const rand = el.getBoundingClientRect();
        return [...el.querySelectorAll('*')]
          .map((k) => k.getBoundingClientRect())
          .filter((r) => r.width > 0 && (r.left < rand.left - 0.5 || r.right > rand.right + 0.5)).length;
      });
      expect(draussen).toBe(0);
      if (BILDER) {
        mkdirSync(BILDER, { recursive: true });
        await block.screenshot({ path: join(BILDER, `was-steht-an-${fall}-${breite}.png`) });
      }
    });
  }
  test(`ohne jede Frist kein Block bei ${breite} px`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: 800 });
    await page.goto('/e2e/energiemanagement-baustein.html?fall=leer');
    await expect(page.getByTestId('uebersicht-bausteine')).toBeAttached();
    await expect(page.getByTestId('baustein-energiemanagement')).toHaveCount(0);
  });
}
