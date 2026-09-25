import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * „Energiemanagement › Audits“ und „› Feststellungen“ (UEMS AP-19 IP-20, §5.4, R9–R11, SP5, W3) bei 375 px und 1440 px
 * auf der Bühne von IP-9 `e2e/energiemanagement.html` mit `&al=…` — die ECHTE Schale, die ECHTEN Reiter, die Routen von
 * IP-18/IP-19 gespielt aus dem Referenzunternehmen 1.10, die Maßnahme über die Routen von AP-18 und die ECHTE
 * Maßnahmen-Seite.
 *
 * Fälle: der ganze Weg Audit planen → durchgeführt → Hinweis → Feststellung → Eintrag → „Maßnahme anlegen“ mit
 * vorbelegter Herkunft → Maßnahmen-Seite („Herkunft: Feststellung F-…“ als Sprung) → umgesetzt → Wirksamkeit →
 * abgeschlossen · R10/R11 gelesen (Auditprogramm mit nächstem Audit, Feststellung mit Einträgen, Stand Nr. 1) · Vier-Augen
 * nicht erfüllbar als Satz · „Einsicht“ ohne Schreib-Knopf.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente je Schritt. Mit `ENERGIEMANAGEMENT_BILDER=<Ordner>` legt der
 * Lauf je Schritt ein Bild ab — die Ansicht. Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.ENERGIEMANAGEMENT_BILDER;
const AM_22_01_2029 = new Date('2029-01-22T16:00:00+01:00');
const AM_15_04_2029 = new Date('2029-04-15T10:00:00+02:00');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const VERANTWORTUNG =
  'Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen. VoltPilot hält fest, wer was wann entschieden hat, und beurteilt nicht, ob Ihr Energiemanagement genügt.';
const EINSICHT_LEER = 'Mit ‚Einsicht‘ können Sie hier nichts ändern. Festhalten kann, wer das Energiemanagement bearbeitet.';
const NOCH_NICHT = 'Die Wirksamkeit lässt sich prüfen, sobald jede Maßnahme umgesetzt, bewertet oder verworfen ist.';
const SCHREIBEN =
  /^(Audit planen|Durchgeführt melden|Hinweis festhalten|Audit abschließen|Audit absagen|Feststellung erfassen|Eintrag festhalten|Wirksamkeit prüfen|Ohne Maßnahme abschließen|Zurücknehmen)$/;
const HINWEIS = 'Die Energiepolitik wurde im Dezember 2026 bekannt gemacht; wer seitdem eingestellt wurde, lernt sie in der Einarbeitung nicht kennen.';
const WORTLAUT = 'Wer die Bezugsbasen pflegt und freigibt und wer vertritt, ist nicht festgelegt.';

async function oeffne(page: Page, query: string, breite: number, zeit = AM_22_01_2029) {
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
      .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs') && !(e instanceof HTMLInputElement && e.type === 'file'))
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
  // Ein hohes Fenster statt `fullPage` — sonst stünde die feste Leiste mitten im Bild (AP-18 IP-13).
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
const gesendet = (page: Page) => page.evaluate(() => (window as unknown as { __afGesendet: { route: string; koerper: unknown }[] }).__afGesendet);

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
  await expect(page.locator('.vp-kal-tag').first()).toBeHidden();
}

