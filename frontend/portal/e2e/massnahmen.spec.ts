import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * „Unternehmen › Ziele und Maßnahmen › Maßnahmen“ (UEMS AP-18 IP-13) bei 375 px und 1440 px auf der eigenen Bühne
 * `e2e/massnahmen.html` — die ECHTE Schale mit den ECHTEN Reitern, die Routen gespielt aus dem Referenzunternehmen 1.9
 * (`src/test/massnahmeFixtures.ts`, R3/R7/R9).
 *
 * Fälle: Register am 15.03.2028 (R9: M-2028-0002 überfällig seit 15 Tagen zuerst, „ohne Messgrundlage“ in der Zeile,
 * Filter) · Anlegen mit Messgrundlage am 22.01.2028 (R3: KZ-0004, Ausgangslage Dezember 2027 in der Vorschau, 3 %) und
 * „umgesetzt melden“ (kein Tag in der Zukunft) · Anlegen ohne Messgrundlage am Energieeinsatz EE-3 (R7: sichtbare Wahl,
 * Zahl gesperrt) · Einstieg am Energieziel (vorbelegt).
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Fall. Mit `MASSNAHMEN_BILDER=<Ordner>` legt der Lauf
 * je Fall ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.MASSNAHMEN_BILDER;
const AM_15_03_2028 = new Date('2028-03-15T09:00:00Z');
const AM_22_01_2028 = new Date('2028-01-22T09:00:00Z');
const AM_20_01_2028 = new Date('2028-01-20T09:00:00Z');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const OHNE = 'ohne Messgrundlage — Wirkung nicht messbar';
const UEBERFAELLIG_R9 = 'M-2028-0002 · geplant · Termin 29.02.2028 · überfällig seit 15 Tagen · Ines Kaltenbach.';

