import { expect, test, type Page } from '@playwright/test';

/**
 * **Abgleich Gerät ↔ Messstellenbetreiber** (MiSpeL MP-15, BK-15 Variante A) — der Browser-Beweis bei 375 und 1440 px:
 * der Satz mit der größten Abweichung in der Monatskarte (MP-18), das Blatt „Abgleich“ mit den vier Zählrichtungen und
 * der Wirkung, an der Messstelle die Tabelle je Monat und der Import. Kein Überlauf. Mit `MISPEL_FOTOS=<ordner>` legt
 * der Lauf die Fotos für die Ansicht ab.
 */
const NBSP = String.fromCharCode(160);
const FOTOS = process.env.MISPEL_FOTOS;

async function oeffne(page: Page, breite: number, flaeche: 'monat' | 'messstelle') {
  await page.setViewportSize({ width: breite, height: breite < 600 ? 812 : 900 });
  await page.goto(`/e2e/msb-abgleich.html?flaeche=${flaeche}&jetzt=${encodeURIComponent('2026-12-10T13:00:00+01:00')}`);
  await expect(page.locator('main[data-buehne="msb-abgleich"]')).toBeVisible();
  // Die Erlöse laden ihre Teile nacheinander (Vite lädt Module nach); erst danach steht die Karte still.
  await page.waitForLoadState('networkidle');
}

async function ohneUeberlauf(page: Page) {
  const b = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(b.s).toBeLessThanOrEqual(b.c);
}

/** Ohne Ziel: der sichtbare Ausschnitt (Blatt); mit Ziel: das Ziel aus der ganzen Seite, ohne mitlaufende Kopfleiste. */
async function foto(page: Page, name: string, ziel?: ReturnType<Page['locator']>) {
  if (!FOTOS || test.info().project.name !== 'desktop-chromium') return;
  if (!ziel) {
    await page.screenshot({ path: `${FOTOS}/${name}.png` });
    return;
  }
  const b = await ziel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  });
  await page.screenshot({ path: `${FOTOS}/${name}.png`, fullPage: true, clip: b });
}

for (const breite of [1440, 375]) {
  test(`Monatskarte: Satz mit größter Abweichung und Blatt „Abgleich“ bei ${breite} px`, async ({ page }) => {
    await oeffne(page, breite, 'monat');
    const satz = page.getByTestId('msb-abgleich-satz');
    await expect(satz).toContainText('Gerät ↔ Messstellenbetreiber: gelb.');
    await expect(satz).toContainText(`Am Speicherzähler (Entladen) liegen beide +3,4${NBSP}% auseinander.`);
    await expect(satz).toContainText('Abgerechnet wird mit den Werten des Messstellenbetreibers');
    await expect(satz).toContainText('höher als in der Vorschau');
    await ohneUeberlauf(page);
    await foto(page, `monatskarte-${breite}`, page.getByRole('region', { name: 'MiSpeL · Mengen nach Anlage 1' }));

    const blatt = page.getByRole('dialog', { name: 'Abgleich November 2026' });
    await expect(async () => {
      await satz.getByRole('button', { name: 'Abgleich ansehen ›' }).click();
      await expect(blatt).toBeVisible({ timeout: 2000 });
    }).toPass();
    await expect(blatt.getByTestId('msb-abgleich-blatt').locator('li')).toHaveCount(4);
    await expect(blatt).toContainText('Z2 · Entladen');
    await expect(blatt).toContainText(`+3,4${NBSP}%`);
    await expect(blatt).toContainText('Wirkung auf den Monat');
    await expect(blatt).toContainText('Rot (16)');
    await expect(blatt).toContainText('Saldierung');
    await expect(blatt).toContainText('Tenor S. 28');
    await ohneUeberlauf(page);
    await foto(page, `blatt-abgleich-${breite}`);
    await blatt.locator('.vp-ab-schwellen').scrollIntoViewIfNeeded();
    await foto(page, `blatt-abgleich-unten-${breite}`);
    await blatt.getByRole('button', { name: 'Schließen', exact: true }).last().click();
    await expect(blatt).toBeHidden();
  });

  test(`Messstelle: Tabelle je Monat und Import bei ${breite} px`, async ({ page }) => {
    await oeffne(page, breite, 'messstelle');
    const karte = page.getByTestId('msb-abgleich');
    await expect(karte.getByRole('heading', { name: 'Abgleich Gerät ↔ Messstellenbetreiber' })).toBeVisible();
    const zeilen = karte.locator('tbody tr');
    await expect(zeilen).toHaveCount(3);
    await expect(zeilen.nth(0)).toContainText('noch keine Werte');
    await expect(zeilen.nth(0)).toContainText('nicht vergleichbar');
    await expect(zeilen.nth(1)).toContainText(`+300${NBSP}kWh (+3,4${NBSP}%)`);
    await expect(zeilen.nth(1)).toContainText('gelb');
    await expect(zeilen.nth(1)).toContainText('Saldierung');
    await expect(zeilen.nth(2)).toContainText('Lücke');
    await ohneUeberlauf(page);
    await foto(page, `messstelle-${breite}`, karte);
    expect(await karte.evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(breite);

    await karte.locator('input[type="file"]').setInputFiles({
      name: 'msb-2026-12-z2.csv', mimeType: 'text/csv',
      buffer: Buffer.from('zeitstempel;zaehlpunkt;richtung;kwh\n'),
    });
    await expect(karte.getByRole('status')).toContainText('Eingelesen: 5.952 Viertelstunden (Bezug, Abgabe) aus msb-2026-12-z2.csv.');
    expect(await page.evaluate(() => (window as unknown as { __eingelesen: string[] }).__eingelesen)).toEqual(['msb-2026-12-z2.csv']);
    await ohneUeberlauf(page);
    await foto(page, `import-${breite}`, karte);
  });
}
