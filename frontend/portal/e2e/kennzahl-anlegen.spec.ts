import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Der Assistent „Kennzahl anlegen“ und „Kopieren“ (UEMS AP-11 IP-14, §5.1, §5.2) auf der Bühne `startansicht` — die
 * ECHTE Welt „Kennzahlen“ mit dem ECHTEN Assistenten; die Cloud ist gestellt aus dem Referenzunternehmen Ahrenberg
 * (`src/test/kennzahlAnlegenFixtures.ts`, Werte K1/K2 aus den Vektoren). Uhr 10.11.2026: Oktober ist die letzte
 * abgeschlossene Periode.
 *
 * GEMESSEN, nicht behauptet: Querlauf von Dokument und Dialog-Körper und jedes Element über dem Rand, bei 375 und 1440 px.
 * GEZÄHLT: `window.__kennzahlAufrufe` — bis „Anlegen“ steht dort keine einzige Anlage, nur Vorschauen (K1, K20). Die
 * Bühne rendert in `React.StrictMode`: eine Vorschau kann doppelt gezählt sein, eine Anlage nie.
 *
 * Seriell: die Fälle teilen den Dev-Server und schreiben dieselben Bilder. Mit `KENNZAHL_ANLEGEN_BILDER=<Ordner>` legt der
 * Lauf (desktop-chromium, 375 px) je Schritt ein Bild und `messung-*.json` ab — die Vorschau für den Captain.
 */
test.describe.configure({ mode: 'serial' });

const BILDER = process.env.KENNZAHL_ANLEGEN_BILDER;
const NOVEMBER = new Date('2026-11-10T08:00:00Z');

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(NOVEMBER);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&${query}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const aufrufe = (page: Page) =>
  page.evaluate(() => {
    const a = (window as unknown as { __kennzahlAufrufe: { vorschau: unknown[]; anlegen: unknown[] } }).__kennzahlAufrufe;
    return { vorschau: a.vorschau.length, anlegen: a.anlegen.length };
  });

/** Querlauf in px — am DOKUMENT und im Dialog-Körper — und was über den Rand steht. */
async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-modal *, .vp-main *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.closest('.vp-bereich-tabs, .vp-kz-balken-rahmen'))
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

