import { test, expect, type Page } from '@playwright/test';

/**
 * Der Sonnen-Teppich (Konzept `vp-prognosen-konzept`, E1 = C) im echten
 * Browser - die drei Zuschnitte aus `ship-instructions.md` Punkt 11: mit
 * Speicher (Reiter im Fahrplan), nur messen mit PV (eigener Bereich), nur
 * messen ohne PV (Teppich für den Verbrauch). Bei 1440 und 390 px: kein
 * Überlauf, keine Konsolenfehler.
 */
async function oeffnen(page: Page, width: number, fall: string, uhr: Date, zusatz = '') {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
  await page.clock.setFixedTime(uhr);
  await page.goto(`/e2e/prognose.html?fall=${fall}${zusatz}`);
  await expect(page.locator('.vp-pz-antwort')).toBeVisible();
  await expect(page.locator('.vp-pt-teppich')).toBeVisible();
}

async function ohneUeberlauf(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(
    await page.locator('main').evaluate((el) =>
      [...el.querySelectorAll('*')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
      }).length,
    ),
  ).toBe(0);
}

const JETZT = new Date(2026, 10, 11, 13, 45);

for (const width of [390, 1440]) {
  test(`Prognose bei ${width} px · mit Speicher: zwei Balken, Speicher-Streifen, "Ihr Fahrplan"`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'mit-speicher', JETZT);

    await expect(page.locator('.vp-pt-balken-zeile')).toHaveCount(2);
    await expect(page.locator('.vp-pt-teppich .vp-pt-tagzeile')).toHaveCount(7);
    await expect(page.getByRole('link', { name: /Ihr Fahrplan/ })).toBeVisible();
    await expect(page.getByText('Speicher', { exact: true })).toBeVisible();

    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });

  test(`Prognose bei ${width} px · nur messen mit PV: eigener Bereich, ohne Speicher-Streifen`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'nur-messen-pv', JETZT);

    await expect(page.locator('.vp-pt-balken-zeile')).toHaveCount(2);
    await expect(page.locator('.vp-pt-teppich .vp-pt-tagzeile')).toHaveCount(7);
    // Ohne Fahrplan: keine Zeile "Ihr Fahrplan", kein Speicher-Streifen.
    await expect(page.getByRole('link', { name: /Ihr Fahrplan/ })).toHaveCount(0);
    await expect(page.getByText('Speicher', { exact: true })).toHaveCount(0);

    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });

  test(`Prognose bei ${width} px · Rückblick: Tage und Satz, mit PV beide Arten`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'mit-speicher', JETZT);

    await page.getByRole('button', { name: /Rückblick/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Verbrauchsprognose (Last)')).toBeVisible();
    await expect(page.getByText('PV-Prognose (Erzeugung)')).toBeVisible();
    await expect(page.locator('.vp-pz-rblk-tabelle tbody tr')).toHaveCount(14);
    await expect(page.getByText('An 8 von 10 Tagen höchstens 2 kWh daneben.')).toBeVisible();
    await expect(page.getByText('An 8 von 10 Tagen höchstens 3 kWh daneben.')).toBeVisible();

    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });

  test(`Prognose bei ${width} px · Rückblick ohne PV: keine Sonnen-Zeile, ehrlich`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'nur-messen-ohne-pv', JETZT);

    await page.getByRole('button', { name: /Rückblick/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Verbrauchsprognose (Last)')).toBeVisible();
    await expect(page.getByText('PV-Prognose (Erzeugung)')).toHaveCount(0);
    await expect(page.locator('.vp-pz-rblk-tabelle tbody tr')).toHaveCount(7);

    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });

  test(`Prognose bei ${width} px · nur messen ohne PV: der Teppich zeigt nur den Verbrauch`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'nur-messen-ohne-pv', JETZT);

    // Ohne PV: EIN Balken (Verbrauch), keine Sonnen-Zahl.
    await expect(page.locator('.vp-pt-balken-zeile')).toHaveCount(1);
    await expect(page.locator('.vp-pt-balken-titel')).toHaveText('Verbrauch heute');
    await expect(page.locator('.vp-pt-teppich .vp-pt-tagzeile')).toHaveCount(7);
    await expect(page.getByRole('link', { name: /Ihr Fahrplan/ })).toHaveCount(0);
    // Die Überschrift nennt die Verbrauchsspitze, nicht "Sonne reicht".
    await expect(page.locator('.vp-pt-kopfsatz')).not.toContainText('Sonne reicht');

    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

