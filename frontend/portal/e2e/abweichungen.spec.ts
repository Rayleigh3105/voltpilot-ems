import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Auffälligkeiten und Abweichungen (UEMS AP-18 IP-18) bei 375 px und 1440 px auf der eigenen Bühne
 * `e2e/abweichungen.html` — die ECHTE Schale mit der ECHTEN Kennzahl-Seite (Reiter „Vergleich mit Bezugsbasis“) und dem
 * ECHTEN Bereich „Ziele und Maßnahmen“; die Routen gespielt aus dem Referenzunternehmen 1.9
 * (`src/test/abweichungFixtures.ts`, R1/R2/R8/R11, dazu `massnahmeFixtures.ts` für die neue Maßnahme).
 *
 * Fälle: Vermerk → Abweichung → Ursache-Aussage → Abschluss „Maßnahme“ mit Sprung in den vorbelegten Dialog
 * „Maßnahme anlegen“ (R1/R2, 15.01.2028) · „zur Kenntnis nehmen“ mit Pflicht-Begründung (R11) und „Abweichung eröffnen“
 * von Hand an einer Zeile „im Rahmen“ (A3) · Register am 10.02.2028 (überfällig zuerst, abgeschlossen mit Ergebnis) und
 * die abgeschlossene AW-2026-0001 mit geerbtem Vorbehalt (R8).
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Fall. Mit `ABWEICHUNGEN_BILDER=<Ordner>` legt der Lauf
 * je Fall ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.ABWEICHUNGEN_BILDER;
const AM_15_01_2028 = new Date('2028-01-15T09:00:00Z');
const AM_10_02_2028 = new Date('2028-02-10T09:00:00Z');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const AUSSAGE = 'Die Werkzeugheizungen der Maschinen 3 bis 6 liefen vom 23.12. bis 02.01. durch — keine Abschaltung in der Betriebspause programmiert.';

