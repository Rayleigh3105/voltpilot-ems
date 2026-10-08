import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { grenzHinweisZeigt } from './grenzHinweis';

/**
 * „Energiemanagement › Audits“ und „› Feststellungen“ (UEMS AP-19 IP-20, §5.4, R9–R11, SP5, W3) bei 375 px und 1440 px
 * auf der Bühne von IP-9 `e2e/energiemanagement.html` mit `&al=…` — die ECHTE Schale, die ECHTEN Reiter, die Routen von
 * IP-18/IP-19 gespielt aus dem Referenzunternehmen 1.10, die Maßnahme über die Routen von AP-18 und die ECHTE
 * Maßnahmen-Seite.
 *
 * Fälle: der ganze Weg Audit planen (Blatt in drei Schritten) → durchgeführt → Hinweis → Feststellung → Eintrag →
 * „Maßnahme anlegen“ mit vorbelegter Herkunft → Maßnahmen-Seite („Herkunft: Feststellung F-…“ als Sprung) → umgesetzt →
 * Wirksamkeit (Blatt) → abgeschlossen · R10/R11 gelesen (Status zuerst, Als Nächstes, Stufen, Einträge als Datumsblöcke
 * mit Kürzel) · Vier-Augen nicht erfüllbar als Satz · „Einsicht“ ohne Schreib-Knopf · `…/feststellungen` öffnet den
 * Reiter „Audits“ (Konzept Nachweisen n1 Runde 2, §6.6, Entscheid 17).
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
const SCHREIBEN =
  /^(Planen|Audit planen|Durchgeführt melden|Hinweis festhalten|Audit abschließen|Audit absagen|Feststellung erfassen|Eintrag festhalten|Festhalten|Wirksamkeit prüfen|Ohne Maßnahme abschließen|Zurücknehmen)$/;
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

const blatt = (page: Page, testId: string) => page.getByTestId(testId);
const feldIn = (page: Page, testId: string, name: string) => blatt(page, testId).getByRole('combobox', { name, exact: true });

for (const breite of [375, 1440]) {
  /** „Maßnahme planen“: am Telefon vier Schritte mit „Weiter“, am Rechner ein Dialog. */
  const weiter = async (page: Page) => {
    if (breite < 720) await modal(page).getByTestId('planen-weiter').click();
  };
  test.describe(`Energiemanagement › Audits und Feststellungen bei ${breite} px`, () => {
    test('Audit → Feststellung → Maßnahme → Wirksamkeit: der ganze Weg mit vorbelegter Herkunft (R9–R11, SP5)', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&al=leer&seite=audits', breite);
      await expect(page.getByTestId('energiemanagement-reiter-audits')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('audits-leer')).toHaveText('Noch kein internes Audit');
      await expect(page.getByTestId('feststellungen-leer')).toHaveText('Keine Feststellung');
      await expect(page.getByTestId('audits-status')).toHaveText('keine Feststellung offen');
      // Ohne durchgeführtes Audit nennt VoltPilot keine Frist: „Als Nächstes“ ohne Datumsblock.
      await expect(page.getByTestId('audit-naechstes')).toContainText('Erstes internes Audit');
      await expect(page.getByTestId('audit-naechstes').locator('.vp-fd')).toHaveCount(0);
      await grenzHinweisZeigt(page, GRENZE, VERANTWORTUNG);

      // IA1 als Blatt in drei Schritten: was und wann, wer prüft und warum unabhängig, Prüfen.
      await page.getByTestId('audit-naechstes').getByRole('button', { name: 'Planen' }).click();
      await expect(page.getByTestId('nw-schritt')).toContainText('Schritt 1 von 3');
      await blatt(page, 'audit-planen-was').fill('Bezugsbasen BB-0001 bis BB-0005, Energieziel EZ-2028-0001, Aufgaben im Energiemanagement');
      await waehleTag(page, feldIn(page, 'audit-planen-blatt', 'Wann?'), '2029-01-22');
      await ohneQuerlauf(page, 'Blatt Audit planen, Schritt 1');
      await ablegen(page, `a-audit-planen-1-${breite}`);
      await page.getByTestId('audit-planen-weiter').click();
      await waehle(page, feldIn(page, 'audit-planen-blatt', 'Wer prüft?'), /^Claudia Berger/);
      // Die Mehrfach-Auswahl bleibt offen, bis man daneben tippt (am Telefon ein Blatt mit Hintergrund).
      const hintergrund = page.locator('.vp-picker-backdrop');
      if (await hintergrund.count()) await hintergrund.click({ position: { x: 8, y: 8 } });
      else await page.getByTestId('nw-schritt').click();
      await expect(hintergrund).toHaveCount(0);
      await expect(page.locator('.vp-picker-panel')).toHaveCount(0);
      // Der Tipp daneben schloss nur den Picker, das Blatt steht noch.
      await expect(page.getByTestId('audit-planen-blatt')).toBeVisible();
      await page.getByTestId('audit-planen-unabhaengig-team').click();
      await ohneQuerlauf(page, 'Blatt Audit planen, Schritt 2');
      await ablegen(page, `a-audit-planen-2-${breite}`);
      await page.getByTestId('audit-planen-weiter').click();
      await expect(page.getByTestId('audit-planen-pruefen')).toContainText('Internes Audit 2029');
      await page.getByRole('button', { name: 'Woran ändern' }).click();
      await blatt(page, 'audit-planen-blatt').getByLabel('Woran prüfen Sie?').fill('Energiepolitik D-0001 Fassung 1, Aufgaben im Energiemanagement');
      await ohneQuerlauf(page, 'Blatt Audit planen, Prüfen');
      await ablegen(page, `a-audit-planen-3-${breite}`);
      await page.getByTestId('audit-planen-senden').click();
      await expect(page.getByTestId('audit-planen-blatt')).toHaveCount(0);
      await expect(page.getByTestId('audit-status')).toHaveText('geplant· am 22.01.2029');

      // Durchgeführt am 22.01.2029, ein Hinweis mit „festgestellt von“ der Auditorin (IA2, IA5).
      await page.getByTestId('audit-durchgefuehrt').click();
      await page.getByTestId('audit-durchgefuehrt-senden').click();
      await expect(page.getByTestId('audit-status')).toHaveText('durchgeführt· noch offen');
      await expect(page.getByTestId('audit-stufen').locator('li')).toHaveText(['Geplant22.01.2029', 'Durchgeführt22.01.2029', 'Abgeschlossenjetzt']);
      await page.getByTestId('audit-hinweis').click();
      await expect(combo(page, 'Festgestellt von')).toContainText('Claudia Berger');
      await modal(page).getByLabel('Hinweis im Wortlaut').fill(HINWEIS);
      await page.getByTestId('hinweis-senden').click();
      await expect(page.getByTestId('audit-daraus-hinweis-0')).toContainText('Hinweis');
      await page.getByTestId('audit-daraus-hinweis-0').click();
      await expect(page.getByTestId('audit-hinweis-1')).toHaveText(HINWEIS);
      await expect(page.getByTestId('audit-blatt-hinweis')).toContainText('Claudia Berger · 22.01.2029');
      await page.keyboard.press('Escape');
      await expect(page.locator('.vp-bs-wrap, .vp-modal')).toHaveCount(0);
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
      await expect(page.getByTestId('feststellung-kopf').locator('h1')).toHaveText(WORTLAUT);
      await expect(page.getByTestId('feststellung-status')).toHaveText('offen· bis 22.04.2029');

      // FS2: sofortige Behebung als Aussage einer Person - ein Datumsblock mit Kürzel, der Wortlaut auf Antippen.
      await page.getByTestId('feststellung-eintrag').click();
      await waehle(page, combo(page, 'Art'), /^Sofortige Behebung/);
      await modal(page).getByLabel('Wortlaut').fill('Bis zur Festlegung gibt Ines Kaltenbach keine Bezugsbasis ohne Rücksprache mit Jonas Wendlinger frei.');
      await waehle(page, combo(page, 'Person'), /^Ines Kaltenbach/);
      await page.getByTestId('eintrag-senden').click();
      await expect(page.getByTestId('feststellung-eintrag-behebung')).toHaveText('22.01.2029Sofort behobenIK');
      await expect(page.getByTestId('feststellung-eintrag-behebung').getByRole('img', { name: 'Ines Kaltenbach' })).toBeVisible();
      await expect(page.getByTestId('feststellung-noch-nicht')).toContainText('Prüfen nach der Umsetzung');

      // FS3: „Maßnahme anlegen“ öffnet den AP-18-Dialog mit vorbelegter Herkunft — das Kundenwort, nie das Vertragswort.
      await page.getByTestId('feststellung-seite').getByTestId('massnahme-anlegen-knopf').click();
      await expect(modal(page).getByTestId('massnahme-herkunft-vorbelegt')).toHaveText('Herkunft: Feststellung F-2029-0001.');
      // Entscheid 6: aus einer Feststellung ist die Maßnahme organisatorisch vorbelegt - sie trägt keine Zahl.
      await expect(modal(page).getByTestId('planen-art-organisatorisch').locator('input')).toBeChecked();
      await modal(page).getByTestId('planen-titel').fill('Aufgabe „Bezugsbasen pflegen und freigeben“ festlegen');
      await weiter(page);
      await expect(modal(page).getByTestId('planen-prozent')).toHaveCount(0);
      await modal(page).getByTestId('planen-wortlaut').fill('Zuständigkeit festgelegt; jede Freigabe nennt die zuständige Person und ihre Vertretung.');
      await weiter(page);
      await waehle(page, combo(page, 'Wer kümmert sich?'), /^Jonas Wendlinger/);
      await modal(page).getByRole('group', { name: 'Bis wann?' }).getByRole('button', { name: 'Ende Februar' }).click();
      await weiter(page);
      await ohneQuerlauf(page, 'Dialog Maßnahme planen');
      await dialogBild(page, `d-massnahme-anlegen-${breite}`);
      await modal(page).locator('[data-testid="massnahme-anlegen-senden"]:visible').click();
      await expect(page.locator('.vp-modal')).toHaveCount(0);
      const zeile = page.getByTestId('feststellung-massnahme-M-2029-0001');
      await expect(zeile).toContainText('geplant');
      await ohneQuerlauf(page, 'Feststellung mit Maßnahme');
      await ablegen(page, `e-feststellung-offen-${breite}`);

      // SP5/W3: die Maßnahmen-Seite sagt „Herkunft: Feststellung F-2029-0001.“ und springt dorthin zurück.
      await zeile.click();
      const herkunft = page.getByTestId('massnahme-sprung-herkunft');
      await expect(page.getByTestId('massnahme-herkunft')).toContainText('Herkunft: Feststellung F-2029-0001.');
      await expect(page.getByTestId('massnahme-seite')).not.toContainText(/Nichtkonformit/i);
      await page.getByTestId('massnahme-umgesetzt-knopf').click();
      await expect(modal(page).getByRole('button', { name: 'Heute, 22.01.' })).toHaveAttribute('aria-pressed', 'true');
      await page.getByTestId('massnahme-umgesetzt-text').fill('Aufgabe zugeordnet: Ines Kaltenbach, Vertretung Jonas Wendlinger.');
      await page.getByTestId('massnahme-umgesetzt-senden').click();
      await expect(page.getByTestId('verlauf-massnahme_umgesetzt')).toBeVisible();
      await ohneQuerlauf(page, 'Maßnahmen-Seite mit Herkunft');
      await ablegen(page, `f-massnahme-herkunft-${breite}`);
      await herkunft.click();

      // FS4 als Blatt: „Behoben, und bleibt es so?“ - vorbelegt die Person des eigenen Kontos und der Tag der Route.
      await expect(page.getByTestId('feststellung-massnahme-M-2029-0001')).toContainText('umgesetzt');
      await expect(page.getByTestId('feststellung-noch-nicht')).toHaveCount(0);
      await expect(page.getByTestId('feststellung-stufen').locator('li').last()).toHaveText('Wirksam?jetzt');
      await page.getByTestId('feststellung-wirksamkeit-pruefen').click();
      await expect(page.getByTestId('wirksamkeit-ergebnis-wirksam').locator('input')).toBeChecked();
      await page.getByTestId('wirksamkeit-begruendung').fill('Aufgabe festgelegt, Vertretung benannt; die Freigaben nennen beide.');
      await expect(page.getByTestId('wirksamkeit-blatt')).toContainText('Ines Kaltenbach · 22.01.2029');
      await ohneQuerlauf(page, 'Blatt Wirksamkeit');
      await ablegen(page, `g-wirksamkeit-${breite}`);
      await page.getByTestId('wirksamkeit-festhalten').click();
      await expect(page.getByTestId('feststellung-status')).toHaveText('behoben und wirksam');
      await expect(page.getByTestId('feststellung-stufen').locator('li').last()).toHaveText('Wirksam22.01.2029');
      await expect(page.getByTestId('feststellung-seite').getByTestId('massnahme-anlegen-knopf')).toHaveCount(0);
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
      expect(koerper[0].koerper).toMatchObject({
        titel: 'Internes Audit 2029', termin: '2029-01-22', auditor_ids: ['a1900000-0000-4000-8000-0000000000a5'],
        unabhaengigkeit: 'Claudia Berger gehört nicht zum Energieteam und prüft keine eigene Arbeit.', verantwortlich: 'IK',
      });
      expect(koerper[3].koerper).toMatchObject({ quelle: { art: 'internes_audit' }, festgestellt_von: 'a1900000-0000-4000-8000-0000000000a5', verantwortlich: 'JW' });
      expect(koerper[5].koerper).toMatchObject({ ergebnis: 'wirksam', entschieden_von: 'a1900000-0000-4000-8000-0000000000a1', am: '2029-01-22' });
    });

    test('R9–R11 gelesen: Audits mit nächstem Audit, Feststellung mit Einträgen und Stufen bis „wirksam“', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&al=r11&seite=audits', breite, AM_15_04_2029);
      await expect(page.getByTestId('audits-status')).toHaveText('keine Feststellung offen');
      await expect(page.getByTestId('audit-naechstes')).toContainText('Internes Audit 2030');
      await expect(page.getByTestId('audit-naechstes').getByRole('img', { name: 'bis 22.01.2030' })).toBeVisible();
      await expect(page.getByTestId('audit-zeile-AU-2029-0001')).toHaveText(/Internes Audit 2029\s*1 Hinweis · 1 Feststellung/);
      await expect(page.getByTestId('feststellung-zeile-F-2029-0001')).toContainText('wirksam seit 15.04.2029');
      await ohneQuerlauf(page, 'Audits R9');
      await ablegen(page, `i-audits-${breite}`);
      await page.getByTestId('audit-zeile-AU-2029-0001').click();
      await expect(page.getByTestId('audit-status')).toHaveText('abgeschlossen');
      await expect(page.getByTestId('audit-daraus')).toContainText('Feststellung');
      await page.getByTestId('audit-pruefer').click();
      await expect(page.getByTestId('audit-blatt-pruefer')).toContainText('Claudia Berger (Controlling) gehört nicht zum Energieteam und prüft keine eigene Arbeit.');
      await page.keyboard.press('Escape');
      await expect(page.locator('.vp-bs-wrap, .vp-modal')).toHaveCount(0);
      await page.getByTestId('audit-original').click();
      await expect(page.getByTestId('audit-blatt-original')).toContainText('QM-Laufwerk, Ordner Energiemanagement/Audits');
      await expect(page.getByTestId('audit-blatt-original')).toContainText('Prüfsumme');
      await page.keyboard.press('Escape');
      await expect(page.locator('.vp-bs-wrap, .vp-modal')).toHaveCount(0);
      await ohneQuerlauf(page, 'Audit R9 abgeschlossen');
      await ablegen(page, `j-audit-abgeschlossen-${breite}`);
      await page.getByTestId('audit-daraus-feststellung-1').click();
      await expect(page.getByTestId('feststellung-status')).toHaveText('behoben und wirksam');
      await expect(page.getByTestId('feststellung-stufen').locator('li')).toHaveText([
        'Festgestellt22.01.2029', /^Maßnahme\d{2}\.\d{2}\.\d{4}$/, 'Umgesetzt01.03.2029', 'Wirksam15.04.2029',
      ]);
      await page.getByTestId('feststellung-eintrag-ursache_aussage').click();
      await expect(page.getByTestId('feststellung-blatt-eintrag')).toContainText(
        'Die Aufgabenliste entstand zum Start, bevor es Bezugsbasen gab; sie wurde nicht nachgeführt.',
      );
      await page.keyboard.press('Escape');
      await expect(page.locator('.vp-bs-wrap, .vp-modal')).toHaveCount(0);
      // Stand Nr. 1 mit Begründung und Prüfsumme: einen Tipp tiefer, im Menü „…“.
      await page.getByTestId('feststellung-kopf').getByRole('button', { name: 'Weitere Aktionen' }).click();
      await page.getByRole('menuitem', { name: 'Stand 1 · wirksam' }).click();
      await expect(page.getByTestId('feststellung-blatt-stand')).toContainText('Prüfsumme');
      await page.keyboard.press('Escape');
      await expect(page.locator('.vp-bs-wrap, .vp-modal')).toHaveCount(0);
      await ohneQuerlauf(page, 'Feststellung R11');
      await ablegen(page, `k-feststellung-wirksam-${breite}`);

      // Zurück zum Audit, aus dem sie kommt.
      await page.getByTestId('feststellung-kopf').getByRole('button', { name: 'Internes Audit 2029' }).click();
      await expect(page.getByTestId('audit-seite')).toBeVisible();
    });

    test('Vier-Augen nicht erfüllbar als Satz (FS6, W15), „Einsicht“ ohne Schreib-Knopf (R6), …/feststellungen öffnet Audits (Entscheid 17)', async ({ page }) => {
      await oeffne(page, 'lage=ahrenberg&al=r10&fs=1&vieraugen=1', breite, AM_15_04_2029);
      await expect(page.getByTestId('feststellung-vieraugen')).toHaveText(
        'Vier-Augen nicht erfüllbar: außer Ines Kaltenbach und Jonas Wendlinger darf niemand freigeben, und beide sind hier beteiligt.',
      );
      await ohneQuerlauf(page, 'Vier-Augen nicht erfüllbar');
      await ablegen(page, `l-vieraugen-${breite}`);

      const ohneSchreiben = async (fall: string) => {
        await expect(page.getByRole('button', { name: SCHREIBEN }), fall).toHaveCount(0);
        await ohneQuerlauf(page, fall);
      };
      await oeffne(page, 'person=RF&lage=ahrenberg&al=r10&seite=feststellungen', breite, AM_15_04_2029);
      await expect(page.getByTestId('energiemanagement-reiter-audits')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('energiemanagement-reiter-feststellungen')).toHaveCount(0);
      await expect(page.getByTestId('feststellungen-register')).toBeInViewport();
      await expect(page.getByTestId('einsicht-rolle')).toBeVisible();
      await ohneSchreiben('Einsicht: Audits');
      await page.getByTestId('feststellung-zeile-F-2029-0001').click();
      await expect(page.getByTestId('feststellung-seite').getByTestId('einsicht-satz').first()).toHaveText(EINSICHT_LEER);
      await ohneSchreiben('Einsicht: Feststellung F-2029-0001');
      expect(await gesendet(page)).toEqual([]);
    });
  });
}
