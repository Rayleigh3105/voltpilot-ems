import { expect, test, type Page } from '@playwright/test';

/**
 * Plattform-Administrator in der Mandantensicht: Cockpit · Fahrplan · Steuerung · Anlage am Rand (Auftrag
 * `vp-mandanten-sicht-navigation`). Bis dahin blieb der Betreiber im Mandanten mit EINER Anlage auf der nackten
 * Kunden-Übersicht (`#/uebersicht`): keine offene Anlage, also keine fünf Bereiche in der Seitenleiste. Jetzt landet er
 * dort wie der Kunde selbst. Wirt: `mandantensicht-navigation.html` (ganzer `App`, gefälschter Server, PV + Speicher an
 * den Anlagen, also mit Fahrplan). Belege: `BELEGE=<Ordner>` schreibt Bildschirmfotos dorthin.
 */
const MIT = 'Solarhof Beispiel';
const ANLAGE = 'b1000000-0000-4000-8000-000000000001';
const MANDANT_ID = 'a1000000-0000-4000-8000-000000000001';
const BELEGE = process.env.BELEGE;

async function springe(page: Page, mandant: string) {
  await page.goto('/e2e/mandantensicht-navigation.html#/mandanten');
  await page.getByRole('button', { name: `Details zu ${mandant}` }).click();
  await page.getByRole('region', { name: mandant }).getByRole('button', { name: /In Mandanten-Ansicht springen/ }).click();
}

/** Die Bereiche der Anlage: Seitenleiste am Rechner, Telefon-Leiste am Telefon - dieselben Wörter, dieselbe Folge. */
function bereiche(page: Page, breit: boolean) {
  return breit
    ? page.getByRole('navigation', { name: 'Hauptnavigation' }).locator('.vp-anlagenav .vp-navitem')
    : page.locator('.vp-bottombar .vp-bottombar-item');
}

async function foto(page: Page, name: string) {
  if (BELEGE) await page.screenshot({ path: `${BELEGE}/${name}.png` });
}

for (const [breite, breit] of [[1440, true], [375, false]] as const) {
  test(`${breite} px: der Sprung landet in der Anlage, ihre fünf Bereiche stehen am Rand und navigieren im Mandanten`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breit ? 900 : 812 });
    await springe(page, MIT);

    // Die Landung ist die der Kundenansicht: die einzige Anlage, nicht die nackte Übersicht.
    await expect(page).toHaveURL(new RegExp(`#/anlage/${ANLAGE}$`));
    const leiste = bereiche(page, breit);
    await expect(leiste).toHaveText(['Cockpit', 'Fahrplan', 'Verlauf', 'Steuerung', 'Anlage']);
    await expect(leiste.first()).toHaveAttribute('aria-current', 'page');
    // Kein Rückweg „Meine Anlagen“, der sofort wieder in dieselbe Anlage führte - wie beim Kunden mit einer Anlage.
    await expect(page.getByRole('button', { name: 'Meine Anlagen' })).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override'))).toBe(MANDANT_ID);
    await foto(page, `mandantensicht-cockpit-${breite}`);

    for (const [name, ziel] of [
      ['Fahrplan', `#/anlage/${ANLAGE}/fahrplan`],
      ['Steuerung', `#/anlage/${ANLAGE}/steuerung`],
      ['Anlage', `#/anlage/${ANLAGE}/modell`],
      ['Cockpit', `#/anlage/${ANLAGE}`],
    ] as const) {
      await leiste.filter({ hasText: new RegExp(`^${name}$`) }).click();
      await expect(page, name).toHaveURL(new RegExp(`${ziel.replace(/[/#]/g, '\\$&')}$`));
      await expect(leiste.filter({ hasText: new RegExp(`^${name}$`) }), name).toHaveAttribute('aria-current', 'page');
      // Weiter im Mandanten: derselbe Kundenbereich, der Umschalter nennt ihn.
      expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override')), name).toBe(MANDANT_ID);
      // Scheibe S1 (E3 = A): die Suche zeigt keinen gewählten Wert mehr - das
      // Rückweg-Band nennt stattdessen den Mandanten der Kundenansicht.
      await expect(page.locator('.vp-kundenansicht-band')).toContainText(MIT);
      if (name === 'Fahrplan' || name === 'Steuerung') await foto(page, `mandantensicht-${name.toLowerCase()}-${breite}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), name).toBeLessThanOrEqual(1);
    }
  });
}

test('1440 px: der Rückweg in die Betreiber-Sicht bleibt - Suche, ADMIN-Zeichen, Raum „Plattform“', async ({ page }) => {
  // Die Seitenleiste mit den drei Räumen gibt es nur am Rechner; das Telefon-Projekt bringt sonst 393 px mit.
  await page.setViewportSize({ width: 1440, height: 900 });
  await springe(page, MIT);
  await expect(page).toHaveURL(new RegExp(`#/anlage/${ANLAGE}$`));
  await expect(page.locator('.vp-usermenu .n')).toContainText('ADMIN');
  // Scheibe S1 (E3 = A): das Rückweg-Band nennt den Mandanten, statt des Umschalter-Chips.
  await expect(page.locator('.vp-kundenansicht-band')).toContainText(MIT);
  // Die Räume stehen UNGEFALTET unter den Bereichen der Anlage.
  await expect(page.getByRole('button', { name: 'Plattform', exact: true })).toBeVisible();
  await foto(page, 'mandantensicht-rueckweg-1440');
  await page.getByRole('button', { name: 'Zur Plattform zurück' }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override'))).toBeNull();
  await expect(page.getByRole('button', { name: 'Fahrplan', exact: true })).toHaveCount(0);
});

test('375 px: der Rückweg bleibt sichtbar - das Band, nicht mehr das Konto-Menü', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await springe(page, MIT);
  await expect(page).toHaveURL(new RegExp(`#/anlage/${ANLAGE}$`));
  // Scheibe S1: „Plattform" steht nicht mehr im Avatar-Menü (die drei Räume
  // gelten nur ausserhalb einer offenen Anlage) - das Band bleibt der Weg zurück.
  await expect(page.locator('.vp-kundenansicht-band')).toContainText(MIT);
  await foto(page, 'mandantensicht-rueckweg-375');
  await page.getByRole('button', { name: 'Zur Plattform zurück' }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override'))).toBeNull();
});

test('mehrere Anlagen: wie beim Kunden das Portfolio, in jeder geöffneten Anlage stehen die Bereiche', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await springe(page, 'Musterwerk Nord GmbH');
  await expect(page).toHaveURL(/#\/portfolio$/);
  await expect(page.getByRole('heading', { name: 'Portfolio' })).toBeVisible();
  await page.goto('/e2e/mandantensicht-navigation.html?mandant=ohne#/anlage/b2000000-0000-4000-8000-000000000002');
  const leiste = bereiche(page, true);
  await expect(leiste).toHaveText(['Cockpit', 'Fahrplan', 'Verlauf', 'Steuerung', 'Anlage']);
  // Hier gibt es die Ebene darüber: der Weg hoch führt in das Portfolio dieses Mandanten.
  await expect(page.getByRole('button', { name: /Zurück zu|Meine Anlagen|Portfolio/ }).first()).toBeVisible();
  await foto(page, 'mandantensicht-portfolio-anlage-1440');
});
