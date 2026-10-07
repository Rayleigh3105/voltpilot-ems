import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { grenzHinweisZeigt } from './grenzHinweis';

/**
 * „Energiemanagement › Wiedervorlage“ und „› Managementbewertung“ (UEMS AP-19 IP-24, §5.5, WV1–WV4, MG1–MG7, R12, R13)
 * bei 375 px und 1440 px auf der Bühne von IP-9 `e2e/energiemanagement.html` mit `&mb=…` — die ECHTE Schale, die ECHTEN
 * Reiter, die Berichte-Routen der Vorlage `managementbewertung` und die Wiedervorlage gespielt aus R12/R13, der ECHTE
 * Freigabe-Dialog der Berichte (AP-12).
 *
 * Seit Konzept Nachweisen n1 Runde 2 (§6.7, PR 5): der Reiter mit „Kann noch nicht beginnen“ und den freigegebenen als
 * Karte mit Folgen-Balken; die Seite eines Jahres mit Status-Zeile, Folgen-Balken, PDF oben, den Beschlüssen als Zeilen
 * mit ihrer Folge und dem Wortlaut im Blatt; im Entwurf die Stufen und das geführte Blatt „Vorbereiten“ in fünf Schritten.
 *
 * Fälle: Wiedervorlage R12 am 12.02.2029 (acht fällig, am längsten fällig zuerst, eine Vorschau, Kalender-Abzug als
 * Abruf, Sprung auf das Dokument) · Anlegen → Eingaben → Sitzung → Beschlüsse → Prüfen → Freigeben → Folge, Stand 1, PDF
 * und „Kann noch nicht beginnen“ · Leitung ohne Aufgabe am Tag (der Satz der Route) · eine je Jahr
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
const KALENDER_HINWEIS =
  'Kalender-Abzug (.ics): Die Termine veralten in Ihrem Kalender, wenn sich eine Frist ändert; maßgeblich ist die Wiedervorlage im Portal.';

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
/** Das Blatt von Nachweisen: am Telefon `BottomSheet`, am Rechner `Modal`. */
const blatt = (page: Page) => page.locator('.vp-bs-wrap, .vp-modal').last();
async function blattZu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('.vp-bs-wrap, .vp-modal')).toHaveCount(0);
}
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
    test('R12: Wiedervorlage am 12.02.2029 als Arbeitsliste, Kalender-Abzug und Schritt bis „Geprüft, bleibt“', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&mb=r13', breite, AM_12_02_2029_MORGEN);
      // K1/D2: die Reiter des Energiemanagements stehen in der Gruppe „Nachweisen“, neben den Berichten — ohne zweite
      // Reihe im Bereich. Die Wiedervorlage beantwortet „Was steht an?“ und steht in der Übersicht; ihre Adresse bleibt.
      // N1: die Gruppen stehen am Rechner in der Seitenleiste, am Telefon in der Leiste.
      await expect(page.getByTestId('energiemanagement-bereich').locator('.vp-bereich-tabs')).toHaveCount(0);
      const reiter = page.getByRole('tablist', { name: 'Reiter der Gruppe Nachweisen' }).getByRole('tab');
      await expect(reiter).toHaveText(['Überblick', 'Berichte', 'Dokumente', 'Audits', 'Managementbewertung', 'Aufgaben']);
      if (breite < 720) await page.locator('.vp-bottombar').getByRole('button', { name: 'Übersicht', exact: true }).click();
      else await page.getByTestId('seitenleiste-uebersicht').click();
      await page.getByTestId('energiemanagement-reiter-wiedervorlage').click();
      await expect(page).toHaveURL(/#\/portfolio\/energiemanagement\/wiedervorlage$/);
      await expect(page.getByTestId('energiemanagement-reiter-wiedervorlage')).toHaveAttribute('aria-selected', 'true');
      if (breite >= 720) await expect(page.getByTestId('seitenleiste-uebersicht')).toHaveAttribute('aria-current', 'page');

      // Konzept Wiedervorlage w1: Seitentitel wie der Reiter, ein Satz sagt, was das ist; Marken zählen Einträge.
      const w = page.getByTestId('wiedervorlage');
      await expect(w.getByRole('heading', { level: 1 })).toHaveText('Wiedervorlage');
      await expect(w.getByTestId('wiedervorlage-kopf')).toHaveText('Alle Fristen Ihres Energiemanagements, das am längsten Überfällige zuerst. Stand 12.02.2029.');
      await expect(w.getByTestId('wiedervorlage-marken').locator('.vp-k-marke')).toHaveText(['8 überfällig', '1 in den nächsten 30 Tagen']);
      const ueber = w.getByTestId('wiedervorlage-ueberfaellig').locator(':scope > li');
      await expect(ueber).toHaveCount(8);
      await expect(ueber.first()).toContainText('Bezugsbasis BB-0002 überprüfen');
      await expect(ueber.first().getByRole('img', { name: 'fällig seit 13.11.2027' })).toBeVisible();
      await expect(ueber.nth(3)).toContainText('Leistungsvergleich');
      await expect(ueber.nth(3)).toContainText('neu freigeben');
      await expect(ueber.last()).toContainText('Anwendungsbereich überprüfen');
      const bald = w.getByTestId('wiedervorlage-bald').locator(':scope > li');
      await expect(bald).toHaveCount(1);
      await expect(bald.first()).toContainText('M-2029-0001 · in 16 Tagen');
      await expect(bald.first()).toContainText('Jonas Wendlinger');
      await expect(w).not.toContainText(/seit \d+ Tagen/);
      // Grenz- und Verantwortungs-Satz stehen einmal am Fuß, mit „Woher kommen diese Fristen?“.
      const fuss = w.getByTestId('wiedervorlage-fuss');
      await expect(fuss).toContainText('Woher kommen diese Fristen?');
      await expect(fuss).toContainText(VERANTWORTUNG);
      await expect(fuss).toContainText(GRENZE);
      await expect(fuss).toContainText(KALENDER_HINWEIS);
      await ohneQuerlauf(page, 'Wiedervorlage');
      await ablegen(page, `w1-wiedervorlage-${breite}`);

      // WV4/E10: der Kalender-Abzug ist ein Abruf, eine Datei und keine Nachricht; am Telefon im Menü.
      const laden = page.waitForEvent('download');
      if (breite < 720) {
        await w.getByRole('button', { name: 'Weitere Aktionen' }).click();
        await page.getByRole('menu').getByRole('menuitem', { name: 'Kalender-Abzug (.ics)' }).click();
      } else {
        await w.getByTestId('wiedervorlage-kalender').click();
      }
      expect((await laden).suggestedFilename()).toBe('wiedervorlage-energiemanagement.ics');
      expect((await gesendet(page)).map((g) => g.route)).toEqual(['GET /api/v1/energiemanagement/wiedervorlage?format=ics']);

      // Entscheid 8: der Schritt öffnet das Objekt mit offenem Entscheid. D-0001 „Bestätigen oder neu fassen“ landet beim
      // Knopf „Prüfen“ (Konzept Nachweisen n1, §6.10: Überprüfung festhalten); danach steht die Adresse ohne Parameter.
      await w.getByTestId('wiedervorlage-eintrag-D-0001').click();
      await expect(page).toHaveURL(/#\/portfolio\/energiemanagement\/dokumente\/[^?]+$/);
      const pruefen = page.getByTestId('dokument-pruefen');
      await expect(pruefen).toBeFocused();
      await pruefen.click();
      const blatt = page.getByTestId('ueberpruefung-blatt');
      await expect(blatt.getByRole('group', { name: 'Gilt Fassung 1 noch?' })).toBeVisible();
      await waehle(page, blatt.getByRole('combobox', { name: 'Wer hat entschieden?' }), /^Robert Falk/);
      await page.getByTestId('ueberpruefung-begruendung').fill('Mit der Jahresplanung 2029 durchgesehen; die Politik gilt unverändert.');
      await page.getByTestId('ueberpruefung-senden').click();
      await expect(blatt).toBeHidden();
      await expect(page.getByTestId('dokument-status')).toHaveText('gilt· Robert Falk');
      await expect(page.getByTestId('dokument-stufen')).toContainText('bis 12.02.2030');
      const em = await page.evaluate(() => (window as unknown as { __emGesendet: { route: string; koerper: Record<string, unknown> }[] }).__emGesendet);
      expect(em.filter((g) => g.route.endsWith('/geprueft')).map((g) => g.koerper)).toEqual([
        { entschieden_von: expect.any(String), am: null, begruendung: 'Mit der Jahresplanung 2029 durchgesehen; die Politik gilt unverändert.' },
      ]);
      await ohneQuerlauf(page, 'Dokument nach „Geprüft, bleibt“');
      await ablegen(page, `w1-dokument-geprueft-${breite}`);
    });

    test('Anlegen → Eingaben → Sitzung → Beschlüsse → Prüfen → Freigeben → Folge, mit Stand 1 und PDF', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&mb=leer&seite=managementbewertung', breite, AM_12_02_2029_FREIGABE);
      const register = page.getByTestId('managementbewertung-register');
      await expect(register.getByRole('heading', { level: 1 })).toHaveText('Managementbewertung');
      await expect(register.locator('.vp-nw-kurz')).toHaveText('Jahresrückblick der Leitung');
      // Ohne eine des Vorjahrs: genau ein nächster Schritt - die Managementbewertung 2028 anlegen.
      const naechstes = register.getByTestId('mb-naechstes');
      await expect(naechstes).toContainText('Als Nächstes');
      await expect(naechstes).toContainText('Managementbewertung 2028');
      await ohneQuerlauf(page, 'Reiter ohne Managementbewertung');
      await ablegen(page, `m1-leer-${breite}`);

      // Anlegen (MG1): der Bericht der Vorlage `managementbewertung` für 2028 am Unternehmen.
      // Ein Blatt mit einer Frage; das laufende Jahr kann noch nicht beginnen und steht nicht zur Wahl.
      await naechstes.getByRole('button', { name: 'Managementbewertung anlegen' }).click();
      const anlegen = page.getByTestId('mb-anlegen-dialog');
      await expect(anlegen.getByTestId('mb-anlegen-jahr-2028').getByRole('radio')).toBeChecked();
      await expect(anlegen.getByTestId('mb-anlegen-jahr-2029')).toHaveCount(0);
      await ohneQuerlauf(page, 'Anlegen');
      await ablegen(page, `m2-anlegen-${breite}`);
      await anlegen.getByTestId('mb-anlegen-senden').click();
      await expect(page).toHaveURL(/#\/portfolio\/energiemanagement\/managementbewertung\/BR-2029-0001$/);

      // Der Entwurf: Stufen, „Vorbereiten“, noch kein Beschluss, keine Sitzung; die Eingaben von heute im Blatt (MG2).
      const seite = page.getByTestId('managementbewertung-seite');
      const kopf = seite.getByTestId('mb-kopf');
      await expect(kopf.getByRole('heading', { level: 1 })).toContainText('Managementbewertung 2028');
      await expect(kopf.locator('.vp-nw-kurz')).toHaveText('Entwurf');
      await expect(seite.getByTestId('mb-stufen')).toContainText('Sitzung');
      await expect(seite.getByTestId('mb-beschluesse')).toContainText('Noch kein Beschluss festgehalten.');
      await expect(seite.getByTestId('mb-sitzung-zeile')).toContainText('fehlt');
      await expect(seite.getByTestId('mb-pdf-1')).toHaveCount(0);
      await grenzHinweisZeigt(seite, VERANTWORTUNG, GRENZE);
      await ohneQuerlauf(page, 'Entwurf');
      await ablegen(page, `m3-entwurf-${breite}`);

      await seite.getByTestId('mb-eingaben-zeile').click();
      await expect(blatt(page).getByTestId('mb-eingaben-stand')).toHaveText('Eingaben vom 12.02.2029, 14:10');
      await expect(blatt(page).getByTestId('mb-eingaben').locator('[data-testid^="mb-eingabe-zeile-"]')).toHaveCount(10);
      const teil = async (key: string, pruefe: () => Promise<void>) => {
        await blatt(page).getByTestId(`mb-eingabe-zeile-${key}`).click();
        await pruefe();
        await blatt(page).getByTestId('mb-eingaben-zurueck').click();
      };
      await teil('vorige_beschluesse', () => expect(blatt(page).getByTestId('mb-vorige-keine')).toHaveText('Keine frühere Managementbewertung festgehalten.'));
      await teil('energieziele', () => expect(blatt(page).getByTestId('mb-eingabe-EZ-2028-0001')).toContainText('verfehlt · 2,7 % weniger in 11 von 12 Monaten'));
      await teil('massnahmen', async () => {
        await expect(blatt(page).getByTestId('mb-eingabe-M-2028-0001')).toContainText('belegt · 2,4 % weniger');
        await expect(blatt(page).getByTestId('mb-eingabe-M-2028-0002')).toContainText('nicht messbar');
      });
      await teil('energieleistung', () => expect(blatt(page).getByTestId('mb-eingabe-BR-2028-0001')).toContainText('12,9 % mehr als erwartet · Urteil wie festgehalten: schlechter'));
      await teil('abweichungen', () => expect(blatt(page).getByTestId('mb-abschnitt-abweichungen')).toContainText('keine offene Abweichung'));
      await teil('audits_feststellungen', () => expect(blatt(page).getByTestId('mb-abschnitt-audits_feststellungen')).toContainText('1 offene Feststellung'));
      await teil('grundlagen', () =>
        expect(blatt(page).getByTestId('mb-aufgaben')).toHaveText(
          'Aufgaben im Energiemanagement: 10 laufende Zuordnungen; keine Person festgelegt für Bezugsbasen pflegen und freigeben.',
        ),
      );
      await teil('wiedervorlage', () => expect(blatt(page).getByTestId('mb-abschnitt-wiedervorlage')).toContainText('Stichtag 12.02.2029: 8 fällig · 1 in den nächsten 30 Tagen'));
      await ohneQuerlauf(page, 'Was die Leitung sah');
      await blattZu(page);

      // Vorbereiten, Schritt 1: was die Leitung sieht; Schritt 2: Sitzung - Tag heute, die Leitung am Tag vorgewählt (MG4).
      await seite.getByTestId('mb-vorbereiten-knopf').click();
      const vb = page.getByTestId('mb-vorbereiten');
      await expect(vb.getByTestId('nw-schritt')).toContainText('Schritt 1 von 5');
      await expect(vb.getByTestId('mb-vb-eingaben').locator('.vp-nw-zl')).toHaveCount(10);
      await ohneQuerlauf(page, 'Vorbereiten: Eingaben');
      await vb.getByTestId('mb-vb-weiter').click();
      await expect(vb.getByTestId('nw-schritt')).toContainText('Schritt 2 von 5');
      await expect(vb.getByTestId('mb-vb-leitung')).toContainText('Robert Falk');
      const dabei = vb.getByRole('combobox', { name: 'Wer war dabei?', exact: true });
      await waehle(page, dabei, /^Ines Kaltenbach/);
      // Die Mehrfach-Auswahl bleibt offen, bis man sie schließt (Escape schließt nur die Liste, nicht das Blatt).
      await page.locator(`[id="${await dabei.getAttribute('id')}-liste"]`).press('Escape');
      await expect(vb).toBeVisible();
      await vb.getByLabel('Wo? (wahlfrei)').fill('Werk Ahrenberg, Besprechungsraum');
      await ohneQuerlauf(page, 'Vorbereiten: Sitzung');
      await ablegen(page, `m4-sitzung-${breite}`);
      await vb.getByTestId('mb-vb-sitzung-festhalten').click();

      // Schritt 3: Beschluss 1 - Art wählen statt tippen (MBV), entschieden von der Leitung der Sitzung (MG5).
      await expect(blatt(page).getByRole('heading', { name: 'Beschluss 1' })).toBeVisible();
      await expect(vb.getByTestId('nw-schritt')).toContainText('Schritt 3 von 5');
      await vb.getByTestId('mb-vb-beschluss-festhalten').click();
      await expect(vb.getByTestId('mb-vb-art')).toContainText('Bitte wählen.');
      await vb.getByTestId('mb-vb-art-keine_aenderung').click();
      await vb.getByLabel('Beschluss').fill(B6);
      await ohneQuerlauf(page, 'Vorbereiten: Beschluss');
      await ablegen(page, `m5-beschluss-${breite}`);
      await vb.getByTestId('mb-vb-beschluss-festhalten').click();

      // Schritt 4: Prüfen - Sitzung und Beschlüsse mit „Ändern“; ein weiterer Beschluss.
      await expect(vb.getByTestId('nw-schritt')).toContainText('Schritt 4 von 5');
      await expect(vb.getByTestId('mb-vb-pruefen')).toContainText('12.02.2029 · Robert Falk');
      await expect(vb.getByTestId('mb-vb-pruefen')).toContainText('Der Anwendungsbereich (D-0002, Fassung 1) bleibt unverändert');
      await vb.getByTestId('mb-vb-weiterer').click();
      await expect(blatt(page).getByRole('heading', { name: 'Beschluss 2' })).toBeVisible();
      await vb.getByTestId('mb-vb-art-dokument').click();
      await vb.getByLabel('Beschluss').fill(B3);
      await vb.getByTestId('mb-vb-beschluss-festhalten').click();
      await expect(vb.getByTestId('mb-vb-pruefen')).toContainText('Energiepolitik um Einkauf und Planung ergänzen');
      await ohneQuerlauf(page, 'Vorbereiten: Prüfen');
      await ablegen(page, `m6-pruefen-${breite}`);

      // Schritt 5: Freigeben = die Freigabe der Berichte - Stand 1 mit Abzug und Prüfsumme; danach ändert sich nichts mehr.
      await vb.getByTestId('mb-vb-weiter').click();
      await expect(vb.getByTestId('nw-schritt')).toContainText('Schritt 5 von 5');
      await expect(vb.getByTestId('mb-vb-freigeben-zeilen')).toContainText('12.02.2029, 14:10');
      await ohneQuerlauf(page, 'Vorbereiten: Freigeben');
      await ablegen(page, `m7-freigeben-${breite}`);
      await vb.getByTestId('mb-vb-freigeben').click();
      await expect(page.locator('.vp-bs-wrap, .vp-modal')).toHaveCount(0);
      await expect(seite.getByTestId('mb-status')).toHaveText('Stand 1 gilt');
      await expect(kopf.locator('.vp-nw-kurz')).toHaveText('Sitzung 12.02.2029 · Robert Falk');
      await expect(seite.getByTestId('mb-vorbereiten-knopf')).toHaveCount(0);
      await expect(seite.getByTestId('mb-beschluss-1')).toContainText('ohne Folge');
      await expect(seite.getByTestId('mb-folgen')).toContainText('2ohne Folge');

      // Folge (MG6): Beschluss 1 mit der Fassung, die bleibt - nur anhängen, der Stand bleibt.
      await seite.getByTestId('mb-beschluss-1').click();
      await expect(blatt(page).getByTestId('mb-beschluss-wortlaut')).toHaveText(B6);
      await expect(blatt(page).getByTestId('mb-ohne-folge-1')).toHaveText('Keine Folge in VoltPilot — der Beschluss steht im Stand vom 12.02.2029.');
      await ohneQuerlauf(page, 'Blatt Beschluss 1');
      await blatt(page).getByTestId('mb-folge-knopf-1').click();
      await waehle(page, combo(page, 'Art'), /^Dokument-Fassung/);
      await waehle(page, combo(page, 'Was aus dem Beschluss entstanden ist'), /^D-0002/);
      await expect(page.getByTestId('mb-folge-dialog')).toContainText(VERANTWORTUNG);
      await ohneQuerlauf(page, 'Folge');
      await dialogBild(page, `m8-folge-${breite}`);
      await modal(page).getByTestId('mb-folge-senden').click();
      await expect(page.locator('.vp-modal')).toHaveCount(0);
      await expect(seite.getByTestId('mb-beschluss-1')).not.toContainText('ohne Folge');
      await expect(seite.getByTestId('mb-folgen')).toContainText('1erledigt');
      await seite.getByTestId('mb-beschluss-1').click();
      await expect(blatt(page).getByTestId('mb-folge-1-D-0002/1')).toContainText('freigegeben');
      await blattZu(page);
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

      // PDF oben - jeder Abruf protokolliert.
      const laden = page.waitForEvent('download');
      await seite.getByTestId('mb-pdf-1').click();
      expect((await laden).suggestedFilename()).toBe('BR-2029-0001-stand-1.pdf');
      await expect(seite.getByTestId('mb-abruf')).toHaveText('PDF abgerufen, der Abruf ist protokolliert.');

      // Zurück zum Reiter: 2028 als Karte mit Folgen-Balken; 2029 kann noch nicht beginnen (Frist aus der Wiedervorlage, MG7).
      await kopf.getByRole('button', { name: 'Alle Managementbewertungen' }).click();
      await expect(page.getByTestId('mb-zeile-BR-2029-0001')).toContainText('Managementbewertung 2028');
      await expect(page.getByTestId('mb-folgen-BR-2029-0001')).toContainText('1erledigt');
      const spaeter = page.getByTestId('mb-naechstes');
      await expect(spaeter).toContainText('Kann noch nicht beginnen');
      await expect(spaeter).toContainText('Managementbewertung 2029');
      await expect(spaeter).toContainText('ab Januar 2030');
      await expect(spaeter.getByRole('img', { name: /12\.02\.2030/ })).toBeVisible();
      await expect(spaeter.getByRole('button')).toHaveCount(0);
      await ohneQuerlauf(page, 'Reiter nach der Freigabe');
      await ablegen(page, `m10-liste-${breite}`);
    });

    test('MG4/MG5: die Leitung muss am Tag die Aufgabe haben — die Route sagt es, das Blatt zeigt ihren Satz', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&mb=r13&br=1', breite, AM_12_02_2029_FREIGABE);
      const seite = page.getByTestId('managementbewertung-seite');
      await seite.getByTestId('mb-vorbereiten-knopf').click();
      const vb = page.getByTestId('mb-vorbereiten');
      await vb.getByTestId('mb-vb-weiter').click();
      await vb.getByTestId('mb-vb-leitung').getByRole('button', { name: 'Leitung ändern' }).click();
      await waehle(page, vb.getByRole('combobox', { name: 'Leitung', exact: true }), /^Ines Kaltenbach/);
      await vb.getByTestId('mb-vb-sitzung-festhalten').click();
      await expect(vb.getByTestId('energiemanagement-ablehnung')).toHaveText(
        'Diese Person hat am 12.02.2029 nicht die Aufgabe ‚Leitung des Unternehmens‘. Ordnen Sie die Leitung unter „Aufgaben“ zu.',
      );
      await ohneQuerlauf(page, 'Leitung fehlt');
    });

    test('MG1: eine je Jahr — 2028 gibt es schon (grau), der Entwurf ist der eine nächste Schritt', async ({ page }) => {
      await oeffne(page, 'mb=r13&seite=managementbewertung', breite, AM_12_02_2029_FREIGABE);
      // Der Entwurf ist der eine nächste Schritt („Öffnen“); anlegen steht im Menü.
      await expect(page.getByTestId('mb-naechstes').getByRole('button', { name: 'Öffnen' })).toBeVisible();
      await page.getByTestId('managementbewertung-kopf').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Managementbewertung anlegen' }).click();
      const anlegen = page.getByTestId('mb-anlegen-dialog');
      await expect(anlegen.getByTestId('mb-anlegen-jahr-2028')).toContainText('gibt es schon');
      await expect(anlegen.getByTestId('mb-anlegen-jahr-2028').getByRole('radio')).toBeDisabled();
      await expect(anlegen.getByTestId('mb-anlegen-jahr-2027').getByRole('radio')).toBeChecked();
      await ohneQuerlauf(page, 'Anlegen mit vorhandener 2028');
      await blattZu(page);
      await page.getByTestId('mb-naechstes').getByRole('button', { name: 'Öffnen' }).click();
      await expect(page).toHaveURL(/#\/portfolio\/energiemanagement\/managementbewertung\/BR-2029-0001$/);
    });

    test('„Einsicht“ (Robert Falk): liest Sitzung, sechs Beschlüsse und Stand, lädt das PDF, ändert nichts', async ({ page }) => {
      await oeffne(page, 'person=RF&lage=ahrenberg&mb=r13f&seite=managementbewertung', breite, AM_12_02_2029_FREIGABE);
      const register = page.getByTestId('managementbewertung-register');
      await expect(register.getByRole('button', { name: 'Weitere Aktionen' })).toHaveCount(0);
      await expect(register.getByTestId('mb-naechstes')).toContainText('Kann noch nicht beginnen');
      await ablegen(page, `m11-einsicht-reiter-${breite}`);
      await page.getByTestId('mb-zeile-BR-2029-0001').click();
      const seite = page.getByTestId('managementbewertung-seite');
      await expect(seite.getByTestId('mb-status')).toHaveText('Stand 1 gilt');
      await expect(seite.getByTestId('mb-pdf-1')).toBeVisible();
      await expect(seite.getByTestId('mb-vorbereiten-knopf')).toHaveCount(0);
      await expect(seite.getByTestId('mb-beschluesse').locator('[data-testid^="mb-beschluss-"]')).toHaveCount(6);
      await ohneQuerlauf(page, 'Einsicht');
      await ablegen(page, `m11-einsicht-${breite}`);
      await seite.getByTestId('mb-beschluss-3').click();
      await expect(blatt(page).getByTestId('mb-beschluss-wortlaut')).toHaveText('Energiepolitik um Einkauf und Planung ergänzen; neue Fassung bis 31.03.2029.');
      await expect(blatt(page).getByTestId('mb-folge-knopf-3')).toHaveCount(0);
      await expect(blatt(page).getByTestId('einsicht-satz')).toHaveText(EINSICHT_LEER);
      await expect(blatt(page).getByRole('button', { name: 'Maßnahme anlegen' })).toHaveCount(0);
      await blattZu(page);
      await seite.getByTestId('mb-eingaben-zeile').click();
      await expect(blatt(page).getByTestId('mb-eingaben-stand')).toHaveText('Eingaben vom 12.02.2029, 14:00');
      await blattZu(page);
      expect(await gesendet(page)).toEqual([]);
    });
  });
}