async function oeffne(page: Page, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/massnahmen.html?${query}`);
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

async function ablegen(page: Page, name: string, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const path = join(BILDER, `${name}.png`);
  const vp = page.viewportSize();
  // Die feste Leiste stünde in einem Vollseitenbild mitten im Inhalt: dort ein hohes Fenster statt `fullPage`.
  if (ganz && vp) {
    const hoehe = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe) });
    await page.screenshot({ path });
    await page.setViewportSize(vp);
    return;
  }
  await page.screenshot({ path, fullPage: ganz });
}

/** Ein ganzes Modal ablegen: am Telefon scrollt es in sich — dann das Modal selbst als Bild. */
async function ablegenDialog(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.locator('.vp-modal').first().screenshot({ path: join(BILDER, `${name}.png`) });
}

async function waehle(page: Page, feld: Locator, option: RegExp) {
  await feld.click();
  const id = await feld.getAttribute('id');
  await page.locator(`[id="${id}-liste"]`).getByRole('option', { name: option }).click();
}

async function waehleTag(page: Page, feld: Locator, iso: string) {
  await feld.click();
  const tag = page.locator(`.vp-kal-tag[data-iso="${iso}"]:not(.is-rand)`);
  for (let i = 0; i < 24 && !(await tag.isVisible()); i++) await page.getByRole('button', { name: 'Nächster Monat' }).click();
  await tag.click();
  // Am Telefon gleitet das Kalender-Blatt hinaus — erst danach steht der Dialog wieder frei.
  await expect(page.locator('.vp-kal-tag').first()).toBeHidden();
}

const modal = (page: Page) => page.locator('.vp-modal');
const combo = (page: Page, name: string) => modal(page).getByRole('combobox', { name, exact: true });

for (const breite of [375, 1440]) {
  test.describe(`Maßnahmen bei ${breite} px`, () => {
    test('Register R9: überfällig zuerst, „ohne Messgrundlage“ in der Zeile, Filter „nur überfällige“', async ({ page }) => {
      await oeffne(page, 'lage=r9', breite, AM_15_03_2028);
      const tafel = page.getByTestId('massnahmen-tafel');
      await expect(tafel).toBeVisible();
      const zeilen = tafel.locator('tbody tr');
      await expect(zeilen).toHaveCount(2);
      await expect(zeilen.nth(0)).toHaveAttribute('data-testid', 'massnahme-zeile-M-2028-0002');
      await expect(zeilen.nth(0).getByTestId('termin')).toContainText('überfällig seit 15 Tagen');
      await expect(zeilen.nth(0).getByTestId('messgrundlage')).toHaveText(OHNE);
      await expect(zeilen.nth(1).getByTestId('messgrundlage')).toHaveText('KZ-0004 Stromeinsatz Spritzguss je kg');
      await expect(page.getByTestId('massnahmen-register').getByText(GRENZE)).toBeVisible();
      ohneQuerlauf(await messe(page), 'Register');
      await ablegen(page, `register-${breite}`, true);
      await page.getByTestId('massnahmen-filter-ueberfaellig').check();
      await expect(zeilen).toHaveCount(1);
      await zeilen.nth(0).getByRole('button', { name: 'M-2028-0002' }).click();
      await expect(page.getByTestId('massnahme-frist')).toHaveText(UEBERFAELLIG_R9);
      await expect(page.getByTestId('massnahme-ohne-messgrundlage')).toContainText('braucht Druckluft eine Energieleistungskennzahl');
      expect(await page.evaluate(() => location.hash)).toMatch(/^#\/portfolio\/verbesserung\/massnahmen\/[0-9a-f-]{36}$/);
      ohneQuerlauf(await messe(page), 'Seite R7');
      await ablegen(page, `seite-ohne-${breite}`, true);
    });

    test('Anlegen mit Messgrundlage (R3) und „umgesetzt melden“ — kein Tag in der Zukunft', async ({ page }) => {
      await oeffne(page, 'lage=leer', breite, AM_22_01_2028);
      await expect(page.getByTestId('massnahmen-leer')).toBeVisible();
      await page.getByTestId('massnahme-anlegen-knopf').click();
      await expect(modal(page).getByTestId('massnahme-wahl-mit')).toBeChecked();
      await expect(modal(page).getByTestId('massnahme-wirkung-zahl')).toBeDisabled();
      await modal(page).getByLabel('Titel').fill('Werkzeugheizungen in Betriebspausen abschalten');
      await waehle(page, combo(page, 'Verantwortlich'), /^Murat Demirci/);
      await waehleTag(page, combo(page, 'Termin'), '2028-01-31');
      await waehle(page, combo(page, 'Kennzahl'), /^KZ-0004/);
      const vorschau = modal(page).getByTestId('massnahme-ausgangslage-vorschau');
      await expect(vorschau).toContainText('Ausgangslage Dezember 2027:');
      await expect(vorschau).toContainText('12,9 % mehr als die Bezugsbasis erwarten lässt: schlechter');
      await expect(vorschau.getByTestId('massnahme-methode')).toContainText('keine Wahl');
      await expect(modal(page).getByTestId('massnahme-wirkung-zahl')).toBeEnabled();
      await modal(page).getByTestId('massnahme-wirkung-zahl').fill('3');
      await modal(page).getByLabel('erwartete Wirkung — Wortlaut').fill('Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion.');
      ohneQuerlauf(await messe(page), 'Dialog mit Messgrundlage');
      await ablegenDialog(page, `anlegen-mit-${breite}`);
      await page.getByTestId('massnahme-anlegen-senden').click();

      const seite = page.getByTestId('massnahme-seite');
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('Maßnahme M-2028-0001');
      await expect(page.getByTestId('massnahme-kopf')).toHaveText(
        'M-2028-0001 · Werkzeugheizungen in Betriebspausen abschalten · Verantwortlich Murat Demirci · Termin 31.01.2028.',
      );
      await expect(page.getByTestId('massnahme-messgrundlage-satz')).toContainText('Ausgangslage Dezember 2027: 12,9 % mehr als erwartet');
      await expect(page.getByTestId('massnahme-pruefsumme')).toHaveText(/^Prüfsumme sha256:[0-9a-f]{64}$/);
      await expect(page.getByTestId('massnahme-messgrundlage-satz')).toContainText('Erwartete Wirkung: 3 % weniger');
      await expect(page.getByTestId('massnahme-erwartete-wirkung')).toHaveCount(0);
      await page.getByTestId('massnahme-kommentar').getByLabel('Kommentar').fill('Zeitschaltung ist bestellt.');
      await page.getByTestId('massnahme-kommentar-senden').click();
      await expect(page.getByTestId('verlauf-kommentar')).toContainText('Zeitschaltung ist bestellt.');
      ohneQuerlauf(await messe(page), 'Seite geplant');
      await ablegen(page, `seite-geplant-${breite}`, true);

      await page.getByTestId('massnahme-umgesetzt-knopf').click();
      const am = combo(page, 'umgesetzt am');
      await am.click();
      await expect(page.locator('.vp-kal-tag[data-iso="2028-01-23"]:not(.is-rand)')).toBeDisabled();
      await page.locator('.vp-kal-tag[data-iso="2028-01-22"]:not(.is-rand)').click();
      await modal(page).getByLabel('Begründung').fill('Zeitschaltung an den Maschinen 3 bis 6 aktiv, Probelauf ohne Befund.');
      ohneQuerlauf(await messe(page), 'Dialog umgesetzt');
      await ablegenDialog(page, `umgesetzt-dialog-${breite}`);
      await page.getByTestId('massnahme-umgesetzt-senden').click();
      await expect(page.getByTestId('massnahme-kopf')).toHaveText(
        'M-2028-0001 · Werkzeugheizungen in Betriebspausen abschalten · Verantwortlich Murat Demirci · Termin 31.01.2028 · umgesetzt am 22.01.2028.',
      );
      await expect(page.getByTestId('massnahme-umgesetzt-knopf')).toHaveCount(0);
      await expect(page.getByTestId('massnahme-aendern-knopf')).toHaveCount(0);
      await expect(page.getByTestId('verlauf-massnahme_umgesetzt')).toContainText('umgesetzt gemeldet');
      ohneQuerlauf(await messe(page), 'Seite umgesetzt');
      await ablegen(page, `seite-umgesetzt-${breite}`, true);
    });

    test('Anlegen ohne Messgrundlage am Energieeinsatz EE-3 (R7): sichtbare Wahl, Zahl gesperrt', async ({ page }) => {
      await oeffne(page, 'lage=leer&seite=einsatz', breite, AM_20_01_2028);
      const einstieg = page.getByTestId('massnahme-anlegen-einstieg-einsatz');
      await expect(einstieg).toBeVisible();
      ohneQuerlauf(await messe(page), 'Energieeinsatz');
      await ablegen(page, `einsatz-${breite}`);
      await einstieg.getByTestId('massnahme-anlegen-knopf').click();
      await expect(modal(page).getByTestId('massnahme-herkunft-vorbelegt')).toHaveText('am Energieeinsatz');
      await expect(modal(page).getByTestId('massnahme-wahl-ohne')).toBeChecked();
      await expect(modal(page).getByTestId('massnahme-ohne-satz')).toContainText(OHNE);
      await expect(modal(page).getByTestId('massnahme-wirkung-zahl')).toBeDisabled();
      await expect(combo(page, 'Energieeinsatz (wahlfrei)')).toContainText('EE-3');
      await modal(page).getByLabel('Titel').fill('Druckluft-Leckagen orten und beseitigen');
      await waehle(page, combo(page, 'Verantwortlich'), /^Ines Kaltenbach/);
      await waehleTag(page, combo(page, 'Termin'), '2028-02-29');
      await modal(page).getByLabel('erwartete Wirkung — Wortlaut').fill('Leckagen verursachen einen großen Teil des Druckluft-Stroms außerhalb der Produktion.');
      ohneQuerlauf(await messe(page), 'Dialog ohne Messgrundlage');
      await ablegenDialog(page, `anlegen-ohne-${breite}`);
      await page.getByTestId('massnahme-anlegen-senden').click();
      const angelegt = page.getByTestId('massnahme-angelegt');
      await expect(angelegt).toContainText('Maßnahme M-2028-0001 angelegt');
      await angelegt.getByRole('link').click();
      await expect(page.getByTestId('massnahme-ohne-messgrundlage')).toHaveText(
        'M-2028-0001 · Druckluft-Leckagen orten und beseitigen · ohne Messgrundlage — Wirkung nicht messbar. Um die Wirkung zu messen, braucht Druckluft eine Energieleistungskennzahl (zum Beispiel Stromeinsatz je Betriebsstunde mit einer Bezugsbasis).',
      );
      await expect(page.getByTestId('massnahme-herkunft')).toContainText('am Energieeinsatz EE-3');
      await expect(page.getByTestId('massnahme-pruefsumme')).toHaveCount(0);
      await expect(page.getByTestId('massnahme-erwartete-wirkung')).toHaveText(
        'erwartete Wirkung: ‚Leckagen verursachen einen großen Teil des Druckluft-Stroms außerhalb der Produktion.‘',
      );
      ohneQuerlauf(await messe(page), 'Seite ohne Messgrundlage');
    });

    test('Einstieg am Energieziel: vorbelegt mit Kennzahl und Energieziel', async ({ page }) => {
      await oeffne(page, 'lage=leer&ez=1', breite, AM_22_01_2028);
      await page.getByTestId('massnahme-anlegen-einstieg-energieziel').getByTestId('massnahme-anlegen-knopf').click();
      await expect(modal(page).getByTestId('massnahme-herkunft-vorbelegt')).toHaveText('aus dem Energieziel');
      await expect(combo(page, 'Kennzahl')).toContainText('KZ-0004');
      await expect(combo(page, 'Energieziel (wahlfrei)')).toContainText('EZ-2028-0001');
      await expect(modal(page).getByTestId('massnahme-ausgangslage-vorschau')).toContainText('12,9 % mehr');
      ohneQuerlauf(await messe(page), 'Dialog am Energieziel');
    });
  });
}
