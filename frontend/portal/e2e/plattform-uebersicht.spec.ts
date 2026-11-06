import { expect, test } from '@playwright/test';

/** Kein waagrechter Überlauf der Seite (Muster `box-updates.spec.ts`). */
async function ueberlauf(page: import('@playwright/test').Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
}

test('Plattform › Übersicht: vier Kacheln, Braucht dich, Flotte, Dienste - Antwort zuerst', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/plattform-uebersicht.html');

  await expect(page.getByRole('tab', { name: 'Übersicht', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('ueb-stand')).toContainText('alle 30 s');

  // Vier Kacheln, je eine Ausnahme-Zahl.
  const kacheln = page.getByTestId('ueb-kacheln');
  await expect(kacheln).toContainText('Verbindung');
  await expect(kacheln).toContainText('Software');
  await expect(kacheln).toContainText('Steuerung');
  await expect(kacheln).toContainText('Plan');

  // Braucht dich, in der Rangfolge aus dem Report: Fehler > Zurückhalten >
  // offline mit Anfrage > Stufe 1 > Fenster ohne Schlüssel > Werkstatt nicht
  // bereit > nicht zugeordnete Anmeldung.
  const zeilen = page.getByTestId('ueb-braucht-zeile');
  await expect(zeilen).toHaveCount(7);
  await expect(zeilen.nth(0)).toContainText('Pumpwerk Ost');
  await expect(zeilen.nth(1)).toContainText('Gewerbepark West');
  await expect(zeilen.nth(2)).toContainText('Hof Lindenallee');
  await expect(zeilen.nth(3)).toContainText('Kleingarten Ostend');
  await expect(zeilen.nth(4)).toContainText('VP-BOX-1001');
  await expect(zeilen.nth(5)).toContainText('edge-m1');
  await expect(zeilen.nth(6)).toContainText('edge-q7xk2p9');

  // Eine Zeile führt in die Geräteakte - nie in ein Fenster.
  await zeilen.nth(0).click();
  await expect(page.getByTestId('akte-zustand')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Flottenbild: jede Box ein Feld, Tippen öffnet die Akte (eigener Aufruf,
  // da die Vorschau ohne echtes Routing navigiert - kein Browserverlauf).
  await page.goto('/e2e/plattform-uebersicht.html');
  const flotte = page.getByTestId('ueb-flotte');
  await expect(flotte).toBeVisible();
  // Eine auffällige Box ist ein beschriftetes Element (Name sichtbar, nicht
  // nur im Tooltip) - „ich brauch ewig, bis ich da was erkenne" (Captain).
  const ersterChip = flotte.locator('.vp-ueb-flotte-chip').first();
  await expect(ersterChip).toBeVisible();
  await expect(ersterChip).toContainText(/Hof Lindenallee|Kleingarten Ostend|Pumpwerk Ost|Box Halle 3/);
  await flotte.locator('button').first().click();
  await expect(page.getByTestId('akte-zustand')).toBeVisible();

  // Dienste: Tunnel- und Werkstatt-Dienst mit Alter (E7).
  await page.goto('/e2e/plattform-uebersicht.html');
  const dienste = page.getByTestId('ueb-dienste');
  await expect(dienste).toContainText('Tunnel-Dienst');
  await expect(dienste).toContainText('Werkstatt-Dienst');

  // Bewusst ohne Geld (Captain-Entscheid Q2).
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('€');
  expect(text).not.toMatch(/verdient|gespart|Erlös/i);

  expect(errors).toEqual([]);
});

test('Plattform › Übersicht: Braucht dich - erledigen, einklappbar wieder ansehen, zurückholen', async ({ page }) => {
  await page.goto('/e2e/plattform-uebersicht.html');
  const zeilen = page.getByTestId('ueb-braucht-zeile');
  const vorher = await zeilen.count();
  await expect(page.getByTestId('ueb-braucht-dich')).toBeVisible();

  const erste = zeilen.first();
  await erste.getByRole('button', { name: /als erledigt markieren/i }).click();
  await expect(zeilen).toHaveCount(vorher - 1);

  const auf = page.getByRole('button', { name: /Erledigte anzeigen/ });
  await expect(auf).toContainText('(1)');
  await auf.click();
  await expect(page.locator('.vp-ueb-braucht-erledigte-zeile')).toHaveCount(1);

  await page.getByRole('button', { name: /zurückholen/ }).click();
  await expect(zeilen).toHaveCount(vorher);
});

test('Plattform › Übersicht: Software-Kachel führt auf die Software-Seite', async ({ page }) => {
  await page.goto('/e2e/plattform-uebersicht.html');
  await page.getByTestId('ueb-kacheln').getByRole('button', { name: /Software/ }).click();
  await expect(page.getByRole('tab', { name: 'Software', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('Plattform › Übersicht am Telefon: Zeilen statt Reiterleiste, Wort-Budget, kein Überlauf', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/e2e/plattform-uebersicht.html');

  // Die waagrecht scrollende Reiterleiste weicht Zeilen am Ende (§4.3).
  await expect(page.getByRole('tablist', { name: 'Plattform' })).toBeHidden();
  const reiter = page.getByTestId('ueb-reiter-zeilen');
  await expect(reiter).toContainText('Software');
  await expect(reiter).toContainText('Werkstatt');
  await expect(reiter).toContainText('Fernwartung');
  await expect(reiter).toContainText('Katalog');
  await reiter.getByText('Fernwartung', { exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Fernwartung' })).toBeVisible();
  await page.goto('/e2e/plattform-uebersicht.html');

  // Erster Bildschirm: Kopf + vier Kacheln - das Board misst hier 50 Wörter.
  const woerter = await page.evaluate(() => {
    const kopf = document.querySelector('.vp-admin-head');
    const kacheln = document.querySelector('[data-testid="ueb-kacheln"]');
    const text = [kopf, kacheln].filter(Boolean).map((el) => el!.textContent ?? '').join(' ');
    return text.trim().split(/\s+/).filter(Boolean).length;
  });
  expect(woerter).toBeLessThanOrEqual(50);

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const seite = await ueberlauf(page);
    expect(seite, `Seitenüberlauf bei ${width}px`).toBeLessThanOrEqual(1);
  }
});
