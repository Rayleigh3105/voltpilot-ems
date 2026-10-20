import { expect, test, type Page } from '@playwright/test';

/**
 * Eine Überwachung entsteht nur noch unter Meldungen › Überwachungen (Konzept b1, 20.10.2026,
 * Entscheid E3): „+ Überwachung“ → „Wo?“ → „Welcher Wert?“ → das vorhandene Blatt „Überwachen“.
 * Dazu der Abnahme-Befund aus Produktion ("wie kann ich diese denn wieder löschen also die
 * Überwachung?"): „Löschen“ fragt ehrlich zurück. GEMESSEN, nicht behauptet: die gesendeten
 * Anfragekörper, kein Querlauf, Konsole sauber.
 */
async function oeffnen(page: Page, breite: number, person?: string) {
  const fehler: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') fehler.push(msg.text()); });
  page.on('pageerror', (e) => fehler.push(String(e)));
  await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
  await page.goto(`/e2e/ueberwachung-loeschen.html${person ? `?person=${person}` : ''}`);
  await expect(page.getByRole('heading', { name: 'Meldungen' })).toBeVisible();
  await expect(page.getByTestId('meldungen-reiter-regeln')).toHaveAttribute('aria-selected', 'true');
  return fehler;
}

/** „+ Überwachung“ → Ort → Wert; gibt das Blatt „Überwachen“ zurück. */
async function waehle(page: Page, ort: RegExp, wert: RegExp) {
  await page.getByRole('button', { name: 'Überwachung', exact: true }).click();
  const neu = page.getByRole('dialog', { name: 'Neue Überwachung' });
  await expect(neu).toBeVisible();
  await neu.getByRole('combobox', { name: 'Wo?' }).click();
  await page.getByRole('option', { name: ort }).click();
  await neu.getByRole('button', { name: wert }).click();
  await expect(neu).toHaveCount(0);
  const blatt = page.getByRole('dialog', { name: /^Überwachen: / });
  await expect(blatt).toBeVisible();
  return blatt;
}

const anfragen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ueberwachungAnfragen: unknown[] }).__ueberwachungAnfragen);

const ueberlauf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const breite of [390, 1440] as const) {
  test(`Überwachung unter Meldungen anlegen und wieder löschen bei ${breite}px`, async ({ page }) => {
    const fehler = await oeffnen(page, breite);
    await expect(page.getByText('Noch keine Überwachung eingeschaltet.')).toBeVisible();

    const blatt = await waehle(page, /Halle 1/, /PV-Leistung/);
    await expect(blatt).toContainText('Überwachen: PV-Leistung');
    await blatt.getByRole('button', { name: 'Überwachung starten' }).click();
    await expect(blatt).toHaveCount(0);
    expect(await anfragen(page)).toEqual([expect.objectContaining({ wertart: 'anlage.pv.leistung', bezug: { anlage: 'an-1' } })]);

    const zeile = page.locator('.vp-regel', { hasText: 'PV-Leistung' });
    await expect(zeile).toBeVisible();
    await expect(zeile.getByRole('button', { name: 'Jetzt scharf schalten' })).toHaveCount(0);

    // Löschen fragt ehrlich zurück (Verlauf bleibt, Konto meldet nicht mehr) - erst dann weg.
    await zeile.getByRole('button', { name: /löschen$/i }).click();
    const dialog = page.getByRole('dialog', { name: 'Überwachung löschen?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('confirm-consequences')).toContainText('Verlauf');
    await expect(dialog.getByTestId('confirm-consequences')).toContainText('Meldungen');
    await dialog.getByRole('button', { name: 'Löschen' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.vp-regel', { hasText: 'PV-Leistung' })).toHaveCount(0);
    await expect(page.getByText('Noch keine Überwachung eingeschaltet.')).toBeVisible();

    expect(await ueberlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });

  // „Gilt für“ (Alerting Scheibe 4, §6.4): zwei Chips im BESTEHENDEN Blatt; „Alle Anlagen“ ersetzt beim
  // Anlegen den konkreten Bezug durch {"alle":"anlage"} - am gesendeten Körper geprüft, nicht nur am Bild.
  test(`„Gilt für: Alle Anlagen“ sendet die Auswahl statt des Bezugs bei ${breite}px`, async ({ page }) => {
    const fehler = await oeffnen(page, breite);
    const blatt = await waehle(page, /Halle 1/, /Netzbezug/);
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('Sag mir Bescheid, wenn der Netzbezug');
    const giltFuer = blatt.getByRole('group', { name: 'Gilt für' });
    await expect(giltFuer.getByRole('button', { name: 'Diese Anlage' })).toHaveAttribute('aria-pressed', 'true');
    await giltFuer.getByRole('button', { name: 'Alle Anlagen' }).click();
    await expect(blatt.locator('.vp-ueberwachen-probelauf')).toHaveCount(0);
    await blatt.getByRole('button', { name: 'Überwachung starten' }).click();
    await expect(blatt).toHaveCount(0);
    expect(await anfragen(page)).toEqual([expect.objectContaining({ bezug: { alle: 'anlage' } })]);
    expect(await ueberlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });
}

test('eine Messstelle und ein Geräte-Kanal lassen sich ebenso wählen', async ({ page }) => {
  const fehler = await oeffnen(page, 1440);
  // Die Geräte einer Anlage stehen unter ihr, der Kanal in Kundenworten.
  await page.getByRole('button', { name: 'Überwachung', exact: true }).click();
  const neu = page.getByRole('dialog', { name: 'Neue Überwachung' });
  await neu.getByRole('combobox', { name: 'Wo?' }).click();
  await page.getByRole('option', { name: /Halle 1/ }).click();
  await expect(neu.getByRole('button', { name: /Zähler Halle · Netzleistung/ })).toBeVisible();
  await expect(neu.getByText('grid_power_kw')).toHaveCount(0);
  // Eine Messstelle: ihre Werte kommen aus dem Werte-Katalog.
  await neu.getByRole('combobox', { name: 'Wo?' }).click();
  await page.getByRole('option', { name: /Hauptzähler/ }).click();
  await neu.getByRole('button', { name: /Monat unvollständig/ }).click();
  const blatt = page.getByRole('dialog', { name: /^Überwachen: Monat unvollständig/ });
  await expect(blatt).toBeVisible();
  // Ein Zustand statt einer Schwelle (§6.4): erst wählen, dann starten.
  const zustand = blatt.getByRole('group', { name: 'Wenn der Zustand' });
  await expect(blatt.getByRole('button', { name: 'Überwachung starten' })).toBeDisabled();
  await zustand.getByRole('button').first().click();
  await blatt.getByRole('button', { name: 'Überwachung starten' }).click();
  await expect(blatt).toHaveCount(0);
  expect(await anfragen(page)).toEqual([expect.objectContaining({ wertart: 'messstelle.monat_unvollstaendig', bezug: { messstelle: 'ms-1' } })]);
  expect(fehler).toEqual([]);
});

test('„+ Überwachung“ folgt dem Recht: ein Bearbeiter am Standort sieht es, ein Unterstützer nicht', async ({ page }) => {
  await oeffnen(page, 1440, 'PH');
  await expect(page.getByRole('button', { name: 'Überwachung', exact: true })).toBeVisible();
  await oeffnen(page, 1440, 'TB');
  await expect(page.getByRole('button', { name: 'Überwachung', exact: true })).toHaveCount(0);
});