async function pruefeUndFotografiere(page: Page, breite: number, name: string, { ganz = true } = {}) {
  await ruhig(page);
  const m = await messe(page, breite);
  expect(m.dokument, `${name} ${breite}: Dokument`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente über dem Rand`).toEqual([]);
  if (!BILDER || breite !== 375 || test.info().project.name !== 'desktop-chromium') return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${name}.png`) });
  // Das ganze Bild: das Fenster so hoch wie der Dialog-Inhalt, damit nichts im Scrollbereich fehlt.
  if (ganz && m.inhaltHoehe && m.sichtHoehe && m.inhaltHoehe > m.sichtHoehe) {
    const vorher = page.viewportSize()!;
    await page.setViewportSize({ width: breite, height: vorher.height + (m.inhaltHoehe - m.sichtHoehe) + 40 });
    await ruhig(page);
    await page.screenshot({ path: join(BILDER, `${name}-ganz.png`) });
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
  test(`${breite} px — KZ-0001 „Stromeinsatz je Stück — Halle 2“ aus der Vorlage: fünf Schritte, Hebel, K13, vor „Anlegen“ nichts gespeichert`, async ({ page }) => {
    await oeffne(page, 'ansicht=kennzahlen&welt=leer&person=IK', breite);
    await expect(page.getByText(/^Es gibt noch keine Kennzahl\. Kennzahlen setzen Messwerte ins Verhältnis/)).toBeVisible();
    await pruefeUndFotografiere(page, breite, 'liste-leer', { ganz: false });

    await page.getByTestId('kennzahl-anlegen-knopf').click();
    const dialog = page.getByRole('dialog', { name: /^(Kennzahl anlegen|Fertig)$/ });
    await expect(dialog.getByText('Eine Vorlage wählen — oder ohne Vorlage')).toBeVisible();
    await expect(dialog.getByRole('radio')).toHaveCount(11); // zehn Vorlagen (AP-17 W11) und „ohne Vorlage“
    await expect(weiter(dialog)).toBeDisabled();
    await pruefeUndFotografiere(page, breite, 's1-vorlage');
    await dialog.getByRole('radio', { name: /^Stromeinsatz je Stück/ }).check();
    await weiter(dialog).click();

    // Schritt 2: MS-12 — und der Hebel, sobald eine zweite Messstelle dazukommt.
    await expect(dialog.getByText('Schritt 2 von 5 · Menge')).toBeVisible();
    const menge = dialog.getByRole('combobox', { name: 'Menge', exact: true });
    await (await listeVon(page, menge)).getByRole('option', { name: /^MS-12 Montage Linie M1/ }).click();
    await page.keyboard.press('Escape');
    await expect(weiter(dialog)).toBeEnabled();
    await pruefeUndFotografiere(page, breite, 's2-menge');
    await (await listeVon(page, menge)).getByRole('option', { name: /^MS-18 Montagehalle Lindach gesamt/ }).click();
    await page.keyboard.press('Escape');
    const hebel = dialog.getByTestId('kennzahl-hebel-gesamtwert');
    await expect(hebel).toContainText('Mehrere Messstellen? Legen Sie zuerst einen Summenwert an');
    await expect(hebel).toContainText('Der Summenwert entsteht an der Anlage Werk Ahrenberg – Halle 2.');
    await expect(weiter(dialog)).toBeDisabled();
    await pruefeUndFotografiere(page, breite, 's2-hebel');

    await hebel.getByRole('button', { name: 'Summenwert anlegen' }).click();
    const gesamtwert = page.getByRole('dialog', { name: 'Summenwert anlegen' });
    await expect(gesamtwert).toBeVisible();
    await expect(page.locator('.vp-modal')).toHaveCount(2);
    await pruefeUndFotografiere(page, breite, 's2-gesamtwert-darueber', { ganz: false });
    await gesamtwert.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(page.locator('.vp-modal')).toHaveCount(1);
    await expect(hebel).toBeVisible();
    await (await listeVon(page, menge)).getByRole('option', { name: /^MS-18 Montagehalle Lindach gesamt/ }).click();
    await page.keyboard.press('Escape');
    await expect(hebel).toHaveCount(0);
    await weiter(dialog).click();

    // Schritt 3: BZ-6 — die Perioden-Prüfung sofort unter der Auswahl; je Tag ist K13.
    await expect(dialog.getByText('Schritt 3 von 5 · Bezugsgröße')).toBeVisible();
    const bezug = dialog.getByRole('combobox', { name: 'Bezugsgröße', exact: true });
    await (await listeVon(page, bezug)).getByRole('option', { name: /^BZ-6 Gutteile Montage Halle 2/ }).click();
    await expect(dialog.getByTestId('kennzahl-periode-ok')).toHaveText('BZ-6 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet');
    await pruefeUndFotografiere(page, breite, 's3-bezugsgroesse');
    await dialog.getByRole('radio', { name: 'Tag', exact: true }).check();
    await expect(
      dialog.getByText('BZ-6 Gutteile Montage Halle 2 führt Monatswerte. Eine Kennzahl je Tag ist damit nicht bildbar — ein Monatswert wird nie auf Tage verteilt.'),
    ).toBeVisible();
    await expect(weiter(dialog)).toBeDisabled();
    await pruefeUndFotografiere(page, breite, 's3-je-tag');
    await dialog.getByRole('radio', { name: 'Monat', exact: true }).check();
    await weiter(dialog).click();

    // Schritt 4: vorgeschlagen und vorbelegt; bis hierher keine Vorschau und keine Anlage.
    await expect(dialog.getByText('Schritt 4 von 5 · Geltungsbereich')).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Geltungsbereich', exact: true })).toContainText('Halle 2');
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Stromeinsatz je Stück — Halle 2');
    await expect(dialog.getByLabel('Verantwortlich', { exact: true })).toHaveValue('Ines Kaltenbach');
    await expect(dialog.getByTestId('kennzahl-rechte')).toContainText('Standort Werk Ahrenberg');
    expect(await aufrufe(page)).toEqual({ vorschau: 0, anlegen: 0 });
    await pruefeUndFotografiere(page, breite, 's4-geltung');
    await weiter(dialog).click();

    // Schritt 5: die letzten drei abgeschlossenen Perioden, read-only.
    const perioden = dialog.getByTestId('kennzahl-vorschau-periode');
    await expect(perioden).toHaveCount(3);
    await expect(perioden.nth(0)).toContainText('Oktober 2026');
    await expect(perioden.nth(0)).toContainText(/0,15\skWh je Stück/);
    await expect(perioden.nth(0)).toContainText('vollständig');
    await expect(perioden.nth(1)).toContainText('September 2026');
    for (const i of [1, 2]) await expect(perioden.nth(i)).toContainText('vor dem Bestehen');
    await expect(dialog.getByText('Nichts wird vor „Anlegen“ gespeichert')).toBeVisible();
    const vorAnlegen = await aufrufe(page);
    expect(vorAnlegen.anlegen).toBe(0);
    expect(vorAnlegen.vorschau).toBeGreaterThan(0);
    await pruefeUndFotografiere(page, breite, 's5-vorschau');

    await dialog.getByRole('button', { name: 'Anlegen', exact: true }).click();
    await expect(dialog.getByTestId('kennzahl-fertig')).toContainText('KZ-0001 angelegt · Fassung 1 gilt seit Beginn');
    expect((await aufrufe(page)).anlegen).toBe(1);
    await pruefeUndFotografiere(page, breite, 's6-fertig', { ganz: false });
    await dialog.getByRole('button', { name: 'Fertig', exact: true }).click();
    await expect(page.getByTestId('kennzahl-karte')).toHaveCount(1);
    await expect(page.getByTestId('kennzahl-karte')).toContainText('KZ-0001');
  });

  test(`${breite} px — Kopieren an KZ-0001 für die Montagehalle Lindach: Form, Name und Zweck übernommen, Eingänge und Verantwortlich neu`, async ({ page }) => {
    // Jonas Wendlinger (Kundenadministrator) kopiert — „Verantwortlich“ ist er, nicht Ines Kaltenbach von der Quelle.
    await oeffne(page, 'ansicht=kennzahl&kz=KZ-0001', breite);
    await expect(page.locator('[data-testid="werte-karte"]')).toBeVisible();
    await pruefeUndFotografiere(page, breite, 'seite-kopieren', { ganz: false });
    await page.getByRole('button', { name: 'Kopieren', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Kennzahl kopieren' });
    await expect(dialog.getByText('Kopie von KZ-0001')).toBeVisible();
    await expect(dialog.getByTestId('kennzahl-kopie-quelle')).toContainText('Stromeinsatz Montage je Stück — Halle 2');
    await pruefeUndFotografiere(page, breite, 'k1-kopie');
    await weiter(dialog).click();

    const menge = dialog.getByRole('combobox', { name: 'Menge', exact: true });
    await (await listeVon(page, menge)).getByRole('option', { name: /^MS-18 Montagehalle Lindach gesamt/ }).click();
    await page.keyboard.press('Escape');
    await weiter(dialog).click();
    const bezug = dialog.getByRole('combobox', { name: 'Bezugsgröße', exact: true });
    await (await listeVon(page, bezug)).getByRole('option', { name: /^BZ-7 Gutteile Montage Lindach/ }).click();
    await expect(dialog.getByTestId('kennzahl-periode-ok')).toHaveText('BZ-7 führt Monatswerte — die Kennzahl wird je Monat und Jahr gebildet');
    await weiter(dialog).click();

    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Stromeinsatz Montage je Stück — Montagehalle Lindach');
    await expect(dialog.getByLabel('Verantwortlich', { exact: true })).toHaveValue('Jonas Wendlinger');
    await expect(dialog.getByTestId('kennzahl-rechte')).toContainText('Standort Werk Lindach');
    await pruefeUndFotografiere(page, breite, 'k4-kopie-geltung');
    await weiter(dialog).click();

    const perioden = dialog.getByTestId('kennzahl-vorschau-periode');
    await expect(perioden).toHaveCount(3);
    await expect(perioden.nth(0)).toContainText(/0,50\skWh je Stück/);
    await expect(perioden.nth(0)).toContainText('ab 15.10.2026');
    await pruefeUndFotografiere(page, breite, 'k5-kopie-vorschau');
    expect((await aufrufe(page)).anlegen).toBe(0);
  });
}
