import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { grenzHinweisZeigt } from './grenzHinweis';

/**
 * „Verbessern › Maßnahmen“ (Verbessern-Konzept v1 §6.5–§6.9, PR 2) bei 375 px und 1440 px auf der eigenen Bühne
 * `e2e/massnahmen.html` — die ECHTE Schale mit den ECHTEN Reitern, die Routen gespielt aus dem Referenzunternehmen 1.9
 * (`src/test/massnahmeFixtures.ts`, R3/R7/R9, Schätzung wie Entscheid 13).
 *
 * Fälle: Register nach Stufen am 15.03.2028 (R9: „Zu tun“ mit M-2028-0002 überfällig, die Art als Marke statt des
 * Mangels, Chips) und die Seite der überfälligen Maßnahme · „Maßnahme planen“ am Energieziel (R3: Kennzahl vorbelegt,
 * Prozent in kWh im Jahr, Prüfen am Ende), Kommentar, „Umsetzung melden“ (Heute vorgewählt) · „Maßnahme planen“ im
 * Register ohne Kennzahl (Schätzung in kWh, als solche gekennzeichnet) · Einstieg am Energieeinsatz EE-3 · „Ändern“
 * zeigt die Richtung als Wort (V7).
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Fall. Mit `MASSNAHMEN_BILDER=<Ordner>` legt der Lauf
 * je Fall ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.MASSNAHMEN_BILDER;
const AM_15_03_2028 = new Date('2028-03-15T09:00:00Z');
const AM_20_01_2028 = new Date('2028-01-20T09:00:00Z');
/** Der Tag der Energieziel-Route (`energiezielBuehne('juli')`): eine Uhr für Bühne und Route. */
const AM_10_07_2028 = new Date('2028-07-10T08:00:00Z');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const WORTLAUT_R3 = 'Heizungen laufen etwa ein Fünftel der Zeit ohne Produktion.';
const WORTLAUT_R7 = 'Leckagen verursachen einen großen Teil des Druckluft-Stroms außerhalb der Produktion.';

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

const modal = (page: Page) => page.locator('.vp-modal');
const combo = (page: Page, name: string) => modal(page).getByRole('combobox', { name, exact: true });
/** Am Rechner stehen Knopf und Zusammenfassung zweimal im Blatt (Spalte rechts, Schritt 4 am Telefon): der sichtbare. */
const sichtbar = (page: Page, testid: string) => modal(page).locator(`[data-testid="${testid}"]:visible`);

