import { expect, test, type Page } from '@playwright/test';

/**
 * Abrechnung prüfen (Bedienkonzept `vp-privatkunde-bedienkonzept` §7, Variante A; BK-8/9/10 = A) auf der Bühne
 * `e2e/abrechnung.tsx`: der fünfte Abschnitt „Zeitraum“ in Verlauf › Energie und die Karte darunter. GEMESSEN bei
 * 1440 (Chromium) und 375 px (WebKit): jeder Abschnitt der Leiste mindestens 44 × 44 px, „⋯“ am Telefon in der
 * zweiten Zeile, kein waagerechter Überlauf, die Eingabe bleibt nach dem Neuladen, Konsole sauber.
 *
 * `VORSCHAU=<Ordner>` legt die Fotos der Vorschau vor dem Merge ab (sonst keine Fotos).
 */
const JETZT = '2026-11-14T10:00:00Z';
const JAHR = 'von=2025-11-01&bis=2026-10-31';
const VORSCHAU = process.env.VORSCHAU ?? '';

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

function breiteFuer(projekt: string): 1440 | 375 | null {
  if (projekt === 'desktop-chromium') return 1440;
  if (projekt === 'mobile-webkit') return 375;
  return null;
}

async function oeffnen(page: Page, breite: 1440 | 375, pfad: string, query = '') {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  await page.setViewportSize({ width: breite, height: breite === 1440 ? 900 : 812 });
  await page.clock.setFixedTime(new Date(JETZT));
  await page.goto(`/e2e/abrechnung.html${query}#/anlage/${pfad}`);
  await page.locator('.vp-zeitleiste').first().waitFor();
  return fehler;
}

async function karte(page: Page) {
  const k = page.locator('section.vp-ab-karte');
  await expect(k.locator('[data-testid="abrechnung-bezug"]')).toBeVisible();
  return k;
}

const ohneLuecken = (s: string | null) => (s ?? '').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();

