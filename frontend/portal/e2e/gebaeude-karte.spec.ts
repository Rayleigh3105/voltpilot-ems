import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS AP-13 IP-10 — die Gebäude-Karte auf „Standort › Gebäude“ (E4 = A, Ü6, B4; O4) auf der Bühne `startansicht`,
 * bei 1440 und 375 px: Halle 2 im Oktober 2026 mit den Blöcken Energie · Messstellen · Kennzahlen, dem Sprung ins
 * gefilterte Register, „Kennzahl anlegen“ nur mit Recht und den Leerzuständen.
 *
 * Querlauf GEMESSEN am Dokument und an jedem sichtbaren Element des Hauptbereichs. Mit `GEBAEUDE_BILDER=<Ordner>`
 * legt der Lauf je Fall ein Bild und `messung-<fall>.json` ab — die Vorschau.
 * Die Spec importiert keine Fixtures (sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt).
 */

const BILDER = process.env.GEBAEUDE_BILDER;
/** Die Uhr der Bühne: 10.11.2026 — die Leiste steht damit auf dem letzten gebildeten Monat, Oktober 2026. */
const JETZT = new Date('2026-11-10T08:15:00Z');

async function oeffne(page: Page, query: string, breite: number, jetzt = JETZT) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

/** Halle 2 aufklappen und auf die gerechnete Sicht warten. */
async function halle2(page: Page) {
  const auf = page.getByRole('button', { name: 'Halle 2: Karte aufklappen' });
  await expect(auf).toBeVisible();
  await auf.click();
  const karte = page.locator('[data-testid="gebaeude-karte-G-2"]');
  await expect(karte.locator('[data-testid^="gebaeude-system-"]')).toBeVisible();
  return karte;
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const main = document.querySelector<HTMLElement>('.vp-main');
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    const texte = (sel: string) => [...document.querySelectorAll(sel)].filter(sichtbar).map((e) => e.textContent?.trim() ?? '');
    return {
      route: document.body.dataset.route ?? null,
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...new Set(ueberstehend)],
      titel: main?.querySelector('h1:not(.vp-sr-only)')?.textContent?.trim() ?? null,
      zeitraum: document.querySelector('[data-testid="gebaeude-zeitraum"]')?.textContent?.trim() ?? null,
      aufklapper: document.querySelectorAll('.vp-ob-aufklapper').length,
      karten: document.querySelectorAll('[data-testid^="gebaeude-karte-"]').length,
      bloecke: texte('[data-testid^="gebaeude-karte-"] .vp-gk-titel'),
      posten: texte('[data-testid^="gebaeude-karte-"] .vp-gk-posten li'),
      // Jede Fläche, auf die getippt wird, misst mindestens 44 px (O17) — eine Touch-Regel, am Telefon geprüft
      // (wie IP-8/IP-9): was hier steht, ist zu klein.
      kleine: [...document.querySelectorAll<HTMLElement>('.vp-gk button, .vp-gk a, .vp-gk-schritt, .vp-ob-aufklapper')]
        .filter((e) => sichtbar(e) && e.getBoundingClientRect().width > 0)
        .map((e) => ({ text: e.textContent?.trim() || e.getAttribute('aria-label'), h: Math.round(e.getBoundingClientRect().height) }))
        .filter((x) => x.h < 44),
      text: main?.textContent ?? '',
    };
  });
}

async function ablegen(page: Page, name: string, m: Awaited<ReturnType<typeof messe>>, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const { text: _text, ...ohneText } = m;
  writeFileSync(join(BILDER, `messung-${name}.json`), JSON.stringify(ohneText, null, 2));
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: ganz });
}

/** Kein Querlauf an jeder Breite; Tippflächen sind eine Touch-Regel und werden am Telefon geprüft (wie IP-8/IP-9). */
function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, fall: string, breite = 1440) {
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
  if (breite < 721) expect(m.kleine, `${fall}: Tippflächen`).toEqual([]);
}

