import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * „Unternehmen › Ziele und Maßnahmen › Energieziele“ (UEMS AP-18 IP-8) bei 375 px und 1440 px auf der eigenen Bühne
 * `e2e/energieziele.html` — die ECHTE Schale mit der ECHTEN Leiste und den ECHTEN Reitern, die Routen gespielt aus dem
 * Referenzunternehmen 1.9 (`src/test/energiezielFixtures.ts`, R4/R10).
 *
 * Fälle: leerer Zustand (Satz und Grenz-Satz, R13) · Anlegen an KZ-0004 am 20.12.2027 (Basis-Zeile, Vorgabe nächstes
 * Kalenderjahr, R4) · Stand im Register und auf der Seite am 10.07.2028 (5 von 12, März nicht gezählt, kein Vorschlag) ·
 * Bewerten nach dem Ende (R10: fällig seit 15 Tagen, kein Vorschlag, „verfehlt“) · Vier-Augen (IK beantragt, JW bestätigt).
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Fall. Mit `ENERGIEZIELE_BILDER=<Ordner>` legt der Lauf
 * je Fall ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.ENERGIEZIELE_BILDER;
const AM_20_12_2027 = new Date('2027-12-20T09:00:00Z');
const AM_10_07_2028 = new Date('2028-07-10T09:00:00Z');
const AM_15_01_2029 = new Date('2029-01-15T09:00:00Z');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const LEER =
  'Noch keine Energieziele, Maßnahmen oder Abweichungen. Sie entstehen aus Ihren Energieleistungskennzahlen: aus einer Auffälligkeit, aus einem Energieziel oder von Hand.';
const STAND_JULI =
  'Energieziel EZ-2028-0001 · Spritzguss: 5 % weniger Strom als die Bezugsbasis erwarten lässt · Januar bis Dezember 2028 · Verantwortlich Ines Kaltenbach. Stand nach 5 von 12 Monaten: 2,9 % weniger (März 2028 nicht bewertbar: Produktionsmenge außerhalb der Bezugsbasis). Bezugsbasis BB-0001, Fassung 2.';
const BEGRUENDUNG = 'Zwei Maßnahmen wirken erst ab dem zweiten Halbjahr; Juli und März tragen den Rest.';

