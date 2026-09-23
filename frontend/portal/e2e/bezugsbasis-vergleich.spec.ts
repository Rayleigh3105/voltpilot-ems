import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS AP-17 IP-20 (NW-4, §8): der Reiter „Vergleich mit Bezugsbasis“ an KZ-0001 auf der Bühne `startansicht` — die
 * ECHTE Kennzahl-Seite, der Leser antwortet mit R2/R11 aus `src/test/bezugsbasisVergleichFixtures.ts`
 * (`&vergleich=r2|maerz|stand`, ohne Angabe R10). Abnahme: die Dezember-Zeile trägt „schlechter“ mit Band, die rohe
 * Hälfte daneben kein Urteil-Wort und keinen Pfeil — bei 375 px (Karten) und 1440 px (Tafel), ohne Querlauf.
 *
 * Mit `VERGLEICH_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab.
 */

const BILDER = process.env.VERGLEICH_BILDER;
const JETZT = new Date('2026-12-03T08:00:00Z');
const URTEIL_ODER_PFEIL = /besser|schlechter|im Rahmen|nicht bewertbar|[↑↓▲▼⬆⬇]/u;

async function oeffne(page: Page, vergleich: string | null, breite: number) {
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&ansicht=kennzahl&kz=KZ-0001${vergleich ? `&vergleich=${vergleich}` : ''}`);
  await expect(page.getByTestId('kennzahl-seite')).toBeVisible();
  await page.getByTestId('kennzahl-reiter-vergleich').click();
  await expect(page.getByTestId('bezugsbasis-vergleich')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function querlauf(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *')]
      .filter((e) => e.offsetParent !== null && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)] };
  });
}

async function bild(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: true });
}

for (const breite of [375, 1440]) {
  test.describe(`Vergleich mit Bezugsbasis — ${breite} px`, () => {
    test('R2: Dezember bereinigt „schlechter (± 2 %)“ neben der rohen Zeile ohne Urteil und ohne Pfeil', async ({ page }) => {
      await oeffne(page, 'r2', breite);
      const dez = page.getByTestId('monat-2027-12');
      await expect(dez.getByTestId('urteil')).toHaveText('schlechter (± 2 %)');
      await expect(dez.getByTestId('erwartet')).toHaveText('69 098 kWh');
      await expect(dez.getByTestId('bedingung')).toHaveText('bei 250 000 kg');
      await expect(dez.getByTestId('roh')).toContainText('8,8 % weniger als im Vormonat');
      await expect(dez.getByTestId('roh-urteil')).toHaveText('ohne Urteil');
      await expect(dez.getByTestId('roh')).not.toHaveText(URTEIL_ODER_PFEIL);
      await expect(dez.getByTestId('roh-urteil')).toBeVisible();
      await expect(dez.getByTestId('urteil')).toBeVisible();
      // 1440 px: roh und bereinigt stehen in EINER Zeile nebeneinander; 375 px: dieselbe Karte, roh zuerst.
      const rohKasten = (await dez.getByTestId('roh').boundingBox())!;
      const urteilKasten = (await dez.getByTestId('urteil').boundingBox())!;
      if (breite >= 960) expect(Math.abs(rohKasten.y - urteilKasten.y)).toBeLessThan(40);
      else expect(urteilKasten.y).toBeGreaterThan(rohKasten.y);
      await expect(page.getByTestId('vergleich-grenze')).toBeVisible();
      expect(await querlauf(page)).toEqual({ dokument: 0, ueberstehend: [] });
      await bild(page, `r2-${breite}`);
    });

    test('R11: der Zeitraum Σ ÷ Σ — 323 000 kWh gemessen, 317 395 kWh erwartet, im Rahmen', async ({ page }) => {
      await oeffne(page, 'r2', breite);
      const kopf = page.getByTestId('vergleich-zeitraum');
      await expect(kopf.getByRole('heading')).toHaveText('Zeitraum · November 2027 bis Februar 2028');
      await expect(kopf.getByTestId('urteil')).toHaveText('im Rahmen (± 2 %)');
      await expect(kopf.getByTestId('zeitraum-satz')).toContainText('1,8 %: im Rahmen der Bezugsbasis (Summe über vier Monate)');
      await expect(page.getByTestId('vergleich-stand')).toHaveText('ungesichert — noch kein Stand');
      expect(await querlauf(page)).toEqual({ dokument: 0, ueberstehend: [] });
    });

    test('G3: der März zeigt den Grund statt der Zahlen, der Zeitraum „4 von 5 Monaten“', async ({ page }) => {
      await oeffne(page, 'maerz', breite);
      const maerz = page.getByTestId('monat-2028-03');
      await expect(maerz.getByTestId('grund')).toContainText('Modell nicht anwendbar: Produktionsmenge im März 2028 (390 000 kg)');
      await expect(maerz.getByTestId('erwartet')).toHaveCount(0);
      await expect(page.getByTestId('zeitraum-monate')).toHaveText('4 von 5 Monaten');
      expect(await querlauf(page)).toEqual({ dokument: 0, ueberstehend: [] });
      await bild(page, `g3-${breite}`);
    });

    test('R10: ohne Bezugsbasis nur der Leer-Satz, keine Tafel, kein Urteil', async ({ page }) => {
      await oeffne(page, null, breite);
      await expect(page.getByTestId('vergleich-leer')).toContainText('Noch keine Bezugsbasis.');
      await expect(page.getByTestId('vergleich-monate')).toHaveCount(0);
      await expect(page.getByTestId('urteil')).toHaveCount(0);
      await expect(page.getByTestId('vergleich-grenze')).toBeVisible();
      expect(await querlauf(page)).toEqual({ dokument: 0, ueberstehend: [] });
      await bild(page, `leer-${breite}`);
    });
  });
}
