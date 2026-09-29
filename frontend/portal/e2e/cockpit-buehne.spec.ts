import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Die Bühne des Cockpits (Konzept „Cockpit als Tagesfilm“): Leitungsplan,
// Jetzt/Heute, Tagesleiste und Blätter bei 375 und 1440 px.
for (const width of [375, 1440]) {
  for (const betrieb of ['eigenverbrauch', 'markt', 'spitze']) {
    test(`${betrieb}: Bühne bei ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      const fehler: string[] = [];
      page.on('pageerror', (e) => fehler.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
      await page.goto(`/e2e/cockpit-buehne.html?betrieb=${betrieb}`);
      await expect(page.getByRole('group', { name: 'Energiefluss Ihrer Anlage' })).toBeVisible();
      await expect(page.locator('.vp-eb-marke')).toHaveText(/Live/);
      // Live laufen die Punkte, zurückgezogen nicht.
      await expect(page.locator('.vp-lp.is-live')).toHaveCount(1);
      const leiste = page.getByRole('slider', { name: 'Tageszeit' });
      await leiste.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('.vp-eb-marke')).toHaveText('gemessen');
      await expect(page.locator('.vp-lp.is-live')).toHaveCount(0);
      await page.keyboard.press('End');
      await expect(page.locator('.vp-eb-marke')).toHaveText('Plan und Prognose');
      await expect(page.locator('.vp-lp.is-plan')).toHaveCount(1);
      await page.getByRole('button', { name: 'Zurück zu Jetzt' }).click();
      await expect(page.locator('.vp-eb-marke')).toHaveText(/Live/);
      // Heute · kWh
      await page.getByRole('button', { name: 'Heute · kWh' }).click();
      await expect(page.locator('.vp-eb-marke')).toHaveText('Energie · gemessen');
      await expect(page.locator('.vp-lp-lab').first()).toContainText('kWh');
      await page.getByRole('button', { name: 'Jetzt · kW' }).click();
      // Ein Knoten öffnet sein Blatt; Escape schließt und gibt den Fokus zurück.
      const speicher = page.locator('.vp-lp-batt');
      await speicher.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(speicher).toBeFocused();
      // Kein Überlauf, nichts ragt heraus, keine Fehler.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      expect(await page.locator('main').evaluate((el) => [...el.querySelectorAll('*')].filter((e) => {
        const r = e.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
      }).length)).toBe(0);
      expect(fehler).toEqual([]);
      if (process.env.BUEHNE_BILDER) {
        await mkdir(process.env.BUEHNE_BILDER, { recursive: true });
        await page.screenshot({ path: `${process.env.BUEHNE_BILDER}/${betrieb}-${width}.png`, fullPage: true });
      }
    });
  }
}
