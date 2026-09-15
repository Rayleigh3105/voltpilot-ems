import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';

/**
 * „Unternehmen › Messstellen“ und „Standort › Messstellen“ (UEMS AP-04 IP-5) bei
 * 1440 px (Tabelle) und 375 px (Karten) auf der Bühne `startansicht` — die ECHTE
 * Schale mit der ECHTEN Leiste und den ECHTEN Reitern, dieselben reinen Funktionen
 * wie `App.tsx`, das Register des Referenzunternehmens (heute = 20.10.2026 10:15,
 * `src/test/messstellenRegisterFixtures.ts`).
 *
 * GEMESSEN, nicht behauptet: Querlauf des Dokuments (`scrollWidth − clientWidth`),
 * jedes Element, das über den Bildrand ragt (außer in einem lokal scrollenden
 * Rahmen), die Kacheln der Leiste und die SICHTBAREN Reiter.
 *
 * Mit `MESSSTELLEN_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und
 * `messung-<fall>.json` ab — die Vorschau für die Freigabe.
 */

const BILDER = process.env.MESSSTELLEN_BILDER;
const JETZT = new Date('2026-10-20T08:15:30Z');

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function warteAufRegister(page: Page) {
  await expect(page.locator('[data-testid="messstellen"] .vp-ms-tabelle, [data-testid="messstellen"] .vp-ms-karten').first()).toBeVisible();
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const bar = document.querySelector<HTMLElement>('.vp-bottombar');
    const leisteSichtbar = bar !== null && getComputedStyle(bar).display !== 'none';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-ms-rahmen, .vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return {
      route: document.body.dataset.route ?? null,
      breite,
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...new Set(ueberstehend)],
      leiste: leisteSichtbar ? [...bar!.querySelectorAll('.vp-bottombar-item .lbl')].map((l) => l.textContent ?? '') : null,
      leisteAktiv: leisteSichtbar ? bar!.querySelector('[aria-current="page"] .lbl')?.textContent ?? null : null,
      reiter: [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')].filter(sichtbar).map((t) => t.textContent?.trim() ?? ''),
      reiterAktiv: [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"][aria-selected="true"]')].filter(sichtbar).map((t) => t.textContent?.trim() ?? ''),
      zeilen: document.querySelectorAll('.vp-ms-tabelle tbody tr').length,
      karten: document.querySelectorAll('.vp-ms-karte').length,
      still: [...document.querySelectorAll('.vp-ms-still')].map((e) => e.querySelector('.vp-ms-kz')?.textContent ?? ''),
      kopf: document.querySelector('.vp-ms-kopf p')?.textContent ?? null,
      spalten: [...document.querySelectorAll('.vp-ms-tabelle th')].map((t) => t.textContent ?? ''),
      tabelleScrollt: (() => {
        const r = document.querySelector<HTMLElement>('.vp-ms-rahmen');
        return r ? r.scrollWidth - r.clientWidth : null;
      })(),
    };
  });
}

async function ablegen(page: Page, name: string, m: unknown, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: ganz });
}

