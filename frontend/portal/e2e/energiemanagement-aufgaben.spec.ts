import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { grenzHinweisZeigt } from './grenzHinweis';

/**
 * „Energiemanagement › Aufgaben“, „Wer ist wofür verantwortlich“, die Personen-Seite und die Rolle „Einsicht“
 * (UEMS AP-19 IP-13, §5.2, R5, R6, R11) bei 375 px und 1440 px auf der Bühne von IP-9 `e2e/energiemanagement.html` —
 * die ECHTE Schale, die ECHTEN Reiter, die Routen von IP-6/IP-10 gespielt aus dem Referenzunternehmen 1.10.
 *
 * Seit Konzept Nachweisen n1 Runde 2 (§6.8, Entscheid 23, PR 5): „Wer macht was · Stand …“, die Status-Zeile, je
 * Aufgabe eine Zeile mit Kurzwort und Kürzeln (am Rechner mit Namen), Name, Vertretung, seit wann, Beleg und Beschluss im
 * Blatt der Aufgabe; die Personen am Rechner rechts, am Telefon hinter „Personen“; „Stand an einem anderen Tag“ und
 * „Wer ist wofür verantwortlich“ im Menü „…“.
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
const AUFGABEN_KURZ = [
  'Leitung', 'Energiemanagement leiten', 'Energieteam', 'Bezugsbasen', 'Ziele und Maßnahmen', 'Energetische Bewertung', 'Interne Audits',
  'Managementbewertung', 'Dokumente',
];
const EINSICHT_ROLLE = 'Einsicht — Sie sehen das Energiemanagement des ganzen Unternehmens und können nichts ändern.';
const EINSICHT_LEER = 'Mit ‚Einsicht‘ können Sie hier nichts ändern. Festhalten kann, wer das Energiemanagement bearbeitet.';
/** Jede Beschriftung eines Schreib-Knopfs im Bereich (IP-9, IP-13, IP-15 „Nachweis festhalten“ und IP-20 Audits/Feststellungen). */
const SCHREIBEN =
  /^(Dokument anlegen|Neue Fassung|Entwurf bearbeiten|Freigeben|Freigabe beantragen|Freigabe bestätigen|Aufgabe zuordnen|Person anlegen|Zuordnung beenden|Angaben ändern|Nachweis festhalten|Audit planen|Durchgeführt melden|Hinweis festhalten|Audit abschließen|Audit absagen|Feststellung erfassen|Eintrag festhalten|Wirksamkeit prüfen|Ohne Maßnahme abschließen|Zurücknehmen)$/;
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

const blatt = (page: Page) => page.locator('.vp-bs-wrap, .vp-modal').last();
async function blattZu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('.vp-bs-wrap, .vp-modal')).toHaveCount(0);
}
async function menue(page: Page, eintrag: string) {
  await page.getByTestId('aufgaben-kopf').getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: eintrag }).click();
}