async function oeffne(page: Page, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/energieziele.html?${query}`);
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
    const reiter = [...document.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]')]
      .filter((t) => sichtbar(t))
      .map((t) => (t.textContent ?? '').trim());
    return { route: document.body.dataset.route ?? null, dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)], reiter };
  });
}

function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, fall: string) {
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const path = join(BILDER, `${name}.png`);
  const vp = page.viewportSize();
  // Am Telefon stünde die feste Leiste in einem Vollseitenbild mitten im Inhalt: dort ein hohes Fenster statt `fullPage`.
  if (ganz && vp && vp.width < 720) {
    const hoehe = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe) });
    await page.screenshot({ path });
    await page.setViewportSize(vp);
    return;
  }
  await page.screenshot({ path, fullPage: ganz });
}

async function waehle(page: Page, feld: Locator, option: RegExp) {
  await feld.click();
  const id = await feld.getAttribute('id');
  await page.locator(`[id="${id}-liste"]`).getByRole('option', { name: option }).click();
}

const begruendung = (page: Page) => page.locator('.vp-modal').getByLabel('Begründung');

for (const breite of [375, 1440]) {
  test.describe(`Energieziele bei ${breite} px`, () => {
    test('leerer Zustand (R13): Satz und Grenz-Satz; der Reiter Abweichungen ehrlich leer', async ({ page }) => {
      await oeffne(page, 'lage=leer', breite, AM_20_12_2027);
      await expect(page.getByTestId('energieziele-leer')).toHaveText(LEER);
      await expect(page.getByTestId('verbesserung-bereich').getByText(GRENZE)).toBeVisible();
      const m = await messe(page);
      expect(m.reiter).toEqual(expect.arrayContaining(['Energieziele', 'Maßnahmen', 'Abweichungen']));
      if (breite >= 720) expect(m.reiter).toContain('Ziele und Maßnahmen');
      ohneQuerlauf(m, 'leer');
      await ablegen(page, `leer-${breite}`, true);
      await page.getByTestId('verbesserung-reiter-abweichungen').click();
      await expect(page.getByTestId('verbesserung-leer-abweichungen')).toBeVisible();
      await expect(page.getByTestId('verbesserung-leer-abweichungen').getByRole('button')).toHaveCount(0);
      expect(await page.evaluate(() => location.hash)).toBe('#/portfolio/verbesserung/abweichungen');
    });

    test('Anlegen an KZ-0004 (R4): Basis-Zeile, Vorgabe Januar bis Dezember 2028, danach die Seite des Energieziels', async ({ page }) => {
      await oeffne(page, 'lage=leer&seite=kennzahl', breite, AM_20_12_2027);
      const knopf = page.getByTestId('energieziel-setzen-knopf');
      await expect(knopf).toBeVisible();
      await ablegen(page, `kennzahl-${breite}`);
      await knopf.click();
      const dialog = page.getByTestId('energieziel-setzen');
      await expect(dialog.getByTestId('energieziel-basis-zeile')).toContainText('Bezugsbasis BB-0001 · Fassung 2');
      await expect(dialog.getByText('Januar bis Dezember 2028 — ganze Monate, frühestens ab dem nächsten Monat.')).toBeVisible();
      await expect(dialog.getByText(GRENZE)).toBeVisible();
      await ablegen(page, `dialog-${breite}`);
      await page.locator('.vp-modal').getByLabel(/Zielwert in % weniger/).fill('5');
      await page.locator('.vp-modal').getByLabel('Wortlaut').fill('Spritzguss: 5 % weniger Strom als die Bezugsbasis erwarten lässt — Jahresziel 2028.');
      await begruendung(page).fill('Jahresplanung 2028 nach der Freigabe der Fassung 2 (24.11.2027).');
      ohneQuerlauf(await messe(page), 'Dialog');
      await page.getByTestId('energieziel-setzen-senden').click();
      const gesetzt = page.getByTestId('energieziel-gesetzt');
      await expect(gesetzt).toContainText('Energieziel EZ-2028-0001 gesetzt');
      await gesetzt.getByRole('link').click();
      const seite = page.getByTestId('energieziel-seite');
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('Energieziel EZ-2028-0001');
      await expect(page.getByTestId('energieziel-stand-satz')).toHaveText('noch kein bewertbarer Monat (0 von 12).');
      await expect(page.getByTestId('energieziel-verlauf')).toContainText('angelegt');
      ohneQuerlauf(await messe(page), 'neu');
    });

    test('Stand am 10.07.2028 (R4): Register mit Stand-Spalte, Seite mit Monaten, Summenzeile und ohne Vorschlag', async ({ page }) => {
      await oeffne(page, 'lage=juli', breite, AM_10_07_2028);
      const zeile = page.getByTestId('energieziel-zeile-EZ-2028-0001');
      await expect(zeile.getByTestId('stand')).toHaveText('2,9 % weniger nach 5 von 12 Monaten');
      ohneQuerlauf(await messe(page), 'Register');
      await ablegen(page, `register-${breite}`, true);
      await zeile.getByRole('button', { name: 'EZ-2028-0001' }).click();
      await expect(page.getByTestId('energieziel-stand-satz')).toHaveText(STAND_JULI);
      await expect(page.getByTestId('monat-2028-03').getByTestId('grund')).toContainText('außerhalb der Bezugsbasis');
      await expect(page.getByTestId('monat-2028-01').getByTestId('urteil')).toHaveText('besser (± 2 %)');
      await expect(page.getByTestId('monat-2028-07')).toContainText('noch nicht endgültig');
      await expect(page.getByTestId('energieziel-summe')).toContainText('5 von 12 Monaten');
      await expect(page.getByTestId('energieziel-summe')).toContainText('410 400 kWh');
      await expect(page.getByTestId('energieziel-vorschlag')).toHaveCount(0);
      await expect(page.getByTestId('energieziel-bewerten')).toHaveCount(0);
      await expect(page.getByTestId('energieziel-seite').getByText(GRENZE)).toBeVisible();
      ohneQuerlauf(await messe(page), 'Seite');
      await ablegen(page, `seite-stand-${breite}`, true);
    });

    test('Bewerten am 15.01.2029 (R10): fällig seit 15 Tagen, kein Vorschlag, „verfehlt“ mit Begründung', async ({ page }) => {
      await oeffne(page, 'lage=faellig&ez=1', breite, AM_15_01_2029);
      await expect(page.getByTestId('energieziel-frist')).toHaveText('Bewertung fällig seit 15 Tagen');
      await expect(page.getByTestId('energieziel-summe')).toContainText('11 von 12 Monaten');
      await page.getByTestId('energieziel-bewerten').click();
      await expect(page.getByTestId('bewerten-ohne-vorschlag')).toBeVisible();
      await waehle(page, page.locator('.vp-modal').getByRole('combobox', { name: 'Ergebnis', exact: true }), /^verfehlt$/);
      await begruendung(page).fill(BEGRUENDUNG);
      ohneQuerlauf(await messe(page), 'Bewerten');
      await ablegen(page, `bewerten-${breite}`);
      await page.getByTestId('energieziel-bewerten-senden').click();
      await expect(page.getByTestId('energieziel-bewertet')).toHaveText('Bewertet am 15.01.2029 von Ines Kaltenbach: verfehlt.');
      await expect(page.getByTestId('energieziel-frist')).toHaveCount(0);
      await expect(page.getByTestId('energieziel-verlauf')).toContainText('bewertet');
      ohneQuerlauf(await messe(page), 'bewertet');
      await ablegen(page, `bewertet-${breite}`, true);
    });

    test('Vier-Augen: „bewerten“ wird ein Antrag (409 vieraugen_beantragen → beantragen), Jonas Wendlinger bestätigt', async ({ page }) => {
      await oeffne(page, 'lage=faellig&ez=1&vieraugen=1', breite, AM_15_01_2029);
      await page.getByTestId('energieziel-bewerten').click();
      await waehle(page, page.locator('.vp-modal').getByRole('combobox', { name: 'Ergebnis', exact: true }), /^verfehlt$/);
      await begruendung(page).fill(BEGRUENDUNG);
      await page.getByTestId('energieziel-bewerten-senden').click();
      await expect(page.getByTestId('energieziel-beantragt')).toContainText('beantragt von Ines Kaltenbach am 15.01.2029');
      await expect(page.getByText('Ihren eigenen Antrag bestätigt eine zweite Person.')).toBeVisible();
      await expect(page.getByTestId('energieziel-freigeben')).toHaveCount(0);

      await oeffne(page, 'lage=beantragt&ez=1&person=JW', breite, AM_15_01_2029);
      await page.getByTestId('energieziel-freigeben').click();
      await begruendung(page).fill('Geprüft: Stand und Begründung stimmen mit dem Jahresbericht überein.');
      await page.getByTestId('energieziel-bewerten-senden').click();
      await expect(page.getByTestId('energieziel-bewertet')).toHaveText('Bewertet am 15.01.2029 von Ines Kaltenbach: verfehlt.');
      await expect(page.getByTestId('energieziel-bestaetigt')).toHaveText('Bestätigt von Jonas Wendlinger am 15.01.2029.');
      ohneQuerlauf(await messe(page), 'Vier-Augen');
    });
  });
}
