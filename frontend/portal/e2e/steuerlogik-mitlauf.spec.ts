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

test('Scharf schalten: die Hinweise stehen gesammelt im Dialog, eine Bestätigung genügt', async ({ page }) => {
  const fehler = await oeffnen(page, 375, 'scharf');
  await page.getByRole('button', { name: 'Scharf schalten …' }).click();
  const dialog = page.getByRole('dialog', { name: '„Wärmepumpe“ scharf schalten?' });
  await expect(dialog).toContainText('Ab jetzt schaltet die Box nach Fassung 2: Wärmepumpe gehört der Logik.');
  await expect(dialog).toContainText('Home Assistant');
  await expect(dialog).toContainText('Der Kunde stellt selbst: Sonnenstrom in Wärme speichern, Speicher höchstens.');
  if (process.env.BILDER_DIR) await page.screenshot({ path: `${process.env.BILDER_DIR}/plattform-scharf-dialog-375.png`, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Gelesen, scharf schalten' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { scharfAufrufe: number[] }).scharfAufrufe)).toEqual([2]);
  await ohneUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('Scharf schalten: ein zweiter Herr sperrt die Bestätigung, Abbrechen bleibt', async ({ page }) => {
  const fehler = await oeffnen(page, 1440, 'konflikt');
  await page.getByRole('button', { name: 'Scharf schalten …' }).click();
  const dialog = page.getByRole('dialog', { name: '„Wärmepumpe“ scharf schalten?' });
  await expect(dialog).toContainText('Gesperrt: Für „Wärmepumpe“ gilt eine Steuerart.');
  await expect(dialog.getByRole('button', { name: 'Gelesen, scharf schalten' })).toBeDisabled();
  if (process.env.BILDER_DIR) await page.screenshot({ path: `${process.env.BILDER_DIR}/plattform-zweiter-herr-1440.png`, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog).toHaveCount(0);
  expect(fehler).toEqual([]);
});
