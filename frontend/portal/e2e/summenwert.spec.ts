import { expect as baseExpect, test, type Page } from '@playwright/test';

// Der Vite-Dev-Server kompiliert den Modulgraphen beim ERSTEN Zugriff kalt;
// deshalb eine grosszügige Aussage-Wartezeit wie in den anderen E2E-Bühnen.
const expect = baseExpect.configure({ timeout: 30_000 });
test.describe.configure({ retries: 2 });

/**
 * Der geräteseitige Summenwert-Assistent, Ankerfall Deye SUN-30K
 * (Konzept vp-agg-konzept3-r8): aus ALLEN Registern des Geräts wird „PV gesamt"
 * = PV 1 + PV 2 + PV 3 + Gen-Port (= 15,5 kW) gebaut und der Rolle PV-Produktion
 * zugeordnet.
 *
 * ⚠ ECHTE Katalog-Lage (fix-forward B1/B2): der Gen-Port
 * (`…generator-smartload-microinverter.generator-power`) ist im Deye-Katalog
 * `recommended:false`, also NICHT standard-beobachtet. Der captain-Ankerfall geht
 * deshalb über den NATÜRLICHEN Weg: „+ Beobachten" hebt den Gen-Port in die
 * Aufzeichnung, danach entscheidet der Kunde am Schalter, dass er als Erzeugung
 * mitzählt - erst dann wandert er in die Summe (15,5 kW) und der Speichern-Aufruf
 * trägt `gilt_als_erzeugung`. Die frühere Fixture setzte den Gen-Port künstlich
 * `selected:true` und maskierte so den 400-Sackgassen-Save (B1).
 *
 * Die Cloud ist per `page.route` STATEFUL verdrahtet: „+ Beobachten" schaltet ein
 * Register echt frei (quantity/direction je Punkt wie seit „Summenwert-Fundament").
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

/** Das volle Register-Inventar des Geräts (Katalog-Stammdaten, ohne Beobachtungs-Zustand). */
const P: Record<string, ReturnType<typeof catPoint>> = {
  pv1: catPoint({ pointKey: 'pv1', labelDe: 'PV 1', group: 'PV' }),
  pv2: catPoint({ pointKey: 'pv2', labelDe: 'PV 2', group: 'PV' }),
  pv3: catPoint({ pointKey: 'pv3', labelDe: 'PV 3', group: 'PV' }),
  // Ein beobachtetes, RICHTUNGSLOSES Nicht-Erzeugungs-Register (Hausverbrauch): es darf NICHT
  // still als PV mitgezählt werden (B2) und trägt die NEUTRALE Erzeugungs-Frage (Verengung).
  hausverbrauch: catPoint({
    pointKey: 'deye.hybrid_3p.load.load-consumption-power', labelDe: 'Hausverbrauch',
    group: 'Load', direction: null, recommended: true,
  }),
  // Der ECHTE Gen-Port: richtungslos UND ambivalenter Anschluss-Kanal, `recommended:false`.
  genport: catPoint({
    pointKey: 'deye.hybrid_3p.generator-smartload-microinverter.generator-power', labelDe: 'Gen-Port',
    group: 'Generator/SmartLoad/Microinverter', direction: null, recommended: false,
  }),
  ct: catPoint({ pointKey: 'ct', labelDe: 'Externe Erzeugung (CT-Klemme)', group: 'PV' }),
  battV: catPoint({ pointKey: 'batt-v', labelDe: 'Batteriespannung', group: 'Batterie', quantity: 'voltage', direction: null, unit: 'V' }),
  temp: catPoint({ pointKey: 'temp', labelDe: 'Modultemperatur', group: 'Temperaturen', quantity: 'temperature', direction: null, unit: '°C' }),
  state: catPoint({ pointKey: 'state', labelDe: 'Betriebszustand', group: 'Zustände', quantity: null, direction: null, aggregationKind: 'text', unit: null }),
  netzE: catPoint({ pointKey: 'netz-e', labelDe: 'Netzarbeit', group: 'Netz', quantity: 'active_energy', direction: 'import', aggregationKind: 'counter', unit: 'kWh' }),
  netz: catPoint({ pointKey: 'sunspec.model_203.w', labelDe: 'Netzleistung', group: 'Netz', direction: 'import_export' }),
  netzRoh: catPoint({ pointKey: 'deye.hybrid_3p.grid.external-ct-total-power', labelDe: 'Netzleistung extern', group: 'Netz', direction: 'import_export' }),
};
const ALLE_PUNKTE = Object.values(P);

/** Der Live-Wert je Register (nur wenn beobachtet). PV 1+2+3 = 12,4; + Gen-Port 3,1 = 15,5. */
const LIVE: Record<string, string> = {
  pv1: '5.2', pv2: '4.1', pv3: '3.1',
  'deye.hybrid_3p.load.load-consumption-power': '2.0',
  'deye.hybrid_3p.generator-smartload-microinverter.generator-power': '3.1',
};

