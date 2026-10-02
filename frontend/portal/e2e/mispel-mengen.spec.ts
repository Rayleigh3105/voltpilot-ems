import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * **MiSpeL · Mengen nach Anlage 1** (MP-18, BK-18 Variante A) — der Browser-Beweis über die echte `ErloeseSection`
 * einer Simulator-Anlage bei 375 und 1440 px: die Karte steht unter der Kennzahlleiste, zeigt die Zahlen des
 * Rechenwerks (Fixture = Antwort der Route aus `MispelMengenApiTest`), läuft nicht über, und der Nachweis geht über die
 * Routen von MP-16 hinaus. Mit `MISPEL_FOTOS=<ordner>` legt der Lauf die Fotos für die Ansicht ab.
 */
// Gelesen statt importiert: der Test-Lader verlangt für JSON-Module ein Import-Attribut.
const FX = JSON.parse(readFileSync(new URL('./mispel-mengen-fixtures.json', import.meta.url), 'utf8')) as Record<
  string,
  {
    stand: string | null;
    teile: Array<{ farben: Array<{ farbe: string; kwh: number }>; einspeisung: { kwh: number }; umlagereduziert: { kwh: number } }>;
    wert: { summeOhneMarktpraemieEur: number | null } | null;
  }
>;
const NBSP = String.fromCharCode(160);
const kwh = (v: number) => `${Math.round(v).toLocaleString('de-DE')}${NBSP}kWh`;
const eur = (v: number) => `+${NBSP}${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${NBSP}€`;
const FOTOS = process.env.MISPEL_FOTOS;

async function oeffne(page: Page, breite: number, z: 'monat' | 'jahr', at: string) {
  await page.setViewportSize({ width: breite, height: breite < 600 ? 812 : 900 });
  await page.goto(`/e2e/mispel-mengen.html?z=${z}&at=${at}&jetzt=${encodeURIComponent('2026-12-10T13:00:00+01:00')}`);
  await expect(page.locator('main[data-buehne="mispel-mengen"]')).toBeVisible();
}

const karte = (page: Page, name = 'MiSpeL · Mengen nach Anlage 1') => page.getByRole('region', { name });

async function ohneUeberlauf(page: Page) {
  const breiten = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(breiten.s).toBeLessThanOrEqual(breiten.c);
}

