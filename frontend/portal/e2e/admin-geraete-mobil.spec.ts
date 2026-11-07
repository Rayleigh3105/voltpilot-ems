import { expect, test, type Page } from '@playwright/test';

/**
 * Admin › Geräte am Telefon (Auftrag `vp-admin-mobil-ueberholung`):
 * - Geräte-Liste: je Box eine kompakte Zeile statt einer ~ 350 px hohen Etikett/Wert-Karte;
 * - Reiter „Geräte · Software · Werkstatt · Fernwartung“ passen bei 390 px ohne Abschneiden;
 * - Geräteakte: Zustand und Stand in einer Zeile, die Knöpfe in einer Reihe darunter;
 * - Fernwartung: Boxen und Techniker-Zugänge als kompakte Zeilen, Zustand neben dem Namen.
 * Wirte: `box-updates.html` (Liste, Akte) und `fernwartung.html`.
 */
const PHONE = { width: 390, height: 844 };

async function keinUeberlauf(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

async function zeilenHoehen(page: Page, tabelle: string) {
  return page.locator(`[data-testid="${tabelle}"] tbody tr:not(.vp-fw-unterzeile)`).evaluateAll((trs) =>
    trs.map((tr) => ({ text: (tr.textContent ?? '').trim().slice(0, 30), hoehe: tr.getBoundingClientRect().height })),
  );
}

test('390 px: die Geräte-Liste zeigt je Box eine kompakte Zeile ohne Etiketten', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/e2e/box-updates.html');
  await page.getByRole('button', { name: 'Geräte', exact: true }).click();
  const liste = page.getByTestId('geraete-liste');
  await expect(liste).toContainText('Solarpark Sonnenhof');
  for (const z of await zeilenHoehen(page, 'geraete-liste')) {
    expect(z.hoehe, `${z.text}: unter 280 px (vorher 350 - 470 px)`).toBeLessThan(280);
  }
  const etiketten = await liste.locator('td').evaluateAll((tds) => tds.filter((td) => {
    const c = getComputedStyle(td, '::before').content;
    return td.getBoundingClientRect().height > 0 && c !== 'none' && c !== 'normal' && c !== '""';
  }).length);
  expect(etiketten, 'keine BOX/VERBINDUNG/SOFTWARE-Etiketten mehr').toBe(0);
  // Jede Zeile bleibt per Knopf erreichbar (Tastatur, Vorleser).
  await expect(liste.getByRole('button', { name: /Geräteakte öffnen für/ }).first()).toBeVisible();
  await keinUeberlauf(page);
});

test('390 px: die vier Geräte-Reiter passen in die Breite', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/e2e/box-updates.html');
  const reiter = page.locator('.vp-geraete-tabs');
  await expect(reiter).toBeVisible();
  const mass = await reiter.evaluate((r) => ({
    ueber: r.scrollWidth - r.clientWidth,
    rechts: Math.max(...[...r.children].map((b) => b.getBoundingClientRect().right)),
    rand: r.getBoundingClientRect().right,
  }));
  expect(mass.ueber, 'kein Reiter scrollt aus dem Bild').toBeLessThanOrEqual(1);
  expect(mass.rechts).toBeLessThanOrEqual(mass.rand + 1);
  await expect(reiter.getByRole('tab', { name: 'Fernwartung' })).toBeInViewport({ ratio: 1 });
});

test('390 px: der Kopf der Geräteakte - Zustand vorn, Stand dabei, Knöpfe in einer Reihe', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/e2e/box-updates.html#');
  await page.getByRole('button', { name: 'Geräte', exact: true }).click();
  await page.getByTestId('geraete-liste').getByText('Solarpark Sonnenhof').first().click();
  const zustand = page.getByTestId('akte-zustand');
  await expect(zustand).toContainText('Verbunden');
  const mass = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
    const knoepfe = [...document.querySelectorAll('.vp-akte-aktionen > .vp-btn, .vp-akte-aktionen > .vp-akte-menu')].map((b) => b.getBoundingClientRect());
    return { zustand: r('[data-testid="akte-zustand"]'), stand: r('[data-testid="akte-stand"]'), status: r('.vp-akte-status'), knoepfe };
  });
  // Der Zustand steht vor dem Stand (oben bzw. links), beide zusammen höchstens zwei Zeilen.
  expect(mass.zustand.top).toBeLessThanOrEqual(mass.stand.top + 1);
  expect(mass.status.height, 'Zustand + Stand höchstens zwei Zeilen').toBeLessThan(64);
  for (const k of mass.knoepfe) expect(k.top, 'Knöpfe unter dem Zustand').toBeGreaterThanOrEqual(mass.status.bottom - 1);
  expect(mass.knoepfe.length).toBeGreaterThanOrEqual(2);
  const oben = mass.knoepfe.map((k) => Math.round(k.top));
  expect(Math.max(...oben) - Math.min(...oben), 'die Knöpfe stehen in einer Reihe').toBeLessThan(6);
  await keinUeberlauf(page);
});

test('390 px: Fernwartung - Boxen und Zugänge als kompakte Zeilen, Zustand neben dem Namen', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/e2e/fernwartung.html');
  const zugaenge = page.getByTestId('fw-techniker');
  await expect(zugaenge).toContainText('Kim (Tablet)');
  for (const z of await zeilenHoehen(page, 'fw-techniker')) {
    expect(z.hoehe, `${z.text}: unter 330 px (vorher ~ 480 px)`).toBeLessThan(330);
  }
  const kim = zugaenge.locator('tr', { hasText: 'Kim (Tablet)' });
  const lage = await kim.evaluate((tr) => {
    const r = (s: string) => tr.querySelector(s)!.getBoundingClientRect();
    return { name: r('.vp-fw-name'), status: r('td[data-label="Status"] .vp-badge, td[data-label="Status"] > *') };
  });
  expect(Math.abs(lage.status.top - lage.name.top), 'der Zustand steht neben dem Namen').toBeLessThan(12);
  // Etiketten, die ohne Wort nichts sagen, stehen klein davor („Tunnel 10.10.32.5“, „Letzter Handshake …“).
  await expect(kim.getByTestId('fw-handshake')).toBeVisible();
  expect(await kim.getByTestId('fw-handshake').evaluate((td) => getComputedStyle(td, '::before').content)).toContain('Letzter Handshake');
  for (const z of await zeilenHoehen(page, 'fw-boxen')) {
    expect(z.hoehe, `${z.text}: Box-Zeile unter 440 px (mit zwei offenen Fenstern)`).toBeLessThan(440);
  }
  await keinUeberlauf(page);
});
