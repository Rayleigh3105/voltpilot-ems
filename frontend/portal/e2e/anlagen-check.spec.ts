import { expect, test, type Page } from '@playwright/test';

/**
 * Anlagen-Check (Bedienkonzept vp-privatkunde-bedienkonzept, BK-4/BK-5/BK-7 = A): die Kachel „Solaranlage“ im
 * Cockpit, die Karte „Erzeugung nach Einheiten“ in Verlauf › Energie und die „Speicher-Bilanz“ auf der Geräteseite -
 * echtes Portal auf gestellten Antworten (`e2e/anlagen-check-fixtures.ts`), bei 1440 und 375 px: Inhalt, Ort, kein
 * Überlauf, Konsole sauber. Mühlbach ist die Beobachtungs-Anlage wie Schramm (vier Wechselrichter), Birkenweg der
 * Hybrid (ganze Anlage), Sonnenhof die Anlage mit drei Dächern und einem Speicher.
 */
test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

const NB = /[  ]/g;
const BREITEN = [1440, 375] as const;

async function oeffnen(page: Page, breite: number, pfad: string, uhr: string, warte: string) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  await page.setViewportSize({ width: breite, height: breite === 1440 ? 900 : 812 });
  await page.clock.setFixedTime(new Date(uhr));
  await page.goto(pfad);
  await page.locator(warte).first().waitFor();
  return fehler;
}

const ueberlauf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const text = async (page: Page, sel: string) => ((await page.locator(sel).first().textContent()) ?? '').replace(NB, ' ');

test.describe('Kachel „Solaranlage“', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop-chromium', 'Breiten werden hier selbst gesetzt'));

  for (const breite of BREITEN) {
    test(`Mühlbach: „Kaco 3 liefert weniger“, vier Zeilen auf der Spur der Erwartung (${breite} px)`, async ({ page }) => {
      const fehler = await oeffnen(page, breite, '/e2e/cockpit-privat.html?lage=abend&einheiten=wr&solar=warn#/anlage/muehlbach', '2026-11-07T18:47:00Z', '.vp-lp');
      const kachel = page.locator('[data-kachel="solaranlage"]');
      await expect(kachel).toBeVisible();
      await expect(kachel.locator('.vp-k-marke')).toHaveText('Kaco 3 liefert weniger');
      await expect(kachel.locator('.vp-k-marke')).toHaveClass(/is-warn/);
      await expect(kachel.locator('.vp-k-mini')).toHaveCount(4);
      await expect(kachel.locator('.vp-k-mini.is-warn')).toHaveCount(1);
      await expect(kachel.locator('.vp-k-spur.is-erwartet')).toHaveCount(4);
      expect(await text(page, '[data-kachel="solaranlage"] .vp-k-sub')).toBe('letzte 7 Tage · gemessen gegen erwartet');
      expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
      expect(fehler).toEqual([]);
      // Der Kopf führt in den Verlauf, Woche.
      await kachel.locator('.vp-k-kopf').click();
      await expect(page).toHaveURL(/#\/anlage\/muehlbach\/messwerte\?z=woche/);
    });

    test(`Birkenweg (Hybrid): eine Zeile „Ganze Anlage“, Kachel klein (${breite} px)`, async ({ page }) => {
      const fehler = await oeffnen(page, breite, '/e2e/cockpit-privat.html?lage=speicher&solar=eine#/anlage/birkenweg', '2026-11-07T18:47:00Z', '.vp-lp');
      const kachel = page.locator('[data-kachel="solaranlage"]');
      await expect(kachel).toHaveClass(/is-klein/);
      await expect(kachel.locator('.vp-k-marke')).toHaveText('Liefert wie erwartet');
      await expect(kachel.locator('.vp-k-mini > span').first()).toHaveText('Ganze Anlage');
      expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
      expect(fehler).toEqual([]);
    });
  }

  const ZUSTAENDE: [string, string, RegExp][] = [
    ['gut', 'Alle 4 liefern wie erwartet', /letzte 7 Tage/],
    ['sonne', 'Zu wenig Sonne für einen Vergleich', /ab 3 Tagen mit Sonne/],
    ['fehlt', 'Von Kaco 3 fehlen Messwerte', /gemessen gegen erwartet/],
    ['abgeregelt', 'Alle 4 liefern wie erwartet', /5 von 7 Tagen · 2 Tage abgeregelt, nicht gewertet/],
    ['frueh', 'Noch zu kurz für einen Vergleich', /letzte/],
  ];
  for (const [fall, marke, fuss] of ZUSTAENDE) {
    test(`Zustand ${fall}`, async ({ page }) => {
      const fehler = await oeffnen(page, 1440, `/e2e/cockpit-privat.html?lage=abend&einheiten=wr&solar=${fall}#/anlage/muehlbach`, '2026-11-07T18:47:00Z', '.vp-lp');
      const kachel = page.locator('[data-kachel="solaranlage"]');
      await expect(kachel.locator('.vp-k-marke')).toHaveText(marke);
      expect(await text(page, '[data-kachel="solaranlage"] .vp-k-sub')).toMatch(fuss);
      if (fall === 'fehlt') await expect(kachel.locator('.vp-k-mini').nth(2).locator('b')).toHaveText(/^keine Werte seit /);
      expect(fehler).toEqual([]);
    });
  }

  test('ohne Antwort (keine PV, älteres Backend) keine Kachel', async ({ page }) => {
    const fehler = await oeffnen(page, 1440, '/e2e/cockpit-privat.html?lage=abend&solar=aus#/anlage/muehlbach', '2026-11-07T18:47:00Z', '.vp-lp');
    await expect(page.locator('.vp-k-platz').first()).toBeVisible();
    await expect(page.locator('[data-kachel="solaranlage"]')).toHaveCount(0);
    expect(fehler).toEqual([]);
  });
});

