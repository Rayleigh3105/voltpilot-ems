import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * PFC200 Stufe 4 „Wünschen“ auf der Bühne `e2e/anlagensteuerung.html?koppel=1`: der Abschnitt „Stellplätze“ unter
 * Steuerung › Geräte und auf der Geräteseite der Steuerung, je Stellplatz Wunsch der Box, Quittung der Steuerung und
 * wirksam getrennt; der Dialog „Schalt-Test und Freigabe“ prüft den Testwert gegen das Band und zeigt die Quittung
 * getrennt von der Wirkung. Bei 375 und 1440 px ohne Querlauf und ohne Fehler in der Konsole.
 */
const BREITEN = [375, 1440] as const;

async function oeffne(page: Page, breite: number, frage: string) {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  const fehler: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  await page.goto(`/e2e/anlagensteuerung.html?${frage}`);
  return fehler;
}

async function ohneQuerlauf(page: Page, breite: number, wurzel: string) {
  const m = await page.evaluate(([b, w]) => ({
    seite: document.documentElement.scrollWidth - window.innerWidth,
    draussen: [...document.querySelectorAll(`${w} *`)]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > (b as number) + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`),
  }), [breite, wurzel] as const);
  expect(m.seite).toBe(0);
  expect(m.draussen).toEqual([]);
}

/**
 * Eine Aufnahme des Abschnitts mit 8 px Rand, aus der ganzen Seite bei Scroll 0: ein Element-Bild schnitte den Rand
 * der Karten ab, und beim Scrollen läge die klebende Kopfzeile der Bühne über dem Abschnitt.
 */
async function aufnahme(page: Page, ziel: Locator, pfad: string) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const r = await ziel.evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x + window.scrollX, y: b.y + window.scrollY, w: b.width, h: b.height, seite: document.documentElement.clientWidth };
  });
  const x = Math.max(0, r.x - 8);
  await page.screenshot({
    path: pfad, fullPage: true, clip: { x, y: Math.max(0, r.y - 8), width: Math.min(r.w + 16, r.seite - x), height: r.h + 16 },
  });
}

for (const breite of BREITEN) {
  test(`Steuerung › Geräte: Stellplätze mit drei getrennten Zeilen (${breite} px)`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium');
    const fehler = await oeffne(page, breite, 'fall=buettner&flaeche=steuerung&koppel=1');
    const abschnitt = page.getByTestId('koppel-stellplaetze');
    await expect(abschnitt.getByRole('heading', { name: 'Stellplätze' })).toBeVisible();
    await expect(abschnitt.getByTestId('koppel-kopf')).toHaveText('Die Steuerung nimmt Wünsche der Box an.');
    const plaetze = abschnitt.getByTestId('koppel-stellplatz');
    await expect(plaetze).toHaveCount(3);
    await expect(plaetze.nth(0)).toContainText(/Wunsch der Box\s*159,0\s?kW · Fahrplan/);
    await expect(plaetze.nth(0)).toContainText(/Quittung der Steuerung\s*angenommen/);
    await expect(plaetze.nth(1)).toContainText('Lampe am Gerät');
    await expect(plaetze.nth(2)).toContainText('nicht bereit: Wartung');
    await ohneQuerlauf(page, breite, '.stn');
    // Derselbe Knopf des Designsystems wie auf der Geräteseite - die Fläche vererbt ihm nicht ihre Schrift.
    await expect(plaetze.nth(0).getByRole('button', { name: 'Schalt-Test und Freigabe' })).toHaveCSS('font-weight', '700');
    await aufnahme(page, abschnitt, `e2e/shots/stellplaetze/steuerung-${breite}.png`);

    // Schalt-Test: ein Wert außerhalb des Bands bleibt mit Fehler und Fokus im Feld.
    await plaetze.nth(2).getByRole('button', { name: 'Schalt-Test und Freigabe' }).click();
    const dialog = page.getByRole('dialog', { name: 'Stellplatz 3' });
    await expect(dialog).toBeVisible();
    const feld = dialog.getByLabel(/^Testwert in kW/);
    await feld.fill('80');
    await dialog.getByRole('button', { name: 'Schalt-Test starten' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(/Der Testwert muss zwischen −50,0 und 50,0\s?kW liegen\./);
    await expect(feld).toBeFocused();
    await feld.fill('−12,5');
    await dialog.getByRole('button', { name: 'Schalt-Test starten' }).click();
    const ergebnis = dialog.getByTestId('koppel-test-ergebnis');
    await expect(ergebnis).toContainText('Die Steuerung hat den Testwunsch angenommen.');
    await expect(ergebnis).toContainText(/Wirksam laut Steuerung\s*entlädt 12,5\s?kW/);
    await expect(ergebnis).toContainText('Ob die Anlage dem Testwert folgt, zeigt die Quittung nicht.');
    await ohneQuerlauf(page, breite, '.vp-modal');
    await dialog.screenshot({ path: `e2e/shots/stellplaetze/dialog-${breite}.png` });

    // Freigabe erst mit dem Haken, dann mit Rückfrage; danach steht der Stellplatz als freigegeben da.
    const haken = dialog.getByRole('checkbox', { name: 'Ich habe die Wirkung an der Anlage gesehen.' });
    await expect(haken).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Freigeben' })).toBeDisabled();
    await haken.check();
    await dialog.getByRole('button', { name: 'Freigeben' }).click();
    const frage = page.getByRole('dialog', { name: 'Stellplatz 3 freigeben?' });
    await expect(frage).toContainText('Die Steuerung entscheidet weiter selbst');
    await ohneQuerlauf(page, breite, '.vp-modal');
    await frage.getByRole('button', { name: 'Freigeben' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Schalt-Test und Freigabe' }).nth(2)).toBeFocused();
    // Die Antwort der Freigabe ist das frische Koppelbild: Stellplatz 3 steht als freigegeben, der Satz nennt zwei.
    await expect(plaetze.nth(2)).toContainText('freigegeben');
    await expect(page.getByText(/VoltPilot schickt der Steuerung Wünsche an 2 freigegebenen Stellplätzen/)).toBeVisible();
    expect(fehler).toEqual([]);
  });

  test(`Geräteseite der Steuerung: Stellplätze in der Karte „Gerät“ (${breite} px)`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium');
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=geraet&koppel=1');
    // Die Karte „Gerät“ steht unter „Technik & Diagnose“ - am Telefon zugeklappt.
    const sektion = page.getByTestId('baustein-details');
    await expect(sektion).toBeAttached();
    if (!(await sektion.evaluate((el) => (el as HTMLDetailsElement).open))) await sektion.locator(':scope > summary').click();
    const abschnitt = sektion.getByTestId('koppel-stellplaetze');
    await expect(abschnitt.getByRole('heading', { name: 'Stellplätze', level: 4 })).toBeVisible();
    await expect(abschnitt.getByTestId('koppel-stellplatz')).toHaveCount(3);
    await ohneQuerlauf(page, breite, '.vp-main');
    await expect(abschnitt.getByRole('button', { name: 'Schalt-Test und Freigabe' }).first()).toHaveCSS('font-weight', '700');
    await aufnahme(page, abschnitt, `e2e/shots/stellplaetze/geraet-${breite}.png`);
    expect(fehler).toEqual([]);
  });
}
