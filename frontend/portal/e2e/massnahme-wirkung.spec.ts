import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Die Wirkung auf der Seite einer Maßnahme (Verbessern-Konzept v1 §6.6, PR 2; UEMS AP-18 IP-20) bei 375 px und 1440 px
 * auf der Bühne `e2e/massnahmen.html` - die ECHTE Maßnahmen-Seite, die Routen gespielt aus dem Referenzunternehmen 1.9
 * (`src/test/massnahmeFixtures.ts`, R5/R6/R7/R12) am 15.11.2028; dazu „neu bewerten“ bzw. „beibehalten“ an der
 * Energieziel-Seite (`e2e/energieziele.html`, Lage `anstoss`).
 *
 * Fälle: Wirkung lesen (R5: Kacheln, Grafik mit Infozeile, Fazit mit dem Grund des März, „Werte je Monat“ mit roher
 * Kennzahl ohne Wort) und ohne Stand „beobachtet — nicht belegt“ · „Wirkung prüfen“ mit Antwort-Karten → Stand Nr. 1
 * als Zitat (R6) · Vier-Augen: der Antrag, eine zweite Person bestätigt · ohne Messung „Abschließen“ mit einem Satz
 * (R7, Entscheid 6) · Anstoß „beibehalten“ mit Begründung (R12) · Anstoß am Energieziel „neu bewerten“.
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
    // Eine Tabelle scrollt in ihrem Rahmen (Portal-Regel): gezählt wird der Rahmen, nicht seine Zellen; ein
    // geschlossener Aufklapper zeigt nur seine Zeile.
    const lokal = (e: Element) => {
      if (e.closest('details:not([open])') && !e.closest('summary')) return true;
      for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
        // Schale und Dialog-Körper scrollen selbst: ihre Inhalte zählen weiter.
        if (/vp-modal|vp-main|vp-shell/.test(p.className)) break;
        if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) return true;
      }
      return false;
    };
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs') && !lokal(e))
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

const modal = (page: Page) => page.locator('.vp-modal');
const MAERZ_R5 = 'Produktionsmenge Spritzguss 390 000 kg außerhalb der Bezugsbasis';

