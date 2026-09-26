import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-10T10:00:00Z'));
});

test('help is available without plants, during API failure and without an admin tenant', async ({ page }) => {
  for (const state of ['empty', 'error', 'admin', 'single']) {
    await page.goto('/e2e/help.html?state=' + state + '#/hilfe/fahrplan');
    await expect(page.getByRole('heading', { name: 'Den Fahrplan verstehen', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Zurück zum Portal' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Den Fahrplan verstehen', exact: true })).toBeVisible();
  }
});

test('search, article navigation, section links, back and unknown links work', async ({ page }) => {
  await page.goto('/e2e/help.html#/hilfe');
  await page.getByRole('searchbox').fill('Akku');
  await page.getByRole('link', { name: /Speichergrenzen und Reserven/ }).click();
  await expect(page.getByRole('heading', { name: 'Speichergrenzen und Reserven', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Passende Artikel' }).getByRole('link').first().click();
  await expect(page.locator('main h1')).toBeInViewport();
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole('searchbox')).toHaveValue('Akku');
  await page.getByRole('searchbox').fill('unbekannteswort');
  await expect(page.getByRole('status')).toContainText('Keine Treffer');
  await page.goto('/e2e/help.html#/hilfe/probleme?abschnitt=kein-fahrplan');
  await expect(page.getByRole('heading', { name: 'Es gibt keinen Fahrplan' })).toBeInViewport();
  await page.goto('/e2e/help.html#/hilfe/kein-artikel');
  await expect(page.getByRole('heading', { name: 'Artikel nicht gefunden' })).toBeVisible();
});

test('contextual help preserves the actual first onboarding step and focus', async ({ page }) => {
  await page.goto('/e2e/help.html?state=empty#/uebersicht');
  const firstStep = page.getByTestId('standort-zuerst');
  await expect(firstStep).toBeVisible();
  await expect(firstStep.getByRole('button', { name: 'Standort anlegen' })).toBeEnabled();
  const trigger = page.getByRole('link', { name: 'Hilfe zu diesem Schritt' });
  await trigger.focus();
  await trigger.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Hilfe zur Ansicht', exact: true });
  await expect(panel.getByRole('heading', { name: 'Eine Anlage anlegen', exact: true })).toBeVisible();
  const centerLink = panel.getByRole('link', { name: /Im Hilfe-Center öffnen/ });
  await centerLink.focus();
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Schließen', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(centerLink).toBeFocused();
  await panel.getByRole('link', { name: /Betriebsmodelle und Voraussetzungen/ }).click();
  await expect(panel.getByRole('heading', { name: 'Betriebsmodelle und Voraussetzungen', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Vorheriger Artikel' }).click();
  await expect(panel.getByRole('heading', { name: 'Eine Anlage anlegen', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Schließen', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(firstStep).toBeVisible();
  await expect(trigger).toBeFocused();
  // The reader chunk is now cached: focus must return on subsequent openings too.
  await trigger.click();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Schließen', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(firstStep).toBeVisible();
});

test('nested screenshot viewing closes independently and keeps the form behind help', async ({ page }) => {
  await page.goto('/e2e/help.html?scene=claim');
  const form = page.getByRole('dialog', { name: 'Gerät hinzufügen', exact: true });
  await form.locator('input').fill('edge-abcdefj');
  await form.getByRole('link', { name: 'Hilfe beim Verbinden' }).click();
  const help = page.getByRole('dialog', { name: 'Hilfe zur Ansicht', exact: true });
  const image = help.getByRole('button', { name: 'Screenshot vergrößern: Die Geräte-ID zuordnen', exact: true });
  await image.click();
  const zoom = page.getByRole('dialog', { name: 'Screenshot: Die Geräte-ID zuordnen', exact: true });
  await expect(zoom).toBeVisible();
  await expect.poll(() => zoom.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(zoom).not.toBeVisible();
  await expect(help).toBeVisible();
  await expect(image).toBeFocused();
  const opened = page.waitForEvent('popup');
  await help.getByRole('link', { name: /Im Hilfe-Center öffnen/ }).click();
  const center = await opened;
  await expect(center.getByRole('heading', { name: 'Die Box verbinden und erste Daten prüfen', exact: true })).toBeVisible();
  await center.close();
  await help.getByRole('button', { name: 'Schließen', exact: true }).click();
  await expect(form.locator('input')).toHaveValue('edge-abcdefj');
  await expect(form).toBeVisible();
});

test('der Artikel zum Energiemanagement: über die Suche erreichbar, mit Verantwortungs- und Grenz-Satz, ohne Querlauf (AP-20 IP-22)', async ({ page }) => {
  const titel = 'Was VoltPilot für Ihr Energiemanagement festhält — und was bei Ihnen bleibt';
  await page.goto('/e2e/help.html#/hilfe');
  await page.getByRole('searchbox').fill('Gesamtabzug');
  await page.getByRole('link', { name: new RegExp(titel) }).first().click();
  await expect(page.getByRole('heading', { name: titel, exact: true })).toBeVisible();
  for (const abschnitt of ['Was VoltPilot festhält', 'Was bei Ihnen bleibt', 'Grenze']) {
    await expect(page.getByRole('heading', { name: abschnitt, exact: true })).toBeVisible();
  }
  const artikel = page.locator('main');
  await expect(artikel.getByText('Inhalte und Entscheidungen Ihres Energiemanagements verantwortet Ihr Unternehmen.')).toBeVisible();
  await expect(artikel.getByText('Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.')).toBeVisible();
  await expect(artikel.getByText('Interne Audits durchführen (Gespräche, Begehung)')).toBeVisible();
  await expect(artikel.getByText('Energiepolitik')).toHaveCount(0);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test('help fits phone, tablet and desktop and the menu reaches the center', async ({ page }) => {
  await page.goto('/e2e/help.html#/hilfe');
  for (const width of [320, 390, 834, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('searchbox')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/help.html?state=empty#/uebersicht');
  await page.getByRole('button', { name: /Konto-Menü/ }).click();
  await page.getByRole('menuitem', { name: 'Hilfe & Kontakt' }).click();
  await expect(page.getByRole('searchbox')).toBeVisible();
  await page.goto('/e2e/help.html#/hilfe/energiefluesse');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
