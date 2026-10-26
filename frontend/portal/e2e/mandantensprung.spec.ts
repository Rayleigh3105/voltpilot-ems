import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Plattform-Administrator › Mandanten › Mandant öffnen › „In Mandanten-Ansicht springen", OHNE Unterstützung.
 * Seit dem 26.10.2026 ist der Mandanten-Umschalter wieder offen (Entscheidung des Betreibers): die API nimmt den
 * Mandanten an, der Sprung landet in seiner Ansicht - auch bei einem Mandanten ohne Standort und beim gemerkten
 * Mandanten nach dem Neuladen. Ist der Schalter aus (Not-Aus, `?schalter=aus`), nennt die Karte Grund und Weg statt
 * „Kein Standort zugewiesen". Wirt: `mandantensprung.html` (ganzer `App`, gefälschter Server).
 */
async function oeffne(page: Page, mandant: string): Promise<Locator> {
  await page.goto('/e2e/mandantensprung.html#/mandanten');
  await page.getByRole('button', { name: `Details zu ${mandant}` }).click();
  const dialog = page.getByRole('dialog', { name: mandant });
  await expect(dialog.getByRole('heading', { name: 'Unterstützung' })).toBeVisible();
  return dialog;
}

/** Kein Querrollen der Seite; jedes Element der Fläche bleibt in ihr und schneidet seinen Text nicht ab. */
async function passt(page: Page, flaeche: Locator, teile: string) {
  const mass = await flaeche.evaluate((f, auswahl) => {
    const rand = f.getBoundingClientRect();
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      ueberstehend: [...f.querySelectorAll<HTMLElement>(auswahl)].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.left < rand.left - 1 || r.right > rand.right + 1 || e.scrollWidth > e.clientWidth + 1);
      }).map((e) => (e.textContent ?? '').trim().slice(0, 50)),
    };
  }, teile);
  expect(mass.seite, 'die Seite rollt nicht quer').toBeLessThanOrEqual(1);
  expect(mass.ueberstehend, 'nichts steht über oder ist abgeschnitten').toEqual([]);
}

test('ohne Unterstützung: der Sprung landet in der Ansicht des Mandanten', async ({ page }) => {
  const dialog = await oeffne(page, 'Solarhof Beispiel');
  // Dieser Mandant hat einen Standort: kein Hinweis im Kasten, beide Wege stehen da.
  await expect(dialog.getByRole('button', { name: 'Notfall-Zugriff', exact: true })).toBeVisible();
  await expect(dialog.getByRole('note')).toHaveCount(0);
  await expect(dialog.getByText(/Eine Unterstützung oder ein Notfall-Zugriff ist dafür nicht nötig/)).toBeVisible();
  await passt(page, dialog, 'p, h3, button, .vp-alert');

  await dialog.getByRole('button', { name: /In Mandanten-Ansicht springen/ }).click();
  await expect(page.getByRole('heading', { name: 'Solarhof Dach' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override'))).toBe('a1000000-0000-4000-8000-000000000001');
  // Die Anlagenseite selbst ändert dieser Sprung nicht (ihr Titel kürzt am Telefon mit Auslassung); hier zählt nur,
  // dass die Seite nicht quer rollt.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

test('Mandant ohne Standort: der Dialog sagt, warum keine Unterstützung geht, und der Sprung öffnet sein Portfolio', async ({ page }) => {
  const dialog = await oeffne(page, 'Musterwerk Nord GmbH');
  const hinweis = dialog.getByRole('note');
  await expect(hinweis).toBeVisible();
  await expect(hinweis).toContainText('Dieser Mandant hat noch keinen Standort.');
  await expect(hinweis).toContainText('gelten immer für Standorte, nie für das ganze Unternehmen');
  await expect(hinweis).toContainText('„In Mandanten-Ansicht springen“ öffnet sie trotzdem');
  // Nichts wird versteckt: Anfrage, Notfall-Zugriff und Sprung bleiben, wie sie sind.
  await expect(dialog.getByRole('button', { name: 'Unterstützung anfragen' })).toBeEnabled();
  await passt(page, dialog, 'p, h3, button, .vp-alert');

  await dialog.getByRole('button', { name: /In Mandanten-Ansicht springen/ }).click();
  // Zwei Anlagen, kein Standort: dieselbe Landung wie für den Kunden selbst, das Portfolio.
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  await expect(page).toHaveURL(/#\/portfolio$/);
  await expect(page.getByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toHaveCount(0);
});

test('ein gemerkter Mandant öffnet sich nach dem Neuladen wieder in seiner Ansicht', async ({ page }) => {
  // Der Umschalter merkt sich den Mandanten in der Sitzung; auch dieser Weg landet beim Mandanten.
  await page.goto('/e2e/mandantensprung.html?mandant=mit#/uebersicht');
  await expect(page.getByRole('heading', { name: 'Solarhof Dach' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toHaveCount(0);
});

test('Not-Aus: bei abgeschaltetem Sprung endet er auf der Karte mit Grund und Weg', async ({ page }) => {
  await page.goto('/e2e/mandantensprung.html?schalter=aus&mandant=ohne#/uebersicht');
  const titel = page.getByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' });
  await expect(titel).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toHaveCount(0);
  const karte = page.locator('main .vp-card', { has: titel });
  await expect(karte).toContainText('Die Ansicht von Musterwerk Nord GmbH hat sich nicht geöffnet.');
  await expect(karte).toContainText('in dieser Umgebung abgeschaltet');
  await expect(karte).toContainText('„Unterstützung anfragen“ oder „Notfall-Zugriff“');
  await passt(page, karte, 'h1, p, button');

  // Der Weg zurück verlässt den Mandanten und zeigt wieder die Liste.
  await karte.getByRole('button', { name: 'Zu den Mandanten' }).click();
  await expect(page.getByRole('button', { name: 'Details zu Musterwerk Nord GmbH' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override'))).toBeNull();
});
