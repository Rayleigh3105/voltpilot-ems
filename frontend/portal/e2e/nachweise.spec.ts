import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * „Nachweise“ am Energieeinsatz und an der Person (UEMS AP-19 IP-15, §5.3, R7, R8) bei 375 px und 1440 px.
 *
 * R7 auf der Bühne der Bewertung (`e2e/bewertung.html`, die ECHTE `EnergieeinsatzSeite` mit den Energiemanagement-Routen
 * der Lage `ahrenberg`): Ines Kaltenbach hält am 10.11.2028 am Einsatz EE-1 Spritzguss den Arbeitsplan der Instandhaltung
 * als Verweis fest — „Nachweis festhalten“ (Bezug vorbelegt) → Fassung als Verweis mit der Prüfsumme aus dem Browser →
 * Freigabe → der Abschnitt sagt „Geführt in Ihrem System: …“. Die Datei verlässt den Rechner nicht: ihr Inhalt steht in
 * keiner Anfrage und in keinem Körper, die Prüfsumme ist hier in Node nachgerechnet.
 *
 * R8 auf der Bühne des Energiemanagements (`e2e/energiemanagement.html?ps=MD`): die Unterweisung von Murat Demirci als
 * Kompetenz-Nachweis ohne Überprüfung; Robert Falk mit „Einsicht“ liest ihn, ohne Schreib-Knopf.
 *
 * Mit `NACHWEISE_BILDER=<Ordner>` legt der Lauf je Schritt ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.NACHWEISE_BILDER;
const AM_10_11_2028 = new Date('2028-11-10T09:00:00Z');
const AM_25_01_2028 = new Date('2028-01-25T09:00:00Z');
const AM_12_02_2029 = new Date('2029-02-12T09:00:00Z');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const VERANTWORTUNG =
  'Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen. VoltPilot hält fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr Energiemanagement genügt.';
const LEER = 'Hier ist noch nichts festgehalten.';
const EINSICHT = 'Mit ‚Einsicht‘ können Sie hier nichts ändern. Festhalten kann, wer das Energiemanagement bearbeitet.';
const VERWEIS_FELDER = ['ablage', 'adresse', 'bezeichnung', 'datum', 'fassungsangabe', 'kennung', 'sha256'];
const EE1 = 'ee000000-0000-4000-8000-000000000001';
const MD = 'a1900000-0000-4000-8000-0000000000a4';

async function oeffne(page: Page, pfad: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(pfad);
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
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs') && !(e instanceof HTMLInputElement && e.type === 'file'))
      .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueberstehend)] };
  });
}

function ohneQuerlauf(m: Awaited<ReturnType<typeof messe>>, fall: string) {
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

/** Ein Abschnitt als Bild — das Element selbst, in einem Fenster so hoch wie die Seite (sonst deckt die feste Leiste ihn ab). */
async function abschnittBild(page: Page, ort: Locator, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const vp = page.viewportSize()!;
  const hoehe = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.querySelector('.vp-main')?.scrollHeight ?? 0));
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe + 200) });
  await ort.screenshot({ path: join(BILDER, `${name}.png`), animations: 'disabled' });
  await page.setViewportSize(vp);
}

/** Die ganze Seite in einem hohen Fenster (die feste Leiste bleibt oben). */
async function seitenBild(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const vp = page.viewportSize()!;
  const hoehe = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.querySelector('.vp-main')?.scrollHeight ?? 0));
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, hoehe) });
  await page.screenshot({ path: join(BILDER, `${name}.png`) });
  await page.setViewportSize(vp);
}

/** Ein Dialog als Bild: das Fenster so hoch wie der Dialog. */
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

async function waehle(page: Page, feld: Locator, option: RegExp) {
  await feld.click();
  const id = await feld.getAttribute('id');
  await page.locator(`[id="${id}-liste"]`).getByRole('option', { name: option }).click();
}

const modal = (page: Page) => page.locator('.vp-modal').last();
const gesendet = (page: Page) => page.evaluate(() => (window as unknown as { __emGesendet: { route: string; koerper: unknown }[] }).__emGesendet);
const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