for (const breite of [375, 1440]) {
  test.describe(`Wirkung und Bewertung bei ${breite} px`, () => {
    test('R5: Kacheln, Grafik mit Infozeile, Fazit mit dem Grund des März, Werte je Monat; ohne Stand „beobachtet — nicht belegt“', async ({ page }) => {
      await oeffne(page, 'massnahmen', 'lage=r5&m=1', breite, AM_15_11_2028);
      await expect(page.getByTestId('massnahme-wirkung-satz')).toHaveText(SATZ_R5);
      await expect(page.getByTestId('massnahme-antwort')).toContainText(/Seit der Umsetzung 2,4\s%\sweniger Strom/);
      await expect(page.getByTestId('massnahme-kachel-Weniger als erwartet')).toContainText(/16\.100/);
      await expect(page.getByTestId('massnahme-wirkung-fazit')).toContainText('6 von 8 Monaten lagen unter der Erwartung, 1 im Rahmen, 1 darüber.');
      await expect(page.getByTestId('massnahme-wirkung-fazit')).toContainText(MAERZ_R5);
      await expect(page.getByTestId('massnahme-wirkung-info')).toContainText('Oktober 2028');
      await page.getByTestId('wirkung-monat-2028-03').click();
      await expect(page.getByTestId('massnahme-wirkung-info')).toContainText(MAERZ_R5);
      await page.getByTestId('massnahme-wirkung-monate').locator('summary').click();
      await expect(page.getByTestId('wirkung-2028-02').getByTestId('roh')).toHaveText('0,2672');
      await expect(page.getByTestId('wirkung-2028-03').getByTestId('urteil')).toHaveText('nicht bewertbar');
      await expect(page.getByTestId('massnahme-beobachtet')).toHaveText(OFFEN);
      await expect(page.getByTestId('massnahme-stand')).toHaveCount(0);
      await expect(page.getByTestId('massnahme-seite')).not.toContainText(KAUSAL);
      ohneQuerlauf(await messe(page), 'Wirkung');
      await ablegen(page, `wirkung-${breite}`, page.getByTestId('massnahme-seite'));
    });

    test('R6: „Wirkung prüfen“ - beobachtete Zahl oben, Antwort-Karten, ein Satz → Stand Nr. 1 als Zitat', async ({ page }) => {
      await oeffne(page, 'massnahmen', 'lage=r5&m=1', breite, AM_15_11_2028);
      await page.getByTestId('massnahme-bewerten').click();
      const blatt = page.getByTestId('massnahme-bewerten-dialog');
      await expect(blatt.getByTestId('massnahme-bewerten-beobachtet')).toContainText(/2,4\s%\sweniger als erwartet · 8 von 12 Monaten · erwartet waren 3\s%/);
      await expect(blatt).toContainText('Wird als Stand Nr. 1 festgehalten.');
      // Ohne Antwort sagt das Blatt es, statt zu senden.
      await page.getByTestId('massnahme-bewerten-senden').click();
      await expect(blatt).toContainText('Bitte wählen Sie eine Antwort.');
      await blatt.getByTestId('massnahme-bewerten-wahl-belegt').locator('input').check();
      await blatt.getByTestId('massnahme-bewerten-text').fill(BEGRUENDUNG_R6);
      ohneQuerlauf(await messe(page), 'Wirkung prüfen');
      await ablegen(page, `bewerten-dialog-${breite}`, modal(page).first());
      await page.getByTestId('massnahme-bewerten-senden').click();
      await expect(modal(page)).toHaveCount(0);
      const stand = page.getByTestId('massnahme-stand');
      await expect(stand).toContainText(`‚${BEGRUENDUNG_R6}‘`);
      await expect(stand).toContainText('Ines Kaltenbach · 15.11.2028');
      await expect(page.getByTestId('massnahme-bewertung').getByTestId('massnahme-marke')).toHaveText('belegt');
      await expect(page.getByTestId('massnahme-beobachtet')).toHaveCount(0);
      await page.getByTestId('massnahme-staende').locator('summary').click();
      await expect(page.getByTestId('massnahme-staende')).toContainText('Stand Nr. 1 · belegt');
      await expect(page.getByTestId('massnahme-staende')).toContainText('Prüfsumme sha256:');
      ohneQuerlauf(await messe(page), 'Stand Nr. 1');
      await ablegen(page, `stand-belegt-${breite}`, page.getByTestId('massnahme-bewertung'));
    });

    test('Vier-Augen: „Wirkung prüfen“ wird ein Antrag; eine zweite Person bestätigt', async ({ page }) => {
      await oeffne(page, 'massnahmen', 'lage=r5&m=1&vieraugen=1', breite, AM_15_11_2028);
      await page.getByTestId('massnahme-bewerten').click();
      await page.getByTestId('massnahme-bewerten-wahl-belegt').locator('input').check();
      await page.getByTestId('massnahme-bewerten-text').fill(BEGRUENDUNG_R6);
      await page.getByTestId('massnahme-bewerten-senden').click();
      await expect(modal(page)).toHaveCount(0);
      await expect(page.getByTestId('massnahme-antrag')).toContainText('Ines Kaltenbach hat „belegt“ beantragt (15.11.2028)');
      await expect(page.getByTestId('massnahme-antrag')).toContainText('Bestätigen oder ablehnen kann eine zweite Person.');
      await expect(page.getByTestId('massnahme-bewertung')).toContainText('Ihren eigenen Antrag bestätigt eine zweite Person.');
      await expect(page.getByTestId('massnahme-freigeben')).toHaveCount(0);
      await expect(page.getByTestId('massnahme-beobachtet')).toHaveCount(0);

      // Ein Antrag von Jonas Wendlinger: Ines Kaltenbach (nicht Urheberin, nicht verantwortlich) bestätigt.
      await oeffne(page, 'massnahmen', 'lage=antrag&m=1&vieraugen=1', breite, AM_15_11_2028);
      await expect(page.getByTestId('massnahme-antrag')).toContainText('Jonas Wendlinger hat „belegt“ beantragt');
      await page.getByTestId('massnahme-freigeben').click();
      await expect(modal(page)).toContainText('Stand Nr. 1: „belegt“ beantragt von Jonas Wendlinger');
      ohneQuerlauf(await messe(page), 'Vier-Augen-Dialog');
      await ablegen(page, `vieraugen-dialog-${breite}`, modal(page).first());
      await page.getByTestId('massnahme-bewerten-senden').click();
      await expect(modal(page)).toHaveCount(0);
      await expect(page.getByTestId('massnahme-stand')).toContainText('Bestätigt von Ines Kaltenbach am 15.11.2028.');
      await expect(page.getByTestId('massnahme-antrag')).toHaveCount(0);
    });

    test('R7 / Entscheid 6: ohne Messung keine Grafik - „Abschließen“ mit einem Satz, als Ergebnis „nicht messbar“', async ({ page }) => {
      await oeffne(page, 'massnahmen', 'lage=r5&m=2', breite, AM_20_11_2028);
      const knopf = page.getByTestId('massnahme-bewerten');
      await expect(knopf).toHaveText('Abschließen');
      await expect(page.getByTestId('massnahme-wirkung')).toHaveCount(0);
      await expect(page.getByTestId('massnahme-kacheln')).toHaveCount(0);
      await knopf.click();
      const blatt = page.getByTestId('massnahme-bewerten-dialog');
      await expect(blatt.getByTestId('massnahme-bewerten-wahl')).toHaveCount(0);
      await blatt.getByTestId('massnahme-bewerten-text').fill(BEGRUENDUNG_R7);
      ohneQuerlauf(await messe(page), 'Abschließen');
      await ablegen(page, `abschliessen-dialog-${breite}`, modal(page).first());
      await page.getByTestId('massnahme-bewerten-senden').click();
      await expect(modal(page)).toHaveCount(0);
      await expect(page.getByTestId('massnahme-stand')).toContainText(`‚${BEGRUENDUNG_R7}‘`);
      await expect(page.getByTestId('massnahme-bewertung').getByTestId('massnahme-marke')).toHaveText('nicht messbar');
      ohneQuerlauf(await messe(page), 'R7');
      await ablegen(page, `abgeschlossen-ohne-${breite}`, page.getByTestId('massnahme-seite'));
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
