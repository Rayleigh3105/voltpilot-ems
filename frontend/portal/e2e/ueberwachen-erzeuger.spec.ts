import { test, expect } from '@playwright/test';

// Die Erzeuger-Vorlagen im Blatt "Überwachen" (UEMS EZ-11, Konzept vp-erzeuger-wago-konzept §4.8, EW-9 A):
// derselbe Prüfstand wie die Perioden-Form (`ueberwachen-periode.html` rendert das Blatt für jede Wertart), hier
// mit "Anlage folgt nicht" - die Toleranzen der Vorlage als Felder, kein Probelauf, kein Überlauf bei 390/1440 px.
for (const width of [390, 1440]) {
  test(`Anlage folgt nicht: Vorlage mit Toleranz-Feldern und Anfrage bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
    await page.goto('/e2e/ueberwachen-periode.html?wertart=erzeuger.anlage_folgt_nicht');

    const blatt = page.getByRole('dialog');
    await expect(blatt).toBeVisible();
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('mehr erzeugt, als die wirksame Grenze erlaubt');
    await expect(blatt.getByText('Meldet ab dem Start, ohne Probelauf.')).toBeVisible();
    await expect(blatt.getByLabel('Länger als (Minuten)')).toHaveValue('5');

    const kw = blatt.getByLabel('Toleranz mindestens (kW)');
    await expect(kw).toHaveValue('5');
    await kw.fill('12');
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('mindestens 12');

    await page.screenshot({ path: test.info().outputPath(`ez11-anlage-folgt-nicht-${width}.png`), fullPage: true });
    await blatt.getByRole('button', { name: 'Überwachung starten' }).click();

    const koerper = await page.evaluate(
      () => (window as unknown as { __ueberwachungAnfragen: unknown[] }).__ueberwachungAnfragen,
    );
    expect(koerper).toHaveLength(1);
    expect(koerper[0]).toMatchObject({
      wertart: 'erzeuger.anlage_folgt_nicht',
      schwere: 'warnung',
      bedingung: { art: 'zustand', ziel: ['folgt_nicht'], dauer_s: 300, erholen_s: 300, toleranz_prozent: 5, toleranz_kw: 12 },
    });

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });
}
