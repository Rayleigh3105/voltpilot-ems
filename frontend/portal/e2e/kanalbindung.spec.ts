import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
async function start(page: Page, width: number, query = '') {
  await page.clock.setFixedTime(new Date('2026-11-02T06:40:00Z'));
  await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
  await page.goto(`/e2e/kanalbindung.html?${query}`);
  await page.getByText('Messkanal', { exact: true }).click();
  await page.getByRole('button', { name: 'Messkanal binden', exact: true }).click();
}
async function waehle(page: Page, label: string, name: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: false }).click();
}
async function foto(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  if (process.env.KANAL_BILDER) { mkdirSync(process.env.KANAL_BILDER, { recursive: true }); await page.screenshot({ path: join(process.env.KANAL_BILDER, `${name}.png`), fullPage: name.startsWith('regel-') }); }
}
for (const width of [375, 1440]) {
  test(`${width}: Temperatur binden, Regel lesen, beenden und Fokus`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await start(page, width);
    const dialog = page.getByRole('dialog', { name: 'Messkanal binden', exact: true });
    await dialog.getByRole('button', { name: 'Binden', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Messkanal', exact: true })).toBeFocused();
    await waehle(page, 'Messkanal', 'Außenfühler');
    await expect(dialog.getByLabel('Raumtemperatur (°C)')).toHaveValue('20');
    await dialog.getByLabel('Raumtemperatur (°C)').fill('22');
    await dialog.getByLabel('Heizgrenze (°C)').fill('17');
    await foto(page, `temperatur-${width}`);
    if (width === 375) { await dialog.getByRole('combobox', { name: 'Datum', exact: true }).scrollIntoViewIfNeeded(); await foto(page, `zeitraum-${width}`); }
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(e => e.contains(document.activeElement))).toBe(true); }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Messkanal binden', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Messkanal binden', exact: true }).click();
    await waehle(page, 'Messkanal', 'Außenfühler');
    await dialog.getByLabel('Raumtemperatur (°C)').fill('22'); await dialog.getByLabel('Heizgrenze (°C)').fill('17');
    await dialog.getByRole('button', { name: 'Binden', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Gradtage G22/17', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).kanalAufrufe)).toMatchObject([{ raumtemperatur: 22, heizgrenze: 17, von: '2026-11-02T07:40:00+01:00' }]);
    await page.clock.setFixedTime(new Date('2026-12-02T06:40:00Z'));
    await page.getByText('Werte und Fassungen', { exact: true }).click();
    await page.getByText('Fassungen ansehen (1)').click();
    await expect(page.getByText(/Aus Messkanal Außentemperatur · Gradtage G22\/17 · unvollständig · Abdeckung 83,3/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Berichtigen', exact: true })).toHaveCount(0);
    await foto(page, `regel-${width}`);
    await page.getByRole('button', { name: 'Bindung beenden', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Bindung beenden', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Messkanal binden', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
  test(`${width}: Zustandswahl und fehlende Daten`, async ({ page }) => {
    await start(page, width, 'zustand'); await waehle(page, 'Messkanal', 'K-9');
    await waehle(page, 'Zustand', 'Charging'); await foto(page, `zustand-${width}`);
    await page.getByRole('dialog').getByRole('button', { name: 'Binden', exact: true }).click();
    await expect(page.getByText('Zeit im Zustand „Charging“', { exact: true })).toBeVisible();
    await start(page, width, 'ohne-daten'); await waehle(page, 'Messkanal', 'Außenfühler');
    await page.getByRole('dialog').getByRole('button', { name: 'Binden', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('liefert zurzeit keine Daten');
    expect(await page.evaluate(() => (window as any).kanalAufrufe)).toEqual([]);
  });
}
test('Leser sehen Bindungen und Werte ohne Schreibhebel', async ({ page }) => {
  await page.goto('/e2e/kanalbindung.html?person=CB');
  await page.getByText('Messkanal', { exact: true }).click();
  await expect(page.getByText('Es ist kein Messkanal gebunden.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Messkanal binden', exact: true })).toHaveCount(0);
});
