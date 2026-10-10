import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BILDER = process.env.HERKUNFT_BILDER;
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function daten(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/measurement-selection')) return route.fulfill(json({
      deviceId: 'box-halle-2', siteId: 'werk-ahrenberg', desiredRevision: 1, catalogVersion: '2026.08.26.3',
      status: 'applied', statusReason: null, activationNotice: 'Aufzeichnung läuft', disableNotice: 'Historie bleibt',
      selections: [{ pointKey: 'energy-import', enabled: true, cadenceS: 60, applyStatus: 'applied', applyReason: null,
        enabledAt: '2026-08-26T00:00:00Z', disabledAt: null, label: 'Wirkenergie Bezug', family: 'multi-meter',
        group: 'Energie', semanticStatus: 'known', customDefinition: null }],
      volumeEstimate: { enabledPointCount: 1, samplesPerMinute: 1, requestsPerMinute: 1, dutyCyclePercent: 1,
        softWarning: false, hardRejected: false, reasons: [], rawGbPerYear: .1, longTermGbPerYear: .03,
        totalGbPerYear: .13, retentionSummary: '90 Tage roh' },
    }));
    if (url.pathname.endsWith('/measurement-selection/catalog')) return route.fulfill(json({
      catalogVersion: '2026.08.26.3', edgeMinVersion: '2026.08.26', customPointActionLabel: 'Eigenen Messwert hinzufügen',
      total: 1, offset: 0, limit: 100, groups: [{ value: 'Energie', count: 1 }], semanticStatuses: [],
      points: [{ family: 'multi-meter', pointKey: 'energy-import', sourceKind: 'modbus_holding',
        address: { kind: 'modbus_holding', registers: [2], widthWords: 2 }, selector: 'holding:2', widthBits: 32,
        valueType: 'uint32', signed: false, endian: 'big', scale: { kind: 'factor', value: .1 }, unit: 'kWh',
        group: 'Energie', labelDe: 'Wirkenergie Bezug', labelSource: 'Energy import', semanticStatus: 'known',
        aggregationKind: 'counter', defaultCadenceS: 60, minCadenceS: 60, longTermCadenceS: 900,
        pollGroup: 'meter', sourceUrl: '', sourceCommit: '', sourceRevision: null, dynamic: false, recommended: true,
        available: true, availabilityStatus: 'family_configured', availabilityReason: 'verfügbar', recorded: true,
        selected: true, selectedCadenceS: 60, lastReadAt: '2027-01-19T10:15:00+01:00', rawValue: '1061902.7',
        decodedValue: '1061902.7', quality: 'good', gap: false, droppedSamples: 0, estimatedDataPerYearBytes: 1 }],
    }));
    if (url.pathname.endsWith('/messkanaele')) return route.fulfill(json({
      site_id: 'werk-ahrenberg', komponente: 'zaehler-z5', inhaltsstand: '2026.08.26.3',
      messkanaele: [{ kanal: 'energy-import', anzeigename: 'Wirkenergie Bezug', einheit: 'kWh', wertart: 'counter',
        groesse: 'Wirkenergie', richtung: 'Bezug', aktiv: true, lesende_box: 'box-halle-2',
        geraet: { id: 'einbau-z5a', geraet: 'GR-7', einbau: 'Z-5a', seriennummer: '4471023' }, speist: [] }],
    }));
    if (url.pathname.endsWith('/history')) return route.fulfill(json({
      meta: { pointKey: 'energy-import', label: 'Wirkenergie Bezug', sourceLabel: 'Energy import', unit: 'kWh',
        aggregationKind: 'counter', semanticStatus: 'known', catalogVersion: '2026.08.26.3', representation: 'decoded',
        rawAvailable: false, from: '2026-11-03T14:00:00+01:00', to: '2026-11-03T18:00:00+01:00', bucketSeconds: 900,
        aggregationExplanation: 'Viertelstundenwerte.', siteId: 'werk-ahrenberg', entityId: 'zaehler-z5',
        quelle: 'viertelstunde', quelleErklaerung: 'Viertelstundenwerte.', rohGrenze: '2026-10-20T00:00:00+02:00' },
      data: [0, 1, 2, 3].map((n) => ({ time: `2026-11-03T1${4 + n}:00:00+01:00`, value: 20 + n,
        minimum: 20 + n, maximum: 20 + n, text: null, sampleCount: 15, gap: n === 1,
        herkunft: { quelle: 'viertelstunde', wertart: 'counter', abdeckungProzent: 100, erhalten: 15, erwartet: 15,
          nGood: 15, nUncertain: 0, nInvalid: 0, nStale: 0, nDeviceError: 0, zustand: 'endgueltig',
          endgueltigAb: '2026-11-10T18:00:00+01:00', version: 1, nachgeliefert: n === 0 ? 15 : 0,
          zustellart: n === 0 ? 'nachgeliefert' : 'direkt', letzteEingangszeit: n === 0 ? '2026-11-03T17:31:00+01:00' : `2026-11-03T1${4 + n}:14:07+01:00`,
          geraetEinbau: 'einbau-z5a', geraetEinbauZwei: null, box: 'box-halle-2', boxZwei: null,
          fassung: 1, katalogVersion: '2026.08.26.3', rolle: 'fuehrend', standAnfang: 1061800, standEnde: 1061902.7 } })),
      markers: [{ time: '2026-11-03T14:00:00+01:00', until: '2026-11-03T17:30:00+01:00', kind: 'data_gap', label: 'Datenlücke', count: 1 }],
    }));
    return route.fulfill(json({}));
  });
}

test('M1–M3 · Komponenten-Verlauf zeigt Herkunft, Nachlieferung und Rohdatenfrist ohne Querlauf', async ({ page }, info) => {
  const breite = info.project.name.includes('desktop') ? 1440 : 375;
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
  await daten(page);
  await page.goto('/e2e/herkunft-verlauf.html');
  await page.getByRole('button', { name: /Register beobachten/ }).click();
  await page.getByRole('button', { name: 'Verlauf ansehen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Verlauf · Wirkenergie Bezug' });
  await expect(dialog).toContainText('nachgeliefert um 17:31 (14:00–17:30)');
  await expect(dialog).toContainText('Rohwerte (60 s) bis 20.10.2026 verfügbar — ab hier Viertelstundenwerte.');
  await expect(dialog.getByRole('button', { name: 'Rohwert' })).toBeDisabled();
  const canvas = dialog.locator('.vp-measure-chart canvas');
  await expect(canvas).toBeVisible();
  await canvas.click({ position: { x: 64, y: 150 } });
  await expect(dialog.getByTestId('herkunfts-karte')).toBeVisible();
  await expect(dialog.getByTestId('herkunfts-karte')).toContainText('Z-5a · 4471023');
  await expect(dialog.getByTestId('herkunfts-karte')).toContainText('Box Halle 2');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBe(0);
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await dialog.screenshot({ path: join(BILDER, `herkunft-verlauf-${breite}.png`) });
  }
});
