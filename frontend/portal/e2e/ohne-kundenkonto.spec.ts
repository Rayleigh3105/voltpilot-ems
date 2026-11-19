import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Plattform › Geräte › Updates, Karte „Ohne Kundenkonto" (Konzept vp-update-vor-zuordnung, S2): drei erfundene
 * Boxen - eine bereit, eine ohne Tunnel-Rückmeldung (kein Knopf, Grund), eine mit einem zurückgenommenen Fernlauf
 * in „Braucht dich" - am Telefon (390) und am Rechner (1440), ohne Überlauf und ohne Konsolenfehler.
 *
 * Mit `VP_TUNNEL_UPDATE_S2_BILDER=<Ordner>` legt der Lauf je Breite ein Bildschirmfoto dort ab.
 */
const BREITEN = [390, 1440] as const;
const BILDER = process.env.VP_TUNNEL_UPDATE_S2_BILDER;

function wache(page: Page): string[] {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => m.type() === 'error' && fehler.push(m.text()));
  return fehler;
}

async function keinUeberlauf(page: Page) {
  const ueber = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueber).toBeLessThanOrEqual(1);
}

for (const breite of BREITEN) {
  test.describe(`Ohne Kundenkonto bei ${breite} px`, () => {
    test('zeigt jede Box mit Stand und Grund; „Alle aufspielen" und „Braucht dich"', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop-chromium');
      const fehler = wache(page);
      await page.setViewportSize({ width: breite, height: breite === 390 ? 844 : 900 });
      await page.goto('/e2e/edge-updates.html');

      const karte = page.getByTestId('ohne-kundenkonto');
      await expect(karte).toBeVisible();
      await expect(karte).toContainText('3 Boxen warten auf ihr Kundenkonto');
      await expect(karte).toContainText('edge-cyhchfr');
      await expect(karte).toContainText('edge-mnpqrsb');
      await expect(karte).toContainText('Die Box ist gerade nicht im Tunnel');

      // „Alle n aufspielen" zählt nur die Boxen, deren Vorprüfung durchkommt (zwei von drei).
      const alle = karte.getByTestId('ohne-kundenkonto-alle');
      await expect(alle).toHaveText('Alle 2 aufspielen');

      const braucht = karte.getByTestId('ohne-kundenkonto-braucht-dich');
      await expect(braucht).toContainText('edge-k7m2xq3');
      await expect(braucht).toContainText('zurückgenommen');

      if (BILDER) {
        mkdirSync(BILDER, { recursive: true });
        await page.waitForTimeout(350); // Animationen/Übergänge zuerst zu Ende.
        await karte.screenshot({ path: join(BILDER, `ohne-kundenkonto-${breite}.png`) });
      }

      await keinUeberlauf(page);
      expect(fehler).toEqual([]);
    });

    test('„Aufspielen" je Box legt denselben Auftrag wie die Akte an (S1, keine zweite Logik)', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop-chromium');
      const fehler = wache(page);
      await page.setViewportSize({ width: breite, height: breite === 390 ? 844 : 900 });
      await page.goto('/e2e/edge-updates.html');
      const karte = page.getByTestId('ohne-kundenkonto');
      const zeilen = karte.getByTestId('ohne-kundenkonto-zeile');
      await expect(zeilen.first()).toContainText('edge-cyhchfr');

      await zeilen.first().getByRole('button', { name: 'Auf 2026.11.15 bringen' }).click();
      const aufrufe = () => page.evaluate(() => (window as unknown as
        { __fernlaufAufspielenAufrufe: { ref: string; fassung: string }[] }).__fernlaufAufspielenAufrufe);
      await expect.poll(async () => (await aufrufe()).length).toBeGreaterThan(0);
      expect((await aufrufe())[0]).toEqual({ ref: 'edge-cyhchfr', fassung: 'edge-light-2026.11.15' });

      await keinUeberlauf(page);
      expect(fehler).toEqual([]);
    });
  });
}
