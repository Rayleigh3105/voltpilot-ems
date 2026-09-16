import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

for (const width of [375, 1440]) {
  for (const zustand of ['zugeordnet', 'stumm', 'rueckfall']) {
    test(`${zustand}: Rollen im Cockpit bei ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      const fehler: string[] = [];
      page.on('pageerror', e => fehler.push(e.message));
      await page.goto(`/e2e/cockpit-rollen.html?zustand=${zustand}`);
      await expect(page.getByRole('heading', { name: 'Halle 1' })).toBeVisible();
      const rollen = page.locator('.vp-pvrolle');
      if (zustand === 'rueckfall') {
        await expect(rollen).toHaveCount(0);
        await expect(page.locator('svg').getByText('148,6 kW', { exact: true })).toBeVisible();
      } else {
        await expect(rollen).toHaveCount(3);
        for (const rolle of await rollen.all()) {
          const button = rolle.getByRole('button');
          expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          await button.click();
          await expect(button).toHaveAttribute('aria-expanded', 'true');
        }
        if (zustand === 'zugeordnet') {
          await expect(page.locator('.vp-rolle-stand').first()).toHaveText('Stand 10:15 Uhr');
          await expect(page.locator('svg').getByText('213,5 kW', { exact: true })).toBeVisible();
          await expect(page.getByText('Unterzähler Kühlung', { exact: true })).toBeVisible();
        } else {
          await expect(page.getByText('Stand unbekannt', { exact: true })).toHaveCount(3);
          await expect(page.getByText('liefert gerade nicht', { exact: true })).toHaveCount(5);
          await expect(page.locator('svg').getByText('148,6 kW', { exact: true })).toHaveCount(0);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      expect(await page.locator('main').evaluate(el => [...el.querySelectorAll('*')].filter(e => {
        const r = e.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
      }).length)).toBe(0);
      expect(fehler).toEqual([]);
      if (process.env.ROLLEN_BILDER) {
        await mkdir(process.env.ROLLEN_BILDER, { recursive: true });
        await page.screenshot({ path: `${process.env.ROLLEN_BILDER}/${zustand}-${width}.png`, fullPage: true });
      }
    });
  }
}