for (const breite of [375, 1440]) {
  test.describe(`Energiemanagement › Aufgaben bei ${breite} px`, () => {
    test('R5/R11: Aufgabe zuordnen mit „entschieden von“ — Bezugsbasen ab 01.03.2029, Vertretung, Beschluss B4', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&seite=aufgaben', breite);
      await expect(page.getByTestId('energiemanagement-reiter-aufgaben')).toHaveAttribute('aria-selected', 'true');
      const kopf = page.getByTestId('aufgaben-kopf');
      await expect(kopf.getByRole('heading', { level: 1 })).toHaveText('Aufgaben');
      await expect(kopf.locator('.vp-nw-kurz')).toHaveText('Wer macht was · Stand 12.02.2029');
      // R5: am 12.02.2029 hat „Bezugsbasen“ keine Person - die Status-Zeile zählt sie, ohne Warnton (keine Frist).
      await expect(page.getByTestId('aufgaben-status')).toHaveText('1 Aufgabe ohne Person');
      const liste = page.getByTestId('aufgaben-liste');
      await expect(liste.locator('[data-testid^="aufgabe-"] .vp-nw-zl-titel')).toHaveText(AUFGABEN_KURZ);
      await expect(page.getByTestId('aufgabe-bezugsbasen')).toContainText('keine Person');
      await expect(page.getByTestId('aufgabe-bezugsbasen')).toContainText('Zuordnen');
      await expect(page.getByTestId('aufgabe-unternehmensleitung').getByRole('img', { name: 'Robert Falk' })).toHaveText('RF');
      await expect(page.getByTestId('aufgabe-energieteam').getByRole('img')).toHaveText('IKPHMD');
      if (breite >= 720) {
        // Am Rechner: der Name neben dem Kürzel, „3 Personen“ beim Energieteam, rechts die Personen mit ihrer Zahl.
        await expect(page.getByTestId('aufgabe-unternehmensleitung')).toContainText('Robert Falk');
        await expect(page.getByTestId('aufgabe-energieteam')).toContainText('3 Personen');
        await expect(page.getByTestId('personen-liste').getByTestId('person-zeile-RF')).toContainText('1 Aufgabe');
        await expect(page.getByTestId('aufgaben-zuordnen')).toBeVisible();
      } else {
        await expect(page.getByTestId('aufgabe-unternehmensleitung').locator('.vp-nw-nur-breit')).toBeHidden();
        await page.getByTestId('aufgaben-personen').click();
        await expect(blatt(page).getByTestId('person-zeile-RF')).toContainText('Robert Falk');
        await blattZu(page);
      }
      await grenzHinweisZeigt(page, GRENZE, VERANTWORTUNG);
      await ohneQuerlauf(page, 'Aufgaben 12.02.2029');
      await ablegen(page, `a-aufgaben-${breite}`, true);

      // Name, Vertretung, seit wann, entschieden von und Beleg stehen im Blatt der Aufgabe.
      await page.getByTestId('aufgabe-energiemanagement_leiten').click();
      const leiten = blatt(page).getByTestId('zuordnung-energiemanagement_leiten-IK');
      await expect(leiten).toContainText('Ines Kaltenbach');
      await expect(leiten).toContainText('Jonas Wendlinger');
      await expect(leiten).toContainText('seit 01.10.2026');
      await expect(leiten).toContainText('Robert Falk');
      await expect(leiten).toContainText('Bestellung Energiemanagement vom 28.09.2026, unterschrieben · Personalakte (Personalabteilung)');
      await expect(blatt(page).getByTestId('zuordnung-beenden')).toHaveCount(1);
      await ohneQuerlauf(page, 'Blatt Energiemanagement leiten');
      await blattZu(page);

      // Aus dem Blatt zuordnen: die Aufgabe ist vorbelegt; ohne „entschieden von“ nimmt der Dialog nicht an (PA2).
      await page.getByTestId('aufgabe-bezugsbasen').click();
      await expect(blatt(page).getByTestId('aufgabe-ohne-person')).toHaveText(OHNE_PERSON);
      await blatt(page).getByTestId('aufgabe-zeile-zuordnen').click();
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

      // Am 12.02.2029 bleibt „keine Person“ - im Blatt darunter die künftige Zuordnung mit „ab“.
      await expect(page.getByTestId('aufgaben-status')).toHaveText('1 Aufgabe ohne Person');
      await page.getByTestId('aufgabe-bezugsbasen').click();
      await expect(blatt(page).getByTestId('aufgabe-ohne-person')).toHaveText(OHNE_PERSON);
      const kuenftig = blatt(page).getByTestId('zuordnung-bezugsbasen-IK');
      await expect(kuenftig).toContainText('ab 01.03.2029');
      await expect(kuenftig).toContainText('Jonas Wendlinger');
      await expect(kuenftig).toContainText('BR-2029-0001/B4');
      await blattZu(page);
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

      // Stand am 01.03.2029 (Menü „…“): die Zuordnung läuft, jede Aufgabe hat eine Person (R11).
      await menue(page, 'Stand an einem anderen Tag');
      await blatt(page).getByRole('combobox', { name: 'Tag', exact: true }).click();
      await page.getByRole('button', { name: 'Nächster Monat' }).click();
      await page.getByRole('gridcell', { name: '1', exact: true }).first().click();
      await expect(kopf.locator('.vp-nw-kurz')).toHaveText('Wer macht was · Stand 01.03.2029');
      await expect(page.getByTestId('aufgaben-status')).toHaveText('jede Aufgabe hat eine Person');
      await expect(page.getByTestId('aufgabe-bezugsbasen').getByRole('img', { name: 'Ines Kaltenbach' })).toHaveText('IK');
      await page.getByTestId('aufgabe-bezugsbasen').click();
      await expect(blatt(page).getByTestId('aufgabe-ohne-person')).toHaveCount(0);
      await expect(blatt(page).getByTestId('zuordnung-bezugsbasen-IK')).toContainText('seit 01.03.2029');
      await ohneQuerlauf(page, 'Aufgaben 01.03.2029');
      await ablegen(page, `c-aufgaben-0103-${breite}`);
    });

    test('R5: Wer ist wofür verantwortlich — gelesen, ohne Urteil — und die Personen-Seite der Leitung ohne Konto', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&seite=aufgaben', breite);
      await menue(page, 'Wer ist wofür verantwortlich');
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
      await grenzHinweisZeigt(page, GRENZE);
      await ohneQuerlauf(page, 'Wer ist wofür verantwortlich');
      await ablegen(page, `d-verantwortung-${breite}`, true);

      await page.getByTestId('verantwortung-aufgabe-unternehmensleitung').getByRole('button', { name: 'Robert Falk' }).click();
      expect(await page.evaluate(() => location.hash)).toBe(`#/portfolio/energiemanagement/personen/${IDS.RF}`);
      const seite = page.getByTestId('person-seite');
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('Robert Falk');
      await expect(page.getByTestId('person-ohne-konto')).toHaveText('Robert Falk · Geschäftsführer · ohne Konto — erscheint als ‚entschieden von‘.');
      await expect(page.getByTestId('person-aufgabe-unternehmensleitung')).toContainText('Leitung des Unternehmens seit 01.10.2026.');
      await grenzHinweisZeigt(seite, GRENZE, VERANTWORTUNG);
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
      // Der Überblick verspricht „Einsicht“ kein Festhalten (Konzept Nachweisen n1, §6.13).
      await expect(page.getByTestId('ueberblick-naechstes').getByRole('button')).toHaveCount(0);
      await ohneSchreiben('Einsicht: Überblick');
      await oeffne(page, 'person=RF&lage=ahrenberg&seite=verzeichnis', breite);
      await expect(page.getByTestId('verzeichnis-eintrag').first()).toBeVisible();
      await page.getByTestId('verzeichnis-kopf').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await expect(page.getByRole('menuitem', { name: 'Als CSV abrufen' })).toBeVisible();
      await page.keyboard.press('Escape');
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

      // Aufgaben: lesen ja, kein Schreib-Knopf; im Blatt der Aufgabe steht der Leer-Satz an der Stelle von „Aufgabe zuordnen“.
      await oeffne(page, 'person=RF&lage=ahrenberg&seite=aufgaben', breite);
      await expect(page.getByTestId('aufgaben-status')).toHaveText('1 Aufgabe ohne Person');
      await expect(page.getByTestId('aufgabe-bezugsbasen')).not.toContainText('Zuordnen');
      await ohneSchreiben('Einsicht: Aufgaben');
      await ablegen(page, `g-einsicht-aufgaben-${breite}`, true);
      await page.getByTestId('aufgabe-bezugsbasen').click();
      await expect(blatt(page).getByTestId('aufgabe-ohne-person')).toHaveText(OHNE_PERSON);
      await expect(blatt(page).getByTestId('einsicht-satz')).toHaveText(EINSICHT_LEER);
      await ohneSchreiben('Einsicht: Blatt Bezugsbasen');
      await blattZu(page);

      await menue(page, 'Wer ist wofür verantwortlich');
      await expect(page.getByTestId('verantwortung-freigaben-satz')).toBeVisible();
      await ohneSchreiben('Einsicht: Wer ist wofür verantwortlich');

      await oeffne(page, 'person=RF&lage=ahrenberg&ps=IK', breite);
      await expect(page.getByTestId('person-seite').getByRole('heading', { level: 1 })).toHaveText('Ines Kaltenbach');
      // Zwei Schreib-Stellen, zwei Sätze: „Angaben ändern“ im Kopf und seit IP-15 „Nachweis festhalten“ im Abschnitt „Nachweise“.
      await expect(page.getByTestId('person-seite').getByTestId('einsicht-satz')).toHaveText([EINSICHT_LEER, EINSICHT_LEER]);
      await expect(page.getByTestId('person-nachweise').getByTestId('einsicht-satz')).toHaveText(EINSICHT_LEER);
      await ohneSchreiben('Einsicht: Personen-Seite');
      expect(await gesendet(page)).toEqual([]);
    });
  });
}
