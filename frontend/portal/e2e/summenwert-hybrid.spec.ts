import { expect as baseExpect, test, type Page } from '@playwright/test';

// Wie die anderen E2E-Bühnen: der Vite-Dev-Server kompiliert den Modulgraphen
// beim ersten Zugriff kalt, deshalb eine grosszügige Aussage-Wartezeit.
const expect = baseExpect.configure({ timeout: 30_000 });
test.describe.configure({ retries: 2 });

/**
 * Fix (b), Konzept vp-agg-konzept3-r8: ein Deye SUN-30K, dessen Speicher-Entität
 * KEINEN PV-Aspekt mehr bildet (fehlender `pv_power_kw`-Kanal), aber live PV
 * meldet, zeigt die Karte „PV-Produktion dieses Geräts" trotzdem - über den
 * echten Wirt-Gate (`geraetSeite` + `pvEinstiegEntityId`), geseedet auf die
 * Träger-Entität. Nie „gar kein Knopf" für genau ein erzeugendes Gerät.
 */
async function mock(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    // Die Karte lädt ihre (noch fehlende) Rollen-Zuordnung: unzugeordnet.
    if (/\/komponenten\/[^/]+\/rollen\/pv$/.test(path)) {
      return route.fulfill({ json: { entity_id: 'inv', role: 'pv', zugeordnet: null } });
    }
    return route.fulfill({ json: {} });
  });
}

test('Hybrid ohne PV-Aspekt, aber mit gemeldetem Solarstrom, sieht die Karte', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Ankerlauf einmal (Logik ist engine-unabhängig)');
  test.slow();
  await mock(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/e2e/summenwert-hybrid.html');

  // Belegt den reproduzierten Schaden: kein PV-Aspekt in den Komponenten …
  await expect(page.getByTestId('pv-aspekt')).toHaveText('ohne PV-Aspekt');
  // … und trotzdem erscheint die Karte samt Anlege-Einstieg (kein toter, aber
  // auch kein FEHLENDER Knopf).
  await expect(page.getByText('PV-Produktion dieses Geräts')).toBeVisible();
  await expect(page.getByRole('button', { name: /Summenwert anlegen/ })).toBeVisible();
  await expect(page.getByTestId('kein-einstieg')).toHaveCount(0);
});

test('Leserin sieht die PV-Karte am beschädigten Hybrid, aber keinen Summenwert-Knopf', async ({ page }) => {
  await mock(page);
  await page.goto('/e2e/summenwert-hybrid.html?person=CB');

  await expect(page.getByTestId('pv-aspekt')).toHaveText('ohne PV-Aspekt');
  const karte = page.locator('.vp-geraet-pvp-card');
  await expect(karte.getByText('PV-Produktion dieses Geräts')).toBeVisible();
  await expect(karte.getByRole('note')).toContainText('Jonas Wendlinger');
  await expect(karte.getByRole('button', { name: /Summenwert anlegen|Bearbeiten/ })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/** Layout-Abnahme: bei 375 und 1440 px läuft die Seite nicht waagerecht über. */
for (const width of [375, 1440]) {
  test(`kein waagerechter Überlauf bei ${width} px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Layout-Abnahme läuft einmal');
    test.slow();
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(String(e)));
    await mock(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/e2e/summenwert-hybrid.html');
    await expect(page.getByText('PV-Produktion dieses Geräts')).toBeVisible();

    const seitenUeberlauf = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(seitenUeberlauf).toBeLessThanOrEqual(1);
    expect(fehler, fehler.join('\n')).toEqual([]);
  });
}
