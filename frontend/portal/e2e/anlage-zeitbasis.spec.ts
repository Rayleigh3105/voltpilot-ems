import { expect, test, type Page } from '@playwright/test';

/**
 * Anlagenkopf und Gerätezeilen auf EINER Zeitbasis (Bühne `e2e/anlage-zeitbasis.html`, fiktive Anlage Werkhof Linde):
 * der Kopf bildet sich aus den Zeilen, die Seite lädt `/sources` im 30-s-Takt mit, und ein nicht mehr frischer Stand
 * nennt sein Alter. Die Uhr der Seite steht (`page.clock`) - der Takt wird vorgespult, nie abgewartet.
 * Die Spec importiert keine Fixtures (sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt).
 */
/** Zahl und Einheit trennt ein geschütztes Leerzeichen, Wörter ein normales: `\s` deckt beide. */
const t = (s: string) => new RegExp(s.replace(/[.()]/g, '\\$&').replace(/ /g, '\\s'));

async function oeffne(page: Page) {
  await page.clock.install();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/anlage-zeitbasis.html');
}
const kopf = (page: Page) => page.locator('.vp-auf-t-zeile.is-anlage .vp-auf-t-summe').first();
const kopfZeile = (page: Page) => page.locator('.vp-auf-t-zeile.is-anlage').first();
const netzZeile = (page: Page) => page.locator('[data-aufbau-geraet="src-zbnetz01"]');
const abrufe = (page: Page, name: string) =>
  page.evaluate((n) => (window as unknown as { __abrufe: Record<string, number> }).__abrufe[n] ?? 0, name);
const phase = (page: Page, p: number) =>
  page.evaluate((x) => { (window as unknown as { __phase: number }).__phase = x; }, p);

test('Kopf und Netzzähler-Zeile sagen dasselbe - beim Öffnen und nach dem nächsten Abruf', async ({ page }) => {
  const fehler: string[] = [];
  page.on('console', (m) => m.type() === 'error' && fehler.push(m.text()));
  await oeffne(page);

  // Der Fall vom Screenshot: die Zeile 0,6 kW Einspeisung, der Kopf jetzt ebenso - nie „Bezug 5,4" daneben.
  await expect(netzZeile(page)).toContainText(t('0,6 kW Einspeisung'));
  await expect(kopf(page)).toContainText(t('Einspeisung 0,6 kW'));
  await expect(kopf(page)).toContainText(t('PV 7,9 kW'));
  await expect(kopf(page)).not.toContainText('Bezug');
  await expect(kopfZeile(page)).not.toContainText('Werte vor');
  const quellenVorher = await abrufe(page, 'siteSources');
  const topologieVorher = await abrufe(page, 'topology');

  // Ein Takt (30 s): `/sources` kommt mit der Topologie neu, Zeile und Kopf folgen gemeinsam.
  await phase(page, 2);
  await page.clock.runFor(30_000);
  await expect.poll(() => abrufe(page, 'siteSources')).toBe(quellenVorher + 1);
  await expect(netzZeile(page)).toContainText(t('1,2 kW Bezug'));
  await expect(kopf(page)).toContainText(t('Bezug 1,2 kW'));
  await expect(kopf(page)).not.toContainText('Einspeisung');
  expect(await abrufe(page, 'topology')).toBe(topologieVorher + 1);

  // Die Box liest nicht mehr neu: nach zwei weiteren Takten nennt der Kopf das Alter - dasselbe wie die Zeile.
  await phase(page, 3);
  await page.clock.runFor(60_000);
  await expect.poll(() => abrufe(page, 'siteSources')).toBe(quellenVorher + 3);
  await expect(kopfZeile(page)).toContainText(t('Werte vor 1 Min.'));
  await expect(netzZeile(page)).toContainText(t('vor 1 Min.'));
  expect(fehler).toEqual([]);
});

test('am Telefon: das Alter steht in der Kopfzeile der Anlage, ohne Querlauf', async ({ page }) => {
  await page.clock.install();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/e2e/anlage-zeitbasis.html');
  await expect(netzZeile(page)).toContainText(t('0,6 kW Einspeisung'));
  await phase(page, 2);
  await page.clock.runFor(30_000);
  await phase(page, 3);
  await page.clock.runFor(120_000);
  await expect(kopfZeile(page)).toContainText(t('Werte vor 2 Min.'));
  const querlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(querlauf).toBeLessThanOrEqual(0);
});
