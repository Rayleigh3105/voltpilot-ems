import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * **Der Kalender der Zeit-Leiste wird nie abgeschnitten** (Captain-Befund
 * 04.11.2026, Anlage › Energie › Tag bei 1440 px).
 *
 * Das Datum-Feld steht am RECHTEN Ende der Leiste. Das Panel nahm die Breite
 * dieses Feldes (rund 240 px), das Gitter verlangt aber KW-Spalte plus sieben
 * Tage: `overflow: hidden` schnitt Sa/So, „Nächster Monat" und den Fuß ab.
 *
 * Dazu der Monat: vorher ein waagerecht scrollender Chip-Streifen ohne Jahr im
 * ⋯-Popover (Captain: „ich weiß nicht mal, was das ist") - jetzt ein Raster
 * der zwölf Monate unter seinem Jahr, im Datum-Feld wie im ⋯-Popover.
 *
 * Gemessen auf der Prüfbühne `verlauf.html` (dieselbe Messwerte-Seite).
 */

const SEITE = (z: string) => `/e2e/verlauf.html#/anlage/help-site/messwerte?z=${z}&at=2026-08-04`;

const fehlerSammeln = (page: Page) => {
  const fehler: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  page.on('pageerror', (e) => fehler.push(String(e)));
  return fehler;
};

async function oeffne(page: Page, z: string) {
  await page.goto(SEITE(z));
  // Nur das Laden der Bühne, keine Dauer-Messung: der Dev-Server übersetzt beim ersten Abruf.
  await expect(page.locator('.vp-zeitleiste .vp-period-nav .label')).toBeVisible({ timeout: 30_000 });
}

/** Liegt `innen` vollständig in `aussen` (± 1 px Rundung)? */
async function liegtIn(innen: Locator, aussen: { x: number; y: number; width: number; height: number }) {
  const b = (await innen.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(aussen.x - 1);
  expect(b.y).toBeGreaterThanOrEqual(aussen.y - 1);
  expect(b.x + b.width).toBeLessThanOrEqual(aussen.x + aussen.width + 1);
  expect(b.y + b.height).toBeLessThanOrEqual(aussen.y + aussen.height + 1);
}

/** Das Panel steht ganz im Bild und schneidet nichts von seinem Inhalt ab. */
async function panelGanz(page: Page, panel: Locator) {
  const vp = page.viewportSize()!;
  const p = (await panel.boundingBox())!;
  await liegtIn(panel, { x: 0, y: 0, width: vp.width, height: vp.height });
  const abgeschnitten = await panel.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(abgeschnitten).toBeLessThanOrEqual(0);
  return p;
}

async function keinWaagerechterUeberlauf(page: Page) {
  const ueber = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(ueber).toBeLessThanOrEqual(0);
}

const istTelefon = (page: Page) => page.viewportSize()!.width <= 700;

/** Am Schreibtisch steht das Feld in der Leiste, am Telefon im ⋯-Blatt. */
async function feldOeffnen(page: Page, name: string) {
  if (istTelefon(page)) {
    await page.getByRole('button', { name: 'Zeitraum & Vergleich' }).click();
  }
  await page.getByRole('combobox', { name }).click();
  const panel = page.locator('.vp-picker-panel');
  await expect(panel).toBeVisible();
  // Das Telefon-Blatt fährt ein: erst nach der Einblendung messen.
  await panel.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  return panel;
}

for (const breite of [1440, 1280, 1024]) {
  test(`Tag bei ${breite} px: alle sieben Wochentage und beide Blätter-Knöpfe sind sichtbar`, async ({ page }) => {
    test.skip(istTelefon(page), 'Schreibtisch-Fall; das Telefon hat seinen eigenen');
    const fehler = fehlerSammeln(page);
    await page.setViewportSize({ width: breite, height: 900 });
    await oeffne(page, 'tag');
    const feld = page.getByRole('combobox', { name: 'Tag wählen' });
    const f = (await feld.boundingBox())!;
    const panel = await feldOeffnen(page, 'Tag wählen');
    const p = await panelGanz(page, panel);

    for (const tag of ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']) {
      await liegtIn(panel.getByRole('columnheader', { name: tag, exact: true }), p);
    }
    await liegtIn(panel.getByRole('button', { name: 'Voriger Monat' }), p);
    await liegtIn(panel.getByRole('button', { name: 'Nächster Monat' }), p);
    await liegtIn(panel.getByRole('button', { name: 'Heute' }), p);
    // Am rechten Rand der Leiste: das Panel endet bündig mit dem Feld, nicht dahinter.
    if (f.x + p.width > breite - 12) {
      expect(Math.abs(p.x + p.width - (f.x + f.width))).toBeLessThanOrEqual(1);
    }
    await keinWaagerechterUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

test('Tag am Telefon bei 375 px: das Blatt zeigt alle sieben Wochentage und beide Blätter-Knöpfe', async ({ page }) => {
  test.skip(!istTelefon(page), 'Telefon-Fall');
  const fehler = fehlerSammeln(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await oeffne(page, 'tag');
  const panel = await feldOeffnen(page, 'Tag wählen');
  await expect(panel).toHaveClass(/is-sheet/);
  const p = await panelGanz(page, panel);
  for (const tag of ['Mo', 'So']) {
    await liegtIn(panel.getByRole('columnheader', { name: tag, exact: true }), p);
  }
  await liegtIn(panel.getByRole('button', { name: 'Voriger Monat' }), p);
  await liegtIn(panel.getByRole('button', { name: 'Nächster Monat' }), p);
  await keinWaagerechterUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('Woche: das Panel steht ganz im Bild, beide Blätter-Knöpfe sichtbar', async ({ page }) => {
  const fehler = fehlerSammeln(page);
  await page.setViewportSize(istTelefon(page) ? { width: 375, height: 812 } : { width: 1440, height: 900 });
  await oeffne(page, 'woche');
  const panel = await feldOeffnen(page, 'Woche wählen');
  const p = await panelGanz(page, panel);
  await liegtIn(panel.getByRole('columnheader', { name: 'So', exact: true }), p);
  await liegtIn(panel.getByRole('button', { name: 'Nächster Monat' }), p);
  await keinWaagerechterUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('Monat: zwölf Monate unter ihrem Jahr, das Jahr blättert, kein Tagesgitter', async ({ page }) => {
  const fehler = fehlerSammeln(page);
  await page.setViewportSize(istTelefon(page) ? { width: 375, height: 812 } : { width: 1440, height: 900 });
  await oeffne(page, 'monat');
  const panel = await feldOeffnen(page, 'Monat wählen');
  const p = await panelGanz(page, panel);
  const raster = panel.getByRole('grid', { name: 'Monat wählen' });
  await expect(raster.getByRole('gridcell')).toHaveCount(12);
  await expect(panel.getByRole('columnheader')).toHaveCount(0);
  await expect(panel.getByText('2026', { exact: true })).toBeVisible();
  await expect(raster.getByRole('gridcell', { name: 'August 2026' })).toHaveAttribute('aria-selected', 'true');
  await liegtIn(panel.getByRole('button', { name: 'Voriges Jahr' }), p);
  await liegtIn(panel.getByRole('button', { name: 'Nächstes Jahr' }), p);
  for (const m of await raster.getByRole('gridcell').all()) await liegtIn(m, p);

  await raster.getByRole('gridcell', { name: 'Juni 2026' }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator('.vp-period-nav .label')).toContainText('Juni 2026');
  await keinWaagerechterUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('⋯ im Tag: der Monats-Sprung ist ein Raster mit Jahr, ohne Scroll-Leiste und ohne Tooltip', async ({ page }) => {
  test.skip(istTelefon(page), 'das Popover ist die Schreibtisch-Fassung des ⋯-Blatts');
  const fehler = fehlerSammeln(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await oeffne(page, 'tag');
  await page.getByRole('button', { name: 'Monat, Vergleich & Datenlage' }).click();
  const pop = page.getByRole('dialog', { name: 'Zeitraum & Vergleich' });
  const raster = pop.getByRole('grid', { name: 'Monat anspringen' });
  await expect(raster.getByRole('gridcell')).toHaveCount(12);
  await expect(pop.getByText('2026', { exact: true })).toBeVisible();
  await expect(pop.locator('.vp-mstrip')).toHaveCount(0);
  await expect(raster.locator('[title]')).toHaveCount(0);
  const b = (await pop.boundingBox())!;
  await liegtIn(pop, { x: 0, y: 0, width: 1440, height: 900 });
  for (const m of await raster.getByRole('gridcell').all()) await liegtIn(m, b);
  const quer = await raster.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(quer).toBeLessThanOrEqual(0);

  await raster.getByRole('gridcell', { name: 'Juli 2026' }).click();
  await expect(pop).toBeHidden();
  await expect(page.locator('.vp-period-nav .label')).toContainText('07.2026');
  expect(fehler).toEqual([]);
});
