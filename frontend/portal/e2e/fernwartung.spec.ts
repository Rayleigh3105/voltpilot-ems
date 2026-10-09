import { expect, test } from '@playwright/test';

// WebKit braucht im Container unter parallelen Projekten 1-3 s je Klick; die drei Abläufe
// hier sind klickreich und lagen damit am 30-s-Vorgabewert (einzeln laufen sie in ~14 s).
test.describe.configure({ timeout: 60_000 });

test('Fernwartung: Lage, Sperrgründe und Fenster öffnen auf jeder Bildschirmgröße', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/fernwartung.html');

  await expect(page.getByRole('tab', { name: 'Fernwartung' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('fw-dienst')).toContainText('Tunnel-Dienst holt ab');
  await expect(page.getByText(/meldet der Tunnel-Dienst nicht zurück/)).toBeVisible();

  const boxen = page.getByTestId('fw-boxen');
  const gesperrt = boxen.locator('tr').filter({ hasText: 'edge-q2w3e4r' });
  await expect(gesperrt.getByRole('button', { name: 'Fenster öffnen' })).toBeDisabled();
  await expect(gesperrt).toContainText('gesperrt - erst entsperren');
  // Einziger aktiver Zugang hat an dieser Box schon ein Fenster: gesperrt mit Grund.
  const pilot = boxen.locator('tr').filter({ hasText: 'edge-zay5sdd' });
  await expect(pilot.getByRole('button', { name: 'Fenster öffnen' })).toBeDisabled();
  await expect(pilot).toContainText('schon ein Fenster');

  const frei = boxen.locator('tr').filter({ hasText: 'edge-k7m2xq3' });
  await frei.getByRole('button', { name: 'Fenster öffnen' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: /Techniker-Zugang/ })).toContainText('Alex (Laptop)');
  await dialog.getByRole('combobox', { name: /Techniker-Zugang/ }).click();
  await expect(page.getByRole('option', { name: /Werkstatt-Tablet/ })).toHaveAttribute('aria-disabled', 'true');
  // Zwei Zugänge heißen gleich; der gesperrte bleibt mit Grund sichtbar, wählbar ist der aktive.
  await expect(page.getByRole('option', { name: /Alex \(Laptop\)/ })).toHaveCount(2);
  await page.getByRole('option', { name: /Alex \(Laptop\)/ }).filter({ hasNotText: 'Zugang gesperrt' }).click();
  await dialog.getByLabel('Grund *').fill('go-e prüfen');
  await dialog.getByRole('button', { name: 'Fenster öffnen' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(frei.getByText(/^bis .* · Alex \(Laptop\)$/)).toBeVisible();

  await expect(page.getByTestId('fw-protokoll')).toContainText('Fenster geöffnet');

  // Kein horizontaler Überlauf der Seite (Tabellen scrollen lokal).
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('fernwartung.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('Fernwartung: ein gesperrter Zugang lässt sich nach einer Rückfrage endgültig löschen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/fernwartung.html');

  const zugaenge = page.getByTestId('fw-techniker');
  const alt = zugaenge.locator('tr').filter({ hasText: '10.10.32.2' });
  const neu = zugaenge.locator('tr').filter({ hasText: '10.10.32.3' });
  // Derselbe Name zweimal: der alte gesperrt, der neue aktiv.
  await expect(zugaenge.locator('tr').filter({ hasText: 'Alex (Laptop)' })).toHaveCount(2);
  await expect(alt).toContainText('gesperrt');
  await expect(neu).toContainText('aktiv');
  await expect(neu.getByRole('button', { name: 'Löschen' })).toHaveCount(0);

  // Die Rückfrage sagt in einem Satz, was passiert - und passt ganz auf den Schirm.
  const ausloeser = alt.getByRole('button', { name: 'Löschen' });
  await ausloeser.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const titel = dialog.getByRole('heading', { name: 'Zugang löschen?' });
  await expect(titel).toBeVisible();
  const satz = dialog.getByText(/verschwindet endgültig aus allen Listen und lässt sich nicht wiederherstellen\./);
  await expect(satz).toContainText('„Alex (Laptop)“ (10.10.32.2, dTkajHaC…V3kk=)');
  await expect(dialog.getByTestId('confirm-consequences')).toContainText('bleiben vergeben');
  const bestaetigen = dialog.getByRole('button', { name: 'Endgültig löschen' });
  await expect(bestaetigen).toBeInViewport({ ratio: 1 });
  await expect(satz).toBeInViewport({ ratio: 1 });
  for (const teil of [titel, satz, bestaetigen, dialog.getByRole('button', { name: 'Abbrechen' })]) {
    // Nichts abgeschnitten: kein Text ragt über seinen Kasten hinaus.
    expect(await teil.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: test.info().outputPath('loeschen-rueckfrage.png') });

  // Escape bricht ab: nichts gelöscht, der Fokus kehrt zum Auslöser zurück.
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(alt).toBeVisible();
  await expect(ausloeser).toBeFocused();

  await ausloeser.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Endgültig löschen' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(alt).toHaveCount(0);
  await expect(zugaenge.locator('tr').filter({ hasText: 'Alex (Laptop)' })).toHaveCount(1);
  await expect(neu).toBeVisible();

  // Das Protokoll trägt den Eintrag und nennt den Zugang weiter beim Namen.
  const eintrag = page.getByTestId('fw-protokoll').locator('tr').filter({ hasText: 'Techniker-Zugang gelöscht' });
  await expect(eintrag).toContainText('Alex (Laptop)');
  await expect(eintrag).toContainText('10.10.32.2');
  await expect(eintrag).toContainText('bleiben vergeben');

  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath('fernwartung-nach-loeschen.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('Fernwartung: ein gelöschter Zugang fehlt in der Auswahl, ein aktiver ist erst nach dem Sperren löschbar', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/e2e/fernwartung.html');

  const zugaenge = page.getByTestId('fw-techniker');
  const alt = zugaenge.locator('tr').filter({ hasText: '10.10.32.2' });
  const neu = zugaenge.locator('tr').filter({ hasText: '10.10.32.3' });
  await alt.getByRole('button', { name: 'Löschen' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Endgültig löschen' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(alt).toHaveCount(0);

  // Aus der Auswahl ist er auch weg: nur noch ein „Alex (Laptop)".
  const frei = page.getByTestId('fw-boxen').locator('tr').filter({ hasText: 'edge-k7m2xq3' });
  await frei.getByRole('button', { name: 'Fenster öffnen' }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: /Techniker-Zugang/ }).click();
  await expect(page.getByRole('option', { name: /Alex \(Laptop\)/ })).toHaveCount(1);
  await page.keyboard.press('Escape');
  if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  // Ein aktiver Zugang: erst sperren, dann erscheint „Löschen".
  await neu.getByRole('button', { name: 'Sperren' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sperren' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(neu.getByRole('button', { name: 'Löschen' })).toBeVisible();
  await expect(neu.getByRole('button', { name: 'Entsperren' })).toBeVisible();
  expect(errors).toEqual([]);
});
