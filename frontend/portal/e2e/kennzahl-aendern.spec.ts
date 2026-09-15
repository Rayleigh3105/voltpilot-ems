import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * „Berechnung ändern ab …“, Versionen, Stammdaten, Archivieren und Löschen an der Kennzahl-Seite (UEMS AP-11 IP-15, §5.4,
 * §5.5, §5.7) auf der Bühne `startansicht` — die ECHTE Welt „Kennzahlen“ mit dem ECHTEN Assistenten im Modus „ändern“;
 * die Cloud ist gestellt aus dem Referenzunternehmen Ahrenberg und den Vektoren (`src/test/kennzahlAendernFixtures.ts`:
 * K17 an KZ-0004; `kennzahlWerteFixtures.ts`: K7 an KZ-0001).
 *
 * Drei Uhren: am 01.04.2027 ist der März abgeschlossen — die Vorschau der Route vergleicht ihn („März 2027: 0,30 statt
 * 0,29“), der Tag 01.03.2027 ist „rückwirkend (31 Tage)“. Am 20.03.2027 steht K17 wörtlich: Fassung 2 seit 01.03.2027
 * „rückwirkend (19 Tage)“, und derselbe Tag noch einmal ist „Ab diesem Tag gilt schon Fassung 2.“. Am 03.12.2026 K7.
 *
 * GEMESSEN, nicht behauptet: Querlauf von Dokument und Dialog-Körper, jedes Element über dem Rand, bei 375 und 1440 px.
 * GEZÄHLT: `window.__kennzahlAufrufe` — bis „Speichern“ keine Fassung, nur Vorschauen.
 *
 * Seriell: die Fälle teilen den Dev-Server und schreiben dieselben Bilder. Mit `KENNZAHL_AENDERN_BILDER=<Ordner>` legt
 * der Lauf (desktop-chromium) die Bilder ab — die Ansicht für den Captain.
 */
test.describe.configure({ mode: 'serial' });

const BILDER = process.env.KENNZAHL_AENDERN_BILDER;
const AM_1_APRIL = new Date('2027-04-01T09:31:00+02:00');
const AM_20_MAERZ = new Date('2027-03-20T11:00:00+01:00');
const DEZEMBER = new Date('2026-12-03T08:00:00Z');
const NB = String.fromCharCode(160);
const K17_BEGRUENDUNG = 'Zähler MS-24 = Spritzguss inkl. Kühlung';

async function oeffne(page: Page, query: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const aufrufe = (page: Page) =>
  page.evaluate(() => {
    const a = (window as unknown as { __kennzahlAufrufe: Record<string, unknown[]> }).__kennzahlAufrufe;
    return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.length])) as Record<string, number>;
  });

/** Querlauf in px — am DOKUMENT und im Dialog-Körper — und was über den Rand steht. */
async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-modal *, .vp-main *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.closest('.vp-bereich-tabs, .vp-kz-balken-rahmen, .vp-picker-panel, .vpd-panel'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll<HTMLElement>('.vp-modal .dbody')].at(-1) ?? null;
    return {
      dokument: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper ? koerper.scrollWidth - koerper.clientWidth : null,
      draussen,
      inhaltHoehe: koerper ? koerper.scrollHeight : null,
      sichtHoehe: koerper ? koerper.clientHeight : null,
    };
  }, breite);
}

