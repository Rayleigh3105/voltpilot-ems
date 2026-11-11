import { test, expect, type Page } from '@playwright/test';

/**
 * Der Sonnen-Teppich (Konzept `vp-prognosen-konzept`, E1 = C) im echten
 * Browser - die drei Zuschnitte aus `ship-instructions.md` Punkt 11: mit
 * Speicher (Reiter im Fahrplan), nur messen mit PV (eigener Bereich), nur
 * messen ohne PV (Teppich für den Verbrauch). Bei 1440 und 390 px: kein
 * Überlauf, keine Konsolenfehler.
 */
async function oeffnen(page: Page, width: number, fall: string, uhr: Date) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
  await page.clock.setFixedTime(uhr);
  await page.goto(`/e2e/prognose.html?fall=${fall}`);
  await expect(page.locator('.vp-pz-antwort')).toBeVisible();
  await expect(page.locator('.vp-pt-teppich')).toBeVisible();
}

async function ohneUeberlauf(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(
    await page.locator('main').evaluate((el) =>
      [...el.querySelectorAll('*')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
      }).length,
    ),
  ).toBe(0);
}

const JETZT = new Date(2026, 10, 11, 13, 45);

for (const width of [390, 1440]) {
  test(`Prognose bei ${width} px · mit Speicher: zwei Balken, Speicher-Streifen, "Ihr Fahrplan"`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'mit-speicher', JETZT);

    await expect(page.locator('.vp-pt-balken-zeile')).toHaveCount(2);
    await expect(page.locator('.vp-pt-teppich .vp-pt-tagzeile')).toHaveCount(7);
    await expect(page.getByRole('link', { name: /Ihr Fahrplan/ })).toBeVisible();
    await expect(page.getByText('Speicher', { exact: true })).toBeVisible();

    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });

  test(`Prognose bei ${width} px · nur messen mit PV: eigener Bereich, ohne Speicher-Streifen`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'nur-messen-pv', JETZT);

    await expect(page.locator('.vp-pt-balken-zeile')).toHaveCount(2);
    await expect(page.locator('.vp-pt-teppich .vp-pt-tagzeile')).toHaveCount(7);
    // Ohne Fahrplan: keine Zeile "Ihr Fahrplan", kein Speicher-Streifen.
    await expect(page.getByRole('link', { name: /Ihr Fahrplan/ })).toHaveCount(0);
    await expect(page.getByText('Speicher', { exact: true })).toHaveCount(0);

    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });

  test(`Prognose bei ${width} px · nur messen ohne PV: der Teppich zeigt nur den Verbrauch`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'nur-messen-ohne-pv', JETZT);

    // Ohne PV: EIN Balken (Verbrauch), keine Sonnen-Zahl.
    await expect(page.locator('.vp-pt-balken-zeile')).toHaveCount(1);
    await expect(page.locator('.vp-pt-balken-titel')).toHaveText('Verbrauch');
    await expect(page.locator('.vp-pt-teppich .vp-pt-tagzeile')).toHaveCount(7);
    await expect(page.getByRole('link', { name: /Ihr Fahrplan/ })).toHaveCount(0);
    // Die Überschrift nennt die Verbrauchsspitze, nicht "Sonne reicht".
    await expect(page.locator('.vp-pt-kopfsatz')).not.toContainText('Sonne reicht');

    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}