/** Einen Katalog-Punkt mit dem aktuellen Beobachtungs-Zustand ausstatten. */
function stamp(p: ReturnType<typeof catPoint>, observed: Set<string>) {
  const sel = observed.has(p.pointKey as string);
  return {
    ...p,
    selected: sel,
    recorded: sel,
    decodedValue: sel ? LIVE[p.pointKey as string] ?? null : null,
    lastReadAt: sel ? new Date().toISOString() : null,
    selectedCadenceS: sel ? 5 : null,
  };
}

async function mock(page: Page) {
  const state: { assigned: null | Record<string, unknown> } = { assigned: null };
  // Der Beobachtungs-Zustand ist ECHT veränderlich: PV 1/2/3 + Hausverbrauch stehen (der
  // Gen-Port NICHT); „+ Beobachten" schaltet weitere Register frei.
  const observed = new Set<string>(['pv1', 'pv2', 'pv3', 'deye.hybrid_3p.load.load-consumption-power', 'sunspec.model_203.w']);
  let revision = 1;

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith('/summenwerte')) return route.fulfill({ json: [] });

    if (path.endsWith('/entities')) return route.fulfill({ json: { entities: [{ id: 'inv', deviceId: 'd1', label: 'Deye SUN-30K' }] } });
    if (path.endsWith('/measurement-selection/lesen')) return route.fulfill({ json: { wert: 2, einheit: 'kW', gelesen_am: new Date().toISOString(), grund: null } });
    if (path.endsWith('/summenwert-quellen')) return route.fulfill({ json: [{ entityId: 'inv', deviceId: 'd1', name: 'Deye SUN-30K', grund: null }] });
    // Rollen-Zuordnung dieses Geräts
    if (/\/komponenten\/[^/]+\/rollen\/pv$/.test(path)) {
      if (method === 'PUT') {
        state.assigned = { art: 'gesamtwert', capability: null, quell_messstelle_id: 'gw-1', name: 'PV gesamt' };
        return route.fulfill({ json: { zugeordnet: state.assigned, abgeloest: null } });
      }
      return route.fulfill({ json: { entity_id: 'inv', role: 'pv', zugeordnet: state.assigned } });
    }

    // Katalog: beobachtete (selectedOnly) vs. alle Register - beide aus dem aktuellen Zustand.
    if (path.endsWith('/measurement-selection/catalog')) {
      const nurSelektiert = url.searchParams.get('selectedOnly') === 'true';
      const alle = ALLE_PUNKTE.map((p) => stamp(p, observed));
      const points = nurSelektiert ? alle.filter((p) => p.selected) : alle;
      return route.fulfill({
        json: {
          catalogVersion: '2026.09.11.1', edgeMinVersion: '1.0',
          customPointActionLabel: 'Eigenen Messwert hinzufügen',
          total: points.length, offset: 0, limit: 80,
          groups: [], semanticStatuses: [], points,
        },
      });
    }
    // „+ Beobachten": ein Register echt freischalten.
    if (/\/measurement-selection\/[^/]+$/.test(path) && method === 'PUT') {
      const pointKey = decodeURIComponent(path.split('/').pop() ?? '');
      observed.add(pointKey);
      revision += 1;
      return route.fulfill({ json: selektionsState(revision, observed.size) });
    }
    if (path.endsWith('/measurement-selection')) {
      return route.fulfill({ json: selektionsState(revision, observed.size) });
    }

    // Gesamtwert anlegen + Live-Wert
    if (path.endsWith('/messstellen/berechnet') && method === 'POST') {
      return route.fulfill({ status: 201, json: { id: 'gw-1', kennzeichen: 'MS-0007', name: route.request().postDataJSON().name, art: 'berechnet', medium: 'Strom', lebenszyklus: 'aktiv', fehlt: [] } });
    }
    if (/\/messstellen\/[^/]+\/wert$/.test(path)) {
      return route.fulfill({ json: { wert: 15.5, einheit: 'kW', unvollstaendig: false, fehlende: [], stand: new Date().toISOString() } });
    }

    return route.fulfill({ json: {} });
  });
}

/** Ein Selektions-Zustand mit passender Revision + Volumen-Schätzung. */
function selektionsState(revision: number, enabled: number) {
  return {
    deviceId: 'd1', siteId: 'site-e2e', entityId: 'inv', desiredRevision: revision,
    catalogVersion: '2026.09.11.1', status: 'applied', statusReason: '', activationNotice: '',
    disableNotice: '', selections: [],
    volumeEstimate: {
      enabledPointCount: enabled, samplesPerMinute: enabled * 12, requestsPerMinute: enabled * 3,
      dutyCyclePercent: 63, softWarning: false, hardRejected: false, reasons: [],
      rawGbPerYear: 0.4, longTermGbPerYear: 0.1, totalGbPerYear: 0.5, retentionSummary: '',
    },
  };
}

