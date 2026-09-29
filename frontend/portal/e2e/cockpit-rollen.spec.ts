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
      // Die Aufschlüsselung je Gerät steht im Blatt des jeweiligen Knotens
      // (Konzept „Cockpit als Tagesfilm“), nicht unter dem Fluss.
      await expect(page.locator('.vp-hero-flow .vp-pvrolle')).toHaveCount(0);
      if (zustand === 'rueckfall') {
        await expect(page.locator('.vp-lp').getByText('148,6 kW', { exact: true })).toBeVisible();
        await page.locator('.vp-lp-k-pv').click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await expect(page.getByRole('dialog').locator('.vp-rolle-pv')).toHaveCount(0);
        await page.keyboard.press('Escape');
      } else {
        const gesehen: string[] = [];
        for (const knoten of ['pv', 'load', 'grid']) {
          await page.locator(`.vp-lp-k-${knoten}`).click();
          const blatt = page.getByRole('dialog');
          // Dieselbe Listenform wie „Verbrauch im Detail“ unter dem Fluss, vollständig.
          const liste = blatt.locator('.vp-eb-liste');
          await expect(liste).toHaveCount(1);
          gesehen.push((await liste.textContent()) ?? '');
          await page.keyboard.press('Escape');
          await expect(blatt).toHaveCount(0);
        }
        const alle = gesehen.join(' ');
        if (zustand === 'zugeordnet') {
          expect(alle).toContain('Stand 10:15 Uhr');
          await expect(page.locator('.vp-lp').getByText('213,5 kW', { exact: true })).toBeVisible();
          expect(alle).toContain('Unterzähler Kühlung');
        } else {
          expect(alle.split('Stand unbekannt').length - 1).toBe(3);
          expect(alle.split('liefert gerade nicht').length - 1).toBe(5);
          await expect(page.locator('.vp-lp').getByText('148,6 kW', { exact: true })).toHaveCount(0);
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