async function ruhig(page: Page) {
  if ((await page.locator('.vp-modal').count()) > 0) await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

type Bild = { ganz?: boolean; element?: string; seite?: boolean; auch1440?: boolean };

async function pruefeUndFotografiere(page: Page, breite: number, name: string, bild: Bild = {}) {
  await ruhig(page);
  const m = await messe(page, breite);
  expect(m.dokument, `${name} ${breite}: Dokument`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente über dem Rand`).toEqual([]);
  if (!BILDER || test.info().project.name !== 'desktop-chromium' || (breite !== 375 && !bild.auch1440)) return;
  mkdirSync(BILDER, { recursive: true });
  const datei = join(BILDER, `${name}-${breite}.png`);
  if (bild.element) {
    await page.getByTestId(bild.element).screenshot({ path: datei });
    return;
  }
  if (bild.seite) {
    // Das Bild der ganzen Seite: die feste Leiste am unteren Rand stünde sonst mitten im Bild über einer Karte.
    const ohneLeiste = await page.addStyleTag({ content: '.vp-bottombar { visibility: hidden !important; }' });
    await page.screenshot({ path: datei, fullPage: true });
    await ohneLeiste.evaluate((el) => el.remove());
    return;
  }
  await page.screenshot({ path: datei });
  // Das ganze Bild: das Fenster so hoch wie der Dialog-Inhalt, damit nichts im Scrollbereich fehlt.
  if (bild.ganz !== false && m.inhaltHoehe && m.sichtHoehe && m.inhaltHoehe > m.sichtHoehe) {
    const vorher = page.viewportSize()!;
    await page.setViewportSize({ width: breite, height: vorher.height + (m.inhaltHoehe - m.sichtHoehe) + 40 });
    await ruhig(page);
    await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`) });
    await page.setViewportSize(vorher);
  }
}

/** Die Liste DIESES Felds — eine eben geschlossene blendet noch aus und steht solange im DOM. */
async function listeVon(page: Page, feld: Locator): Promise<Locator> {
  await feld.click();
  const id = await feld.getAttribute('id');
  return id ? page.locator(`[id="${id}-liste"]`) : page.locator('body');
}

const weiter = (dialog: Locator) => dialog.getByRole('button', { name: 'Weiter', exact: true });

