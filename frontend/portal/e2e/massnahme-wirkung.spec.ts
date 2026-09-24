import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Abschnitt „Wirkung“, Spalte „Bewertung“ und Anstöße an der Maßnahme (UEMS AP-18 IP-20, §5.5–§5.7) bei 375 px und
 * 1440 px auf der Bühne `e2e/massnahmen.html` — die ECHTE Maßnahmen-Seite, die Routen gespielt aus dem
 * Referenzunternehmen 1.9 (`src/test/massnahmeFixtures.ts`, R5/R6/R7/R12) am 15.11.2028; dazu „neu bewerten“ bzw.
 * „beibehalten“ an der Energieziel-Seite (`e2e/energieziele.html`, Lage `anstoss`).
 *
 * Fälle: Wirkung lesen (R5: 8 von 12, Umsetzungsmonat und März nicht gezählt, „vorläufig“, roh ohne Wort) und ohne
 * Stand „beobachtet — nicht belegt“ · „belegt“ mit Begründung → Stand Nr. 1 mit Prüfsumme (R6) · Vier-Augen: der
 * Antrag, eine zweite Person bestätigt · ohne Messgrundlage nur „nicht messbar“ (R7) · Anstoß „beibehalten“ mit
 * Begründung (R12) · Anstoß am Energieziel „neu bewerten“ öffnet den Bewerten-Dialog.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Fall. Mit `WIRKUNG_BILDER=<Ordner>` legt der Lauf je
 * Fall ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.WIRKUNG_BILDER;
const AM_15_11_2028 = new Date('2028-11-15T09:00:00Z');
const AM_20_11_2028 = new Date('2028-11-20T09:00:00Z');
const AM_05_11_2028 = new Date('2028-11-05T09:00:00Z');
const SATZ_R5 =
  'Wirkung von M-2028-0001, beobachtet: 2,4 % weniger Strom als die Bezugsbasis erwarten lässt (Februar bis Oktober 2028, 8 von 12 Monaten; März 2028 nicht bewertbar: Produktionsmenge Spritzguss außerhalb der Bezugsbasis) — erwartet waren 3 % weniger. Ob die Maßnahme das bewirkt hat, sagt eine Person.';
const OFFEN = 'Beobachtet — nicht belegt. Eine Bewertung mit Begründung setzt eine Person.';
const BEGRUENDUNG_R6 =
  'Zeitschaltung seit 22.01.2028 aktiv, Laufzeit der Werkzeugheizungen laut Steuerung 18 % niedriger; keine andere Änderung am Prozess Spritzguss im Zeitraum.';
const BEGRUENDUNG_R7 = 'Keine Messgrundlage: Druckluft hat keine Energieleistungskennzahl.';
const BEGRUENDUNG_R12 =
  'Version 2 ändert die Ausgangslage um 0,9 Punkte; die Maßnahme und ihre erwartete Wirkung bleiben, wie sie angelegt wurden — der Stand des Leistungsvergleichs wird revidiert.';
const KAUSAL = /hat gewirkt|haben gewirkt|Einsparung durch|Ursache/;

async function oeffne(page: Page, pfad: string, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/${pfad}.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)] };
  });
}

function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, fall: string) {
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string, ziel?: Locator) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const path = join(BILDER, `${name}.png`);
  if (ziel) {
    // Die feste Leiste stünde in einem hohen Element-Bild mitten im Inhalt: dort ein hohes Fenster statt Scrollen.
    const vp = page.viewportSize();
    const hoehe = await page.evaluate(() => document.documentElement.scrollHeight);
    if (vp) await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe) });
    await ziel.screenshot({ path });
    if (vp) await page.setViewportSize(vp);
    return;
  }
  await page.screenshot({ path });
}

async function waehle(page: Page, feld: Locator, option: RegExp) {
  await feld.click();
  const id = await feld.getAttribute('id');
  await page.locator(`[id="${id}-liste"]`).getByRole('option', { name: option }).click();
}

