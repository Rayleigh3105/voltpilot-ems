import { test, expect } from '@playwright/test';

// Alerting Scheibe 5 (Konzept vp-alerting-konzept-m1 §7 Scheibe 5 Punkt 9 "Playwright-Nachweis
// 390/1440"): die Marke "eigene Überwachung" und "Zur Kennzahl/Zum Energieziel/Zur Messstelle"
// im Meldungs-Center (§6.4 Nr. 7), der CSV-Export je Periode (Entscheid 14A) und die Zustands-
// Form des Blatts "Überwachen" (Energieziel-Kurs, §6.4) - keine Dauer/Erholdauer-Lücke, dafür
// Zustands-Chips statt einer Schwelle.
for (const width of [390, 1440]) {
  test(`Meldungs-Center: Marke, Quelle-Link und CSV-Export im Verlauf bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
    await page.goto('/e2e/ueberwachen-energiemanagement.html');

    const seite = page.locator('#root');
    await seite.getByTestId('meldungen-reiter-verlauf').click();
    await expect(seite.getByTestId('verlauf-csv')).toBeVisible();

    const liste = seite.locator('.vp-meldungen-liste li');
    await expect(liste).toHaveCount(3);

    // Energieziel-Kurs: Marke + "Zum Energieziel".
    const energiezielZeile = liste.filter({ hasText: 'AL-2029-000012' });
    await expect(energiezielZeile.getByTestId('meldung-eigene-ueberwachung')).toContainText('eigene Überwachung');
    await expect(energiezielZeile.getByTestId('meldung-quelle-link')).toHaveText('Zum Energieziel');
    await expect(energiezielZeile.getByTestId('meldung-quelle-link')).toHaveAttribute('href', '#/portfolio/verbesserung/energieziele/ez-42');

    // Messstelle: Marke + "Zur Messstelle".
    const messstelleZeile = liste.filter({ hasText: 'AL-2029-000013' });
    await expect(messstelleZeile.getByTestId('meldung-eigene-ueberwachung')).toContainText('eigene Überwachung');
    await expect(messstelleZeile.getByTestId('meldung-quelle-link')).toHaveText('Zur Messstelle');

    // Eine Scheibe-1-Wertart (Anlage) trägt weder Marke noch Quelle-Link.
    const anlageZeile = liste.filter({ hasText: 'AL-2029-000014' });
    await expect(anlageZeile.getByTestId('meldung-eigene-ueberwachung')).toHaveCount(0);
    await expect(anlageZeile.getByTestId('meldung-quelle-link')).toHaveCount(0);

    // CSV-Export: Zeitraum wählen, herunterladen - kein Fehler, keine Navigation weg von der Seite.
    const download = page.waitForEvent('download');
    await seite.getByRole('button', { name: 'Verlauf als CSV' }).click();
    const datei = await download;
    expect(datei.suggestedFilename()).toBe('meldungen-verlauf.csv');

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });

  test(`Überwachen-Blatt: Zustands-Form für den Energieziel-Kurs bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
    await page.goto('/e2e/ueberwachen-energiemanagement.html?modus=blatt');

    const blatt = page.getByRole('dialog');
    await expect(blatt).toBeVisible();

    // Zustands-Form statt Schwelle/Rückkehrschwelle (§6.4): keine Zahlenfelder, dafür Zustands-Chips.
    await expect(blatt.getByLabel(/^Schwelle/)).toHaveCount(0);
    const zustand = blatt.getByRole('group', { name: 'Wenn der Zustand' });
    await expect(zustand).toBeVisible();
    await zustand.getByRole('button', { name: 'nicht auf Kurs' }).click();
    await expect(zustand.getByRole('button', { name: 'nicht auf Kurs' })).toHaveAttribute('aria-pressed', 'true');
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('nicht auf Kurs');
    await expect(blatt.getByRole('button', { name: 'Überwachung starten' })).toBeEnabled();

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });
}
