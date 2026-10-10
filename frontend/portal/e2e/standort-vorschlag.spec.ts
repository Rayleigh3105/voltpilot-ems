import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * AP-14 U2: sichtbarer 2+1-Fluss bei 375 und 1440 px; A6 bleibt als Gegenprobe.
 *
 * firstmate K2 (09.10.2026): die frühere grosse Karte „Noch nicht zugeordnet" ist aus der
 * Kunden-Übersicht entfernt — der Weg in diese Vorschau führt jetzt über den leisen Einstieg
 * „Messen & Auswerten einrichten" im ⋯-Menü (`oeffneMenu`). Dieselbe Regel lässt „Was sich
 * ändert" das Versprechen „Ihre Startseite wird die Unternehmens-Übersicht" nicht mehr von der
 * gewohnten Übersicht aus geben: ein hier frisch gegründeter Standort misst nach dem Bestätigen
 * noch nicht („Messen & Auswerten" ist ein eigener, späterer Schritt) — nur ein Standort, der
 * VORHER schon mass, durfte das versprechen (`standortVorschlag.ts wasSichAendert`,
 * `startansicht.test.ts` K2-Block). Dass dieser Lauf trotzdem auf der Unternehmens-Übersicht
 * landet (Zeile `Kunststoffwerk Ahrenberg GmbH`), kommt allein von der Funktionen-Bühne
 * (`messenArt=eingerichtet` ist ihre Vorgabe) und beweist nicht das Versprechen.
 */
const BILDER = process.env.STANDORT_VORSCHLAG_BILDER;

async function ruhe(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

/** Der leise Einstieg: ⋯-Menü der gewohnten Übersicht → „Messen & Auswerten einrichten". */
async function oeffneMenu(page: Page) {
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Messen & Auswerten einrichten' }).click();
}

async function oeffne(page: Page, breite: 375 | 1440) {
  await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await page.goto('/e2e/startansicht.html?bild=bestand-mehrere&vorschlag=offen&vorschlagfall=u2&vorschauart=steuerkunde');
  // K2: keine Karte mehr auf der gewohnten Übersicht — nur der leise Einstieg im Menü.
  await expect(page.getByText('Noch nicht zugeordnet')).toHaveCount(0);
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `standort-vorschlag-karte-${breite}.png`) });
  }
  await oeffneMenu(page);
  await expect(page.getByRole('heading', { name: 'Vorschau: Ihre Anlagen und Standorte' })).toBeVisible();
  await ruhe(page);
}

async function adressenErgaenzen(page: Page) {
  const strassen = page.getByLabel('Straße und Hausnummer *');
  const plz = page.getByLabel('PLZ');
  const orte = page.getByLabel('Ort *');
  for (let i = 0; i < await strassen.count(); i++) {
    await strassen.nth(i).fill(i === 0 ? 'Industriestraße 4' : 'Werkstraße 8');
    await plz.nth(i).fill(i === 0 ? '84347' : '84123');
    await orte.nth(i).fill(i === 0 ? 'Pfarrkirchen' : 'Lindach');
  }
}

async function zuAhrenbergGruppieren(page: Page) {
  await page.getByRole('combobox', { name: 'Gehört zu: Werk Ahrenberg – Halle 2' }).click();
  await page.getByRole('option', { name: 'Werk Ahrenberg – Halle 1' }).click();
  const dialog = page.getByRole('dialog', { name: 'Standorte einrichten' });
  await expect(dialog.locator('.vp-sv-gruppe')).toHaveCount(2);
  await dialog.getByLabel('Name des Standorts *').first().fill('Werk Ahrenberg');
}

