import { expect, test, type Page } from '@playwright/test';

/**
 * **Netzladen nach MiSpeL** (MiSpeL MP-18c, Bedienkonzept BK-W5 = A, Captain
 * 04.10.2026) — der Browser-Beweis über die vier Flächen mit dem Beispieltag
 * des Bedienkonzepts (Kühlhaus Seebach, Mi. 17.11.2027): Cockpit, Verlauf ›
 * Erlöse (Tag, Monat), Fahrplan „Was hat es gebracht?“ und Portfolio; dazu
 * der Händler-Modus („geschätzt“) und dieselbe Anlage ohne MiSpeL (wie bisher).
 *
 * Die Bühne läuft auf fester Uhr (`?jetzt=`). Fotos nur mit `MISPEL_W5_FOTOS`
 * (Verzeichnis) — ohne die Variable lädt und läuft die Spec unverändert.
 */
const NACH_DEM_TAG = 'jetzt=2027-11-18T09%3A00%3A00%2B01%3A00';
const NACH_DEM_LAUF = 'jetzt=2027-12-12T09%3A00%3A00%2B01%3A00';
const AM_ABEND = 'jetzt=2027-11-17T19%3A30%3A00%2B01%3A00';
const UHR: Record<string, string> = {
  offen: NACH_DEM_TAG,
  bestimmt: NACH_DEM_LAUF,
  monat: NACH_DEM_LAUF,
  heute: AM_ABEND,
  haendler: NACH_DEM_TAG,
  ohne: NACH_DEM_TAG,
};

async function oeffne(page: Page, fall: string, flaeche: string) {
  await page.goto(`/e2e/mispel-w5.html?fall=${fall}&flaeche=${flaeche}&${UHR[fall]}`);
  await expect(page.locator(`main[data-fall="${fall}"]`)).toBeVisible();
}

async function foto(page: Page, name: string, breite: number, wahl?: string) {
  const ziel = process.env.MISPEL_W5_FOTOS;
  if (!ziel) return;
  if (wahl) {
    // Aus dem ganzen Bild geschnitten: so überdeckt die klebende Zeitleiste die Karte nicht.
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = await page.locator(wahl).first().boundingBox();
    if (box) {
      await page.screenshot({ path: `${ziel}/${name}-${breite}.png`, fullPage: true, clip: box });
      return;
    }
  }
  await page.screenshot({ path: `${ziel}/${name}-${breite}.png`, fullPage: true });
}

async function keinUeberlauf(page: Page, breite: number) {
  const weite = await page.evaluate(() => document.scrollingElement!.scrollWidth);
  expect(weite).toBeLessThanOrEqual(breite);
}

