import { expect, test } from '@playwright/test';

/**
 * Abnahme-Befund aus Produktion: eine selbst angelegte Überwachung ließ sich nicht wieder löschen -
 * der Betreiber wörtlich: "wie kann ich diese denn wieder löschen also die Überwachung?" Dieser
 * Lauf prüft den ganzen Weg: "Überwachung starten" (Blatt, Alerting Scheibe 2) → Reiter
 * "Überwachungen" im Meldungs-Center → "Löschen" mit ehrlicher Rückfrage (Verlauf bleibt, Konto
 * meldet nicht mehr) → die Regel ist weg. GEMESSEN, nicht behauptet: kein Querlauf, Konsole sauber.
 */
for (const breite of [390, 1440] as const) {
  test(`Überwachung anlegen und wieder löschen bei ${breite}px`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('console', (msg) => { if (msg.type() === 'error') fehler.push(msg.text()); });
    page.on('pageerror', (e) => fehler.push(String(e)));
    await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });

    await page.goto('/e2e/ueberwachung-loeschen.html');

    // 1) Überwachung starten (Blatt).
    const blatt = page.getByRole('dialog');
    await expect(blatt).toBeVisible();
    await blatt.getByRole('button', { name: 'Überwachung starten' }).click();

    // 2) Das Meldungs-Center öffnet sich, Reiter "Überwachungen".
    await expect(page.getByRole('heading', { name: 'Meldungen' })).toBeVisible();
    await page.getByTestId('meldungen-reiter-regeln').click();

    const zeile = page.locator('.vp-regel', { hasText: 'PV-Leistung' });
    await expect(zeile).toBeVisible();
    await expect(zeile.getByRole('button', { name: 'Jetzt scharf schalten' })).toHaveCount(0);

    // 3) Löschen fragt ehrlich zurück (Verlauf bleibt, Konto meldet nicht mehr) - erst dann weg.
    await zeile.getByRole('button', { name: /löschen$/i }).click();
    const dialog = page.getByRole('dialog', { name: 'Überwachung löschen?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('confirm-consequences')).toContainText('Verlauf');
    await expect(dialog.getByTestId('confirm-consequences')).toContainText('Meldungen');

    await dialog.getByRole('button', { name: 'Löschen' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.vp-regel', { hasText: 'PV-Leistung' })).toHaveCount(0);
    await expect(page.getByText('Noch keine Überwachung eingeschaltet.')).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });
}