function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, fall: string) {
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

test.describe('Messstellen-Register', () => {
  test('Unternehmen › Messstellen bei 1440 px: Tabelle, Reiter „Messstellen“, 0 px Überlauf', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=messstellen', 1440);
    await warteAufRegister(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'unternehmen-1440');
    expect(m.route).toBe('#/portfolio/messstellen');
    expect(m.zeilen).toBe(22);
    expect(m.karten).toBe(0);
    expect(m.spalten).toEqual(['Kennzeichen', 'Name', 'Ort', 'Elektrische Stellung', 'Quelle (führend)', 'Zustand', 'Letzter Wert']);
    // AP-11 IP-13: „Kennzahlen“ steht als Reiter neben „Messstellen“ (Ahrenberg misst und hat Kennzahlen).
    expect(m.reiter).toEqual(['Übersicht', 'Standorte', 'Messstellen', 'Kennzahlen', 'Berichte', 'Messwerte']);
    expect(m.reiterAktiv).toEqual(['Messstellen']);
    expect(m.leiste).toBeNull();
    expect(m.kopf).toBe('21 von 22 Messstellen liefern Daten');
    await ablegen(page, 'unternehmen-1440', m);
    await ablegen(page, 'unternehmen-1440-ganz', m, true);
  });

  test('Unternehmen › Messstellen bei 375 px: Karten, Leiste mit „Messstellen“ offen, keine doppelten Reiter', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=messstellen', 375);
    await warteAufRegister(page);
    const m = await messe(page);
    ohneQuerlauf(m, 'unternehmen-375');
    expect(m.karten).toBe(22);
    expect(m.zeilen).toBe(0);
    expect(m.leiste).toEqual(['Übersicht', 'Standorte', 'Messstellen', 'Kennzahlen', 'Berichte']);
    expect(m.leisteAktiv).toBe('Messstellen');
    // Variante B: was die Leiste trägt, ist am Telefon kein zweites Mal Reiter.
    expect(m.reiter).toEqual([]);
    await ablegen(page, 'unternehmen-375', m);
  });

  test('Standort › Messstellen (Werk Ahrenberg) bei 1440 und 375 px: Übersicht · Gebäude · Anlagen · Messstellen, 16 Messstellen', async ({ page }) => {
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-messstellen', breite);
      await warteAufRegister(page);
      const m = await messe(page);
      ohneQuerlauf(m, `werk-${breite}`);
      expect(m.route).toBe(`#/standort/${FIXTURE_IDS.st1}/messstellen`);
      expect(breite === 375 ? m.karten : m.zeilen).toBe(16);
      // AP-13 IP-2: Gebäude und Anlagen haben ihre Seite — vier Bereiche (O17). Am Rechner die Reiter, am
      // Telefon die Leiste; was die Leiste trägt, ist dort kein zweites Mal Reiter.
      expect(m.reiter).toEqual(breite === 375 ? [] : ['Übersicht', 'Gebäude', 'Anlagen', 'Messstellen']);
      expect(m.reiterAktiv).toEqual(breite === 375 ? [] : ['Messstellen']);
      expect(m.leiste).toEqual(breite === 375 ? ['Übersicht', 'Gebäude', 'Anlagen', 'Messstellen'] : null);
      if (breite === 375) expect(m.leisteAktiv).toBe('Messstellen');
      expect(m.kopf).toBe('Werk Ahrenberg · 15 von 16 Messstellen liefern Daten');
      await ablegen(page, `werk-${breite}`, m);
    }
  });

  test('„Messstelle anlegen“ (AP-04 IP-6) in Standort › Messstellen bei 1440 und 375 px: Knopf im Kopf öffnet den Dialog, 0 px Überlauf', async ({ page }) => {
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=werk-messstellen', breite);
      await warteAufRegister(page);
      const knopf = page.locator('.vp-ms-kopf').getByRole('button', { name: 'Messstelle anlegen' });
      await expect(knopf).toBeVisible();
      const m = await messe(page);
      ohneQuerlauf(m, `anlegen-knopf-${breite}`);
      await ablegen(page, `anlegen-knopf-${breite}`, m);

      await knopf.click();
      const dialog = page.getByRole('dialog', { name: 'Messstelle anlegen' });
      await expect(dialog).toBeVisible();
      await expect(page.getByLabel('Kennzeichen', { exact: true })).toHaveValue('MS-0023');
      await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
      const d = await page.evaluate(() => {
        const koerper = document.querySelector<HTMLElement>('.vp-modal .dbody');
        return {
          dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          dialog: koerper ? koerper.scrollWidth - koerper.clientWidth : null,
        };
      });
      expect(d.dokument, `anlegen-dialog-${breite}: Dokument`).toBe(0);
      expect(d.dialog, `anlegen-dialog-${breite}: Dialog`).toBe(0);
      await ablegen(page, `anlegen-dialog-${breite}`, d);

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await warteAufRegister(page);
    }
  });

  test('„Stand am 10.10.2026“ bei 1440 und 375 px: die Messstellen in Lindach sind benannt, nicht weggelassen', async ({ page }) => {
    for (const breite of [1440, 375]) {
      await oeffne(page, 'bild=unternehmen&ansicht=messstellen', breite);
      await warteAufRegister(page);
      await page.getByRole('combobox', { name: 'Stand am' }).click();
      await page.locator('.vp-kal-tag[data-iso="2026-10-10"]:not(.is-rand)').click();
      await expect(page.getByText('Sie sehen den Stand am 10.10.2026')).toBeVisible();
      await expect(page.locator('.vp-ms-still')).toHaveCount(4);
      const m = await messe(page);
      ohneQuerlauf(m, `stand-am-${breite}`);
      expect(m.still).toEqual(['MS-16', 'MS-17', 'MS-18', 'MS-22']);
      expect(breite === 375 ? m.karten : m.zeilen).toBe(22);
      expect(m.kopf).toBeNull();
      if (breite === 1440) expect(m.spalten).toContain('Zustand (heute)');
      await expect(page.locator('.vp-ms-still').first()).toContainText(
        'Am 10.10.2026 gab es MS-16 „Netzbezug Lindach“ im Portal noch nicht.',
      );
      await ablegen(page, `stand-am-${breite}`, m);
      await page.locator('.vp-ms-still').first().scrollIntoViewIfNeeded();
      await ablegen(page, `stand-am-${breite}-lindach`, m);
    }
  });

  test('Filter „Nur ohne Quelle“ bei 375 px: MS-21 bleibt, der Weg zurück steht daneben', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&ansicht=messstellen', 375);
    await warteAufRegister(page);
    await page.getByRole('button', { name: 'Nur ohne Quelle (1)' }).click();
    await expect(page.locator('.vp-ms-karte')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Filter zurücksetzen' })).toBeVisible();
    const m = await messe(page);
    ohneQuerlauf(m, 'ohne-quelle-375');
    await ablegen(page, 'ohne-quelle-375', m);
  });
});

