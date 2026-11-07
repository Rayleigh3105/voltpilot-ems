import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Der Aufbau gruppiert (Konzept `vp-anlage-geraete-gruppiert`, GR-1 A · GR-2 A · GR-3 A) auf der Bühne
 * `e2e/anlage-gruppiert.html`: der echte Aufbau über den Formen einer Kundenanlage mit drei Kaco, einem Netzzähler und
 * zwei Shelly in Unterverteilungen. Die Box meldet sie in der Reihenfolge ihrer Quellkennung (Kaco 3, Netzanschluss,
 * Kaco 2, UV Keller, Kaco 1, UV Halle); der Aufbau liest sie nach Gruppe und Namen.
 *
 * Je Breite nur die passende Maschine: unter 720 px mobiles WebKit, 1440 Desktop-Chromium. Kein Querlauf, keine
 * Elemente über den Rand, keine Konsolenfehler.
 *
 * Bilder nur auf Wunsch (`GRUPPIERT_BILDER=<Ordner>`), nie ins Repository.
 */
const BILDER = process.env.GRUPPIERT_BILDER;
const BREITEN = [375, 390, 1440] as const;
const NBSP = String.fromCharCode(160);

async function oeffne(page: Page, breite: number, query = '') {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
  await page.goto(`/e2e/anlage-gruppiert.html${query}`);
  const tabelle = page.getByRole('table', { name: 'Aufbau: Anlagen, Boxen und Geräte' });
  await expect(tabelle.locator('[data-aufbau-geraet]').first()).toBeVisible();
  return tabelle;
}

/** Die Zeilen der Tabelle, wie man sie liest: Köpfe als „[Erzeugung 3 · 7,9 kW]“, Geräte mit ihrem Namen. */
async function lesen(tabelle: Locator): Promise<string[]> {
  return tabelle.locator('[role="row"][data-aufbau-gruppe], [role="row"][data-aufbau-geraet]').evaluateAll((zeilen) =>
    zeilen.map((z) => {
      if (z.hasAttribute('data-aufbau-gruppe')) return `[${(z as HTMLElement).getAttribute('aria-label')}]`;
      return z.querySelector('.vp-auf-t-titel')?.textContent?.trim() ?? '';
    }),
  );
}