for (const breite of [375, 1440]) {
  test.describe(`Nachweise bei ${breite} px`, () => {
    test('R7: Verweis am Einsatz festhalten — Bezug vorbelegt, Prüfsumme aus dem Browser, „Geführt in Ihrem System“', async ({ page }) => {
      const anfragen: string[] = [];
      page.on('request', (r) => {
        if (r.method() !== 'GET') anfragen.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`);
      });
      await oeffne(page, '/e2e/bewertung.html?person=IK&stand=voll&ee=EE-1', breite, AM_10_11_2028);
      const seite = page.getByTestId('einsatz-seite');
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('Spritzguss');
      const abschnitt = page.getByTestId('einsatz-nachweise');
      await expect(abschnitt.getByRole('heading', { level: 2 })).toHaveText('Nachweise');
      await expect(abschnitt.getByTestId('nachweise-leer')).toHaveText(LEER);
      await expect(abschnitt.getByText(VERANTWORTUNG)).toBeVisible();
      // Den Grenz-Satz trägt die Einsatz-Seite selbst (am Fuß, dazu Einstufung und Messplanung) — der Abschnitt nicht noch einmal.
      await expect(seite.locator('.vp-bw-grenze').last()).toHaveText(GRENZE);
      await expect(abschnitt.getByText(GRENZE)).toHaveCount(0);
      ohneQuerlauf(await messe(page), 'Einsatz leer');
      await abschnittBild(page, abschnitt, `a-einsatz-leer-${breite}`);

      await abschnitt.getByTestId('nachweis-festhalten').click();
      const anlegen = page.getByTestId('nachweis-anlegen-dialog');
      await expect(modal(page).getByRole('heading', { name: 'Nachweis festhalten' })).toBeVisible();
      await expect(anlegen.getByTestId('nachweis-bezug')).toHaveText('Energieeinsatz EE-1 Spritzguss');
      await expect(anlegen.getByRole('radiogroup', { name: 'Bezug' })).toHaveCount(0);
      const art = modal(page).getByRole('combobox', { name: 'Art', exact: true });
      await expect(art).toContainText('Betrieb und Instandhaltung');
      await art.click();
      const optionen = page.locator(`[id="${await art.getAttribute('id')}-liste"]`).getByRole('option');
      await expect(optionen).toHaveCount(3);
      await page.keyboard.press('Escape');
      await expect(anlegen).toBeVisible();
      await anlegen.getByLabel('Titel').fill('Kriterien für Betrieb und Instandhaltung — Spritzguss');
      ohneQuerlauf(await messe(page), 'Nachweis festhalten');
      await dialogBild(page, `b-anlegen-${breite}`);
      await page.getByTestId('dokument-anlegen-senden').click();

      const fassung = page.getByTestId('fassung-dialog');
      await expect(fassung.getByTestId('fassung-form-verweis')).toBeChecked();
      const verweis = fassung.locator('fieldset').filter({ hasText: 'Wo das Original liegt' });
      await verweis.getByLabel('Ablage bei Ihnen').fill('Instandhaltungssystem, Arbeitspläne');
      await verweis.getByLabel('Bezeichnung').fill('Arbeitsplan Spritzgussmaschinen, Rev. 4');
      await verweis.getByLabel('Kennung bei Ihnen').fill('IH-SG-01');
      await verweis.getByLabel('Adresse (wahlfrei)').fill('https://instandhaltung.ahrenberg.example/plan/IH-SG-01');
      await verweis.getByLabel('Ihre Fassungsangabe').fill('Rev. 4 vom 03.11.2028');
      const inhalt = `ARBEITSPLAN-IH-SG-01-REV-4-${breite}-INHALT-BLEIBT-AUF-DEM-GERAET`;
      await verweis.locator('input[type="file"]').setInputFiles({ name: 'IH-SG-01_Rev4.pdf', mimeType: 'application/pdf', buffer: Buffer.from(inhalt) });
      await expect(verweis.getByTestId(/-pruefsumme$/)).toContainText('aus „IH-SG-01_Rev4.pdf“.');
      ohneQuerlauf(await messe(page), 'Verweis');
      await dialogBild(page, `c-verweis-${breite}`);
      await page.getByTestId('fassung-senden').click();

      const freigabe = page.getByTestId('freigabe-dialog');
      await expect(freigabe).toBeVisible();
      await waehle(page, modal(page).getByRole('combobox', { name: 'entschieden von' }), /^Ines Kaltenbach/);
      await freigabe.getByLabel('Begründung').fill('Die Kriterien stehen im Arbeitsplan der Instandhaltung; abgestimmt mit der Instandhaltung.');
      ohneQuerlauf(await messe(page), 'Freigabe');
      await dialogBild(page, `d-freigabe-${breite}`);
      await page.getByTestId('freigabe-senden').click();
      await expect(freigabe).toBeHidden();

      const zeile = abschnitt.getByTestId('nachweis-D-0004');
      await expect(zeile.getByRole('link')).toHaveText('D-0004 Kriterien für Betrieb und Instandhaltung — Spritzguss');
      await expect(zeile.getByRole('link')).toHaveAttribute('href', /#\/portfolio\/energiemanagement\/dokumente\/d1900000-/);
      await expect(zeile.getByTestId('nachweis-ort')).toHaveText(
        'Geführt in Ihrem System: Instandhaltungssystem, Arbeitspläne (IH-SG-01, Rev. 4 vom 03.11.2028).',
      );
      await expect(zeile.getByTestId('nachweis-adresse')).toHaveText('https://instandhaltung.ahrenberg.example/plan/IH-SG-01');
      await expect(zeile.getByTestId('nachweis-pruefsumme')).toHaveText('Prüfsumme der Datei festgehalten am 10.11.2028.');
      await expect(zeile.getByTestId('nachweis-pruefsumme')).toHaveAttribute('title', sha256(inhalt));
      await expect(zeile.getByTestId('nachweis-ueberpruefung')).toHaveText('Überprüfung fällig am 10.11.2029.');
      await expect(abschnitt.getByTestId('nachweise-leer')).toHaveCount(0);
      ohneQuerlauf(await messe(page), 'Einsatz mit Nachweis');
      await abschnittBild(page, abschnitt, `e-einsatz-nachweis-${breite}`);
      await seitenBild(page, `f-einsatz-seite-${breite}`);

      const koerper = await gesendet(page);
      expect(anfragen.filter((a) => a.includes(inhalt))).toEqual([]);
      expect(JSON.stringify(koerper)).not.toContain(inhalt);
      expect(koerper.map((k) => k.route.replace(/d1900000-[0-9a-f-]+/, '{id}'))).toEqual([
        'POST /api/v1/energiemanagement/dokumente',
        'POST /api/v1/energiemanagement/dokumente/{id}/fassungen',
        'POST /api/v1/energiemanagement/dokumente/{id}/fassungen/1/freigeben',
      ]);
      expect(koerper[0].koerper).toEqual({
        art: 'betrieb', titel: 'Kriterien für Betrieb und Instandhaltung — Spritzguss', bezug: { art: 'energieeinsatz', energieeinsatz_id: EE1 },
      });
      const entwurf = koerper[1].koerper as { form: string; verweis: Record<string, unknown>; wortlaut?: unknown };
      expect(entwurf.form).toBe('verweis');
      expect(entwurf.wortlaut).toBeUndefined();
      expect(Object.keys(entwurf.verweis).sort()).toEqual(VERWEIS_FELDER);
      expect(entwurf.verweis).toMatchObject({ ablage: 'Instandhaltungssystem, Arbeitspläne', kennung: 'IH-SG-01', fassungsangabe: 'Rev. 4 vom 03.11.2028', sha256: sha256(inhalt) });
    });

    test('Abbrechen nach dem Anlegen: der Entwurf steht im Abschnitt und führt zur Dokument-Seite', async ({ page }) => {
      await oeffne(page, '/e2e/bewertung.html?person=IK&stand=voll&ee=EE-1', breite, AM_10_11_2028);
      const abschnitt = page.getByTestId('einsatz-nachweise');
      await abschnitt.getByTestId('nachweis-festhalten').click();
      await waehle(page, modal(page).getByRole('combobox', { name: 'Art', exact: true }), /^Auslegung/);
      await expect(page.getByTestId('nachweis-anlegen-dialog').getByLabel('Titel')).toHaveValue('Auslegung (Nachweis)');
      await page.getByTestId('nachweis-anlegen-dialog').getByLabel('Titel').fill('Planung Temperiergeräte Halle 1');
      await page.getByTestId('dokument-anlegen-senden').click();
      await expect(page.getByTestId('fassung-dialog')).toBeVisible();
      await modal(page).getByRole('button', { name: 'Abbrechen' }).click();
      const zeile = abschnitt.getByTestId('nachweis-D-0004');
      await expect(zeile.getByTestId('nachweis-ort')).toHaveText('Entwurf — noch keine Fassung freigegeben.');
      await expect(zeile.getByTestId('nachweis-ueberpruefung')).toHaveText('Ein Nachweis — ohne Überprüfung.');
      ohneQuerlauf(await messe(page), 'Entwurf am Einsatz');
    });

    test('R8: Kompetenz-Nachweis an der Person — ohne Überprüfung; „Einsicht“ liest ihn ohne Schreib-Knopf', async ({ page }) => {
      await oeffne(page, '/e2e/energiemanagement.html?person=IK&lage=ahrenberg&ps=MD', breite, AM_25_01_2028);
      const seite = page.getByTestId('person-seite');
      await expect(seite.getByRole('heading', { level: 1 })).toHaveText('Murat Demirci');
      const abschnitt = page.getByTestId('person-nachweise');
      await expect(abschnitt.getByTestId('nachweise-leer')).toHaveText(LEER);
      await abschnitt.getByTestId('nachweis-festhalten').click();
      const anlegen = page.getByTestId('nachweis-anlegen-dialog');
      await expect(anlegen.getByTestId('nachweis-bezug')).toHaveText('Person Murat Demirci');
      await expect(modal(page).getByRole('combobox', { name: 'Art', exact: true })).toContainText('Kompetenz (Nachweis)');
      await anlegen.getByLabel('Titel').fill('Unterweisung Zeitschaltung der Werkzeugheizungen');
      ohneQuerlauf(await messe(page), 'Nachweis an der Person');
      await dialogBild(page, `g-person-anlegen-${breite}`);
      await page.getByTestId('dokument-anlegen-senden').click();
      const verweis = page.getByTestId('fassung-dialog').locator('fieldset').filter({ hasText: 'Wo das Original liegt' });
      await verweis.getByLabel('Ablage bei Ihnen').fill('Personalsystem, Unterweisungen');
      await verweis.getByLabel('Bezeichnung').fill('Unterweisungsnachweis UW-2028-014');
      await verweis.getByLabel('Kennung bei Ihnen').fill('UW-2028-014');
      await page.getByTestId('fassung-senden').click();
      await waehle(page, modal(page).getByRole('combobox', { name: 'entschieden von' }), /^Ines Kaltenbach/);
      await page.getByTestId('freigabe-dialog').getByLabel('Begründung').fill('Nachweis zur Maßnahme M-2028-0001: Murat Demirci ist in die Zeitschaltung eingewiesen.');
      await page.getByTestId('freigabe-senden').click();

      const zeile = abschnitt.getByTestId('nachweis-D-0004');
      await expect(zeile.getByRole('link')).toHaveText('D-0004 Unterweisung Zeitschaltung der Werkzeugheizungen');
      await expect(zeile.getByTestId('nachweis-ort')).toHaveText('Geführt in Ihrem System: Personalsystem, Unterweisungen (UW-2028-014).');
      await expect(zeile.getByTestId('nachweis-ueberpruefung')).toHaveText('Ein Nachweis — ohne Überprüfung.');
      await expect(zeile.getByTestId('nachweis-pruefsumme')).toHaveCount(0);
      await expect(seite.getByText(VERANTWORTUNG)).toBeVisible();
      await expect(seite.getByText(GRENZE)).toBeVisible();
      ohneQuerlauf(await messe(page), 'Person mit Nachweis');
      await abschnittBild(page, abschnitt, `h-person-nachweis-${breite}`);
      await seitenBild(page, `i-person-seite-${breite}`);
      const koerper = await gesendet(page);
      expect(koerper[0].koerper).toMatchObject({ art: 'kompetenz', bezug: { art: 'person', person_id: MD } });

      // Robert Falk mit „Einsicht“: derselbe Abschnitt, an der Stelle des Knopfs der Satz (RE3).
      await oeffne(page, '/e2e/energiemanagement.html?person=RF&lage=ahrenberg&ps=MD', breite, AM_12_02_2029);
      const lesend = page.getByTestId('person-nachweise');
      await expect(lesend.getByTestId('nachweise-leer')).toHaveText(LEER);
      await expect(lesend.getByTestId('nachweis-festhalten')).toHaveCount(0);
      await expect(lesend.getByTestId('einsicht-satz')).toHaveText(EINSICHT);
    });
  });
}
