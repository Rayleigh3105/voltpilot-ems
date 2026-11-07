import { expect, test, type Page } from '@playwright/test';

/**
 * Admin › Plattform am Telefon (Auftrag `vp-admin-mobil-ueberholung`):
 * - Übersicht: die vier Kennzahl-Kacheln kompakt (Zahl und Wort nebeneinander), „Braucht dich“ im ersten Bildschirm;
 * - Katalog: die drei Unter-Reiter mit Kurzwort in voller Breite (vorher „Prog…“ abgeschnitten), der Name bleibt lang;
 * - Gerätevorlagen, Steuerungs-Freigabe und Prognosemodelle als kompakte Zeilen statt Etikett/Wert-Karten.
 * Wirte: `plattform-uebersicht.html`, `katalog-bereich.html`.
 */
const PHONE = { width: 390, height: 844 };

async function keinUeberlauf(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

async function ohneEtiketten(page: Page, tabelle: string) {
  return page.locator(tabelle).locator('td').evaluateAll((tds) => tds.filter((td) => {
    const c = getComputedStyle(td, '::before').content;
    // `vp-zeilen-etikett` setzt sein kleines Etikett bewusst - gezählt werden nur die alten GROSS-Etiketten.
    return td.getBoundingClientRect().height > 0 && c !== 'none' && c !== 'normal' && c !== '""'
      && getComputedStyle(td, '::before').textTransform === 'uppercase';
  }).length);
}

test('390 px: Übersicht - vier kompakte Kacheln, „Braucht dich“ im ersten Bildschirm', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/e2e/plattform-uebersicht.html');
  const kacheln = page.getByTestId('ueb-kacheln');
  await expect(kacheln).toBeVisible();
  const mass = await kacheln.evaluate((k) => ({
    hoehe: k.getBoundingClientRect().height,
    zeilen: [...k.querySelectorAll('.vp-ueb-kachel')].map((c) => {
      const zahl = c.querySelector('.vp-ueb-kachel-zahl')!.getBoundingClientRect();
      const wort = c.querySelector('.vp-ueb-kachel-wort')!.getBoundingClientRect();
      return { nebeneinander: wort.left > zahl.right - 1 && wort.top < zahl.bottom };
    }),
  }));
  expect(mass.hoehe, 'vier Kacheln unter 200 px (vorher ~ 330 px)').toBeLessThan(200);
  for (const z of mass.zeilen) expect(z.nebeneinander, 'Zahl und Wort nebeneinander').toBe(true);
  await expect(page.getByRole('heading', { name: /Braucht dich/ }).first()).toBeInViewport();
  await keinUeberlauf(page);
});

test('390 px: Katalog-Reiter tragen ein Kurzwort und passen, der Name bleibt lang', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/e2e/katalog-bereich.html?sektion=prognose');
  const reiter = page.locator('.vp-katalog-tabs');
  await expect(reiter.getByRole('tab', { name: 'Prognosemodelle' })).toHaveText(/Prognose/);
  await expect(reiter.getByRole('tab', { name: 'Gerätevorlagen' })).toBeInViewport({ ratio: 1 });
  await expect(reiter.getByRole('tab', { name: 'Prognosemodelle' })).toBeInViewport({ ratio: 1 });
  expect(await reiter.evaluate((r) => r.scrollWidth - r.clientWidth)).toBeLessThanOrEqual(1);
  await keinUeberlauf(page);
});

for (const [sektion, tabelle, hoechstens] of [
  ['vorlagen', '[data-testid="vorlagen"]', 190],
  ['modelle', '.vp-sf-tabelle', 200],
  ['prognose', '.vp-prognose-tabelle', 140],
] as const) {
  test(`390 px: Katalog › ${sektion} als kompakte Zeilen ohne GROSS-Etiketten`, async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(`/e2e/katalog-bereich.html?sektion=${sektion}`);
    const zeile = page.locator(`${tabelle} tbody tr`).first();
    await expect(zeile).toBeVisible();
    expect(await ohneEtiketten(page, tabelle)).toBe(0);
    const hoehen = await page.locator(`${tabelle} tbody tr`).evaluateAll((trs) => trs.map((tr) => tr.getBoundingClientRect().height));
    for (const h of hoehen) expect(h, `Zeile unter ${hoechstens} px`).toBeLessThan(hoechstens);
    await keinUeberlauf(page);
  });
}
