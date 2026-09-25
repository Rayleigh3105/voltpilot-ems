import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/**
 * **„Preise im Zeitraum" und „So verdient Ihre Anlage"** (Konzept „Erlöse ·
 * Preise und Verdienst", 25.09.2026) — der Browser-Beweis über die echte
 * `ErloeseSection` mit den eingefrorenen Konzept-Fixtures.
 *
 * Geprüft wird, was jsdom nicht sieht: die Balken haben ihre Länge aus der
 * gemeinsamen Skala, nichts läuft bei 375 px über, die Karten stehen am
 * Rechner nebeneinander, das Aufdecken läuft genau einmal beim ersten
 * Sichtbarwerden — und unter reduzierter Bewegung gar nicht.
 */
// Gelesen statt importiert: der Test-Lader verlangt für JSON-Module ein
// Import-Attribut, das Vite und TypeScript hier nicht kennen.
const FX = (
  JSON.parse(readFileSync(new URL('../src/erloeseFixtures.json', import.meta.url), 'utf8')) as {
    fixtures: Array<{ id: string; now: string }>;
  }
).fixtures;
const jetzt = (fall: string) => FX.find((f) => f.id === fall)!.now;

async function oeffne(page: Page, fall: string) {
  await page.goto(`/e2e/erloese-preise.html?fall=${fall}&jetzt=${encodeURIComponent(jetzt(fall))}`);
  await expect(page.locator(`main[data-fall="${fall}"]`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Preise im Zeitraum' })).toBeVisible();
}

const preise = (page: Page) => page.getByRole('region', { name: 'Preise im Zeitraum' });
const verdient = (page: Page) => page.getByRole('region', { name: 'So verdient Ihre Anlage' });

/** Breite eines Segments relativ zu seiner Spur. */
async function anteil(page: Page, karte: string, zeile: string, segment = 0): Promise<number> {
  return page
    .getByRole('region', { name: karte })
    .locator(`[data-zeile="${zeile}"] .vp-bl-seg`)
    .nth(segment)
    .evaluate((el) => el.getBoundingClientRect().width / (el.parentElement as HTMLElement).getBoundingClientRect().width);
}

test.describe('Preise im Zeitraum · drei Balken auf einer Skala', () => {
  test('Direktvermarktung · Monat: Werte, Längen und die Antwort darüber', async ({ page }) => {
    await oeffne(page, 'dv-monat');
    const karte = preise(page);
    await karte.scrollIntoViewIfNeeded();
    await expect(karte.getByText('Selbst genutzter Strom war mehr wert als eingespeister.')).toBeVisible();
    const zeilen = karte.getByRole('list', { name: 'Preise je Kilowattstunde' }).getByRole('listitem');
    await expect(zeilen).toHaveCount(3);
    await expect(zeilen.nth(0)).toContainText('Eigenverbrauch');
    await expect(zeilen.nth(0)).toContainText('25,0 ct');
    await expect(zeilen.nth(1)).toContainText('9,3 ct');
    await expect(zeilen.nth(2)).toContainText('bezahlt: fester Tarif 25 ct/kWh');
    // 25 ct füllen die Spur, 9,3 ct gut ein Drittel davon.
    expect(await anteil(page, 'Preise im Zeitraum', 'eigenverbrauch')).toBeCloseTo(1, 2);
    expect(await anteil(page, 'Preise im Zeitraum', 'einspeisung')).toBeCloseTo(9.31 / 25, 2);
  });

  test('ohne Stromtarif: „—" mit gestrichelter Spur und dem Weg dorthin', async ({ page }) => {
    await oeffne(page, 'eeg-ohne-tarif');
    const zeile = preise(page).locator('[data-zeile="eigenverbrauch"]');
    await expect(zeile.locator('.vp-bl-wert')).toHaveText('—');
    await expect(zeile.locator('.vp-bl-spur.leer')).toHaveCount(1);
    await expect(zeile.locator('.vp-bl-seg')).toHaveCount(0);
    await expect(zeile.getByRole('link', { name: 'Stromtarif hinterlegen ›' })).toBeVisible();
    await expect(verdient(page)).toHaveCount(0);
  });
});

test.describe('So verdient Ihre Anlage · Börse gegen Börse, die Prämie obendrauf', () => {
  test('Prämien-Monat: der Block liegt auf dem Börsen-Teil und die Summe stimmt', async ({ page }) => {
    await oeffne(page, 'dv-monat');
    const karte = verdient(page);
    await karte.scrollIntoViewIfNeeded();
    await expect(karte.getByText('+ 1,2 ct über dem Monatsdurchschnitt')).toBeVisible();
    await expect(karte.locator('[data-zeile="erloes"] .vp-bl-wert')).toHaveText('9,3 ct');
    // Ø 6,2 · Ihre 7,4 · Erlös 9,31 auf EINER Skala bis 9,31.
    expect(await anteil(page, 'So verdient Ihre Anlage', 'markt')).toBeCloseTo(6.2 / 9.31, 2);
    expect(await anteil(page, 'So verdient Ihre Anlage', 'anlage')).toBeCloseTo(7.4 / 9.31, 2);
    expect(await anteil(page, 'So verdient Ihre Anlage', 'erloes', 1)).toBeCloseTo(1.91 / 9.31, 2);
    // Die Rechnung liegt im Aufklapper, zugeklappt.
    await expect(karte.locator('details.vp-sv-rechnung')).not.toHaveAttribute('open', '');
  });

  test('Tag mit negativem Börsenpreis: Nulllinie, Vorzeichen, kein gestapelter Block', async ({ page }) => {
    await oeffne(page, 'dv-praemie-ruht');
    const karte = verdient(page);
    await karte.scrollIntoViewIfNeeded();
    await expect(karte.locator('.vp-bl-null').first()).toBeAttached();
    await expect(karte.locator('[data-zeile="anlage"] .vp-bl-wert')).toHaveClass(/minus/);
    await expect(karte.locator('[data-zeile="erloes"] .vp-bl-seg')).toHaveCount(1);
  });

  test('am Rechner stehen beide Karten nebeneinander', async ({ page }, info) => {
    test.skip(info.project.name !== 'desktop-chromium', 'Rechner-Anordnung');
    await page.setViewportSize({ width: 1440, height: 900 });
    await oeffne(page, 'dv-monat');
    const a = await preise(page).boundingBox();
    const b = await verdient(page).boundingBox();
    expect(a && b).toBeTruthy();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);
  });
});

test.describe('Layout · nichts läuft über', () => {
  for (const fall of ['dv-monat', 'dv-tag-laufend', 'dv-provisorisch-knapp', 'dv-praemie-ruht', 'eeg-ohne-tarif', 'eeg-jahr']) {
    test(`${fall}: kein seitlicher Überlauf, keine Konsolenfehler`, async ({ page }) => {
      const fehler: string[] = [];
      page.on('pageerror', (e) => fehler.push(String(e)));
      page.on('console', (m) => {
        if (m.type() === 'error') fehler.push(m.text());
      });
      await oeffne(page, fall);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const ueber = await page.evaluate(() => {
        const breite = document.documentElement.clientWidth;
        return [...document.querySelectorAll('.vp-bl-rahmen *, .vp-sv-verdict, .vp-sv-praemie *')]
          .filter((el) => el.getBoundingClientRect().right > breite + 1)
          .map((el) => el.className.toString());
      });
      expect(ueber).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(fehler).toEqual([]);
    });
  }
});

test.describe('Bewegung · aufdecken statt wachsen', () => {
  test('deckt GENAU EINMAL auf, wenn die Liste ins Bild kommt, und räumt per Frist auf', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await oeffne(page, 'dv-monat');
    const rahmen = verdient(page).locator('.vp-bl-rahmen');
    // Unter der Falz: noch nichts passiert.
    await expect(rahmen).not.toHaveAttribute('data-aufdecken', 'laeuft');
    await verdient(page).scrollIntoViewIfNeeded();
    await expect(rahmen).toHaveAttribute('data-aufdecken', 'laeuft');
    // Nach der Frist ist die Klasse weg und jeder Balken steht auf seinem Wert.
    await expect(rahmen).not.toHaveAttribute('data-aufdecken', 'laeuft', { timeout: 3000 });
    expect(await anteil(page, 'So verdient Ihre Anlage', 'erloes', 1)).toBeCloseTo(1.91 / 9.31, 2);
  });

  test('unter reduzierter Bewegung wird nichts aufgedeckt — alles steht sofort', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await oeffne(page, 'dv-monat');
    await verdient(page).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await expect(verdient(page).locator('.vp-bl-rahmen')).not.toHaveAttribute('data-aufdecken', 'laeuft');
    expect(await anteil(page, 'So verdient Ihre Anlage', 'anlage')).toBeCloseTo(7.4 / 9.31, 2);
  });
});
