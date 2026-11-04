import { expect as baseExpect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Der Vite-Dev-Server kompiliert den Modulgraphen beim ersten Zugriff kalt — großzügige Frist.
const expect = baseExpect.configure({ timeout: 30_000 });

/**
 * „Gerät zuordnen" an der Bühne `zuordnen-dialog.html`, je Geräteart bei 375 und 1440 px:
 * das Paar „Von Ihrer Box gemeldet / Wird angezeigt als", kein Querlauf, kein Element über
 * dem Dialogrand, keine Konsolenfehler. Mit `ZUORDNEN_DIALOG_BILDER=<Ordner>` legt der Lauf
 * je Fall ein Bild ab.
 */
const BILDER = process.env.ZUORDNEN_DIALOG_BILDER;
const FAELLE = [
  { art: 'verbraucher', angezeigt: 'Verbraucher' },
  { art: 'wallbox', angezeigt: 'Wallbox' },
  { art: 'pv', angezeigt: 'PV-Erzeugung' },
  { art: 'netz', angezeigt: 'Netzanschluss' },
  { art: 'unbekannt', angezeigt: null },
  { art: 'verbraucher', angezeigt: null, wieder: true },
] as const;

// Die Breiten stellt der Fall selbst - ein Projekt genügt.
test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop-chromium', 'Breiten stellt der Fall selbst'));

for (const breite of [375, 1440] as const) {
  for (const fall of FAELLE) {
    const name = `${fall.art}${'wieder' in fall ? '-wieder' : ''}-${breite}`;
    test(`Gerät zuordnen · ${name}`, async ({ page }) => {
      const fehler: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
      page.on('pageerror', (e) => fehler.push(e.message));
      await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
      await page.goto(`/e2e/zuordnen-dialog.html?art=${fall.art}${'wieder' in fall ? '&wieder=1' : ''}`);
      const dialog = page.getByRole('dialog', { name: 'Gerät zuordnen' });
      const karte = dialog.getByRole('region', { name: 'Gemeldetes Gerät' });
      await expect(karte.locator('dt').first()).toHaveText('Von Ihrer Box gemeldet');
      if (fall.angezeigt) {
        await expect(karte.locator('dd').nth(1)).toHaveText(fall.angezeigt);
        // Begriff ÜBER dem Wert, nie daneben geklebt.
        const dt = await karte.locator('dt').nth(1).boundingBox();
        const dd = await karte.locator('dd').nth(1).boundingBox();
        expect(dd!.y).toBeGreaterThan(dt!.y + dt!.height - 1);
      } else {
        await expect(karte.locator('dt')).toHaveCount(1);
      }
      await expect(dialog.getByRole('button', { name: 'wieder' in fall ? 'Wieder verbinden' : 'Zuordnen', exact: true })).toBeVisible();

      const quer = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(quer).toBe(0);
      const ueber = await dialog.evaluate((d) => {
        const rand = d.getBoundingClientRect();
        return Array.from(d.querySelectorAll('*'))
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < rand.left - 0.5 || r.right > rand.right + 0.5); })
          .map((el) => el.className || el.tagName);
      });
      expect(ueber).toEqual([]);
      if (BILDER) {
        mkdirSync(BILDER, { recursive: true });
        await page.screenshot({ path: join(BILDER, `${name}.png`) });
      }
      expect(fehler).toEqual([]);
    });
  }
}
