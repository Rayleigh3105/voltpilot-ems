import { expect, test, type Page } from '@playwright/test';

/**
 * Steuerlogik Stufe 6, Zusammenführen: „Wie Ihre Regeln laufen“ im Reiter „Regeln“ (`e2e/steuerweg.tsx`). GEMESSEN
 * bei 390 und 1440 px: ab Werk der bisherige Weg mit „Vergleich starten“; der Vergleich nennt je Regel beide Seiten
 * und den Tag; „Übernehmen“ fragt mit den Folgen nach und schaltet erst dann; „Zurück“ wirkt ohne Rückfrage; eine
 * Edge Light hat keinen Schritt; wer den Schalter nicht stellen darf, sieht ihn ohne Knöpfe. Kein Überlauf, Konsole
 * sauber. Mit `BILDER_DIR` legt der Lauf Bilder ab.
 */
test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

const BILDER = process.env.BILDER_DIR;

async function oeffnen(page: Page, breite: 390 | 1440, stand: string) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  await page.setViewportSize({ width: breite, height: breite === 1440 ? 900 : 844 });
  await page.goto(`/e2e/steuerweg.html?stand=${stand}`);
  await page.getByRole('region', { name: 'Wie Ihre Regeln laufen' }).waitFor();
  return fehler;
}

async function ohneUeberlauf(page: Page) {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s).toBeLessThanOrEqual(w.c);
}

async function bild(page: Page, name: string, breite: number) {
  if (!BILDER) return;
  await page.screenshot({ path: `${BILDER}/${name}-${breite}.png`, fullPage: true, animations: 'disabled' });
}

const gesendet = (page: Page) => page.evaluate(() => (window as unknown as { gesendet: string[] }).gesendet);

for (const breite of [390, 1440] as const) {
  test(`vom bisherigen Weg über den Vergleich zum neuen Weg und zurück bei ${breite} px`, async ({ page }) => {
    const fehler = await oeffnen(page, breite, 'alt');
    const abschnitt = page.getByRole('region', { name: 'Wie Ihre Regeln laufen' });
    await expect(abschnitt.locator('.grp-h .pill')).toHaveText('bisher');
    await expect(abschnitt).toContainText('Ihre Regeln laufen wie bisher.');
    await expect(abschnitt.getByRole('button')).toHaveText(['Vergleich starten']);
    await bild(page, 'steuerweg-bisher', breite);
    await ohneUeberlauf(page);

    await abschnitt.getByRole('button', { name: 'Vergleich starten' }).click();
    await expect(abschnitt.locator('.grp-h .pill')).toHaveText('Vergleich');
    const sonne = abschnitt.locator('li[data-regel="r-sonne"]');
    await expect(sonne).toContainText(/Neuer Weg: an, geschaltet: an\. Heute 13\sStd 12\sMin verglichen, immer gleich\./);
    await expect(sonne.locator('.pill')).toHaveText('gleich');
    const nacht = abschnitt.locator('li[data-regel="r-nacht"]');
    await expect(nacht.locator('.pill')).toHaveText('weicht ab');
    await expect(nacht).toContainText(/Heute 13\sStd 12\sMin verglichen, 1\sStd verschieden \(längstens 1\sStd\)\./);
    await expect(abschnitt.locator('li[data-regel="r-frei"]')).toContainText('im freien Editor gebaut');
    await expect(abschnitt.getByRole('button')).toHaveText(['Übernehmen', 'Vergleich beenden']);
    await bild(page, 'steuerweg-vergleich', breite);
    await ohneUeberlauf(page);

    // Übernehmen ist der ausdrückliche Schritt: erst der Dialog mit den Folgen, abbrechen ändert nichts.
    await abschnitt.getByRole('button', { name: 'Übernehmen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Neuen Weg übernehmen?' });
    await expect(dialog).toContainText('Die Box schaltet 2 Regeln selbst; der bisherige Weg gibt sie ab.');
    await expect(dialog).toContainText('Heute wichen die Wege ab bei: „Nachts laufen lassen“.');
    await expect(dialog).toContainText('Auf dem bisherigen Weg bleiben: „Heizstab bei Wärmepumpe aus“.');
    await bild(page, 'steuerweg-uebernehmen-dialog', breite);
    await dialog.getByRole('button', { name: 'Abbrechen' }).click();
    expect(await gesendet(page)).toEqual(['mitlauf']);
    await abschnitt.getByRole('button', { name: 'Übernehmen' }).click();
    await page.getByRole('dialog', { name: 'Neuen Weg übernehmen?' }).getByRole('button', { name: 'Übernehmen' }).click();
    await expect(abschnitt.locator('.grp-h .pill')).toHaveText('neuer Weg');
    await expect(sonne).toContainText('Die Box will: an.');
    await expect(abschnitt.getByRole('button')).toHaveText(['Zurück zum bisherigen Weg']);
    await bild(page, 'steuerweg-neuer-weg', breite);
    await ohneUeberlauf(page);

    // Zurück wirkt sofort, ohne Rückfrage.
    await abschnitt.getByRole('button', { name: 'Zurück zum bisherigen Weg' }).click();
    await expect(abschnitt.locator('.grp-h .pill')).toHaveText('bisher');
    expect(await gesendet(page)).toEqual(['mitlauf', 'uebernehmen', 'zurueck']);
    expect(fehler).toEqual([]);
  });

  test(`Edge Light und ohne Recht: kein Schritt bei ${breite} px`, async ({ page }) => {
    const fehler = await oeffnen(page, breite, 'light');
    const abschnitt = page.getByRole('region', { name: 'Wie Ihre Regeln laufen' });
    await expect(abschnitt).toContainText('Diese Box rechnet jede Regel selbst und schaltet danach.');
    await expect(abschnitt.getByRole('button')).toHaveCount(0);
    await bild(page, 'steuerweg-edge-light', breite);
    await ohneUeberlauf(page);

    const fehler2 = await oeffnen(page, breite, 'leser');
    await expect(page.getByRole('region', { name: 'Wie Ihre Regeln laufen' }).getByRole('button')).toHaveCount(0);
    expect([...fehler, ...fehler2]).toEqual([]);
  });
}
