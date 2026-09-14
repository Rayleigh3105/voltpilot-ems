import { expect as baseExpect, test, type Page } from '@playwright/test';

// Der Vite-Dev-Server kompiliert den Modulgraphen beim ERSTEN Zugriff kalt;
// deshalb eine grosszügige Aussage-Wartezeit wie in den anderen E2E-Bühnen.
const expect = baseExpect.configure({ timeout: 30_000 });
test.describe.configure({ retries: 2 });

/**
 * Der geräteseitige Summenwert-Assistent, Ankerfall Deye SUN-30K
 * (Konzept vp-agg-konzept3-r8): aus ALLEN Registern des Geräts wird „PV gesamt"
 * = PV 1 + PV 2 + PV 3 + Gen-Port (= 15,5 kW) gebaut und der Rolle PV-Produktion
 * zugeordnet. Nicht summierbare Register erscheinen sichtbar, aber gesperrt mit
 * Grund. Die Cloud ist per `page.route` verdrahtet (quantity/direction je Punkt
 * wie seit PR „Summenwert-Fundament" + Katalog-Serialisierung).
 */

/** Ein Katalog-Punkt mit sinnvollen Vorgaben; jede Eigenschaft ist überschreibbar. */
function catPoint(over: Record<string, unknown>) {
  return {
    family: 'hybrid_3p',
    pointKey: 'p',
    sourceKind: 'modbus',
    address: null,
    selector: 'holding:0x0000',
    widthBits: 16,
    valueType: 'uint16',
    signed: false,
    endian: 'big',
    scale: { kind: 'fixed', value: 1 },
    unit: 'kW',
    group: 'PV',
    labelDe: null,
    labelSource: null,
    semanticStatus: 'known',
    aggregationKind: 'gauge',
    quantity: 'active_power',
    direction: 'generation',
    defaultCadenceS: 5,
    minCadenceS: 1,
    longTermCadenceS: 900,
    pollGroup: 'pv',
    sourceUrl: 'https://example',
    sourceCommit: 'abc',
    sourceRevision: null,
    dynamic: false,
    recommended: true,
    available: true,
    availabilityStatus: 'read',
    availabilityReason: '',
    recorded: false,
    selected: false,
    selectedCadenceS: null,
    lastReadAt: null,
    rawValue: null,
    decodedValue: null,
    quality: null,
    gap: false,
    droppedSamples: 0,
    estimatedDataPerYearBytes: 400_000_000,
    ...over,
  };
}

const BEOBACHTET = [
  catPoint({ pointKey: 'pv1', labelDe: 'PV 1', selected: true, recorded: true, decodedValue: '5.2', lastReadAt: '2026-09-12T09:45:00Z', selectedCadenceS: 5 }),
  catPoint({ pointKey: 'pv2', labelDe: 'PV 2', selected: true, recorded: true, decodedValue: '4.1', lastReadAt: '2026-09-12T09:45:00Z', selectedCadenceS: 5 }),
  catPoint({ pointKey: 'pv3', labelDe: 'PV 3', selected: true, recorded: true, decodedValue: '3.1', lastReadAt: '2026-09-12T09:45:00Z', selectedCadenceS: 5 }),
  catPoint({ pointKey: 'genport', labelDe: 'Gen-Port', direction: null, selected: true, recorded: true, decodedValue: '3.1', lastReadAt: '2026-09-12T09:45:00Z', selectedCadenceS: 5 }),
];

const ALLE = [
  catPoint({ pointKey: 'ct', labelDe: 'Externe Erzeugung (CT-Klemme)', group: 'PV', decodedValue: null }),
  catPoint({ pointKey: 'batt-v', labelDe: 'Batteriespannung', group: 'Batterie', quantity: 'voltage', direction: null, unit: 'V' }),
  catPoint({ pointKey: 'temp', labelDe: 'Modultemperatur', group: 'Temperaturen', quantity: 'temperature', direction: null, unit: '°C' }),
  catPoint({ pointKey: 'state', labelDe: 'Betriebszustand', group: 'Zustände', quantity: null, direction: null, aggregationKind: 'text', unit: null }),
  catPoint({ pointKey: 'netz-e', labelDe: 'Netzarbeit', group: 'Netz', quantity: 'active_energy', direction: 'import', aggregationKind: 'counter', unit: 'kWh' }),
];

