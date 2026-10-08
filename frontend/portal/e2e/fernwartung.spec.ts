import { expect, test } from '@playwright/test';

test('Fernwartung: Lage, Sperrgründe und Fenster öffnen auf jeder Bildschirmgröße', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/fernwartung.html');

  await expect(page.getByRole('tab', { name: 'Fernwartung' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('fw-dienst')).toContainText('Tunnel-Dienst holt ab');
  await expect(page.getByText(/meldet der Tunnel-Dienst nicht zurück/)).toBeVisible();

  const boxen = page.getByTestId('fw-boxen');
  const gesperrt = boxen.locator('tr').filter({ hasText: 'edge-q2w3e4r' });
  await expect(gesperrt.getByRole('button', { name: 'Fenster öffnen' })).toBeDisabled();
  await expect(gesperrt).toContainText('gesperrt - erst entsperren');
  // Einziger aktiver Zugang hat an dieser Box schon ein Fenster: gesperrt mit Grund.
  const pilot = boxen.locator('tr').filter({ hasText: 'edge-zay5sdd' });
  await expect(pilot.getByRole('button', { name: 'Fenster öffnen' })).toBeDisabled();
  await expect(pilot).toContainText('schon ein Fenster');

  const frei = boxen.locator('tr').filter({ hasText: 'edge-k7m2xq3' });
  await frei.getByRole('button', { name: 'Fenster öffnen' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: /Techniker-Zugang/ })).toContainText('Alex (Laptop)');
  await dialog.getByRole('combobox', { name: /Techniker-Zugang/ }).click();
  await expect(page.getByRole('option', { name: /Werkstatt-Tablet/ })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('option', { name: /Alex \(Laptop\)/ }).click();
  await dialog.getByLabel('Grund *').fill('go-e prüfen');
  await dialog.getByRole('button', { name: 'Fenster öffnen' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(frei.getByText(/^bis .* · Alex \(Laptop\)$/)).toBeVisible();

  await expect(page.getByTestId('fw-protokoll')).toContainText('Fenster geöffnet');

  // Kein horizontaler Überlauf der Seite (Tabellen scrollen lokal).
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('fernwartung.png'), fullPage: true });
  expect(errors).toEqual([]);
});
