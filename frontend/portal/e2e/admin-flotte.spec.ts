import { expect, test } from '@playwright/test';
import { join } from 'node:path';

for (const width of [1440, 375] as const) {
  test(`Admin-Flotte gruppiert bei ${width} px je Anlage eine Zeile pro Box`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/e2e/admin-flotte.html');

    const fleet = page.getByTestId('admin-fleet');
    await expect(fleet).toBeVisible();
    await expect(fleet.locator('.vp-fleet-group-head')).toHaveCount(2);
    await expect(fleet.locator('.vp-fleet-box')).toHaveCount(3);
    await expect(fleet).toContainText('Werk Ahrenberg');
    await expect(fleet).toContainText('Box Leitstand');
    await expect(fleet).toContainText('Box Halle 2');
    await expect(fleet).toContainText('Führende Box');
    await expect(fleet).toContainText('Weitere Box');
    await expect(fleet).toContainText('edge-2026.09.0');
    await expect(fleet).toContainText('Rückmeldung je Datenquelle: fehlt');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);

    const output = process.env.ADMIN_FLOTTE_BILDER;
    if (output) await page.screenshot({ path: join(output, `admin-flotte-${width}.png`), fullPage: true });
  });
}
