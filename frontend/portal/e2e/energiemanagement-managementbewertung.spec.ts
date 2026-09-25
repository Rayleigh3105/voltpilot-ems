import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * „Energiemanagement › Wiedervorlage“ und „› Managementbewertung“ (UEMS AP-19 IP-24, §5.5, WV1–WV4, MG1–MG7, R12, R13)
 * bei 375 px und 1440 px auf der Bühne von IP-9 `e2e/energiemanagement.html` mit `&mb=…` — die ECHTE Schale, die ECHTEN
 * Reiter, die Berichte-Routen der Vorlage `managementbewertung` und die Wiedervorlage gespielt aus R12/R13, der ECHTE
 * Freigabe-Dialog der Berichte (AP-12).
 *
 * Fälle: Wiedervorlage R12 am 12.02.2029 (acht fällig, am längsten fällig zuerst, eine Vorschau, Kalender-Abzug als
 * Abruf, Sprung auf das Dokument) · Anlegen → Entwurf mit Eingaben → Sitzung → Beschluss → Freigabe → Folge, Stand Nr. 1
 * mit Prüfsumme, PDF und „nächste fällig“ · Leitung ohne Aufgabe am Tag (der Satz der Route) · eine je Jahr
 * (`bericht_gibt_es_schon` öffnet die vorhandene) · „Einsicht“ liest Sitzung, Beschlüsse und Stand, lädt das PDF, ändert nichts.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Schritt. Mit `ENERGIEMANAGEMENT_BILDER=<Ordner>` legt der
 * Lauf je Schritt ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.ENERGIEMANAGEMENT_BILDER;
const AM_12_02_2029_MORGEN = new Date('2029-02-12T08:00:00+01:00');
const AM_12_02_2029_FREIGABE = new Date('2029-02-12T14:10:00+01:00');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const VERANTWORTUNG =
  'Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen. VoltPilot hält fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr Energiemanagement genügt.';
const EINSICHT_LEER = 'Mit ‚Einsicht‘ können Sie hier nichts ändern. Festhalten kann, wer das Energiemanagement bearbeitet.';
const KALENDER = 'Stand vom 12.02.2029 aus VoltPilot; maßgeblich ist die Wiedervorlage im Portal.';

async function oeffne(page: Page, query: string, breite: number, zeit: Date) {
  await page.clock.setFixedTime(zeit);
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
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)] };
  });
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const vp = page.viewportSize()!;
  const hoehe = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.querySelector('.vp-main')?.scrollHeight ?? 0));
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe) });
  await page.screenshot({ path: join(BILDER, `${name}.png`) });
  await page.setViewportSize(vp);
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
const combo = (page: Page, name: string) => modal(page).getByRole('combobox', { name, exact: true });
const B6 = 'Der Anwendungsbereich (D-0002, Fassung 1) bleibt unverändert.';
const B3 = 'Energiepolitik um Einkauf und Planung ergänzen; neue Fassung bis 31.03.2029.';

async function waehle(page: Page, feld: Locator, option: RegExp) {
  await feld.click();
  const id = await feld.getAttribute('id');
  await page.locator(`[id="${id}-liste"]`).getByRole('option', { name: option }).click();
}
const gesendet = (page: Page) => page.evaluate(() => (window as unknown as { __mbGesendet: { route: string; body: unknown }[] }).__mbGesendet);