async function ueberlauf(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function foto(page: Page, name: string, breite: number, ziel?: string) {
  if (!VORSCHAU) return;
  const datei = `${VORSCHAU}/${name}-${breite}.png`;
  if (ziel) {
    await page.locator(ziel).first().screenshot({ path: datei });
  } else {
    await page.screenshot({ path: datei, fullPage: true });
  }
}

test.describe('Abrechnung prüfen', () => {
  test.beforeEach(({}, info) => {
    test.skip(breiteFuer(info.project.name) == null, 'je Breite nur die passende Maschine');
  });

  test('Zeitraum in der Leiste: fünf Abschnitte, Datumsfelder, ⋯ am Telefon in der zweiten Zeile', async ({ page }, info) => {
    const breite = breiteFuer(info.project.name)!;
    const fehler = await oeffnen(page, breite, 'birkenweg/messwerte?z=monat&at=2026-10-15');
    const abschnitte = page.locator('.vp-zeitleiste .vp-seg [role="tab"]');
    await expect(abschnitte).toHaveText(['Tag', 'Woche', 'Monat', 'Jahr', 'Zeitraum']);
    for (const b of await abschnitte.all()) {
      const r = (await b.boundingBox())!;
      expect(r.width, await b.textContent() ?? '').toBeGreaterThanOrEqual(44);
      expect(r.height).toBeGreaterThanOrEqual(44);
    }
    if (breite === 375) {
      // §3.5: „⋯“ rückt neben den Blätterer in die zweite Zeile.
      await expect(page.locator('.vp-zl-row-2 .vp-zl-more')).toBeVisible();
      await expect(page.locator('.vp-zl-row-1 .vp-zl-more')).toHaveCount(0);
    }
    expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
    await foto(page, 'leiste-monat', breite, '.vp-zeitleiste');

    // Antippen übernimmt den gezeigten Monat — bis höchstens gestern.
    await page.getByRole('tab', { name: 'Zeitraum' }).click();
    await expect(page).toHaveURL(/z=zeitraum&von=2026-10-01&bis=2026-10-31/);
    await expect(page.locator('.vp-zr-feld')).toHaveCount(2);
    await expect(page.locator('.vp-zr-feld').first()).toContainText('01.10.2026');
    await expect(page.getByRole('button', { name: 'Vorheriger Zeitraum' })).toHaveCount(0);
    await karte(page);
    // Im Zeitraum kein Vergleich mit einer Vorperiode.
    await expect(page.locator('.vp-vr-dlt')).toHaveCount(0);
    expect(await ueberlauf(page)).toBeLessThanOrEqual(0);

    // Zurück zu „Monat“: die gewohnte Leiste, der Zeitraum ist gemerkt.
    await page.getByRole('tab', { name: 'Monat' }).click();
    await expect(page.locator('.vp-zr-feld')).toHaveCount(0);
    await expect(page.locator('section.vp-ab-karte')).toHaveCount(0);
    expect(fehler).toEqual([]);
  });

  test('Privat mit Zähler: Mengen, Zählerstände, Unterschied, Eingabe bleibt nach Neuladen', async ({ page }, info) => {
    const breite = breiteFuer(info.project.name)!;
    const fehler = await oeffnen(page, breite, `birkenweg/messwerte?z=zeitraum&${JAHR}`);
    const k = await karte(page);
    await expect(k.locator('.vp-vr-card-title')).toContainText('Abrechnung prüfen');
    await expect(k.locator('.vp-vr-card-title small')).toHaveText('01.11.2025 – 31.10.2026');
    const bezug = k.locator('[data-testid="abrechnung-bezug"]');
    expect(ohneLuecken(await bezug.textContent())).toMatch(/Netzbezug.*Zählerstand 12.509 → 18.476/);
    expect(ohneLuecken(await bezug.locator('.vp-ab-gemessen').first().textContent())).toBe('5.967 kWh');
    await expect(k.locator('[data-testid="abrechnung-einspeisung"]')).toContainText('Zählerstand 29.134 → 30.872');
    await expect(k.locator('.vp-ab-satz')).toHaveText(
      'Gemessen am Netzanschluss. Für die Rechnung zählt der Zähler Ihres Messstellenbetreibers.',
    );
    await foto(page, 'zeitraum-leer', breite, 'section.vp-ab-karte');

    // Eintragen, Feld verlassen: gespeichert, Unterschied steht.
    const feld = page.getByRole('textbox', { name: 'Netzbezug laut Rechnung in kWh' });
    await feld.fill('5.931');
    await feld.blur();
    await expect(bezug.locator('.vp-ab-unterschied')).toContainText('+36');
    expect(ohneLuecken(await bezug.locator('.vp-ab-unterschied').textContent())).toContain('+36 kWh · 0,6 %');
    await expect(bezug.locator('.vp-ab-unterschied.is-gross')).toHaveCount(0);
    expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
    await foto(page, 'privat-jahr', breite);
    await foto(page, 'privat-karte', breite, 'section.vp-ab-karte');

    await page.reload();
    await karte(page);
    await expect(page.getByRole('textbox', { name: 'Netzbezug laut Rechnung in kWh' })).toHaveValue('5.931');

    // Großer Unterschied: der Wert im Warn-Ton, die Frage nach Zeitraum und Zählernummer — kein Urteil.
    const f2 = page.getByRole('textbox', { name: 'Netzbezug laut Rechnung in kWh' });
    await f2.fill('5.410');
    await f2.blur();
    await expect(bezug.locator('.vp-ab-unterschied.is-gross')).toBeVisible();
    await expect(page.locator('.vp-ab-satz')).toHaveText(
      'Größerer Unterschied beim Netzbezug. Stimmen Zeitraum und Zählernummer auf der Rechnung?',
    );
    await foto(page, 'unterschied-gross', breite, 'section.vp-ab-karte');

    // Leeres Feld löscht.
    await f2.fill('');
    await f2.blur();
    await expect(bezug.locator('.vp-ab-unterschied')).toHaveCount(breite === 1440 ? 1 : 0);
    expect(fehler).toEqual([]);
  });

  test('Frühere Prüfungen setzen den Zeitraum der Seite', async ({ page }, info) => {
    const breite = breiteFuer(info.project.name)!;
    await oeffnen(page, breite, 'birkenweg/messwerte?z=zeitraum&von=2024-11-01&bis=2025-10-31');
    await karte(page);
    const f = page.getByRole('textbox', { name: 'Netzbezug laut Rechnung in kWh' });
    await f.fill('2.870');
    await f.blur();
    await expect(page.locator('.vp-ab-unterschied').first()).not.toHaveText('–');
    await page.goto(`/e2e/abrechnung.html#/anlage/birkenweg/messwerte?z=zeitraum&${JAHR}`);
    const k = await karte(page);
    const knopf = k.getByRole('button', { name: 'Frühere Prüfungen' });
    await expect(knopf).toBeVisible();
    await knopf.click();
    await foto(page, 'fruehere', breite, 'section.vp-ab-karte');
    await k.getByRole('button', { name: '01.11.2024 – 31.10.2025' }).click();
    await expect(page).toHaveURL(/von=2024-11-01&bis=2025-10-31/);
    await expect(page.getByRole('textbox', { name: 'Netzbezug laut Rechnung in kWh' })).toHaveValue('2.870');
    await expect(page.locator('.vp-ab-satz').first()).toContainText('Gemessen wird erst seit dem 01.03.2025');
  });

  test('Beobachtung wie Schramm: Messbeginn im Zeitraum, Zählerstände vom Netzzähler', async ({ page }, info) => {
    const breite = breiteFuer(info.project.name)!;
    const fehler = await oeffnen(page, breite, 'muehlbach/messwerte?z=zeitraum&von=2026-11-01&bis=2026-11-13', '?anlage=muehlbach');
    const k = await karte(page);
    await expect(k.locator('.vp-ab-satz.is-warn')).toHaveText(
      'Gemessen wird erst seit dem 07.11.2026 – davor fehlen 6 Tage dieses Zeitraums.',
    );
    await expect(k.locator('[data-testid="abrechnung-bezug"]')).toContainText('Zählerstand 42.612 →');
    await expect(k.locator('[data-testid="abrechnung-einspeisung"]')).toContainText('Zählerstand 80.952 →');
    expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
    await foto(page, 'beobachtung', breite);
    await foto(page, 'beobachtung-karte', breite, 'section.vp-ab-karte');

    // Ganz vor dem Messbeginn: ein Satz, kein „0 kWh“.
    await page.goto('/e2e/abrechnung.html?anlage=muehlbach#/anlage/muehlbach/messwerte?z=zeitraum&von=2026-10-01&bis=2026-10-31');
    await expect(page.locator('.vp-ab-satz')).toHaveText('Für diesen Zeitraum liegen keine Messwerte vor.');
    await expect(page.locator('[data-testid="abrechnung-bezug"] .vp-ab-gemessen').first()).toHaveText('–');
    await foto(page, 'ohne-messwerte', breite);
    expect(fehler).toEqual([]);
  });

  test('Ohne Zähler: aus Messwerten summiert, Lückentage genannt', async ({ page }, info) => {
    const breite = breiteFuer(info.project.name)!;
    const fehler = await oeffnen(page, breite, `birkenweg/messwerte?z=zeitraum&${JAHR}`, '?fall=summe');
    const k = await karte(page);
    await expect(k.locator('[data-testid="abrechnung-bezug"]')).toContainText('aus Messwerten summiert');
    await expect(k.locator('.vp-ab-satz.is-warn')).toHaveText(
      'An 3 Tagen fehlen Messwerte (12.–14.02.2026) – sie sind in der Summe nicht enthalten.',
    );
    await foto(page, 'ohne-zaehler', breite, 'section.vp-ab-karte');
    expect(fehler).toEqual([]);
  });

  test('Keine Einspeisung: nur die Zeile Netzbezug', async ({ page }, info) => {
    const breite = breiteFuer(info.project.name)!;
    await oeffnen(page, breite, `birkenweg/messwerte?z=zeitraum&${JAHR}`, '?fall=nurbezug');
    const k = await karte(page);
    await expect(k.locator('[data-testid="abrechnung-einspeisung"]')).toHaveCount(0);
    await foto(page, 'nur-bezug', breite, 'section.vp-ab-karte');
  });

  test('Bis 92 Tage je Tag, darüber je Monat', async ({ page }, info) => {
    const breite = breiteFuer(info.project.name)!;
    await oeffnen(page, breite, 'birkenweg/messwerte?z=zeitraum&von=2026-08-01&bis=2026-10-31');
    await karte(page);
    await expect(page.locator('.vp-vr-card-title').filter({ hasText: 'Energiebilanz je Tag' })).toBeVisible();
    await foto(page, 'quartal', breite);
    await page.goto(`/e2e/abrechnung.html#/anlage/birkenweg/messwerte?z=zeitraum&${JAHR}`);
    await expect(page.locator('.vp-vr-card-title').filter({ hasText: 'Energiebilanz je Monat' })).toBeVisible();
  });
});
