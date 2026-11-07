import { expect, test, type Page } from '@playwright/test';

/**
 * Die Suche oben beim Plattform-Administrator (Befund 07.11.2026, Telefon des Betreibers): „Bitte wählen …“ antippen,
 * einen Kunden wählen — und es passierte nichts. Die Wahl setzte nur den Mandanten; die Seite blieb auf „Benutzer“
 * (bzw. auf der Anlage des vorigen Kunden) und das Feld zeigte weiter „Bitte wählen …“. Jetzt springt die Wahl in die
 * Kundensicht wie „Wie der Kunde es sieht“ und das Feld nennt den Kunden. Wirt: `mandantensicht-navigation.html`
 * (ganzer `App`, gefälschter Server, erfundene Mandanten). Belege: `BELEGE=<Ordner>` schreibt Bildschirmfotos.
 */
const MIT = 'Solarhof Beispiel';
const MIT_ID = 'a1000000-0000-4000-8000-000000000001';
const MIT_ANLAGE = 'b1000000-0000-4000-8000-000000000001';
const OHNE = 'Musterwerk Nord GmbH';
const OHNE_ID = 'a2000000-0000-4000-8000-000000000002';
const BELEGE = process.env.BELEGE;

// exact: das Suchfeld im Blatt heisst „… suchen durchsuchen" und stünde beim Zuklappen sonst mit im Treffer.
const suche = (page: Page) => page.getByRole('combobox', { name: 'Box, Kunde, Anlage, Person suchen', exact: true });
const override = (page: Page) => page.evaluate(() => sessionStorage.getItem('vp-tenant-override'));

async function foto(page: Page, name: string) {
  if (BELEGE) await page.screenshot({ path: `${BELEGE}/${name}.png` });
}

test.describe('390 px, Touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('tippen, Kunde wählen: die Kundensicht öffnet sich und das Feld nennt den Kunden', async ({ page }) => {
    await page.goto('/e2e/mandantensicht-navigation.html#/mandanten');
    await expect(suche(page)).toHaveText(/Kunde suchen …/);
    await expect(suche(page)).not.toHaveText(/Bitte wählen/);
    await foto(page, 'admin-suche-390-vorher');

    await suche(page).tap();
    const liste = page.getByRole('listbox', { name: 'Box, Kunde, Anlage, Person suchen' });
    await expect(liste).toBeVisible();
    await foto(page, 'admin-suche-390-offen');
    await liste.getByRole('option', { name: new RegExp(MIT) }).tap();

    // Der Wechsel ist sichtbar: die Landung des Kunden (seine einzige Anlage), das Band, das Feld.
    await expect(page).toHaveURL(new RegExp(`#/anlage/${MIT_ANLAGE}$`));
    expect(await override(page)).toBe(MIT_ID);
    await expect(page.locator('.vp-kundenansicht-band')).toContainText(MIT);
    await expect(suche(page)).toHaveText(new RegExp(MIT));
    await foto(page, 'admin-suche-390-gewaehlt');

    // Aus der Kundensicht heraus ein anderer Kunde: Suchwort tippen, antippen - die Sicht wechselt mit.
    await suche(page).tap();
    await page.getByRole('combobox', { name: /durchsuchen/ }).fill('Muster');
    await page.getByRole('listbox', { name: 'Box, Kunde, Anlage, Person suchen' }).getByRole('option', { name: new RegExp(OHNE) }).tap();
    await expect(page).toHaveURL(/#\/portfolio$/);
    expect(await override(page)).toBe(OHNE_ID);
    await expect(page.locator('.vp-kundenansicht-band')).toContainText(OHNE);
    await expect(suche(page)).toHaveText(new RegExp(OHNE));
    await foto(page, 'admin-suche-390-zweiter-kunde');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

    // Zurück zur Plattform: das Feld ist wieder leer.
    await page.getByRole('button', { name: 'Zur Plattform zurück' }).tap();
    expect(await override(page)).toBeNull();
    await expect(suche(page)).toHaveText(/Kunde suchen …/);
  });
});

test('1440 px: Kunde wählen öffnet die Kundensicht', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/mandantensicht-navigation.html#/mandanten');
  await suche(page).click();
  await page.getByRole('listbox', { name: 'Box, Kunde, Anlage, Person suchen' }).getByRole('option', { name: new RegExp(MIT) }).click();
  await expect(page).toHaveURL(new RegExp(`#/anlage/${MIT_ANLAGE}$`));
  expect(await override(page)).toBe(MIT_ID);
  await expect(suche(page)).toHaveText(new RegExp(MIT));
  await foto(page, 'admin-suche-1440-gewaehlt');
});
