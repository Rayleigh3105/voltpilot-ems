import { expect, test, type Page } from '@playwright/test';

/**
 * Steuerlogik Stufe 2, das Blatt der Plattform (`e2e/steuerlogik-mitlauf.tsx`): das Beispiel der Wärmepumpe, wie die
 * Box es meldet. GEMESSEN bei 1440 und 375 px: Lage, Vergleich würde gegen ist mit dem Gerätenamen, das Protokoll des
 * Tages, eine gesperrte Logik mit ihrer nicht bestandenen Probe, kein Überlauf der Seite, Konsole sauber.
 */
test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

async function oeffnen(page: Page, breite: 1440 | 375, stand = 'mit') {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  await page.setViewportSize({ width: breite, height: breite === 1440 ? 900 : 812 });
  await page.goto(`/e2e/steuerlogik-mitlauf.html?stand=${stand}`);
  await page.locator('.vp-slm').waitFor();
  return fehler;
}

async function ohneUeberlauf(page: Page) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s).toBeLessThanOrEqual(w.c);
}

for (const breite of [1440, 375] as const) {
  test(`Mitlauf mit Vergleich und Protokoll bei ${breite} px`, async ({ page }) => {
    const fehler = await oeffnen(page, breite);
    const karte = page.getByRole('article', { name: 'Wärmepumpe' });
    await expect(karte).toContainText('Fassung 2 · läuft mit, schaltet nichts');
    await expect(karte).toContainText('Box hat Fassung 2 angenommen');
    await expect(karte).toContainText('Speichert Sonnenstrom');
    const zeile = karte.getByRole('row', { name: /Wärmepumpe/ }).first();
    await expect(zeile).toContainText('61 s von 22 min verschieden');
    await karte.getByRole('button', { name: 'Protokoll heute' }).click();
    await expect(karte.getByText('Wechsel heute (2)')).toBeVisible();
    await expect(karte.getByRole('row', { name: /11:21:01/ })).toContainText('ist');
    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

test('eine gesperrte Logik nennt ihre Probe und lässt den Text stehen', async ({ page }) => {
  const fehler = await oeffnen(page, 375);
  const feld = page.getByLabel('Text der Logik (YAML-Schreibform oder JSON)').last();
  await page.getByRole('button', { name: 'Prüfen und ausliefern' }).click();
  await expect(page.getByText('Bitte den Text der Logik einfügen oder eine Datei wählen.')).toBeVisible();
  await expect(feld).toBeFocused();
  await feld.fill('logic: 1');
  await page.getByRole('button', { name: 'Prüfen und ausliefern' }).click();
  await expect(page.getByText('Probe „Kalter Morgen“: status ist Nachtsperre, erwartet Heizt aus dem Netz')).toBeVisible();
  await expect(feld).toHaveValue('logic: 1');
  await ohneUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('eine Box ohne die Fähigkeit bekommt kein Formular', async ({ page }) => {
  const fehler = await oeffnen(page, 1440, 'ohne');
  await expect(page.getByText('Die Box meldet die Fähigkeit steuerlogik_mitlauf nicht. Erst die Box aktualisieren.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prüfen und ausliefern' })).toHaveCount(0);
  expect(fehler).toEqual([]);
});
