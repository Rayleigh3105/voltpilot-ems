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
    lastReadAt: sel ? '2026-09-12T09:45:00Z' : null,
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
          total: nurSelektiert ? points.length : 624, offset: 0, limit: 80,
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
      return route.fulfill({ status: 201, json: { id: 'gw-1', kennzeichen: 'MS-0007', name: 'PV gesamt', art: 'berechnet', medium: 'Strom', lebenszyklus: 'aktiv', fehlt: [] } });
    }
    if (/\/messstellen\/[^/]+\/wert$/.test(path)) {
      return route.fulfill({ json: { wert: 15.5, einheit: 'kW', unvollstaendig: false, fehlende: [], stand: '2026-09-12T09:45:00Z' } });
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
async function assistentOeffnen(page: Page) {
  await page.goto('/e2e/summenwert.html');
  await page.getByRole('button', { name: /Summenwert anlegen/ }).click();
  return page.getByRole('dialog', { name: /Gesamtwert|Fertig/ });
}

test('Vorzeichen-Netzregister bleiben ohne Erzeugungs-Haken und ohne Aufnahme gesperrt', async ({ page }, testInfo) => {
  test.skip(!['desktop-chromium', 'mobile-chromium'].includes(testInfo.project.name));
  test.slow();
  await mock(page);
  const width = testInfo.project.name === 'mobile-chromium' ? 375 : 1440;
  await page.setViewportSize({ width, height: 1000 });
  const dialog = await assistentOeffnen(page);
  await expect(dialog.locator('.vp-sw-sum-v')).toContainText('12,4');
  for (const name of ['Netzleistung', 'Netzleistung extern']) {
    await expect(dialog.getByText(`Zählt „${name}" als Erzeugung?`)).toHaveCount(0);
    const button = dialog.getByRole('button', { name: `${name} mitzählen`, exact: true });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /Bezug und Abgabe gemeinsam/);
    const row = dialog.locator('.vp-sw-row').filter({
      has: page.getByRole('button', { name: `${name} mitzählen`, exact: true }),
    });
    await expect(row.getByRole('button', { name: /Beobachten/ })).toHaveCount(0);
    await expect(row.getByText('Bezug und Abgabe trennen', { exact: true })).toBeVisible();
  }
  await dialog.screenshot({ path: testInfo.outputPath(`import-export-${width}.png`) });
});

test('SUN-30K: Gen-Port über „+ Beobachten" aufnehmen, als Erzeugung entscheiden, speichern gelingt', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium' && testInfo.project.use.browserName !== 'webkit', 'Ankerlauf einmal (Logik ist engine-unabhängig)');
  test.slow();
  await mock(page);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // Deliverable A: die Ergebnis-Karte der Geräteseite (noch ohne Zuordnung).
  await page.goto('/e2e/summenwert.html');
  await expect(page.getByText('Summenwerte dieses Geräts')).toBeVisible();
  await page.locator('.vp-summen-head').locator('..').screenshot({ path: 'e2e/shots/summenwert-geraetkarte.png' });

  await page.getByRole('button', { name: /Summenwert anlegen/ }).click();
  const dialog = page.getByRole('dialog', { name: /Gesamtwert|Fertig/ });

  // Schritt 1: Name-Vorschlag „PV gesamt", nur die Erzeugungs-Stränge vorab an.
  await expect(dialog.getByLabel('Name des Gesamtwerts')).toHaveValue('PV gesamt');
  await expect(dialog.getByText('PV 1')).toBeVisible();

  // B2 · der Gen-Port ist NICHT vorab dabei (recommended:false, unbeobachtet): die Summe
  // trägt PV 1+2+3 = 12,4 kW, NICHT 15,5. Keine stille Gen-Port-Zählung.
  await expect(dialog.locator('.vp-sw-sum-v')).toContainText('12,4');
  await expect(dialog.getByText('Am Gen-Port hängt ein Mikrowechselrichter?')).toHaveCount(0);

  // B2 · das beobachtete richtungslose Nicht-Erzeugungs-Register (Hausverbrauch) wird NICHT
  // still mitgezählt und trägt die NEUTRALE Erzeugungs-Frage (kein Gen-Port-Wording).
  await expect(dialog.getByText('Zählt „Hausverbrauch" als Erzeugung?')).toBeVisible();

  // „Alle Register": der Gen-Port ist ein rohes summierbares Register mit „+ Beobachten";
  // die nicht summierbaren erscheinen sichtbar, aber gesperrt MIT Grund.
  await expect(dialog.getByText('Externe Erzeugung (CT-Klemme)')).toBeVisible();
  await expect(dialog.getByText('keine Messgröße').first()).toBeVisible();
  await expect(dialog.getByText('kein Zahlenwert').first()).toBeVisible();
  await expect(dialog.getByText('andere Messgröße').first()).toBeVisible();
  await dialog.screenshot({ path: 'e2e/shots/summenwert-desktop.png' });

  // Der ECHTE Ankerpfad: den Gen-Port über „+ Beobachten" aufnehmen …
  const genRow = dialog.locator('.vp-sw-row', { hasText: 'Gen-Port' });
  await genRow.getByRole('button', { name: /Beobachten/ }).click();

  // … jetzt erscheint er als erklärte Gen-Port-Frage (NICHT still gezählt: Summe noch 12,4) …
  await expect(dialog.getByText('Am Gen-Port hängt ein Mikrowechselrichter?')).toBeVisible();
  await expect(dialog.locator('.vp-sw-sum-v')).toContainText('12,4');

  // … der Kunde entscheidet am Schalter, dass er als Erzeugung mitzählt → 15,5 kW.
  const genSuggest = dialog.locator('.vp-sw-suggest', { hasText: 'Mikrowechselrichter' });
  await genSuggest.locator('label').click();
  await expect(dialog.locator('.vp-sw-sum-v')).toContainText('15,5');
  await dialog.getByText('Diesen Wert verwenden als …').scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: 'e2e/shots/summenwert-desktop-schritt2.png' });

  // Speichern gelingt (früher: Server-400-Sackgasse) - der Summenwert ist die PV-Produktion.
  await dialog.getByRole('button', { name: /Verwenden als PV-Produktion/ }).click();
  await expect(dialog.getByText('ist die PV-Produktion dieses Geräts')).toBeVisible();
});

