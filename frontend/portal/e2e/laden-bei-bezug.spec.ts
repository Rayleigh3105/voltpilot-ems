import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// K8 „Anzeige ehrlich" (h4 §7 B1/B2): Satz statt Haken, Zahlen aus dem 30-s-Mittel.
for (const width of [375, 1440]) {
  for (const stand of ['vorher', 'nachher']) {
    test(`${stand}: Laden bei Bezug im Cockpit bei ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const fehler: string[] = [];
      page.on('pageerror', e => fehler.push(e.message));
      await page.goto(`/e2e/laden-bei-bezug.html?stand=${stand}`);
      await expect(page.getByRole('heading', { name: 'Anlage mit Speicher' })).toBeVisible();
      const svg = page.locator('.vp-hero-flow svg').first();
      if (stand === 'vorher') {
        await expect(svg.getByText('26,2 kW', { exact: true })).toBeVisible();
        await expect(page.locator('.vp-flow-confirm')).toHaveCount(1);
        await expect(page.locator('.vp-hero-hinweis')).toHaveCount(0);
      } else {
        await expect(svg.getByText('19,6 kW', { exact: true })).toBeVisible();
        await expect(svg.getByText('26,2 kW', { exact: true })).toHaveCount(0);
        await expect(page.locator('.vp-flow-confirm')).toHaveCount(0);
        await expect(page.getByRole('status')).toHaveText(
          'Eine Wolke hat die Sonne gerade verdeckt – der Speicher regelt in den nächsten Sekunden nach.');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      expect(await page.locator('main').evaluate(el => [...el.querySelectorAll('*')].filter(e => {
        const r = e.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
      }).length)).toBe(0);
      expect(fehler).toEqual([]);
      if (process.env.K8_BILDER) {
        await mkdir(process.env.K8_BILDER, { recursive: true });
        await page.screenshot({ path: `${process.env.K8_BILDER}/${stand}-${width}.png`, fullPage: true });
      }
    });
  }
}
