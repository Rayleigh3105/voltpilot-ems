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

async function mock(page: Page) {
  const state: { created: null | Record<string, unknown> } = { created: null };

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

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
            groesse: 'Wirkleistung', richtung: 'Erzeugung', quantity: 'Power', direction: 'Generation',
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

test('SUN-30K: der Assistent stellt Gesamt-PV zusammen und der Wert erscheint in Übersicht + Verlauf', async ({ page }) => {
  test.slow();
  await mock(page);
  await page.goto('/e2e/gesamtwert.html');

  await page.getByRole('button', { name: 'Gesamtwert anlegen' }).click();
  // Der Titel wechselt im letzten Schritt auf „Fertig" — beide Namen zulassen.
  const dialog = page.getByRole('dialog', { name: /Gesamtwert|Fertig/ });

  // Schritt 1: die vier PV-Werte wählen. Das Picker-Panel hängt am Body und
  // trägt die Beschriftung „Messwerte wählen" — der Verlauf-Ast dahinter heißt
  // nur „Messwerte", deshalb streng auf DIESE Liste eingegrenzt.
  await dialog.getByRole('combobox', { name: /Messwerte/ }).click();
  const panel = page.getByRole('listbox', { name: 'Messwerte wählen' });
  for (const name of [/PV 1/, /PV 2/, /PV 3/, /Mikrowechselrichter/]) {
    await panel.getByRole('option', { name }).click();
  }
  // Am Telefon liegt das Picker-Panel als Vollbild über der Fußzeile — Escape
  // schließt NUR den Picker (nicht das Modal), dann ist „Weiter" erreichbar.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await dialog.getByRole('button', { name: /Weiter.*4 Werte/ }).click();

  // Schritt 2: Rechnen (Standard +)
  await expect(dialog.getByText('Wie zählen wir sie?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Weiter' }).click();

  // Schritt 3: Name-Vorschlag „Gesamt-PV" + Kennzeichen
  await expect(dialog.getByLabel('Name')).toHaveValue('Gesamt-PV');
  await expect(dialog.getByText('MS-0007')).toBeVisible();
  await dialog.getByRole('button', { name: 'Weiter' }).click();

  // Schritt 4: Vorschau — die grosse Zahl ist 15,5 (kW), die Rechenzeile zeigt
  // die Summanden.
  await expect(dialog.locator('.vp-gw-big')).toHaveText('15,5');
  await expect(dialog.getByText(/PV 1 5,20 \+ PV 2 4,10 \+ PV 3 3,10/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Speichern' }).click();

  // Schritt 5: Fertig
  await expect(dialog.getByText('ist angelegt')).toBeVisible();
  // „Fertig" schließt das Modal (es blendet aus) — force überspringt die
  // Stabilitätsprüfung, die sonst am Ausblenden scheitert.
  await dialog.getByRole('button', { name: 'Fertig' }).click({ force: true });
  await expect(dialog).toBeHidden();

  // Übersicht: die Kachel „Gesamt-PV" mit „berechnet" + Live-Wert (dies beweist
  // zugleich, dass der snake_case-Formel-Read die Site-Zuordnung findet — B1).
  const uebersicht = page.getByRole('region', { name: 'Übersicht' });
  await expect(uebersicht.getByText('Gesamt-PV')).toBeVisible();
  await expect(uebersicht.getByText('berechnet')).toBeVisible();
  await expect(uebersicht.locator('.vp-gwk-big')).toContainText('15,5');

  // Verlauf: der eigene Ast „Berechnete Werte" mit dem wählbaren Gesamt-PV.
  // Der Ast entsteht auf jedem Viewport; am Telefon wohnt die Auswahl im
  // Bottom-Sheet (Schiene ausgeblendet), deshalb wird das Wählen + die Kurve
  // nur dort geprüft, wo die Schiene sichtbar ist.
  const verlauf = page.getByRole('region', { name: 'Verlauf' });
  const ast = verlauf.getByText('Berechnete Werte').first();
  await expect(ast).toBeAttached();
  if (await ast.isVisible()) {
    await verlauf.getByRole('option', { name: /Gesamt-PV/ }).first().click();
    await expect(verlauf.getByText('Gesamt-PV').first()).toBeVisible();
  }
});

/**
 * Layout-Abnahme: bei Handy-, Tablet- und Rechnerbreite läuft nichts über
 * (0 px waagerechter Überlauf) und kein Fehler landet in der Konsole — beim
 * Assistenten (jeder Schritt) UND bei der fertigen Kachel. Der Bruch zur
 * Vollbild-Schrittfolge liegt bei 720 px, deshalb 375 · 768 · 1440.
 */
for (const width of [375, 768, 1440]) {
  test(`kein waagerechter Überlauf bei ${width} px`, async ({ page }, testInfo) => {
    // Layout ist von der Engine unabhängig — einmal auf Chromium (Viewport wird
    // hier ohnehin gesetzt) genügt und hält den Testlauf leicht.
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Layout-Abnahme läuft einmal');
    test.slow();
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(String(e)));
    await mock(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/e2e/gesamtwert.html');

    const seitenUeberlauf = () =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const modalUeberlauf = () =>
      page.locator('.vp-modal').evaluate((el) => el.scrollWidth - el.clientWidth);
    const ok = (n: number) => expect(n).toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: 'Gesamtwert anlegen' }).click();
    const dialog = page.getByRole('dialog', { name: /Gesamtwert|Fertig/ });

    // Schritt 1 (Picker)
    await dialog.getByRole('combobox', { name: /Messwerte/ }).click();
    const panel = page.getByRole('listbox', { name: 'Messwerte wählen' });
    for (const name of [/PV 1/, /PV 2/, /PV 3/, /Mikrowechselrichter/]) {
      await panel.getByRole('option', { name }).click();
    }
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    ok(await seitenUeberlauf());
    ok(await modalUeberlauf());
    await dialog.getByRole('button', { name: /Weiter.*4 Werte/ }).click();

    // Schritt 2 (Rechnen) + Feineinstellung aufklappen
    await expect(dialog.getByText('Wie zählen wir sie?')).toBeVisible();
    await dialog.getByRole('button', { name: /Feineinstellung/ }).click();
    ok(await modalUeberlauf());
    await dialog.getByRole('button', { name: 'Weiter' }).click();

    // Schritt 3 (Name)
    await expect(dialog.getByLabel('Name')).toBeVisible();
    ok(await modalUeberlauf());
    await dialog.getByRole('button', { name: 'Weiter' }).click();

    // Schritt 4 (Vorschau mit Rechenzeile + Sparkline)
    await expect(dialog.locator('.vp-gw-big')).toHaveText('15,5');
    ok(await modalUeberlauf());
    await dialog.getByRole('button', { name: 'Speichern' }).click();

    // Schritt 5 + schließen
    await expect(dialog.getByText('ist angelegt')).toBeVisible();
    ok(await modalUeberlauf());
    await dialog.getByRole('button', { name: 'Fertig' }).click({ force: true });
    await expect(dialog).toBeHidden();

    // Fertige Kachel im Cockpit
    await expect(page.getByRole('region', { name: 'Übersicht' }).getByText('Gesamt-PV')).toBeVisible();
    ok(await seitenUeberlauf());

    expect(fehler, fehler.join('\n')).toEqual([]);
  });
}
