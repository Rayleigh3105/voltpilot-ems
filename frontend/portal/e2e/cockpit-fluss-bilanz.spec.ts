import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

/**
 * Der Fluss geht auf (Schramm „Zuhause“, 07.11.2026 14:20, fiktiv nachgestellt): vorher „Erzeugung 1,2 kW ·
 * Bezug 5,9 kW · Verbrauch 9,6 kW“ und „Sonne deckt 12 %“, weil eine PV-Zuordnung am PIKO die ganze Sonne ersetzte.
 */
const NB = ' ';
const knoten = (page: Page, rolle: string) => page.locator(`.vp-lp-k-${rolle}`);

async function ohneUeberlauf(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(await page.locator('main').evaluate((el) => [...el.querySelectorAll('*')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
  }).length)).toBe(0);
}

for (const width of [375, 1440]) {
  test(`die Zuordnung am PIKO: Erzeugung + Bezug = Verbrauch bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    await page.goto('/e2e/cockpit-fluss-bilanz.html?fall=zuordnung');
    await expect(page.locator('.vp-lp')).toBeVisible();
    await expect(knoten(page, 'pv')).toHaveAttribute('aria-label', `Sonne: 3,7${NB}kW, Erzeugung`);
    await expect(knoten(page, 'grid')).toHaveAttribute('aria-label', `Netz: 5,9${NB}kW, Bezug`);
    await expect(knoten(page, 'load')).toHaveAttribute('aria-label', `Haus: 9,6${NB}kW, Verbrauch`);
    await expect(page.locator('.vp-eb-satz')).toHaveText(`Sonne deckt 38${NB}% des Verbrauchs, der Rest kommt aus dem Netz.`);
    await expect(page.locator('.vp-eb-luecke')).toHaveCount(0);
    // „Verbrauch im Detail“ bleibt das Haus der Box (9,6 kW) - dieselbe Zahl wie am Knoten.
    const detail = page.locator('.vp-eb-listen');
    await expect(detail).toContainText('Verbrauch im Detail');
    await expect(detail).toContainText(`9,6${NB}kW`);
    for (const z of ['UV Halle', 'UV Keller', 'übriger Haushalt']) await expect(detail).toContainText(z);
    await ohneUeberlauf(page);
    if (process.env.BILANZ_BILDER) {
      await mkdir(process.env.BILANZ_BILDER, { recursive: true });
      await page.screenshot({ path: `${process.env.BILANZ_BILDER}/zuordnung-${width}.png`, fullPage: true });
    }
    // Das Blatt der Sonne: der zugeordnete PIKO und die drei KACO mit ihrer Messung, Summe = Knoten.
    await knoten(page, 'pv').click();
    const blatt = page.getByRole('dialog');
    await expect(blatt.locator('.vp-rolle-pv')).toContainText('Kostal PIKO Scheune');
    for (const name of ['Kaco Ost', 'Kaco Mitte', 'Kaco West']) await expect(blatt).toContainText(name);
    await expect(blatt).toContainText('Geräte ohne Zuordnung zählen mit ihrer eigenen Messung.');
    if (process.env.BILANZ_BILDER) await page.screenshot({ path: `${process.env.BILANZ_BILDER}/zuordnung-blatt-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(blatt).toHaveCount(0);
    expect(fehler).toEqual([]);
  });

  test(`ein KACO meldet sich nicht: er wird genannt statt still gezählt bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    await page.goto('/e2e/cockpit-fluss-bilanz.html?fall=veraltet');
    await expect(page.locator('.vp-lp')).toBeVisible();
    await expect(knoten(page, 'pv')).toHaveAttribute('aria-label', `Sonne: 3,0${NB}kW, Erzeugung`);
    await expect(knoten(page, 'load')).toHaveAttribute('aria-label', `Haus: 8,9${NB}kW, Verbrauch`);
    await expect(page.locator('.vp-eb-luecke')).toHaveText('Nicht mitgezählt: Kaco West (meldet sich gerade nicht).');
    await ohneUeberlauf(page);
    if (process.env.BILANZ_BILDER) await page.screenshot({ path: `${process.env.BILANZ_BILDER}/veraltet-${width}.png`, fullPage: true });
    expect(fehler).toEqual([]);
  });

  test(`Werte, die nicht zusammenpassen, bekommen keine Prozente bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    await page.goto('/e2e/cockpit-fluss-bilanz.html?fall=teilverbrauch');
    await expect(page.locator('.vp-lp')).toBeVisible();
    await expect(page.locator('.vp-eb-satz')).toHaveText(
      `Die Werte passen gerade nicht zusammen: Erzeugung und Bezug liefern 9,6${NB}kW, der Verbrauch zeigt 7,9${NB}kW. ` +
        'Darum rechnet das Cockpit keine Anteile aus.',
    );
    // Unter dem Fluss steht die Aufschlüsselung der Zuordnung - dieselbe Summe wie am Knoten, nicht das Haus der Box.
    await expect(knoten(page, 'load')).toHaveAttribute('aria-label', `Haus: 7,9${NB}kW, Verbrauch`);
    const detail = page.locator('.vp-eb-listen');
    await expect(detail).toContainText('Verbrauch im Detail');
    await expect(detail).toContainText(`7,9${NB}kW`);
    await expect(detail).not.toContainText(`9,6${NB}kW`);
    await ohneUeberlauf(page);
    if (process.env.BILANZ_BILDER) await page.screenshot({ path: `${process.env.BILANZ_BILDER}/teilverbrauch-${width}.png`, fullPage: true });
    expect(fehler).toEqual([]);
  });
}
