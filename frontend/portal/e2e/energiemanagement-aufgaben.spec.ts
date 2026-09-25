import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * „Energiemanagement › Aufgaben“, „Wer ist wofür verantwortlich“, die Personen-Seite und die Rolle „Einsicht“
 * (UEMS AP-19 IP-13, §5.2, R5, R6, R11) bei 375 px und 1440 px auf der Bühne von IP-9 `e2e/energiemanagement.html` —
 * die ECHTE Schale, die ECHTEN Reiter, die Routen von IP-6/IP-10 gespielt aus dem Referenzunternehmen 1.10.
 *
 * Fälle: Aufgabe zuordnen mit „entschieden von“ (R11: Bezugsbasen ab 01.03.2029, Vertretung, Beschluss B4) · Wer ist
 * wofür verantwortlich und die Personen-Seite (R5) · als „Einsicht“ kein Schreib-Knopf, an seiner Stelle der Leer-Satz (R6).
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Schritt. Mit `ENERGIEMANAGEMENT_BILDER=<Ordner>` legt der
 * Lauf je Schritt ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.ENERGIEMANAGEMENT_BILDER;
const AM_12_02_2029 = new Date('2029-02-12T14:00:00+01:00');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const VERANTWORTUNG =
  'Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen. VoltPilot hält fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr Energiemanagement genügt.';
const OHNE_PERSON = 'Bezugsbasen pflegen und freigeben — keine Person festgelegt.';
const EINSICHT_ROLLE = 'Einsicht — Sie sehen das Energiemanagement des ganzen Unternehmens und können nichts ändern.';
const EINSICHT_LEER = 'Mit ‚Einsicht‘ können Sie hier nichts ändern. Festhalten kann, wer das Energiemanagement bearbeitet.';
/** Jede Beschriftung eines Schreib-Knopfs im Bereich (IP-9 und IP-13). */
const SCHREIBEN =
  /^(Dokument anlegen|Neue Fassung|Entwurf bearbeiten|Freigeben|Freigabe beantragen|Freigabe bestätigen|Aufgabe zuordnen|Person anlegen|Zuordnung beenden|Angaben ändern)$/;
const IDS = {
  RF: 'a1900000-0000-4000-8000-0000000000f1',
  IK: 'a1900000-0000-4000-8000-0000000000a1',
  JW: 'a1900000-0000-4000-8000-0000000000a2',
};

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(AM_12_02_2029);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/energiemanagement.html?${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function ohneQuerlauf(page: Page, fall: string) {
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const ueberstehend = [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *')]
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs') && !(e instanceof HTMLInputElement && e.type === 'file'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)] };
  });
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string, ganz = false) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const path = join(BILDER, `${name}.png`);
  const vp = page.viewportSize();
  // Ein hohes Fenster statt `fullPage` — sonst stünde die feste Leiste mitten im Bild (AP-18 IP-13).
  if (ganz && vp) {
    const hoehe = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.querySelector('.vp-main')?.scrollHeight ?? 0));
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe) });
    await page.screenshot({ path });
    await page.setViewportSize(vp);
    return;
  }
  await page.screenshot({ path });
}

async function dialogBild(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const vp = page.viewportSize()!;
  const zuviel = await page.evaluate(() =>
    Math.max(0, ...[...document.querySelectorAll<HTMLElement>('.vp-modal *')].map((e) => e.scrollHeight - e.clientHeight).filter((d) => d > 1)),
  );
  await page.setViewportSize({ width: vp.width, height: vp.height + zuviel + 40 });
  await page.waitForTimeout(300);
  await modal(page).screenshot({ path: join(BILDER, `${name}.png`), animations: 'disabled' });
  await page.setViewportSize(vp);
}

const modal = (page: Page) => page.locator('.vp-modal').last();
const gesendet = (page: Page) => page.evaluate(() => (window as unknown as { __emGesendet: { route: string; koerper: unknown }[] }).__emGesendet);

async function waehle(page: Page, name: string, option: RegExp) {
  const feld = modal(page).getByRole('combobox', { name, exact: true });
  await feld.click();
  const id = await feld.getAttribute('id');
  await page.locator(`[id="${id}-liste"]`).getByRole('option', { name: option }).click();
}