async function mock(page: Page) {
  const state: { assigned: null | Record<string, unknown> } = { assigned: null };
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    // Rollen-Zuordnung dieses Geräts
    if (/\/komponenten\/[^/]+\/rollen\/pv$/.test(path)) {
      if (method === 'PUT') {
        state.assigned = { art: 'gesamtwert', capability: null, quell_messstelle_id: 'gw-1', name: 'PV gesamt' };
        return route.fulfill({ json: { zugeordnet: state.assigned, abgeloest: null } });
      }
      return route.fulfill({ json: { entity_id: 'inv', role: 'pv', zugeordnet: state.assigned } });
    }

    // Katalog: beobachtete (selectedOnly) vs. alle Register
    if (path.endsWith('/measurement-selection/catalog')) {
      const nurSelektiert = url.searchParams.get('selectedOnly') === 'true';
      const points = nurSelektiert ? BEOBACHTET : ALLE;
      return route.fulfill({
        json: {
          catalogVersion: '2026.09.11.1', edgeMinVersion: '1.0',
          customPointActionLabel: 'Eigenen Messwert hinzufügen',
          total: nurSelektiert ? points.length : 624, offset: 0, limit: 80,
          groups: [], semanticStatuses: [], points,
        },
      });
    }
    if (path.endsWith('/measurement-selection')) {
      return route.fulfill({ json: { deviceId: 'd1', siteId: 'site-e2e', entityId: 'inv', desiredRevision: 1, catalogVersion: '2026.09.11.1', status: 'applied', statusReason: '', activationNotice: '', disableNotice: '', selections: [], volumeEstimate: { enabledPointCount: 4, samplesPerMinute: 48, requestsPerMinute: 12, dutyCyclePercent: 63, softWarning: false, hardRejected: false, reasons: [], rawGbPerYear: 0.4, longTermGbPerYear: 0.1, totalGbPerYear: 0.5, retentionSummary: '' } } });
    }
    if (/\/measurement-selection\/[^/]+$/.test(path) && method === 'PUT') {
      return route.fulfill({ json: { deviceId: 'd1', siteId: 'site-e2e', entityId: 'inv', desiredRevision: 2, catalogVersion: '2026.09.11.1', status: 'pending_edge', statusReason: '', activationNotice: '', disableNotice: '', selections: [], volumeEstimate: { enabledPointCount: 5, samplesPerMinute: 60, requestsPerMinute: 15, dutyCyclePercent: 68, softWarning: false, hardRejected: false, reasons: [], rawGbPerYear: 0.5, longTermGbPerYear: 0.1, totalGbPerYear: 0.6, retentionSummary: '' } } });
    }

    // Gesamtwert anlegen + Live-Wert
    if (path.endsWith('/messstellen/berechnet') && method === 'POST') {
      return route.fulfill({ status: 201, json: { id: 'gw-1', kennzeichen: 'MS-0007', name: 'PV gesamt', art: 'berechnet', medium: 'Strom', lebenszyklus: 'aktiv', fehlt: [] } });
    }
    if (/\/messstellen\/[^/]+\/wert$/.test(path)) {
      return route.fulfill({ json: { wert: 15.5, einheit: 'kW', unvollstaendig: false, fehlende: [], stand: '2026-09-12T09:45:00Z' } });
    }

    return route.fulfill({ json: {} });
  });
}

/** Öffnet die Geräteseiten-Karte und ihren Assistenten. */
async function assistentOeffnen(page: Page) {
  await page.goto('/e2e/summenwert.html');
  await page.getByRole('button', { name: /Summenwert anlegen/ }).click();
  return page.getByRole('dialog', { name: /Gesamtwert|Fertig/ });
}

