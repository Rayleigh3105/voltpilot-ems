import { expect, test, type Page } from '@playwright/test';

/**
 * Plattform-Admin Personen (Konzept vp-plattform-admin-box-benutzer-konzept, Teil 2, Spec-Punkt 4):
 * Person hinzufügen (jede Rolle, mit/ohne Standorte, doppelte E-Mail, doppelter Anmeldename),
 * Bearbeiten, Umbenennen, Startpasswort - mit den Wüstholz-Daten, bei 1440 und 390 px.
 */
const DESKTOP = 1440;
const PHONE = 390;

async function keinUeberlauf(page: Page) {
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(1);
}

/** Konsolenfehler mitzählen und am Ende prüfen - dieselbe Probe wie in `mandanten-akte.spec.ts`. */
function fehlerAufzeichnen(page: Page): string[] {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  return fehler;
}

for (const breite of [DESKTOP, PHONE]) {
  test(`Person hinzufügen: Standortrolle mit Standort, Startpasswort sichtbar · ${breite}px`, async ({ page }) => {
    const fehler = fehlerAufzeichnen(page);
    await page.setViewportSize({ width: breite, height: breite === PHONE ? 844 : 900 });
    await page.goto('/e2e/admin-personen.html');
    await page.waitForSelector('.vp-kundenakte');

    await page.getByRole('button', { name: 'Person hinzufügen' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('Vorname').fill('Sabine');
    await page.getByLabel('Nachname').fill('Wüstholz');
    await page.getByLabel('E-Mail').fill('sabine.wuestholz@example.de');
    // Rolle bleibt auf der Vorgabe „Leser" (Standortrolle); bei genau einem Standort erscheint kein Wähler.
    await expect(page.getByText('Gilt für „Zuhause".')).toBeVisible();
    await page.getByRole('button', { name: 'Person anlegen' }).click();

    await expect(page.getByLabel('Startpasswort')).toBeVisible();
    await page.getByRole('button', { name: 'Fertig' }).click();
    await expect(page.getByText('Sabine Wüstholz')).toBeVisible();
    await expect(page.getByText('Leser')).toBeVisible();

    await keinUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

for (const breite of [DESKTOP, PHONE]) {
  test(`Bearbeiten ändert Name und E-Mail; Anmeldename ändern zeigt den Folgen-Satz (P1/P3) · ${breite}px`, async ({ page }) => {
    const fehler = fehlerAufzeichnen(page);
    await page.setViewportSize({ width: breite, height: breite === PHONE ? 844 : 900 });
    await page.goto('/e2e/admin-personen.html');
    await page.waitForSelector('.vp-kundenakte');

    await page.getByRole('button', { name: 'Aktionen für wuestholz' }).click();
    await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
    const edit = page.getByRole('dialog', { name: /Benutzer bearbeiten: wuestholz/ });
    await expect(edit.getByText(/gilt ab dem Speichern nicht mehr/)).toHaveCount(0);
    await edit.getByLabel('Anmeldename').fill('kf.wuestholz');
    await expect(edit.getByText('„wuestholz" gilt ab dem Speichern nicht mehr. Wer angemeldet ist, bleibt es.')).toBeVisible();
    await edit.getByLabel('E-Mail').fill('karl-friedrich@example.de');
    await edit.getByRole('button', { name: 'Änderungen speichern' }).click();
    await expect(edit).toHaveCount(0);
    await expect(page.getByText('karl-friedrich@example.de')).toBeVisible();

    await keinUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

test('Person hinzufügen: unternehmensweite Rolle ohne Standort-Wähler', async ({ page }) => {
  const fehler = fehlerAufzeichnen(page);
  await page.setViewportSize({ width: DESKTOP, height: 900 });
  await page.goto('/e2e/admin-personen.html');
  await page.waitForSelector('.vp-kundenakte');

  await page.getByRole('button', { name: 'Person hinzufügen' }).click();
  await page.getByLabel('E-Mail').fill('energie@example.de');
  await page.getByRole('combobox', { name: 'Rolle' }).click();
  await page.getByRole('option', { name: 'Energiemanager' }).click();
  // Energiemanager gilt unternehmensweit - kein Standort-Satz, kein Wähler.
  await expect(page.getByText(/Gilt für/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Person anlegen' }).click();
  await expect(page.getByLabel('Startpasswort')).toBeVisible();

  await keinUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('Person hinzufügen: doppelter Anmeldename und doppelte E-Mail nennen das richtige Feld (N5)', async ({ page }) => {
  const fehler = fehlerAufzeichnen(page);
  await page.setViewportSize({ width: DESKTOP, height: 900 });
  await page.goto('/e2e/admin-personen.html');
  await page.waitForSelector('.vp-kundenakte');

  await page.getByRole('button', { name: 'Person hinzufügen' }).click();
  // Der vorgeschlagene Anmeldename „wuestholz" existiert schon (Karl-Friedrich); die E-Mail selbst ist frei.
  await page.getByLabel('E-Mail').fill('wuestholz@andere-domain.example');
  await page.getByRole('button', { name: 'Person anlegen' }).click();
  await expect(page.getByText('Dieser Anmeldename ist bereits vergeben.')).toBeVisible();

  // Anmeldename ändern macht ihn frei - jetzt kollidiert nur noch Karls E-Mail.
  await page.getByText('Ändern').click();
  await page.getByLabel('Anmeldename').fill('andere-person');
  await page.getByLabel('E-Mail').fill('k.wuestholz@example.de');
  await page.getByRole('button', { name: 'Person anlegen' }).click();
  await expect(page.getByText('Diese E-Mail-Adresse ist bereits vergeben.')).toBeVisible();

  await keinUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('Neues Startpasswort über das Zeilenmenü (N6)', async ({ page }) => {
  const fehler = fehlerAufzeichnen(page);
  await page.setViewportSize({ width: DESKTOP, height: 900 });
  await page.goto('/e2e/admin-personen.html');
  await page.waitForSelector('.vp-kundenakte');

  await page.getByRole('button', { name: 'Aktionen für wuestholz' }).click();
  await page.getByRole('menuitem', { name: 'Neues Startpasswort' }).click();
  const dlg = page.getByRole('dialog', { name: /Neues Startpasswort: wuestholz/ });
  await dlg.getByRole('button', { name: 'Startpasswort vergeben' }).click();
  await expect(dlg.getByLabel('Startpasswort')).toBeVisible();

  await keinUeberlauf(page);
  expect(fehler).toEqual([]);
});