for (const breite of [375, 1440]) {
  test.describe(`Energiemanagement › Aufgaben bei ${breite} px`, () => {
    test('R5/R11: Aufgabe zuordnen mit „entschieden von“ — Bezugsbasen ab 01.03.2029, Vertretung, Beschluss B4', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&seite=aufgaben', breite);
      await expect(page.getByTestId('energiemanagement-reiter-aufgaben')).toHaveAttribute('aria-selected', 'true');
      const reiter = page.getByTestId('aufgaben-reiter');
      await expect(reiter.getByRole('heading', { level: 2 })).toHaveText('Aufgaben im Energiemanagement');
      // R5: zehn laufende Zuordnungen am 22.01.2029 — und am 12.02.2029 dieselben; Bezugsbasen als Satz, keine Warnung.
      await expect(reiter.locator('.vp-em-zuordnung')).toHaveCount(10);
      await expect(reiter.getByTestId('zuordnung-beenden')).toHaveCount(10);
      await expect(page.getByTestId('aufgabe-bezugsbasen').getByTestId('aufgabe-ohne-person')).toHaveText(OHNE_PERSON);
      await expect(page.getByTestId('aufgabe-unternehmensleitung')).toContainText('Robert Falk seit 01.10.2026.');
      await expect(page.getByTestId('zuordnung-energiemanagement_leiten-IK')).toContainText(
        'Ines Kaltenbach seit 01.10.2026, Vertretung Jonas Wendlinger, entschieden von Robert Falk.',
      );
      await expect(page.getByTestId('zuordnung-energiemanagement_leiten-IK')).toContainText('Beleg: Bestellung Energiemanagement vom 28.09.2026, unterschrieben · Personalakte (Personalabteilung)');
      await expect(page.getByTestId('personen-liste').getByTestId('person-zeile-RF')).toContainText('ohne Konto');
      await expect(page.getByText(GRENZE)).toBeVisible();
      await expect(page.getByText(VERANTWORTUNG)).toBeVisible();
      await ohneQuerlauf(page, 'Aufgaben 12.02.2029');
      await ablegen(page, `a-aufgaben-${breite}`, true);

      // Aus der Zeile zuordnen: die Aufgabe ist vorbelegt; ohne „entschieden von“ nimmt der Dialog nicht an (PA2).
      await page.getByTestId('aufgabe-bezugsbasen').getByTestId('aufgabe-zeile-zuordnen').click();
      await expect(modal(page).getByRole('combobox', { name: 'Aufgabe', exact: true })).toContainText('Bezugsbasen pflegen und freigeben');
      await waehle(page, 'Person', /^Ines Kaltenbach/);
      await modal(page).getByRole('combobox', { name: 'gilt ab', exact: true }).click();
      await page.getByRole('button', { name: 'Nächster Monat' }).click();
      await page.getByRole('gridcell', { name: '1', exact: true }).first().click();
      await waehle(page, 'Vertretung (wahlfrei)', /^Jonas Wendlinger/);
      await modal(page).getByLabel('Begründung').fill('Beschluss B4 der Managementbewertung 2028: Bezugsbasen pflegen und freigeben.');
      await modal(page).getByLabel('Beschluss (wahlfrei)').fill('BR-2029-0001/B4');
      await page.getByTestId('zuordnen-senden').click();
      await expect(modal(page).getByText('Bitte wählen Sie, wer entschieden hat.')).toBeVisible();
      await waehle(page, 'entschieden von', /^Robert Falk/);
      await ohneQuerlauf(page, 'Dialog Aufgabe zuordnen');
      await dialogBild(page, `b-zuordnen-${breite}`);
      await page.getByTestId('zuordnen-senden').click();
      await expect(page.locator('.vp-modal')).toHaveCount(0);

      // Am 12.02.2029 bleibt der Satz — darunter die künftige Zuordnung mit „ab“.
      const zeile = page.getByTestId('aufgabe-bezugsbasen');
      await expect(zeile.getByTestId('aufgabe-ohne-person')).toHaveText(OHNE_PERSON);
      await expect(zeile.getByTestId('zuordnung-bezugsbasen-IK')).toContainText(
        'Ines Kaltenbach ab 01.03.2029, Vertretung Jonas Wendlinger, entschieden von Robert Falk.',
      );
      await expect(zeile.getByTestId('zuordnung-bezugsbasen-IK')).toContainText('Beschluss BR-2029-0001/B4');
      const koerper = (await gesendet(page)).filter((g) => g.route === 'POST /api/v1/energiemanagement/aufgaben');
      expect(koerper).toEqual([
        {
          route: 'POST /api/v1/energiemanagement/aufgaben',
          koerper: {
            aufgabe: 'bezugsbasen', person_id: IDS.IK, gilt_ab: '2029-03-01', vertretung_person_id: IDS.JW, entschieden_von: IDS.RF,
            begruendung: 'Beschluss B4 der Managementbewertung 2028: Bezugsbasen pflegen und freigeben.', beleg: null, beschluss_kennung: 'BR-2029-0001/B4',
          },
        },
      ]);

      // Stand am 01.03.2029: die Zuordnung läuft, der Satz ist weg (R11).
      await reiter.getByRole('combobox', { name: 'Stand am', exact: true }).click();
      await page.getByRole('button', { name: 'Nächster Monat' }).click();
      await page.getByRole('gridcell', { name: '1', exact: true }).first().click();
      await expect(zeile.getByTestId('aufgabe-ohne-person')).toHaveCount(0);
      await expect(zeile.getByTestId('zuordnung-bezugsbasen-IK')).toContainText(
        'Ines Kaltenbach seit 01.03.2029, Vertretung Jonas Wendlinger, entschieden von Robert Falk.',
      );
      await ohneQuerlauf(page, 'Aufgaben 01.03.2029');
      await ablegen(page, `c-aufgaben-0103-${breite}`);
    });

    test('R5: Wer ist wofür verantwortlich — gelesen, ohne Urteil — und die Personen-Seite der Leitung ohne Konto', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&seite=aufgaben', breite);
      await page.getByTestId('verantwortung-link').click();
      expect(await page.evaluate(() => location.hash)).toBe('#/portfolio/energiemanagement/verantwortung');
      await expect(page.getByTestId('energiemanagement-reiter-aufgaben')).toHaveAttribute('aria-selected', 'true');
      const v = page.getByTestId('verantwortung-ansicht');
      await expect(v.getByRole('heading', { level: 2 })).toHaveText('Wer ist wofür verantwortlich');
      await expect(page.getByTestId('verantwortung-aufgabe-bezugsbasen')).toHaveText(OHNE_PERSON);
      const einsaetze = ['Murat Demirci', 'Peter Hollerbach', 'Ines Kaltenbach', 'Ines Kaltenbach', 'Peter Hollerbach', 'Jonas Wendlinger', 'Jonas Wendlinger', 'Ines Kaltenbach'];
      for (const [i, name] of einsaetze.entries()) await expect(page.getByTestId(`verantwortung-objekt-EE-${i + 1}`)).toContainText(name);
      for (const [i, name] of ['Ines Kaltenbach', 'Ines Kaltenbach', 'Ines Kaltenbach', 'Jonas Wendlinger', 'Peter Hollerbach'].entries()) {
        await expect(page.getByTestId(`verantwortung-objekt-BB-000${i + 1}`)).toContainText(name);
      }
      await expect(page.getByTestId('verantwortung-art-bezugsbasis')).toContainText('Verantwortlich an den Bezugsbasen: die Verantwortlichen der Kennzahlen.');
      await expect(page.getByTestId('verantwortung-freigaben-satz')).toHaveText('Alle 5 Bezugsbasen hat Ines Kaltenbach freigegeben.');
      await expect(page.getByTestId('verantwortung-freigaben').locator('tbody tr')).toHaveCount(8);
      await expect(page.getByText(GRENZE)).toBeVisible();
      await ohneQuerlauf(page, 'Wer ist wofür verantwortlich');
      await ablegen(page, `d-verantwortung-${breite}`, true);

      await page.getByTestId('verantwortung-aufgabe-unternehmensleitung').getByRole('button', { name: 'Robert Falk' }).click();
      expect(await page.evaluate(() => location.hash)).toBe(`#/portfolio/energiemanagement/personen/${IDS.RF}`);
      const seite = page.getByTestId('person-seite');
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('Robert Falk');
      await expect(page.getByTestId('person-ohne-konto')).toHaveText('Robert Falk · Geschäftsführer · ohne Konto — erscheint als ‚entschieden von‘.');
      await expect(page.getByTestId('person-aufgabe-unternehmensleitung')).toContainText('Leitung des Unternehmens seit 01.10.2026.');
      await expect(seite.getByText(GRENZE)).toBeVisible();
      await expect(seite.getByText(VERANTWORTUNG)).toBeVisible();
      await expect(page.getByTestId('person-aendern')).toBeVisible();
      await ohneQuerlauf(page, 'Personen-Seite Robert Falk');
      await ablegen(page, `e-person-rf-${breite}`, true);
      await page.getByTestId('person-zurueck').click();
      await expect(page.getByTestId('aufgaben-reiter')).toBeVisible();
    });

    test('R6: als „Einsicht“ kein Schreib-Knopf — an seiner Stelle der Leer-Satz, lesen und CSV bleiben', async ({ page }) => {
      const ohneSchreiben = async (fall: string) => {
        await expect(page.getByRole('button', { name: SCHREIBEN }), fall).toHaveCount(0);
        await ohneQuerlauf(page, fall);
      };
      await oeffne(page, 'person=RF&lage=ahrenberg', breite);
      await expect(page.getByTestId('einsicht-rolle')).toHaveText(EINSICHT_ROLLE);
      await expect(page.getByTestId('verzeichnis-zeile-D-0001').first()).toBeVisible();
      await expect(page.getByTestId('verzeichnis-csv')).toBeVisible();
      await ohneSchreiben('Einsicht: Verzeichnis');

      await page.getByTestId('energiemanagement-reiter-dokumente').click();
      await expect(page.getByTestId('dokument-zeile-D-0001')).toBeVisible();
      await expect(page.getByTestId('dokumente-register').getByTestId('einsicht-satz')).toHaveText(EINSICHT_LEER);
      await ohneSchreiben('Einsicht: Dokumente');
      await ablegen(page, `f-einsicht-dokumente-${breite}`, true);

      await page.getByTestId('dokument-zeile-D-0001').getByRole('button').click();
      await expect(page.getByTestId('dokument-kopf')).toContainText('entschieden von Robert Falk');
      await expect(page.getByTestId('dokument-seite').getByTestId('einsicht-satz')).toHaveCount(1);
      await ohneSchreiben('Einsicht: Dokument D-0001');

      await oeffne(page, 'person=RF&lage=ahrenberg&seite=aufgaben', breite);
      await expect(page.getByTestId('aufgabe-bezugsbasen').getByTestId('aufgabe-ohne-person')).toHaveText(OHNE_PERSON);
      await expect(page.getByTestId('aufgaben-reiter').getByTestId('einsicht-satz')).toHaveText(EINSICHT_LEER);
      await ohneSchreiben('Einsicht: Aufgaben');
      await ablegen(page, `g-einsicht-aufgaben-${breite}`, true);

      await page.getByTestId('verantwortung-link').click();
      await expect(page.getByTestId('verantwortung-freigaben-satz')).toBeVisible();
      await ohneSchreiben('Einsicht: Wer ist wofür verantwortlich');

      await oeffne(page, 'person=RF&lage=ahrenberg&ps=IK', breite);
      await expect(page.getByTestId('person-seite').getByRole('heading', { level: 1 })).toHaveText('Ines Kaltenbach');
      await expect(page.getByTestId('person-seite').getByTestId('einsicht-satz')).toHaveText(EINSICHT_LEER);
      await ohneSchreiben('Einsicht: Personen-Seite');
      expect(await gesendet(page)).toEqual([]);
    });
  });
}
