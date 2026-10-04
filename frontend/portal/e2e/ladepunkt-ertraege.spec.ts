import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * **Ladepunkt · Erträge im Monat** und **Was kann dieser Ladepunkt?** (MiSpeL MP-41a, BK-41 „in allen Varianten
 * gleich“) — der Browser-Beweis bei 375 und 1440 px: die Karte steht in Verlauf › Erlöse unter der MiSpeL-Karte von
 * MP-18, zeigt die Mengen nach Anlage 1 mit Formelnummer, und eine Summe gegenüber „das Auto lädt nur“ nur dann, wenn
 * der Vergleich (Messlatte, MP-33d) da ist. Dazu der echte Dialog aus Anlage › Aufbau. Kein Überlauf. Mit
 * `LADEPUNKT_FOTOS=<ordner>` legt der Lauf die Fotos für die Ansicht ab.
 */
// Gelesen statt importiert: der Test-Lader verlangt für JSON-Module ein Import-Attribut.
const FX = JSON.parse(readFileSync(new URL('./ladepunkt-ertraege-fixtures.json', import.meta.url), 'utf8')) as Record<
  string,
  { vergleich?: { summe_eur: number | null } }
>;
const NBSP = String.fromCharCode(160);
const FOTOS = process.env.LADEPUNKT_FOTOS;

async function oeffne(page: Page, breite: number, query: string) {
  await page.setViewportSize({ width: breite, height: breite < 600 ? 812 : 900 });
  await page.goto(`/e2e/ladepunkt-ertraege.html?${query}&jetzt=${encodeURIComponent('2026-12-10T13:00:00+01:00')}`);
  await expect(page.locator('main[data-buehne="ladepunkt-ertraege"]')).toBeVisible();
}

const karte = (page: Page) => page.getByRole('region', { name: 'Erträge am Ladepunkt' });

async function ohneUeberlauf(page: Page) {
  const breiten = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(breiten.s).toBeLessThanOrEqual(breiten.c);
}