/**
 * Die Lage des Captains nachgestellt (vp-prognose-teppich-treue, 11.11.2026):
 * Gewerbe ohne Speicher, November, ≈31 kWh Sonne/Tag, ≈204 kWh
 * Verbrauch/Tag, 16:06 Uhr - die Regressionsprobe für den Befund.
 */
const CAPTAIN_JETZT = new Date(2026, 10, 11, 16, 6);

for (const width of [390, 1440]) {
  test(`Prognose bei ${width} px · Lage des Captains (Gewerbe, November): Teppich bleibt lesbar, kein Überlauf`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'captain-november', CAPTAIN_JETZT);

    // "Heute" trägt echte Säulen (Datenfehler 1/Maßstab-Befund): mindestens
    // eine Stunde zeigt eine Säule, nicht nur die leere Spur.
    await expect(page.locator('.vp-pt-tagzeile').first().locator('.vp-pt-saeule')).not.toHaveCount(0);
    await expect(page.locator('.vp-pt-teppich .vp-pt-tagzeile')).toHaveCount(7);
    await expect(page.locator('.vp-pt-jetzt-linie')).toBeVisible();
    await expect(page.locator('.vp-pt-teppich-leer')).toHaveCount(0);

    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

const SOMMER_JETZT = new Date(2026, 6, 28, 10, 45);

for (const width of [390, 1440]) {
  test(`Prognose bei ${width} px · Sommer-Lage: Sonne deutlich über dem Verbrauch, kein Überlauf`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'sommer', SOMMER_JETZT);

    await expect(page.locator('.vp-pt-tagzeile').first().locator('.vp-pt-saeule')).not.toHaveCount(0);
    await expect(page.locator('.vp-pt-teppich .vp-pt-tagzeile')).toHaveCount(7);
    await expect(page.locator('.vp-pt-jetzt-linie')).toBeVisible();

    await ohneUeberlauf(page);
    expect(fehler).toEqual([]);
  });
}

test('Datenfehler 2 · ein lückenhafter Ausblick-Tag zeigt "noch keine Vorhersage", nicht leer', async ({ page }) => {
  await oeffnen(page, 1440, 'captain-november', CAPTAIN_JETZT, '&luecke=1');

  await expect(page.getByText('noch keine Vorhersage')).toBeVisible();
  // Reihenfolge der Zeilen: 0 Heute, 1 Morgen, 2 Fr 13.11., 3 Sa 14.11., 4 So
  // 15.11., 5 Mo 16.11. (der lückenhafte Tag), 6 Di 17.11. Der Tag davor und
  // danach bleiben unberührt - nur Mo 16.11. fällt ehrlich aus.
  const zeilen = page.locator('.vp-pt-teppich .vp-pt-tagzeile');
  await expect(zeilen).toHaveCount(7);
  await expect(zeilen.nth(4).locator('.vp-pt-saeule')).not.toHaveCount(0); // So 15.11.
  await expect(zeilen.nth(5).locator('.vp-pt-teppich-leer')).toBeVisible(); // Mo 16.11.
  await expect(zeilen.nth(6).locator('.vp-pt-saeule')).not.toHaveCount(0); // Di 17.11.
});

