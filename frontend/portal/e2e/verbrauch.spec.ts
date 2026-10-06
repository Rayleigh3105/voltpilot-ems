import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * „Unternehmen › Auswerten › Verbrauch“ (Konzept Auswerten a1, Entscheid 10.1) bei 375 px und 1440 px auf der Bühne der
 * Bewertung (`e2e/bewertung.html`): die ECHTE Schale, die ECHTEN Reiter und die ECHTE `VerbrauchPage`, die Routen gespielt
 * aus dem Referenzunternehmen (`src/test/bewertungFixtures.ts`; Rangliste Oktober 2026, ein Monat Hauptzähler).
 *
 * Fälle: Monat (Antwort, Kachel, Balkenreihen, Rest mit „Zähler planen“, Gas), 12 Monate (Monatssäulen mit leeren
 * Monaten, Infozeile, Adresse), Reihe → Seite des Energieeinsatzes und zurück.
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente. Mit `VERBRAUCH_BILDER=<Ordner>` je Fall ein Bild.
 */

const BILDER = process.env.VERBRAUCH_BILDER;
const AM_20_11 = new Date('2026-11-20T09:00:00Z');
const REITER = ['Verbrauch', 'Kennzahlen', 'Bewertung'];

async function oeffne(page: Page, breite: number, hash = '#/portfolio/verbrauch') {
  await page.clock.setFixedTime(AM_20_11);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/bewertung.html?stand=voll${hash}`);
  await expect(page.getByTestId('verbrauch-antwort')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *')]
      .filter((e) => e.offsetParent !== null)
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.right > breite + 0.5 || r.left < -0.5);
      })
      .map((e) => `${e.tagName.toLowerCase()}.${e.className}`);
    const reiter = [...document.querySelectorAll('[data-testid="gruppen-reiter"] [role="tab"]')].map((t) => t.textContent ?? '');
    return { dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)], reiter, route: location.hash };
  });
}

async function ablegen(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: true });
}

for (const breite of [375, 1440]) {
  test.describe(`Verbrauch bei ${breite} px`, () => {
    test('Monat: Antwort zuerst, Kachel, Bereiche absteigend, Rest mit Weg, Gas mit Menge — die Gruppe hat drei Reiter', async ({ page }) => {
      await oeffne(page, breite);
      await expect(page.getByTestId('verbrauch-antwort')).toContainText('Spritzguss braucht mit 42');
      await expect(page.getByTestId('verbrauch-antwort')).toContainText('Strom · Oktober 2026 · alle Zähler vollständig');
      await expect(page.getByLabel('Strom im Oktober 2026')).toContainText('185.380');
      await expect(page.locator('[data-testid^="verbrauch-reihe-"]')).toHaveCount(6);
      await expect(page.locator('[data-testid^="verbrauch-reihe-"]').first()).toContainText('Spritzguss');
      await expect(page.getByTestId('verbrauch-rest')).toContainText('Keinem Bereich zugeordnet');
      await expect(page.getByTestId('verbrauch-traeger-Gas')).toContainText('1.240');
      const m = await messe(page);
      expect(m.dokument, 'Querlauf').toBe(0);
      expect(m.ueberstehend, 'überstehende Elemente').toEqual([]);
      expect(m.reiter).toEqual(REITER);
      await ablegen(page, `monat-${breite}`);

      // „Zähler planen“ am Rest öffnet den Messbedarf mit dem Rest der größten Anlage.
      await page.getByTestId('verbrauch-zaehler-planen').click();
      await expect(page.locator('.vp-modal').getByLabel('Was soll gemessen werden?')).toHaveValue(/^Rest Halle 1: 54\.580\s?kWh/);
      await page.keyboard.press('Escape');
    });

    test('12 Monate: Monatssäulen ab null, ein Monat ohne Wert bleibt leer und gestrichelt, die Adresse merkt sich die Wahl', async ({ page }) => {
      await oeffne(page, breite);
      await page.getByRole('tab', { name: '12 Monate' }).click();
      await expect(page.getByTestId('verbrauch-zeitraum')).toHaveText('Nov 2025 – Okt 2026');
      const verlauf = page.getByTestId('verbrauch-verlauf');
      await expect(verlauf.locator('.vp-vb-saeule')).toHaveCount(12);
      // Die Bühne kennt nur den Oktober — elf Monate bleiben leere Säulen, nie 0.
      await expect(verlauf.locator('.vp-vb-saeule.is-leer')).toHaveCount(11);
      await expect(page.getByTestId('verbrauch-infozeile')).toContainText('Oktober 2026');
      await page.getByTestId('verbrauch-verlauf-flaeche').focus();
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('verbrauch-infozeile')).toContainText('September 2026keine Werte');
      expect(await page.evaluate(() => location.hash)).toBe('#/portfolio/verbrauch?zeitraum=12monate');
      const m = await messe(page);
      expect(m.dokument, 'Querlauf').toBe(0);
      expect(m.ueberstehend, 'überstehende Elemente').toEqual([]);
      await ablegen(page, `zwoelf-${breite}`);
    });

    test('eine Reihe öffnet den Bereich unter „Verbrauch“; der Rückweg führt zurück', async ({ page }) => {
      await oeffne(page, breite);
      await page.locator('[data-testid^="verbrauch-reihe-"]').first().getByRole('button').first().click();
      const seite = page.getByTestId('einsatz-seite');
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('Spritzguss');
      expect(await page.evaluate(() => location.hash)).toMatch(/^#\/portfolio\/verbrauch\/ee000000-/);
      await expect(page.getByTestId('einsatz-antwort')).toContainText('Spritzguss brauchte im Oktober 2026');
      // „Warum“: K2 ist bei 67,8 % Zuordnung nicht belastbar, K3 ohne zwölf Monate nicht anwendbar — kein ✗.
      const warum = page.getByTestId('einsatz-warum');
      await expect(warum.getByTestId('einsatz-kriterium-offen')).toHaveCount(2);
      await expect(warum).toContainText('nicht belastbar – erst ab 80');
      await expect(warum).not.toContainText('nicht erfüllt');
      const m = await messe(page);
      expect(m.dokument, 'Querlauf').toBe(0);
      expect(m.ueberstehend, 'überstehende Elemente').toEqual([]);
      await ablegen(page, `einsatz-${breite}`);
      await seite.getByRole('button', { name: 'Verbrauch' }).click();
      await expect(page.getByTestId('verbrauch-antwort')).toBeVisible();
    });

    test('der Rückweg „Verbrauch“ behält den gewählten Zeitraum', async ({ page }) => {
      await oeffne(page, breite, '#/portfolio/verbrauch?zeitraum=12monate&bis=2026-10');
      await page.locator('[data-testid^="verbrauch-reihe-"]').first().getByRole('button').first().click();
      await expect(page.getByTestId('einsatz-seite')).toBeVisible();
      expect(await page.evaluate(() => location.hash)).toMatch(/^#\/portfolio\/verbrauch\/ee000000-[^?]+\?zeitraum=12monate&bis=2026-10$/);
      await page.getByTestId('einsatz-seite').getByRole('button', { name: 'Verbrauch' }).click();
      await expect(page.getByTestId('verbrauch-zeitraum')).toHaveText('Nov 2025 – Okt 2026');
      expect(await page.evaluate(() => location.hash)).toBe('#/portfolio/verbrauch?zeitraum=12monate&bis=2026-10');
    });

    test('die alte Adresse eines Einsatzes unter „Bewertung“ öffnet dieselbe Seite', async ({ page }) => {
      await page.clock.setFixedTime(AM_20_11);
      await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
      await page.goto('/e2e/bewertung.html?stand=voll#/portfolio/bewertung/ee000000-0000-4000-8000-000000000001');
      await expect(page.getByTestId('einsatz-seite').getByRole('heading', { level: 1 })).toHaveText('Spritzguss');
    });
  });
}
