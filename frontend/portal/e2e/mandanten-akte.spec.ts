import { expect, test, type Page } from '@playwright/test';

/**
 * Mobil-Durchgang Kundenakte (`vp-adminview-mobile-rework`): 390 px ist die
 * Haupt-Breite des Auftrags, 1440 px die Regressionsprobe.
 */
const PHONE = 390;
const DESKTOP = 1440;

async function keinUeberlauf(page: Page) {
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf).toBeLessThanOrEqual(1);
}

test('Kundenakte bei 390 px: Anlagen und Boxen/Vertrag beginnen zu, mit Urteil - Personen bleibt offen', async ({ page }) => {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.setViewportSize({ width: PHONE, height: 844 });
  await page.goto('/e2e/mandanten-akte.html');
  await page.waitForSelector('.vp-kundenakte');

  // Primär: Personen bleibt eine offene Karte - die Namen stehen ohne Klick da.
  await expect(page.getByText('Felix Diekmann')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Personen/ })).toBeVisible();

  // Sekundär: Anlagen und Boxen / Vertrag beginnen zu, tragen aber das Urteil.
  const anlagen = page.locator('details', { hasText: 'Anlagen und Boxen' });
  await expect(anlagen).not.toHaveAttribute('open', '');
  await expect(anlagen).toContainText('2 Anlagen');
  const vertrag = page.locator('details', { hasText: 'Vertrag' });
  await expect(vertrag).not.toHaveAttribute('open', '');
  await expect(vertrag).toContainText('aktiv');

  // Antippen öffnet - der Inhalt ist nicht verloren.
  await anlagen.locator('summary').click();
  await expect(anlagen).toHaveAttribute('open', '');
  await expect(anlagen).toContainText('Werk Nord');
  await expect(anlagen).toContainText('Anlage anlegen');

  await keinUeberlauf(page);
  expect(fehler).toEqual([]);
});

test('Kundenakte bei 390 px: beendeter Vertrag trägt „beendet" als Urteil', async ({ page }) => {
  await page.setViewportSize({ width: PHONE, height: 844 });
  await page.goto('/e2e/mandanten-akte.html?vertrag=beendet');
  await page.waitForSelector('.vp-kundenakte');
  const vertrag = page.locator('details', { hasText: 'Vertrag' });
  await expect(vertrag).toContainText('beendet');
  await keinUeberlauf(page);
});

test('Kundenakte am Rechner (1440 px): Anlagen und Boxen/Vertrag bleiben offene Karten (keine Verschlechterung)', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP, height: 900 });
  await page.goto('/e2e/mandanten-akte.html');
  await page.waitForSelector('.vp-kundenakte');
  await expect(page.locator('details')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Anlagen und Boxen/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Vertrag' })).toBeVisible();
  await expect(page.getByText('Werk Nord')).toBeVisible();
  await keinUeberlauf(page);
});

/**
 * Punkt 7 (Befund vp-kundenakte-fremde-personen, Zusatz des Captains: „Ich find vom Kunden lösen
 * nicht"): „Vom Kunden lösen …" steht sichtbar AN jeder Box der Karte „Anlagen und Boxen" - derselbe
 * Dialog wie in der Geräteakte. Eine nie gemeldete Box ist lösbar (Anlass, Bestätigen, danach weg);
 * eine gemeldete erklärt ruhig, warum nicht - nie ein toter Knopf.
 */
