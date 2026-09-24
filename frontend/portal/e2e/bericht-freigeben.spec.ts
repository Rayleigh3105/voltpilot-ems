import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Der Weg vom Entwurf zum Berichtsstand (UEMS AP-12 IP-14, §5.1–§5.3) auf der Bühne `startansicht` — die ECHTE Schale,
 * die ECHTE Berichtsseite und die ECHTEN Dialoge; die Antworten folgen der Zeitachse des Referenzunternehmens
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
  await expect(page.getByTestId('bericht-kopf')).toBeVisible();
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
      .filter((e) => (e.offsetParent !== null || getComputedStyle(e).position === 'fixed') && !e.closest('.vp-bereich-tabs, .vp-br-wahl'))
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

test.describe('Bericht anlegen (§5.1)', () => {
  // AP-16 IP-25: Ines trägt `bewertung.abrufen` — die fünfte Karte ist die energetische Bewertung (Datengrundlage).
  // AP-17 IP-24: die sechste und letzte ist der Leistungsvergleich (Unternehmen oder Standort, Reihenfolge von `VORLAGEN`).
  test('Ines, 10.11.2026 08:55: sechs Vorlagen, Werk Ahrenberg, Oktober vorbelegt, eine Kennzahl abgewählt → BR-2026-0001 mit Entwurf', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte&berichte=leer&person=IK', 375, AM_10_11_0850);
    await expect(page.getByText('Es gibt noch keinen Bericht.')).toBeVisible();
    await page.getByTestId('bericht-anlegen-knopf').click();
    const d = page.getByTestId('bericht-anlegen');
    await expect(d.locator('.vp-bd-karte')).toHaveCount(6);
    await expect(d.locator('.vp-bd-karte').nth(4)).toContainText('Energetische Bewertung');
    await expect(d.locator('.vp-bd-karte').last()).toContainText('Leistungsvergleich');
    await expect(d.locator('.vp-bd-karte').first()).toHaveClass(/is-gewaehlt/);
    await expect(d.locator('.vp-bd-karte').first()).toContainText('Monatsbericht Standort');
    await expect(d.locator('.vp-bd-karte').first()).toContainText('Fassung 1');

    await waehle(page, 'Geltung', 'Werk Ahrenberg');
    await expect(page.getByRole('combobox', { name: 'Zeitraum' })).toContainText('Oktober 2026');
    await expect(page.getByTestId('bericht-anlegen-vorschau')).toContainText('Der Oktober 2026 ist zu Ende · endgültig seit 08.11.2026');

    const kennzahlen = d.getByTestId('bericht-anlegen-kennzahlen').getByRole('checkbox');
    const anzahl = await kennzahlen.count();
    expect(anzahl).toBeGreaterThan(0);
    for (let i = 0; i < anzahl; i++) await expect(kennzahlen.nth(i)).toBeChecked();
    await kennzahlen.first().uncheck();
    const m = await ohneQuerlauf(page, 'anlegen-375');
    await foto(page, 'anlegen-375', m);

    // Vor „Anlegen“ ist nichts geschrieben.
    expect((await aufrufe(page)).anlegen).toEqual([]);
    await page.clock.setFixedTime(AM_10_11_0855);
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();
    await seite(page);
    expect(await page.evaluate(() => document.body.dataset.route)).toBe('#/portfolio/berichte/BR-2026-0001');
    const [anfrage] = (await aufrufe(page)).anlegen as Array<Record<string, unknown>>;
    expect(anfrage).toMatchObject({ vorlage: 'monatsbericht_standort', geltung_id: ST1, zeitraum: '2026-10' });
    expect(anfrage.kennzahlen_abgewaehlt).toHaveLength(1);
    await expect(page.locator('.vp-br-zeile-kopf')).toHaveText('Entwurf · Datenstand 10.11.2026 08:55 (MEZ)');
    await expect(page.getByRole('button', { name: 'Als Berichtsstand freigeben' })).toBeEnabled();
  });

  // AP-17 IP-24 (S1): der Leistungsvergleich gilt für Unternehmen ODER Standort — Peter bekommt ihn über Werk Lindach.
  test('Peter (Bearbeiter Lindach): die zwei Standort-Vorlagen und der Leistungsvergleich, nur Werk Lindach — September sagt den Satz der Route', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte&berichte=leer&person=PH', 375, AM_10_11_0855);
    await page.getByTestId('bericht-anlegen-knopf').click();
    const d = page.getByTestId('bericht-anlegen');
    await expect(d.locator('.vp-bd-karte')).toHaveCount(3);
    await expect(d.locator('.vp-bd-karte').last()).toContainText('Leistungsvergleich');
    await expect(d).not.toContainText('Unternehmen');
    await expect(page.getByRole('combobox', { name: 'Geltung' })).toContainText('Werk Lindach');
    await waehle(page, 'Zeitraum', 'September 2026');
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();
    const fehler = d.getByRole('alert');
    await expect(fehler).toHaveText('Für Werk Lindach gibt es im September 2026 keine Messstellen — der Standort besteht seit dem 15.10.2026.');
    const m = await ohneQuerlauf(page, 'anlegen-abgelehnt-375');
    await foto(page, 'anlegen-abgelehnt-375', m);
  });

  test('den Bericht gibt es schon: der Satz der Route und „Bericht öffnen“', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte&person=IK', 375, AM_13_11);
    await page.getByTestId('bericht-anlegen-knopf').click();
    await waehle(page, 'Geltung', 'Werk Ahrenberg');
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();
    await expect(page.getByTestId('bericht-anlegen').getByRole('alert')).toContainText(
      'Diesen Bericht gibt es schon: BR-2026-0001 (Monatsbericht Werk Ahrenberg, Oktober 2026).',
    );
    await page.getByRole('button', { name: 'Bericht öffnen' }).click();
    await seite(page);
    await expect(page.getByTestId('bericht-revision')).toBeVisible();
  });
});