test('SUN-30K: der Assistent baut „PV gesamt" aus allen Registern und ordnet PV-Produktion zu', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Ankerlauf einmal (Logik ist engine-unabhängig)');
  test.slow();
  await mock(page);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Deliverable A: die Ergebnis-Karte der Geräteseite (noch ohne Zuordnung).
  await page.goto('/e2e/summenwert.html');
  await expect(page.getByText('PV-Produktion dieses Geräts')).toBeVisible();
  await page.locator('.vp-geraet-pvp-card').screenshot({ path: 'e2e/shots/summenwert-geraetkarte.png' });

  await page.getByRole('button', { name: /Summenwert anlegen/ }).click();
  const dialog = page.getByRole('dialog', { name: /Gesamtwert|Fertig/ });

  // Schritt 1: Name-Vorschlag „PV gesamt", die Erzeugungs-Stränge vorab an.
  await expect(dialog.getByLabel('Name des Gesamtwerts')).toHaveValue('PV gesamt');
  await expect(dialog.getByText('PV 1')).toBeVisible();
  await expect(dialog.getByText('Am Gen-Port hängt ein Mikrowechselrichter?')).toBeVisible();

  // Die Summenzeile trägt 15,5 kW (PV 1+2+3 + Gen-Port).
  await expect(dialog.locator('.vp-sw-sum-v')).toContainText('15,5');

  // „Alle Register": ein rohes summierbares Register bietet „Beobachten"; die
  // nicht summierbaren erscheinen sichtbar, aber gesperrt MIT Grund.
  await expect(dialog.getByText('Externe Erzeugung (CT-Klemme)')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Beobachten/ }).first()).toBeVisible();
  await expect(dialog.getByText('keine Messgröße').first()).toBeVisible();
  await expect(dialog.getByText('kein Zahlenwert').first()).toBeVisible();
  await expect(dialog.getByText('andere Messgröße').first()).toBeVisible();

  // Schritt 2: verwenden als PV-Produktion; die weiteren Rollen als „folgt"-Chips.
  await expect(dialog.getByText('Diesen Wert verwenden als …')).toBeVisible();
  await expect(dialog.getByText('Netz · folgt')).toBeVisible();

  // Schritt 1 (Quellenliste aus allen Registern) und Schritt 2 (verwenden als).
  await dialog.screenshot({ path: 'e2e/shots/summenwert-desktop.png' });
  await dialog.getByText('Diesen Wert verwenden als …').scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: 'e2e/shots/summenwert-desktop-schritt2.png' });

  await dialog.getByRole('button', { name: /Verwenden als PV-Produktion/ }).click();

  // Fertig: der Summenwert ist die PV-Produktion dieses Geräts.
  await expect(dialog.getByText('ist die PV-Produktion dieses Geräts')).toBeVisible();
});

test('Handy 375: der Assistent als Vollbild-Schrittfolge, sauber und vollständig', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'einmal, mit gesetztem 375-Viewport');
  test.slow();
  await mock(page);
  await page.setViewportSize({ width: 375, height: 812 });
  const dialog = await assistentOeffnen(page);

  await expect(dialog.getByText('Summenwert bauen - aus allen Registern')).toBeVisible();
  await expect(dialog.locator('.vp-sw-sum-v')).toContainText('15,5');
  await expect(dialog.getByText('Diesen Wert verwenden als …')).toBeVisible();

  // Das Vollbild-Sheet als Element aufnehmen (nicht fullPage - der fixe Sheet
  // über der scrollenden Seite komponiert sonst durch).
  await dialog.screenshot({ path: 'e2e/shots/summenwert-mobile.png' });
});

/**
 * Layout-Abnahme: bei 375 · 768 · 1440 läuft weder die Seite noch das Modal
 * waagerecht über (0 px) und kein Fehler landet in der Konsole. Der Bruch zur
 * Vollbild-Schrittfolge liegt bei 720 px.
 */
for (const width of [375, 768, 1440]) {
  test(`kein waagerechter Überlauf bei ${width} px`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Layout-Abnahme läuft einmal');
    test.slow();
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(String(e)));
    await mock(page);
    await page.setViewportSize({ width, height: 900 });
    const dialog = await assistentOeffnen(page);
    await expect(dialog.locator('.vp-sw-sum-v')).toContainText('15,5');

    const seitenUeberlauf = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    const modalUeberlauf = await page.locator('.vp-modal').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(seitenUeberlauf).toBeLessThanOrEqual(1);
    expect(modalUeberlauf).toBeLessThanOrEqual(1);
    expect(fehler, fehler.join('\n')).toEqual([]);
  });
}
