import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Zählerbaum-Konzept (E1-E5 = A, 10.11.2026), gewerbliche Gegenprobe
 * (`e2e/zb-liste-gewerbe.html`, Bericht §3.1 „Werk Nord"): ZWEI
 * Unterverteilungen mit je mehreren Maschinen dahinter, beliebig tief, mit
 * derselben Regel wie die private Anlage (R1 - keine zweite Regel für
 * Gewerbe).
 *
 * Je Breite nur die passende Maschine: unter 720 px mobiles WebKit, 1440
 * Desktop-Chromium. Kein Querlauf, keine Elemente über den Rand, keine
 * Konsolenfehler.
 */
const BILDER = process.env.ZAEHLERBAUM_BILDER;
const BREITEN = [375, 390, 1440] as const;
const NBSP = String.fromCharCode(160);

async function oeffne(page: Page, breite: number) {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
  await page.goto('/e2e/zb-liste-gewerbe.html');
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
  test.describe(`Zählerbaum: Liste gewerblich (${breite})`, () => {
    test.beforeEach(({}, info) => {
      const passend = breite < 720 ? info.project.name === 'mobile-webkit' : info.project.name === 'desktop-chromium';
      test.skip(!passend, 'je Breite nur die passende Maschine');
    });

    test('zwei Unterverteilungen, je mit Maschinen dahinter, derselbe Rest je Ebene wie privat', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite);
      expect(await lesen(tabelle)).toEqual([
        // Nur EIN Erzeuger: keine Summe (dieselbe Regel wie überall - erst ab zwei Zeilen).
        '[Erzeugung, 1 Gerät]',
        'Dach-PV',
        '[Netz, 1 Gerät]',
        'Netzanschluss',
        // Nur die drei Unterverteilungen zählen am Werk (3 Geräte, 74,0 kW) -
        // die sechs Maschinen dahinter stecken schon in ihren Werten.
        `[Verbrauch, 3 Geräte, zusammen 74,0${NBSP}kW]`,
        'UV Büro',
        'UV Halle 1',
        'Abkantpresse',
        'Laserschneidanlage',
        'Schraubenkompressor',
        'UV Halle 2',
        'Absauganlage',
      ]);
      const geraete = await geraeteMitEbene(tabelle);
      const ebeneVon = (name: string) => geraete.find((g) => g.name === name)?.ebene ?? -1;
      // UV Halle 1/2 auf derselben Ebene wie UV Büro - direkte Kinder des Werks.
      expect(ebeneVon('UV Halle 1')).toBe(ebeneVon('UV Büro'));
      expect(ebeneVon('UV Halle 2')).toBe(ebeneVon('UV Büro'));
      // Jede Maschine eine Ebene unter ihrer Unterverteilung.
      expect(ebeneVon('Laserschneidanlage')).toBe(ebeneVon('UV Halle 1') + 1);
      expect(ebeneVon('Abkantpresse')).toBe(ebeneVon('UV Halle 1') + 1);
      expect(ebeneVon('Schraubenkompressor')).toBe(ebeneVon('UV Halle 1') + 1);
      expect(ebeneVon('Absauganlage')).toBe(ebeneVon('UV Halle 2') + 1);
      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `gewerbe-${breite}`);
      expect(fehler).toEqual([]);
    });
  });
}
