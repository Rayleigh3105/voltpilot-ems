import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * UEMS AP-15 IP-24 — das Betreiber-Blatt „Gemeinsame Steuerung“ bei 375 und 1440 px auf der eigenen Bühne
 * `e2e/betreiberblatt.html` (echte Komponente, Plattform-Rolle, gestellte Routen; keine echte Anlage). Prüfnachweis
 * der Zelle: scharfschalten mit fehlender Quittung bleibt im Übergangsstand (R12) — die führende Box hat quittiert,
 * die mitsteuernde nicht → „1 von 2“, kein Zielstand, kein Plan je Box; erst nach der Quittung der Zielstand. Dazu:
 * Sprungprobe auslösen → das Protokoll erscheint. Mit `GSB_BILDER=<Ordner>` legt der Lauf Bilder für die Ansicht ab.
 * Die Spec importiert keine Fixtures (sie laden `api.ts`).
 */

const BILDER = process.env.GSB_BILDER;
const JETZT = new Date('2027-06-15T11:40:00Z');

async function oeffne(page: Page, breite: number, query: string): Promise<Locator> {
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: BILDER ? (breite < 720 ? 5200 : 2600) : breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/betreiberblatt.html?${query}`);
  await page.evaluate(() => document.fonts.ready);
  // Seit den kurzen Einstellungen (main 41ed67c26) steht die Gruppe auch am Telefon offen; das Blatt steht darin.
  // (Der erste Knopf „Gemeinsame Steuerung …“ öffnet dort den Änderungs-Dialog — nicht mehr klicken.)
  const abschnitt = page.locator('#technik-gemeinsam');
  await expect(abschnitt).toBeVisible();
  const blatt = page.getByTestId('betreiber-blatt');
  await expect(blatt).toBeVisible();
  await expect(blatt.getByTestId('gsb-spalten')).toBeVisible();
  return blatt;
}

async function bild(ziel: Locator, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await ziel.page().waitForTimeout(250);
  await ziel.screenshot({ path: join(BILDER, `${name}.png`) });
}

async function keinUeberlauf(page: Page) {
  const breit = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(breit).toBeLessThanOrEqual(0);
}

const zelle = (blatt: Locator, zeile: string, spalte: number) =>
  blatt.locator(`tr[data-zeile="${zeile}"] td`).nth(spalte);

for (const breite of [375, 1440]) {
  test.describe(`Betreiber-Blatt (${breite} px)`, () => {
    test('S1: offene I1-Liste, „nicht gemeldet“ statt Null, Sprungprobe-Knopf nur an der Box, die sie meldet', async ({ page }) => {
      const blatt = await oeffne(page, breite, 'lage=beobachtet');
      await expect(blatt.getByTestId('gsb-kopf')).toHaveText('S1 · beobachtet · Epoche 0');
      await expect(blatt.getByTestId('gsb-fehlt')).toContainText('Sprungprobe fehlt an Box Verwaltung (T5)');
      await expect(zelle(blatt, 'waechter-einspeisung', 1)).toHaveText('nicht gemeldet');
      await expect(zelle(blatt, 'wirksam-bezug', 1)).toHaveText('nicht gemeldet');
      await expect(blatt.getByTestId('gsb-i1').locator('li[data-stand="offen"]')).toHaveCount(4);
      await expect(blatt.getByTestId('gsb-sprung-grund')).toContainText('meldet die Fähigkeit sprungprobe nicht');
      await expect(blatt.getByRole('button', { name: 'Sprungprobe auslösen' })).toHaveCount(1);
      await keinUeberlauf(page);
      await bild(blatt, `s1-${breite}`);

      // Scharfschalten in S1: die api lehnt ab (409), das Wort steht an seiner Stelle
      await blatt.getByRole('button', { name: 'Scharfschalten' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByTestId('gsb-i1-dialog')).toBeVisible();
      await dialog.getByRole('button', { name: 'Scharfschalten' }).click();
      await expect(blatt.getByTestId('gsb-abgelehnt')).toContainText('Sprungprobe fehlt');
      await expect(blatt.getByTestId('gsb-kopf')).toHaveText('S1 · beobachtet · Epoche 0');
    });

    test('AP-15 Folge von IP-19: „Ungeregeltes hinter dem Abgang (erklärt)“ nur, wenn eine Box eins hat', async ({ page }) => {
      const ohne = await oeffne(page, breite, 'lage=beobachtet');
      await expect(ohne.locator('tr[data-zeile="wirksam-reserve"]')).toHaveCount(1);
      await expect(ohne.locator('tr[data-zeile="ungeregelt-abgang"]')).toHaveCount(0);
      const blatt = await oeffne(page, breite, 'lage=beobachtet&ungeregelt=50');
      await expect(blatt.locator('tr[data-zeile="ungeregelt-abgang"] th')).toHaveText('Ungeregeltes hinter dem Abgang (erklärt)');
      await expect(zelle(blatt, 'ungeregelt-abgang', 0)).toHaveText('keins');
      await expect(zelle(blatt, 'ungeregelt-abgang', 1)).toHaveText('50 kW');
      await keinUeberlauf(page);
      await bild(blatt.locator('table').first(), `ungeregelt-${breite}`);
    });

    test('Sprungprobe auslösen → das Protokoll erscheint', async ({ page }) => {
      const blatt = await oeffne(page, breite, 'lage=beobachtet&proben=1');
      await expect(blatt.getByTestId('gsb-protokoll').locator('tbody tr')).toHaveCount(1);
      await blatt.getByRole('button', { name: 'Sprungprobe auslösen' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('zweimal für 60 s');
      await dialog.getByLabel(/Sprung \(kW/).fill('25');
      await dialog.getByRole('button', { name: 'Sprungprobe auslösen' }).click();
      await expect(dialog).toBeHidden();
      const zeilen = blatt.getByTestId('gsb-protokoll').locator('tbody tr');
      await expect(zeilen).toHaveCount(2);
      await expect(zeilen.first()).toContainText('ausgelöst — Bericht steht aus');
      await expect(zeilen.first()).toContainText('25 kW');
      await expect(zeilen.nth(1)).toContainText('+0,4 kW');
      await keinUeberlauf(page);
      await bild(blatt, `sprungprobe-${breite}`);
    });

    test('R12: scharfschalten mit fehlender Quittung bleibt im Übergangsstand, erst die Quittung bringt den Zielstand', async ({ page }) => {
      const blatt = await oeffne(page, breite, 'lage=geprueft');
      await expect(blatt.getByTestId('gsb-i1').locator('li[data-stand="offen"]')).toHaveCount(0);
      await blatt.getByRole('button', { name: 'Scharfschalten' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('erst nach ihrer Quittung');
      await dialog.getByRole('button', { name: 'Scharfschalten' }).click();
      await expect(dialog).toBeHidden();

      const zwei = blatt.getByTestId('gsb-zweischritt');
      await expect(zwei).toHaveAttribute('data-art', 'uebergang');
      await expect(zwei).toContainText('1 von 2 Boxen hat bestätigt · wartet auf Box Verwaltung');
      await expect(blatt).not.toContainText('Zielstand steht');
      await expect(zelle(blatt, 'plan-veroeffentlicht', 0)).toHaveText('keiner');
      await expect(zelle(blatt, 'plan-veroeffentlicht', 1)).toHaveText('keiner');
      await expect(zelle(blatt, 'revision-quittiert', 1)).toHaveAttribute('data-warnung', 'ja');
      await expect(blatt.getByTestId('gsb-kopf')).toHaveText('S3 · Anteile aktiv · Epoche 1');
      await keinUeberlauf(page);
      await bild(blatt, `uebergang-${breite}`);

      // Neu lesen ohne Quittung: bleibt, wie es ist — das Blatt nimmt nichts vorweg
      await blatt.getByRole('button', { name: 'Neu lesen' }).click();
      await expect(zwei).toHaveAttribute('data-art', 'uebergang');

      await page.evaluate(() => (window as unknown as { __quittung: () => void }).__quittung());
      await blatt.getByRole('button', { name: 'Neu lesen' }).click();
      await expect(zwei).toHaveAttribute('data-art', 'ziel');
      await expect(zwei).toContainText('Zielstand steht — alle 2 Boxen haben quittiert');
      await expect(zelle(blatt, 'plan-veroeffentlicht', 1)).toHaveText('a1b2c3d4');
      await expect(zelle(blatt, 'plan-angenommen', 1)).toHaveText('a1b2c3d4');
      await expect(zelle(blatt, 'wirksam-bezug', 1)).toHaveText('77 kW');
      await expect(zelle(blatt, 'verlust-gestern', 1)).toHaveText('mindestens 0 kWh (gemessen) · geschätzt 160,2 kWh (Prognose)');
      await expect(zelle(blatt, 'verlust-gestern', 0)).toHaveText('nicht gemeldet');
      await bild(blatt, `aktiv-${breite}`);
    });

    test('als Betreiber angehalten: Kopf sagt es, fortsetzen nur hier', async ({ page }) => {
      const blatt = await oeffne(page, breite, 'lage=anteile_aktiv');
      await blatt.getByRole('button', { name: 'Als Betreiber anhalten' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Die Anteile bleiben in Kraft');
      await dialog.getByRole('button', { name: 'Anhalten' }).click();
      await expect(blatt.getByTestId('gsb-kopf')).toHaveText('angehalten · vom Betreiber angehalten · Epoche 1');
      await expect(blatt.getByTestId('gsb-vom-betreiber')).toBeVisible();
      await expect(blatt.getByRole('button', { name: 'Als Betreiber fortsetzen' })).toBeVisible();
      await keinUeberlauf(page);
      await bild(blatt, `angehalten-${breite}`);
    });
  });
}

for (const breite of [375, 1440]) {
  test(`Auflösen: Betreiber bestätigt fehlende Box (${breite} px)`, async ({ page }) => {
    const blatt = await oeffne(page, breite, 'lage=anteile_aktiv&aufloesen=1');
    await expect(blatt.getByTestId('gsb-kopf')).toHaveText('Gemeinsame Steuerung wird aufgelöst · 0 von 1 Boxen haben bestätigt.');
    await expect(blatt.getByRole('button', { name: 'Geräte sind vom Netz - bestätigen' })).toHaveCount(1);
    await keinUeberlauf(page);
    await bild(blatt, `aufloesen-betreiber-${breite}`);
    await blatt.getByRole('button', { name: 'Geräte sind vom Netz - bestätigen' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /bestätigen/i }).click();
    await expect(blatt.getByTestId('gsb-kopf')).toContainText('aufgelöst');
  });
}