for (const breite of [375, 1440]) {
  test(`${breite} px — K17 am 01.04.2027: KZ-0004 ab 01.03.2027 mit MS-24, neu und bisher nebeneinander, vor „Speichern“ nichts gespeichert`, async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0004&welt=k17&person=IK', breite, AM_1_APRIL);
    const berechnung = page.getByTestId('kennzahl-berechnung');
    await expect(berechnung).toContainText('Menge je Bezugsgröße · MS-20 je BZ-1 · Fassung 1 gilt seit Beginn');
    await expect(page.getByTestId('werte-karte')).toContainText(`0,29${NB}kWh je kg`);
    await pruefeUndFotografiere(page, breite, 'k17-seite-vorher', { seite: true });

    await page.getByTestId('berechnung-aendern-knopf').click();
    const dialog = page.getByRole('dialog', { name: /^(Berechnung ändern|Fertig)$/ });
    await expect(dialog.getByText('Schritt 1 von 4 · Gilt ab')).toBeVisible();
    await expect(dialog.getByTestId('kennzahl-heute-gilt')).toHaveText('Heute gilt: Menge je Bezugsgröße · MS-20 je BZ-1 · Fassung 1 gilt seit Beginn');
    await expect(dialog.getByTestId('kennzahl-gilt-ab')).toHaveText('Fassung 2 gilt ab heute — Fassung 1 endet am 31.03.2027.');
    await pruefeUndFotografiere(page, breite, 'k17-s1-heute');
    await dialog.getByRole('combobox', { name: 'Gilt ab', exact: true }).click();
    await page.getByRole('button', { name: 'Voriger Monat' }).click();
    await page.getByRole('gridcell', { name: '1', exact: true }).first().click();
    await expect(dialog.getByTestId('kennzahl-gilt-ab')).toHaveText('Fassung 2 gilt ab 01.03.2027 — Fassung 1 endet am 28.02.2027.rückwirkend (31 Tage)');
    await pruefeUndFotografiere(page, breite, 'k17-s1-rueckwirkend');
    await weiter(dialog).click();

    // Schritt 2: MS-20 ist vorbelegt — MS-24 statt MS-20.
    await expect(dialog.getByText('Schritt 2 von 4 · Menge')).toBeVisible();
    const menge = dialog.getByRole('combobox', { name: 'Menge', exact: true });
    await expect(menge).toContainText('MS-20');
    await (await listeVon(page, menge)).getByRole('option', { name: /^MS-24 Spritzguss inkl\. Kühlung/ }).click();
    await page.keyboard.press('Escape');
    await (await listeVon(page, menge)).getByRole('option', { name: /^MS-20 Prozess Spritzguss gesamt/ }).click();
    await page.keyboard.press('Escape');
    await expect(menge).toContainText('MS-24');
    await expect(weiter(dialog)).toBeEnabled();
    await pruefeUndFotografiere(page, breite, 'k17-s2-menge');
    await weiter(dialog).click();

    // Schritt 3: BZ-1 bleibt vorbelegt, die Prüfung sofort darunter.
    await expect(dialog.getByText('Schritt 3 von 4 · Bezugsgröße')).toBeVisible();
    await expect(dialog.getByTestId('kennzahl-periode-ok')).toHaveText('BZ-1 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet');
    await pruefeUndFotografiere(page, breite, 'k17-s3-bezugsgroesse');
    expect((await aufrufe(page)).vorschau).toBe(0);
    await weiter(dialog).click();

    // Schritt 4: die Route rechnet zweimal — neu und bisher; die Begründung ist Pflicht.
    await expect(dialog.getByText('Schritt 4 von 4 · Vorschau')).toBeVisible();
    await expect(dialog.getByTestId('kennzahl-vergleich-satz')).toHaveText('März 2027: 0,30 statt 0,29');
    await expect(dialog.getByTestId('kennzahl-wirkung')).toHaveText('Ab März 2027 gilt Fassung 2 — Februar 2027 und früher bleiben bei Fassung 1.');
    const speichern = dialog.getByRole('button', { name: 'Speichern', exact: true });
    await expect(speichern).toBeDisabled();
    await dialog.getByLabel('Begründung').fill('Kühlung');
    await expect(dialog.getByText('Noch 3 Zeichen — warum rechnet die Kennzahl ab diesem Tag anders?')).toBeVisible();
    await expect(speichern).toBeDisabled();
    await pruefeUndFotografiere(page, breite, 'k17-s4-begruendung-zu-kurz');
    await dialog.getByLabel('Begründung').fill(K17_BEGRUENDUNG);
    await expect(speichern).toBeEnabled();
    await pruefeUndFotografiere(page, breite, 'k17-s4-vorschau', { auch1440: true });
    const vorher = await aufrufe(page);
    expect(vorher.fassung).toBe(0);
    expect(vorher.vorschau).toBeGreaterThanOrEqual(2);

    await speichern.click();
    const fertig = dialog.getByTestId('kennzahl-fertig');
    await expect(fertig).toContainText('Fassung 2 gilt seit 01.03.2027');
    await expect(fertig).toContainText('rückwirkend (31 Tage)');
    expect((await aufrufe(page)).fassung).toBe(1);
    await pruefeUndFotografiere(page, breite, 'k17-fertig', { ganz: false });
    await dialog.getByRole('button', { name: 'Fertig', exact: true }).click();
    await expect(page.locator('.vp-modal')).toHaveCount(0);

    await expect(berechnung).toContainText('Menge je Bezugsgröße · MS-24 je BZ-1 · Fassung 2 gilt seit 01.03.2027');
    await expect(berechnung).toContainText('rückwirkend (31 Tage)');
    await expect(berechnung.locator('.vp-kz-fassung')).toHaveCount(2);
    await expect(berechnung.locator('.vp-kz-fassung').first()).toContainText(`„${K17_BEGRUENDUNG}“`);
    await pruefeUndFotografiere(page, breite, 'k17-seite-nachher', { element: 'kennzahl-berechnung', auch1440: true });
  });

  test(`${breite} px — K17 am 20.03.2027: „Fassung 2 seit 01.03.2027 · rückwirkend (19 Tage)“; derselbe Tag noch einmal ist „Ab diesem Tag gilt schon Fassung 2.“`, async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0004&welt=k17-fassung2&person=IK', breite, AM_20_MAERZ);
    const berechnung = page.getByTestId('kennzahl-berechnung');
    await expect(berechnung).toContainText('Menge je Bezugsgröße · MS-24 je BZ-1 · Fassung 2 gilt seit 01.03.2027');
    await expect(berechnung).toContainText('rückwirkend (19 Tage)');
    await expect(berechnung.locator('.vp-kz-fassung').nth(1)).toContainText('seit Beginn bis 28.02.2027');
    await expect(page.getByTestId('werte-karte')).toContainText(`0,30${NB}kWh je kg`);
    await pruefeUndFotografiere(page, breite, 'k17-karte', { seite: true, auch1440: true });

    await page.getByTestId('berechnung-aendern-knopf').click();
    const dialog = page.getByRole('dialog', { name: 'Berechnung ändern' });
    await expect(dialog.getByTestId('kennzahl-gilt-ab')).toHaveText('Fassung 3 gilt ab heute — Fassung 2 endet am 19.03.2027.');
    await dialog.getByRole('combobox', { name: 'Gilt ab', exact: true }).click();
    await page.getByRole('gridcell', { name: '1', exact: true }).first().click();
    await expect(dialog.getByText('Ab diesem Tag gilt schon Fassung 2.')).toBeVisible();
    await expect(dialog.getByTestId('kennzahl-gilt-ab')).toHaveCount(0);
    await expect(weiter(dialog)).toBeDisabled();
    await pruefeUndFotografiere(page, breite, 'k17-ueberlappt');
    expect((await aufrufe(page)).vorschau).toBe(0);
  });

  test(`${breite} px — K7 am 03.12.2026: die Versionen an der Kennzahl (WertVersionen) — Version 2 mit K-2026-0007, vorher 0,1488`, async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001', breite, DEZEMBER);
    await expect(page.getByTestId('werte-karte')).toBeVisible();
    await page.getByTestId('verlauf-balken').first().click();
    await expect(page.getByTestId('werte-versionen')).toContainText('2 Versionen');
    await pruefeUndFotografiere(page, breite, 'k7-karte');
    await page.getByTestId('werte-versionen').click();
    const dialog = page.getByTestId('versionen-dialog');
    await expect(dialog.getByTestId('version')).toHaveCount(2);
    await expect(dialog).toContainText(`0,1488${NB}kWh je Stück`);
    await expect(dialog).toContainText(`0,1473${NB}kWh je Stück`);
    await expect(dialog).toContainText('Korrektur K-2026-0007');
    await pruefeUndFotografiere(page, breite, 'k7-versionen', { auch1440: true });
  });

  test(`${breite} px — Stammdaten ändern an KZ-0001: ohne Fassung, der Kopf zeigt den neuen Verantwortlichen`, async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001&person=IK', breite, DEZEMBER);
    await page.getByTestId('stammdaten-aendern-knopf').click();
    const dialog = page.getByRole('dialog', { name: 'Stammdaten ändern' });
    const speichern = dialog.getByRole('button', { name: 'Speichern', exact: true });
    await expect(speichern).toBeDisabled();
    await dialog.getByLabel('Verantwortlich').fill('Peter Hollerbach');
    await expect(speichern).toBeEnabled();
    await pruefeUndFotografiere(page, breite, 'stammdaten');
    await speichern.click();
    await expect(page.locator('.vp-modal')).toHaveCount(0);
    await expect(page.getByText('Gebäude Halle 2 · verantwortlich Peter Hollerbach')).toBeVisible();
    const a = await aufrufe(page);
    expect([a.stammdaten, a.fassung]).toEqual([1, 0]);
  });

  test(`${breite} px — KZ-0001 archivieren: Löschen gesperrt, die Folgen nennen KZ-0003; danach „archiviert“ in der Liste und „Eingang archiviert (KZ-0001)“ an KZ-0003`, async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001&person=IK', breite, DEZEMBER);
    const zyklus = page.getByTestId('kennzahl-lebenszyklus');
    await expect(zyklus).toContainText('KZ-0001 hat Werte — archivieren Sie sie.');
    await expect(zyklus.getByRole('button', { name: 'Kennzahl löschen' })).toHaveCount(0);
    // In die Mitte geholt — sonst verdeckt die feste Leiste am unteren Rand das Bild, nicht die Seite.
    await zyklus.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await pruefeUndFotografiere(page, breite, 'lebenszyklus', { ganz: false });

    await page.getByTestId('archivieren-knopf').click();
    const dialog = page.getByRole('dialog', { name: 'Kennzahl archivieren' });
    await expect(dialog.getByTestId('confirm-consequences')).toContainText(
      'KZ-0003 Stromeinsatz Montage je Stück — Unternehmen liest KZ-0001 und zeigt danach „Eingang archiviert (KZ-0001)“.',
    );
    await pruefeUndFotografiere(page, breite, 'archivieren');
    await dialog.getByRole('button', { name: 'Archivieren', exact: true }).click();
    await expect(page.locator('.vp-modal')).toHaveCount(0);
    await expect(page.getByTestId('kennzahl-archiviert')).toHaveText('Archiviert am 03.12.2026 — die Werte bleiben lesbar, VoltPilot rechnet sie nicht mehr.');
    await expect(page.getByTestId('stammdaten-aendern-knopf')).toHaveCount(0);
    await expect(page.getByTestId('berechnung-aendern-knopf')).toHaveCount(0);
    expect((await aufrufe(page)).archivieren).toBe(1);
    await pruefeUndFotografiere(page, breite, 'archiviert-seite', { seite: true });

    await page.getByRole('button', { name: 'Alle Kennzahlen' }).click();
    const karte = page.getByTestId('kennzahl-karte').filter({ hasText: 'KZ-0001' });
    await expect(karte).toContainText('archiviert');
    await expect(page.locator('[data-testid="kennzahl-zahl"], [data-testid="kennzahl-hinweis"]')).toHaveCount(5);
    await pruefeUndFotografiere(page, breite, 'liste-archiviert', { seite: true });
    await page.getByTestId('kennzahl-karte').filter({ hasText: 'KZ-0003' }).click();
    await expect(page.getByTestId('kennzahl-eingang-archiviert')).toHaveText('Eingang archiviert (KZ-0001)');
    await pruefeUndFotografiere(page, breite, 'eingang-archiviert', { element: 'kennzahl-berechnung' });
  });

  test(`${breite} px — eine Kennzahl ohne einen einzigen Wert löschen: bestätigen, dann zurück zur Liste`, async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen&frisch=1&person=IK', breite, DEZEMBER);
    await page.getByTestId('kennzahl-karte').filter({ hasText: 'KZ-0009' }).click();
    const zyklus = page.getByTestId('kennzahl-lebenszyklus');
    await zyklus.getByRole('button', { name: 'Kennzahl löschen' }).click();
    await expect(zyklus).toContainText('KZ-0009 Stromeinsatz je Stück — Halle 2 verschwindet aus der Liste.');
    await zyklus.getByRole('button', { name: 'Endgültig löschen' }).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await pruefeUndFotografiere(page, breite, 'loeschen', { ganz: false });
    await zyklus.getByRole('button', { name: 'Endgültig löschen' }).click();
    await expect(page.getByTestId('kennzahlen')).toBeVisible();
    await expect(page.getByTestId('kennzahl-karte').filter({ hasText: 'KZ-0009' })).toHaveCount(0);
    expect((await aufrufe(page)).loeschen).toBe(1);
  });
}