for (const breite of [375, 1440]) {
  test.describe(`Netzladen nach MiSpeL · ${breite} px`, () => {
    test.use({ viewport: { width: breite, height: breite === 375 ? 812 : 1000 } });

    test('Verlauf › Erlöse, Tag, Gutschrift offen: Stromrechnung + Mengen, kein Rückfall-Satz', async ({ page }) => {
      const fehler: string[] = [];
      page.on('console', (m) => m.type() === 'error' && fehler.push(m.text()));
      await oeffne(page, 'offen', 'erloese');
      const karte = page.locator('section.vp-c-card.vp-c-speicher');
      await expect(karte).toBeVisible();
      await expect(karte.locator('.vp-chip').first()).toHaveText('Gutschrift offen');
      const zeile = karte.locator('.vp-c-sp-zeile').first();
      await expect(zeile.locator('.vp-c-sp-label')).toHaveText('Auf der Stromrechnung');
      await expect(zeile.locator('.vp-c-sp-wert')).toHaveText('− 0,84 €');
      await expect(zeile.locator('.vp-c-sp-grund')).toHaveText(
        'gegenüber demselben Speicher ohne smarte Steuerung · ohne MiSpeL-Gutschrift',
      );
      const block = karte.locator('.vp-c-sp-mispel');
      await expect(block).toContainText('Netzladen nach MiSpeL');
      await expect(block).toContainText('Aus dem Netz in den Speicher312,0 kWh');
      await expect(block).toContainText('Aus dem Speicher ins Netz214,6 kWh');
      await expect(block).toContainText('Gutschrift für Novemberoffen');
      await expect(karte.locator('.vp-c-sp-anker-label')).toHaveText('1.–17. November · Stromrechnung');
      await expect(page.locator('.vp-vr-kpi', { hasText: 'VoltPilot-Steuerung' })).toContainText(
        'Stromrechnung · Netzladen nach MiSpeL, Gutschrift im Monat',
      );
      await expect(page.locator('main')).not.toContainText('nicht ausgezahlt');
      await expect(page.locator('main')).not.toContainText('unter Null');
      await foto(page, 'erloese-tag-offen', breite, 'section.vp-c-card.vp-c-speicher');
      await foto(page, 'erloese-tag-offen-kennzahlen', breite, '.vp-vr-kpis');

      await karte.locator('details.vp-formel summary').click();
      const body = karte.locator('.vp-formel-body');
      await expect(body).toContainText('Schritt 3 · Steuerung auf der Stromrechnung');
      await expect(body).toContainText('Schritt 4 · Netzladen nach MiSpeL');
      await expect(body).toContainText('Für November: offen.');
      await expect(body).toContainText('wie Schritt 3 ohne MiSpeL-Gutschrift');
      await expect(body).not.toContainText('anders geladen und entladen');
      await foto(page, 'erloese-tag-offen-schritte', breite, 'section.vp-c-card.vp-c-speicher');
      await keinUeberlauf(page, breite);
      expect(fehler).toEqual([]);
    });

    test('Verlauf › Erlöse, Tag nach dem Monatslauf: die Gutschrift (20) steht daneben', async ({ page }) => {
      await oeffne(page, 'bestimmt', 'erloese');
      const karte = page.locator('section.vp-c-card.vp-c-speicher');
      await expect(karte.locator('.vp-c-sp-mispel')).toContainText('Gutschrift für November+ 253,71 €');
      await expect(karte.locator('.vp-c-label .vp-chip')).toHaveCount(0);
      await foto(page, 'erloese-tag-bestimmt', breite, 'section.vp-c-card.vp-c-speicher');
      await keinUeberlauf(page, breite);
    });

    test('Verlauf › Erlöse, Monat: Stromrechnung, Gutschrift nach Anlage 1, zusammen', async ({ page }) => {
      await oeffne(page, 'monat', 'erloese');
      const karte = page.locator('section.vp-c-card.vp-c-speicher');
      await expect(karte.locator('.vp-c-sp-zeile').first().locator('.vp-c-sp-label')).toHaveText(
        'Auf der Stromrechnung',
      );
      await expect(karte.locator('.vp-c-sp-zeile').first().locator('.vp-c-sp-wert')).toHaveText('− 4,86 €');
      await expect(karte).toContainText('MiSpeL-Gutschrift nach Anlage 1+ 253,71 €');
      await expect(karte.locator('.vp-c-sp-summe')).toContainText('Zusammen+ 248,85 €');
      await expect(karte.locator('.vp-c-label .vp-chip')).toHaveCount(0);
      await expect(karte.locator('.vp-c-sp-anker-label')).toHaveText('Jahr bisher · Stromrechnung');
      await foto(page, 'erloese-monat', breite, 'section.vp-c-card.vp-c-speicher');
      await keinUeberlauf(page, breite);
    });

    test('Cockpit am Abend: „Stromrechnung“ und die Netzladen-Zeile', async ({ page }) => {
      await oeffne(page, 'heute', 'cockpit');
      const main = page.locator('main');
      await expect(main).toContainText('Steuerung heute · Stromrechnung');
      await expect(main).toContainText(
        'Netzladen nach MiSpeL: 312,0 kWh gespeichert, 214,6 kWh ins Netz · Gutschrift offen',
      );
      await expect(main).not.toContainText('unter Null');
      await foto(page, 'cockpit', breite, breite === 375 ? '[data-frame="cockpit-telefon"]' : '[data-frame="cockpit-leiste"]');
      await keinUeberlauf(page, breite);
    });

    test('Fahrplan „Was hat es gebracht?“: derselbe Satz, Planwert ohne MiSpeL-Gutschrift', async ({ page }) => {
      await oeffne(page, 'offen', 'fahrplan');
      const main = page.locator('main');
      await expect(main).toContainText('Was hat es gebracht?');
      await expect(main).toContainText('− 0,84 €');
      await expect(main).toContainText('Netzladen nach MiSpeL: 312,0 kWh gespeichert, 214,6 kWh ins Netz');
      await expect(main.locator('[data-planwert]')).toHaveText(
        'Vorab geplant hatte der Fahrplan + 0,62 € durch die Steuerung — ohne MiSpeL-Gutschrift',
      );
      await foto(page, 'fahrplan', breite, '[data-frame="fahrplan"]');
      await keinUeberlauf(page, breite);
    });

    test('Portfolio: die Anlage nennt „Netzladen nach MiSpeL“', async ({ page }) => {
      await oeffne(page, 'heute', 'portfolio');
      await expect(page.locator('main')).toContainText('Netzladen nach MiSpeL');
      await expect(page.locator('main')).toContainText('November · Stromrechnung − 3,12 €');
      await foto(page, 'portfolio', breite, '.vp-portfolio');
      await keinUeberlauf(page, breite);
    });

    test('Händler-Modus: „davon durch Netzladen … geschätzt“, die Karte wie bisher', async ({ page }) => {
      await oeffne(page, 'haendler', 'erloese');
      await expect(page.locator('main')).toContainText('davon durch Netzladen + 12,40 € geschätzt');
      const karte = page.locator('section.vp-c-card.vp-c-speicher');
      await expect(karte.locator('.vp-c-sp-zeile').first().locator('.vp-c-sp-label')).toHaveText(
        'Steuerung an diesem Tag',
      );
      await expect(karte).not.toContainText('MiSpeL');
      await foto(page, 'haendler', breite, 'section[aria-label="Preise im Zeitraum"]');
      await keinUeberlauf(page, breite);
    });

    test('Anlage ohne MiSpeL: wie bisher — Rückfall-Satz, „unter Null“, kein „geschätzt“', async ({ page }) => {
      await oeffne(page, 'ohne', 'erloese');
      const karte = page.locator('section.vp-c-card.vp-c-speicher');
      await expect(karte.locator('.vp-chip').first()).toHaveText('unter Null');
      await expect(karte.locator('.vp-c-sp-grund')).toHaveText('anders geladen und entladen');
      await expect(karte.locator('.vp-c-sp-anker-label')).toHaveText('1.–17. November');
      await expect(page.locator('main')).not.toContainText('Stromrechnung ·');
      await expect(page.locator('main')).not.toContainText('geschätzt');
      await expect(page.locator('main')).toContainText('davon durch Netzladen + 12,40 €');
      await foto(page, 'ohne-mispel', breite, 'section.vp-c-card.vp-c-speicher');
      await keinUeberlauf(page, breite);
    });
  });
}