for (const breite of [DESKTOP, PHONE]) {
  test(`„Vom Kunden lösen" an der Box der Kundenakte: lösbar löst, gemeldet erklärt · ${breite}px`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    await page.setViewportSize({ width: breite, height: breite === PHONE ? 844 : 900 });
    await page.goto('/e2e/mandanten-akte.html');
    await page.waitForSelector('.vp-kundenakte');
    if (breite === PHONE) {
      await page.locator('details', { hasText: 'Anlagen und Boxen' }).locator('summary').click();
    }

    // Beide Boxen von Werk Nord tragen die sichtbare Handlung; Halle Süd (keine Box) keine.
    const aktionen = page.getByRole('button', { name: 'Vom Kunden lösen …' });
    await expect(aktionen).toHaveCount(2);

    // Die GEMELDETE Box (Badge ohne Link): der Dialog erklärt, warum sie nicht lösbar ist -
    // kein Anlass-Formular, der einzige Knopf ist „Verstanden".
    await aktionen.first().click();
    const dialog = page.getByRole('dialog', { name: 'Vom Kunden lösen' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Hat Daten gespeichert');
    await expect(dialog).toContainText('Der Kunde entfernt die Box selbst');
    await expect(dialog.getByLabel('Anlass')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Verstanden' }).click();
    await expect(dialog).toBeHidden();

    // Die NIE gemeldete Box: Anlass wählen, bestätigen - danach ist sie aus der Akte verschwunden.
    await aktionen.nth(1).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Hat sich nie gemeldet');
    await dialog.getByLabel('Anlass').click();
    await page.getByRole('option', { name: 'Doppelt verbunden' }).click();
    await dialog.getByRole('button', { name: 'Vom Kunden lösen', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Vom Kunden lösen …' })).toHaveCount(1);

    await keinUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

/**
 * vp-kunde-sofort-loeschen: ein datenfreier Kunde (Server-Urteil) ist sofort endgültig löschbar.
 * Badge „beendet · sofort löschbar", Kopf-Menü und Vertrag-Karte tragen den Weg; der Dialog
 * verlangt den abgetippten Namen, nennt die Folgen vom Server und endet auf dem Löschbericht.
 */
for (const breite of [DESKTOP, PHONE]) {
  test(`Sofort löschbar: Badge, Kopf-Menü, Abschrift-Dialog, Bericht · ${breite}px`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    await page.setViewportSize({ width: breite, height: breite === PHONE ? 844 : 900 });
    await page.goto('/e2e/mandanten-akte.html?vertrag=beendet&loeschbar=sofort');
    await page.waitForSelector('.vp-kundenakte');

    await expect(page.getByText('beendet · sofort löschbar')).toBeVisible();

    await page.getByRole('button', { name: 'Weitere Aktionen für Kunststoffwerk Ahrenberg GmbH' }).click();
    await page.getByRole('menuitem', { name: 'Kunde endgültig löschen …' }).click();
    const dialog = page.getByRole('dialog', { name: 'Kunde endgültig löschen' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('keinen Datenbestand');
    await expect(dialog).toContainText('VP-BB22');
    await expect(dialog).toContainText('Werkstatt-, Fernwartungs- und Plattform-Protokolle bleiben');

    // Ohne Abschrift löscht nichts - der Fehler steht am Feld.
    await dialog.getByRole('button', { name: 'Kunde endgültig löschen' }).click();
    await expect(dialog.getByRole('alert')).toContainText('bitte genau abtippen');
    await dialog.getByLabel('Zum Bestätigen den Kundennamen abtippen').fill('Kunststoffwerk Ahrenberg GmbH');
    await dialog.getByRole('button', { name: 'Kunde endgültig löschen' }).click();

    // Danach: der Bericht statt der Akte, mit den freigegebenen Boxen und dem Weg zurück zur Liste.
    await expect(page.getByRole('heading', { name: /Kunde gelöscht/ })).toBeVisible();
    await expect(page.getByText('VP-BB22 - wieder anmeldbar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zu den Kunden' })).toBeVisible();

    await keinUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

/** Mit Daten: derselbe Einstieg erklärt ruhig (Datenarten, ab wann, Gesamtabzug) - kein Gefahren-Knopf. */
test('Kunde mit Daten: der Dialog erklärt, warum er bleibt', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP, height: 900 });
  await page.goto('/e2e/mandanten-akte.html?vertrag=beendet');
  await page.waitForSelector('.vp-kundenakte');
  await expect(page.getByText('beendet · löschbar ab 01.01.2027')).toBeVisible();
  await page.getByRole('button', { name: 'Weitere Aktionen für Kunststoffwerk Ahrenberg GmbH' }).click();
  await page.getByRole('menuitem', { name: 'Kunde endgültig löschen …' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kunde endgültig löschen' });
  await expect(dialog).toContainText('Box-Herzschläge · Messwerte');
  await expect(dialog).toContainText('frühestens am 01.01.2027');
  await expect(dialog).toContainText('Gesamtabzug');
  await expect(dialog.getByRole('button', { name: 'Kunde endgültig löschen' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Verstanden' }).click();
  await expect(dialog).toBeHidden();
});

/**
 * Nebenbei behoben (vp-kunde-sofort-loeschen Punkt 5): die zwei Unterstützung-Knöpfe stehen mit
 * Lücke und auf einer Linie (oder sauber untereinander), die Karte ohne versetzten Extra-Rand;
 * ein Anlagenname bricht nie mitten im Wort.
 */
for (const breite of [DESKTOP, PHONE]) {
  test(`Pixelprobe Unterstützung-Knöpfe und Anlagennamen · ${breite}px`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite === PHONE ? 844 : 900 });
    await page.goto('/e2e/mandanten-akte.html');
    await page.waitForSelector('.vp-kundenakte');
    if (breite === PHONE) {
      await page.locator('details', { hasText: 'Anlagen und Boxen' }).locator('summary').click();
    }

    const anfragen = page.getByRole('button', { name: 'Unterstützung anfragen' });
    const notfall = page.getByRole('button', { name: 'Notfall-Zugriff' });
    const a = (await anfragen.boundingBox())!;
    const n = (await notfall.boundingBox())!;
    const gleicheZeile = Math.abs(a.y - n.y) < 2;
    if (gleicheZeile) {
      const luecke = n.x >= a.x ? n.x - (a.x + a.width) : a.x - (n.x + n.width);
      expect(luecke, 'Lücke zwischen den Knöpfen').toBeGreaterThanOrEqual(4);
    } else {
      const luecke = Math.max(a.y, n.y) - Math.min(a.y + a.height, n.y + n.height);
      expect(luecke, 'vertikale Lücke zwischen den Knöpfen').toBeGreaterThanOrEqual(4);
    }

    // Kein versetzter Extra-Rand: die Karte beginnt bündig mit den Nachbarkarten der Spalte.
    const unterstuetzung = (await page.locator('.vp-kundenakte-nebenspalte > .vp-unterstuetzung').boundingBox())!;
    const vertragKarte = (await page.locator('.vp-kundenakte-nebenspalte > .vp-mandant-karte').last().boundingBox())!;
    expect(Math.abs(unterstuetzung.x - vertragKarte.x), 'bündige linke Kante').toBeLessThanOrEqual(1);

    // Anlagennamen („Werk Nord", „Halle Süd") bleiben einzeilig - kein Umbruch mitten im Wort.
    for (const name of await page.locator('.vp-kundenakte-liste-haupt b').all()) {
      const box = (await name.boundingBox())!;
      expect(box.height, 'Anlagenname einzeilig').toBeLessThan(30);
    }
  });
}