test.describe('Leisten-Nachweis: mit der Seite „Messstellen“ schaltet sich die Leiste des Unternehmens zu', () => {
  test('Übersicht bei 375 px — Variante B (gebaut): Leiste Übersicht · Standorte · Messstellen · Kennzahlen · Berichte, Reiter nur Übersicht · Messwerte', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen', 375);
    const m = await messe(page);
    ohneQuerlauf(m, 'leiste-uebersicht-375');
    expect(m.route).toBe('#/portfolio');
    expect(m.leiste).toEqual(['Übersicht', 'Standorte', 'Messstellen', 'Kennzahlen', 'Berichte']);
    expect(m.leisteAktiv).toBe('Übersicht');
    expect(m.reiter).toEqual(['Übersicht', 'Messwerte']);
    await ablegen(page, 'leiste-uebersicht-375', m);
    await page.locator('.vp-bottombar').getByRole('button', { name: 'Messstellen' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio/messstellen');
    await warteAufRegister(page);
  });

  test('Übersicht bei 375 px — Variante A (nur Vorschau, `&reiter=alle`): jeder Bereich steht doppelt', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen&reiter=alle', 375);
    const m = await messe(page);
    ohneQuerlauf(m, 'leiste-uebersicht-375-alle-reiter');
    expect(m.leiste).toEqual(['Übersicht', 'Standorte', 'Messstellen', 'Kennzahlen', 'Berichte']);
    expect(m.reiter).toEqual(['Übersicht', 'Standorte', 'Messstellen', 'Kennzahlen', 'Berichte', 'Messwerte']);
    await ablegen(page, 'leiste-uebersicht-375-alle-reiter', m);
  });

  test('am Rechner bleibt der Weg über die Reiter — Unternehmen und Standort', async ({ page }) => {
    await oeffne(page, 'bild=unternehmen', 1440);
    await page.getByRole('tab', { name: 'Messstellen' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio/messstellen');
    await warteAufRegister(page);
    await oeffne(page, 'bild=unternehmen&ansicht=werk', 1440);
    const m = await messe(page);
    expect(m.reiter).toEqual(['Übersicht', 'Gebäude', 'Anlagen', 'Messstellen']);
    await ablegen(page, 'werk-uebersicht-1440', m);
    await page.getByRole('tab', { name: 'Messstellen' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${FIXTURE_IDS.st1}/messstellen`);
    await warteAufRegister(page);
  });

  test('der reine Messkunde (nur Werk Lindach, oberste Ebene): „Messstellen“ führt auf seinen Standort — Reiter am Rechner, Kachel am Telefon', async ({ page }) => {
    await oeffne(page, 'bild=messkunde', 1440);
    const r = await messe(page);
    ohneQuerlauf(r, 'messkunde-1440');
    // AP-13 IP-2: als oberste Ebene trägt die Reiter-Reihe auch „Gebäude“; Lindach hat eine Anlage — kein „Anlagen“ (Z4).
    expect(r.reiter).toEqual(expect.arrayContaining(['Übersicht', 'Gebäude', 'Messstellen']));
    expect(r.reiter).not.toContain('Anlagen');
    await page.getByRole('tab', { name: 'Messstellen' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${FIXTURE_IDS.st2}/messstellen`);
    await warteAufRegister(page);

    await oeffne(page, 'bild=messkunde', 375);
    const m = await messe(page);
    ohneQuerlauf(m, 'messkunde-375');
    // Drei Bereiche mit Seite — seit AP-13 IP-2 die Leiste (O17: Werk Lindach drei Kacheln).
    expect(m.leiste).toEqual(['Übersicht', 'Gebäude', 'Messstellen']);
    await page.locator('.vp-bottombar').getByRole('button', { name: 'Messstellen' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${FIXTURE_IDS.st2}/messstellen`);
    await warteAufRegister(page);
    const n = await messe(page);
    ohneQuerlauf(n, 'messkunde-messstellen-375');
    expect(n.karten).toBe(3);
    expect(n.leisteAktiv).toBe('Messstellen');
    await ablegen(page, 'messkunde-messstellen-375', n);
  });
});
