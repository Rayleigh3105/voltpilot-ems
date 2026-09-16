import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const bilder = process.env.KORREKTUR_BILDER;
test.beforeEach(async ({ page }, info) => {
  await page.setViewportSize({ width: info.project.name.startsWith('mobile') ? 375 : 1440, height: 900 });
});
async function bild(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) {
    const box = await dialog.boundingBox(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
  if (bilder) { mkdirSync(bilder, { recursive: true }); await page.screenshot({ path: join(bilder, `${name}-${page.viewportSize()!.width}.png`), fullPage: false }); }
}
async function korrektur(page: Page, params = '') {
  await page.goto(`/e2e/korrekturen.html?liste=1${params}`);
  await page.getByRole('button', { name: 'Korrekturen', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('K-2026-0007');
  await bild(page, 'liste');
  await page.getByRole('button', { name: /K-2026-0007/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Version 1 → 2');
}
test('Lückenmarker → Methode → echte Vorschau → Vorschlag; Fokus und genau ein Schreibvorgang', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/e2e/korrekturen.html');
  const ausloeser = page.getByTestId('verlauf-ereignis').getByRole('button', { name: 'Ersatzwert eintragen' });
  await ausloeser.click(); const d = page.getByRole('dialog');
  await expect(d).toContainText('1.872 kWh');
  await expect(d.getByRole('combobox', { name: 'Methode' })).toContainText('gleichmäßig');
  await d.getByLabel('Begründung', { exact: true }).fill('Box-Tausch nach Defekt; Energiekarte hat weitergezählt');
  await bild(page, 'ersatzwert');
  await d.getByRole('button', { name: 'Vorschau berechnen' }).click();
  await expect(d).toContainText('Ersatzwert prüfen');
  await expect(d).toContainText('Version 1 → 2');
  await expect(d).toContainText('Revision nötig');
  expect(await page.evaluate(() => (window as any).korrekturSchreiben.length)).toBe(0);
  await bild(page, 'vorschau');
  await d.getByRole('button', { name: 'Vorschlag speichern' }).click();
  await expect(d).toContainText('Die bisherigen Werte bleiben unverändert');
  expect(await page.evaluate(() => (window as any).korrekturSchreiben.length)).toBe(1);
  await page.keyboard.press('Escape'); await expect(d).toHaveCount(0); await expect(ausloeser).toBeFocused();
  expect(errors).toEqual([]);
});
test('Standortliste → zweite Person gibt frei → Widerruf mit Grund', async ({ page }) => {
  await korrektur(page);
  const d = page.getByRole('dialog'); await bild(page, 'pruefen');
  await d.getByRole('region', { name: 'Auswirkungen' }).scrollIntoViewIfNeeded(); await bild(page, 'auswirkungen');
  await d.getByLabel('Begründung der Entscheidung').fill('Beleg und Auswirkungen wurden geprüft');
  await d.getByRole('button', { name: 'Freigeben', exact: true }).click();
  await expect(d).toContainText('Freigegeben');
  await d.getByLabel('Grund für den Widerruf').fill('Profil aus Netzbetreiber-Lastgang verfügbar');
  await bild(page, 'widerruf');
  await d.getByRole('button', { name: 'Widerruf speichern' }).click();
  await expect(d).toContainText('Zurückgenommen');
  expect(await page.evaluate(() => (window as any).korrekturSchreiben.map((x: any) => x.status))).toEqual(['freigegeben', 'zurueckgenommen']);
});
test('Ersteller sieht Vier-Augen-Zustand; kein Freigabe-Knopf und keine versteckte Aktion', async ({ page }) => {
  await korrektur(page, '&ersteller=1&person=IK');
  const d = page.getByRole('dialog');
  await expect(d).toContainText('Freigabe durch eine zweite Person erforderlich');
  await expect(d.getByRole('button', { name: 'Freigeben', exact: true })).toHaveCount(0);
  await expect(d.getByRole('button', { name: 'Ablehnen', exact: true })).toHaveCount(0);
  await bild(page, 'vier-augen');
  await page.keyboard.press('Tab'); expect(await d.evaluate(e => e.contains(document.activeElement))).toBe(true);
});
test('Ablehnen und ein 409 erhalten den begründeten Prüfweg', async ({ page }) => {
  await korrektur(page, '&konflikt=1'); const d = page.getByRole('dialog');
  await d.getByLabel('Begründung der Entscheidung').fill('Nachlieferung ist bereits anderweitig geprüft');
  await d.getByRole('button', { name: 'Ablehnen', exact: true }).click();
  await expect(d.getByRole('alert')).toContainText('inzwischen geändert');
  await expect(d.getByLabel('Begründung der Entscheidung')).toHaveValue('Nachlieferung ist bereits anderweitig geprüft');
  await d.getByRole('button', { name: 'Ablehnen', exact: true }).click();
  await expect(d).toContainText('Abgelehnt');
});
