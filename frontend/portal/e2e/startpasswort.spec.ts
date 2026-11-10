import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const bilder = process.env.STARTPASSWORT_BILDER;

for (const breite of [375, 1440]) {
  test(`N3, Neuvergabe und Plattformweg · ${breite}px`, async ({ page, browserName }) => {
    const fehler: string[] = [];
    page.on('pageerror', e => fehler.push(e.message));
    await page.setViewportSize({ width: breite, height: 1000 });
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } }));
    await page.goto('/e2e/startpasswort.html');
    const ausloeser = page.locator('#root').getByRole('button', { name: 'Benutzer anlegen', exact: true });
    await ausloeser.click();
    let dialog = page.getByRole('dialog', { name: 'Benutzer anlegen', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Bei der ersten Anmeldung');
    await foto('N3-vorher');
    await dialog.getByRole('button', { name: 'Benutzer anlegen', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Benutzer angelegt', exact: true });
    await expect(dialog.getByLabel('Startpasswort', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Startpasswort kopieren' }).click();
    await expect(dialog.getByText('Startpasswort kopiert.', { exact: true })).toBeVisible();
    await foto('N3-passwort');
    const tasten = await dialog.getByRole('button').count();
    for (let i = 0; i < tasten + 2; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(ausloeser).toBeFocused();
    await ausloeser.click();
    await expect(page.getByLabel('Startpasswort', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();

    const neu = page.locator('#root').getByRole('button', { name: 'Startpasswort neu vergeben', exact: true });
    await neu.click();
    dialog = page.getByRole('dialog', { name: 'Startpasswort neu vergeben', exact: true });
    await expect(dialog).toContainText('Das bisherige Passwort wird ersetzt.');
    await foto('N1-neuvergabe');
    await dialog.getByRole('button', { name: 'Startpasswort vergeben', exact: true }).click();
    await expect(dialog.getByLabel('Startpasswort', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(neu).toBeFocused();

    expect(await page.evaluate(() => [Object.values(localStorage), Object.values(sessionStorage)].flat().some(v => v.includes('Beispiel')))).toBe(false);
    expect(fehler).toEqual([]);

    async function foto(name: string) {
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      if (bilder && browserName === 'chromium') {
        mkdirSync(bilder, { recursive: true });
        await page.screenshot({ path: `${bilder}/${name}-${breite}.png`, fullPage: true, animations: 'disabled' });
      }
    }
  });
}
