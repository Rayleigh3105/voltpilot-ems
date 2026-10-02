import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * **MiSpeL · Simulator-Durchstich** (MP-22, E6 = D) — der Browser-Beweis am Ende der Kette: ein Monat der
 * Simulator-Anlage (Optimierer im Mischbetrieb → Plan zur Box → Monatslauf MP-8) in der echten `ErloeseSection` bei
 * 375 und 1440 px. Die Karte zeigt die Mengen des Rechenwerks (Fixture = Antwort der Route aus
 * `MispelDurchstichSimulatorTest`), Stand „vorläufig · Gerätewerte“ (keine Werte des Messstellenbetreibers, T S. 28),
 * und der Nachweis geht über die Routen von MP-16 als Vorschau. Mit `MISPEL_FOTOS=<ordner>` legt der Lauf Fotos ab.
 */
// Gelesen statt importiert: der Test-Lader verlangt für JSON-Module ein Import-Attribut.
const FX = JSON.parse(readFileSync(new URL('./mispel-durchstich-fixtures.json', import.meta.url), 'utf8')) as {
  'monat-2026-10': {
    stand: string;
    teile: Array<{ farben: Array<{ farbe: string; formel: string; kwh: number }>; einspeisung: { kwh: number } }>;
  };
};
const MONAT = FX['monat-2026-10'];
const NBSP = String.fromCharCode(160);
const kwh = (v: number) => `${Math.round(v).toLocaleString('de-DE')}${NBSP}kWh`;
const FOTOS = process.env.MISPEL_FOTOS;

async function oeffne(page: Page, breite: number) {
  await page.setViewportSize({ width: breite, height: breite < 600 ? 812 : 900 });
  await page.goto(`/e2e/mispel-durchstich.html?z=monat&at=2026-10-15&jetzt=${encodeURIComponent('2026-11-03T09:00:00+01:00')}`);
  await expect(page.locator('main[data-buehne="mispel-durchstich"]')).toBeVisible();
}

const karte = (page: Page) => page.getByRole('region', { name: 'MiSpeL · Mengen nach Anlage 1' });

async function foto(page: Page, name: string) {
  if (!FOTOS || test.info().project.name !== 'desktop-chromium') return;
  // Ganzseitig zugeschnitten statt Element-Foto: so legt sich die klebende Zeitraum-Leiste nicht über die Karte.
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = (await karte(page).boundingBox())!;
  await page.screenshot({ path: join(FOTOS, `${name}.png`), fullPage: true, clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
}

for (const breite of [1440, 375]) {
  test(`Oktober 2026 der Simulator-Anlage bei ${breite} px: die Mengen des Rechenwerks, vorläufig`, async ({ page }) => {
    await oeffne(page, breite);
    const k = karte(page);
    await expect(k.getByRole('heading', { name: 'MiSpeL · Mengen nach Anlage 1 · Oktober 2026' })).toBeVisible();
    await expect(k.getByText('vorläufig · Gerätewerte')).toBeVisible();
    const teil = MONAT.teile[0];
    await expect(k.getByText(kwh(teil.einspeisung.kwh), { exact: true })).toBeVisible();
    expect(teil.farben.map((f) => f.farbe)).toEqual(['gruen', 'gelb', 'rot', 'grau']);
    for (const f of teil.farben) {
      await expect(k.locator(`[data-farbe="${f.farbe}"]`)).toContainText(kwh(f.kwh));
    }
    await expect(k.locator('[data-farbe="rot"]')).toContainText('(16) Saldierungsfähige Netzeinspeisung im Kalendermonat');
    const breiten = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    expect(breiten.s).toBeLessThanOrEqual(breiten.c);
    await foto(page, `karte-${breite}`);
    if (breite === 1440) {
      await k.getByRole('button', { name: 'Vorschau (PDF)' }).click();
      expect(await page.evaluate(() => (window as unknown as { __nachweise: unknown[] }).__nachweise)).toEqual([
        ['simulator-anlage', '2026-10', 'netzbetreiber', 'pdf'],
      ]);
    }
  });
}
