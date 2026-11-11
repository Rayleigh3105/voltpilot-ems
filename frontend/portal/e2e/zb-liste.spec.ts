import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Zählerbaum-Konzept (E1-E5 = A, 10.11.2026), Option A „Baum in der Liste":
 * die Bühne `e2e/zb-liste.html` zeigt den vom Captain gemeldeten Fall -
 * Netzanschluss 8,1 kW Bezug, UV Halle 7,7 kW, UV Keller 0,1 kW - OHNE ein
 * einziges gesetztes `haengtAn` (jede Bestandsanlage vor `komponente_haengt_an`).
 * Die Vorgabe (Vertrag §1: „was nicht ausdrücklich woanders hängt, hängt an
 * der Wurzel") hängt beide Unterzähler darum an den Netzanschluss, auch ohne
 * eine einzige Zeile in `komponente_haengt_an` - das war der Captain-Fund:
 * vor dieser Vorgabe blieben sie flach unter „Verbrauch".
 *
 * `?kompressor=1` fügt zusätzlich einen Kompressor (3,2 kW) HINTER UV Halle
 * ein (R1): er steht eine Ebene tiefer als UV Halle, zwei unter dem
 * Netzanschluss. Mit nur einer verbleibenden Gerätegruppe (alles hängt am
 * Netzanschluss) steht kein Gruppenkopf mehr da - „Netz" und „Verbrauch"
 * waren zwei Köpfe nur, solange ein Teil der Geräte nicht im Baum stand.
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

    test('ohne gesetztes haengtAn: die Vorgabe hängt beide Unterzähler trotzdem an den Netzanschluss', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite);
      // Kein Gruppenkopf mehr - nur noch EINE Gruppe (alles hängt am Netzanschluss), Köpfe stehen erst ab zwei.
      expect(await lesen(tabelle)).toEqual(['Netzanschluss', 'UV Halle', 'UV Keller']);
      await expect(tabelle.locator('[data-aufbau-geraet="src-netzanschluss"] .vp-auf-t-wert')).toHaveText(`8,1${NBSP}kW Bezug`);
      const geraete = await geraeteMitEbene(tabelle);
      const netz = geraete.find((g) => g.name === 'Netzanschluss');
      const halle = geraete.find((g) => g.name === 'UV Halle');
      const keller = geraete.find((g) => g.name === 'UV Keller');
      expect(halle?.ebene).toBe((netz?.ebene ?? -1) + 1);
      expect(keller?.ebene).toBe((netz?.ebene ?? -1) + 1);
      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `ohne-kompressor-${breite}`);
      expect(fehler).toEqual([]);
    });

    test('ohne Netzanschluss-Zähler: keine Wurzel zum Anhängen, die Unterzähler bleiben flach (Vertrag §1)', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite, '?ohneNetz=1');
      expect(await lesen(tabelle)).toEqual(['UV Halle', 'UV Keller']);
      const geraete = await geraeteMitEbene(tabelle);
      const halle = geraete.find((g) => g.name === 'UV Halle');
      const keller = geraete.find((g) => g.name === 'UV Keller');
      expect(keller?.ebene).toBe(halle?.ebene ?? -1);
      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `ohne-netzanschluss-${breite}`);
      expect(fehler).toEqual([]);
    });

    test('mit Kompressor hinter UV Halle: zwei Ebenen unter dem Netzanschluss, beliebig tief (R1)', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite, '?kompressor=1');
      expect(await lesen(tabelle)).toEqual(['Netzanschluss', 'UV Halle', 'Kompressor', 'UV Keller']);
      const geraete = await geraeteMitEbene(tabelle);
      const netz = geraete.find((g) => g.name === 'Netzanschluss');
      const halle = geraete.find((g) => g.name === 'UV Halle');
      const kompressor = geraete.find((g) => g.name === 'Kompressor');
      const keller = geraete.find((g) => g.name === 'UV Keller');
      expect(halle?.ebene).toBe((netz?.ebene ?? -1) + 1);
      expect(kompressor?.ebene).toBe((halle?.ebene ?? -1) + 1);
      expect(keller?.ebene).toBe((netz?.ebene ?? -1) + 1);
      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `mit-kompressor-${breite}`);
      expect(fehler).toEqual([]);
    });

    test('Umhängen durchklicken: UV Keller hinter UV Halle, Zahlen danach geprüft', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite);
      // Vorher: UV Halle und UV Keller beide (ohne gesetztes haengtAn) an der Wurzel, kein Gruppenkopf.
      expect(await lesen(tabelle)).toEqual(['Netzanschluss', 'UV Halle', 'UV Keller']);

      await tabelle.locator('[data-aufbau-geraet="src-uv-keller"]').getByRole('button', { name: /Weitere Aktionen/ }).click();
      await page.getByRole('menuitem', { name: /Woanders anhängen/ }).click();

      const dialog = page.getByRole('dialog', { name: 'Woanders anhängen' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('radio', { name: /UV Halle/ }).check();
      await dialog.getByRole('button', { name: 'Übernehmen' }).click();
      await expect(dialog).toBeHidden();

      // Nachher: UV Keller hängt ausdrücklich hinter UV Halle - genau wie der Kompressor-Fall, nur über den Dialog erreicht.
      expect(await lesen(tabelle)).toEqual(['Netzanschluss', 'UV Halle', 'UV Keller']);
      const geraete = await geraeteMitEbene(tabelle);
      const netz = geraete.find((g) => g.name === 'Netzanschluss');
      const halle = geraete.find((g) => g.name === 'UV Halle');
      const keller = geraete.find((g) => g.name === 'UV Keller');
      expect(halle?.ebene).toBe((netz?.ebene ?? -1) + 1);
      expect(keller?.ebene).toBe((halle?.ebene ?? -1) + 1);

      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `umhaengen-${breite}`);
      expect(fehler).toEqual([]);
    });
  });
}
