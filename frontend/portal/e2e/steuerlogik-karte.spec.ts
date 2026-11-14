import { expect, test, type Page } from '@playwright/test';

/**
 * Steuerlogik Stufe 3, die Karte und das Blatt „Warum?“ (`e2e/steuerlogik-karte.tsx`). Die Karte trägt die Antwort
 * der API Byte für Byte (`steuerlogik-karte.valid.wasser.json`). GEMESSEN bei 390 und 1440 px: ein Satz, die
 * Pille, der Schalter mit seinem Hilfesatz, die Störung zuerst; im Blatt die Bedingungen mit Haken, die Regler im
 * Bereich, gesperrte Werte, der Verlauf; kein Überlauf, Konsole sauber. Mit `BILDER_DIR` legt der Lauf Bilder ab.
 */
test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

const BILDER = process.env.BILDER_DIR;

async function oeffnen(page: Page, breite: 390 | 1440, stand: string, blatt = false) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  await page.setViewportSize({ width: breite, height: breite === 1440 ? 900 : 844 });
  await page.goto(`/e2e/steuerlogik-karte.html?stand=${stand}${blatt ? '&blatt=1' : ''}`);
  await page.locator('.lg-karte').waitFor();
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

for (const breite of [390, 1440] as const) {
  test(`die Karte mit dem Schalter bei ${breite} px`, async ({ page }) => {
    const fehler = await oeffnen(page, breite, 'winter');
    const karte = page.getByRole('region', { name: 'Logik Heizung' });
    await expect(karte).toContainText('Heizt aus dem Netz');
    await expect(karte.locator('.pill')).toHaveText('Netz');
    const schalter = karte.getByRole('switch', { name: 'Winterregelung' });
    await expect(schalter).toHaveAttribute('aria-checked', 'true');
    // Lage und Hilfesatz kommen aus EINEM Lauf: dieselben Zahlen (40 °C, 60 °C), kein Widerspruch in der Karte.
    await expect(karte).toContainText(/Speicher 1 war unter 40\s°C gefallen.*heizt aus dem Netz bis 60\s°C/);
    await expect(karte).toContainText(/Unter 40\s°C heizt Speicher 1 aus dem Netz, von 06:00 bis 22:00 Uhr, bis 60\s°C/);
    await expect(karte).toContainText('Durchlauferhitzer · 3 Phasen');
    await bild(page, 'karte-winterregelung', breite);
    await schalter.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { gesendet: unknown[] }).gesendet)).toEqual([
      { kennung: 'winter', wert: 'off' },
    ]);
    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });

  test(`das Blatt „Warum?“ mit Reglern und Verlauf bei ${breite} px`, async ({ page }) => {
    const fehler = await oeffnen(page, breite, 'wasser');
    const karte = page.getByRole('region', { name: 'Logik Warmwasser' });
    await expect(karte).toContainText('Wartet auf Sonnenstrom');
    await expect(karte.getByRole('switch')).toHaveCount(0);
    await bild(page, 'karte-warmwasser', breite);
    await karte.getByRole('button', { name: 'Warum?' }).click();
    const blatt = page.getByRole('dialog', { name: 'Warmwasser' });
    await expect(blatt).toBeVisible();
    await expect(blatt.getByText('Was gerade entscheidet')).toBeVisible();
    await expect(blatt.locator('.lg-check li').first()).toBeVisible();
    // Jede Gruppe trägt den Satz der Logik in Alltagssprache, mit dem Wert von jetzt - nie eine Kennung.
    const titel = blatt.locator('.lg-gruppe-t > span');
    await expect(titel.first()).toHaveText(/^Heizt aus dem Netz bis 50\s°C, wenn alles erfüllt ist$/);
    // Das Gerät: Befehl 3 Phasen, die Mindestlaufzeit hält es (der Schutz der Box, den keine Logik überstimmt).
    await expect(blatt.locator('.lg-geraete')).toContainText('3 Phasen');
    await expect(blatt.locator('.lg-geraete')).toContainText('Mindestlaufzeit');
    // Ein Zielwert als Regler in seinem Bereich; „mehr“ stellt einen Schritt höher und sendet die Form des Dokuments.
    await expect(blatt.getByText('Das stellen Sie ein')).toBeVisible();
    const ziel = blatt.locator('.lg-regler').filter({ hasText: 'Mit Sonnenstrom bis' });
    await expect(ziel.locator('output')).toHaveText('57 °C');
    await ziel.getByRole('button', { name: 'Mit Sonnenstrom bis mehr' }).click();
    await expect(ziel.locator('output')).toHaveText('58 °C');
    await expect(ziel).toContainText('wird übernommen');
    await expect.poll(() => page.evaluate(() => (window as unknown as { gesendet: unknown[] }).gesendet), { timeout: 3000 })
      .toEqual([{ kennung: 'ziel', wert: '58 °C' }]);
    await expect(blatt.getByText('Heute')).toBeVisible();
    await expect(blatt.locator('.lg-verlauf')).toContainText('Jonas Wendlinger: Nie kälter als 40 °C → 42 °C');
    await expect(blatt.locator('.lg-verlauf')).toContainText('Heizstab: 3 Phasen');
    await bild(page, 'blatt-warum', breite);
    // Alle Gruppen: jede Überschrift ist ein Satz der Logik - Kennungen (netzheizen, zurueck, stufe_x) und
    // kleingeschriebene Satzanfänge kommen nicht vor.
    await blatt.getByRole('button', { name: /Alle \d+ Gruppen anzeigen/ }).click();
    const alle = await titel.allTextContents();
    expect(alle.length).toBeGreaterThan(2);
    expect(alle.join(' | ')).not.toMatch(/netzheizen|zurueck|versuch|blind|[a-z]_[a-z]|(^|\| )[a-z]/);
    if (BILDER) {
      // Für das Bild aller Gruppen kurz ein hohes Fenster: das Blatt wächst mit und zeigt alle auf einmal.
      await page.setViewportSize({ width: breite, height: 2400 });
      await blatt.getByRole('heading', { name: 'Was gerade entscheidet' }).scrollIntoViewIfNeeded();
      await bild(page, 'warum-alle-gruppen', breite);
      await page.setViewportSize({ width: breite, height: breite === 1440 ? 900 : 844 });
    }
    await blatt.getByRole('button', { name: 'Weniger anzeigen' }).click();
    await ohneUeberlauf(page);
    await page.keyboard.press('Escape');
    await expect(blatt).toHaveCount(0);
    await expect(karte.getByRole('button', { name: 'Warum?' })).toBeFocused();
    expect(fehler).toEqual([]);
  });

  test(`eine Störung steht zuerst bei ${breite} px`, async ({ page }) => {
    const fehler = await oeffnen(page, breite, 'stoerung');
    const karte = page.getByRole('region', { name: 'Logik Warmwasser' });
    await expect(karte.locator('.pill')).toHaveText('Störung');
    await expect(karte).toContainText('Störung Fühler');
    await expect(karte).toContainText('Der Fühler liefert keinen Wert');
    await expect(karte.locator('.lg-stoerung')).toHaveText('Ohne Wert: Speicher.');
    await bild(page, 'karte-stoerung', breite);
    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

test('eine Logik, die auf der Box nicht läuft, sagt es ehrlich', async ({ page }) => {
  const fehler = await oeffnen(page, 390, 'haelt');
  const karte = page.getByRole('region', { name: 'Logik Warmwasser' });
  await expect(karte).toContainText('Läuft nicht');
  await expect(karte).toContainText('Die Logik läuft auf der Box nicht');
  await bild(page, 'karte-haelt-an', 390);
  await karte.getByRole('button', { name: 'Warum?' }).click();
  await expect(page.locator('.lg-geraete')).toContainText('Schaltstand unbekannt');
  expect(fehler).toEqual([]);
});

test('ohne Recht sind alle Werte gesperrt und ein Satz nennt den Weg', async ({ page }) => {
  const fehler = await oeffnen(page, 390, 'leser', true);
  const blatt = page.getByRole('dialog', { name: 'Warmwasser' });
  await expect(blatt.locator('.lg-regler')).toHaveCount(0);
  await expect(blatt.locator('.prow .lg-wert').first()).toBeVisible();
  await expect(blatt.getByRole('button', { name: 'Ändern' })).toHaveCount(0);
  await bild(page, 'blatt-leser', 390);
  expect(fehler).toEqual([]);
});
