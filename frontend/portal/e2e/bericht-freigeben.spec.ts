import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Der Weg vom Entwurf zum Berichtsstand (UEMS AP-12 IP-14, §5.1–§5.3; seit Konzept Nachweisen n1, Runde 2, §6.4 mit
 * „Erstellen“ in Schritten, „Prüfen“ und Bestätigung und EINER Entscheidung nach einer Korrektur) auf der Bühne
 * `startansicht` - die ECHTE Schale, die ECHTE Berichtsseite und die ECHTEN Blätter; die Antworten folgen der Zeitachse des Referenzunternehmens
 * (`src/test/berichtFixtures.ts`: 10.11.2026 08:55 angelegt · 09:02 Nr. 1 · 12.11. K-2026-0007 · 16.11. 14:20 Nr. 2).
 * Die Uhr der Bühne steht je Schritt auf dem Zeitpunkt der Referenzdatei — auch zwischen Öffnen und Klick.
 *
 * SERIELL: jeder Fall ist ein Schritt desselben Flusses (anlegen → freigeben → Revision → Nr. 2), und die Bilder der
 * Vorschau entstehen in dieser Reihenfolge. Die Bühne zählt, was geschrieben wurde (`window.__berichtAufrufe`).
 *
 * GEMESSEN, nicht behauptet: kein Querlauf des Dokuments, kein Element über den Rand des Dialogs, die Sätze wörtlich.
 * Mit `BERICHT_DIALOGE_BILDER=<Ordner>` legt der Lauf je Dialog ein Bild ab (375 px, dazu `…-ganz` in voller Höhe).
 * Die Spec importiert keine Fixtures (sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt).
 */

test.describe.configure({ mode: 'serial' });

const BILDER = process.env.BERICHT_DIALOGE_BILDER;
const ST1 = '5a1d0000-0000-4000-8000-000000000001';
const AM_20_10 = new Date('2026-10-20T08:30:00Z');
const AM_10_11_0850 = new Date('2026-11-10T07:50:00Z');
const AM_10_11_0855 = new Date('2026-11-10T07:55:00Z');
const AM_10_11_0858 = new Date('2026-11-10T07:58:00Z');
const AM_10_11_0902 = new Date('2026-11-10T08:02:00Z');
const AM_13_11 = new Date('2026-11-13T08:00:00Z');
const AM_16_11_1420 = new Date('2026-11-16T13:20:00Z');
const BEGRUENDUNG = 'Korrektur betrifft nur den 31.10. nach Betriebsschluss, Bericht bleibt';
const LAEUFT = 'Der Oktober 2026 ist noch nicht zu Ende — ein Berichtsstand ist ab dem 08.11.2026 möglich (7 Tage nach Monatsende).';

async function oeffne(page: Page, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function seite(page: Page) {
  await expect(page.getByTestId('bericht-status')).toBeVisible();
}

const text = async (page: Page, testId: string) => ((await page.getByTestId(testId).textContent()) ?? '').replace(/\s+/g, ' ').trim();

/** Querlauf des Dokuments und jedes Element, das über den Rand des obersten Dialogs (oder der Seite) steht. */
async function querlauf(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1) ?? null;
    const rand = dialog ? dialog.getBoundingClientRect().right : doc.clientWidth;
    const wo = dialog ?? document.querySelector<HTMLElement>('.vp-main') ?? document.body;
    const ueber = [...wo.querySelectorAll<HTMLElement>('*')]
      .filter((e) => (e.offsetParent !== null || getComputedStyle(e).position === 'fixed') && !e.closest('.vp-bereich-tabs'))
      .filter((e) => e.getBoundingClientRect().right > rand + 0.5)
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { dokument: doc.scrollWidth - doc.clientWidth, ueberstehend: [...new Set(ueber)] };
  });
}

async function ohneQuerlauf(page: Page, fall: string) {
  const m = await querlauf(page);
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
  return m;
}