for (const breite of [375, 1440]) {
  test.describe(`Energiemanagement › Wiedervorlage und Managementbewertung bei ${breite} px`, () => {
    test('R12: Wiedervorlage am 12.02.2029 — acht fällig, am längsten fällig zuerst, eine Vorschau, Kalender-Abzug und Sprung', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&mb=r13', breite, AM_12_02_2029_MORGEN);
      // §6.3: die Wiedervorlage ist der zweite Reiter.
      const reiter = page.getByTestId('energiemanagement-bereich').locator('.vp-bereich-tabs [role="tab"]');
      await expect(reiter).toHaveText(['Verzeichnis', 'Wiedervorlage', 'Dokumente', 'Aufgaben', 'Audits', 'Feststellungen', 'Managementbewertung']);
      await page.getByTestId('energiemanagement-reiter-wiedervorlage').click();
      await expect(page).toHaveURL(/#\/portfolio\/energiemanagement\/wiedervorlage$/);
      const w = page.getByTestId('wiedervorlage');
      await expect(w.getByTestId('wiedervorlage-summe')).toHaveText('Stand 12.02.2029: 8 fällig · 1 in den nächsten 30 Tagen.');
      const faellig = w.getByTestId('wiedervorlage-faellig').locator('li');
      await expect(faellig).toHaveCount(8);
      await expect(faellig.first()).toContainText('BB-0002');
      await expect(faellig.first()).toContainText('seit 457 Tagen fällig');
      await expect(faellig.first()).toContainText('Bezugsbasis');
      await expect(faellig.nth(3)).toContainText('BR-2028-0001');
      await expect(faellig.last()).toContainText('D-0002');
      const vorschau = w.getByTestId('wiedervorlage-vorschau').locator('li');
      await expect(vorschau).toHaveCount(1);
      await expect(vorschau.first()).toContainText('M-2029-0001');
      await expect(vorschau.first()).toContainText('fällig in 16 Tagen');
      await expect(vorschau.first()).toContainText('Verantwortlich Jonas Wendlinger');
      await expect(w.getByTestId('wiedervorlage-vermerk')).toContainText(KALENDER);
      await expect(page.getByTestId('energiemanagement-saetze')).toContainText(VERANTWORTUNG);
      await expect(page.getByTestId('energiemanagement-saetze')).toContainText(GRENZE);
      await ohneQuerlauf(page, 'Wiedervorlage');
      await ablegen(page, `w1-wiedervorlage-${breite}`);

      // WV4/E10: der Kalender-Abzug ist ein Abruf — eine Datei, keine Nachricht.
      const laden = page.waitForEvent('download');
      await w.getByTestId('wiedervorlage-kalender').click();
      expect((await laden).suggestedFilename()).toBe('wiedervorlage-energiemanagement.ics');
      expect((await gesendet(page)).map((g) => g.route)).toEqual(['GET /api/v1/energiemanagement/wiedervorlage?format=ics']);

      // WV3: Sprung nur zu einer Seite, die es gibt — D-0001 öffnet die Seite des Dokuments.
      await w.getByTestId('wiedervorlage-zeile-D-0001').getByRole('button').click();
      await expect(page).toHaveURL(/#\/portfolio\/energiemanagement\/dokumente\//);
      await expect(page.getByText('Energiepolitik D-0001', { exact: false }).first()).toBeVisible();
    });

    test('Anlegen → Sitzung → Beschluss → Freigabe → Folge, mit Entwurf, Stand Nr. 1 und PDF', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&mb=leer&seite=managementbewertung', breite, AM_12_02_2029_FREIGABE);
      const register = page.getByTestId('managementbewertung-register');
      await expect(register.getByTestId('managementbewertung-leer')).toHaveText('Hier ist noch nichts festgehalten.');
      await expect(register.getByTestId('mb-naechste')).toHaveText('Ohne freigegebene Managementbewertung mit Sitzung nennt VoltPilot keine nächste.');
      await ablegen(page, `m1-leer-${breite}`);

      // Anlegen (MG1): der Bericht der Vorlage `managementbewertung` für 2028 am Unternehmen.
      await register.getByTestId('mb-anlegen').click();
      const anlegen = page.getByTestId('mb-anlegen-dialog');
      await expect(combo(page, 'Jahr')).toContainText('2028');
      await expect(anlegen).toContainText(VERANTWORTUNG);
      await expect(anlegen).toContainText(GRENZE);
      await ohneQuerlauf(page, 'Anlegen');
      await dialogBild(page, `m2-anlegen-${breite}`);
      await modal(page).getByTestId('mb-anlegen-senden').click();
      await expect(page).toHaveURL(/#\/portfolio\/energiemanagement\/managementbewertung\/BR-2029-0001$/);

      // Der Entwurf zeigt die Eingaben live (MG2); ohne Sitzung und Beschluss lässt sich nicht freigeben.
      const seite = page.getByTestId('managementbewertung-seite');
      await expect(seite.getByTestId('mb-kopf')).toHaveText('Managementbewertung 2028 · Entwurf.');
      await expect(seite.getByTestId('mb-entwurf')).toContainText('Entwurf — Eingaben am 12.02.2029, 14:10');
      await expect(seite.getByTestId('mb-freigeben')).toBeDisabled();
      await expect(seite.getByTestId('mb-freigabe-voraussetzung')).toHaveText(
        'Freigeben lässt sich, sobald die Sitzung mit der Leitung und mindestens ein Beschluss festgehalten sind.',
      );
      await expect(seite.getByTestId('mb-beschluss-knopf')).toHaveCount(0);
      await expect(seite.getByTestId('mb-vorige-keine')).toHaveText('Keine frühere Managementbewertung festgehalten.');
      await expect(seite.getByTestId('mb-eingabe-EZ-2028-0001')).toContainText('verfehlt · 2,7 % weniger in 11 von 12 Monaten');
      await expect(seite.getByTestId('mb-eingabe-M-2028-0001')).toContainText('Stand Nr. 1 · belegt · 2,4 % weniger');
      await expect(seite.getByTestId('mb-eingabe-M-2028-0002')).toContainText('nicht messbar');
      await expect(seite.getByTestId('mb-eingabe-BR-2028-0001')).toContainText('12,9 % mehr als erwartet · Urteil wie festgehalten: schlechter');
      await expect(seite.getByTestId('mb-abschnitt-abweichungen')).toContainText('keine offene Abweichung');
      await expect(seite.getByTestId('mb-abschnitt-audits_feststellungen')).toContainText('1 offene Feststellung');
      await expect(seite.getByTestId('mb-aufgaben')).toHaveText(
        'Aufgaben im Energiemanagement: 10 laufende Zuordnungen; keine Person festgelegt für Bezugsbasen pflegen und freigeben.',
      );
      await expect(seite.getByTestId('mb-abschnitt-wiedervorlage')).toContainText('Stichtag 12.02.2029: 8 fällig · 1 in den nächsten 30 Tagen');
      await expect(seite).toContainText(VERANTWORTUNG);
      await expect(seite).toContainText(GRENZE);
      await ohneQuerlauf(page, 'Entwurf');
      await ablegen(page, `m3-entwurf-${breite}`);

      // Sitzung (MG4): Tag heute, die Leitung am Tag vorgewählt (Robert Falk, ohne Konto), Teilnehmende, Ort.
      await seite.getByTestId('mb-sitzung-knopf').click();
      await expect(combo(page, 'Leitung')).toContainText('Robert Falk');
      await waehle(page, combo(page, 'Teilnehmende'), /^Ines Kaltenbach/);
      // Die Mehrfach-Auswahl bleibt offen, bis man sie schließt (Escape schließt nur die Liste, nicht den Dialog).
      await page.locator(`[id="${await combo(page, 'Teilnehmende').getAttribute('id')}-liste"]`).press('Escape');
      await expect(page.getByTestId('mb-sitzung-dialog')).toBeVisible();
      await modal(page).getByLabel('Ort (wahlfrei)').fill('Werk Ahrenberg, Besprechungsraum');
      await expect(page.getByTestId('mb-sitzung-dialog')).toContainText(VERANTWORTUNG);
      await ohneQuerlauf(page, 'Sitzung');
      await dialogBild(page, `m4-sitzung-${breite}`);
      await modal(page).getByTestId('mb-sitzung-senden').click();
      await expect(seite.getByTestId('mb-sitzung-satz')).toHaveText(
        'Sitzung am 12.02.2029 · Leitung Robert Falk · Teilnehmende Ines Kaltenbach · Werk Ahrenberg, Besprechungsraum',
      );
      await expect(seite.getByTestId('mb-kopf')).toHaveText('Managementbewertung 2028 · Sitzung am 12.02.2029 · Leitung Robert Falk · Entwurf.');

      // Beschlüsse (MG5): entschieden von der Leitung, eingetragen von der, die festhält; auch „bleibt“ ist ein Beschluss.
      await seite.getByTestId('mb-beschluss-knopf').click();
      await waehle(page, combo(page, 'Art'), /^bleibt, wie es ist/);
      await modal(page).getByLabel('Wortlaut').fill(B6);
      await expect(combo(page, 'Entschieden von')).toContainText('Robert Falk');
      await ohneQuerlauf(page, 'Beschluss');
      await dialogBild(page, `m5-beschluss-${breite}`);
      await modal(page).getByTestId('mb-beschluss-senden').click();
      await expect(seite.getByTestId('mb-beschluss-1')).toContainText(`Beschluss 1 — entschieden von Robert Falk, eingetragen von Ines Kaltenbach: ${B6}`);
      await seite.getByTestId('mb-beschluss-knopf').click();
      await waehle(page, combo(page, 'Art'), /^Dokument$/);
      await modal(page).getByLabel('Wortlaut').fill(B3);
      await modal(page).getByTestId('mb-beschluss-senden').click();
      await expect(seite.getByTestId('mb-beschluss-2')).toContainText(`Beschluss 2 — entschieden von Robert Falk, eingetragen von Ines Kaltenbach: ${B3}`);
      await expect(seite.getByTestId('mb-freigeben')).toBeEnabled();
      await expect(seite.getByTestId('mb-freigabe-voraussetzung')).toHaveCount(0);
      await ohneQuerlauf(page, 'Beschlüsse');
      await ablegen(page, `m6-beschluesse-${breite}`);

      // Freigabe (MG7) = die Freigabe der Berichte — Stand Nr. 1 mit Abzug und Prüfsumme; danach ändert sich nichts mehr.
      await seite.getByTestId('mb-freigeben').click();
      await expect(modal(page)).toContainText('Berichtsstand freigeben');
      await ohneQuerlauf(page, 'Freigabe');
      await dialogBild(page, `m7-freigabe-${breite}`);
      await modal(page).getByRole('button', { name: /Nr\. 1 freigeben$/ }).click();
      await expect(seite.getByTestId('mb-kopf')).toHaveText(
        'Managementbewertung 2028 · Sitzung am 12.02.2029 · Leitung Robert Falk · Stand Nr. 1 vom 12.02.2029, 14:10, mit Prüfsumme.',
      );
      await expect(seite.getByTestId('mb-stand-1')).toContainText('Stand Nr. 1 · freigegeben am 12.02.2029, 14:10 von Ines Kaltenbach');
      await expect(seite.getByTestId('mb-stand-seines-tages')).toHaveText(
        'Dieser Stand zeigt die Eingaben vom 12.02.2029, 14:10. Was sich danach geändert hat, zeigt die nächste Managementbewertung.',
      );
      await expect(seite.getByTestId('mb-freigeben')).toHaveCount(0);
      await expect(seite.getByTestId('mb-sitzung-knopf')).toHaveCount(0);
      await expect(seite.getByTestId('mb-beschluss-aendern-1')).toHaveCount(0);
      await expect(seite.getByTestId('mb-ohne-folge-1')).toHaveText('Keine Folge in VoltPilot — der Beschluss steht im Stand vom 12.02.2029.');

      // Folge (MG6): Beschluss 1 mit der Fassung, die bleibt — nur anhängen, der Stand bleibt; Beschluss 2 ohne Folge sagt es.
      await seite.getByTestId('mb-folge-knopf-1').click();
      await waehle(page, combo(page, 'Art'), /^Dokument-Fassung/);
      await waehle(page, combo(page, 'Was aus dem Beschluss entstanden ist'), /^D-0002/);
      await expect(page.getByTestId('mb-folge-dialog')).toContainText(VERANTWORTUNG);
      await ohneQuerlauf(page, 'Folge');
      await dialogBild(page, `m8-folge-${breite}`);
      await modal(page).getByTestId('mb-folge-senden').click();
      await expect(seite.getByTestId('mb-folge-1-D-0002/1')).toContainText('Dokument-Fassung D-0002/1');
      await expect(seite.getByTestId('mb-folge-1-D-0002/1')).toContainText('freigegeben · verknüpft am 12.02.2029 von Ines Kaltenbach');
      await expect(seite.getByTestId('mb-ohne-folge-2')).toHaveText('Keine Folge in VoltPilot — der Beschluss steht im Stand vom 12.02.2029.');
      await expect(seite.getByTestId('mb-stand-1')).toBeVisible();
      await expect(seite.getByTestId('mb-stand-2')).toHaveCount(0);
      expect((await gesendet(page)).map((g) => [g.route, g.body])).toEqual([
        ['POST /api/v1/berichte', { vorlage: 'managementbewertung', geltung_id: 'u0190000-0000-4000-8000-000000000001', zeitraum: '2028' }],
        ['PUT /api/v1/energiemanagement/managementbewertungen/BR-2029-0001/sitzung', {
          tag: '2029-02-12', leitung: 'a1900000-0000-4000-8000-0000000000f1', teilnehmende: ['a1900000-0000-4000-8000-0000000000a1'], ort: 'Werk Ahrenberg, Besprechungsraum',
        }],
        ['POST /api/v1/energiemanagement/managementbewertungen/BR-2029-0001/beschluesse', { art: 'keine_aenderung', wortlaut: B6, entschieden_von: 'a1900000-0000-4000-8000-0000000000f1' }],
        ['POST /api/v1/energiemanagement/managementbewertungen/BR-2029-0001/beschluesse', { art: 'dokument', wortlaut: B3, entschieden_von: 'a1900000-0000-4000-8000-0000000000f1' }],
        ['POST /api/v1/berichte/BR-2029-0001/freigeben', { entwurf_datenstand: '2029-02-12T13:10:00.000Z' }],
        ['POST /api/v1/energiemanagement/managementbewertungen/BR-2029-0001/beschluesse/1/folgen', { art: 'dokument', objekt: 'D-0002/1' }],
      ]);
      await ohneQuerlauf(page, 'Stand mit Folge');
      await ablegen(page, `m9-stand-folge-${breite}`);

      // PDF auf Abruf — jeder Abruf protokolliert.
      const laden = page.waitForEvent('download');
      await seite.getByTestId('mb-pdf-1').click();
      expect((await laden).suggestedFilename()).toBe('BR-2029-0001-stand-1.pdf');
      await expect(seite.getByTestId('mb-abruf')).toHaveText('PDF von Stand Nr. 1 abgerufen — der Abruf ist protokolliert.');

      // Zurück zur Liste: 2028 mit Stand Nr. 1, „nächste fällig“ aus der Wiedervorlage (MG7, 12 Monate nach der Sitzung).
      await seite.getByTestId('mb-zur-liste').click();
      await expect(page.getByTestId('mb-zeile-BR-2029-0001')).toContainText('Managementbewertung 2028');
      await expect(page.getByTestId('mb-zeile-BR-2029-0001')).toContainText('Stand Nr. 1');
      await expect(page.getByTestId('mb-naechste')).toHaveText('Nächste Managementbewertung: nicht in den nächsten 30 Tagen fällig (aus der Sitzung von BR-2029-0001).');
      await ablegen(page, `m10-liste-${breite}`);
    });

    test('MG4/MG5: die Leitung muss am Tag die Aufgabe haben — die Route sagt es, der Dialog zeigt ihren Satz', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&mb=r13&br=1', breite, AM_12_02_2029_FREIGABE);
      const seite = page.getByTestId('managementbewertung-seite');
      await seite.getByTestId('mb-sitzung-knopf').click();
      await waehle(page, combo(page, 'Leitung'), /^Ines Kaltenbach/);
      await modal(page).getByTestId('mb-sitzung-senden').click();
      await expect(modal(page).getByTestId('energiemanagement-ablehnung')).toHaveText(
        'Diese Person hat am 12.02.2029 nicht die Aufgabe ‚Leitung des Unternehmens‘. Ordnen Sie die Leitung unter „Aufgaben“ zu.',
      );
      await ohneQuerlauf(page, 'Leitung fehlt');
    });

    test('MG1: eine je Jahr — die zweite für 2028 spricht den Satz der Route und öffnet die vorhandene', async ({ page }) => {
      await oeffne(page, 'mb=r13&seite=managementbewertung', breite, AM_12_02_2029_FREIGABE);
      await page.getByTestId('mb-anlegen').click();
      await modal(page).getByTestId('mb-anlegen-senden').click();
      await expect(modal(page).getByTestId('energiemanagement-ablehnung')).toContainText('Diesen Bericht gibt es schon: BR-2029-0001');
      await modal(page).getByTestId('mb-vorhandene-oeffnen').click();
      await expect(page).toHaveURL(/#\/portfolio\/energiemanagement\/managementbewertung\/BR-2029-0001$/);
    });

    test('„Einsicht“ (Robert Falk): liest Sitzung, sechs Beschlüsse und Stand, lädt das PDF, ändert nichts', async ({ page }) => {
      await oeffne(page, 'person=RF&lage=ahrenberg&mb=r13f&seite=managementbewertung', breite, AM_12_02_2029_FREIGABE);
      await expect(page.getByTestId('mb-anlegen')).toHaveCount(0);
      await expect(page.getByTestId('managementbewertung-register')).toContainText(EINSICHT_LEER);
      await page.getByTestId('mb-zeile-BR-2029-0001').getByRole('button').click();
      const seite = page.getByTestId('managementbewertung-seite');
      await expect(seite.getByTestId('mb-stand-seines-tages')).toContainText('Dieser Stand zeigt die Eingaben vom 12.02.2029, 14:00.');
      await expect(seite.getByTestId('mb-pdf-1')).toBeVisible();
      await expect(seite.getByTestId('mb-freigeben')).toHaveCount(0);
      await expect(seite.getByTestId('mb-kopf')).toHaveText(
        'Managementbewertung 2028 · Sitzung am 12.02.2029 · Leitung Robert Falk · Stand Nr. 1 vom 12.02.2029, 14:10, mit Prüfsumme.',
      );
      await expect(seite.getByTestId('mb-beschluesse').locator('[data-testid^="mb-beschluss-"]')).toHaveCount(6);
      await expect(seite.getByTestId('mb-beschluss-3')).toContainText(
        'Beschluss 3 — entschieden von Robert Falk, eingetragen von Ines Kaltenbach: Energiepolitik um Einkauf und Planung ergänzen; neue Fassung bis 31.03.2029.',
      );
      await expect(seite.getByTestId('mb-folge-knopf-1')).toHaveCount(0);
      await expect(seite).toContainText(EINSICHT_LEER);
      await ohneQuerlauf(page, 'Einsicht');
      await ablegen(page, `m11-einsicht-${breite}`);
    });
  });
}
