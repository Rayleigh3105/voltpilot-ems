import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Plattform-Administrator › Mandanten › Mandant öffnen › „In Mandanten-Ansicht springen", OHNE wirksame
 * Unterstützung. Seit der Mandanten-Umschalter geschlossen ist (AP-03 IP-15), nimmt die API den Mandanten dann
 * nicht an. Früher las das Portal das als „Kein Standort zugewiesen"; jetzt nennt eine eigene Karte Grund und Weg,
 * und der Dialog sagt bei einem Mandanten ohne Standort vorher, dass es zurzeit keinen Weg hinein gibt.
 * Wirt: `mandantensprung.html` (ganzer `App`, gefälschter Server).
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

test('ohne Unterstützung: der Sprung endet auf der Karte mit Grund und Weg, nicht bei „Kein Standort zugewiesen"', async ({ page }) => {
  const dialog = await oeffne(page, 'Solarhof Beispiel');
  // Dieser Mandant hat einen Standort: kein Hinweis im Kasten, beide Wege stehen da.
  await expect(dialog.getByRole('button', { name: 'Notfall-Zugriff', exact: true })).toBeVisible();
  await expect(dialog.getByRole('note')).toHaveCount(0);
  await expect(dialog.getByText(/öffnet sich nur mit einer Unterstützung/)).toBeVisible();
  await passt(page, dialog, 'p, h3, button, .vp-alert');

  await dialog.getByRole('button', { name: /In Mandanten-Ansicht springen/ }).click();
  const titel = page.getByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' });
  await expect(titel).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toHaveCount(0);
  const karte = page.locator('main .vp-card', { has: titel });
  await expect(karte).toContainText('Für Solarhof Beispiel besteht keine wirksame Unterstützung.');
  await expect(karte).toContainText('„Unterstützung anfragen“ oder „Notfall-Zugriff“');
  await passt(page, karte, 'h1, p, button');

  // Der Weg zurück verlässt den Mandanten und zeigt wieder die Liste.
  await karte.getByRole('button', { name: 'Zu den Mandanten' }).click();
  await expect(page.getByRole('button', { name: 'Details zu Solarhof Beispiel' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override'))).toBeNull();
});

test('Mandant ohne Standort: der Dialog sagt, dass und warum die Plattform ihn zurzeit nicht betreten kann', async ({ page }) => {
  const dialog = await oeffne(page, 'Musterwerk Nord GmbH');
  const hinweis = dialog.getByRole('note');
  await expect(hinweis).toBeVisible();
  await expect(hinweis).toContainText('Dieser Mandant hat noch keinen Standort.');
  await expect(hinweis).toContainText('gelten immer für Standorte, nie für das ganze Unternehmen');
  await expect(hinweis).toContainText('kann die Mandanten-Ansicht deshalb zurzeit nicht öffnen');
  // Nichts wird versteckt: Anfrage, Notfall-Zugriff und Sprung bleiben, wie sie sind.
  await expect(dialog.getByRole('button', { name: 'Unterstützung anfragen' })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: /In Mandanten-Ansicht springen/ })).toBeEnabled();
  await passt(page, dialog, 'p, h3, button, .vp-alert');
});

test('ein gemerkter Mandant ohne Unterstützung zeigt nach dem Neuladen dieselbe Karte', async ({ page }) => {
  // Der Umschalter merkt sich den Mandanten in der Sitzung; auch dieser Weg endet nicht bei „Kein Standort zugewiesen".
  await page.goto('/e2e/mandantensprung.html?mandant=ohne#/uebersicht');
  const titel = page.getByRole('heading', { name: 'Kein Zugriff auf diesen Kundenbereich' });
  await expect(titel).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kein Standort zugewiesen' })).toHaveCount(0);
  const karte = page.locator('main .vp-card', { has: titel });
  await expect(karte).toContainText('Für Musterwerk Nord GmbH besteht keine wirksame Unterstützung.');
  await passt(page, karte, 'h1, p, button');
});