async function ohneQuerlauf(page: Page, breite: number) {
  const m = await page.evaluate((b) => { const rand = document.querySelector('.vp-auf-t')!.getBoundingClientRect().right; return {
    dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    draussen: [...document.querySelectorAll('.vp-auf-t *')]
      .filter((el) => getComputedStyle(el).clip !== 'rect(0px, 0px, 0px, 0px)' && !el.closest('.vp-sr-only'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      // Auch nicht über den Rand der Tabelle (sie schneidet ab): dort verschwanden „…“ und Pfeil hinter einem langen Wert.
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
  test.describe(`Aufbau gruppiert (${breite})`, () => {
    test.beforeEach(({}, info) => {
      const passend = breite < 720 ? info.project.name === 'mobile-webkit' : info.project.name === 'desktop-chromium';
      test.skip(!passend, 'je Breite nur die passende Maschine');
    });

    test('Erzeugung · Netz · Verbrauch, darin nach Namen, mit Anzahl und Summe', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite);
      expect(await lesen(tabelle)).toEqual([
        `[Erzeugung, 3 Geräte, zusammen 7,9${NBSP}kW]`,
        'Kaco 1',
        'Kaco 2',
        'Kaco 3',
        '[Netz, 1 Gerät]',
        'Netzanschluss',
        `[Verbrauch, 2 Geräte, zusammen 8,0${NBSP}kW]`,
        'UV Halle',
        'UV Keller',
      ]);
      // Der Kopf zeigt die Summe sichtbar - am Telefon die einzige Summe der Seite.
      const erzeugung = tabelle.locator('[data-aufbau-gruppe="erzeugung"]');
      await expect(erzeugung).toBeVisible();
      await expect(erzeugung).toContainText('Erzeugung');
      await expect(erzeugung).toContainText('3');
      await expect(erzeugung.locator('.vp-auf-t-wert')).toHaveText(`7,9${NBSP}kW`);
      // Die Summe ist nachrechenbar: jede Zeile zeigt den Wert ihrer Gruppe.
      await expect(tabelle.locator('[data-aufbau-geraet="src-wqng3qfp"] .vp-auf-t-wert')).toHaveText(`2,9${NBSP}kW`);
      // Ein Unterzähler heißt wie auf seiner Seite und trägt das Zählersymbol, nicht den Schieberegler eines Verbrauchers.
      const uv = tabelle.locator('[data-aufbau-geraet="src-zkscub8m"]');
      if (breite >= 720) await expect(uv.locator('.vp-auf-t-art')).toHaveText('Unterzähler');
      await expect(uv.locator('.vp-auf-sym.is-home')).toBeVisible();
      const zeichen = (id: string) => tabelle.locator(`[data-aufbau-geraet="${id}"] .vp-auf-sym svg`).innerHTML();
      expect(await zeichen('src-zkscub8m')).toBe(await zeichen('src-hkxwbmu2'));
      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `nachher-zuhause-${breite}`);
      expect(fehler).toEqual([]);
    });

    test('nichts doppelt: Unterzähler und Heizstab in einer Gruppe zeigen keine Summe', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite, '?heizstab=1');
      expect(await lesen(tabelle)).toEqual([
        `[Erzeugung, 3 Geräte, zusammen 7,9${NBSP}kW]`,
        'Kaco 1',
        'Kaco 2',
        'Kaco 3',
        '[Netz, 1 Gerät]',
        'Netzanschluss',
        // Die Unterzähler zuerst, dann der Heizstab - und keine Summe, er kann hinter UV Keller hängen.
        '[Verbrauch, 3 Geräte]',
        'UV Halle',
        'UV Keller',
        'Heizstab',
      ]);
      await expect(tabelle.locator('[data-aufbau-gruppe="verbrauch"] .vp-auf-t-wert')).toHaveText('');
      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `nachher-gemischt-${breite}`);
      expect(fehler).toEqual([]);
    });

    test('ein Gerät ohne aktuellen Wert: keine Teilsumme, sondern ein Satz', async ({ page }) => {
      const tabelle = await oeffne(page, breite, '?alt=1');
      const erzeugung = tabelle.locator('[data-aufbau-gruppe="erzeugung"]');
      await expect(erzeugung.locator('.vp-auf-t-wert')).toHaveText('1 Gerät ohne aktuellen Wert');
      await expect(erzeugung).not.toContainText('kW');
      await ohneQuerlauf(page, breite);
    });

    test('zwei Boxen: Gruppen je Box, eine Box nur mit Ladepunkten bleibt ohne Kopf', async ({ page }) => {
      const fehler = konsole(page);
      const tabelle = await oeffne(page, breite, '?hof=1');
      const koepfe = tabelle.locator('[data-aufbau-gruppe]');
      await expect(koepfe).toHaveCount(3);
      expect(await lesen(tabelle)).toEqual([
        `[Erzeugung, 3 Geräte, zusammen 7,9${NBSP}kW]`,
        'Kaco 1',
        'Kaco 2',
        'Kaco 3',
        '[Netz, 1 Gerät]',
        'Netzanschluss',
        `[Verbrauch, 2 Geräte, zusammen 8,0${NBSP}kW]`,
        'UV Halle',
        'UV Keller',
        // Box „Hof“: eine Gruppe, also nur nach Namen.
        'Ladepunkt 1',
        'Ladepunkt 2',
      ]);
      await ohneQuerlauf(page, breite);
      await foto(page, tabelle, `nachher-zwei-boxen-${breite}`);
      expect(fehler).toEqual([]);
    });

    test('die Suche zeigt den Treffer mit seiner Gruppe, ohne Teilsumme', async ({ page }) => {
      const tabelle = await oeffne(page, breite);
      await page.getByRole('searchbox').or(page.getByLabel('Liste durchsuchen')).first().fill('uv halle');
      await expect.poll(() => lesen(tabelle)).toEqual(['[Verbrauch, 1 Gerät]', 'UV Halle']);
    });
  });
}

test('die Box-Seite liest die Geräte in derselben Reihenfolge', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-chromium', 'Reihenfolge, keine Breite');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/anlage-gruppiert.html?flaeche=box');
  const liste = page.getByTestId('box-geraete');
  await expect(liste).toContainText('Kaco 1');
  const namen = await liste.locator('a.vp-geraet-zeile').evaluateAll((as) =>
    as.map((a) => (a.textContent ?? '').match(/^(Kaco \d|Netzanschluss|UV Halle|UV Keller)/)?.[1] ?? ''),
  );
  expect(namen.filter(Boolean)).toEqual(['Kaco 1', 'Kaco 2', 'Kaco 3', 'Netzanschluss', 'UV Halle', 'UV Keller']);
});