async function foto(page: Page, name: string, element?: ReturnType<typeof karte>) {
  if (!FOTOS || test.info().project.name !== 'desktop-chromium') return;
  if (!element) {
    await page.screenshot({ path: join(FOTOS, `${name}.png`) });
    return;
  }
  // Ganzseitig zugeschnitten statt Element-Foto: so legt sich die klebende Zeitraum-Leiste nicht über die Karte.
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = (await element.boundingBox())!;
  await page.screenshot({ path: join(FOTOS, `${name}.png`), fullPage: true, clip: { x: Math.max(0, box.x - 8), y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
}

for (const breite of [1440, 375]) {
  test.describe(`Ladepunkt-Erträge bei ${breite} px`, () => {
    test('mit Messlatte: Mengen nach Anlage 1, Posten und die Summe gegenüber nur laden — unter der MiSpeL-Karte', async ({ page }) => {
      await oeffne(page, breite, 'messlatte=mit');
      const k = karte(page);
      await expect(k).toBeVisible();
      await expect(k.getByRole('heading', { name: 'Ladepunkt · Wallbox Garage · November 2026' })).toBeVisible();
      // Die Karte steht unter der MiSpeL-Karte von MP-18.
      const mispel = (await page.getByRole('region', { name: 'MiSpeL · Mengen nach Anlage 1' }).boundingBox())!;
      expect((await k.boundingBox())!.y).toBeGreaterThan(mispel.y);
      await expect(k.locator('[data-menge="geladen"]')).toContainText('(5) Verbrauch im Stromspeicher und/oder Ladepunkt im Kalendermonat');
      await expect(k.locator('[data-menge="fremd"]')).toContainText('Strom von anderswo — zählt nicht');
      await expect(k.locator('[data-menge="fremd"]')).toContainText(`10${NBSP}kWh`);
      await expect(k.locator('[data-betrag="mehr_geladen"]')).toHaveText(`−${NBSP}22,61${NBSP}€`);
      await expect(k.locator('[data-betrag="marktpraemie"]')).toHaveText('offen');
      const summe = FX['ertrag-mit'].vergleich!.summe_eur!;
      await expect(k.locator('[data-betrag="summe"]')).toHaveText(`+${NBSP}${summe.toLocaleString('de-DE', { minimumFractionDigits: 2 })}${NBSP}€`);
      await expect(k.getByText('Gesetzesfassung wird geprüft.', { exact: false })).toBeVisible();
      // Kleine Mengen mit einer Nachkommastelle wie im Bedienkonzept, Umlagen und Netzentgelt brutto.
      await expect(k.locator('[data-menge="gelb"]')).toContainText(`10,2${NBSP}kWh`);
      await expect(k.getByText('inkl. 19 % USt', { exact: false }).first()).toBeVisible();
      await ohneUeberlauf(page);
      await foto(page, `ertrag-mit-${breite}`, k);
      // Die ganze Seite: Verlauf › Erlöse mit der MiSpeL-Karte (MP-18) und darunter dem Ladepunkt.
      if (FOTOS && breite === 1440 && test.info().project.name === 'desktop-chromium') {
        await page.screenshot({ path: join(FOTOS, 'erloese-kontext-1440.png'), fullPage: true });
      }
    });

    test('ohne Messlatte: Mengen und Posten, aber keine Summe und kein Minus', async ({ page }) => {
      await oeffne(page, breite, 'messlatte=ohne');
      const k = karte(page);
      await expect(k).toBeVisible();
      await expect(k.locator('[data-betrag="summe"]')).toHaveText('offen');
      for (const id of ['weniger_gekauft', 'mehr_geladen', 'ins_netz_verkauft', 'akku_verschleiss']) {
        await expect(k.locator(`[data-betrag="${id}"]`)).toHaveText('offen');
      }
      await expect(k.locator('[data-betrag="vermiedene_umlagen"]')).toHaveText(`+${NBSP}0,48${NBSP}€`);
      await expect(k.locator('[data-hinweis="ohne-vergleich"]')).toContainText('in dem das Auto nur lädt');
      expect(await k.textContent()).not.toMatch(/−\s?\d/);
      await ohneUeberlauf(page);
      await foto(page, `ertrag-ohne-${breite}`, k);
    });

    test('Anlage › Aufbau: was der Ladepunkt kann, ab einem Tag, mit der Einordnung nach Anlage 1', async ({ page }) => {
      await oeffne(page, breite, 'ansicht=aufbau');
      if (breite > 600) await page.setViewportSize({ width: breite, height: 1120 });
      const d = page.getByRole('dialog');
      await expect(d).toBeVisible();
      await expect(d.getByText('Wallbox Garage · Zurückspeisen')).toBeVisible();
      await expect(d.getByRole('radio', { name: 'Laden und zurückspeisen' })).toHaveAttribute('aria-checked', 'true');
      await expect(d.getByRole('checkbox', { name: /Ins Haus \(V2H\)/ })).toBeChecked();
      await expect(d.getByRole('checkbox', { name: /Ins Netz \(V2G\)/ })).toBeChecked();
      await expect(d.getByRole('checkbox', { name: /Rückspeisen stoppen/ })).toBeDisabled();
      await expect(d.getByLabel('Höchste Rückspeiseleistung (kW)')).toHaveValue('11');
      await expect(d.getByText('Zählt wie ein Stromspeicher — Ladepunkt der Festlegung (A1 S. 26).')).toBeVisible();
      await expect(d.getByText('Ob ein Auto zurückspeisen kann, prüft die Wallbox beim Anstecken.')).toBeVisible();
      await ohneUeberlauf(page);
      await foto(page, `aufbau-${breite}`);
      if (breite < 600) {
        await d.getByText('Ob ein Auto zurückspeisen kann, prüft die Wallbox beim Anstecken.').scrollIntoViewIfNeeded();
        await foto(page, `aufbau-${breite}-unten`);
      }
      await d.getByRole('button', { name: 'Speichern' }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { __gesendet: unknown[] }).__gesendet.length)).toBe(1);
      const gesendet = await page.evaluate(() => (window as unknown as { __gesendet: unknown[][] }).__gesendet[0]);
      expect(gesendet[2]).toEqual({
        nutzbarkeit: 'bidirektional',
        v2h: true,
        v2g: true,
        rueckspeisung_bei_einspeisung_unterbunden: false,
        rueckspeiseleistung_kw: 11,
        gueltig_ab: '2026-11-15',
      });
    });
  });
}
