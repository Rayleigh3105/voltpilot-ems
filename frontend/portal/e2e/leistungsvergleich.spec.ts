import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS AP-17 IP-24 (R8) auf der Bühne `leistungsvergleich`: Ines Kaltenbach legt am 12.01.2028 den Leistungsvergleich
 * Dezember 2027 für KZ-0004 an (Kennzahl ist Pflicht), sieht den Entwurf mit den acht Abschnitten, gibt ihn als Stand
 * Nr. 1 frei und ruft das PDF ab — bei 375 und 1440 px, ohne Querlauf. Die Spec importiert keine Fixtures (sie laden
 * `api.ts`, dem im Node-Lauf `import.meta.env` fehlt); die Sätze stehen wörtlich.
 */

const AM_12_01 = new Date('2028-01-12T08:30:00Z');
const ABSCHNITTE = ['kopf', 'kennzahl', 'bezugsbasis', 'vergleich_je_periode', 'urteil', 'grenzen_und_vorbehalte', 'statische_faktoren', 'quellenverzeichnis'];
const STAND_SATZ = 'Leistungsvergleich Stromeinsatz Spritzguss je kg, Dezember 2027 · Stand Nr. 1 vom 12.01.2028 · Bezugsbasis BB-0001, Fassung 2 · Prüfsumme 4e2d…';

async function querlauf(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const breite of [375, 1440]) {
  test(`Leistungsvergleich anlegen, freigeben und PDF abrufen (${breite} px)`, async ({ page }) => {
    await page.clock.setFixedTime(AM_12_01);
    await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
    await page.goto('/e2e/leistungsvergleich.html');
    await page.getByRole('button', { name: 'Bericht anlegen', exact: true }).click();

    const dialog = page.getByTestId('bericht-anlegen');
    await dialog.getByRole('radio', { name: /^Leistungsvergleich/ }).check();
    const kennzahl = page.getByTestId('bericht-anlegen-kennzahl');
    await expect(kennzahl.getByRole('radio')).toHaveCount(1);
    // Ohne Kennzahl sendet der Dialog nicht (sonst 400).
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();
    await expect(kennzahl.getByRole('alert')).toHaveText('Wählen Sie die Kennzahl.');
    expect(await page.evaluate(() => (window as unknown as { __lv: { anlegen: unknown[] } }).__lv.anlegen.length)).toBe(0);
    await kennzahl.getByRole('radio', { name: /KZ-0004/ }).check();
    expect(await querlauf(page)).toBe(0);
    await page.getByRole('button', { name: 'Anlegen', exact: true }).click();

    // Entwurf: acht Abschnitte, ungesichert.
    await expect(page.getByTestId('leistungsvergleich')).toBeVisible();
    for (const s of ABSCHNITTE) await expect(page.getByTestId(`bericht-abschnitt-${s}`)).toBeVisible();
    await expect(page.getByTestId('leistungsvergleich-stand')).toHaveText('ungesichert — noch kein Stand');
    await expect(page.getByTestId('monat-2027-12').getByTestId('roh-urteil')).toHaveText('ohne Urteil');
    expect(await querlauf(page)).toBe(0);

    // Freigabe → Stand Nr. 1.
    await page.getByTestId('bericht-hebel').getByRole('button', { name: 'Als Berichtsstand freigeben' }).click();
    await page.getByTestId('bericht-freigeben-knopf').click();
    await expect(page.getByTestId('leistungsvergleich-stand')).toHaveText(STAND_SATZ);
    await expect(page.getByTestId('bericht-pruefsumme')).toBeVisible();
    expect(await querlauf(page)).toBe(0);

    // PDF-Abruf am Stand.
    const download = page.waitForEvent('download');
    await page.getByTestId('leistungsvergleich-dateien').getByRole('button', { name: 'PDF', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('bericht-BR-2028-0001-nr1.pdf');
    await expect(page.getByTestId('leistungsvergleich-abruf')).toHaveText('PDF von Stand Nr. 1 abgerufen — der Abruf ist protokolliert.');
    expect(await page.evaluate(() => (window as unknown as { __lv: { dateien: string[] } }).__lv.dateien)).toEqual(['1.pdf']);
  });
}
