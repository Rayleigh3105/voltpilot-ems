import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const bilder = '/tmp/vp-uems-r03-unterstuetzung-portal/bilder';
for (const breite of [375, 1440]) {
  test(`N4–N6, Anfrage und Notfall · ${breite}px`, async ({ page, browserName }, info) => {
    const fehler: string[] = []; page.on('pageerror', e => fehler.push(e.message));
    await page.clock.setFixedTime(new Date('2026-10-20T08:15:00Z')); await page.setViewportSize({ width: breite, height: 1000 });
    await page.goto('/e2e/unterstuetzung.html');
    await expect(page.getByRole('status').filter({ hasText: 'Elektro Brunner (Installateur)' })).toBeVisible(); await foto('N5');
    const karte = page.getByRole('region', { name: 'Unterstützung', exact: true });
    const ausloeser = karte.getByRole('button', { name: 'Unterstützung gewähren', exact: true }); await ausloeser.click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('E-Mail-Adresse des Partners').fill('thomas.brunner@elektro-brunner.example');
    await dialog.getByRole('button', { name: 'Unterstützung gewähren', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Standorte' })).toBeFocused();
    await dialog.getByRole('combobox', { name: 'Standorte' }).click();
    await page.getByRole('option', { name: 'Werk Ahrenberg', exact: true }).click(); await page.keyboard.press('Escape');
    await dialog.getByLabel('Grund (optional)').fill('Ladepunkt Halle 2 einrichten'); await foto('N4');
    await dialog.getByRole('region', { name: 'Folgen der Unterstützung' }).scrollIntoViewIfNeeded(); await foto('N4-Folgen');
    for (let n = 0; n < 12; n++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true); }
    await dialog.getByRole('button', { name: 'Unterstützung gewähren', exact: true }).click();
    await expect(page.getByLabel('Startpasswort', { exact: true })).toBeVisible(); await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(ausloeser).toBeFocused();
    await page.goto('/e2e/unterstuetzung.html');
    await karte.getByRole('button', { name: 'Beenden', exact: true }).first().click(); dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Gesetzte Handeingriffe bleiben'); await foto('N6');
    await dialog.getByLabel('Grund (optional)').fill('Arbeit erledigt');
    await dialog.getByRole('button', { name: 'Zugriff beenden' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Elektro Brunner (Installateur)' })).toHaveCount(0);
    await expect(karte.getByRole('heading', { name: 'Unterstützung', exact: true })).toBeFocused();
    await page.goto('/e2e/unterstuetzung.html?modus=partner');
    await expect(page.getByRole('status')).toContainText('Sie arbeiten im Kundenbereich Kunststoffwerk Ahrenberg GmbH');
    await expect(page.getByRole('status')).toContainText('Einrichten und Bedienen');
    await expect(page.getByRole('combobox', { name: 'Kundenbereich' })).toBeVisible(); await foto('N5b');
    await page.goto('/e2e/unterstuetzung.html?modus=notfall');
    await expect(page.getByRole('status')).toContainText('VoltPilot-Support hat Notfall-Zugriff'); await foto('A14');
    await expect(page.getByRole('region', { name: 'Unterstützung', exact: true }).getByRole('button', { name: 'Verlängern' })).toHaveCount(0);
    await page.goto('/e2e/unterstuetzung.html?modus=anfrage');
    await page.getByRole('button', { name: 'Bestätigen oder ändern' }).click(); dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Lena Voss'); await foto('Anfrage');
    await dialog.getByRole('button', { name: 'Unterstützung bestätigen' }).click(); await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(() => window.letzteGewaehrung?.anfrage_id)).toBe('22222222-2222-4222-8222-222222222222');
    await page.goto('/e2e/unterstuetzung.html?modus=admin');
    await page.getByRole('button', { name: 'Details zu Kunststoffwerk Ahrenberg GmbH' }).click();
    await page.getByRole('button', { name: 'Notfall-Zugriff', exact: true }).click(); dialog = page.getByRole('dialog', { name: 'Notfall-Zugriff', exact: true });
    await dialog.getByRole('combobox', { name: 'Standorte' }).click(); await page.getByRole('option', { name: 'Werk Ahrenberg', exact: true }).click(); await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Notfall-Zugriff gewähren' }).click();
    await expect(dialog.getByLabel('Grund (Pflicht)')).toBeFocused(); await expect(dialog).toContainText('genau 24 Stunden');
    await dialog.getByLabel('Grund (Pflicht)').fill('Wechselrichter meldet Fehler F42'); await foto('Admin-Notfall');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Kunststoffwerk Ahrenberg GmbH', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Notfall-Zugriff', exact: true })).toBeFocused();
    expect(fehler).toEqual([]);
    async function foto(name: string) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (info.repeatEachIndex === 1) { mkdirSync(bilder, { recursive: true }); await page.screenshot({ path: `${bilder}/${name}-${breite}-${browserName}.png`, animations: 'disabled', fullPage: false }); }
    }
  });
}
