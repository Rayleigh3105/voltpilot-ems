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
  if (BILDER) { mkdirSync(BILDER, { recursive: true }); await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: false }); }
}
async function waehle(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
for (const breite of [375, 1440]) {
  test(`${breite}: Eingabe, Validierung und Fokus`, async ({ page }) => {
    await start(page, breite, 'leer');
    await page.getByText('Werte und Fassungen', { exact: true }).click();
    const trigger = page.getByRole('button', { name: 'Wert eingeben', exact: true });
    await trigger.click();
    const d = page.getByRole('dialog', { name: 'Wert eingeben', exact: true });
    await expect(d.getByRole('combobox', { name: 'Periode' })).toContainText('Oktober 2026');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d.getByLabel('Wert (Stück)')).toBeFocused();
    await d.getByLabel('Wert (Stück)').fill('48.200');
    await foto(page, `eingabe-${breite}`);
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); expect(await d.evaluate(e => e.contains(document.activeElement))).toBe(true); }
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d).toHaveCount(0); await expect(trigger).toBeFocused();
    await expect(page.getByText(/48.200 Stück · Fassung 1/)).toBeVisible();
    expect(await page.evaluate(() => (window as any).wertAufrufe)).toMatchObject([{ periode: '2026-10', wert: '48.200' }]);
  });
  test(`${breite}: Berichtigung mit Begründung, Fassungen und Vier-Augen`, async ({ page }) => {
    await start(page, breite);
    await page.getByText('Werte und Fassungen', { exact: true }).click();
    await page.getByRole('button', { name: 'Berichtigen', exact: true }).click();
    const d = page.getByRole('dialog', { name: 'Wert berichtigen', exact: true });
    await d.getByLabel('Wert (Stück)').fill('48200');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d.getByLabel('Begründung')).toBeFocused();
    await d.getByLabel('Begründung').fill('Tippfehler — eine Null fehlte');
    await foto(page, `berichtigung-${breite}`);
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await page.getByText('Fassungen ansehen (2)').click();
    await expect(page.getByText(/Fassung 1 · 4.820 Stück/)).toBeVisible();
    await expect(page.getByText(/Fassung 2 · 48.200 Stück/)).toBeVisible();
    await foto(page, `fassungen-${breite}`);
    await start(page, breite, 'vier'); await page.getByText('Werte und Fassungen', { exact: true }).click();
    await page.getByRole('button', { name: 'Berichtigen', exact: true }).click();
    await d.getByLabel('Wert (Stück)').fill('48.200'); await d.getByLabel('Begründung').fill('Tippfehler — eine Null fehlte');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(page.getByText(/4.820 Stück · Fassung 1/)).toBeVisible();
    await expect(page.getByText(/Vorschlag von Ines/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Berichtigen', exact: true })).toHaveCount(0);
  });
  test(`${breite}: Ablesung am Messstellen-Wirt, Zuordnung und Berichtigung`, async ({ page }) => {
    await start(page, breite, 'ablesung');
    const abs = page.getByRole('region', { name: 'Ablesungen', exact: true });
    await expect(abs).toBeVisible();
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
    expect(await page.evaluate(() => (window as any).wertAufrufe)).toMatchObject([{ kz: 'MS-21', stand: '49.451', zuordnung_monat: '2026-10', zeitpunkt: '2026-11-02T07:40:00+01:00' }]);
    await abs.getByRole('button', { name: 'Berichtigen', exact: true }).last().click();
    const korr = page.getByRole('dialog', { name: 'Ablesung berichtigen', exact: true });
    await waehle(page, 'Zuordnung', 'Keinem Monat zuordnen');
    await korr.getByLabel('Begründung').fill('Die Ablesung gehört nicht zum Oktober.');
    await korr.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(abs.getByRole('status')).toContainText('bis zur Freigabe gilt der bisherige Stand');
  });
  test(`${breite}: ohne Eingaberecht bleiben Werte lesbar`, async ({ page }) => {
    await start(page, breite, 'person=LB');
    await page.getByText('Werte und Fassungen', { exact: true }).click();
    await expect(page.getByText(/4.820 Stück · Fassung 1/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Wert eingeben|Berichtigen/ })).toHaveCount(0);
  });
}
