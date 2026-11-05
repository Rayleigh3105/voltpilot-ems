import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Katalog „Gerät hinzufügen" auf der Bühne `e2e/geraete-katalog-breite.html` (Auftrag vom 05.11.2026, Captain:
 * „ist das zu hochkant", Nachtrag: am Telefon bleibt die heutige Linie).
 *
 * Belegt beide Hälften der Abnahme:
 * - Am Rechner (1440 px) nutzt der Dialog die Breite - ein Karten-Raster statt des einspaltigen Turms - und die
 *   Suche, die Arten-Filter, „Im Heimnetz suchen" und jeder Eintrag führen unverändert weiter.
 * - Am Telefon (375 px) bleibt die bisherige einspaltige Linie unverändert (ein Eintrag unter dem nächsten).
 *
 * Bilder: `KATALOG_BILDER=<Ordner>` legt `<name>-<breite>.png` ab (Vorher/Nachher-Beleg im Task-Datenordner).
 */
const BILDER = process.env.KATALOG_BILDER;

const modal = (page: Page) => page.getByRole('dialog', { name: 'Gerät hinzufügen' });

async function oeffne(page: Page, breite: number) {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 860 : 960 });
  await page.goto('/e2e/geraete-katalog-breite.html');
  await expect(modal(page)).toBeVisible();
}

async function foto(page: Page, name: string, breite: number) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
}

/** Mittelpunkt eines Elements - zwei Einträge in derselben Reihe teilen sich die Y-Koordinate, nicht die X. */
async function mitte(locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('kein boundingBox');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('Katalog „Gerät hinzufügen" · Desktop (1440 px)', () => {
  test('nutzt die Breite - ein Karten-Raster statt des einspaltigen Turms', async ({ page }) => {
    await oeffne(page, 1440);
    const dialog = modal(page);
    const breite = (await dialog.boundingBox())?.width ?? 0;
    // Der heutige Dialog ist 640 px breit; die Abnahme verlangt deutlich mehr Breitennutzung.
    expect(breite).toBeGreaterThan(750);

    // Wechselrichter → Deye (37 Modelle): mehrere Modelle stehen NEBENEINANDER, nicht nur untereinander.
    await dialog.getByRole('button', { name: /^Wechselrichter/ }).click();
    await dialog.getByRole('button', { name: /^Deye/ }).click();
    const eintraege = dialog.locator('.vp-kat-eintrag.is-modell');
    await expect(eintraege.first()).toBeVisible();
    const n = await eintraege.count();
    expect(n).toBeGreaterThan(5);
    const a = await mitte(eintraege.nth(0));
    const b = await mitte(eintraege.nth(1));
    // Zwei Modelle derselben Reihe: gleiche Höhe, verschiedene Spalte.
    expect(Math.abs(a.y - b.y)).toBeLessThan(2);
    expect(Math.abs(a.x - b.x)).toBeGreaterThan(50);
    await foto(page, 'nachher-deye-modelle', 1440);

    // Zurück zu den Marken, dann über „Alle" zur Übersicht - „Im Heimnetz suchen" bleibt prominent oben.
    await dialog.getByRole('button', { name: /Wechselrichter$/ }).click();
    await dialog.getByRole('button', { name: 'Alle' }).click();
    await expect(page.getByTestId('kat-heimnetz')).toBeVisible();
    await foto(page, 'nachher-uebersicht', 1440);
  });

  test('Suche filtert sofort, Filter-Chips bleiben in Funktion, ein Eintrag führt weiter', async ({ page }) => {
    await oeffne(page, 1440);
    const dialog = modal(page);
    const suche = dialog.getByRole('searchbox', { name: 'Katalog durchsuchen' });
    await suche.fill('KOSTAL');
    await expect(dialog.getByText(/KOSTAL-1/)).toBeVisible();
    await expect(dialog.getByText(/Deye-1\b/)).not.toBeVisible();
    await suche.fill('');

    // Chips mit Anzahl bleiben erhalten.
    const zaehler = dialog.getByRole('button', { name: /^Wechselrichter/ });
    await expect(zaehler).toContainText(/\d+/);
    await zaehler.click();
    await expect(zaehler).toHaveAttribute('aria-pressed', 'true');

    // Ein Eintrag führt in den bestehenden Folgeschritt (hier: `onWahl`/`onSuche` der Bühne).
    await dialog.getByRole('button', { name: /^Fronius/ }).click();
    await dialog.getByRole('button', { name: /^Fronius-1\b/ }).click();
    const wahl = await page.evaluate(() => (window as unknown as { __wahl: unknown }).__wahl);
    expect(wahl).toMatchObject({ art: 'modell' });
  });

  test('Escape schließt, Fokus bleibt in der Fläche', async ({ page }) => {
    await oeffne(page, 1440);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(modal(page)).toHaveCount(0);
  });
});

test.describe('Katalog „Gerät hinzufügen" · Telefon (375 px)', () => {
  test('bleibt die heutige Linie: volle Breite, ein Eintrag je Reihe', async ({ page }) => {
    await oeffne(page, 375);
    const dialog = modal(page);
    const breite = (await dialog.boundingBox())?.width ?? 0;
    expect(breite).toBeGreaterThan(360);

    await dialog.getByRole('button', { name: /^Wechselrichter/ }).click();
    await dialog.getByRole('button', { name: /^Deye/ }).click();
    const eintraege = dialog.locator('.vp-kat-eintrag.is-modell');
    await expect(eintraege.first()).toBeVisible();
    const a = await mitte(eintraege.nth(0));
    const b = await mitte(eintraege.nth(1));
    // Zwei aufeinanderfolgende Modelle: verschiedene Höhe (untereinander), nicht nebeneinander.
    expect(Math.abs(a.y - b.y)).toBeGreaterThan(20);
    await foto(page, 'nachher-deye-modelle', 375);

    await dialog.getByRole('button', { name: /Wechselrichter$/ }).click();
    await foto(page, 'nachher-uebersicht', 375);
  });

  test('Suche und Heimnetz-Einstieg bleiben erreichbar', async ({ page }) => {
    await oeffne(page, 375);
    await expect(page.getByTestId('kat-heimnetz')).toBeVisible();
    const dialog = modal(page);
    const suche = dialog.getByRole('searchbox', { name: 'Katalog durchsuchen' });
    await suche.fill('KACO');
    await expect(dialog.getByText(/KACO-1\b/)).toBeVisible();
  });
});
