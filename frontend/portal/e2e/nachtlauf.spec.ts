import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Nachts von selbst (Konzept vp-update-vor-zuordnung §11.2, S4) mit erfundenen Boxen: in der Karte „Ohne
 * Kundenkonto" der Schalter („an · nächster Lauf 02:00" mit „Anhalten", angehalten mit „Einschalten"), „heute
 * Nacht" an der Box, die dran ist, und in „Braucht dich" ein zurückgenommener Nachtlauf mit Grund und dem Halt der
 * Automatik; in der Akte „Sonst heute Nacht von selbst" unter dem Knopf und im Verlauf „· Automatik · nachts". Am
 * Telefon (390) und am Rechner (1440), ohne Überlauf und ohne Konsolenfehler; am Telefon steht der Knopf einer
 * Zeile in voller Breite unter dem Tunnel-Status (Review S2: „Tunnel verbunden" brach daneben in zwei Zeilen).
 *
 * Mit `VP_TUNNEL_UPDATE_S4_BILDER=<Ordner>` legt der Lauf je Breite Bildschirmfotos dort ab.
 */
const BREITEN = [390, 1440] as const;
const BILDER = process.env.VP_TUNNEL_UPDATE_S4_BILDER;

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

async function foto(page: Page, ziel: Locator, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  // Erst wenn Übergänge und Animationen zu Ende sind.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.waitForTimeout(350);
  // Kopfzeile und Leiste der Schale (fest oder klebend) liegen beim Rollen über dem Ausschnitt: fürs Foto weg.
  await ziel.evaluate((z) => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const p = getComputedStyle(el).position;
      if ((p === 'fixed' || p === 'sticky') && !el.contains(z)) el.dataset.fotoVersteckt = '1';
    }
  });
  await ziel.screenshot({ path: join(BILDER, name), style: '[data-foto-versteckt] { visibility: hidden !important; }' });
  await page.evaluate(() => document.querySelectorAll<HTMLElement>('[data-foto-versteckt]')
    .forEach((el) => delete el.dataset.fotoVersteckt));
}

for (const breite of BREITEN) {
  test.describe(`Nachts von selbst bei ${breite} px`, () => {
    test('Karte „Ohne Kundenkonto": Schalter, „heute Nacht", „Braucht dich" mit Halt; Anhalten und Einschalten', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop-chromium');
      const fehler = wache(page);
      await page.setViewportSize({ width: breite, height: breite === 390 ? 844 : 900 });
      await page.goto('/e2e/edge-updates.html');

      const karte = page.getByTestId('ohne-kundenkonto');
      const schalter = karte.getByTestId('ohne-kundenkonto-nachtlauf');
      await expect(schalter).toHaveText(/Nachts von selbst: an · nächster Lauf 02:00\s*Anhalten/);
      const zeilen = karte.getByTestId('ohne-kundenkonto-zeile');
      await expect(zeilen.nth(0)).toContainText('edge-cyhchfr');
      await expect(zeilen.nth(0).getByTestId('ohne-kundenkonto-heute-nacht')).toHaveText('heute Nacht');
      await expect(karte.getByTestId('ohne-kundenkonto-heute-nacht')).toHaveCount(1);

      const braucht = karte.getByTestId('ohne-kundenkonto-braucht-dich');
      await expect(braucht).toContainText('Über den Tunnel auf 2026.11.15 · zurückgenommen · Automatik · nachts');
      await expect(braucht.getByTestId('ohne-kundenkonto-braucht-grund')).toHaveText('/health nennt edge-light-2026.11.9');
      await expect(braucht.getByTestId('ohne-kundenkonto-braucht-halt')).toContainText('Die Automatik hat für 2026.11.15 angehalten');

      if (breite === 390) {
        // Knopf in voller Breite UNTER dem Status, „Tunnel verbunden" auf einer Zeile.
        const zeile = zeilen.nth(0);
        const knopf = await zeile.getByTestId('ohne-kundenkonto-aufspielen').boundingBox();
        const status = await zeile.locator('.vp-gu-ok-tunnel').boundingBox();
        const box = await zeile.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          const links = r.left + el.clientLeft + parseFloat(s.paddingLeft);
          return { links, breite: el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) };
        });
        const zeilenHoehe = await zeile.locator('.vp-gu-ok-tunnel').evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
        expect(knopf && status).toBeTruthy();
        expect(knopf!.y).toBeGreaterThanOrEqual(status!.y + status!.height - 1);
        expect(Math.abs(knopf!.width - box.breite)).toBeLessThanOrEqual(1);
        expect(Math.abs(knopf!.x - box.links)).toBeLessThanOrEqual(1);
        expect(status!.height).toBeLessThan(zeilenHoehe * 1.5);
      }

      await keinUeberlauf(page);
      await foto(page, karte, `ohne-kundenkonto-nachts-an-${breite}.png`);

      await schalter.getByRole('button', { name: 'Anhalten' }).click();
      await expect(schalter).toHaveText(/Nachts von selbst: angehalten · es bleibt der Knopf\s*Einschalten/);
      await expect(karte.getByTestId('ohne-kundenkonto-heute-nacht')).toHaveCount(0);
      // Angehalten bleibt nur der Knopf.
      await expect(zeilen.nth(0).getByTestId('ohne-kundenkonto-aufspielen')).toBeEnabled();
      await keinUeberlauf(page);
      await foto(page, karte, `ohne-kundenkonto-nachts-angehalten-${breite}.png`);

      await schalter.getByRole('button', { name: 'Einschalten' }).click();
      await expect(schalter).toContainText('Nachts von selbst: an');
      await expect(karte.getByTestId('ohne-kundenkonto-heute-nacht')).toHaveCount(1);
      expect(fehler).toEqual([]);
    });

    test('Akte: „Sonst heute Nacht von selbst" unter dem Knopf; im Verlauf „Automatik · nachts"', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop-chromium');
      const fehler = wache(page);
      await page.setViewportSize({ width: breite, height: 900 });
      await page.goto('/e2e/geraete-akte.html?szenario=wartet&reiter=software&fernlauf=knopf');
      const karte = page.getByTestId('akte-fernlauf');
      await expect(karte.getByTestId('akte-fernlauf-heute-nacht')).toHaveText('Sonst heute Nacht von selbst');
      const knopf = await karte.getByTestId('akte-fernlauf-knopf').boundingBox();
      const satz = await karte.getByTestId('akte-fernlauf-heute-nacht').boundingBox();
      expect(satz!.y).toBeGreaterThan(knopf!.y + knopf!.height - 1);
      await keinUeberlauf(page);
      await foto(page, karte, `akte-heute-nacht-${breite}.png`);

      // Ohne Tunnel: kein Satz (die Automatik nimmt die Box nicht).
      await page.goto('/e2e/geraete-akte.html?szenario=wartet&reiter=software&fernlauf=gesperrt');
      await expect(page.getByTestId('akte-fernlauf-knopf')).toBeDisabled();
      await expect(page.getByTestId('akte-fernlauf-heute-nacht')).toHaveCount(0);

      await page.goto('/e2e/geraete-akte.html?szenario=wartet&reiter=verlauf&fernlauf=nachts');
      const verlauf = page.getByTestId('akte-verlauf-fernlauf');
      await expect(verlauf).toContainText('Über den Tunnel auf 2026.11.15 · fertig · Automatik · nachts');
      await keinUeberlauf(page);
      await foto(page, page.locator('.vp-geraet-sek', { has: verlauf }), `akte-verlauf-nachts-${breite}.png`);
      expect(fehler).toEqual([]);
    });
  });
}
