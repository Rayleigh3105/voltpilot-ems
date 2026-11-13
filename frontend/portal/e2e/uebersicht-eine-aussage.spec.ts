import { expect, test, type Page } from '@playwright/test';

/**
 * Kunden-Alarmierung P4 (B9, „eine Aussage“) auf der Bühne `startansicht.html` bei 375 und 1440 px: die Übersicht
 * „Meine Anlagen“ (`PortfolioCockpit`) liest dieselben offenen Meldungen wie die Glocke. Meldet sich eine Box nicht und
 * die Meldung ist offen, führt die Statuszeile zur Meldung; gibt es (noch) keine, sagt sie „noch ohne Meldung“ statt
 * still neben „Alles ruhig“ zu stehen. Kein Querlauf, keine Konsolenfehler. Mit `UEBERSICHT_BILDER=<Ordner>` je Fall
 * ein Bild für den PR.
 */
const BILDER = process.env.UEBERSICHT_BILDER;
const JETZT = new Date('2026-10-20T08:15:30Z');

async function oeffne(page: Page, query: string, breite: number) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(String(e)));
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 721 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?${query}`);
  await expect(page.locator('.vp-ku-status')).toBeVisible();
  await expect(page.getByText('Wird geladen …')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  return fehler;
}

const ueberlauf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const breite of [375, 1440] as const) {
  test(`Übersicht: die Box meldet sich nicht, die Zeile führt zur Meldung (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, 'bild=unternehmen&messen=bestand&box=stumm', breite);
    const status = page.locator('.vp-ku-status');
    await expect(status).toContainText('Werk Ahrenberg – Halle 1 meldet sich seit');
    await expect(status).not.toContainText('noch ohne Meldung');
    await expect(page.getByTestId('uebersicht-zur-meldung')).toHaveAttribute('href', '#/meldungen?meldung=al-1');
    // Dieselbe Quelle: die Glocke zählt genau diese Meldung.
    await expect(page.getByRole('button', { name: 'Meldungen, 1 ungesehen' })).toBeVisible();
    if (BILDER) await page.screenshot({ path: `${BILDER}/p4-uebersicht-zur-meldung-${breite}.png` });
    expect(await ueberlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });

  test(`Übersicht: noch ohne Meldung, die Glocke ist leer (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, 'bild=unternehmen&messen=bestand&box=stumm&meldungen=keine', breite);
    const status = page.locator('.vp-ku-status');
    await expect(status).toContainText(/Werk Ahrenberg – Halle 1 meldet sich seit .* nicht · noch ohne Meldung/);
    await expect(page.getByTestId('uebersicht-zur-meldung')).toHaveCount(0);
    await expect(status.getByRole('link', { name: 'Zur Anlage ›' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Meldungen', exact: true })).toBeVisible();
    if (BILDER) await page.screenshot({ path: `${BILDER}/p4-uebersicht-noch-ohne-meldung-${breite}.png` });
    expect(await ueberlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });
}
