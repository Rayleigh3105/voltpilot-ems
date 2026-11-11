import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Zählerbaum-Konzept (E1-E5 = A, 10.11.2026), Option A „Baum in der Liste":
 * die Bühne `e2e/zb-liste.html` zeigt den vom Captain gemeldeten Fall -
 * Netzanschluss 8,1 kW Bezug, UV Halle 7,7 kW, UV Keller 0,1 kW. `?kompressor=1`
 * fügt einen Kompressor (3,2 kW) HINTER UV Halle ein und beweist R1: er steht
 * eine Ebene tiefer, die Gruppe „Verbrauch" zählt ihn nicht ein zweites Mal
 * (2 Geräte, 7,8 kW - nicht 3 Geräte, 11,0 kW wie vor dem Zählerbaum-Konzept).
 *
 * Je Breite nur die passende Maschine: unter 720 px mobiles WebKit, 1440
 * Desktop-Chromium. Kein Querlauf, keine Elemente über den Rand, keine
 * Konsolenfehler.
 */
const BILDER = process.env.ZAEHLERBAUM_BILDER;
const BREITEN = [375, 390, 1440] as const;
const NBSP = String.fromCharCode(160);

async function oeffne(page: Page, breite: number, query = '') {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
  await page.goto(`/e2e/zb-liste.html${query}`);
  const tabelle = page.getByRole('table', { name: 'Aufbau: Anlagen, Boxen und Geräte' });
  await expect(tabelle.locator('[data-aufbau-geraet]').first()).toBeVisible();
  return tabelle;
}

async function lesen(tabelle: Locator): Promise<string[]> {
  return tabelle.locator('[role="row"][data-aufbau-gruppe], [role="row"][data-aufbau-geraet]').evaluateAll((zeilen) =>
    zeilen.map((z) => {
      if (z.hasAttribute('data-aufbau-gruppe')) return `[${(z as HTMLElement).getAttribute('aria-label')}]`;
      return z.querySelector('.vp-auf-t-titel')?.textContent?.trim() ?? '';
    }),
  );
}

/** Name und Einrückung (`--ebene`) jeder Gerätezeile, in Lese-Reihenfolge. */
async function geraeteMitEbene(tabelle: Locator): Promise<{ name: string; ebene: number }[]> {
  return tabelle.locator('[role="row"][data-aufbau-geraet]').evaluateAll((zeilen) =>
    zeilen.map((z) => ({
      name: z.querySelector('.vp-auf-t-titel')?.textContent?.trim() ?? '',
      ebene: Number((z as HTMLElement).style.getPropertyValue('--ebene') || '0'),
    })),
  );
}

async function ohneQuerlauf(page: Page, breite: number) {
  const m = await page.evaluate((b) => { const rand = document.querySelector('.vp-auf-t')!.getBoundingClientRect().right; return {
    dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    draussen: [...document.querySelectorAll('.vp-auf-t *')]
      .filter((el) => getComputedStyle(el).clip !== 'rect(0px, 0px, 0px, 0px)' && !el.closest('.vp-sr-only'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > Math.min(b, rand) + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`),
  }; }, breite);
  expect(m.dokument, `${breite}: Dokument`).toBe(0);
  expect(m.draussen, `${breite}: Elemente`).toEqual([]);
}

function konsole(page: Page): string[] {
  const fehler: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  page.on('pageerror', (e) => fehler.push(e.message));
  return fehler;
}

async function foto(page: Page, tabelle: Locator, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await tabelle.screenshot({ path: join(BILDER, `${name}.png`) });
}

for (const breite of BREITEN) {
  test.describe(`Zählerbaum: Liste (${breite})`, () => {
    test.beforeEach(({}, info) => {
      const passend = breite < 720 ? info.project.name === 'mobile-webkit' : info.project.name === 'desktop-chromium';
      test.skip(!passend, 'je Breite nur die passende Maschine');
    });

    test('ohne Kompressor: Bestand bleibt zeichengleich zu heute', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite);
      expect(await lesen(tabelle)).toEqual([
        '[Netz, 1 Gerät]',
        'Netzanschluss',
        `[Verbrauch, 2 Geräte, zusammen 7,8${NBSP}kW]`,
        'UV Halle',
        'UV Keller',
      ]);
      await expect(tabelle.locator('[data-aufbau-geraet="src-netzanschluss"] .vp-auf-t-wert')).toHaveText(`8,1${NBSP}kW Bezug`);
      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `ohne-kompressor-${breite}`);
      expect(fehler).toEqual([]);
    });

    test('mit Kompressor hinter UV Halle: eine Ebene tiefer, Gruppe zählt ihn nicht doppelt (R1)', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite, '?kompressor=1');
      expect(await lesen(tabelle)).toEqual([
        '[Netz, 1 Gerät]',
        'Netzanschluss',
        // Genau 2 Geräte, 7,8 kW - der Kompressor steckt schon in UV Halles 7,7 kW.
        `[Verbrauch, 2 Geräte, zusammen 7,8${NBSP}kW]`,
        'UV Halle',
        'Kompressor',
        'UV Keller',
      ]);
      const geraete = await geraeteMitEbene(tabelle);
      const halle = geraete.find((g) => g.name === 'UV Halle');
      const kompressor = geraete.find((g) => g.name === 'Kompressor');
      expect(kompressor?.ebene).toBe((halle?.ebene ?? -1) + 1);
      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `mit-kompressor-${breite}`);
      expect(fehler).toEqual([]);
    });

    test('Umhängen durchklicken: UV Keller hinter UV Halle, Zahlen danach geprüft', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite);
      // Vorher: UV Halle und UV Keller beide direkt an der Wurzel, 2 Geräte, 7,8 kW.
      expect(await lesen(tabelle)).toEqual([
        '[Netz, 1 Gerät]',
        'Netzanschluss',
        `[Verbrauch, 2 Geräte, zusammen 7,8${NBSP}kW]`,
        'UV Halle',
        'UV Keller',
      ]);

      await tabelle.locator('[data-aufbau-geraet="src-uv-keller"]').getByRole('button', { name: /Weitere Aktionen/ }).click();
      await page.getByRole('menuitem', { name: /Woanders anhängen/ }).click();

      const dialog = page.getByRole('dialog', { name: 'Woanders anhängen' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('radio', { name: /UV Halle/ }).check();
      await dialog.getByRole('button', { name: 'Übernehmen' }).click();
      await expect(dialog).toBeHidden();

      // Nachher: UV Keller hängt hinter UV Halle - genau wie der Kompressor-Fall, nur über den Dialog erreicht.
      // Nur EIN Gerät zählt am Verbrauch (UV Halle) - keine Summe ab einem Gerät (dieselbe Regel wie überall).
      expect(await lesen(tabelle)).toEqual([
        '[Netz, 1 Gerät]',
        'Netzanschluss',
        '[Verbrauch, 1 Gerät]',
        'UV Halle',
        'UV Keller',
      ]);
      const geraete = await geraeteMitEbene(tabelle);
      const halle = geraete.find((g) => g.name === 'UV Halle');
      const keller = geraete.find((g) => g.name === 'UV Keller');
      expect(keller?.ebene).toBe((halle?.ebene ?? -1) + 1);

      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `umhaengen-${breite}`);
      expect(fehler).toEqual([]);
    });
  });
}
