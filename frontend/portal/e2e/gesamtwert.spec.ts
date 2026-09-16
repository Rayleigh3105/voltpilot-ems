import { expect as baseExpect, test, type Page } from '@playwright/test';

// Der Vite-Dev-Server kompiliert den Modulgraphen beim ERSTEN Zugriff; unter
// voller Parallelität (mehrere Worker gleichzeitig kalt) dauert dieser eine
// Kaltstart, nicht der Assistent. Deshalb eine grosszügige Aussage-Wartezeit
// (30 s statt 5 s) und `test.slow()` in den Läufen — der Assistent selbst ist
// warm sofort da (siehe die 9-s-Läufe).
const expect = baseExpect.configure({ timeout: 30_000 });

// Diese Bühne zieht den schweren Chart-Graphen (ECharts über den Verlauf-Ast)
// herein; unter voller Parallelität kompiliert der Dev-Server ihn kalt in
// mehreren Workern GLEICHZEITIG, was einen Kaltstart selten über die Frist
// hebt. Der Assistent selbst ist warm sofort da (die 8–10-s-Läufe). Ein
// Wiederholungslauf fährt gegen den dann warmen Server und ist grün — das ist
// die dafür vorgesehene, dateilokale Stellschraube (kein globaler Eingriff).
// ⚠ Die Wiederholung deckt NUR den Kaltstart. Die Ausfälle bis 15.09.2026 waren
// ein Wirt, der den Assistenten schon beim Speichern schloss (siehe `stehtOffen`)
// — die Wiederholungen hatten sie als „flaky" grün gefärbt.
test.describe.configure({ retries: 2 });

/**
 * Der Gesamtwert-Assistent, Ankerfall Deye SUN-30K: PV 1 + PV 2 + PV 3 +
 * Mikrowechselrichter ergeben „Gesamt-PV" (= 15,5 kW). Danach erscheint der
 * berechnete Wert wie ein gemessener — als Kachel in der Übersicht UND als
 * eigener Ast im Verlauf. Die Cloud ist per `page.route` verdrahtet.
 */

const KANAELE = [
  { kanal: 'pv1_power_kw', wert: 5.2 },
  { kanal: 'pv2_power_kw', wert: 4.1 },
  { kanal: 'pv3_power_kw', wert: 3.1 },
  { kanal: 'microinverter_power_kw', wert: 3.1 },
];

function bucket(last: number) {
  return [{ start: '2026-09-12T09:45:00Z', avg: last, min: last, max: last, last, n: 1 }];
}

/**
 * Der Abschluss-Schritt STEHT, bis der Kunde „Fertig" drückt. Schließt der Wirt das Modal
 * schon beim Speichern, erscheint „ist angelegt" im selben Frame wie `is-closing` und ist
 * nach ~180 ms weg — das war bis 15.09.2026 ein Zeitrennen, das die Wiederholungen still
 * grün färbten. Diese Aussage macht daraus einen festen Befund: sie wartet nicht das
 * Ausblenden ab, sondern scheitert daran (auch ein verschwundenes Modal erfüllt sie nie).
 */
async function stehtOffen(page: Page) {
  await expect(page.locator('.vp-modal-scrim')).not.toHaveClass(/is-closing/);
}