async function oeffne(page: Page, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/abweichungen.html?${query}`);
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

async function vergleich(page: Page) {
  await expect(page.getByTestId('kennzahl-seite')).toBeVisible();
  await page.getByTestId('kennzahl-reiter-vergleich').click();
  await expect(page.getByTestId('bezugsbasis-vergleich')).toBeVisible();
}

for (const breite of [375, 1440]) {
  test.describe(`Abweichungen bei ${breite} px`, () => {
    test('Vermerk → Abweichung → Ursache-Aussage → Abschluss „Maßnahme“ mit Sprung in den vorbelegten Dialog (R1/R2)', async ({ page }) => {
      await oeffne(page, 'lage=vermerk&seite=kennzahl', breite, AM_15_01_2028);
      await vergleich(page);
      const dez = page.getByTestId('monat-2027-12');
      const vermerk = dez.getByTestId('vermerk-2027-12');
      await expect(vermerk).toContainText('Auffälligkeit — vermerkt am 07.01.2028');
      await expect(vermerk.getByTestId('vermerk-eroeffnen')).toHaveText('Abweichung eröffnen');
      await expect(vermerk.getByTestId('vermerk-zur-kenntnis')).toHaveText('zur Kenntnis nehmen');
      // „Abweichung eröffnen“ von Hand an jeder Zeile mit Vergleich — auch „im Rahmen“ (A3).
      await expect(page.getByTestId('monat-2028-02').getByTestId('von-hand-2028-02')).toBeVisible();
      ohneQuerlauf(await messe(page), 'Vergleich mit Vermerk');
      await dez.scrollIntoViewIfNeeded();
      await ablegen(page, `vermerk-zeile-${breite}`);

      await vermerk.getByTestId('vermerk-eroeffnen').click();
      await expect(modal(page).getByTestId('auffaelligkeit-mitgenommen')).toHaveText(
        'Die Abweichung übernimmt alle offenen Auffälligkeiten dieser Kennzahl und Fassung: Dezember 2027.',
      );
      await waehle(page, combo(page, 'Verantwortlich'), /^Ines Kaltenbach/);
      ohneQuerlauf(await messe(page), 'Antwort-Dialog');
      await ablegenDialog(page, `antwort-dialog-${breite}`);
      await page.getByTestId('auffaelligkeit-antwort-senden').click();

      const seite = page.getByTestId('abweichung-seite');
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('Abweichung AW-2028-0001');
      expect(await page.evaluate(() => location.hash)).toMatch(/^#\/portfolio\/verbesserung\/abweichungen\/[0-9a-f-]{36}$/);
      await expect(page.getByTestId('abweichung-kopf')).toHaveText(
        'Abweichung AW-2028-0001 · KZ-0004 Stromeinsatz Spritzguss je kg, Dezember 2027: 12,9 % mehr als die Bezugsbasis erwarten lässt · Verantwortlich Ines Kaltenbach · Frist 14.02.2028 · offen.',
      );
      await expect(page.getByTestId('anlass-satz')).toHaveText(
        'Dezember 2027: 78 000 kWh gemessen, 69 098 kWh erwartet bei 250 000 kg — 12,9 % mehr als die Bezugsbasis erwarten lässt: schlechter.',
      );
      await expect(page.getByTestId('abweichung-pruefsumme')).toHaveText(/^Prüfsumme sha256:[0-9a-f]{64}$/);
      await expect(page.getByTestId('abweichung-vergleich').getByTestId('monat-2027-12')).toBeVisible();

      // Ursache-Aussage: Murat Demirci sagt aus, Ines Kaltenbach trägt ein (R2) — nie ein Satz des Systems (U1–U3).
      await page.getByTestId('abweichung-aussage-knopf').click();
      await waehle(page, combo(page, 'Aussage von …'), /^Murat Demirci/);
      await waehleTag(page, combo(page, 'Tag der Aussage'), '2028-01-14');
      await modal(page).getByLabel('Wortlaut der Aussage').fill(AUSSAGE);
      await page.getByTestId('ursache-aussage-senden').click();
      const zeile = page.getByTestId('verlauf-ursache_aussage');
      await expect(zeile.getByTestId('ursache-aussage-satz')).toHaveText(`Ursache — Aussage von Murat Demirci, 14.01.2028 (keine Messung): ‚${AUSSAGE}‘`);
      await expect(zeile.getByTestId('ursache-aussage-kennzeichen')).toHaveText('Aussage von Murat Demirci, 14.01.2028 — keine Messung');
      await expect(zeile).toContainText('Ursache-Aussage eingetragen · Ines Kaltenbach · 15.01.2028');
      ohneQuerlauf(await messe(page), 'Seite offen');
      await ablegen(page, `seite-offen-${breite}`, true);

      // Abschluss „Maßnahme“: Sprung in „Maßnahme anlegen“, vorbelegt mit Herkunft, Kennung, Kennzahl und Monat.
      await page.getByTestId('abweichung-abschliessen-knopf').click();
      await modal(page).getByTestId('abschluss-massnahme').check();
      await page.getByTestId('abschluss-massnahme-anlegen').click();
      const anlegen = modal(page).getByTestId('massnahme-anlegen');
      await expect(anlegen.getByTestId('massnahme-herkunft-vorbelegt')).toHaveText('aus der Abweichung AW-2028-0001');
      await expect(combo(page, 'Kennzahl')).toContainText('KZ-0004');
      await expect(anlegen.getByTestId('massnahme-ausgangslage-vorschau')).toContainText('Ausgangslage Dezember 2027:');
      await modal(page).getByLabel('Titel').fill('Werkzeugheizungen in Betriebspausen abschalten');
      await waehle(page, combo(page, 'Verantwortlich'), /^Murat Demirci/);
      await waehleTag(page, combo(page, 'Termin'), '2028-01-31');
      await modal(page).getByTestId('massnahme-wirkung-zahl').fill('3');
      await modal(page).getByLabel('erwartete Wirkung — Wortlaut').fill('Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion.');
      ohneQuerlauf(await messe(page), 'Sprung in Maßnahme anlegen');
      await ablegenDialog(page, `abschluss-sprung-${breite}`);
      await page.getByTestId('massnahme-anlegen-senden').click();

      await expect(combo(page, 'Bestehende Maßnahme')).toContainText('M-2028-0001');
      await modal(page).getByLabel('Begründung').fill('Aussage von Murat Demirci erklärt die Ursache plausibel; Dezember-Werte bleiben.');
      await ablegenDialog(page, `abschluss-dialog-${breite}`);
      await page.getByTestId('abweichung-abschliessen-senden').click();
      await expect(page.getByTestId('abschluss-satz')).toHaveText(
        'Abgeschlossen am 15.01.2028 von Ines Kaltenbach: Maßnahme M-2028-0001 — ‚Aussage von Murat Demirci erklärt die Ursache plausibel; Dezember-Werte bleiben.‘',
      );
      await expect(seite.getByRole('heading', { level: 1 }).locator('..')).toContainText('abgeschlossen');
      await expect(page.getByTestId('abweichung-abschliessen-knopf')).toHaveCount(0);
      await expect(page.getByTestId('abweichung-aussage-knopf')).toHaveCount(0);
      ohneQuerlauf(await messe(page), 'Seite abgeschlossen');
      await ablegen(page, `seite-abgeschlossen-${breite}`, true);

      await page.getByTestId('abschluss-sprung-massnahme').click();
      await expect(page.getByTestId('massnahme-herkunft')).toContainText('aus der Abweichung AW-2028-0001');
    });

    test('„zur Kenntnis nehmen“ nur mit Begründung (R11); „Abweichung eröffnen“ von Hand an „im Rahmen“ (A3)', async ({ page }) => {
      await oeffne(page, 'lage=vermerk&seite=kennzahl', breite, AM_15_01_2028);
      await vergleich(page);
      await page.getByTestId('vermerk-zur-kenntnis').click();
      await page.getByTestId('auffaelligkeit-antwort-senden').click();
      await expect(modal(page).locator('.vp-ez-fehler')).toHaveText('Begründung mit 10 bis 500 Zeichen.');
      await modal(page).getByLabel('Begründung').fill('Kleinserien-Sonderauftrag KW 27–29, im Produktionsplan dokumentiert; keine Abweichung des Prozesses.');
      ohneQuerlauf(await messe(page), 'zur Kenntnis');
      await ablegenDialog(page, `zur-kenntnis-dialog-${breite}`);
      await page.getByTestId('auffaelligkeit-antwort-senden').click();
      const antwort = page.getByTestId('monat-2027-12').getByTestId('vermerk-antwort');
      await expect(antwort).toContainText('zur Kenntnis genommen von Ines Kaltenbach am 15.01.2028');
      await expect(page.getByTestId('vermerk-eroeffnen')).toHaveCount(0);
      await page.getByTestId('monat-2027-12').scrollIntoViewIfNeeded();
      await ablegen(page, `vermerk-zur-kenntnis-${breite}`);

      await page.getByTestId('von-hand-2028-02').click();
      await page.getByTestId('von-hand-senden').click();
      await expect(modal(page).locator('.vp-ez-fehler').first()).toBeVisible();
      await modal(page).getByLabel('Warum').fill('Februar trotz Umsetzung kaum weniger — prüfen, ob die Zeitschaltung greift.');
      await waehle(page, combo(page, 'Verantwortlich'), /^Murat Demirci/);
      await page.getByTestId('von-hand-senden').click();
      await expect(page.getByTestId('abweichung-herkunft')).toContainText('von Hand eröffnet');
      await expect(page.getByTestId('abweichung-wortlaut')).toHaveText('‚Februar trotz Umsetzung kaum weniger — prüfen, ob die Zeitschaltung greift.‘');
      ohneQuerlauf(await messe(page), 'von Hand');
    });

    test('Register am 10.02.2028: offen und überfällig zuerst, abgeschlossen mit Ergebnis; AW-2026-0001 mit Vorbehalt (R8)', async ({ page }) => {
      await oeffne(page, 'lage=register', breite, AM_10_02_2028);
      const tafel = page.getByTestId('abweichungen-tafel');
      await expect(tafel).toBeVisible();
      const zeilen = tafel.locator('tbody tr');
      await expect(zeilen).toHaveCount(2);
      await expect(zeilen.nth(0)).toHaveAttribute('data-testid', 'abweichung-zeile-AW-2028-0001');
      await expect(zeilen.nth(0).getByTestId('frist')).toContainText('überfällig seit 10 Tagen');
      await expect(zeilen.nth(1).getByTestId('ergebnis')).toHaveText('erklärt');
      await expect(page.getByTestId('verbesserung-bereich').getByText(GRENZE)).toBeVisible();
      ohneQuerlauf(await messe(page), 'Register');
      await ablegen(page, `register-${breite}`, true);
      await page.getByTestId('abweichungen-filter-ueberfaellig').check();
      await expect(zeilen).toHaveCount(1);
      await page.getByTestId('abweichungen-filter-ueberfaellig').uncheck();

      await zeilen.nth(1).getByRole('button', { name: 'AW-2026-0001' }).click();
      await expect(page.getByTestId('abweichung-vorbehalte')).toContainText('Bezugsbasis vorläufig (1 von 12 Monaten)');
      await expect(page.getByTestId('ursache-aussage-satz')).toContainText('Ursache — Aussage von Jonas Wendlinger, 10.12.2026 (keine Messung)');
      await expect(page.getByTestId('abschluss-satz')).toContainText('Abgeschlossen am 20.12.2026 von Ines Kaltenbach: erklärt');
      ohneQuerlauf(await messe(page), 'Seite R8');
      await ablegen(page, `seite-r8-${breite}`, true);
    });
  });
}