for (const breite of [375, 1440] as const) {
  test(`Mehr-Anlagen-Kunde bestätigt zwei Standorte (${breite} px)`, async ({ page }) => {
    await oeffne(page, breite);
    const dialog = page.getByRole('dialog', { name: 'Standorte einrichten' });
    await expect(dialog.locator('.vp-sv-gruppe')).toHaveCount(3);
    if (BILDER) await page.screenshot({ path: join(BILDER, `standort-vorschlag-ausgang-${breite}.png`) });
    await zuAhrenbergGruppieren(page);
    await adressenErgaenzen(page);
    await expect(dialog.getByText('Werk Ahrenberg – Halle 1', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Werk Ahrenberg – Halle 2', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Werk Lindach', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Bis Sie bestätigen, ändert sich nichts')).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Was sich ändert' })).toBeVisible();
    // K2: von der gewohnten Übersicht aus kein Startseiten-Versprechen mehr (siehe Dateikopf).
    await expect(dialog).not.toContainText('Ihre Startseite wird die Unternehmens-Übersicht.');
    await expect(dialog).toContainText('Erlöse und Kosten finden Sie weiter im Cockpit jeder Anlage, im Portfolio und unter Erlöse.');
    await expect(dialog).toContainText('An Steuerung, Fahrplänen und Freigaben ändert sich nichts.');

    if (BILDER) {
      await dialog.locator('.dbody').evaluate((element) => { element.scrollTop = 0; });
      await page.screenshot({ path: join(BILDER, `standort-vorschlag-gruppiert-${breite}.png`) });
      await dialog.locator('.dbody').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.screenshot({ path: join(BILDER, `standort-vorschlag-vorschau-${breite}.png`) });
    }

    await page.getByRole('button', { name: 'Zuordnung bestätigen' }).click();
    const anfragen = await page.evaluate(() => (window as typeof window & { standortVorschlagAnfragen: unknown[] }).standortVorschlagAnfragen);
    expect(anfragen).toEqual([{ gruppen: [
      { name: 'Werk Ahrenberg', zeitzone: 'Europe/Berlin', adresse: { strasse: 'Industriestraße 4', plz: '84347', ort: 'Pfarrkirchen', land: 'DE' }, vorschlagIds: ['aa020000-0000-4000-8000-000000000001', 'aa020000-0000-4000-8000-000000000002'] },
      { name: 'Werk Lindach', zeitzone: 'Europe/Berlin', adresse: { strasse: 'Werkstraße 8', plz: '84123', ort: 'Lindach', land: 'DE' }, vorschlagIds: ['aa020000-0000-4000-8000-000000000003'] },
    ] }]);
    await expect(dialog).toHaveCount(0);
    // Die Funktionen-Bühne markiert beide neuen Standorte als messend (Vorgabe `messenArt=
    // eingerichtet`) — deshalb springt dieser Lauf auf die Unternehmens-Übersicht; ohne Messen
    // bliebe die gewohnte Übersicht (K2-Block in `startansicht.test.ts`), nicht dieser Klick.
    await expect(page.getByRole('heading', { name: 'Kunststoffwerk Ahrenberg GmbH' })).toBeVisible();
    await expect(page.getByText('Werk Ahrenberg', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Werk Lindach', { exact: true }).first()).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio');
    await ruhe(page);
    if (BILDER) await page.screenshot({ path: join(BILDER, `standort-vorschlag-bestaetigt-${breite}.png`) });
  });

  test(`A6 mit zwei Anlagen lässt sich weiterhin vollständig zusammenlegen (${breite} px)`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
    await page.goto('/e2e/startansicht.html?bild=bestand-mehrere&vorschlag=offen&vorschauart=steuerkunde');
    await oeffneMenu(page);
    const dialog = page.getByRole('dialog', { name: 'Standorte einrichten' });
    await expect(dialog.locator('.vp-sv-gruppe')).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Alle Anlagen zusammenlegen' }).click();
    await expect(dialog.locator('.vp-sv-gruppe')).toHaveCount(1);
    await dialog.getByLabel('Name des Standorts *').fill('Werk Ahrenberg');
    await adressenErgaenzen(page);
    await expect(dialog).not.toContainText('Ihre Startseite wird die Unternehmens-Übersicht.');
    if (BILDER) await page.screenshot({ path: join(BILDER, `standort-vorschlag-a6-${breite}.png`) });
    await page.getByRole('button', { name: 'Zuordnung bestätigen' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test(`reiner Messkunde liest in derselben Vorschau gar keine Änderung (K2) (${breite} px)`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
    await page.goto('/e2e/startansicht.html?bild=bestand-mehrere&vorschlag=offen&vorschlagfall=u2&vorschauart=messkunde');
    await oeffneMenu(page);
    const dialog = page.getByRole('dialog', { name: 'Standorte einrichten' });
    await expect(dialog.getByRole('heading', { name: 'Was sich ändert' })).toBeVisible();
    // K2: kein Startseiten-Versprechen von der gewohnten Übersicht aus — ein reiner Messkunde
    // ohne Geld/Steuerung liest hier also gar keinen Satz mehr (vorher nur die Startseite).
    await expect(dialog).not.toContainText('Ihre Startseite wird die Unternehmens-Übersicht.');
    await expect(dialog).not.toContainText('Erlöse');
    await expect(dialog).not.toContainText('Steuerung');
    await expect(dialog).not.toContainText('Fahrplänen');
    await ruhe(page);
    if (BILDER) {
      await dialog.locator('.dbody').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.screenshot({ path: join(BILDER, `standort-vorschlag-messkunde-${breite}.png`) });
    }
  });
}

test('reine Verbrauchsanlage mit Tarif: Ebenen-Übersicht bleibt ohne Geld', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/startansicht.html?bild=bestand-mehrere&vorschlag=offen&vorschlagfall=u2&vorschauart=verbrauch');
  await oeffneMenu(page);
  await expect(page.getByRole('heading', { name: 'Vorschau: Ihre Anlagen und Standorte' })).toBeVisible();
  await zuAhrenbergGruppieren(page);
  await adressenErgaenzen(page);
  await page.getByRole('button', { name: 'Zuordnung bestätigen' }).click();
  await expect(page.getByRole('heading', { name: 'Kunststoffwerk Ahrenberg GmbH' })).toBeVisible();
  await ruhe(page);
  const main = page.locator('.vp-main');
  await expect(main).not.toContainText('Erlös heute');
  await expect(main).not.toContainText('Vorteil heute');
  await expect(main).not.toContainText('€');
  if (BILDER) await page.screenshot({ path: join(BILDER, 'verbrauch-ebenen-uebersicht-ohne-geld-1440.png') });
});

test('reine Verbrauchsanlage mit Tarif: Cockpit-Kosten bleiben vor und nach der Bestätigung zeichengleich', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const karte = page.locator('[data-frame="cockpit-leiste"]');
  await page.goto('/e2e/cockpit-erloes.html?verbrauch=1&standorte=vorher');
  await expect(karte).toContainText('Kosten');
  const vorher = await karte.innerText();
  if (BILDER) await karte.screenshot({ path: join(BILDER, 'verbrauch-cockpit-kosten-vorher-1440.png') });

  await page.goto('/e2e/cockpit-erloes.html?verbrauch=1&standorte=nachher');
  await expect(karte).toContainText('Kosten');
  expect(await karte.innerText()).toBe(vorher);
  if (BILDER) await karte.screenshot({ path: join(BILDER, 'verbrauch-cockpit-kosten-nachher-1440.png') });
});
