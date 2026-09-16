import { expect, test } from '@playwright/test';

test('Versionen, Filter und Update-Dialog funktionieren auf jeder Bildschirmgröße', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/box-updates.html');
  const boxes = page.getByTestId('box-versions');
  await expect(boxes).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Updates', exact: true })).toHaveAttribute('aria-selected', 'true');
  const workshop = boxes.locator('tr').filter({ hasText: 'Werkstatt am Bach' });
  await expect(workshop.locator('[data-label="Installierte Version"]')).toContainText('edge-2026.09.02');
  await expect(workshop.locator('[data-label="Zielversion"]')).toContainText('edge-2026.09.10');
  await page.locator('.vp-box-filter-panel > summary').click();
  await page.getByRole('button', { name: 'Update läuft 1' }).click();
  await expect(boxes.locator('tbody tr')).toHaveCount(1);
  await expect(boxes).toContainText('Werkstatt am Bach');
  await page.getByRole('button', { name: 'Update verwalten für Werkstatt am Bach · edge-abcdefj' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Software-Version');
  await drawer.getByRole('button', { name: 'Aktualisieren', exact: true }).click();
  await expect(drawer.getByRole('alert')).toContainText('Aktion ist fehlgeschlagen');
  await page.keyboard.press('Escape');
  await expect(drawer).not.toBeVisible();
  await page.getByRole('button', { name: 'Alle Boxen 5' }).click();
  await page.getByRole('combobox', { name: 'Installierte Version' }).click();
  await page.getByRole('option', { name: 'edge-2026.09.10', exact: true }).click();
  await expect(boxes.locator('tbody tr')).toHaveCount(1);
  await expect(boxes).toContainText('Solarpark Sonnenhof');
  await page.getByRole('tab', { name: 'Registrierung' }).click();
  const support = page.locator('details').filter({ hasText: '1 Box ohne Kundenkonto' });
  await expect(support).not.toHaveAttribute('open');
  await support.locator('summary').click();
  await expect(support).toHaveAttribute('open');
  await expect(support).toContainText('edge-xyz234q');
  expect(errors).toEqual([]);
});

test('Versionsübersicht bleibt bei 320, 768, 1024 und 1440 px innerhalb des Bildschirms', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-chromium' && info.project.use.browserName !== 'webkit', 'Gezielte zusätzliche Viewport-Prüfung');
  await page.goto('/e2e/box-updates.html');
  await expect(page.getByTestId('box-versions')).toBeVisible();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const metrics = await page.evaluate(() => {
      const table = document.querySelector('[data-testid="box-versions"]')!;
      return {
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
        tableOverflow: table.scrollWidth - table.clientWidth,
      };
    });
    expect(metrics.documentOverflow, `Seite bei ${width}px`).toBeLessThanOrEqual(1);
    expect(metrics.tableOverflow, `Versionen bei ${width}px`).toBeLessThanOrEqual(1);
  }
});
