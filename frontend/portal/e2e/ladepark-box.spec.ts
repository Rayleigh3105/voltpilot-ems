import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const BILDER = process.env.LADEPARK_BOX_BILDER;

for (const breite of [375, 1440]) {
  test(`OCPP-Assistent wählt Box und zeigt ihre Adresse ${breite}`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 1000 });
    await page.goto('/e2e/ladepark-box.html');
    await expect(page.getByText('Bitte wählen Sie die Box für diesen Ladepark.')).toBeVisible();

    await page.getByRole('combobox', { name: 'Box für die Ladepunkte' }).click();
    await page.getByRole('option', { name: /Box Halle 2/ }).click();
    await page.getByLabel('Name der Säule (optional)').fill('Parkplatz Halle 2');
    await expect(page.getByLabel('Kennung')).toHaveValue('parkplatz-halle-2');
    await expect(page.getByText('ws://192.168.10.31:8890/ocpp/parkplatz-halle-2')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
    if (BILDER) {
      mkdirSync(BILDER, { recursive: true });
      await page.screenshot({ path: join(BILDER, `ladepark-box-${breite}.png`), fullPage: true });
    }

    await page.getByRole('button', { name: 'Kennung eintragen' }).click();
    await expect(page.getByText(/lässt diese Kennung ab jetzt herein/)).toBeVisible();
  });
}
