import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
const BILDER = process.env.WERTE_BILDER;
async function start(page: Page, breite: number, query = '') {
  await page.clock.setFixedTime(new Date('2026-11-02T06:40:00Z'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 1000 });
  await page.goto(`/e2e/werte-eingabe.html?${query}`);
  await page.evaluate(() => document.fonts.ready);
}
async function foto(page: Page, name: string) {
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  if (BILDER) { mkdirSync(BILDER, { recursive: true }); await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: name.startsWith('fassungen-') }); }
}
async function waehle(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
for (const breite of [375, 1440]) {
  // Konzept Messen m1 §6.8: eingetragen wird auf der Seite der Bezugsgröße - „Wert eintragen“ oben, Berichtigen und
  // Fassungen im Menü ⋯ der Zeile.
  test(`${breite}: Eingabe, Validierung und Fokus`, async ({ page }) => {
    await start(page, breite, 'leer');
    await expect(page.getByTestId('bezugsgroesse-status')).toHaveText('Für Oktober 2026 fehlt der Wert');
    const trigger = page.getByRole('button', { name: 'Wert eintragen', exact: true });
    await trigger.click();
    const d = page.getByRole('dialog', { name: 'Wert eintragen', exact: true });
    await expect(d.getByRole('combobox', { name: 'Periode' })).toContainText('Oktober 2026');
    await expect(d).not.toContainText('Europe/Berlin');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d.getByLabel('Wert (Stück)')).toBeFocused();
    await d.getByLabel('Wert (Stück)').fill('48.200');
    await foto(page, `eingabe-${breite}`);
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); expect(await d.evaluate(e => e.contains(document.activeElement))).toBe(true); }
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d).toHaveCount(0); await expect(trigger).toBeFocused();
    await expect(page.getByTestId('bezugswert-zeile').first()).toContainText(/48\.200\sStück/);
    await expect(page.getByTestId('bezugsgroesse-status')).toHaveText('Werte bis Oktober 2026 eingetragen');
    expect(await page.evaluate(() => (window as any).wertAufrufe)).toMatchObject([{ periode: '2026-10', wert: '48.200' }]);
  });
  test(`${breite}: Berichtigung mit Begründung, Fassungen und Vier-Augen`, async ({ page }) => {
    await start(page, breite);
    const zeile = page.getByTestId('bezugswert-zeile').first();
    const menue = zeile.getByRole('button', { name: 'Aktionen zu Oktober 2026' });
    await menue.click();
    await page.getByRole('menuitem', { name: 'Berichtigen', exact: true }).click();
    const d = page.getByRole('dialog', { name: 'Wert berichtigen', exact: true });
    await expect(d).toContainText('Bisher wirksam: 4.820 Stück');
    await d.getByLabel('Wert (Stück)').fill('48200');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d.getByLabel('Begründung')).toBeFocused();
    await d.getByLabel('Begründung').fill('Tippfehler — eine Null fehlte');
    await foto(page, `berichtigung-${breite}`);
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d).toHaveCount(0); await expect(menue).toBeFocused();
    await menue.click();
    await page.getByRole('menuitem', { name: 'Fassungen ansehen (2)' }).click();
    await expect(page.getByText(/Fassung 1 · 4\.820\sStück/)).toBeVisible();
    await expect(page.getByText(/Fassung 2 · 48\.200\sStück/)).toBeVisible();
    await foto(page, `fassungen-${breite}`);
    await start(page, breite, 'vier');
    await menue.click();
    await page.getByRole('menuitem', { name: 'Berichtigen', exact: true }).click();
    await d.getByLabel('Wert (Stück)').fill('48.200'); await d.getByLabel('Begründung').fill('Tippfehler — eine Null fehlte');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(zeile).toContainText(/4\.820\sStück/);
    await expect(zeile).toContainText(/Vorschlag von Ines/);
    await menue.click();
    await expect(page.getByRole('menuitem', { name: 'Berichtigen', exact: true })).toHaveCount(0);
  });
  test(`${breite}: Ablesung am Messstellen-Wirt, Zuordnung und Berichtigung`, async ({ page }) => {
    await start(page, breite, 'ablesung');
    const abs = page.getByRole('region', { name: 'Ablesungen', exact: true });
    await expect(abs).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).wertAbfragen as number)).toBeGreaterThan(0);
    const vorherGelesen = await page.evaluate(() => (window as any).wertAbfragen as number);
    const trigger = abs.getByRole('button', { name: 'Ablesung eintragen', exact: true });
    await trigger.click();
    const d = page.getByRole('dialog', { name: 'Ablesung eintragen', exact: true });
    await expect(d).toContainText('Europe/Berlin · MEZ');
    await expect(d).toContainText('95,9 %');
    await d.getByLabel('Zählerstand (m³)').fill('49.451');
    await foto(page, `ablesung-${breite}`);
    await d.getByRole('combobox', { name: 'Datum', exact: true }).click();
    await page.keyboard.press('Escape'); await expect(d).toBeVisible();
    await expect(d.getByLabel('Zählerstand (m³)')).toHaveValue('49.451');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d).toHaveCount(0); await expect(trigger).toBeFocused();
    await expect(abs.getByRole('status')).toContainText('1\u00a0240 m³');
    await expect.poll(() => page.evaluate(() => (window as any).wertAbfragen as number)).toBeGreaterThan(vorherGelesen);
    expect(await page.evaluate(() => (window as any).wertAufrufe)).toMatchObject([{ kz: 'MS-21', stand: '49.451', zuordnung_monat: '2026-10', zeitpunkt: '2026-11-02T07:40:00+01:00' }]);
    await abs.getByRole('button', { name: 'Berichtigen', exact: true }).last().click();
    const korr = page.getByRole('dialog', { name: 'Ablesung berichtigen', exact: true });
    await waehle(page, 'Zuordnung', 'Keinem Monat zuordnen');
    await korr.getByLabel('Begründung').fill('Die Ablesung gehört nicht zum Oktober.');
    await korr.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(abs.getByRole('status')).toContainText('bis zur Freigabe gilt der bisherige Stand');
  });
  test(`${breite}: ohne Eingaberecht bleiben Werte lesbar`, async ({ page }) => {
    await start(page, breite, 'person=CB');
    await expect(page.getByTestId('bezugswert-zeile').first()).toContainText(/4\.820\sStück/);
    await expect(page.getByRole('button', { name: 'Wert eintragen', exact: true })).toHaveCount(0);
    await page.getByTestId('bezugswert-zeile').first().getByRole('button', { name: 'Aktionen zu Oktober 2026' }).click();
    await expect(page.getByRole('menuitem', { name: 'Berichtigen', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Fassungen ansehen (1)' })).toBeVisible();
  });
}
for (const breite of [375, 1440]) {
  test(`${breite}: doppelte Stunde wird gewählt, fehlende Stunde und lange Zuordnung werden nicht geraten`, async ({ page }) => {
    await start(page, breite, 'ablesung');
    await page.clock.setFixedTime(new Date('2026-10-26T10:00:00Z'));
    await page.getByRole('button', { name: 'Ablesung eintragen', exact: true }).click();
    const d = page.getByRole('dialog', { name: 'Ablesung eintragen', exact: true });
    await d.getByRole('combobox', { name: 'Datum', exact: true }).click();
    await page.locator('[data-iso="2026-10-25"]:not(.is-rand)').click();
    await d.getByRole('combobox', { name: 'Uhrzeit', exact: true }).fill('02:30');
    await d.getByRole('combobox', { name: 'Uhrzeit', exact: true }).press('Tab');
    await d.getByLabel('Zählerstand (m³)').fill('49.451');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    expect(await page.evaluate(() => (window as any).wertAufrufe)).toEqual([]);
    await waehle(page, 'Welche Stunde?', 'MEZ (UTC+01:00)');
    await foto(page, `zeitpunkt-${breite}`);
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).wertAufrufe)).toMatchObject([{ zeitpunkt: '2026-10-25T02:30:00+01:00' }]);
    await start(page, breite, 'ablesung');
    await page.clock.setFixedTime(new Date('2027-03-28T10:00:00Z'));
    await page.getByRole('button', { name: 'Ablesung eintragen', exact: true }).click();
    await d.getByRole('combobox', { name: 'Uhrzeit', exact: true }).fill('02:30');
    await d.getByRole('combobox', { name: 'Uhrzeit', exact: true }).press('Tab');
    await d.getByLabel('Zählerstand (m³)').fill('49.451');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d.getByRole('alert')).toContainText('gibt es an diesem Tag nicht');
    expect(await page.evaluate(() => (window as any).wertAufrufe)).toEqual([]);
    await d.getByRole('combobox', { name: 'Uhrzeit', exact: true }).fill('03:30');
    await d.getByRole('combobox', { name: 'Uhrzeit', exact: true }).press('Tab');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d).toContainText('drei oder mehr Monate');
    expect(await page.evaluate(() => (window as any).wertAufrufe)).toEqual([]);
    await waehle(page, 'Zuordnung', 'Keinem Monat zuordnen');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).wertAufrufe)).toMatchObject([{ zuordnung_monat: null }]);
  });
}