test.describe('Karte „Erzeugung nach Einheiten“', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop-chromium', 'Breiten werden hier selbst gesetzt'));
  const VERLAUF = (q: string, z: string, at: string) => `/e2e/unterverteilung.html?${q}#/anlage/help-site/messwerte?z=${z}&at=${at}`;

  for (const breite of BREITEN) {
    test(`Woche: erste Karte der Seitenspalte, Zeilen, Säulen, Satz (${breite} px)`, async ({ page }) => {
      const fehler = await oeffnen(page, breite, VERLAUF('solar=warn', 'woche', '2026-09-03'), '2026-09-07T09:00:00Z', '.vp-vr-card');
      const karte = page.locator('.vp-vr-einheiten');
      await expect(karte).toBeVisible();
      // Der Spiegel von „Verbrauch nach Bereichen“: die erste Karte ihrer Spalte.
      expect(await karte.evaluate((el) => el.parentElement?.firstElementChild === el)).toBe(true);
      await expect(karte.locator('.vp-vr-kv > div')).toHaveCount(3);
      await expect(karte.locator('.vp-vr-kv > div.is-warn dt')).toContainText('Carport');
      await expect(karte.locator('.vp-vr-saeule')).toHaveCount(7);
      expect((await karte.locator('.vp-vr-foot').first().textContent())?.replace(NB, ' ')).toBe('Carport liefert seit Mittwoch weniger als erwartet.');
      expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
      expect(fehler).toEqual([]);
    });
  }

  test('Jahr: Säulen je Monat; Tag ohne Satz; heute noch offen', async ({ page }) => {
    await oeffnen(page, 1440, VERLAUF('solar=gut', 'jahr', '2026-08-15'), '2026-09-07T09:00:00Z', '.vp-vr-einheiten');
    await expect(page.locator('.vp-vr-einheiten .vp-vr-saeule')).toHaveCount(9);
    await page.goto(VERLAUF('solar=gut', 'tag', '2026-09-03'));
    await page.locator('.vp-vr-einheiten').waitFor();
    await expect(page.locator('.vp-vr-einheiten .vp-vr-foot')).toHaveCount(0);
    await page.goto(VERLAUF('solar=gut', 'tag', '2026-09-07'));
    await expect(page.locator('.vp-vr-einheiten .vp-vr-foot')).toHaveText('Der Vergleich beginnt mit dem ersten abgeschlossenen Tag.');
  });

  test('ohne Antwort keine Karte', async ({ page }) => {
    await oeffnen(page, 1440, VERLAUF('', 'woche', '2026-09-03'), '2026-09-07T09:00:00Z', '.vp-vr-card');
    await expect(page.locator('.vp-vr-einheiten')).toHaveCount(0);
  });
});

