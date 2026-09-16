import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const BILDER = process.env.LADEGRENZE_BILDER;

async function oeffne(page: Page, breite: number, fall: 'gebunden' | 'ungebunden' | 'zuhoch') {
  await page.clock.setFixedTime(new Date('2026-10-20T08:15:30+02:00'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 1000 });
  await page.goto(`/e2e/ladegrenze.html?fall=${fall}`);
  await expect(page.getByRole('heading', { name: 'Ladepark-Rahmen' })).toBeVisible();
  await expect(page.getByText('Netzanschluss wird geprüft …')).toHaveCount(0);
}

async function foto(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: true });
  }
}

for (const breite of [375, 1440]) {
  test(`gebundener Netzanschluss und Ladebudget ${breite}`, async ({ page }) => {
    await oeffne(page, breite, 'gebunden');
    await expect(page.getByText(/Netzanschluss NA-2: 200.*vereinbart/)).toBeVisible();
    await expect(page.getByText(/Ladebudget 53,5/)).toBeVisible();
    await foto(page, `gebunden-${breite}`);
  });

  test(`Übergangswert steht ohne Bindung im Dialog ${breite}`, async ({ page }) => {
    await oeffne(page, breite, 'ungebunden');
    await expect(page.getByText(/Heute ist kein Netzanschluss gebunden/)).toContainText('im Dialog');
    await page.getByLabel('kW', { exact: true }).fill('180');
    await page.getByRole('button', { name: 'Übernehmen', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('Vereinbarte Leistung (kW)')).toBeVisible();
    await foto(page, `ungebunden-dialog-${breite}`);
  });

  test(`220 kW bei 200 kW zeigt den Grund ${breite}`, async ({ page }) => {
    await oeffne(page, breite, 'zuhoch');
    await page.getByLabel('kW', { exact: true }).fill('220');
    await expect(page.getByText('220 kW liegen über 200 kW vereinbarter Leistung — bitte prüfen.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Übernehmen', exact: true })).toBeDisabled();
    await foto(page, `zuhoch-${breite}`);
  });
}
