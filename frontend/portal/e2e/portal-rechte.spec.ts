import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const BILDER = process.env.RECHTE_BILDER;
const ST2 = '5a1d0000-0000-4000-8000-000000000002';
for (const breite of [375, 1440]) {
  for (const [bild, person] of [['R1', 'MD'], ['T1', 'CB'], ['T3', 'PH']] as const) {
    test(`${bild} · ${person} · ${breite}px`, async ({ page }) => {
      const fehler: string[] = [];
      page.on('pageerror', e => fehler.push(e.message));
      await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
      await page.setViewportSize({ width: breite, height: 1000 });
      await page.goto(`/e2e/startansicht.html?bild=unternehmen&rechte=1&person=${person}${bild === 'T3' ? '&messen=bestand' : ''}`);
      // R1 landet auf der Steuerung - ein nachgeladenes Stück, das der
      // Entwicklungsserver nach `load` noch Modul für Modul ausliefert (warm
      // 1–11 s, kalt über 60 s gemessen). Erst sein Ende abwarten, dann gelten
      // die strengen 5 s der Zusicherungen - wie in den Geschwister-Specs der Bühne.
      await page.waitForLoadState('networkidle');
      if (bild === 'R1') {
        await expect(page.getByRole('button', { name: 'Automatik pausieren' })).toBeVisible();
        await expect(page.getByRole('button', { name: /Speicher: eingreifen/ })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Freigeben', exact: true })).toHaveCount(0);
      } else if (bild === 'T1') {
        await expect(page.getByText('Teilansicht: Werk Ahrenberg, Werk Lindach (2 von 3 Standorten)', { exact: true })).toBeVisible();
        await expect(page.locator('body')).not.toContainText('Werk Nord');
        await expect(page.getByRole('button', { name: 'Anlage anlegen', exact: true })).toHaveCount(0);
      } else {
        await expect(page).toHaveURL(new RegExp(`#/standort/${ST2}$`));
        await expect(page.locator('body')).not.toContainText('2 Standorte · 3 Anlagen');
        await expect(page.getByRole('heading', { name: 'Werk Lindach ST-2', exact: true })).toBeVisible();
        await expect(page.locator('body')).toContainText('Jonas Wendlinger');
      }
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      expect(fehler).toEqual([]);
      if (BILDER) {
        mkdirSync(BILDER, { recursive: true });
        await page.screenshot({ path: `${BILDER}/${bild}-${breite}.png`, fullPage: true });
      }
    });
  }
}

test('N7 → L3 · Zugriff beendet verwirft die alte Seite und lädt die neue Startansicht', async ({ page }) => {
  await page.goto('/e2e/startansicht.html?bild=unternehmen&rechte=1&person=PH');
  await expect(page).toHaveURL(new RegExp(`#/standort/${ST2}$`));
  await page.evaluate(() => (window as unknown as { __beendeZugriff(): void }).__beendeZugriff());
  await expect(page.getByRole('alert')).toContainText('Zugriff beendet');
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toBeVisible();
  await expect(page.locator('body')).toContainText('Ihr Kundenadministrator Jonas Wendlinger kann das ändern.');
  await expect(page.getByRole('button', { name: 'Anlage anlegen', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/#\/uebersicht$/);
});