test('Datenfehler 3 · "am Vorabend erwartet" steht nur in der Legende, wenn wirklich eine Linie gezeichnet wird', async ({ page }) => {
  await oeffnen(page, 1440, 'captain-november', CAPTAIN_JETZT, '&ohneVorabend=1');

  await expect(page.getByText('am Vorabend erwartet')).toHaveCount(0);
  // Die übrige Legende bleibt da - nur die Vorabend-Zeile fehlt ehrlich.
  await expect(page.getByText('gemessen', { exact: true })).toBeVisible();
  await expect(page.getByText('erwartet', { exact: true })).toBeVisible();
});

// captain-Befund Runde 2: das Jetzt-Schild im Tagesbild überdeckte bei
// manchen Uhrzeiten die Himmel-/Temperatur-Zeile. Das Schild bekam eine
// eigene Zeile (Bericht R3.2: "unter der Himmel-Zeile, über der Fläche") -
// hier geprüft über mehrere Uhrzeiten hinweg, auch an den Rändern (0-2, 22-23 Uhr).
for (const [stunde, minute] of [
  [1, 30],
  [11, 50],
  [12, 5],
  [16, 6],
  [23, 40],
]) {
  test(`Jetzt-Schild überdeckt die Himmel-/Temperatur-Zeile nicht, auch nicht um ${stunde}:${String(minute).padStart(2, '0')} Uhr`, async ({ page }) => {
    const jetzt = new Date(2026, 10, 11, stunde, minute);
    await oeffnen(page, 1440, 'captain-november', jetzt);

    const schild = page.getByTestId('vp-pt-jetzt-schild').first();
    await expect(schild).toBeVisible();
    const schildBox = await schild.boundingBox();
    expect(schildBox).not.toBeNull();

    const kopfZellen = page.getByTestId('vp-pt-himmel-kopf');
    const anzahl = await kopfZellen.count();
    expect(anzahl).toBeGreaterThan(0);
    for (let i = 0; i < anzahl; i++) {
      const box = await kopfZellen.nth(i).boundingBox();
      if (!box || !schildBox) continue;
      const ueberlappt =
        schildBox.x < box.x + box.width &&
        schildBox.x + schildBox.width > box.x &&
        schildBox.y < box.y + box.height &&
        schildBox.y + schildBox.height > box.y;
      expect(ueberlappt).toBe(false);
    }
  });
}

// captain-Befund Runde 3: die Y-Achse des Tagesbilds zeigte einen dichten
// Zahlenstapel alle 2 kW und schnitt am Telefon die oberste Beschriftung links
// ab; die X-Achse zeigte jede Stunde 0…23. Beides jetzt wenige, runde Marken
// (Bericht R3.2: "wie im Konzept").
for (const width of [390, 1440]) {
  test(`Prognose bei ${width} px · Tagesbild-Achsen: wenige runde Marken, nichts abgeschnitten`, async ({ page }) => {
    await oeffnen(page, width, 'captain-november', CAPTAIN_JETZT);

    const yMarken = page.getByTestId('vp-pt-y-marke');
    const yAnzahl = await yMarken.count();
    expect(yAnzahl).toBeGreaterThan(1);
    expect(yAnzahl).toBeLessThanOrEqual(6);

    const xMarken = page.getByTestId('vp-pt-x-marke');
    const xAnzahl = await xMarken.count();
    expect(xAnzahl).toBeGreaterThan(1);
    expect(xAnzahl).toBeLessThanOrEqual(9);
    await expect(xMarken.first()).toHaveText('0 Uhr');
    await expect(xMarken.last()).toHaveText('24');

    // Die oberste Y-Marke (mit " kW") darf nicht links aus dem Bild laufen.
    await expect(yMarken.last()).toHaveText(/ kW$/);
    const bild = page.locator('.vp-pt-bild');
    const bildBox = await bild.boundingBox();
    const obersteBox = await yMarken.last().boundingBox();
    expect(bildBox).not.toBeNull();
    expect(obersteBox).not.toBeNull();
    if (bildBox && obersteBox) {
      expect(obersteBox.x).toBeGreaterThanOrEqual(bildBox.x - 1);
    }
  });
}
