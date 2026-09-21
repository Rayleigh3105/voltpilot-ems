import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
const BILDER = process.env.NETZANSCHLUSS_BILDER;
const ST1 = '5a1d0000-0000-4000-8000-000000000001';
async function oeffne(page: Page, breite: number, zusatz = '') {
  await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
  await page.setViewportSize({
    width: breite,
    height: breite === 375 ? 812 : 1000,
  });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&ansicht=werk-netzanschluesse&${zusatz}`);
  await expect(page.getByTestId('netzanschluesse')).toBeVisible();
  await expect(page.getByText('Wird geladen …', { exact: true })).toHaveCount(0);
}
async function foto(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.vp-na *, [role="dialog"] *')]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (r.right > innerWidth + 0.5 || r.left < -0.5);
          })
          .map((e) => e.tagName),
      ),
    )
    .toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    )
    .toBe(0);
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({
      path: join(BILDER, `${name}.png`),
      fullPage: false,
    });
  }
}
async function waehleAnlage(page: Page) {
  await page.getByRole('dialog').getByRole('combobox', { name: 'Anlage', exact: true }).click();
  await page.getByRole('option', { name: /Halle 1/ }).click();
}
for (const breite of [375, 1440]) {
  test(`Vorschlag ergänzen, atomar übernehmen und verwerfen ${breite}`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffne(page, breite, 'netz=vorschlag');
    const karte = page.locator('[data-testid^="vorschlag-"]').first();
    await expect(karte).toContainText('NA-0001');
    await foto(page, `vorschlag-${breite}`);
    await karte.getByRole('button', { name: 'Übernehmen', exact: true }).click();
    const d = page.getByRole('dialog');
    await expect(d.getByLabel('Name', { exact: true })).toHaveValue(/Netzanschluss .*Halle 1/);
    await expect(d.getByRole('combobox', { name: 'Anlage', exact: true })).toBeDisabled();
    await expect(d.getByRole('combobox', { name: 'Gilt ab', exact: true })).toContainText('12.03.2024');
    await foto(page, `vorschlag-dialog-beginn-${breite}`);
    await expect(d.getByLabel('Netzbetreiber')).toHaveValue('');
    await expect(d.getByLabel('Vereinbarte Leistung (kW)')).toHaveValue('');
    await d.getByRole('button', { name: 'Übernehmen', exact: true }).click();
    await expect(d.getByRole('combobox', { name: 'Messung', exact: true })).toBeFocused();
    await d.getByRole('combobox', { name: 'Messung', exact: true }).click();
    await page.getByRole('option', { name: 'RLM', exact: true }).click();
    await d.getByLabel('Begründung').fill('Vorhandene Anlage dem Anschluss zuordnen.');
    await d.getByLabel('Netzbetreiber').fill('Netzgesellschaft Ahrental (fiktiv)');
    await d.getByLabel('Marktlokation').fill('47110000001');
    await d.getByLabel('Anschlussleistung (kVA)').fill('630');
    await d.getByLabel('Vereinbarte Leistung (kW)').fill('550');
    await expect(d.getByText('Bitte eine gültige Angabe eingeben.')).toHaveCount(0);
    await expect(d.getByText('Bitte die rückwirkende Änderung begründen.')).toHaveCount(0);
    await foto(page, `vorschlag-dialog-${breite}`);
    await d.getByRole('button', { name: 'Übernehmen', exact: true }).click();
    await expect(d).toHaveCount(0);
    await expect(page.getByTestId('netzanschluss-NA-0001')).toContainText('ab 12.03.2024');
    await expect(page.getByRole('status')).toBeFocused();
    await page.getByTestId('netzanschluss-NA-0001').scrollIntoViewIfNeeded();
    await foto(page, `vorschlag-uebernommen-${breite}`);
    await page.locator('[data-testid^="vorschlag-"]').getByRole('button', { name: 'Verwerfen' }).click();
    await expect(page.locator('[data-testid^="vorschlag-"]')).toHaveCount(0);
    const aufrufe = await page.evaluate(() => (window as any).naAufrufe);
    expect(aufrufe.uebernehmen).toHaveLength(1);
    expect(aufrufe.uebernehmen[0].bindung_ab).toBe('2024-03-12');
    expect(aufrufe.anlegen).toHaveLength(0);
    expect(aufrufe.binden).toHaveLength(0);
    expect(aufrufe.verwerfen).toHaveLength(1);
    expect(fehler).toEqual([]);
    await oeffne(page, breite, 'netz=vorschlag&person=CB');
    await expect(page.locator('[data-testid^="vorschlag-"]')).toHaveCount(0);
  });
  test(`Liste, Anlegen und Wechsel mit Datum ${breite}`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffne(page, breite);
    await expect(page.getByTestId('netzanschluss-NA-1')).toContainText('vereinbart 550\u00a0kW · Anschluss 630\u00a0kVA');
    await expect(page.getByTestId('netzanschluss-NA-1')).toContainText('12.03.2024');
    await foto(page, `liste-${breite}`);
    await page.getByRole('button', { name: 'Netzanschluss anlegen', exact: true }).click();
    const d = page.getByRole('dialog');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d.getByLabel('Name', { exact: true })).toBeFocused();
    await d.getByLabel('Name', { exact: true }).fill('Hauptanschluss Halle 1');
    await d.getByLabel('Marktlokation', { exact: true }).fill('47110000001');
    await d.getByLabel('Netzbetreiber', { exact: true }).fill('Netzgesellschaft Ahrental (fiktiv)');
    await d.getByLabel('Anschlussleistung (kVA)', { exact: true }).fill('630');
    await d.getByLabel('Vereinbarte Leistung (kW)', { exact: true }).fill('550,45');
    await foto(page, `anlegen-${breite}`);
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d).toHaveCount(0);
    const neu = page.getByTestId('netzanschluss-NA-0004');
    await expect(neu).toContainText('Noch keine Anlage gebunden');
    await expect(neu).toContainText('vereinbart 550,45\u00a0kW · Anschluss 630\u00a0kVA');
    await neu.getByRole('button', { name: 'Anlage binden / wechseln', exact: true }).click();
    await waehleAnlage(page);
    await d.getByRole('combobox', { name: 'Gilt ab', exact: true }).click();
    await page.locator('[role="gridcell"][data-iso="2026-10-21"]').click();
    await expect(d).toContainText('Die bisherige Bindung endet am 20.10.2026.');
    await foto(page, `wechseln-${breite}`);
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d).toHaveCount(0);
    await expect(neu).toContainText('ab 21.10.2026');
    await expect(page.getByTestId('netzanschluss-NA-1')).toContainText('bis 20.10.2026');
    const aufrufe = await page.evaluate(() => (window as any).naAufrufe);
    expect(aufrufe.anlegen).toHaveLength(1);
    expect(aufrufe.anlegen[0].vereinbart_kw).toBe('550.45');
    expect(aufrufe.binden).toEqual([
      {
        anlage_id: 'a0000000-0000-4000-8000-000000000001',
        gueltig_ab: '2026-10-21',
        grund: null,
      },
    ]);
    await foto(page, `gebunden-${breite}`);
    expect(fehler).toEqual([]);
  });
  test(`Erstbindung, Rückwirkung, Picker-Escape und Fokus ${breite}`, async ({ page }) => {
    await oeffne(page, breite, 'netz=ungebunden');
    const trigger = page
      .getByTestId('netzanschluss-NA-1')
      .getByRole('button', { name: 'Anlage binden / wechseln' });
    await trigger.click();
    await waehleAnlage(page);
    const d = page.getByRole('dialog');
    await d.getByRole('combobox', { name: 'Gilt ab' }).click();
    await page.locator('[role="gridcell"][data-iso="2026-10-19"]').click();
    await expect(d).toContainText('Rückwirkend');
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d.getByLabel('Begründung')).toBeFocused();
    await d.getByLabel('Begründung').fill('Anschluss seit gestern in Betrieb.');
    await d.getByRole('combobox', { name: 'Anlage', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(d).toBeVisible();
    await expect(d.getByLabel('Begründung')).toHaveValue('Anschluss seit gestern in Betrieb.');
    await foto(page, `binden-${breite}`);
    await d.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(d).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId('netzanschluss-NA-1')).toContainText('ab 19.10.2026');
  });
  test(`Leser, leerer Zustand, Lesefehler und Konflikt ${breite}`, async ({ page }) => {
    await oeffne(page, breite, 'person=CB');
    await expect(page.getByRole('button', { name: 'Netzanschluss anlegen' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Anlage binden / wechseln' })).toHaveCount(0);
    await oeffne(page, breite, 'netz=leer');
    await expect(page.getByText('Noch kein Netzanschluss', { exact: true })).toBeVisible();
    await oeffne(page, breite, 'netz=fehler');
    await expect(page.getByRole('alert')).toContainText('konnten nicht geladen');
    await oeffne(page, breite, 'netz=konflikt');
    await page
      .getByTestId('netzanschluss-NA-1')
      .getByRole('button', { name: 'Anlage binden / wechseln' })
      .click();
    await waehleAnlage(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('überschneidet');
    await expect(page.getByRole('dialog').getByRole('alert')).toBeFocused();
  });
  test(`Bilanzkopf mit Grenz-Nachweis des Monats (AP-15 IP-31) ${breite}`, async ({ page }) => {
    await oeffne(page, breite);
    const kopf = page.getByTestId('bilanz-netzanschluss');
    await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=bilanz&an=AN-1&grenze=eingehalten');
    await expect(kopf).toContainText('vereinbart 550\u00a0kW · Anschluss 630\u00a0kVA · Grenze im September 2026 eingehalten');
    await foto(page, `bilanz-nachweis-${breite}`);
    await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=bilanz&an=AN-1&grenze=nicht_belegt');
    await expect(kopf).toContainText('Grenze im September 2026 nicht belegt');
    await foto(page, `bilanz-nicht-belegt-${breite}`);
    await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=bilanz&an=AN-1');
    await expect(kopf).toContainText('vereinbart 550\u00a0kW · Anschluss 630\u00a0kVA');
    await expect(kopf).not.toContainText('Grenze im');
  });
  test(`Bilanzkopf aus Tagesroute und Betriebskunde ohne neuen Reiter ${breite}`, async ({ page }) => {
    await oeffne(page, breite);
    await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=bilanz&an=AN-1');
    await expect(page.getByTestId('bilanz-netzanschluss')).toContainText('Netzanschluss NA-1');
    await expect(page.getByTestId('bilanz-netzanschluss')).toContainText('vereinbart 550\u00a0kW · Anschluss 630\u00a0kVA');
    await foto(page, `bilanz-${breite}`);
    await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=werk-netzanschluesse&messen=bestand');
    await expect(page.getByTestId('netzanschluesse')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Netzanschlüsse' })).toHaveCount(0);
    await expect(page.locator(`a[href="#/standort/${ST1}/netzanschluesse"]`)).toHaveCount(0);
  });
}
