import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS EZ-10 „Steuerung, Anlage, Messwerte“ bei 375 und 1440 px auf der Bühne `e2e/anlagensteuerung.html`:
 * die Karte in Steuerung › Geräte (nur messen), die Geräteseite der Anlagensteuerung, „Strom & Geld“ und der
 * Ast im Verlauf - mit den fiktiven Anlagen Gore (PV) und Büttner (BHKW). Kein Querlauf der Seite oder eines
 * Elements, keine Fehler in der Konsole - GEMESSEN, nicht behauptet.
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

async function ohneQuerlauf(page: Page, breite: number) {
  const m = await page.evaluate((b) => ({
    seite: document.documentElement.scrollWidth - window.innerWidth,
    draussen: [...document.querySelectorAll('.vp-main *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.closest('.vp-rahmen-chips, .vp-verlauf-chart'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`),
  }), breite);
  expect(m.seite).toBe(0);
  expect(m.draussen).toEqual([]);
}

for (const breite of BREITEN) {
  test(`Steuerung › Geräte: wer steuert, je Motor Soll, Ist, folgt, Grund (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=buettner&flaeche=steuerung');
    await expect(page.getByText('Gesteuert wird sie vom Netzbetreiber N-ERGIE Netz GmbH und vom Direktvermarkter WVV.', { exact: false })).toBeVisible();
    const motoren = page.getByTestId('erz-einheit');
    await expect(motoren).toHaveCount(2);
    await expect(motoren.nth(0)).toContainText('folgt');
    await expect(motoren.nth(1)).toContainText('nicht bereit für den Direktvermarkter: Wartung, Gasspeicher leer');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Geräteseite: die Anlagensteuerung mit ihren Einheiten (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=geraet');
    await expect(page.getByRole('heading', { name: 'Anlagensteuerung Gore' }).first()).toBeVisible();
    await expect(page.getByText('Die Anlage erzeugt gerade 158,9', { exact: false })).toBeVisible();
    const sektion = page.getByTestId('baustein-details');
    if (!(await sektion.evaluate((el) => (el as HTMLDetailsElement).open))) await sektion.locator(':scope > summary').click();
    const einheiten = sektion.getByTestId('geraet-einheiten');
    await expect(einheiten).toContainText('WR Dach Nord');
    await expect(einheiten).toContainText('läuft begrenzt');
    await expect(sektion.getByText('Energiekarten')).toHaveCount(0);
    await expect(sektion.getByTestId('geraet-anlagensteuerung')).toContainText('2610 · Oktober 2026');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Strom & Geld: Netzbetreiber, Direktvermarkter, Einspeisemanagement, Einheiten (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=buettner&flaeche=einstellungen');
    const geld = page.locator('#technik-geld');
    await expect(geld.getByRole('button', { name: /^Direktvermarkter/ })).toContainText('WVV · über Relais und 4–20 mA');
    await expect(geld.getByRole('button', { name: /^Einspeisemanagement/ })).toContainText('Stufen');
    await expect(geld.getByRole('button', { name: /^Motor 1/ })).toContainText('MaStR-Nummer nicht erfasst');
    await ohneQuerlauf(page, breite);
    await geld.getByRole('button', { name: /^Direktvermarkter/ }).click();
    await expect(page.getByRole('dialog').getByLabel('Direktvermarkter')).toHaveValue('WVV');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Verlauf › Messwerte: der Ast der Anlagensteuerung (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=verlauf');
    await expect(page.getByText('WR Dach Nord · Ist').first()).toBeAttached();
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });
}
