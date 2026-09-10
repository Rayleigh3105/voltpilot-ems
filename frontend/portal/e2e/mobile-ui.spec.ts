import { expect, test } from '@playwright/test';

test('device claiming keeps focus while typing and returns focus after closing', async ({ page }) => {
  await page.goto('/e2e/mobile-ui.html');
  const trigger = page.getByRole('button', { name: 'Gerät hinzufügen', exact: true });
  // Keyboard launch: Safari intentionally does not focus buttons on a tap.
  await trigger.focus();
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Gerät hinzufügen' });
  const ref = dialog.locator('input').first();
  await ref.click();
  await ref.pressSequentially('edge-abcdefj');
  await expect(ref).toHaveValue('edge-abcdefj');
  await expect(ref).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('modal contains keyboard focus and Escape closes only its nested picker', async ({ page }) => {
  await page.goto('/e2e/mobile-ui.html');
  await page.getByRole('button', { name: 'Gerät hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Gerät hinzufügen' });
  await dialog.getByRole('button', { name: 'Schließen', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Gerät hinzufügen', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Schließen', exact: true })).toBeFocused();
  await dialog.getByRole('combobox').click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox')).toBeFocused();
});

test('claim sheet keeps its actions reachable on small phones and in landscape', async ({ page }) => {
  await page.goto('/e2e/mobile-ui.html');
  await page.getByRole('button', { name: 'Gerät hinzufügen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Gerät hinzufügen' });
  for (const [width, height] of [[320,568], [375,812], [390,844], [430,932], [812,375]]) {
    await page.setViewportSize({ width, height });
    await expect(dialog.getByRole('button', { name: 'Schließen', exact: true })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Gerät hinzufügen', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const input = dialog.locator('input').first();
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeInViewport();
  }
});

test('registration validates, keeps readable mobile fields, and clears old focus rings', async ({ page, isMobile }) => {
  await page.goto('/e2e/mobile-ui.html?register');
  const submit = page.getByRole('button', { name: 'Konto erstellen', exact: true });
  if (isMobile) await submit.tap();
  else await submit.click();
  const name = page.getByLabel('Ihr Name oder Firmenname', { exact: true });
  await expect(name).toBeFocused();
  await name.fill('Mobile Test');
  await page.getByLabel('E-Mail-Adresse', { exact: true }).fill('invalid');
  await page.getByLabel('Passwort', { exact: true }).fill('123');
  await expect(name).toHaveCSS('box-shadow', 'none');
  await page.getByRole('button', { name: 'Anzeigen', exact: true }).click();
  await expect(page.getByLabel('Passwort', { exact: true })).toHaveAttribute('type','text');
  await page.getByRole('button', { name: 'Konto erstellen', exact: true }).click();
  await expect(page.getByText('Das sieht noch nicht wie eine E-Mail-Adresse aus.')).toBeVisible();
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});
