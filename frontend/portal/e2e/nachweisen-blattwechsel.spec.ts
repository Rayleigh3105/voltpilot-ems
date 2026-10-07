import { expect, test, type Page } from '@playwright/test';

/**
 * Blatt-Wechsel und verschachtelte Blätter am Handy (Review Nachweisen r1, Q-1 und Q-2) auf der Bühne
 * `e2e/energiemanagement.html` am 12.02.2029, 390 × 844, OHNE reduzierte Bewegung - erst das Ausblenden macht den
 * Fehler sichtbar: das Blatt einer Gruppe blendet noch aus, während das Blatt eines Teils öffnet.
 *
 * Vorher merkte sich jedes Blatt `body.style.overflow` als „vorher“: nach Gruppe → Teil → Schließen stand `hidden`,
 * die Seite scrollte bis zum Neuladen nicht mehr. Und Escape im Erklär-Blatt schloss auch das Teil-Blatt darunter
 * samt Eingaben. Beides läuft jetzt über den einen Stapel der Überlagerungen (`designsystem/…/ueberlagerung.js`).
 */

async function oeffne(page: Page) {
  await page.clock.setFixedTime(new Date('2029-02-12T14:00:00+01:00'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/energiemanagement.html?lage=ahrenberg');
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** Wartet, bis keine Fläche mehr ausblendet (die Dauer misst `useAusblenden` aus `--vp-motion-exit`). */
const ausgeblendet = (page: Page) => expect(page.locator('.is-closing')).toHaveCount(0);

test('Gruppen-Blatt → Teil-Blatt → schließen: die Seite scrollt wieder', async ({ page }) => {
  await oeffne(page);
  const vorher = await page.evaluate(() => document.body.style.overflow);
  await page.getByRole('button', { name: /^Grundlagen:/ }).click();
  const gruppe = page.getByTestId('gruppen-blatt');
  await expect(gruppe).toBeVisible();
  await gruppe.getByTestId('gruppen-teil-risiken_chancen').click();
  await expect(page.getByTestId('teil-blatt')).toBeVisible();
  await ausgeblendet(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).last().click();
  await expect(page.getByTestId('teil-blatt')).toBeHidden();
  await ausgeblendet(page);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe(vorher);
  // Und die Seite bewegt sich wirklich: ein Wisch nach oben scrollt sie.
  await page.mouse.wheel(0, 600);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  // Der Fokus steht wieder am Auslöser der Kette, nicht am Ende des Dokuments.
  await expect(page.getByRole('button', { name: /^Grundlagen:/ })).toBeFocused();
});

test('Escape im Erklär-Blatt schließt nur das Erklär-Blatt; das Teil-Blatt behält seine Eingabe', async ({ page }) => {
  await oeffne(page);
  await page.getByTestId('teil-chip-kontext').click();
  const teil = page.getByTestId('teil-blatt');
  await expect(teil).toBeVisible();
  await teil.getByText('Trifft zurzeit nicht zu').click();
  await page.getByTestId('teil-weiter').click();
  await page.getByTestId('teil-satz').fill('Unsere Interessen stehen im Handbuch, Kapitel Umfeld.');
  await teil.getByRole('button', { name: 'Was heißt „trifft zurzeit nicht zu“?' }).click();
  await expect(page.getByTestId('erklaer-blatt')).toBeVisible();
  await ausgeblendet(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('erklaer-blatt')).toBeHidden();
  await expect(teil).toBeVisible();
  await expect(page.getByTestId('teil-satz')).toHaveValue('Unsere Interessen stehen im Handbuch, Kapitel Umfeld.');
  // Tab bleibt im Teil-Blatt.
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(teil).toBeHidden();
  await ausgeblendet(page);
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
});
