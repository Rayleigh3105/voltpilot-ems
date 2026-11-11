import { expect, test, type Page } from '@playwright/test';

/**
 * Die Steuerzeile des Cockpits (Konzept b1, 20.10.2026): EINE Zeile Auftrag › Gerät › Wirkung,
 * die Gründe im Blatt „Warum?“, die Abweichung der Einspeisegrenze als Befund mit Weg in die
 * Einstellungen - am Rechner rechts unter der Leitkachel (Entscheid E2), am Telefon am Bühnenfuß.
 * Echtes Portal auf den fiktiven Hilfe-Fixtures, dieselbe Lage wie im Screenshot des Captains
 * (`?steuerung=abweichung`). GEMESSEN: Ort, Inhalt des Blatts, Wege, kein Überlauf, Konsole sauber.
 */
const COCKPIT = '/e2e/help.html?steuerung=abweichung#/anlage/help-site';

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

async function oeffnen(page: Page) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  await page.clock.setFixedTime(new Date('2026-09-10T10:00:00Z'));
  await page.goto(COCKPIT);
  await page.locator('.vp-steuer').waitFor();
  return fehler;
}

const text = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => (el.textContent ?? '').replace(/[  ]/g, ' '));

test('am Rechner: eine Zeile rechts unter der Leitkachel, „Warum?“ öffnet die Gründe', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fehler = await oeffnen(page);
  const zeile = page.locator('.vp-hero-side .vp-hero-steuer .vp-steuer');
  await expect(zeile).toBeVisible();
  await expect(page.locator('.vp-stage-foot')).toHaveCount(0);
  expect(await text(page, '.vp-steuer-kette')).toContain('Speicher abgeben 0,3 kW');
  await expect(zeile.locator('.vp-steuer-hinweis')).toHaveText('1 Hinweis');
  // Kein Fließtext mehr unter der Bühne.
  await expect(page.locator('.vp-control-reason, .vp-guard-line')).toHaveCount(0);

  await zeile.getByRole('button', { name: /Warum\?/ }).click();
  const blatt = page.getByRole('dialog', { name: 'Steuerung jetzt' });
  await expect(blatt).toBeVisible();
  const inhalt = await blatt.evaluate((el) => (el.textContent ?? '').replace(/[  ]/g, ' '));
  // Die Zahl heißt, was sie ist: der nach Solar verbleibende Verbrauch, nie „Ihr Verbrauch“.
  expect(inhalt).toContain('der nach Solar verbleibende Verbrauch (0,8 kW)');
  expect(inhalt).not.toContain('Ihr Verbrauch');
  expect(inhalt).toContain('Einspeisegrenze 75,0 kW.');
  await expect(blatt.getByRole('note')).toContainText('70,0');
  await blatt.getByRole('note').getByRole('button', { name: /Prüfen/ }).click();
  await expect(blatt).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('/technik');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(fehler).toEqual([]);
});

test('der Befund steht auch im Zustand der Anlage - mit Weg in die Einstellungen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await oeffnen(page);
  const zustand = page.locator('#zustand');
  await expect(zustand).toContainText('Einspeisegrenze: Ihr Wechselrichter begrenzt die Einspeisung');
  await expect(zustand.getByRole('button', { name: /Einstellungen/ })).toBeVisible();
});

test.describe('am Telefon', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('steht die Zeile am Fuß der Bühne, ein Tipp öffnet das Blatt', async ({ page }) => {
    const fehler = await oeffnen(page);
    const zeile = page.locator('.vp-stage-foot .vp-steuer');
    await expect(zeile).toBeVisible();
    await expect(page.locator('.vp-hero-side')).toHaveCount(0);
    await zeile.getByRole('button', { name: /Warum\?/ }).tap();
    const blatt = page.getByRole('dialog', { name: 'Steuerung jetzt' });
    await expect(blatt).toBeVisible();
    await expect(blatt.getByRole('note')).toContainText('70,0');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });
});
