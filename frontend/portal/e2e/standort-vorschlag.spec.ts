import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/** AP-02 IP-10: sichtbarer A6/A15-Fluss bei 375 und 1440 px. */
const BILDER = process.env.STANDORT_VORSCHLAG_BILDER;

async function oeffne(page: Page, breite: 375 | 1440) {
  await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await page.goto('/e2e/startansicht.html?bild=unternehmen&vorschlag=offen');
  await expect(page.getByText('Noch nicht zugeordnet').first()).toBeVisible();
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `standort-vorschlag-karte-${breite}.png`) });
  }
  await page.getByRole('button', { name: 'Standorte einrichten' }).click();
  await expect(page.getByRole('heading', { name: 'Vorschau: Ihre Anlagen und Standorte' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

for (const breite of [375, 1440] as const) {
  test(`zwei Anlagen werden als ein Standort bestätigt (${breite} px)`, async ({ page }) => {
    await oeffne(page, breite);
    await page.getByRole('button', { name: 'Alle Anlagen zusammenlegen' }).click();
    await page.getByLabel('Name des Standorts *').fill('Werk Ahrenberg');
    await page.getByLabel('Straße und Hausnummer *').fill('Industriestraße 4');
    await page.getByLabel('PLZ').fill('84347');
    await page.getByLabel('Ort *').fill('Pfarrkirchen');
    const dialog = page.getByRole('dialog', { name: 'Standorte einrichten' });
    await expect(dialog.getByText('Werk Ahrenberg – Halle 1', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Werk Ahrenberg – Halle 2', { exact: true })).toBeVisible();
    await expect(page.getByText('Bis Sie bestätigen, ändert sich nichts')).toBeVisible();

    if (BILDER) {
      await dialog.locator('.dbody').evaluate((element) => { element.scrollTop = 0; });
      await page.screenshot({ path: join(BILDER, `standort-vorschlag-vorschau-${breite}.png`) });
    }

    await page.getByRole('button', { name: 'Zuordnung bestätigen' }).click();
    await expect(page.getByText('Noch nicht zugeordnet')).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    if (BILDER) await page.screenshot({ path: join(BILDER, `standort-vorschlag-bestaetigt-${breite}.png`) });
  });
}