for (const breite of [375, 1440]) {
  const telefon = breite < 720;
  /** Am Telefon vier Schritte: „Weiter“ prüft den Schritt; am Rechner stehen alle Fragen in einem Dialog. */
  const weiter = async (page: Page) => {
    if (telefon) await modal(page).getByTestId('planen-weiter').click();
  };
  const bisWann = (page: Page, wort: string) => modal(page).getByRole('group', { name: 'Bis wann?' }).getByRole('button', { name: wort }).click();

  test.describe(`Maßnahmen bei ${breite} px`, () => {
    test('Register R9 nach Stufen: überfällig in „Zu tun“, die Art als Marke, Chips; die Seite der überfälligen Maßnahme', async ({ page }) => {
      await oeffne(page, 'lage=r9', breite, AM_15_03_2028);
      const register = page.getByTestId('massnahmen-register');
      await expect(register.getByRole('heading', { level: 1 })).toHaveText('Maßnahmen');
      await expect(page.getByTestId('massnahmen-antwort')).toContainText('1 Maßnahme ist seit 15 Tagen überfällig; 1 ist umgesetzt und noch abzuschließen.');
      const zuTun = page.getByTestId('massnahmen-gruppe-zu_tun');
      const m2 = zuTun.getByTestId('massnahme-eintrag-M-2028-0002');
      await expect(m2).toHaveAttribute('data-entscheid', 'massnahme_termin');
      await expect(m2.getByTestId('massnahme-marke')).toHaveText('nicht gemessen');
      await expect(m2.getByTestId('massnahme-schritt')).toHaveText('Umsetzung melden');
      const m1 = page.getByTestId('massnahmen-gruppe-umgesetzt').getByTestId('massnahme-eintrag-M-2028-0001');
      await expect(m1.getByTestId('massnahme-bringt')).toContainText(/2,4\s%\sweniger/);
      await expect(m1.getByTestId('massnahme-schritt')).toHaveText('Wirkung prüfen');
      await expect(register).not.toContainText('ohne Messgrundlage — Wirkung nicht messbar');
      await grenzHinweisZeigt(page.getByTestId('verbesserung-bereich'), GRENZE);
      ohneQuerlauf(await messe(page), 'Register');
      await ablegen(page, `register-${breite}`, true);

      await page.getByTestId('massnahmen-chip-umgesetzt').click();
      await expect(zuTun).toHaveCount(0);
      await expect(page.getByTestId('massnahmen-chip-umgesetzt')).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('massnahmen-chip-alle').click();
      await page.getByTestId('massnahme-oeffnen-M-2028-0002').click();
      await expect(page.getByTestId('massnahme-titel')).toHaveText('Druckluft-Leckagen orten und beseitigenM-2028-0002');
      await expect(page.getByTestId('massnahme-antwort')).toContainText('Seit 15 Tagen überfällig - Termin war 29.02.2028.');
      await expect(page.getByTestId('massnahme-umgesetzt-knopf')).toHaveText('Umsetzung melden');
      await expect(page.getByTestId('massnahme-erwartete-wirkung')).toContainText('Nicht gemessen:');
      await expect(page.getByTestId('massnahme-zustand')).toHaveAttribute('data-entscheid', 'massnahme_termin');
      expect(await page.evaluate(() => location.hash)).toMatch(/^#\/portfolio\/verbesserung\/massnahmen\/[0-9a-f-]{36}$/);
      ohneQuerlauf(await messe(page), 'Seite überfällig');
      await ablegen(page, `seite-ueberfaellig-${breite}`, true);
    });

    test('Planen am Energieziel (R3): Kennzahl vorbelegt, Prozent in kWh im Jahr, Prüfen am Ende; Kommentar und „Umsetzung melden“', async ({ page }) => {
      await oeffne(page, 'lage=leer&ez=1', breite, AM_10_07_2028);
      await page.getByTestId('massnahme-anlegen-einstieg-energieziel').getByTestId('massnahme-anlegen-knopf').click();
      const blatt = page.getByTestId('massnahme-anlegen');
      await expect(page.getByTestId('massnahme-herkunft-vorbelegt')).toContainText('für das Energieziel 2028');
      await expect(blatt.getByTestId('planen-art-gemessen').locator('input')).toBeChecked();
      // Ohne Titel geht es nicht weiter: der Fehler steht am Feld, nicht erst nach dem Senden.
      if (telefon) {
        await weiter(page);
        await expect(blatt).toContainText('Bitte sagen Sie in einem Satz, was zu tun ist.');
      }
      await blatt.getByTestId('planen-titel').fill('Werkzeugheizungen in Betriebspausen abschalten');
      await weiter(page);
      await blatt.getByTestId('planen-prozent').fill('3');
      await expect(blatt.getByTestId('planen-umrechnung')).toHaveText(
        /^Entspricht rund 30\.500\skWh im Jahr - gerechnet mit 1\.017\.050\skWh in Juli 2027 bis Juni 2028\.$/,
      );
      await expect(blatt.getByTestId('planen-vorher')).toContainText('Juni 2028');
      await blatt.getByTestId('planen-wortlaut').fill(WORTLAUT_R3);
      await weiter(page);
      await waehle(page, combo(page, 'Wer kümmert sich?'), /^Murat Demirci/);
      await bisWann(page, 'Ende August');
      await expect(blatt).toContainText('Termin 31.08.2028 - noch 52 Tage.');
      await weiter(page);
      const pruef = sichtbar(page, 'planen-zusammenfassung');
      await expect(pruef).toContainText('Murat Demirci');
      await expect(pruef).toContainText('31.08.2028');
      ohneQuerlauf(await messe(page), 'Planen mit Kennzahl');
      await ablegenDialog(page, `planen-mit-${breite}`);
      await sichtbar(page, 'massnahme-anlegen-senden').click();

      // Am Energieziel öffnet das Anlegen gleich die Seite der neuen Maßnahme.
      await expect(page.getByTestId('massnahme-titel')).toHaveText('Werkzeugheizungen in Betriebspausen abschaltenM-2028-0001');
      await expect(page.getByTestId('massnahme-antwort')).toContainText('Geplant bis 31.08.2028 - noch 52 Tage.');
      await expect(page.getByTestId('massnahme-erwartete-wirkung')).toContainText(/3\s%\sweniger als erwartet, rund 30\.500\skWh im Jahr/);
      await expect(page.getByTestId('massnahme-erwartete-wirkung')).toContainText(WORTLAUT_R3);
      await expect(page.getByTestId('massnahme-pruefsumme')).toHaveText(/^Prüfsumme sha256:[0-9a-f]{64}$/);
      await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Kommentar schreiben' }).click();
      await modal(page).getByTestId('massnahme-kommentar-text').fill('Zeitschaltung ist bestellt.');
      await page.getByTestId('massnahme-kommentar-senden').click();
      await expect(modal(page)).toHaveCount(0);
      await expect(page.getByTestId('verlauf-kommentar')).toContainText('Zeitschaltung ist bestellt.');
      ohneQuerlauf(await messe(page), 'Seite geplant');
      await ablegen(page, `seite-geplant-${breite}`, true);

      await page.getByTestId('massnahme-umgesetzt-knopf').click();
      await expect(modal(page).getByRole('button', { name: 'Heute, 10.07.' })).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('massnahme-umgesetzt-text').fill('Zeitschaltung an den Maschinen 3 bis 6 aktiv, Probelauf ohne Befund.');
      ohneQuerlauf(await messe(page), 'Umsetzung melden');
      await ablegenDialog(page, `umgesetzt-dialog-${breite}`);
      await page.getByTestId('massnahme-umgesetzt-senden').click();
      await expect(modal(page)).toHaveCount(0);
      await expect(page.getByTestId('massnahme-umgesetzt-knopf')).toHaveCount(0);
      await expect(page.getByTestId('verlauf-massnahme_umgesetzt')).toContainText('Umgesetzt');
      await expect(page.getByTestId('massnahme-wirkung-leer')).toContainText('VoltPilot vergleicht ab August 2028 zwölf Monate lang');
      await expect(page.getByTestId('massnahme-bewerten')).toHaveText('Wirkung prüfen');
      ohneQuerlauf(await messe(page), 'Seite umgesetzt');
      await ablegen(page, `seite-umgesetzt-${breite}`, true);
    });

    test('Planen im Register ohne Kennzahl (Entscheid 13): Schätzung in kWh im Jahr, auf der Seite als Schätzung', async ({ page }) => {
      await oeffne(page, 'lage=leer', breite, AM_20_01_2028);
      await expect(page.getByTestId('massnahmen-leer')).toBeVisible();
      ohneQuerlauf(await messe(page), 'Register leer');
      await ablegen(page, `register-leer-${breite}`);
      await page.locator('[data-testid^="massnahme-planen-knopf"]:visible').click();
      const blatt = page.getByTestId('massnahme-anlegen');
      await blatt.getByTestId('planen-titel').fill('Druckluft-Leckagen orten und beseitigen');
      await blatt.getByTestId('planen-art-nicht_gemessen').locator('input').check();
      await weiter(page);
      await expect(blatt.getByTestId('planen-prozent')).toHaveCount(0);
      await blatt.getByTestId('planen-kwh').fill('12.000');
      await blatt.getByTestId('planen-wortlaut').fill(WORTLAUT_R7);
      await waehle(page, combo(page, 'Wo spart sie? (Energieeinsatz, wahlfrei)'), /Druckluft/);
      await weiter(page);
      await waehle(page, combo(page, 'Wer kümmert sich?'), /^Ines Kaltenbach/);
      await bisWann(page, 'Ende Februar');
      await weiter(page);
      await expect(sichtbar(page, 'planen-zusammenfassung')).toContainText(/12\.000\skWh im Jahr/);
      ohneQuerlauf(await messe(page), 'Planen ohne Kennzahl');
      await ablegenDialog(page, `planen-ohne-${breite}`);
      await sichtbar(page, 'massnahme-anlegen-senden').click();

      await expect(page.getByTestId('massnahme-titel')).toHaveText('Druckluft-Leckagen orten und beseitigenM-2028-0001');
      await expect(page.getByTestId('massnahme-erwartete-wirkung')).toContainText(/rund 12\.000\skWh im Jahr, geschätzt/);
      await expect(page.getByTestId('massnahme-ohne-messgrundlage')).toContainText('misst VoltPilot die Wirkung.');
      await expect(page.getByTestId('massnahme-pruefsumme')).toHaveCount(0);
      ohneQuerlauf(await messe(page), 'Seite ohne Kennzahl');
      await ablegen(page, `seite-ohne-${breite}`, true);
    });

    test('Einstieg am Energieeinsatz EE-3: „nicht gemessen“ vorbelegt', async ({ page }) => {
      await oeffne(page, 'lage=leer&seite=einsatz', breite, AM_20_01_2028);
      const einstieg = page.getByTestId('massnahme-anlegen-einstieg-einsatz');
      await expect(einstieg).toBeVisible();
      await einstieg.getByTestId('massnahme-anlegen-knopf').click();
      await expect(page.getByTestId('massnahme-herkunft-vorbelegt')).toContainText('am Energieeinsatz');
      await expect(page.getByTestId('planen-art-nicht_gemessen').locator('input')).toBeChecked();
      ohneQuerlauf(await messe(page), 'Planen am Energieeinsatz');
    });

    test('„Ändern“ zeigt die Richtung als Wort (V7) und steht im Menü', async ({ page }) => {
      await oeffne(page, 'lage=geplant&m=1', breite, AM_20_01_2028);
      await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Ändern' }).click();
      await expect(page.getByTestId('massnahme-aendern-zahl')).toHaveValue('3');
      await expect(modal(page).getByRole('button', { name: 'weniger' })).toHaveAttribute('aria-pressed', 'true');
      ohneQuerlauf(await messe(page), 'Ändern');
      await ablegenDialog(page, `aendern-${breite}`);
    });
  });
}
