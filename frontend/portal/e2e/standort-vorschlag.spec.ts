import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/** AP-02 IP-10: sichtbarer A6/A15-Fluss bei 375 und 1440 px. */
const BILDER = process.env.STANDORT_VORSCHLAG_BILDER;

async function ruhe(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function oeffne(page: Page, breite: 375 | 1440) {
  await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await page.goto('/e2e/startansicht.html?bild=bestand-mehrere&vorschlag=offen&vorschauart=steuerkunde');
  await expect(page.getByText('Noch nicht zugeordnet').first()).toBeVisible();
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `standort-vorschlag-karte-${breite}.png`) });
  }
  await page.getByRole('button', { name: 'Standorte einrichten' }).click();
  await expect(page.getByRole('heading', { name: 'Vorschau: Ihre Anlagen und Standorte' })).toBeVisible();
  await ruhe(page);
}

async function adressenErgaenzen(page: Page) {
  const strassen = page.getByLabel('Straße und Hausnummer *');
  const plz = page.getByLabel('PLZ');
  const orte = page.getByLabel('Ort *');
  for (let i = 0; i < await strassen.count(); i++) {
    await strassen.nth(i).fill(i === 0 ? 'Industriestraße 4' : 'Werkstraße 8');
    await plz.nth(i).fill(i === 0 ? '84347' : '84123');
    await orte.nth(i).fill(i === 0 ? 'Pfarrkirchen' : 'Ahrenberg');
  }
}

for (const breite of [375, 1440] as const) {
  test(`Mehr-Anlagen-Kunde bestätigt zwei Standorte (${breite} px)`, async ({ page }) => {
    await oeffne(page, breite);
    await adressenErgaenzen(page);
    const dialog = page.getByRole('dialog', { name: 'Standorte einrichten' });
    await expect(dialog.getByText('Werk Ahrenberg – Halle 1', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Werk Ahrenberg – Halle 2', { exact: true })).toBeVisible();
    await expect(page.getByText('Bis Sie bestätigen, ändert sich nichts')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Was sich ändert' })).toBeVisible();
    await expect(dialog).toContainText('Ihre Startseite wird die Unternehmens-Übersicht.');
    await expect(dialog).toContainText('Erlöse und Kosten finden Sie weiter im Cockpit jeder Anlage, im Portfolio und unter Erlöse.');
    await expect(dialog).toContainText('An Steuerung, Fahrplänen und Freigaben ändert sich nichts.');

    if (BILDER) {
      await dialog.locator('.dbody').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.screenshot({ path: join(BILDER, `standort-vorschlag-vorschau-${breite}.png`) });
    }

    await page.getByRole('button', { name: 'Zuordnung bestätigen' }).click();
    await expect(page.getByText('Noch nicht zugeordnet')).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Kunststoffwerk Ahrenberg GmbH' })).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio');
    await ruhe(page);
    if (BILDER) await page.screenshot({ path: join(BILDER, `standort-vorschlag-bestaetigt-${breite}.png`) });
  });

  test(`reiner Messkunde liest in derselben Vorschau nur die Startseiten-Änderung (${breite} px)`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
    await page.goto('/e2e/startansicht.html?bild=bestand-mehrere&vorschlag=offen&vorschauart=messkunde');
    await page.getByRole('button', { name: 'Standorte einrichten' }).click();
    const dialog = page.getByRole('dialog', { name: 'Standorte einrichten' });
    await expect(dialog.getByRole('heading', { name: 'Was sich ändert' })).toBeVisible();
    await expect(dialog).toContainText('Ihre Startseite wird die Unternehmens-Übersicht.');
    await expect(dialog).not.toContainText('Erlöse');
    await expect(dialog).not.toContainText('Steuerung');
    await expect(dialog).not.toContainText('Fahrplänen');
    await ruhe(page);
    if (BILDER) {
      await dialog.locator('.dbody').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.screenshot({ path: join(BILDER, `standort-vorschlag-messkunde-${breite}.png`) });
    }
  });
}

test('reine Verbrauchsanlage mit Tarif: Ebenen-Übersicht bleibt ohne Geld', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/startansicht.html?bild=bestand-mehrere&vorschlag=offen&vorschauart=verbrauch');
  await page.getByRole('button', { name: 'Standorte einrichten' }).click();
  await expect(page.getByRole('heading', { name: 'Vorschau: Ihre Anlagen und Standorte' })).toBeVisible();
  await adressenErgaenzen(page);
  await page.getByRole('button', { name: 'Zuordnung bestätigen' }).click();
  await expect(page.getByRole('heading', { name: 'Kunststoffwerk Ahrenberg GmbH' })).toBeVisible();
  await ruhe(page);
  const main = page.locator('.vp-main');
  await expect(main).not.toContainText('Erlös heute');
  await expect(main).not.toContainText('Vorteil heute');
  await expect(main).not.toContainText('€');
  if (BILDER) await page.screenshot({ path: join(BILDER, 'verbrauch-ebenen-uebersicht-ohne-geld-1440.png') });
});

test('reine Verbrauchsanlage mit Tarif: Cockpit-Kosten bleiben vor und nach der Bestätigung zeichengleich', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const karte = page.locator('[data-frame="cockpit-leiste"]');
  await page.goto('/e2e/cockpit-erloes.html?verbrauch=1&standorte=vorher');
  await expect(karte).toContainText('Kosten');
  const vorher = await karte.innerText();
  if (BILDER) await karte.screenshot({ path: join(BILDER, 'verbrauch-cockpit-kosten-vorher-1440.png') });

  await page.goto('/e2e/cockpit-erloes.html?verbrauch=1&standorte=nachher');
  await expect(karte).toContainText('Kosten');
  expect(await karte.innerText()).toBe(vorher);
  if (BILDER) await karte.screenshot({ path: join(BILDER, 'verbrauch-cockpit-kosten-nachher-1440.png') });
});
