import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const bilder = process.env.BENUTZER_BILDER;
for (const breite of [375, 1440]) {
  test(`N1–N3, N8 und Entzug · ${breite}px`, async ({ page, browserName }, info) => {
    const fehler: string[] = [];
    page.on('pageerror', e => fehler.push(e.message));
    await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
    await page.setViewportSize({ width: breite, height: 1000 });
    await page.goto('/e2e/benutzer.html');
    await expect(page.getByText('Jonas Wendlinger · Sie')).toBeVisible();
    await foto('N1');
    const ausloeser = page.getByRole('button', { name: 'Benutzer anlegen', exact: true });
    await ausloeser.click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(dialog.getByLabel('Benutzername', { exact: true })).toBeFocused();
    await dialog.getByLabel('Benutzername', { exact: true }).fill('claudia');
    await dialog.getByLabel('E-Mail', { exact: true }).fill('claudia@ahrenberg.example');
    await dialog.getByLabel('Vorname', { exact: true }).fill('Claudia');
    await dialog.getByLabel('Nachname', { exact: true }).fill('Berger');
    await foto('N2');
    await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Benutzer anlegen', exact: true });
    await expect(dialog).toContainText('Schritt 2 von 2');
    await dialog.getByRole('button', { name: 'Benutzer anlegen', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Standorte' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Alle aktuellen Standorte' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Standorte' })).not.toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByText('Darf', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Darf nicht', { exact: true })).toBeVisible();
    await foto('N3');
    await dialog.getByRole('button', { name: 'Benutzer anlegen', exact: true }).click();
    await expect(page.getByLabel('Startpasswort', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(ausloeser).toBeFocused();
    await page.getByRole('button', { name: 'Zugriffsprotokoll', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Zugriffsprotokoll' })).toBeVisible();
    await expect(page.getByText('Zugriff gewährt · Leser')).toBeVisible();
    await foto('N8');
    await page.getByRole('button', { name: 'Benutzerliste', exact: true }).click();
    await page.getByRole('button', { name: 'Sperren', exact: true }).first().click();
    dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Gesetzte Handeingriffe bleiben');
    await dialog.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await page.getByRole('button', { name: 'Zugriff beenden', exact: true }).first().click();
    dialog = page.getByRole('dialog', { name: 'Zugriff beenden' });
    await expect(dialog).toContainText('Andere Zuweisungen bleiben erhalten.');
    await dialog.getByRole('button', { name: 'Zugriff beenden', exact: true }).click();
    await expect(page.getByText('Ines Kaltenbach', { exact: true })).toBeVisible();
    expect(fehler).toEqual([]);
    async function foto(name: string) {
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      if (bilder && info.repeatEachIndex === 1) { mkdirSync(bilder, { recursive: true }); await page.screenshot({ path: `${bilder}/${name}-${breite}-${browserName}.png`, animations: 'disabled', fullPage: name === 'N1' || name === 'N8' }); }
    }
  });
  test(`Energiemanager liest, Leser ausgeschlossen · ${breite}px`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: 1000 });
    await page.goto('/e2e/benutzer.html?person=IK');
    await expect(page.getByText('Ines Kaltenbach · Sie')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Benutzer anlegen' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Zugriffsprotokoll' })).toHaveCount(0);
    await page.goto('/e2e/benutzer.html?person=CB');
    await expect(page.getByRole('alert')).toHaveText('Diese Seite gibt es für Sie nicht.');
  });
}
