import { expect, test } from '@playwright/test';

/**
 * **Privatkunde, drei Nebenbefunde** (Konzept `vp-privatkunde-luecken-konzept`
 * §8, PK5-A) — Browser-Beweis an der Bühne `privat-nebenbefunde` mit fester
 * Uhr (13.11.2026, 12:15).
 */
const JETZT = 'jetzt=2026-11-13T12%3A15%3A00%2B01%3A00';

test('Erlöse einer Privat-Anlage: aktiver Reiter, Vergleich in Euro statt „461 %“', async ({ page }) => {
  await page.goto(`/e2e/privat-nebenbefunde.html?flaeche=erloese&${JETZT}`);
  const reiter = page.getByRole('tablist', { name: 'Reiter des Bereichs Verlauf' });
  await expect(reiter.getByRole('tab')).toHaveText(['Energie', 'Erlöse', 'Messwerte']);
  await expect(reiter.getByRole('tab', { name: 'Erlöse' })).toHaveAttribute('aria-selected', 'true');
  const vergleich = page.getByText(/weniger als gestern bis 12 Uhr/);
  await expect(vergleich).toHaveText(/1,65\s€ weniger als gestern bis 12 Uhr/);
  await expect(vergleich).not.toHaveText(/%/);
});

test('Benutzer-Seite eines Privatkunden spricht Haushalt, ein Gewerbekunde bleibt beim Unternehmen', async ({ page }) => {
  await page.goto('/e2e/privat-nebenbefunde.html?flaeche=benutzer');
  await expect(page.getByText('Gilt für alle Orte des Haushalts, auch künftige.').first()).toBeVisible();
  await expect(page.getByText(/Energiemanager|Kundenadministrator|Standorte/)).toHaveCount(0);

  await page.goto('/e2e/privat-nebenbefunde.html?flaeche=benutzer&profil=gewerbe');
  await expect(page.getByText('Gilt für alle Standorte des Unternehmens, auch künftige.').first()).toBeVisible();
  await expect(page.getByText('Kundenadministrator').first()).toBeVisible();
});