test.describe('Berichtsstand freigeben (§5.2)', () => {
  test('10.11.2026: drei Voraussetzungen erfüllt, der Datenstand im Text — Nr. 1 freigegeben um 09:02', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&person=IK', 375, AM_10_11_0858);
    await seite(page);
    await page.getByRole('button', { name: 'Als Berichtsstand freigeben' }).click();
    const d = page.getByTestId('bericht-freigeben');
    const punkte = (await d.getByTestId('bericht-freigeben-voraussetzungen').locator('li').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
    expect(punkte).toEqual([
      'Zeitraum zu Ende — erfüllt',
      'Alle 18 Werte endgültig — erfüllt',
      'Entwurf aktuell (Datenstand 10.11.2026 08:55) — erfüllt',
    ]);
    await expect(d).toContainText('genau diesen Entwurf — Datenstand, Zeitzone Europe/Berlin, Zahlenformat de-DE werden festgehalten.');
    const m = await ohneQuerlauf(page, 'freigeben-375');
    await foto(page, 'freigeben-375', m);

    await page.clock.setFixedTime(AM_10_11_0902);
    await page.getByRole('button', { name: 'Berichtsstand Nr. 1 freigeben' }).click();
    await expect(page.getByTestId('bericht-freigeben')).toHaveCount(0);
    await expect(page.locator('.vp-br-zeile-kopf')).toHaveText(
      'Datenstand 10.11.2026 08:55 (MEZ) · Berichtsstand Nr. 1 · freigegeben 10.11.2026 09:02 von Ines Kaltenbach',
    );
    await expect(page.getByTestId('bericht-pruefsumme')).toBeVisible();
    await expect(page.locator('.vp-br-wahl [role="tab"][aria-selected="true"]')).toHaveText('Nr. 1');
    expect((await aufrufe(page)).freigeben).toEqual(['2026-11-10T07:55:00Z']);
  });

  test('20.10.2026: der Oktober läuft — „Als Berichtsstand freigeben“ ist aus und sagt warum (B4 a)', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&person=IK', 375, AM_20_10);
    await seite(page);
    await expect(page.getByRole('button', { name: 'Als Berichtsstand freigeben' })).toBeDisabled();
    expect(await text(page, 'bericht-freigeben-warum')).toBe(LAEUFT);
    const m = await ohneQuerlauf(page, 'laeuft-375');
    await foto(page, 'laeuft-375', m);
  });
});