test('SUN-30K: ohne Erzeugungs-Entscheidung sperrt der Assistent nicht den PV-Grundfall', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium' && testInfo.project.use.browserName !== 'webkit', 'einmal');
  test.slow();
  await mock(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dialog = await assistentOeffnen(page);

  // Der PV-Grundfall (PV 1+2+3, ohne Gen-Port) ist speicherbar - der richtungslose Gen-Port
  // ist gar kein Term, also keine offene Entscheidung, kein Riegel, keine Sackgasse.
  await expect(dialog.locator('.vp-sw-sum-v')).toContainText('12,4');
  await expect(dialog.getByRole('button', { name: /Verwenden als PV-Produktion/ })).toBeEnabled();

  // Nimmt der Kunde den Gen-Port auf, ist er zunächst NICHT im Term (Summe bleibt 12,4) - der
  // Speichern-Weg des Grundfalls bleibt offen, bis er sich für den Gen-Port entscheidet.
  const genRow = dialog.locator('.vp-sw-row', { hasText: 'Gen-Port' });
  await genRow.getByRole('button', { name: /Beobachten/ }).click();
  await expect(dialog.getByText('Am Gen-Port hängt ein Mikrowechselrichter?')).toBeVisible();
  await expect(dialog.locator('.vp-sw-sum-v')).toContainText('12,4');
  await expect(dialog.getByRole('button', { name: /Verwenden als PV-Produktion/ })).toBeEnabled();
});

test('Handy 375: der Assistent als Vollbild-Schrittfolge, sauber und vollständig', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium' && testInfo.project.use.browserName !== 'webkit', 'einmal, mit gesetztem 375-Viewport');
  test.slow();
  await mock(page);
  await page.setViewportSize({ width: 375, height: 812 });
  const dialog = await assistentOeffnen(page);

  await expect(dialog.getByText('Summenwert bauen - aus allen Registern')).toBeVisible();
  // Der Default-Summenwert (PV 1+2+3, ohne Gen-Port) = 12,4 kW.
  await expect(dialog.locator('.vp-sw-sum-v')).toContainText('12,4');
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
    test.skip(testInfo.project.name !== 'desktop-chromium' && testInfo.project.use.browserName !== 'webkit', 'Layout-Abnahme läuft einmal');
    test.slow();
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(String(e)));
    await mock(page);
    await page.setViewportSize({ width, height: 900 });
    const dialog = await assistentOeffnen(page);
    await expect(dialog.locator('.vp-sw-sum-v')).toContainText('12,4');

    const seitenUeberlauf = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    const modalUeberlauf = await page.locator('.vp-modal').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(seitenUeberlauf).toBeLessThanOrEqual(1);
    expect(modalUeberlauf).toBeLessThanOrEqual(1);
    expect(fehler, fehler.join('\n')).toEqual([]);
  });
}