/** Öffnet die Geräteseiten-Karte und ihren Assistenten. */

for (const width of [375, 1440]) {
  test(`Gen-Port antippen: fünf Schritte, Live-Wert und Rolle bei ${width} px`, async ({ page }, testInfo) => {
    test.slow();
    const errors: string[] = [];
    const reads: string[] = [], selections: string[] = [], saves: Record<string, unknown>[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (r.url().includes('/measurement-selection/lesen')) reads.push(r.url());
      if (r.url().includes('/measurement-selection/') && r.method() === 'PUT') selections.push(r.url());
      if (r.url().endsWith('/messstellen/berechnet') && r.method() === 'POST') saves.push(r.postDataJSON());
    });
    await mock(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/e2e/summenwert.html');
    await page.getByRole('button', { name: 'Summenwert anlegen' }).click();
    const dialog = page.getByRole('dialog', { name: /Summenwert/ });
    await expect(dialog.getByRole('button', { name: 'PV 1 entfernen' })).toBeVisible();
    await expect(dialog.locator('.vp-sw-sumline')).toContainText('12,4');
    await dialog.locator('summary').filter({ hasText: 'Alle Register des Geräts' }).click();
    await dialog.getByRole('button', { name: 'Gen-Port einmal lesen' }).click();
    await expect(dialog.getByText(/jetzt gelesen/)).toBeVisible();
    expect(reads).toHaveLength(1); expect(selections).toHaveLength(0);
    await expect(dialog.locator('.vp-sw-sumline')).toContainText('12,4');
    const gen = dialog.locator('.vp-sw-suggest', { hasText: 'Mikrowechselrichter' });
    await gen.locator('label').click();
    await expect(dialog.locator('.vp-sw-sumline')).toContainText('14,4');
    await gen.locator('label').click(); await gen.locator('label').click();
    expect(reads).toHaveLength(1);
    async function shot(step: number) {
      expect(await dialog.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      if (testInfo.project.name === 'desktop-chromium') await dialog.screenshot({ path: `${process.env.SUMMENWERT_BILDER ?? 'e2e/shots'}/geraet-${width}-${step}.png` });
    }
    await shot(1);
    await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
    await dialog.getByRole('button', { name: /Feineinstellung/ }).click();
    await expect(dialog.getByLabel('Faktor für PV 1')).toHaveValue('1'); await shot(2);
    await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
    await dialog.getByLabel('Name des Summenwerts').fill('PV mit Gen-Port'); await shot(3);
    await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'keine Rolle', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'PV-Produktion', exact: true }).click(); await shot(4);
    await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(dialog.getByText(/ist angelegt/)).toBeVisible();
    await expect(page.locator('.vp-modal-scrim')).not.toHaveClass(/is-closing/);
    expect(selections).toHaveLength(1); expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ rolle: { entity_id: 'inv', role: 'pv', ersetzen: false } });
    await shot(5);
    await dialog.getByRole('button', { name: 'Fertig', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Summenwert anlegen' })).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test('Lesefehler bleibt fehlend, Abbrechen schreibt keine Beobachtung', async ({ page }) => {
  await mock(page);
  await page.route('**/measurement-selection/lesen?*', (route) => route.fulfill({ json: { wert: null, einheit: 'kW', gelesen_am: null, grund: 'box_offline' } }));
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PUT') writes.push(r.url()); });
  await page.goto('/e2e/summenwert.html');
  await page.getByRole('button', { name: 'Summenwert anlegen' }).click();
  const dialog = page.getByRole('dialog', { name: /Summenwert/ });
  await dialog.locator('summary').filter({ hasText: 'Alle Register des Geräts' }).click();
  await dialog.getByRole('button', { name: 'Gen-Port einmal lesen' }).click();
  await expect(dialog.getByText(/die Box antwortet nicht/)).toBeVisible();
  await dialog.locator('.vp-sw-suggest', { hasText: 'Mikrowechselrichter' }).locator('label').click();
  await expect(dialog.locator('.vp-sw-sumline')).toContainText('unvollständig');
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); expect(writes).toHaveLength(0);
});


test('Vorzeichen-Netzregister bleiben ohne Erzeugungs-Haken und ohne Aufnahme gesperrt', async ({ page }) => {
  test.slow(); await mock(page); await page.goto('/e2e/summenwert.html');
  await page.getByRole('button', { name: 'Summenwert anlegen' }).click();
  const dialog = page.getByRole('dialog', { name: /Summenwert/ });
  await dialog.locator('summary').filter({ hasText: 'Alle Register des Geräts' }).click();
  for (const name of ['Netzleistung', 'Netzleistung extern']) {
    const button = dialog.getByRole('button', { name: `${name} mitzählen`, exact: true });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /Bezug und Abgabe gemeinsam/);
    await expect(dialog.getByText(`Zählt „${name}“ als Erzeugung?`)).toHaveCount(0);
  }
});