test.describe('Revision nötig, Vergleich, Nr. 2 und Verwerfen (§5.3)', () => {
  test('13.11.2026: das Banner, der Vergleich mit drei Abweichungen, „ersetzt Nr. 1“ — Nr. 2 am 16.11.2026 14:20', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&person=IK', 375, AM_13_11);
    await seite(page);
    const banner = page.getByTestId('bericht-revision');
    await expect(banner).toContainText('Revision nötig — Korrektur K-2026-0007');
    await expect(banner).toContainText('Erkannt am 12.11.2026 10:05.');
    await expect(banner).toContainText('Der Berichtsstand Nr. 1 bleibt unverändert.');
    let m = await ohneQuerlauf(page, 'banner-375');
    await foto(page, 'banner-375', m);

    await banner.getByRole('button', { name: 'Entwurf vergleichen' }).click();
    const v = page.getByTestId('bericht-vergleich');
    await expect(v.getByTestId('bericht-abweichung')).toHaveCount(3);
    expect(await text(page, 'bericht-vergleich-anzahl')).toBe('3 Abweichungen · 15 Werte unverändert');
    const erste = ((await v.getByTestId('bericht-abweichung').first().textContent()) ?? '').replace(/\s+/g, ' ');
    expect(erste).toContain('MS-12');
    expect(erste).toMatch(/Nr\. 1 ?6\.100 kWh/u);
    expect(erste).toMatch(/Entwurf ?6\.040 kWh/u);
    expect(erste).toContain('Korrektur K-2026-0007');
    expect(erste).toContain('Ines Kaltenbach (Energiemanager), 12.11.2026 10:05: Zählerablesung 31.10. berichtigt (Ablesefehler 60 kWh)');
    m = await ohneQuerlauf(page, 'vergleich-375');
    await foto(page, 'vergleich-375', m);

    await page.getByRole('button', { name: 'Als Berichtsstand Nr. 2 freigeben' }).click();
    const f = page.getByTestId('bericht-freigeben');
    await expect(f).toContainText('ersetzt Berichtsstand Nr. 1');
    await expect(f).toContainText('Entwurf aktuell (Datenstand 12.11.2026 10:05)');
    m = await ohneQuerlauf(page, 'revision-freigeben-375');
    await foto(page, 'revision-freigeben-375', m);

    await page.clock.setFixedTime(AM_16_11_1420);
    await page.getByRole('button', { name: 'Berichtsstand Nr. 2 freigeben' }).click();
    await expect(page.locator('.vp-br-zeile-kopf')).toHaveText(
      'Datenstand 12.11.2026 10:05 (MEZ) · Berichtsstand Nr. 2 · freigegeben 16.11.2026 14:20 von Ines Kaltenbach',
    );
    await expect(page.getByTestId('bericht-revision')).toHaveCount(0);
    await expect(page.getByTestId('bericht-verlauf')).toContainText('ersetzt durch Nr. 2');
    expect((await aufrufe(page)).freigeben).toEqual(['2026-11-12T09:05:33Z']);
  });

  test('13.11.2026: „Anstoß verwerfen“ — ohne Begründung am Feld abgelehnt, mit Begründung wird der Vermerk „Anstoß verworfen (…)“', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&person=IK', 375, AM_13_11);
    await seite(page);
    await page.getByTestId('bericht-revision').getByRole('button', { name: 'Anstoß verwerfen' }).click();
    const d = page.getByTestId('anstoss-verwerfen');
    await expect(d).toContainText('Der Berichtsstand Nr. 1 bleibt der gültige.');
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Anstoß verwerfen' }).click();
    await expect(d).toContainText('Die Begründung fehlt.');
    await expect(d.getByLabel('Begründung')).toBeFocused();
    await d.getByLabel('Begründung').fill(BEGRUENDUNG);
    const m = await ohneQuerlauf(page, 'verwerfen-375');
    await foto(page, 'verwerfen-375', m);
    await page.locator('[role="dialog"]').getByRole('button', { name: 'Anstoß verwerfen' }).click();
    await expect(page.getByTestId('anstoss-verwerfen')).toHaveCount(0);
    await expect(page.getByTestId('bericht-revision')).toHaveCount(0);
    await expect(page.locator('.vp-br-abzeichen')).toContainText(`Anstoß verworfen (${BEGRUENDUNG})`);
    expect((await aufrufe(page)).verwerfen).toEqual([BEGRUENDUNG]);
  });

  test('Claudia (Leser): kein „Bericht anlegen“, kein „Anstoß verwerfen“, kein Freigeben — vergleichen darf sie', async ({ page }) => {
    await oeffne(page, 'ansicht=berichte&person=CB', 375, AM_13_11);
    await expect(page.getByTestId('bericht-karte')).toHaveCount(1);
    await expect(page.getByTestId('bericht-anlegen-knopf')).toHaveCount(0);
    await page.getByTestId('bericht-karte').click();
    await seite(page);
    const banner = page.getByTestId('bericht-revision');
    await expect(banner.getByRole('button', { name: 'Entwurf vergleichen' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Anstoß verwerfen' })).toHaveCount(0);
    await page.locator('.vp-br-wahl [role="tab"]', { hasText: 'Entwurf' }).click();
    await expect(page.locator('.vp-br-zeile-kopf')).toHaveText('Entwurf · Datenstand 12.11.2026 10:05 (MEZ)');
    await expect(page.getByRole('button', { name: /^Als Berichtsstand/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mit Berichtsstand Nr. 1 vergleichen' })).toBeVisible();
  });

  test('bei 1440 px: Vergleich und Freigabe-Dialog ohne Querlauf', async ({ page }) => {
    await oeffne(page, 'ansicht=bericht&br=BR-2026-0001&person=IK', 1440, AM_13_11);
    await seite(page);
    await page.getByTestId('bericht-revision').getByRole('button', { name: 'Entwurf vergleichen' }).click();
    await expect(page.getByTestId('bericht-abweichung')).toHaveCount(3);
    let m = await ohneQuerlauf(page, 'vergleich-1440');
    await foto(page, 'vergleich-1440', m);
    await page.getByRole('button', { name: 'Als Berichtsstand Nr. 2 freigeben' }).click();
    await expect(page.getByTestId('bericht-freigeben')).toBeVisible();
    m = await ohneQuerlauf(page, 'freigeben-1440');
    await foto(page, 'freigeben-1440', m);
  });
});