const modal = (page: Page) => page.locator('.vp-modal');
const combo = (page: Page, name: string) => modal(page).getByRole('combobox', { name, exact: true });

for (const breite of [375, 1440]) {
  test.describe(`Wirkung und Bewertung bei ${breite} px`, () => {
    test('R5: Wirkung lesen — 8 von 12, nicht gezählte Monate mit Grund, roh ohne Wort; ohne Stand „beobachtet — nicht belegt“', async ({ page }) => {
      await oeffne(page, 'massnahmen', 'lage=r5&m=1', breite, AM_15_11_2028);
      const w = page.getByTestId('massnahme-wirkung');
      await expect(page.getByTestId('massnahme-wirkung-satz')).toHaveText(SATZ_R5);
      await expect(page.getByTestId('massnahme-wirkung-vorlaeufig')).toHaveText('vorläufig (8 von 12 Monaten)');
      await expect(w.getByTestId('wirkung-2028-01').getByTestId('grund')).toHaveText('Januar 2028: Umsetzungsmonat — nicht gezählt.');
      await expect(w.getByTestId('wirkung-2028-03').getByTestId('grund')).toContainText('390 000 kg außerhalb der Bezugsbasis (228 600–375 100 kg)');
      await expect(w.getByTestId('wirkung-2028-07').getByTestId('urteil')).toHaveText('schlechter (± 2 %)');
      await expect(w.getByTestId('wirkung-2028-02').getByTestId('roh')).toHaveText('0,2672');
      await expect(w.getByTestId('wirkung-2028-11')).toContainText('noch nicht endgültig');
      const summe = page.getByTestId('massnahme-wirkung-summe');
      await expect(summe).toContainText('8 von 12 Monaten');
      await expect(summe).toContainText('647 000 kWh');
      await expect(summe).toContainText('2,4 % weniger');
      await expect(summe).toContainText('besser (± 2 %)');
      await expect(page.getByTestId('massnahme-wirkung-daneben')).toContainText('Ausgangslage Dezember 2027: 12,9 % mehr als erwartet');
      await expect(page.getByTestId('massnahme-wirkung-daneben')).toContainText('Erwartete Wirkung: 3 % weniger');
      await expect(page.getByTestId('massnahme-beobachtet')).toHaveText(OFFEN);
      await expect(page.getByTestId('massnahme-stand')).toHaveCount(0);
      await expect(page.getByTestId('massnahme-seite')).not.toContainText(KAUSAL);
      ohneQuerlauf(await messe(page), 'Wirkung');
      await ablegen(page, `wirkung-${breite}`, page.locator('.vp-ma-wirkung'));
    });

    test('R6: „belegt“ mit Begründung → Stand Nr. 1 mit Person, Datum, Prüfsumme; die Zahl steht daneben', async ({ page }) => {
      await oeffne(page, 'massnahmen', 'lage=r5&m=1', breite, AM_15_11_2028);
      await page.getByTestId('massnahme-bewerten').click();
      await expect(modal(page)).toBeVisible();
      await expect(page.getByTestId('massnahme-bewerten-hinweis')).toHaveText('Bei „belegt“: was Sie wissen und die Zahl nicht zeigt.');
      // Ohne Ergebnis und Begründung sagt der Dialog es und setzt den Fokus auf das erste Feld.
      await page.getByTestId('massnahme-bewerten-senden').click();
      await expect(modal(page)).toContainText('Bitte wählen Sie ein Ergebnis.');
      await waehle(page, combo(page, 'Ergebnis'), /^belegt$/);
      await modal(page).getByLabel('Begründung').fill(BEGRUENDUNG_R6);
      ohneQuerlauf(await messe(page), 'Bewerten-Dialog');
      await ablegen(page, `bewerten-dialog-${breite}`, modal(page).first());
      await page.getByTestId('massnahme-bewerten-senden').click();
      await expect(modal(page)).toHaveCount(0);
      const stand = page.getByTestId('massnahme-stand');
      await expect(stand).toContainText(`Belegt von Ines Kaltenbach am 15.11.2028: ‚${BEGRUENDUNG_R6}‘`);
      await expect(stand).toContainText('Beobachtet: 2,4 % weniger (8 von 12 Monaten). Stand Nr. 1, Prüfsumme 4635…');
      await expect(stand).toContainText('Stand Nr. 1 · Prüfsumme sha256:4635f20a');
      await expect(page.getByTestId('massnahme-beobachtet')).toHaveCount(0);
      await expect(page.getByTestId('massnahme-wirkung-satz')).toHaveText(SATZ_R5);
      await page.getByTestId('massnahme-staende').locator('summary').click();
      await expect(page.getByTestId('massnahme-staende')).toContainText('Stand Nr. 1 · Prüfsumme');
      ohneQuerlauf(await messe(page), 'Stand Nr. 1');
      await ablegen(page, `stand-belegt-${breite}`, page.getByTestId('massnahme-bewertung'));
    });

    test('Vier-Augen: „bewerten“ wird ein Antrag; eine zweite Person bestätigt', async ({ page }) => {
      await oeffne(page, 'massnahmen', 'lage=r5&m=1&vieraugen=1', breite, AM_15_11_2028);
      await page.getByTestId('massnahme-bewerten').click();
      await waehle(page, combo(page, 'Ergebnis'), /^belegt$/);
      await modal(page).getByLabel('Begründung').fill(BEGRUENDUNG_R6);
      await page.getByTestId('massnahme-bewerten-senden').click();
      await expect(modal(page)).toHaveCount(0);
      await expect(page.getByTestId('massnahme-antrag')).toContainText('Stand Nr. 1: „belegt“ beantragt von Ines Kaltenbach am 15.11.2028');
      await expect(page.getByTestId('massnahme-bewertung')).toContainText('Ihren eigenen Antrag bestätigt eine zweite Person.');
      await expect(page.getByTestId('massnahme-freigeben')).toHaveCount(0);
      await expect(page.getByTestId('massnahme-beobachtet')).toHaveText(OFFEN);

      // Ein Antrag von Jonas Wendlinger: Ines Kaltenbach (nicht Urheberin, nicht verantwortlich) bestätigt.
      await oeffne(page, 'massnahmen', 'lage=antrag&m=1&vieraugen=1', breite, AM_15_11_2028);
      await expect(page.getByTestId('massnahme-antrag')).toContainText('beantragt von Jonas Wendlinger');
      await page.getByTestId('massnahme-freigeben').click();
      await expect(modal(page)).toContainText('Stand Nr. 1: „belegt“ beantragt von Jonas Wendlinger');
      ohneQuerlauf(await messe(page), 'Vier-Augen-Dialog');
      await ablegen(page, `vieraugen-dialog-${breite}`, modal(page).first());
      await page.getByTestId('massnahme-bewerten-senden').click();
      await expect(modal(page)).toHaveCount(0);
      await expect(page.getByTestId('massnahme-stand')).toContainText('Bestätigt von Ines Kaltenbach am 15.11.2028.');
      await expect(page.getByTestId('massnahme-antrag')).toHaveCount(0);
    });

    test('R7: ohne Messgrundlage nur der Satz und nur „nicht messbar“', async ({ page }) => {
      await oeffne(page, 'massnahmen', 'lage=r5&m=2', breite, AM_20_11_2028);
      await expect(page.getByTestId('massnahme-wirkung-satz')).toContainText('ohne Messgrundlage — Wirkung nicht messbar');
      await expect(page.getByTestId('massnahme-wirkung-monate')).toHaveCount(0);
      await page.getByTestId('massnahme-bewerten').click();
      await expect(page.getByTestId('massnahme-bewerten-hinweis')).toHaveText('Ohne Messgrundlage ist „nicht messbar“ das einzige Ergebnis.');
      await combo(page, 'Ergebnis').click();
      const liste = page.locator(`[id="${await combo(page, 'Ergebnis').getAttribute('id')}-liste"]`);
      await expect(liste.getByRole('option')).toHaveText(['nicht messbar']);
      await liste.getByRole('option', { name: 'nicht messbar' }).click();
      await modal(page).getByLabel('Begründung').fill(BEGRUENDUNG_R7);
      await page.getByTestId('massnahme-bewerten-senden').click();
      await expect(page.getByTestId('massnahme-stand')).toContainText(`Bewertet am 20.11.2028 von Ines Kaltenbach: nicht messbar — ‚${BEGRUENDUNG_R7}‘`);
      ohneQuerlauf(await messe(page), 'R7');
    });

    test('R12: Anstoß „Ausgangslage korrigiert“ — „beibehalten“ mit Begründung, die Kopie bleibt', async ({ page }) => {
      await oeffne(page, 'massnahmen', 'lage=r12&m=1', breite, AM_15_11_2028);
      const anstoss = page.getByTestId('anstoss-ausgangslage_korrigiert');
      await expect(anstoss).toContainText('Ausgangslage korrigiert · K-2028-0001 · 03.04.2028 · offen');
      await expect(anstoss.getByTestId('anstoss-bleibt')).toHaveText('beibehalten');
      await expect(anstoss.getByTestId('anstoss-neu_kopiert')).toHaveText('neu kopieren');
      await expect(anstoss.getByTestId('anstoss-neu_bewertet')).toHaveCount(0);
      const pruefsumme = await page.getByTestId('massnahme-pruefsumme').textContent();
      ohneQuerlauf(await messe(page), 'Anstoß offen');
      await ablegen(page, `anstoss-${breite}`, page.getByTestId('massnahme-anstoesse'));
      await anstoss.getByTestId('anstoss-bleibt').click();
      await anstoss.getByTestId('anstoss-beibehalten-senden').click();
      await expect(anstoss).toContainText('Begründung mit 10 bis 500 Zeichen.');
      await anstoss.getByLabel('Begründung').fill(BEGRUENDUNG_R12);
      await anstoss.getByTestId('anstoss-beibehalten-senden').click();
      await expect(anstoss).toContainText('Ausgangslage korrigiert · K-2028-0001 · 03.04.2028 · beibehalten (Ines Kaltenbach, 15.11.2028)');
      await expect(anstoss).toContainText(BEGRUENDUNG_R12);
      await expect(anstoss.getByTestId('anstoss-bleibt')).toHaveCount(0);
      await expect(page.getByTestId('massnahme-pruefsumme')).toHaveText(pruefsumme!);
    });

    test('Energieziel: Anstoß „Bezugsbasis neu gefasst“ — „neu bewerten“ öffnet den Bewerten-Dialog, „beibehalten“ mit Begründung', async ({ page }) => {
      await oeffne(page, 'energieziele', 'lage=anstoss&ez=1', breite, AM_05_11_2028);
      const anstoss = page.getByTestId('anstoss-messgrundlage_neu_gefasst');
      await expect(anstoss).toContainText('Bezugsbasis neu gefasst · BB-0001/Fassung-3 · 02.11.2028 · offen');
      await expect(anstoss.getByTestId('anstoss-neu_kopiert')).toHaveCount(0);
      await anstoss.getByTestId('anstoss-neu_bewertet').click();
      await expect(modal(page)).toContainText('Bezugsbasis neu gefasst · BB-0001/Fassung-3');
      await page.keyboard.press('Escape');
      await expect(modal(page)).toHaveCount(0);
      await anstoss.getByTestId('anstoss-bleibt').click();
      await anstoss.getByLabel('Begründung').fill('Fassung 3 ändert die Zielperiode nicht wesentlich; das Energieziel bleibt.');
      await anstoss.getByTestId('anstoss-beibehalten-senden').click();
      await expect(anstoss).toContainText('beibehalten (Ines Kaltenbach, 05.11.2028)');
      ohneQuerlauf(await messe(page), 'Energieziel-Anstoß');
    });
  });
}
