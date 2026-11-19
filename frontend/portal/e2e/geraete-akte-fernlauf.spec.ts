import { expect, test, type Page } from '@playwright/test';

/**
 * Fernlauf durch den Wartungstunnel (Konzept vp-update-vor-zuordnung S1): die Akte einer erfundenen Box ohne
 * Kundenkonto, Reiter „Software" mit „Linie und Stand" und „Durch den Tunnel aufspielen" - Knopf mit Haken,
 * Bestätigung, Schrittleiste, Ergebnis - am Telefon (390) und am Rechner (1440), ohne Überlauf und ohne
 * Konsolenfehler.
 */
const BREITEN = [390, 1440] as const;

function wache(page: Page): string[] {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => m.type() === 'error' && fehler.push(m.text()));
  return fehler;
}

async function oeffne(page: Page, breite: number, fernlauf: string, reiter = 'software') {
  await page.setViewportSize({ width: breite, height: 900 });
  await page.goto(`/e2e/geraete-akte.html?szenario=wartet&reiter=${reiter}&fernlauf=${fernlauf}`);
}

async function keinUeberlauf(page: Page) {
  const ueber = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueber).toBeLessThanOrEqual(1);
}

for (const breite of BREITEN) {
  test.describe(`Fernlauf bei ${breite} px`, () => {
    test('Linie und Stand nennt die laufende Fassung; der Knopf öffnet die Bestätigung und erteilt den Auftrag', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop-chromium');
      const fehler = wache(page);
      await oeffne(page, breite, 'knopf');
      const stand = page.getByTestId('akte-fernlauf-stand');
      await expect(stand).toContainText('Läuft');
      await expect(stand).toContainText('2026.11.5');
      await expect(stand).toContainText('gerade nach ihrem Zertifikat');
      await expect(stand).toContainText('2026.11.15');
      const karte = page.getByTestId('akte-fernlauf');
      await expect(karte).toContainText('Wie in der Werkstatt. Etwa 5 Min., startet einmal neu.');
      for (const h of ['Tunnel verbunden', 'Fragt nach Schlüsseln', 'Kein Kundenkonto']) await expect(karte).toContainText(h);
      await expect(page.getByRole('button', { name: 'Aktualisieren' })).toBeVisible();
      await keinUeberlauf(page);

      await page.getByTestId('akte-fernlauf-knopf').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('edge-k7m2xq3 von 2026.11.5 auf 2026.11.15 bringen?');
      await expect(dialog).toContainText('Der Werkstatt-Dienst bekommt ein Fenster für 30 Min. Die Box startet einmal neu.');
      await dialog.getByRole('button', { name: 'Aufspielen' }).click();
      await expect(page.getByTestId('akte-fernlauf-laeuft')).toContainText('Wartet auf den Werkstatt-Dienst');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await keinUeberlauf(page);
      expect(fehler).toEqual([]);
    });

    test('ohne Tunnel bleibt der Knopf aus und nennt den Grund', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop-chromium');
      await oeffne(page, breite, 'gesperrt');
      await expect(page.getByTestId('akte-fernlauf-knopf')).toBeDisabled();
      await expect(page.getByTestId('akte-fernlauf-grund')).toContainText('nicht im Tunnel');
      await keinUeberlauf(page);
    });

    test('läuft: Schrittleiste mit dem laufenden Schritt', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop-chromium');
      await oeffne(page, breite, 'laeuft');
      await expect(page.getByTestId('akte-fernlauf-laeuft')).toContainText('Programm neu starten');
      await expect(page.locator('.vp-fl-punkt.vp-fl-erledigt')).toHaveCount(3);
      await expect(page.locator('.vp-fl-punkt[aria-current="step"]')).toHaveAttribute('aria-label', 'Neustart: läuft');
      await keinUeberlauf(page);
    });

    test('zurückgenommen: Grund, „Noch einmal", „Fernwartung öffnen" und Belege', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop-chromium');
      await oeffne(page, breite, 'zurueck');
      const e = page.getByTestId('akte-fernlauf-ergebnis');
      await expect(e).toContainText('Zurück auf 2026.11.5');
      await expect(e).toContainText('edge-light-2026.11.14');
      await expect(page.getByTestId('akte-fernlauf-knopf')).toHaveText('Noch einmal');
      await expect(page.getByRole('button', { name: 'Fernwartung öffnen' }).last()).toBeVisible();
      await page.getByRole('button', { name: 'Belege' }).click();
      await expect(page.locator('.vp-fl-belege')).toContainText('Bisherige Fassung zurückspielen');
      await keinUeberlauf(page);
    });

    test('fertig: neue Fassung läuft, kein Knopf; der Verlauf nennt den Fernlauf', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop-chromium');
      await oeffne(page, breite, 'fertig');
      await expect(page.getByTestId('akte-fernlauf-ergebnis')).toContainText('2026.11.15 läuft');
      await expect(page.getByTestId('akte-fernlauf-knopf')).toHaveCount(0);
      await oeffne(page, breite, 'fertig', 'verlauf');
      await expect(page.getByTestId('akte-verlauf-fernlauf')).toContainText('Über den Tunnel auf 2026.11.15 · fertig · Alex Beispiel');
      await keinUeberlauf(page);
    });

    test('S3 §4.7: eine wartende Docker-Box sagt einen ehrlichen Satz statt des Knopfs - kein Wartungstunnel', async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop-chromium');
      const fehler = wache(page);
      await oeffne(page, breite, 'docker');
      await expect(page.getByRole('heading', { name: 'Docker-Box' })).toBeVisible();
      await expect(page.getByText(/Holt beim Verbinden die neueste Fassung/)).toBeVisible();
      await expect(page.getByTestId('akte-fernlauf-knopf')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Noch nicht verbunden' })).toHaveCount(0);
      await keinUeberlauf(page);
      expect(fehler).toEqual([]);
      if (process.env.WEG_BILDER) {
        await page.screenshot({ path: `${process.env.WEG_BILDER}/akte-docker-box-${breite}.png`, animations: 'disabled' });
      }
    });
  });
}