async function foto(page: Page, name: string, ganz = false) {
  if (!FOTOS || test.info().project.name !== 'desktop-chromium') return;
  if (ganz) {
    await page.screenshot({ path: join(FOTOS, `${name}.png`), fullPage: true });
    return;
  }
  // Ganzseitig zugeschnitten statt Element-Foto: so legt sich die klebende Zeitraum-Leiste nicht über die Karte.
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = (await karte(page, name.includes('jahr') ? 'MiSpeL · Saldierung je Monat' : undefined).boundingBox())!;
  await page.screenshot({ path: join(FOTOS, `${name}.png`), fullPage: true, clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
}

for (const breite of [1440, 375]) {
  test.describe(`MiSpeL-Karte bei ${breite} px`, () => {
    test('Monat endgültig: Zahlen des Rechenwerks mit Begriff und Formelnummer, unter der Kennzahlleiste', async ({ page }) => {
      await oeffne(page, breite, 'monat', '2026-11-15');
      const k = karte(page);
      await expect(k).toBeVisible();
      await expect(k.getByRole('heading', { name: 'MiSpeL · Mengen nach Anlage 1 · November 2026' })).toBeVisible();
      await expect(k.getByText('endgültig · Messstellenbetreiber')).toBeVisible();
      const teil = FX['monat-2026-11'].teile[0];
      await expect(k.getByText(kwh(teil.einspeisung.kwh), { exact: true })).toBeVisible();
      for (const f of teil.farben) {
        await expect(k.locator(`[data-farbe="${f.farbe}"]`)).toContainText(kwh(f.kwh));
      }
      await expect(k.locator('[data-farbe="gruen"]')).toContainText('(26) Förderfähige zeitgleiche Netzeinspeisung');
      await expect(k.locator('[data-farbe="rot"]')).toContainText('(16) Saldierungsfähige Netzeinspeisung im Kalendermonat');
      await expect(k.locator('[data-betrag="marktpraemie"]')).toHaveText('offen');
      await expect(k.locator('[data-betrag="summe"]')).toHaveText(eur(FX['monat-2026-11'].wert!.summeOhneMarktpraemieEur!));
      // Die Karte steht unter der Kennzahlleiste.
      const kpi = await page.getByRole('group', { name: /^Erlöse · / }).boundingBox();
      const box = await k.boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(kpi!.y + kpi!.height);
      // Die Balkenstücke folgen den Mengen: Grün ist das längste Stück.
      const w = await k.locator('.vp-mi-teil .vp-mi-bar i').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
      expect(w).toHaveLength(4);
      expect(Math.max(...w)).toBe(w[0]);
      // W5: kein Arbitrage-Ausweis im Preise-Fuß.
      await expect(page.getByText(/davon durch Netzladen/)).toHaveCount(0);
      await ohneUeberlauf(page);
      await foto(page, `monat-endgueltig-${breite}`);
      if (breite === 1440) await foto(page, `seite-monat-${breite}`, true);
    });

    test('Monat vorläufig: Gerätewerte, Vorschau mit Wasserzeichen-Hinweis', async ({ page }) => {
      await oeffne(page, breite, 'monat', '2026-12-05');
      const k = karte(page);
      await expect(k.getByText('vorläufig · Gerätewerte')).toBeVisible();
      await expect(k).toContainText('Vorschau aus den Werten Ihrer Geräte, Stand 10.12., 13:00');
      await expect(k).toContainText('Vermiedene Umlagen (Vorschau)');
      await expect(k.locator('[data-farbe="gelb"]')).toContainText(kwh(FX['monat-2026-12'].teile[0].farben[1].kwh));
      await k.getByRole('button', { name: 'Vorschau (PDF)' }).click();
      expect(await page.evaluate(() => (window as unknown as { __nachweise: unknown[] }).__nachweise)).toEqual([
        ['simulator-anlage', '2026-12', 'netzbetreiber', 'pdf'],
      ]);
      await ohneUeberlauf(page);
      await foto(page, `monat-vorlaeufig-${breite}`);
    });

    test('Jahr: eine Zeile je Monat, Grund der Änderung, Sprung in den Monat', async ({ page }) => {
      await oeffne(page, breite, 'jahr', '2026-11-15');
      const k = karte(page, 'MiSpeL · Saldierung je Monat');
      await expect(k.getByRole('heading', { name: 'MiSpeL · Saldierung je Monat · 2026' })).toBeVisible();
      const zeilen = k.getByRole('list', { name: 'Monate nach Anlage 1' }).getByRole('listitem');
      await expect(zeilen).toHaveCount(3);
      await expect(zeilen.nth(0)).toContainText('Dezember');
      await expect(zeilen.nth(1)).toContainText('gegenüber der Vorschau — Grund: Gerätewerte statt Werte des Messstellenbetreibers');
      await expect(zeilen.nth(2)).toContainText('Marktprämie mit Ausschließlichkeitsoption — keine Mengen nach Anlage 1');
      await expect(k.locator('[data-betrag="jahr"]')).toHaveText(eur(234.02));
      await ohneUeberlauf(page);
      await foto(page, `jahr-${breite}`);
      await zeilen.nth(1).getByRole('button', { name: 'Nachweis ›' }).click();
      await expect(karte(page).getByRole('heading', { name: /November 2026/ })).toBeVisible();
    });
  });
}

test('Telefon: der Nachweis kommt als Blatt mit Empfänger und Format', async ({ page }) => {
  await oeffne(page, 375, 'monat', '2026-11-15');
  const k = karte(page);
  await k.getByRole('button', { name: 'Nachweis holen' }).click();
  const blatt = page.getByRole('dialog', { name: 'Nachweis November 2026' });
  await expect(blatt).toBeVisible();
  await blatt.getByRole('radio', { name: /Direktvermarkter/ }).check();
  await blatt.getByRole('radio', { name: 'CSV' }).check();
  if (FOTOS && test.info().project.name === 'desktop-chromium') {
    await page.screenshot({ path: join(FOTOS, 'nachweis-blatt-375.png') });
  }
  await blatt.getByRole('button', { name: 'Herunterladen' }).click();
  await expect(blatt).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as { __nachweise: unknown[] }).__nachweise)).toEqual([
    ['simulator-anlage', '2026-11', 'direktvermarkter', 'csv'],
  ]);
});

test('Rechner: Nachweis (PDF) für den gewählten Empfänger', async ({ page }) => {
  await oeffne(page, 1440, 'monat', '2026-11-15');
  const k = karte(page);
  await k.getByRole('button', { name: 'Nachweis (PDF)' }).click();
  await k.getByRole('button', { name: 'CSV' }).click();
  expect(await page.evaluate(() => (window as unknown as { __nachweise: unknown[] }).__nachweise)).toEqual([
    ['simulator-anlage', '2026-11', 'lieferant', 'pdf'],
    ['simulator-anlage', '2026-11', 'lieferant', 'csv'],
  ]);
});