test.describe('AP-13 IP-10 · die Gebäude-Karte (O4)', () => {
  test('Halle 2 im Oktober 2026 bei 1440 und 375 px: Energie · Messstellen · Kennzahlen — keine Gebäude-Summe', async ({ page }) => {
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-gebaeude&person=IK', breite);
      const karte = await halle2(page);
      const m = await messe(page);
      ohneQuerlauf(m, `gebaeude-karte-${breite}`, breite);
      expect(m.route).toMatch(/^#\/standort\/[^/]+\/gebaeude$/);
      // Jedes Gebäude trägt seine Hülle; aufgeklappt ist genau die eine Karte.
      expect(m.aufklapper).toBe(3);
      expect(m.karten).toBe(1);
      expect(m.bloecke).toEqual(['Energie', 'Messstellen', 'Kennzahlen']);
      expect(m.zeitraum).toBe('Oktober 2026');

      const text = (await karte.textContent())!.split(String.fromCharCode(160)).join(' ');
      expect(text).toContain('Gemessen im Gebäude 32.000 kWh (3 Messstellen)');
      expect(text).toContain('Außerhalb des Gebäudes, im selben System:');
      expect(text).toContain('1.100 kWh');
      expect(text).toContain('Rest des Systems Werk Ahrenberg – Halle 2: 3.800 kWh nicht verortet');
      // B4: ein Gebäude ist eine Sicht — 36.900 kWh ist die Zahl der ANLAGE und steht hier nie.
      expect(text).not.toContain('36.900');
      expect(m.posten).toHaveLength(3);
      expect(m.posten.join(' · ')).toContain('Spritzguss SG07–SG10');
      // Die Datenlage kommt aus dem Register mit Filter Ort (E13 zählt Hauptzähler und berechnete mit).
      await expect(karte.locator('[data-testid="gebaeude-datenlage"]')).toContainText('5 von 5');
      await expect(karte.locator('[data-testid="kennzahl-karte"]')).toHaveCount(1);
      await expect(karte.getByText('KZ-0001')).toBeVisible();

      await ablegen(page, `karte-${breite}`, m);
      await ablegen(page, `karte-${breite}-ganz`, m, true);
    }
  });

  test('der Sprung der Datenlage öffnet das Register MIT Filter Ort = Halle 2', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=werk-gebaeude&person=IK', 1440);
    const karte = await halle2(page);
    await karte.locator('[data-testid="gebaeude-datenlage"]').click();
    await expect(page.locator('[data-testid="messstellen"]')).toBeVisible();
    expect(page.url()).toContain('ort=G-2');
    // Genau die fünf Messstellen aus Halle 2 — und keine aus Halle 1.
    await expect(page.locator('.vp-main')).toContainText('MS-11');
    await expect(page.locator('.vp-main')).not.toContainText('MS-06');
    const m = await messe(page);
    ohneQuerlauf(m, 'register-gefiltert');
    await ablegen(page, 'register-gefiltert-1440', m);
  });

  test('„Kennzahl anlegen“ steht dem Energiemanager mit vorgeschlagener Menge — dem Leser gar nicht (G3)', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=werk-gebaeude&person=IK', 1440);
    const karte = await halle2(page);
    const knopf = karte.getByRole('button', { name: 'Kennzahl anlegen' });
    await expect(knopf).toBeVisible();
    await knopf.click();
    await page.getByRole('radio', { name: /^Stromeinsatz je Stück/ }).click();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(page.locator('[data-testid="kennzahl-menge-vorschlag"]')).toContainText('MS-11, MS-12, MS-13');
    const m = await messe(page);
    await ablegen(page, 'kennzahl-anlegen-1440', m);

    await oeffne(page, 'bild=unternehmen&ansicht=werk-gebaeude&person=CB', 1440);
    const leserKarte = await halle2(page);
    await expect(leserKarte.getByRole('button', { name: 'Kennzahl anlegen' })).toHaveCount(0);
    await ablegen(page, 'ohne-recht-1440', await messe(page));
  });

  test('am Telefon: „Kennzahl anlegen“ und der Assistent ohne Querlauf (375 px)', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=werk-gebaeude&person=IK', 375);
    const karte = await halle2(page);
    await karte.getByRole('button', { name: 'Kennzahl anlegen' }).click();
    await expect(page.getByRole('radio', { name: /^Stromeinsatz je Stück/ })).toBeVisible();
    const m = await messe(page);
    expect(m.dokument, 'Assistent 375: Querlauf des Dokuments').toBe(0);
    await ablegen(page, 'kennzahl-anlegen-375', m);
  });

  test('Werk Lindach ohne Gebäude: kein Aufklapper, keine Karte — die Hülle bleibt leer (Z4)', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=lindach-gebaeude&orte=leer', 1440);
    await expect(page.locator('[data-testid="ortsbaum"]')).toBeVisible();
    const m = await messe(page);
    ohneQuerlauf(m, 'lindach-leer');
    expect(m.aufklapper).toBe(0);
    expect(m.karten).toBe(0);
    await ablegen(page, 'lindach-leer-1440', m);
  });
});
