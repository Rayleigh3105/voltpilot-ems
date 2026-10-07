import { expect, test, type Page } from '@playwright/test';

/**
 * Die Unternehmens-Übersicht nach Konzept §5.1 (#1403) auf der Bühne `startansicht` (Unternehmen Ahrenberg, `&rechte`
 * mit der Selbstauskunft der Person): JEDE Rolle sieht dieselbe feste Struktur - Kopf, Kachelraster „Kennzahlen Ihrer
 * Anlagen“, „Anlagen nach Standort“, „Tiefer einsteigen“ (dazwischen „Was steht an“, sobald eine Frist ansteht; die
 * Bühne hat keine).
 *
 * Die rollenabhängigen Einstiege des Konzepts „Energiemanagement ohne Fachsprache“ - K2 Fahrplan „Ihr
 * Energiemanagement“ für den Energiemanager, K6 „Belege finden“ für Leser und „Einsicht“, K8 Datenlage zuerst am
 * Telefon - sind mit der festen Struktur entfallen (uems ac5fda37c, Review C8: `einstiegFuer`/`obenBausteine`
 * entfernt). Der Weg zu den Belegen ist „Tiefer einsteigen › Nachweisen“.
 */
const JETZT = new Date('2026-10-20T10:00:00+02:00');
const PERSONEN = ['IK', 'CB', 'RF', 'JW'] as const;

async function oeffne(page: Page, person: string, breite: number) {
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&rechte=1&person=${person}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

const querlauf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const oberkante = async (page: Page, name: string) => {
  const flaeche = page.getByRole('region', { name, exact: true });
  await expect(flaeche).toBeVisible();
  return (await flaeche.boundingBox())!.y;
};

for (const breite of [375, 1440]) {
  test(`§5.1 · jede Rolle bei ${breite} px: dieselbe feste Struktur, kein Rollen-Einstieg oben`, async ({ page }) => {
    for (const person of PERSONEN) {
      const konsole: string[] = [];
      const hoeren = (m: { type(): string; text(): string }) => m.type() === 'error' && konsole.push(m.text());
      page.on('console', hoeren);
      await oeffne(page, person, breite);
      const kacheln = await oberkante(page, 'Kennzahlen Ihrer Anlagen');
      const anlagen = await oberkante(page, 'Anlagen nach Standort');
      const tiefer = await oberkante(page, 'Tiefer einsteigen');
      expect(kacheln, `${person}: Kachelraster vor den Anlagen`).toBeLessThan(anlagen);
      expect(anlagen, `${person}: Anlagen vor „Tiefer einsteigen“`).toBeLessThan(tiefer);
      for (const weg of ['Messen', 'Auswerten', 'Verbessern', 'Nachweisen']) {
        await expect(page.getByRole('region', { name: 'Tiefer einsteigen' }).getByRole('button', { name: new RegExp(`^${weg} `) })).toBeVisible();
      }
      for (const alt of ['baustein-fahrplan', 'baustein-belege', 'uebersicht-bausteine', 'funktionen-karte']) {
        await expect(page.getByTestId(alt), `${person}: „${alt}“ steht nicht mehr auf der Unternehmens-Übersicht`).toHaveCount(0);
      }
      expect(await querlauf(page), `${person}: Querlauf`).toBe(0);
      expect(konsole, `${person}: Konsolenfehler`).toEqual([]);
      page.off('console', hoeren);
    }
  });

  test(`§5.1 · Leser bei ${breite} px: „Tiefer einsteigen › Nachweisen“ führt zu den Belegen`, async ({ page }) => {
    await oeffne(page, 'CB', breite);
    await page.getByRole('region', { name: 'Tiefer einsteigen' }).getByRole('button', { name: /^Nachweisen / }).click();
    await expect(page).toHaveURL(/#\/portfolio\/energiemanagement$/);
  });
}
