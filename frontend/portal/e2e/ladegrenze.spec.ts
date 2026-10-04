import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Die Ladegrenze (AP-01 IP-13) im Rahmen-Blatt von Steuerung › Laden. Seit dem Nachzug „Steuerung neu“ wohnt die
 * Prüfung gegen den Netzanschluss nicht mehr in der gelöschten `LadeparkRahmenKarte`, sondern im Blatt der echten
 * Seite (Bühne `e2e/ladegrenze.tsx` auf den Steuerungs-Beispieldaten). Geschrieben wird über `PUT /charging-frame`.
 */

const BILDER = process.env.LADEGRENZE_BILDER;

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

async function oeffne(page: Page, breite: number, fall: 'gebunden' | 'ungebunden' | 'zuhoch') {
  await page.clock.setFixedTime(new Date('2026-09-29T11:10:00Z'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 1000 });
  await page.goto(`/e2e/ladegrenze.html?fall=${fall}#/anlage/help-site/laden`);
  await page.locator('.stn').first().waitFor();
  await page.getByRole('button', { name: 'Rahmen', exact: true }).click();
  const blatt = page.getByRole('dialog', { name: 'Netzanschluss und Laden' });
  await expect(blatt).toBeVisible();
  await expect(blatt.getByText('Netzanschluss wird geprüft …')).toHaveCount(0);
  return blatt;
}

async function foto(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `${name}.png`) });
  }
}

for (const breite of [375, 1440]) {
  test(`gebundener Netzanschluss und Ladebudget ${breite}`, async ({ page }) => {
    const blatt = await oeffne(page, breite, 'gebunden');
    await expect(blatt.getByText(/Netzanschluss NA-2: 200.*vereinbart/)).toBeVisible();
    await expect(blatt.getByText(/Grundlast der letzten 7 Tage 96,5.*Ladebudget 53,5/)).toBeVisible();
    await expect(blatt.getByText(/bitte prüfen/)).toHaveCount(0);
    await foto(page, `gebunden-${breite}`);
  });

  test(`Übergangswert steht ohne Bindung im Blatt und geht an /charging-frame ${breite}`, async ({ page }) => {
    const blatt = await oeffne(page, breite, 'ungebunden');
    await expect(blatt.getByText(/Heute ist kein Netzanschluss gebunden/)).toContainText('für den Übergang');
    await blatt.getByRole('button', { name: 'weniger' }).click();
    const feld = blatt.getByLabel('Vereinbarte Leistung (kW)');
    await expect(feld).toBeVisible();
    await blatt.getByRole('button', { name: 'Übernehmen', exact: true }).click();
    await expect(blatt.getByText('Tragen Sie die vereinbarte Leistung ein.')).toBeVisible();
    await expect(feld).toBeFocused();
    await feld.fill('200');
    await foto(page, `ungebunden-blatt-${breite}`);
    await blatt.getByRole('button', { name: 'Übernehmen', exact: true }).click();
    await expect(blatt).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { ladegrenzeGesendet: unknown[] }).ladegrenzeGesendet))
      .toEqual([{ gridLimitKw: 179, vereinbartKw: 200 }]);
  });

  test(`220 kW bei 200 kW zeigt den Grund ${breite}`, async ({ page }) => {
    const blatt = await oeffne(page, breite, 'zuhoch');
    await expect(blatt.getByText('220 kW liegen über 200 kW vereinbarter Leistung — bitte prüfen.')).toBeVisible();
    await blatt.getByRole('button', { name: 'weniger' }).click();
    await expect(blatt.getByText('219 kW liegen über 200 kW vereinbarter Leistung — bitte prüfen.')).toBeVisible();
    await expect(blatt.getByRole('button', { name: 'Übernehmen', exact: true })).toBeDisabled();
    await foto(page, `zuhoch-${breite}`);
  });
}