async function mock(page: Page, vorzeichenNetz = false) {
  const state: { created: null | Record<string, unknown> } = { created: null };

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith('/measurement-selection/catalog')) return route.fulfill({ json: { total: KANAELE.length, points: KANAELE.map((k, i) => ({
      pointKey: k.kanal, labelDe: ['PV 1', 'PV 2', 'PV 3', 'Mikrowechselrichter'][i], group: 'PV', quantity: 'active_power', direction: vorzeichenNetz && i === 0 ? 'import_export' : 'generation',
      aggregationKind: 'gauge', unit: 'kW', selected: true, decodedValue: String(k.wert), lastReadAt: new Date().toISOString(), estimatedDataPerYearBytes: 0,
    })) } });
    if (path.endsWith('/summenwert-quellen')) return route.fulfill({ json: [{ entityId: 'inv', deviceId: 'd1', name: 'Deye SUN-30K', grund: null }] });
    // --- Assistent: Baum, Größen, Live-Werte, Kennzeichen ---
    if (path.endsWith('/entities')) {
      return route.fulfill({
        json: {
          registry: null,
          localSetup: [],
          staleOnDevice: [],
          entities: [
            {
              id: 'inv',
              entityType: 'modbus-generic',
              typeLabel: 'Wechselrichter',
              role: 'grid',
              label: 'Deye SUN-30K',
              control: false,
              deviceId: 'd1',
              capabilities: { measure: KANAELE.map((k) => ({ channel: k.kanal, unit: 'kW' })) },
              guards: null,
              syncStatus: 'in_sync',
              observed: { health: 'ok', lastTelemetryAt: null, channels: [], appliedType: null, reportedAt: '' },
              edgeSourceId: null,
            },
          ],
        },
      });
    }
    if (path.endsWith('/topology')) {
      return route.fulfill({
        json: {
          schemaVersion: '1.0',
          entities: [
            { id: 'inv', entityType: 'modbus-generic', typeLabel: 'Wechselrichter', label: 'Deye SUN-30K', category: 'meter', health: 'ok', capabilities: [] },
          ],
          topology: { schema_version: '1.0', nodes: [] },
        },
      });
    }
    if (path.endsWith('/messkanaele')) {
      return route.fulfill({
        json: {
          siteId: 'site-e2e',
          komponente: 'inv',
          inhaltsstand: '2026.09.11.1',
          messkanaele: KANAELE.map((k) => ({
            kanal: k.kanal, anzeigename: null, einheit: 'kW', wertart: 'Momentanwert',
            groesse: 'Wirkleistung', quantity: 'active_power',
            richtung: vorzeichenNetz && k === KANAELE[0] ? 'richtungslos' : 'Erzeugung',
            direction: vorzeichenNetz && k === KANAELE[0] ? 'import_export' : 'generation',
            kadenz_s: 5, aktiv: true, lesende_box: null, geraet: null, speist: [],
          })),
        },
      });
    }
    if (/\/entities\/[^/]+\/history/.test(path)) {
      return route.fulfill({
        json: {
          range: 'day', from: '', to: '', bucketMinutes: 5,
          channels: Object.fromEntries(KANAELE.map((k) => [k.kanal, bucket(k.wert)])),
        },
      });
    }
    if (path.endsWith('/kennzeichen-vorschlag')) {
      return route.fulfill({ json: { kennzeichen: 'MS-0007' } });
    }

    // --- Berechnete Messstelle: anlegen + lesen ---
    if (path.endsWith('/messstellen/berechnet') && method === 'POST') {
      state.created = { id: 'gw-1', kennzeichen: 'MS-0007', name: 'Gesamt-PV', art: 'berechnet', medium: 'Strom', lebenszyklus: 'aktiv', fehlt: [] };
      return route.fulfill({ status: 201, json: state.created });
    }
    if (path.endsWith('/messstellen')) {
      return route.fulfill({ json: { messstellen: state.created ? [state.created] : [] } });
    }
    if (/\/messstellen\/[^/]+\/formel$/.test(path)) {
      // ⚠ snake_case wie das echte Backend #688 (MessstelleFormelDto, @JsonNaming).
      return route.fulfill({
        json: {
          messstelle_id: 'gw-1', schema_version: '1.0',
          hauptgroesse: { groesse: 'Wirkleistung', richtung: 'Erzeugung', einheit: 'kW', wertart: 'Momentanwert' },
          terme: KANAELE.map((k, i) => ({ position: i, eingang_art: 'messkanal', entity_id: 'inv', point_key: k.kanal, quell_messstelle_id: null, vorzeichen: '+', faktor: 1, groesse: null, eingerichtet: true })),
          formel_vorhanden: true, eingaenge_eingerichtet: true,
        },
      });
    }
    if (/\/messstellen\/[^/]+\/wert$/.test(path)) {
      return route.fulfill({ json: { wert: 15.5, einheit: 'kW', unvollstaendig: false, fehlende: [], stand: '2026-09-12T09:45:00Z' } });
    }
    if (/\/messstellen\/[^/]+\/verlauf/.test(path)) {
      return route.fulfill({
        json: {
          messstelle_id: 'gw-1', einheit: 'kW',
          punkte: [
            { zeit: '2026-09-12T08:00:00Z', wert: 4.2 },
            { zeit: '2026-09-12T09:00:00Z', wert: 11.8 },
            { zeit: '2026-09-12T09:45:00Z', wert: 15.5 },
          ],
        },
      });
    }
    // Alles Übrige (Layout, Overview, …) braucht die Bühne nicht.
    return route.fulfill({ json: {} });
  });
}


for (const width of [375, 1440]) {
  test(`Anlagen-Einstieg ohne Vorauswahl und ohne Rolle bei ${width} px`, async ({ page }, testInfo) => {
    test.slow(); await mock(page); await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/e2e/gesamtwert.html');
    await page.getByRole('button', { name: 'Summenwert anlegen', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /Summenwert/ });
    await expect(dialog.getByRole('button', { name: 'Weiter', exact: true })).toBeDisabled();
    for (const name of ['PV 1', 'PV 2', 'PV 3', 'Mikrowechselrichter']) await dialog.getByRole('button', { name: `${name} mitzählen`, exact: true }).click();
    await expect(dialog.locator('.vp-sw-sumline')).toContainText('15,5');
    for (let step = 1; step <= 4; step++) {
      expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      if (testInfo.project.name === 'desktop-chromium') await dialog.screenshot({ path: `/tmp/vp-helfer-ansicht/anlage-${width}-${step}.png` });
      if (step < 4) await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
    }
    await expect(dialog.getByRole('button', { name: 'keine Rolle', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const request = page.waitForRequest((r) => r.url().endsWith('/messstellen/berechnet') && r.method() === 'POST');
    await dialog.getByRole('button', { name: 'Speichern' }).click();
    expect((await request).postDataJSON().rolle).toBeUndefined();
    await expect(dialog.getByText(/ist angelegt/)).toBeVisible(); await stehtOffen(page);
    if (testInfo.project.name === 'desktop-chromium') await dialog.screenshot({ path: `/tmp/vp-helfer-ansicht/anlage-${width}-5.png` });
    await dialog.getByRole('button', { name: 'Fertig' }).click(); await expect(dialog).toBeHidden();
    const overview = page.getByRole('region', { name: 'Übersicht' });
    await expect(overview.getByText('Gesamt-PV')).toBeVisible();
    await expect(overview.locator('.vp-gwk-big')).toContainText('15,5');
    const verlauf = page.getByRole('region', { name: 'Verlauf' });
    await expect(verlauf.getByText('Berechnete Werte').first()).toBeAttached();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}


test('der Anlagen-Einstieg sperrt import_export vor der Auswahl', async ({ page }) => {
  test.slow(); await mock(page, true); await page.goto('/e2e/gesamtwert.html');
  await page.getByRole('button', { name: 'Summenwert anlegen', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /Summenwert/ });
  const button = dialog.getByRole('button', { name: 'PV 1 mitzählen', exact: true });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /Bezug und Abgabe gemeinsam/);
  await expect(dialog.getByText(/Bezug und Abgabe trennen/)).toBeVisible();
});
