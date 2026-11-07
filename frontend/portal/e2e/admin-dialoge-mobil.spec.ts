import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Admin-Dialoge (Auftrag `vp-admin-mobil-ueberholung`): ein Feld aus Beschriftung, Textfeld und Hilfe
 * (`<label className="vp-field">`) hatte keine eigene Regel - Beschriftung, ein schmales Textfeld und der
 * Hilfesatz standen nebeneinander in EINER Zeile („Grund *“ beim Öffnen eines Fernwartungs-Fensters,
 * die JSON-Felder bei „Vorlage eintragen“). Jetzt untereinander, das Textfeld über die volle Breite.
 * Wirte: `fernwartung.html`, `katalog-bereich.html`.
 */
async function feldUntereinander(page: Page, feld: Locator) {
  const m = await feld.evaluate((f) => {
    const r = (e: Element | null) => e!.getBoundingClientRect();
    return { feld: r(f), label: r(f.querySelector('.vp-field-label')), text: r(f.querySelector('textarea')), hilfe: f.querySelector('.vp-field-help') ? r(f.querySelector('.vp-field-help')) : null };
  });
  expect(m.text.top, 'Textfeld unter der Beschriftung').toBeGreaterThanOrEqual(m.label.bottom - 1);
  expect(m.text.width, 'Textfeld über die volle Breite').toBeGreaterThan(m.feld.width - 2);
  if (m.hilfe) expect(m.hilfe.top, 'Hilfe unter dem Textfeld').toBeGreaterThanOrEqual(m.text.bottom - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

for (const breite of [390, 1440]) {
  test(`${breite} px: „Fernwartung öffnen“ - „Grund *“ steht unter seiner Beschriftung in voller Breite`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
    await page.goto('/e2e/fernwartung.html');
    await page.getByTestId('fw-boxen').locator('tr').filter({ hasText: 'edge-k7m2xq3' }).getByRole('button', { name: 'Fenster öffnen' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const feld = dialog.locator('label.vp-field', { hasText: 'Grund' });
    await feldUntereinander(page, feld);
    // Bedienbar: das Feld nimmt Text an (Name aus der Beschriftung).
    await dialog.getByLabel('Grund *').fill('Update einspielen');
    await expect(dialog.getByLabel('Grund *')).toHaveValue('Update einspielen');
  });

  test(`${breite} px: „Vorlage eintragen“ - die JSON-Felder stehen untereinander`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
    await page.goto('/e2e/katalog-bereich.html?sektion=vorlagen');
    await page.getByRole('button', { name: '＋ Vorlage eintragen' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const felder = dialog.locator('label.vp-field');
    expect(await felder.count()).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < await felder.count(); i++) {
      await felder.nth(i).scrollIntoViewIfNeeded();
      await feldUntereinander(page, felder.nth(i));
    }
  });
}