test.describe('Speicher-Bilanz auf der Geräteseite', () => {
  test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop-chromium', 'Breiten werden hier selbst gesetzt'));
  const GERAET = (q: string) => `/e2e/unterverteilung.html?${q}#/anlage/help-site/geraet/VP-DEMO-0001/inverter`;

  for (const breite of BREITEN) {
    test(`drei Zahlen nach „Heute“, Satz, „12 Monate ›“ (${breite} px)`, async ({ page }) => {
      const fehler = await oeffnen(page, breite, GERAET('bilanz=normal'), '2026-09-07T09:00:00Z', '[data-testid="geraet-rahmen"]');
      const karte = page.locator('[data-baustein="bilanz"]');
      await expect(karte.locator('h2')).toHaveText('Speicher-Bilanz · 30 Tage');
      await expect(karte.locator('.vp-sb-wert')).toHaveText([/91\s%/, '19', /19\skWh/]);
      expect((await karte.locator('.vp-sb-satz').textContent())?.replace(NB, ' ')).toBe('Unauffällig – wie in den letzten 12 Monaten (90–92 %).');
      // „Heute“ steht davor, auch am Telefon (gleiche Ordnung, Quellreihenfolge).
      const oben = await page.evaluate(() => [
        document.querySelector('[data-baustein="heute"]')?.getBoundingClientRect().top ?? -1,
        document.querySelector('[data-baustein="bilanz"]')?.getBoundingClientRect().top ?? -1,
      ]);
      expect(oben[0]).toBeGreaterThanOrEqual(0);
      expect(oben[1]).toBeGreaterThan(oben[0]);
      await karte.locator('.vp-sb-umschalter').click();
      await expect(karte.locator('h2')).toHaveText('Speicher-Bilanz · 12 Monate');
      await expect(karte.locator('.vp-sb-monate tbody tr')).toHaveCount(12);
      expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
      expect(fehler).toEqual([]);
    });
  }

  test('wenig geladen, ohne Kapazität, niedriger, ohne Daten', async ({ page }) => {
    await oeffnen(page, 1440, GERAET('bilanz=wenig'), '2026-09-07T09:00:00Z', '[data-baustein="bilanz"]');
    await expect(page.locator('.vp-sb-satz')).toHaveText('Noch zu wenig geladen für eine Bilanz – ab etwa 5 Vollzyklen.');
    await page.goto(GERAET('bilanz=ohnekap'));
    await expect(page.locator('[data-baustein="bilanz"] h2')).toHaveText('Speicher-Bilanz · 90 Tage');
    await expect(page.locator('.vp-sb-titel')).toHaveText(['Wirkungsgrad', 'Verlust']);
    await page.goto(GERAET('bilanz=schlecht'));
    await expect(page.locator('.vp-sb-satz')).toHaveClass(/is-warn/);
    await page.goto(GERAET(''));
    await page.locator('[data-testid="geraet-rahmen"]').waitFor();
    await expect(page.locator('[data-baustein="bilanz"]')).toHaveCount(0);
  });
});
