import { test, expect } from '@playwright/test';

// Die Perioden-Form des Blatts "Überwachen" (Alerting Scheibe 4, Konzept vp-alerting-konzept-m1
// §6.3/§6.4, §7 "Playwright für Blatt mit Auswahl UND Lastspitze bei 390 und 1440 px"): "Lastspitze
// droht" (der einzige Dringend-Vorschlag ab Werk, §6.10 Punkt 3) und "Verbrauch im Zeitraum" sind
// periodisch (`menge`) - keine Dauer/Erholdauer-Felder (§6.4 Nr. 2), stattdessen Zeitraum-Chips und
// ein Schalter "Mehr als …"/"Änderung …".
for (const width of [390, 1440]) {
  test(`Lastspitze: "Mehr als …" mit Zeitraum-Chips, Satz und Anfrage bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
    await page.goto('/e2e/ueberwachen-periode.html?wertart=anlage.lastspitze.periode');

    const blatt = page.getByRole('dialog');
    await expect(blatt).toBeVisible();
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('die Lastspitze');
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('im Monat'); // Vorgabe-Zeitraum

    const zeitraum = blatt.getByRole('group', { name: 'Zeitraum' });
    await expect(zeitraum).toBeVisible();
    await expect(zeitraum.getByRole('button', { name: 'Monat' })).toHaveAttribute('aria-pressed', 'true');
    await zeitraum.getByRole('button', { name: 'Abrechnungszeitraum' }).click();
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('im Abrechnungszeitraum');

    const wiePruefen = blatt.getByRole('group', { name: 'Wie prüfen?' });
    await expect(wiePruefen.getByRole('button', { name: 'Mehr als …' })).toHaveAttribute('aria-pressed', 'true');

    // Keine Dauer-/Erholdauer-Felder bei einer Periode (§6.4 Nr. 2).
    await expect(blatt.getByLabel('Länger als (Minuten)')).toHaveCount(0);

    const schwelle = blatt.getByLabel('Schwelle (kW)', { exact: true });
    await schwelle.fill('180');
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('180,0');

    await blatt.getByRole('button', { name: 'Dringend' }).click();
    await blatt.getByRole('button', { name: 'Überwachung starten' }).click();

    const koerper = await page.evaluate(
      () => (window as unknown as { __ueberwachungAnfragen: unknown[] }).__ueberwachungAnfragen,
    );
    expect(koerper).toHaveLength(1);
    expect(koerper[0]).toMatchObject({
      wertart: 'anlage.lastspitze.periode',
      schwere: 'dringend',
      bedingung: { art: 'periode', richtung: 'ueber', schwelle: 180, periode: 'abrechnungszeitraum' },
    });

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });

  test(`Verbrauch im Zeitraum: "Änderung …" gegenüber der Vorperiode bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
    await page.goto('/e2e/ueberwachen-periode.html?wertart=anlage.verbrauch.menge');

    const blatt = page.getByRole('dialog');
    await expect(blatt).toBeVisible();

    await blatt.getByRole('group', { name: 'Wie prüfen?' }).getByRole('button', { name: 'Änderung …' }).click();
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('gegenüber der vorigen Periode');

    await blatt.getByRole('button', { name: 'fällt' }).click();
    const prozent = blatt.getByLabel('Um mehr als (%)');
    await prozent.fill('25');
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('25');
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('fällt');

    await blatt.getByRole('button', { name: 'Überwachung starten' }).click();
    const koerper = await page.evaluate(
      () => (window as unknown as { __ueberwachungAnfragen: unknown[] }).__ueberwachungAnfragen,
    );
    expect(koerper).toHaveLength(1);
    expect(koerper[0]).toMatchObject({
      wertart: 'anlage.verbrauch.menge',
      bedingung: { art: 'aenderung', richtung: 'niedriger', schwelle_prozent: 25 },
    });

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });
}