/** Das Bild der Vorschau: so, wie das Telefon es zeigt — und einmal in voller Höhe des Dialogs. */
async function foto(page: Page, name: string, m: unknown) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}.json`), JSON.stringify(m, null, 2));
  const ruhe = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  await ruhe();
  await page.screenshot({ path: join(BILDER, `${name}.png`) });
  const groesse = page.viewportSize();
  if (!groesse) return;
  const dialog = page.locator('[role="dialog"]').last();
  if ((await dialog.count()) === 0) return;
  // In voller Höhe: der Inhalt des Dialogs von oben, so hoch, dass nichts mehr scrollt.
  const hoehe = await dialog.evaluate((d) => {
    const body = d.querySelector<HTMLElement>('.dbody');
    if (body) body.scrollTop = 0;
    return d.scrollHeight + (body ? body.scrollHeight - body.clientHeight : 0) + 160;
  });
  if (hoehe > groesse.height) {
    await page.setViewportSize({ width: groesse.width, height: Math.min(hoehe, 2400) });
    await ruhe();
    await page.screenshot({ path: join(BILDER, `${name}-ganz.png`) });
    await page.setViewportSize(groesse);
  }
}

async function waehle(page: Page, feld: string, option: string) {
  // `exact`: ab einigen Zeilen blendet der Picker ein Suchfeld „… durchsuchen“ ein, das ebenfalls combobox ist.
  const ausloeser = page.getByRole('combobox', { name: feld, exact: true });
  await ausloeser.click();
  // `aria-controls` trägt der Auslöser erst, wenn die Liste offen ist.
  await expect(ausloeser).toHaveAttribute('aria-controls', /-liste$/);
  const liste = page.locator(`[id="${await ausloeser.getAttribute('aria-controls')}"]`);
  await liste.getByRole('option', { name: option, exact: true }).click();
  await expect(ausloeser).toContainText(option);
}

const aufrufe = (page: Page) =>
  page.evaluate(() => (window as unknown as { __berichtAufrufe: { anlegen: unknown[]; freigeben: string[]; verwerfen: string[] } }).__berichtAufrufe);

/** Konzept Nachweisen n1, Runde 2 (§6.4): „Erstellen“ in Schritten - Welcher? · Für wo und wann? · Prüfen. */
async function erstellen(page: Page, art: 'monat' | 'jahr') {
  await page.getByTestId('bericht-anlegen-knopf').click();
  await expect(page.getByTestId('bericht-erstellen-art')).toBeVisible();
  // Die Antwort-Karte ist das Ziel (das Radio darin ist nur für Vorleser sichtbar).
  await page.getByTestId(`bericht-erstellen-art-${art}`).click();
  await page.getByTestId('bericht-erstellen-weiter').click();
}

test.describe('Bericht erstellen (§5.1, Nachweisen n1 §6.4)', () => {
  // AP-16 IP-25: Ines trägt `bewertung.abrufen` - eine Art ist die energetische Bewertung; AP-17 IP-24 der Leistungsvergleich.
  test('Ines, 10.11.2026 08:55: vier Arten, Werk Ahrenberg, Oktober vorbelegt, eine Kennzahl abgewählt → BR-2026-0001, Prüfen, „Später freigeben“', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte&berichte=leer&person=IK', 375, AM_10_11_0850);
    await expect(page.getByText('Es gibt noch keinen Bericht.')).toBeVisible();
    await page.getByTestId('bericht-anlegen-knopf').click();
    const arten = page.getByTestId('bericht-erstellen-art').getByRole('radio');
    await expect(arten).toHaveCount(4);
    expect((await page.getByTestId('bericht-erstellen-art').textContent())?.replace(/\s+/g, ' ')).toContain('Monatsbericht');
    await expect(page.getByTestId('bericht-erstellen-art')).toContainText('Energetische Bewertung');
    await expect(page.getByTestId('bericht-erstellen-art')).toContainText('Leistungsvergleich');
    let m = await ohneQuerlauf(page, 'erstellen-1-375');
    await foto(page, 'erstellen-1-375', m);
    await page.getByTestId('bericht-erstellen-art-monat').click();
    await page.getByTestId('bericht-erstellen-weiter').click();

    await page.getByTestId('bericht-erstellen-fuer').locator('label', { hasText: /^Werk Ahrenberg$/ }).click();
    await expect(page.getByRole('combobox', { name: 'Wann?' })).toContainText('Oktober 2026');
    await page.getByTestId('bericht-erstellen-kennzahlen-zeile').getByRole('button').click();
    const kennzahlen = page.getByTestId('bericht-erstellen-kennzahlen').getByRole('checkbox');
    const anzahl = await kennzahlen.count();
    expect(anzahl).toBeGreaterThan(0);
    for (let i = 0; i < anzahl; i++) await expect(kennzahlen.nth(i)).toBeChecked();
    await page.getByTestId('bericht-erstellen-kennzahlen').locator('label').first().click();
    await expect(kennzahlen.first()).not.toBeChecked();
    m = await ohneQuerlauf(page, 'erstellen-2-375');
    await foto(page, 'erstellen-2-375', m);

    // Vor „Weiter“ in Schritt 2 ist nichts geschrieben.
    expect((await aufrufe(page)).anlegen).toEqual([]);
    await page.clock.setFixedTime(AM_10_11_0855);
    await page.getByTestId('bericht-erstellen-weiter').click();
    const pruefen = page.getByTestId('bericht-pruefen');
    await expect(pruefen).toContainText('Monatsbericht Oktober 2026');
    await expect(pruefen).toContainText('Werk Ahrenberg');
    await expect(pruefen).toContainText('endgültig · 10.11.2026, 08:55');
    const [anfrage] = (await aufrufe(page)).anlegen as Array<Record<string, unknown>>;
    expect(anfrage).toMatchObject({ vorlage: 'monatsbericht_standort', geltung_id: ST1, zeitraum: '2026-10' });
    expect(anfrage.kennzahlen_abgewaehlt).toHaveLength(1);
    m = await ohneQuerlauf(page, 'erstellen-3-375');
    await foto(page, 'erstellen-3-375', m);
    await page.getByTestId('bericht-erstellen-spaeter').click();
    await seite(page);
    expect(await page.evaluate(() => document.body.dataset.route)).toBe('#/portfolio/berichte/BR-2026-0001');
    await expect(page.getByTestId('bericht-status')).toHaveText('Entwurf');
    await expect(page.getByTestId('bericht-freigeben')).toBeEnabled();
  });

  // AP-17 IP-24 (S1): der Leistungsvergleich gilt für Unternehmen ODER Standort — Peter bekommt ihn über Werk Lindach.
  test('Peter (Bearbeiter Lindach): Monats-, Jahresbericht und Leistungsvergleich, nur Werk Lindach - September sagt den Satz der Route', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte&berichte=leer&person=PH', 375, AM_10_11_0855);
    await page.getByTestId('bericht-anlegen-knopf').click();
    await expect(page.getByTestId('bericht-erstellen-art').getByRole('radio')).toHaveCount(3);
    await expect(page.getByTestId('bericht-erstellen-art')).not.toContainText('Energetische Bewertung');
    await page.getByTestId('bericht-erstellen-art-monat').click();
    await page.getByTestId('bericht-erstellen-weiter').click();
    const fuer = page.getByTestId('bericht-erstellen-fuer');
    await expect(fuer.getByRole('radio')).toHaveCount(1);
    await expect(fuer).toContainText('Werk Lindach');
    await expect(fuer).not.toContainText('Unternehmen');
    await waehle(page, 'Wann?', 'September 2026');
    await page.getByTestId('bericht-erstellen-weiter').click();
    await expect(page.getByTestId('blatt-ablehnung')).toHaveText('Für Werk Lindach gibt es im September 2026 keine Messstellen — der Standort besteht seit dem 15.10.2026.');
    const m = await ohneQuerlauf(page, 'erstellen-abgelehnt-375');
    await foto(page, 'erstellen-abgelehnt-375', m);
  });

  test('den Bericht gibt es schon: der Satz der Route und „Bericht öffnen“', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte&person=IK', 375, AM_13_11);
    await erstellen(page, 'monat');
    await page.getByTestId('bericht-erstellen-fuer').locator('label', { hasText: /^Werk Ahrenberg$/ }).click();
    await page.getByTestId('bericht-erstellen-weiter').click();
    await expect(page.getByTestId('blatt-ablehnung')).toContainText('Diesen Bericht gibt es schon');
    await page.getByTestId('bericht-erstellen-oeffnen-vorhanden').click();
    await seite(page);
    await expect(page.getByTestId('bericht-entscheid')).toBeVisible();
  });
});

test.describe('Stand freigeben (§5.2, Nachweisen n1 §6.4)', () => {
  test('10.11.2026: Prüfen mit „endgültig“ und dem Datenstand - Stand 1 um 09:02, Bestätigung mit PDF', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&person=IK', 375, AM_10_11_0858);
    await seite(page);
    await expect(page.getByTestId('bericht-status')).toHaveText('Entwurf');
    await page.getByTestId('bericht-freigeben').click();
    await expect(page.getByTestId('bericht-pruefen')).toContainText('endgültig · 10.11.2026, 08:55');
    await expect(page.getByTestId('bericht-pruefen-hinweis')).toContainText('Ändert sich danach nie mehr');
    let m = await ohneQuerlauf(page, 'freigeben-375');
    await foto(page, 'freigeben-375', m);

    await page.clock.setFixedTime(AM_10_11_0902);
    await page.getByTestId('bericht-freigeben-senden').click();
    const bestaetigung = page.getByTestId('bericht-bestaetigung');
    await expect(bestaetigung).toContainText('Stand 1 ist freigegeben');
    await expect(bestaetigung).toContainText('10.11.2026, 09:02');
    await expect(bestaetigung.getByRole('button', { name: 'PDF' })).toBeVisible();
    m = await ohneQuerlauf(page, 'bestaetigung-375');
    await foto(page, 'bestaetigung-375', m);
    await page.getByTestId('bericht-fertig').click();
    await expect(page.getByTestId('bericht-status')).toHaveText('Stand 1 gilt· Daten unverändert');
    await expect(page.getByTestId('bericht-zeile-pruefsumme')).toBeVisible();
    expect((await aufrufe(page)).freigeben).toEqual(['2026-11-10T07:55:00Z']);
  });

  test('20.10.2026: der Oktober läuft - „Freigeben“ ist aus und sagt warum (B4 a)', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&person=IK', 375, AM_20_10);
    await seite(page);
    await expect(page.getByTestId('bericht-freigeben')).toBeDisabled();
    expect(await text(page, 'bericht-freigeben-warum')).toBe(LAEUFT);
    const m = await ohneQuerlauf(page, 'laeuft-375');
    await foto(page, 'laeuft-375', m);
  });
});

test.describe('Nach einer Korrektur: eine Entscheidung mit zwei Antworten (§5.3, Entscheid 16)', () => {
  test('13.11.2026: „Daten geändert“, die Werte alt → neu, der Grund - „Ja, Stand 2 freigeben“ am 16.11.2026 14:20', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&person=IK', 375, AM_13_11);
    await seite(page);
    await expect(page.getByTestId('bericht-status')).toHaveText('Daten geändert· Stand 1 gilt noch');
    const karte = page.getByTestId('bericht-entscheid');
    const werte = karte.getByTestId('bericht-entscheid-werte').locator('li');
    await expect(werte).toHaveCount(3);
    const erste = ((await werte.first().textContent()) ?? '').replace(/\s+/g, ' ');
    expect(erste).toMatch(/6\.100/u);
    expect(erste).toMatch(/6\.040/u);
    let m = await ohneQuerlauf(page, 'entscheid-375');
    await foto(page, 'entscheid-375', m);
    await karte.getByTestId('bericht-grund').click();
    const grund = page.getByTestId('bericht-grund-blatt');
    await expect(grund).toContainText('Korrektur K-2026-0007');
    await expect(grund).toContainText('Zählerablesung 31.10. berichtigt (Ablesefehler 60 kWh)');
    await expect(grund).toContainText('Ines Kaltenbach');
    m = await ohneQuerlauf(page, 'grund-375');
    await foto(page, 'grund-375', m);
    await page.keyboard.press('Escape');

    await karte.getByTestId('bericht-antwort-ja').click();
    await karte.getByTestId('bericht-weiter').click();
    await expect(page.getByTestId('bericht-pruefen-hinweis')).toContainText('Stand 1 bleibt lesbar');
    await expect(page.getByTestId('bericht-pruefen')).toContainText('endgültig · 12.11.2026, 10:05');
    m = await ohneQuerlauf(page, 'revision-freigeben-375');
    await foto(page, 'revision-freigeben-375', m);

    await page.clock.setFixedTime(AM_16_11_1420);
    await page.getByTestId('bericht-freigeben-senden').click();
    await expect(page.getByTestId('bericht-bestaetigung')).toContainText('Stand 2 ist freigegeben');
    await page.getByTestId('bericht-fertig').click();
    await expect(page.getByTestId('bericht-status')).toHaveText('Stand 2 gilt· Daten unverändert');
    await expect(page.getByTestId('bericht-entscheid')).toHaveCount(0);
    await expect(page.getByTestId('bericht-stand-1')).toContainText('überholt');
    expect((await aufrufe(page)).freigeben).toEqual(['2026-11-12T09:05:33Z']);
  });

  test('13.11.2026: „Nein, Stand 1 behalten“ - ohne Grund am Feld abgelehnt, mit Grund „Änderung nicht übernommen“', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&person=IK', 375, AM_13_11);
    await seite(page);
    const karte = page.getByTestId('bericht-entscheid');
    await karte.getByTestId('bericht-antwort-nein').click();
    await karte.getByTestId('bericht-weiter').click();
    const d = page.getByTestId('bericht-behalten-blatt');
    await expect(d).toContainText('Stand 1 bleibt gültig');
    await page.getByTestId('bericht-behalten-senden').click();
    await expect(d).toContainText('Die Begründung fehlt.');
    await expect(page.getByTestId('bericht-behalten-grund')).toBeFocused();
    await page.getByTestId('bericht-behalten-grund').fill(BEGRUENDUNG);
    const m = await ohneQuerlauf(page, 'behalten-375');
    await foto(page, 'behalten-375', m);
    await page.getByTestId('bericht-behalten-senden').click();
    await expect(page.getByTestId('bericht-behalten-blatt')).toHaveCount(0);
    await expect(page.getByTestId('bericht-entscheid')).toHaveCount(0);
    await expect(page.getByTestId('bericht-status')).toHaveText('Stand 1 gilt· Änderung nicht übernommen');
    await page.getByTestId('bericht-korrekturen').click();
    await expect(page.getByTestId('bericht-grund-blatt')).toContainText(`nicht übernommen: ${BEGRUENDUNG}`);
    expect((await aufrufe(page)).verwerfen).toEqual([BEGRUENDUNG]);
  });

  test('Claudia (Leser): kein „Erstellen“, keine Antworten - an ihrer Stelle, wer freigibt', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte&person=CB', 375, AM_13_11);
    await expect(page.getByTestId('bericht-zeile-BR-2026-0001')).toHaveCount(1);
    await expect(page.getByTestId('bericht-anlegen-knopf')).toHaveCount(0);
    await page.getByTestId('bericht-zeile-BR-2026-0001').click();
    await seite(page);
    const karte = page.getByTestId('bericht-entscheid');
    await expect(karte.getByTestId('bericht-entscheid-werte').locator('li')).toHaveCount(3);
    await expect(karte.getByRole('radio')).toHaveCount(0);
    await expect(karte.getByTestId('bericht-freigeben-ohne-recht')).toContainText('Freigeben:');
  });

  test('bei 1440 px: Entscheidung und Prüfen ohne Querlauf', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&person=IK', 1440, AM_13_11);
    await seite(page);
    await expect(page.getByTestId('bericht-entscheid-werte').locator('li')).toHaveCount(3);
    let m = await ohneQuerlauf(page, 'entscheid-1440');
    await foto(page, 'entscheid-1440', m);
    await page.getByTestId('bericht-antwort-ja').click();
    await page.getByTestId('bericht-weiter').click();
    await expect(page.getByTestId('bericht-pruefen')).toBeVisible();
    m = await ohneQuerlauf(page, 'freigeben-1440');
    await foto(page, 'freigeben-1440', m);
  });
});