for (const breite of [375, 1440]) {
  test.describe(`Energiemanagement › Audits und Feststellungen bei ${breite} px`, () => {
    test('Audit → Feststellung → Maßnahme → Wirksamkeit: der ganze Weg mit vorbelegter Herkunft (R9–R11, SP5)', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&al=leer&seite=audits', breite);
      await expect(page.getByTestId('energiemanagement-reiter-audits')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('audits-leer')).toHaveText('Hier ist noch nichts festgehalten.');
      await expect(page.getByTestId('audit-naechstes')).toHaveText('Noch kein internes Audit durchgeführt — ohne Durchführung nennt VoltPilot keine Frist.');
      await expect(page.getByText(GRENZE)).toBeVisible();
      await expect(page.getByText(VERANTWORTUNG)).toBeVisible();

      // IA1: planen — Auditorin ohne Schreibrecht, Unabhängigkeit als Wortlaut.
      await page.getByTestId('audit-planen').click();
      await modal(page).getByLabel('Titel').fill('Internes Audit 2029: Bezugsbasen, Energieziele, Maßnahmen und Grundlagen');
      await waehleTag(page, combo(page, 'Termin'), '2029-01-22');
      await waehle(page, combo(page, 'Wer prüft'), /^Claudia Berger/);
      // Die Mehrfach-Auswahl bleibt offen, bis man daneben tippt (am Telefon ein Blatt mit Hintergrund).
      const hintergrund = page.locator('.vp-picker-backdrop');
      if (await hintergrund.count()) await hintergrund.click({ position: { x: 8, y: 8 } });
      else await page.keyboard.press('Tab');
      await expect(hintergrund).toHaveCount(0);
      await modal(page).getByLabel('Unabhängigkeit').fill('Claudia Berger (Controlling) gehört nicht zum Energieteam und prüft keine eigene Arbeit.');
      await modal(page).getByLabel('Was geprüft wird').fill('Bezugsbasen BB-0001 bis BB-0005, Energieziel EZ-2028-0001, Aufgaben im Energiemanagement');
      await modal(page).getByLabel('Woran geprüft wird').fill('Energiepolitik D-0001 Fassung 1, Aufgaben im Energiemanagement');
      await waehle(page, combo(page, 'Verantwortlich'), /^Ines Kaltenbach/);
      await ohneQuerlauf(page, 'Dialog Audit planen');
      await dialogBild(page, `a-audit-planen-${breite}`);
      await page.getByTestId('audit-planen-senden').click();
      await expect(page.locator('.vp-modal')).toHaveCount(0);
      await expect(page.getByTestId('audit-kopf')).toHaveText('Internes Audit AU-2029-0001 · geplant am 22.01.2029 · Claudia Berger.');

      // Durchgeführt am 22.01.2029, ein Hinweis mit „festgestellt von“ der Auditorin (IA2, IA5).
      await page.getByTestId('audit-durchgefuehrt').click();
      await page.getByTestId('audit-durchgefuehrt-senden').click();
      await expect(page.getByTestId('audit-kopf')).toHaveText('Internes Audit AU-2029-0001 · durchgeführt am 22.01.2029 von Claudia Berger (Controlling).');
      await page.getByTestId('audit-hinweis').click();
      await expect(combo(page, 'Festgestellt von')).toContainText('Claudia Berger');
      await modal(page).getByLabel('Hinweis im Wortlaut').fill(HINWEIS);
      await page.getByTestId('hinweis-senden').click();
      await expect(page.getByTestId('audit-hinweis-1')).toContainText('Hinweis — festgestellt von Claudia Berger, eingetragen von Ines Kaltenbach am 22.01.2029.');
      await ohneQuerlauf(page, 'Audit durchgeführt');
      await ablegen(page, `b-audit-durchgefuehrt-${breite}`);

      // FS1: die Feststellung aus diesem Audit — Quelle vorbelegt, Frist ohne Angabe 90 Tage.
      await page.getByTestId('audit-feststellung').click();
      await expect(modal(page).getByTestId('feststellung-quelle-vorbelegt')).toHaveText('Quelle: aus dem internen Audit AU-2029-0001');
      await modal(page).getByLabel('Was nicht erfüllt ist').fill(WORTLAUT);
      await modal(page).getByLabel('Wortlaut der Vorgabe').fill('„Wir legen fest, wer im Energiemanagement wofür zuständig ist.“');
      await waehle(page, combo(page, 'Bezug: Aufgabe (wahlfrei)'), /^Bezugsbasen pflegen und freigeben/);
      await waehle(page, combo(page, 'Verantwortlich'), /^Jonas Wendlinger/);
      await ohneQuerlauf(page, 'Dialog Feststellung erfassen');
      await dialogBild(page, `c-feststellung-erfassen-${breite}`);
      await page.getByTestId('feststellung-erfassen-senden').click();
      await expect(page.getByTestId('feststellung-kopf')).toHaveText(
        'Feststellung F-2029-0001 · aus dem internen Audit AU-2029-0001 · festgestellt von Claudia Berger am 22.01.2029 · Verantwortlich Jonas Wendlinger · Frist 22.04.2029 · offen.',
      );
      await expect(page.getByTestId('feststellung-frist')).toHaveText('Frist 22.04.2029: fällig in 90 Tagen');

      // FS2: sofortige Behebung als Aussage einer Person.
      await page.getByTestId('feststellung-eintrag').click();
      await waehle(page, combo(page, 'Art'), /^Sofortige Behebung/);
      await modal(page).getByLabel('Wortlaut').fill('Bis zur Festlegung gibt Ines Kaltenbach keine Bezugsbasis ohne Rücksprache mit Jonas Wendlinger frei.');
      await waehle(page, combo(page, 'Person'), /^Ines Kaltenbach/);
      await page.getByTestId('eintrag-senden').click();
      await expect(page.getByTestId('feststellung-eintrag-behebung')).toContainText(
        'Sofortige Behebung — Ines Kaltenbach, 22.01.2029: Bis zur Festlegung gibt Ines Kaltenbach keine Bezugsbasis ohne Rücksprache mit Jonas Wendlinger frei.',
      );
      await expect(page.getByTestId('feststellung-noch-nicht')).toHaveText(NOCH_NICHT);

      // FS3: „Maßnahme anlegen“ öffnet den AP-18-Dialog mit vorbelegter Herkunft — das Kundenwort, nie das Vertragswort.
      await page.getByTestId('feststellung-massnahmen').getByTestId('massnahme-anlegen-knopf').click();
      await expect(modal(page).getByTestId('massnahme-herkunft-vorbelegt')).toHaveText('Herkunft: Feststellung F-2029-0001.');
      await modal(page).getByTestId('massnahme-wahl-ohne').check();
      await modal(page).getByLabel('Titel').fill('Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen');
      await waehle(page, combo(page, 'Verantwortlich'), /^Jonas Wendlinger/);
      await waehleTag(page, combo(page, 'Termin'), '2029-02-28');
      await modal(page).getByLabel('erwartete Wirkung — Wortlaut').fill('Zuständigkeit festgelegt; jede Freigabe nennt die zuständige Person und ihre Vertretung.');
      await ohneQuerlauf(page, 'Dialog Maßnahme anlegen');
      await dialogBild(page, `d-massnahme-anlegen-${breite}`);
      await page.getByTestId('massnahme-anlegen-senden').click();
      await expect(page.locator('.vp-modal')).toHaveCount(0);
      const zeile = page.getByTestId('feststellung-massnahme-M-2029-0001');
      await expect(zeile).toContainText('geplant');
      await ohneQuerlauf(page, 'Feststellung mit Maßnahme');
      await ablegen(page, `e-feststellung-offen-${breite}`);

      // SP5/W3: die Maßnahmen-Seite sagt „Herkunft: Feststellung F-2029-0001.“ und springt dorthin zurück.
      await zeile.getByRole('link').click();
      const herkunft = page.getByTestId('massnahme-sprung-herkunft');
      await expect(herkunft).toHaveText('Herkunft: Feststellung F-2029-0001.');
      await expect(page.getByTestId('massnahme-seite')).not.toContainText(/Nichtkonformit/i);
      await page.getByTestId('massnahme-umgesetzt-knopf').click();
      await page.locator('.vp-kal-tag[data-iso="2029-01-22"]:not(.is-rand)').waitFor({ state: 'detached' }).catch(() => undefined);
      await modal(page).getByLabel('Begründung').fill('Aufgabe zugeordnet: Ines Kaltenbach, Vertretung Jonas Wendlinger.');
      await page.getByTestId('massnahme-umgesetzt-senden').click();
      await expect(page.getByTestId('massnahme-umgesetzt-am')).toBeVisible();
      await ohneQuerlauf(page, 'Maßnahmen-Seite mit Herkunft');
      await ablegen(page, `f-massnahme-herkunft-${breite}`);
      await herkunft.click();

      // FS4: die Wirksamkeit an der Feststellung — Stand Nr. 1 einer Person, mit Prüfsumme; „wirksam“ schließt ab.
      await expect(page.getByTestId('feststellung-massnahme-M-2029-0001')).toContainText('umgesetzt am 22.01.2029');
      await expect(page.getByTestId('feststellung-noch-nicht')).toHaveCount(0);
      await page.getByTestId('feststellung-wirksamkeit-pruefen').click();
      await waehle(page, combo(page, 'Ergebnis'), /^wirksam/);
      await modal(page).getByLabel('Begründung').fill('Aufgabe festgelegt, Vertretung benannt; die Freigaben nennen beide.');
      await waehle(page, combo(page, 'entschieden von (wer geprüft hat)'), /^Ines Kaltenbach/);
      await ohneQuerlauf(page, 'Dialog Wirksamkeit');
      await dialogBild(page, `g-wirksamkeit-${breite}`);
      await page.getByTestId('stand-senden').click();
      await expect(page.getByTestId('feststellung-kopf')).toContainText('· abgeschlossen.');
      await expect(page.getByTestId('feststellung-stand-1')).toContainText('Wirksamkeit geprüft am 22.01.2029 von Ines Kaltenbach: wirksam — Stand Nr. 1 mit Prüfsumme.');
      await expect(page.getByTestId('feststellung-massnahmen').getByTestId('massnahme-anlegen-knopf')).toHaveCount(0);
      await ohneQuerlauf(page, 'Feststellung abgeschlossen');
      await ablegen(page, `h-feststellung-abgeschlossen-${breite}`);

      // An der Grenze zur Route: jede Aussage trägt ihre Person, die Maßnahme ihre Herkunft mit Kennung.
      const koerper = await gesendet(page);
      expect(koerper.map((k) => k.route.replace(/[0-9a-f-]{36}/, '{id}'))).toEqual([
        'POST /api/v1/energiemanagement/audits',
        'POST /api/v1/energiemanagement/audits/{id}/durchgefuehrt',
        'POST /api/v1/energiemanagement/audits/{id}/hinweise',
        'POST /api/v1/energiemanagement/feststellungen',
        'POST /api/v1/energiemanagement/feststellungen/{id}/eintraege',
        'POST /api/v1/energiemanagement/feststellungen/{id}/wirksamkeit',
      ]);
      expect(koerper[3].koerper).toMatchObject({ quelle: { art: 'internes_audit' }, festgestellt_von: 'a1900000-0000-4000-8000-0000000000a5', verantwortlich: 'JW' });
      expect(koerper[5].koerper).toMatchObject({ ergebnis: 'wirksam', entschieden_von: 'a1900000-0000-4000-8000-0000000000a1' });
    });

    test('R9–R11 gelesen: Auditprogramm mit nächstem Audit, Feststellung mit Einträgen, Stand Nr. 1 „wirksam“', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&al=r11&seite=audits', breite, AM_15_04_2029);
      await expect(page.getByTestId('audit-naechstes')).toContainText('Nächstes internes Audit fällig am 22.01.2030');
      await expect(page.getByTestId('audit-zeile-AU-2029-0001')).toContainText('1 Hinweis · F-2029-0001');
      await ohneQuerlauf(page, 'Auditprogramm R9');
      await ablegen(page, `i-auditprogramm-${breite}`);
      await page.getByTestId('audit-zeile-AU-2029-0001').getByRole('button').click();
      await expect(page.getByTestId('audit-unabhaengigkeit')).toHaveText('Claudia Berger (Controlling) gehört nicht zum Energieteam und prüft keine eigene Arbeit.');
      await expect(page.getByTestId('audit-bericht')).toContainText('Geführt in Ihrem System: QM-Laufwerk, Ordner Energiemanagement/Audits');
      await expect(page.getByTestId('audit-pruefsumme')).toBeVisible();
      await ohneQuerlauf(page, 'Audit R9 abgeschlossen');
      await ablegen(page, `j-audit-abgeschlossen-${breite}`);
      await page.getByTestId('audit-sprung-F-2029-0001').click();
      await expect(page.getByTestId('feststellung-kopf')).toContainText('· abgeschlossen.');
      await expect(page.getByTestId('feststellung-eintrag-ursache_aussage')).toContainText(
        'Ursache — Aussage von Ines Kaltenbach, 25.01.2029: Die Aufgabenliste entstand zum Start, bevor es Bezugsbasen gab; sie wurde nicht nachgeführt.',
      );
      await expect(page.getByTestId('feststellung-stand-1')).toContainText('Wirksamkeit geprüft am 15.04.2029 von Ines Kaltenbach: wirksam — Stand Nr. 1 mit Prüfsumme.');
      await expect(page.getByTestId('feststellung-massnahme-M-2029-0001')).toContainText('umgesetzt am 01.03.2029');
      await ohneQuerlauf(page, 'Feststellung R11');

      await page.getByTestId('feststellung-zurueck').click();
      await expect(page.getByTestId('feststellung-zeile-F-2029-0001')).toContainText('abgeschlossen: wirksam');
    });

    test('Vier-Augen nicht erfüllbar als Satz (FS6, W15) und „Einsicht“ ohne Schreib-Knopf (R6)', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&al=r10&fs=1&vieraugen=1', breite, AM_15_04_2029);
      await expect(page.getByTestId('feststellung-vieraugen')).toHaveText(
        'Vier-Augen nicht erfüllbar: außer Ines Kaltenbach und Jonas Wendlinger darf niemand freigeben, und beide sind hier beteiligt.',
      );
      await ohneQuerlauf(page, 'Vier-Augen nicht erfüllbar');
      await ablegen(page, `k-vieraugen-${breite}`);

      const ohneSchreiben = async (fall: string) => {
        await expect(page.getByRole('button', { name: SCHREIBEN }), fall).toHaveCount(0);
        await ohneQuerlauf(page, fall);
      };
      await oeffne(page, 'person=RF&lage=ahrenberg&al=r10&seite=audits', breite, AM_15_04_2029);
      await expect(page.getByTestId('audits-register').getByTestId('einsicht-satz')).toHaveText(EINSICHT_LEER);
      await ohneSchreiben('Einsicht: Audits');
      await page.getByTestId('energiemanagement-reiter-feststellungen').click();
      await expect(page.getByTestId('feststellungen-register').getByTestId('einsicht-satz')).toHaveText(EINSICHT_LEER);
      await ohneSchreiben('Einsicht: Feststellungen');
      await page.getByTestId('feststellung-zeile-F-2029-0001').getByRole('button').click();
      await expect(page.getByTestId('feststellung-seite').getByTestId('einsicht-satz').first()).toHaveText(EINSICHT_LEER);
      await ohneSchreiben('Einsicht: Feststellung F-2029-0001');
      expect(await gesendet(page)).toEqual([]);
    });
  });
}
