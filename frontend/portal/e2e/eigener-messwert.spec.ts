import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * „Eigenen Messwert hinzufügen" mit der EINEN Frage „Was misst dieser Wert?" (Paket
 * vp-uems-baukasten-messwert-groesse, Schnitt 2) bei 375 und 1440 px: die echte
 * `BeobachteteRegister` auf der Bühne `e2e/eigener-messwert.html`. Geprüft wird, was das
 * Formular WIRKLICH schickt (Katalogwörter + passende Aufbewahrungsklasse) und dass Frage,
 * Hinweis und Einheiten-Satz ohne Querlauf in den Dialog passen — gemessen, nicht behauptet.
 *
 * Mit `EIGENER_MESSWERT_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab (Ansicht).
 */
const BILDER = process.env.EIGENER_MESSWERT_BILDER;

async function oeffne(page: Page, breite: number, suche = '') {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/eigener-messwert.html${suche}`);
  const dialog = page.getByRole('dialog', { name: 'Eigenen Messwert hinzufügen' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  return dialog;
}

async function querlauf(page: Page, breite: number) {
  return page.evaluate((b) => ({
    dokument: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    draussen: [...document.querySelectorAll('.vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`),
  }), breite);
}

async function bild(page: Page, breite: number, name: string) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const m = await querlauf(page, breite);
  expect(m.dokument, `${name} ${breite}: Dokument`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
}

async function waehle(page: Page, dialog: ReturnType<Page['getByRole']>, label: string) {
  const feld = dialog.getByRole('combobox', { name: 'Was misst dieser Wert?' });
  await feld.click();
  const id = await feld.getAttribute('id');
  await page.locator(`[id="${id}-liste"]`).getByRole('option', { name: label, exact: true }).click();
  await expect(feld).toContainText(label);
}

for (const breite of [375, 1440] as const) {
  test.describe(`Eigenen Messwert hinzufügen · ${breite} px`, () => {
    test('fragt „Was misst dieser Wert?" und schickt die Katalogwörter mit Zählerstand-Aufbewahrung', async ({ page }) => {
      const dialog = await oeffne(page, breite);
      await expect(dialog.getByText('Nur mit dieser Angabe bekommt der Wert eine Messstelle.')).toBeVisible();
      await bild(page, breite, 'frage');

      const feld = dialog.getByRole('combobox', { name: 'Was misst dieser Wert?' });
      await feld.click();
      const liste = page.locator(`[id="${await feld.getAttribute('id')}-liste"]`);
      await expect(liste.getByRole('option')).toHaveCount(11);
      await expect(liste.getByRole('option', { name: 'Etwas anderes (ohne Messstelle)', exact: true })).toBeVisible();
      await bild(page, breite, 'liste');
      await page.keyboard.press('Escape');

      await waehle(page, dialog, 'Energie-Zählerstand – Bezug');
      await expect(dialog.getByText('Bekommt eine Messstelle über den Messen-Assistenten. Einheit Wh, kWh oder MWh.')).toBeVisible();
      await page.getByRole('button', { name: 'Last und Volumen prüfen' }).click();
      const aufzeichnen = page.getByRole('button', { name: 'Jetzt aufzeichnen' });
      await expect(aufzeichnen).toBeEnabled();
      await bild(page, breite, 'gewaehlt');
      await aufzeichnen.click();
      await expect(dialog).toBeHidden();
      const gesendet = await page.evaluate(() => (window as unknown as { __eigeneMesswerte: Array<{ definition: Record<string, unknown> }> }).__eigeneMesswerte);
      expect(gesendet).toHaveLength(1);
      expect(gesendet[0].definition).toMatchObject({
        label: 'Zähler Druckluft', unit: 'kWh', retentionClass: 'energy_counter', readOnly: true,
        measures: { quantity: 'active_energy', direction: 'import', aggregationKind: 'counter' },
      });
    });

    test('sagt, wenn die Einheit nicht zur Antwort passt, und zeichnet dann nicht auf', async ({ page }) => {
      const dialog = await oeffne(page, breite, '?einheit=kW');
      await waehle(page, dialog, 'Energie-Zählerstand – Bezug');
      await expect(dialog.getByText('Ein Energie-Zählerstand braucht die Einheit Wh, kWh oder MWh.')).toBeVisible();
      await page.getByRole('button', { name: 'Last und Volumen prüfen' }).click();
      await expect(page.getByRole('button', { name: 'Jetzt aufzeichnen' })).toBeDisabled();
      await bild(page, breite, 'einheit');
    });

    test('„Etwas anderes" bleibt ohne Messstelle und schickt keine Angabe', async ({ page }) => {
      const dialog = await oeffne(page, breite, '?einheit=°C&label=Temperatur Schrank');
      await waehle(page, dialog, 'Etwas anderes (ohne Messstelle)');
      await expect(dialog.getByText('Der Wert wird aufgezeichnet, bekommt aber keine Messstelle.')).toBeVisible();
      await page.getByRole('button', { name: 'Last und Volumen prüfen' }).click();
      await page.getByRole('button', { name: 'Jetzt aufzeichnen' }).click();
      await expect(dialog).toBeHidden();
      const gesendet = await page.evaluate(() => (window as unknown as { __eigeneMesswerte: Array<{ definition: Record<string, unknown> }> }).__eigeneMesswerte);
      expect(gesendet[0].definition).not.toHaveProperty('measures');
      expect(gesendet[0].definition.retentionClass).toBe('live_power');
    });
  });
}
